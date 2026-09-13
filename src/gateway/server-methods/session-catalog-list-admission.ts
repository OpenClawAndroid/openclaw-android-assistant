import { AsyncLocalStorage } from "node:async_hooks";

type QueuedProviderList = {
  start: () => void;
};

type QueuedProviderListOutcome<T> = { kind: "started"; result: Promise<T> } | { kind: "cancelled" };

class SessionCatalogListBusyError extends Error {
  readonly code = "catalog_busy";

  constructor(maxConcurrent: number, maxQueued: number) {
    super(`session catalog is busy (${maxConcurrent} active, ${maxQueued} queued); retry shortly`);
    this.name = "SessionCatalogListBusyError";
  }
}

export class SessionCatalogListAdmission {
  private active = 0;
  private readonly queue: QueuedProviderList[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("maxQueued must be a non-negative integer");
    }
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active < this.maxConcurrent) {
      return await this.start(task);
    }
    if (this.queue.length >= this.maxQueued) {
      throw new SessionCatalogListBusyError(this.maxConcurrent, this.maxQueued);
    }
    // A released slot runs the next caller's plugin and root scope, never the
    // preceding provider's context inherited by the queue drain.
    const runInAsyncContext = AsyncLocalStorage.snapshot();
    const outcome = await new Promise<QueuedProviderListOutcome<T>>((resolve) => {
      const queued: QueuedProviderList = {
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve({ kind: "started", result: runInAsyncContext(() => this.start(task)) });
        },
      };
      const onAbort = () => {
        const index = this.queue.indexOf(queued);
        if (index < 0) {
          return;
        }
        this.queue.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        resolve({ kind: "cancelled" });
      };
      // Admission settles separately so cancellation cannot release a started provider.
      this.queue.push(queued);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
    if (outcome.kind === "cancelled") {
      signal?.throwIfAborted();
      throw new Error("Cancelled session catalog admission has no aborted owner signal");
    }
    return await outcome.result;
  }

  private async start<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await task();
    } finally {
      // Release before draining so every settlement, including rejection, hands
      // exactly one slot to the oldest waiter instead of leaking capacity.
      this.active -= 1;
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.maxConcurrent) {
      const next = this.queue.shift();
      if (!next) {
        return;
      }
      next.start();
    }
  }
}
