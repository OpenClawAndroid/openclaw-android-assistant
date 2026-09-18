// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readPreparedServerMethodModelCatalogs } from "../gateway/server-methods/optional-model-catalog.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "../gateway/server-methods/sessions-read-cache.test-support.js";
import * as projectionWork from "../gateway/session-projection-work.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../gateway/session-row-projection.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  recordRuntimeAuthMaterialization,
  revokeRuntimeAuthMaterializations,
} from "./auth-profiles/runtime-materializations.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { getPreparedModelRuntimeAuthMaterializations } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";

const mocks = getPreparedModelRuntimeMocks();
const rowCount = 256;
const model: ModelCatalogEntry = {
  provider: "custom",
  id: "synthetic-model",
  name: "Synthetic model",
  contextWindow: 32_000,
  reasoning: false,
  input: ["text"],
};
let state: OpenClawTestState;
let projection: SessionRowProjection | undefined;

// Worker replies are fresh objects, as across the real worker serialization boundary.
function catalog(entry: ModelCatalogEntry | undefined = model): ModelCatalogSnapshot {
  const entries = entry ? [structuredClone(entry)] : [];
  return {
    entries,
    routeVariants: structuredClone(entries),
    providerOutcomes: [{ provider: "custom", status: "ready" }],
  };
}

// Real catalog publication, persisted rows, projection, and the registered RPC share one owner.
async function setup(preparedMap = false) {
  const config: OpenClawConfig = {
    agents: {
      list: [{ id: "default", default: true }],
      defaults: { model: "custom/synthetic-model" },
    },
  };
  mocks.configuredAgentIds = ["default"];
  mocks.runPreparedModelCatalogWorker.mockImplementation(async () => catalog());
  const input = { config, agentId: "default", agentDir: state.agentDir("default") };
  let owner = await publishPreparedModelRuntimeSnapshot(input, { catalogMode: "static" });
  await owner.loadFullModelCatalog!({ refresh: true });
  for (let index = 0; index < rowCount; index++) {
    replaceSessionEntrySync(
      { agentId: "default", sessionKey: `agent:default:row-${index}` },
      {
        sessionId: `session-${index}`,
        updatedAt: index + 1,
        label: `Row ${index}`,
        modelProvider: "custom",
        model: "synthetic-model",
        visibility: "shared",
      },
    );
  }
  const context = requestContext(config);
  const readPrepared = vi.fn(async () => owner.readFullModelCatalog?.() ?? owner.modelCatalog);
  context.readPreparedGatewayModelCatalog = readPrepared;
  const readCatalog = vi.fn(async () =>
    preparedMap
      ? readPreparedServerMethodModelCatalogs(context, ["default"])
      : (owner.readFullModelCatalog?.() ?? owner.modelCatalog).entries,
  );
  projection = await createSessionRowProjection({
    cfg: config,
    getConfig: () => config,
    getModelCatalog: readCatalog,
  });
  const rows = projection;
  bindSessionRowProjection(context, () => rows);
  const client = identifiedClient("synthetic-viewer");
  const list = () =>
    listSessions({ context, client, request: { limit: rowCount, archived: "all" } });
  const initial = await list();
  expect(initial.sessions).toHaveLength(rowCount);
  expect(initial.sessions.every((row) => row.contextTokens === 32_000)).toBe(true);
  return {
    config,
    rows,
    readCatalog,
    readPrepared,
    list,
    initial,
    refresh: () => owner.loadFullModelCatalog!({ refresh: true }),
    replaceOwner: async () => {
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      owner = getPreparedModelRuntimeSnapshot(input)!;
    },
  };
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "catalog-publication-rows", scenario: "minimal" });
  await resetPreparedModelRuntimeHarness(state);
  // Temporal presentation is separate from materialized row facts.
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
});

