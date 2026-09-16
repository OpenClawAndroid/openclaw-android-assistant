import fs from "node:fs";
import { performance } from "node:perf_hooks";
import * as timers from "node:timers/promises";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import * as registryQueries from "../../agents/subagents/registry/subagent-registry-queries.js";
import * as registryRead from "../../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunReadRecord } from "../../agents/subagents/registry/subagent-registry-read.types.js";
import {
  clearSubagentRunsReadCacheForTest,
  persistSubagentRunsToDisk,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import {
  bindSwarmRunReservation,
  removeQueuedSwarmRun,
  reserveSwarmRun,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  resolveSessionStorePathCore,
  SESSION_TOTAL_TOKENS_VERSION,
} from "../../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
}));

const targetKey = "agent:main:controller";
const targetScope = { agentId: "main", sessionKey: targetKey };

function retainedRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const now = Date.now();
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:off-page-requester",
    controllerSessionKey: targetKey,
    requesterAgentId: "main",
    requesterDisplayKey: "requester",
    task: "synthetic retained task",
    cleanup: "keep",
    createdAt: now - 100,
    execution: { status: "terminal", startedAt: now - 90, endedAt: now - 10 },
    completion: { required: false, resultText: "synthetic retained result" },
    delivery: { status: "not_required" },
    ...overrides,
  };
}

async function describeSession(
  context: GatewayRequestContext,
  client: GatewayClient,
  key = targetKey,
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionReadHandlers["sessions.describe"]!({
    req: { type: "req", id: "describe-worker", method: "sessions.describe", params: { key } },
    params: { key },
    context,
    client,
    isWebchatConnect: () => false,
    respond: (...response) => responses.push(response),
  });
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
  return responses[0]?.[1];
}

async function withFixture(
  run: (fixture: {
    cfg: OpenClawConfig;
    context: GatewayRequestContext;
    ownerId: string;
    viewer: GatewayClient;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { model: "openai/gpt-5.6-sol" } },
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const ownerId = ensureProfileForEmail("owner@example.com").id;
      const viewer = identifiedClient(ensureProfileForEmail("viewer@example.com").id);
      await upsertSessionEntryCore(targetScope, {
        sessionId: "original",
        updatedAt: Date.now(),
        label: "Original",
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: ownerId },
      });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:subagent:run-0" },
        {
          sessionId: "off-page-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:off-page-requester",
        },
      );
      const records = Array.from({ length: 64 }, (_, i) =>
        retainedRun(`run-${i}`, {
          controllerSessionKey: i === 0 ? targetKey : `agent:main:other-${i}`,
        }),
      );
      records.push(
        retainedRun("deleted-collector", {
          collect: true,
          groupId: "retained-group",
          swarmRequesterSessionKey: targetKey,
          collectorCompletion: { status: "done" },
        }),
      );
      saveSubagentRegistryToSqlite(new Map(records.map((entry) => [entry.runId, entry])));
      clearSubagentRunsReadCacheForTest();
      try {
        await run({ cfg, context: requestContext(cfg), ownerId, viewer });
      } finally {
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
}

function pauseRead(boundary: "worker" | "preparation" | "grouping") {
  const paused = createDeferredCore();
  const released = createDeferredCore();
  const restore: Array<() => void> = [];
  if (boundary === "worker") {
    // oxlint-disable-next-line typescript/unbound-method -- apply preserves the native Worker receiver.
    const postMessage = Worker.prototype.postMessage;
    const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      const message: unknown = args[0];
      if (isRecord(message) && message.type === "execute" && message.input instanceof Uint8Array) {
        const command: unknown = deserialize(message.input);
        if (isRecord(command) && command.type === "subagents.sessionList") {
          paused.resolve();
          void released.promise.then(() => postMessage.apply(this, args));
          return;
        }
      }
      return postMessage.apply(this, args);
    });
    restore.push(() => spy.mockRestore());
  } else {
    let budgetDue = false;
    let held = false;
    let offset = 0;
    const now = performance.now.bind(performance);
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + offset);
    const prepare = registryRead.prepareSubagentSessionListReadIndex;
    const prepared = vi
      .spyOn(registryRead, "prepareSubagentSessionListReadIndex")
      .mockImplementation(async (...args) => {
        if (boundary === "preparation") {
          budgetDue = true;
          offset += 20;
        }
        const work = await prepare(...args);
        return (function* () {
          budgetDue = true;
          offset += 20;
          return yield* work;
        })();
      });
    const immediate = timers.setImmediate;
    const yielded = vi.spyOn(timers, "setImmediate").mockImplementation(async (...args) => {
      if (budgetDue && !held) {
        held = true;
        paused.resolve();
        await released.promise;
      }
      return immediate(...args);
    });
    restore.push(
      () => clock.mockRestore(),
      () => prepared.mockRestore(),
      () => yielded.mockRestore(),
    );
  }
  return {
    paused: paused.promise,
    release: () => released.resolve(),
    restore: () => restore.forEach((reset) => reset()),
  };
}

