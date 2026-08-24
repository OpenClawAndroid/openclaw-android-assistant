import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ColumnType, Generated } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  abandonSessionTranscriptDisplayClaimInTransaction,
  claimSessionTranscriptDisplayInTransaction,
  finalizeSessionTranscriptDisplayInTransaction,
  hasTranscriptMessage,
  prepareSessionTranscriptDisplayProjection,
  readSessionTranscriptDisplayRowsInTransaction,
  readSessionTranscriptDisplayState,
  shouldProjectActiveEvent,
  type PreparedSessionTranscriptDisplayCarry,
  type PreparedSessionTranscriptDisplayRow,
} from "./session-transcript-display.js";
import {
  EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
  readSessionTranscriptSourceGenerationInTransaction,
  sessionTranscriptSourceGenerationMatchesInTransaction,
} from "./session-transcript-source-generation.js";
import {
  resolveVisibleTranscriptAppendParentId,
  selectVisibleTranscriptEventEntries,
} from "./transcript-visible-events.js";

type TranscriptProjectionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_windows" | "session_transcript_index_state" | "transcript_events"
> & {
  session_transcript_active_events: OpenClawAgentKyselyDatabase["session_transcript_active_events"] & {
    rowid: Generated<number>;
  };
  session_transcript_fts: Omit<
    OpenClawAgentKyselyDatabase["session_transcript_fts"],
    "timestamp"
  > & {
    rowid: Generated<number>;
    timestamp: ColumnType<string | null, number | string | null, number | string | null>;
  };
};

export type TranscriptIndexEntry = {
  messageId: string;
  role: "assistant" | "user";
  text: string;
  timestamp: number;
};

export type PreparedSessionTranscriptProjectionMetadata = {
  activeEventCount: number;
  activeMessageCount: number;
  activeNeedsRebuild: boolean;
  displayCarry: PreparedSessionTranscriptDisplayCarry[];
  displayGeneration: string;
  displayNeedsRebuild: boolean;
  displayPreviousGeneration: string | null;
  displayRowCount: number;
  leafEventId: string | null;
  sessionId: string;
  sourceGeneration: string;
  sourceIndexedSeq: number;
  sourceTranscriptUpdatedAt: number | null;
};

export type PreparedSessionTranscriptProjection = PreparedSessionTranscriptProjectionMetadata & {
  activeRows: Array<{
    activePosition: number;
    eventSeq: number;
    messagePosition: number | null;
  }>;
  displayRows: PreparedSessionTranscriptDisplayRow[];
  ftsRows: TranscriptIndexEntry[];
};

type SessionTranscriptProjectionSourceRow = {
  createdAt: number;
  event: unknown;
  seq: number;
};

type ProjectionDeleteChunkResult = {
  hasMore: boolean;
  owned: boolean;
};

function getProjectionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TranscriptProjectionDatabase>(db);
}

function readMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const record = message as { content?: unknown; role?: unknown; text?: unknown };
  if (record.role !== "user" && record.role !== "assistant") {
    return undefined;
  }
  if (typeof record.content === "string") {
    return record.content.trim() || undefined;
  }
  if (typeof record.text === "string") {
    return record.text.trim() || undefined;
  }
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const content = record.content as unknown[];
  const parts = content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return [];
    }
    const part = block as { text?: unknown; type?: unknown };
    if (part.type !== "text" && part.type !== "input_text" && part.type !== "output_text") {
      return [];
    }
    return typeof part.text === "string" && part.text.trim() ? [part.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Extracts the searchable user/assistant text from one transcript event. */
export function extractTranscriptIndexEntry(
  event: unknown,
  fallbackTimestamp: number,
): TranscriptIndexEntry | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const record = event as { id?: unknown; message?: unknown; timestamp?: unknown; type?: unknown };
  if (record.type !== "message" || typeof record.id !== "string" || !record.id.trim()) {
    return undefined;
  }
  const message = record.message as { role?: unknown } | undefined;
  const role = message?.role;
  if (role !== "user" && role !== "assistant") {
    return undefined;
  }
  const text = readMessageText(message);
  if (!text) {
    return undefined;
  }
  const timestamp =
    typeof record.timestamp === "number"
      ? record.timestamp
      : typeof record.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
  return {
    messageId: record.id.trim(),
    role,
    text,
    timestamp: Number.isFinite(timestamp) ? timestamp : fallbackTimestamp,
  };
}

