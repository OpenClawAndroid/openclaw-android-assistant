import { describe, expect, it } from "vitest";
import {
  runTaskRecordTransitionOperation,
  type TaskRecordTransitionInput,
  type TaskRecordTransitionOperations,
  type TaskRecordTransitionReceipt,
} from "./task-registry-transition.operation.js";
import type { TaskRecord } from "./task-registry.types.js";

const running: TaskRecord = {
  taskId: "task-a",
  runtime: "subagent",
  requesterSessionKey: "agent:main:main",
  ownerKey: "agent:main:main",
  scopeKind: "session",
  childSessionKey: "agent:child:main",
  runId: "run-a",
  task: "Synthetic transition",
  status: "running",
  deliveryStatus: "pending",
  notifyPolicy: "done_only",
  createdAt: 100,
  startedAt: 100,
  lastEventAt: 150,
};

const finalization: TaskRecordTransitionInput = {
  kind: "state",
  taskId: running.taskId,
  now: 300,
  params: {
    runId: "run-a",
    status: "succeeded",
    endedAt: 200,
    terminalSummary: "  Finished   work ",
    suppressDelivery: true,
  },
};

function createStore(task: TaskRecord = running) {
  let stored = structuredClone(task);
  const committed: TaskRecordTransitionReceipt[] = [];
  let writes = 0;
  const operations: TaskRecordTransitionOperations = {
    readCurrent: () => stored,
    hasAuthoritativeBacking: () => true,
    write: (operation) => operation(),
    upsertTask(next) {
      stored = structuredClone(next);
      writes += 1;
      return true;
    },
    deferCommit: (publish) => publish(),
    onCommitted: (receipt) => committed.push(receipt),
  };
  return { operations, committed, read: () => stored, writes: () => writes };
}

describe("task transition settlement", () => {
  it("keeps no-op repair receipts without repeating a terminal write or delivery", () => {
    const store = createStore();
    runTaskRecordTransitionOperation(finalization, store.operations);
    runTaskRecordTransitionOperation(finalization, store.operations);

    expect(store.writes()).toBe(1);
    expect(store.read()).toMatchObject({
      status: "succeeded",
      endedAt: 200,
      lastEventAt: 200,
      terminalSummary: "Finished work",
      deliveryStatus: "not_applicable",
      cleanupAfter: 200 + 7 * 24 * 60 * 60_000,
    });
    expect(store.committed).toHaveLength(2);
    expect(store.committed[0]).toMatchObject({
      persisted: true,
      becomesTerminal: true,
      deliver: false,
    });
    expect(store.committed[1]).toMatchObject({
      persisted: false,
      becomesTerminal: false,
      deliver: false,
    });
  });

  it("records a confirmed row before a later transaction cleanup error escapes", () => {
    const store = createStore();
    const cleanupFailure = new Error("Writer cleanup failed after commit");
    expect(() =>
      runTaskRecordTransitionOperation(finalization, {
        ...store.operations,
        write(operation) {
          operation();
          throw cleanupFailure;
        },
      }),
    ).toThrow(cleanupFailure);

    expect(store.read().status).toBe("succeeded");
    expect(store.writes()).toBe(1);
    expect(store.committed).toHaveLength(1);
    expect(store.committed[0]?.task).toEqual(store.read());
  });

  it("preserves the last canonical outcome when a delayed running event arrives", () => {
    const store = createStore();
    runTaskRecordTransitionOperation(finalization, store.operations);
    const before = store.read();
    const result = runTaskRecordTransitionOperation(
      {
        kind: "state",
        taskId: running.taskId,
        now: 400,
        params: { runId: "run-a", status: "running", startedAt: 350 },
      },
      store.operations,
    );

    expect(result).toBeNull();
    expect(store.read()).toEqual(before);
    expect(store.writes()).toBe(1);
    expect(store.committed).toHaveLength(1);
  });
});