async function whilePaused(
  boundary: "worker" | "preparation" | "grouping",
  start: () => Promise<unknown>,
  change: () => Promise<void> | void,
) {
  const pause = pauseRead(boundary);
  const request = start();
  try {
    expect(
      await Promise.race([pause.paused.then(() => "paused"), request.then(() => "responded")]),
    ).toBe("paused");
    await change();
    pause.release();
    return await request;
  } finally {
    pause.release();
    await request.catch(() => {});
    pause.restore();
  }
}

it("rechecks the shared budget before each coalesced caller captures registry facts", async () => {
  await withFixture(async ({ context, viewer }) => {
    await describeSession(context, viewer);
    let chargedMs = 0;
    let slice = 0;
    const captureSlices: number[] = [];
    const now = performance.now.bind(performance);
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + chargedMs);
    const immediate = timers.setImmediate;
    const yielded = vi.spyOn(timers, "setImmediate").mockImplementation(async (...args) => {
      const result = await immediate(...args);
      slice++;
      return result;
    });
    const build = registryQueries.buildSubagentRunReadIndexWork;
    const captures = vi
      .spyOn(registryQueries, "buildSubagentRunReadIndexWork")
      .mockImplementation(
        <T extends SubagentRunReadRecord>(...args: Parameters<typeof build<T>>) => {
          const work = build(...args);
          captureSlices.push(slice);
          chargedMs += 20;
          return work;
        },
      );
    const requests = Array.from({ length: 8 }, (_, index) =>
      index % 2 === 0
        ? describeSession(context, viewer)
        : listSessions({ client: viewer, context, request: { limit: index + 1 } }),
    );
    try {
      await Promise.all(requests);
      expect(captureSlices).toHaveLength(8);
      expect(new Set(captureSlices).size).toBe(captureSlices.length);
    } finally {
      await Promise.allSettled(requests);
      captures.mockRestore();
      yielded.mockRestore();
      clock.mockRestore();
    }
  });
});

it.each(["describe", "list"] as const)(
  "captures current registry facts after yielding before %s preparation",
  async (method) => {
    await withFixture(async ({ context, viewer }) => {
      await describeSession(context, viewer);
      const current = retainedRun("current-memory", {
        childSessionKey: targetKey,
        controllerSessionKey: "agent:main:current-controller",
      });
      try {
        const response = await whilePaused(
          "preparation",
          () =>
            method === "describe"
              ? describeSession(context, viewer)
              : listSessions({ client: viewer, context, request: { limit: 100 } }).then(
                  (result) => ({
                    session: result.sessions.find((row) => row.key === targetKey),
                  }),
                ),
          () => {
            const published = retainedRun("current-persisted", {
              collect: true,
              groupId: "current-group",
              swarmRequesterSessionKey: targetKey,
              collectorCompletion: { status: "done" },
            });
            persistSubagentRunsToDisk(new Map([[published.runId, published]]));
            subagentRuns.set(current.runId, current);
          },
        );
        expect(response).toMatchObject({
          session: {
            controlOwnerSessionKey: "agent:main:current-controller",
            swarm: { groups: [{ groupId: "current-group", done: 1 }] },
          },
        });
        expect(JSON.stringify(response)).not.toContain("retained-group");
      } finally {
        subagentRuns.delete(current.runId);
      }
    });
  },
);

