// Active transcript projection maintenance shared by the SQLite session
// accessor, bounded history readers, and full-text search. Both projections
// mirror the ACTIVE transcript branch only. Invariant: the
// watermark's leaf_event_id always equals the append parent the accessor
// would resolve next; an append that chains onto it forward-indexes in the
// same transaction, anything ambiguous (leaf controls, branch switches)
// marks the session dirty for its write or maintenance owner to rebuild from
// the canonical visible-path resolver.
import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ColumnType } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { ensureOpenClawAgentDisplayRowSchema } from "../../state/openclaw-agent-display-row-schema.js";
import { ensureOpenClawAgentTranscriptProjectionSourceColumns } from "../../state/openclaw-agent-transcript-projection-source-schema.js";
import { chunkItems } from "../../utils/chunk-items.js";
import {
  appendEligibleSessionTranscriptDisplayRowInTransaction,
  hasTranscriptMessage,
  invalidateExistingSessionTranscriptDisplayInTransaction,
  invalidateSessionTranscriptDisplayInTransaction,
  isSessionTranscriptDisplayBoundary,
  shouldProjectActiveEvent,
} from "./session-transcript-display.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  buildSessionTranscriptProjection,
  claimPreparedSessionTranscriptProjectionInTransaction,
  deletePreparedSessionTranscriptProjectionChunkInTransaction,
  extractTranscriptIndexEntry,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  type TranscriptIndexEntry,
} from "./session-transcript-projection-rebuild.js";
import {
  EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
  readSessionTranscriptSourceGenerationInTransaction,
  readSessionTranscriptSourceGenerationTokenInTransaction,
} from "./session-transcript-source-generation.js";
import {
  isCanonicalSessionTranscriptEntry,
  isSessionTranscriptLeafControl,
  isSessionTranscriptSideAppendEntry,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";

const SQLITE_TABLE_EXISTS_SQL = "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?";

type TranscriptIndexDatabase = Omit<
  Pick<
    OpenClawAgentKyselyDatabase,
    | "session_windows"
    | "session_transcript_active_events"
    | "session_transcript_display_state"
    | "session_transcript_fts"
    | "session_transcript_index_state"
    | "transcript_rewrite_watermarks"
    | "transcript_events"
  >,
  "session_transcript_fts"
> & {
  session_transcript_fts: Omit<
    OpenClawAgentKyselyDatabase["session_transcript_fts"],
    "timestamp"
  > & {
    timestamp: ColumnType<string | null, number | string | null, number | string | null>;
  };
};

const SYNCHRONOUS_PROJECTION_CHUNK_ROWS = 512;
const SYNCHRONOUS_PROJECTION_FTS_CHUNK_ROWS = 128;

export type SessionTranscriptProjectionState = {
  activeEventCount: number;
  activeMessageCount: number;
  indexedSeq: number;
  leafEventId: string | null;
  needsRebuild: boolean;
  sourceGeneration: string | null;
};

function getIndexKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TranscriptIndexDatabase>(db);
}

function readSessionTranscriptProjectionState(
  db: DatabaseSync,
  sessionId: string,
): SessionTranscriptProjectionState | undefined {
  ensureOpenClawAgentTranscriptProjectionSourceColumns(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getIndexKysely(db)
      .selectFrom("session_transcript_index_state")
      .select([
        "active_event_count",
        "active_message_count",
        "indexed_seq",
        "leaf_event_id",
        "needs_rebuild",
        "source_generation",
      ])
      .where("session_id", "=", sessionId),
  );
  if (!row) {
    return undefined;
  }
  return {
    activeEventCount: row.active_event_count,
    activeMessageCount: row.active_message_count,
    indexedSeq: row.indexed_seq,
    leafEventId: row.leaf_event_id,
    needsRebuild: row.needs_rebuild !== 0,
    sourceGeneration: row.source_generation,
  };
}

