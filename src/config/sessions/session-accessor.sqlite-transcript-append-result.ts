import type {
  appendTranscriptEventSnapshotSync,
  TranscriptWriteSnapshot,
} from "./session-accessor.sqlite-transcript-write.js";

export function requireTranscriptEventAppendSnapshot(
  result: ReturnType<typeof appendTranscriptEventSnapshotSync>,
  message: string,
): TranscriptWriteSnapshot<boolean> {
  if (result.ok && result.value.result) {
    return result.value;
  }
  const cause = result.ok ? { code: "transcript-event-not-appended" as const } : result.error;
  throw new Error(`${message}: ${cause.code}`, { cause });
}
