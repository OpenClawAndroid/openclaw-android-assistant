import { createHash } from "node:crypto";
import { runGitBuffered } from "../../agents/worktrees/git.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../server-methods/workspace-fs.js";
import {
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  parseWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { manifestNodes } from "./workspace-reconcile-core.js";
import { reconciliationEntries } from "./workspace-reconcile-derived-paths.js";
import { WORKSPACE_RESULT_GIT_TIMEOUT_MS as PATCH_TIMEOUT_MS } from "./workspace-result-git.js";
import {
  requireWorkerResultStorageRef,
  STAGED_RESULT_MESSAGE,
  type StagedWorkerArtifactInventory,
  type StagedWorkerWorkspaceInventory,
  type WorkspaceArtifactReadOperations,
} from "./workspace-result-inventory.js";

const STAGED_RESULT_METADATA_LIMIT = 128 * 1024 * 1024 + 4_096;

export function parseChangedWorkspaceResult(
  base: WorkerWorkspaceManifest,
  current: WorkerWorkspaceManifest,
  enforceRecordLimit = true,
): { changed: boolean; entries: WorkerWorkspaceManifestEntry[] } {
  const baseNodes = manifestNodes(base);
  const currentNodes = manifestNodes(current);
  const changed = new Set(
    [...new Set([...baseNodes.keys(), ...currentNodes.keys()])].filter(
      (entryPath) =>
        JSON.stringify(baseNodes.get(entryPath)) !== JSON.stringify(currentNodes.get(entryPath)),
    ),
  );
  const recordCount = [...changed].reduce(
    (count, entryPath) =>
      count + Number(baseNodes.has(entryPath)) + Number(currentNodes.has(entryPath)),
    0,
  );
  if (enforceRecordLimit && recordCount > MAX_RECONCILIATION_ENTRIES) {
    throw new Error(
      `Cloud workspace reconciliation exceeds the ${MAX_RECONCILIATION_ENTRIES} entry limit`,
    );
  }
  let totalBytes = 0;
  const entries = reconciliationEntries(current.entries).filter((entry) => changed.has(entry.path));
  for (const entry of entries) {
    if (entry.type === "file" && entry.size > MAX_RECONCILIATION_FILE_BYTES) {
      throw new Error(`Cloud workspace result is too large: ${entry.path}`);
    }
    totalBytes += entry.type === "file" ? entry.size : Buffer.byteLength(entry.target);
    if (totalBytes > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Cloud workspace staged result exceeds its byte limit");
    }
  }
  return { changed: recordCount > 0, entries };
}

async function readGitBlob(params: {
  root: string;
  objectId: string;
  maxBytes: number;
}): Promise<Buffer> {
  const result = await runGitBuffered(params.root, ["cat-file", "blob", params.objectId], {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: params.maxBytes + 1,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || "git cat-file failed");
  }
  if (result.stdout.byteLength > params.maxBytes) {
    throw new Error("Cloud workspace staged result exceeds its byte limit");
  }
  return result.stdout;
}

export async function loadStagedWorkerWorkspace(
  root: string,
  stagedResultRef: string,
): Promise<StagedWorkerWorkspaceInventory> {
  const ref = requireWorkerResultStorageRef(stagedResultRef);
  const rawCommit = await runGitBuffered(root, ["cat-file", "commit", ref], {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: STAGED_RESULT_METADATA_LIMIT,
  });
  if (rawCommit.termination !== "exit" || rawCommit.code !== 0) {
    throw new Error(rawCommit.stderr.toString("utf8").trim() || "git cat-file failed");
  }
  const commitHeaderEnd = rawCommit.stdout.indexOf("\n\n");
  if (commitHeaderEnd < 0) {
    throw new Error("Cloud workspace staged result metadata is invalid");
  }
  const message = rawCommit.stdout.subarray(commitHeaderEnd + 2);
  const metadataEnd = message.indexOf("\n\n");
  if (metadataEnd < 0) {
    throw new Error("Cloud workspace staged result metadata is invalid");
  }
  const lines = message.subarray(0, metadataEnd).toString("utf8").split("\n");
  const version = lines[1] === "version 1" ? 1 : lines[1] === "version 2" ? 2 : undefined;
  const match = /^sha256:[a-f0-9]{64}$/u;
  const baseManifestRef = lines[2]?.slice("base-ref ".length) ?? "";
  const currentManifestRef = lines[3]?.slice("current-ref ".length) ?? "";
  const baseBytes = Number(lines[4]?.slice("base-bytes ".length));
  const currentBytes = Number(lines[5]?.slice("current-bytes ".length));
  if (
    lines[0] !== STAGED_RESULT_MESSAGE ||
    version === undefined ||
    !lines[2]?.startsWith("base-ref ") ||
    !lines[3]?.startsWith("current-ref ") ||
    !lines[4]?.startsWith("base-bytes ") ||
    !lines[5]?.startsWith("current-bytes ") ||
    lines.length !== 6 ||
    !match.test(baseManifestRef) ||
    !match.test(currentManifestRef) ||
    !Number.isSafeInteger(baseBytes) ||
    baseBytes < 0 ||
    !Number.isSafeInteger(currentBytes) ||
    currentBytes < 0
  ) {
    throw new Error("Cloud workspace staged result metadata is invalid");
  }
  const manifests = message.subarray(metadataEnd + 2);
  if (manifests.byteLength !== baseBytes + currentBytes) {
    throw new Error("Cloud workspace staged result metadata is truncated");
  }
  const baseRaw = manifests.subarray(0, baseBytes).toString("utf8");
  const currentRaw = manifests.subarray(baseBytes).toString("utf8");
  const base = parseWorkerWorkspaceManifest(baseRaw, baseManifestRef);
  const current = parseWorkerWorkspaceManifest(currentRaw, currentManifestRef);
  // Shipped v1 refs carry a complete current tree and predate the conservative
  // manifest worst-case record gate. Recovery still validates their manifests,
  // tree shape, and changed payload bytes; the apply owner caps actual records.
  const changedResult = parseChangedWorkspaceResult(base, current, version !== 1);
  const changedEntries = changedResult.entries;
  const treeEntries = version === 1 ? reconciliationEntries(current.entries) : changedEntries;
  const tree = await runGitBuffered(root, ["ls-tree", "-r", "-z", "--full-tree", ref], {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: 2 * MAX_RECONCILIATION_FILE_BYTES,
  });
  if (tree.termination !== "exit" || tree.code !== 0) {
    throw new Error(tree.stderr.toString("utf8").trim() || "git ls-tree failed");
  }
  const objectsByPath = new Map<string, { mode: string; objectId: string }>();
  for (const record of tree.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const parsed = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(
      record,
    );
    if (!parsed) {
      throw new Error("Cloud workspace staged result tree is invalid");
    }
    objectsByPath.set(parsed[3]!, { mode: parsed[1]!, objectId: parsed[2]! });
  }
  if (objectsByPath.size !== treeEntries.length) {
    throw new Error("Cloud workspace staged result tree does not match its manifest");
  }
  for (const entry of treeEntries) {
    const object = objectsByPath.get(entry.path);
    const expectedMode =
      entry.type === "symlink" ? "120000" : (entry.mode & 0o111) !== 0 ? "100755" : "100644";
    if (!object || object.mode !== expectedMode) {
      throw new Error(`Cloud workspace staged result tree is invalid: ${entry.path}`);
    }
  }
  return {
    baseManifestRaw: baseRaw,
    currentManifestRaw: currentRaw,
    baseManifestRef,
    currentManifestRef,
    base,
    current,
    changed: changedResult.changed,
    changedEntries,
    objectsByPath,
  };
}

export async function readStagedWorkerWorkspaceEntry(
  params: { root: string; objectsByPath: StagedWorkerWorkspaceInventory["objectsByPath"] },
  entry: WorkerWorkspaceManifestEntry,
): Promise<Buffer> {
  const object = params.objectsByPath.get(entry.path);
  if (!object) {
    throw new Error(`Cloud workspace result has no payload for ${entry.path}`);
  }
  const content = await readGitBlob({
    root: params.root,
    objectId: object.objectId,
    maxBytes: MAX_RECONCILIATION_FILE_BYTES,
  });
  const matches =
    entry.type === "symlink"
      ? content.toString("utf8") === entry.target
      : content.byteLength === entry.size &&
        createHash("sha256").update(content).digest("hex") === entry.sha256;
  if (!matches) {
    throw new Error(`Cloud workspace staged result payload is invalid: ${entry.path}`);
  }
  return content;
}

export async function collectStagedWorkerArtifacts(
  input: WorkspaceArtifactReadOperations["workspace.artifacts"]["input"],
): Promise<StagedWorkerArtifactInventory> {
  const snapshot = await loadStagedWorkerWorkspace(input.root, input.ref);
  const currentPaths = new Set(snapshot.current.entries.map((entry) => entry.path));
  const basePaths = new Set(snapshot.base.entries.map((entry) => entry.path));
  const changes: StagedWorkerArtifactInventory["changes"] = [
    ...snapshot.changedEntries.map((entry) => ({
      path: entry.path,
      status: basePaths.has(entry.path) ? ("modified" as const) : ("added" as const),
      additions: 0,
      deletions: 0,
    })),
    ...snapshot.base.entries
      .filter((entry) => !currentPaths.has(entry.path))
      .map((entry) => ({
        path: entry.path,
        status: "deleted" as const,
        additions: 0,
        deletions: 0,
      })),
  ].toSorted((left, right) => left.path.localeCompare(right.path));
  const selected = snapshot.changedEntries.find((entry) => entry.path === input.previewPath);
  const preview =
    selected?.type === "file" && selected.size <= WORKSPACE_PREVIEW_MAX_BYTES
      ? await readStagedWorkerWorkspaceEntry(
          { root: input.root, objectsByPath: snapshot.objectsByPath },
          selected,
        )
      : undefined;
  return {
    baseManifestRef: snapshot.baseManifestRef,
    currentManifestRef: snapshot.currentManifestRef,
    base: { baseCommit: snapshot.base.baseCommit },
    current: { baseCommit: snapshot.current.baseCommit },
    changedEntries: snapshot.changedEntries,
    changes,
    ...(preview === undefined ? {} : { preview }),
  };
}
