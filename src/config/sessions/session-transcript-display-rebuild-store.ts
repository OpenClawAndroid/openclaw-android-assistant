import type { DatabaseSync } from "node:sqlite";
import type { Generated } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type {
  PreparedSessionTranscriptDisplayCarry,
  PreparedSessionTranscriptDisplayRow,
  SessionTranscriptDisplayRowKind,
} from "../../sessions/transcript-display-reducer-contract.js";
import {
  SESSION_TRANSCRIPT_DISPLAY_SEMANTICS_VERSION,
  parseDisplayRowKind,
} from "../../sessions/transcript-display-reducer.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  ensureOpenClawAgentDisplayRowSchema,
  SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE,
} from "../../state/openclaw-agent-display-row-schema.js";
import { chunkItems } from "../../utils/chunk-items.js";
import {
  readSessionTranscriptDisplayState,
  writeDisplayReducerCarry,
  writeDisplayState,
} from "./session-transcript-display-store.js";
import {
  EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
  readSessionTranscriptSourceGenerationInTransaction,
  sessionTranscriptSourceGenerationMatchesInTransaction,
} from "./session-transcript-source-generation.js";

const SESSION_TRANSCRIPT_DISPLAY_PAGE_MAX_ROWS = 200;
// Node's SQLite builds default to 32,766 variables per statement. Leave room for
// query-shape changes using the wider 11-binding canvas row as the batch bound.
const DISPLAY_COMPANION_INSERT_BATCH_SIZE = Math.floor(32_000 / 11);
type SessionTranscriptDisplayReadResult =
  | {
      generation: string;
      kind: "ready";
      nextOrdinal?: number;
      rows: Array<{
        displayOrdinal: number;
        kind: SessionTranscriptDisplayRowKind;
        revision: number;
        rowId: string;
        rowVersion: number;
        sourceEventSeq: number;
      }>;
    }
  | { generation: string | null; kind: "reset" };
type SessionTranscriptDisplayReadParams = {
  expectedGeneration: string;
  fromOrdinal: number | "tail";
  limit: number;
};
type DisplayRowDatabase = Omit<
  Pick<
    OpenClawAgentKyselyDatabase,
    | "session_transcript_display_rows"
    | "session_transcript_display_row_sources"
    | "session_transcript_display_canvas"
    | "session_transcript_display_carry"
    | "session_transcript_display_state"
    | "session_windows"
    | "transcript_events"
  >,
  "session_transcript_display_rows"
> & {
  session_transcript_display_rows: OpenClawAgentKyselyDatabase["session_transcript_display_rows"] & {
    rowid: Generated<number>;
  };
};
type DisplayDeleteChunkResult = { hasMore: boolean; owned: boolean };
function getDisplayKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<DisplayRowDatabase>(db);
}

export function claimSessionTranscriptDisplayInTransaction(
  db: DatabaseSync,
  params: {
    claimId: number;
    generation: string;
    previousGeneration: string | null;
    sessionId: string;
  },
): boolean {
  const state = readSessionTranscriptDisplayState(db, params.sessionId);
  if (!state) {
    if (params.previousGeneration !== null) {
      return false;
    }
    writeDisplayState(db, params.sessionId, {
      generation: params.generation,
      indexedSeq: EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
      needsRebuild: true,
      rowCount: 0,
      sourceGeneration: null,
      updatedAt: params.claimId,
    });
    return true;
  }
  if (state.generation !== params.previousGeneration) {
    return false;
  }
  writeDisplayState(db, params.sessionId, {
    ...state,
    generation: params.generation,
    needsRebuild: true,
    sourceGeneration: null,
    updatedAt: params.claimId,
  });
  return true;
}

function displayClaimIsOwned(
  db: DatabaseSync,
  params: {
    claimId: number;
    generation: string;
    sessionId: string;
    sourceGeneration: string;
    sourceIndexedSeq: number;
  },
): boolean {
  const state = readSessionTranscriptDisplayState(db, params.sessionId);
  return Boolean(
    state?.needsRebuild &&
    state.generation === params.generation &&
    state.updatedAt === params.claimId &&
    sessionTranscriptSourceGenerationMatchesInTransaction(db, params.sessionId, {
      generation: params.sourceGeneration,
      indexedSeq: params.sourceIndexedSeq,
    }),
  );
}

