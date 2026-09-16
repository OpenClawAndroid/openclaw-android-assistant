// Live OpenAI AgentSession coverage for repeated automatic compaction and long-context opt-in.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Message, Model, Tool } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import {
  estimateToolSchemaTokenPressure,
  shouldPreemptivelyCompactBeforePrompt,
} from "../embedded-agent-runner/run/preemptive-compaction.js";
import { attemptServerEndpointCompaction } from "../embedded-agent-runner/server-endpoint-compaction.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_OPENAI_COMPACTION) && API_KEY.length > 0;
const FULL_CONTEXT = isTruthyEnvValue(process.env.OPENCLAW_LIVE_OPENAI_COMPACTION_FULL);
const describeLive = LIVE ? describe : describe.skip;
const MODEL_ID = process.env.OPENCLAW_LIVE_OPENAI_COMPACTION_MODEL?.trim() || "gpt-5.6-luna";
const STRESS_PROFILE = FULL_CONTEXT
  ? {
      contextTokens: 922_000,
      compactionReserveTokens: 222_000,
      keepRecentTokens: 50_000,
      chunkChars: 900_000,
      maxTurns: 12,
      maxOutputTokens: 128_000,
      providerTimeoutMs: 10 * 60 * 1000,
      testTimeoutMs: 60 * 60 * 1000,
    }
  : {
      contextTokens: 48_000,
      compactionReserveTokens: 8_000,
      keepRecentTokens: 4_000,
      chunkChars: 120_000,
      maxTurns: 8,
      maxOutputTokens: 8_192,
      providerTimeoutMs: 2 * 60 * 1000,
      testTimeoutMs: 10 * 60 * 1000,
    };

const sessions: AgentSession[] = [];
const tempRoots: string[] = [];

