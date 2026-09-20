import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  getTrackedWorkerCpuSources,
  createCpuTrackedWorker,
  sampleTrackedWorkerMemory,
} from "./worker-cpu.js";

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  vi.restoreAllMocks();
});

async function createWorker() {
  const worker = createCpuTrackedWorker("setInterval(() => {}, 1000)", { eval: true });
  workers.push(worker);
  await once(worker, "online");
  return worker;
}

describe("worker CPU lifecycle", () => {
  it("includes direct Workers in heap totals and removes their samples at native exit", async () => {
    const initial = sampleTrackedWorkerMemory();
    const direct = new Worker("setInterval(() => {}, 1000)", { eval: true });
    workers.push(direct);
    await once(direct, "online");
    const owned = await createWorker();
    sampleTrackedWorkerMemory();
    await vi.waitFor(() => {
      const memory = sampleTrackedWorkerMemory();
      expect(memory.workerCount).toBe(initial.workerCount + 2);
      expect(memory.workerHeapSampledCount).toBe(initial.workerHeapSampledCount + 2);
      expect(memory.workerHeapTotalBytes).toBeGreaterThan(memory.workerHeapUsedBytes);
      expect(memory.workerHeapUsedBytes).toBeGreaterThan(0);
    });
    // Some consumers clear listeners before native teardown; counters must still retire.
    direct.removeAllListeners();
    await Promise.all([direct.terminate(), owned.terminate()]);
    expect(sampleTrackedWorkerMemory()).toEqual(initial);
  });

  it("bounds outstanding heap reads and excludes stale samples during a native stall", async () => {
    const worker = await createWorker();
    const native = await worker.getHeapStatistics();
    const stalled = createDeferredCore<typeof native>();
    const read = vi
      .spyOn(worker, "getHeapStatistics")
      .mockResolvedValueOnce(native)
      .mockReturnValue(stalled.promise);
    sampleTrackedWorkerMemory();
    await Promise.resolve();
    expect(sampleTrackedWorkerMemory().workerHeapSampledCount).toBe(1);
    const now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now + 60_001);
    for (let index = 0; index < 10; index++) {
      expect(sampleTrackedWorkerMemory()).toMatchObject({
        workerCount: 1,
        workerHeapSampledCount: 0,
        workerHeapTotalBytes: 0,
        workerHeapUsedBytes: 0,
      });
    }
    expect(read).toHaveBeenCalledTimes(2);
    await worker.terminate();
    stalled.resolve(native);
    await stalled.promise;
    expect(sampleTrackedWorkerMemory().workerCount).toBe(0);
  });

  it("retains native ownership through stalled reads and removes it only at exit", async () => {
    const initial = getTrackedWorkerCpuSources();
    const worker = await createWorker();
    const read = createDeferredCore<NodeJS.CpuUsage>();
    const cpuUsage = vi.spyOn(worker, "cpuUsage").mockReturnValue(read.promise);
    const tracked = getTrackedWorkerCpuSources();
    expect(tracked.workers).toHaveLength(initial.workers.length + 1);
    const source = tracked.workers.at(-1)!;
    const pending = source.cpuUsage();
    await expect(source.cpuUsage()).resolves.toBeUndefined();
    await expect(getTrackedWorkerCpuSources().workers.at(-1)!.cpuUsage()).resolves.toBeUndefined();
    expect(cpuUsage).toHaveBeenCalledTimes(1);
    await worker.terminate();
    expect(getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
    expect(getTrackedWorkerCpuSources().revision).toBeGreaterThan(tracked.revision);
    read.resolve({ user: 100, system: 10 });
    await pending;
    expect(getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
  });

  it("recovers after rejected or synchronously unavailable native counters", async () => {
    const worker = await createWorker();
    const cpuUsage = vi
      .spyOn(worker, "cpuUsage")
      .mockRejectedValueOnce(new Error("not running"))
      .mockImplementationOnce(() => {
        throw new Error("unsupported");
      })
      .mockResolvedValue({ user: 100, system: 10 });
    const source = getTrackedWorkerCpuSources().workers.at(-1)!;
    await expect(source.cpuUsage()).resolves.toBeUndefined();
    await expect(source.cpuUsage()).resolves.toBeUndefined();
    await expect(source.cpuUsage()).resolves.toEqual({ user: 100, system: 10 });
    expect(cpuUsage).toHaveBeenCalledTimes(3);
  });
});
