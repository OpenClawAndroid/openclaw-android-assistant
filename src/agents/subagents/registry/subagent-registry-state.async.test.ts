import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../../state/openclaw-state-db-cache.js";
import * as databaseCache from "../../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as workerStore from "../../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForSessions,
  getSubagentRunsSnapshotForRead,
  getSubagentMaintenanceRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForSessions,
  invalidateSubagentSessionListReadCache,
  onSubagentRegistryPersisted,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  publishSubagentRunsAfterAtomicStore,
  restoreSubagentRunsFromDisk,
  withSubagentSessionListRunsSnapshotForRead,
} from "./subagent-registry-state.js";
import * as store from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const transport = vi.hoisted(() => ({
  execute: vi.fn<() => Promise<Map<string, SubagentRunReadRecord> | undefined>>(),
}));
vi.mock("../../../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: async (
    _context: unknown,
    operation: (worker: { execute: typeof transport.execute }) => Promise<unknown>,
  ) => operation({ execute: transport.execute }),
}));

let state: OpenClawTestState;
let memory: Map<string, SubagentRunRecord>;
let replies: ReturnType<
  typeof createDeferredCore<Map<string, SubagentRunReadRecord> | undefined>
>[];
const rootSessionKey = "agent:main:main";
const otherSessionKey = "agent:main:other";
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  openOpenClawStateDatabase();
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  clearSubagentRunsReadCacheForTest();
  memory = new Map();
  replies = [];
  transport.execute.mockReset().mockImplementation(() => {
    const reply = createDeferredCore<Map<string, SubagentRunReadRecord> | undefined>();
    replies.push(reply);
    return reply.promise;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearSubagentRunsReadCacheForTest();
  await state.cleanup();
});
function runs(
  model: string,
  runId = "one",
  scope: Partial<
    Pick<SubagentRunRecord, "childSessionKey" | "requesterSessionKey" | "controllerSessionKey">
  > = {},
) {
  const run = createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    model,
    completion: { required: false },
    delivery: { status: "not_required" },
    ...scope,
  });
  return new Map([[run.runId, run]]);
}
async function started(index: number) {
  await vi.waitFor(() => expect(replies).toHaveLength(index + 1));
  return replies[index]!;
}
function read(yieldIfNeeded?: () => Promise<void> | undefined) {
  return withSubagentSessionListRunsSnapshotForRead(
    memory,
    captureOpenClawStateWorkerContext(),
    (snapshot) => [...snapshot.values()].map((run) => run.model),
    yieldIfNeeded,
  );
}
function expectScopedModels(
  sessionKey: string,
  treeModels: string[],
  options: {
    controllerModels?: string[];
    inMemoryRuns?: Map<string, SubagentRunRecord>;
  } = {},
) {
  const inMemoryRuns = options.inMemoryRuns ?? new Map<string, SubagentRunRecord>();
  expect(
    [...getSubagentSessionListRunsSnapshotForSessions(inMemoryRuns, [sessionKey]).values()].map(
      (run) => run.model,
    ),
  ).toEqual(treeModels);
  expect(
    [...getSubagentSessionListRunsSnapshotForRead(inMemoryRuns, [sessionKey]).values()].map(
      (run) => run.model,
    ),
  ).toEqual(options.controllerModels ?? treeModels);
}

it("captures in-memory-only reads after the budget pause without reading persisted rows", async () => {
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "0");
  memory = runs("before");
  const pause = createDeferredCore();
  let holdRead = true;
  const first = read(() => (holdRead ? pause.promise : undefined));
  for (const [id, entry] of runs("current")) {
    memory.set(id, entry);
  }
  holdRead = false;
  pause.resolve();
  expect(await first).toEqual(["current"]);
  expect(transport.execute).not.toHaveBeenCalled();
});

it("coalesces a fill and projects current memory after the reply", async () => {
  const first = read();
  await started(0);
  const second = read();
  expect(replies).toHaveLength(1);
  for (const [id, run] of runs("current")) {
    memory.set(id, run);
  }
  replies[0]!.resolve(runs("old"));
  expect(await first).toEqual(["current"]);
  expect(await second).toEqual(["current"]);
  expectScopedModels(rootSessionKey, ["old"]);
  expectScopedModels(rootSessionKey, ["current"], { inMemoryRuns: memory });
});

