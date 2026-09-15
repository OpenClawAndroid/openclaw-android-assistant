import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptMutationStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";

/** Reads physical transcript presence without decoding events or restoring cold storage. */
export function hasSessionTranscriptEventsSync(scope: SessionTranscriptReadScope): boolean {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  // Archive and restore move events atomically; both stores must share one statement snapshot.
  // A cold descriptor guarantees a nonempty transcript, even when its archive needs repair.
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select("session_id")
        .where("session_id", "=", resolved.sessionId)
        .unionAll(
          db
            .selectFrom("session_transcript_cold_archives")
            .select("session_id")
            .where("session_id", "=", resolved.sessionId),
        )
        .limit(1),
    ),
  );
}

/** Reads both physical mutation fences from the same session window snapshot. */
export function readTranscriptMutationStateSync(scope: SessionTranscriptReadScope) {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => readTranscriptMutationStateInTransaction(database, resolved.sessionId),
    {
      databaseLabel: database.path,
      operationLabel: "session transcript mutation read",
    },
  );
}

/** Reads only the current transcript mutation fence without parsing transcript rows. */
export function readTranscriptMutationAtSync(scope: SessionTranscriptReadScope): number | null {
  return readTranscriptMutationStateSync(scope).updatedAt;
}
