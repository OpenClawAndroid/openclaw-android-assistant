import type { DatabaseSync } from "node:sqlite";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureOpenClawAgentTranscriptProjectionSourceColumns } from "./openclaw-agent-transcript-projection-source-schema.js";

export const SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE = "session_transcript_display_state";
export const SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE = "session_transcript_display_rows";
export const SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE =
  "session_transcript_display_row_sources";
export const SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE = "session_transcript_display_canvas";
export const SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE = "session_transcript_display_carry";

const DISPLAY_ROW_SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE} (`;
const DISPLAY_SEMANTICS_SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE} (`;
const TRANSCRIPT_FTS_SCHEMA_START =
  "CREATE VIRTUAL TABLE IF NOT EXISTS session_transcript_fts USING fts5(";
const SQLITE_TABLE_EXISTS_SQL = "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?";
const ENSURED_DATABASES = new WeakSet<DatabaseSync>();
const ABSENT_DATABASES = new WeakSet<DatabaseSync>();
const FOUNDATION_ONLY_DATABASES = new WeakSet<DatabaseSync>();
const DISPLAY_ROW_SCHEMA_COMPATIBILITY = {
  allowCompatibleAdditiveColumns: true,
  allowedMissingColumns: [`${SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE}.source_generation`],
};

function splitDisplayRowSchema(
  sql: string,
  endMarker = TRANSCRIPT_FTS_SCHEMA_START,
): {
  displayFoundation: string;
  displayRows: string;
  displaySemantics: string;
  withoutDisplayRows: string;
} {
  const start = sql.indexOf(DISPLAY_ROW_SCHEMA_START);
  const semanticsStart = sql.indexOf(DISPLAY_SEMANTICS_SCHEMA_START, start);
  const end = sql.indexOf(endMarker, start);
  if (start === -1 || semanticsStart === -1 || end === -1) {
    throw new Error("OpenClaw agent display-row schema markers are missing.");
  }
  return {
    displayFoundation: sql.slice(start, semanticsStart),
    displayRows: sql.slice(start, end),
    displaySemantics: sql.slice(semanticsStart, end),
    withoutDisplayRows: `${sql.slice(0, start)}${sql.slice(end)}`,
  };
}

const displayRowSchema = splitDisplayRowSchema(OPENCLAW_AGENT_SCHEMA_SQL);

const AGENT_DISPLAY_ROW_SCHEMA_SQL = displayRowSchema.displayRows;
const AGENT_DISPLAY_ROW_FOUNDATION_SCHEMA_SQL = displayRowSchema.displayFoundation;
const AGENT_DISPLAY_ROW_SEMANTICS_SCHEMA_SQL = displayRowSchema.displaySemantics;
export const AGENT_BASE_SCHEMA_SQL =
  splitDisplayRowSchema(OPENCLAW_AGENT_SCHEMA_SQL).withoutDisplayRows;

function hasDisplayRowTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    // Schema ownership must reject an incomplete lazy group before installing it.
    db.prepare(/* sqlite-allow-raw */ SQLITE_TABLE_EXISTS_SQL).get(tableName),
  );
}

export function validateOpenClawAgentDisplayRowSchema(db: DatabaseSync): boolean {
  if (ENSURED_DATABASES.has(db)) {
    return true;
  }
  if (ABSENT_DATABASES.has(db) || FOUNDATION_ONLY_DATABASES.has(db)) {
    return false;
  }
  const statePresent = hasDisplayRowTable(db, SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE);
  const rowsPresent = hasDisplayRowTable(db, SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE);
  const semanticTables = [
    SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE,
    SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE,
    SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE,
  ];
  const presentSemanticTables = semanticTables.filter((tableName) =>
    hasDisplayRowTable(db, tableName),
  );
  if (!statePresent && !rowsPresent && presentSemanticTables.length === 0) {
    ABSENT_DATABASES.add(db);
    return false;
  }
  if (!statePresent || !rowsPresent) {
    throw new Error("OpenClaw agent display-row schema is partially present.");
  }
  assertSqliteSchemaContains(
    db,
    "OpenClaw agent display-row foundation schema",
    AGENT_DISPLAY_ROW_FOUNDATION_SCHEMA_SQL,
    DISPLAY_ROW_SCHEMA_COMPATIBILITY,
  );
  if (presentSemanticTables.length === 0) {
    FOUNDATION_ONLY_DATABASES.add(db);
    return false;
  }
  if (presentSemanticTables.length !== semanticTables.length) {
    throw new Error("OpenClaw agent display-row semantics schema is partially present.");
  }
  assertSqliteSchemaContains(
    db,
    "OpenClaw agent display-row schema",
    AGENT_DISPLAY_ROW_SCHEMA_SQL,
    DISPLAY_ROW_SCHEMA_COMPATIBILITY,
  );
  ENSURED_DATABASES.add(db);
  return true;
}

function cacheDisplayRowSchemaAfterTransaction(db: DatabaseSync): void {
  setImmediate(() => {
    if (!db.isOpen || db.isTransaction) {
      return;
    }
    try {
      if (validateOpenClawAgentDisplayRowSchema(db)) {
        ENSURED_DATABASES.add(db);
      }
    } catch {
      // The next feature use must surface external drift synchronously.
    }
  });
}

/** Lazily installs the complete additive display-row group on first projection use. */
export function ensureOpenClawAgentDisplayRowSchema(db: DatabaseSync): void {
  if (ENSURED_DATABASES.has(db)) {
    return;
  }
  const ensure = () => {
    const absent = ABSENT_DATABASES.has(db);
    const statePresent = !absent && hasDisplayRowTable(db, SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE);
    const rowsPresent = !absent && hasDisplayRowTable(db, SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE);
    const complete = validateOpenClawAgentDisplayRowSchema(db);
    if (!statePresent && !rowsPresent) {
      db.exec(AGENT_DISPLAY_ROW_SCHEMA_SQL); // sqlite-allow-raw -- Canonical additive DDL only.
    } else if (!complete) {
      db.exec(AGENT_DISPLAY_ROW_SEMANTICS_SCHEMA_SQL); // sqlite-allow-raw -- Canonical additive DDL only.
      // Foundation rows were reduced under older semantics. Rotate and dirty
      // them so readers cannot publish a mixed-generation projection.
      // sqlite-allow-raw -- One-time lazy semantic migration.
      db.prepare(
        `UPDATE ${SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE}
         SET generation = lower(hex(randomblob(16))), needs_rebuild = 1, updated_at = ?`,
      ).run(Date.now());
    }
    ABSENT_DATABASES.delete(db);
    FOUNDATION_ONLY_DATABASES.delete(db);
    assertSqliteSchemaContains(
      db,
      "OpenClaw agent display-row schema",
      AGENT_DISPLAY_ROW_SCHEMA_SQL,
      DISPLAY_ROW_SCHEMA_COMPATIBILITY,
    );
    ensureOpenClawAgentTranscriptProjectionSourceColumns(db);
    assertSqliteSchemaContains(
      db,
      "OpenClaw agent display-row schema",
      AGENT_DISPLAY_ROW_SCHEMA_SQL,
    );
  };
  if (db.isTransaction) {
    ensure();
    cacheDisplayRowSchemaAfterTransaction(db);
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
  ENSURED_DATABASES.add(db);
}