/** Builds the same active-branch and search projection for worker and in-transaction owners. */
export function buildSessionTranscriptProjection(params: {
  activeNeedsRebuild?: boolean;
  displayGeneration?: string;
  displayNeedsRebuild?: boolean;
  displayPreviousGeneration?: string | null;
  includeDisplayRows?: boolean;
  rows: readonly SessionTranscriptProjectionSourceRow[];
  sessionId: string;
  sourceGeneration: string;
  sourceTranscriptUpdatedAt: number | null;
}): PreparedSessionTranscriptProjection {
  const now = Date.now();
  const events = params.rows.map((row) => row.event);
  const activeRows: PreparedSessionTranscriptProjection["activeRows"] = [];
  const displayProjection =
    params.includeDisplayRows === false
      ? { carry: [], rows: [] }
      : prepareSessionTranscriptDisplayProjection(params.rows);
  const displayRows = displayProjection.rows;
  const ftsRows: TranscriptIndexEntry[] = [];
  let activeMessageCount = 0;

  for (const entry of selectVisibleTranscriptEventEntries(events)) {
    const source = params.rows[entry.seq - 1];
    // Forward appends and both rebuild owners must give timestamp-less events
    // the same persisted source timestamp, not the time a projection ran.
    const indexed = extractTranscriptIndexEntry(entry.event, source?.createdAt ?? now);
    if (indexed) {
      ftsRows.push(indexed);
    }
    if (!source || !shouldProjectActiveEvent(entry.event)) {
      continue;
    }
    const projectsMessage = hasTranscriptMessage(entry.event);
    activeRows.push({
      activePosition: activeRows.length,
      eventSeq: source.seq,
      messagePosition: projectsMessage ? activeMessageCount : null,
    });
    if (projectsMessage) {
      activeMessageCount += 1;
    }
  }

  return {
    activeEventCount: activeRows.length,
    activeMessageCount,
    activeNeedsRebuild: params.activeNeedsRebuild ?? true,
    activeRows,
    displayCarry: displayProjection.carry,
    displayGeneration: params.displayGeneration ?? randomUUID().replaceAll("-", ""),
    displayNeedsRebuild: params.displayNeedsRebuild ?? true,
    displayPreviousGeneration: params.displayPreviousGeneration ?? null,
    displayRowCount: displayRows.length,
    displayRows,
    ftsRows,
    leafEventId: resolveVisibleTranscriptAppendParentId(events),
    sessionId: params.sessionId,
    sourceGeneration: params.sourceGeneration,
    sourceIndexedSeq: params.rows.at(-1)?.seq ?? EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
    sourceTranscriptUpdatedAt: params.sourceTranscriptUpdatedAt,
  };
}

/** Reads and resolves one projection on a worker-owned SQLite snapshot. */
export function prepareSessionTranscriptProjection(
  db: DatabaseSync,
  sessionId: string,
  options: { includeDisplayProjection?: boolean } = {},
): PreparedSessionTranscriptProjection | undefined {
  return runSqliteDeferredTransactionSync(
    db,
    () => {
      const kysely = getProjectionKysely(db);
      const session = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("session_windows")
          .select("transcript_updated_at")
          .where("session_id", "=", sessionId),
      );
      const rows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("transcript_events")
          .select(["event_json", "seq", "created_at"])
          .where("session_id", "=", sessionId)
          .orderBy("seq", "asc"),
      ).rows;
      if (!session) {
        return undefined;
      }
      const source = readSessionTranscriptSourceGenerationInTransaction(db, sessionId);
      if (!source) {
        return undefined;
      }
      const latestSeq = source.indexedSeq;
      const activeState = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("session_transcript_index_state")
          .select(["indexed_seq", "needs_rebuild", "source_generation"])
          .where("session_id", "=", sessionId),
      );
      const includeDisplayProjection = options.includeDisplayProjection === true;
      const displayState = includeDisplayProjection
        ? readSessionTranscriptDisplayState(db, sessionId)
        : undefined;
      const displayNeedsRebuild =
        includeDisplayProjection &&
        (!displayState ||
          displayState.needsRebuild ||
          displayState.indexedSeq !== latestSeq ||
          displayState.sourceGeneration !== source.generation);
      const displayGeneration =
        displayState && (!displayNeedsRebuild || displayState.needsRebuild)
          ? displayState.generation
          : randomUUID().replaceAll("-", "");

      return buildSessionTranscriptProjection({
        activeNeedsRebuild:
          latestSeq >= 0 &&
          (!activeState ||
            activeState.needs_rebuild !== 0 ||
            activeState.indexed_seq !== latestSeq ||
            activeState.source_generation !== source.generation),
        displayGeneration,
        displayNeedsRebuild,
        includeDisplayRows: includeDisplayProjection,
        displayPreviousGeneration: displayState?.generation ?? null,
        rows: rows.map((row) => ({
          createdAt: row.created_at,
          event: JSON.parse(row.event_json) as Record<string, unknown>,
          seq: row.seq,
        })),
        sessionId,
        sourceGeneration: source.generation,
        sourceTranscriptUpdatedAt: session.transcript_updated_at,
      });
    },
    {
      databaseLabel: "agent transcript projection",
      operationLabel: "sessions.transcript-index.prepare",
    },
  );
}

