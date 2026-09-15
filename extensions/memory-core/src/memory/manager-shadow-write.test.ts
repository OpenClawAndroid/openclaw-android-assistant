import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as storage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  WorkerTaskError,
  WorkerTaskPool,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordMemorySessionTombstones } from "../memory-entry-origins.js";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import * as cpu from "./manager-cpu-worker-runtime.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import * as shadow from "./manager-shadow-task.js";
import { MemorySourceIndexKernel } from "./manager-source-index-kernel.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("private session source staging", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup(vectorEnabled = false) {
    await fixture.seedSessionTranscript({
      sessionId: "shadow-session",
      messages: [
        {
          role: "user",
          timestamp: 1,
          content: vectorEnabled
            ? "Violet session preference. Beta."
            : "Violet session preference.",
          senderIsOwner: true,
        },
      ],
    });
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: vectorEnabled ? "openai" : "none",
        sources: ["memory", "sessions"],
        sessionMemory: true,
        vectorEnabled,
      }),
    );
    // SAFETY: this fixture owns the manager and inspects its published native store.
    const db = Reflect.get(manager, "db") as DatabaseSync;
    return { manager, db };
  }

  it.each([
    { mode: "FTS-only", vectorEnabled: false },
    { mode: "vector", vectorEnabled: true },
  ])(
    "runs forced $mode session staging off-thread while retaining the memory-file path",
    async ({ vectorEnabled }) => {
      const { manager, db } = await setup(vectorEnabled);
      // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted kernel receiver.
      const replace = MemorySourceIndexKernel.prototype.replace;
      let memoryWrites = 0;
      vi.spyOn(MemorySourceIndexKernel.prototype, "replace").mockImplementation(
        function (this: MemorySourceIndexKernel, input) {
          if (input.source === "sessions") {
            throw new Error("session staging reached the application thread");
          }
          memoryWrites += 1;
          return replace.call(this, input);
        },
      );
      await manager.sync({ reason: "cli", force: true });
      expect(memoryWrites).toBeGreaterThan(0);
      expect(
        db.prepare("SELECT DISTINCT source FROM memory_index_chunks ORDER BY source").all(),
      ).toEqual([{ source: "memory" }, { source: "sessions" }]);
      const sessionChunks = db
        .prepare(
          "SELECT id, text, embedding FROM memory_index_chunks WHERE source='sessions' ORDER BY id",
        )
        .all();
      expect(sessionChunks).toEqual([
        {
          id: expect.any(String),
          text: expect.stringContaining("Violet session preference."),
          embedding: vectorEnabled ? "[0,1,0,0]" : "[]",
        },
      ]);
      if (vectorEnabled) {
        const vectors = db
          .prepare(
            "SELECT v.id, hex(v.embedding) AS embedding FROM memory_index_chunks_vec AS v " +
              "JOIN memory_index_chunks AS c ON c.id = v.id WHERE c.source = 'sessions' ORDER BY v.id",
          )
          .all();
        const embedding = Buffer.from(new Float32Array([0, 1, 0, 0]).buffer)
          .toString("hex")
          .toUpperCase();
        expect(vectors).toEqual(sessionChunks.map(({ id }) => ({ id, embedding })));
      }
      await manager.close();
      const entries = await fs.readdir(path.dirname(db.location()!));
      expect(entries.filter((name) => name.includes(".memory-reindex-"))).toEqual([]);
    },
  );

  it("rejects a tombstone recorded after native staging before publishing the shadow", async () => {
    const { manager, db } = await setup();
    await manager.sync({ reason: "baseline", force: true });
    const before = db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all();
    const run = cpu.replaceMemoryShadowSessionInWorker;
    vi.spyOn(cpu, "replaceMemoryShadowSessionInWorker").mockImplementation(
      async (input, inputBytes) => {
        const result = await run(input, inputBytes);
        // Deliberately bypass the workspace lock to exercise post-await authority;
        // production forget holds that lock and also advances this revision.
        recordMemorySessionTombstones({ agentId: "main", sessionIds: ["shadow-session"] });
        return result;
      },
    );
    await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow("forgotten");
    expect(db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all()).toEqual(
      before,
    );
  });

  it("drains accepted staging before manager close releases its database", async () => {
    const { manager, db } = await setup();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const run = cpu.replaceMemoryShadowSessionInWorker;
    vi.spyOn(cpu, "replaceMemoryShadowSessionInWorker").mockImplementation(
      async (input, inputBytes) => {
        const result = await run(input, inputBytes);
        entered.resolve();
        await resume.promise;
        return result;
      },
    );
    const sync = manager.sync({ reason: "cli", force: true });
    void sync.catch(() => undefined);
    let close: Promise<void> | undefined;
    let closed = false;
    try {
      await Promise.race([entered.promise, sync]);
      close = manager.close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      resume.resolve();
      await Promise.all([sync, close]);
      expect(
        db.prepare("SELECT source FROM memory_index_sources WHERE source='sessions'").all(),
      ).toEqual([{ source: "sessions" }]);
    } finally {
      resume.resolve();
      await Promise.allSettled([sync, close]);
    }
  });

  it("uses the original path only for the explicit oversized-input decision", async () => {
    const { manager, db } = await setup();
    const run = vi.spyOn(cpu, "replaceMemoryShadowSessionInWorker");
    const deadline = vi.spyOn(MemoryIndexDatabase.prototype, "captureShadowWriteDeadline");
    const transactions = vi.spyOn(sqliteRuntime, "runSqliteImmediateTransaction");
    vi.spyOn(shadow, "memoryShadowSessionInputBytes").mockReturnValue(
      shadow.MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES + 1,
    );
    await manager.sync({ reason: "cli", force: true });
    expect(run).not.toHaveBeenCalled();
    const beginDeadlineNs = deadline.mock.results[0]?.value;
    expect(typeof beginDeadlineNs).toBe("bigint");
    expect(transactions.mock.calls.map((call) => call[2]?.beginDeadlineNs)).toContain(
      beginDeadlineNs,
    );
    expect(
      db.prepare("SELECT source FROM memory_index_sources WHERE source='sessions'").all(),
    ).toEqual([{ source: "sessions" }]);
  });

  it("retains late vector setup after its timeout-facing promise rejects", async () => {
    await fixture.seedSessionTranscript({
      sessionId: "late-vector",
      messages: [{ role: "user", timestamp: 1, content: "Violet late vector preference." }],
    });
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "openai",
        sources: ["sessions"],
        sessionMemory: true,
        vectorEnabled: true,
      }),
    );
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const timedOut = createDeferred<void>();
    const load = storage.loadSqliteVecExtension;
    vi.spyOn(storage, "loadSqliteVecExtension").mockImplementation(async (input) => {
      if (!input.db.location()?.includes(".memory-reindex-")) {
        return load(input);
      }
      entered.resolve();
      await resume.promise;
      return { ok: false, error: "controlled late vector setup" };
    });
    // SAFETY: the fixture injects the existing timeout outcome while leaving
    // the separate underlying setup task pending; no production hook is added.
    const owner = manager as unknown as {
      db: DatabaseSync;
      withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
    };
    const withTimeout = owner.withTimeout.bind(owner);
    vi.spyOn(owner, "withTimeout").mockImplementation(
      <T>(promise: Promise<T>, timeoutMs: number, message: string) => {
        if (
          !message.startsWith("sqlite-vec load timed out") ||
          !owner.db.location()?.includes(".memory-reindex-")
        ) {
          return withTimeout(promise, timeoutMs, message);
        }
        void promise.catch(() => undefined);
        timedOut.resolve();
        return Promise.reject(new Error(message));
      },
    );
    const run = vi.spyOn(cpu, "replaceMemoryShadowSessionInWorker");
    const sync = manager.sync({ reason: "cli", force: true });
    void sync.catch(() => undefined);
    let close: Promise<void> | undefined;
    let closed = false;
    try {
      await Promise.race([Promise.all([entered.promise, timedOut.promise]), sync]);
      await nextTurn();
      expect(run).not.toHaveBeenCalled();
      close = manager.close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      resume.resolve();
      await Promise.all([sync, close]);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      resume.resolve();
      await Promise.allSettled([sync, close]);
    }
  });

  it("preserves staging when shared capacity refuses the task before preparation", async () => {
    const { manager, db } = await setup();
    const prepare = cpu.prepareMemoryIndexInWorker;
    const started = createDeferred<void>();
    const resume = createDeferred<void>();
    const factoryJoined = createDeferred<void>();
    let factoryStarted = false;
    let blocker: WorkerTaskPool<cpu.MemoryIndexTask, cpu.MemoryIndexTaskResult> | undefined;
    let pending: Promise<cpu.MemoryIndexTaskResult> | undefined;
    vi.spyOn(cpu, "prepareMemoryIndexInWorker").mockImplementation(async (input) => {
      const result = await prepare(input);
      if (input.source === "sessions" && !blocker) {
        blocker = new WorkerTaskPool<cpu.MemoryIndexTask, cpu.MemoryIndexTaskResult>({
          workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.index),
          maxWorkers: 1,
          sharedCompute: true,
        });
        // Reserve the shared admission ledger with a fixture factory. Cleanup
        // closes the task before releasing it, so it never dispatches to a Worker.
        pending = blocker.run(
          async () => {
            factoryStarted = true;
            started.resolve();
            try {
              await resume.promise;
            } finally {
              factoryJoined.resolve();
            }
            return { kind: "prepare", input };
          },
          { inputBytes: shadow.MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES },
        );
        void pending.catch(() => undefined);
        await Promise.race([started.promise, pending]);
      }
      return result;
    });
    try {
      await manager.sync({ reason: "cli", force: true });
      expect(blocker).toBeDefined();
      expect(
        db.prepare("SELECT source FROM memory_index_sources WHERE source='sessions'").all(),
      ).toEqual([{ source: "sessions" }]);
    } finally {
      const close = blocker?.close();
      resume.resolve();
      await Promise.allSettled([
        close,
        pending,
        ...(factoryStarted ? [factoryJoined.promise] : []),
      ]);
    }
  });

  it("never replays an overloaded error after task preparation started", async () => {
    const { manager, db } = await setup();
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted pool receiver.
    const run = WorkerTaskPool.prototype.run;
    vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(
      function (this: WorkerTaskPool<unknown, unknown>, input, options) {
        return run.call(
          this,
          typeof input === "function"
            ? async () => {
                await input();
                throw new WorkerTaskError("accepted preparation failure", "overloaded");
              }
            : input,
          options,
        );
      },
    );
    await expect(manager.sync({ reason: "cli", force: true })).rejects.toMatchObject({
      code: "overloaded",
    });
    expect(db.prepare("SELECT source FROM memory_index_sources").all()).toEqual([]);
  });
});

