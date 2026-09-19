import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "./constants.js";
import { createOAuthRefreshQueue } from "./oauth-refresh-queue.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

it.each([
  { callerFails: false, durableFails: false },
  { callerFails: false, durableFails: true },
  { callerFails: true, durableFails: false },
  { callerFails: true, durableFails: true },
])(
  "joins durable refresh settlement after caller completion (caller fails: $callerFails, durable fails: $durableFails)",
  async ({ callerFails, durableFails }) => {
    const queue = createOAuthRefreshQueue();
    const entered = createDeferredCore();
    const caller = createDeferredCore<string>();
    const durable = createDeferredCore();
    const callerFailure = new Error("Synthetic caller timeout");
    const durableFailure = new Error("Synthetic durable settlement failure");
    const request = queue.enqueue("openai", "openai:selected", async (trackSettlement) => {
      trackSettlement(durable.promise);
      entered.resolve();
      return caller.promise;
    });
    const result = request.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await entered.promise;
    if (callerFails) {
      caller.reject(callerFailure);
    } else {
      caller.resolve("caller complete");
    }
    expect(await result).toEqual(
      callerFails ? { error: callerFailure } : { value: "caller complete" },
    );

    let providerSettled = false;
    let profileSettled = false;
    let unrelatedSettled = false;
    const providerWait = queue.waitForActive("openai").then(() => {
      providerSettled = true;
    });
    const profileWait = queue.waitForActive("openai", "openai:selected").then(() => {
      profileSettled = true;
    });
    const unrelated = Promise.all([
      queue.waitForActive("other"),
      queue.waitForActive("openai", "openai:other"),
    ]).then(() => {
      unrelatedSettled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect([providerSettled, profileSettled, unrelatedSettled]).toEqual([false, false, true]);
      if (durableFails) {
        durable.reject(durableFailure);
      } else {
        durable.resolve();
      }
      await Promise.all([providerWait, profileWait]);
      expect([providerSettled, profileSettled]).toEqual([true, true]);
      await expect(queue.waitForActive("openai")).resolves.toBeUndefined();
    } finally {
      durable.resolve();
      await Promise.allSettled([providerWait, profileWait, unrelated]);
    }
  },
);

it("bounds one waiter without retiring the durable refresh for the next waiter", async () => {
  const queue = createOAuthRefreshQueue();
  const durable = createDeferredCore();
  const callerFailure = new Error("Synthetic caller timeout");
  await expect(
    queue.enqueue("openai", "openai:selected", async (trackSettlement) => {
      trackSettlement(durable.promise);
      throw callerFailure;
    }),
  ).rejects.toBe(callerFailure);

  const timedOut = queue.waitForActive("openai", "openai:selected").then(
    () => ({ completed: true }),
    (error: unknown) => ({ error }),
  );
  try {
    await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_CALL_TIMEOUT_MS);
    expect(await timedOut).toMatchObject({
      error: {
        message: expect.stringContaining(
          `exceeded hard timeout (${OAUTH_REFRESH_CALL_TIMEOUT_MS}ms)`,
        ),
      },
    });
    let laterSettled = false;
    const later = queue.waitForActive("openai", "openai:selected").then(() => {
      laterSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(laterSettled).toBe(false);
    durable.resolve();
    await later;
    expect(laterSettled).toBe(true);
    await expect(queue.waitForActive("openai", "openai:selected")).resolves.toBeUndefined();
  } finally {
    durable.resolve();
    await timedOut;
  }
});