export function sessionTranscriptIndexNeedsReconcile(db: DatabaseSync, sessionId: string): boolean {
  const source = readSessionTranscriptSourceGenerationInTransaction(db, sessionId);
  if (!source || source.indexedSeq < 0) {
    return false;
  }
  const state = readSessionTranscriptProjectionState(db, sessionId);
  return (
    !state ||
    state.needsRebuild ||
    state.indexedSeq !== source.indexedSeq ||
    state.sourceGeneration !== source.generation
  );
}

function writeWatermark(
  db: DatabaseSync,
  sessionId: string,
  watermark: SessionTranscriptProjectionState,
  now: number,
  sourceGeneration?: string,
): void {
  if (!watermark.needsRebuild && !sourceGeneration) {
    throw new Error(`Transcript source generation is missing for ${sessionId}`);
  }
  executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .insertInto("session_transcript_index_state")
      .values({
        session_id: sessionId,
        active_event_count: watermark.activeEventCount,
        active_message_count: watermark.activeMessageCount,
        indexed_seq: watermark.indexedSeq,
        leaf_event_id: watermark.leafEventId,
        needs_rebuild: watermark.needsRebuild ? 1 : 0,
        source_generation: watermark.needsRebuild ? null : sourceGeneration,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          active_event_count: watermark.activeEventCount,
          active_message_count: watermark.activeMessageCount,
          indexed_seq: watermark.indexedSeq,
          leaf_event_id: watermark.leafEventId,
          needs_rebuild: watermark.needsRebuild ? 1 : 0,
          source_generation: watermark.needsRebuild ? null : sourceGeneration,
          updated_at: now,
        }),
      ),
  );
}

function insertActiveEventRow(
  db: DatabaseSync,
  params: {
    activePosition: number;
    eventSeq: number;
    messagePosition: number | null;
    sessionId: string;
  },
): void {
  executeSqliteQuerySync(
    db,
    getIndexKysely(db).insertInto("session_transcript_active_events").values({
      session_id: params.sessionId,
      active_position: params.activePosition,
      event_seq: params.eventSeq,
      message_position: params.messagePosition,
    }),
  );
}

function deleteActiveEventRows(db: DatabaseSync, sessionId: string): void {
  executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .deleteFrom("session_transcript_active_events")
      .where("session_id", "=", sessionId),
  );
}

function insertFtsRow(db: DatabaseSync, sessionId: string, entry: TranscriptIndexEntry): void {
  executeSqliteQuerySync(
    db,
    getIndexKysely(db).insertInto("session_transcript_fts").values({
      text: entry.text,
      session_id: sessionId,
      message_id: entry.messageId,
      role: entry.role,
      // FTS5 aux columns are typeless; the local insert type preserves the
      // numeric timestamp SQLite stores while generated readers stay strings.
      timestamp: entry.timestamp,
    }),
  );
}

function deleteFtsRows(db: DatabaseSync, sessionId: string): void {
  // session_id is UNINDEXED in FTS5, so this scans the index; transcript
  // deletion and rebuilds are rare lifecycle events.
  executeSqliteQuerySync(
    db,
    getIndexKysely(db).deleteFrom("session_transcript_fts").where("session_id", "=", sessionId),
  );
}

function invalidateDisplayProjectionForAppend(
  db: DatabaseSync,
  params: { maintainDisplayProjection?: boolean; sessionId: string },
): void {
  if (params.maintainDisplayProjection === true) {
    invalidateSessionTranscriptDisplayInTransaction(db, params.sessionId);
  }
}

/**
 * In-transaction append hook. Forward-indexes the event when it
 * unambiguously extends the active branch and marks the session for rebuild
 * otherwise. Runs inside the same write transaction as the event insert, so
 * the index can never lag or tear relative to committed transcript rows.
 */
