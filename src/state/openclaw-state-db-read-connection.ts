import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  createSqliteLifecycleAggregateError,
  SqliteCoordinatorError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-coordinator.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabase,
  type OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { openTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";

export type OpenClawStateReadConnection = {
  database: Pick<OpenClawStateDatabase, "db" | "path">;
  close: () => boolean;
};

class SnapshotCleanupIncompleteError extends Error {}

export function assertStateReadSchema(database: DatabaseSync, pathname: string): void {
  if (isExistingOpenClawStateSchema(pathname, database)) {
    assertExistingOpenClawStateRuntimeSchema(database, pathname);
  } else {
    assertSupportedStateSchemaVersion(database, pathname);
  }
}

export function withOpenClawStateReadOnlyLocation<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
  expectedIdentity?: string,
): T {
  const opened = openOpenClawStateReadConnection(pathname, source, expectedIdentity);
  const errors: unknown[] = [];
  let closeAdmission: (() => void) | undefined;
  let result!: T;
  try {
    closeAdmission = openStateSchemaReadAdmission?.(opened.database.db);
    assertStateReadSchema(opened.database.db, pathname);
    result = operation(opened.database);
    const location = typeof source === "string" ? source : source.location;
    if (location === pathname && isPromiseLike(result)) {
      throw new SqliteCoordinatorError("SQLite source read must remain synchronous");
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    closeAdmission?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    opened.close();
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(errors, "Shared-state read and reader cleanup failed.");
  return result;
}

/** Own one native reader; callers retain their runtime or maintenance schema policy. */
export function openOpenClawStateReadConnection(
  pathname: string,
  source: string | PreparedSqliteReadOnlyLocation,
  expectedIdentity?: string,
): OpenClawStateReadConnection {
  const snapshot = typeof source === "string" ? undefined : source;
  const location = typeof source === "string" ? source : source.location;
  if (expectedIdentity !== undefined) {
    assertExistingDatabaseIdentity(location, expectedIdentity);
  }
  // The first catalog read needs the busy handler; installing a later PRAGMA is too late.
  const options = { readOnly: true, timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS };
  let db: OpenClawStateDatabase["db"];
  try {
    db =
      location === pathname
        ? openTrackedStateDatabase(pathname, options)
        : openNodeSqliteDatabase(location, options);
  } catch (error) {
    snapshot?.cleanup();
    throw error;
  }
  let closed = false;
  const database = {
    db,
    path: pathname,
    afterClose: (): undefined => {
      if (snapshot && !snapshot.cleanup()) {
        throw new SnapshotCleanupIncompleteError("Shared-state snapshot cleanup is incomplete.");
      }
      closed = true;
      return undefined;
    },
  };
  const connection: OpenClawStateReadConnection = {
    database: { db, path: pathname },
    close() {
      if (closed) {
        return false;
      }
      // A failed close remains owned for retry, including private snapshot handles.
      const errors = openClawStateDatabaseCache.closeOpenClawStateDatabaseHandle(database);
      if (errors.length === 1 && errors[0] instanceof SnapshotCleanupIncompleteError) {
        return false;
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw createSqliteLifecycleAggregateError(
          errors,
          "Shared-state reader cleanup failed.",
          errors[0],
        );
      }
      return true;
    },
  };
  try {
    if (expectedIdentity !== undefined) {
      assertExistingDatabaseIdentity(location, expectedIdentity);
    }
  } catch (error) {
    try {
      connection.close();
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "Shared-state reader identity and cleanup failed.",
        error,
      );
    }
    throw error;
  }
  return connection;
}
