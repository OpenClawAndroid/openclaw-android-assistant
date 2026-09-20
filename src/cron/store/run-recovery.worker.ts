import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { serializeCronLoadError } from "./load-error.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import { findActiveCronRunReceiptInDatabase } from "./run-receipt-store.js";
import type { CronRunRecoveryWorkerOperations } from "./run-recovery.types.js";

export function proposeCronRunRecoveryInWorker(
  database: OpenClawStateDatabase,
  { storeKey, proposal }: CronRunRecoveryWorkerOperations["cron.proposeRunRecovery"]["input"],
): CronRunRecoveryWorkerOperations["cron.proposeRunRecovery"]["output"] {
  try {
    // Receipt first-use DDL and both observations retain their original transaction.
    const observed = runOpenClawStateWriteTransaction(
      ({ db }) => {
        const receipt = findActiveCronRunReceiptInDatabase({
          database: db,
          storePath: storeKey,
          jobId: proposal.jobId,
        });
        const rows =
          proposal.runningAtMs === undefined
            ? []
            : loadCronRows(db, storeKey, new Set([proposal.jobId]));
        const job = loadedCronStoreFromRows(rows).store.jobs[0];
        return {
          ...proposal,
          receipt,
          runningReceiptId:
            job?.state.runningAtMs === proposal.runningAtMs
              ? job?.state.runningReceiptId
              : undefined,
        };
      },
      { database, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "cron.run-recovery.propose" },
    );
    return { ok: true, proposal: observed };
  } catch (error) {
    return { ok: false, error: serializeCronLoadError(error) };
  }
}