it.each(["worker", "grouping"] as const)(
  "projects current target, lineage, children and placement after the %s wait",
  async (boundary) => {
    await withFixture(async ({ context, viewer }) => {
      const childKey = "agent:main:direct-child";
      const removedKey = "agent:main:removed-child";
      for (const key of [childKey, removedKey]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          {
            sessionId: key,
            updatedAt: Date.now(),
            parentSessionKey: targetKey,
          },
        );
      }
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:current-parent" },
        {
          sessionId: "current-parent",
          updatedAt: Date.now(),
          providerOverride: "openai",
          modelOverride: "gpt-5.5",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        },
      );
      const placements = createWorkerSessionPlacementStore();
      context.workerSessionPlacementService = placements;
      const response = await whilePaused(
        boundary,
        () => describeSession(context, viewer),
        async () => {
          await upsertSessionEntryCore(targetScope, {
            sessionId: "replacement",
            label: "Current conversation",
            parentSessionKey: "agent:main:current-parent",
          });
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: childKey },
            {
              parentSessionKey: "agent:main:other",
              spawnedBy: "agent:main:other",
            },
          );
          await deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            target: { canonicalKey: removedKey, storeKeys: [removedKey] },
            archiveTranscript: false,
          });
          placements.startDispatch({
            sessionId: "replacement",
            agentId: "main",
            sessionKey: targetKey,
          });
        },
      );
      expect(response).toMatchObject({
        session: {
          sessionId: "replacement",
          label: "Current conversation",
          modelProvider: "openai",
          model: "gpt-5.5",
          modelOverrideSource: "inherited",
          placement: { state: "requested" },
          childSessions: ["agent:main:subagent:run-0"],
          swarm: {
            groups: [
              {
                groupId: "retained-group",
                done: 1,
                children: [{ sessionKey: "agent:main:subagent:deleted-collector", status: "done" }],
              },
            ],
          },
        },
      });
      expect(JSON.stringify(response)).not.toContain("synthetic retained");
    });
  },
);

it.each([
  ["worker", ["role", "creator alias"]],
  ["grouping", ["draft", "role", "creator alias"]],
] as const)("rechecks sharing visibility after the %s wait", async (boundary, changes) => {
  for (const change of changes) {
    await withFixture(async ({ cfg, context, viewer }) => {
      const response = await whilePaused(
        boundary,
        () => describeSession(context, viewer),
        async () => {
          if (change === "role") {
            const next: OpenClawConfig = {
              ...cfg,
              gateway: {
                roles: {
                  default: "reader",
                  definitions: {
                    reader: {
                      agents: "*",
                      scopes: ["operator.read"],
                      sessions: { others: "none" },
                    },
                  },
                },
              },
            };
            setRuntimeConfigSnapshot(next);
            context.getRuntimeConfig = () => next;
          } else {
            if (change === "creator alias") {
              linkEmail("owner@example.com", viewer.authenticatedUserProfile!.profileId);
            }
            await upsertSessionEntryCore(targetScope, { visibility: "draft" });
          }
        },
      );
      expect(response).toMatchObject(
        change === "creator alias"
          ? { session: { sessionId: "original", sharingRole: "owner" } }
          : { session: null },
      );
    });
  }
});

it.each(["worker", "grouping"] as const)(
  "resolves the current agent store and main alias after the %s wait",
  async (boundary) => {
    for (const route of ["agent", "main alias"] as const) {
      await withFixture(async ({ cfg, context, viewer }) => {
        const initial: OpenClawConfig = {
          ...cfg,
          agents: {
            ownership: "explicit",
            entries: { main: {}, work: {} },
            defaults: { model: "openai/gpt-5.6-sol", systemAgent: { agentId: "main" } },
          },
        };
        const next: OpenClawConfig =
          route === "agent"
            ? {
                ...initial,
                agents: {
                  ...initial.agents,
                  defaults: { ...initial.agents?.defaults, systemAgent: { agentId: "work" } },
                },
              }
            : { ...initial, session: { scope: "global" } };
        for (const [agentId, key] of [
          ["main", "global"],
          ["work", "global"],
          ["main", "agent:main:main"],
        ] as const) {
          await upsertSessionEntryCore(
            { agentId, sessionKey: key },
            {
              sessionId: `${agentId}-${key}`,
              updatedAt: Date.now(),
              visibility: "shared",
            },
          );
        }
        const pluginRegistry = createEmptyPluginRegistry();
        pluginRegistry.providers.push({
          pluginId: "catalog-fixture",
          source: "test",
          provider: {
            id: "openai",
            label: "Catalog fixture",
            auth: [],
            resolveThinkingProfile: () => ({ levels: [] }),
          },
        });
        const catalog = {
          entries: [{ id: "gpt-5.6-sol", provider: "openai", name: "Fixture", reasoning: true }],
          pluginRegistry,
        };
        const catalogs = vi.fn(async () => catalog);
        context.readPreparedGatewayModelCatalog = catalogs;
        context.getRuntimeConfig = () => initial;
        setRuntimeConfigSnapshot(initial);
        const key = route === "agent" ? "global" : "agent:main:main";
        expect(await describeSession(context, viewer, key)).toMatchObject({
          session: { agentId: "main", thinkingLevels: [] },
        });
        clearSubagentRunsReadCacheForTest();
        catalogs.mockClear();
        const response = await whilePaused(
          boundary,
          () => describeSession(context, viewer, key),
          async () => {
            if (route === "main alias") {
              await deleteSessionEntryLifecycle({
                agentId: "main",
                storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
                target: { canonicalKey: "agent:main:main", storeKeys: ["agent:main:main"] },
                archiveTranscript: false,
              });
            }
            context.getRuntimeConfig = () => next;
            setRuntimeConfigSnapshot(next);
          },
        );
        expect(catalogs).toHaveBeenCalledExactlyOnceWith({ agentId: "main" });
        expect(response).toMatchObject({
          session: {
            key: "global",
            agentId: route === "agent" ? "work" : "main",
            sessionId: route === "agent" ? "work-global" : "main-global",
            thinkingLevels:
              route === "agent" ? expect.arrayContaining([{ id: "low", label: "low" }]) : [],
          },
        });
      });
    }
  },
);

