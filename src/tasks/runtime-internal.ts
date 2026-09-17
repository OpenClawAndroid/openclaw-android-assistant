// Internal task registry facade used by runtime modules without exposing public SDK surface.
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  ensureTaskFlowRegistryReady,
  reloadTaskFlowRegistryFromStore,
} from "./task-flow-runtime-internal.js";
import {
  ensureTaskRegistryReady as ensureTaskRegistryReadyInternal,
  reloadTaskRegistryFromStore as reloadTaskRegistryFromStoreInternal,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Read a task view without creating state or refreshing the synchronous projections. */
export async function findTaskViewByRunIdAsync(
  runId: string,
  assertCurrent: () => void,
): Promise<TaskRecord | undefined> {
  assertCurrent();
  const lookup = runId.trim();
  if (!lookup) {
    return undefined;
  }
  const context = captureOpenClawStateWorkerContext();
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  const task = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "tasks.findByRunId", input: { runId: lookup } }),
    { existingOnly: true, assertCurrent },
  );
  context.admission.assertCurrent();
  assertCurrent();
  return task;
}

export function ensureTaskRuntimeStateReady(): void {
  ensureTaskFlowRegistryReady();
  ensureTaskRegistryReadyInternal();
}

export function reloadTaskRuntimeStateFromStore(): void {
  reloadTaskFlowRegistryFromStore();
  reloadTaskRegistryFromStoreInternal();
}

export {
  assertTaskCancellationReadyById,
  cancelTaskById,
  createTaskRecord,
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  findTaskByRunId,
  finalizeTaskRecordByRunId,
  getTaskById,
  hasActiveTaskForChildSessionKey,
  listFreshTasksForOwnerKey,
  listTaskRecordPage,
  listTaskRecords,
  listTaskRecordsUnsorted,
  listTasksForFlowId,
  listTasksForOwnerKey,
  linkTaskToFlowById,
  markTaskLostById,
  markTaskRunningByRunId,
  markTaskTerminalById,
  maybeDeliverTaskTerminalUpdate,
  publishTaskRecordAfterAtomicStore,
  recordTaskProgressByRunId,
  resolveTaskForLookupToken,
  isParentFlowLinkError,
  setTaskCleanupAfterById,
  setTaskRunDeliveryStatusByRunId,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
export type { TaskRecord } from "./task-registry.types.js";
