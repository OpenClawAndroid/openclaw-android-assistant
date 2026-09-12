import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import type { MessageActionGateway } from "../../infra/outbound/message-action-contracts.js";
import type {
  OutboundGatewayRequest,
  OutboundGatewayRequestContext,
} from "../../infra/outbound/message-gateway-options.js";
import {
  resolveGatewayOptions,
  resolveMessageActionAgentRuntimeIdentity,
  resolveMessageActionAgentRuntimeIdentityToken,
  shouldUseInProcessGatewayTool,
  type GatewayCallOptions,
} from "./gateway.js";
import {
  bindAgentToolGatewayRequest,
  withAgentToolGatewayRuntimeIdentity,
} from "./in-process-gateway.js";

/** Capture message routing before preparation can await or the Gateway can retire. */
export function createMessageToolGateway(
  gatewayOpts: GatewayCallOptions,
  options?: {
    conversationReadOrigin?: ConversationReadInvocationOrigin;
    messageActionTurnCapability?: string;
    agentSessionKey?: string;
    runId?: string;
    sessionId?: string;
  },
  signal?: AbortSignal,
): MessageActionGateway | undefined {
  if (options?.conversationReadOrigin === "direct-operator") {
    return undefined;
  }
  const boundRequest = shouldUseInProcessGatewayTool(gatewayOpts)
    ? bindAgentToolGatewayRequest()
    : undefined;
  const { target, ...connection } = resolveGatewayOptions(gatewayOpts);
  const callerOwnsTerminalReceipt =
    !boundRequest &&
    (target === "remote" ||
      Boolean(gatewayOpts.gatewayUrl?.trim() || gatewayOpts.gatewayToken?.trim()));
  const identityParams = {
    opts: gatewayOpts,
    target: boundRequest ? ("local" as const) : target,
    turnCapability: options?.messageActionTurnCapability,
    turnCapabilitySessionKey: options?.agentSessionKey,
    runId: options?.runId,
    sessionId: options?.sessionId,
    callerOwnsTerminalReceipt,
  };
  return {
    ...connection,
    clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
    clientDisplayName: "agent",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    ...(callerOwnsTerminalReceipt ? { terminalSourceReplyReceiptOwner: "caller" } : {}),
    ...(boundRequest
      ? {
          request: async <T>(
            request: OutboundGatewayRequest,
            context?: OutboundGatewayRequestContext,
          ) => {
            const identity = await resolveMessageActionAgentRuntimeIdentity({
              ...identityParams,
              ...context,
            });
            return boundRequest<T>(
              withAgentToolGatewayRuntimeIdentity(
                { ...request, signal: request.signal ?? signal },
                identity,
              ),
            );
          },
        }
      : {
          resolveAgentRuntimeIdentityToken: (context?: OutboundGatewayRequestContext) =>
            resolveMessageActionAgentRuntimeIdentityToken({ ...identityParams, ...context }),
        }),
  };
}