export function indexAppendedTranscriptEventInTransaction(
  db: DatabaseSync,
  params: {
    sessionId: string;
    seq: number;
    event: unknown;
    eventId: string | null;
    createdAt: number;
    /** True maintains, false skips for a batch owner, omission invalidates adopted state. */
    maintainDisplayProjection?: boolean;
    sourceGeneration?: string;
  },
): boolean {
  const existingDisplayInvalidated =
    params.maintainDisplayProjection === undefined &&
    invalidateExistingSessionTranscriptDisplayInTransaction(db, params.sessionId);
  const sourceGeneration =
    params.sourceGeneration ??
    readSessionTranscriptSourceGenerationTokenInTransaction(db, params.sessionId);
  if (!sourceGeneration) {
    throw new Error(`Transcript source generation is missing for ${params.sessionId}`);
  }
  const watermark = readSessionTranscriptProjectionState(db, params.sessionId);
  if (!watermark) {
    if (params.seq !== 0) {
      // Pre-existing rows without index state (e.g. doctor-migrated
      // transcripts): stay unindexed until reconcile rebuilds the session.
      invalidateDisplayProjectionForAppend(db, params);
      return true;
    }
    applyForwardIndex(
      db,
      params,
      {
        activeEventCount: 0,
        activeMessageCount: 0,
        indexedSeq: EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
        leafEventId: null,
        needsRebuild: false,
        sourceGeneration,
      },
      sourceGeneration,
    );
    return params.maintainDisplayProjection === true
      ? appendEligibleSessionTranscriptDisplayRowInTransaction(db, {
          ...params,
          sourceGeneration,
        })
      : existingDisplayInvalidated;
  }
  if (watermark.needsRebuild) {
    if (
      isSessionTranscriptDisplayBoundary(params.event) ||
      isSessionTranscriptLeafControl(params.event) ||
      isSessionTranscriptSideAppendEntry(params.event)
    ) {
      invalidateDisplayProjectionForAppend(db, params);
    }
    return true;
  }
  if (watermark.sourceGeneration !== sourceGeneration) {
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    invalidateDisplayProjectionForAppend(db, params);
    return true;
  }
  if (params.seq !== watermark.indexedSeq + 1) {
    // Out-of-band writes bypassed the hook; reconcile recomputes the truth.
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    invalidateDisplayProjectionForAppend(db, params);
    return true;
  }
  if (
    isSessionTranscriptLeafControl(params.event) ||
    isSessionTranscriptSideAppendEntry(params.event)
  ) {
    // Leaf controls repoint the active branch and side appends attach off
    // the main chain; the visible path must be re-resolved rather than
    // guessed at append time.
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    invalidateDisplayProjectionForAppend(db, params);
    return true;
  }
  if (isSessionTranscriptDisplayBoundary(params.event)) {
    applyForwardIndex(db, params, watermark, sourceGeneration);
    invalidateDisplayProjectionForAppend(db, params);
    return true;
  }
  const isCanonicalEvent = isCanonicalSessionTranscriptEntry(params.event);
  if (isCanonicalEvent && watermark.leafEventId === null && watermark.activeEventCount > 0) {
    // A canonical tree supersedes legacy flat message rows. Re-resolve once
    // instead of retaining rows that are no longer on the selected path.
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    invalidateDisplayProjectionForAppend(db, params);
    return true;
  }
  const treeEntry = parseSessionTranscriptTreeEntry(params.event);
  if (
    !isCanonicalEvent &&
    watermark.leafEventId !== null &&
    shouldProjectActiveEvent(params.event)
  ) {
    // A noncanonical row after a tracked tree cursor may be a flat fallback or
    // an opaque append ancestor. Only the full resolver can decide visibility.
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    invalidateDisplayProjectionForAppend(db, params);
    return true;
  }
  if (treeEntry && treeEntry.parentId !== watermark.leafEventId) {
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    invalidateDisplayProjectionForAppend(db, params);
    return true;
  }
  applyForwardIndex(db, params, watermark, sourceGeneration);
  return params.maintainDisplayProjection === true
    ? appendEligibleSessionTranscriptDisplayRowInTransaction(db, {
        ...params,
        sourceGeneration,
      })
    : existingDisplayInvalidated;
}

