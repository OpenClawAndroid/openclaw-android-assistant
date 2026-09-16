import { createHash } from "node:crypto";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { TranscriptDigest } from "./session-accessor.sqlite-transcript-digest.types.js";

export function readSessionTranscriptDigest(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  append?: (row: { createdAt: number; eventJson: string }) => void,
): TranscriptDigest {
  let eventCount = 0;
  let rollingHash = "";
  for (const row of iterateSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select(["created_at", "event_json"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  )) {
    rollingHash = createHash("sha256")
      .update(rollingHash)
      .update("\0")
      .update(row.event_json)
      .digest("hex");
    eventCount += 1;
    append?.({ createdAt: row.created_at, eventJson: row.event_json });
  }
  return { eventCount, rollingHash };
}
