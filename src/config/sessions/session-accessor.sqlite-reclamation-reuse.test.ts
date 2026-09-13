import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "../../state/openclaw-agent-db-lease.js";
import {
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
  setOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import { loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { withWorkerSqliteIntegrityCounter } from "./session-accessor.sqlite-integrity-counter.test-support.js";
import * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import {
  createLifecycleArtifactReclamationPlan,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

const validation = vi.hoisted(() => ({
  checks: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        super(
          filename,
          options.workerData?.operation === "reclaim"
            ? withWorkerSqliteIntegrityCounter(options, validation.checks)
            : options,
        );
      }
    },
  };
});

beforeEach(() => {
  validation.checks = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
});
function fullChecks() {
  return Atomics.load(new Int32Array(validation.checks), 0);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createFixture(sessionIds = ["first", "second"], agentId = "main") {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("reclamation-reuse-")) };
  const options = { agentId, env };
  const scopes = sessionIds.map((sessionId) => ({
    agentId: options.agentId,
    env,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  }));
  for (const scope of scopes) {
    ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  }
  const database = openOpenClawAgentDatabase(options);
  const plans = scopes.map((scope) =>
    createLifecycleArtifactReclamationPlan({
      agentId: "main",
      databaseOptions: { ...options, path: database.path },
      entries: [{ sessionKey: scope.sessionKey, expectedEntry: loadSessionEntryReadOnly(scope) }],
      materializedPlans: [],
    }),
  );
  return { options, scopes, database, plans };
}

function observeReclamationWorkers(onSpawn?: (worker: Worker) => void) {
  const spawned: Worker[] = [];
  const create = archiveWorker.createSqliteTranscriptArchiveWorker;
  vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
    const worker = create(data);
    spawned.push(worker);
    onSpawn?.(worker);
    return worker;
  });
  return spawned;
}

function leasesFor(fixture: ReturnType<typeof createFixture>) {
  return openOpenClawStateDatabase({ env: fixture.options.env })
    .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?")
    .all(fixture.database.path);
}

test("retained reclamation operations share the first full scan until the Gateway owner invalidates it", async () => {
  const { options, database, scopes } = createFixture(["parent", "child"]);
  const databaseOptions = { ...options, path: database.path };
  const plan = reclamation.createHistoryEvictionReclamationPlan({
    databaseOptions,
    diskBudget: {},
    materializedPlans: [],
    protectedSessionIds: new Set(scopes.map((scope) => scope.sessionId)),
    sessionId: "already-removed-history",
  });
  for (const scope of scopes) {
    expect(appendTranscriptEventSync(scope, { type: "integrity-proof-survivor" })).toEqual({
      ok: true,
      value: true,
    });
  }
  closeOpenClawAgentDatabasesForTest(databaseOptions.env.OPENCLAW_STATE_DIR);
  const workerIds = new Set<number>();
  for (let pass = 0; pass < 3; pass += 1) {
    if (pass === 2) {
      await closeOpenClawAgentDatabasesAsync(databaseOptions.env.OPENCLAW_STATE_DIR);
      closeOpenClawAgentDatabasesForTest(databaseOptions.env.OPENCLAW_STATE_DIR);
    }
    const diagnostics: SqliteSessionReclamationDiagnostics = {};
    await expect(
      runSqliteSessionReclamation({ forceInProcess: false, plan, diagnostics }),
    ).resolves.toMatchObject({ kind: "history-eviction", value: { deleted: true } });
    expect(fullChecks()).toBe(pass === 2 ? 2 : 1);
    expect(diagnostics.workerThreadId).toBeGreaterThan(0);
    workerIds.add(diagnostics.workerThreadId!);
    for (const scope of scopes) {
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe(scope.sessionId);
      expect(await loadTranscriptEvents(scope)).toContainEqual({
        type: "integrity-proof-survivor",
      });
    }
  }
  expect(workerIds.size).toBe(2);
});

test("warm Worker results cannot revive proof invalidated after a competing parent verification", async () => {
  const { database, plans } = createFixture();
  invalidateOpenClawAgentDatabaseValidation(database.path);
  const observed: {
    worker?: OpenClawAgentDatabaseValidation;
    parent?: OpenClawAgentDatabaseValidation;
  } = {};
  const spawned = observeReclamationWorkers((worker) => {
    worker.prependListener(
      "message",
      (message: reclamationWorker.SqliteReclamationWorkerMessage) => {
        if (message.type === "reclaimed" && message.operationId === 1) {
          observed.worker = message.validation;
          // A concurrent canonical opener can finish before the first Worker result is adopted.
          observed.parent = setOpenClawAgentDatabaseValidation(database);
        }
      },
    );
  });
  await runSqliteSessionReclamation({ forceInProcess: false, plan: plans[0]! });
  expect(observed.worker).toBeDefined();
  expect(observed.parent).toBeDefined();
  expect(getOpenClawAgentDatabaseValidation(database)).toBe(observed.parent);

  invalidateOpenClawAgentDatabaseValidation(database.path);
  expect(Atomics.load(new Int32Array(observed.worker!.valid), 0)).toBe(1);
  expect(Atomics.load(new Int32Array(observed.parent!.valid), 0)).toBe(0);
  await runSqliteSessionReclamation({ forceInProcess: false, plan: plans[1]! });
  expect(spawned).toHaveLength(1);
  expect(getOpenClawAgentDatabaseValidation(database)).toBeUndefined();
});

