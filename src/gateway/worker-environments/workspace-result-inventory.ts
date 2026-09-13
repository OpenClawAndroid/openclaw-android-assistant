import type { SessionDiffFile } from "../../../packages/gateway-protocol/src/index.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";

// Deleting the owning ref releases its objects to ordinary Git garbage collection.
export const WORKER_RESULT_REF_PREFIX = "refs/openclaw/worker-results";
export const WORKER_RESULT_CANDIDATE_REF_PREFIX = "refs/openclaw/worker-result-candidates";
export const WORKER_RESULT_CLEANUP_REF_PREFIX = "refs/openclaw/worker-result-cleanup";
export const STAGED_RESULT_MESSAGE = "OpenClaw worker workspace result";

export function requireWorkerResultStorageRef(ref: string): string {
  if (
    !new RegExp(
      `^(?:${WORKER_RESULT_REF_PREFIX}|${WORKER_RESULT_CANDIDATE_REF_PREFIX}|${WORKER_RESULT_CLEANUP_REF_PREFIX})/[A-Za-z0-9-]+$`,
      "u",
    ).test(ref)
  ) {
    throw new Error("Cloud workspace staged result reference is invalid");
  }
  return ref;
}

export type StagedWorkerWorkspaceInventory = {
  baseManifestRaw: string;
  currentManifestRaw: string;
  baseManifestRef: string;
  currentManifestRef: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  changed: boolean;
  changedEntries: WorkerWorkspaceManifestEntry[];
  objectsByPath: Map<string, { mode: string; objectId: string }>;
};

export type StagedWorkerArtifactInventory = {
  baseManifestRef: string;
  currentManifestRef: string;
  base: Pick<WorkerWorkspaceManifest, "baseCommit">;
  current: Pick<WorkerWorkspaceManifest, "baseCommit">;
  changedEntries: WorkerWorkspaceManifestEntry[];
  changes: SessionDiffFile[];
  preview?: Uint8Array;
};

export type WorkspaceArtifactReadOperations = {
  "workspace.artifacts": {
    input: { root: string; ref: string; previewPath?: string };
    output: StagedWorkerArtifactInventory;
  };
};
