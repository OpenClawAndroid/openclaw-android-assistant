import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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

type BackfillParams = Parameters<typeof backfillSessionRowTranscriptFields>[0];

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
  it("returns a transient preview without changing legacy metadata", async () => {
    await withSession(
      async (params) => {
        const before = sessionAccessor.loadSessionEntry(params);
        await expect(backfillSessionRowTranscriptFields(params)).resolves.toEqual({
          lastMessagePreview: "Found the slow query",
        });
        expect(sessionAccessor.loadSessionEntry(params)).toEqual(before);
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
});
