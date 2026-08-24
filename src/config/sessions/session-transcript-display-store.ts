import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Generated } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  DisplayReducerEffects,
  DisplayReducerRow,
  DisplayReducerState,
  PreparedSessionTranscriptDisplayCanvas,
  PreparedSessionTranscriptDisplayCarry,
} from "../../sessions/transcript-display-reducer-contract.js";
import {
  SESSION_TRANSCRIPT_DISPLAY_ROW_VERSION,
  SESSION_TRANSCRIPT_DISPLAY_SEMANTICS_VERSION,
  createDisplayRowId,
  parseDisplayCarryKind,
  parseDisplayRowKind,
  reduceSessionTranscriptDisplaySource,
} from "../../sessions/transcript-display-reducer.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  ensureOpenClawAgentDisplayRowSchema,
  SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE,
  validateOpenClawAgentDisplayRowSchema,
} from "../../state/openclaw-agent-display-row-schema.js";
import { EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ } from "./session-transcript-source-generation.js";

type SessionTranscriptDisplayState = {
  generation: string;
  indexedSeq: number;
  needsRebuild: boolean;
  rowCount: number;
  sourceGeneration: string | null;
  updatedAt: number;
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
function getDisplayKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<DisplayRowDatabase>(db);
}
function createDisplayGeneration(): string {
  return randomUUID().replaceAll("-", "");
}

export function readSessionTranscriptDisplayState(
  db: DatabaseSync,
  sessionId: string,
): SessionTranscriptDisplayState | undefined {
  ensureOpenClawAgentDisplayRowSchema(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getDisplayKysely(db)
      .selectFrom(SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE)
      .select([
        "generation",
        "indexed_seq",
        "needs_rebuild",
        "row_count",
        "source_generation",
        "updated_at",
      ])
      .where("session_id", "=", sessionId),
  );
  return row
    ? {
        generation: row.generation,
        indexedSeq: row.indexed_seq,
        needsRebuild: row.needs_rebuild !== 0,
        rowCount: row.row_count,
        sourceGeneration: row.source_generation,
        updatedAt: row.updated_at,
      }
    : undefined;
}

export function writeDisplayState(
  db: DatabaseSync,
  sessionId: string,
  state: SessionTranscriptDisplayState,
): void {
  executeSqliteQuerySync(
    db,
    getDisplayKysely(db)
      .insertInto(SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE)
      .values({
        generation: state.generation,
        indexed_seq: state.indexedSeq,
        needs_rebuild: state.needsRebuild ? 1 : 0,
        row_count: state.rowCount,
        session_id: sessionId,
        source_generation: state.sourceGeneration,
        updated_at: state.updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          generation: state.generation,
          indexed_seq: state.indexedSeq,
          needs_rebuild: state.needsRebuild ? 1 : 0,
          row_count: state.rowCount,
          source_generation: state.sourceGeneration,
          updated_at: state.updatedAt,
        }),
      ),
  );
}

/** Rotates one display generation and makes every reader reset until reconcile publishes it. */
export function invalidateSessionTranscriptDisplayInTransaction(
  db: DatabaseSync,
  sessionId: string,
): string {
  ensureOpenClawAgentDisplayRowSchema(db);
  const state = readSessionTranscriptDisplayState(db, sessionId);
  const generation = createDisplayGeneration();
  writeDisplayState(db, sessionId, {
    generation,
    indexedSeq: state?.indexedSeq ?? EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
    needsRebuild: true,
    rowCount: state?.rowCount ?? 0,
    sourceGeneration: null,
    updatedAt: Date.now(),
  });
  return generation;
}

/** Invalidates an adopted display projection without materializing absent storage. */
export function invalidateExistingSessionTranscriptDisplayInTransaction(
  db: DatabaseSync,
  sessionId: string,
): boolean {
  if (!validateOpenClawAgentDisplayRowSchema(db)) {
    return false;
  }
  const result = executeSqliteQuerySync(
    db,
    getDisplayKysely(db)
      .updateTable(SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE)
      .set({
        generation: createDisplayGeneration(),
        needs_rebuild: 1,
        updated_at: Date.now(),
      })
      .where("session_id", "=", sessionId),
  );
  return result.numAffectedRows === 1n;
}

function displayRowFromDatabase(row: {
  display_ordinal: number;
  kind: string;
  revision: number;
  row_id: string;
  source_event_seq: number;
}): DisplayReducerRow {
  return {
    canvases: [],
    displayOrdinal: row.display_ordinal,
    kind: parseDisplayRowKind(row.kind),
    revision: row.revision,
    rowId: row.row_id,
    semanticSources: [],
    sourceEventSeq: row.source_event_seq,
  };
}

