import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { create, type Row } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";

afterEach(() => vi.restoreAllMocks());

it("eventually fills legacy titles and previews without waiting during startup or changing activity", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const target = { agentId: "main", sessionKey: "agent:main:legacy", sessionId: "legacy" };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(target, {
      messages: [
        { message: { role: "user", content: "Investigate the slow session query" } },
        { message: { role: "assistant", content: "The query is now bounded." } },
      ],
      touchSessionEntry: false,
    });
    const projection = await createSessionRowProjection({ cfg });
    try {
      expect(loadSessionEntry(target)?.displayName).toBeUndefined();
      await vi.waitFor(() => {
        expect(loadSessionEntry(target)).toMatchObject({
          displayName: "Investigate the slow session query",
          updatedAt: 1,
        });
        expect(
          projection.snapshot(
            { agentId: "main", key: target.sessionKey },
            {
              includeDerivedTitles: true,
              includeLastMessage: true,
            },
          ).row,
        ).toMatchObject({
          derivedTitle: "Investigate the slow session query",
          lastMessagePreview: "The query is now bounded.",
        });
      });
      replaceSessionEntrySync(target, { sessionId: "replacement", updatedAt: 2 });
      emitSessionIdentityMutation({
        kind: "reset",
        agentId: "main",
        previous: { sessionId: target.sessionId, sessionKeys: [target.sessionKey] },
        current: { sessionId: "replacement", sessionKeys: [target.sessionKey] },
      });
      expect(
        projection.snapshot(
          { agentId: "main", key: target.sessionKey },
          {
            includeLastMessage: true,
          },
        ).row,
      ).toMatchObject({ sessionId: "replacement", lastMessagePreview: undefined });
    } finally {
      projection.dispose();
    }
  });
});

it("refreshes a row described while its replacement catalog is still loading", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const query = { agentId: "main", key: "agent:main:catalog" };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: query.key },
      {
        sessionId: "catalog",
        updatedAt: 1,
        providerOverride: "unit-test",
        modelOverride: "fixture",
      },
    );
    const initial = [
      {
        id: "fixture",
        name: "Fixture",
        provider: "unit-test",
        contextWindow: 8192,
        contextTokens: 8192,
      },
    ];
    const replacement = createDeferredCore<typeof initial>();
    let catalog = Promise.resolve(initial);
    const projection = await createSessionRowProjection({ cfg, getModelCatalog: () => catalog });
    try {
      catalog = replacement.promise;
      sessionChanges.emit({ all: true, scope: "catalog" });
      await nextTurn();
      expect(projection.snapshot(query).row?.contextTokens).toBe(8192);
      replacement.resolve([{ ...initial[0]!, contextWindow: 16384, contextTokens: 16384 }]);
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row?.contextTokens).toBe(16384);
    } finally {
      replacement.resolve(initial);
      projection.dispose();
    }
  });
});

it("continues backfill queued as the previous batch settles", async () => {
  vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields").mockResolvedValue({});
  const rows = new Map<string, Row>(
    ["first", "second"].map((key) => {
      const entry = { sessionId: key, updatedAt: 1 };
      return [
        key,
        {
          ...create({
            key,
            agentId: "main",
            storeTarget: { agentId: "main", storePath: "unused" },
          }),
          entry,
        },
      ];
    }),
  );
  const published: string[] = [];
  const backfill = createSessionRowProjectionBackfill({
    ready: async () => {},
    read: (id) => rows.get(id),
    current: () => true,
    publish(row) {
      published.push(row.key);
      if (row.key === "first") {
        queueMicrotask(() => backfill.enqueue("second"));
      }
    },
  });
  try {
    backfill.enqueue("first", { all: true, scope: "profiles" });
    backfill.start();
    await nextTurn();
    expect(published).toEqual([]);
    backfill.enqueue("first");
    await vi.waitFor(() => expect(published).toEqual(["first", "second"]));
  } finally {
    backfill.dispose();
  }
});

