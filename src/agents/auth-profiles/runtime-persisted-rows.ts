import fs from "node:fs";
import type { AuthProfileRowRead } from "./types.js";

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
    { identity: string; revision: string; rows: AuthProfileRowRead }
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
          const identity = readIdentity(databasePath);
          const entry = entries.get(databasePath);
          if (entry?.identity === identity && entry.revision === revision.rows) {
            return structuredClone(entry.rows);
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
            entries.set(databasePath, { identity, revision: revision.rows, rows });
            // Bound retained credential owners; eviction never changes read authority.
            while (entries.size > 64) {
              entries.delete(entries.keys().next().value!);
            }
          }
          // Host overlays and callers may mutate their view, never the retained rows.
          return structuredClone(rows);
        },
      };
    },
  };
}
