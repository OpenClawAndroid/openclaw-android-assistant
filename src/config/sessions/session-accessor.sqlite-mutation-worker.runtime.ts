import { on } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { MessagePort } from "node:worker_threads";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync-cache-state.js";
import {
  createOpenClawAgentDatabaseClaim,
  type OpenClawAgentDatabaseClaim,
} from "../../state/openclaw-agent-db-identity.js";
import {
  assertOpenClawAgentDatabaseLease,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "../../state/openclaw-agent-db-lease.js";
import { readOpenClawAgentDatabaseWorkerLeaseReceipt } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  getOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  borrowOpenClawAgentDatabase,
  settleOpenClawAgentDatabaseWorkerClose,
  withOpenClawAgentDatabaseAdmission,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
  type OpenClawAgentDatabaseWorkerCloseResult,
  type OpenClawAgentDatabaseWriteAdmission,
} from "../../state/openclaw-agent-db.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  markSqliteReclamationSettled,
  waitForSqliteReclamationCommit,
} from "./session-accessor.sqlite-reclamation-commit.js";
import type {
  SqliteReclamationWorkerRequest,
  SqliteReclamationWorkerMessage,
} from "./session-accessor.sqlite-reclamation-worker.js";
import type { SqliteMutationWorkerMessage } from "./session-accessor.sqlite-worker-request.js";
import type {
  SessionColdWorkerData,
  SessionColdMutationResult,
} from "./session-cold-storage-worker.js";

const WORKER_CLOSE_MAX_ATTEMPTS = 3;

async function settleReclamationDatabase(
  pathname: string,
): Promise<{ cleanupWarnings: string[]; settled: boolean }> {
  const warnings = new Set<string>();
  let outcome: OpenClawAgentDatabaseWorkerCloseResult = { errors: [], settled: false };
  for (let attempt = 0; attempt < WORKER_CLOSE_MAX_ATTEMPTS; attempt += 1) {
    outcome = settleOpenClawAgentDatabaseWorkerClose(pathname);
    outcome.errors.forEach((error) => warnings.add(error.message));
    if (outcome.settled) {
      break;
    }
    if (attempt + 1 < WORKER_CLOSE_MAX_ATTEMPTS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25 * 2 ** attempt);
      });
    }
  }
  return { cleanupWarnings: [...warnings], settled: outcome.settled };
}

function withWorkerWriteAdmission<T>(
  port: MessagePort,
  operationId: number,
  databaseOptions: OpenClawAgentDatabaseOptions,
  operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
): Promise<T> {
  let admissionId = 0;
  let finalAdmission = false;
  const withAdmission: OpenClawAgentDatabaseWriteAdmission = async (run) => {
    const requestedId = ++admissionId;
    const admission = await new Promise<{
      allowed: boolean;
      validation?: OpenClawAgentDatabaseValidation;
    }>((resolve, reject) => {
      const receive = (admissionMessage: {
        type: string;
        operationId: number;
        admissionId: number;
        allowed: boolean;
        validation?: OpenClawAgentDatabaseValidation;
      }) => {
        cleanup();
        if (
          admissionMessage.type !== "admission" ||
          admissionMessage.operationId !== operationId ||
          admissionMessage.admissionId !== requestedId
        ) {
          reject(new Error("SQLite reclamation Worker received invalid write admission"));
          return;
        }
        resolve(admissionMessage);
      };
      const closed = () => {
        cleanup();
        reject(new Error("SQLite reclamation parent closed during database admission"));
      };
      const cleanup = () => {
        port.off("message", receive);
        port.off("close", closed);
      };
      port.on("message", receive);
      port.once("close", closed);
      port.postMessage({
        type: "admission-request",
        operationId,
        admissionId: requestedId,
      });
    });
    const value = await run(() => {
      if (!admission.allowed) {
        throw new Error("SQLite reclamation database admission was revoked");
      }
    }, admission.validation);
    if (!finalAdmission) {
      port.postMessage({
        type: "admission-release",
        operationId,
        admissionId: requestedId,
      });
    }
    return value;
  };
  return withOpenClawAgentDatabaseAdmission(databaseOptions, withAdmission, (database) => {
    finalAdmission = true;
    return operation(database);
  });
}

