import { expect, it } from "vitest";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { create as createSessionRow } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import {
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareSessionRowSelection,
} from "./session-utils-list.js";

it.each([false, true])(
  "preserves sentinel precedence, ties, and resident order before filtering (activeOnly: %s)",
  async (activeOnly) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {}, ops: {} } } };
      const projection = createSessionRowProjectionFixture({ cfg, store: {} });
      const samples = [
        ["shadow-global", "global", "main", "fallback"],
        ["ordinary", "agent:main:ordinary", "main", "primary"],
        ["main-global", "global", "main", "primary"],
        ["ops-global", "global", "ops", "primary"],
        ["ops-shadow", "global", "ops", "fallback"],
        ["unknown-winner", "unknown", "ops", "primary"],
        ["unknown-shadow", "unknown", "main", "fallback"],
        ["excluded", "agent:main:ordinary", "main", "excluded"],
        ["retired", "agent:retired:ordinary", "retired", "primary"],
      ] as const;
      const rows = samples.map(([sessionId, key, agentId, storePath]) => {
        const entry = { sessionId, updatedAt: 1 };
        return {
          ...createSessionRow(
            {
              key,
              agentId,
              storeTarget: { agentId, storePath },
            },
            entry,
          ),
          entry,
        };
      });
      projection.selectEntries = () => rows;
      projection.state.scope = () => ({
        paths: new Map([
          ["primary", 0],
          ["fallback", 1],
        ]),
        path: "(multiple)",
        agentId: undefined,
        configuredAgentIds: new Set(["main", "ops"]),
      });
      try {
        const prepared = prepareSessionRowSelection(projection, {
          activeOnly,
          configuredAgentsOnly: true,
          includeGlobal: true,
          includeUnknown: true,
        });
        expect(prepared.entries.map(([, entry]) => entry.sessionId)).toEqual(
          activeOnly
            ? ["ordinary", "main-global", "ops-global", "unknown-winner", "unknown-shadow"]
            : ["ordinary", "main-global", "unknown-winner"],
        );
        for (const [key, entry] of prepared.entries) {
          const target = prepared.getTarget(key)!;
          const original = rows.find((row) => row.entry === entry)!;
          expect(target.entry).toBe(entry);
          expect(target.storeTarget).toBe(original.storeTarget);
          expect(target.storeKey ?? key).toBe(original.key);
          if (!activeOnly || original.key.startsWith("agent:")) {
            expect(target).toBe(original);
          }
        }
        const visible = filterAndSortSessionEntries({
          ...prepared,
          entryFilter: (_key, entry) => entry.sessionId !== "main-global",
        });
        expect(visible.map(([, entry]) => entry.sessionId)).toEqual(
          expect.not.arrayContaining(["main-global", "shadow-global", "ops-shadow"]),
        );
        expect(rows.map((row) => row.entry.sessionId)).toEqual(samples.map(([id]) => id));
      } finally {
        projection.dispose();
      }
    });
  },
);

it("rejects duplicate ordinary keys introduced after store admission before filtering or pagination", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const primary = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const secondary = state.statePath("secondary.sqlite");
    const key = "agent:main:original";
    for (const [storePath, sessionKey] of [
      [primary, key],
      [secondary, "agent:main:other"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey },
        { sessionId: sessionKey, updatedAt: Date.now() },
      );
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      const opts = { configuredAgentsOnly: true };
      expect((await listProjectedSessions({ projection, opts })).sessions).toHaveLength(2);
      const duplicate = { agentId: "main", storePath: secondary, sessionKey: key };
      replaceSessionEntrySync(duplicate, { sessionId: "duplicate", updatedAt: Date.now() + 1 });
      await expect(
        listProjectedSessions({ projection, opts: { ...opts, limit: 1, offset: 1 } }),
      ).rejects.toThrow("duplicate rows resolve to canonical session key");
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: secondary,
        archiveTranscript: false,
        target: { canonicalKey: key, storeKeys: [key] },
      });
      const result = await listProjectedSessions({ projection, opts });
      expect(result.sessions.map((row) => row.key).toSorted()).toEqual([key, "agent:main:other"]);
    } finally {
      projection.dispose();
    }
  });
});
