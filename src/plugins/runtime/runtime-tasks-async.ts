import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import {
  mapTaskFlowDetail,
  mapTaskRunAggregateSummary,
  mapTaskRunDetail,
  mapTaskRunView,
} from "../../tasks/task-domain-views.js";
import {
  buildFlowRecord,
  buildManagedTaskFlowPatch,
  type FlowRecordPatch,
  type ManagedTaskFlowMutation,
} from "../../tasks/task-flow-registry.records.js";
import {
  ensureTaskFlowRegistryReady,
  runTaskFlowRegistryWorkerMutation,
} from "../../tasks/task-flow-runtime-internal.js";
import { canOwnerAccessTask } from "../../tasks/task-owner-access.js";
import { ensureTaskRegistryReady } from "../../tasks/task-registry-state.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { asManagedTaskFlowRecord, mapFlowUpdateResult } from "./runtime-managed-flow-result.js";
import type {
  BoundAsyncManagedTaskFlowsRuntime,
  BoundAsyncTaskFlowsRuntime,
  BoundAsyncTaskRunsRuntime,
  PluginRuntimeAsyncTasks,
} from "./runtime-tasks.types.js";

type Binding = Parameters<PluginRuntimeAsyncTasks["runs"]["bindSession"]>[0];

function bind(params: Binding) {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error("Tasks runtime requires a bound sessionKey.");
  }
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  return { sessionKey, ...(requesterOrigin ? { requesterOrigin } : {}) };
}

async function readStore(includeTasks: boolean, includeFlows: boolean) {
  const context = captureOpenClawStateWorkerContext();
  // Registry restore retains its main-thread admission and failure semantics;
  // the subsequent query or mutation uses the shared worker.
  if (includeFlows) {
    context.admission.assertCurrent();
    ensureTaskFlowRegistryReady({ refreshProjection: false });
  }
  if (includeTasks) {
    context.admission.assertCurrent();
    ensureTaskRegistryReady();
  }
  const store = await import("../../state/openclaw-state-worker-store.js");
  context.admission.assertCurrent();
  return { store, context };
}

function bindRuns(params: Binding): BoundAsyncTaskRunsRuntime {
  const binding = bind(params);
  const identity = { callerOwnerKey: binding.sessionKey, callerAgentId: params.agentId };
  const visible = (task: TaskRecord | undefined) =>
    task && canOwnerAccessTask(task, identity) ? task : undefined;
  const list = async () => {
    const { store, context } = await readStore(true, false);
    const records = await store.executeOpenClawStateWorker(context, {
      type: "tasks.list",
      input: { ownerKey: binding.sessionKey },
    });
    return records.filter((task) => canOwnerAccessTask(task, identity));
  };
  return {
    ...binding,
    async get(taskId) {
      const { store, context } = await readStore(true, false);
      const task = visible(
        await store.executeOpenClawStateWorker(context, {
          type: "tasks.get",
          input: { taskId: taskId.trim() },
        }),
      );
      return task ? mapTaskRunDetail(task) : undefined;
    },
    list: async () => (await list()).map(mapTaskRunView),
    async findLatest() {
      const task = (await list())[0];
      return task ? mapTaskRunDetail(task) : undefined;
    },
    async resolve(token) {
      const { store, context } = await readStore(true, false);
      const records = await store.executeOpenClawStateWorker(context, {
        type: "tasks.resolve",
        input: { ownerKey: binding.sessionKey, token: token.trim() },
      });
      const task =
        visible(records.direct) ?? visible(records.byRun) ?? records.related.find(visible);
      return task ? mapTaskRunDetail(task) : undefined;
    },
  };
}

async function readFlowTaskSummary(ownerKey: string, flowId: string) {
  const { store, context } = await readStore(true, true);
  return store.executeOpenClawStateWorker(context, {
    type: "flows.summary",
    input: { ownerKey, flowId },
  });
}

