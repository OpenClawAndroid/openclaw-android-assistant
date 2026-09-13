import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type {
  AgentRunContext,
  ProjectedAgentRunIndex,
  ProjectedAgentRunState,
} from "./agent-run-registry.types.js";

export function projectedRunIdentity(agentId: string, value: string): string {
  return `${normalizeAgentId(agentId)}\0${value}`;
}

export function buildAgentRunProjectionIndex(params: {
  contexts: Iterable<Readonly<AgentRunContext>>;
  lifecycleGeneration: string;
}): ProjectedAgentRunIndex {
  const sessionKeys = new Map<string, ProjectedAgentRunState>();
  const sessionIds = new Map<string, ProjectedAgentRunState>();
  const ownerlessSessionKeys = new Map<string, ProjectedAgentRunState>();
  const ownerlessSessionIds = new Map<string, ProjectedAgentRunState>();
  const add = (
    index: Map<string, ProjectedAgentRunState>,
    key: string,
    status: ProjectedAgentRunState,
  ) => {
    const previous = index.get(key);
    if (previous !== "running" && !(previous === "queued" && status === "capacity-wait")) {
      index.set(key, status);
    }
  };
  for (const context of params.contexts) {
    const queued = (context.capacityWaits?.size ?? 0) > 0;
    if (
      context.lifecycleGeneration !== params.lifecycleGeneration ||
      (context.projectSessionActive !== true &&
        (!queued ||
          context.projectSessionActive === false ||
          context.projectSessionLifecycle === false))
    ) {
      continue;
    }
    const status = !queued
      ? "running"
      : context.projectSessionActive === true
        ? "queued"
        : "capacity-wait";
    const agentId = context.agentId ?? parseAgentSessionKey(context.sessionKey)?.agentId;
    if (context.sessionKey !== undefined && agentId) {
      add(sessionKeys, projectedRunIdentity(agentId, context.sessionKey), status);
    } else if (context.sessionKey !== undefined) {
      add(ownerlessSessionKeys, context.sessionKey, status);
    }
    if (context.sessionId !== undefined && agentId) {
      add(sessionIds, projectedRunIdentity(agentId, context.sessionId), status);
    } else if (context.sessionId !== undefined) {
      add(ownerlessSessionIds, context.sessionId, status);
    }
  }
  return { sessionKeys, sessionIds, ownerlessSessionKeys, ownerlessSessionIds };
}
