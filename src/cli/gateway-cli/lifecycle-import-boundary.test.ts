// The run loop primes lifecycle.runtime.ts before the HTTP listener binds, so the
// hub's re-exports decide how much module graph loads during gateway cold start.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createRuntimeWithExitSignal,
  createSignaledStart,
  waitForStart,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

const fixture = vi.hoisted(() => ({
  releaseLock: vi.fn(async () => {}),
  error: vi.fn(),
}));
vi.mock("../../infra/gateway-lock.js", () => ({
  acquireGatewayLock: async () => ({ release: fixture.releaseLock }),
}));
vi.mock("../../infra/systemd-stop-timeout.js", () => ({
  readSystemdStopTimeout: async () => null,
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: fixture.error,
  }),
}));
vi.mock("../../logging/logger.js", () => ({ flushLogger: async () => {} }));

afterEach(() => {
  vi.doUnmock("./lifecycle.runtime.js");
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

type LifecycleRuntime = typeof import("./lifecycle.runtime.js");

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("gateway lifecycle hub import boundaries", () => {
  it("re-exports primed symbols from their defining modules instead of facades", () => {
    const hub = readSource("src/cli/gateway-cli/lifecycle.runtime.ts");

    // The generation owner must not pull hot-reload or managed-reloader graphs
    // into the lifecycle hub before the gateway can accept a connection.
    expect(hub).toContain('from "../../gateway/server-reload-generation.js"');
    expect(hub).not.toContain('from "../../gateway/server-reload-hot.js"');
    expect(hub).not.toContain('from "../../gateway/server-reload-managed.js"');

    // Restart marking belongs to server close, after the drain identifies the
    // exact runs that still need abort. The primed run-loop hub must not regain
    // the earlier duplicate owner.
    expect(hub).not.toContain("main-session-restart-recovery");
    expect(hub).not.toContain(
      'from "../../agents/main-session-recovery/main-session-restart-recovery.js"',
    );
  });

  it.each(["SIGTERM", "SIGUSR1"] as const)(
    "finishes priming before installing signals and handles %s after dist chunk rotation",
    async (signal) => {
      vi.resetModules();
      const importing = createDeferredCore();
      const finishImport = createDeferredCore();
      let primed = false;
      const idle = createActiveWorkSnapshot();
      const hub = {
        detectGatewayRespawnSupervisorIdentity: () => ({ kind: "systemd" as const, name: "test" }),
        requestGatewayRestartWithSignalAdmission:
          vi.fn<LifecycleRuntime["requestGatewayRestartWithSignalAdmission"]>(),
        isGatewaySigusr1RestartExternallyAllowed: () => false,
        scheduleGatewaySigusr1Restart: vi.fn<LifecycleRuntime["scheduleGatewaySigusr1Restart"]>(),
        abortEmbeddedAgentRun: () => false,
        consumeGatewayRestartIntentPayloadSync: vi.fn(() => null),
        consumeGatewaySigusr1RestartAuthorization: () => true,
        consumeGatewaySigusr1RestartIntent: () => null,
        peekGatewaySigusr1RestartReason: () => undefined,
        markGatewaySigusr1RestartHandled: vi.fn(),
        abortPendingChannelReloads: vi.fn(),
        markGatewayDraining: vi.fn(),
        createGatewayActiveWorkSnapshot: () => idle,
        waitForGatewayActiveWork: vi.fn(async () => ({ drained: true, snapshot: idle })),
        stopGatewayManagedProviderLocalServices: vi.fn(async () => {}),
        restartGatewayProcessWithFreshPid: vi.fn(() => ({ mode: "supervised" as const })),
        writeGatewayRestartHandoffSync: vi.fn(() => null),
      } satisfies Partial<LifecycleRuntime>;
      vi.doMock("./lifecycle.runtime.js", async () => {
        importing.resolve();
        await finishImport.promise;
        primed = true;
        return hub;
      });
      const { runGatewayLoop } = await import("./run-loop.js");
      await withIsolatedSignals(async ({ captureSignal }) => {
        const originalOn = process.on.bind(process);
        const installed: string[] = [];
        vi.spyOn(process, "on").mockImplementation((event, listener) => {
          if (event === "SIGTERM" || event === "SIGINT" || event === "SIGUSR1") {
            expect(primed, `lifecycle import must finish before installing ${event}`).toBe(true);
            installed.push(event);
          }
          return originalOn(event, listener);
        });
        const fixtureStopped = new Error("fixture stopped");
        const startupSettled = createDeferredCore();
        void startupSettled.promise.catch(() => {});
        const close = createCloseMock();
        const { start, started } = createSignaledStart(close, startupSettled.promise);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        const loop = runGatewayLoop({ start, runtime, completeBoot });
        void loop.catch(() => {});
        try {
          await Promise.race([importing.promise, loop]);
          expect(installed).toEqual([]);
          expect(start).not.toHaveBeenCalled();
          finishImport.resolve();
          await Promise.race([waitForStart(started), loop]);
          expect(installed).toEqual(["SIGTERM", "SIGINT", "SIGUSR1"]);

          const missingChunk = vi.fn(() => {
            throw Object.assign(new Error("rotated lifecycle chunk"), {
              code: "ERR_MODULE_NOT_FOUND",
            });
          });
          vi.doMock("./lifecycle.runtime.js", missingChunk);
          // Prove new imports fail while the already-running owner retains its hub.
          await expect(import("./lifecycle.runtime.js")).rejects.toThrow();
          expect(missingChunk).toHaveBeenCalledOnce();
          missingChunk.mockClear();
          captureSignal(signal)();
          await vi.waitFor(() => expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0));
          await expect(exited).resolves.toBe(0);
          expect(missingChunk).not.toHaveBeenCalled();
          expect(hub.consumeGatewayRestartIntentPayloadSync).toHaveBeenCalledOnce();
          expect(hub.waitForGatewayActiveWork).toHaveBeenCalledOnce();
          expect(close).toHaveBeenCalledOnce();
          expect(hub.stopGatewayManagedProviderLocalServices).toHaveBeenCalledOnce();
          expect(fixture.releaseLock).toHaveBeenCalledOnce();
          expect(fixture.error).not.toHaveBeenCalled();
          expect(completeBoot).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome: signal === "SIGUSR1" ? "planned_restart" : "clean_stop",
            }),
          );
          if (signal === "SIGUSR1") {
            expect(hub.restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
            expect(hub.writeGatewayRestartHandoffSync).toHaveBeenCalledOnce();
          }
        } finally {
          finishImport.resolve();
          if (start.mock.calls.length && !runtime.exit.mock.calls.length) {
            captureSignal("SIGINT")();
            await exited;
          }
          startupSettled.reject(fixtureStopped);
          await loop.catch(() => {});
        }
      });
    },
  );
});
