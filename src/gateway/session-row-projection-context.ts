import { getSubagentRegistryPublicationRevision } from "../agents/subagents/registry/subagent-registry-publication.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import { buildProjectedAgentRunIndex } from "../infra/agent-run-registry.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

/** Session metadata changes reuse registry topology until its owner publishes new facts. */
export function createSessionRowProjectionContext() {
  let preparedEpoch = -1;
  let subagentRevision: number | undefined = getSubagentRegistryPublicationRevision();
  let current = buildSessionListRowMetadataContext({ now: Date.now() });
  const subagentInputs = current.subagentRuns.inputs;
  return {
    get current() {
      return current;
    },
    subagentInputs,
    invalidate(change: SessionRowChange) {
      if ("all" in change) {
        if (
          change.scope === "subagent-runs" ||
          change.scope === "stores" ||
          change.scope === "config"
        ) {
          subagentRevision = undefined;
        }
        if (change.scope === "profiles") {
          current.userProfileIdentityById.clear();
        }
      }
    },
    prepare(epoch: number) {
      if (preparedEpoch === epoch) {
        return;
      }
      const now = Date.now(),
        revision = getSubagentRegistryPublicationRevision();
      current = buildSessionListRowMetadataContext({
        now,
        subagentRuns:
          subagentRevision === revision
            ? current.subagentRuns.atTime(now)
            : buildSubagentSessionListReadIndex(now),
        userProfileIdentityById: current.userProfileIdentityById,
      });
      current.projectedAgentRuns = buildProjectedAgentRunIndex();
      Object.assign(subagentInputs, current.subagentRuns.inputs);
      subagentRevision = revision;
      preparedEpoch = epoch;
    },
  };
}
