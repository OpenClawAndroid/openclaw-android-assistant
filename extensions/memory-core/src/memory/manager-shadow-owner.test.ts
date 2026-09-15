import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { readMemoryShadowIdentity } from "./manager-shadow-task.js";
import { replaceMemoryShadowSession } from "./manager-shadow-write.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

const owners: MemoryIndexDatabase[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) {
    await owner.closeShadow();
  }
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("private shadow admission", () => {
  it("queues inherited reentrant callbacks until the native writer settles", async () => {
    const owner = new MemoryIndexDatabase(new DatabaseSync(":memory:"));
    owners.push(owner);
    const resume = createDeferred<void>();
    const events: string[] = [];
    let callback: Promise<number> | undefined;
    const native = owner.withPrivateAccess(
      async () => {
        events.push("native-start");
        callback = owner.withPrivateAccess(() => events.push("callback"), { reentrant: true });
        await resume.promise;
        events.push("native-settled");
      },
      { nativeWriter: true },
    );
    try {
      expect(events).toEqual(["native-start"]);
      resume.resolve();
      await native;
      await callback;
      expect(events).toEqual(["native-start", "native-settled", "callback"]);
    } finally {
      resume.resolve();
      await native.catch(() => undefined);
      await callback?.catch(() => undefined);
    }
  });

  it("invokes an idle writer immediately and preserves FIFO, caller ALS and undefined rejection", async () => {
    const owner = new MemoryIndexDatabase(new DatabaseSync(":memory:"));
    owners.push(owner);
    const context = new AsyncLocalStorage<string>();
    const resume = createDeferred<void>();
    const events: Array<string | undefined> = [];
    const first = context.run("first", () =>
      owner.withPrivateAccess(async () => {
        events.push(context.getStore());
        await resume.promise;
      }),
    );
    void first.catch(() => undefined);
    expect(events).toEqual(["first"]);
    const second = context.run("second", () =>
      owner.withPrivateAccess(async () => {
        events.push(context.getStore());
        return owner.withPrivateAccess(() => context.getStore(), { reentrant: true });
      }),
    );
    const third = context.run("third", () =>
      owner.withPrivateAccess(() => events.push(context.getStore())),
    );
    resume.reject(undefined);
    await expect(first).rejects.toBeUndefined();
    await expect(second).resolves.toBe("second");
    await third;
    expect(events).toEqual(["first", "second", "third"]);
  });

  it("retains SQLite failure codes and rolls back the failed Worker callback", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-shadow-owner-"));
    directories.push(directory);
    const owner = MemoryIndexDatabase.openShadow(
      path.join(directory, "shadow # unicode é.sqlite"),
      false,
    );
    owners.push(owner);
    ensureMemoryIndexSchema({ db: owner.db, cacheEnabled: false, ftsEnabled: true });
    owner.fts.enabled = true;
    owner.fts.available = true;
    owner.db.exec(
      "CREATE TRIGGER refuse_source BEFORE INSERT ON memory_index_sources BEGIN SELECT RAISE(ABORT, 'source refused'); END",
    );
    const replacement: Extract<MemorySourceIndexReplacement, { source: "sessions" }> = {
      source: "sessions",
      agentId: "main",
      sessionId: "one",
      model: "fts-only",
      now: 1,
      vectorReady: false,
      entry: { path: "sessions/one", hash: "source", mtimeMs: 1, size: 1 },
      embeddings: [],
      chunks: [
        {
          startLine: 1,
          endLine: 1,
          text: "retained text",
          hash: "chunk",
          importance: null,
          triggers: null,
          projectKey: null,
        },
      ],
    };
    await expect(
      owner.replaceShadowSession(replacement, () => undefined, owner.captureShadowWriteDeadline()),
    ).rejects.toMatchObject({
      code: "ERR_SQLITE_ERROR",
      errcode: 1811,
      entered: true,
      committed: false,
    });
    expect(owner.db.prepare("SELECT * FROM memory_index_chunks").all()).toEqual([]);
    expect(owner.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
    owner.db.exec("DROP TRIGGER refuse_source");
    await expect(
      owner.replaceShadowSession(replacement, () => undefined, owner.captureShadowWriteDeadline()),
    ).resolves.toEqual({
      kind: "staged",
    });
  });

  it("reports committed staging when closing its native connection fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-shadow-close-"));
    directories.push(directory);
    const filename = path.join(directory, "shadow # committed.sqlite");
    const owner = MemoryIndexDatabase.openShadow(filename, false);
    owners.push(owner);
    ensureMemoryIndexSchema({ db: owner.db, cacheEnabled: false, ftsEnabled: true });
    const open = sqliteRuntime.openNodeSqliteDatabase;
    let closeNative: (() => void) | undefined;
    vi.spyOn(sqliteRuntime, "openNodeSqliteDatabase").mockImplementation((location, options) => {
      const database = open(location, options);
      closeNative = database.close.bind(database);
      vi.spyOn(database, "close").mockImplementation(() => {
        throw new Error("controlled native close failure");
      });
      return database;
    });
    try {
      const result = await replaceMemoryShadowSession({
        kind: "replace-session",
        databasePath: filename,
        beginDeadlineNs: owner.captureShadowWriteDeadline(),
        fileIdentity: readMemoryShadowIdentity(filename),
        pragmas: {
          busy_timeout: 5000,
          synchronous: 2,
          foreign_keys: 1,
          wal_autocheckpoint: 1000,
          journal_size_limit: 67108864,
          checkpoint_fullfsync: 1,
        },
        vector: { enabled: false, available: false },
        fts: { enabled: true, available: true },
        replacement: {
          source: "sessions",
          agentId: "main",
          sessionId: "committed",
          model: "fts-only",
          now: 1,
          vectorReady: false,
          entry: { path: "sessions/committed", hash: "source", mtimeMs: 1, size: 1 },
          embeddings: [],
          chunks: [
            {
              startLine: 1,
              endLine: 1,
              text: "committed text",
              hash: "chunk",
              importance: null,
              triggers: null,
              projectKey: null,
            },
          ],
        },
      });
      expect(result).toMatchObject({
        kind: "session-failed",
        entered: true,
        committed: true,
        error: { message: "controlled native close failure" },
      });
      expect(owner.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
        { text: "committed text" },
      ]);
    } finally {
      vi.restoreAllMocks();
      closeNative?.();
    }
  });
});
