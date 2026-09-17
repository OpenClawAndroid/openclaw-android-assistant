import type { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionHistoryUnavailableMessage } from "../gateway/session-history-error.js";
import { createDeferredCore } from "../shared/deferred.js";
import { WorkerTaskError, WorkerTaskPool } from "./worker-task-pool.js";

type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn<(message: { taskId: number; responseId?: number }) => void>>;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
};
const workers = vi.hoisted(() => [] as FakeWorker[]);

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    parentPort: null,
    Worker: class extends EventEmitter {
      constructor() {
        super();
        workers.push(this);
      }
      postMessage = vi.fn<(message: { taskId: number; responseId?: number }) => void>();
      ref() {}
      unref() {}
      terminate = vi.fn(async () => {
        this.emit("exit", 0);
        return 0;
      });
    },
  };
});
vi.mock("node:os", () => ({ availableParallelism: () => 2 }));
vi.mock("./runtime-worker-url.js", () => ({ resolveRuntimeWorkerThreadExecArgv: () => [] }));

const pools: WorkerTaskPool<string, string>[] = [];
function createPool(validateResult?: (value: string) => void) {
  const pool = new WorkerTaskPool<string, string>({
    workerUrl: new URL("data:text/javascript,"),
    maxWorkers: 1,
    maxPendingBytes: 10,
    sharedCompute: true,
    idleTimeoutMs: 0,
    validateResult,
  });
  pools.push(pool);
  return pool;
}
function taskId(worker: FakeWorker) {
  return expectDefined(worker.postMessage.mock.calls[0]?.[0].taskId, "posted task");
}

beforeEach(() => {
  workers.splice(0);
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

describe("worker task retirement failures", () => {
  it.each(["close", "rotate"] as const)(
    "retains both failures and input custody until a later %s joins exit",
    async (join) => {
      const taskFailure = new WorkerTaskError("original task failure", "unavailable");
      const retirementFailure = new Error("exit uncertain");
      const pool = createPool(() => {
        throw taskFailure;
      });
      const inputReleased = vi.fn();
      const responseReleased = vi.fn();
      const responsePosted = createDeferredCore();
      const result = pool
        .run("input", {
          inputBytes: 8,
          onInputConsumed: inputReleased,
          onRequest: async () => ({
            input: "host reply",
            timeoutMs: 60_000,
            onConsumed: responseReleased,
          }),
        })
        .catch((error: unknown) => error);
      const worker = expectDefined(workers[0], "task worker");
      worker.postMessage.mockImplementation((message) => {
        if (message.responseId !== undefined) {
          responsePosted.resolve();
        }
      });
      worker.emit("message", {
        status: "request",
        taskId: taskId(worker),
        id: 1,
        value: "request",
      });
      await responsePosted.promise;
      worker.terminate.mockRejectedValueOnce(retirementFailure);
      worker.emit("message", { status: "ok", taskId: taskId(worker), value: "result" });
      const failure = await result;
      expect(failure).toBeInstanceOf(AggregateError);
      const aggregate = expectDefined(
        failure instanceof AggregateError ? failure : undefined,
        "both task and retirement failures",
      );
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(taskFailure);
      expect(aggregate.errors[1]).toBe(retirementFailure);
      expect(aggregate.cause).toBe(retirementFailure);
      expect(aggregate.message).toMatch(/exit uncertain.*original task failure/);
      expect(failure).not.toBeInstanceOf(WorkerTaskError);
      expect(resolveSessionHistoryUnavailableMessage(taskFailure)).toBeDefined();
      expect(resolveSessionHistoryUnavailableMessage(failure)).toBeUndefined();
      expect(inputReleased).not.toHaveBeenCalled();
      expect(responseReleased).not.toHaveBeenCalled();
      expect(pool.getSnapshot().pendingTasks).toBe(1);
      await expect(pool.run("too large", { inputBytes: 3 })).rejects.toMatchObject({
        code: "overloaded",
      });

      const waitingPool = createPool();
      const waitingResult = waitingPool.run("waiting", {}).catch((error: unknown) => error);
      expect(workers).toHaveLength(1);
      const exit = createDeferredCore();
      const terminating = createDeferredCore();
      worker.terminate.mockImplementationOnce(async () => {
        terminating.resolve();
        await exit.promise;
        worker.emit("exit", 0);
        return 0;
      });
      const joined = pool[join]();
      try {
        await terminating.promise;
        expect(inputReleased).not.toHaveBeenCalled();
        expect(responseReleased).not.toHaveBeenCalled();
        expect(pool.getSnapshot().pendingTasks).toBe(1);
        expect(workers).toHaveLength(1);
      } finally {
        exit.resolve();
        await joined;
      }
      expect(inputReleased).toHaveBeenCalledOnce();
      expect(responseReleased).toHaveBeenCalledOnce();
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      expect(await result).toBe(failure);
      const successor = expectDefined(workers[1], "waiting pool worker after exit");
      successor.emit("message", { status: "ok", taskId: taskId(successor), value: "completed" });
      expect(await waitingResult).toBe("completed");
      await pool[join]();
      expect(inputReleased).toHaveBeenCalledOnce();
      expect(responseReleased).toHaveBeenCalledOnce();
      expect(worker.terminate).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves the retirement failure alone when the task succeeded", async () => {
    const pool = createPool();
    const released = vi.fn();
    const result = pool.run("input", { onInputConsumed: released });
    const retirementFailure = new Error("exit uncertain");
    const worker = expectDefined(workers[0], "task worker");
    worker.terminate.mockRejectedValueOnce(retirementFailure);
    const rejected = expect(result).rejects.toBe(retirementFailure);
    worker.emit("message", { status: "ok", taskId: taskId(worker), value: "result" });
    await rejected;
    expect(released).not.toHaveBeenCalled();
    await pool.close();
    expect(released).toHaveBeenCalledOnce();
  });

  it("preserves the original task error when retirement succeeds", async () => {
    const taskFailure = new WorkerTaskError("original task failure", "unavailable");
    const pool = createPool(() => {
      throw taskFailure;
    });
    const released = vi.fn();
    const result = pool.run("input", { onInputConsumed: released });
    const rejected = expect(result).rejects.toBe(taskFailure);
    const worker = expectDefined(workers[0], "task worker");
    worker.emit("message", { status: "ok", taskId: taskId(worker), value: "result" });
    await rejected;
    expect(released).toHaveBeenCalledOnce();
  });
});
