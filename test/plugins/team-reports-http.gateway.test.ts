import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTeamReportsHttpHandler,
  createTeamReportsStore,
  listWorkSessions,
} from "../../extensions/team-reports/api.js";
import { upsertSessionEntryCore } from "../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "../../src/gateway/auth.js";
import { CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS } from "../../src/gateway/control-ui-contract.js";
import { setControlUiPluginAuthCookie } from "../../src/gateway/control-ui-plugin-auth-cookie.js";
import {
  authorizePluginGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
} from "../../src/gateway/http-auth-utils.js";
import { createDirectChatContext } from "../../src/gateway/server-chat.agent-events.test-helpers.js";
import { createGatewayTestRegistry } from "../../src/gateway/server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "../../src/gateway/server/plugins-http.js";
import { resolveSharedGatewaySessionGeneration } from "../../src/gateway/server/ws-shared-generation.js";
import { bindSessionRowProjection } from "../../src/gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../src/gateway/session-row-projection.js";
import { withTempConfig } from "../../src/gateway/test-temp-config.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../../src/logging/subsystem.js";
import { sessionChanges } from "../../src/sessions/session-row-changes.js";
import { trackAsyncWork } from "../../src/shared/async-work-scope.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../src/state/user-profiles.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";

function get(server: Server, path: string, cookie?: string) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP fixture is not listening");
  }
  return new Promise<{ status: number; body: string; cookies: string[] }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: address.port, path, headers: cookie ? { cookie } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            cookies: res.headers["set-cookie"] ?? [],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withReports(
  roles: boolean,
  run: (fixture: {
    read: (path?: string) => ReturnType<typeof get>;
    blockDiscovery: () => { entered: Promise<void>; release: () => void };
    rotate: () => void;
    expire: () => void;
    blockViewer: () => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      ...(roles
        ? {
            gateway: {
              roles: {
                default: "blocked",
                definitions: {
                  reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
                  blocked: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
                },
              },
            },
          }
        : {}),
    };
    await state.writeConfig(cfg);
    await withTempConfig({
      cfg,
      run: async () => {
        const reader = ensureProfileForEmail("reports-reader@example.test");
        const owner = ensureProfileForEmail("reports-owner@example.test");
        setUserProfileRole(reader.id, "reader");
        for (const row of [
          { name: "own-draft", owner: reader.id, visibility: "draft" as const },
          { name: "foreign-draft", owner: owner.id, visibility: "draft" as const },
          { name: "shared", owner: owner.id, visibility: "shared" as const },
          {
            name: "dashboard:incognito-reports",
            owner: reader.id,
            visibility: "shared" as const,
            incognito: true,
          },
        ]) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: "agent:main:" + row.name },
            {
              sessionId: row.name,
              label: "REPORT-PROOF-" + row.name,
              updatedAt: Date.now(),
              visibility: row.visibility,
              ...(row.incognito ? { incognito: true } : {}),
              createdActor: { type: "human", source: "profile", id: row.owner },
            },
          );
        }
        const context = createDirectChatContext({
          getRuntimeConfig: () => cfg,
          trackExecution: trackAsyncWork,
        });
        let gate: ReturnType<typeof createDeferred<void>> | undefined;
        let entered: ReturnType<typeof createDeferred<void>> | undefined;
        const projection = await createSessionRowProjection({
          cfg,
          context,
          getModelCatalog: async () => {
            entered?.resolve();
            await gate?.promise;
            return undefined;
          },
        });
        bindSessionRowProjection(context, () => projection);
        const store = await createTeamReportsStore({
          workerModuleUrl: resolveRuntimeWorkerUrl({
            currentModuleUrl: import.meta.url,
            sourceWorkerName: "../../extensions/team-reports/src/store.worker",
            distWorkerPath: "extensions/team-reports/src/store.worker.js",
          }),
        });
        let auth: ResolvedGatewayAuth = {
          mode: "token",
          token: "reports-proof-initial",
          allowTailscale: false,
        };
        const issuedAt = Date.now();
        let discoveryStarted: ReturnType<typeof createDeferred<void>> | undefined;
        const handler = createGatewayPluginRequestHandler({
          registry: createGatewayTestRegistry({
            httpRoutes: [
              {
                pluginId: "team-reports",
                path: "/reports",
                match: "prefix",
                auth: "gateway",
                gatewayMethodDispatchAllowed: true,
                handler: createTeamReportsHttpHandler({
                  basePath: "/reports",
                  displayTimezone: "UTC",
                  assetsDir: "unused",
                  sessionRouting: () => ({ controlUiBasePath: "", mainKey: "main" }),
                  workSessions: async (offset, limit) => {
                    discoveryStarted?.resolve();
                    return await listWorkSessions(offset, limit);
                  },
                  getStore: () => store,
                  status: async () => ({}),
                  health: async () => ({ running: false, warnings: 0 }),
                  orgs: () => [],
                  people: () => [],
                }),
                source: "reports-proof",
              },
            ],
          }),
          getGatewayRequestContext: () => context,
          log: createSubsystemLogger("test/reports-http"),
        });
        const server = createServer((req, res) => {
          void (async () => {
            // The fixture issues synthetic identity cookies through the real signer.
            if (req.url === "/fixture-cookie") {
              setControlUiPluginAuthCookie(
                res,
                [
                  {
                    pluginId: "team-reports",
                    path: "/reports",
                    match: "prefix",
                    scopes: ["operator.read"],
                  },
                ],
                {
                  generation: resolveSharedGatewaySessionGeneration(auth),
                  profileId: reader.id,
                  nowMs: issuedAt,
                },
              );
              res.end();
              return;
            }
            const authorized = await authorizePluginGatewayHttpRequestOrReply({
              req,
              res,
              auth,
              getResolvedAuth: () => auth,
              requestPath: new URL(req.url ?? "/", "http://localhost").pathname,
              resolveOperatorScopes: resolveSharedSecretHttpOperatorScopes,
            });
            if (authorized) {
              await handler(req, res, undefined, {
                gatewayAuthSatisfied: true,
                gatewayRequestAuth: authorized.requestAuth,
                gatewayRequestOperatorScopes: authorized.operatorScopes,
              });
            }
          })().catch((error) => {
            res.destroy(error);
          });
        });
        try {
          await projection.ensureMaterialized();
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          const issued = await get(server, "/fixture-cookie");
          expect(issued.cookies).toHaveLength(1);
          const cookie = issued.cookies.map((value) => value.split(";", 1)[0]).join("; ");
          await run({
            read: (path = "/reports/sessions/") => get(server, path, cookie),
            blockDiscovery: () => {
              gate = createDeferred();
              entered = createDeferred();
              discoveryStarted = createDeferred();
              sessionChanges.emit({ all: true, scope: "catalog" });
              return {
                entered: Promise.all([entered.promise, discoveryStarted.promise]).then(() => {}),
                release: () => gate?.resolve(),
              };
            },
            rotate: () => {
              auth = { ...auth, token: "reports-proof-rotated" };
            },
            expire: () => {
              vi.spyOn(Date, "now").mockReturnValue(issuedAt + CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS);
            },
            blockViewer: () => {
              setUserProfileRole(reader.id, "blocked");
            },
          });
        } finally {
          gate?.resolve();
          server.closeAllConnections();
          if (server.listening) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
          await projection.ensureMaterialized();
          projection.dispose();
          await store.close();
        }
      },
    });
  });
}

