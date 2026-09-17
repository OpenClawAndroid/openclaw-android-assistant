import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  inspectAgentDatabaseAdmission,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  loadCombinedSessionStoreForGatewayAsync,
  loadCombinedSessionStoreForGatewayCore,
} from "./combined-store-gateway.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import * as inventory from "./session-accessor.sqlite-list-read.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";

afterEach(() => vi.restoreAllMocks());

function holdInventoryResults(count: number, failure?: { index: number; error: Error }) {
  const gates = Array.from({ length: count }, () => createDeferredCore());
  const ready = Array.from({ length: count }, () => createDeferredCore());
  const finished = Array.from({ length: count }, () => createDeferredCore());
  const started: SessionEntryListScope[] = [];
  const completed: number[] = [];
  const read = inventory.listSessionEntriesReadOnlyAsync;
  let active = 0;
  let peak = 0;
  vi.spyOn(inventory, "listSessionEntriesReadOnlyAsync").mockImplementation(async (scope = {}) => {
    const index = started.length;
    started.push(scope);
    peak = Math.max(peak, ++active);
    try {
      const entries = await read(scope);
      ready[index]!.resolve();
      await gates[index]!.promise;
      if (index === failure?.index) {
        throw failure.error;
      }
      return entries;
    } finally {
      active--;
      completed.push(index);
      finished[index]!.resolve();
    }
  });
  return {
    started,
    completed,
    ready,
    peak: () => peak,
    release: async (index: number) => {
      gates[index]!.resolve();
      await finished[index]!.promise;
      await setImmediate();
    },
    releaseAll: () => gates.forEach((gate) => gate.resolve()),
  };
}

function seedStores(): OpenClawConfig {
  const agentIds = ["main", "alpha", "bravo", "charlie", "delta", "echo"];
  for (const agentId of agentIds) {
    for (const sessionKey of ["global", `agent:${agentId}:main`]) {
      replaceSessionEntrySync(
        { agentId, sessionKey },
        {
          sessionId: `${agentId}-${sessionKey}`,
          updatedAt: 1,
          providerOverride: "ollama",
          modelOverride: `model-${agentId}`,
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        },
      );
    }
  }
  return { agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) } };
}

it("bounds inventory reads while preserving target order and hidden model sources", async () => {
  await withOpenClawTestState({ label: "combined-concurrent-order" }, async () => {
    const cfg = seedStores();
    const opts = { configuredAgentsOnly: true, projection: "list" as const };
    const expected = loadCombinedSessionStoreForGatewayCore(cfg, opts);
    expect(expected.durableTargets).toHaveLength(6);
    const held = holdInventoryResults(6);
    const operation = loadCombinedSessionStoreForGatewayAsync(cfg, opts);
    void operation.catch(() => {});
    try {
      await setImmediate();
      expect(held.started).toHaveLength(4);
      // A finished slot can admit the next store without waiting for target zero.
      await held.release(3);
      expect(held.started).toHaveLength(5);
      await held.release(4);
      expect(held.started).toHaveLength(6);
      for (const index of [5, 2, 1, 0]) {
        await held.release(index);
      }
      const combined = await operation;
      expect(held.peak()).toBe(4);
      expect(held.completed).toEqual([3, 4, 5, 2, 1, 0]);
      expect(combined.store).toEqual(expected.store);
      expect(Object.keys(combined.store)).toEqual(Object.keys(expected.store));
      expect(combined.durableTargets).toEqual(expected.durableTargets);
      expect([...combined.targetsBySessionKey.keys()]).toEqual([
        ...expected.targetsBySessionKey.keys(),
      ]);
      expect(combined.store.global?.sessionId).toBe(
        `${expected.durableTargets[0]!.agentId}-global`,
      );
      for (const { agentId } of expected.durableTargets) {
        const target = combined.targetsBySessionKey.get(`agent:${agentId}:main`)!;
        expect(target.storeTarget).toEqual(
          expected.targetsBySessionKey.get(`agent:${agentId}:main`)!.storeTarget,
        );
        expect(target.readSourceEntry("global")).toMatchObject({
          sessionId: `${agentId}-global`,
          modelOverride: `model-${agentId}`,
        });
        expect(target.readSourceEntry("agent:echo:main")).toMatchObject({
          sessionId: "echo-agent:echo:main",
          modelOverride: "model-echo",
        });
      }
    } finally {
      held.releaseAll();
      await Promise.allSettled([operation]);
    }
  });
});

