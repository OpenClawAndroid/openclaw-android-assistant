import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

describe("configured catalog registry composition", () => {
  it.each<{
    name: string;
    mode: "merge" | "replace";
    capturedBaseUrl: string;
    capturedId: string;
    pin: boolean;
    modelApi?: ModelCatalogEntry["api"];
    modelBaseUrl?: string;
    expectedBaseUrl: string;
    expectedIds: string[];
    inheritsChoices: boolean;
  }>([
    {
      name: "captured metadata",
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: true,
    },
    {
      name: "replace exclusion",
      mode: "replace",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected"],
      inheritsChoices: false,
    },
    {
      name: "captured endpoint",
      mode: "merge",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "http://127.0.0.1:9/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: false,
    },
    {
      name: "replace with a different captured endpoint",
      mode: "replace",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected"],
      inheritsChoices: false,
    },
    {
      name: "model endpoint pin",
      mode: "merge",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "selected",
      pin: true,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: true,
    },
    {
      name: "case-sensitive identity",
      mode: "merge",
      capturedBaseUrl: "http://127.0.0.1:9/v1",
      capturedId: "Selected",
      pin: false,
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "Selected", "retained-only"],
      inheritsChoices: true,
    },
    {
      name: "captured route",
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      modelApi: "openai-completions",
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: true,
    },
    {
      name: "API override",
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      modelApi: "openai-responses",
      expectedBaseUrl: "https://fixture.invalid/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: false,
    },
    {
      name: "endpoint override",
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      modelBaseUrl: "https://proxy.invalid/v1",
      expectedBaseUrl: "https://proxy.invalid/v1",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: false,
    },
    {
      name: "equivalent endpoint",
      mode: "merge",
      capturedBaseUrl: "https://fixture.invalid/v1",
      capturedId: "selected",
      pin: false,
      modelBaseUrl: "https://fixture.invalid/v1/",
      expectedBaseUrl: "https://fixture.invalid/v1/",
      expectedIds: ["selected", "retained-only"],
      inheritsChoices: true,
    },
  ])(
    "keeps configured rows and same-route choices: $name",
    ({
      mode,
      capturedBaseUrl,
      capturedId,
      pin,
      modelApi,
      modelBaseUrl,
      expectedBaseUrl,
      expectedIds,
      inheritsChoices,
    }) => {
      const configured: ModelCatalogEntry = {
        provider: "donor-fixture",
        id: "selected",
        name: "Configured selected",
        api: modelApi ?? "openai-completions",
        baseUrl: "https://fixture.invalid/v1",
        contextWindow: 32_000,
        reasoning: true,
        configuredReasoning: true,
        input: ["text"],
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      const config: OpenClawConfig = {
        models: {
          mode,
          providers: {
            "donor-fixture": {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              models: [
                {
                  id: "selected",
                  name: "Configured selected",
                  contextWindow: 32_000,
                  maxTokens: 4096,
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  ...(modelApi ? { api: modelApi } : {}),
                  ...(modelBaseUrl
                    ? { baseUrl: modelBaseUrl }
                    : pin
                      ? { baseUrl: configured.baseUrl }
                      : {}),
                },
              ],
            },
          },
        },
      };
      const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
        config,
        includePluginCatalogs: false,
        pluginMetadataSnapshot: metadataSnapshot,
        modelsJsonContents: JSON.stringify({
          providers: {
            "donor-fixture": {
              api: "openai-completions",
              baseUrl: capturedBaseUrl,
              models: [
                {
                  id: capturedId,
                  name: "Earlier selected",
                  contextWindow: 64_000,
                  maxTokens: 4096,
                  reasoning: false,
                  input: ["text", "image"],
                },
                {
                  id: "retained-only",
                  name: "Retained authored row",
                  contextWindow: 48_000,
                  maxTokens: 4096,
                  reasoning: false,
                  input: ["text", "image"],
                },
              ],
            },
          },
        }),
      });
      const agentFacts = {
        input: { config },
        configuredModelRefs: [{ provider: "donor-fixture", modelId: "selected" }],
      };
      const workspaceFacts = {
        configuredCatalogEntries: [configured],
        pluginMetadataSnapshot: metadataSnapshot,
        inlineProviderModels: [],
      };
      const { modelCatalog } = prepareCapturedRuntimeFacts({
        agentFacts,
        workspaceFacts,
        templateModelRegistry: registry,
        configuredRuntimeModels: [
          { id: "32k", label: "32K", contextWindow: 32000 },
          { id: "64k", label: "64K", contextWindow: 64000 },
        ].map<PreparedConfiguredRuntimeModel>((option) => ({
          provider: configured.provider,
          modelId: configured.id,
          model: {
            id: configured.id,
            name: configured.name,
            provider: configured.provider,
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
            contextWindows: [option],
            contextWindowDefault: option.id,
          },
        })),
      });

      expect(modelCatalog.entries.map((entry) => entry.id)).toEqual(expectedIds);
      const expectedEntry = {
        ...configured,
        baseUrl: expectedBaseUrl,
        ...(inheritsChoices
          ? {
              contextWindows: [{ id: "32k", label: "32K", contextWindow: 32000 }],
              contextWindowDefault: "32k",
            }
          : {}),
      };
      expect(modelCatalog.entries[0]).toEqual(expectedEntry);
      expect(modelCatalog.routeVariants).toEqual(modelCatalog.entries);
      const policy = createModelVisibilityPolicy({
        cfg: config,
        catalog: modelCatalog.entries,
        defaultProvider: configured.provider,
        defaultModel: configured.id,
        manifestPlugins: metadataSnapshot,
      });
      expect(policy.configuredCatalog[0]).toEqual(expectedEntry);
    },
  );
});
