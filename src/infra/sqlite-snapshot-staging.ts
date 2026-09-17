import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { getChildLogger } from "../logging/logger.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import {
  createPrivateSqliteTempDirectorySync,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "./sqlite-private-directory.js";
import {
  registerSnapshotTempDirectory,
  removeTempDirectory,
  SQLITE_SNAPSHOT_CONTROL_FILES,
} from "./sqlite-readonly-location-cleanup.js";

const prefix = "openclaw-sqlite-readonly-v2-";
const suffix = "(?:[A-Za-z0-9]{6}|[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12})$";
const legacyMarker = new RegExp(`^openclaw-sqlite-readonly-[1-9]\\d*-${suffix}`, "u");
const tokenMarker = new RegExp(`^${prefix}${suffix}`, "u");
const tokenName = SQLITE_SNAPSHOT_CONTROL_FILES[0];
const scannedRoots = new Set<string>();
type ReclamationPass = { controller: AbortController; callers: number; done: Promise<void> };
const pendingReclamations = new Map<string, ReclamationPass>();
const legacyAgeMs = 24 * 60 * 60 * 1000;
const isStagingName = (name: string) => legacyMarker.test(name) || tokenMarker.test(name);
type SnapshotToken = (retiring?: boolean) => void;

function stagingParent(root: string): string | undefined {
  const parent = path.basename(root) === "openclaw" ? path.dirname(root) : root;
  return isStagingName(path.basename(parent)) ? parent : undefined;
}

function warn(message: string, error?: unknown): void {
  try {
    getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
      { errorCode: extractErrorCode(error) },
      message,
    );
  } catch {
    // Cleanup diagnostics must not prevent inspection or startup.
  }
}

function snapshotToken(directory: string, mode: "create" | "read" | "reclaim"): SnapshotToken {
  const location = path.join(directory, tokenName);
  // Check sidecars before SQLite may recover or remove a private journal.
  const family = SQLITE_SNAPSHOT_CONTROL_FILES.map((file) =>
    fs.lstatSync(path.join(directory, file), { throwIfNoEntry: false }),
  );
  const existing = family[0];
  if (
    family.some(
      (file) => file && (!file.isFile() || (process.getuid && file.uid !== process.getuid())),
    ) ||
    (!existing && mode !== "create" && !legacyMarker.test(path.basename(directory)))
  ) {
    throw new Error("SQLite snapshot token ownership is unknown");
  }
  // Shipped drivers may supply a legacy parent without a token. Cooperating
  // workers/reclaimers create the same inode; SQLite arbitrates admission.
  // CREATE never recreates a missing parent directory.
  const db = openNodeSqliteDatabase(existing ? resolveExistingSqliteFileUri(location) : location);
  const release: SnapshotToken = (retiring = false) => {
    if (!db.isOpen) {
      return;
    }
    if (retiring) {
      // Windows handles omit FILE_SHARE_DELETE: commit retirement while fenced,
      // then close for removal. Late workers reject the committed marker.
      if (!db.isTransaction) {
        db.exec("BEGIN IMMEDIATE");
      }
      db.exec("PRAGMA user_version=1; COMMIT");
    }
    db.close();
  };
  try {
    db.exec(
      `PRAGMA busy_timeout=0; ${mode === "create" ? "BEGIN IMMEDIATE" : mode === "reclaim" ? "BEGIN EXCLUSIVE" : "BEGIN; SELECT rootpage FROM sqlite_schema LIMIT 1"}`,
    );
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") {
      throw new Error("SQLite snapshot token journal mode is unknown");
    }
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && (mode !== "reclaim" || version !== 1)) {
      throw new Error("SQLite snapshot parent retired; aborting snapshot allocation");
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

function inspectSnapshot(
  directory: string,
  tokens: SnapshotToken[] | undefined,
  cutoff: number,
  layout = "",
): { bytes: number; newest: number } {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Snapshot directory ownership is unknown");
  }
  const legacy = !layout && legacyMarker.test(path.basename(directory));
  // Check all legacy activity without creating tokens, then repeat under locks.
  // Even creating an empty token would otherwise postpone a recent copy's expiry.
  if (legacy && tokens) {
    inspectSnapshot(directory, undefined, cutoff, layout);
  }
  if (!layout && tokens) {
    tokens.push(snapshotToken(directory, "reclaim"));
  }
  let bytes = 0;
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    const item = fs.lstatSync(location);
    if (process.getuid && item.uid !== process.getuid()) {
      throw new Error("Snapshot file ownership is unknown");
    }
    // Coordination files are neither copied data nor evidence of legacy activity.
    if (
      !layout &&
      item.isFile() &&
      SQLITE_SNAPSHOT_CONTROL_FILES.some((file) => file === entry.name)
    ) {
      continue;
    }
    newest = Math.max(newest, item.mtimeMs);
    if (item.isDirectory()) {
      const nested = (!layout || layout === "openclaw") && isStagingName(entry.name);
      const childLayout = nested ? "" : [layout, entry.name].filter(Boolean).join("/");
      if (
        !nested &&
        !["openclaw", "openclaw-state", "openclaw-state/state"].includes(childLayout)
      ) {
        throw new Error("Unrecognized snapshot directory");
      }
      const child = inspectSnapshot(location, tokens, cutoff, childLayout);
      bytes += child.bytes;
      newest = Math.max(newest, child.newest);
    } else if (
      item.isFile() &&
      (layout === "openclaw-state/state"
        ? /^openclaw\.sqlite(?:-wal|-shm|-journal)?$/u.test(entry.name)
        : !layout &&
          /^(?:first|database\.sqlite(?:\.partial)?(?:-wal|-shm|-journal)?)$/u.test(entry.name))
    ) {
      bytes += item.size;
    } else {
      throw new Error("Unrecognized snapshot artifact");
    }
  }
  // Also protects old selected workers nested below a current-generation parent.
  if (legacy && newest >= cutoff) {
    throw new Error("Legacy snapshot contains activity newer than 24 hours");
  }
  return { bytes, newest };
}

