// Live proof for Codex native subagent monitoring against a real app-server:
// spawned-child lineage, detached completion delivery, and history recovery.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  AgentHarnessScopedCreateRunningTaskRunParams,
  AgentHarnessScopedFinalizeTaskRunParams,
  AgentHarnessScopedSetDeliveryStatusParams,
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { codexNativeSubagentRunId } from "./native-subagent-task-ids.js";
import type { JsonObject } from "./protocol.js";
import { isJsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const CodexNativeSubagentMonitor = codexNativeSubagentMonitorRuntime.Monitor;

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_NATIVE_SUBAGENT === "1";
const describeLive = LIVE ? describe : describe.skip;

type RecordedDelivery = {
  childSessionId: string;
  status: string;
  result: string;
};

function createDeliveryRecorder(
  taskRecords: AgentHarnessTaskRecord[] = [],
  requesterSessionKey = "live:streamed",
) {
  const deliveries: RecordedDelivery[] = [];
  const taskRuntime = {
    tryCreateRunningTaskRun: (params: AgentHarnessScopedCreateRunningTaskRunParams) => {
      const existing = taskRecords.find((task) => task.runId === params.runId);
      if (existing) {
        if (params.detail !== undefined) {
          existing.detail = params.detail;
        }
        return existing;
      }
      const task: AgentHarnessTaskRecord = {
        taskId: params.runId,
        runtime: "subagent",
        taskKind: "codex-native",
        scopeKind: "session",
        ownerKey: requesterSessionKey,
        requesterSessionKey,
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        runId: params.runId,
        task: params.task,
        ...(params.detail === undefined ? {} : { detail: params.detail }),
      };
      taskRecords.push(task);
      return task;
    },
    recordTaskRunProgressByRunId: () => [],
    finalizeTaskRunByRunId: (params: AgentHarnessScopedFinalizeTaskRunParams) => {
      const task = taskRecords.find((record) => record.runId === params.runId);
      if (!task) {
        return [];
      }
      task.status = params.status;
      task.endedAt = params.endedAt;
      task.terminalSummary = params.terminalSummary ?? undefined;
      return [task];
    },
    listTaskRecords: () => taskRecords,
    setDetachedTaskDeliveryStatusByRunId: (params: AgentHarnessScopedSetDeliveryStatusParams) => {
      const task = taskRecords.find((record) => record.runId === params.runId);
      return task ? [Object.assign(task, params)] : [];
    },
  };
  return {
    deliveries,
    runtime: {
      createAgentHarnessTaskRuntime: () => taskRuntime,
      deliverAgentHarnessTaskCompletion: async (params: RecordedDelivery) => {
        deliveries.push({
          childSessionId: params.childSessionId,
          status: params.status,
          result: params.result,
        });
        return { delivered: true, path: "steered" as const };
      },
    } as never,
  };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describeLive("codex native subagent monitor live", () => {
  beforeEach(() => {
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
  });
  afterEach(() => {
    setManagedCodexPluginRoot(undefined);
  });

  it("runs native shell work again on a completed child and keeps all three results", async () => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for this live test");
    }
    await withTempDir("openclaw-codex-native-followup-", async (root) => {
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const options = resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { homeScope: "user" } },
        env: {},
      });
      const client = await createIsolatedCodexAppServerClient({
        startOptions: {
          ...options.start,
          env: { CODEX_HOME: path.join(root, "codex-home") },
          clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
        },
        agentDir: path.join(root, "agent"),
        authProfileId: null,
        timeoutMs: 120_000,
      });
      try {
        await client.request(
          "account/login/start",
          { type: "apiKey", apiKey },
          { timeoutMs: 60_000 },
        );
        const started = await client.request(
          "thread/start",
          {
            model: "gpt-5.5",
            cwd: workspace,
            approvalPolicy: "never",
            sandbox: "read-only",
            threadSource: "user",
            experimentalRawEvents: true,
            config: { "features.multi_agent": true },
          },
          { timeoutMs: 120_000 },
        );
        const parentThreadId = started.thread.id;
        const completedTurns = new Set<string>();
        const shellResults: Array<{ threadId: string; output: string }> = [];
        client.addNotificationHandler((notification) => {
          const params = isJsonObject(notification.params) ? notification.params : undefined;
          if (
            notification.method === "turn/completed" &&
            params?.threadId === parentThreadId &&
            isJsonObject(params.turn) &&
            typeof params.turn.id === "string"
          ) {
            completedTurns.add(params.turn.id);
          }
          const item = isJsonObject(params?.item) ? params.item : undefined;
          if (
            notification.method === "item/completed" &&
            params?.threadId !== parentThreadId &&
            typeof params?.threadId === "string" &&
            item?.type === "commandExecution" &&
            item.exitCode === 0 &&
            typeof item.aggregatedOutput === "string"
          ) {
            shellResults.push({ threadId: params.threadId, output: item.aggregatedOutput });
          }
        });
        const tasks: AgentHarnessTaskRecord[] = [];
        const recorder = createDeliveryRecorder(tasks, "live:followup");
        const monitor = new CodexNativeSubagentMonitor(client as never, recorder.runtime);
        const claims = { first: 0, second: 0, third: 0 };
        const releases = { first: 0, second: 0, third: 0 };
        const registerParent = (owner: "first" | "second" | "third") =>
          monitor.registerParent({
            parentThreadId,
            requesterSessionKey: "live:followup",
            taskRuntimeScope: {
              requesterSessionKey: "live:followup",
            } as AgentHarnessTaskRuntimeScope,
            agentId: "live",
            historyOwner: {
              parentThreadId,
              sessionId: "live-parent-session",
              connectionFingerprint: "a".repeat(64),
            },
            claimDirectChild: () => {
              claims[owner] += 1;
              return () => {
                releases[owner] += 1;
              };
            },
          });
        let parent = registerParent("first");
        const run = async (text: string) => {
          const turn = await client.request(
            "turn/start",
            {
              threadId: parentThreadId,
              input: [{ type: "text", text, text_elements: [] }],
            },
            { timeoutMs: 300_000 },
          );
          parent.bindTurn(turn.turn.id);
          await waitFor(
            () => (completedTurns.has(turn.turn.id) ? true : undefined),
            300_000,
            "parent completion",
          );
        };
        await run(
          "Spawn exactly one native subagent. Tell it to run the shell command printf FIRST_NATIVE_SHELL, then reply exactly FIRST_RESULT. Wait for that child to finish using native collaboration. Keep the child open for a later follow-up. Reply PARENT_FIRST when done.",
        );
        await waitFor(
          () => (tasks[0]?.status === "succeeded" ? true : undefined),
          60_000,
          "first child result",
        );
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.terminalSummary).toBe("FIRST_RESULT");
        await waitFor(
          () => (tasks[0]?.deliveryStatus === "delivered" ? true : undefined),
          60_000,
          "first native receipt",
        );
        const first = structuredClone(tasks[0]!);
        const childThreadId = first.runId!.slice("codex-thread:".length);
        expect(shellResults).toContainEqual({
          threadId: childThreadId,
          output: "FIRST_NATIVE_SHELL",
        });
        await parent.unregister();
        expect(claims.first).toBe(1);
        expect(releases.first).toBe(1);
        const expectedTasks = [first];
        for (const ordinal of ["second", "third"] as const) {
          const token = ordinal.toUpperCase();
          parent = registerParent(ordinal);
          await run(
            `Send a follow-up to that same completed child using native collaboration; do not spawn another child. Tell it to run the shell command printf ${token}_NATIVE_SHELL, then reply exactly ${token}_RESULT. Wait for its result, keep the child open for another follow-up, then reply PARENT_${token}.`,
          );
          const assignment = await waitFor(
            () =>
              tasks.find(
                (task) => task.terminalSummary === `${token}_RESULT` && task.status === "succeeded",
              ),
            60_000,
            `${ordinal} child result`,
          );
          expect(tasks).toHaveLength(expectedTasks.length + 1);
          for (const previous of expectedTasks) {
            expect(tasks.find((task) => task.runId === previous.runId)).toEqual(previous);
          }
          expect(assignment.runId).toMatch(new RegExp(`^codex-thread:${childThreadId}:turn:`));
          expect(expectedTasks.map((task) => task.runId)).not.toContain(assignment.runId);
          expect(shellResults).toContainEqual({
            threadId: childThreadId,
            output: `${token}_NATIVE_SHELL`,
          });
          await waitFor(
            () => (assignment.deliveryStatus === "delivered" ? true : undefined),
            60_000,
            `${ordinal} native receipt`,
          );
          expectedTasks.push(structuredClone(assignment));
          await parent.unregister();
        }
        expect(claims).toEqual({ first: 1, second: 1, third: 1 });
        expect(releases).toEqual({ first: 1, second: 1, third: 1 });
        expect(recorder.deliveries).toEqual([]);
        monitor.dispose();
      } finally {
        await client.closeAndWait();
      }
    });
  }, 900_000);

  it("delivers spawned subagent results live and recovers them from history", async () => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for this live test");
    }
    await withTempDir("openclaw-codex-native-subagent-", async (root) => {
      let client: CodexAppServerClient | undefined;
      try {
        const codexHome = path.join(root, "codex-home");
        const workspace = path.join(root, "workspace");
        await fs.mkdir(workspace, { recursive: true });
        const runtime = resolveCodexAppServerRuntimeOptions({
          pluginConfig: { appServer: { homeScope: "user" } },
          env: {},
        });
        client = await createIsolatedCodexAppServerClient({
          startOptions: {
            ...runtime.start,
            env: { CODEX_HOME: codexHome },
            clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
          },
          agentDir: path.join(root, "agent"),
          authProfileId: null,
          timeoutMs: 120_000,
        });
        await client.request(
          "account/login/start",
          { type: "apiKey", apiKey },
          { timeoutMs: 60_000 },
        );

        let parentThreadId = "";
        let parentTurnCompleted = false;
        client.addNotificationHandler((notification) => {
          if (notification.method !== "turn/completed") {
            return;
          }
          const params = isJsonObject(notification.params) ? notification.params : undefined;
          if (params?.threadId === parentThreadId) {
            parentTurnCompleted = true;
          }
        });

        const started = await client.request(
          "thread/start",
          {
            model: "gpt-5.5",
            cwd: workspace,
            approvalPolicy: "never",
            sandbox: "read-only",
            threadSource: "user",
            experimentalRawEvents: true,
            config: { "features.multi_agent": true },
          },
          { timeoutMs: 120_000 },
        );
        parentThreadId = started.thread.id;

        const streamed = createDeliveryRecorder();
        const monitor = new CodexNativeSubagentMonitor(client as never, streamed.runtime);
        const parentRegistration = monitor.registerParent({
          parentThreadId,
          requesterSessionKey: "live:streamed",
          taskRuntimeScope: {
            requesterSessionKey: "live:streamed",
          } as AgentHarnessTaskRuntimeScope,
          agentId: "live",
        });

        // Detached-child scenario: the parent replies immediately while the
        // child still owes its own model round (plus a sleep for margin), so
        // the parent turn completes first, like an OpenClaw run cleaning up
        // after yield while its native subagent is still working.
        const turn = await client.request(
          "turn/start",
          {
            threadId: parentThreadId,
            input: [
              {
                type: "text",
                text: "Spawn exactly one subagent with this exact task: 'First run the shell command sleep 20 and wait for it to finish. Then reply with exactly the word BANANA42.' Do not wait for the subagent to finish. Reply DONE immediately after spawning it.",
                text_elements: [],
              },
            ],
          },
          { timeoutMs: 300_000 },
        );
        parentRegistration.bindTurn(turn.turn.id);

        await waitFor(
          () => (parentTurnCompleted ? true : undefined),
          300_000,
          "parent turn completion",
        );
        // The child is still sleeping when the parent turn ends; delivery after
        // this point proves the detached path, not same-turn streaming.
        expect(streamed.deliveries).toHaveLength(0);
        await parentRegistration.unregister();

        const delivery = await waitFor(
          () => streamed.deliveries[0],
          420_000,
          "detached child completion delivery",
        );
        expect(delivery.status).toBe("succeeded");
        expect(delivery.result).toMatch(/BANANA42/iu);
        const childThreadId = delivery.childSessionId;

        // Canonical protocol shape: lineage plus terminal turn from history.
        const read = await client.request(
          "thread/read",
          { threadId: childThreadId, includeTurns: true },
          { timeoutMs: 60_000 },
        );
        expect((read.thread as unknown as JsonObject).parentThreadId).toBe(parentThreadId);
        const turns = read.thread.turns ?? [];
        expect(turns.at(-1)?.status).toBe("completed");

        const page = await client.request(
          "thread/turns/list",
          { threadId: childThreadId, limit: 1, sortDirection: "desc", itemsView: "full" },
          { timeoutMs: 60_000 },
        );
        const pageTurns = isJsonObject(page) && Array.isArray(page.data) ? page.data : [];
        const latestTurn = isJsonObject(pageTurns[0]) ? pageTurns[0] : undefined;
        expect(latestTurn?.status).toBe("completed");

        // Fresh-monitor recovery: no streamed state, only a persisted task row.
        const recoveryRunId = codexNativeSubagentRunId(childThreadId);
        const recovery = createDeliveryRecorder([
          {
            taskId: recoveryRunId,
            runtime: "subagent",
            taskKind: "codex-native",
            sourceId: recoveryRunId,
            requesterSessionKey: "live:recovery",
            ownerKey: "live:recovery",
            scopeKind: "session",
            agentId: "live",
            runId: recoveryRunId,
            label: "Subagent",
            task: "live recovery probe",
            status: "running",
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
            createdAt: Date.now(),
          } as AgentHarnessTaskRecord,
        ]);
        const recoveryMonitor = new CodexNativeSubagentMonitor(client as never, recovery.runtime);
        const recoveryRegistration = recoveryMonitor.registerParent({
          parentThreadId,
          requesterSessionKey: "live:recovery",
          taskRuntimeScope: {
            requesterSessionKey: "live:recovery",
          } as AgentHarnessTaskRuntimeScope,
          agentId: "live",
        });
        await recoveryRegistration.unregister();
        const recovered = await waitFor(
          () => recovery.deliveries[0],
          120_000,
          "history-based completion recovery",
        );
        expect(recovered.childSessionId).toBe(childThreadId);
        expect(recovered.status).toBe("succeeded");
        expect(recovered.result).toMatch(/BANANA42/iu);
      } finally {
        await client?.closeAndWait();
        await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    });
  }, 900_000);
});