it.each([
  "full publication",
  "named deletion",
  "failed best effort",
  "restore",
  "complete tree fill",
  "ownership rebind",
  "reset",
])("rejects a delayed reply across %s in the same millisecond", async (change) => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const first = read();
  await started(0);
  if (change === "full publication") {
    persistSubagentRunsToDisk(runs("current"));
  } else if (change === "named deletion") {
    persistSubagentRunsToDisk(new Map(), ["one"]);
  } else if (change === "failed best effort") {
    vi.spyOn(store, "saveSubagentRegistryToSqlite").mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    persistSubagentRunsToDisk(runs("current"));
  } else if (change === "restore") {
    store.saveSubagentRegistryToSqlite(runs("current"));
    restoreSubagentRunsFromDisk({ runs: memory });
  } else if (change === "complete tree fill") {
    store.saveSubagentRegistryToSqlite(runs("current"));
    expectScopedModels(rootSessionKey, ["current"]);
  } else if (change === "ownership rebind") {
    invalidateSubagentSessionListReadCache();
  } else {
    clearSubagentRunsReadCacheForTest();
  }
  replies[0]!.resolve(
    runs("old", "one", {
      requesterSessionKey: otherSessionKey,
      controllerSessionKey: otherSessionKey,
      childSessionKey: "agent:main:subagent:old",
    }),
  );
  if (["ownership rebind", "reset"].includes(change)) {
    (await started(1)).resolve(runs("current"));
  }
  expect(await first).toEqual(change === "named deletion" ? [] : ["current"]);
  expectScopedModels(rootSessionKey, change === "named deletion" ? [] : ["current"]);
  expectScopedModels(otherSessionKey, []);
});

it.each(["reset", "ownership rebind"])(
  "keeps the accepted newer fill when replies finish out of order after %s",
  async (change) => {
    const first = read();
    await started(0);
    if (change === "reset") {
      clearSubagentRunsReadCacheForTest();
    } else {
      invalidateSubagentSessionListReadCache();
    }
    const second = read();
    await started(1);
    replies[1]!.resolve(
      runs("current", "one", {
        requesterSessionKey: otherSessionKey,
        controllerSessionKey: otherSessionKey,
        childSessionKey: "agent:main:subagent:current",
      }),
    );
    expect(await second).toEqual(["current"]);
    expectScopedModels(rootSessionKey, []);
    expectScopedModels(otherSessionKey, ["current"]);
    replies[0]!.resolve(runs("old"));
    expect(await first).toEqual(["current"]);
    expect(await read()).toEqual(["current"]);
    expectScopedModels(rootSessionKey, []);
    expectScopedModels(otherSessionKey, ["current"]);
  },
);

it("does not supersede a fill on a rolled-back strict write", async () => {
  const first = read();
  await started(0);
  vi.spyOn(store, "saveSubagentRegistryToSqlite").mockImplementationOnce(() => {
    throw new Error("write failed");
  });
  expect(() => persistSubagentRunsToDiskOrThrow(runs("uncommitted"))).toThrow("write failed");
  replies[0]!.resolve(runs("committed"));
  expect(await first).toEqual(["committed"]);
  expectScopedModels(rootSessionKey, ["committed"]);
});

