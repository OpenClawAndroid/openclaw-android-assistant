import { enqueueKeyedTask } from "../../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "./constants.js";
import { observeOAuthRefreshSettlement } from "./oauth-refresh-fence.js";

export function createOAuthRefreshQueue() {
  const tails = new Map<string, Promise<void>>();
  const pending = new Map<string, Set<Promise<void>>>();
  const keyFor = (provider: string, profileId: string) => `${provider}\u0000${profileId}`;
  return {
    enqueue<T>(
      provider: string,
      profileId: string,
      task: (trackSettlement: (settlement: Promise<unknown>) => void) => Promise<T>,
    ): Promise<T> {
      const key = keyFor(provider, profileId);
      const finished = createDeferredCore();
      const active = pending.get(key) ?? new Set<Promise<void>>();
      active.add(finished.promise);
      pending.set(key, active);
      let settlement: Promise<void> | undefined;
      const request = enqueueKeyedTask({
        tails,
        key,
        // The task registers durable work before its caller-facing promise settles.
        task: () =>
          task((work) => {
            settlement = work.then(
              () => undefined,
              () => undefined,
            );
          }),
      });
      void request
        .then(
          () => settlement,
          () => settlement,
        )
        .then(() => {
          active.delete(finished.promise);
          if (active.size === 0) {
            pending.delete(key);
          }
          finished.resolve();
        });
      return request;
    },
    async waitForActive(provider: string, profileId?: string): Promise<void> {
      const key = profileId ? keyFor(provider, profileId) : undefined;
      const active: Promise<void>[] = [];
      for (const [queuedKey, work] of pending) {
        if (key ? queuedKey === key : queuedKey.startsWith(`${provider}\u0000`)) {
          active.push(...work);
        }
      }
      if (active.length === 0) {
        return;
      }
      // Join this snapshot of work; the subsequent credential read owns the outcome.
      await observeOAuthRefreshSettlement(
        `modelSelection(${provider})`,
        OAUTH_REFRESH_CALL_TIMEOUT_MS,
        Promise.all(active),
      );
    },
  };
}
