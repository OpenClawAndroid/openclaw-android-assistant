// Keep source lifetime pinned while the snapshot owner consumes live or private bytes.
import fs, { type BigIntStats } from "node:fs";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  adoptPreparedLocation,
  removeTempDirectory,
  removeTempDirectoryAsync,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import {
  createSqliteSnapshotStagingDirectory,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import {
  resolveSqliteInspectionSignal,
  runSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerSync,
} from "./sqlite-readonly-worker.js";
import {
  readSqliteSchemaHeaderFromSnapshotAsync,
  type SqliteSchemaHeader,
} from "./sqlite-schema-header.js";
import { createSqliteSnapshotStagingDirectorySync } from "./sqlite-snapshot-staging.js";
import { withSqliteSourceHandleAsync } from "./sqlite-source-handle.js";
import {
  hasStateDatabaseSourceExclusion,
  prepareStateDatabaseCanonicalMutation,
  prepareStateDatabaseMutationSnapshot,
} from "./state-database-coordinator.js";

/** Inspect metadata without copying the payload. Exclusive task-local scopes
 * must use their snapshot owner: a child cannot borrow that source authority. */
export async function inspectSqliteSchemaHeader(
  pathname: string,
  options: { signal?: AbortSignal; agentSchemaVersionForOwnership?: number } = {},
) {
  const signal = resolveSqliteInspectionSignal(options.signal);
  signal?.throwIfAborted();
  if (
    prepareStateDatabaseCanonicalMutation(pathname) ||
    hasStateDatabaseSourceExclusion(pathname)
  ) {
    const prepared = await prepareSqliteReadOnlyLocation(pathname, { ...options, signal });
    return readSqliteSchemaHeaderFromSnapshotAsync(
      prepared,
      signal,
      options.agentSchemaVersionForOwnership,
    );
  }
  // Reserve cleanup ownership before launch even if only journal recovery will
  // need a copy. Cancellation joins the child before deleting unpublished bytes.
  signal?.throwIfAborted();
  const stagingRoot = await createSqliteSnapshotStagingDirectory(undefined, false, signal);
  let header: SqliteSchemaHeader;
  try {
    signal?.throwIfAborted();
    header = await runSqliteReadOnlyWorker(pathname, {
      mode: "schema-header",
      stagingRoot,
      signal,
      agentSchemaVersionForOwnership: options.agentSchemaVersionForOwnership,
    });
    signal?.throwIfAborted();
  } catch (error) {
    if (!(await removeTempDirectoryAsync(stagingRoot))) {
      throw new Error(
        `${coerceErrorMessage(error)}; SQLite snapshot cleanup failed: ${stagingRoot}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  if (!(await removeTempDirectoryAsync(stagingRoot))) {
    throw new Error(`SQLite read-only worker snapshot cleanup failed: ${stagingRoot}`);
  }
  signal?.throwIfAborted();
  return header;
}

// Keep parent launch orchestration out of the native snapshot child's import graph.
export async function prepareSqliteReadOnlyLocation(
  pathname: string,
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal } = {},
): Promise<PreparedSqliteReadOnlyLocation> {
  const signal = resolveSqliteInspectionSignal(options.signal);
  let stagingRoot: string | undefined;
  try {
    signal?.throwIfAborted();
    const ownedSnapshot = prepareStateDatabaseMutationSnapshot(pathname, signal);
    if (ownedSnapshot) {
      const prepared = await ownedSnapshot;
      try {
        signal?.throwIfAborted();
        return prepared;
      } catch (error) {
        await prepared.cleanupAsync();
        throw error;
      }
    }
    if (hasStateDatabaseSourceExclusion(pathname)) {
      const prepared = options.preserveSourceArtifacts
        ? prepareSqliteReadOnlyLocationSyncInProcess(pathname)
        : await prepareSqliteReadOnlyLocationInProcess(pathname, undefined, signal);
      try {
        signal?.throwIfAborted();
        return prepared;
      } catch (error) {
        await prepared.cleanupAsync();
        throw error;
      }
    }
    // A stopped worker may never publish its random snapshot path. Allocate its
    // private parent first so cancellation can join the child and remove all copies.
    signal?.throwIfAborted();
    stagingRoot = await createSqliteSnapshotStagingDirectory(undefined, false, signal);
    signal?.throwIfAborted();
    const location = await runSqliteReadOnlyWorker(pathname, {
      mode: options.preserveSourceArtifacts ? "sync" : "async",
      signal,
      stagingRoot,
    });
    signal?.throwIfAborted();
    // Cancellable maintenance must retain its fence on cleanup failure; ordinary
    // read-only handles report false so their owner can retry close.
    return adoptPreparedLocation(location, stagingRoot, options.signal !== undefined);
  } catch (error) {
    if (stagingRoot && !(await removeTempDirectoryAsync(stagingRoot))) {
      throw new Error(
        `${coerceErrorMessage(error)}; SQLite snapshot cleanup failed: ${stagingRoot}`,
        {
          cause: error,
        },
      );
    }
    signal?.throwIfAborted();
    throw error;
  }
}

export function prepareSqliteReadOnlyLocationSync(
  pathname: string,
): PreparedSqliteReadOnlyLocation {
  if (hasStateDatabaseSourceExclusion(pathname)) {
    return prepareSqliteReadOnlyLocationSyncInProcess(pathname);
  }
  const stagingRoot = createSqliteSnapshotStagingDirectorySync();
  try {
    return adoptPreparedLocation(runSqliteReadOnlyWorkerSync(pathname, stagingRoot), stagingRoot);
  } catch (error) {
    if (!removeTempDirectory(stagingRoot)) {
      throw new SqliteSnapshotCleanupError(
        `${coerceErrorMessage(error)}; SQLite snapshot cleanup failed: ${stagingRoot}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function prepareSqliteSnapshotSource(
  pathname: string,
): Promise<PreparedSqliteReadOnlyLocation | undefined> {
  const canonicalPath = fs.realpathSync.native(pathname);
  const journalPath = `${canonicalPath}-journal`;
  let journal: BigIntStats;
  try {
    journal = fs.lstatSync(journalPath, { bigint: true });
  } catch (error) {
    // SAFETY: lstatSync on this canonical string path reports Node errno failures.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!journal.isFile()) {
    throw new Error(`SQLite rollback journal must be a regular file: ${journalPath}`);
  }
  return await prepareSqliteReadOnlyLocation(canonicalPath);
}

export async function withSqliteSnapshotSource<T>(
  pathname: string,
  operation: (sourcePath: string) => Promise<T>,
): Promise<T> {
  let prepared = await prepareSqliteSnapshotSource(pathname);
  try {
    try {
      return prepared
        ? await operation(prepared.location)
        : await withSqliteSourceHandleAsync(pathname, () => operation(pathname));
    } catch (error) {
      if (prepared) {
        throw error;
      }
      prepared = await prepareSqliteSnapshotSource(pathname);
      if (!prepared) {
        throw error;
      }
      return await operation(prepared.location);
    }
  } finally {
    await prepared?.cleanupAsync();
  }
}
