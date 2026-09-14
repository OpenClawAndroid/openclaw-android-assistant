import { DatabaseSync, StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getCronJobsStoreRevision,
  loadCronJobsStoreWithConfigJobs,
  noteCronJobsStoreCommit,
  saveCronJobsStore,
} from "./store.js";
import { restoreCronLoadError, serializeCronLoadError } from "./store/load-error.js";
import type { CronStoreWorkerOperations } from "./store/load-worker.types.js";
import type { CronStoreFile } from "./types.js";

it("loads complete partitioned cron state off the host and preserves it through reopen", async () => {
  await withOpenClawTestState({ label: "cron-worker-load" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const otherStorePath = state.statePath("other", "jobs.json");
    const store: CronStoreFile = {
      version: 1,
      jobs: ["first", "second"].map((id) => ({
        id,
        name: id,
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 2,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "scheduled café 🦞" },
        state: { nextRunAtMs: 60_001 },
      })),
    };
    await saveCronJobsStore(storePath, store);
    await saveCronJobsStore(otherStorePath, { version: 1, jobs: [] });
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    const revision = getCronJobsStoreRevision(storePath);
    const spies = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      vi.spyOn(StatementSync.prototype, "get"),
      vi.spyOn(StatementSync.prototype, "all"),
      vi.spyOn(StatementSync.prototype, "run"),
      vi.spyOn(StatementSync.prototype, "iterate"),
    ];
    try {
      const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(loaded.store.jobs.map((job) => job.id)).toEqual(["first", "second"]);
      expect(loaded.store.jobs[0]).toMatchObject(
        expectDefined(store.jobs[0], "first seeded cron job"),
      );
      expect(loaded.configJobs).toHaveLength(2);
      expect(loaded.configJobIndexes).toEqual([0, 1]);
      expect(loaded.configJobRuntimeEntries[0]?.state).toMatchObject({ nextRunAtMs: 60_001 });
      expect(loaded.jobsFingerprint).toEqual(expect.any(String));
      expect(loaded.invalidConfigRows).toEqual([]);
      expect((await loadCronJobsStoreWithConfigJobs(otherStorePath)).store.jobs).toEqual([]);
      expect(getCronJobsStoreRevision(storePath)).toBe(revision);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      for (const job of store.jobs) {
        job.name = `updated ${job.id}`;
      }
      await saveCronJobsStore(storePath, store);
      for (const spy of spies) {
        spy.mockClear();
      }
      const updated = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(updated.store.jobs.map((job) => job.name)).toEqual([
        "updated first",
        "updated second",
      ]);
      expect(updated.jobsFingerprint).not.toBe(loaded.jobsFingerprint);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      // The retained synchronous writer owns its close-time WAL maintenance.
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      for (const spy of spies) {
        spy.mockClear();
      }
      expect(await loadCronJobsStoreWithConfigJobs(storePath)).toEqual(updated);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

describe("worker load result publication", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { ok: true, repairCommits: 2 },
    { ok: false, repairCommits: 2 },
    { ok: false, repairCommits: 0 },
  ])(
    "publishes completed or uncertain load repairs before settling success=$ok count=$repairCommits",
    async ({ ok, repairCommits }) => {
      const storePath = `/synthetic/cron-repair-result-${ok}-${repairCommits}/jobs.json`;
      const result: CronStoreWorkerOperations["cron.loadMutable"]["output"] = ok
        ? {
            ok: true,
            repairCommits,
            loaded: {
              store: { version: 1, jobs: [] },
              configJobs: [],
              configJobIndexes: [],
              configJobRuntimeEntries: [],
              invalidConfigRows: [],
            },
          }
        : {
            ok: false,
            repairCommits,
            error: { name: "Error", message: "later load stage failed", code: "SQLITE_ERROR" },
          };
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        async (_context, operation) => operation({ execute: vi.fn().mockResolvedValue(result) }),
      );
      noteCronJobsStoreCommit(storePath);
      const before = getCronJobsStoreRevision(storePath);
      if (ok) {
        await expect(loadCronJobsStoreWithConfigJobs(storePath)).resolves.toHaveProperty(
          "store.jobs",
          [],
        );
      } else {
        await expect(loadCronJobsStoreWithConfigJobs(storePath)).rejects.toMatchObject({
          message: "later load stage failed",
          code: "SQLITE_ERROR",
        });
      }
      expect(getCronJobsStoreRevision(storePath)).toBe(before + Math.max(1, repairCommits));
    },
  );

  it("invalidates a cached load when transport cannot provide its repair result", async () => {
    const storePath = "/synthetic/cron-unavailable-result/jobs.json";
    const failure = new Error("worker result unavailable");
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockRejectedValue(failure);
    const before = getCronJobsStoreRevision(storePath);
    await expect(loadCronJobsStoreWithConfigJobs(storePath)).rejects.toBe(failure);
    expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
  });

  it("preserves the coordinator cause used by Doctor diagnostics", () => {
    const native = Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" });
    const original = new SqliteCoordinatorError("repair completed but cleanup failed", native);
    const restored = restoreCronLoadError(serializeCronLoadError(original));
    expect(restored.name).toBe(original.name);
    expect(restored.cause).toMatchObject({ message: "database busy", code: "SQLITE_BUSY" });
    expect(formatErrorMessage(restored, { redact: (text) => text })).toBe(
      formatErrorMessage(original, { redact: (text) => text }),
    );
  });
});
