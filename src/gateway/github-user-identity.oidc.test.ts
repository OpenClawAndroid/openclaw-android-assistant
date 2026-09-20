import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import {
  ensureProfileForEmail,
  getUserProfileListItem,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import { resolveAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import { resolveGatewayConnectUserProfile } from "./server/ws-connection/connect-user-profile.js";

const accessOrigin = "https://team.cloudflareaccess.com";
const cfg: OpenClawConfig = {
  gateway: {
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
      },
    },
    roles: {
      default: "guest",
      definitions: {
        maintainer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.admin"] },
        guest: { sessions: { others: "none" }, agents: [], scopes: [] },
      },
    },
  },
};

function accessRequest(principal = "ada@example.test") {
  const req = new IncomingMessage(new Socket());
  req.headers = {
    "cf-access-authenticated-user-email": principal,
    "cf-access-jwt-assertion": `header.${Buffer.from(JSON.stringify({ iss: accessOrigin })).toString("base64url")}.signature`,
  };
  const authResult = { ok: true, method: "trusted-proxy" as const, user: principal };
  return { req, authResult, cfg };
}

function identityResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("Cloudflare Access OIDC profile resolution", () => {
  it.each(["email", "GitHub"])(
    "reuses an existing %s profile and role for HTTP and WebSocket connections",
    async (provider) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile =
          provider === "GitHub"
            ? syncGitHubIdentity({
                identity: { accountId: 101, login: "ada", name: "Ada" },
                authenticationAlias: { kind: "email", email: "ada@example.test" },
              })
            : ensureProfileForEmail("ada@example.test");
        setUserProfileRole(profile.id, "maintainer");
        const before = getUserProfileListItem(profile.id);
        const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
          identityResponse({
            id: "oidc-subject-101",
            email: "ADA@Example.Test",
            name: "OIDC display name",
            idp: { type: "oidc" },
          }),
        );
        const request = accessRequest();
        try {
          const httpProfile = await resolveAuthenticatedHttpUserProfile(request);
          expect(httpProfile.authenticatedUserProfile?.profileId).toBe(profile.id);
          expect(httpProfile.operatorRolePolicy?.scopes).toEqual(["operator.admin"]);
          const connectedProfile = await resolveGatewayConnectUserProfile({
            ownerProfileExpected: false,
            authenticatedUserId: request.authResult.user,
            authResult: request.authResult,
            resolveAuthenticatedGitHubIdentity: createAuthenticatedGitHubIdentitySync({
              authResult: request.authResult,
              authConfig: cfg.gateway?.auth,
              requestHeaders: request.req.headers,
            }),
          });
          expect(connectedProfile).toEqual(httpProfile.authenticatedUserProfile);
          expect(getUserProfileListItem(profile.id)).toEqual(before);
          expect(transport).toHaveBeenCalledTimes(2);
          expect(
            transport.mock.calls.every(
              ([url]) => url === `${accessOrigin}/cdn-cgi/access/get-identity`,
            ),
          ).toBe(true);
        } finally {
          request.req.destroy();
        }
      });
    },
  );

  it("gives a new OIDC email its own default-role profile without interpreting its subject as GitHub", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const existing = syncGitHubIdentity({
        identity: { accountId: 101, login: "ada" },
        authenticationAlias: { kind: "email", email: "ada@example.test" },
      });
      setUserProfileRole(existing.id, "maintainer");
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        identityResponse({
          id: 101,
          email: "grace@example.test",
          idp: { type: "oidc" },
        }),
      );
      const request = accessRequest("grace@example.test");
      try {
        const result = await resolveAuthenticatedHttpUserProfile(request);
        const profileId = result.authenticatedUserProfile?.profileId;
        expect(profileId).toBeTypeOf("string");
        expect(profileId).not.toBe(existing.id);
        expect(result.operatorRolePolicy?.scopes).toEqual([]);
        expect(getUserProfileListItem(profileId!)).toMatchObject({
          emails: ["grace@example.test"],
          githubIdentity: null,
        });
      } finally {
        request.req.destroy();
      }
    });
  });

  it.each([
    { name: "mismatched principal", email: "other@example.test", idp: { type: "oidc" } },
    { name: "missing principal", idp: { type: "oidc" } },
    { name: "missing provider", email: "ada@example.test" },
    { name: "malformed provider", email: "ada@example.test", idp: { type: 1 } },
    { name: "unknown provider", email: "ada@example.test", idp: { type: "unknown" } },
    {
      name: "expired Access identity",
      email: "ada@example.test",
      idp: { type: "oidc" },
      status: 401,
    },
  ])(
    "rejects $name without changing an existing profile",
    async ({ name: _name, status, ...identity }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = ensureProfileForEmail("ada@example.test");
        setUserProfileRole(profile.id, "maintainer");
        const before = getUserProfileListItem(profile.id);
        const changed = vi.fn();
        const stop = onUserProfilesChanged(changed);
        const transport = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(identityResponse(identity, status));
        const request = accessRequest();
        try {
          await expect(resolveAuthenticatedHttpUserProfile(request)).rejects.toThrow();
          expect(getUserProfileListItem(profile.id)).toEqual(before);
          expect(changed).not.toHaveBeenCalled();
          expect(transport).toHaveBeenCalledOnce();
        } finally {
          stop();
          request.req.destroy();
        }
      });
    },
  );
});