export function abandonSessionTranscriptDisplayClaimInTransaction(
  db: DatabaseSync,
  params: { claimId: number; generation: string; sessionId: string },
): void {
  executeSqliteQuerySync(
    db,
    getDisplayKysely(db)
      .updateTable(SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE)
      .set({ source_generation: null, updated_at: Date.now() })
      .where("session_id", "=", params.sessionId)
      .where("generation", "=", params.generation)
      .where("needs_rebuild", "!=", 0)
      .where("updated_at", "=", params.claimId),
  );
}

export function deleteSessionTranscriptDisplayChunkInTransaction(
  db: DatabaseSync,
  params: {
    claimId: number;
    generation: string;
    maxRows: number;
    sessionId: string;
    sourceGeneration: string;
    sourceIndexedSeq: number;
  },
): DisplayDeleteChunkResult {
  if (!displayClaimIsOwned(db, params)) {
    return { hasMore: false, owned: false };
  }
  const kysely = getDisplayKysely(db);
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom(SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE)
      .where("session_id", "=", params.sessionId),
  );
  const deleted = Number(
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)
        .where(
          "rowid",
          "in",
          kysely
            .selectFrom(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)
            .select("rowid")
            .where("session_id", "=", params.sessionId)
            .limit(params.maxRows),
        ),
    ).numAffectedRows ?? 0n,
  );
  return { hasMore: deleted === params.maxRows, owned: true };
}

export function appendSessionTranscriptDisplayChunkInTransaction(
  db: DatabaseSync,
  params: {
    claimId: number;
    generation: string;
    rows: readonly PreparedSessionTranscriptDisplayRow[];
    sessionId: string;
    sourceGeneration: string;
    sourceIndexedSeq: number;
  },
): boolean {
  if (!displayClaimIsOwned(db, params)) {
    return false;
  }
  if (params.rows.length > 0) {
    const kysely = getDisplayKysely(db);
    executeSqliteQuerySync(
      db,
      kysely.insertInto(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE).values(
        params.rows.map((row) => ({
          display_ordinal: row.displayOrdinal,
          kind: row.kind,
          revision: row.revision,
          row_id: row.rowId,
          row_version: row.rowVersion,
          session_id: params.sessionId,
          source_event_seq: row.sourceEventSeq,
        })),
      ),
    );
    const semanticSources = params.rows.flatMap((row) =>
      row.semanticSources.map((source) => ({
        position: source.position,
        relation: source.relation,
        row_id: row.rowId,
        semantics_version: SESSION_TRANSCRIPT_DISPLAY_SEMANTICS_VERSION,
        session_id: params.sessionId,
        source_event_seq: source.sourceEventSeq,
        source_occurrence: source.sourceOccurrence,
      })),
    );
    for (const sources of chunkItems(semanticSources, DISPLAY_COMPANION_INSERT_BATCH_SIZE)) {
      executeSqliteQuerySync(
        db,
        kysely.insertInto(SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE).values(sources),
      );
    }
    const canvases = params.rows.flatMap((row) =>
      row.canvases.map((canvas) => ({
        board_widget_name: canvas.boardWidgetName ?? null,
        canvas_version: SESSION_TRANSCRIPT_DISPLAY_SEMANTICS_VERSION,
        position: canvas.position,
        preferred_height: canvas.preferredHeight ?? null,
        row_id: row.rowId,
        sandbox: canvas.sandbox ?? null,
        session_id: params.sessionId,
        source_event_seq: canvas.sourceEventSeq,
        title: canvas.title ?? null,
        url: canvas.url,
        view_id: canvas.viewId ?? null,
      })),
    );
    for (const canvasRows of chunkItems(canvases, DISPLAY_COMPANION_INSERT_BATCH_SIZE)) {
      executeSqliteQuerySync(
        db,
        kysely.insertInto(SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE).values(canvasRows),
      );
    }
  }
  return true;
}

