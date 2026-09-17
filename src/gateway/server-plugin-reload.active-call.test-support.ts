import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../plugins/plugin-lifecycle-lease.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  createRecoveryChannelManager,
  type RecoveryFixtureFactory,
} from "./server-plugin-reload.recovery.test-support.js";
import { createReadinessChecker } from "./server/readiness.js";

export async function verifyActiveCallDrainLease(
  createRecoveryFixture: RecoveryFixtureFactory,
  stateDir: string,
  holdMs = 5_000,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const serviceStopped = createDeferredCore();
  const effectsPath = path.join(stateDir, "completed-call.txt");
  await fs.writeFile(effectsPath, "");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  let reloadLease: PluginLifecycleLeaseContext | undefined;
  let registrations = 0;
  const disposed: number[] = [];
  const signals: AbortSignal[] = [];
  const fixture = await createRecoveryFixture({
    env,
    abortOnCandidateStart: false,
    initialStop: async () => {
      serviceStopped.resolve();
    },
    assertInvokerOwned: () => {
      assert(reloadLease);
      reloadLease.assertOwned();
    },
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      api.registerChannel({
        plugin: {
          ...createChannelTestPluginBase({ id: "drain-channel" }),
          gateway: {
            startAccount: async ({ abortSignal }) => {
              signals.push(abortSignal);
              await new Promise<void>((resolve) => {
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
            },
          },
        },
      });
      const generation = ++registrations;
      assert(api.lifecycle.onDispose);
      api.lifecycle.onDispose(() => {
        disposed.push(generation);
      });
      api.registerGatewayMethod("first.call", async ({ params, respond }) => {
        if (params.hold) {
          entered.resolve();
          await release.promise;
          await fs.appendFile(effectsPath, "completed\n");
        }
        respond(true, { generation });
      });
    },
  });
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  await manager.startChannel("drain-channel");
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  const readiness = createReadinessChecker({
    channelManager: manager,
    startedAt: Date.now(),
    getPluginReloadStatus: fixture.owner.getReloadStatus,
  });
  const record = fixture.previousRegistry.plugins.find((entry) => entry.id === "first");
  assert(record);
  const instance = getPluginInstance(record);
  assert(instance);
  const handler = fixture.previousRegistry.gatewayHandlers["first.call"];
  assert(handler);
  const invoke = (hold: boolean, respond: GatewayRequestHandlerOptions["respond"]) =>
    handler({
      req: { type: "req", id: "active-call-drain", method: "first.call" },
      params: { hold },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestHandlerOptions["context"],
    });
  const reload = () =>
    withPluginLifecycleLease({ env, waitMs: 0 }, async (lease) => {
      reloadLease = lease;
      return fixture.reload();
    });
  const response = vi.fn();
  let callSettled = false;
  const originalCall = Promise.resolve(invoke(true, response)).then(
    () => {
      callSettled = true;
    },
    (error: unknown) => {
      callSettled = true;
      return error;
    },
  );
  let reloading: Promise<unknown> | undefined;
  let reloadSettled = false;
  try {
    await entered.promise;
    vi.useFakeTimers();
    reloading = reload().then(
      (result) => {
        reloadSettled = true;
        return result;
      },
      (error: unknown) => {
        reloadSettled = true;
        return error;
      },
    );
    await serviceStopped.promise;
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      withPluginLifecycleLease({ env, waitMs: 0 }, async () => "competing owner"),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(reloadSettled).toBe(false);
    expect(callSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fixture.owner.getReloadStatus()?.phase).toBe("recovering"));
    await vi.advanceTimersByTimeAsync(holdMs - 5_000);
    expect(readiness()).toMatchObject({
      ready: false,
      failing: ["plugin-reload"],
      pluginReload: { phase: holdMs > 65_000 ? "failed" : "recovering" },
    });
    expect(fixture.candidates).toHaveLength(0);
    expect(disposed).toEqual([]);
    expect(response).not.toHaveBeenCalled();
    expect(await fs.readFile(effectsPath, "utf8")).toBe("");
    // The failed handoff still owns this admitted write. Recovery can recreate
    // the old registration only after the write releases its resource hold.
    release.resolve();
    expect(await originalCall).toBeUndefined();
    expect(response).toHaveBeenCalledExactlyOnceWith(true, { generation: 1 }, undefined, undefined);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("completed\n");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await reloading).toMatchObject({
      details: { phase: "drain", committed: false, pluginIds: ["first"] },
    });
    if (holdMs > 65_000) {
      expect(manager.getRuntimeSnapshot().reloadingChannels?.size).toBe(0);
      expect(signals).toHaveLength(1);
      expect(fixture.owner.getReloadStatus()).toMatchObject({
        phase: "failed",
        reason: expect.stringContaining("restart the Gateway"),
      });
      await expect(manager.startChannel("drain-channel")).rejects.toThrow("reloaded or disabled");
      await expect(reload()).resolves.toMatchObject({ runtime: { pluginIds: ["first"] } });
      expect(signals).toHaveLength(2);
      expect(readiness()).toMatchObject({ ready: true, failing: [] });
      return;
    }
    expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(manager.getRuntimeSnapshot().reloadingChannels?.size).toBe(0);
    expect(readiness()).toMatchObject({ ready: true, failing: [] });
    expect(instance.disposing).toBe(true);
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(disposed).toEqual([1]);
    expect(callSettled).toBe(true);
    expect(fixture.candidates).toHaveLength(0);
    await expect(invoke(false, vi.fn())).rejects.toThrow("reloaded or disabled");
    const completedLease = reloadLease;
    assert(completedLease);
    expect(() => completedLease.assertOwned()).toThrowError(
      expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
    );
    await expect(
      withPluginLifecycleLease({ env, waitMs: 0 }, async (lease) => {
        lease.assertOwned();
        return "reacquired";
      }),
    ).resolves.toBe("reacquired");

    expect(fixture.firstStart).toHaveBeenCalledTimes(2);
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    await expect(reload()).resolves.toMatchObject({ runtime: { pluginIds: ["first"] } });
    expect(disposed).toEqual([1, 2]);
    await expect(invoke(false, vi.fn())).rejects.toThrow("reloaded or disabled");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("completed\n");
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(disposed).toEqual([1, 2]);
    await expect(invoke(false, vi.fn())).rejects.toThrow("reloaded or disabled");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("completed\n");
    expect(fixture.siblingStop).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    try {
      await originalCall;
      await vi.advanceTimersByTimeAsync(10_000);
      if (reloading && !reloadSettled) {
        await vi.waitFor(() => expect(reloadSettled).toBe(true));
      }
      await reloading;
    } finally {
      vi.useRealTimers();
      await manager.stopChannel("drain-channel");
    }
  }
}
