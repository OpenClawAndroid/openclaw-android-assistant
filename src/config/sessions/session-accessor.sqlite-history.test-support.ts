import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

export function insertSyntheticHistory(
  database: OpenClawAgentDatabase,
  sessionId: string,
  count: number,
  boundaries = false,
  boundaryType: "compaction" | "custom_message" = "compaction",
): void {
  const lastSeq = count * (boundaries ? 2 : 1) + 1;
  const insertEvent = database.db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertIdentity = database.db.prepare(
    `INSERT INTO transcript_event_identities
       (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
  );
  const insertActive = database.db.prepare(
    `INSERT INTO session_transcript_active_events
       (session_id, active_position, event_seq, message_position, context_eligible)
     VALUES (?, ?, ?, ?, 1)`,
  );
  runSqliteImmediateTransactionSync(database.db, () => {
    for (let seq = 2; seq <= lastSeq; seq += 1) {
      const isBoundary = boundaries && seq % 2 === 0;
      const id = `synthetic-${isBoundary ? "boundary" : "message"}-${String(seq)}`;
      const type = isBoundary ? boundaryType : "message";
      const event = {
        type,
        id,
        parentId: null,
        timestamp: "2026-08-15T00:00:00.000Z",
        ...(isBoundary
          ? boundaryType === "compaction"
            ? { summary: "synthetic" }
            : {
                customType: "synthetic-notice",
                content: "synthetic",
                display: seq % 4 === 0,
              }
          : { message: { role: "user", content: "synthetic" } }),
      };
      insertEvent.run(sessionId, seq, JSON.stringify(event), seq);
      insertIdentity.run(sessionId, id, seq, type, seq);
      insertActive.run(
        sessionId,
        seq - 1,
        seq,
        isBoundary ? null : boundaries ? Math.floor(seq / 2) : seq - 1,
      );
    }
    database.db
      .prepare(
        `UPDATE session_transcript_index_state
         SET indexed_seq = ?, leaf_event_id = ?, active_event_count = ?, active_message_count = ?
         WHERE session_id = ?`,
      )
      .run(
        lastSeq,
        `synthetic-message-${String(lastSeq)}`,
        lastSeq,
        boundaries ? count + 1 : lastSeq,
        sessionId,
      );
  });
}