it("does not revive resident rows after disposal with a topology refresh pending", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:disposed" },
      { sessionId: "disposed", updatedAt: 1 },
    );
    const projection = await createSessionRowProjection({
      cfg: { agents: { list: [{ id: "main", default: true }] } },
    });
    sessionChanges.emit({ all: true, scope: "config" });
    projection.dispose();
    expect(projection.selectEntries()).toEqual([]);
    expect(projection.select()).toEqual([]);
  });
});

it("preserves a stored fallback model without requiring a terminal transcript", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const key = "agent:main:stored-fallback";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "stored-fallback",
        updatedAt: 1,
        status: "done",
        providerOverride: "unit-test",
        modelOverride: "selected",
        modelProvider: "unit-test",
        model: "fallback",
        fallbackNotice: {
          kind: "active",
          selectedModel: "unit-test/selected",
          activeModel: "unit-test/fallback",
        },
      },
    );
    const projection = await createSessionRowProjection({ cfg });
    try {
      expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
        activeModelProvider: "unit-test",
        activeModel: "fallback",
      });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "stored-fallback",
          updatedAt: 2,
          status: "done",
          providerOverride: "unit-test",
          modelOverride: "selected",
          modelProvider: "unit-test",
          model: "replacement",
          fallbackNotice: {
            kind: "active",
            selectedModel: "unit-test/selected",
            activeModel: "unit-test/replacement",
          },
        },
      );
      expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
        activeModelProvider: "unit-test",
        activeModel: "replacement",
      });
    } finally {
      projection.dispose();
    }
  });
});

it("backfills terminal fallback models and clears previews when the newest message cannot fit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const target = { agentId: "main", sessionKey: "agent:main:fallback", sessionId: "fallback" };
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      displayName: "Existing title",
      status: "done",
      lastRunId: "terminal-run",
      providerOverride: "unit-test",
      modelOverride: "selected",
      fallbackNotice: {
        kind: "active" as const,
        selectedModel: "unit-test/selected",
        activeModel: "unit-test/fallback",
      },
    });
    await persistSessionTranscriptTurn(target, {
      messages: [
        {
          message: {
            role: "assistant",
            content: "Finished",
            provider: "unit-test",
            model: "fallback",
            stopReason: "stop",
            __openclaw: { runId: "terminal-run" },
          },
        },
      ],
      touchSessionEntry: false,
    });
    const projection = await createSessionRowProjection({ cfg });
    const query = { agentId: "main", key: target.sessionKey };
    try {
      expect(projection.snapshot(query).row?.activeModel).toBeUndefined();
      await vi.waitFor(() =>
        expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
          activeModelProvider: "unit-test",
          activeModel: "fallback",
          lastMessagePreview: "Finished",
        }),
      );
      await persistSessionTranscriptTurn(target, {
        messages: [{ message: { role: "assistant", content: "x".repeat(70 * 1024) } }],
        touchSessionEntry: false,
      });
      await vi.waitFor(() =>
        expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
          activeModel: undefined,
          lastMessagePreview: undefined,
        }),
      );
    } finally {
      projection.dispose();
    }
  });
});

it("publishes created and moved child relationships before the background drain", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const now = Date.now();
    const first = "agent:main:first-parent",
      second = "agent:main:second-parent",
      child = "agent:main:child";
    for (const key of [first, second, child]) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: key,
          updatedAt: now,
          ...(key === child ? { parentSessionKey: first } : {}),
        },
      );
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key: first }).row?.childSessions).toEqual([
        child,
      ]);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: child },
        {
          sessionId: child,
          updatedAt: now + 1,
          parentSessionKey: second,
        },
      );
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      expect(projection.snapshot({ agentId: "main", key: second }).row?.childSessions).toEqual([
        child,
      ]);
      expect(
        projection.snapshot({ agentId: "main", key: first }).row?.childSessions,
      ).toBeUndefined();
      const created = "agent:main:new-child";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: created },
        {
          sessionId: created,
          updatedAt: now + 2,
          parentSessionKey: second,
        },
      );
      expect(
        projection.snapshot({ agentId: "main", key: second }).row?.childSessions?.toSorted(),
      ).toEqual([child, created]);
    } finally {
      projection.dispose();
    }
  });
});
