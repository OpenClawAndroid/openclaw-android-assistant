import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveThinkingDefault } from "./model-thinking-default.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => metadataSnapshot,
}));

const providerPolicySurfaceMock = vi.hoisted(() => ({
  resolveBundledProviderPolicySurface: vi.fn((providerId: string) => {
    if (providerId !== "anthropic" && providerId !== "amazon-bedrock") {
      return null;
    }
    return {
      resolveThinkingProfile: (context: { modelId: string }) =>
        context.modelId.includes("claude-") && context.modelId.includes("4-6")
          ? {
              levels: [
                { id: "off", label: "off", rank: 0 },
                { id: "adaptive", label: "adaptive", rank: 6 },
              ],
              defaultLevel: "adaptive",
            }
          : undefined,
    };
  }),
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveBundledProviderPolicySurface:
    providerPolicySurfaceMock.resolveBundledProviderPolicySurface,
  resolveProviderPolicySurface: providerPolicySurfaceMock.resolveBundledProviderPolicySurface,
}));

const ANTHROPIC_OPUS_CATALOG = [
  {
    provider: "anthropic",
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
  },
];

function resolveAnthropicOpusThinking(cfg: OpenClawConfig) {
  return resolveThinkingDefault({
    cfg,
    provider: "anthropic",
    model: "claude-opus-4-6",
    catalog: ANTHROPIC_OPUS_CATALOG,
  });
}

describe("resolveThinkingDefault", () => {
  it.each([
    {
      name: "prefers per-model params.thinking over global thinkingDefault",
      thinking: "high",
      thinkingDefault: "low" as const,
      expected: "high",
    },
    {
      name: "accepts per-model params.thinking=adaptive",
      thinking: "adaptive",
      thinkingDefault: undefined,
      expected: "adaptive",
    },
    {
      name: "normalizes per-model thinking aliases accepted by runtime controls",
      thinking: "extra-high",
      thinkingDefault: "low" as const,
      expected: "xhigh",
    },
  ])("$name", ({ thinking, thinkingDefault, expected }) => {
    const cfg = {
      agents: {
        defaults: {
          ...(thinkingDefault ? { thinkingDefault } : {}),
          models: {
            "anthropic/claude-opus-4-6": {
              params: { thinking },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveAnthropicOpusThinking(cfg)).toBe(expected);
  });

  it.each([
    { thinking: false, agentDefault: undefined, expected: "off" },
    { thinking: "extra-high", agentDefault: undefined, expected: "xhigh" },
    { thinking: "high", agentDefault: "minimal", expected: "minimal" },
  ] as const)(
    "resolves agent thinking defaults (model=$thinking, agent=$agentDefault)",
    ({ thinking, agentDefault, expected }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            thinkingDefault: "low",
            models: { "fixture/reasoning-model": { params: { thinking: "high" } } },
          },
          entries: {
            alpha: {
              thinkingDefault: agentDefault,
              models: { "fixture/reasoning-model": { params: { thinking } } },
            },
          },
        },
      };
      expect(
        resolveThinkingDefault({
          cfg,
          agentId: "alpha",
          provider: "fixture",
          model: "reasoning-model",
        }),
      ).toBe(expected);
    },
  );

  it("accepts legacy duplicated OpenRouter keys for per-model thinking", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/openrouter/hunter-alpha": {
              params: { thinking: "high" },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveThinkingDefault({
        cfg,
        provider: "openrouter",
        model: "openrouter/hunter-alpha",
      }),
    ).toBe("high");
  });

  it.each([
    { name: "treats params.thinking=false as off (#74374)", thinking: false },
    {
      name: 'treats params.thinking="disabled" as off (#74374)',
      thinking: "disabled",
    },
    { name: 'treats params.thinking="none" as off', thinking: "none" },
  ])("$name", ({ thinking }) => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "deepseek/deepseek-v4-pro": {
              params: { thinking },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveThinkingDefault({
        cfg,
        provider: "deepseek",
        model: "deepseek-v4-pro",
      }),
    ).toBe("off");
  });

  it.each([
    {
      name: "defaults explicitly configured Anthropic Opus 5 to high adaptive thinking",
      provider: "anthropic",
      model: "claude-opus-5",
      modelName: "Claude Opus 5",
      expected: "high",
    },
    {
      name: "keeps thinking off by default for explicitly configured Anthropic Opus 4.7",
      provider: "anthropic",
      model: "claude-opus-4-7",
      modelName: "Claude Opus 4.7",
      expected: "off",
    },
    {
      name: "leaves explicitly configured Anthropic Opus 4.8 thinking off by default",
      provider: "anthropic",
      model: "claude-opus-4-8",
      modelName: "Claude Opus 4.8",
      expected: "off",
    },
    {
      name: "leaves explicitly configured Anthropic Vertex Opus 4.8 thinking off by default",
      provider: "anthropic-vertex",
      model: "claude-opus-4-8",
      modelName: "Claude Opus 4.8",
      expected: "off",
    },
    {
      name: "leaves explicitly configured Claude CLI Opus 4.8 thinking off by default",
      provider: "claude-cli",
      model: "claude-opus-4-8",
      modelName: "Claude Opus 4.8",
      expected: "off",
    },
  ])("$name", ({ provider, model, modelName, expected }) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: `${provider}/${model}` } } },
    };

    expect(
      resolveThinkingDefault({
        cfg,
        provider,
        model,
        catalog: [{ provider, id: model, name: modelName, reasoning: true }],
      }),
    ).toBe(expected);
  });

  it("uses provider policy thinking defaults when no explicit config overrides them", () => {
    const cfg = {} as OpenClawConfig;

    expect(resolveAnthropicOpusThinking(cfg)).toBe("adaptive");
    expect(
      resolveThinkingDefault({
        cfg,
        provider: "amazon-bedrock",
        model: "us.anthropic.claude-sonnet-4-6",
        catalog: [
          {
            provider: "amazon-bedrock",
            id: "us.anthropic.claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            reasoning: true,
          },
        ],
      }),
    ).toBe("adaptive");
  });

  it("falls back to medium when no provider thinking policy is active", () => {
    const cfg = {} as OpenClawConfig;

    expect(
      resolveThinkingDefault({
        cfg,
        provider: "custom-provider",
        model: "custom-reasoning-model",
        catalog: [
          {
            provider: "custom-provider",
            id: "custom-reasoning-model",
            name: "Custom Reasoning Model",
            reasoning: true,
          },
        ],
      }),
    ).toBe("medium");
  });

  it("honors configured provider models that disable reasoning", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "gemma-4-26b-a4b-it",
                name: "Gemma 4 26B",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveThinkingDefault({
        cfg,
        provider: "google",
        model: "gemma-4-26b-a4b-it",
      }),
    ).toBe("off");
  });
});