export async function runColdMutationWorkerPort(
  port: MessagePort,
  data: SessionColdWorkerData,
): Promise<void> {
  const { mutateSessionColdTranscriptInWorker, prepareSessionColdRestoreInWorker } =
    await import("./session-cold-storage-worker.js");
  const { reclaimSqliteFreePages } = await import("./session-history-archive-pruning.js");
  // Restore materialization must finish before requesting any write admission.
  const coldRecords =
    data.plan.kind === "cold-restore"
      ? await prepareSessionColdRestoreInWorker(data.plan)
      : undefined;
  const commitGate = data.commitGate;
  let result: SessionColdMutationResult;
  let validation: OpenClawAgentDatabaseValidation | undefined;
  try {
    result = await withWorkerWriteAdmission(
      port,
      0,
      data.plan.databaseOptions,
      async (openedDatabase) => {
        let transactionDatabase: DatabaseSync | undefined;
        try {
          const changed = mutateSessionColdTranscriptInWorker(
            data.plan,
            coldRecords,
            (database) => {
              transactionDatabase = database.db;
              waitForSqliteReclamationCommit(commitGate, () =>
                port.postMessage({ type: "commit-request", operationId: 0 }),
              );
            },
          );
          // The parent joins the cold transaction, not the subsequent bounded page drain.
          markSqliteReclamationSettled(commitGate);
          if (data.plan.kind !== "cold-restore") {
            await reclaimSqliteFreePages(data.plan.databaseOptions, undefined, { maxPasses: 64 });
          }
          return changed;
        } finally {
          validation = getOpenClawAgentDatabaseValidation(openedDatabase);
          if (
            transactionDatabase &&
            (!transactionDatabase.isOpen || !transactionDatabase.isTransaction)
          ) {
            markSqliteReclamationSettled(commitGate);
          }
        }
      },
    );
  } catch (error) {
    const cleanup = await settleReclamationDatabase(data.plan.databaseOptions.path);
    if (cleanup.settled) {
      markSqliteReclamationSettled(commitGate);
    } else {
      throw new AggregateError(
        [error, ...cleanup.cleanupWarnings.map((warning) => new Error(warning))],
        "SQLite session reclamation failed and Worker cleanup is incomplete; restart OpenClaw before deleting the owning agent",
        { cause: error },
      );
    }
    throw error;
  }
  const cleanup = await settleReclamationDatabase(data.plan.databaseOptions.path);
  const workerResult = {
    result,
    ...(cleanup.cleanupWarnings.length > 0 ? { cleanupWarnings: cleanup.cleanupWarnings } : {}),
    ...(!cleanup.settled ? { cleanupIncomplete: true } : {}),
  };
  port.postMessage({
    type: "reclaimed",
    operationId: 0,
    result: workerResult,
    settled: true,
    validation: cleanup.settled ? validation : undefined,
  } satisfies SqliteMutationWorkerMessage<typeof workerResult>);
  port.close();
}

export async function runReclamationWorkerPort(
  port: MessagePort,
  databaseOptions: SqliteSessionReclamationPlan["databaseOptions"],
): Promise<void> {
  // Archive-only operations never load the write/lifecycle graph.
  const { reclaimSqliteSessionInTransaction } =
    await import("./session-accessor.sqlite-reclamation.js");
  let claim: OpenClawAgentDatabaseClaim | undefined;
  let retainedDatabase: DatabaseSync | undefined;
  let lease: OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
  let commitGate: SharedArrayBuffer | undefined;
  let operationId = 0;
  try {
    for await (const [message] of on(port, "message")) {
      // SAFETY: only the typed private parent sends on this port.
      const request = message as
        | SqliteReclamationWorkerRequest
        | { type: "close" }
        | { type: "admission" };
      if (request.type === "close") {
        break;
      }
      // Admission replies also reach the iterator; the active request consumes them below.
      if (request.type === "admission") {
        continue;
      }
      commitGate = request.commitGate;
      if (
        request.operationId !== ++operationId ||
        !isDeepStrictEqual(request.plan.databaseOptions, databaseOptions)
      ) {
        throw new Error("SQLite session reclamation database owner is no longer current");
      }
      claim?.assertCurrent();
      let validation: OpenClawAgentDatabaseValidation | undefined;
      const result = await withWorkerWriteAdmission(
        port,
        operationId,
        databaseOptions,
        (database) => {
          const openedForRequest = !claim;
          if (!claim) {
            const borrowed = borrowOpenClawAgentDatabase(databaseOptions);
            claim = createOpenClawAgentDatabaseClaim(database, borrowed.release);
            retainedDatabase = database.db;
            lease = readOpenClawAgentDatabaseWorkerLeaseReceipt(databaseOptions.path);
            port.postMessage({
              type: "lease",
              receipt: lease,
            } satisfies SqliteReclamationWorkerMessage);
          }
          claim.assertCurrent();
          if (retainedDatabase !== database.db || !lease) {
            throw new Error("SQLite session reclamation database owner is no longer current");
          }
          assertOpenClawAgentDatabaseLease(lease.leaseId, databaseOptions);
          try {
            const reclaimed = reclaimSqliteSessionInTransaction(request.plan, {
              beforeMutation: claim.assertCurrent,
              onCommit: () =>
                waitForSqliteReclamationCommit(request.commitGate, () =>
                  port.postMessage({
                    type: "commit-request",
                    operationId,
                  } satisfies SqliteReclamationWorkerMessage),
                ),
            });
            // Warm results must not revive proof invalidated by the parent between requests.
            if (openedForRequest) {
              validation = getOpenClawAgentDatabaseValidation(database);
            }
            return reclaimed;
          } finally {
            if (!database.db.isOpen || !database.db.isTransaction) {
              markSqliteReclamationSettled(commitGate);
            }
            clearNodeSqliteKyselyCacheForDatabase(database.db);
          }
        },
      );
      // The matching settlement releases this victim's admission and all plan buffers.
      request.plan.materializedPlans.length = 0;
      port.postMessage({
        type: "reclaimed",
        operationId,
        result,
        settled: true,
        validation,
      } satisfies SqliteReclamationWorkerMessage);
      commitGate = undefined;
    }
  } catch (error) {
    const cleanup = await settleReclamationDatabase(databaseOptions.path);
    port.postMessage({ type: "closed", ...cleanup } satisfies SqliteReclamationWorkerMessage);
    if (cleanup.settled) {
      markSqliteReclamationSettled(commitGate);
    } else {
      throw new AggregateError(
        [error, ...cleanup.cleanupWarnings.map((warning) => new Error(warning))],
        "SQLite session reclamation failed and Worker cleanup is incomplete; restart OpenClaw before deleting the owning agent",
        { cause: error },
      );
    }
    throw error;
  } finally {
    claim?.release();
  }
  const cleanup = await settleReclamationDatabase(databaseOptions.path);
  port.postMessage({ type: "closed", ...cleanup } satisfies SqliteReclamationWorkerMessage);
  port.close();
}