test.each([
  { cold: false, agentId: "main" },
  { cold: true, agentId: "main" },
  { cold: false, agentId: "MAIN" },
])(
  "keeps each request context and reopens after explicit database retirement (retire: $cold, agent: $agentId)",
  async ({ cold, agentId }) => {
    const fixture = createFixture(undefined, agentId);
    const { options, database, plans, scopes } = fixture;
    invalidateOpenClawAgentDatabaseValidation(database.path);
    const spawned = observeReclamationWorkers();
    const context = new AsyncLocalStorage<number>();
    const diagnostics: SqliteSessionReclamationDiagnostics[] = [{}, {}];
    try {
      for (const [index, plan] of plans.entries()) {
        if (cold && index === 1) {
          expect(await closeOpenClawAgentDatabaseByPathAsync(database.path)).toBe(true);
          expect(spawned[0]?.threadId).toBe(-1);
        }
        let checks = 0;
        await expect(
          context.run(index, () =>
            runSqliteSessionReclamation({
              forceInProcess: false,
              plan,
              diagnostics: diagnostics[index],
              assertCommitAllowed: () => {
                checks += 1;
                expect(context.getStore()).toBe(index);
              },
            }),
          ),
        ).resolves.toMatchObject({ kind: "lifecycle-artifacts", value: { removedEntries: 1 } });
        expect(checks).toBeGreaterThan(1);
        expect(loadSessionEntryReadOnly(scopes[index]!)).toBeUndefined();
      }
      expect(spawned).toHaveLength(cold ? 2 : 1);
      expect(fullChecks()).toBe(1);
      expect(diagnostics[0]?.workerThreadId).toBeGreaterThan(0);
      if (cold) {
        expect(diagnostics[1]?.workerThreadId).not.toBe(diagnostics[0]?.workerThreadId);
      } else {
        expect(diagnostics[1]?.workerThreadId).toBe(diagnostics[0]?.workerThreadId);
      }
      if (cold) {
        expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      }
      expect(leasesFor(fixture)).toHaveLength(cold ? 1 : 2);
    } finally {
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
    }
    expect(spawned.every((worker) => worker.threadId === -1)).toBe(true);
    expect(leasesFor(fixture)).toHaveLength(0);
  },
);

test.each(["admission", "commit"] as const)(
  "rejects a revoked retained claim on the reused Worker's next %s",
  async (checkpoint) => {
    const { database, plans, scopes } = createFixture();
    await runSqliteSessionReclamation({ forceInProcess: false, plan: plans[0]! });
    const withWorker = reclamationWorker.withSqliteReclamationWorker;
    let revoked = false;
    let closeElapsedMs = 0;
    vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
      (options, claim, run, assertRequestCurrent) =>
        withWorker(
          options,
          claim,
          async (worker) => {
            const execute = worker.run.bind(worker);
            const spy = vi.spyOn(worker, "run").mockImplementation((params) =>
              execute({
                ...params,
                ...(checkpoint === "commit"
                  ? {
                      onCommitRequest: () => {
                        const started = performance.now();
                        revoked = closeOpenClawAgentDatabaseByPath(database.path);
                        closeElapsedMs = performance.now() - started;
                        return params.onCommitRequest();
                      },
                    }
                  : {
                      withWriteAdmission: async (...args) => {
                        revoked = closeOpenClawAgentDatabaseByPath(database.path);
                        return params.withWriteAdmission(...args);
                      },
                    }),
              }),
            );
            try {
              return await run(worker);
            } finally {
              spy.mockRestore();
            }
          },
          assertRequestCurrent,
        ),
    );
    await expect(
      runSqliteSessionReclamation({ forceInProcess: false, plan: plans[1]! }),
    ).rejects.toThrow("claim is no longer current");
    expect(revoked).toBe(true);
    if (checkpoint === "commit") {
      // A retained transaction must be signaled before native close can wait on its lock.
      expect(closeElapsedMs).toBeLessThan(2_000);
    }
    expect(loadSessionEntryReadOnly(scopes[0]!)).toBeUndefined();
    expect(loadSessionEntryReadOnly(scopes[1]!)).toMatchObject({ sessionId: "second" });
  },
);

