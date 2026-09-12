import type { TaskFlowRegistryUpdateResult } from "../../tasks/task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type { TaskFlowUpdateResult } from "../../tasks/task-flow-runtime-internal.js";
import type {
  ManagedTaskFlowMutationResult,
  ManagedTaskFlowRecord,
} from "./runtime-taskflow.types.js";

function isManagedFlow(flow: TaskFlowRecord | undefined): flow is ManagedTaskFlowRecord {
  return flow?.syncMode === "managed" && Boolean(flow.controllerId);
}

export function asManagedTaskFlowRecord(
  flow: TaskFlowRecord | undefined,
): ManagedTaskFlowRecord | undefined {
  return isManagedFlow(flow) ? flow : undefined;
}

export function mapFlowUpdateResult(
  result:
    | TaskFlowUpdateResult
    | TaskFlowRegistryUpdateResult
    | {
        applied: false;
        reason: "not_managed";
        current: TaskFlowRecord;
      },
): ManagedTaskFlowMutationResult {
  if (result.applied) {
    const managed = asManagedTaskFlowRecord(result.flow);
    return managed
      ? { applied: true, flow: managed }
      : { applied: false, code: "not_managed", current: result.flow };
  }
  if (result.reason === "invalid_patch") {
    throw result.error;
  }
  return {
    applied: false,
    code: result.reason,
    ...("current" in result && result.current ? { current: result.current } : {}),
  };
}
