import { describe, expect, it } from "vitest";
import { applyTaskRecordPatch, normalizeTaskTimestamps } from "./task-registry-records.js";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";

function task(status: TaskStatus, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task-${status}`,
    runtime: "cli",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: status,
    status,
    deliveryStatus: "not_applicable",
    notifyPolicy: "done_only",
    createdAt: 100,
    ...overrides,
  };
}

describe("normalizeTaskTimestamps", () => {
  it.each(["succeeded", "failed", "timed_out", "cancelled", "lost"] as const)(
    "materializes %s completion from the latest terminal event",
    (status) => {
      expect(normalizeTaskTimestamps(task(status, { lastEventAt: 250 })).endedAt).toBe(250);
    },
  );

  it("falls back to original creation when a legacy terminal has no event time", () => {
    expect(
      normalizeTaskTimestamps(task("failed", { createdAt: 200, startedAt: 100 })).endedAt,
    ).toBe(200);
  });

  it("does not add an end time to active records", () => {
    expect(normalizeTaskTimestamps(task("running", { lastEventAt: 250 })).endedAt).toBeUndefined();
  });
});

describe("applyTaskRecordPatch lifecycle clock", () => {
  it("clamps a stale terminal update instead of moving lastEventAt backwards", () => {
    const current = task("running", { lastEventAt: 300, startedAt: 110 });
    const next = applyTaskRecordPatch(current, {
      status: "succeeded",
      endedAt: 200,
      lastEventAt: 200,
    });

    expect(next.status).toBe("succeeded");
    expect(next.lastEventAt).toBe(300);
    expect(next.endedAt).toBe(200);
  });

  it("preserves forward terminal timestamps", () => {
    const current = task("running", { lastEventAt: 300, startedAt: 110 });
    const next = applyTaskRecordPatch(current, {
      status: "succeeded",
      endedAt: 400,
      lastEventAt: 400,
    });

    expect(next.status).toBe("succeeded");
    expect(next.lastEventAt).toBe(400);
    expect(next.endedAt).toBe(400);
  });

  it("preserves pre-insert backdating for non-terminal updates", () => {
    const current = task("running", { lastEventAt: 300, startedAt: 110 });
    const next = applyTaskRecordPatch(current, {
      startedAt: 100,
      lastEventAt: 200,
    });

    expect(next.status).toBe("running");
    expect(next.lastEventAt).toBe(200);
  });
});
