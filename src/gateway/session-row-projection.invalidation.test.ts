import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as catalogLookup from "../agents/model-catalog-lookup.js";
import {
  recordSessionParticipant,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail, setDisplayName } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as projectionWork from "./session-projection-work.js";
import * as materialization from "./session-row-projection-materialize.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  "profiles",
  "agent-runs",
  "subagent-runs",
  "worker-environments",
  "worker-placements",
  "sessions",
])(
  "serves concurrent lists after broad %s changes without a session-entry drain",
  async (scope) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        agents: { list: [{ id: "main", default: true }], defaults: { model: "unit-test/model" } },
      };
      const count = 256;
      for (let index = 0; index < count + 8; index++) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: `agent:main:row-${index}` },
          {
            sessionId: `row-${index}`,
            updatedAt: index < count ? index + 2 : 1,
            ...(index >= count ? { archivedAt: 1 } : {}),
          },
        );
      }
      const release = projectionWork.retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [{ provider: "unit-test", id: "model", name: "Model" }],
      });
      const opts = { limit: 20, archived: "all", search: "unit-test/model" } as const;
      const drain = createDeferredCore();
      try {
        await listProjectedSessions({ projection, opts });
        const catalogReads = vi.spyOn(catalogLookup, "findModelCatalogEntry");
        await listProjectedSessions({ projection, opts });
        const warmCatalogLookups = catalogReads.mock.calls.length;
        catalogReads.mockClear();
        const reads = vi.spyOn(materialization, "readSessionRowEntry");
        vi.spyOn(projectionWork, "yieldSessionListWork").mockReturnValue(drain.promise);
        sessionChanges.emit({ all: true, scope });
        const lists = Promise.all(
          Array.from({ length: 8 }, () => listProjectedSessions({ projection, opts })),
        );
        const result = await Promise.race([lists, nextTurn().then(() => undefined)]);
        expect(result?.map((list) => list.count)).toEqual(Array.from({ length: 8 }, () => 20));
        expect(reads).not.toHaveBeenCalled();
        // Presentation changes must not add catalog work beyond the warm request's defaults.
        expect(catalogReads.mock.calls.length).toBeLessThanOrEqual(warmCatalogLookups * 8);
        expect(projection.dirtyRowCount).toBe(0);
      } finally {
        drain.resolve();
        await projection.ensureMaterialized();
        projection.dispose();
        release();
      }
    });
  },
);

it("refreshes profile display fields on selected live and archived rows without rereading entries", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const owner = ensureProfileForEmail("owner@example.com");
    const participant = ensureProfileForEmail("participant@example.com");
    for (const archived of [false, true]) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:profile-${archived}` },
        {
          sessionId: `profile-${archived}`,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: owner.id },
          ...(archived
            ? { archivedAt: 1, archivedBy: { type: "human" as const, id: owner.id } }
            : {}),
        },
      );
    }
    for (const archived of [false, true]) {
      recordSessionParticipant(
        { agentId: "main", sessionKey: `agent:main:profile-${archived}` },
        { identity: { type: "profile", id: participant.id }, promptedAt: 1 },
      );
    }
    const release = projectionWork.retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await listProjectedSessions({ projection, opts: { archived: "all" } });
      const reads = vi.spyOn(materialization, "readSessionRowEntry");
      setDisplayName(owner.id, "Current owner");
      setDisplayName(participant.id, "Current participant");
      const result = await listProjectedSessions({ projection, opts: { archived: "all" } });
      expect(result.sessions).toHaveLength(2);
      for (const row of result.sessions) {
        expect(row.createdActor?.label).toBe("Current owner");
        expect(row.owner?.actor.label).toBe("Current owner");
        expect(row.participants).toEqual([
          expect.objectContaining({ label: "Current participant" }),
        ]);
        if (row.archived) {
          expect(row.archivedBy?.label).toBe("Current owner");
        }
      }
      expect(reads).not.toHaveBeenCalled();
    } finally {
      projection.dispose();
      release();
    }
  });
});
