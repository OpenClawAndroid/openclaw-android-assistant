import fs from "node:fs";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

export type MemoryShadowConnection = {
  fileIdentity: { device: string; inode: string };
  extensionPath?: string;
  pragmas: {
    busy_timeout: number;
    synchronous: number;
    foreign_keys: number;
    wal_autocheckpoint: number;
    journal_size_limit: number;
    checkpoint_fullfsync: number;
  };
};

export type MemoryShadowSessionInput = MemoryShadowConnection & {
  kind: "replace-session";
  databasePath: string;
  beginDeadlineNs: bigint;
  replacement: Extract<MemorySourceIndexReplacement, { source: "sessions" }>;
  vector: { enabled: boolean; available: boolean | null };
  fts: { enabled: boolean; available: boolean };
};

export type MemoryShadowFailure = {
  name: string;
  message: string;
  code?: string;
  errcode?: number;
};

export type MemoryShadowSessionResult =
  | { kind: "session-replaced" }
  | {
      kind: "session-failed";
      error: MemoryShadowFailure;
      cleanupError?: MemoryShadowFailure;
      entered: boolean;
      committed: boolean;
    };

// The indexing pool already has this 256 MiB pending-input limit. Placement
// preserves larger supported sources on their original path until active-input
// framing can retain them without charging a complete value to the pending queue.
export const MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES = 256 * 1024 * 1024;

export function memoryShadowSessionInputBytes(input: MemoryShadowSessionInput): number {
  const { replacement } = input;
  let bytes =
    512 +
    2 *
      (input.databasePath.length +
        input.fileIdentity.device.length +
        input.fileIdentity.inode.length +
        (input.extensionPath?.length ?? 0) +
        replacement.entry.path.length +
        replacement.entry.hash.length +
        replacement.model.length +
        replacement.agentId.length +
        replacement.sessionId.length);
  for (const chunk of replacement.chunks) {
    bytes +=
      256 +
      2 *
        (chunk.text.length +
          chunk.hash.length +
          (chunk.triggers?.length ?? 0) +
          (chunk.projectKey?.length ?? 0) +
          (chunk.provenance?.originClass.length ?? 0) +
          (chunk.provenance?.sessionKind.length ?? 0) +
          (chunk.provenance?.supersedesKey?.length ?? 0));
  }
  for (const embedding of replacement.embeddings) {
    bytes += 32 + embedding.length * 8;
  }
  return bytes;
}

export function readMemoryShadowIdentity(filename: string): MemoryShadowConnection["fileIdentity"] {
  const info = fs.statSync(filename, { bigint: true });
  if (!info.isFile()) {
    throw new Error("Memory reindex shadow is not a regular file");
  }
  return { device: String(info.dev), inode: String(info.ino) };
}

export function assertMemoryShadowIdentity(
  filename: string,
  expected: MemoryShadowConnection["fileIdentity"],
): void {
  const actual = readMemoryShadowIdentity(filename);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error("Memory reindex shadow file changed during its owned lifetime");
  }
}
