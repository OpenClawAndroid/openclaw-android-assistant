import type { HeapInfo } from "node:v8";
import { Worker } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type WorkerSource = {
  cpuUsage: () => Promise<NodeJS.CpuUsage | undefined>;
  heap?: { value: HeapInfo; sampledAt: number };
  heapPending?: boolean;
};

// Native exit, not pool retirement or Gateway reset, ends resource-counter ownership.
// Shared chunks must see the same workers; this registry never starts a sampler.
const trackedWorkers = resolveGlobalSingleton(Symbol.for("openclaw.workerCpuSources"), () => {
  // Node also reports direct plugin/dependency Workers here, without a second registry.
  process.on("worker", trackWorker);
  return { revision: 0, workers: new Map<Worker, WorkerSource>() };
});

export function createCpuTrackedWorker(...args: ConstructorParameters<typeof Worker>): Worker {
  const worker = new Worker(...args);
  trackWorker(worker); // Bun need not emit Node's process-level Worker event.
  return worker;
}

function forgetWorker(worker: Worker): void {
  if (trackedWorkers.workers.delete(worker)) {
    trackedWorkers.revision++;
  }
}

function trackWorker(worker: Worker): void {
  if (trackedWorkers.workers.has(worker)) {
    return;
  }
  let pending = false;
  trackedWorkers.workers.set(worker, {
    async cpuUsage() {
      // Worker.cpuUsage cannot cancel an interrupt blocked in native work. Keep
      // at most one outstanding request even across sampler resets/restarts.
      if (pending) {
        return undefined;
      }
      pending = true;
      try {
        return await worker.cpuUsage();
      } catch {
        return undefined;
      } finally {
        pending = false;
      }
    },
  });
  trackedWorkers.revision++;
  worker.once("exit", () => forgetWorker(worker));
}

function pruneExitedWorkers(): void {
  // A consumer may remove all exit listeners during its own cleanup.
  for (const worker of trackedWorkers.workers.keys()) {
    if (worker.threadId === -1) {
      forgetWorker(worker);
    }
  }
}

export function getTrackedWorkerCpuSources(): {
  revision: number;
  workers: { cpuUsage: () => Promise<NodeJS.CpuUsage | undefined> }[];
} {
  pruneExitedWorkers();
  return { revision: trackedWorkers.revision, workers: [...trackedWorkers.workers.values()] };
}

async function refreshWorkerHeap(worker: Worker, source: WorkerSource): Promise<void> {
  source.heapPending = true;
  try {
    source.heap = { value: await worker.getHeapStatistics(), sampledAt: performance.now() };
  } catch {
    source.heap = undefined;
  } finally {
    source.heapPending = false;
  }
}

/** Read completed samples without blocking the heartbeat on a busy native isolate. */
export function sampleTrackedWorkerMemory() {
  pruneExitedWorkers();
  const memory = {
    workerCount: trackedWorkers.workers.size,
    workerHeapSampledCount: 0,
    workerHeapTotalBytes: 0,
    workerHeapUsedBytes: 0,
  };
  for (const [worker, source] of trackedWorkers.workers) {
    // At most two heartbeat intervals old; exits remove both counters and samples.
    if (source.heap && performance.now() - source.heap.sampledAt < 60_000) {
      memory.workerHeapSampledCount++;
      memory.workerHeapTotalBytes += source.heap.value.total_heap_size;
      memory.workerHeapUsedBytes += source.heap.value.used_heap_size;
    }
    // Native heap interrupts cannot be canceled. Never queue another behind a stall.
    if (!source.heapPending) {
      void refreshWorkerHeap(worker, source);
    }
  }
  return memory;
}