test.each(["path", "root"] as const)(
  "joins queued cold reclamation before %s retirement returns",
  async (retirement) => {
    const fixture = createFixture();
    await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
    expect(getOpenClawAgentDatabaseIfOpen(fixture.options)).toBeUndefined();
    const spawned = observeReclamationWorkers();
    const enteredQueue = createDeferredCore();
    const releaseQueue = createDeferredCore();
    const enqueued = createDeferredCore();
    const observed: { claim?: OpenClawAgentDatabaseClaim } = {};
    const withWorker = reclamationWorker.withSqliteReclamationWorker;
    vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
      (options, claim, run, assertRequestCurrent) => {
        const result = withWorker(options, claim, run, assertRequestCurrent);
        observed.claim = claim;
        enqueued.resolve();
        return result;
      },
    );
    const holding = archiveWorker.runExclusiveSqliteTranscriptArchiveWorker(async () => {
      enteredQueue.resolve();
      await releaseQueue.promise;
    });
    await enteredQueue.promise;
    const request = runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[0]! });
    void request.catch(() => {});
    let closing: Promise<unknown> | undefined;
    try {
      await Promise.race([enqueued.promise, request]);
      expect(observed.claim?.isCurrent()).toBe(true);
      closing =
        retirement === "path"
          ? closeOpenClawAgentDatabaseByPathAsync(fixture.database.path)
          : closeOpenClawAgentDatabasesAsync(fixture.options.env.OPENCLAW_STATE_DIR);
      let closeSettled = false;
      void closing.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );
      await yieldToEventLoop();
      expect(closeSettled).toBe(false);
      releaseQueue.resolve();
      await expect(request).rejects.toThrow(/revoked|no longer current|admission.*changed/i);
      await closing;
      expect(observed.claim?.isCurrent()).toBe(false);
      expect(spawned).toHaveLength(0);
      expect(loadSessionEntryReadOnly(fixture.scopes[0]!)).toMatchObject({ sessionId: "first" });
      expect(leasesFor(fixture)).toHaveLength(0);
    } finally {
      releaseQueue.resolve();
      await Promise.allSettled([holding, request, ...(closing ? [closing] : [])]);
    }
  },
);

test("retires the previous database before opening a different agent store", async () => {
  const first = createFixture();
  const second = createFixture();
  invalidateOpenClawAgentDatabaseValidation(first.database.path);
  invalidateOpenClawAgentDatabaseValidation(second.database.path);
  const spawned = observeReclamationWorkers();
  await runSqliteSessionReclamation({ forceInProcess: false, plan: first.plans[0]! });
  expect(leasesFor(first)).toHaveLength(2);
  await runSqliteSessionReclamation({ forceInProcess: false, plan: second.plans[0]! });
  expect(spawned).toHaveLength(2);
  expect(fullChecks()).toBe(2);
  expect(spawned[0]?.threadId).toBe(-1);
  expect(leasesFor(first)).toHaveLength(1);
  expect(leasesFor(second)).toHaveLength(2);
  expect(loadSessionEntryReadOnly(first.scopes[1]!)).toMatchObject({ sessionId: "second" });
  expect(loadSessionEntryReadOnly(second.scopes[1]!)).toMatchObject({ sessionId: "second" });
});

test("retires after sixty idle seconds and opens a new Worker for the next request", async () => {
  const fixture = createFixture(["first", "second", "third"]);
  invalidateOpenClawAgentDatabaseValidation(fixture.database.path);
  const spawned = observeReclamationWorkers();
  await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[0]! });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldClearNativeTimers: true });
  try {
    await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[1]! });
    expect(spawned).toHaveLength(1);
    expect(fullChecks()).toBe(1);
    const exited = once(spawned[0]!, "exit");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(spawned[0]?.threadId).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1);
    await exited;
  } finally {
    vi.useRealTimers();
  }
  expect(leasesFor(fixture)).toHaveLength(1);
  await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[2]! });
  expect(spawned).toHaveLength(2);
  expect(fullChecks()).toBe(1);
  expect(loadSessionEntryReadOnly(fixture.scopes[2]!)).toBeUndefined();
});

