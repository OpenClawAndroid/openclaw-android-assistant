import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as registryRead from "../agents/subagents/registry/subagent-registry-read.js";
import { persistSubagentRunsToDiskOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as projectionWork from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { seedSessionRowProjectionTranscriptFixture } from "./session-row-projection.transcript-fixture.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  subagentRuns.clear();
});

it("reuses the subagent index across a 2,048-session drain with unrelated writes and refreshes a changed run", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const count = seedSessionRowProjectionTranscriptFixture();
    for (let index = 1; index < count; index++) {
      const run: SubagentRunRecord = {
        runId: `run-${index}`,
        childSessionKey: `agent:main:legacy-${index}`,
        requesterSessionKey: "agent:main:legacy-0",
        requesterDisplayKey: "parent",
        task: "Synthetic task",
        cleanup: "keep",
        createdAt: 1,
        execution: { status: "running", startedAt: 1 },
        completion: { required: false },
        delivery: { status: "not_required" },
      };
      subagentRuns.set(run.runId, run);
    }
    const builds = vi.spyOn(registryRead, "buildSubagentSessionListReadIndex");
    const yieldWork = projectionWork.yieldSessionListWork;
    let yields = 0;
    vi.spyOn(projectionWork, "yieldSessionListWork").mockImplementation(async () => {
      await yieldWork();
      yields++;
      if (yields <= 32) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: "agent:main:legacy-2047" },
          { sessionId: "legacy-2047", updatedAt: count + yields, label: `Update ${yields}` },
        );
      }
      if (yields === 12) {
        const run = subagentRuns.get("run-1")!;
        subagentRuns.set(run.runId, {
          ...run,
          execution: { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } },
        });
        persistSubagentRunsToDiskOrThrow(subagentRuns, [run.runId]);
      }
    });
    const memoryBefore = process.memoryUsage();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      const elapsed = process.threadCpuUsage(cpu);
      const memoryAfter = process.memoryUsage();
      console.log(
        JSON.stringify({
          count,
          yields,
          indexBuilds: builds.mock.calls.length,
          initialDrainMs: performance.now() - started,
          initialDrainThreadCpuMs: (elapsed.user + elapsed.system) / 1000,
          heapUsedDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
          rssDelta: memoryAfter.rss - memoryBefore.rss,
        }),
      );
      expect(projection.select()).toHaveLength(count);
      expect(projection.dirtyRowCount).toBe(0);
      expect(yields).toBeGreaterThanOrEqual(32);
      expect(
        projection.snapshot({ agentId: "main", key: "agent:main:legacy-2047" }).row?.label,
      ).toBe("Update 32");
      expect(projection.snapshot({ agentId: "main", key: "agent:main:legacy-1" }).row?.status).toBe(
        "done",
      );
      expect(builds).toHaveBeenCalledTimes(2);
    } finally {
      projection.dispose();
    }
  });
}, 120_000);

it.each(["ownership", "retirement", "clear", "persistence"] as const)(
  "refreshes subagent facts before synchronous %s observers read the row",
  async (publication) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const cfg = { agents: { list: [{ id: "main", default: true }] } };
        const child = "agent:main:child",
          parent = "agent:main:parent",
          nextParent = "agent:main:next";
        for (const key of [child, parent, nextParent]) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: key },
            { sessionId: key, updatedAt: 1 },
          );
        }
        const run: SubagentRunRecord = {
          runId: "run",
          childSessionKey: child,
          requesterSessionKey: parent,
          requesterDisplayKey: "parent",
          task: "Synthetic task",
          cleanup: "keep",
          createdAt: 1,
          execution: { status: "running", startedAt: 1 },
          completion: { required: false },
          delivery: { status: "not_required" },
        };
        subagentRuns.set(run.runId, run);
        const projection = await createSessionRowProjection({ cfg });
        const snapshot = () => projection.snapshot({ agentId: "main", key: child }).row;
        let observed: ReturnType<typeof snapshot> | undefined;
        const stop = sessionChanges.subscribe(() => {
          observed = snapshot();
        });
        try {
          expect(snapshot()?.controlOwnerSessionKey).toBe(parent);
          if (publication === "ownership" || publication === "persistence") {
            const replacement = { ...run, requesterSessionKey: nextParent };
            subagentRuns.set(run.runId, replacement);
            expect(snapshot()?.controlOwnerSessionKey).toBe(parent);
            if (publication === "ownership") {
              subagentRuns.commitOwnership(replacement);
            } else {
              persistSubagentRunsToDiskOrThrow(subagentRuns, [run.runId]);
            }
          } else if (publication === "retirement") {
            subagentRuns.delete(run.runId);
            expect(snapshot()?.controlOwnerSessionKey).toBe(parent);
            subagentRuns.confirmRetirement(run);
          } else {
            subagentRuns.clear();
          }
          const moved = publication === "ownership" || publication === "persistence";
          expect(observed?.key).toBe(child);
          expect(observed?.controlOwnerSessionKey).toBe(moved ? nextParent : undefined);
          await projection.ensureMaterialized();
          expect(
            projection.snapshot({ agentId: "main", key: parent }).row?.childSessions,
          ).toBeUndefined();
          expect(
            projection.snapshot({ agentId: "main", key: nextParent }).row?.childSessions,
          ).toEqual(moved ? [child] : undefined);
        } finally {
          stop();
          projection.dispose();
        }
      },
    );
  },
);