function readDisplayReducerCarry(
  db: DatabaseSync,
  sessionId: string,
): PreparedSessionTranscriptDisplayCarry[] {
  return executeSqliteQuerySync(
    db,
    getDisplayKysely(db)
      .selectFrom(SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE)
      .select([
        "delivery_event_seq",
        "kind",
        "position",
        "related_event_seq",
        "source_event_seq",
        "source_occurrence",
      ])
      .where("session_id", "=", sessionId)
      .orderBy("kind")
      .orderBy("position"),
  ).rows.map((row) => {
    const entry: PreparedSessionTranscriptDisplayCarry = {
      kind: parseDisplayCarryKind(row.kind),
      position: row.position,
      sourceEventSeq: row.source_event_seq,
      sourceOccurrence: row.source_occurrence,
    };
    if (row.related_event_seq !== null) {
      entry.relatedEventSeq = row.related_event_seq;
    }
    if (row.delivery_event_seq !== null) {
      entry.deliveryEventSeq = row.delivery_event_seq;
    }
    return entry;
  });
}

export function writeDisplayReducerCarry(
  db: DatabaseSync,
  sessionId: string,
  carry: readonly PreparedSessionTranscriptDisplayCarry[],
): void {
  const kysely = getDisplayKysely(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom(SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE).where("session_id", "=", sessionId),
  );
  if (carry.length === 0) {
    return;
  }
  executeSqliteQuerySync(
    db,
    kysely.insertInto(SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE).values(
      carry.map((entry) => ({
        carry_version: SESSION_TRANSCRIPT_DISPLAY_SEMANTICS_VERSION,
        delivery_event_seq: entry.deliveryEventSeq ?? null,
        kind: entry.kind,
        position: entry.position,
        related_event_seq: entry.relatedEventSeq ?? null,
        session_id: sessionId,
        source_event_seq: entry.sourceEventSeq,
        source_occurrence: entry.sourceOccurrence,
      })),
    ),
  );
}

