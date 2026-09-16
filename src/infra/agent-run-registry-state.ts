// Canonical process-local registry state; callers retain the existing singleton identity.
import { randomUUID } from "node:crypto";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  AgentRunContext,
  AgentRunContextOwnership,
  AgentRunRegistryState,
} from "./agent-run-registry.types.js";

const AGENT_RUN_REGISTRY_STATE_KEY = Symbol.for("openclaw.agentRunRegistry.state");

export function getAgentRunRegistryState(): AgentRunRegistryState {
  return resolveGlobalSingleton<AgentRunRegistryState>(AGENT_RUN_REGISTRY_STATE_KEY, () => ({
    contexts: new Map<string, AgentRunContext>(),
    owners: new Map<string, AgentRunContextOwnership>(),
    lifecycleGeneration: randomUUID(),
    version: 0,
  }));
}

export function bumpAgentRunIndexVersion(): void {
  getAgentRunRegistryState().version += 1;
}
