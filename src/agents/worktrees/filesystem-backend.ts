import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { extractErrorCode, isMissingPathError } from "../../infra/errors.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS } from "./git.js";

export type WorktreeFilesystemOptions = {
  signal?: AbortSignal;
  commitGuard: () => void;
};

export interface WorktreeFilesystemBackend {
  id: string;
  createTemplate: (path: string, options: WorktreeFilesystemOptions) => Promise<void>;
  cloneTemplate: (
    source: string,
    destination: string,
    options: WorktreeFilesystemOptions,
  ) => Promise<void>;
}

// Linux's BTRFS_SUPER_MAGIC identifies the destination volume, not its mount name.
const BTRFS_SUPER_MAGIC = 0x9123683e;

function assertActive(options: WorktreeFilesystemOptions): void {
  options.signal?.throwIfAborted();
  options.commitGuard();
}

async function requireAbsentDestination(
  destination: string,
  options: WorktreeFilesystemOptions,
): Promise<void> {
  assertActive(options);
  try {
    await fs.lstat(destination);
  } catch (error) {
    assertActive(options);
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  assertActive(options);
  // Snapshotting onto an existing directory creates a child instead of failing.
  throw new Error(`Worktree filesystem destination already exists: ${destination}`);
}

async function runBtrfsMutation(
  args: string[],
  destination: string,
  options: WorktreeFilesystemOptions,
): Promise<void> {
  await requireAbsentDestination(destination, options);
  assertActive(options);
  const result = await runCommandWithTimeout(["btrfs", "--quiet", "subvolume", ...args], {
    timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    signal: options.signal,
    killProcessTree: true,
  });
  assertActive(options);
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(
      `Btrfs subvolume ${args[0]} failed: ${result.stderr.trim() || result.termination}`,
    );
  }
}

const btrfsBackend: WorktreeFilesystemBackend = {
  id: "btrfs",
  async createTemplate(destination, options) {
    await runBtrfsMutation(["create", "--", destination], destination, options);
  },
  async cloneTemplate(source, destination, options) {
    await runBtrfsMutation(["snapshot", "--", source, destination], destination, options);
  },
};

async function cloneRefsDirectory(
  source: string,
  destination: string,
  options: WorktreeFilesystemOptions,
  cloneFile: (source: string, destination: string) => void,
): Promise<void> {
  const stats = await fs.lstat(source);
  if (!stats.isDirectory()) {
    throw new Error(`Worktree template is not a directory: ${source}`);
  }
  const entries = await fs.readdir(source, { withFileTypes: true });
  assertActive(options);
  await fs.mkdir(destination, { mode: 0o700 });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await cloneRefsDirectory(sourcePath, destinationPath, options, cloneFile);
    } else {
      assertActive(options);
      cloneFile(sourcePath, destinationPath);
      // Native clones are synchronous metadata operations. Yield between files
      // so cancellation and allocation-lease renewal can run in wide directories.
      await setImmediate();
    }
  }
  // Populate writable directories before restoring their source permissions.
  assertActive(options);
  await fs.chmod(destination, stats.mode & 0o777);
}

/** Probe without creating artifacts; the caller supplies an existing destination parent. */
export async function detectWorktreeFilesystemBackend(
  parentPath: string,
  options: WorktreeFilesystemOptions,
): Promise<WorktreeFilesystemBackend | null> {
  assertActive(options);
  if (process.platform === "win32") {
    const { refsFilesystem } = await import("./filesystem-refs.native.js");
    assertActive(options);
    const volume = refsFilesystem.probe(parentPath);
    if (!volume) {
      return null;
    }
    return {
      id: "refs",
      async createTemplate(destination, templateOptions) {
        assertActive(templateOptions);
        await fs.mkdir(destination);
      },
      async cloneTemplate(source, destination, cloneOptions) {
        await cloneRefsDirectory(source, destination, cloneOptions, (from, to) =>
          refsFilesystem.cloneFile(from, to, volume.clusterSize),
        );
      },
    };
  }
  if (process.platform === "darwin") {
    const { apfsFilesystem } = await import("./filesystem-apfs.native.js");
    const volume = await fs.statfs(parentPath);
    assertActive(options);
    if (apfsFilesystem.type === undefined || volume.type !== apfsFilesystem.type) {
      return null;
    }
    const parentAcl = apfsFilesystem.readDirectoryAcl(parentPath);
    if (parentAcl === undefined || parentAcl === "inheritable") {
      return null;
    }
    const assertCloneAcls = (directory: string, parent: string) => {
      const acl = apfsFilesystem.readDirectoryAcl(parent);
      // A private Git template can retain ACLs from its own parent. Do not
      // transplant those into another checkout or repair ACLs independently of Git.
      if (
        acl === undefined ||
        acl === "inheritable" ||
        apfsFilesystem.readDirectoryAcl(directory) !== "none"
      ) {
        throw new Error("APFS directory cloning cannot preserve directory ACLs; use Git checkout");
      }
    };
    return {
      id: "apfs",
      async createTemplate(destination, templateOptions) {
        assertActive(templateOptions);
        await fs.mkdir(destination);
      },
      async cloneTemplate(source, destination, cloneOptions) {
        const stats = await fs.lstat(source);
        if (!stats.isDirectory()) {
          throw new Error(`Worktree template is not a directory: ${source}`);
        }
        const parent = path.dirname(destination);
        assertCloneAcls(source, parent);
        assertActive(cloneOptions);
        // Join the atomic native operation even on cancellation, so recovery
        // cannot race a clone still writing the destination on another thread.
        await apfsFilesystem.cloneDirectory(source, destination);
        assertActive(cloneOptions);
        // Selection may precede a long template checkout. Recheck around the
        // native call, including ACLs inherited/copied onto the new root, so a
        // changed policy takes the existing cleanup + native Git fallback.
        assertCloneAcls(destination, parent);
      },
    };
  }
  if (process.platform !== "linux") {
    return null;
  }
  const volume = await fs.statfs(parentPath);
  assertActive(options);
  if (volume.type !== BTRFS_SUPER_MAGIC) {
    return null;
  }
  let result: SpawnResult;
  try {
    result = await runCommandWithTimeout(["btrfs", "--version"], {
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
      signal: options.signal,
      killProcessTree: true,
    });
  } catch (error) {
    assertActive(options);
    const code = extractErrorCode(error);
    if (code === "ENOENT" || code === "EACCES" || code === "ENOEXEC") {
      return null;
    }
    throw error;
  }
  assertActive(options);
  return result.termination === "exit" && result.code === 0 ? btrfsBackend : null;
}
