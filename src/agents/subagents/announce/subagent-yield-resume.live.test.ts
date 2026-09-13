import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../../../../packages/gateway-protocol/src/schema/tasks.js";
import { runQaGatewayFixture } from "../../../../test/helpers/qa-gateway-cleanup.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { GatewayClient } from "../../../gateway/client.js";
import { startGatewayServer, type GatewayServer } from "../../../gateway/server.js";
import { readSessionMessagesAsync } from "../../../gateway/session-transcript-readers.js";
import { isTruthyEnvValue } from "../../../infra/env.js";
import { resetPluginRuntimeStateForTest } from "../../../plugins/runtime.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { getFreePort } from "../../../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../../utils/message-channel.js";
import { isLiveTestEnabled } from "../../live-test-helpers.js";
import {
  countPendingDescendantRuns,
  listSubagentRunsForRequester,
} from "../registry/subagent-registry.test-helpers.js";

const enabled = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_SUBAGENT_STRESS);
const describeLive = enabled ? describe : describe.skip;
const WAIT_MS = 8 * 60_000;

function boundedCount(name: string, fallback: number, maximum: number): number {
  const count = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(count) || count < 1 || count > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return count;
}

async function until<T>(
  label: string,
  read: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) {
      return result;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`Live subagent stress timed out: ${label}`);
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  return Array.isArray(message.content)
    ? message.content
        .flatMap((part) => {
          const block = asOptionalRecord(part);
          return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
        })
        .join("\n")
        .trim()
    : "";
}

async function history(sessionKey: string): Promise<Record<string, unknown>[]> {
  const sessionEntry = loadSessionEntry({ agentId: "main", sessionKey });
  if (!sessionEntry?.sessionId) {
    return [];
  }
  const messages = await readSessionMessagesAsync(
    { agentId: "main", sessionEntry, sessionId: sessionEntry.sessionId, sessionKey },
    { mode: "full", reason: "live yield stress completion verification" },
  );
  return messages.flatMap((message) => {
    const record = asOptionalRecord(message);
    return record ? [record] : [];
  });
}

function finalReplies(messages: Record<string, unknown>[], marker: string): string[] {
  return messages.flatMap((message) => {
    if (
      message.role !== "assistant" ||
      message.phase === "commentary" ||
      message.openclawMessageToolMirror ||
      message.openclawDeliveryMirror ||
      message.provider === "openclaw" ||
      (Array.isArray(message.content) &&
        message.content.some((part) => asOptionalRecord(part)?.type === "toolCall"))
    ) {
      return [];
    }
    const text = messageText(message);
    return text.startsWith(marker) ? [text] : [];
  });
}

function successfulYields(messages: Record<string, unknown>[]): number {
  return messages.filter((message) => {
    if (message.role !== "toolResult" || message.toolName !== "sessions_yield" || message.isError) {
      return false;
    }
    if (asOptionalRecord(message.details)?.status === "yielded") {
      return true;
    }
    try {
      return asOptionalRecord(JSON.parse(messageText(message)))?.status === "yielded";
    } catch {
      return false;
    }
  }).length;
}

async function connect(port: number, token: string): Promise<GatewayClient> {
  return await new Promise((resolve, reject) => {
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      deviceIdentity: null,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin"],
      requestTimeoutMs: WAIT_MS,
      onHelloOk: () => resolve(client),
      onConnectError: reject,
    });
    client.start();
  });
}