test("joins a crashed reused Worker, releases its exact lease, and preserves the uncommitted victim", async () => {
  const fixture = createFixture(["first", "second", "third"]);
  const spawned = observeReclamationWorkers();
  await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[0]! });
  const child = spawned[0]!;
  let terminated = false;
  child.prependListener("message", (message: { type: string; operationId?: number }) => {
    if (message.type === "admission-request" && message.operationId === 2 && !terminated) {
      terminated = true;
      void child.terminate();
    }
  });
  await expect(
    runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[1]! }),
  ).rejects.toThrow(/exited|uncertain/);
  expect(terminated).toBe(true);
  expect(child.threadId).toBe(-1);
  expect(leasesFor(fixture)).toHaveLength(1);
  expect(loadSessionEntryReadOnly(fixture.scopes[1]!)).toMatchObject({ sessionId: "second" });
  await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[2]! });
  expect(spawned).toHaveLength(2);
  expect(loadSessionEntryReadOnly(fixture.scopes[2]!)).toBeUndefined();
});

test("retains a crashed Worker's mismatched lease and retries only its restored receipt", async () => {
  const fixture = createFixture();
  const received: { receipt?: OpenClawAgentDatabaseWorkerLeaseReceipt } = {};
  const spawned = observeReclamationWorkers((worker) => {
    worker.on("message", (message: reclamationWorker.SqliteReclamationWorkerMessage) => {
      if (message.type === "lease") {
        received.receipt = message.receipt;
      }
    });
  });
  await runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plans[0]! });
  const retainedReceipt = received.receipt;
  if (!retainedReceipt) {
    throw new Error("Expected the real Worker's admitted lease receipt");
  }
  const child = spawned[0]!;
  await child.terminate();
  expect(child.threadId).toBe(-1);
  const kept = openOpenClawAgentDatabase({ ...fixture.options, agentId: "kept" });
  const state = openOpenClawStateDatabase({ env: fixture.options.env }).db;
  const readLeases = () =>
    state
      .prepare(
        "SELECT lease_id, agent_id, path, owner_pid, owner_start_time FROM agent_database_leases ORDER BY lease_id",
      )
      .all();
  const before = readLeases();
  expect(before).toContainEqual(expect.objectContaining({ lease_id: retainedReceipt.leaseId }));
  state
    .prepare("UPDATE agent_database_leases SET owner_pid = ? WHERE lease_id = ?")
    .run(retainedReceipt.ownerPid + 1, retainedReceipt.leaseId);
  try {
    const mismatched = readLeases();
    await expect(
      closeOpenClawAgentDatabaseByPathAsync(fixture.database.path),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: expect.stringContaining("receipt no longer matches") }),
      ],
    });
    expect(readLeases()).toEqual(mismatched);
    expect(fixture.database.db.isOpen).toBe(true);
    expect(kept.db.isOpen).toBe(true);
  } finally {
    state
      .prepare("UPDATE agent_database_leases SET owner_pid = ? WHERE lease_id = ?")
      .run(retainedReceipt.ownerPid, retainedReceipt.leaseId);
    await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
  }
  expect(readLeases()).toEqual(before.filter((row) => row.path === kept.path));
  expect(kept.db.isOpen).toBe(true);
});

test.each([false, true])(
  "reuses one Worker across history and cap-entry victims until lifecycle close (failure: %s)",
  async (failure) => {
    await withOpenClawTestState(
      { prefix: "reclamation-sweep-", layout: "state-only" },
      async (state) => {
        const sessionKey = "agent:main:explicit:sweep-lifetime";
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const databaseOptions = { agentId: "main", env: state.env };
        for (const [index, sessionId] of ["first", "second", "current"].entries()) {
          await replaceSessionEntry(
            { sessionKey, storePath },
            {
              sessionId,
              updatedAt: index + 1,
              ...(sessionId === "current"
                ? { archivedAt: 4, archiveReason: "active-session-cap" as const }
                : {}),
            },
          );
        }
        await reclaimSqliteFreePages(databaseOptions);
        const workers: Worker[] = [];
        const spawn = archiveWorker.createSqliteTranscriptArchiveWorker;
        vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation(
          (data) => {
            const worker = spawn(data);
            workers.push(worker);
            return worker;
          },
        );
        const run = reclamation.runSqliteSessionReclamation;
        let requests = 0;
        vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
          if (++requests === 2 && failure) {
            throw new Error("next victim preparation failed");
          }
          return run(params);
        });
        const sweep = enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
        });
        if (failure) {
          await expect(sweep).rejects.toThrow("next victim preparation failed");
        } else {
          const result = await sweep;
          expect(result?.removedEntries).toBe(3);
          expect(result?.totalBytesAfter).toBe(
            (await measureSessionPhysicalDiskUsage(storePath)).totalBytes,
          );
        }
        expect(
          openOpenClawAgentDatabase(databaseOptions)
            .db.prepare("SELECT session_id FROM session_windows ORDER BY session_id")
            .all(),
        ).toEqual(failure ? [{ session_id: "current" }, { session_id: "second" }] : []);
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBeGreaterThan(0);
        await closeOpenClawAgentDatabasesAsync(state.root);
        expect(workers[0]?.threadId).toBe(-1);
      },
    );
  },
);
