import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { GetPublishedPreparedModelCatalogOwnerParams } from "../../agents/prepared-model-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChatMetadataProjectionFacts } from "./chat-metadata-session-projection.js";

export type PreparedAgentFacts = ChatMetadataProjectionFacts & {
  authStoreRevision: string;
  catalogStatusKey: string;
  skillsVersion: number;
};

export type PreparedGenerationFacts = {
  config: OpenClawConfig;
  configKey: string;
  pluginRegistryVersion: number;
  agents: PreparedAgentFacts[];
};

export type ChatMetadataFactsDeps = {
  getConfig: () => OpenClawConfig;
  getPreparedOwner: (
    params: GetPublishedPreparedModelCatalogOwnerParams,
  ) => PreparedModelRuntimeSnapshot | undefined;
  getPreparedAuthStore: (
    agentDir?: string,
    inheritedAuthDir?: string,
  ) => AuthProfileStore | undefined;
  getAuthStoreRevision: (agentDir?: string) => number;
  getSkillsVersion: (workspaceDir?: string) => number;
  getPluginRegistryVersion: () => number;
};

export function generationFactsMatch(
  left: PreparedGenerationFacts,
  right: PreparedGenerationFacts,
): boolean {
  if (
    left.configKey !== right.configKey ||
    left.pluginRegistryVersion !== right.pluginRegistryVersion ||
    left.agents.length !== right.agents.length
  ) {
    return false;
  }
  return left.agents.every((agent, index) => {
    const candidate = right.agents[index];
    return (
      candidate?.agentId === agent.agentId &&
      candidate.owner === agent.owner &&
      candidate.authStoreRevision === agent.authStoreRevision &&
      candidate.modelCatalog === agent.modelCatalog &&
      candidate.catalogStatusKey === agent.catalogStatusKey &&
      candidate.skillsVersion === agent.skillsVersion
    );
  });
}
