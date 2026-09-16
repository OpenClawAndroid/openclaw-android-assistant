import { readSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { readCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { readWithCanonicalSessionAdmission } from "../config/sessions/session-canonical-key.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { readOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-open.js";
import { withScopedOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-scope.js";
import { createSessionTranscriptReader } from "./session-transcript-read-kernel.js";
import type { ResolvedTranscriptReadTarget } from "./session-transcript-read-target.js";

/** Serializable addresses prepared by the host; no handle, environment or config crosses isolates. */
export type PreparedSessionHistoryReadTarget = {
  transcript: ResolvedTranscriptReadTarget & { agentId: string; storePath: string };
  database: { agentId: string; path: string };
  entryValidationKey?: string;
};

export function createReadonlySessionHistoryReader(target: PreparedSessionHistoryReadTarget) {
  return createSessionTranscriptReader({
    resolveTarget: async () => target.transcript,
    readSnapshot: async (_transcript, read) => {
      const result = withScopedOpenClawAgentDatabaseReadOnly(
        (database) =>
          readWithCanonicalSessionAdmission(database, () => {
            // Repeat the original conditional row validation at every reader invocation,
            // after dispatch. A current entry may name a successor; it never selects this transcript.
            const entryValidationKey = target.entryValidationKey;
            if (entryValidationKey !== undefined) {
              readOpenClawAgentDatabaseReadOnly(database, (db) =>
                readSessionEntryRow(db, entryValidationKey),
              );
            }
            return readCurrentProjectionSnapshot(
              database,
              {
                agentId: target.transcript.agentId,
                sessionId: target.transcript.sessionId,
                sessionKey: target.transcript.sessionKey,
                databaseAgentId: target.database.agentId,
                path: target.database.path,
              },
              read,
            );
          }),
        target.database,
        { throwOnMissingTable: true },
      );
      if (!result.found) {
        throw new Error(
          "Session transcript storage is unavailable; open the source gateway and retry.",
        );
      }
      if (result.value.kind === "unavailable") {
        throw new SessionTranscriptProjectionUnavailableError(target.transcript.sessionId);
      }
      return result.value.value;
    },
  });
}
