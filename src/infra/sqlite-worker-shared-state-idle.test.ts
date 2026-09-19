import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { deserialize } from "node:v8";
import { MessagePort, Worker, type Transferable } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import * as runtimeWorker from "./runtime-worker-url.js";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import * as sqliteWorkers from "./sqlite-worker-store.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const minute = 60_000;

async function fixture(mode: "healthy" | "local-reader" | "unsettled-inspection" = "healthy") {
  const context = captureOpenClawStateWorkerContext({
    env: { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-idle-") },
  });
  const now = performance.now.bind(performance);
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
  const timers = vi.spyOn(globalThis, "setTimeout");
  const resolveWorker = runtimeWorker.resolveRuntimeWorkerUrl;
  const resolver = vi
    .spyOn(runtimeWorker, "resolveRuntimeWorkerUrl")
    .mockImplementation((params) =>
      params.sourceWorkerName === runtimeProcessEntrypoints.sharedStateStore.sourceWorkerName
        ? new URL("./sqlite-worker-shared-state-idle-fixture.test-support.ts", import.meta.url)
        : resolveWorker(params),
    );
  const messages = vi.spyOn(Worker.prototype, "postMessage");
  const read = () =>
    executeOpenClawStateWorker(context, {
      type: "flows.list",
      input: { ownerKey: `agent:main:${mode}` },
    });
  expect(await read()).toEqual([]);
  const worker = messages.mock.contexts[0];
  messages.mockRestore();
  resolver.mockRestore();
  if (!(worker instanceof Worker)) {
    throw new Error("Expected the canonical shared-state worker");
  }
  const scheduled = (delay: number) => {
    const index = timers.mock.calls.findLastIndex(
      (call) => typeof call[1] === "number" && call[1] <= delay && call[1] > delay - 1_000,
    );
    const callback = timers.mock.calls[index]?.[0];
    if (typeof callback !== "function") {
      throw new Error(`Expected idle callback after ${delay} ms`);
    }
    return () => {
      const timer = timers.mock.results[index];
      if (timer?.type === "return") {
        clearTimeout(timer.value);
      }
      callback();
    };
  };
  return {
    context,
    worker,
    read,
    scheduled,
    advance: (duration: number) => {
      elapsed += duration;
    },
  };
}

it("retains the original healthy worker after one minute and closes it after 30 minutes", async () => {
  const f = await fixture();
  f.advance(minute);
  f.scheduled(minute)();
  // Joining a real call also joins the original owner's retirement, if it retired at one minute.
  expect(await f.read()).toEqual([]);
  expect(f.worker.threadId).not.toBe(-1);
  f.advance(minute);
  f.scheduled(minute)();
  await vi.waitFor(() => expect(f.scheduled(29 * minute)).toBeTypeOf("function"));
  expect(f.worker.threadId).not.toBe(-1);
  const exited = once(f.worker, "exit");
  f.advance(29 * minute);
  f.scheduled(29 * minute)();
  await exited;
  expect(await f.read()).toEqual([]);
});

it("retires an unavailable actor even when its completed idle result is healthy", async () => {
  const f = await fixture();
  const available = vi
    .spyOn(sqliteWorkers, "isSqliteWorkerStoreAvailable")
    .mockReturnValueOnce(false);
  try {
    f.advance(minute);
    f.scheduled(minute)();
    await vi.waitFor(() => expect(f.worker.threadId).toBe(-1));
    expect(await f.read()).toEqual([]);
  } finally {
    available.mockRestore();
  }
});

it("retires a worker with an untracked local reader and releases its actual WAL pin", async () => {
  const f = await fixture("local-reader");
  const { DatabaseSync } = requireNodeSqlite();
  const writer = new DatabaseSync(f.context.admission.databasePath);
  try {
    writer.exec("PRAGMA busy_timeout=0; CREATE TABLE idle_probe (value TEXT)");
    expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(1);
    const exited = once(f.worker, "exit");
    f.advance(minute);
    f.scheduled(minute)();
    await exited;
    expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
  } finally {
    writer.close();
  }
});

it("keeps a healthy worker when another connection holds the WAL reader", async () => {
  const f = await fixture();
  const { DatabaseSync } = requireNodeSqlite();
  const writer = new DatabaseSync(f.context.admission.databasePath);
  const reader = new DatabaseSync(f.context.admission.databasePath);
  try {
    writer.exec("PRAGMA busy_timeout=0; CREATE TABLE idle_probe (value TEXT)");
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM sqlite_schema").get();
    writer.exec("INSERT INTO idle_probe VALUES ('after-reader')");
    expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(1);
    f.advance(minute);
    f.scheduled(minute)();
    await vi.waitFor(() => expect(f.scheduled(29 * minute)).toBeTypeOf("function"));
    expect(f.worker.threadId).not.toBe(-1);
    expect(await f.read()).toEqual([]);
    expect(f.worker.threadId).not.toBe(-1);
  } finally {
    if (reader.isTransaction) {
      reader.exec("ROLLBACK");
    }
    reader.close();
    writer.close();
  }
});

it("ignores an inspection result and old expiry when real work resumes", async () => {
  const f = await fixture();
  const postMessage = f.worker.postMessage.bind(f.worker);
  const dispatched = createDeferredCore();
  let resume: (() => void) | undefined;
  const send = vi
    .spyOn(f.worker, "postMessage")
    .mockImplementation((request: SqliteWorkerRequest, transfers?: readonly Transferable[]) => {
      if (
        request.type === "execute" &&
        deserialize(request.input).type === "database.inspectIdle"
      ) {
        resume = () => postMessage(request, transfers);
        dispatched.resolve();
        return;
      }
      return postMessage(request, transfers);
    });
  const oldInspection = f.scheduled(minute);
  f.advance(minute);
  oldInspection();
  await dispatched.promise;
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const active = runOpenClawStateWorkerOperation(f.context, async (scope) => {
    entered.resolve();
    await finish.promise;
    return scope.execute({ type: "flows.list", input: { ownerKey: "agent:main:idle" } });
  });
  await entered.promise;
  send.mockRestore();
  try {
    if (!resume) {
      throw new Error("Expected a held native inspection request");
    }
    resume();
    f.advance(30 * minute);
    oldInspection();
    expect(f.worker.threadId).not.toBe(-1);
  } finally {
    finish.resolve();
  }
  expect(await active).toEqual([]);
  oldInspection();
  f.advance(minute);
  f.scheduled(minute)();
  await vi.waitFor(() => expect(f.scheduled(29 * minute)).toBeTypeOf("function"));
  expect(f.worker.threadId).not.toBe(-1);
});

it("replaces a failed idle actor after an enclosing callback settles", async () => {
  const f = await fixture("unsettled-inspection");
  const nativePost = vi.spyOn(MessagePort.prototype, "postMessage");
  nativePost.mockRestore();
  let resume: (() => void) | undefined;
  const send = vi
    .spyOn(MessagePort.prototype, "postMessage")
    .mockImplementation(function (this: MessagePort, message, transfers) {
      if (isRecord(message) && message.type === "accepted" && Object.hasOwn(message, "admission")) {
        // Hold the acquired-custody grant, after live authority has accepted this inspection.
        send.mockRestore();
        resume = () => nativePost.call(this, message, transfers);
        return;
      }
      return nativePost.call(this, message, transfers);
    });
  f.advance(minute);
  f.scheduled(minute)();
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const escape = createDeferredCore<never>();
  void escape.promise.catch(() => {});
  let active: Promise<string> | undefined;
  try {
    await vi.waitFor(() => expect(resume).toBeTypeOf("function"));
    if (!resume) {
      throw new Error("Expected an admitted native inspection");
    }
    active = runOpenClawStateWorkerOperation(f.context, () =>
      Promise.race([
        (async () => {
          entered.resolve();
          await finish.promise;
          await expect(f.read()).rejects.toMatchObject({ code: "unavailable" });
          return "completed without dispatch";
        })(),
        escape.promise,
      ]),
    );
    await entered.promise;
    const exited = once(f.worker, "exit");
    resume();
    resume = undefined;
    await exited;
    await nextTurn();
    finish.resolve();
    let settled = false;
    void active.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(await active).toBe("completed without dispatch");
    await nextTurn();
    expect(await f.read()).toEqual([]);
  } finally {
    send.mockRestore();
    resume?.();
    finish.resolve();
    escape.reject(new Error("Release the enclosing fixture after failed observation"));
    await active?.catch(() => {});
  }
});