afterEach(async ({ task }) => {
  projection?.dispose();
  projection = undefined;
  vi.restoreAllMocks();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

describe("catalog publication session rows", () => {
  it.each(["bound", "revoked"] as const)(
    "keeps session rows resident when runtime auth is %s",
    async (action) => {
      const { config, rows, list, initial, readCatalog } = await setup(true);
      const input = { config, agentId: "default", agentDir: state.agentDir("default") };
      const owner = getPreparedModelRuntimeSnapshot(input)!;
      const route = {
        agentDir: input.agentDir,
        provider: model.provider,
        modelId: model.id,
        modelApi: "openai-completions",
        modelBaseUrl: "https://synthetic.example.test/v1",
        requestTransportOverrides: "none" as const,
        authMode: "api-key",
        runtimeOwnerId: "synthetic",
      };
      if (action === "revoked") {
        expect(recordRuntimeAuthMaterialization(route)).toBe(true);
        await list();
      }
      const before = rows.materializedCount;
      const catalogReads = readCatalog.mock.calls.length;
      expect(
        action === "bound"
          ? recordRuntimeAuthMaterialization(route)
          : revokeRuntimeAuthMaterializations(route),
      ).toBe(true);
      expect(getPreparedModelRuntimeAuthMaterializations(owner)).toEqual(
        action === "bound"
          ? [expect.objectContaining({ provider: model.provider, modelId: model.id })]
          : [],
      );
      expect(rows.dirtyRowCount).toBe(0);
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount).toBe(before);
      expect(readCatalog).toHaveBeenCalledTimes(catalogReads);
    },
  );

  it("publishes settled attempt status without rebuilding unchanged resident rows", async () => {
    const { rows, list, refresh, initial, readCatalog } = await setup();
    const before = rows.materializedCount;
    const catalogReads = readCatalog.mock.calls.length;
    const started = createDeferred();
    const reply = createDeferred<ModelCatalogSnapshot>();
    const events = vi.fn<Parameters<typeof registerPreparedModelRuntimePublicationListener>[0]>();
    const unsubscribe = registerPreparedModelRuntimePublicationListener(events);
    mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async () => {
      started.resolve();
      return reply.promise;
    });
    const pending = refresh();
    try {
      await started.promise;
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount - before).toBe(0);
      expect(rows.dirtyRowCount).toBe(0);
      expect(readCatalog).toHaveBeenCalledTimes(catalogReads);
      reply.resolve(catalog());
      await pending;
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount - before).toBe(0);
      expect(rows.dirtyRowCount).toBe(0);
      expect(readCatalog).toHaveBeenCalledTimes(catalogReads);

      mocks.runPreparedModelCatalogWorker.mockRejectedValueOnce(new Error("synthetic failure"));
      await expect(refresh()).rejects.toThrow("synthetic failure");
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount - before).toBe(0);
      await refresh();
      expect((await list()).sessions).toEqual(initial.sessions);
      expect(rows.materializedCount - before).toBe(0);
      expect(rows.dirtyRowCount).toBe(0);
      expect(readCatalog).toHaveBeenCalledTimes(catalogReads);
      expect(events.mock.calls.map(([event]) => event)).toEqual([
        { phase: "catalog-published", modelFactsChanged: false },
        {
          phase: "catalog-failed",
          error: expect.objectContaining({ message: "synthetic failure" }),
          modelFactsChanged: false,
        },
        { phase: "catalog-published", modelFactsChanged: false, refreshStatusChanged: true },
      ]);
    } finally {
      reply.resolve(catalog());
      await pending;
      unsubscribe();
    }
  });

  it("refreshes changed model facts, removal, owner replacement, and config", async () => {
    const { rows, list, refresh, replaceOwner, config } = await setup();
    let previousCount = rows.materializedCount;
    const currentModel = { ...model };
    // Each independent metadata change must invalidate, including non-context capabilities.
    for (const patch of [
      { contextWindow: 64_000 },
      { reasoning: true },
      { input: ["text", "image"] },
    ] satisfies Partial<ModelCatalogEntry>[]) {
      Object.assign(currentModel, patch);
      mocks.runPreparedModelCatalogWorker.mockResolvedValue(catalog(currentModel));
      await refresh();
      const changed = await list();
      expect(changed.sessions).toHaveLength(rowCount);
      expect(changed.sessions.every((row) => row.contextTokens === 64_000)).toBe(true);
      expect(
        changed.sessions.every((row) =>
          currentModel.reasoning
            ? row.thinkingLevels!.some((level) => level.id === "high")
            : row.thinkingLevels!.every((level) => level.id === "off"),
        ),
      ).toBe(true);
      expect(rows.materializedCount - previousCount).toBe(rowCount);
      previousCount = rows.materializedCount;
    }

    // An empty successful inventory is a real removal, including its dynamic context limit.
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({ entries: [], routeVariants: [] });
    await refresh();
    expect((await list()).sessions.every((row) => row.contextTokens !== 64_000)).toBe(true);
    const removed = rows.materializedCount;
    await replaceOwner();
    await list();
    expect(rows.materializedCount - removed).toBeGreaterThanOrEqual(rowCount);
    const replaced = rows.materializedCount;
    config.models = {
      providers: {
        custom: {
          baseUrl: "https://synthetic.example.test/v1",
          models: [
            {
              id: model.id,
              name: model.name,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 1_000,
              contextWindow: 12_000,
              contextTokens: 12_000,
            },
          ],
        },
      },
    };
    sessionChanges.emit({ all: true, scope: "config" });
    expect((await list()).sessions.every((row) => row.contextTokens === 12_000)).toBe(true);
    expect(rows.materializedCount - replaced).toBe(rowCount);
  });

  it.each(["unchanged", "changed", "failed"] as const)(
    "converges when a %s publication arrives during a yielded drain",
    async (outcome) => {
      const { rows, list, refresh } = await setup();
      const before = rows.materializedCount;
      const yieldWork = projectionWork.yieldSessionListWork;
      let publishedDuringDrain = false;
      vi.spyOn(projectionWork, "yieldSessionListWork").mockImplementation(async () => {
        if (!publishedDuringDrain && rows.materializedCount > before && rows.dirtyRowCount > 0) {
          publishedDuringDrain = true;
          if (outcome === "changed") {
            mocks.runPreparedModelCatalogWorker.mockResolvedValue(
              catalog({ ...model, contextWindow: 64_000 }),
            );
          } else if (outcome === "failed") {
            mocks.runPreparedModelCatalogWorker.mockRejectedValueOnce(new Error("drain failure"));
          }
          if (outcome === "failed") {
            await expect(refresh()).rejects.toThrow("drain failure");
          } else {
            await refresh();
          }
        }
        await yieldWork();
      });
      sessionChanges.emit({ all: true, scope: "config" });
      const result = await list();
      expect(publishedDuringDrain).toBe(true);
      expect(result.sessions).toHaveLength(rowCount);
      expect(
        result.sessions.every(
          (row) => row.contextTokens === (outcome === "changed" ? 64_000 : 32_000),
        ),
      ).toBe(true);
      expect(rows.dirtyRowCount).toBe(0);
      if (outcome !== "changed") {
        expect(rows.materializedCount - before).toBe(rowCount);
      }
    },
  );

  it("recovers an incomplete optional catalog after an identical successful publication", async () => {
    const { rows, list, refresh, readPrepared } = await setup(true);
    const readPublished = readPrepared.getMockImplementation()!;
    readPrepared.mockRejectedValue(new Error("optional prepared reader unavailable"));
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(
      catalog({ ...model, contextWindow: 64_000 }),
    );
    await refresh();
    const fallback = await list();
    expect(fallback.sessions).toHaveLength(rowCount);
    expect(fallback.sessions.every((row) => row.contextTokens !== 64_000)).toBe(true);
    expect(rows.needsMaterialization).toBe(false);
    readPrepared.mockImplementation(readPublished);
    await refresh();
    expect((await list()).sessions.every((row) => row.contextTokens === 64_000)).toBe(true);
    expect(rows.needsMaterialization).toBe(false);
  });

  it("serves retained rows after a failed background catalog read and retries on the next list", async () => {
    const { rows, list, refresh, readCatalog } = await setup();
    const replacement = createDeferred<Awaited<ReturnType<typeof readCatalog>>>();
    readCatalog.mockReturnValueOnce(replacement.promise);
    mocks.runPreparedModelCatalogWorker.mockResolvedValue(
      catalog({ ...model, contextWindow: 64_000 }),
    );
    await refresh();
    try {
      expect((await list()).sessions.every((row) => row.contextTokens === 32_000)).toBe(true);
      replacement.reject(new Error("projection read failure"));
      await projectionWork.yieldSessionListWork();
      expect(rows.needsMaterialization).toBe(false);
      expect((await list()).sessions.every((row) => row.contextTokens === 64_000)).toBe(true);
      expect(rows.needsMaterialization).toBe(false);
    } finally {
      replacement.resolve([]);
    }
  });
});
