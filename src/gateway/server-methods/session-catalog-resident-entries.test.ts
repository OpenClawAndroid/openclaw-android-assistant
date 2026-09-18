import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { sessionCatalogHandlers } from "./session-catalog.js";

afterEach(() => vi.restoreAllMocks());

const key = "agent:main:adopted";
const original = {
  sessionId: "original-instance",
  updatedAt: 1,
  pluginOwnerId: "fixture",
  createdActor: { type: "system" as const, id: "original-owner" },
};

async function withCatalog(
  run: (fixture: {
    list: () => Promise<ReturnType<typeof vi.fn>>;
    setList: (list: SessionCatalogProvider["list"]) => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true, agentDir: state.agentDir("main") }] },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync({ agentId: "main", sessionKey: key }, original);
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const projection = await createSessionRowProjection({ cfg, getConfig: () => cfg, context });
    bindSessionRowProjection(context, () => projection);
    const previous = captureActivePluginRegistrySnapshot();
    const provider: SessionCatalogProvider = {
      id: "fixture",
      label: "Fixture",
      list: async ({ sessionEntries }) => {
        const adopted = sessionEntries
          ?.entriesForCatalog?.()
          .find((entry) => entry.sessionKey === key);
        return [
          {
            hostId: "gateway:fixture",
            label: "Fixture",
            kind: "gateway",
            connected: true,
            sessions: adopted
              ? [
                  {
                    threadId: "native-thread",
                    sessionKey: key,
                    status: "stored",
                    archived: false,
                    canContinue: true,
                    canArchive: false,
                  },
                ]
              : [],
          },
        ];
      },
      read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    };
    const registry = createEmptyPluginRegistry();
    registry.sessionCatalogs.push({ pluginId: "fixture", source: "fixture", provider });
    markPluginRegistryActive(registry);
    setActivePluginRegistry(registry);
    try {
      await run({
        setList: (list) => {
          provider.list = list;
        },
        list: async () => {
          const respond = vi.fn();
          await sessionCatalogHandlers["sessions.catalog.list"]!({
            params: { catalogId: "fixture", agentId: "main" },
            context,
            client: { connect: { role: "operator", scopes: ["operator.admin"] } },
            respond,
          } as never);
          return respond;
        },
      });
    } finally {
      projection.dispose();
      restoreActivePluginRegistrySnapshot(previous);
    }
  });
}

it("reads clean local catalog entries from the resident owner without SQLite", async () => {
  await withCatalog(async ({ list }) => {
    const first = await list();
    expect(first.mock.calls[0]?.[1]).toMatchObject({
      catalogs: [{ hosts: [{ sessions: [{ sessionKey: key }] }] }],
    });
    const reads = (["get", "all", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    );
    const second = await list();
    expect(second.mock.calls[0]?.[1]).toEqual(first.mock.calls[0]?.[1]);
    expect(
      reads.flatMap((read) =>
        read.mock.contexts.map((statement) =>
          statement instanceof StatementSync ? statement.sourceSQL : "unknown statement",
        ),
      ),
    ).toEqual([]);
  });
});

it("does not attach a replacement session identity after provider enumeration yields", async () => {
  await withCatalog(async ({ list, setList }) => {
    const started = createDeferredCore();
    const release = createDeferredCore();
    setList(async ({ sessionEntries }) => {
      expect(
        sessionEntries?.entriesForCatalog?.().find((entry) => entry.sessionKey === key)?.entry
          .sessionId,
      ).toBe(original.sessionId);
      started.resolve();
      await release.promise;
      return [
        {
          hostId: "gateway:fixture",
          label: "Fixture",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: "native-thread",
              sessionKey: key,
              status: "stored",
              archived: false,
              canContinue: true,
              canArchive: false,
            },
          ],
        },
      ];
    });
    const pending = list();
    await started.promise;
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        ...original,
        sessionId: "replacement-instance",
        updatedAt: 2,
        createdActor: { type: "system", id: "replacement-owner" },
      },
    );
    release.resolve();
    const respond = await pending;
    const session = respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions[0];
    expect(session).toMatchObject({ threadId: "native-thread" });
    expect(session).not.toHaveProperty("sessionKey");
    expect(session).not.toHaveProperty("createdActor");
  });
});
