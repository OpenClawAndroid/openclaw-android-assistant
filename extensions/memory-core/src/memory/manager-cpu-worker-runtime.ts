import { ensureSqliteLibrarySelected } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  resolveRuntimeWorkerUrl,
  WorkerTaskPool,
  WorkerTaskError,
} from "openclaw/plugin-sdk/process-runtime";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import type {
  MemoryIndexPreparationInput,
  prepareMemoryIndexChunks,
} from "./manager-index-preparation.js";
import type {
  MemoryKeywordWorkerQuery,
  MemorySearchWorkerInput,
  MemorySearchWorkerOutput,
  MemoryVectorWorkerQuery,
} from "./manager-search.worker.js";
import {
  MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES,
  type MemoryShadowSessionInput,
  type MemoryShadowSessionResult,
  type MemoryShadowFailure,
} from "./manager-shadow-task.js";

export type MemoryIndexTask =
  | { kind: "prepare"; input: MemoryIndexPreparationInput }
  | MemoryShadowSessionInput;
export type MemoryIndexTaskResult =
  | { kind: "prepared"; value: ReturnType<typeof prepareMemoryIndexChunks> }
  | MemoryShadowSessionResult;

const retrieval = new WorkerTaskPool<MemorySearchWorkerInput, MemorySearchWorkerOutput>({
  workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.search),
  maxWorkers: 1,
  sharedCompute: true,
});
// Background chunk preparation must not occupy the foreground retrieval worker.
const indexing = new WorkerTaskPool<MemoryIndexTask, MemoryIndexTaskResult>({
  workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.index),
  maxWorkers: 1,
  sharedCompute: true,
  maxPendingBytes: MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES,
});

type MemoryReadTarget = { databasePath: string; agentId: string };

export async function runMemoryKeywordSearch(
  target: MemoryReadTarget,
  query: MemoryKeywordWorkerQuery,
  signal?: AbortSignal,
) {
  ensureSqliteLibrarySelected();
  const result = await retrieval.run(
    { ...target, kind: "keyword", query },
    {
      signal,
      inputBytes:
        2 *
        (query.body.query.length +
          (query.body.rankingQuery?.length ?? 0) +
          query.path.query.length +
          (query.path.exactPathQuery?.length ?? 0)),
    },
  );
  if (result.kind !== "keyword") {
    throw new Error("Invalid memory keyword worker result");
  }
  return result;
}

export async function runMemoryVectorFallback(
  target: MemoryReadTarget,
  query: MemoryVectorWorkerQuery,
  signal?: AbortSignal,
) {
  ensureSqliteLibrarySelected();
  const result = await retrieval.run(
    { ...target, kind: "vector", query },
    {
      signal,
      inputBytes: query.queryVec.length * 8,
    },
  );
  if (result.kind !== "vector") {
    throw new Error("Invalid memory vector worker result");
  }
  return result.rows;
}

export async function prepareMemoryIndexInWorker(input: MemoryIndexPreparationInput) {
  let inputBytes = input.content.length * 2 + (input.entry.lineMap?.length ?? 0) * 8;
  for (const provenance of input.entry.lineProvenance ?? []) {
    inputBytes +=
      32 +
      2 *
        (provenance.originClass.length +
          provenance.sessionKind.length +
          (provenance.supersedesKey?.length ?? 0));
  }
  const result = await indexing.run({ kind: "prepare", input }, { inputBytes });
  if (result.kind !== "prepared") {
    throw new Error("Invalid memory indexing worker result");
  }
  return result.value;
}

export async function replaceMemoryShadowSessionInWorker(
  input: MemoryShadowSessionInput,
  inputBytes: number,
): Promise<"staged" | "not-admitted"> {
  ensureSqliteLibrarySelected();
  let nativeSettled = false;
  let preparationStarted = false;
  let result: MemoryIndexTaskResult;
  try {
    result = await indexing.run(
      () => {
        preparationStarted = true;
        return input;
      },
      {
        // Charge the complete retained input even though a factory records admission.
        inputBytes,
        // The existing channel exposes consumption alongside host requests. This
        // task never requests host data; no retained input is hidden in this callback.
        onRequest: async () => {
          throw new Error("Unexpected memory shadow host request");
        },
        onInputConsumed: () => {
          nativeSettled = true;
        },
      },
    );
  } catch (error) {
    if (!preparationStarted && error instanceof WorkerTaskError && error.code === "overloaded") {
      return "not-admitted";
    }
    throw error;
  }
  if (
    !preparationStarted ||
    !nativeSettled ||
    (result.kind !== "session-replaced" && result.kind !== "session-failed")
  ) {
    throw new Error("Invalid memory shadow worker settlement");
  }
  if (result.kind === "session-failed") {
    const error = (value: MemoryShadowFailure) => Object.assign(new Error(value.message), value);
    throw Object.assign(error(result.error), {
      ...(result.cleanupError ? { cause: error(result.cleanupError) } : {}),
      entered: result.entered,
      committed: result.committed,
    });
  }
  return "staged";
}
