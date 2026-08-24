import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionTranscriptMessageEventCount } from "./session-accessor.sqlite-active-events.js";
import { ensureSqliteTranscriptGenerationsForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite-import.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import {
  appendSessionTranscriptDisplayChunkInTransaction,
  deleteSessionTranscriptDisplayChunkInTransaction,
} from "./session-transcript-display.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import {
  abandonPreparedSessionTranscriptProjectionInTransaction,
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  claimPreparedSessionTranscriptProjectionInTransaction,
  deletePreparedSessionTranscriptProjectionChunkInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  prepareSessionTranscriptProjection,
} from "./session-transcript-projection-rebuild.js";
import { reconcileSessionTranscriptIndexes } from "./session-transcript-reconcile.js";
import { replaceSessionTranscriptSourceGenerationInTransaction } from "./session-transcript-source-generation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function createScope(name: string) {
  return {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make(`openclaw-source-generation-${name}-`) },
    sessionId: `session-${name}`,
    sessionKey: `agent:main:${name}`,
  };
}

function readGeneration(scope: ReturnType<typeof createScope>): string | undefined {
  return (
    openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env })
      .db.prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
      .get(scope.sessionId) as { generation: string } | undefined
  )?.generation;
}

describe("session transcript source generation", () => {
  it("keeps an empty replacement for an absent session as a no-op", async () => {
    const scope = createScope("absent-empty-replacement");
    await replaceTranscriptEvents(scope, []);

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    expect(
      database.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM session_windows WHERE session_id = ?) AS windows,
             (SELECT COUNT(*) FROM transcript_rewrite_watermarks WHERE session_id = ?) AS generations,
             (SELECT COUNT(*) FROM sqlite_schema
              WHERE type = 'table' AND name = 'session_transcript_display_state') AS display_tables`,
        )
        .get(scope.sessionId, scope.sessionId),
    ).toEqual({ display_tables: 0, generations: 0, windows: 0 });
  });

  it("owns an empty generation and rotates it once for an empty replacement", async () => {
    const scope = createScope("empty-replacement");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const initial = readGeneration(scope);
    expect(initial).toMatch(/^[0-9a-f]{32}$/u);

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db.exec(`
      CREATE TEMP TABLE tracked_source_generation_writes (write_count INTEGER NOT NULL);
      INSERT INTO tracked_source_generation_writes (write_count) VALUES (0);
      CREATE TEMP TRIGGER track_source_generation_insert
      AFTER INSERT ON transcript_rewrite_watermarks
      WHEN NEW.session_id = '${scope.sessionId}'
      BEGIN
        UPDATE tracked_source_generation_writes SET write_count = write_count + 1;
      END;
      CREATE TEMP TRIGGER track_source_generation_update
      AFTER UPDATE ON transcript_rewrite_watermarks
      WHEN NEW.session_id = '${scope.sessionId}'
      BEGIN
        UPDATE tracked_source_generation_writes SET write_count = write_count + 1;
      END;
    `);

    await replaceTranscriptEvents(scope, []);

    expect(readGeneration(scope)).toMatch(/^[0-9a-f]{32}$/u);
    expect(readGeneration(scope)).not.toBe(initial);
    expect(
      database.db.prepare("SELECT write_count FROM tracked_source_generation_writes").get(),
    ).toEqual({ write_count: 1 });
  });

  it("gives an empty legacy import an authoritative generation", async () => {
    const scope = createScope("empty-import");
    await importSqliteSessionRows({
      agentId: scope.agentId,
      env: scope.env,
      entry: { sessionId: scope.sessionId, updatedAt: 10 },
      sessionKey: scope.sessionKey,
    });

    expect(readGeneration(scope)).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("repairs the generation of an empty legacy canonical source", async () => {
    const scope = createScope("empty-canonical-repair");
    const entry = { sessionId: scope.sessionId, updatedAt: 10 };
    await upsertSessionEntryCore(scope, entry);
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db
      .prepare("DELETE FROM transcript_rewrite_watermarks WHERE session_id = ?")
      .run(scope.sessionId);

    await ensureSqliteTranscriptGenerationsForCanonicalRepair([
      {
        agentId: scope.agentId,
        entry,
        sessionKey: scope.sessionKey,
        storePath: database.path,
      },
    ]);

    expect(readGeneration(scope)).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("publishes source ownership with active and display projection state", async () => {
    const scope = createScope("projection-source-ownership");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });

    await appendTranscriptMessage(scope, {
      maintainDisplayProjection: true,
      message: { role: "user", content: "projection source" },
    });

    const sourceGeneration = readGeneration(scope);
    expect(
      database.db
        .prepare(
          `SELECT
             active.source_generation AS active_source_generation,
             display.source_generation AS display_source_generation,
             display.generation AS display_generation
           FROM session_transcript_index_state AS active
           JOIN session_transcript_display_state AS display
             ON display.session_id = active.session_id
           WHERE active.session_id = ?`,
        )
        .get(scope.sessionId),
    ).toEqual({
      active_source_generation: sourceGeneration,
      display_generation: expect.stringMatching(/^[0-9a-f]{32}$/u),
      display_source_generation: sourceGeneration,
    });
  });

  it("rejects prepared work after a same-sequence source replacement", async () => {
    const scope = createScope("stale-preparation");
    await appendTranscriptMessage(scope, {
      maintainDisplayProjection: true,
      message: { role: "user", content: "prepared source" },
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db.exec(`
      UPDATE session_transcript_index_state
      SET needs_rebuild = 1
      WHERE session_id = '${scope.sessionId}';
      UPDATE session_transcript_display_state
      SET needs_rebuild = 1
      WHERE session_id = '${scope.sessionId}';
    `);
    const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
    expect(plan).toBeDefined();

    runOpenClawAgentWriteTransaction(
      (writeDatabase) => {
        replaceSessionTranscriptSourceGenerationInTransaction(writeDatabase, scope.sessionId);
        expect(
          writeDatabase.db
            .prepare(
              `SELECT
                 active.source_generation AS active_source_generation,
                 display.source_generation AS display_source_generation
               FROM session_transcript_index_state AS active
               JOIN session_transcript_display_state AS display
                 ON display.session_id = active.session_id
               WHERE active.session_id = ?`,
            )
            .get(scope.sessionId),
        ).toEqual({ active_source_generation: null, display_source_generation: null });
        expect(
          claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -101),
        ).toBe(false);
      },
      { agentId: scope.agentId, env: scope.env },
    );
  });

  it("rejects final publication after a same-sequence source replacement", async () => {
    const scope = createScope("stale-finalization");
    await appendTranscriptMessage(scope, {
      maintainDisplayProjection: true,
      message: { role: "user", content: "claimed source" },
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db.exec(`
      UPDATE session_transcript_index_state
      SET needs_rebuild = 1
      WHERE session_id = '${scope.sessionId}';
      UPDATE session_transcript_display_state
      SET needs_rebuild = 1
      WHERE session_id = '${scope.sessionId}';
    `);
    const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
    expect(plan).toBeDefined();
    runOpenClawAgentWriteTransaction(
      (writeDatabase) => {
        expect(
          claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -202),
        ).toBe(true);
      },
      { agentId: scope.agentId, env: scope.env },
    );

    runOpenClawAgentWriteTransaction(
      (writeDatabase) => {
        replaceSessionTranscriptSourceGenerationInTransaction(writeDatabase, scope.sessionId);
        expect(
          finalizePreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -202),
        ).toBe(false);
      },
      { agentId: scope.agentId, env: scope.env },
    );
  });

  it("does not forward-publish rows from an unbound projection", async () => {
    const scope = createScope("stale-forward-append");
    const initial = await appendTranscriptMessage(scope, {
      maintainDisplayProjection: true,
      message: { role: "user", content: "bound source" },
    });
    expect(initial).toBeDefined();
    const options = { agentId: scope.agentId, env: scope.env };
    const resolved = resolveSqliteTranscriptScope(scope);
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      replaceSessionTranscriptSourceGenerationInTransaction(writeDatabase, scope.sessionId);
      expect(
        appendTranscriptEventInTransaction(
          writeDatabase,
          resolved,
          {
            id: "stale-forward",
            message: { role: "assistant", content: "must rebuild" },
            parentId: initial!.messageId,
            type: "message",
          },
          { scheduleProjectionReconcile: false },
        ),
      ).toBe(true);
    }, options);

    const database = openOpenClawAgentDatabase(options);
    expect(
      database.db
        .prepare(
          `SELECT
             (SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?) AS active_needs_rebuild,
             (SELECT source_generation FROM session_transcript_index_state WHERE session_id = ?) AS active_source_generation,
             (SELECT needs_rebuild FROM session_transcript_display_state WHERE session_id = ?) AS display_needs_rebuild,
             (SELECT source_generation FROM session_transcript_display_state WHERE session_id = ?) AS display_source_generation`,
        )
        .get(scope.sessionId, scope.sessionId, scope.sessionId, scope.sessionId),
    ).toEqual({
      active_needs_rebuild: 1,
      active_source_generation: null,
      display_needs_rebuild: 1,
      display_source_generation: null,
    });
  });

  it.each(["generation", "frontier"] as const)(
    "rejects every claimed chunk after the source %s changes",
    async (change) => {
      const scope = createScope(`stale-chunks-${change}`);
      await appendTranscriptMessage(scope, {
        maintainDisplayProjection: true,
        message: { role: "user", content: "claimed source" },
      });
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
      database.db.exec(`
        UPDATE session_transcript_index_state
        SET needs_rebuild = 1
        WHERE session_id = '${scope.sessionId}';
      `);
      const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
      expect(plan).toBeDefined();
      const claimId = -303;
      runOpenClawAgentWriteTransaction(
        (writeDatabase) => {
          expect(
            claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, claimId),
          ).toBe(true);
        },
        { agentId: scope.agentId, env: scope.env },
      );

      runOpenClawAgentWriteTransaction(
        (writeDatabase) => {
          if (change === "generation") {
            replaceSessionTranscriptSourceGenerationInTransaction(writeDatabase, scope.sessionId);
          } else {
            writeDatabase.db
              .prepare(
                "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
              )
              .run(
                scope.sessionId,
                plan!.sourceIndexedSeq + 1,
                JSON.stringify({ type: "message", id: "raced" }),
                Date.now(),
              );
          }
          const before = writeDatabase.db
            .prepare(
              `SELECT
                 (SELECT COUNT(*) FROM session_transcript_active_events WHERE session_id = ?) AS active_count,
                 (SELECT COUNT(*) FROM session_transcript_fts WHERE session_id = ?) AS fts_count,
                 (SELECT COUNT(*) FROM session_transcript_display_rows WHERE session_id = ?) AS display_count`,
            )
            .get(scope.sessionId, scope.sessionId, scope.sessionId);
          const source = {
            sourceGeneration: plan!.sourceGeneration,
            sourceIndexedSeq: plan!.sourceIndexedSeq,
          };

          expect(
            deletePreparedSessionTranscriptProjectionChunkInTransaction(writeDatabase.db, {
              claimId,
              maxRowsPerTable: 1,
              sessionId: scope.sessionId,
              ...source,
            }),
          ).toEqual({ hasMore: false, owned: false });
          expect(
            appendPreparedSessionTranscriptProjectionChunkInTransaction(writeDatabase.db, {
              activeRows: plan!.activeRows,
              claimId,
              ftsRows: plan!.ftsRows,
              sessionId: scope.sessionId,
              ...source,
            }),
          ).toBe(false);
          expect(
            deleteSessionTranscriptDisplayChunkInTransaction(writeDatabase.db, {
              claimId,
              generation: plan!.displayGeneration,
              maxRows: 1,
              sessionId: scope.sessionId,
              ...source,
            }),
          ).toEqual({ hasMore: false, owned: false });
          expect(
            appendSessionTranscriptDisplayChunkInTransaction(writeDatabase.db, {
              claimId,
              generation: plan!.displayGeneration,
              rows: plan!.displayRows,
              sessionId: scope.sessionId,
              ...source,
            }),
          ).toBe(false);
          expect(
            finalizePreparedSessionTranscriptProjectionInTransaction(
              writeDatabase.db,
              plan!,
              claimId,
            ),
          ).toBe(false);
          expect(
            writeDatabase.db
              .prepare(
                `SELECT
                   (SELECT COUNT(*) FROM session_transcript_active_events WHERE session_id = ?) AS active_count,
                   (SELECT COUNT(*) FROM session_transcript_fts WHERE session_id = ?) AS fts_count,
                   (SELECT COUNT(*) FROM session_transcript_display_rows WHERE session_id = ?) AS display_count`,
              )
              .get(scope.sessionId, scope.sessionId, scope.sessionId),
          ).toEqual(before);
        },
        { agentId: scope.agentId, env: scope.env },
      );
    },
  );

  it("does not let delayed abandonment invalidate a newer publication", async () => {
    const scope = createScope("delayed-abandonment");
    await appendTranscriptMessage(scope, {
      maintainDisplayProjection: true,
      message: { role: "user", content: "fresh owner" },
    });
    const options = { agentId: scope.agentId, env: scope.env };
    const database = openOpenClawAgentDatabase(options);
    database.db.exec(`
      UPDATE session_transcript_index_state
      SET needs_rebuild = 1
      WHERE session_id = '${scope.sessionId}';
      UPDATE session_transcript_display_state
      SET needs_rebuild = 1
      WHERE session_id = '${scope.sessionId}';
    `);
    const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
    expect(plan).toBeDefined();

    runOpenClawAgentWriteTransaction((writeDatabase) => {
      expect(
        claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -501),
      ).toBe(true);
      expect(
        claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -502),
      ).toBe(true);
      expect(
        finalizePreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -502),
      ).toBe(true);
      abandonPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -501);
    }, options);

    expect(
      database.db
        .prepare(
          `SELECT
             active.source_generation AS active_source_generation,
             display.source_generation AS display_source_generation
           FROM session_transcript_index_state AS active
           JOIN session_transcript_display_state AS display
             ON display.session_id = active.session_id
           WHERE active.session_id = ?`,
        )
        .get(scope.sessionId),
    ).toEqual({
      active_source_generation: plan!.sourceGeneration,
      display_source_generation: plan!.sourceGeneration,
    });
  });

  it.each(["failed", "done", "error", "exit", "rejected-continuation"] as const)(
    "abandons a claimed projection after worker %s and permits a fresh retry",
    async (terminal) => {
      const scope = createScope(`worker-${terminal}`);
      await persistSessionTranscriptTurn(scope, {
        messages: [
          {
            eventId: "seed",
            maintainDisplayProjection: true,
            message: { role: "user", content: "seed" },
          },
        ],
        touchSessionEntry: false,
      });
      const databaseOptions = { agentId: scope.agentId, env: scope.env };
      const database = openOpenClawAgentDatabase(databaseOptions);
      database.db.exec(`
        UPDATE session_transcript_index_state
        SET needs_rebuild = 1
        WHERE session_id = '${scope.sessionId}';
        UPDATE session_transcript_display_state
        SET needs_rebuild = 1
        WHERE session_id = '${scope.sessionId}';
      `);
      const prepared = prepareSessionTranscriptProjection(database.db, scope.sessionId);
      expect(prepared).toBeDefined();
      const {
        activeRows: _activeRows,
        displayRows: _displayRows,
        ftsRows: _ftsRows,
        ...plan
      } = prepared!;
      const worker = Object.assign(new EventEmitter(), {
        postMessage: vi.fn((message: { accepted: boolean; type: "continue" }) => {
          if (!message.accepted) {
            queueMicrotask(() => {
              worker.emit("message", { type: "done" });
              worker.emit("exit", 0);
            });
            return;
          }
          queueMicrotask(() => {
            if (terminal === "failed") {
              worker.emit("message", { error: "injected worker failure", type: "failed" });
            } else if (terminal === "done") {
              worker.emit("message", { type: "done" });
              worker.emit("exit", 0);
            } else if (terminal === "error") {
              worker.emit("error", new Error("injected worker error"));
            } else if (terminal === "exit") {
              worker.emit("exit", 7);
            } else {
              runOpenClawAgentWriteTransaction((writeDatabase) => {
                replaceSessionTranscriptSourceGenerationInTransaction(
                  writeDatabase,
                  scope.sessionId,
                );
              }, databaseOptions);
              worker.emit("message", {
                rows: prepared!.activeRows.slice(0, 1),
                sessionId: scope.sessionId,
                type: "active-chunk",
              });
            }
          });
        }),
        terminate: vi.fn(async () => 0),
      });
      const createWorker = vi.fn(() => {
        queueMicrotask(() => worker.emit("message", { plan, type: "plan-start" }));
        return worker as unknown as Worker;
      });

      const outcome = reconcileSessionTranscriptIndexes({
        ...databaseOptions,
        createWorker,
      });
      if (terminal === "rejected-continuation") {
        await expect(outcome).resolves.toEqual({ reconciledSessions: 0 });
      } else {
        await expect(outcome).rejects.toThrow();
      }
      expect(createWorker).toHaveBeenCalledTimes(1);
      const abandoned = database.db
        .prepare(
          `SELECT
             (SELECT updated_at FROM session_transcript_index_state WHERE session_id = ?) AS active_claim,
             (SELECT source_generation FROM session_transcript_index_state WHERE session_id = ?) AS active_source_generation`,
        )
        .get(scope.sessionId, scope.sessionId) as {
        active_claim: number;
        active_source_generation: string | null;
      };
      expect(abandoned.active_claim).toBeGreaterThanOrEqual(0);
      expect(abandoned.active_source_generation).toBeNull();

      await expect(reconcileSessionTranscriptIndexes(databaseOptions)).resolves.toEqual({
        reconciledSessions: 1,
      });
      expect(readSessionTranscriptMessageEventCount(scope)).toBe(1);
    },
    20_000,
  );

  it("rolls back a synchronous rebuild when its claimed source changes", async () => {
    const scope = createScope("synchronous-claim-race");
    await appendTranscriptMessage(scope, {
      maintainDisplayProjection: true,
      message: { role: "user", content: "synchronous source" },
    });
    const options = { agentId: scope.agentId, env: scope.env };
    const database = openOpenClawAgentDatabase(options);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    const before = {
      active: database.db
        .prepare(
          "SELECT active_position, event_seq, message_position FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
        )
        .all(scope.sessionId),
      projectionSources: database.db
        .prepare(
          `SELECT
             active.source_generation AS active_source_generation,
             display.source_generation AS display_source_generation
           FROM session_transcript_index_state AS active
           JOIN session_transcript_display_state AS display
             ON display.session_id = active.session_id
           WHERE active.session_id = ?`,
        )
        .get(scope.sessionId),
      fts: database.db
        .prepare(
          "SELECT message_id, role, text FROM session_transcript_fts WHERE session_id = ? ORDER BY message_id",
        )
        .all(scope.sessionId),
      generation: readGeneration(scope),
    };
    database.db.exec(`
      CREATE TEMP TRIGGER race_synchronous_projection_claim
      AFTER UPDATE OF updated_at ON main.session_transcript_index_state
      WHEN NEW.session_id = '${scope.sessionId}' AND NEW.updated_at < 0
      BEGIN
        UPDATE transcript_rewrite_watermarks
        SET generation = 'raced-source-generation'
        WHERE session_id = NEW.session_id;
      END;
    `);

    expect(() =>
      runOpenClawAgentWriteTransaction((writeDatabase) => {
        reconcileSessionTranscriptIndexInTransaction(writeDatabase.db, scope.sessionId);
      }, options),
    ).toThrow(`Transcript projection claim changed while rebuilding ${scope.sessionId}`);

    expect({
      active: database.db
        .prepare(
          "SELECT active_position, event_seq, message_position FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
        )
        .all(scope.sessionId),
      projectionSources: database.db
        .prepare(
          `SELECT
             active.source_generation AS active_source_generation,
             display.source_generation AS display_source_generation
           FROM session_transcript_index_state AS active
           JOIN session_transcript_display_state AS display
             ON display.session_id = active.session_id
           WHERE active.session_id = ?`,
        )
        .get(scope.sessionId),
      fts: database.db
        .prepare(
          "SELECT message_id, role, text FROM session_transcript_fts WHERE session_id = ? ORDER BY message_id",
        )
        .all(scope.sessionId),
      generation: readGeneration(scope),
    }).toEqual(before);
  });
});
