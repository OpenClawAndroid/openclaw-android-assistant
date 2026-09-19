import fs from "node:fs";
import type { AuthProfileRowRead } from "./types.js";

const IDENTITY_PROBE_INTERVAL_MS = 100;

type RowsReader = {
  read: () => Promise<AuthProfileRowRead>;
  assertCurrent: () => void;
};

export class AuthProfileRuntimeReadStaleError extends Error {
  constructor() {
    super("Auth profile store changed during its runtime read; retry resolution");
    this.name = "AuthProfileRuntimeReadStaleError";
  }
}

// Worker rows contain JSON values; normalization builds each caller's mutable store.
function freezeRows(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    freezeRows(child);
  }
}

// Include WAL and rollback-journal writes from other processes, without opening
// SQLite (which could release a host writer's POSIX locks).
function readIdentity(databasePath: string): string {
  return ["", "-wal", "-journal"]
    .map((suffix) => {
      const stat = fs.statSync(databasePath + suffix, { bigint: true, throwIfNoEntry: false });
      return stat
        ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
        : "missing";
    })
    .join("/");
}

/** A derived rows cache; the runtime snapshot owner supplies publication generations. */
export function createRuntimeAuthProfileRowsCache(
  revisionAtPath: (path: string) => { rows: string; selection: string },
) {
  const entries = new Map<
    string,
    { identity: string; checkedAt: number; revision: string; rows: AuthProfileRowRead }
  >();
  return {
    clear(databasePath?: string) {
      if (databasePath === undefined) {
        entries.clear();
      } else {
        entries.delete(databasePath);
      }
    },
    prepare(databasePath: string, reader: RowsReader): RowsReader {
      const revision = revisionAtPath(databasePath);
      const assertCurrent = () => {
        reader.assertCurrent();
        // Bookkeeping evicts reusable rows without revoking an admitted snapshot read.
        if (revisionAtPath(databasePath).selection !== revision.selection) {
          throw new AuthProfileRuntimeReadStaleError();
        }
      };
      return {
        assertCurrent,
        async read() {
          assertCurrent();
          const entry = entries.get(databasePath);
          const checkedAt = performance.now();
          // Owner writes invalidate immediately; external writes are checked every 100 ms.
          // Hits must not extend the interval, including while a cold read is pending.
          if (
            entry?.revision === revision.rows &&
            checkedAt - entry.checkedAt < IDENTITY_PROBE_INTERVAL_MS
          ) {
            return entry.rows;
          }
          const identity = readIdentity(databasePath);
          if (entry?.identity === identity && entry.revision === revision.rows) {
            entry.checkedAt = checkedAt;
            return entry.rows;
          }
          entries.delete(databasePath);
          // Only completed, certified reads can serve another caller's later snapshot.
          const rows = await reader.read();
          assertCurrent();
          if (
            rows.cacheable &&
            rows.store.status !== "unreadable" &&
            rows.state.status !== "unreadable" &&
            revisionAtPath(databasePath).rows === revision.rows &&
            readIdentity(databasePath) === identity
          ) {
            freezeRows(rows);
            entries.set(databasePath, { identity, checkedAt, revision: revision.rows, rows });
            // Bound retained credential owners; eviction never changes read authority.
            while (entries.size > 64) {
              entries.delete(entries.keys().next().value!);
            }
          }
          return rows;
        },
      };
    },
  };
}