function sourceSnapshotMatches(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
): boolean {
  const kysely = getProjectionKysely(db);
  const session = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_windows")
      .select("transcript_updated_at")
      .where("session_id", "=", plan.sessionId),
  );
  const source = readSessionTranscriptSourceGenerationInTransaction(db, plan.sessionId);
  return (
    session?.transcript_updated_at === plan.sourceTranscriptUpdatedAt &&
    source?.generation === plan.sourceGeneration &&
    source.indexedSeq === plan.sourceIndexedSeq
  );
}

function projectionClaimIsOwned(
  db: DatabaseSync,
  params: {
    claimId: number;
    sessionId: string;
    sourceGeneration: string;
    sourceIndexedSeq: number;
  },
): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getProjectionKysely(db)
      .selectFrom("session_transcript_index_state")
      .select(["needs_rebuild", "source_generation", "updated_at"])
      .where("session_id", "=", params.sessionId),
  );
  return Boolean(
    row &&
    row.needs_rebuild !== 0 &&
    row.source_generation === null &&
    row.updated_at === params.claimId &&
    sessionTranscriptSourceGenerationMatchesInTransaction(db, params.sessionId, {
      generation: params.sourceGeneration,
      indexedSeq: params.sourceIndexedSeq,
    }),
  );
}

/** Claims a prepared snapshot. Later chunks publish only while this claim remains current. */
export function claimPreparedSessionTranscriptProjectionInTransaction(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  claimId: number,
): boolean {
  if (!sourceSnapshotMatches(db, plan)) {
    return false;
  }
  const kysely = getProjectionKysely(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_transcript_index_state")
      .select(["indexed_seq", "needs_rebuild", "source_generation"])
      .where("session_id", "=", plan.sessionId),
  );
  const activeNeedsRebuild =
    plan.sourceIndexedSeq >= 0 &&
    (!current ||
      current.needs_rebuild !== 0 ||
      current.indexed_seq !== plan.sourceIndexedSeq ||
      current.source_generation !== plan.sourceGeneration);
  if (
    activeNeedsRebuild !== plan.activeNeedsRebuild ||
    (!plan.activeNeedsRebuild && !plan.displayNeedsRebuild)
  ) {
    return false;
  }
  if (plan.displayNeedsRebuild) {
    const readiness = readSessionTranscriptDisplayRowsInTransaction(db, plan.sessionId, {
      expectedGeneration: plan.displayPreviousGeneration ?? plan.displayGeneration,
      fromOrdinal: 0,
      limit: 1,
    });
    if (readiness.kind === "ready" || readiness.generation !== plan.displayPreviousGeneration) {
      return false;
    }
  }
  if (
    plan.displayNeedsRebuild &&
    !claimSessionTranscriptDisplayInTransaction(db, {
      claimId,
      generation: plan.displayGeneration,
      previousGeneration: plan.displayPreviousGeneration,
      sessionId: plan.sessionId,
    })
  ) {
    return false;
  }
  if (plan.activeNeedsRebuild) {
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("session_transcript_index_state")
        .values({
          active_event_count: 0,
          active_message_count: 0,
          indexed_seq: EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
          leaf_event_id: null,
          needs_rebuild: 1,
          session_id: plan.sessionId,
          source_generation: null,
          updated_at: claimId,
        })
        .onConflict((conflict) =>
          conflict.column("session_id").doUpdateSet({
            active_event_count: 0,
            active_message_count: 0,
            indexed_seq: EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
            leaf_event_id: null,
            needs_rebuild: 1,
            source_generation: null,
            updated_at: claimId,
          }),
        ),
    );
  }
  return true;
}

export function abandonPreparedSessionTranscriptProjectionInTransaction(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  claimId: number,
): void {
  if (plan.activeNeedsRebuild) {
    executeSqliteQuerySync(
      db,
      getProjectionKysely(db)
        .updateTable("session_transcript_index_state")
        .set({ source_generation: null, updated_at: Date.now() })
        .where("session_id", "=", plan.sessionId)
        .where("needs_rebuild", "!=", 0)
        .where("updated_at", "=", claimId),
    );
  }
  if (plan.displayNeedsRebuild) {
    abandonSessionTranscriptDisplayClaimInTransaction(db, {
      claimId,
      generation: plan.displayGeneration,
      sessionId: plan.sessionId,
    });
  }
}