it.each(["worker", "grouping"] as const)(
  "projects elapsed runtime, status expiry and budget time after the %s wait",
  async (boundary) => {
    await withFixture(async ({ context, viewer }) => {
      const startedAt = Date.now() - 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 1000);
      const running = retainedRun("clock-running", {
        childSessionKey: targetKey,
        controllerSessionKey: "agent:main:parent",
        requesterSessionKey: "agent:main:parent",
        createdAt: startedAt,
        execution: { status: "running", startedAt },
      });
      let claim: string | undefined;
      try {
        await upsertSessionEntryCore(targetScope, {
          agentStatus: { note: "Working", expiresAt: startedAt + 2000 },
          totalTokens: 100,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
          goal: {
            schemaVersion: 1,
            id: "clock-goal",
            objective: "Synthetic clock proof",
            status: "active",
            createdAt: startedAt,
            updatedAt: startedAt,
            tokenStart: 0,
            tokensUsed: 0,
            tokenBudget: 50,
            continuationTurns: 0,
          },
        });
        subagentRuns.set(running.runId, running);
        claim = claimAgentRunContext(
          running.runId,
          { sessionKey: targetKey },
          { trackOwner: true, ownsContext: true },
        );
        expect(registryRead.isSubagentRunLive(running)).toBe(true);
        expect(await describeSession(context, viewer)).toMatchObject({
          session: {
            status: "running",
            runtimeMs: 1000,
            agentStatus: { note: "Working" },
          },
        });
        clearSubagentRunsReadCacheForTest();
        const response = await whilePaused(
          boundary,
          () => describeSession(context, viewer),
          () => {
            clock.mockReturnValue(startedAt + 6000);
          },
        );
        expect(response).toMatchObject({
          session: {
            status: "running",
            runtimeMs: 6000,
            agentStatus: undefined,
            goal: {
              status: "budget_limited",
              budgetLimitedAt: startedAt + 6000,
              updatedAt: startedAt + 6000,
            },
          },
        });
        expect(loadSessionEntry(targetScope)?.goal?.status).toBe("active");
      } finally {
        releaseAgentRunContext(running.runId, claim);
        subagentRuns.delete(running.runId);
        clock.mockRestore();
      }
    });
  },
);

it.each(["worker", "grouping"] as const)(
  "refreshes retained control ownership after the %s wait",
  async (boundary) => {
    await withFixture(async ({ context, viewer }) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const older = retainedRun("expiring-owner", {
        childSessionKey: targetKey,
        controllerSessionKey: "agent:main:older-controller",
        requesterSessionKey: "agent:main:older-controller",
        createdAt: now - 2 * 60 * 60 * 1000,
        execution: { status: "running", startedAt: now - 2 * 60 * 60 * 1000 },
      });
      const newer = retainedRun("newer-ended-owner", {
        childSessionKey: targetKey,
        controllerSessionKey: "agent:main:newer-controller",
        requesterSessionKey: "agent:main:newer-controller",
        createdAt: now - 1000,
        execution: { status: "terminal", startedAt: now - 1000, endedAt: now - 10 },
      });
      try {
        saveSubagentRegistryToSqlite(new Map([older, newer].map((run) => [run.runId, run])));
        clearSubagentRunsReadCacheForTest();
        expect(await describeSession(context, viewer)).toMatchObject({
          session: { controlOwnerSessionKey: older.controllerSessionKey },
        });
        clearSubagentRunsReadCacheForTest();
        const response = await whilePaused(
          boundary,
          () => describeSession(context, viewer),
          () => {
            clock.mockReturnValue(now + 1);
          },
        );
        expect(response).toMatchObject({
          session: { controlOwnerSessionKey: newer.controllerSessionKey },
        });
      } finally {
        clock.mockRestore();
      }
    });
  },
);

