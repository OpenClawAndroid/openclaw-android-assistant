import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";

/** Keep both diagnostics in the message-only worker response and both causes locally. */
export function sessionHistoryCleanupError(
  error: unknown,
  cleanupError: unknown,
  stage: "database close" | "worker retirement",
): AggregateError {
  return new AggregateError(
    [error, cleanupError],
    `${coerceErrorMessage(error)}; ${stage} failed: ${coerceErrorMessage(cleanupError)}`,
    { cause: cleanupError },
  );
}
