import { expectDefined } from "@openclaw/normalization-core";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import type { GatewayStoredSessionTargets } from "../config/sessions/combined-store-gateway.js";
import { readSessionTranscriptWatermarkBatch } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectSessionActivitySummary } from "./session-activity-summary-state.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/** Called only on the visible, paginated rows; ordinary session lists do no recap work. */
export function projectActivitySummaryList(
  params: {
    cfg: OpenClawConfig;
    opts: { includeActivitySummary?: boolean };
    store: Record<string, SessionEntry>;
    targetsBySessionKey: GatewayStoredSessionTargets;
  },
  rows: GatewaySessionRow[],
): void {
  if (!params.opts.includeActivitySummary) {
    return;
  }
  const entries = rows.map(
    (row) => [row.key, expectDefined(params.store[row.key], "Activity row entry")] as const,
  );
  const cached = entries.filter(([, entry]) => entry.activitySummary !== undefined);
  const watermarks = readSessionTranscriptWatermarkBatch(
    cached.map(([key, entry]) => {
      const target = expectDefined(params.targetsBySessionKey.get(key), "Activity row target");
      return {
        ...target.storeTarget,
        sessionId: entry.sessionId,
        sessionKey: target.storeKey ?? key,
      };
    }),
  );
  const watermarkByKey = new Map(cached.map(([key], index) => [key, watermarks[index]]));
  const enabledByAgent = new Map<string, boolean>();
  for (const row of rows) {
    const target = expectDefined(params.targetsBySessionKey.get(row.key), "Activity row target");
    let enabled = enabledByAgent.get(target.agentId);
    if (enabled === undefined) {
      enabled = Boolean(
        resolveUtilityModelRefForAgent({ cfg: params.cfg, agentId: target.agentId }),
      );
      enabledByAgent.set(target.agentId, enabled);
    }
    row.activitySummary = projectSessionActivitySummary({
      cfg: params.cfg,
      key: target.storeKey ?? row.key,
      agentId: target.agentId,
      entry: params.store[row.key],
      enabled,
      watermark: watermarkByKey.get(row.key),
    });
  }
}
