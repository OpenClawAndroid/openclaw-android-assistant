import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  readSessionTranscriptWatermark,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
  type TranscriptEvent,
} from "./session-accessor.js";
import { rotateTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readSessionTranscriptHotWatermark } from "./session-accessor.sqlite-transcript-watermark.js";

function transcriptMessages(count: number): TranscriptEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "message",
    id: `message-${index}`,
    parentId: index === 0 ? null : `message-${index - 1}`,
    message: { role: "user", content: `Message ${index}` },
  }));
}

const isHotWatermarkQuery = (sql: string) =>
  sql.includes('from "transcript_events"') && sql.includes('from "transcript_rewrite_watermarks"');

describe("SQLite transcript watermark queries", () => {
  let state: OpenClawTestState;
  const scope = (sessionId: string) => ({
    agentId: "main",
    env: state.env,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  });

  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    for (const [sessionId, count] of [
      ["first", 1],
      ["second", 2],
    ] as const) {
      await upsertSessionEntryCore(scope(sessionId), { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope(sessionId), transcriptMessages(count));
    }
  });

  afterEach(async () => {
    await state.cleanup();
  });

  it("does not recompile 1000 warm watermark reads while executing every query", () => {
    const database = openOpenClawAgentDatabase(scope("first"));
    const targets = [scope("first"), scope("second")];
    const entries = targets.map(loadSessionEntryReadOnly);
    const queries = trackSqliteStatementExecutions(database.db, ["watermarks"], (sql) =>
      isHotWatermarkQuery(sql) ? "watermarks" : null,
    );
    const compile = vi.spyOn(getNodeSqliteKysely(database.db).getExecutor(), "compileQuery");
    try {
      const expected = targets.map(readSessionTranscriptWatermark);
      expect(expected).toEqual([
        { generation: expect.any(String), maxSeq: 0 },
        { generation: expect.any(String), maxSeq: 1 },
      ]);
      expect(expected[0]?.generation).not.toBe(expected[1]?.generation);
      const beforeReads = queries.counts.watermarks;
      const beforeChanges = database.db.prepare("SELECT total_changes() AS count").get();
      compile.mockClear();
      for (let index = 0; index < 1_000; index++) {
        const targetIndex = index % targets.length;
        expect(readSessionTranscriptWatermark(targets[targetIndex]!)).toEqual(
          expected[targetIndex],
        );
      }
      expect(queries.counts.watermarks - beforeReads).toBe(1_000);
      expect(database.db.prepare("SELECT total_changes() AS count").get()).toEqual(beforeChanges);
      expect(targets.map(loadSessionEntryReadOnly)).toEqual(entries);
      expect(database.db.isTransaction).toBe(false);
      expect(
        compile.mock.results.filter(
          (result) => result.type === "return" && isHotWatermarkQuery(result.value.sql),
        ).length,
      ).toBe(0);
    } finally {
      compile.mockRestore();
      queries.restore();
    }
  });

  it("binds each session again after appends, rewrites, and missing-session reads", async () => {
    const first = readSessionTranscriptWatermark(scope("first"));
    const second = readSessionTranscriptWatermark(scope("second"));
    await appendTranscriptMessage(scope("first"), {
      eventId: "appended",
      parentId: "message-0",
      message: { role: "assistant", content: "Appended message" },
    });
    expect(readSessionTranscriptWatermark(scope("first"))).toEqual({ ...first, maxSeq: 1 });
    expect(readSessionTranscriptWatermark(scope("second"))).toEqual(second);

    await replaceTranscriptEvents(scope("first"), transcriptMessages(3));
    const rewritten = readSessionTranscriptWatermark(scope("first"));
    expect(rewritten.maxSeq).toBe(2);
    expect(rewritten.generation).not.toBe(first.generation);
    expect(readSessionTranscriptWatermark(scope("missing"))).toEqual({
      generation: null,
      maxSeq: null,
    });
    expect(readSessionTranscriptWatermark(scope("second"))).toEqual(second);
    expect(readSessionTranscriptWatermark(scope("first"))).toEqual(rewritten);
  });

  it.each([false, true])("keeps public reads committed through writer rollback=%s", (rollback) => {
    const target = scope("first");
    const before = readSessionTranscriptWatermark(target);
    const database = openOpenClawAgentDatabase(target);
    const failure = new Error("rollback watermark generation");
    let generation = before.generation;
    const write = () =>
      runOpenClawAgentWriteTransaction((writer) => {
        generation = rotateTranscriptGenerationInTransaction(writer, target.sessionId);
        expect(readSessionTranscriptHotWatermark(writer, target.sessionId)).toEqual({
          ...before,
          generation,
        });
        // Public reads use the committed companion even after its query is warm.
        expect(readSessionTranscriptWatermark(target)).toEqual(before);
        expect(readSessionTranscriptWatermark(target)).toEqual(before);
        if (rollback) {
          throw failure;
        }
      }, target);
    if (rollback) {
      expect(write).toThrow(failure);
    } else {
      write();
    }
    expect(generation).not.toBe(before.generation);
    expect(database.db.isTransaction).toBe(false);
    expect(readSessionTranscriptWatermark(target)).toEqual({
      ...before,
      generation: rollback ? before.generation : generation,
    });
  });

  it("keeps a WAL snapshot until its read transaction ends", () => {
    const target = scope("first");
    const database = openOpenClawAgentDatabase(target);
    const before = readSessionTranscriptWatermark(target);
    const peer = new (requireNodeSqlite().DatabaseSync)(database.path);
    try {
      expect(peer.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      const db = getNodeSqliteKysely<DB>(peer);
      runSqliteDeferredTransactionSync(database.db, () => {
        expect(readSessionTranscriptHotWatermark(database, target.sessionId)).toEqual(before);
        executeSqliteQuerySync(
          peer,
          db
            .updateTable("transcript_rewrite_watermarks")
            .set({ generation: "peer-generation" })
            .where("session_id", "=", target.sessionId),
        );
        expect(readSessionTranscriptHotWatermark(database, target.sessionId)).toEqual(before);
      });
      expect(readSessionTranscriptWatermark(target)).toEqual({
        ...before,
        generation: "peer-generation",
      });
      expect(database.db.isTransaction).toBe(false);
    } finally {
      peer.close();
    }
  });

  it("prepares for the reopened native handle and rejects the closed one", async () => {
    const target = scope("first");
    const database = openOpenClawAgentDatabase(target);
    const before = readSessionTranscriptWatermark(target);
    await closeOpenClawAgentDatabaseByPathAsync(database.path, target.agentId);
    expect(database.db.isOpen).toBe(false);
    expect(() => readSessionTranscriptHotWatermark(database, target.sessionId)).toThrow();
    const reopened = openOpenClawAgentDatabase(target);
    expect(Object.is(reopened.db, database.db)).toBe(false);
    const compile = vi.spyOn(getNodeSqliteKysely(reopened.db).getExecutor(), "compileQuery");
    try {
      expect(readSessionTranscriptWatermark(target)).toEqual(before);
      expect(readSessionTranscriptWatermark(target)).toEqual(before);
      expect(
        compile.mock.results.filter(
          (result) => result.type === "return" && isHotWatermarkQuery(result.value.sql),
        ).length,
      ).toBe(1);
    } finally {
      compile.mockRestore();
    }
  });
});