export function* reclaimAbandonedSqliteSnapshots(root: string, report = warn): Generator<void> {
  if (stagingParent(root) || scannedRoots.has(root)) {
    return;
  }
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const legacy = legacyMarker.test(entry.name);
      if (!entry.isDirectory() || !isStagingName(entry.name)) {
        continue;
      }
      const directory = path.join(root, entry.name);
      const tokens: SnapshotToken[] = [];
      try {
        const { bytes } = inspectSnapshot(directory, tokens, Date.now() - legacyAgeMs);
        for (const token of tokens) {
          token(true);
        }
        const claimed = path.join(
          root,
          `${legacy ? `openclaw-sqlite-readonly-${process.pid}-` : prefix}${randomUUID()}`,
        );
        fs.renameSync(directory, claimed);
        if (!removeTempDirectory(claimed)) {
          throw new Error("Snapshot removal failed; check private cache permissions");
        }
        report(`Reclaimed ${bytes} bytes of interrupted SQLite snapshot data.`);
      } catch (error) {
        report("Skipped SQLite snapshot reclamation: owner live, recent, or unverified.", error);
      } finally {
        for (const token of tokens) {
          token();
        }
      }
      // Yield only after retirement, removal, and token release settle together.
      yield;
    }
  } catch (error) {
    report("SQLite snapshot reclamation failed; check private cache permissions.", error);
  }
  scannedRoots.add(root);
}

export async function allocateSqliteSnapshotStagingDirectory(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
  allowLegacyWorker = false,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!stagingParent(root)) {
    while (!scannedRoots.has(root)) {
      signal?.throwIfAborted();
      let pass = pendingReclamations.get(root);
      if (!pass) {
        const controller = new AbortController();
        pass = {
          controller,
          callers: 0,
          done: (async () => {
            try {
              const { runSqliteReadOnlyWorker } = await import("./sqlite-readonly-worker.js");
              if (!controller.signal.aborted) {
                for (const message of await runSqliteReadOnlyWorker(root, {
                  mode: "reclaim",
                  signal: controller.signal,
                })) {
                  warn(message);
                }
              }
            } catch (error) {
              warn(
                "SQLite snapshot reclamation worker failed; continuing without cache cleanup.",
                error,
              );
            } finally {
              // Cancellation leaves unvisited directories for the next allocation.
              // Other failures remain best effort, without a blocking sync fallback.
              if (!controller.signal.aborted) {
                scannedRoots.add(root);
              }
              pendingReclamations.delete(root);
            }
          })(),
        };
        pendingReclamations.set(root, pass);
      }
      // A stopping pass cannot accept new callers; wait for its directory to
      // settle, then start a fresh pass. Both waits remain caller-cancellable.
      const joined = !pass.controller.signal.aborted;
      if (joined) {
        pass.callers++;
      }
      try {
        await racePromiseWithAbortSignal(pass.done, signal);
      } finally {
        if (joined && --pass.callers === 0 && signal?.aborted) {
          pass.controller.abort();
        }
      }
    }
  }
  signal?.throwIfAborted();
  // Allocation and token registration stay atomic after the shared scan settles.
  return createSqliteSnapshotStagingDirectorySync(root, allowLegacyWorker);
}

export function createSqliteSnapshotStagingDirectorySync(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
  allowLegacyWorker = false,
): string {
  // A shared parent token fences admission until the child's own token is held.
  // No mkdir of root: a late orphan must abort if reclamation already won.
  const parentDirectory = stagingParent(root);
  const parent = parentDirectory ? snapshotToken(parentDirectory, "read") : undefined;
  let directory: string | undefined;
  try {
    if (!parent) {
      for (const _ of reclaimAbandonedSqliteSnapshots(root)) {
        // Synchronous callers drain the same directory-boundary iterator.
      }
    }
    // A selected installation may launch a worker without token admission.
    directory = createPrivateSqliteTempDirectorySync(
      root,
      allowLegacyWorker ? `openclaw-sqlite-readonly-${process.pid}-` : prefix,
    );
    registerSnapshotTempDirectory(directory, snapshotToken(directory, "create"));
    return directory;
  } catch (error) {
    if (directory) {
      removeTempDirectory(directory);
    }
    throw error;
  } finally {
    parent?.();
  }
}
