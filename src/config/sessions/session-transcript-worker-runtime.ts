import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import {
  resolveSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type {
  SessionEntryWorkerInput,
  SessionModelContextWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript.worker.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);
const modelContextReads = new WorkerTaskPool<
  SessionModelContextWorkerInput,
  SessionTranscriptWorkerReply<"model-context">
>({
  workerUrl,
  // Preserve context-read admission order and avoid multiplying large SQLite scans.
  maxWorkers: 1,
});

// Background transcript exports cannot occupy the foreground context worker.
const sessionEntries = new WorkerTaskPool<
  SessionEntryWorkerInput,
  SessionTranscriptWorkerReply<"session-entry">
>({ workerUrl, maxWorkers: 1, sharedCompute: true });

function unwrapReply<Kind extends "model-context" | "session-entry">(
  reply: SessionTranscriptWorkerReply<Kind>,
) {
  if (reply.ok) {
    return reply.value;
  }
  if (reply.error.kind === "cold") {
    throw new SessionTranscriptColdError(reply.error.sessionId);
  }
  throw new SessionTranscriptReadFenceError(reply.error.message);
}

export async function readSessionTranscriptModelContextAsync(
  target: SessionTranscriptRuntimeTarget,
  admission: SessionModelContextWorkerInput["admission"],
  signal?: AbortSignal,
  through?: SessionModelContextWorkerInput["through"],
): Promise<ReturnType<typeof readSessionTranscriptModelContext>> {
  signal?.throwIfAborted();
  return unwrapReply<"model-context">(
    await modelContextReads.run(
      { kind: "model-context", target, admission, through },
      { timeoutMs: 60_000, signal },
    ),
  );
}

export async function prepareSessionEntryInWorker(
  absPath: string,
  options: SessionEntryWorkerInput["options"],
  redaction: SensitiveTextRedactionSnapshot,
) {
  const receipt = resolveSessionTranscriptReadFence(options);
  return unwrapReply<"session-entry">(
    await sessionEntries.run(
      {
        kind: "session-entry",
        absPath,
        options,
        redaction,
        ...(receipt ? { admission: { ...receipt } } : {}),
      },
      {
        inputBytes:
          2 *
          (absPath.length +
            options.agentId.length +
            options.sessionId.length +
            options.storePath.length +
            (options.sessionKey?.length ?? 0) +
            redaction.registeredSecretValues.reduce((bytes, value) => bytes + value.length, 0)),
      },
    ),
  );
}