describe("complete shadow task input accounting", () => {
  it("charges every logical vector, including valid repeated provider arrays", () => {
    const vector = Array.from({ length: 16_384 }, () => 0);
    const input: shadow.MemoryShadowSessionInput = {
      kind: "replace-session",
      databasePath: "/shadow.sqlite",
      beginDeadlineNs: 1n,
      fileIdentity: { device: "1", inode: "2" },
      pragmas: {
        busy_timeout: 5000,
        synchronous: 2,
        foreign_keys: 0,
        wal_autocheckpoint: 1000,
        journal_size_limit: 67108864,
        checkpoint_fullfsync: 1,
      },
      vector: { enabled: false, available: false },
      fts: { enabled: true, available: true },
      replacement: {
        source: "sessions",
        agentId: "main",
        sessionId: "large",
        model: "valid-provider",
        now: 1,
        vectorReady: false,
        entry: { path: "sessions/large", hash: "source", mtimeMs: 1, size: 1 },
        chunks: Array.from({ length: 2048 }, (_, index) => ({
          startLine: index,
          endLine: index,
          text: "retained text",
          hash: String(index),
          importance: null,
          triggers: null,
          projectKey: null,
        })),
        embeddings: Array.from({ length: 2048 }, () => vector),
      },
    };
    expect(shadow.memoryShadowSessionInputBytes(input)).toBeGreaterThan(
      shadow.MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES,
    );
    input.replacement.embeddings = Array.from({ length: 2048 }, () => vector.slice(0, 1536));
    expect(shadow.memoryShadowSessionInputBytes(input)).toBeLessThan(
      shadow.MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES,
    );
  });
});
