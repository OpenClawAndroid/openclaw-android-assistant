import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { buildFlowRecord } from "../tasks/task-flow-registry.records.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "../tasks/task-flow-registry.store.sqlite.js";
import { readTaskRegistrySnapshot } from "../tasks/task-registry.store.kernel.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import { TASK_RUNTIMES, type TaskStatus } from "../tasks/task-registry.types.js";
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
  state = await createOpenClawTestState({ prefix: "openclaw-flow-summary-", applyEnv: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

function fixture(statuses: readonly TaskStatus[] = ["running"]) {
  const ownerKey = "agent:main:summary";
  const flow = buildFlowRecord({
    controllerId: "tests/summary",
    ownerKey,
    goal: "Synthetic flow",
    createdAt: 100,
  });
  upsertTaskFlowRegistryRecordToSqlite(flow);
  let index = 0;
  for (const runtime of TASK_RUNTIMES) {
    for (const status of statuses) {
      const count =
        runtime === "subagent" && status === "queued"
          ? 3
          : runtime === "cli" && status === "failed"
            ? 2
            : 1;
      for (let copy = 0; copy < count; copy++) {
        upsertTaskWithDeliveryStateToSqlite({
          task: {
            taskId: `task-${index++}`,
            runtime,
            status,
            parentFlowId: flow.flowId,
            ownerKey,
            requesterSessionKey: ownerKey,
            scopeKind: "session",
            task: "Large task ".repeat(1024),
            progressSummary: "Progress ".repeat(1024),
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
            createdAt: 100,
          },
        });
      }
    }
  }
  const context = captureOpenClawStateWorkerContext();
  const backend = runWithSqliteWorkerStateContext(context, () =>
    createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
  const summary = (requestedOwner = ownerKey, flowId = flow.flowId) =>
    runWithSqliteWorkerStateContext(context, () =>
      backend.execute({ type: "flows.summary", input: { ownerKey: requestedOwner, flowId } }),
    );
  const detail = () =>
    runWithSqliteWorkerStateContext(context, () =>
      backend.execute({
        type: "flows.detail",
        input: { ownerKey, lookup: "id", token: flow.flowId },
      }),
    );
  return { summary, detail, database: openOpenClawStateDatabase() };
}

it("counts every status and runtime without mixing another flow, including empty and missing flows", () => {
  const { summary, database } = fixture([
    "queued",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
  ]);
  const expected = {
    total: 31,
    active: 10,
    terminal: 21,
    failures: 13,
    byStatus: {
      queued: 6,
      running: 4,
      succeeded: 4,
      failed: 5,
      timed_out: 4,
      cancelled: 4,
      lost: 4,
    },
    byRuntime: { subagent: 9, acp: 7, cron: 7, cli: 8 },
  };
  expect(summary()).toEqual(expected);
  expect(summary("agent:other:summary")).toBeUndefined();
  expect(summary(undefined, "missing")).toBeUndefined();
  const unrelated = buildFlowRecord({
    controllerId: "tests/summary",
    ownerKey: "agent:main:summary",
    goal: "Empty flow",
    createdAt: 100,
  });
  upsertTaskFlowRegistryRecordToSqlite(unrelated);
  expect(summary(undefined, unrelated.flowId)).toEqual({
    total: 0,
    active: 0,
    terminal: 0,
    failures: 0,
    byStatus: {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      lost: 0,
    },
    byRuntime: { subagent: 0, acp: 0, cron: 0, cli: 0 },
  });
  database.db
    .prepare("UPDATE task_runs SET parent_flow_id = ? WHERE task_id = 'task-0'")
    .run(unrelated.flowId);
  expect(summary()).toMatchObject({
    total: 30,
    active: 9,
    byStatus: { queued: 5 },
    byRuntime: { subagent: 8 },
  });
});

it.each(["runtime", "status"] as const)(
  "rejects invalid count input %s only after checking flow ownership",
  (field) => {
    const { summary, database } = fixture();
    database.db.exec(`UPDATE task_runs SET ${field} = 'invalid' WHERE task_id = 'task-0'`);
    expect(summary("agent:other:summary")).toBeUndefined();
    expect(summary(undefined, "missing")).toBeUndefined();
    expect(() => summary()).toThrow(`Invalid persisted task ${field}: "invalid"`);
  },
);

it.each([
  ["scope_kind", "scope kind"],
  ["delivery_status", "delivery status"],
  ["notify_policy", "notify policy"],
  ["terminal_outcome", "terminal outcome"],
] as const)("leaves unused %s validation with full record readers", (field, label) => {
  const { summary, detail, database } = fixture();
  database.db.exec(`UPDATE task_runs SET ${field} = 'invalid' WHERE task_id = 'task-0'`);
  expect(summary()).toMatchObject({ total: 4, active: 4, terminal: 0, failures: 0 });
  expect(() => detail()).toThrow(`Invalid persisted task ${label}: "invalid"`);
  expect(() => readTaskRegistrySnapshot(database)).toThrow(
    `Invalid persisted task ${label}: "invalid"`,
  );
});
