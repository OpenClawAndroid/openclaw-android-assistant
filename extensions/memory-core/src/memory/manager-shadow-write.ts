import type { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  runSqliteImmediateTransaction,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  assertMemoryShadowIdentity,
  type MemoryShadowSessionInput,
  type MemoryShadowSessionResult,
  type MemoryShadowFailure,
} from "./manager-shadow-task.js";
import { MemorySourceIndexKernel } from "./manager-source-index-kernel.js";

function failure(error: unknown): MemoryShadowFailure {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? { code: error.code }
      : {}),
    ...(error &&
    typeof error === "object" &&
    "errcode" in error &&
    typeof error.errcode === "number"
      ? { errcode: error.errcode }
      : {}),
  };
}

export async function replaceMemoryShadowSession(
  input: MemoryShadowSessionInput,
): Promise<MemoryShadowSessionResult> {
  let db: DatabaseSync | undefined;
  let error: MemoryShadowFailure | undefined;
  let cleanupError: MemoryShadowFailure | undefined;
  let entered = false;
  let committed = false;
  try {
    assertMemoryShadowIdentity(input.databasePath, input.fileIdentity);
    const database = openNodeSqliteDatabase(resolveExistingSqliteFileUri(input.databasePath), {
      allowExtension: Boolean(input.extensionPath),
    });
    db = database;
    assertMemoryShadowIdentity(input.databasePath, input.fileIdentity);
    // Keep the host's existing connection policy and sole maintenance timer.
    for (const [name, value] of Object.entries(input.pragmas)) {
      if (!Number.isSafeInteger(value)) {
        throw new Error("Invalid memory shadow connection policy");
      }
      database.exec(`PRAGMA ${name} = ${value}`);
    }
    if (input.extensionPath) {
      const loaded = await loadSqliteVecExtension({
        db: database,
        extensionPath: input.extensionPath,
      });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "Failed to load the memory shadow vector extension");
      }
    }
    const kernel = new MemorySourceIndexKernel(database, input);
    await runSqliteImmediateTransaction(
      database,
      async () => {
        assertMemoryShadowIdentity(input.databasePath, input.fileIdentity);
        return () => {
          entered = true;
          return kernel.replace(input.replacement);
        };
      },
      { beginDeadlineNs: input.beginDeadlineNs },
    );
    committed = true;
  } catch (caught) {
    error = failure(caught);
  } finally {
    try {
      if (db?.isOpen) {
        db.close();
      }
    } catch (caught) {
      if (error) {
        cleanupError = failure(caught);
      } else {
        error = failure(caught);
      }
    }
  }
  // Any failure withholds the consumption receipt, so the pool joins native
  // termination before this typed result reaches the owner. No write retries here.
  return error
    ? {
        kind: "session-failed",
        error,
        ...(cleanupError ? { cleanupError } : {}),
        entered,
        committed,
      }
    : { kind: "session-replaced" };
}
