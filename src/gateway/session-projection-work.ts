import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

const SESSION_PROJECTION_YIELD_INTERVAL_MS = 12;
let activeProjections = 0;
let sharedWorkStartedAt = 0;
let pendingYield: Promise<void> | undefined;

type SessionProjectionWorkBudget = {
  shouldYield: () => boolean;
  yieldIfNeeded: () => Promise<void> | undefined;
  resumeAfterAwait: () => void;
};

function yieldProjectionWork(): Promise<void> {
  return (pendingYield ??= yieldToEventLoop().then(() => {
    sharedWorkStartedAt = performance.now();
    pendingYield = undefined;
  }));
}

/** Concurrent session projections share one event-loop slice and one pending yield. */
export async function withSessionProjectionWorkBudget<T>(
  run: (budget: SessionProjectionWorkBudget) => Promise<T>,
  startedAt?: number,
): Promise<T> {
  let workStartedAt = startedAt ?? performance.now();
  if (activeProjections++ === 0) {
    sharedWorkStartedAt = workStartedAt;
  }
  let checkedItems = 0;
  const workIsDue = () => {
    const now = performance.now();
    return (
      now - workStartedAt >= SESSION_PROJECTION_YIELD_INTERVAL_MS ||
      now - sharedWorkStartedAt >= SESSION_PROJECTION_YIELD_INTERVAL_MS
    );
  };
  const resumeAfterAwait = () => {
    workStartedAt = performance.now();
  };
  try {
    return await run({
      // Sample the clock in small batches without stacking per-caller work slices.
      shouldYield: () => ++checkedItems % 16 === 0 && workIsDue(),
      yieldIfNeeded: () => (workIsDue() ? yieldProjectionWork().then(resumeAfterAwait) : undefined),
      resumeAfterAwait,
    });
  } finally {
    activeProjections--;
  }
}