function createDatabaseDisplayEffects(
  db: DatabaseSync,
  sessionId: string,
  initialRowCount: number,
): DisplayReducerEffects & { rowCount: () => number } {
  const kysely = getDisplayKysely(db);
  const newRows = new Set<string>();
  const revisedRows = new Set<string>();
  let rowCount = initialRowCount;
  const findRow = (sourceEventSeq: number): DisplayReducerRow | undefined => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)
        .select(["display_ordinal", "kind", "revision", "row_id", "source_event_seq"])
        .where("session_id", "=", sessionId)
        .where("source_event_seq", "=", sourceEventSeq),
    );
    return row ? displayRowFromDatabase(row) : undefined;
  };
  const revise = (row: DisplayReducerRow, includeNew = false) => {
    if ((!includeNew && newRows.has(row.rowId)) || revisedRows.has(row.rowId)) {
      return;
    }
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)
        .set({ revision: row.revision + 1 })
        .where("session_id", "=", sessionId)
        .where("row_id", "=", row.rowId),
    );
    row.revision += 1;
    revisedRows.add(row.rowId);
  };
  const readCanvases = (rowId: string) =>
    executeSqliteQuerySync(
      db,
      kysely
        .selectFrom(SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE)
        .select([
          "board_widget_name",
          "position",
          "preferred_height",
          "sandbox",
          "source_event_seq",
          "title",
          "url",
          "view_id",
        ])
        .where("session_id", "=", sessionId)
        .where("row_id", "=", rowId)
        .orderBy("position"),
    ).rows.map((canvas): PreparedSessionTranscriptDisplayCanvas => {
      const fact: PreparedSessionTranscriptDisplayCanvas = {
        position: canvas.position,
        sourceEventSeq: canvas.source_event_seq,
        url: canvas.url,
      };
      if (canvas.board_widget_name !== null) {
        fact.boardWidgetName = canvas.board_widget_name;
      }
      if (canvas.preferred_height !== null) {
        fact.preferredHeight = canvas.preferred_height;
      }
      if (canvas.sandbox === "strict" || canvas.sandbox === "scripts") {
        fact.sandbox = canvas.sandbox;
      }
      if (canvas.title !== null) {
        fact.title = canvas.title;
      }
      if (canvas.view_id !== null) {
        fact.viewId = canvas.view_id;
      }
      return fact;
    });
  const writeCanvases = (
    row: DisplayReducerRow,
    canvases: readonly PreparedSessionTranscriptDisplayCanvas[],
  ) => {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom(SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE)
        .where("session_id", "=", sessionId)
        .where("row_id", "=", row.rowId),
    );
    if (canvases.length > 0) {
      executeSqliteQuerySync(
        db,
        kysely.insertInto(SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE).values(
          canvases.map((canvas, position) => ({
            board_widget_name: canvas.boardWidgetName ?? null,
            canvas_version: SESSION_TRANSCRIPT_DISPLAY_SEMANTICS_VERSION,
            position,
            preferred_height: canvas.preferredHeight ?? null,
            row_id: row.rowId,
            sandbox: canvas.sandbox ?? null,
            session_id: sessionId,
            source_event_seq: canvas.sourceEventSeq,
            title: canvas.title ?? null,
            url: canvas.url,
            view_id: canvas.viewId ?? null,
          })),
        ),
      );
    }
    revise(row, true);
  };
  const removeCanvases = (sourceEventSeq: number) => {
    const owners = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom(SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE)
        .innerJoin(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE, (join) =>
          join
            .onRef(
              `${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE}.session_id`,
              "=",
              `${SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE}.session_id`,
            )
            .onRef(
              `${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE}.row_id`,
              "=",
              `${SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE}.row_id`,
            ),
        )
        .select([
          `${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE}.display_ordinal`,
          `${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE}.kind`,
          `${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE}.revision`,
          `${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE}.row_id`,
          `${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE}.source_event_seq`,
        ])
        .where(`${SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE}.session_id`, "=", sessionId)
        .where(`${SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE}.source_event_seq`, "=", sourceEventSeq),
    ).rows;
    for (const owner of owners) {
      const row = displayRowFromDatabase(owner);
      writeCanvases(
        row,
        readCanvases(row.rowId).filter((canvas) => canvas.sourceEventSeq !== sourceEventSeq),
      );
    }
  };
  return {
    addCanvases: (row, sourceEventSeq, canvases) => {
      removeCanvases(sourceEventSeq);
      const current = readCanvases(row.rowId);
      const identities = new Set(current.map((canvas) => canvas.viewId ?? canvas.url));
      let changed = false;
      for (const canvas of canvases) {
        const identity = canvas.viewId ?? canvas.url;
        if (!identities.has(identity) && current.length < 16) {
          current.push({ ...canvas, position: current.length });
          identities.add(identity);
          changed = true;
        }
      }
      if (changed) {
        writeCanvases(row, current);
      }
    },
    addRelation: (row, relation, sourceReferences) => {
      const existing = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom(SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE)
          .select(["position", "source_event_seq", "source_occurrence"])
          .where("session_id", "=", sessionId)
          .where("row_id", "=", row.rowId)
          .where("relation", "=", relation)
          .orderBy("position"),
      ).rows;
      const sources = new Set(
        existing.map((entry) => `${entry.source_event_seq}:${entry.source_occurrence}`),
      );
      const limit = relation === "turn_boundary" ? 1 : 16;
      const added: Array<(typeof sourceReferences)[number]> = [];
      for (const source of sourceReferences) {
        const key = `${source.sourceEventSeq}:${source.sourceOccurrence}`;
        if (sources.has(key) || sources.size >= limit) {
          continue;
        }
        added.push(source);
        sources.add(key);
      }
      if (added.length === 0) {
        return;
      }
      executeSqliteQuerySync(
        db,
        kysely.insertInto(SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE).values(
          added.map((source, offset) => ({
            position: existing.length + offset,
            relation,
            row_id: row.rowId,
            semantics_version: SESSION_TRANSCRIPT_DISPLAY_SEMANTICS_VERSION,
            session_id: sessionId,
            source_event_seq: source.sourceEventSeq,
            source_occurrence: source.sourceOccurrence,
          })),
        ),
      );
      revise(row);
    },
    appendRow: (kind, sourceEventSeq) => {
      const row: DisplayReducerRow = {
        canvases: [],
        displayOrdinal: rowCount,
        kind,
        revision: 1,
        rowId: createDisplayRowId(),
        semanticSources: [],
        sourceEventSeq,
      };
      executeSqliteQuerySync(
        db,
        kysely.insertInto(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE).values({
          display_ordinal: row.displayOrdinal,
          kind,
          revision: 1,
          row_id: row.rowId,
          row_version: SESSION_TRANSCRIPT_DISPLAY_ROW_VERSION,
          session_id: sessionId,
          source_event_seq: sourceEventSeq,
        }),
      );
      newRows.add(row.rowId);
      rowCount += 1;
      return row;
    },
    beginSource: () => {
      newRows.clear();
      revisedRows.clear();
    },
    findRow,
    removeCanvases,
    replaceStreamRows: (pendingSourceEventSeqs, sourceEventSeq) => {
      const pending = pendingSourceEventSeqs
        .flatMap((seq) => findRow(seq) ?? [])
        .toSorted((left, right) => left.displayOrdinal - right.displayOrdinal);
      const target = pending[0];
      if (!target) {
        throw new Error("Transcript display stream-error carry has no owned row.");
      }
      for (const extra of pending.slice(1).toReversed()) {
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)
            .where("session_id", "=", sessionId)
            .where("row_id", "=", extra.rowId),
        );
        const following = executeSqliteQuerySync(
          db,
          kysely
            .selectFrom(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)
            .select(["display_ordinal", "row_id"])
            .where("session_id", "=", sessionId)
            .where("display_ordinal", ">", extra.displayOrdinal)
            .orderBy("display_ordinal"),
        ).rows;
        for (const row of following) {
          const shouldRevise = !revisedRows.has(row.row_id);
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)
              .set((eb) => ({
                display_ordinal: row.display_ordinal - 1,
                ...(shouldRevise ? { revision: eb("revision", "+", 1) } : {}),
              }))
              .where("session_id", "=", sessionId)
              .where("row_id", "=", row.row_id),
          );
          if (shouldRevise) {
            revisedRows.add(row.row_id);
          }
        }
        rowCount -= 1;
      }
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable(SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)
          .set({
            kind: "assistant",
            revision: target.revision + 1,
            source_event_seq: sourceEventSeq,
          })
          .where("session_id", "=", sessionId)
          .where("row_id", "=", target.rowId),
      );
      target.kind = "assistant";
      target.revision += 1;
      target.sourceEventSeq = sourceEventSeq;
      revisedRows.add(target.rowId);
      return target;
    },
    rowCount: () => rowCount,
  };
}

