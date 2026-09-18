// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { RuntimeAuthProfileStore } from "./auth-profiles/types.js";
import {
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-model-auth-usage" });
  await resetPreparedModelRuntimeHarness(state);
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

describe("prepared model auth publication", () => {
  it("retains the prepared owner on bookkeeping and refreshes on auth availability changes", async () => {
    const snapshots = await vi.importActual<typeof import("./auth-profiles/runtime-snapshots.js")>(
      "./auth-profiles/runtime-snapshots.js",
    );
    const agentDir = state.agentDir("usage-publication");
    const input = { config: {}, agentDir };
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: { "test:primary": { type: "token", provider: "test", token: "synthetic-token" } },
    };
    snapshots.setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    const initial = await publishPreparedModelRuntimeSnapshot(input);
    const events = vi.fn();
    const unregisterEvents = registerPreparedModelRuntimePublicationListener(events);
    const unregisterAuth = snapshots.registerRuntimeAuthProfileStoreMutationListener((event) => {
      mocks.mutationListener?.(event);
    });
    try {
      snapshots.updateRuntimeAuthProfileStoreSnapshot(
        {
          ...store,
          runtimeInheritsMainState: true,
          usageStats: {
            "test:primary": { lastUsed: 2, errorCount: 1, failureCounts: { timeout: 1 } },
          },
        },
        agentDir,
      );
      expect(await prepareModelRuntimeSnapshot(input)).toBe(initial);
      expect(events).not.toHaveBeenCalled();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();

      snapshots.updateRuntimeAuthProfileStoreSnapshot(
        {
          ...store,
          usageStats: { "test:primary": { cooldownUntil: Date.now() + 60_000 } },
        },
        agentDir,
      );
      expect(await prepareModelRuntimeSnapshot(input)).not.toBe(initial);
      expect(events).toHaveBeenCalledWith({ phase: "invalidated" });
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    } finally {
      unregisterAuth();
      unregisterEvents();
      snapshots.clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
    }
  });
});