function bindManagedFlows(params: Binding): BoundAsyncManagedTaskFlowsRuntime {
  const binding = bind(params);
  const prepareWrite = async () => {
    const { store, context } = await readStore(false, true);
    return <T>(
      flowId: string,
      mutate: (
        scope: Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">,
      ) => Promise<T>,
    ) =>
      store.runOpenClawStateWorkerOperation(context, (scope) =>
        runTaskFlowRegistryWorkerMutation(
          { admission: context.admission, flowId },
          () => mutate(scope),
          () => scope.execute({ type: "flows.current", input: { flowId } }),
        ),
      );
  };
  const tryCreateManaged: BoundAsyncManagedTaskFlowsRuntime["tryCreateManaged"] = async (input) => {
    const snapshot = structuredClone(input);
    const write = await prepareWrite();
    const flow = buildFlowRecord({
      ...snapshot,
      ownerKey: binding.sessionKey,
      requesterOrigin: binding.requesterOrigin,
      syncMode: "managed",
    });
    try {
      const created = await write(flow.flowId, (scope) =>
        scope.execute({ type: "flows.createManaged", input: { flow } }),
      );
      return asManagedTaskFlowRecord(created) ?? null;
    } catch (error) {
      // Retirement can aggregate an uncertain operation with a cleanup error.
      if (
        collectNestedErrorCandidates(error).some(
          (candidate) => extractErrorCode(candidate) === "outcome-unknown",
        )
      ) {
        throw error;
      }
      return null;
    }
  };
  const update = async (
    mutation: ManagedTaskFlowMutation,
    input: FlowRecordPatch & { flowId: string; expectedRevision: number },
  ) => {
    const snapshot = structuredClone(input);
    const write = await prepareWrite();
    const patch = buildManagedTaskFlowPatch(mutation, snapshot);
    const result = await write(snapshot.flowId, (scope) =>
      scope.execute({
        type: "flows.updateManaged",
        input: {
          flowId: snapshot.flowId,
          expectedRevision: snapshot.expectedRevision,
          ownerKey: binding.sessionKey,
          patch,
        },
      }),
    );
    return mapFlowUpdateResult(result);
  };

  const read = async (lookup: "id" | "latest" | "resolve", token?: string) => {
    const { store, context } = await readStore(false, true);
    return store.executeOpenClawStateWorker(context, {
      type: "flows.read",
      input: { ownerKey: binding.sessionKey, lookup, token },
    });
  };
  return {
    ...binding,
    tryCreateManaged,
    async createManaged(input) {
      const flow = await tryCreateManaged(input);
      if (!flow) {
        throw new Error("TaskFlow persistence failed.");
      }
      return flow;
    },
    setWaiting: (input) => update("setWaiting", input),
    resume: (input) => update("resume", input),
    finish: (input) => update("finish", input),
    fail: (input) => update("fail", input),
    requestCancel: (input) => update("requestCancel", input),
    get: (flowId) => read("id", flowId),
    async list() {
      const { store, context } = await readStore(false, true);
      return store.executeOpenClawStateWorker(context, {
        type: "flows.list",
        input: { ownerKey: binding.sessionKey },
      });
    },
    findLatest: () => read("latest"),
    resolve: (token) => read("resolve", token),
    getTaskSummary: (flowId) => readFlowTaskSummary(binding.sessionKey, flowId),
  };
}

function bindFlows(params: Binding): BoundAsyncTaskFlowsRuntime {
  const binding = bind(params);
  const read = async (lookup: "id" | "latest" | "resolve", token?: string) => {
    const { store, context } = await readStore(true, true);
    return store.runOpenClawStateWorkerOperation(context, async (scope) => {
      const result = await scope.execute({
        type: "flows.detail",
        input: { ownerKey: binding.sessionKey, lookup, token },
      });
      context.admission.assertCurrent();
      return result ? mapTaskFlowDetail(result) : undefined;
    });
  };
  return {
    ...binding,
    get: (flowId) => read("id", flowId),
    async list() {
      const { store, context } = await readStore(false, true);
      return store.executeOpenClawStateWorker(context, {
        type: "flows.views",
        input: { ownerKey: binding.sessionKey },
      });
    },
    findLatest: () => read("latest"),
    resolve: (token) => read("resolve", token),
    async getTaskSummary(flowId) {
      const summary = await readFlowTaskSummary(binding.sessionKey, flowId);
      return summary ? mapTaskRunAggregateSummary(summary) : undefined;
    },
  };
}

export function createRuntimeAsyncTasks(): PluginRuntimeAsyncTasks {
  return {
    runs: {
      bindSession: bindRuns,
      fromToolContext: (ctx) =>
        bindRuns({
          sessionKey: ctx.sessionKey ?? "",
          agentId: ctx.agentId,
          requesterOrigin: ctx.deliveryContext,
        }),
    },
    flows: {
      bindSession: bindFlows,
      fromToolContext: (ctx) =>
        bindFlows({ sessionKey: ctx.sessionKey ?? "", requesterOrigin: ctx.deliveryContext }),
    },
    managedFlows: {
      bindSession: bindManagedFlows,
      fromToolContext: (ctx) =>
        bindManagedFlows({
          sessionKey: ctx.sessionKey ?? "",
          requesterOrigin: ctx.deliveryContext,
        }),
    },
  };
}
