// Owns the published index state and the isolated lifetime of shadow reindex work.
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveStateDir,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  runQueuedStoreWrite,
  withOpenClawAgentDatabaseWrite,
  type StoreWriterQueue,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { replaceMemoryShadowSessionInWorker } from "./manager-cpu-worker-runtime.js";
import { closeMemoryDatabase, openMemoryDatabaseAtPath } from "./manager-db.js";
import {
  assertMemoryShadowIdentity,
  readMemoryShadowIdentity,
  MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES,
  memoryShadowSessionInputBytes,
  type MemoryShadowConnection,
  type MemoryShadowSessionInput,
} from "./manager-shadow-task.js";
import {
  MemorySourceIndexKernel,
  type MemorySourceIndexReplacement,
} from "./manager-source-index-kernel.js";

type ShadowSessionPlacement = { kind: "staged" } | { kind: "caller"; beginDeadlineNs: bigint };

export class MemoryIndexDatabase {
  private readonly privateQueues = new Map<string, StoreWriterQueue>();
  private nativeWriterActive = false;
  private shadow?: {
    path: string;
    identity: MemoryShadowConnection["fileIdentity"];
    pragmas: MemoryShadowConnection["pragmas"];
  };
  private shadowClose?: Promise<void>;
  private releaseInProgress = false;
  shadowReleased = false;

  static openShadow(filename: string, allowExtension: boolean): MemoryIndexDatabase {
    let database: MemoryIndexDatabase | undefined;
    const db = openMemoryDatabaseAtPath(filename, allowExtension, (operation) =>
      database ? database.runMaintenance(operation) : operation(),
    );
    try {
      database = new MemoryIndexDatabase(db);
      const readPragma = (name: keyof MemoryShadowConnection["pragmas"]): number => {
        const row = db.prepare(`PRAGMA ${name}`).get();
        const value = name === "busy_timeout" ? (row?.busy_timeout ?? row?.timeout) : row?.[name];
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
          throw new Error("Invalid memory shadow connection policy");
        }
        return value;
      };
      database.shadow = {
        path: filename,
        identity: readMemoryShadowIdentity(filename),
        pragmas: {
          busy_timeout: readPragma("busy_timeout"),
          synchronous: readPragma("synchronous"),
          foreign_keys: readPragma("foreign_keys"),
          wal_autocheckpoint: readPragma("wal_autocheckpoint"),
          journal_size_limit: readPragma("journal_size_limit"),
          checkpoint_fullfsync: readPragma("checkpoint_fullfsync"),
        },
      };
      return database;
    } catch (error) {
      closeMemoryDatabase(db);
      throw error;
    }
  }

  static captureWriteOptions(agentId: string, databasePath: string, source?: MemoryIndexDatabase) {
    const env = { ...(source?.writeOptions?.env ?? process.env) };
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    return {
      agentId,
      path: source?.writeOptions?.path ?? resolveUserPath(databasePath),
      env,
    };
  }

  readonly sourceIndex: MemorySourceIndexKernel;
  readonly vector: {
    enabled: boolean;
    available: boolean | null;
    semanticAvailable?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  } = { enabled: false, available: null };
  readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  } = { enabled: false, available: false };
  vectorReady: Promise<boolean> | null = null;
  lastMetaSerialized: string | null = null;
  vectorDegradedWriteWarningShown = false;
  closed = false;

  constructor(
    readonly db: DatabaseSync,
    readonly release: () => void = () => closeMemoryDatabase(db),
    readonly readOnly = false,
    readonly writeOptions?: Parameters<typeof withOpenClawAgentDatabaseWrite>[0],
  ) {
    this.sourceIndex = new MemorySourceIndexKernel(db, this);
  }

  get isShadow(): boolean {
    return this.shadow !== undefined;
  }

  assertShadowPath(): void {
    if (this.shadow) {
      assertMemoryShadowIdentity(this.shadow.path, this.shadow.identity);
    }
  }

  captureShadowWriteDeadline(): bigint {
    if (!this.shadow) {
      throw new Error("Memory shadow deadline requires its private owner");
    }
    return process.hrtime.bigint() + BigInt(this.shadow.pragmas.busy_timeout) * 1_000_000n;
  }

  withPrivateAccess<T>(
    operation: () => T | Promise<T>,
    options: { nativeWriter?: boolean; reentrant?: boolean; closingMaintenance?: boolean } = {},
  ): Promise<T> {
    if (this.closed && !options.closingMaintenance) {
      return Promise.reject(new Error("Memory reindex database owner is closed"));
    }
    return runQueuedStoreWrite({
      queues: this.privateQueues,
      storePath: this.shadow?.path ?? "memory-index",
      label: "private memory index access",
      // A Worker callback may inherit ALS, but it does not own a native write
      // permit. It must queue until the actual Worker operation settles.
      reentrant: options.reentrant === true && !this.nativeWriterActive,
      fn: async () => {
        if (!this.db.isOpen) {
          throw new Error("Memory reindex database owner is closed");
        }
        this.assertShadowPath();
        if (options.nativeWriter) {
          this.nativeWriterActive = true;
        }
        try {
          return await operation();
        } finally {
          if (options.nativeWriter) {
            this.nativeWriterActive = false;
          }
        }
      },
    });
  }

  private async drainPrivateAccess(): Promise<void> {
    while (this.privateQueues.size > 0) {
      await Promise.allSettled(
        Array.from(this.privateQueues.values()).flatMap((queue) =>
          queue.drainPromise ? [queue.drainPromise] : [],
        ),
      );
    }
  }

  private runMaintenance(operation: () => boolean): boolean {
    let result = false;
    // The WAL owner reports this pass as pending; the accepted operation is
    // retained in private admission and drains before its connection closes.
    void this.withPrivateAccess(
      () => {
        result = operation();
        return result;
      },
      { reentrant: true, closingMaintenance: this.releaseInProgress },
    ).catch(() => undefined);
    return result;
  }

  async replaceShadowSession(
    replacement: Extract<MemorySourceIndexReplacement, { source: "sessions" }>,
    assertCurrent: () => void,
    beginDeadlineNs: bigint,
  ): Promise<ShadowSessionPlacement> {
    const shadow = this.shadow;
    if (!shadow) {
      throw new Error("Memory source worker requires its private shadow owner");
    }
    return this.withPrivateAccess<ShadowSessionPlacement>(
      async () => {
        assertCurrent();
        const input: MemoryShadowSessionInput = {
          kind: "replace-session",
          databasePath: shadow.path,
          fileIdentity: shadow.identity,
          pragmas: shadow.pragmas,
          beginDeadlineNs,
          ...(this.vector.available && this.vector.extensionPath
            ? { extensionPath: this.vector.extensionPath }
            : {}),
          replacement,
          vector: { enabled: this.vector.enabled, available: this.vector.available },
          fts: { enabled: this.fts.enabled, available: this.fts.available },
        };
        const inputBytes = memoryShadowSessionInputBytes(input);
        if (inputBytes > MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES) {
          return { kind: "caller", beginDeadlineNs };
        }
        // Allocate the transfer projection only after complete size accounting.
        input.replacement = {
          ...replacement,
          chunks: replacement.chunks.map((chunk) => ({
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            text: chunk.text,
            hash: chunk.hash,
            importance: chunk.importance,
            triggers: chunk.triggers,
            projectKey: chunk.projectKey,
            ...(chunk.provenance ? { provenance: { ...chunk.provenance } } : {}),
          })),
        };
        const result = await replaceMemoryShadowSessionInWorker(input, inputBytes);
        assertCurrent();
        if (result === "not-admitted") {
          return { kind: "caller", beginDeadlineNs };
        }
        return { kind: "staged" };
      },
      { nativeWriter: true },
    );
  }

  closeShadow(): Promise<void> {
    this.closed = true;
    this.shadowClose ??= (async () => {
      await this.drainPrivateAccess();
      // Each accepted pool task has closed its native database or joined Worker
      // termination before its promise releases this private admission.
      this.releaseInProgress = true;
      try {
        this.release();
      } finally {
        this.releaseInProgress = false;
      }
      await this.drainPrivateAccess();
      this.shadowReleased = true;
    })();
    return this.shadowClose;
  }
}

