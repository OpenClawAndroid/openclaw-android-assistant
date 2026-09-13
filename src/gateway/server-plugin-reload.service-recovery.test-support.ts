import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  verifyFailedRecoveryServiceOwnership,
  verifyCandidateCleanupRecovery,
} from "./server-plugin-reload.managed-candidate.test-support.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";
import {
  verifyOneWayDrainRecovery,
  verifyReversibleFenceRecovery,
} from "./server-plugin-reload.suspension.test-support.js";

export function registerPluginServiceRecoveryTests(createRecoveryFixture: RecoveryFixtureFactory) {
  describe("Gateway plugin service recovery ownership", () => {
    it("restores prepared config effects when channel admission cannot pause", async () => {
      const rollback = vi.fn(async () => {});
      const fixture = await createRecoveryFixture({ prepareConfigEffects: () => rollback });
      const failure = new Error("fixture channel pause failed");
      vi.spyOn(fixture.runtime.channelManager, "pauseChannelStarts").mockImplementationOnce(() => {
        throw failure;
      });
      await expect(fixture.reload()).rejects.toMatchObject({
        details: { committed: false },
        cause: failure,
      });
      expect(fixture.firstStop).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledOnce();
    });

    it.each(["restored", "failed"] as const)(
      "settles prepared config effects only after plugin rollback is %s",
      async (restoration) => {
        const recoveryStarted = createDeferredCore();
        const releaseRecovery = createDeferredCore();
        const rollback = vi.fn(async () => {
          const record = fixture.previousRegistry.plugins.find((plugin) => plugin.id === "first");
          expect(record && getPluginInstance(record)?.acceptingCalls).toBe(true);
        });
        const fixture = await createRecoveryFixture({
          prepareConfigEffects: () => rollback,
          recoveryStart: async () => {
            recoveryStarted.resolve();
            await releaseRecovery.promise;
            if (restoration === "failed") {
              throw new Error("fixture recovery failed");
            }
          },
        });
        const reloading = fixture.reload().catch((error: unknown) => error);
        try {
          await recoveryStarted.promise;
          expect(rollback).not.toHaveBeenCalled();
          releaseRecovery.resolve();
          expect(await reloading).toMatchObject({ details: { committed: false } });
          expect(rollback).toHaveBeenCalledTimes(restoration === "restored" ? 1 : 0);
        } finally {
          releaseRecovery.resolve();
          await reloading;
        }
      },
    );

    it.each(["prepare", "drain", "publish", "committed"] as const)(
      "preserves the committed owner when its invoker closes during %s",
      async (boundary) => {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const failure = new Error("plugin invoker closed");
        let invokerOpen = true;
        const pause = async () => {
          entered.resolve();
          await release.promise;
        };
        const candidateStart = vi.fn();
        const fixture = await createRecoveryFixture({
          abortOnCandidateStart: false,
          candidateStart,
          ...(boundary === "prepare" ? { prepareAttached: pause } : {}),
          ...(boundary === "drain" ? { initialStop: pause } : {}),
          ...(boundary === "publish" ? { beforePublish: pause } : {}),
          ...(boundary === "committed" ? { afterPublish: pause } : {}),
          assertInvokerOwned: () => {
            if (!invokerOpen) {
              throw failure;
            }
          },
        });
        const pending = fixture.reload().catch((error: unknown) => error);
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("plugin reload completed before its pause");
            }),
          ]);
          invokerOpen = false;
          release.resolve();
          const result = await pending;
          if (boundary === "committed") {
            expect(result).toMatchObject({
              runtime: { operationId: "service-recovery", pluginIds: ["first"] },
            });
            expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
            const previousRecord = fixture.previousRegistry.plugins.find(
              (record) => record.id === "first",
            );
            assert.ok(previousRecord);
            expect(getPluginInstance(previousRecord)?.lifecycle.signal.aborted).toBe(true);
            expect(fixture.firstStart).toHaveBeenCalledOnce();
            expect(fixture.candidateStop).not.toHaveBeenCalled();
          } else {
            expect(result).toMatchObject({
              details: { phase: boundary === "publish" ? "activate" : boundary, committed: false },
              cause: failure,
            });
            expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
            expect(fixture.firstStart).toHaveBeenCalledTimes(boundary === "prepare" ? 1 : 2);
            expect(fixture.candidateStop).toHaveBeenCalledTimes(boundary === "publish" ? 1 : 0);
          }
          expect(candidateStart).toHaveBeenCalledTimes(
            boundary === "publish" || boundary === "committed" ? 1 : 0,
          );
          expect(fixture.siblingStart).toHaveBeenCalledOnce();
          expect(fixture.siblingStop).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await pending;
        }
      },
    );

    it("keeps retained and failed-recovery services owned after recovery startup rejects", () =>
      verifyFailedRecoveryServiceOwnership(createRecoveryFixture));

    it("restores the previous service after candidate cleanup fails and permits another attempt", () =>
      verifyCandidateCleanupRecovery(createRecoveryFixture));

    it.each(["suspension", "restart signal"] as const)(
      "restores the previous plugin runtime after failed replacement during reversible %s",
      (fence) => verifyReversibleFenceRecovery(createRecoveryFixture, fence),
    );

    it("publishes retained services before awaited cleanup when admission closes and recovery is skipped", () =>
      verifyOneWayDrainRecovery(createRecoveryFixture));
  });
}
