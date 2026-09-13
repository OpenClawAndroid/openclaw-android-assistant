import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { refreshChatMetadata, retireChatMetadataRequests } from "./chat-state-refresh.ts";

afterEach(() => vi.useRealTimers());

it.each(["agent:work:current", "global"])(
  "refreshes catalog-dependent facts for %s without reloading retained roster windows",
  async (key) => {
    vi.useFakeTimers();
    const before: GatewaySessionRow = {
      key,
      agentId: "work",
      sessionId: "current-session",
      kind: "direct",
      updatedAt: 1,
      model: "model",
      modelProvider: "test",
      contextTokens: 8192,
    };
    const after = { ...before, contextTokens: 262144 };
    const other: GatewaySessionRow = {
      key: "agent:other:kept",
      sessionId: "other-session",
      kind: "direct",
      updatedAt: 1,
    };
    const query = { agentId: "work", spawnedBy: key, limit: 10000 };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "models.list") {
        return { models: [] };
      }
      if (method === "chat.metadata") {
        return { commands: [] };
      }
      if (method === "sessions.describe") {
        return { session: after };
      }
      if (method === "sessions.list") {
        return sessionsResult(
          (params as { agentId?: string }).agentId === "other" ? [other] : [before],
          1,
        );
      }
      return {};
    });
    const client = createTestGatewayClient(request);
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway, "work");
    const state = {
      ...makeChatHost(),
      client,
      sessions,
      sessionKey: key,
      assistantAgentId: "work",
      connected: true,
      connectionEpoch: 1,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const observation = sessions.observeList(query, () => {});
    try {
      await sessions.refresh({ agentId: "other" });
      await observation.refresh();
      state.sessionsResult = sessionsResult([before], 1);
      state.sessionsResultAgentId = "work";
      await refreshChatMetadata(state);
      const initialLists = request.mock.calls.filter(
        ([method]) => method === "sessions.list",
      ).length;
      invalidateChatMetadataStore(client);
      await refreshChatMetadata(state);
      await vi.advanceTimersByTimeAsync(1000);
      expect(state.sessionsResult?.sessions[0]?.contextTokens).toBe(262144);
      expect(sessions.listSnapshot(query).result?.sessions[0]?.contextTokens).toBe(262144);
      expect(sessions.state.agentId).toBe("other");
      expect(sessions.state.result?.sessions).toEqual([other]);
      expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(
        initialLists,
      );
      expect(request).toHaveBeenCalledWith("sessions.describe", { key, agentId: "work" });
      // Actual membership events still refresh the matching windows.
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { key: "agent:work:new", agentId: "work", reason: "create", spawnedBy: key },
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.list").length,
      ).toBeGreaterThan(initialLists);
      const afterMembership = request.mock.calls.filter(
        ([method]) => method === "sessions.list",
      ).length;
      emitEvent({ type: "event", event: "config.changed", payload: {} });
      await vi.advanceTimersByTimeAsync(1000);
      expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(
        afterMembership + 2,
      );
    } finally {
      retireChatMetadataRequests(state);
      observation.dispose();
      sessions.dispose();
    }
  },
);

it("does not publish a catalog descriptor after the chat changes its session", async () => {
  const described = createDeferred<{ session: GatewaySessionRow }>();
  const row: GatewaySessionRow = {
    key: "agent:work:old",
    sessionId: "old-session",
    kind: "direct",
    updatedAt: 1,
    contextTokens: 8192,
  };
  const request = vi.fn((method: string) => {
    if (method === "models.list") {
      return Promise.resolve({ models: [] });
    }
    if (method === "sessions.describe") {
      return described.promise;
    }
    return Promise.resolve({ commands: [] });
  });
  const client = createTestGatewayClient(request);
  const { gateway } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway, "work");
  const state = {
    ...makeChatHost(),
    client,
    sessions,
    connected: true,
    sessionKey: row.key,
    assistantAgentId: "work",
    sessionsResult: sessionsResult([row], 1),
  } as unknown as ChatPageHost;
  try {
    await refreshChatMetadata(state);
    invalidateChatMetadataStore(client);
    const pending = refreshChatMetadata(state);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", { key: row.key, agentId: "work" }),
    );
    const replacement = sessionsResult(
      [{ ...row, key: "agent:work:new", sessionId: "new-session" }],
      2,
    );
    state.sessionKey = "agent:work:new";
    state.sessionsResult = replacement;
    described.resolve({ session: { ...row, contextTokens: 262144 } });
    await pending;
    expect(state.sessionsResult).toBe(replacement);
  } finally {
    described.resolve({ session: row });
    retireChatMetadataRequests(state);
    sessions.dispose();
  }
});