// One process-lifetime container; stores belong only to their awaited rebuild.
const reindexDatabase = new AsyncLocalStorage<{
  manager: MemoryManagerDatabaseContext;
  database: MemoryIndexDatabase;
}>();

export abstract class MemoryManagerDatabaseContext {
  protected abstract publishedDatabase: MemoryIndexDatabase;
  protected closed = false;

  protected async withDatabaseWrite<T>(write: () => T): Promise<T> {
    const database = this.database;
    const run = () => {
      if (this.closed || database.closed || !database.db.isOpen || this.database !== database) {
        throw new Error("Memory database owner closed or changed before write admission");
      }
      if (database.readOnly) {
        throw new Error("Memory status managers are read-only");
      }
      return write();
    };
    // A shadow index is private to its awaited rebuild; only the published
    // borrowed database shares the agent's reclamation/write admission owner.
    return database.writeOptions
      ? await withOpenClawAgentDatabaseWrite(database.writeOptions, run, database.db)
      : await database.withPrivateAccess(run, { reentrant: true });
  }

  protected async withDatabaseRead<T>(read: () => T): Promise<T> {
    const database = this.database;
    return database.isShadow ? database.withPrivateAccess(read) : read();
  }

  protected get database(): MemoryIndexDatabase {
    const context = reindexDatabase.getStore();
    const shadow = context?.manager === this ? context.database : undefined;
    if (shadow?.closed) {
      throw new Error("Memory reindex database context is closed");
    }
    return shadow ?? this.publishedDatabase;
  }

  protected get db(): DatabaseSync {
    return this.database.db;
  }

  protected get vector() {
    return this.database.vector;
  }

  protected get fts() {
    return this.database.fts;
  }

  protected withPublishedDatabase<T>(run: () => T): T {
    // Public calls can originate in reindex progress/provider callbacks. They
    // must never inherit the temporary writer or outlive its connection.
    return reindexDatabase.exit(run);
  }

  protected async withReindexDatabase<T>(
    database: MemoryIndexDatabase,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await reindexDatabase.run({ manager: this, database }, run);
      // Publication attaches the finished file only after its writer closes.
      await database.closeShadow();
      return result;
    } finally {
      try {
        await database.closeShadow();
      } catch {}
    }
  }
}