function applyForwardIndex(
  db: DatabaseSync,
  params: {
    sessionId: string;
    seq: number;
    event: unknown;
    eventId: string | null;
    createdAt: number;
  },
  watermark: SessionTranscriptProjectionState,
  sourceGeneration: string,
): void {
  const entry = extractTranscriptIndexEntry(params.event, params.createdAt);
  if (entry) {
    insertFtsRow(db, params.sessionId, entry);
  }
  const projectsActiveEvent = shouldProjectActiveEvent(params.event);
  const projectsMessage = projectsActiveEvent && hasTranscriptMessage(params.event);
  if (projectsActiveEvent) {
    insertActiveEventRow(db, {
      activePosition: watermark.activeEventCount,
      eventSeq: params.seq,
      messagePosition: projectsMessage ? watermark.activeMessageCount : null,
      sessionId: params.sessionId,
    });
  }
  // Mirror scanSessionTranscriptTree's leaf advancement: canonical entries
  // (parent-linked or parentless) become the tip the next append chains to;
  // headers and unknown control rows leave the tip untouched.
  const advancesLeaf = params.eventId !== null && isCanonicalSessionTranscriptEntry(params.event);
  writeWatermark(
    db,
    params.sessionId,
    {
      activeEventCount: watermark.activeEventCount + (projectsActiveEvent ? 1 : 0),
      activeMessageCount: watermark.activeMessageCount + (projectsMessage ? 1 : 0),
      indexedSeq: params.seq,
      leafEventId: advancesLeaf ? params.eventId : watermark.leafEventId,
      needsRebuild: false,
      sourceGeneration,
    },
    params.createdAt,
    sourceGeneration,
  );
}

/** Marks one session for lazy rebuild without touching its FTS rows. */
function markSessionTranscriptIndexDirtyInTransaction(db: DatabaseSync, sessionId: string): void {
  const now = Date.now();
  const watermark = readSessionTranscriptProjectionState(db, sessionId);
  writeWatermark(
    db,
    sessionId,
    {
      activeEventCount: watermark?.activeEventCount ?? 0,
      activeMessageCount: watermark?.activeMessageCount ?? 0,
      indexedSeq: watermark?.indexedSeq ?? EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
      leafEventId: watermark?.leafEventId ?? null,
      needsRebuild: true,
      sourceGeneration: null,
    },
    now,
  );
}

/** In-transaction delete hook: drops index rows alongside transcript rows. */
export function deleteSessionTranscriptIndexInTransaction(
  db: DatabaseSync,
  sessionId: string,
): void {
  deleteFtsRows(db, sessionId);
  deleteActiveEventRows(db, sessionId);
  executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .deleteFrom("session_transcript_index_state")
      .where("session_id", "=", sessionId),
  );
}

