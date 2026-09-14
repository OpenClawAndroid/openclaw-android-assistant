import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionsGitHubHandlers } from "./sessions-github.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () => undefined,
}));
vi.mock("../github-publication-availability.js", () => ({
  prepareCurrentGitHubPublicationIdentity: mocks.identity,
}));

const sessionKey = "agent:main:publication-read";
const sessionId = "publication-read-session";
const publisher = { source: "agent-override" as const, accountId: 7, login: "shared-bot" };
const receipt = {
  result: {
    requestId: "8c698e8a-bdc7-4927-a0f2-73a842c2d7b1",
    publisher,
    status: "publishing" as const,
    message: "The shared publication is in progress.",
  },
  confirmation: null,
};

async function withReadFixture(run: (fixture: ReturnType<typeof createFixture>) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
    await run(createFixture());
  });
}

function createFixture() {
  const client: GatewayClient = {
    connId: "publication-reader",
    connect: {
      role: "operator",
      scopes: ["operator.read"],
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", mode: "test", platform: "test", version: "1" },
    },
  };
  let connected = true;
  const sharedStatus = vi.fn().mockReturnValue(receipt);
  const latestShared = vi.fn().mockReturnValue(receipt);
  const personalStatus = vi.fn();
  const requestForSession = vi.fn();
  // Only these services belong to the read handler; the authorization helpers stay real.
  const context = {
    getRuntimeConfig,
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
      new Set(connected && (!filter || filter(client)) ? [client.connId] : []),
    githubPublicationService: { sharedStatus, latestShared, personalStatus, requestForSession },
  } as unknown as GatewayRequestContext;
  const invoke = async (
    method: "sessions.github.options" | "sessions.github.status",
    params: Record<string, unknown>,
  ) => {
    const respond = vi.fn();
    await expectDefined(
      sessionsGitHubHandlers[method],
      method,
    )({
      params,
      respond: respond as never,
      context,
      client,
      req: { type: "req", id: "publication-read", method },
      isWebchatConnect: () => false,
    });
    return respond;
  };
  return {
    client,
    invoke,
    sharedStatus,
    latestShared,
    personalStatus,
    requestForSession,
    disconnect: () => {
      connected = false;
    },
  };
}

beforeEach(() => {
  mocks.identity.mockReset().mockResolvedValue({
    source: publisher.source,
    account: { accountId: publisher.accountId, login: publisher.login },
  });
});

describe("shared publication receipt reads", () => {
  it("reads an accepted shared request without a personal profile or write permission", async () => {
    await withReadFixture(async (fixture) => {
      const respond = await fixture.invoke("sessions.github.status", {
        sessionKey,
        requestId: receipt.result.requestId,
      });
      expect(respond).toHaveBeenCalledWith(true, receipt);
      expect(fixture.sharedStatus).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey, sessionId, agentId: "main" }),
        receipt.result.requestId,
      );
      expect(fixture.personalStatus).not.toHaveBeenCalled();
      expect(fixture.requestForSession).not.toHaveBeenCalled();
      expect(mocks.identity).not.toHaveBeenCalled();
    });
  });

  it("discovers the shared receipt and can restrict recovery to the exact invocation key", async () => {
    await withReadFixture(async (fixture) => {
      const respond = await fixture.invoke("sessions.github.options", {
        sessionKey,
        idempotencyKey: "owned-unknown-attempt",
      });
      expect(respond).toHaveBeenCalledWith(true, {
        personal: null,
        shared: publisher,
        pendingPersonal: null,
        latestShared: receipt,
      });
      expect(fixture.latestShared).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey, sessionId, agentId: "main" }),
        "owned-unknown-attempt",
      );
      expect(fixture.requestForSession).not.toHaveBeenCalled();
    });
  });

  it.each(["scope", "connection", "unverified-profile"] as const)(
    "does not downgrade a failed %s check into shared access",
    async (failure) => {
      await withReadFixture(async (fixture) => {
        if (failure === "scope") {
          fixture.client.connect.scopes = [];
        } else if (failure === "connection") {
          fixture.disconnect();
        } else {
          fixture.client.authenticatedUserProfile = {
            profileId: "unverified-publication-person",
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          };
        }
        const respond = await fixture.invoke("sessions.github.status", {
          sessionKey,
          requestId: receipt.result.requestId,
        });
        expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
        expect(fixture.sharedStatus).not.toHaveBeenCalled();
        expect(fixture.personalStatus).not.toHaveBeenCalled();
      });
    },
  );

  it("does not expose personal receipts to a profileless shared reader", async () => {
    await withReadFixture(async (fixture) => {
      fixture.sharedStatus.mockReturnValue(undefined);
      const respond = await fixture.invoke("sessions.github.status", {
        sessionKey,
        requestId: receipt.result.requestId,
      });
      expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(fixture.personalStatus).not.toHaveBeenCalled();
    });
  });
});