export function finalizeSessionTranscriptDisplayInTransaction(
  db: DatabaseSync,
  params: {
    claimId: number;
    generation: string;
    carry: readonly PreparedSessionTranscriptDisplayCarry[];
    rowCount: number;
    sessionId: string;
    sourceGeneration: string;
    sourceIndexedSeq: number;
  },
): boolean {
  if (!displayClaimIsOwned(db, params)) {
    return false;
  }
  writeDisplayReducerCarry(db, params.sessionId, params.carry);
  const result = executeSqliteQuerySync(
    db,
    getDisplayKysely(db)
      .updateTable(SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE)
      .set({
        indexed_seq: params.sourceIndexedSeq,
        needs_rebuild: 0,
        row_count: params.rowCount,
        source_generation: params.sourceGeneration,
        updated_at: Date.now(),
      })
      .where("session_id", "=", params.sessionId)
      .where("generation", "=", params.generation)
      .where("needs_rebuild", "!=", 0)
      .where("updated_at", "=", params.claimId),
  );
  if (result.numAffectedRows !== 1n) {
    return false;
  }
  return true;
}

function normalizeDisplayPageLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return SESSION_TRANSCRIPT_DISPLAY_PAGE_MAX_ROWS;
  }
  return Math.max(1, Math.min(SESSION_TRANSCRIPT_DISPLAY_PAGE_MAX_ROWS, Math.floor(limit)));
}

function readSessionTranscriptDisplayRowsSnapshot(
  db: DatabaseSync,
  sessionId: string,
  params: SessionTranscriptDisplayReadParams,
): SessionTranscriptDisplayReadResult {
  const state = readSessionTranscriptDisplayState(db, sessionId);
  const source = state
    ? readSessionTranscriptSourceGenerationInTransaction(db, sessionId)
    : undefined;
  if (
    !source ||
    !state ||
    state.generation !== params.expectedGeneration ||
    state.needsRebuild ||
    state.indexedSeq !== source.indexedSeq ||
    state.sourceGeneration !== source.generation
  ) {
    return { generation: state?.generation ?? null, kind: "reset" };
  }
  const tail = params.fromOrdinal === "tail";
  const fromOrdinal =
    params.fromOrdinal === "tail" || !Number.isFinite(params.fromOrdinal)
      ? 0
      : Math.max(0, Math.floor(params.fromOrdinal));
  const limit = normalizeDisplayPageLimit(params.limit);
  const kysely = getDisplayKysely(db);
  const pageQuery = kysely
    .selectFrom(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)
    .select(["display_ordinal", "kind", "revision", "row_id", "row_version", "source_event_seq"])
    .where("session_id", "=", sessionId);
  const selected = executeSqliteQuerySync(
    db,
    (tail
      ? pageQuery.orderBy("display_ordinal", "desc")
      : pageQuery.where("display_ordinal", ">=", fromOrdinal).orderBy("display_ordinal", "asc")
    ).limit(limit + 1),
  ).rows;
  const hasMore = selected.length > limit;
  const page = selected.slice(0, limit);
  const rows = (tail ? page.toReversed() : page).map((row) => ({
    displayOrdinal: row.display_ordinal,
    kind: parseDisplayRowKind(row.kind),
    revision: row.revision,
    rowId: row.row_id,
    rowVersion: row.row_version,
    sourceEventSeq: row.source_event_seq,
  }));
  return {
    generation: state.generation,
    kind: "ready",
    ...(!tail && hasMore ? { nextOrdinal: fromOrdinal + rows.length } : {}),
    rows,
  };
}

/** Reads one generation-bound page or returns reset without exposing partial projection state. */
export function readSessionTranscriptDisplayRowsInTransaction(
  db: DatabaseSync,
  sessionId: string,
  params: SessionTranscriptDisplayReadParams,
): SessionTranscriptDisplayReadResult {
  ensureOpenClawAgentDisplayRowSchema(db);
  if (db.isTransaction) {
    return readSessionTranscriptDisplayRowsSnapshot(db, sessionId, params);
  }
  return runSqliteDeferredTransactionSync(
    db,
    () => readSessionTranscriptDisplayRowsSnapshot(db, sessionId, params),
    {
      databaseLabel: "agent transcript display projection",
      operationLabel: "sessions.transcript-display.read",
    },
  );
}
