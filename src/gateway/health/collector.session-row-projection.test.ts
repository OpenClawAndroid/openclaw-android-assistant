import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readStatusSessionStores } from "../../status/session-stores.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { observeSessionRowBackfill } from "../session-row-backfill.test-support.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { buildHealthAgentSummaries, resolveHealthAgentOrder } from "./collector.js";

afterEach(() => vi.restoreAllMocks());

async function settleProjection(projection: SessionRowProjection) {
  do {
    await projection.ensureMaterialized();
  } while (projection.needsMaterialization);
}

describe("health and status resident session summaries", () => {
  it("counts a shared physical store once while retaining per-agent windows", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const storePath = path.join(stateDir, "shared-sessions.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, worker: {} },
          defaults: { systemAgent: { agentId: "main" } },
        },
        session: { store: storePath },
      };
      const sessionKeys = ["agent:main:primary", "agent:worker:primary"];
      const backfill = observeSessionRowBackfill(sessionKeys);
      for (const [agentId, updatedAt] of [
        ["main", 10],
        ["worker", 20],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId, sessionKey: `agent:${agentId}:primary`, storePath },
          { sessionId: `${agentId}-primary`, updatedAt },
        );
      }
      const projection = await createSessionRowProjection({ cfg });
      try {
        await settleProjection(projection);
        await backfill;
        await settleProjection(projection);
        const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
        const reads = (["all", "get", "iterate"] as const).map((method) =>
          vi.spyOn(StatementSync.prototype, method),
        );
        const agents = [{ id: "main" }, { id: "worker" }];

        const status = await readStatusSessionStores(cfg, agents, 10, projection);
        const health = await buildHealthAgentSummaries(
          cfg,
          resolveHealthAgentOrder(cfg),
          projection,
        );

        expect(status.paths).toHaveLength(1);
        expect(status.count).toBe(2);
        expect(status.byAgent.map((agent) => [agent.agent.id, agent.count])).toEqual([
          ["main", 1],
          ["worker", 1],
        ]);
        expect(health.map((agent) => [agent.agentId, agent.sessions.count])).toEqual([
          ["main", 1],
          ["worker", 1],
        ]);
        expect(prepares).not.toHaveBeenCalled();
        for (const read of reads) {
          expect(read).not.toHaveBeenCalled();
        }
      } finally {
        projection.dispose();
      }
    });
  });

  it("uses no SQLite for clean repeats and follows dirty and topology publications", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
      };
      const mainKey = "agent:main:primary";
      const backfill = observeSessionRowBackfill([mainKey]);
      const committed = await upsertSessionEntryCore(
        { agentId: "main", sessionKey: mainKey },
        { sessionId: "main-primary", updatedAt: 10 },
      );
      if (!committed) {
        throw new Error("Expected the session write owner to return its committed row");
      }
      const initialUpdatedAt = committed.updatedAt;
      const projection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
      try {
        await settleProjection(projection);
        await backfill;
        await settleProjection(projection);
        expect(
          projection.describe({
            agentId: "main",
            key: mainKey,
          })?.entry,
        ).toMatchObject({ sessionId: committed.sessionId, updatedAt: initialUpdatedAt });

        const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
        const reads = (["all", "get", "iterate"] as const).map((method) =>
          vi.spyOn(StatementSync.prototype, method),
        );
        const agents = [{ id: "main" }];
        const readStatus = () => readStatusSessionStores(cfg, agents, 10, projection);
        const readHealth = () =>
          buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(cfg), projection);

        const firstStatus = await readStatus();
        expect(firstStatus.byAgent[0]).toMatchObject({
          count: 1,
          recent: [
            expect.objectContaining({
              sessionKey: mainKey,
              entry: expect.objectContaining({ updatedAt: initialUpdatedAt }),
            }),
          ],
        });
        const firstHealth = await readHealth();
        expect(firstHealth[0]?.sessions).toMatchObject({
          count: 1,
          recent: [expect.objectContaining({ key: mainKey, updatedAt: initialUpdatedAt })],
        });
        await readStatus();
        await readHealth();
        expect(prepares).not.toHaveBeenCalled();
        for (const read of reads) {
          expect(read).not.toHaveBeenCalled();
        }

        const dirtyBackfill = observeSessionRowBackfill([mainKey]);
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: mainKey },
          { sessionId: "main-primary", updatedAt: 20 },
        );
        expect(projection.dirtyRowCount).toBeGreaterThan(0);
        const dirty = await readStatus();
        expect(dirty.byAgent[0]?.recent[0]?.entry.updatedAt).toBe(20);
        expect(
          prepares.mock.calls.length +
            reads.reduce((total, read) => total + read.mock.calls.length, 0),
        ).toBeGreaterThan(0);
        await dirtyBackfill;
        await settleProjection(projection);

        prepares.mockClear();
        for (const read of reads) {
          read.mockClear();
        }
        const clean = await readHealth();
        expect(clean[0]?.sessions.recent[0]?.updatedAt).toBe(20);
        expect(prepares).not.toHaveBeenCalled();
        for (const read of reads) {
          expect(read).not.toHaveBeenCalled();
        }

        const workerKey = "agent:worker:primary";
        await upsertSessionEntryCore(
          { agentId: "worker", sessionKey: workerKey },
          { sessionId: "worker-primary", updatedAt: 30 },
        );
        cfg = {
          agents: {
            ownership: "explicit",
            entries: { main: {}, worker: {} },
            defaults: { systemAgent: { agentId: "main" } },
          },
        };
        sessionChanges.emit({ all: true, scope: "config" });
        const topology = await buildHealthAgentSummaries(
          cfg,
          resolveHealthAgentOrder(cfg),
          projection,
        );
        expect(topology.map((agent) => [agent.agentId, agent.sessions.count])).toEqual([
          ["main", 1],
          ["worker", 1],
        ]);
        expect(topology[1]?.sessions.recent[0]?.key).toBe(workerKey);
      } finally {
        projection.dispose();
      }
    });
  });
});
