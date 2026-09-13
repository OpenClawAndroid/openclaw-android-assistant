import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import {
  beginConversationDeliveryOperation,
  getConversationDeliveryOperation,
} from "../../config/sessions/conversation-delivery-store.js";
import {
  registerConversationAddresses,
  resolveConversation,
  resolveConversationRegistryScope,
} from "../../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../../config/sessions/conversation-route-fingerprint.js";
import {
  conversation,
  holdConversationWriterForTest,
} from "../../gateway/conversation-delivery.test-support.js";
import { runGatewayConversationSend } from "../../gateway/conversation-send.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import {
  defaultConversationDeliveryDeps,
  type ConversationDeliveryDeps,
} from "./conversation-delivery.js";
import { deliverOutboundPayloadsInternal } from "./deliver.js";
import {
  captureConversationDeliveryTarget,
  markDurableDeliveryQueued,
} from "./delivery-completion.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { enqueueDeliveryOnce, loadPendingDelivery } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  readQueuedEntries,
} from "./delivery-queue.test-helpers.js";

describe("conversation completion through the real delivery queue", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  function installSender(sendText: NonNullable<ChannelOutboundAdapter["sendText"]>) {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "reef",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "reef",
              outbound: { deliveryMode: "direct", sendText },
              messaging: {
                normalizeTarget: (raw) => raw.trim(),
                inferTargetChatType: () => "direct",
                targetResolver: {
                  looksLikeId: (raw) => raw === "molty" || raw === conversation.target,
                },
              },
            }),
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({ enabled: true }),
              isConfigured: () => true,
            },
          },
        },
      ]),
    );
  }

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it.each(["omitted-default", "legacy-marker"] as const)(
    "resumes created operation custody with a retained %s completion locator",
    async (locator) => {
      const stateDir = fixtures.tmpDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const legacyMarker = path.join(stateDir, "custom", "sessions.json");
      const config = locator === "legacy-marker" ? { session: { store: legacyMarker } } : {};
      const scope = resolveConversationRegistryScope({ agentId: "main", config });
      onTestFinished(() => {
        closeOpenClawAgentDatabaseByPath(scope.storePath);
      });
      registerConversationAddresses(scope, [
        { ...conversation, deliveryTarget: conversation.target },
      ]);
      const operationId = "retained-created-operation";
      beginConversationDeliveryOperation(scope, {
        operationId,
        operationKind: "send",
        conversationRef: conversation.conversationRef,
        message: "retained intent",
      });
      const completion = {
        kind: "conversation" as const,
        agentId: "main",
        operationId,
        routeFingerprint: resolveConversationRouteFingerprint(conversation),
        ...(locator === "legacy-marker" ? { storePath: legacyMarker } : {}),
      };
      const queueId = "retained-queue-before-callback";
      await enqueueDeliveryOnce(
        {
          channel: "reef",
          to: conversation.target,
          payloads: [{ text: "retained intent" }],
          queuePolicy: "required",
          deliveryCompletion: completion,
        },
        queueId,
        stateDir,
      );
      expect(getConversationDeliveryOperation(scope, operationId)?.status).toBe("created");
      const sendText = vi.fn(async () => {
        expect((await loadPendingDelivery(queueId, stateDir))?.deliveryCompletion).toEqual(
          completion,
        );
        return { channel: "reef" as const, messageId: "retained-send" };
      });
      installSender(sendText);
      await expect(
        deliverOutboundPayloadsInternal({
          cfg: config,
          channel: "reef",
          to: conversation.target,
          payloads: [{ text: "retained intent" }],
          queuePolicy: "required",
          deliveryIntentId: queueId,
          reusePendingDeliveryIntent: true,
          requireUnknownSendReconciliation: false,
          deliveryCompletion: { ...completion, storePath: scope.storePath },
          conversationDeliveryTarget: captureConversationDeliveryTarget(scope),
          onDeliveryAttempt: async () => {},
        }),
      ).resolves.toMatchObject([{ messageId: "retained-send" }]);
      expect(sendText).toHaveBeenCalledOnce();
      expect(getConversationDeliveryOperation(scope, operationId)?.status).toBe("sent");
      expect(await loadPendingDelivery(queueId, stateDir)).toBeNull();
    },
  );

  it.each(["logical-agent", "physical-owner", "physical-path"] as const)(
    "rejects changed %s before completion mutates the operation",
    async (changed) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
      const scope = resolveConversationRegistryScope({ agentId: "main", config: {} });
      onTestFinished(() => {
        closeOpenClawAgentDatabaseByPath(scope.storePath);
      });
      registerConversationAddresses(scope, [
        { ...conversation, deliveryTarget: conversation.target },
      ]);
      const operationId = "mismatched-completion";
      beginConversationDeliveryOperation(scope, {
        operationId,
        operationKind: "send",
        conversationRef: conversation.conversationRef,
        message: "captured owner",
      });
      const target = captureConversationDeliveryTarget(scope);
      if (changed === "logical-agent") {
        target.agentId = "other";
      }
      if (changed === "physical-owner") {
        target.databaseAgentId = "other";
      }
      if (changed === "physical-path") {
        target.storePath = path.join(fixtures.tmpDir(), "other.sqlite");
      }
      await expect(
        markDurableDeliveryQueued(
          { kind: "conversation", agentId: "main", operationId },
          "queue-mismatch",
          undefined,
          undefined,
          undefined,
          target,
        ),
      ).rejects.toThrow("Conversation delivery target does not match durable custody");
      expect(getConversationDeliveryOperation(scope, operationId)?.status).toBe("created");
    },
  );

  it("keeps Gateway send custody and completion on its captured root across both writer waits", async () => {
    const originalRoot = path.join(fixtures.tmpDir(), "original");
    const replacementRoot = path.join(fixtures.tmpDir(), "replacement");
    fs.mkdirSync(originalRoot);
    fs.mkdirSync(replacementRoot);
    vi.stubEnv("OPENCLAW_STATE_DIR", originalRoot);
    const scope = resolveConversationRegistryScope({ agentId: "main", config: {} });
    const replacementScope = {
      agentId: "main",
      storePath: path.join(replacementRoot, "agents", "main", "agent", "openclaw-agent.sqlite"),
      env: { ...scope.env, OPENCLAW_STATE_DIR: replacementRoot },
    };
    onTestFinished(() => {
      closeOpenClawAgentDatabaseByPath(scope.storePath);
      closeOpenClawAgentDatabaseByPath(replacementScope.storePath);
    });
    const config = { agents: { entries: { main: {} } }, session: { store: scope.storePath } };
    const operationId = "real-queue-admission";
    registerConversationAddresses(scope, [
      { ...conversation, deliveryTarget: conversation.target },
    ]);
    const started = createDeferred<{
      writer: ReturnType<typeof holdConversationWriterForTest>;
      queueId: string;
    }>();
    const sent = createDeferred<ReturnType<typeof holdConversationWriterForTest>>();
    let cleanupStarted = false;
    let custodyWriter: ReturnType<typeof holdConversationWriterForTest> | undefined;
    let settlementWriter: ReturnType<typeof holdConversationWriterForTest> | undefined;
    const sendText = vi.fn(async (input: object) => {
      expect(input).not.toHaveProperty("conversationDeliveryTarget");
      expect(input).not.toHaveProperty("deliveryQueueStateContext");
      expect(input).not.toHaveProperty("env");
      expect(input).not.toHaveProperty("supervisorMode");
      const writer = holdConversationWriterForTest(scope);
      settlementWriter = writer;
      sent.resolve(writer);
      if (cleanupStarted) {
        await writer.release();
      }
      return { channel: "reef" as const, messageId: "reef-delivered" };
    });
    installSender(sendText);
    let actionFailed = false;
    let actionError: unknown;
    const runMessageAction = vi.fn<ConversationDeliveryDeps["runMessageAction"]>(async (input) => {
      if (!input.deliveryIntentId) {
        throw new Error("Gateway conversation send did not supply its queue intent");
      }
      const writer = holdConversationWriterForTest(scope);
      custodyWriter = writer;
      started.resolve({ writer, queueId: input.deliveryIntentId });
      await writer.entered;
      if (cleanupStarted) {
        await writer.release();
      }
      // Gateway has created the operation and captured its target; every real
      // action/send adapter below must retain those facts through its awaits.
      vi.stubEnv("OPENCLAW_STATE_DIR", replacementRoot);
      try {
        return await defaultConversationDeliveryDeps.runMessageAction(input);
      } catch (error) {
        actionFailed = true;
        actionError = error;
        throw error;
      }
    });
    let settled = false;
    const delivery = runGatewayConversationSend(
      {
        config,
        readCurrentConfig: () => config,
        agentId: "main",
        senderIsOwner: true,
        operationId,
        conversationRef: conversation.conversationRef,
        message: "synthetic conversation",
      },
      { ...defaultConversationDeliveryDeps, resolveConversation, runMessageAction },
    ).finally(() => {
      settled = true;
    });
    const outcome = delivery.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const custodyWriterReady = Promise.race([started.promise, outcome.then(() => undefined)]);
    const settlementWriterReady = Promise.race([sent.promise, outcome.then(() => undefined)]);
    try {
      const custody = await custodyWriterReady;
      if (!custody) {
        throw new Error("Gateway send settled before reaching its custody writer", {
          cause: await outcome,
        });
      }
      const { queueId } = custody;
      await custody.writer.entered;
      await vi.waitFor(() =>
        expect(
          readQueuedEntries(originalRoot).length > 0 ||
            readQueuedEntries(replacementRoot).length > 0 ||
            sendText.mock.calls.length > 0 ||
            actionFailed ||
            settled,
        ).toBe(true),
      );
      if (actionFailed) {
        throw actionError;
      }
      if (settled) {
        await delivery;
      }
      expect(sendText).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(readQueuedEntries(originalRoot)).toHaveLength(1);
      expect(readQueuedEntries(replacementRoot)).toEqual([]);
      expect(getConversationDeliveryOperation(scope, operationId)?.status).toBe("created");
      const [queued] = readQueuedEntries(originalRoot);
      expect(queued).not.toHaveProperty("conversationDeliveryTarget");
      expect(queued).not.toHaveProperty("deliveryQueueStateContext");
      expect(queued).not.toHaveProperty("env");
      expect(queued).not.toHaveProperty("supervisorMode");
      expect(queued?.id).toBe(queueId);
      expect(queued?.deliveryCompletion).toMatchObject({
        kind: "conversation",
        agentId: "main",
        operationId,
        routeFingerprint: resolveConversationRouteFingerprint(conversation),
      });
      await custody.writer.release();
      settlementWriter = await settlementWriterReady;
      if (!settlementWriter) {
        throw new Error("Gateway send settled before reaching its completion writer", {
          cause: await outcome,
        });
      }
      await settlementWriter.entered;
      await setImmediate();
      expect(settled).toBe(false);
      expect(getConversationDeliveryOperation(scope, operationId)).toMatchObject({
        status: "queued",
        queueId,
      });
      expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, originalRoot)).toBe(
        "pending",
      );
      await settlementWriter.release();
      expect(await outcome).toMatchObject({
        value: { status: "sent", messageId: "reef-delivered", queueId },
      });
      expect(runMessageAction).toHaveBeenCalledOnce();
      expect(sendText).toHaveBeenCalledOnce();
      expect(getConversationDeliveryOperation(scope, operationId)).toMatchObject({
        status: "sent",
        platformMessageId: "reef-delivered",
        queueId,
      });
      expect(getConversationDeliveryOperation(replacementScope, operationId)).toBeUndefined();
      expect(readQueuedEntries(originalRoot)).toEqual([]);
      expect(readQueuedEntries(replacementRoot)).toEqual([]);
    } finally {
      cleanupStarted = true;
      try {
        await Promise.all([custodyWriter?.release(), settlementWriter?.release()]);
      } finally {
        await outcome;
      }
    }
  });
});