it.each(["best effort", "strict refusal", "strict commit", "atomic commit"])(
  "keeps %s publication independent of retired read admission",
  async (mode) => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    persistSubagentRunsToDiskOrThrow(runs("before"), ["one"]);
    expectScopedModels(rootSessionKey, ["before"]);
    const database = openOpenClawStateDatabase();
    const context = captureOpenClawStateWorkerContext();
    const current = runs("after");
    const entry = current.get("one")!;
    entry.execution = { status: "terminal", endedAt: 2, outcome: { status: "ok" } };
    entry.cleanupCompletedAt = 2;
    const wake = vi.fn();
    const unsubscribe = onSubagentRegistryPersisted(wake);
    const releaseClose = createDeferredCore();
    const unregister = registerOpenClawStateDatabaseAsyncResource({
      close: () => releaseClose.promise,
    });
    const events: Array<() => void> = [];
    const publish = () => {
      if (mode === "atomic commit") {
        publishSubagentRunsAfterAtomicStore(current, ["one"], events);
      } else if (mode === "best effort") {
        persistSubagentRunsToDisk(current, ["one"]);
      } else {
        persistSubagentRunsToDiskOrThrow(current, ["one"]);
      }
    };
    if (mode === "atomic commit") {
      store.saveSubagentRegistryChangesToSqlite(current, ["one"]);
    }
    const resumePublication = createDeferredCore();
    let publication: Promise<void> | undefined;
    if (mode === "best effort" || mode === "strict refusal") {
      const scope = createOpenClawDatabaseMaintenanceScope();
      scope.run(() => {
        publication = resumePublication.promise.then(publish);
      });
      await scope.close();
    }
    const closing = closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
    try {
      expect(() => captureOpenClawStateWorkerContext()).toThrow("read admission is closed");
      const local = runs("current-memory", "memory", {
        requesterSessionKey: otherSessionKey,
        controllerSessionKey: rootSessionKey,
      });
      expect(
        [...getSubagentSessionListRunsSnapshotForRead(local, [rootSessionKey]).values()].map(
          (run) => run.model,
        ),
      ).toEqual(["current-memory"]);
      if (publication) {
        const observed =
          mode === "strict refusal"
            ? expect(publication).rejects.toThrow("maintenance resource scope is closed")
            : expect(publication).resolves.toBeUndefined();
        resumePublication.resolve();
        await observed;
      } else {
        expect(publish).not.toThrow();
      }
      const committed = mode === "strict commit" || mode === "atomic commit";
      expect(store.readSubagentRun(database, "one")?.model).toBe(committed ? "after" : "before");
      const refused = mode === "strict refusal";
      expect(getSubagentRunsSnapshotForRead(new Map()).get("one")).toMatchObject({
        model: refused ? "before" : "after",
        execution: { status: refused ? "running" : "terminal" },
      });
      const maintenance = getSubagentMaintenanceRunsSnapshotForRead(new Map()).get("one");
      expect(maintenance?.execution.status).toBe(refused ? "running" : "terminal");
      expect(maintenance?.cleanupCompletedAt).toBe(refused ? undefined : 2);
      expect(events).toHaveLength(mode === "atomic commit" ? 1 : 0);
      events.forEach((event) => event());
      expect(wake).toHaveBeenCalledTimes(refused ? 0 : 1);
      await expect(
        withSubagentSessionListRunsSnapshotForRead(new Map(), context, () => "stale"),
      ).rejects.toThrow("read admission is closed");
    } finally {
      resumePublication.resolve();
      releaseClose.resolve();
      await closing;
      unregister();
      unsubscribe();
    }
    store.saveSubagentRegistryChangesToSqlite(
      runs("reopened", "one", {
        requesterSessionKey: otherSessionKey,
        controllerSessionKey: otherSessionKey,
        childSessionKey: "agent:main:subagent:reopened",
      }),
      ["one"],
    );
    expect(getSubagentSessionListRunsSnapshotForRead(new Map()).get("one")?.model).toBe("reopened");
    expectScopedModels(rootSessionKey, []);
    expectScopedModels(otherSessionKey, ["reopened"]);
    await expect(
      withSubagentSessionListRunsSnapshotForRead(new Map(), context, () => "stale"),
    ).rejects.toThrow("read admission changed");
  },
);

it("keeps unrelated publication context failures visible", () => {
  const failure = new Error("synthetic context failure");
  vi.spyOn(databaseCache, "captureOpenClawStateDatabaseReadAdmission").mockImplementationOnce(
    () => {
      throw failure;
    },
  );
  expect(() => persistSubagentRunsToDisk(runs("current"), ["one"])).toThrow(failure);
});

