import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { copySqliteSessionOwnedStateForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite-import.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  replaceTranscriptEvents,
  rewriteTranscriptEventRowsExact,
  trimTranscriptForManualCompact,
} from "./session-accessor.sqlite-transcript-write.js";
import type { SessionTranscriptTurnMessageAppend } from "./session-accessor.types.js";
import {
  appendSessionTranscriptDisplayChunkInTransaction,
  claimSessionTranscriptDisplayInTransaction,
  deleteSessionTranscriptDisplayChunkInTransaction,
  finalizeSessionTranscriptDisplayInTransaction,
  invalidateSessionTranscriptDisplayInTransaction,
  prepareSessionTranscriptDisplayProjection,
  readSessionTranscriptDisplayRowsInTransaction,
  readSessionTranscriptDisplayState,
} from "./session-transcript-display.js";
import {
  plannedDisplaySnapshot,
  readDisplaySnapshot,
} from "./session-transcript-display.test-support.js";
import {
  claimPreparedSessionTranscriptProjectionInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  prepareSessionTranscriptProjection,
} from "./session-transcript-projection-rebuild.js";
import {
  reconcileSessionTranscriptDisplayProjection,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type DisplayStateRow = {
  generation: string;
  indexed_seq: number;
  needs_rebuild: number;
  row_count: number;
};

type DisplayRow = {
  display_ordinal: number;
  kind: "assistant" | "compaction" | "opaque" | "reset" | "user";
  revision: number;
  row_id: string;
  row_version: number;
  source_event_seq: number;
};

function withDisplayProjection(
  messages: readonly SessionTranscriptTurnMessageAppend[],
): SessionTranscriptTurnMessageAppend[] {
  return messages.map((message) => ({ ...message, maintainDisplayProjection: true }));
}

describe("SQLite transcript display rows", () => {
  let stateDir: string;
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-transcript-display-");
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "display-session",
      sessionKey: "agent:main:display-session",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  function database() {
    return openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  }

  function readState(sessionId = scope.sessionId): DisplayStateRow {
    const row = database()
      .db.prepare(
        `SELECT generation, indexed_seq, needs_rebuild, row_count
           FROM session_transcript_display_state
          WHERE session_id = ?`,
      )
      .get(sessionId) as DisplayStateRow | undefined;
    expect(row).toBeDefined();
    return row!;
  }

  function readRows(sessionId = scope.sessionId): DisplayRow[] {
    return database()
      .db.prepare(
        `SELECT row_id, row_version, revision, display_ordinal, source_event_seq, kind
           FROM session_transcript_display_rows
          WHERE session_id = ?
          ORDER BY display_ordinal`,
      )
      .all(sessionId) as DisplayRow[];
  }

  function readSourceIdentity(sessionId = scope.sessionId) {
    const db = database().db;
    const generation = db
      .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
      .get(sessionId) as { generation: string };
    const frontier = db
      .prepare("SELECT MAX(seq) AS indexed_seq FROM transcript_events WHERE session_id = ?")
      .get(sessionId) as { indexed_seq: number | null };
    return {
      sourceGeneration: generation.generation,
      sourceIndexedSeq: frontier.indexed_seq ?? -1,
    };
  }

  function trackDisplayGenerationWrites(sessionId: string): void {
    const db = database().db;
    readSessionTranscriptDisplayState(db, sessionId);
    db.exec(`
      CREATE TEMP TABLE tracked_display_generation_writes (
        session_id TEXT PRIMARY KEY,
        write_count INTEGER NOT NULL
      ) STRICT;
      CREATE TEMP TRIGGER track_display_generation_insert
      AFTER INSERT ON main.session_transcript_display_state
      WHEN NEW.session_id = (SELECT session_id FROM tracked_display_generation_writes)
      BEGIN
        UPDATE tracked_display_generation_writes SET write_count = write_count + 1;
      END;
      CREATE TEMP TRIGGER track_display_generation_update
      AFTER UPDATE OF generation ON main.session_transcript_display_state
      WHEN NEW.session_id = (SELECT session_id FROM tracked_display_generation_writes)
        AND OLD.generation <> NEW.generation
      BEGIN
        UPDATE tracked_display_generation_writes SET write_count = write_count + 1;
      END;
    `);
    db.prepare(
      "INSERT INTO tracked_display_generation_writes (session_id, write_count) VALUES (?, 0)",
    ).run(sessionId);
  }

  function readDisplayGenerationWrites(): number {
    const row = database()
      .db.prepare("SELECT write_count FROM tracked_display_generation_writes")
      .get() as { write_count: number };
    return row.write_count;
  }

  function readPage(
    params: { expectedGeneration: string; fromOrdinal: number | "tail"; limit: number },
    sessionId = scope.sessionId,
  ) {
    return readSessionTranscriptDisplayRowsInTransaction(database().db, sessionId, params);
  }

  async function appendPlainPair(): Promise<void> {
    await persistSessionTranscriptTurn(scope, {
      messages: withDisplayProjection([
        {
          eventId: "user-1",
          parentId: null,
          message: { role: "user", content: "hello" },
        },
        {
          eventId: "assistant-1",
          parentId: "user-1",
          message: { role: "assistant", content: "hi" },
        },
      ]),
      touchSessionEntry: false,
    });
  }

  it("keeps ordinary message appends off display maintenance until reader adoption", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "user", content: "hello" } }],
      touchSessionEntry: false,
    });

    expect(
      database()
        .db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_transcript_display_state'",
        )
        .get(),
    ).toBeUndefined();

    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });
    expect(
      database()
        .db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_transcript_display_state'",
        )
        .get(),
    ).toBeUndefined();

    const adoptedScope = {
      ...scope,
      sessionId: "adopted-display-session",
      sessionKey: "agent:main:adopted-display-session",
    };
    await persistSessionTranscriptTurn(adoptedScope, {
      messages: withDisplayProjection([{ message: { role: "user", content: "adopted" } }]),
      touchSessionEntry: false,
    });

    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "assistant", content: "still unadopted" } }],
      touchSessionEntry: false,
    });
    expect(readSessionTranscriptDisplayState(database().db, scope.sessionId)).toBeUndefined();

    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });
    expect(readSessionTranscriptDisplayState(database().db, scope.sessionId)).toBeUndefined();
  });

  it("keeps generation and existing identities stable across plain appends and no-op replay", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: withDisplayProjection([
        {
          eventId: "user-1",
          parentId: null,
          message: { role: "user", content: "hello" },
        },
      ]),
      touchSessionEntry: false,
    });
    const firstState = readState();
    const firstRows = readRows();
    expect(firstState).toMatchObject({ indexed_seq: 1, needs_rebuild: 0, row_count: 1 });
    expect(firstRows).toMatchObject([
      {
        display_ordinal: 0,
        kind: "user",
        revision: 1,
        row_version: 1,
        source_event_seq: 1,
      },
    ]);

    await persistSessionTranscriptTurn(scope, {
      messages: withDisplayProjection([
        {
          eventId: "assistant-1",
          parentId: "user-1",
          message: { role: "assistant", content: "hi" },
        },
      ]),
      touchSessionEntry: false,
    });
    const secondState = readState();
    const secondRows = readRows();
    expect(secondState).toMatchObject({ indexed_seq: 2, needs_rebuild: 0, row_count: 2 });
    expect(secondState.generation).toBe(firstState.generation);
    expect(secondRows[0]).toEqual(firstRows[0]);
    expect(secondRows.map((row) => row.display_ordinal)).toEqual([0, 1]);
    expect(secondRows[1]).toMatchObject({
      kind: "assistant",
      revision: 1,
      source_event_seq: 2,
    });

    const replay = await persistSessionTranscriptTurn(scope, {
      messages: withDisplayProjection([
        {
          eventId: "assistant-1",
          parentId: "user-1",
          message: { role: "assistant", content: "hi" },
        },
      ]),
      touchSessionEntry: false,
    });
    expect(replay.appendedCount).toBe(0);
    expect(readState()).toEqual(secondState);
    expect(readRows()).toEqual(secondRows);
  });

  it("resets a ready display when its source generation is stale", async () => {
    await appendPlainPair();
    const ready = readState();
    database()
      .db.prepare(
        `UPDATE session_transcript_display_state
         SET source_generation = 'stale-source'
         WHERE session_id = ?`,
      )
      .run(scope.sessionId);

    expect(
      readPage({
        expectedGeneration: ready.generation,
        fromOrdinal: 0,
        limit: 10,
      }),
    ).toEqual({ generation: ready.generation, kind: "reset" });
  });

  it("rotates on a boundary and publishes one dense rebuilt generation", async () => {
    await appendPlainPair();
    const before = readState();

    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-1",
      parentId: "assistant-1",
      timestamp: "2026-08-19T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "user-1",
    });

    const rebuilding = readState();
    expect(rebuilding.generation).not.toBe(before.generation);
    expect(rebuilding.needs_rebuild).toBe(1);
    expect(
      readPage({
        expectedGeneration: before.generation,
        fromOrdinal: 0,
        limit: 10,
      }),
    ).toEqual({ generation: rebuilding.generation, kind: "reset" });

    await reconcileSessionTranscriptDisplayProjection({
      agentId: scope.agentId,
      env: scope.env,
    });

    const ready = readState();
    const rows = readRows();
    expect(ready).toMatchObject({
      generation: rebuilding.generation,
      needs_rebuild: 0,
      row_count: rows.length,
    });
    expect(rows.map((row) => row.display_ordinal)).toEqual(rows.map((_, index) => index));
    expect(rows.at(-1)?.kind).toBe("reset");
  });

  it("returns bounded ready pages or a generation reset, never dirty rows", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: withDisplayProjection([
        { eventId: "m1", parentId: null, message: { role: "user", content: "one" } },
        {
          eventId: "m2",
          parentId: "m1",
          message: { role: "assistant", content: "two" },
        },
        { eventId: "m3", parentId: "m2", message: { role: "user", content: "three" } },
      ]),
      touchSessionEntry: false,
    });
    const generation = readState().generation;

    expect(
      readPage({
        expectedGeneration: generation,
        fromOrdinal: 0,
        limit: 1,
      }),
    ).toMatchObject({
      generation,
      kind: "ready",
      nextOrdinal: 1,
      rows: [{ displayOrdinal: 0, kind: "user" }],
    });
    expect(
      readPage({
        expectedGeneration: "stale-generation",
        fromOrdinal: 0,
        limit: 10,
      }),
    ).toEqual({ generation, kind: "reset" });
    expect(
      readPage({
        expectedGeneration: generation,
        fromOrdinal: "tail",
        limit: 2,
      }),
    ).toMatchObject({
      generation,
      kind: "ready",
      rows: [
        { displayOrdinal: 1, kind: "assistant" },
        { displayOrdinal: 2, kind: "user" },
      ],
    });
    const normalizedBounds = readPage({
      expectedGeneration: generation,
      fromOrdinal: Number.NaN,
      limit: Number.MAX_SAFE_INTEGER,
    });
    expect(normalizedBounds.kind).toBe("ready");
    expect(normalizedBounds.kind === "ready" ? normalizedBounds.rows : []).toHaveLength(3);

    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "compaction-1",
      parentId: "m3",
      timestamp: "2026-08-19T00:00:00.000Z",
      summary: "boundary",
      firstKeptEntryId: "m1",
      tokensBefore: 10,
    });
    const rebuilding = readState();
    expect(
      readPage({
        expectedGeneration: rebuilding.generation,
        fromOrdinal: 0,
        limit: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ generation: rebuilding.generation, kind: "reset" });
  });

  it("rejects stale row and companion chunks, then publishes one fresh retry", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "assistant-target",
          parentId: null,
          message: { role: "assistant", content: "Spoken answer" },
        },
        {
          eventId: "tts-supplement",
          parentId: "assistant-target",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Audio reply" },
              { type: "audio", url: "/media/tts.mp3" },
            ],
            openclawTtsSupplement: { spokenText: "Spoken answer" },
          },
        },
      ],
      touchSessionEntry: false,
    });
    const sourceRows = database()
      .db.prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(scope.sessionId)
      .map((entry) => {
        const source = entry as { event_json: string; seq: number };
        return { event: JSON.parse(source.event_json), seq: source.seq };
      });
    const plan = prepareSessionTranscriptDisplayProjection(sourceRows);
    const source = readSourceIdentity();
    expect(plan.rows[0]?.semanticSources).toMatchObject([
      { relation: "tts_supplement", sourceEventSeq: 2 },
    ]);

    const firstGeneration = runOpenClawAgentWriteTransaction(
      (agentDatabase) =>
        invalidateSessionTranscriptDisplayInTransaction(agentDatabase.db, scope.sessionId),
      { agentId: scope.agentId, env: scope.env },
    );
    const firstClaim = 101;
    runOpenClawAgentWriteTransaction(
      (agentDatabase) => {
        expect(
          claimSessionTranscriptDisplayInTransaction(agentDatabase.db, {
            claimId: firstClaim,
            generation: firstGeneration,
            previousGeneration: firstGeneration,
            sessionId: scope.sessionId,
          }),
        ).toBe(true);
        let deleted;
        do {
          deleted = deleteSessionTranscriptDisplayChunkInTransaction(agentDatabase.db, {
            claimId: firstClaim,
            generation: firstGeneration,
            maxRows: 1,
            sessionId: scope.sessionId,
            ...source,
          });
          expect(deleted.owned).toBe(true);
        } while (deleted.hasMore);
        expect(
          appendSessionTranscriptDisplayChunkInTransaction(agentDatabase.db, {
            claimId: firstClaim,
            generation: firstGeneration,
            rows: plan.rows.slice(0, 1),
            sessionId: scope.sessionId,
            ...source,
          }),
        ).toBe(true);
      },
      { agentId: scope.agentId, env: scope.env },
    );

    const retryGeneration = runOpenClawAgentWriteTransaction(
      (agentDatabase) =>
        invalidateSessionTranscriptDisplayInTransaction(agentDatabase.db, scope.sessionId),
      { agentId: scope.agentId, env: scope.env },
    );
    runOpenClawAgentWriteTransaction(
      (agentDatabase) => {
        expect(
          appendSessionTranscriptDisplayChunkInTransaction(agentDatabase.db, {
            claimId: firstClaim,
            generation: firstGeneration,
            rows: plan.rows.slice(1),
            sessionId: scope.sessionId,
            ...source,
          }),
        ).toBe(false);
        expect(
          finalizeSessionTranscriptDisplayInTransaction(agentDatabase.db, {
            carry: plan.carry,
            claimId: firstClaim,
            generation: firstGeneration,
            rowCount: plan.rows.length,
            sessionId: scope.sessionId,
            ...source,
          }),
        ).toBe(false);
      },
      { agentId: scope.agentId, env: scope.env },
    );
    expect(
      readPage({
        expectedGeneration: firstGeneration,
        fromOrdinal: 0,
        limit: 10,
      }),
    ).toEqual({ generation: retryGeneration, kind: "reset" });

    const retryClaim = 202;
    runOpenClawAgentWriteTransaction(
      (agentDatabase) => {
        expect(
          claimSessionTranscriptDisplayInTransaction(agentDatabase.db, {
            claimId: retryClaim,
            generation: retryGeneration,
            previousGeneration: retryGeneration,
            sessionId: scope.sessionId,
          }),
        ).toBe(true);
        let deleted;
        do {
          deleted = deleteSessionTranscriptDisplayChunkInTransaction(agentDatabase.db, {
            claimId: retryClaim,
            generation: retryGeneration,
            maxRows: 1,
            sessionId: scope.sessionId,
            ...source,
          });
        } while (deleted.hasMore);
        expect(
          appendSessionTranscriptDisplayChunkInTransaction(agentDatabase.db, {
            claimId: retryClaim,
            generation: retryGeneration,
            rows: plan.rows,
            sessionId: scope.sessionId,
            ...source,
          }),
        ).toBe(true);
        expect(
          finalizeSessionTranscriptDisplayInTransaction(agentDatabase.db, {
            carry: plan.carry,
            claimId: retryClaim,
            generation: retryGeneration,
            rowCount: plan.rows.length,
            sessionId: scope.sessionId,
            ...source,
          }),
        ).toBe(true);
      },
      { agentId: scope.agentId, env: scope.env },
    );
    expect(
      readPage({
        expectedGeneration: retryGeneration,
        fromOrdinal: 0,
        limit: 10,
      }),
    ).toMatchObject({
      generation: retryGeneration,
      kind: "ready",
      rows: [{ kind: "assistant", revision: 2, sourceEventSeq: 1 }],
    });
    expect(
      database()
        .db.prepare(
          "SELECT relation, source_event_seq FROM session_transcript_display_row_sources WHERE session_id = ?",
        )
        .all(scope.sessionId),
    ).toEqual([{ relation: "tts_supplement", source_event_seq: 2 }]);
    expect(
      database()
        .db.prepare(
          "SELECT kind, position, source_event_seq, source_occurrence, related_event_seq FROM session_transcript_display_carry WHERE session_id = ?",
        )
        .all(scope.sessionId),
    ).toEqual([
      {
        kind: "tts_candidate",
        position: 0,
        related_event_seq: null,
        source_event_seq: 1,
        source_occurrence: 0,
      },
    ]);
  });

  it("rotates a lag rebuild identity in its claim before replacing rows", async () => {
    await appendPlainPair();
    const before = readState();
    const beforeRows = readRows();
    const resolved = resolveSqliteTranscriptScope(scope);
    runOpenClawAgentWriteTransaction(
      (agentDatabase) => {
        expect(
          appendTranscriptEventInTransaction(
            agentDatabase,
            resolved,
            {
              type: "message",
              id: "lagged-assistant",
              parentId: "assistant-1",
              message: { role: "assistant", content: "lagged" },
            },
            { maintainDisplayProjection: false, scheduleProjectionReconcile: false },
          ),
        ).toBe(true);
      },
      { agentId: scope.agentId, env: scope.env },
    );
    const plan = prepareSessionTranscriptProjection(database().db, scope.sessionId, {
      includeDisplayProjection: true,
    });
    expect(plan).toMatchObject({
      activeNeedsRebuild: false,
      displayNeedsRebuild: true,
      displayPreviousGeneration: before.generation,
    });
    expect(plan?.displayGeneration).not.toBe(before.generation);

    const claimId = -404;
    runOpenClawAgentWriteTransaction(
      (agentDatabase) => {
        expect(
          claimPreparedSessionTranscriptProjectionInTransaction(agentDatabase.db, plan!, claimId),
        ).toBe(true);
        expect(readSessionTranscriptDisplayState(agentDatabase.db, scope.sessionId)).toMatchObject({
          generation: plan!.displayGeneration,
          needsRebuild: true,
          updatedAt: claimId,
        });
        expect(readRows()).toEqual(beforeRows);
      },
      { agentId: scope.agentId, env: scope.env },
    );
    expect(readPage({ expectedGeneration: before.generation, fromOrdinal: 0, limit: 10 })).toEqual({
      generation: plan!.displayGeneration,
      kind: "reset",
    });

    const source = {
      sourceGeneration: plan!.sourceGeneration,
      sourceIndexedSeq: plan!.sourceIndexedSeq,
    };
    runOpenClawAgentWriteTransaction(
      (agentDatabase) => {
        let deleted;
        do {
          deleted = deleteSessionTranscriptDisplayChunkInTransaction(agentDatabase.db, {
            claimId,
            generation: plan!.displayGeneration,
            maxRows: 1,
            sessionId: scope.sessionId,
            ...source,
          });
          expect(deleted.owned).toBe(true);
        } while (deleted.hasMore);
        expect(
          appendSessionTranscriptDisplayChunkInTransaction(agentDatabase.db, {
            claimId,
            generation: plan!.displayGeneration,
            rows: plan!.displayRows,
            sessionId: scope.sessionId,
            ...source,
          }),
        ).toBe(true);
        expect(
          finalizePreparedSessionTranscriptProjectionInTransaction(
            agentDatabase.db,
            plan!,
            claimId,
          ),
        ).toBe(true);
      },
      { agentId: scope.agentId, env: scope.env },
    );

    expect(
      readDisplaySnapshot({ agentId: scope.agentId, env: scope.env }, scope.sessionId),
    ).toEqual(
      plannedDisplaySnapshot(
        database()
          .db.prepare(
            "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all(scope.sessionId)
          .map((entry) => {
            const row = entry as { created_at: number; event_json: string; seq: number };
            return { createdAt: row.created_at, event: JSON.parse(row.event_json), seq: row.seq };
          }),
      ),
    );
    expect(readRows().map((row) => row.display_ordinal)).toEqual(
      readRows().map((_, index) => index),
    );
  });

  it("publishes an empty ready generation after clearing a transcript", async () => {
    await appendPlainPair();
    const before = readState();

    await replaceTranscriptEvents(scope, []);
    const rebuilding = readState();
    expect(rebuilding.generation).not.toBe(before.generation);
    expect(rebuilding.needs_rebuild).toBe(1);

    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });
    const ready = readState();
    expect(ready).toMatchObject({ indexed_seq: -1, needs_rebuild: 0, row_count: 0 });
    expect(readRows()).toEqual([]);
    expect(
      readPage({
        expectedGeneration: ready.generation,
        fromOrdinal: 0,
        limit: 10,
      }),
    ).toEqual({ generation: ready.generation, kind: "ready", rows: [] });
  });

  it("rotates once when a full replacement contains a display boundary", async () => {
    await appendPlainPair();
    trackDisplayGenerationWrites(scope.sessionId);

    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId },
      {
        type: "message",
        id: "replacement-user",
        parentId: null,
        message: { role: "user", content: "replacement" },
      },
      {
        type: "reset",
        id: "replacement-reset",
        parentId: "replacement-user",
        timestamp: "2026-08-19T00:00:00.000Z",
        reason: "new",
        firstKeptEntryId: "replacement-user",
      },
    ]);

    expect(readDisplayGenerationWrites()).toBe(1);
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });
    expect(readState()).toMatchObject({
      indexed_seq: 2,
      needs_rebuild: 0,
      row_count: 2,
    });
    expect(readRows()).toMatchObject([
      { display_ordinal: 0, kind: "user", source_event_seq: 1 },
      { display_ordinal: 1, kind: "reset", source_event_seq: 2 },
    ]);
  });

  it("rotates and rebuilds after an exact rewrite and manual compaction", async () => {
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    await appendPlainPair();
    const beforeRewrite = readState();
    const eventRow = database()
      .db.prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 2")
      .get(scope.sessionId) as { event_json: string };
    const rewritten = JSON.parse(eventRow.event_json) as Record<string, unknown>;
    rewritten.message = { role: "assistant", content: "rewritten" };
    const transcriptGeneration = database()
      .db.prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
      .get(scope.sessionId) as { generation: string };

    await rewriteTranscriptEventRowsExact(scope, {
      expectedGeneration: transcriptGeneration.generation,
      rows: [
        {
          event: rewritten,
          expectedEventJson: eventRow.event_json,
          seq: 2,
        },
      ],
    });
    const rewriteGeneration = readState();
    expect(rewriteGeneration.generation).not.toBe(beforeRewrite.generation);
    expect(rewriteGeneration.needs_rebuild).toBe(1);
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

    const beforeCompact = readState();
    const compacted = await trimTranscriptForManualCompact(scope, (lines) => lines.slice(-2));
    expect(compacted).toMatchObject({ trimmed: true });
    const compactGeneration = readState();
    expect(compactGeneration.generation).not.toBe(beforeCompact.generation);
    expect(compactGeneration.needs_rebuild).toBe(1);
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });
    expect(readState().needs_rebuild).toBe(0);
  });

  it.each([
    {
      expectedIndexedSeq: 2,
      expectedRows: [
        { display_ordinal: 0, kind: "user", source_event_seq: 1 },
        { display_ordinal: 1, kind: "reset", source_event_seq: 2 },
      ],
      name: "parsed",
      source: {
        readTranscriptEvents: (append: (event: unknown) => void) => {
          append({ type: "session", id: "imported-session" });
          append({
            type: "message",
            id: "imported-user",
            parentId: null,
            message: { role: "user", content: "parsed import" },
          });
          append({
            type: "reset",
            id: "imported-reset",
            parentId: "imported-user",
            timestamp: "2026-08-19T00:00:00.000Z",
            reason: "new",
            firstKeptEntryId: "imported-user",
          });
        },
      },
    },
    {
      expectedIndexedSeq: 1,
      expectedRows: [{ display_ordinal: 0, kind: "user", source_event_seq: 1 }],
      name: "byte-exact",
      source: {
        readExactTranscriptRows: (
          append: (row: { createdAt: number; eventJson: string }) => void,
        ) => {
          append({
            createdAt: 1,
            eventJson: JSON.stringify({ type: "session", id: "imported-session" }),
          });
          append({
            createdAt: 2,
            eventJson: JSON.stringify({
              type: "message",
              id: "imported-user",
              parentId: null,
              message: { role: "user", content: "exact import" },
            }),
          });
        },
      },
    },
  ])(
    "rebuilds adopted display rows after a $name legacy import",
    async ({ expectedIndexedSeq, expectedRows, source }) => {
      const importedScope = {
        agentId: scope.agentId,
        env: scope.env,
        sessionId: "imported-session",
        sessionKey: "agent:main:imported-session",
      };
      await upsertSessionEntryCore(importedScope, {
        sessionId: importedScope.sessionId,
        updatedAt: 0,
      });
      runOpenClawAgentWriteTransaction(
        (agentDatabase) =>
          invalidateSessionTranscriptDisplayInTransaction(
            agentDatabase.db,
            importedScope.sessionId,
          ),
        { agentId: importedScope.agentId, env: importedScope.env },
      );
      trackDisplayGenerationWrites(importedScope.sessionId);
      await importSqliteSessionRows({
        agentId: importedScope.agentId,
        env: importedScope.env,
        entry: { sessionId: importedScope.sessionId, updatedAt: 1 },
        sessionKey: importedScope.sessionKey,
        ...source,
      });

      expect(readDisplayGenerationWrites()).toBe(1);
      expect(readState(importedScope.sessionId).needs_rebuild).toBe(1);
      await waitForSessionTranscriptIndexReconcile({
        agentId: importedScope.agentId,
        env: importedScope.env,
      });
      expect(readState(importedScope.sessionId)).toMatchObject({
        indexed_seq: expectedIndexedSeq,
        needs_rebuild: 0,
        row_count: expectedRows.length,
      });
      expect(readRows(importedScope.sessionId)).toMatchObject(expectedRows);
    },
  );

  it.each([
    { destinationMessages: 1, name: "equal-length" },
    { destinationMessages: 2, name: "shorter" },
  ])(
    "rebuilds display rows when a canonical cross-store replacement is $name",
    async ({ destinationMessages }) => {
      const destinationEvents = [
        {
          eventId: "destination-user",
          parentId: null,
          message: { role: "user" as const, content: "stale destination" },
        },
        {
          eventId: "destination-assistant",
          parentId: "destination-user",
          message: { role: "assistant" as const, content: "stale destination reply" },
        },
      ].slice(0, destinationMessages);
      await persistSessionTranscriptTurn(scope, {
        messages: withDisplayProjection(destinationEvents),
        touchSessionEntry: false,
      });
      const before = readState();
      const beforeRows = readRows();

      const sourceScope = {
        agentId: "source",
        env: scope.env,
        sessionId: scope.sessionId,
        sessionKey: "agent:source:display-session",
      };
      const sourceEntry = { sessionId: sourceScope.sessionId, updatedAt: 2 };
      await upsertSessionEntryCore(sourceScope, sourceEntry);
      await persistSessionTranscriptTurn(sourceScope, {
        messages: withDisplayProjection([
          {
            eventId: "source-assistant",
            parentId: null,
            message: { role: "assistant", content: "canonical source" },
          },
        ]),
        touchSessionEntry: false,
      });
      const sourceDatabase = openOpenClawAgentDatabase({
        agentId: sourceScope.agentId,
        env: sourceScope.env,
      });

      runOpenClawAgentWriteTransaction(
        (destinationDatabase) =>
          copySqliteSessionOwnedStateForCanonicalRepair({
            canonicalKey: scope.sessionKey,
            destinationDatabase,
            preferredEntry: sourceEntry,
            preferredSessionKey: sourceScope.sessionKey,
            source: {
              agentId: sourceScope.agentId,
              storePath: sourceDatabase.path,
            },
            sourceEntries: [sourceEntry],
            sourceKeys: [sourceScope.sessionKey],
          }),
        { agentId: scope.agentId, env: scope.env },
      );

      const rebuilding = readState();
      expect(rebuilding.generation).not.toBe(before.generation);
      expect(rebuilding.needs_rebuild).toBe(1);
      expect(
        readPage({
          expectedGeneration: before.generation,
          fromOrdinal: 0,
          limit: 10,
        }),
      ).toEqual({ generation: rebuilding.generation, kind: "reset" });

      await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

      const ready = readState();
      const rows = readRows();
      expect(ready).toMatchObject({
        generation: rebuilding.generation,
        indexed_seq: 1,
        needs_rebuild: 0,
        row_count: 1,
      });
      expect(rows).toMatchObject([
        {
          display_ordinal: 0,
          kind: "assistant",
          source_event_seq: 1,
        },
      ]);
      expect(rows[0]?.row_id).not.toBe(beforeRows[0]?.row_id);
    },
  );
});