describeLive("OpenAI subagent yield and operator resume stress", () => {
  it(
    "settles concurrent children and preserves a resumed worker's task and parent batch",
    async () => {
      expect(Boolean(process.env.OPENAI_API_KEY?.trim()), "OpenAI API key is present").toBe(true);
      const model = process.env.OPENCLAW_LIVE_SUBAGENT_E2E_MODEL?.trim() || "openai/gpt-5.6-luna";
      expect(model.startsWith("openai/"), "stress uses the OpenAI API provider").toBe(true);
      const batches = boundedCount("OPENCLAW_LIVE_SUBAGENT_STRESS_BATCHES", 2, 5);
      const childrenPerBatch = boundedCount("OPENCLAW_LIVE_SUBAGENT_STRESS_CHILDREN", 3, 6);
      const port = await getFreePort();
      const token = `yield-stress-${randomUUID()}`;
      const state = await createOpenClawTestState({
        label: "openai-yield-resume-live",
        layout: "split",
        env: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
          OPENCLAW_PLUGINS_PATHS: undefined,
          OPENCLAW_DEBUG_MODEL_PAYLOAD: undefined,
          OPENCLAW_DEBUG_SSE: undefined,
        },
      });
      let server: GatewayServer | undefined;
      let client: GatewayClient | undefined;
      const gatePath = path.join(state.workspaceDir, "release.txt");
      await runQaGatewayFixture(
        async () => {
          const cfg: OpenClawConfig = {
            gateway: {
              mode: "local",
              port,
              auth: { mode: "token", token },
              controlUi: { enabled: false },
            },
            plugins: { enabled: false },
            tools: {
              codeMode: false,
              allow: ["sessions_spawn", "sessions_yield", "read", "exec", "process"],
              exec: { mode: "full", host: "gateway" },
            },
            models: {
              providers: {
                openai: {
                  api: "openai-responses",
                  agentRuntime: { id: "openclaw" },
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  timeoutSeconds: 300,
                  models: [
                    {
                      id: model.slice("openai/".length),
                      name: "OpenAI live stress",
                      input: ["text"],
                      reasoning: true,
                      contextWindow: 1_047_576,
                      maxTokens: 8_192,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ],
                },
              },
            },
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                skipBootstrap: true,
                model: { primary: model },
                models: {
                  [model]: { agentRuntime: { id: "openclaw" }, params: { maxTokens: 2_048 } },
                },
                sandbox: { mode: "off" },
                subagents: {
                  allowAgents: ["*"],
                  maxSpawnDepth: 2,
                  maxChildrenPerAgent: childrenPerBatch,
                  maxConcurrent: Math.max(3, childrenPerBatch),
                  runTimeoutSeconds: 300,
                  announceTimeoutMs: 300_000,
                  archiveAfterMinutes: 60,
                },
              },
            },
          };
          await state.writeConfig(cfg);
          clearRuntimeConfigSnapshot();
          resetPluginRuntimeStateForTest();
          server = await startGatewayServer(port, {
            bind: "loopback",
            auth: { mode: "token", token },
            controlUiEnabled: false,
          });
          await server.startupSettled;
          const gateway = await connect(port, token);
          client = gateway;
          const start = (sessionKey: string, message: string) =>
            gateway.request("agent", {
              sessionKey,
              message,
              idempotencyKey: randomUUID(),
              deliver: false,
              timeout: 300,
            });
          const waitForFinal = async (sessionKey: string, marker: string, expected: string) => {
            await until("parent final", async () =>
              finalReplies(await history(sessionKey), marker).some((text) => text === expected)
                ? true
                : undefined,
            );
            await until("descendant settlement", () =>
              countPendingDescendantRuns(sessionKey) === 0 ? true : undefined,
            );
            const messages = await history(sessionKey);
            expect(
              messages.some(
                (message) =>
                  message.role === "toolResult" &&
                  ["read", "exec", "process"].includes(String(message.toolName)),
              ),
              "parent did not inspect child data directly",
            ).toBe(false);
            expect(
              finalReplies(messages, marker).length,
              "one parent final after all descendants settle",
            ).toBe(1);
            expect(successfulYields(messages) > 0, "parent really yielded").toBe(true);
            return successfulYields(messages);
          };
          let parentYields = 0;
          for (let batch = 0; batch < batches; batch += 1) {
            const batchId = randomUUID().replaceAll("-", "");
            const parentKey = `agent:main:live-yield-stress:${batchId}`;
            const parentMarker = `PARENT_${batchId}`;
            const childResults: string[] = [];
            const spawns: Record<string, unknown>[] = [];
            for (let child = 0; child < childrenPerBatch; child += 1) {
              const result = `CHILD_${randomUUID()}`;
              childResults.push(result);
              const chain = Array.from({ length: 4 }, () => `${randomUUID()}.txt`);
              for (let index = 0; index < chain.length; index += 1) {
                await fs.writeFile(
                  path.join(state.workspaceDir, chain[index]!),
                  `${chain[index + 1] ?? result}\n`,
                );
              }
              spawns.push({
                taskName: `stress_${batch}_${child}`,
                cleanup: "keep",
                context: "isolated",
                task: `Use only read. Read ${chain[0]}. The contents name the next workspace file. Follow one filename at a time until the contents start CHILD_. Reply with that exact result only. Do not use exec or spawn.`,
              });
            }
            console.log(
              `[subagent-handoff-stress] ${JSON.stringify({ phase: "fanout", batch: batch + 1, children: childrenPerBatch })}`,
            );
            await start(
              parentKey,
              [
                "Use tools for this exact bounded task. Do not inspect workspace files yourself.",
                "Spawn all children below before waiting; issue their sessions_spawn calls together if possible. Do not spawn any additional children.",
                ...spawns.map((spawn) => `sessions_spawn input: ${JSON.stringify(spawn)}`),
                "After every spawn is accepted, call sessions_yield immediately. Wait for all actual child completion results.",
                `Your only final reply must be ${parentMarker} on the first line, then the exact child result for each child in spawn order, one result per line. No commentary or other content.`,
              ].join("\n"),
            );
            parentYields += await waitForFinal(
              parentKey,
              parentMarker,
              [parentMarker, ...childResults].join("\n"),
            );
            const children = listSubagentRunsForRequester(parentKey);
            expect(children.length, "exact child fanout").toBe(childrenPerBatch);
            expect(
              children.every(
                (run) =>
                  run.execution.outcome?.status === "ok" && run.delivery?.status === "delivered",
              ),
              "all child tasks succeeded and delivered",
            ).toBe(true);
            const firstEnd = Math.min(...children.map((run) => run.execution.endedAt!));
            expect(
              children.every((run) => run.createdAt <= firstEnd),
              "all children spawned before any finished",
            ).toBe(true);
          }

          const resumeId = randomUUID().replaceAll("-", "");
          const parentKey = `agent:main:live-resume-stress:${resumeId}`;
          const parentMarker = `RESUME_PARENT_${resumeId}`;
          const operatorResult = `OPERATOR_RESULT_${randomUUID()}`;
          const startedPath = path.join(state.workspaceDir, "gate-started.txt");
          const gateScript = path.join(state.workspaceDir, "wait-for-release.cjs");
          await fs.writeFile(
            gateScript,
            [
              'const fs = require("node:fs"); const path = require("node:path");',
              "const [gate, started] = process.argv.slice(2);",
              "const timer = setTimeout(() => { watcher.close(); process.exitCode = 1; }, 240000);",
              'function finish() { if (!fs.existsSync(gate)) return; const text = fs.readFileSync(gate, "utf8").trim(); if (!text) return; clearTimeout(timer); watcher.close(); process.stdout.write(text + "\\n"); }',
              'const watcher = fs.watch(path.dirname(gate), finish); fs.writeFileSync(started, "started"); finish();',
            ].join("\n"),
          );
          const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
          const leafTask = `Use exec to run exactly: ${[process.execPath, gateScript, gatePath, startedPath].map(quote).join(" ")}. Allow 240 seconds. If it runs in the background, use process to wait for its result. Reply with its exact stdout only.`;
          const workerTask = `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "resume_gate_leaf", task: leafTask, cleanup: "keep", context: "isolated" })}. Immediately after acceptance call sessions_yield. On the child's completion reply with its exact result only.`;
          await start(
            parentKey,
            [
              `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "resume_worker", task: workerTask, cleanup: "keep", context: "isolated" })}.`,
              "After acceptance call sessions_yield and wait for this worker's actual completion. Do not inspect files or call other tools.",
              `Your only final reply must be ${parentMarker} on one line and the worker's exact result on the next line.`,
            ].join("\n"),
          );
          await until(
            "gate process started",
            async () =>
              await fs.stat(startedPath).then(
                () => true,
                () => undefined,
              ),
          );
          const paused = await until("worker and parent yielded", () =>
            listSubagentRunsForRequester(parentKey).find(
              (run) =>
                run.taskName === "resume_worker" &&
                run.pauseReason === "sessions_yield" &&
                run.requesterSettleWake?.requesterYieldBatch === true,
            ),
          );
          const tasks = await gateway.request<{ tasks: TaskSummary[] }>("tasks.list", {
            sessionKey: parentKey,
            limit: 100,
          });
          const originalTask = tasks.tasks.find(
            (task) =>
              task.childSessionKey === paused.childSessionKey && task.runtime === "subagent",
          );
          expect(Boolean(originalTask), "original canonical task exists").toBe(true);
          const resumeKey = randomUUID();
          const followup = {
            key: paused.childSessionKey,
            idempotencyKey: resumeKey,
            message: `The operator is resuming this same task with a new requested result. Do not create tasks, inspect files, wait, or call tools. Finish now by replying exactly ${operatorResult}.`,
          };
          const accepted = await gateway.request<{ runId: string }>("sessions.send", followup);
          const resumed = await until("operator resume adopted original worker", () =>
            listSubagentRunsForRequester(parentKey).find((run) => run.runId === accepted.runId),
          );
          expect(
            resumed.taskRunId === (paused.taskRunId ?? paused.runId),
            "same canonical task run",
          ).toBe(true);
          expect(resumed.requesterSessionKey === parentKey, "same parent recipient").toBe(true);
          expect(
            resumed.requesterSettleWake?.batchRunIds?.includes(accepted.runId),
            "parent batch follows the successor",
          ).toBe(true);
          expect(
            resumed.requesterSettleWake?.batchRunIds?.includes(paused.runId),
            "parent batch retires predecessor",
          ).toBe(false);
          const replayed = await gateway.request<{ runId: string }>("sessions.send", followup);
          expect(replayed.runId === accepted.runId, "operator retry reuses its accepted run").toBe(
            true,
          );
          await fs.writeFile(gatePath, `GATE_RESULT_${randomUUID()}\n`);
          parentYields += await waitForFinal(
            parentKey,
            parentMarker,
            `${parentMarker}\n${operatorResult}`,
          );
          expect(
            finalReplies(await history(paused.childSessionKey), operatorResult).length,
            "operator replay did not execute a second worker turn",
          ).toBe(1);
          const finalTask = await gateway.request<{ task: TaskSummary }>("tasks.get", {
            taskId: originalTask!.id,
          });
          expect(finalTask.task.id === originalTask!.id, "canonical task id survives resume").toBe(
            true,
          );
          expect(
            finalTask.task.status === "completed" && finalTask.task.deliveryStatus === "delivered",
            "resumed canonical task completed and delivered",
          ).toBe(true);
          expect(listSubagentRunsForRequester(parentKey).length, "no duplicate worker task").toBe(
            1,
          );
          console.log(
            `[subagent-handoff-stress] ${JSON.stringify({ phase: "passed", batches, childrenPerBatch, successfulFanoutChildren: batches * childrenPerBatch, parentYields, automaticParentFinals: batches + 1, operatorResumes: 1, operatorReplays: 1, sameTask: true, remappedBatch: true })}`,
          );
        },
        async () => {
          await fs.writeFile(gatePath, "CLEANUP_RELEASE\n");
        },
        async () => {
          await client?.stopAndWait();
        },
        async () => {
          await server?.close({ reason: "live subagent stress complete" });
        },
        async () => {
          await state.cleanup();
          clearRuntimeConfigSnapshot();
          resetPluginRuntimeStateForTest();
        },
      );
    },
    30 * 60_000,
  );
});
