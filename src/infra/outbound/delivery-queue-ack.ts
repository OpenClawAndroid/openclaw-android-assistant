// Settles exact outbound custody before releasing its queue-owned media.
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite-bound.js";
import { transitionOwnedDeliveryQueueEntry } from "../delivery-queue-sqlite-claim.js";
import {
  completeDeliveryQueueEntryInDatabase,
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
  deleteDeliveryQueueEntryInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite.js";
import { hasLiveDeliveryQueueClaim } from "../delivery-queue-sqlite.types.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  cancelDeliveryQueueMediaRetention,
  createDeliveryQueueMediaRetention,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

type AckDeliveryOptions = {
  /** Caller holds a GC-visible recovery lease until its active adapter settles. */
  retainSpoolArtifacts?: boolean;
  /** An intentionally suppressed pre-send batch must not become a success receipt. */
  suppressCompletionReceipt?: boolean;
  /** Prevent an older provider attempt from settling a replacement owner. */
  expectedPlatformSendAttemptId?: string | null;
};

/** Retires an unsent live claim while its adapter preparation still owns resources. */
export function retireUnsentDelivery(
  params: {
    id: string;
    producerClaimId: string;
    stateDir?: string;
  },
  context?: DeliveryQueueStateContext,
): (() => Promise<void>) | undefined {
  const stateDir = context?.stateDir ?? params.stateDir;
  let release: (() => Promise<void>) | undefined;
  transitionOwnedDeliveryQueueEntry(
    {
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id: params.id,
      stateDir,
      platformSendAttemptId: params.producerClaimId,
    },
    (current, database) => {
      if (
        current.recoveryState !== "producer_claimed" ||
        current.platformSendAttemptId !== undefined ||
        current.platformSendStartedAt !== undefined ||
        !hasLiveDeliveryQueueClaim(current, params.producerClaimId, Date.now())
      ) {
        return;
      }
      // The claim and absence of send evidence are checked in the same transaction
      // that retires custody. A stale snapshot must not erase a dispatched attempt.
      // SAFETY: This namespace's pending rows contain the prepared outbound batch.
      const entry = current as QueuedDelivery;
      const artifacts = collectEntrySpoolPaths(
        acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => prepared.payload),
        stateDir,
      );
      const retention = artifacts.length
        ? createDeliveryQueueMediaRetention(
            artifacts,
            "outbound-media-recovery-lease",
            stateDir,
            database,
            context,
          )
        : undefined;
      // Cancellation removes custody without recording a successful receipt,
      // including for stable intents with completion retention.
      deleteDeliveryQueueEntryInDatabase(database, OUTBOUND_DELIVERY_QUEUE_NAME, entry.id);
      release = async () => {
        try {
          await releaseSpoolArtifacts(artifacts, stateDir);
        } finally {
          cancelDeliveryQueueMediaRetention(retention, stateDir, context);
        }
      };
    },
    context,
  );
  return release;
}

/** Remove a successfully delivered entry, or retain its producer-owned receipt. */
export async function ackDelivery(
  id: string,
  requestedStateDir?: string,
  options?: AckDeliveryOptions,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  const stateDir = context?.stateDir ?? requestedStateDir;
  // Read the media references before the row goes, then unlink only after the
  // delete commits. A crash in between leaves an orphan for the retention sweep;
  // unlinking first could strip media from a row that still has to replay.
  const database = openOpenClawStateDatabase({
    env: resolveDeliveryQueueStateEnv(stateDir, context),
  });
  let spoolPaths: string[] = [];
  const settle = (current: QueuedDelivery | null): void => {
    spoolPaths = current
      ? collectEntrySpoolPaths(
          acceptedPreparedOutboundEntries(current.preparedBatch).map(
            (prepared) => prepared.payload,
          ),
          stateDir,
        )
      : [];
    if (current?.completionRetention && options?.suppressCompletionReceipt !== true) {
      completeDeliveryQueueEntryInDatabase(database, OUTBOUND_DELIVERY_QUEUE_NAME, id);
    } else {
      deleteDeliveryQueueEntryInDatabase(database, OUTBOUND_DELIVERY_QUEUE_NAME, id);
    }
  };
  if (options && "expectedPlatformSendAttemptId" in options) {
    const settled = transitionOwnedDeliveryQueueEntry(
      {
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        stateDir,
        database,
        platformSendAttemptId: options.expectedPlatformSendAttemptId ?? null,
      },
      (entry) => {
        // SAFETY: Pending rows in this namespace retain the prepared outbound payload.
        settle(entry as QueuedDelivery);
      },
      context,
    );
    if (!settled) {
      throw new Error(`Delivery platform claim was lost: ${id}`);
    }
  } else {
    const current = loadDeliveryQueueEntryInDatabase(
      database,
      OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      "pending",
    );
    // SAFETY: Pending rows in this namespace retain the prepared outbound payload.
    settle(current as QueuedDelivery | null);
  }
  if (!options?.retainSpoolArtifacts) {
    await releaseSpoolArtifacts(spoolPaths, stateDir);
  }
}

type FailPendingDeliveryResult = { status: "failed" } | { status: "not_pending" };

/** Conditionally dead-letter a freshly re-read pending entry without a claimed state. */
export async function failPendingDelivery(
  params: {
    id: string;
    entry: QueuedDelivery;
    retainSpoolArtifacts?: boolean;
    expectedPlatformSendAttemptId?: string | null;
  },
  requestedStateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<FailPendingDeliveryResult> {
  const stateDir = context?.stateDir ?? requestedStateDir;
  const terminal = { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, id: params.id, entry: params.entry };
  // An unmatched claim must remain a no-op; standalone calls validate before opening state.
  const prepared =
    params.expectedPlatformSendAttemptId === undefined
      ? prepareDeliveryQueueTerminalEntry(terminal)
      : undefined;
  const database = openOpenClawStateDatabase({
    env: resolveDeliveryQueueStateEnv(stateDir, context),
  });
  let terminalized = false;
  const terminalize = (): undefined => {
    terminalized =
      terminalizePendingDeliveryQueueEntryInDatabase(
        database,
        prepared ?? prepareDeliveryQueueTerminalEntry(terminal),
      ).status === "terminalized";
  };
  if (params.expectedPlatformSendAttemptId !== undefined) {
    transitionOwnedDeliveryQueueEntry(
      {
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id: params.id,
        stateDir,
        database,
        platformSendAttemptId: params.expectedPlatformSendAttemptId,
      },
      terminalize,
      context,
    );
  } else {
    terminalize();
  }
  if (terminalized) {
    if (params.retainSpoolArtifacts !== true) {
      await releaseSpoolArtifacts(
        collectEntrySpoolPaths(
          acceptedPreparedOutboundEntries(params.entry.preparedBatch).map((entry) => entry.payload),
          stateDir,
        ),
        stateDir,
      );
    }
    return { status: "failed" };
  }
  return { status: "not_pending" };
}
