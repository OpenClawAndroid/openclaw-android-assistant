// Stores durable delivery queue entries through their connection-bound owner.
import { resolveStateDir } from "../config/state-dir.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  loadDeliveryQueueEntryInDatabase,
  type DeliveryQueueReadMode,
  type UpsertDeliveryQueueEntryParams,
} from "./delivery-queue-sqlite-bound.js";
import {
  countFailedDeliveryQueueEntriesInDatabase,
  countPendingDeliveryQueueEntriesInDatabase,
  deleteDeliveryQueueEntryInDatabase,
  getDeliveryQueueEntryOwnersInDatabase,
  loadDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
  pruneExpiredDeliveryQueueTombstonesInDatabase,
  reserveDeliveryQueueEntryAttemptInDatabase,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryInDatabase,
  type DeliveryQueueStoredStatus,
  type ReserveDeliveryQueueAttemptResult,
  type TerminalizePendingDeliveryQueueEntryParams,
  type TerminalizePendingDeliveryQueueEntryResult,
} from "./delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";
import { isGatewayExternallySupervised } from "./gateway-supervision.js";

export type {
  DeliveryQueueCompletionRetention,
  DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.types.js";

export type DeliveryQueueStateContext = {
  stateDir: string;
  supervisorMode?: "external";
};

export function captureDeliveryQueueStateContext(stateDir?: string): DeliveryQueueStateContext {
  return {
    stateDir: resolveStateDir(resolveDeliveryQueueStateEnv(stateDir)),
    ...(isGatewayExternallySupervised(process.env) ? { supervisorMode: "external" as const } : {}),
  };
}

export function resolveDeliveryQueueStateEnv(
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): NodeJS.ProcessEnv {
  return context
    ? {
        ...process.env,
        OPENCLAW_STATE_DIR: context.stateDir,
        // Captured absence must not inherit a later ambient supervisor mode.
        OPENCLAW_SUPERVISOR_MODE: context.supervisorMode,
      }
    : stateDir
      ? { ...process.env, OPENCLAW_STATE_DIR: stateDir }
      : process.env;
}

function openStateDatabase(stateDir?: string, context?: DeliveryQueueStateContext) {
  return openOpenClawStateDatabase({
    env: resolveDeliveryQueueStateEnv(stateDir, context),
  });
}

/** Insert or replace a delivery queue entry under a queue namespace. */
export function upsertDeliveryQueueEntry(
  params: UpsertDeliveryQueueEntryParams,
  context?: DeliveryQueueStateContext,
): boolean {
  return upsertDeliveryQueueEntryInDatabase(params, openStateDatabase(params.stateDir, context));
}

/** Load a single pending delivery queue entry. */
export function loadDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
  context?: DeliveryQueueStateContext,
): DeliveryQueueEntryState | null {
  return loadDeliveryQueueEntryInDatabase(
    openStateDatabase(stateDir, context),
    queueName,
    id,
    mode,
  );
}

/** Read row status without hiding dead-lettered entries. */
export function getDeliveryQueueEntryStatus(
  queueName: string,
  id: string,
  stateDir?: string,
): DeliveryQueueStoredStatus | undefined {
  return getDeliveryQueueEntryOwners([queueName], id, stateDir).get(queueName)?.status;
}

/** Read one exact ID across physical namespaces from a single ownership snapshot. */
export function getDeliveryQueueEntryOwners(
  queueNames: readonly string[],
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Map<string, { status: DeliveryQueueStoredStatus; settlementPending?: true }> {
  if (queueNames.length === 0) {
    return new Map();
  }
  return getDeliveryQueueEntryOwnersInDatabase(
    openStateDatabase(stateDir, context),
    queueNames,
    id,
  );
}

/** Load all pending entries for a queue namespace in database order. */
export function loadDeliveryQueueEntries(
  queueName: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
  context?: DeliveryQueueStateContext,
): DeliveryQueueEntryState[] {
  return loadDeliveryQueueEntriesInDatabase(openStateDatabase(stateDir, context), queueName, mode);
}

/** Delete a pending delivery queue entry after successful delivery. */
export function deleteDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): void {
  deleteDeliveryQueueEntryInDatabase(openStateDatabase(stateDir, context), queueName, id);
}

/** Load, transform, and persist a pending delivery queue entry. */
export function updateDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir: string | undefined,
  update: (entry: DeliveryQueueEntryState) => DeliveryQueueEntryState,
  context?: DeliveryQueueStateContext,
): void {
  updateDeliveryQueueEntryInDatabase(openStateDatabase(stateDir, context), queueName, id, update);
}

/** Atomically reserve one provider-delivery call before executing it. */
export function reserveDeliveryQueueEntryAttempt(
  params: {
    queueName: string;
    id: string;
    maxAttempts: number;
    stateDir?: string;
    expectedPlatformSendAttemptId?: string;
  },
  context?: DeliveryQueueStateContext,
): ReserveDeliveryQueueAttemptResult {
  if (!Number.isInteger(params.maxAttempts) || params.maxAttempts <= 0) {
    throw new Error(`Invalid delivery attempt budget: ${params.maxAttempts}`);
  }
  return runOpenClawStateWriteTransaction(
    (database) => reserveDeliveryQueueEntryAttemptInDatabase(database, params),
    {
      env: resolveDeliveryQueueStateEnv(params.stateDir, context),
    },
    {
      operationLabel: `reserve ${params.queueName} delivery attempt`,
    },
  );
}

/** Count dead-lettered entries per queue namespace for coarse health reporting. */
export function countFailedDeliveryQueueEntries(stateDir?: string): Array<{
  queueName: string;
  count: number;
  oldestFailedAt?: number;
}> {
  return countFailedDeliveryQueueEntriesInDatabase(openStateDatabase(stateDir));
}

/** Count pending entries across an exact set of queue namespaces. */
export function countPendingDeliveryQueueEntries(
  queueNames: readonly string[],
  stateDir?: string,
): number {
  if (queueNames.length === 0) {
    return 0;
  }
  return countPendingDeliveryQueueEntriesInDatabase(openStateDatabase(stateDir), queueNames);
}

/** Physically expire age-bounded delivery queue tombstones. */
export function pruneExpiredDeliveryQueueTombstones(stateDir?: string): void {
  pruneExpiredDeliveryQueueTombstonesInDatabase(openStateDatabase(stateDir));
}

/** Atomically delete or tombstone a pending row only while its value is unchanged. */
export function terminalizePendingDeliveryQueueEntry(
  params: TerminalizePendingDeliveryQueueEntryParams & { stateDir?: string },
  context?: DeliveryQueueStateContext,
): TerminalizePendingDeliveryQueueEntryResult {
  const prepared = prepareDeliveryQueueTerminalEntry(params);
  return terminalizePendingDeliveryQueueEntryInDatabase(
    openStateDatabase(params.stateDir, context),
    prepared,
  );
}