it("joins started reads and keeps an earlier canonicalization error ahead of a later read failure", async () => {
  await withOpenClawTestState({ label: "combined-concurrent-errors" }, async () => {
    const cfg = { ...seedStores(), session: { scope: "global" as const } };
    const opts = { configuredAgentsOnly: true, projection: "list" as const };
    const canonicalError = "non-canonical persisted row resolves to session key global";
    expect(() => loadCombinedSessionStoreForGatewayCore(cfg, opts)).toThrow(canonicalError);
    const held = holdInventoryResults(6, { index: 3, error: new Error("later inventory failed") });
    let settled = false;
    const operation = loadCombinedSessionStoreForGatewayAsync(cfg, opts);
    const outcome = operation.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await setImmediate();
      expect(held.started).toHaveLength(4);
      await held.release(3);
      expect(held.started).toHaveLength(4);
      expect(settled).toBe(false);
      await held.release(0);
      expect(settled).toBe(false);
      expect(held.completed).toEqual([3, 0]);
      await held.release(2);
      expect(settled).toBe(false);
      await held.release(1);
      expect(await outcome).toMatchObject({ message: expect.stringContaining(canonicalError) });
      expect(held.started).toHaveLength(4);
      expect(held.completed).toEqual([3, 0, 2, 1]);
    } finally {
      held.releaseAll();
      await outcome;
    }
  });
});

it.each(["ops", "main"])(
  "rechecks %s admission after reading a shared store through a different logical owner",
  async (refusedAgentId) => {
    await withOpenClawTestState({ label: "combined-concurrent-admission" }, async (state) => {
      const storePath = state.statePath("ops.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      replaceSessionEntrySync(
        { agentId: "ops", storePath, sessionKey: "agent:ops:main" },
        { sessionId: "ops-session", updatedAt: 1 },
      );
      const cfg: OpenClawConfig = {
        agents: { entries: { ops: { default: true } } },
        session: { store: state.statePath("{agentId}.sqlite") },
      };
      const opts = { agentId: "ops", projection: "list" as const };
      const expected = loadCombinedSessionStoreForGatewayCore(cfg, opts);
      expect(expected.durableTargets).toEqual([{ agentId: "ops", storePath }]);
      expect(expected.targetsBySessionKey.get("agent:ops:main")?.storeTarget).toEqual({
        agentId: "main",
        storePath,
      });
      const held = holdInventoryResults(1);
      const operation = loadCombinedSessionStoreForGatewayAsync(cfg, opts);
      void operation.catch(() => {});
      try {
        await Promise.race([held.ready[0]!.promise, operation]);
        expect(held.started).toMatchObject([{ agentId: "main", storePath }]);
        const refusal = inspectAgentDatabaseAdmission({
          agentId: refusedAgentId,
          path: storePath,
          metadata: { role: "agent", agentId: "replacement-owner" },
        })!;
        recordAgentDatabaseAdmissions([refusal], { source: "startup", env: state.env });
        await held.release(0);
        await expect(operation).rejects.toMatchObject({
          name: "AgentDatabaseAdmissionError",
          refusal,
        });
      } finally {
        held.releaseAll();
        await Promise.allSettled([operation]);
        recordAgentDatabaseAdmissions([], { source: "startup", env: state.env });
      }
    });
  },
);