it.each([1600, 900])(
  "reuses a completed fill after idle time and clock shifts (%i)",
  async (completedAt) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const persisted = new Map([
      ...runs("first"),
      ...runs("nested", "nested", { requesterSessionKey: "agent:main:subagent:one" }),
      ...runs("unrelated", "unrelated", { requesterSessionKey: otherSessionKey }),
    ]);
    const first = read();
    await started(0);
    now.mockReturnValue(completedAt);
    replies[0]!.resolve(persisted);
    expect(await first).toEqual(["first", "nested", "unrelated"]);
    expectScopedModels(rootSessionKey, ["first", "nested"], { controllerModels: ["first"] });
    expectScopedModels(otherSessionKey, ["unrelated"]);
    now.mockReturnValue(completedAt + 60_000);
    transport.execute.mockResolvedValueOnce(persisted);
    expect(await read()).toEqual(["first", "nested", "unrelated"]);
    expectScopedModels(rootSessionKey, ["first", "nested"], { controllerModels: ["first"] });
    expectScopedModels(otherSessionKey, ["unrelated"]);
    expect(transport.execute).toHaveBeenCalledTimes(1);
  },
);

it("does not retarget a waiting read after its database closes", async () => {
  const context = captureOpenClawStateWorkerContext();
  const first = withSubagentSessionListRunsSnapshotForRead(memory, context, (snapshot) => [
    ...snapshot.keys(),
  ]);
  await started(0);
  const rejected = expect(first).rejects.toThrow();
  await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
  replies[0]!.resolve(runs("old"));
  await rejected;

  openOpenClawStateDatabase();
  const reopened = read();
  (await started(1)).resolve(runs("reopened", "one", { requesterSessionKey: otherSessionKey }));
  expect(await reopened).toEqual(["reopened"]);
  expectScopedModels(rootSessionKey, []);
  expectScopedModels(otherSessionKey, ["reopened"]);
});

it.each(["read failure", "absent database"])(
  "shares the %s fallback with existing waiters and lets a later call retry",
  async (failure) => {
    const settled = createDeferredCore();
    const operation = vi
      .spyOn(workerStore, "runOpenClawStateWorkerOperation")
      .mockImplementation(async () => {
        await settled.promise;
        if (failure === "read failure") {
          throw new Error("read failed");
        }
        return undefined;
      });
    const resumed = createDeferredCore();
    const paused = createDeferredCore();
    let holdReaders = false;
    let waitingReaders = 0;
    const readers = Array.from({ length: 8 }, () =>
      read(() => {
        if (!holdReaders) {
          return undefined;
        }
        if (++waitingReaders === 8) {
          paused.resolve();
        }
        return resumed.promise;
      }),
    );
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    for (const [id, run] of runs("memory", "memory")) {
      memory.set(id, run);
    }
    persistSubagentRunsToDisk(
      new Map([...runs("written", "written"), ...runs("deleted", "deleted")]),
      ["written", "deleted"],
    );
    holdReaders = true;
    settled.resolve();
    await paused.promise;
    persistSubagentRunsToDisk(runs("resumed-written", "written"), ["written"]);
    persistSubagentRunsToDisk(new Map(), ["deleted"]);
    for (const [id, entry] of runs("resumed-memory", "memory")) {
      memory.set(id, entry);
    }
    holdReaders = false;
    resumed.resolve();
    expect(await Promise.all(readers)).toEqual(
      Array.from({ length: 8 }, () => ["resumed-written", "resumed-memory"]),
    );
    expect(operation).toHaveBeenCalledTimes(1);
    operation.mockRestore();

    const retry = read();
    (await started(0)).resolve(
      runs("persisted", "persisted", { requesterSessionKey: otherSessionKey }),
    );
    expect(await retry).toEqual(["persisted", "resumed-written", "resumed-memory"]);
    expectScopedModels(rootSessionKey, ["resumed-written", "resumed-memory"], {
      inMemoryRuns: memory,
    });
    expectScopedModels(otherSessionKey, ["persisted"]);
  },
);

