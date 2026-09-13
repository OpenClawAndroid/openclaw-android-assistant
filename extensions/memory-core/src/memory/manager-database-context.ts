// Owns the published index state and the isolated lifetime of shadow reindex work.
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import {
  resolveStateDir,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { withOpenClawAgentDatabaseWrite } from "openclaw/plugin-sdk/sqlite-runtime";
import { closeMemoryDatabase } from "./manager-db.js";
import { MemorySourceIndexKernel } from "./manager-source-index-kernel.js";

export class MemoryIndexDatabase {
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
      : run();
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
      database.release();
      return result;
    } finally {
      try {
        database.release();
      } catch {}
    }
  }
}
