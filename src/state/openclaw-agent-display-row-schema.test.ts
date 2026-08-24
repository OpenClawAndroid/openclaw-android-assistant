import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { assertOpenClawAgentSchemaContains } from "./openclaw-agent-db-schema-helpers.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  ensureOpenClawAgentDisplayRowSchema,
  AGENT_BASE_SCHEMA_SQL,
  SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE,
  SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE,
  validateOpenClawAgentDisplayRowSchema,
} from "./openclaw-agent-display-row-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureOpenClawAgentTranscriptProjectionSourceColumns } from "./openclaw-agent-transcript-projection-source-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function tableExists(database: DatabaseSync, tableName: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function createDisplayDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  insertDisplayOwnerRows(database);
  return database;
}

function insertDisplayOwnerRows(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO session_nodes
         (session_key, current_session_id, entry_json, entry_valid, updated_at)
       VALUES ('agent:main:test', 'session-1', '{}', -1, 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO session_windows
         (session_id, session_key, session_scope, created_at, updated_at)
       VALUES ('session-1', 'agent:main:test', 'conversation', 1, 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('session-1', 0, '{"type":"session","id":"session-1"}', 1)`,
    )
    .run();
}

function insertDisplayStateAndRow(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO session_transcript_display_state
         (session_id, generation, indexed_seq, row_count, needs_rebuild, updated_at)
       VALUES ('session-1', 'generation-1', 0, 1, 0, 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO session_transcript_display_rows
         (session_id, row_id, row_version, revision, display_ordinal, source_event_seq, kind)
       VALUES ('session-1', 'row-1', 1, 1, 0, 0, 'opaque')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO session_transcript_display_row_sources
         (session_id, row_id, relation, position, source_event_seq, source_occurrence, semantics_version)
       VALUES ('session-1', 'row-1', 'turn_boundary', 0, 0, 0, 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO session_transcript_display_canvas
         (session_id, row_id, position, canvas_version, source_event_seq, url)
       VALUES ('session-1', 'row-1', 0, 1, 0, '/__openclaw__/canvas/documents/cv_test/index.html')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO session_transcript_display_carry
         (session_id, kind, position, source_event_seq, source_occurrence, carry_version)
       VALUES ('session-1', 'heartbeat_boundary', 0, 0, 0, 1)`,
    )
    .run();
}

describe("agent display-row schema", () => {
  it("stays absent until first use without changing schema version metadata", () => {
    const stateDir = tempDirs.make("openclaw-display-row-schema-");
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const versionBefore = database.db.prepare("PRAGMA user_version").get();
    const metadataBefore = database.db
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get();

    expect(tableExists(database.db, SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE)).toBe(false);
    expect(tableExists(database.db, SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)).toBe(false);
    expect(tableExists(database.db, SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE)).toBe(false);
    expect(tableExists(database.db, SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE)).toBe(false);
    expect(tableExists(database.db, SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE)).toBe(false);

    ensureOpenClawAgentDisplayRowSchema(database.db);
    ensureOpenClawAgentDisplayRowSchema(database.db);

    expect(tableExists(database.db, SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE)).toBe(true);
    expect(tableExists(database.db, SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE)).toBe(true);
    expect(
      database.db
        .prepare(
          "SELECT name, strict FROM pragma_table_list WHERE name LIKE 'session_transcript_display_%' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE, strict: 1 },
      { name: SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE, strict: 1 },
      { name: SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE, strict: 1 },
      { name: SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE, strict: 1 },
      { name: SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE, strict: 1 },
    ]);
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    expect(
      database.db
        .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual(metadataBefore);
  });

  it("lazily upgrades and reopens an exact foundation-only database", () => {
    const databasePath = path.join(tempDirs.make("openclaw-display-upgrade-"), "agent.sqlite");
    let database = new DatabaseSync(databasePath);
    try {
      const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(
        `CREATE TABLE IF NOT EXISTS ${SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE} (`,
      );
      const semanticsStart = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(
        `CREATE TABLE IF NOT EXISTS ${SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE} (`,
        start,
      );
      database.exec(AGENT_BASE_SCHEMA_SQL);
      database.exec(OPENCLAW_AGENT_SCHEMA_SQL.slice(start, semanticsStart));
      database.exec(`
        INSERT INTO session_nodes
          (session_key, current_session_id, entry_json, entry_valid, updated_at)
        VALUES ('agent:main:upgrade', 'session-upgrade', '{}', -1, 1);
        INSERT INTO session_windows
          (session_id, session_key, session_scope, created_at, updated_at)
        VALUES ('session-upgrade', 'agent:main:upgrade', 'conversation', 1, 1);
        INSERT INTO transcript_events (session_id, seq, event_json, created_at)
        VALUES ('session-upgrade', 0, '{"type":"session","id":"session-upgrade"}', 1);
        INSERT INTO session_transcript_display_state
          (session_id, generation, indexed_seq, row_count, needs_rebuild, updated_at)
        VALUES ('session-upgrade', 'foundation-generation', 0, 1, 0, 1);
        INSERT INTO session_transcript_display_rows
          (session_id, row_id, row_version, revision, display_ordinal, source_event_seq, kind)
        VALUES ('session-upgrade', 'foundation-row', 1, 1, 0, 0, 'opaque');
      `);
      const versionBefore = database.prepare("PRAGMA user_version").get();

      ensureOpenClawAgentDisplayRowSchema(database);
      expect(tableExists(database, SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE)).toBe(true);
      expect(tableExists(database, SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE)).toBe(true);
      expect(tableExists(database, SESSION_TRANSCRIPT_DISPLAY_CARRY_TABLE)).toBe(true);
      expect(
        database
          .prepare(
            `SELECT generation, needs_rebuild
             FROM session_transcript_display_state
             WHERE session_id = 'session-upgrade'`,
          )
          .get(),
      ).toMatchObject({ needs_rebuild: 1 });
      expect(
        database
          .prepare(
            `SELECT generation
             FROM session_transcript_display_state
             WHERE session_id = 'session-upgrade'`,
          )
          .get(),
      ).not.toEqual({ generation: "foundation-generation" });
      expect(database.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
      database.close();
      database = new DatabaseSync(databasePath);
      expect(() => ensureOpenClawAgentDisplayRowSchema(database)).not.toThrow();
      expect(tableExists(database, SESSION_TRANSCRIPT_DISPLAY_ROW_SOURCES_TABLE)).toBe(true);
      assertSqliteSchemaContains(
        database,
        "foundation reader schema",
        `${AGENT_BASE_SCHEMA_SQL}${OPENCLAW_AGENT_SCHEMA_SQL.slice(start, semanticsStart)}`,
      );
    } finally {
      if (database.isOpen) {
        database.close();
      }
    }
  });

  it("does not cache a schema ensure rolled back by its caller", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(AGENT_BASE_SCHEMA_SQL);
      database.exec("BEGIN IMMEDIATE;");
      ensureOpenClawAgentDisplayRowSchema(database);
      database.exec("ROLLBACK;");

      expect(tableExists(database, SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE)).toBe(false);
      ensureOpenClawAgentDisplayRowSchema(database);
      expect(tableExists(database, SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE)).toBe(true);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: "one missing table",
      damage: `DROP TABLE ${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE};`,
      message: /partially present/u,
    },
    {
      name: "one missing index",
      damage: "DROP INDEX idx_agent_transcript_display_ordinal;",
      message: /idx_agent_transcript_display_ordinal|schema/u,
    },
    {
      name: "one missing semantics table",
      damage: `DROP TABLE ${SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE};`,
      message: /semantics schema is partially present/u,
    },
    {
      name: "a malformed row table",
      damage: `
        DROP TABLE ${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE};
        CREATE TABLE ${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE} (
          session_id TEXT NOT NULL,
          row_id TEXT NOT NULL,
          PRIMARY KEY (session_id, row_id)
        ) STRICT;
      `,
      message: /session_transcript_display_rows|schema/u,
    },
  ])("rejects $name during physical reopen", ({ damage, message }) => {
    const stateDir = tempDirs.make("openclaw-display-row-reopen-");
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
    const database = openOpenClawAgentDatabase(options);
    ensureOpenClawAgentDisplayRowSchema(database.db);
    database.db.exec(damage);
    closeOpenClawAgentDatabasesForTest();

    expect(() => openOpenClawAgentDatabase(options)).toThrow(message);
  });

  it("keeps a complete populated group compatible with the prior schema contract", () => {
    const database = createDisplayDatabase();
    try {
      insertDisplayStateAndRow(database);
      expect(() =>
        assertSqliteSchemaContains(database, "previous agent schema", AGENT_BASE_SCHEMA_SQL),
      ).not.toThrow();
      expect(database.prepare("SELECT row_id FROM session_transcript_display_rows").get()).toEqual({
        row_id: "row-1",
      });
    } finally {
      database.close();
    }
  });

  it("reopens a complete group with compatible future source bindings", () => {
    const stateDir = tempDirs.make("openclaw-display-row-future-columns-");
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
    let database = openOpenClawAgentDatabase(options);
    ensureOpenClawAgentDisplayRowSchema(database.db);
    insertDisplayOwnerRows(database.db);
    insertDisplayStateAndRow(database.db);
    for (const tableName of [
      "session_transcript_index_state",
      SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE,
    ]) {
      const present = database.db
        .prepare(`SELECT 1 FROM pragma_table_info('${tableName}') WHERE name = 'source_generation'`)
        .get();
      if (!present) {
        database.db.exec(`ALTER TABLE ${tableName} ADD COLUMN source_generation TEXT;`);
      }
    }
    closeOpenClawAgentDatabasesForTest();

    expect(() => {
      database = openOpenClawAgentDatabase(options);
    }).not.toThrow();
    expect(database.db.prepare("SELECT row_id FROM session_transcript_display_rows").get()).toEqual(
      {
        row_id: "row-1",
      },
    );
  });

  it("rejects negative semantic and carry source references", () => {
    const database = createDisplayDatabase();
    try {
      insertDisplayStateAndRow(database);
      expect(() =>
        database
          .prepare(
            `INSERT INTO session_transcript_display_row_sources
               (session_id, row_id, relation, position, source_event_seq, source_occurrence, semantics_version)
             VALUES ('session-1', 'row-1', 'tts_supplement', 0, -1, 0, 1)`,
          )
          .run(),
      ).toThrow(/source_event_seq/u);
      expect(() =>
        database
          .prepare(
            `INSERT INTO session_transcript_display_carry
               (session_id, kind, position, source_event_seq, source_occurrence, related_event_seq, carry_version)
             VALUES ('session-1', 'message_tool', 0, 0, 0, -1, 1)`,
          )
          .run(),
      ).toThrow(/related_event_seq/u);
      expect(() =>
        database
          .prepare(
            `INSERT INTO session_transcript_display_carry
               (session_id, kind, position, source_event_seq, source_occurrence, delivery_event_seq, carry_version)
             VALUES ('session-1', 'message_tool', 0, 0, 0, -1, 1)`,
          )
          .run(),
      ).toThrow(/delivery_event_seq/u);
      expect(() =>
        database
          .prepare(
            `INSERT INTO session_transcript_display_carry
               (session_id, kind, position, source_event_seq, source_occurrence, carry_version)
             VALUES ('session-1', 'message_tool', 0, 0, -1, 1)`,
          )
          .run(),
      ).toThrow(/source_occurrence/u);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      deleteSql: "DELETE FROM transcript_events WHERE session_id = 'session-1' AND seq = 0",
      expectedStateRows: 1,
      name: "source event",
    },
    {
      deleteSql: "DELETE FROM session_transcript_display_state WHERE session_id = 'session-1'",
      expectedStateRows: 0,
      name: "display state",
    },
    {
      deleteSql: "DELETE FROM session_windows WHERE session_id = 'session-1'",
      expectedStateRows: 0,
      name: "session",
    },
  ])("cascades display rows when deleting the $name owner", ({ deleteSql, expectedStateRows }) => {
    const database = createDisplayDatabase();
    try {
      insertDisplayStateAndRow(database);
      database.exec(deleteSql);

      expect(
        database.prepare("SELECT COUNT(*) AS count FROM session_transcript_display_rows").get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM session_transcript_display_row_sources")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM session_transcript_display_canvas").get(),
      ).toEqual({ count: 0 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM session_transcript_display_carry").get(),
      ).toEqual({ count: 0 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM session_transcript_display_state").get(),
      ).toEqual({ count: expectedStateRows });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe("agent transcript projection source columns", () => {
  const priorSchema = OPENCLAW_AGENT_SCHEMA_SQL.replaceAll("  source_generation TEXT,\n", "");

  it("accepts and lazily upgrades the prior same-version shape", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(priorSchema);
      database.exec(`
        INSERT INTO session_nodes
          (session_key, current_session_id, entry_json, entry_valid, updated_at)
        VALUES ('agent:main:upgrade', 'session-upgrade', '{}', -1, 1);
        INSERT INTO session_windows
          (session_id, session_key, session_scope, created_at, updated_at)
        VALUES ('session-upgrade', 'agent:main:upgrade', 'conversation', 1, 1);
        INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at)
        VALUES ('session-upgrade', 'source-generation', 1);
        INSERT INTO transcript_events (session_id, seq, event_json, created_at)
        VALUES ('session-upgrade', 0, '{"type":"session","id":"session-upgrade"}', 1);
        INSERT INTO session_transcript_index_state
          (session_id, indexed_seq, needs_rebuild, active_event_count, active_message_count, updated_at)
        VALUES ('session-upgrade', 0, 0, 1, 0, 1);
        INSERT INTO session_transcript_display_state
          (session_id, generation, indexed_seq, row_count, needs_rebuild, updated_at)
        VALUES ('session-upgrade', 'display-generation', 0, 1, 0, 1);
      `);
      expect(() =>
        assertOpenClawAgentSchemaContains(
          database,
          "previous agent schema",
          OPENCLAW_AGENT_SCHEMA_SQL,
        ),
      ).not.toThrow();
      expect(validateOpenClawAgentDisplayRowSchema(database)).toBe(true);

      ensureOpenClawAgentTranscriptProjectionSourceColumns(database);

      expect(
        database
          .prepare(
            `SELECT name FROM pragma_table_info('session_transcript_index_state')
             WHERE name = 'source_generation'`,
          )
          .get(),
      ).toEqual({ name: "source_generation" });
      expect(
        database
          .prepare(
            `SELECT name FROM pragma_table_info('session_transcript_display_state')
             WHERE name = 'source_generation'`,
          )
          .get(),
      ).toEqual({ name: "source_generation" });
      expect(
        database
          .prepare(
            `SELECT
               active.source_generation AS active_source_generation,
               display.source_generation AS display_source_generation
             FROM session_transcript_index_state AS active
             JOIN session_transcript_display_state AS display
               ON display.session_id = active.session_id
             WHERE active.session_id = 'session-upgrade'`,
          )
          .get(),
      ).toEqual({
        active_source_generation: "source-generation",
        display_source_generation: "source-generation",
      });
    } finally {
      database.close();
    }
  });

  it("retries a lazy upgrade rolled back by its owner", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(priorSchema);
      database.exec("BEGIN IMMEDIATE;");
      ensureOpenClawAgentTranscriptProjectionSourceColumns(database);
      database.exec("ROLLBACK;");
      ensureOpenClawAgentTranscriptProjectionSourceColumns(database);

      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM pragma_table_info('session_transcript_index_state')
             WHERE name = 'source_generation'`,
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("drops the retired candidate binding table on the next process open", () => {
    const stateDir = tempDirs.make("openclaw-retired-projection-binding-");
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
    const initial = openOpenClawAgentDatabase(options);
    initial.db.exec(
      "CREATE TABLE session_transcript_projection_bindings (session_id TEXT) STRICT;",
    );
    closeOpenClawAgentDatabasesForTest();

    const reopened = openOpenClawAgentDatabase(options);
    expect(tableExists(reopened.db, "session_transcript_projection_bindings")).toBe(false);
  });
});

describe("agent display-row physical reopen", () => {
  it.each([
    {
      damage: `DROP TABLE ${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE};`,
      name: "partial display foundation",
    },
    {
      damage: `
        DROP TABLE ${SESSION_TRANSCRIPT_DISPLAY_ROWS_TABLE};
        DROP TABLE ${SESSION_TRANSCRIPT_DISPLAY_STATE_TABLE};
      `,
      name: "orphaned display semantics",
    },
    {
      damage: `DROP TABLE ${SESSION_TRANSCRIPT_DISPLAY_CANVAS_TABLE};`,
      name: "partial display semantics",
    },
  ])("rejects a $name after physical reopen", ({ damage }) => {
    const stateDir = tempDirs.make("openclaw-display-row-reopen-");
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
    const initial = openOpenClawAgentDatabase(options);
    const databasePath = initial.path;
    ensureOpenClawAgentDisplayRowSchema(initial.db);
    expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);

    const damaged = new DatabaseSync(databasePath);
    damaged.exec(damage);
    damaged.close();

    expect(() => openOpenClawAgentDatabase(options)).toThrow(
      /display-row (?:semantics )?schema is partially present/u,
    );
  });
});
