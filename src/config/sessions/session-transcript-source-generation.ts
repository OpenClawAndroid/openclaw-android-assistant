import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureOpenClawAgentTranscriptProjectionSourceColumns } from "../../state/openclaw-agent-transcript-projection-source-schema.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";

type SourceGenerationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_display_state"
  | "session_transcript_index_state"
  | "session_windows"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
>;

export const EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ = -1;

type SessionTranscriptSourceGeneration = {
  generation: string;
  indexedSeq: number;
};

function getSourceGenerationKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SourceGenerationDatabase>(db);
}

function createTranscriptGeneration(): string {
  return randomUUID().replaceAll("-", "");
}

/** Reads the authoritative source token when the caller already owns the append frontier. */
export function readSessionTranscriptSourceGenerationTokenInTransaction(
  db: DatabaseSync,
  sessionId: string,
): string | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getSourceGenerationKysely(db)
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", sessionId),
  )?.generation;
}

/** Reads the authoritative source generation and frontier from one SQLite snapshot. */
export function readSessionTranscriptSourceGenerationInTransaction(
  db: DatabaseSync,
  sessionId: string,
): SessionTranscriptSourceGeneration | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSourceGenerationKysely(db)
      .selectFrom("session_windows as window")
      .innerJoin(
        "transcript_rewrite_watermarks as rewrite",
        "rewrite.session_id",
        "window.session_id",
      )
      .select((eb) => [
        "rewrite.generation",
        eb
          .selectFrom("transcript_events as event")
          .select((inner) => inner.fn.max<number>("event.seq").as("indexed_seq"))
          .whereRef("event.session_id", "=", "window.session_id")
          .as("indexed_seq"),
      ])
      .where("window.session_id", "=", sessionId),
  );
  return row
    ? {
        generation: row.generation,
        indexedSeq: row.indexed_seq ?? EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
      }
    : undefined;
}

/** Materializes one source generation; ordinary appends preserve an existing token. */
export function ensureSessionTranscriptSourceGenerationInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): string {
  ensureOpenClawAgentTranscriptProjectionSourceColumns(database.db);
  const existing = readSessionTranscriptSourceGenerationTokenInTransaction(database.db, sessionId);
  if (existing) {
    return existing;
  }
  const generation = createTranscriptGeneration();
  const db = getSourceGenerationKysely(database.db);
  const inserted = executeSqliteQuerySync(
    database.db,
    db
      .insertInto("transcript_rewrite_watermarks")
      .values({ session_id: sessionId, generation, updated_at: Date.now() })
      .onConflict((conflict) => conflict.column("session_id").doNothing()),
  );
  return inserted.numAffectedRows === 1n
    ? generation
    : (readSessionTranscriptSourceGenerationTokenInTransaction(database.db, sessionId) ??
        generation);
}

/** Backfills legacy windows through the same source-generation policy before reconciliation. */
export function ensureAllSessionTranscriptSourceGenerationsInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
): number {
  const db = getSourceGenerationKysely(database.db);
  const missing = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows as window")
      .leftJoin(
        "transcript_rewrite_watermarks as rewrite",
        "rewrite.session_id",
        "window.session_id",
      )
      .select("window.session_id")
      .where("rewrite.session_id", "is", null),
  ).rows;
  for (const row of missing) {
    ensureSessionTranscriptSourceGenerationInTransaction(database, row.session_id);
  }
  return missing.length;
}

export function sessionTranscriptSourceGenerationMatchesInTransaction(
  db: DatabaseSync,
  sessionId: string,
  expected: SessionTranscriptSourceGeneration,
): boolean {
  const source = readSessionTranscriptSourceGenerationInTransaction(db, sessionId);
  return source?.generation === expected.generation && source.indexedSeq === expected.indexedSeq;
}

/** Returns source identity only while the active projection is fully current. */
export function readCurrentSessionTranscriptActiveSourceInTransaction(
  db: DatabaseSync,
  sessionId: string,
): SessionTranscriptSourceGeneration | undefined {
  ensureOpenClawAgentTranscriptProjectionSourceColumns(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSourceGenerationKysely(db)
      .selectFrom("session_transcript_index_state as state")
      .innerJoin("transcript_rewrite_watermarks as source", "source.session_id", "state.session_id")
      .select((eb) => [
        "source.generation",
        "state.indexed_seq",
        "state.needs_rebuild",
        "state.source_generation",
        eb
          .selectFrom("transcript_events as event")
          .select((inner) => inner.fn.max<number>("event.seq").as("source_indexed_seq"))
          .whereRef("event.session_id", "=", "state.session_id")
          .as("source_indexed_seq"),
      ])
      .where("state.session_id", "=", sessionId),
  );
  const sourceIndexedSeq = row?.source_indexed_seq ?? EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ;
  return row &&
    row.needs_rebuild === 0 &&
    row.indexed_seq === sourceIndexedSeq &&
    row.source_generation === row.generation
    ? { generation: row.generation, indexedSeq: sourceIndexedSeq }
    : undefined;
}

/** Replaces source identity and invalidates every derived projection atomically. */
export function replaceSessionTranscriptSourceGenerationInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  source: { generation?: string; updatedAt?: number } = {},
): string {
  const generation = source.generation ?? createTranscriptGeneration();
  const updatedAt = source.updatedAt ?? Date.now();
  ensureOpenClawAgentTranscriptProjectionSourceColumns(database.db);
  const db = getSourceGenerationKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("transcript_rewrite_watermarks")
      .values({ generation, session_id: sessionId, updated_at: updatedAt })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          generation,
          updated_at: updatedAt,
        }),
      ),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_transcript_index_state")
      .set({ source_generation: null })
      .where("session_id", "=", sessionId),
  );
  if (tableExists(database.db, "session_transcript_display_state")) {
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_transcript_display_state")
        .set({ source_generation: null })
        .where("session_id", "=", sessionId),
    );
  }
  return generation;
}
