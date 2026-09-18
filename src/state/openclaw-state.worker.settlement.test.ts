import { afterEach, beforeEach, expect, it } from "vitest";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { createSqliteWorkerBackend } from "./openclaw-state.worker.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-worker-settlement-", applyEnv: true });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("rejects leaked readers and unfinished transactions through the same actor settlement hook", async () => {
  const context = captureOpenClawStateWorkerContext();
  const backend = runWithSqliteWorkerStateContext(context, () =>
    createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
  const { db } = openOpenClawStateDatabase();
  const query = getNodeSqliteKysely<{ schema_meta: { schema_version: number } }>(db)
    .selectFrom("schema_meta")
    .select("schema_version");
  const reader = iterateSqliteQuerySync(db, query);
  try {
    expect(() => backend.assertSettled!()).not.toThrow();
    expect(reader.next().done).toBe(false);
    expect(db.isTransaction).toBe(false);
    expect(() => backend.assertSettled!()).toThrow("active SQLite reader");
    reader.return?.();
    expect(() => backend.assertSettled!()).not.toThrow();
    db.exec("BEGIN");
    expect(() => backend.assertSettled!()).toThrow("unsettled transaction");
    db.exec("ROLLBACK");
    expect(() => backend.assertSettled!()).not.toThrow();
  } finally {
    reader.return?.();
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    await backend.close();
  }
});
