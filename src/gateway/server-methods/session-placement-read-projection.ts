import { readBoardSessionKeys } from "../../boards/sqlite-board-store.kernel.js";
import type { GatewayStoredSessionTarget } from "../../config/sessions/combined-store-gateway.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { projectSessionActivitySummary } from "../session-activity-summary-state.js";
import { isSessionPermissionChangePending } from "../session-permission-change.js";
import {
  projectWorkerPlacementMove,
  projectWorkerSessionPlacement,
  readWorkerPlacementIdentity,
  type WorkerPlacementDiskSpaceReader,
  type WorkerPlacementRunnerAvailabilityReader,
} from "../worker-environments/placement-projector.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { isFailedWorkerPlacementEnvironmentGone } from "../worker-environments/session-placement-lifecycle.js";

type PlacementReadContext = {
  workerPlacementDiskSpaceReader?: WorkerPlacementDiskSpaceReader;
  workerPlacementRunnerAvailabilityReader?: WorkerPlacementRunnerAvailabilityReader;
  workerEnvironmentService?: Parameters<typeof readWorkerPlacementIdentity>[1];
};

/** Acquire cold facts only for this dirty physical row; presentation reads live memory. */
export function readSessionRowFacts(params: {
  cfg: OpenClawConfig;
  target: Pick<GatewayStoredSessionTarget, "agentId" | "storeTarget"> & { key: string };
  entry: SessionEntry;
  context?: PlacementReadContext;
  placementFactsReader?: Pick<WorkerSessionPlacementStore, "getProjectionFacts">;
  activitySummaryEnabled?: boolean;
}) {
  const { cfg, entry } = params;
  // The board callback shares a closure context with present; never capture a resident row.
  const { key, agentId, storeTarget } = params.target;
  const context = params.context ?? {};
  const {
    placement,
    move,
    workspaceResultReconciling = false,
  } = params.placementFactsReader?.getProjectionFacts(entry.sessionId) ?? {};
  const environment = placement?.environmentId
    ? context.workerEnvironmentService?.get(placement.environmentId)
    : undefined;
  const identity = placement
    ? readWorkerPlacementIdentity(placement, context.workerEnvironmentService)
    : undefined;
  const failedRecoveryAction =
    placement?.state === "failed"
      ? isFailedWorkerPlacementEnvironmentGone({
          environmentService: context.workerEnvironmentService,
          placement,
        })
        ? "restart"
        : "stop-first"
      : undefined;
  const activitySummary = projectSessionActivitySummary({
    key,
    agentId,
    storeTarget,
    cfg,
    entry,
    enabled: params.activitySummaryEnabled,
  });
  const board = withOpenClawAgentDatabaseReadOnly(
    (database) => readBoardSessionKeys(database, key).length > 0,
    { agentId: storeTarget.agentId, path: storeTarget.storePath },
  );
  return {
    hasBoard: board.found && board.value,
    present: () => ({
      ...(placement
        ? {
            placement: projectWorkerSessionPlacement(
              placement,
              context.workerPlacementDiskSpaceReader?.read(placement),
              context.workerPlacementRunnerAvailabilityReader?.read(placement, environment ?? null),
              identity,
              failedRecoveryAction,
              workspaceResultReconciling,
            ),
          }
        : {}),
      ...(move ? { placementMove: projectWorkerPlacementMove(move) } : {}),
      permissionModePending: isSessionPermissionChangePending(entry.sessionId),
      activitySummary: activitySummary ? { ...activitySummary } : undefined,
    }),
  };
}
