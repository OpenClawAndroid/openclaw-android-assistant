import { err, ok } from "@openclaw/normalization-core/result";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { isOpenClawAgentDatabasePathCurrent } from "../../state/openclaw-agent-db-identity.js";
import {
  hasOpenClawAgentReadOnlySchema,
  openOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabaseHandle,
} from "../../state/openclaw-agent-db-readonly-open.js";
import {
  loadSessionEntrySnapshot,
  readExactSessionEntryCandidatesInDatabase,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  encodeSessionListWorkerError,
  type SessionListWorkerError,
  type SessionListWorkerOperations,
} from "./session-accessor.sqlite-list-worker-contract.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readCanonicalSessionMainKey,
} from "./session-canonical-key.js";
import { listSessionMembershipKeysInDatabase } from "./session-sharing-store.kernel.js";

// The worker loader requires this export name for existing-database admission.
export { openSessionListSqliteWorkerBackend as openExistingSqliteWorkerBackend };

function openSessionListSqliteWorkerBackend(
  input: { agentId: string; identity: string },
  context: { databasePath: string },
): SqliteWorkerBackend<SessionListWorkerOperations> {
  let database: OpenClawAgentReadOnlyDatabaseHandle | undefined;
  let closed = false;
  const acquire = () => {
    assertExistingDatabaseIdentity(context.databasePath, `file:${input.identity}`);
    if (database && !isOpenClawAgentDatabasePathCurrent(database)) {
      throw new Error("Session metadata worker physical database changed");
    }
    if (!database) {
      const opened = openOpenClawAgentDatabaseReadOnly({
        agentId: input.agentId,
        path: context.databasePath,
      });
      if (!opened.found) {
        return undefined;
      }
      database = opened.database;
    }
    return hasOpenClawAgentReadOnlySchema(database) ? database : undefined;
  };
  return {
    execute(command): SessionListWorkerOperations[keyof SessionListWorkerOperations]["output"] {
      if (closed) {
        throw new Error("Session metadata worker is closed");
      }
      try {
        const reader = acquire();
        if (!reader) {
          return ok(undefined);
        }
        return withSqlitePostCommitPublications(reader.db, () =>
          runSqliteDeferredTransactionSync<
            SessionListWorkerOperations[keyof SessionListWorkerOperations]["output"]
          >(reader.db, () => {
            // The host's admitted-reader contract survives ordinary raw metadata edits.
            // A new admission still validates through the canonical owner on this worker.
            const prepared =
              command.input.validateCanonical ||
              readCanonicalSessionMainKey(reader) !== command.input.mainKey
                ? assertCanonicalSqliteSessionKeysCurrent(
                    reader,
                    undefined,
                    command.type === "inventory",
                  )
                : undefined;
            if (command.type === "inventory") {
              return ok({
                ...loadSessionEntrySnapshot(reader, "list", prepared),
                mainKey: readCanonicalSessionMainKey(reader),
              });
            }
            const entries = readExactSessionEntryCandidatesInDatabase(
              reader,
              command.input.requests,
              "list",
            );
            const identityId = command.input.membershipIdentityId?.trim();
            const memberships = identityId
              ? listSessionMembershipKeysInDatabase(
                  reader,
                  [...new Set(command.input.requests.flat())],
                  identityId,
                )
              : new Set<string>();
            return ok({
              mainKey: readCanonicalSessionMainKey(reader),
              results: entries.map((result) =>
                result.ok
                  ? ok({
                      entries: result.value,
                      membershipKeys: result.value.flatMap(({ sessionKey }) =>
                        memberships.has(sessionKey) ? [sessionKey] : [],
                      ),
                    })
                  : err(encodeSessionListWorkerError(result.error)),
              ),
            });
          }),
        );
      } catch (error) {
        return err<never, SessionListWorkerError>(encodeSessionListWorkerError(error));
      }
    },
    close() {
      closed = true;
      database?.close();
      database = undefined;
    },
  };
}
