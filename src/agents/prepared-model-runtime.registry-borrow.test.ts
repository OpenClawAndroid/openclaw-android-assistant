// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePublishedPreparedModelRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import * as runtimePlugins from "./runtime-plugins.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-registry-borrow" });
  await resetPreparedModelRuntimeHarness(state);
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

async function acquireConfiguredRegistryBorrower() {
  mocks.configuredAgentIds = ["default"];
  const registry = createEmptyPluginRegistry();
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  const config = {};
  const input = {
    agentId: "default",
    config,
    agentDir: state.agentDir("default"),
    inheritedAuthDir: state.agentDir("default"),
    workspaceDir: "/tmp/unused-workspace",
  };
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const borrower = await acquirePublishedPreparedModelRuntime(input);
  await borrower.snapshot.loadFullModelCatalog?.();
  return { registry, config, input, borrower };
}

describe("prepared registry construction borrows", () => {
  it("retains selected inbound resources until a cancelled initial run inspection settles", async () => {
    const { registry, input, borrower } = await acquireConfiguredRegistryBorrower();
    const inspecting = createDeferred();
    const finishInspection = createDeferred();
    const acquire = runtimePlugins.acquireAgentRuntimePluginRegistry;
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValueOnce(createEmptyPluginRegistry());
    const inspection = vi
      .spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry")
      .mockImplementationOnce(async (...args) => {
        const acquired = await acquire(...args);
        inspecting.resolve();
        await finishInspection.promise;
        return acquired;
      });
    const pending = acquireAgentRunPreparedModelRuntime(
      {
        ...input,
        runtimePluginSelections: [{ provider: "custom", modelId: "selected", runtime: "openclaw" }],
      },
      { catalogMode: "static", pluginGeneration: borrower.pluginGeneration },
    );
    const settled = Promise.allSettled([pending]);
    try {
      await Promise.race([
        inspecting.promise,
        pending.then(() => {
          throw new Error("Initial run skipped inspection acquisition");
        }),
      ]);
      markPreparedModelRuntimeSnapshotsStale("configuration replaced during run admission");
      await borrower[Symbol.asyncDispose]();
      expect(isPluginRegistryRetired(registry)).toBe(false);
      finishInspection.resolve();
      await expect(pending).rejects.toThrow("superseded");
      expect(isPluginRegistryRetired(registry)).toBe(true);
    } finally {
      finishInspection.resolve();
      const [outcome] = await settled;
      if (outcome.status === "fulfilled") {
        await outcome.value[Symbol.asyncDispose]();
      }
      await borrower[Symbol.asyncDispose]();
      inspection.mockRestore();
    }
  });

  it("keeps a cached registry alive while its configured replacement is preparing", async () => {
    const { registry, config, input, borrower } = await acquireConfiguredRegistryBorrower();
    const preparing = createDeferred();
    const finishPreparation = createDeferred();
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      preparing.resolve();
      await finishPreparation.promise;
      return { entries: [] };
    });
    const replacement = refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const settled = Promise.allSettled([replacement]);
    try {
      await Promise.race([
        preparing.promise,
        replacement.then(() => {
          throw new Error("Replacement did not enter catalog preparation");
        }),
      ]);
      await borrower[Symbol.asyncDispose]();
      finishPreparation.resolve();
      await replacement;
      const published = await prepareModelRuntimeSnapshot(input);
      expect(published).not.toBe(borrower.snapshot);
      expect(published.pluginRegistry).toBe(registry);
      expect(published.config).toBe(config);
    } finally {
      finishPreparation.resolve();
      await Promise.allSettled([borrower[Symbol.asyncDispose](), settled]);
    }
  });
  it("does not retire an admitted registry borrower when replacement preparation fails", async () => {
    const { registry, config, borrower } = await acquireConfiguredRegistryBorrower();
    const preparationError = new Error("replacement catalog preparation failed");
    mocks.prepareStaticCatalog.mockRejectedValueOnce(preparationError);
    try {
      await expect(
        refreshPreparedModelRuntimeSnapshots(config, {
          gatewayLifecycle: true,
          catalogMode: "static",
        }),
      ).rejects.toBe(preparationError);
      expect(isPluginRegistryRetired(registry)).toBe(false);
    } finally {
      await borrower[Symbol.asyncDispose]();
    }
    expect(isPluginRegistryRetired(registry)).toBe(true);
  });
});
