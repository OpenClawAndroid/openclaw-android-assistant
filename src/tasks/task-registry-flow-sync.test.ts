import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { retainSqliteWorkerErrorCode, SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { serializeAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createInMemoryTaskRegistryStore,
  createInMemoryTaskFlowRegistryStore,
} from "../test-utils/task-registry-store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRegistryRestoreResult } from "./task-registry-restore.worker.js";
import {
  ensureTaskRegistryReadyAsync,
  reloadTaskRegistryFromStoreAsync,
} from "./task-registry-state.js";
import {
  configureTaskRegistryRuntime,
  type TaskRegistryStore,
  type TaskRegistryStoreSnapshot,
} from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskRegistryForTests,
  resetTaskFlowRegistryForTests,
} from "./task-runtime.test-helpers.js";

const ownerKey = "agent:main:restore";
const task: TaskRecord = {
  taskId: "restored-task",
  runtime: "cli",
  requesterSessionKey: ownerKey,
  ownerKey,
  scopeKind: "session",
  task: "Synthetic restore",
  status: "running",
  deliveryStatus: "not_applicable",
  notifyPolicy: "silent",
  createdAt: 10,
  runId: "restored-run",
};
const flow: TaskFlowRecord = {
  flowId: "restored-flow",
  syncMode: "managed",
  controllerId: "tests/restore",
  ownerKey,
  goal: "Synthetic flow",
  revision: 0,
  status: "running",
  notifyPolicy: "silent",
  createdAt: 10,
  updatedAt: 10,
};
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "registry-async-restore-",
  });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});
afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  vi.restoreAllMocks();
  await state.cleanup();
});

function taskRestoreResult(snapshot: TaskRegistryStoreSnapshot): TaskRegistryRestoreResult {
  return { snapshot, settledTasks: [], flowSyncs: [] };
}

