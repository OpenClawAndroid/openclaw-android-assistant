import type { serializeCronLoadError } from "./load-error.js";
import type { CronRunReceiptRecoveryCandidate } from "./run-receipt-store.js";

export type CronRunRecoveryProposal = {
  jobId: string;
  queuedAtMs?: number;
  runningAtMs?: number;
  runningReceiptId?: string;
  receipt?: CronRunReceiptRecoveryCandidate;
};

export type CronRunRecoveryWorkerOperations = {
  "cron.proposeRunRecovery": {
    input: {
      storeKey: string;
      proposal: Pick<CronRunRecoveryProposal, "jobId" | "queuedAtMs" | "runningAtMs">;
    };
    output:
      | { ok: true; proposal: CronRunRecoveryProposal }
      | { ok: false; error: ReturnType<typeof serializeCronLoadError> };
  };
};
