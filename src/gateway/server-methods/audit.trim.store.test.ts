import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { listAuditEvents, recordAuditEvent } from "../../audit/audit-event-store.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { auditHandlers } from "./audit.js";

const tempDirs: string[] = [];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  return { env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-audit-trim-") } };
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  delete process.env.OPENCLAW_STATE_DIR;
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("audit.list padded filters against a real audit store", () => {
  it.each(["audit.list", "audit.activity.list"] as const)(
    "%s returns padded filters without host SQLite",
    async (method) => {
      const database = createDatabaseOptions();
      const stateDir = expectDefined(database.env?.OPENCLAW_STATE_DIR, "temp state dir");
      process.env.OPENCLAW_STATE_DIR = stateDir;

      const input = {
        sourceId: "audit-trim-run-source",
        occurredAt: Date.now(),
        kind: "agent_run" as const,
        actorType: "agent" as const,
        actorId: "main",
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "run-trim-1",
      };
      recordAuditEvent(
        { ...input, sourceSequence: 1, action: "agent.run.started", status: "started" },
        database,
      );
      const finished = recordAuditEvent(
        {
          ...input,
          sourceId: "audit-trim-finished",
          sourceSequence: 2,
          action: "agent.run.finished",
          status: "succeeded",
        },
        database,
      );

      // Negative control: untrimmed filter values miss the planted row at the store.
      expect(
        (
          await listAuditEvents({
            limit: 20,
            filters: { agentId: " main ", runId: " run-trim-1 " },
            database,
          })
        ).events,
      ).toEqual([]);

      await closeOpenClawStateDatabaseAsync();
      const native = requireNodeSqlite();
      const counters = [
        vi.spyOn(native.DatabaseSync.prototype, "prepare"),
        vi.spyOn(native.DatabaseSync.prototype, "exec"),
        ...(["get", "all", "run", "iterate"] as const).map((operation) =>
          vi.spyOn(native.StatementSync.prototype, operation),
        ),
      ];
      const respond = vi.fn();
      await expectDefined(
        auditHandlers[method],
        "audit.list handler",
      )({
        params: {
          limit: 1,
          agentId: " main ",
          sessionKey: " agent:main:main ",
          runId: " run-trim-1 ",
        },
        respond,
      } as never);

      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          nextCursor: String(finished?.sequence),
          events: [
            expect.objectContaining({
              agentId: "main",
              runId: "run-trim-1",
              action: "agent.run.finished",
            }),
          ],
        }),
      );
      respond.mockClear();
      await expectDefined(
        auditHandlers[method],
        "audit list handler",
      )({
        params: { limit: 1, cursor: String(finished?.sequence) },
        respond,
      } as never);
      expect(respond).toHaveBeenCalledWith(true, {
        events: [expect.objectContaining({ action: "agent.run.started" })],
      });
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    },
  );
});