describe("restored task flow synchronization", () => {
  it.each([
    "superseded store",
    "earlier receipt error",
    "closed maintenance scope",
    "flow read error",
    "retry flow read error",
    "retry overload real class",
    "retry overload retained classification",
    "overloaded superseded store",
    "retry overload exhaustion",
    "retired overload admission",
    "closed worker rejection",
    "unavailable worker rejection",
    "unknown worker outcome",
    "ordinary worker rejection",
    "worker cleanup aggregate",
  ] as const)("handles durable flow repair across %s", async (boundary) => {
    const maintenance =
      boundary === "closed maintenance scope"
        ? createOpenClawDatabaseMaintenanceScope(() => {
            throw new Error("Unexpected schema delegation in memory fixture");
          })
        : undefined;
    if (!maintenance) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
    const started = createDeferred();
    const release = createDeferred();
    const retried = createDeferred<{
      context: OpenClawStateWorkerContext;
      error: unknown;
    }>();
    const current = { ...flow, syncMode: "task_mirrored" as const };
    const createStore = () => {
      const flows = createInMemoryTaskFlowRegistryStore({
        flows: new Map([[flow.flowId, current]]),
      });
      const store = createInMemoryTaskRegistryStore(
        {
          tasks: new Map([
            [
              task.taskId,
              {
                ...task,
                parentFlowId: flow.flowId,
                status: "succeeded",
                endedAt: 20,
              },
            ],
          ]),
          deliveryStates: new Map(),
        },
        flows,
      );
      const result: TaskRegistryRestoreResult = {
        ...taskRestoreResult(store.loadSnapshot()),
        flowSyncs: [
          {
            taskId: task.taskId,
            flowId: flow.flowId,
            kind: "result",
            result: { ok: false, reason: "persist_failed", current },
          },
        ],
      };
      return { store, flows, result };
    };
    const first = createStore();
    const second = createStore();
    const supersededStore =
      boundary === "superseded store" || boundary === "overloaded superseded store";
    const overloaded = new SqliteWorkerError("Synthetic queue capacity", "overloaded");
    const failures: Partial<Record<typeof boundary, Error>> = {
      "retry overload real class": overloaded,
      "retry overload retained classification": retainSqliteWorkerErrorCode(
        new Error("Other module queue capacity"),
        overloaded,
      ),
      "overloaded superseded store": overloaded,
      "retry overload exhaustion": overloaded,
      "retired overload admission": overloaded,
      "closed worker rejection": new SqliteWorkerError("Worker closed", "closed"),
      "unavailable worker rejection": new SqliteWorkerError("Worker unavailable", "unavailable"),
      "unknown worker outcome": new SqliteWorkerError("Unknown outcome", "outcome-unknown"),
      "ordinary worker rejection": Object.assign(new Error("Ordinary worker rejection"), {
        name: "SqliteWorkerError",
        code: "overloaded",
      }),
      "worker cleanup aggregate": retainSqliteWorkerErrorCode(
        new AggregateError([overloaded, new Error("Cleanup failed")], "Worker cleanup failed"),
        overloaded,
      ),
    };
    const rejection = failures[boundary];
    const noRetry = [
      "retired overload admission",
      "closed worker rejection",
      "unavailable worker rejection",
      "unknown worker outcome",
      "ordinary worker rejection",
      "worker cleanup aggregate",
    ].includes(boundary);
    const exhausted = boundary === "retry overload exhaustion";
    let rejected = false;
    let retryCalls = 0;
    const erroredReceipt = boundary === "flow read error" || boundary === "retry flow read error";
    let retryErrorPending = boundary === "retry flow read error";
    if (erroredReceipt) {
      first.result.settledTasks = [...first.result.snapshot.tasks.values()];
      first.result.flowSyncs = [
        {
          taskId: task.taskId,
          flowId: flow.flowId,
          kind: "error",
          error: serializeAgentSchemaInspectionError(new Error("flow read unavailable")),
        },
      ];
    }
    if (boundary === "earlier receipt error") {
      first.result.flowSyncs.unshift({
        taskId: "earlier-task",
        kind: "error",
        error: serializeAgentSchemaInspectionError(new Error("earlier receipt unavailable")),
      });
    }
    configureTaskFlowRegistryRuntime({
      store:
        maintenance || erroredReceipt || (rejection && !supersededStore)
          ? first.flows
          : second.flows,
    });
    configureTaskRegistryRuntime({
      store: {
        ...first.store,
        async syncTaskFlowAsync(this: TaskRegistryStore, context, params) {
          let failure: unknown;
          try {
            retryCalls += 1;
            context.maintenanceScope?.assertAdmission();
            if (rejection && (!rejected || exhausted)) {
              rejected = true;
              if (boundary === "retired overload admission") {
                vi.spyOn(context.admission, "assertCurrent").mockImplementation(() => {
                  throw new Error("Retired retry admission");
                });
              }
              throw rejection;
            }
            if (retryErrorPending) {
              retryErrorPending = false;
              return {
                taskId: params.taskId,
                flowId: flow.flowId,
                kind: "error",
                error: serializeAgentSchemaInspectionError(
                  new Error("retry flow read unavailable"),
                ),
              };
            }
            return await first.store.syncTaskFlowAsync.call(this, context, params);
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            retried.resolve({ context, error: failure });
          }
        },
        async withSnapshotAsync(_context, consume) {
          started.resolve();
          await release.promise;
          return consume(first.result);
        },
      },
    });
    const restore = () => ensureTaskRegistryReadyAsync(captureOpenClawStateWorkerContext());
    const pending = maintenance ? maintenance.run(restore) : restore();
    await started.promise;
    if (supersededStore) {
      configureTaskRegistryRuntime({
        store: {
          ...second.store,
          withSnapshotAsync: async (_context, consume) => consume(second.result),
        },
      });
    }
    release.resolve();
    try {
      if (erroredReceipt) {
        await expect(pending).rejects.toThrow("flow read unavailable");
        await expect(restore()).rejects.toThrow("flow read unavailable");
        first.result.settledTasks = [];
        first.result.flowSyncs = [];
        await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        expect(first.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe(current.status);
      } else if (boundary === "earlier receipt error") {
        await expect(pending).rejects.toThrow("earlier receipt unavailable");
      } else {
        await pending;
      }
      if (maintenance) {
        await maintenance.close();
        expect(() => maintenance.assertAdmission()).toThrow("maintenance resource scope is closed");
        const retry = await retried.promise;
        expect(retry.error).toBeUndefined();
        expect(retry.context.maintenanceScope).toBeUndefined();
      } else {
        await vi.advanceTimersByTimeAsync(1_000);
        if (rejection) {
          expect(first.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe(current.status);
          await vi.advanceTimersByTimeAsync(750_000);
          if (noRetry || exhausted) {
            expect(retryCalls).toBe(exhausted ? 5 : 1);
            expect(first.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe(current.status);
            expect(getActiveGatewayRootWorkCount()).toBe(0);
            return;
          }
          expect(retryCalls).toBe(2);
        }
        if (boundary === "retry flow read error") {
          expect(first.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe(current.status);
          await vi.advanceTimersByTimeAsync(5_000);
        }
      }
      await vi.waitFor(() => {
        expect(first.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("succeeded");
        if (supersededStore) {
          expect(second.flows.loadSnapshot().flows.get(flow.flowId)?.status).toBe("succeeded");
        }
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
    } finally {
      await maintenance?.close();
      vi.useRealTimers();
    }
  });
});
