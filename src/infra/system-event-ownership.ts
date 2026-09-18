import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";

/** Queue identity is scoped without rewriting the caller's persisted session key. */
export function resolveSystemEventQueueKey(sessionKey: string, agentId?: string): string {
  if (!sessionKey.trim()) {
    throw new Error("system events require a sessionKey");
  }
  const owner = resolveAgentIdFromSessionKey(sessionKey, agentId);
  if (agentId && owner !== normalizeAgentId(agentId)) {
    throw new Error("System event owner does not match its session key.");
  }
  return toAgentStoreSessionKey({ agentId: owner, requestKey: sessionKey });
}

export function withSystemEventOwner<T extends { sessionKey: string }>(
  options: T,
  agentId: string,
): Omit<T, "sessionKey"> & { sessionKey: string } {
  return { ...options, sessionKey: resolveSystemEventQueueKey(options.sessionKey, agentId) };
}
