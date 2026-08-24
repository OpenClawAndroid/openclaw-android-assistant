import type { DatabaseSync } from "node:sqlite";
import { TRANSCRIPT_PROJECTION_SOURCE_COLUMN_DEFINITIONS } from "./openclaw-agent-db-additive-columns.js";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

const ENSURED_DATABASES = new WeakSet<DatabaseSync>();

type TranscriptProjectionStateTable =
  (typeof TRANSCRIPT_PROJECTION_SOURCE_COLUMN_DEFINITIONS)[number]["tableName"];

function projectionSourceColumnsPresent(db: DatabaseSync): boolean {
  return TRANSCRIPT_PROJECTION_SOURCE_COLUMN_DEFINITIONS.every(
    ({ columnName, tableName }) =>
      !tableExists(db, tableName) || tableHasColumn(db, tableName, columnName),
  );
}

function adoptReadyProjectionSourceGeneration(
  db: DatabaseSync,
  tableName: TranscriptProjectionStateTable,
): void {
  // sqlite-allow-raw -- One-time same-version column migration. Later NULL values remain stale.
  db.exec(`
    UPDATE ${tableName}
    SET source_generation = (
      SELECT generation
      FROM transcript_rewrite_watermarks
      WHERE session_id = ${tableName}.session_id
    )
    WHERE source_generation IS NULL
      AND needs_rebuild = 0
      AND indexed_seq = COALESCE((
        SELECT MAX(seq)
        FROM transcript_events
        WHERE session_id = ${tableName}.session_id
      ), -1);
  `);
}

export function hasRetiredTranscriptProjectionBindingSchema(db: DatabaseSync): boolean {
  return tableExists(db, "session_transcript_projection_bindings");
}

export function dropRetiredTranscriptProjectionBindingSchema(db: DatabaseSync): void {
  if (!hasRetiredTranscriptProjectionBindingSchema(db)) {
    return;
  }
  // Retired derived ownership rows can become stale across a downgrade.
  // Removing them makes any older reader rebuild instead of trusting them.
  db.exec("DROP TABLE session_transcript_projection_bindings;"); // sqlite-allow-raw -- Retired additive DDL cleanup.
}

/** Adds the nullable generation owner to each present projection-state table once. */
export function ensureOpenClawAgentTranscriptProjectionSourceColumns(db: DatabaseSync): void {
  if (ENSURED_DATABASES.has(db)) {
    return;
  }
  let addedColumn = false;
  for (const {
    columnName,
    dataType,
    tableName,
  } of TRANSCRIPT_PROJECTION_SOURCE_COLUMN_DEFINITIONS) {
    if (!ensureColumn(db, tableName, `${columnName} ${dataType}`)) {
      continue;
    }
    addedColumn = true;
    adoptReadyProjectionSourceGeneration(db, tableName);
  }
  if (!addedColumn || !db.isTransaction) {
    ENSURED_DATABASES.add(db);
    return;
  }
  setImmediate(() => {
    if (db.isOpen && !db.isTransaction && projectionSourceColumnsPresent(db)) {
      ENSURED_DATABASES.add(db);
    }
  });
}
