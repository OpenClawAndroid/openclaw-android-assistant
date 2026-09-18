// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as legacyAuth from "./legacy-inherited-auth-dir.js";
import {
  advancePreparedModelRuntimeConfig,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";
import { getPreparedModelRuntimeStartupStatus } from "./prepared-model-runtime.startup-status.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared fleet batches", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-fleet-batch" });
    await resetPreparedModelRuntimeHarness(state);
    mocks.configuredAgentIds = ["first", "middle", "last"];
  });

  afterEach(async (context) => {
    await cleanupPreparedModelRuntimeHarness(state, context.task.result?.state === "fail");
  });

  it.each([
    { heldIndex: 0, earlyAuth: false },
    { heldIndex: 32, earlyAuth: false },
    { heldIndex: 32, earlyAuth: true },
  ])(
    "continues first Gateway startup while fleet workspace $heldIndex is acquiring (early auth: $earlyAuth)",
    async ({ heldIndex, earlyAuth }) => {
      mocks.configuredAgentIds = Array.from({ length: 64 }, (_, index) => `fleet-${index}`);
      const acquiring = createDeferredCore();
      const acquired = createDeferredCore();
      const completed = createDeferredCore();
      const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) => {
        if (phase === "published" && getPreparedModelRuntimeStartupStatus()?.degraded === false) {
          completed.resolve();
        }
      });
      const heldAgent = `fleet-${heldIndex}`;
      const config = {};
      const credentials = { custom: { type: "api_key" as const, key: "updated-test-key" } };
      const mutateAuth = () => {
        mocks.authStorage.getAll.mockReturnValue(credentials);
        mocks.mutationListener?.({
          agentDir: state.agentDir("fleet-0"),
          affectsInheritedStores: false,
        });
      };
      mocks.prepareStaticCatalog.mockImplementation(async (options) => {
        if ((options as { workspaceDir: string }).workspaceDir === `/tmp/workspace-${heldAgent}`) {
          acquiring.resolve();
          await acquired.promise;
        }
        return { entries: [] };
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(120_000);
      const publication = refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        startup: true,
        catalogMode: "static",
      });
      const ready = expect(publication).resolves.toBeUndefined();
      // Attach before advancing timers so the expected pre-fix rejection is always observed.
      void ready.catch(() => undefined);
      try {
        await acquiring.promise;
        if (earlyAuth) {
          mutateAuth();
        }
        await vi.advanceTimersByTimeAsync(120_000);
        await ready;
        expect(getPreparedModelRuntimeStartupStatus()).toMatchObject({
          degraded: true,
          pendingAgents: expect.arrayContaining([heldAgent, "fleet-63"]),
          stage: `static provider catalog; agent ${heldAgent}`,
        });
        expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining(`agent ${heldAgent}`));
        await expect(
          loadPublishedGatewayReplyDispatchRuntime({ agentId: heldAgent }),
        ).rejects.toThrow(heldAgent);
        if (heldIndex > 0) {
          await expect(
            loadPublishedGatewayReplyDispatchRuntime({ agentId: "fleet-0" }),
          ).resolves.toMatchObject({ agentId: "fleet-0" });
          if (!earlyAuth) {
            mutateAuth();
          }
          await expect(
            loadPublishedGatewayReplyDispatchRuntime({ agentId: "fleet-0" }),
          ).resolves.toMatchObject({ agentId: "fleet-0" });
          expect(
            getPreparedModelRuntimeSnapshot({
              config,
              agentId: "fleet-0",
              agentDir: state.agentDir("fleet-0"),
            })
              ?.createStores()
              .authStorage.getAll(),
          ).toEqual(credentials);
        }
        acquired.resolve();
        await completed.promise;
        expect(getPreparedModelRuntimeStartupStatus()).toEqual({
          degraded: false,
          pendingAgents: [],
        });
        await expect(
          loadPublishedGatewayReplyDispatchRuntime({ agentId: heldAgent }),
        ).resolves.toMatchObject({ agentId: heldAgent });
        expect(
          getPreparedModelRuntimeSnapshot({
            config,
            agentId: heldAgent,
            agentDir: state.agentDir(heldAgent),
          }),
        ).toBeDefined();
      } finally {
        acquired.resolve();
        await Promise.allSettled([publication]);
        await getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
        unregister();
        vi.useRealTimers();
      }
    },
  );

  it("keeps auth admission pending when startup degrades during an adopted refresh", async () => {
    mocks.configuredAgentIds = ["first", "last"];
    const firstAuth = createDeferredCore();
    const finishFirstAuth = createDeferredCore();
    const secondAuth = createDeferredCore();
    const finishSecondAuth = createDeferredCore();
    const mutateAuth = () =>
      mocks.mutationListener?.({
        agentDir: state.agentDir("first"),
        affectsInheritedStores: false,
      });
    let initial = true;
    mocks.prepareStaticCatalog.mockImplementation(async (options) => {
      if (initial && (options as { workspaceDir: string }).workspaceDir === "/tmp/workspace-last") {
        initial = false;
        mutateAuth();
      }
      return { entries: [] };
    });
    mocks.resolveAmbientCredentials
      .mockImplementationOnce(() => ({}))
      .mockImplementationOnce(() => ({}))
      .mockImplementationOnce(async () => {
        firstAuth.resolve();
        await finishFirstAuth.promise;
        return {};
      })
      .mockImplementationOnce(async () => {
        secondAuth.resolve();
        await finishSecondAuth.promise;
        return {};
      });
    mocks.warn.mockImplementation((message: string) => {
      if (message.includes("startup degraded")) {
        mutateAuth();
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const publication = refreshPreparedModelRuntimeSnapshots(
      {},
      {
        gatewayLifecycle: true,
        startup: true,
        catalogMode: "static",
      },
    );
    let admission: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let settled = false;
    try {
      await firstAuth.promise;
      admission = loadPublishedGatewayReplyDispatchRuntime({ agentId: "first" });
      void admission.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await publication;
      finishFirstAuth.resolve();
      await secondAuth.promise;
      await nextTurn();
      expect(settled).toBe(false);
      finishSecondAuth.resolve();
      await expect(admission).resolves.toMatchObject({ agentId: "first" });
    } finally {
      finishFirstAuth.resolve();
      finishSecondAuth.resolve();
      await Promise.allSettled([publication, admission]);
      await getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "retains settled agents after a late failure (neutral config advance: %s)",
    async (advanceConfig) => {
      mocks.configuredAgentIds = ["first", "last"];
      const acquiring = createDeferredCore();
      const acquired = createDeferredCore();
      const failed = createDeferredCore();
      mocks.prepareStaticCatalog.mockImplementation(async (options) => {
        if ((options as { workspaceDir: string }).workspaceDir === "/tmp/workspace-last") {
          acquiring.resolve();
          await acquired.promise;
        }
        return { entries: [] };
      });
      mocks.warn.mockImplementation((message: string) => {
        if (message.includes("background model runtime publication failed")) {
          failed.resolve();
        }
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const publication = refreshPreparedModelRuntimeSnapshots(
        {},
        {
          gatewayLifecycle: true,
          startup: true,
          catalogMode: "static",
        },
      );
      try {
        await acquiring.promise;
        await vi.advanceTimersByTimeAsync(120_000);
        await publication;
        if (advanceConfig) {
          advancePreparedModelRuntimeConfig({ logging: { level: "debug" } });
        }
        acquired.reject(new Error("fixture catalog failure"));
        await failed.promise;
        await expect(
          loadPublishedGatewayReplyDispatchRuntime({ agentId: "first" }),
        ).resolves.toMatchObject({ agentId: "first" });
        expect(getPreparedModelRuntimeStartupStatus()).toMatchObject({
          degraded: true,
          pendingAgents: ["last"],
        });
      } finally {
        acquired.resolve();
        await Promise.allSettled([publication]);
        await getPreparedModelRuntimeTestApi().resetPreparedModelRuntimeSnapshotsForTest();
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "services queued event-loop work between agents (shared workspace: %s)",
    async (sharedWorkspace) => {
      if (sharedWorkspace) {
        for (const id of mocks.configuredAgentIds) {
          mocks.configuredWorkspaces.set(id, state.workspaceDir);
        }
      }
      const events: string[] = [];
      let queued: Promise<void> | undefined;
      mocks.discoverAuthStorage.mockImplementation((agentDir) => {
        const agent = mocks.configuredAgentIds.find((id) => state.agentDir(id) === agentDir)!;
        events.push(agent);
        if (agent === "first") {
          queued = nextTurn().then(() => {
            events.push("event-loop");
          });
        }
        return mocks.authStorage;
      });

      await refreshPreparedModelRuntimeSnapshots(
        {},
        {
          gatewayLifecycle: true,
          catalogMode: "static",
        },
      );
      await queued;

      expect(events.indexOf("first")).toBeLessThan(events.indexOf("event-loop"));
      expect(events.indexOf("event-loop")).toBeLessThan(events.indexOf("last"));
    },
  );

  it("does not start plugin callbacks after cancellation at an event-loop boundary", async () => {
    let cancelled = false;
    let lateLoads = 0;
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      if (cancelled) {
        lateLoads += 1;
      }
      return createEmptyPluginRegistry();
    });
    const publication = publishPreparedModelRuntimeSnapshot({
      config: {},
      agentDir: state.agentDir("cancelled"),
      workspaceDir: state.workspaceDir,
    });
    cancelled = true;
    markPreparedModelRuntimeSnapshotsStale("cancel before workspace preparation");
    await expect(publication).rejects.toThrow("superseded");
    expect(lateLoads).toBe(0);
  });

  it("captures one immutable config per fleet without freezing the caller or reusing a stale capture", async () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "fixture/first" } },
    };
    const captures: OpenClawConfig[] = [];
    mocks.prepareStaticCatalog.mockImplementation(async (options) => {
      captures.push((options as { config: OpenClawConfig }).config);
      return { entries: [] };
    });

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    expect(captures).toHaveLength(3);
    expect(new Set(captures).size).toBe(1);
    const first = captures[0]!;
    expect(first).not.toBe(config);
    expect(Object.isFrozen(first.agents?.defaults)).toBe(true);
    expect(Object.isFrozen(config.agents?.defaults)).toBe(false);

    config.agents!.defaults!.model = "fixture/second";
    expect(first.agents?.defaults?.model).toBe("fixture/first");
    captures.length = 0;
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    expect(new Set(captures).size).toBe(1);
    expect(captures[0]).not.toBe(first);
    expect(captures[0]?.agents?.defaults?.model).toBe("fixture/second");
  });

  it("replays an auth change once the first owner starts capturing credentials", async () => {
    mocks.configuredAgentIds = ["first"];
    const config = {};
    const previous = AuthStorage.inMemory({ custom: { type: "api_key", key: "old-test-key" } });
    const credentials = { custom: { type: "api_key" as const, key: "updated-test-key" } };
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      mocks.authStorage.getAll.mockReturnValue(credentials);
      mocks.mutationListener?.({ affectsInheritedStores: true });
      return previous;
    });

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const snapshot = getPreparedModelRuntimeSnapshot({
      config,
      agentId: "first",
      agentDir: state.agentDir("first"),
      inheritedAuthDir: state.agentDir("default"),
      workspaceDir: "/tmp/workspace-first",
    });
    expect(snapshot?.createStores().authStorage.getAll()).toEqual(credentials);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(2);
  });

  it("rebinds inherited auth when shared-store ownership moves before first capture", async () => {
    mocks.configuredAgentIds = ["first"];
    const config = {};
    const inherited = vi.spyOn(legacyAuth, "resolveLegacyInheritedAuthDir");
    inherited.mockReturnValue(state.agentDir("default"));
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      inherited.mockReturnValue(undefined);
      mocks.mutationListener?.({ affectsInheritedStores: true });
      return { entries: [] };
    });
    try {
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      const snapshot = getPreparedModelRuntimeSnapshot({
        config,
        agentId: "first",
        agentDir: state.agentDir("first"),
        workspaceDir: "/tmp/workspace-first",
      });
      expect(snapshot).toBeDefined();
      expect(snapshot?.inheritedAuthDir).toBeUndefined();
      expect(mocks.discoverAuthStorage.mock.calls.at(-1)?.[1]).not.toHaveProperty(
        "inheritedAuthDir",
      );
    } finally {
      inherited.mockRestore();
    }
  });
});
