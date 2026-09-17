import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { backfillSessionTitle } from "./dashboard-session-title-backfill.js";
import { maybeGenerateDashboardSessionTitle } from "./dashboard-session-title.js";
import { backfillSessionRowTranscriptFields } from "./session-row-transcript-backfill.js";

const generateConversationLabelWithFallback = vi.hoisted(() => vi.fn());
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback,
}));
vi.mock("../agents/utility-model.js", () => ({
  resolveUtilityModelRefForAgent: () => undefined,
}));

beforeEach(() => {
  generateConversationLabelWithFallback.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

type BackfillParams = Parameters<typeof backfillSessionTitle>[0];

async function withSession(
  run: (params: BackfillParams) => Promise<void>,
  messages: Array<{ role: string; content: string; provenance?: unknown }> = [
    { role: "user", content: "Investigate why the gateway times out" },
    { role: "assistant", content: "**Found** the slow query" },
  ],
) {
  await withOpenClawTestState({ label: "session-row-backfill" }, async (state) => {
    const params = {
      agentId: "main",
      storePath: state.statePath("sessions.json"),
      sessionKey: "agent:main:dashboard:legacy",
      sessionId: "legacy-session",
      lifecycleRevision: "legacy-lifecycle",
    };
    await sessionAccessor.persistSessionTranscriptTurn(params, {
      messages: messages.map((message) => ({ message })),
      touchSessionEntry: false,
    });
    await sessionAccessor.replaceSessionEntry(params, {
      sessionId: params.sessionId,
      lifecycleRevision: params.lifecycleRevision,
      status: "done",
      updatedAt: 12,
      lastActivityAt: 11,
      lastInteractionAt: 10,
    });
    await run({
      ...params,
      sessionEntry: expectDefined(sessionAccessor.loadSessionEntry(params), "seeded session entry"),
    });
  });
}

describe("session row transcript backfill", () => {
  it("persists a legacy title without moving its activity and returns a transient preview", async () => {
    await withSession(
      async (params) => {
        const before = sessionAccessor.loadSessionEntry(params);
        await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({
          lastMessagePreview: "Found the slow query",
        });
        expect(sessionAccessor.loadSessionEntry(params)).toEqual({
          ...before,
          displayName: "Investigate why the gateway times out",
        });
        expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
      },
      [
        { role: "user", content: "Internal relay", provenance: { kind: "inter_session" } },
        { role: "user", content: "Investigate why the gateway times out" },
        { role: "assistant", content: "**Found** the slow query" },
      ],
    );
  });

  it("does not parse oversized bodies or name a session from an incomplete prefix", async () => {
    const oversized = `oversized-title-payload ${"x".repeat(70 * 1024)}`;
    await withSession(
      async (params) => {
        const parse = JSON.parse;
        let oversizedParses = 0;
        vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
          if (text.includes("oversized-title-payload")) {
            oversizedParses++;
          }
          return parse(text, reviver);
        });
        await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({
          lastMessagePreview: "Latest reply",
        });
        expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBeUndefined();
        expect(oversizedParses).toBe(0);
      },
      [
        { role: "user", content: oversized },
        { role: "user", content: "A later task must not become the title" },
        { role: "assistant", content: "Latest reply" },
      ],
    );
  });

  it("keeps an explicit title and omits a preview when its newest message is oversized", async () => {
    await withSession(
      async (params) => {
        await sessionAccessor.patchSessionEntryCore(params, () => ({ displayName: "My title" }));
        await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({});
        expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBe("My title");
        expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
      },
      [
        { role: "user", content: "Old user prompt" },
        { role: "assistant", content: "Old reply" },
        { role: "assistant", content: "x".repeat(70 * 1024) },
      ],
    );
  });

  it.each([
    ["a replacement lifecycle", { lifecycleRevision: "replacement" }],
    ["a manual rename", { label: "Manual title" }],
    ["a newly running turn", { status: "running" }],
  ] satisfies Array<[string, Partial<SessionEntry>]>)(
    "preserves %s admitted before its metadata write",
    async (_name, mutation) => {
      await withSession(async (params) => {
        const patch = sessionAccessor.patchSessionEntryCore;
        vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementationOnce(
          async (scope, update, options) => {
            await patch(scope, () => mutation);
            return patch(scope, update, options);
          },
        );
        await expect(backfillSessionTitle(params)).resolves.toBe(false);
        expect(sessionAccessor.loadSessionEntry(params)).toMatchObject(mutation);
        expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBeUndefined();
      });
    },
  );

  it("rejects a title from a transcript rewritten before its metadata commit", async () => {
    await withSession(async (params) => {
      const patch = sessionAccessor.patchSessionEntryCore;
      vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementationOnce(
        async (scope, update, options) => {
          await sessionAccessor.replaceTranscriptEvents(params, [
            { type: "session", version: 3, id: params.sessionId },
            {
              type: "message",
              id: "replacement-user",
              parentId: null,
              message: { role: "user", content: "A different branch" },
            },
          ]);
          return patch(scope, update, options);
        },
      );
      await expect(backfillSessionTitle(params)).resolves.toBe(false);
      expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBeUndefined();
    });
  });

  it("does not commit after the resident owner revokes the queued backfill", async () => {
    await withSession(async (params) => {
      let active = true;
      const patch = sessionAccessor.patchSessionEntryCore;
      vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementationOnce(
        (scope, update, options) => {
          active = false;
          return patch(scope, update, options);
        },
      );
      await expect(backfillSessionTitle({ ...params, shouldCommit: () => active })).resolves.toBe(
        false,
      );
      expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBeUndefined();
    });
  });

  it("lets an in-flight foreground title request keep its naming decision", async () => {
    await withSession(async (params) => {
      const started = createDeferredCore();
      const title = createDeferredCore<string>();
      generateConversationLabelWithFallback.mockImplementation(() => {
        started.resolve();
        return title.promise;
      });
      const foreground = maybeGenerateDashboardSessionTitle({
        ...params,
        cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
        entry: sessionAccessor.loadSessionEntry(params),
        userMessage: "Investigate why the gateway times out",
      });
      await started.promise;
      try {
        await expect(backfillSessionTitle(params)).resolves.toBe(false);
      } finally {
        title.resolve("Model-generated title");
        await foreground;
      }
      expect(sessionAccessor.loadSessionEntry(params)?.displayName).toBe("Model-generated title");
      expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
    });
  });
});