function createResourceLoader(): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function buildContextChunk(targetChars: number): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < targetChars; index += 1) {
    const line =
      `Context stress record ${index}: the copper lighthouse tracks violet weather ` +
      `while patient engineers preserve durable state across each compacted conversation.\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join("").slice(0, targetChars);
}

function countCompactions(sessionManager: SessionManager): number {
  return sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
}

async function createLiveSession() {
  const root = await mkdtemp(join(tmpdir(), "openclaw-openai-compaction-live-"));
  tempRoots.push(root);
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const modelsPath = join(root, "models.json");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    modelsPath,
    `${JSON.stringify(
      {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: [
              {
                id: MODEL_ID,
                name: MODEL_ID,
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: STRESS_PROFILE.contextTokens,
                contextTokens: STRESS_PROFILE.contextTokens,
                maxTokens: STRESS_PROFILE.maxOutputTokens,
                compat: {
                  supportsReasoningEffort: true,
                  supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
                  supportsTemperature: false,
                },
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("openai", API_KEY);
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
  const model = modelRegistry.find("openai", MODEL_ID) as Model<"openai-responses"> | undefined;
  if (!model) {
    throw new Error(`failed to load live OpenAI model ${MODEL_ID}`);
  }

  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: "medium",
    compaction: {
      enabled: true,
      reserveTokens: STRESS_PROFILE.compactionReserveTokens,
      keepRecentTokens: STRESS_PROFILE.keepRecentTokens,
    },
    retry: {
      enabled: false,
      provider: { timeoutMs: STRESS_PROFILE.providerTimeoutMs, maxRetryDelayMs: 0 },
    },
  });
  const contextChunk = buildContextChunk(STRESS_PROFILE.chunkChars);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "medium",
    noTools: "all",
    resourceLoader: createResourceLoader(),
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
  });
  sessions.push(session);
  return { contextChunk, session, sessionManager };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describeLive("OpenAI AgentSession repeated compaction live", () => {
  it(
    "uses native budget checkpoints and measured usage across two saved tool-output continuations",
    async () => {
      const model = {
        id: MODEL_ID,
        name: MODEL_ID,
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 1_024,
      } satisfies Model<"openai-responses">;
      const sessionId = randomUUID();
      const durableMarker = `OPENAI-CHECKPOINT-${randomUUID()}`;
      const systemPrompt = "Preserve the durable marker and follow the user's output instructions.";
      const tools: Tool[] = [
        {
          name: "read_synthetic_context",
          description: "Read synthetic context records for this compaction test.",
          parameters: Type.Object({}, { additionalProperties: false }),
        },
      ];
      const toolSchemaTokens = estimateToolSchemaTokenPressure(tools);
      const streamFn = createOpenAIResponsesTransportStreamFn();
      const requestOptions = {
        apiKey: API_KEY,
        sessionId,
        transport: "sse",
        reasoning: "low",
        maxTokens: 1_024,
        timeoutMs: 2 * 60 * 1000,
      } as const;
      let sessionManager = SessionManager.inMemory();
      const messages = () =>
        sessionManager
          .buildSessionContext()
          .messages.filter(
            (message): message is Message =>
              message.role === "user" ||
              message.role === "assistant" ||
              message.role === "toolResult",
          );
      const reopen = () => {
        const persisted = JSON.stringify(sessionManager.getPersistedEntries());
        sessionManager = SessionManager.fromEntries(JSON.parse(persisted));
      };
      const complete = async (toolChoice: "none" | "required") => {
        try {
          const options = {
            ...requestOptions,
            toolChoice,
          } satisfies Parameters<typeof attemptServerEndpointCompaction>[0]["requestOptions"];
          const stream = await Promise.resolve(
            streamFn(model, { systemPrompt, messages: messages(), tools }, options),
          );
          const response = await stream.result();
          expect(response.errorMessage).toBeUndefined();
          expect(response.stopReason).toBe(toolChoice === "required" ? "toolUse" : "stop");
          sessionManager.appendMessage(response);
          return response;
        } finally {
          // Each subsequent request must work from persisted replay, without process-local continuation state.
          cleanupSessionResources(sessionId);
        }
      };

      try {
        sessionManager.appendMessage({
          role: "user",
          content: `Remember durable marker ${durableMarker}. Reply with exactly ${durableMarker}.`,
          timestamp: Date.now(),
        });
        await complete("none");

        for (let cycle = 1; cycle <= 2; cycle += 1) {
          const compacted = await attemptServerEndpointCompaction({
            trigger: "budget",
            streamFn,
            model,
            context: { systemPrompt, messages: messages() },
            sessionManager,
            extraParams: {},
            requestOptions,
          });
          expect(compacted).toBeDefined();
          if (!compacted) {
            throw new Error(`native budget compaction did not complete on cycle ${cycle}`);
          }
          reopen();
          const owner = messages().at(-1);
          expect(owner).toMatchObject({
            role: "assistant",
            providerReplay: { data: compacted.item.encrypted_content },
          });

          sessionManager.appendMessage({
            role: "user",
            content:
              "Call read_synthetic_context exactly once, then reply with exactly the durable marker I asked you to remember.",
            timestamp: Date.now(),
          });
          const requested = await complete("required");
          const calls = requested.content.filter((block) => block.type === "toolCall");
          expect(calls).toHaveLength(1);
          const call = calls[0];
          if (!call || call.name !== "read_synthetic_context") {
            throw new Error("provider did not request the synthetic context tool");
          }
          sessionManager.appendMessage({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: buildContextChunk(24_000) }],
            isError: false,
            timestamp: Date.now(),
          });
          const response = await complete("none");
          expect(
            response.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("")
              .trim(),
          ).toBe(durableMarker);
          reopen();
          expect(messages().at(-1)).toHaveProperty(
            "openclawResponsesInputReplay.contextUsage.totalTokens",
            response.usage.contextUsage?.state === "available"
              ? response.usage.contextUsage.totalTokens
              : undefined,
          );
          expect(response.usage.contextUsage?.state).toBe("available");

          const savedMessages = messages();
          const unboundMessages = structuredClone(savedMessages);
          for (const message of unboundMessages) {
            if (
              "openclawResponsesInputReplay" in message &&
              isRecord(message.openclawResponsesInputReplay)
            ) {
              delete message.openclawResponsesInputReplay.contextUsage;
            }
          }
          const precheck = (history: Message[], contextTokenBudget: number) => {
            const decision = shouldPreemptivelyCompactBeforePrompt({
              messages: history,
              systemPrompt,
              prompt: "Continue remembering the durable marker.",
              contextTokenBudget,
              reserveTokens: 0,
              toolSchemaTokens,
              replay: { model, sessionId },
            });
            return decision.compactionReplay ?? decision;
          };
          const measured = precheck(savedMessages, model.contextWindow);
          const conservative = precheck(unboundMessages, model.contextWindow);
          expect(measured.pressureSource).toBe("provider_context_usage");
          expect(measured.estimatedPromptTokens).toBeLessThan(conservative.estimatedPromptTokens);
          // This smaller budget exercises host routing only; it is never sent to the provider.
          const diagnosticBudget = Math.floor(
            (measured.estimatedPromptTokens + conservative.estimatedPromptTokens) / 2,
          );
          expect(precheck(savedMessages, diagnosticBudget).route).toBe("fits");
          expect(precheck(unboundMessages, diagnosticBudget).overflowTokens).toBeGreaterThan(0);
          process.stderr.write(
            `[openai-checkpoint-live] cycle=${cycle} measured=${measured.estimatedPromptTokens} conservative=${conservative.estimatedPromptTokens} budget=${diagnosticBudget} marker=preserved\n`,
          );
        }
      } finally {
        cleanupSessionResources(sessionId);
      }
    },
    10 * 60 * 1000,
  );

  it(
    "compacts multiple times and preserves durable conversation state",
    async () => {
      const { contextChunk, session, sessionManager } = await createLiveSession();
      const durableMarker = `OPENAI-COMPACTION-${Date.now().toString(36).toUpperCase()}`;
      await session.prompt(
        `Remember durable marker ${durableMarker}. Reply with exactly ${durableMarker}.`,
      );

      let maximumObservedPromptTokens = 0;
      for (
        let turn = 1;
        turn <= STRESS_PROFILE.maxTurns && countCompactions(sessionManager) < 2;
        turn += 1
      ) {
        const acknowledgement = `OPENAI-CONTEXT-${turn}-OK`;
        await session.prompt(
          `${contextChunk}\n\nReply with exactly ${acknowledgement} and nothing else.`,
        );
        const finalAssistant = session.messages.findLast(
          (message) => message.role === "assistant" && message.stopReason === "stop",
        );
        expect(finalAssistant).toBeDefined();
        if (finalAssistant?.role !== "assistant") {
          throw new Error(`missing final assistant message for turn ${turn}`);
        }
        expect(session.getLastAssistantText()).toContain(acknowledgement);
        const promptTokens =
          finalAssistant.usage.contextUsage?.state === "available"
            ? finalAssistant.usage.contextUsage.promptTokens
            : finalAssistant.usage.input +
              finalAssistant.usage.cacheRead +
              finalAssistant.usage.cacheWrite;
        maximumObservedPromptTokens = Math.max(maximumObservedPromptTokens, promptTokens);
        process.stderr.write(
          `[openai-compaction-live] turn=${turn} compactions=${countCompactions(sessionManager)} prompt=${promptTokens}\n`,
        );
      }

      expect(countCompactions(sessionManager)).toBeGreaterThanOrEqual(2);
      if (FULL_CONTEXT) {
        expect(maximumObservedPromptTokens).toBeGreaterThan(272_000);
      }

      await session.prompt(`Reply with exactly the durable marker I asked you to remember.`);
      expect(session.getLastAssistantText()?.trim()).toBe(durableMarker);
    },
    STRESS_PROFILE.testTimeoutMs,
  );
});
