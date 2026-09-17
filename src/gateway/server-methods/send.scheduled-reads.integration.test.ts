import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ScheduledToolPolicyContext } from "../../agents/scheduled-tool-policy.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import {
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../message-action-turn-capability.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
  RespondFn,
} from "./types.js";

const guildId = "100000000000000001";
const channelId = "100000000000000002";
const sessionKey = "agent:main:cron:scheduled-reads:run:fixture";
const sessionId = "scheduled-reads-session";
let discordPlugin: ChannelPlugin;
let messageActionHandler: GatewayRequestHandler;

beforeAll(async () => {
  const { sendHandlers } = await import("./send.js");
  messageActionHandler = expectDefined(
    sendHandlers["message.action"],
    "registered Gateway message.action handler",
  );
  ({ discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
    pluginId: "discord",
    artifactBasename: "api.js",
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearRuntimeConfigSnapshot();
});

function discordMessages(content: string) {
  return [{ id: "100000000000000003", channel_id: channelId, content }];
}

function accountPolicy(
  channel = "discord",
): Extract<ScheduledToolPolicyContext, { mode: "account" }> {
  return {
    version: 1,
    mode: "account",
    ownerSessionKey: `agent:main:${channel}:channel:creator`,
    ownerAccountId: "creator",
    ownerOrigin: { kind: "external", channel },
  };
}

async function createFixture(state: OpenClawTestState) {
  let cfg: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir } },
    channels: {
      discord: {
        enabled: true,
        defaultAccount: "creator",
        accounts: {
          creator: { token: "synthetic-creator-provider-fixture" },
          other: { token: "synthetic-other-provider-fixture" },
        },
        groupPolicy: "allowlist",
        guilds: { [guildId]: { channels: { [channelId]: { enabled: true } } } },
      },
    },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg, cfg);
  const owner = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "discord",
    origin: "global",
    trustedOfficialInstall: true,
  });
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: cfg, registrationMode: "full" }).registerChannel({
    plugin: { ...discordPlugin, status: undefined },
  });
  setActivePluginRegistry(owner.registry);

  let sequence = 0;
  const providerRead = vi.fn<() => Promise<Response>>(async () =>
    Response.json(discordMessages(`fresh-${++sequence}`)),
  );
  const httpRequests: Array<{ method: string; path: string; creatorCredentials: boolean }> = [];
  const unexpectedRequests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      httpRequests.push({
        method,
        path: url.pathname,
        creatorCredentials:
          headers.get("authorization") === "Bot synthetic-creator-provider-fixture",
      });
      if (url.origin === "https://discord.com" && method === "GET") {
        if (url.pathname === `/api/v10/channels/${channelId}`) {
          return Response.json({ id: channelId, guild_id: guildId, type: 0, name: "fixture" });
        }
        if (url.pathname === `/api/v10/channels/${channelId}/messages`) {
          return await providerRead();
        }
      }
      const unexpected = `Unexpected fake Discord request: ${method} ${url.pathname}`;
      unexpectedRequests.push(unexpected);
      throw new Error(unexpected);
    }),
  );

  const operationalRunInstance = createOperationalRunInstanceRef("scheduled-reads-run");
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  // Only the independently covered cron lifetime owner is controlled by this fixture.
  const permission = new AbortController();
  const tokens: string[] = [];
  const createClient = (policy: ScheduledToolPolicyContext): GatewayClient => {
    const identity = {
      agentId: "main",
      runId: operationalRunInstance.runId,
      sessionKey,
      sessionId,
    };
    const token = mintMessageActionTurnCapability({
      ...identity,
      scheduled: { policy, assertCurrent: () => permission.signal.throwIfAborted() },
    });
    tokens.push(token);
    const messageActionContext = expectDefined(
      resolveMessageActionTurnCapability({ ...identity, token }),
      "host-minted message action context",
    );
    return {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        scopes: ["operator.write"],
        client: { id: GATEWAY_CLIENT_IDS.CLI, version: "test", platform: "test", mode: "cli" },
      },
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey,
          operationalRunInstance,
          delegatedAuthority: { kind: "local", ...delegatedAuthority },
          messageActionContext: { ...messageActionContext, turnCapability: token },
        },
      },
    };
  };
  const client = createClient(accountPolicy());
  const context = {
    getRuntimeConfig: () => cfg,
    dedupe: new Map(),
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
  } as GatewayRequestContext;
  return {
    providerRead,
    httpRequests,
    unexpectedRequests,
    createClient,
    revoke: () => permission.abort(new Error("scheduled message permission revoked")),
    setDefaultAccount: async (accountId: string) => {
      cfg = {
        ...cfg,
        channels: {
          ...cfg.channels,
          discord: { ...cfg.channels?.discord, defaultAccount: accountId },
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg, cfg);
    },
    read: async (
      options: { accountId?: string; client?: GatewayClient } = {},
    ): Promise<Parameters<RespondFn>> => {
      const respond = vi.fn<RespondFn>();
      await messageActionHandler({
        req: { type: "req", id: "scheduled-read", method: "message.action" },
        params: {
          channel: "discord",
          action: "read",
          params: { channelId, limit: 1 },
          ...(options.accountId ? { accountId: options.accountId } : {}),
          sessionKey,
          sessionId,
          idempotencyKey: "same-scheduled-read",
        },
        context,
        client: options.client ?? client,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledOnce();
      return expectDefined(respond.mock.calls[0], "Gateway read response");
    },
    close: () => {
      for (const token of tokens) {
        revokeMessageActionTurnCapability(token);
      }
      releaseAgentRunDelegatedAuthority(delegatedAuthority);
    },
  };
}

async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  await withOpenClawTestState(
    { prefix: "gateway-scheduled-reads-", env: { DISCORD_API_URL: undefined } },
    async (state) => {
      const fixture = await createFixture(state);
      try {
        await run(fixture);
        expect(fixture.unexpectedRequests).toEqual([]);
      } finally {
        fixture.close();
      }
    },
  );
}

function expectRead(response: Parameters<RespondFn>, content: string) {
  expect(response[0]).toBe(true);
  expect(response[1]).toMatchObject({ ok: true, channelId, messages: [{ content }] });
  expect(response[2]).toBeUndefined();
}

function expectDenied(response: Parameters<RespondFn>, reason: string) {
  expect(response[0]).toBe(false);
  expect(response[1]).toBeUndefined();
  expect(response[2]?.message).toContain(reason);
}

describe("Gateway scheduled reads through an installed Discord plugin", () => {
  it("fetches fresh same-key results and rejects a repeat after permission revocation", async () => {
    await withFixture(async (fixture) => {
      expectRead(await fixture.read(), "fresh-1");
      expectRead(await fixture.read(), "fresh-2");
      expect(fixture.providerRead).toHaveBeenCalledTimes(2);
      const requestsBeforeRevocation = fixture.httpRequests.length;
      fixture.revoke();
      expectDenied(await fixture.read(), "authority is no longer active");
      expect(fixture.httpRequests).toHaveLength(requestsBeforeRevocation);
    });
  });

  it("rejects a concurrent same-key read without joining a response accepted before revocation", async () => {
    await withFixture(async (fixture) => {
      const accepted = createDeferred();
      const releaseResponse = createDeferred();
      fixture.providerRead.mockImplementationOnce(async () => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            accepted.resolve();
            await releaseResponse.promise;
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(discordMessages("late-data"))),
            );
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      });
      const first = fixture.read();
      let repeated: ReturnType<typeof fixture.read> | undefined;
      try {
        await withTestTimeout(
          Promise.race([accepted.promise, first]),
          5000,
          "Discord read did not reach the provider",
        );
        expect(fixture.providerRead).toHaveBeenCalledOnce();
        const requestsBeforeRevocation = fixture.httpRequests.length;
        fixture.revoke();
        repeated = fixture.read();
        expectDenied(
          await withTestTimeout(
            repeated,
            5000,
            "Revoked same-key read joined the pending provider response",
          ),
          "authority is no longer active",
        );
        expect(fixture.httpRequests).toHaveLength(requestsBeforeRevocation);
        releaseResponse.resolve();
        expectDenied(await first, "authority is no longer active");
        expect(fixture.providerRead).toHaveBeenCalledOnce();
      } finally {
        releaseResponse.resolve();
        await Promise.allSettled([first, repeated]);
      }
    });
  });

  it.each(["account", "provider", "unknown origin", "missing origin"] as const)(
    "does not reuse a successful key with a mismatched creator %s",
    async (mismatch) => {
      await withFixture(async (fixture) => {
        expectRead(await fixture.read(), "fresh-1");
        const requestsBeforeMismatch = fixture.httpRequests.length;
        const policy = accountPolicy(mismatch === "provider" ? "slack" : "discord");
        if (mismatch === "unknown origin") {
          policy.ownerOrigin = { kind: "unknown" };
        } else if (mismatch === "missing origin") {
          delete policy.ownerOrigin;
        }
        const response = await fixture.read(
          mismatch === "account"
            ? { accountId: "other" }
            : { client: fixture.createClient(policy) },
        );
        expectDenied(
          response,
          mismatch === "account" ? "another creator account" : "matching recorded creator origin",
        );
        expect(fixture.httpRequests).toHaveLength(requestsBeforeMismatch);
      });
    },
  );

  it("keeps omitted-account reads on the creator when the provider default changes", async () => {
    await withFixture(async (fixture) => {
      expectRead(await fixture.read(), "fresh-1");
      await fixture.setDefaultAccount("other");
      expectRead(await fixture.read(), "fresh-2");
      expect(fixture.providerRead).toHaveBeenCalledTimes(2);
      expect(fixture.httpRequests.every((request) => request.creatorCredentials)).toBe(true);
    });
  });
});
