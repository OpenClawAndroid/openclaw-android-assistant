// Litellm tests cover index plugin behavior.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePluginRegistration,
  registerProviderPlugin,
  requireRegisteredProvider,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import plugin from "./index.js";

const LITELLM_DEFAULT_MODEL = {
  id: "claude-opus-4-6",
  name: "Claude Opus 4.6",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

function registerProvider() {
  const captured = capturePluginRegistration(plugin);
  const provider = captured.providers[0];
  expect(provider?.id).toBe("litellm");
  return provider;
}

describe("litellm plugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearLiveCatalogCacheForTests();
  });

  it.each([
    {
      name: "default proxy base URL",
      baseUrl: undefined,
      endpoint: "http://localhost:4000/v1/models",
    },
    {
      name: "unversioned explicit base URL",
      baseUrl: "https://litellm.example",
      endpoint: "https://litellm.example/v1/models",
    },
    {
      name: "versioned explicit base URL",
      baseUrl: "https://litellm.example/v1",
      endpoint: "https://litellm.example/v1/models",
    },
    {
      name: "versioned explicit base URL with a path prefix and trailing slashes",
      baseUrl: " https://proxy.example/litellm/v1// ",
      endpoint: "https://proxy.example/litellm/v1/models",
    },
    {
      name: "versioned explicit base URL under a mixed-case provider key",
      providerKey: "LiteLLM",
      baseUrl: "https://litellm.example/v1",
      endpoint: "https://litellm.example/v1/models",
    },
  ])("discovers models from the $name", async ({ providerKey = "litellm", baseUrl, endpoint }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      input === endpoint
        ? Response.json({ object: "list", data: [{ id: "proxy-model", object: "model" }] })
        : new Response("Not Found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "litellm",
      name: "LiteLLM Provider",
    });

    const result = await runProviderCatalog({
      provider: requireRegisteredProvider(providers, "litellm"),
      config: baseUrl ? { models: { providers: { [providerKey]: { baseUrl, models: [] } } } } : {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "LITELLM_API_KEY", discoveryApiKey: "sk-test" }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([endpoint]);
    expect(result).toMatchObject({
      provider: { models: [expect.objectContaining({ id: "proxy-model" })] },
      outcomes: [{ provider: "litellm", status: "ready" }],
    });
  });

  it("honors --custom-base-url in non-interactive API-key setup", async () => {
    const provider = registerProvider();
    const auth = provider?.auth?.[0];
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-litellm-auth-"));
    const resolveApiKey = vi.fn(async () => ({ key: "litellm-test-key", source: "flag" as const }));
    const toApiKeyCredential = vi.fn(({ provider: providerId, resolved }) => ({
      type: "api_key" as const,
      provider: providerId,
      key: resolved.key,
    }));

    try {
      const result = await auth?.runNonInteractive?.({
        authChoice: "litellm-api-key",
        config: {},
        baseConfig: {},
        opts: {
          litellmApiKey: "litellm-test-key",
          customBaseUrl: "https://litellm.example/v1/",
        },
        runtime: createRuntimeSpies(),
        agentDir,
        resolveApiKey,
        toApiKeyCredential,
      });

      expect(result).toStrictEqual({
        auth: {
          profiles: {
            "litellm:default": {
              provider: "litellm",
              mode: "api_key",
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "litellm/claude-opus-4-6": {
                alias: "LiteLLM",
              },
            },
            model: {
              primary: "litellm/claude-opus-4-6",
            },
          },
        },
        models: {
          mode: "merge",
          providers: {
            litellm: {
              baseUrl: "https://litellm.example/v1",
              api: "openai-completions",
              models: [LITELLM_DEFAULT_MODEL],
            },
          },
        },
      });
      expect(resolveApiKey).toHaveBeenCalledWith({
        provider: "litellm",
        flagValue: "litellm-test-key",
        flagName: "--litellm-api-key",
        envVar: "LITELLM_API_KEY",
      });
      expect(toApiKeyCredential).toHaveBeenCalledWith({
        provider: "litellm",
        resolved: { key: "litellm-test-key", source: "flag" },
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