/** Deletes old rows in bounded rowid batches while the prepared claim is current. */
export function deletePreparedSessionTranscriptProjectionChunkInTransaction(
  db: DatabaseSync,
  params: {
    claimId: number;
    maxRowsPerTable: number;
    sessionId: string;
    sourceGeneration: string;
    sourceIndexedSeq: number;
  },
): ProjectionDeleteChunkResult {
  if (!projectionClaimIsOwned(db, params)) {
    return { hasMore: false, owned: false };
  }
  // Hidden rowid batching is the narrow SQLite primitive that keeps each
  // writer transaction bounded for both ordinary and FTS5 projection rows.
  const kysely = getProjectionKysely(db);
  const active = Number(
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("session_transcript_active_events")
        .where(
          "rowid",
          "in",
          kysely
            .selectFrom("session_transcript_active_events")
            .select("rowid")
            .where("session_id", "=", params.sessionId)
            .limit(params.maxRowsPerTable),
        ),
    ).numAffectedRows ?? 0n,
  );
  const fts = Number(
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("session_transcript_fts")
        .where(
          "rowid",
          "in",
          kysely
            .selectFrom("session_transcript_fts")
            .select("rowid")
            .where("session_id", "=", params.sessionId)
            .limit(params.maxRowsPerTable),
        ),
    ).numAffectedRows ?? 0n,
  );
  return {
    hasMore: active === params.maxRowsPerTable || fts === params.maxRowsPerTable,
    owned: true,
  };
}

/** Appends one bounded projection chunk while its claim remains current. */
export function appendPreparedSessionTranscriptProjectionChunkInTransaction(
  db: DatabaseSync,
  params: {
    activeRows?: PreparedSessionTranscriptProjection["activeRows"];
    claimId: number;
    ftsRows?: PreparedSessionTranscriptProjection["ftsRows"];
    sessionId: string;
    sourceGeneration: string;
    sourceIndexedSeq: number;
  },
): boolean {
  if (!projectionClaimIsOwned(db, params)) {
    return false;
  }
  const kysely = getProjectionKysely(db);
  if (params.activeRows && params.activeRows.length > 0) {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("session_transcript_active_events").values(
        params.activeRows.map((row) => ({
          active_position: row.activePosition,
          event_seq: row.eventSeq,
          message_position: row.messagePosition,
          session_id: params.sessionId,
        })),
      ),
    );
  }
  if (params.ftsRows && params.ftsRows.length > 0) {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("session_transcript_fts").values(
        params.ftsRows.map((row) => ({
          message_id: row.messageId,
          role: row.role,
          session_id: params.sessionId,
          text: row.text,
          timestamp: row.timestamp,
        })),
      ),
    );
  }
  return true;
}

/** Publishes counts and the append cursor only if the transcript snapshot stayed current. */
export function finalizePreparedSessionTranscriptProjectionInTransaction(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  claimId: number,
): boolean {
  if (
    (plan.activeNeedsRebuild &&
      !projectionClaimIsOwned(db, {
        claimId,
        sessionId: plan.sessionId,
        sourceGeneration: plan.sourceGeneration,
        sourceIndexedSeq: plan.sourceIndexedSeq,
      })) ||
    !sourceSnapshotMatches(db, plan)
  ) {
    return false;
  }
  if (
    plan.displayNeedsRebuild &&
    !finalizeSessionTranscriptDisplayInTransaction(db, {
      claimId,
      carry: plan.displayCarry,
      generation: plan.displayGeneration,
      rowCount: plan.displayRowCount,
      sessionId: plan.sessionId,
      sourceGeneration: plan.sourceGeneration,
      sourceIndexedSeq: plan.sourceIndexedSeq,
    })
  ) {
    return false;
  }
  if (!plan.activeNeedsRebuild) {
    return true;
  }
  const result = executeSqliteQuerySync(
    db,
    getProjectionKysely(db)
      .updateTable("session_transcript_index_state")
      .set({
        active_event_count: plan.activeEventCount,
        active_message_count: plan.activeMessageCount,
        indexed_seq: plan.sourceIndexedSeq,
        leaf_event_id: plan.leafEventId,
        needs_rebuild: 0,
        source_generation: plan.sourceGeneration,
        updated_at: Date.now(),
      })
      .where("session_id", "=", plan.sessionId)
      .where("needs_rebuild", "!=", 0)
      .where("updated_at", "=", claimId),
  );
  if (result.numAffectedRows !== 1n) {
    return false;
  }
  return true;
}
