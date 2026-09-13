import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ensureNotifyPolicy } from "./task-registry-common.js";
import { compareTasksForRunIdLookup } from "./task-registry-records.js";
import type {
  JsonValue,
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
  TaskScopeKind,
} from "./task-registry.types.js";

export function selectExistingTaskForCreate(params: {
  runtime: TaskRuntime;
  ownerKey: string;
  scopeKind: TaskScopeKind;
  childSessionKey?: string;
  parentFlowId?: string;
  runId?: string;
  label?: string;
  task: string;
  candidates: readonly TaskRecord[];
  isTaskMirroredFlow: (flowId: string) => boolean;
}): TaskRecord | undefined {
  const runId = params.runId?.trim();
  const runScopeMatches = runId
    ? params.candidates.filter((task) => {
        if (
          task.runId?.trim() !== runId ||
          task.runtime !== params.runtime ||
          task.scopeKind !== params.scopeKind ||
          (normalizeOptionalString(task.ownerKey) ?? "") !==
            (normalizeOptionalString(params.ownerKey) ?? "") ||
          (normalizeOptionalString(task.childSessionKey) ?? "") !==
            (normalizeOptionalString(params.childSessionKey) ?? "")
        ) {
          return false;
        }
        if (params.runtime === "acp" && !params.parentFlowId?.trim()) {
          const existingFlowId = task.parentFlowId?.trim();
          return !existingFlowId || params.isTaskMirroredFlow(existingFlowId);
        }
        return (
          (normalizeOptionalString(task.parentFlowId) ?? "") ===
          (normalizeOptionalString(params.parentFlowId) ?? "")
        );
      })
    : [];
  const exact = runId
    ? runScopeMatches.find(
        (task) =>
          (normalizeOptionalString(task.label) ?? "") ===
            (normalizeOptionalString(params.label) ?? "") &&
          (normalizeOptionalString(task.task) ?? "") ===
            (normalizeOptionalString(params.task) ?? ""),
      )
    : undefined;
  if (exact) {
    return exact;
  }
  if (!runId || params.runtime !== "acp") {
    return undefined;
  }
  if (runScopeMatches.length === 0) {
    return undefined;
  }
  return runScopeMatches.toSorted(compareTasksForRunIdLookup)[0];
}

export type TaskCreateMergeParams = {
  taskKind?: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  sourceId?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  requesterAgentId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  deliveryStatus?: TaskDeliveryStatus;
  notifyPolicy?: TaskNotifyPolicy;
  detail?: JsonValue;
};

export function buildTaskCreateMergePatch(
  existing: TaskRecord,
  params: TaskCreateMergeParams,
): Partial<TaskRecord> {
  const patch: Partial<TaskRecord> = {};
  if (params.sourceId?.trim() && !existing.sourceId?.trim()) {
    patch.sourceId = params.sourceId.trim();
  }
  if (params.taskKind?.trim() && !existing.taskKind?.trim()) {
    patch.taskKind = params.taskKind.trim();
  }
  if (params.parentFlowId?.trim() && !existing.parentFlowId?.trim()) {
    patch.parentFlowId = params.parentFlowId.trim();
  }
  if (params.parentTaskId?.trim() && !existing.parentTaskId?.trim()) {
    patch.parentTaskId = params.parentTaskId.trim();
  }
  if (params.agentId?.trim() && !existing.agentId?.trim()) {
    patch.agentId = params.agentId.trim();
  }
  if (params.requesterAgentId?.trim() && !existing.requesterAgentId?.trim()) {
    patch.requesterAgentId = params.requesterAgentId.trim();
  }
  const nextLabel = params.label?.trim();
  if (params.preferMetadata) {
    if (nextLabel && (normalizeOptionalString(existing.label) ?? "") !== nextLabel) {
      patch.label = nextLabel;
    }
    const nextTask = params.task.trim();
    if (nextTask && (normalizeOptionalString(existing.task) ?? "") !== nextTask) {
      patch.task = nextTask;
    }
  } else if (nextLabel && !existing.label?.trim()) {
    patch.label = nextLabel;
  }
  if (params.deliveryStatus === "pending" && existing.deliveryStatus !== "delivered") {
    patch.deliveryStatus = "pending";
  }
  const notifyPolicy = ensureNotifyPolicy({
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: params.deliveryStatus,
    ownerKey: existing.ownerKey,
    scopeKind: existing.scopeKind,
  });
  if (notifyPolicy !== existing.notifyPolicy && existing.notifyPolicy === "silent") {
    patch.notifyPolicy = notifyPolicy;
  }
  if (params.detail !== undefined) {
    patch.detail = params.detail;
  }
  return patch;
}