/** Extends one ready display generation after active-path eligibility is already proven. */
export function appendEligibleSessionTranscriptDisplayRowInTransaction(
  db: DatabaseSync,
  params: { event: unknown; seq: number; sessionId: string; sourceGeneration: string },
): boolean {
  ensureOpenClawAgentDisplayRowSchema(db);
  const state = readSessionTranscriptDisplayState(db, params.sessionId);
  if (state?.needsRebuild) {
    return true;
  }
  if (state && state.sourceGeneration !== params.sourceGeneration) {
    invalidateSessionTranscriptDisplayInTransaction(db, params.sessionId);
    return true;
  }
  if (state && params.seq !== state.indexedSeq + 1) {
    invalidateSessionTranscriptDisplayInTransaction(db, params.sessionId);
    return true;
  }
  if (!state && params.seq !== 0) {
    invalidateSessionTranscriptDisplayInTransaction(db, params.sessionId);
    return true;
  }
  const generation = state?.generation ?? createDisplayGeneration();
  const rowCount = state?.rowCount ?? 0;
  if (!state) {
    writeDisplayState(db, params.sessionId, {
      generation,
      indexedSeq: params.seq - 1,
      needsRebuild: false,
      rowCount: 0,
      sourceGeneration: params.sourceGeneration,
      updatedAt: Date.now(),
    });
  }
  const carry = readDisplayReducerCarry(db, params.sessionId);
  const sourceEvents = new Map<number, unknown>([[params.seq, params.event]]);
  const readEvent = (sourceEventSeq: number): unknown => {
    if (sourceEvents.has(sourceEventSeq)) {
      return sourceEvents.get(sourceEventSeq);
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getDisplayKysely(db)
        .selectFrom("transcript_events")
        .select("event_json")
        .where("session_id", "=", params.sessionId)
        .where("seq", "=", sourceEventSeq),
    );
    const event = row ? (JSON.parse(row.event_json) as unknown) : undefined;
    sourceEvents.set(sourceEventSeq, event);
    return event;
  };
  const effects = createDatabaseDisplayEffects(db, params.sessionId, rowCount);
  const reducerState: DisplayReducerState = {
    carry,
    effects,
    readEvent,
  };
  reduceSessionTranscriptDisplaySource(reducerState, {
    event: params.event,
    seq: params.seq,
  });
  writeDisplayReducerCarry(db, params.sessionId, reducerState.carry);
  writeDisplayState(db, params.sessionId, {
    generation,
    indexedSeq: params.seq,
    needsRebuild: false,
    rowCount: effects.rowCount(),
    sourceGeneration: params.sourceGeneration,
    updatedAt: Date.now(),
  });
  return false;
}
