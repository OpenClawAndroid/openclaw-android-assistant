import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  resolveConcreteSessionStorePath,
  resolveExplicitSessionStorePathForScope,
} from "./paths.js";
import { resolveSessionEntry } from "./session-accessor.sqlite-exact-read.js";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptReadTarget,
} from "./session-accessor.types.js";

/** Resolve a prepared store directly; only unbound callers need runtime configuration. */
export function resolveSessionTranscriptReadTargetCore(
  scope: SessionTranscriptReadScope,
  resolveDefaultStorePath?: (scope: SessionTranscriptReadScope & { agentId: string }) => string,
): SessionTranscriptReadTarget {
  const sessionKey = scope.sessionKey?.trim();
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${sessionKey}`);
  }
  const boundScope = {
    ...scope,
    agentId,
    sessionKey,
    storePath: resolveConcreteSessionStorePath(scope.storePath),
  };
  const storePath =
    resolveExplicitSessionStorePathForScope(boundScope) ?? resolveDefaultStorePath?.(boundScope);
  if (!storePath) {
    throw new Error("Transcript reads require a concrete session store path");
  }
  const hasMatchingSessionEntry = scope.sessionEntry?.sessionId === scope.sessionId;
  const resolved =
    sessionKey && !hasMatchingSessionEntry
      ? resolveSessionEntry(
          {
            agentId,
            ...(scope.env ? { env: scope.env } : {}),
            sessionKey,
            storePath,
          },
          { readOnly: true },
        )
      : undefined;
  const resolvedSessionKey = hasMatchingSessionEntry ? sessionKey : resolved?.normalizedKey;
  return {
    agentId,
    sessionId: scope.sessionId,
    storePath,
    ...(resolvedSessionKey ? { sessionKey: resolvedSessionKey } : {}),
  };
}
