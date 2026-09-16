// Provides model selection, usage, and thinking-level utility helpers.
import {
  calculateUsageCost,
  resolveClaudeNativeThinkingLevelMap,
  requiresClaudeMandatoryAdaptiveThinking,
} from "@openclaw/llm-core";
import {
  resolveOpenAIThinkingApi,
  listMappedModelThinkingLevels,
  MODEL_CATALOG_THINKING_LEVELS,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { resolveOpenAIModelReasoningEfforts } from "./providers/openai-reasoning-effort.js";
import type { Api, Model, ModelThinkingLevel, Usage } from "./types.js";

/** Calculates and stores model cost fields from token usage and per-million pricing. */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  Object.assign(usage.cost, calculateUsageCost(usage, model.cost));
  return usage.cost;
}

/** Replaces the catalog estimate when the provider reports an authoritative billed total. */
export function applyProviderReportedUsageCost(usage: Usage, reportedCost: unknown): void {
  if (typeof reportedCost !== "number" || !Number.isFinite(reportedCost) || reportedCost < 0) {
    return;
  }
  usage.cost.total = reportedCost;
  usage.cost.totalOrigin = "provider-billed";
}

function resolveThinkingLevelMap<TApi extends Api>(model: Model<TApi>) {
  return model.api === "anthropic-messages"
    ? (resolveClaudeNativeThinkingLevelMap(model) ?? model.thinkingLevelMap)
    : model.thinkingLevelMap;
}

/** Returns thinking levels exposed by a reasoning-capable model. */
export function getSupportedThinkingLevels<TApi extends Api>(
  model: Model<TApi>,
): ModelThinkingLevel[] {
  const mandatoryAdaptiveContract =
    model.api === "anthropic-messages" && requiresClaudeMandatoryAdaptiveThinking(model);
  if (!model.reasoning && !mandatoryAdaptiveContract) {
    return ["off"];
  }
  const thinkingLevelMap = resolveThinkingLevelMap(model);
  const reasoningEfforts = resolveOpenAIThinkingApi(model.api)
    ? resolveOpenAIModelReasoningEfforts(model)
    : undefined;
  const mappedLevels = listMappedModelThinkingLevels(model);

  return MODEL_CATALOG_THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return (
        mapped !== undefined ||
        mappedLevels.includes(level) ||
        reasoningEfforts?.includes(level) === true
      );
    }
    return true;
  });
}

/** Clamps a requested thinking level to the closest supported level for a model. */
export function clampThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const availableLevels = getSupportedThinkingLevels(model);
  if (availableLevels.includes(level)) {
    return level;
  }

  const requestedIndex = MODEL_CATALOG_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) {
    return availableLevels[0] ?? "off";
  }

  // Explicit provider opt-outs are hard caps. Downgrade them before considering
  // stronger levels so unsupported xhigh/max requests cannot increase cost.
  const thinkingLevelMap = resolveThinkingLevelMap(model);
  if ((level === "xhigh" || level === "max") && thinkingLevelMap?.[level] === null) {
    for (const candidate of MODEL_CATALOG_THINKING_LEVELS.slice(0, requestedIndex).toReversed()) {
      if (availableLevels.includes(candidate)) {
        return candidate;
      }
    }
  }

  // Prefer the next stronger available level, then walk down if the request was above the model cap.
  for (const candidate of MODEL_CATALOG_THINKING_LEVELS.slice(requestedIndex)) {
    if (availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  for (const candidate of MODEL_CATALOG_THINKING_LEVELS.slice(0, requestedIndex).toReversed()) {
    if (availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  return availableLevels[0] ?? "off";
}

/** Compares model identity by provider and id. */
export function modelsAreEqual<TApi extends Api>(
  a: Model<TApi> | null | undefined,
  b: Model<TApi> | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.id === b.id && a.provider === b.provider;
}