/** Rebuilds one lagging projection under its current write transaction. */
export function reconcileSessionTranscriptIndexInTransaction(
  db: DatabaseSync,
  sessionId: string,
): boolean {
  const latest = executeSqliteQueryTakeFirstSync(
    db,
    getIndexKysely(db)
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  if (!latest) {
    deleteSessionTranscriptIndexInTransaction(db, sessionId);
    return false;
  }
  if (!sessionTranscriptIndexNeedsReconcile(db, sessionId)) {
    return false;
  }
  const source = readSessionTranscriptSourceGenerationInTransaction(db, sessionId);
  const session = executeSqliteQueryTakeFirstSync(
    db,
    getIndexKysely(db)
      .selectFrom("session_windows")
      .select("transcript_updated_at")
      .where("session_id", "=", sessionId),
  );
  if (!source || !session) {
    throw new Error(`Transcript source generation is missing for ${sessionId}`);
  }
  const rows = executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .selectFrom("transcript_events")
      .select(["event_json", "seq", "created_at"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  const projection = buildSessionTranscriptProjection({
    activeNeedsRebuild: true,
    displayNeedsRebuild: false,
    includeDisplayRows: false,
    rows: rows.map((row) => ({
      createdAt: row.created_at,
      event: JSON.parse(row.event_json) as unknown,
      seq: row.seq,
    })),
    sessionId,
    sourceGeneration: source.generation,
    sourceTranscriptUpdatedAt: session.transcript_updated_at,
  });
  const claimId = -randomInt(1, 2 ** 47);
  if (!claimPreparedSessionTranscriptProjectionInTransaction(db, projection, claimId)) {
    return false;
  }
  let deleted;
  do {
    deleted = deletePreparedSessionTranscriptProjectionChunkInTransaction(db, {
      claimId,
      maxRowsPerTable: SYNCHRONOUS_PROJECTION_CHUNK_ROWS,
      sessionId,
      sourceGeneration: projection.sourceGeneration,
      sourceIndexedSeq: projection.sourceIndexedSeq,
    });
    if (!deleted.owned) {
      throw new Error(`Transcript projection claim changed while rebuilding ${sessionId}`);
    }
  } while (deleted.hasMore);
  for (const activeRows of chunkItems(projection.activeRows, SYNCHRONOUS_PROJECTION_CHUNK_ROWS)) {
    if (
      !appendPreparedSessionTranscriptProjectionChunkInTransaction(db, {
        activeRows,
        claimId,
        sessionId,
        sourceGeneration: projection.sourceGeneration,
        sourceIndexedSeq: projection.sourceIndexedSeq,
      })
    ) {
      throw new Error(`Transcript projection claim changed while rebuilding ${sessionId}`);
    }
  }
  for (const ftsRows of chunkItems(projection.ftsRows, SYNCHRONOUS_PROJECTION_FTS_CHUNK_ROWS)) {
    if (
      !appendPreparedSessionTranscriptProjectionChunkInTransaction(db, {
        claimId,
        ftsRows,
        sessionId,
        sourceGeneration: projection.sourceGeneration,
        sourceIndexedSeq: projection.sourceIndexedSeq,
      })
    ) {
      throw new Error(`Transcript projection claim changed while rebuilding ${sessionId}`);
    }
  }
  if (!finalizePreparedSessionTranscriptProjectionInTransaction(db, projection, claimId)) {
    throw new Error(`Transcript projection claim changed while finalizing ${sessionId}`);
  }
  return true;
}

/**
 * Sessions whose index needs reconcile work: flagged rebuilds, transcripts
 * that gained rows without index state (doctor imports), and watermarks
 * behind the newest row. Ordered for deterministic reconcile passes.
 */
function hasTranscriptRows(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM transcript_events LIMIT 1").get()); // sqlite-allow-raw -- Avoid creating the lazy display group for an unused agent database.
}

function sessionIds(rows: readonly { session_id: unknown }[]): string[] {
  return rows.flatMap(({ session_id }) => (typeof session_id === "string" ? [session_id] : []));
}

/** Lists sessions whose active and FTS projection is not bound to the current source. */
export function listSessionsNeedingTranscriptIndexReconcile(db: DatabaseSync): string[] {
  if (!hasTranscriptRows(db)) {
    return [];
  }
  ensureOpenClawAgentTranscriptProjectionSourceColumns(db);
  const rows = executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .selectFrom("session_windows")
      .innerJoin("transcript_events as latest", (join) =>
        join
          .onRef("latest.session_id", "=", "session_windows.session_id")
          .on((eb) =>
            eb(
              "latest.seq",
              "=",
              eb
                .selectFrom("transcript_events as candidate")
                .select("candidate.seq")
                .whereRef("candidate.session_id", "=", "session_windows.session_id")
                .orderBy("candidate.seq", "desc")
                .limit(1),
            ),
          ),
      )
      .leftJoin(
        "session_transcript_index_state as st",
        "st.session_id",
        "session_windows.session_id",
      )
      .leftJoin(
        "transcript_rewrite_watermarks as source",
        "source.session_id",
        "session_windows.session_id",
      )
      .select("session_windows.session_id")
      .where((eb) =>
        eb.or([
          eb(eb.fn.coalesce("st.needs_rebuild", eb.val(1)), "!=", 0),
          eb(
            "latest.seq",
            ">",
            eb.fn.coalesce("st.indexed_seq", eb.val(EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ)),
          ),
          eb("st.source_generation", "is", null),
          eb("source.generation", "is", null),
          eb("st.source_generation", "!=", eb.ref("source.generation")),
        ]),
      )
      .orderBy("session_windows.session_id"),
  ).rows;
  return sessionIds(rows);
}

/** Lists sessions whose active, FTS, or display projection requires repair. */
export function listSessionsNeedingTranscriptProjectionReconcile(db: DatabaseSync): string[] {
  const transcriptRowsPresent = hasTranscriptRows(db);
  const hasDisplayStateTable = Boolean(
    // sqlite-allow-raw -- Probe the lazy schema without installing it.
    db.prepare(SQLITE_TABLE_EXISTS_SQL).get("session_transcript_display_state"),
  );
  if (!transcriptRowsPresent && !hasDisplayStateTable) {
    return [];
  }
  ensureOpenClawAgentDisplayRowSchema(db);
  ensureOpenClawAgentTranscriptProjectionSourceColumns(db);
  const kysely = getIndexKysely(db);
  const rows = transcriptRowsPresent
    ? executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("session_windows")
          .innerJoin("transcript_events as latest", (join) =>
            join
              .onRef("latest.session_id", "=", "session_windows.session_id")
              .on((eb) =>
                eb(
                  "latest.seq",
                  "=",
                  eb
                    .selectFrom("transcript_events as candidate")
                    .select("candidate.seq")
                    .whereRef("candidate.session_id", "=", "session_windows.session_id")
                    .orderBy("candidate.seq", "desc")
                    .limit(1),
                ),
              ),
          )
          .leftJoin(
            "session_transcript_display_state as display",
            "display.session_id",
            "session_windows.session_id",
          )
          .leftJoin(
            "transcript_rewrite_watermarks as source",
            "source.session_id",
            "session_windows.session_id",
          )
          .select("session_windows.session_id")
          .where((eb) =>
            eb.or([
              eb(eb.fn.coalesce("display.needs_rebuild", eb.val(1)), "!=", 0),
              eb(
                "latest.seq",
                ">",
                eb.fn.coalesce(
                  "display.indexed_seq",
                  eb.val(EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ),
                ),
              ),
              eb("display.source_generation", "is", null),
              eb("source.generation", "is", null),
              eb("display.source_generation", "!=", eb.ref("source.generation")),
            ]),
          )
          .orderBy("session_windows.session_id"),
      ).rows
    : [];
  const displayDirtyRows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("session_transcript_display_state as display")
      .leftJoin(
        "transcript_rewrite_watermarks as source",
        "source.session_id",
        "display.session_id",
      )
      .select("display.session_id")
      .where((eb) =>
        eb.or([
          eb("display.needs_rebuild", "!=", 0),
          eb("display.source_generation", "is", null),
          eb("source.generation", "is", null),
          eb("display.source_generation", "!=", eb.ref("source.generation")),
        ]),
      ),
  ).rows;
  return [
    ...new Set([
      ...listSessionsNeedingTranscriptIndexReconcile(db),
      ...sessionIds(rows),
      ...sessionIds(displayDirtyRows),
    ]),
  ].toSorted();
}

/** Drops index rows for sessions whose transcript rows are gone. */
export function deleteOrphanedTranscriptIndexRowsInTransaction(db: DatabaseSync): void {
  const kysely = getIndexKysely(db);
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("session_transcript_active_events")
      .where(
        "session_id",
        "not in",
        kysely.selectFrom("transcript_events").select("session_id").distinct(),
      ),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("session_transcript_fts")
      .where(
        "session_id",
        "not in",
        kysely.selectFrom("transcript_events").select("session_id").distinct(),
      ),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("session_transcript_index_state")
      .where(
        "session_id",
        "not in",
        kysely.selectFrom("transcript_events").select("session_id").distinct(),
      ),
  );
}
