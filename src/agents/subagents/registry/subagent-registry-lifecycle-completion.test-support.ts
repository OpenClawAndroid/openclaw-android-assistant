import type { Mock } from "vitest";
import type { setDetachedTaskDeliveryStatusByRunId } from "../../../tasks/detached-task-runtime.js";
import type {
  blockSubagentCompletionDelivery,
  settleRequesterCompletionBatch,
} from "../completion/subagent-completion-admission.store.js";
import { clearSubagentPendingDelivery } from "./subagent-registry-lifecycle-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function mockBlockedCompletionDeliveryOwner(
  completionDeliveryMocks: {
    blockSubagentCompletionDelivery: Mock<typeof blockSubagentCompletionDelivery>;
    settleRequesterCompletionBatch: Mock<typeof settleRequesterCompletionBatch>;
    runsByEntry: WeakMap<SubagentRunRecord, Map<string, SubagentRunRecord>>;
  },
  taskExecutorMocks: {
    setDetachedTaskDeliveryStatusByRunId: Mock<typeof setDetachedTaskDeliveryStatusByRunId>;
  },
): void {
  completionDeliveryMocks.settleRequesterCompletionBatch.mockImplementation(
    ({
      entries,
      outcome,
    }: Parameters<
      typeof import("../completion/subagent-completion-admission.store.js").settleRequesterCompletionBatch
    >[0]) => {
      for (const { subagent, taskId } of entries) {
        if (subagent.pauseReason !== "sessions_yield") {
          // The store publishes a newly decoded receipt even when already delivered.
          if (outcome.delivered && subagent.delivery) {
            subagent.delivery = { ...subagent.delivery };
          }
          if (
            subagent.expectsCompletionMessage &&
            ["pending", "in_progress"].includes(subagent.delivery?.status ?? "pending")
          ) {
            if (outcome.delivered) {
              const deliveredAt = outcome.deliveredAt ?? Date.now();
              subagent.delivery = {
                ...subagent.delivery,
                status: "delivered",
                disposition: "delivered",
                deliveredAt,
                announcedAt: deliveredAt,
              };
              clearSubagentPendingDelivery(subagent);
              taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId({
                runId: subagent.taskRunId ?? subagent.runId,
                deliveryStatus: "delivered",
              });
            } else {
              completionDeliveryMocks.blockSubagentCompletionDelivery({
                subagent,
                taskId: taskId ?? "",
                reason: outcome.error ?? outcome.reason ?? "requester settle wake failed",
                disposition: outcome.disposition,
              });
            }
          }
          if (subagent.requesterTurnRunId && subagent.expectsCompletionMessage) {
            subagent.retireAfterRequesterTurn =
              subagent.retireAfterRequesterTurn ||
              subagent.requesterSettleWake?.retireAfterSettle ||
              undefined;
          } else if (subagent.requesterSettleWake?.retireAfterSettle) {
            completionDeliveryMocks.runsByEntry.get(subagent)?.delete(subagent.runId);
          }
        }
        subagent.requesterSettleWake = undefined;
      }
    },
  );
  completionDeliveryMocks.blockSubagentCompletionDelivery.mockImplementation(
    ({
      subagent,
      reason,
      suspendedReason,
      disposition,
    }: {
      subagent: SubagentRunRecord;
      reason: string;
      suspendedReason?: "expiry" | "permanent_failure";
      disposition?: NonNullable<SubagentRunRecord["delivery"]>["disposition"];
    }) => {
      subagent.delivery ??= { status: "pending" };
      subagent.delivery.lastError = reason;
      subagent.delivery.deliveredAt = undefined;
      subagent.delivery.announcedAt = undefined;
      if (suspendedReason) {
        subagent.delivery.status = "suspended";
        subagent.delivery.suspendedReason = suspendedReason;
        subagent.delivery.suspendedAt = Date.now();
        subagent.cleanupHandled = false;
        subagent.requesterSettleWake ??= { status: "pending", attemptCount: 0 };
      } else {
        subagent.delivery.status = "failed";
        subagent.delivery.disposition = disposition ?? subagent.delivery.disposition;
        subagent.suppressCompletionDelivery = true;
      }
      return true;
    },
  );
}