describe("Reports HTTP disclosure with production cookie auth and sessions.list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each([false, true])(
    "renders only the signed viewer's visible sessions (roles=%s)",
    async (roles) => {
      await withReports(roles, async ({ read, blockViewer }) => {
        for (const path of ["/reports/", "/reports/sessions/"]) {
          const response = await read(path);
          expect(response.status).toBe(200);
          expect(response.body).toContain("REPORT-PROOF-own-draft");
          expect(response.body).toContain("REPORT-PROOF-shared");
          expect(response.body).not.toContain("REPORT-PROOF-foreign-draft");
          expect(response.body).not.toContain("REPORT-PROOF-dashboard:incognito-reports");
        }
        if (roles) {
          blockViewer();
          const response = await read();
          expect(response.status).toBe(200);
          expect(response.body).toContain("REPORT-PROOF-own-draft");
          expect(response.body).not.toContain("REPORT-PROOF-shared");
        }
      });
    },
  );
  it.each(["expiry", "generation"] as const)(
    "does not disclose after cookie %s during delayed discovery",
    async (invalidation) => {
      await withReports(false, async ({ read, blockDiscovery, expire, rotate }) => {
        const gate = blockDiscovery();
        const pending = read();
        try {
          await withTestTimeout(
            gate.entered,
            10_000,
            "sessions.list did not enter delayed discovery",
          );
          if (invalidation === "expiry") {
            expire();
          } else {
            rotate();
          }
          gate.release();
          const response = await pending;
          expect(response.body).not.toContain("REPORT-PROOF-");
          expect(response.status).toBe(401);
        } finally {
          gate.release();
          await pending;
        }
      });
    },
  );
});