it.each(["reset", "ownership rebind"])("supersedes a settled fallback after %s", async (change) => {
  const first = withSubagentSessionListRunsSnapshotForRead(
    memory,
    captureOpenClawStateWorkerContext(),
    () => {
      if (change === "reset") {
        clearSubagentRunsReadCacheForTest();
      } else {
        invalidateSubagentSessionListReadCache();
      }
      persistSubagentRunsToDisk(runs("published", "published"), ["published"]);
    },
  );
  await started(0);
  const second = read();
  replies[0]!.reject(new Error("read failed"));
  await first;
  (await started(1)).resolve(runs("current", "one", { requesterSessionKey: otherSessionKey }));
  expect(await second).toEqual(["current", "published"]);
  expectScopedModels(rootSessionKey, ["published"]);
  expectScopedModels(otherSessionKey, ["current"]);
});

it("rejects a reply after its captured maintenance scope has retired", async () => {
  const scope = createOpenClawDatabaseMaintenanceScope();
  const context = scope.run(() => captureOpenClawStateWorkerContext());
  const first = withSubagentSessionListRunsSnapshotForRead(memory, context, (snapshot) => [
    ...snapshot.keys(),
  ]);
  await started(0);
  const rejected = expect(first).rejects.toThrow("scope is closed");
  await scope.close();
  replies[0]!.resolve(runs("old"));
  await rejected;

  const rebound = read();
  (await started(1)).resolve(runs("rebound", "one", { requesterSessionKey: otherSessionKey }));
  expect(await rebound).toEqual(["rebound"]);
  expectScopedModels(rootSessionKey, []);
  expectScopedModels(otherSessionKey, ["rebound"]);
});

it("keeps the scalar full-record cache when a compact fill publishes", async () => {
  store.saveSubagentRegistryToSqlite(runs("current"));
  const pending = read();
  await started(0);
  const scalar = getSubagentRunsSnapshotForSessions(memory, ["agent:main:main"]);
  expect(scalar.get("one")?.task).toBe("one");
  replies[0]!.resolve(new Map([["one", { ...runs("current").get("one")!, task: undefined }]]));
  await pending;
  expect(getSubagentRunsSnapshotForRead(new Map()).get("one")?.task).toBe("one");
});

it.each([false, true])(
  "settles complete fills through a stream of named writes and deletions (failed=%s)",
  async (failed) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const initial = new Map([
      ...runs("durable", "durable"),
      ...runs("old", "one", { requesterSessionKey: otherSessionKey }),
      ...runs("deleted", "deleted"),
    ]);
    if (failed) {
      vi.spyOn(store, "saveSubagentRegistryChangesToSqlite").mockImplementation(() => {
        throw new Error("write failed");
      });
    }
    const first = read();
    await started(0);
    for (let index = 0; index < 8; index++) {
      persistSubagentRunsToDisk(runs(`current-${index}`), ["one"]);
      persistSubagentRunsToDisk(new Map(), ["deleted"]);
    }
    expect(replies).toHaveLength(1);
    replies[0]!.resolve(initial);
    expect(await first).toEqual(["durable", "current-7"]);
    expectScopedModels(rootSessionKey, ["durable", "current-7"]);
    expectScopedModels(otherSessionKey, []);
    now.mockReturnValue(1600);
    for (let index = 8; index < 16; index++) {
      persistSubagentRunsToDisk(
        runs(`current-${index}`, "one", {
          requesterSessionKey: otherSessionKey,
          controllerSessionKey: otherSessionKey,
        }),
        ["one"],
      );
      persistSubagentRunsToDisk(new Map(), ["deleted"]);
    }
    expect(await read()).toEqual(["durable", "current-15"]);
    expectScopedModels(rootSessionKey, ["durable"]);
    expectScopedModels(otherSessionKey, ["current-15"]);
    expect(replies).toHaveLength(1);
  },
);

it("hydrates durable-only rows after a cold named publication", async () => {
  persistSubagentRunsToDisk(runs("current"), ["one"]);
  const pending = read();
  await started(0);
  replies[0]!.resolve(new Map([...runs("durable", "durable"), ...runs("old")]));
  expect(await pending).toEqual(["durable", "current"]);
  expectScopedModels(rootSessionKey, ["durable", "current"]);
});
