import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import { apfsFilesystem, type ApfsFileMetadata } from "./filesystem-apfs.native.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.js";

type IndexEntry = { offset: number; name: string };

// gitformat-index(5): support ordinary v2/v3 indexes, with either object hash.
// Unsupported representations keep Git's normal refresh path.
function parseIndex(data: Buffer) {
  const algorithm = (["sha1", "sha256"] as const).find((candidate) => {
    const size = candidate === "sha1" ? 20 : 32;
    return (
      data.length >= 12 + size &&
      createHash(candidate).update(data.subarray(0, -size)).digest().equals(data.subarray(-size))
    );
  });
  if (
    !algorithm ||
    data.toString("ascii", 0, 4) !== "DIRC" ||
    ![2, 3].includes(data.readUInt32BE(4))
  ) {
    return undefined;
  }
  const hashSize = algorithm === "sha1" ? 20 : 32;
  const end = data.length - hashSize;
  const entries: IndexEntry[] = [];
  let offset = 12;
  let previous: Buffer | undefined;
  for (let i = 0; i < data.readUInt32BE(8); i++) {
    const start = offset;
    const nameStart = start + 42 + hashSize;
    if (nameStart >= end || (data.readUInt16BE(nameStart - 2) & 0xf000) !== 0) {
      return undefined;
    }
    const nameEnd = data.indexOf(0, nameStart);
    if (nameEnd < nameStart || nameEnd >= end) {
      return undefined;
    }
    const bytes = data.subarray(nameStart, nameEnd);
    const name = bytes.toString("utf8");
    if (
      (data.readUInt16BE(nameStart - 2) & 0x0fff) !== Math.min(bytes.length, 0x0fff) ||
      !isUtf8(bytes) ||
      (previous && Buffer.compare(previous, bytes) >= 0) ||
      name
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
    ) {
      return undefined;
    }
    previous = bytes;
    offset = start + Math.ceil((nameEnd + 1 - start) / 8) * 8;
    if (offset > end || !data.subarray(nameEnd, offset).every((byte) => byte === 0)) {
      return undefined;
    }
    entries.push({ offset: start, name });
  }
  const entriesEnd = offset;
  const extensions: Buffer[] = [];
  while (offset < end) {
    if (offset + 8 > end || data[offset]! < 0x41 || data[offset]! > 0x5a) {
      return undefined;
    }
    const next = offset + 8 + data.readUInt32BE(offset + 4);
    if (next > end) {
      return undefined;
    }
    // Tree OIDs are unchanged. Discard optional stat-dependent caches and
    // extension-offset checksums; mandatory extensions require native Git.
    if (data.toString("ascii", offset, offset + 4) === "TREE") {
      extensions.push(data.subarray(offset, next));
    }
    offset = next;
  }
  return { algorithm, entries, entriesEnd, extensions };
}

function low32(value: bigint): number {
  return Number(value & 0xffffffffn);
}

function matchesSource(data: Buffer, offset: number, stat: ApfsFileMetadata): boolean {
  const size = low32(stat.size) || (stat.size ? 0x80000000 : 0);
  return (
    stat.type === 1 &&
    data.readUInt32BE(offset) === stat.ctimeSec >>> 0 &&
    data.readUInt32BE(offset + 4) === stat.ctimeNs &&
    data.readUInt32BE(offset + 8) === stat.mtimeSec >>> 0 &&
    data.readUInt32BE(offset + 12) === stat.mtimeNs &&
    data.readUInt32BE(offset + 16) === stat.dev &&
    data.readUInt32BE(offset + 20) === low32(stat.ino) &&
    (data.readUInt32BE(offset + 24) & 0o100) === (stat.mode & 0o100) &&
    data.readUInt32BE(offset + 28) === stat.uid &&
    data.readUInt32BE(offset + 32) === stat.gid &&
    data.readUInt32BE(offset + 36) === size
  );
}

/** Translate only clone-proven stat identities; Git still validates the result. */
export async function copyApfsCloneIndex(
  source: string,
  destination: string,
  sourceIndex: string,
  destinationIndex: string,
  options: WorktreeFilesystemOptions,
): Promise<boolean> {
  const handle = await fs.open(sourceIndex, "r");
  const { data, stamp } = await (async () => {
    try {
      const before = await handle.stat({ bigint: true });
      const contents = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      return {
        data:
          before.mtimeNs === after.mtimeNs &&
          before.ctimeNs === after.ctimeNs &&
          before.size === after.size
            ? contents
            : undefined,
        stamp: before,
      };
    } finally {
      await handle.close();
    }
  })();
  const parsed = data && parseIndex(data);
  if (!data || !parsed) {
    return false;
  }
  // Some Git builds compare timestamps only to whole seconds. Let the clone's
  // ctime second end BEFORE taking provenance snapshots: later same-size edits
  // must then change ctime even when their original mtime is restored.
  await setTimeout(1000 - (Date.now() % 1000), undefined, { signal: options.signal });
  const updated = Buffer.from(data.subarray(0, parsed.entriesEnd));
  for (const [i, entry] of parsed.entries.entries()) {
    if (i % 256 === 0) {
      await setImmediate();
      options.signal?.throwIfAborted();
      options.commitGuard();
    }
    const offset = entry.offset;
    if (
      (data.readUInt32BE(offset + 24) & 0xf000) !== 0x8000 ||
      BigInt(data.readUInt32BE(offset + 8)) >= stamp.mtimeNs / 1_000_000_000n
    ) {
      continue;
    }
    const snapshotSecond = Math.floor(Date.now() / 1000);
    const original = apfsFilesystem.readFileMetadata(path.join(source, entry.name));
    const cloned = apfsFilesystem.readFileMetadata(path.join(destination, entry.name));
    if (
      !original ||
      !cloned ||
      !matchesSource(data, offset, original) ||
      cloned.type !== 1 ||
      cloned.ctimeSec >= snapshotSecond ||
      !original.cloneId ||
      original.cloneId !== cloned.cloneId ||
      original.dev !== cloned.dev ||
      original.ino === cloned.ino ||
      original.size !== cloned.size ||
      original.mtimeSec !== cloned.mtimeSec ||
      original.mtimeNs !== cloned.mtimeNs ||
      (original.mode & 0o100) !== (cloned.mode & 0o100)
    ) {
      continue;
    }
    // Keep OIDs, modes, mtime and size. A mismatch or unsupported entry is left
    // untouched for Git to rehash instead of blessing current filesystem data.
    updated.writeUInt32BE(cloned.ctimeSec >>> 0, offset);
    updated.writeUInt32BE(cloned.ctimeNs, offset + 4);
    updated.writeUInt32BE(cloned.dev, offset + 16);
    updated.writeUInt32BE(low32(cloned.ino), offset + 20);
    updated.writeUInt32BE(cloned.uid, offset + 28);
    updated.writeUInt32BE(cloned.gid, offset + 32);
  }
  const body = Buffer.concat([updated, ...parsed.extensions]);
  options.signal?.throwIfAborted();
  options.commitGuard();
  await fs.writeFile(
    destinationIndex,
    Buffer.concat([body, createHash(parsed.algorithm).update(body).digest()]),
  );
  return true;
}
