import type {
  BuildSessionEntryOptions,
  SessionFileEntry,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { serveWorkerTasks } from "../../infra/worker-task-pool.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type SessionModelContextWorkerInput = {
  kind: "model-context";
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
  through?: TranscriptEntryAnchor;
};

export type SessionEntryWorkerInput = {
  kind: "session-entry";
  absPath: string;
  options: Omit<BuildSessionEntryOptions, "onTranscriptMessage" | "parseYieldEveryLines"> & {
    agentId: string;
    sessionId: string;
    storePath: string;
  };
  admission?: UserTurnTranscriptAdmissionReceipt;
  redaction: SensitiveTextRedactionSnapshot;
};

type SessionTranscriptWorkerValues = {
  "model-context": ReturnType<typeof readSessionTranscriptModelContext>;
  "session-entry": {
    entry: SessionFileEntry | null;
    resetRecallCutoff: ReturnType<typeof readSessionEntryResetRecallCutoff>;
    readError?: string;
  };
};

export type SessionTranscriptWorkerReply<Kind extends keyof SessionTranscriptWorkerValues> =
  | { ok: true; value: SessionTranscriptWorkerValues[Kind] }
  | {
      ok: false;
      error: { kind: "cold"; sessionId: string } | { kind: "fence"; message: string };
    };

serveWorkerTasks(
  async (input): Promise<SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues>> => {
    // SAFETY: The paired runtime constructs this request; the SQLite snapshot validates admission.
    const request = input as SessionModelContextWorkerInput | SessionEntryWorkerInput;
    try {
      return await runWithSessionTranscriptReadFence(
        request.admission,
        async (): Promise<SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues>> => {
          if (request.kind === "model-context") {
            const { readSessionTranscriptModelContext } =
              await import("./session-accessor.sqlite-model-context.js");
            return {
              ok: true,
              value: readSessionTranscriptModelContext(request.target, request.through),
            };
          }
          const { buildSessionEntryInProcess, readSessionEntryResetRecallCutoff } =
            await import("../../../packages/memory-host-sdk/src/host/session-files.js");
          const { createSensitiveTextRedactor } = await import("../../logging/redact.js");
          let readError: string | undefined;
          const entry = await buildSessionEntryInProcess(
            request.absPath,
            request.options,
            createSensitiveTextRedactor(request.redaction),
            (error) => {
              readError = String(error);
            },
          );
          return {
            ok: true,
            value: {
              entry,
              resetRecallCutoff: entry
                ? readSessionEntryResetRecallCutoff(entry)
                : { state: "absent" },
              ...(readError !== undefined ? { readError } : {}),
            },
          };
        },
      );
    } catch (error) {
      if (error instanceof SessionTranscriptColdError) {
        return { ok: false, error: { kind: "cold", sessionId: error.sessionId } };
      }
      if (error instanceof SessionTranscriptReadFenceError) {
        return { ok: false, error: { kind: "fence", message: error.message } };
      }
      throw error;
    }
  },
);
