import { classifyProviderFailoverSignalWithPlugin } from "../../plugins/provider-failover.js";
import type { FailoverReason } from "./signal.js";
type ProviderErrorPattern = {
  /** Regex to match against the raw error message. */
  test: RegExp;
  /** The failover reason this pattern maps to. */
  reason: FailoverReason;
};
/**
 * Provider-specific patterns that map to specific failover reasons.
 * These handle cases where the generic message tables produce wrong results
 * for specific providers.
 */
const PROVIDER_SPECIFIC_PATTERNS: readonly ProviderErrorPattern[] = [
  {
    test: /\bworkers_ai\b.*\bquota limit exceeded\b/i,
    reason: "rate_limit",
  },
  {
    test: /\bmodelnotreadyexception\b/i,
    reason: "overloaded",
  },
  // Groq does not currently ship a bundled provider hook.
  {
    test: /model(?:_is)?_deactivated|model has been deactivated/i,
    reason: "model_not_found",
  },
];

type ProviderSpecificErrorContext = {
  provider?: string;
  modelId?: string;
  errorMessage: string;
  status?: number;
  code?: string;
  errorType?: string;
  providerPlugin?: PreparedProviderFailoverOwner | null;
};
export type PreparedProviderFailoverOwner = {
  id: string;
  matchesContextOverflowError?: (ctx: ProviderSpecificErrorContext) => boolean | undefined;
  classifyFailoverReason?: (ctx: ProviderSpecificErrorContext) => FailoverReason | null | undefined;
};

export function classifyProviderPluginError(
  context: ProviderSpecificErrorContext,
): FailoverReason | null {
  const { providerPlugin, ...providerContext } = context;
  // Presentation has no provider owner; explicit absence must not trigger discovery.
  if (providerPlugin === null) {
    return null;
  }
  if (providerPlugin) {
    const ownedContext = { ...providerContext, provider: providerPlugin.id };
    if (providerPlugin.matchesContextOverflowError?.(ownedContext)) {
      return "context_overflow";
    }
    return providerPlugin.classifyFailoverReason?.(ownedContext) ?? null;
  }
  return (
    classifyProviderFailoverSignalWithPlugin({
      provider: context.provider,
      context: providerContext,
    }) ?? null
  );
}
export function classifyLegacyProviderSpecificError(
  context: ProviderSpecificErrorContext,
): FailoverReason | null {
  for (const pattern of PROVIDER_SPECIFIC_PATTERNS) {
    if (pattern.test.test(context.errorMessage)) {
      return pattern.reason;
    }
  }
  return null;
}
