import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import {
  appendSessionTranscriptDisplayChunkInTransaction,
  claimSessionTranscriptDisplayInTransaction,
} from "./session-transcript-display-rebuild-store.js";
import { ensureSessionTranscriptSourceGenerationInTransaction } from "./session-transcript-source-generation.js";

vi.mock("../../infra/tmp-openclaw-dir.js", () => ({
  DEFAULT_POSIX_TMP_ROOT: "/tmp/openclaw",
  resolvePreferredOpenClawTmpDir: () => "/tmp/openclaw",
}));

const ROW_COUNT = 300;
const COMPANION_COUNT = 16;

describe("transcript display rebuild persistence", () => {
  let db: DatabaseSync | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("chunks oversized semantic-source and canvas inserts below SQLite's variable limit", () => {
    db = new DatabaseSync(":memory:");
    db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    const cases = [
      {
        sessionId: "display-rebuild-semantic-sources",
        table: "session_transcript_display_row_sources",
        companions: (sourceEventSeq: number) => ({
          canvases: [],
          semanticSources: Array.from({ length: COMPANION_COUNT }, (_, position) => ({
            position,
            relation: "message_tool_mirror" as const,
            sourceEventSeq,
            sourceOccurrence: position,
          })),
        }),
      },
      {
        sessionId: "display-rebuild-canvases",
        table: "session_transcript_display_canvas",
        companions: (sourceEventSeq: number) => ({
          canvases: Array.from({ length: COMPANION_COUNT }, (_, position) => ({
            position,
            sourceEventSeq,
            url: `/__openclaw__/canvas/documents/cv_${String(sourceEventSeq)}/${String(position)}.html`,
          })),
          semanticSources: [],
        }),
      },
    ] as const;

    for (const entry of cases) {
      const sessionKey = `agent:main:${entry.sessionId}`;
      db.prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', 0)",
      ).run(sessionKey, entry.sessionId);
      db.prepare(
        "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, 0, 0)",
      ).run(entry.sessionId, sessionKey);
      const insertEvent = db.prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
      );
      for (let sourceEventSeq = 0; sourceEventSeq < ROW_COUNT; sourceEventSeq += 1) {
        insertEvent.run(
          entry.sessionId,
          sourceEventSeq,
          JSON.stringify({
            id: `assistant-${String(sourceEventSeq)}`,
            message: { content: "reply", role: "assistant" },
            type: "message",
          }),
          sourceEventSeq,
        );
      }
      const generation = `generation-${entry.sessionId}`;
      const sourceGeneration = ensureSessionTranscriptSourceGenerationInTransaction(
        { db },
        entry.sessionId,
      );
      const claimId = Date.now();
      db.exec("BEGIN IMMEDIATE");
      expect(
        claimSessionTranscriptDisplayInTransaction(db, {
          claimId,
          generation,
          previousGeneration: null,
          sessionId: entry.sessionId,
        }),
      ).toBe(true);
      expect(
        appendSessionTranscriptDisplayChunkInTransaction(db, {
          claimId,
          generation,
          rows: Array.from({ length: ROW_COUNT }, (_, sourceEventSeq) => ({
            ...entry.companions(sourceEventSeq),
            displayOrdinal: sourceEventSeq,
            kind: "assistant" as const,
            revision: 1,
            rowId: `row-${String(sourceEventSeq)}`,
            rowVersion: 1,
            sourceEventSeq,
          })),
          sessionId: entry.sessionId,
          sourceGeneration,
          sourceIndexedSeq: ROW_COUNT - 1,
        }),
      ).toBe(true);
      db.exec("COMMIT");

      const count = db
        .prepare(`SELECT COUNT(*) AS count FROM ${entry.table} WHERE session_id = ?`)
        .get(entry.sessionId) as { count: number };
      expect(count.count).toBe(ROW_COUNT * COMPANION_COUNT);
    }
  });
});
