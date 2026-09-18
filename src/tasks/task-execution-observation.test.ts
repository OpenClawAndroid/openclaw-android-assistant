import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as nativeExecution from "../agents/subagents/registry/subagent-execution-observation.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { createSubagentTaskBackingDetail } from "./task-backing-records.js";
import { getTaskExecutionObservation } from "./task-execution-observation.js";
import { clearTaskActivity, recordTaskActivityEvent } from "./task-registry-activity.js";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";

const taskIds = new Set<string>();
const runIds = new Set<string>();

function task(id: string, status: TaskStatus): TaskRecord {
  taskIds.add(id);
  return {
    taskId: id,
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: `agent:main:subagent:${id}`,
    runId: id,
    task: "Observe the task",
    status,
    deliveryStatus: "pending",
    notifyPolicy: "silent",
    createdAt: 1,
    detail: createSubagentTaskBackingDetail(1),
  };
}

function registerRun(record: TaskRecord, overrides: Partial<SubagentRunRecord> = {}) {
  const run: SubagentRunRecord = {
    runId: record.taskId,
    childSessionKey: `agent:main:subagent:${record.taskId}`,
    requesterSessionKey: record.requesterSessionKey,
    requesterDisplayKey: "main",
    task: record.task,
    cleanup: "keep",
    createdAt: 1,
    generation: 1,
    execution: { status: "running", startedAt: 1 },
    ...overrides,
  };
  runIds.add(run.runId);
  subagentRuns.set(run.runId, run);
  return run;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const id of taskIds) {
    clearTaskActivity(id);
  }
  for (const id of runIds) {
    subagentRuns.delete(id);
  }
  taskIds.clear();
  runIds.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("projects fixed task statuses without observing retained native executions", () => {
  const statuses = ["queued", "succeeded", "failed", "timed_out", "cancelled", "lost"] as const;
  const rows = Array.from({ length: 1_000 }, (_, index) => {
    const status = statuses[index % statuses.length]!;
    const record = task(`fixed-${index}`, status);
    const run = registerRun(record, {
      pauseReason: "sessions_yield",
      execution: { status: "terminal", endedAt: 2 },
    });
    const timestamp = [undefined, 0, 42][Math.floor(index / statuses.length) % 3];
    if (timestamp !== undefined) {
      recordTaskActivityEvent(record, {
        runId: run.runId,
        seq: 1,
        stream: "tool",
        ts: timestamp,
        data: { phase: "start", name: "stale_tool", toolCallId: "old-tool" },
      });
      recordTaskActivityEvent(record, {
        runId: run.runId,
        seq: 2,
        stream: "execution",
        ts: timestamp,
        data: { state: "waiting", wait: { kind: "approval" } },
      });
    }
    return { record, run, timestamp };
  });
  const before = structuredClone(rows);
  const observe = vi.spyOn(nativeExecution, "getSubagentExecutionObservation");

  expect(rows.map(({ record }) => getTaskExecutionObservation(record))).toEqual(
    rows.map(({ record, timestamp }) => ({
      state:
        record.status === "lost" ? "unknown" : record.status === "queued" ? "queued" : "finished",
      ...(timestamp !== undefined ? { lastActivityAt: timestamp } : {}),
    })),
  );
  expect(rows).toEqual(before);
  expect(observe).toHaveBeenCalledTimes(0);
});

it("keeps running task observations current through generation replacement and deletion", () => {
  const record = task("running-task", "running");
  const original = registerRun(record);
  recordTaskActivityEvent(record, {
    runId: original.runId,
    seq: 1,
    stream: "tool",
    ts: 10,
    data: { phase: "start", name: "old_tool", toolCallId: "old-tool" },
  });
  expect(getTaskExecutionObservation(record)).toEqual({
    state: "running",
    lastActivityAt: 10,
    currentTool: { name: "old_tool", startedAt: 10 },
  });

  const successor = registerRun(record, {
    runId: "successor",
    taskRunId: original.runId,
    generation: 2,
    pauseReason: "sessions_yield",
    execution: { status: "terminal", endedAt: 20 },
  });
  expect(getTaskExecutionObservation(record)).toEqual({ state: "unknown", lastActivityAt: 10 });
  record.detail = createSubagentTaskBackingDetail(2);
  expect(getTaskExecutionObservation(record)).toEqual({
    state: "waiting",
    wait: { kind: "external" },
    lastActivityAt: 10,
  });

  successor.pauseReason = undefined;
  successor.execution = { status: "running", startedAt: 30 };
  recordTaskActivityEvent(record, {
    runId: successor.runId,
    seq: 1,
    stream: "tool",
    ts: 30,
    data: { phase: "start", name: "  read_file  ", toolCallId: "new-tool" },
  });
  expect(getTaskExecutionObservation(record)).toEqual({
    state: "running",
    lastActivityAt: 30,
    currentTool: { name: "read_file", startedAt: 30 },
  });
  subagentRuns.delete(successor.runId);
  subagentRuns.delete(original.runId);
  expect(getTaskExecutionObservation(record)).toEqual({ state: "unknown", lastActivityAt: 30 });
});
