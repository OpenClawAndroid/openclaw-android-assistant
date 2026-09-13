// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchLowLevelChannelReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { getPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshModelRuntimeAfterHotReload } from "../gateway/server-reload-model-runtime-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import { loadPreparedModelCatalogOwnerSnapshot } from "./prepared-model-catalog.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import {
  acquirePreparedModelRuntimeSnapshot,
  advancePreparedModelRuntimeConfig,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "hot-reload-dispatch" });
  await resetPreparedModelRuntimeHarness(state);
  mocks.configuredAgentIds = ["default"];
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

function config(enabled: boolean): OpenClawConfig {
  return { hooks: { internal: { entries: { "session-memory": { enabled } } } } };
}

function ownerInput(cfg: OpenClawConfig) {
  return { config: cfg, agentId: "default", agentDir: state.agentDir("default") };
}

async function publish(cfg: OpenClawConfig) {
  await refreshPreparedModelRuntimeSnapshots(cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
}

describe("retained config and committed model publication", () => {
  it.each(["advance", "hot reload"])(
    "%s preserves exact catalog isolation while dispatch selects the committed config",
    async (publication) => {
      const retained = config(true);
      const committed = config(false);
      await publish(retained);
      await expect(
        loadPreparedModelCatalogOwnerSnapshot(ownerInput(retained)),
      ).resolves.toMatchObject({
        config: retained,
      });
      if (publication === "advance") {
        advancePreparedModelRuntimeConfig(committed);
      } else {
        await refreshModelRuntimeAfterHotReload({
          config: committed,
          agentIds: undefined,
          pluginMetadataSnapshot: undefined,
        });
      }
      await expect(
        loadPreparedModelCatalogOwnerSnapshot(ownerInput(retained)),
      ).rejects.toBeInstanceOf(PreparedModelCatalogConfigReplacedError);
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ).resolves.toMatchObject({
        config: committed,
      });
      await expect(
        loadPreparedModelCatalogOwnerSnapshot(ownerInput(committed)),
      ).resolves.toMatchObject({
        config: committed,
      });
    },
  );

  it("advances model-neutral config without another catalog discovery", async () => {
    await publish(config(true));
    const discoveries = mocks.runPreparedModelCatalogWorker.mock.calls.length;
    const committed = config(false);
    advancePreparedModelRuntimeConfig(committed);
    const runtime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    expect(runtime?.config).toEqual(committed);
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(discoveries);
  });

  it("does not let a retained lease authorize an old config catalog read", async () => {
    const retained = config(true);
    await publish(retained);
    await using lease = await acquirePreparedModelRuntimeSnapshot(ownerInput(retained));
    advancePreparedModelRuntimeConfig(config(false));
    await withPreparedModelRuntimePluginGenerationScope(
      lease.pluginGeneration,
      async () => {
        await expect(
          loadPreparedModelCatalogOwnerSnapshot(ownerInput(retained)),
        ).rejects.toBeInstanceOf(PreparedModelCatalogConfigReplacedError);
      },
      () => lease.snapshot,
    );
  });
});

it("delivers low-level channel replies after hot reload with a retained monitor config", async () => {
  const retained = config(true);
  await publish(retained);
  const deliver = vi.fn(async (_payload: ReplyPayload) => undefined);
  const dispatch = async (messageId: string) => {
    const dispatcher = createReplyDispatcher({ deliver });
    const result = await dispatchLowLevelChannelReplyFromConfig({
      cfg: retained,
      ctx: finalizeInboundContext({
        Body: "hello",
        From: "synthetic-user",
        To: "synthetic-bot",
        AgentId: "default",
        SessionKey: "agent:default:main",
        MessageSid: messageId,
        Provider: "synthetic-channel",
        Surface: "synthetic-channel",
        ChatType: "direct",
        InboundAccessAuthorized: true,
      }),
      dispatcher,
      replyResolver: async (_ctx, _opts, configOverride) => {
        const runtime = getPreparedReplyDispatchRuntime();
        const owner = await loadPreparedModelCatalogOwnerSnapshot(
          ownerInput(runtime?.config ?? configOverride ?? retained),
        );
        return {
          text: `memory enabled: ${owner.config.hooks?.internal?.entries?.["session-memory"]?.enabled}`,
        };
      },
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(result.queuedFinal).toBe(true);
  };
  await dispatch("before-reload");
  await refreshModelRuntimeAfterHotReload({
    config: config(false),
    agentIds: undefined,
    pluginMetadataSnapshot: undefined,
  });
  await dispatch("after-reload");
  expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual([
    "memory enabled: true",
    "memory enabled: false",
  ]);
});
