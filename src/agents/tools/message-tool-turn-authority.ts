import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMessageActionTurnAuthorization,
  resolveMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { createAbortError } from "../../infra/abort-signal.js";

/** Keep discovery and execution bound to the same private turn identity. */
export function createMessageToolTurnAuthority(params: {
  token?: string;
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  getConfig: () => OpenClawConfig;
  admitScheduledInvocation?: () => OpenClawConfig;
}) {
  const { token, agentId, runId, sessionKey, sessionId } = params;
  const lookup =
    agentId && sessionKey ? { token, agentId, runId, sessionKey, sessionId } : undefined;
  const resolve = () => lookup && resolveMessageActionTurnAuthorization(lookup);
  const policy = resolve()?.scheduled?.policy;
  const origin = policy?.mode === "account" ? policy.ownerOrigin : undefined;
  return {
    captureCaller: (signal: AbortSignal | undefined, capture: () => (() => void) | undefined) => {
      if (signal?.aborted) {
        throw createAbortError("Message send aborted");
      }
      const assertCurrent = capture();
      assertCurrent?.();
      return () => {
        assertCurrent?.();
        if (signal?.aborted) {
          throw createAbortError("Message action aborted");
        }
      };
    },
    beginInvocation: () => {
      const authorization = resolve();
      const admitScheduled = authorization?.scheduled && params.admitScheduledInvocation;
      if (authorization?.scheduled && !admitScheduled) {
        throw new Error("Scheduled message invocation requires current tool policy admission.");
      }
      return {
        authorization,
        config: admitScheduled ? admitScheduled() : params.getConfig(),
      };
    },
    scheduledAccountScope:
      policy?.mode === "account" && origin && origin.kind !== "unknown"
        ? {
            accountId: policy.ownerAccountId,
            ...(origin.kind === "external" ? { channel: origin.channel } : {}),
          }
        : undefined,
    assertCurrent: () => {
      if (token?.trim() && (!lookup || !resolveMessageActionTurnCapability(lookup))) {
        throw new Error("message action turn capability is no longer active");
      }
    },
  };
}