it.each(["executor", "reservation"] as const)(
  "rechecks the sole %s owner after grouping yields",
  async (owner) => {
    await withFixture(async ({ context, viewer }) => {
      const old = Date.now() - 3 * 60 * 60 * 1000;
      const run = retainedRun(`owned-${owner}`, {
        requesterSessionKey: targetKey,
        createdAt: old,
        execution:
          owner === "executor" ? { status: "running", startedAt: old } : { status: "queued" },
        collect: owner === "reservation",
        groupId: "owned-queue",
        swarmRequesterSessionKey: targetKey,
      });
      subagentRuns.set(run.runId, run);
      let claim: string | undefined;
      if (owner === "executor") {
        claim = claimAgentRunContext(
          run.runId,
          { sessionKey: run.childSessionKey },
          { trackOwner: true, ownsContext: true },
        );
      } else {
        expect(
          reserveSwarmRun({
            groupId: "owned-queue",
            runId: run.runId,
            maxConcurrent: 1,
            activeRunIds: [],
          }),
        ).toBe(true);
        bindSwarmRunReservation(run.runId, run);
      }
      try {
        expect(registryRead.isSubagentRunLive(run)).toBe(owner === "executor");
        expect(registryRead.isSubagentRunQueued(run)).toBe(owner === "reservation");
        expect(await describeSession(context, viewer)).toMatchObject({
          session: { hasActiveSubagentRun: true },
        });
        const response = await whilePaused(
          "grouping",
          () => describeSession(context, viewer),
          () => {
            if (owner === "executor") {
              releaseAgentRunContext(run.runId, claim);
            } else {
              expect(removeQueuedSwarmRun(run.runId)).toBe(true);
            }
          },
        );
        expect(response).toMatchObject({ session: { hasActiveSubagentRun: undefined } });
      } finally {
        releaseAgentRunContext(run.runId, claim);
        removeQueuedSwarmRun(run.runId);
        subagentRuns.delete(run.runId);
      }
    });
  },
);

it.each(["preparation", "grouping"] as const)(
  "refuses a database generation retired while %s is paused",
  async (boundary) => {
    await withFixture(async ({ context, viewer }) => {
      await expect(
        whilePaused(
          boundary,
          () => describeSession(context, viewer),
          async () => {
            await closeOpenClawStateDatabaseAsync();
          },
        ),
      ).rejects.toThrow(/retired|changed|invalidated|closed/i);
    });
  },
);

it.each(["preparation", "grouping"] as const)(
  "refuses a maintenance scope closed while %s is paused",
  async (boundary) => {
    await withFixture(async ({ context, viewer }) => {
      const scope = createOpenClawDatabaseMaintenanceScope();
      try {
        await expect(
          whilePaused(
            boundary,
            () =>
              scope.run(() => ({
                request: describeSession(context, viewer),
              })).request,
            () => scope.close(),
          ),
        ).rejects.toThrow(/maintenance resource scope is closed/i);
      } finally {
        await scope.close();
      }
    });
  },
);

it("skips the native full index for missing or hidden targets without provisioning storage", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const context = requestContext(cfg);
    const state = captureOpenClawStateWorkerContext();
    const read = vi.spyOn(registryRead, "prepareSubagentSessionListReadIndex");
    try {
      expect(await describeSession(context, identifiedClient("viewer@example.com"))).toEqual({
        session: null,
      });
      expect(read).not.toHaveBeenCalled();
      expect(fs.existsSync(state.admission.databasePath)).toBe(false);
    } finally {
      read.mockRestore();
    }
  });
  await withFixture(async ({ context, viewer }) => {
    await upsertSessionEntryCore(targetScope, { visibility: "draft" });
    const read = vi.spyOn(registryRead, "prepareSubagentSessionListReadIndex");
    try {
      expect(await describeSession(context, viewer)).toEqual({ session: null });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});
