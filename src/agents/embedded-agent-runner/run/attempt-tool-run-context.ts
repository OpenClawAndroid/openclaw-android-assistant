import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { GroupToolPolicyConfig } from "../../../config/types.tools.js";
import { prepareGitHubPublicationAvailability } from "../../../gateway/github-publication-availability.js";
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { agentHarnessExposesOpenClawTools } from "../../harness/tool-surface.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { mergeForcedEmbeddedAttemptToolsAllow } from "./attempt-tool-construction-plan.js";
import type { EmbeddedRunTrigger, RunEmbeddedAgentParams } from "./params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptToolRunFacts = Pick<
  RunEmbeddedAgentParams,
  | "clientCaps"
  | "gatewayUiCommandTarget"
  | "pinnedWidgetAuthoring"
  | "toolBindings"
  | "chatType"
  | "agentAccountId"
  | "messageTo"
  | "messageThreadId"
  | "chatId"
  | "messageActionTurnCapability"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "memberRoleIds"
  | "spawnedBy"
  | "senderId"
  | "senderName"
  | "senderUsername"
  | "senderE164"
  | "senderIsOwner"
  | "scheduledToolPolicy"
  | "approvalReviewerDeviceId"
  | "currentChannelId"
  | "currentMessagingTarget"
  | "currentThreadTs"
  | "currentMessageId"
  | "replyToMode"
  | "hasRepliedRef"
  | "sourceReplyDeliveryMode"
  | "taskSuggestionDeliveryMode"
>;

/**
 * Builds the shared tool-run context for embedded and plugin harness attempts.
 */
export function buildEmbeddedAttemptToolRunContext(
  params: AttemptToolRunFacts & {
    model?: Pick<EmbeddedRunAttemptParams["model"], "provider" | "id">;
    thinkLevel?: ThinkLevel;
    trigger?: EmbeddedRunTrigger;
    jobId?: string;
    memoryFlushWritePath?: string;
    toolsAllow?: string[];
    forceMessageTool?: boolean;
    swarmCollector?: boolean;
    swarmOutputSchema?: Record<string, unknown>;
    conversationToolPolicy?: GroupToolPolicyConfig;
    trace?: DiagnosticTraceContext;
    currentInboundAudio?: boolean;
    replyOperation?: { readonly acceptedSteeredInboundAudio: boolean };
  },
) {
  const { currentInboundAudio, replyOperation } = params;
  // Collector output is mandatory result transport, even on a narrowed tool surface.
  const runtimeToolAllowlist = mergeForcedEmbeddedAttemptToolsAllow(params.toolsAllow, {
    forceMessageTool: params.forceMessageTool,
    forceToolNames:
      params.swarmCollector && params.swarmOutputSchema ? ["structured_output"] : undefined,
  });
  return {
    clientCaps: params.clientCaps,
    gatewayUiCommandTarget: params.gatewayUiCommandTarget,
    pinnedWidgetAuthoring: params.pinnedWidgetAuthoring,
    toolBindings: params.toolBindings,
    chatType: params.chatType,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    nativeChannelId: params.chatId,
    messageActionTurnCapability: params.messageActionTurnCapability,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    memberRoleIds: params.memberRoleIds,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    scheduledToolPolicy: params.scheduledToolPolicy,
    approvalReviewerDeviceId: params.approvalReviewerDeviceId,
    currentChannelId: params.currentChannelId,
    currentMessagingTarget: params.currentMessagingTarget,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    requesterThinkingLevel: params.thinkLevel,
    // modelId may still be a configured alias; children need the prepared identity.
    requesterModel: params.model
      ? { provider: params.model.provider, model: params.model.id }
      : undefined,
    trigger: params.trigger,
    jobId: params.jobId,
    memoryFlushWritePath: params.memoryFlushWritePath,
    swarmCollector: params.swarmCollector,
    swarmOutputSchema: params.swarmOutputSchema,
    currentInboundAudio,
    // Read accepted steering from the captured owner when the tool executes.
    hasCurrentInboundAudio: () =>
      currentInboundAudio === true || replyOperation?.acceptedSteeredInboundAudio === true,
    ...(runtimeToolAllowlist ? { runtimeToolAllowlist } : {}),
    ...(params.conversationToolPolicy
      ? { conversationToolPolicy: params.conversationToolPolicy }
      : {}),
    // Freeze trace metadata at the attempt boundary so later mutable diagnostic updates do not
    // rewrite the facts attached to tool calls already in flight.
    ...(params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}),
  };
}

/** Prepare Gateway tools once at the shared dispatch boundary, including internal continuations. */
export async function withPreparedEmbeddedGatewayTools<T>(
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "admittedRunContext"
    | "cronCreatorAuthorityCapability"
    | "messageChannel"
    | "messageProvider"
    | "currentMessagingTarget"
    | "currentChannelId"
    | "agentAccountId"
    | "currentThreadTs"
    | "sessionId"
    | "disableTools"
    | "sessionPersistence"
    | "githubPublicationAvailable"
  > & { agentId: string; sessionKey: string; agentHarnessId: string },
  isAttemptCurrent: () => boolean,
  run: () => Promise<T>,
): Promise<T> {
  const callerIdentity = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: attempt.admittedRunContext,
    cronAuthorityCheck: attempt.cronCreatorAuthorityCapability?.isCurrent,
    agentId: attempt.agentId,
    sessionKey: attempt.sessionKey,
    turnSourceChannel: attempt.messageChannel ?? attempt.messageProvider,
    turnSourceLocal:
      !attempt.messageChannel &&
      !attempt.messageProvider &&
      attempt.cronCreatorAuthorityCapability?.callerOrigin.kind === "local"
        ? true
        : undefined,
    turnSourceTo: attempt.currentMessagingTarget ?? attempt.currentChannelId,
    turnSourceAccountId: attempt.agentAccountId,
    turnSourceThreadId: attempt.currentThreadTs,
  });
  return withGatewayToolCallerIdentity(callerIdentity, async () => {
    const resolveGatewayContext = getGatewayContextResolver(attempt.admittedRunContext);
    const gateway = resolveGatewayContext?.();
    if (
      !attempt.disableTools &&
      attempt.sessionPersistence !== "detached" &&
      agentHarnessExposesOpenClawTools(attempt.agentHarnessId) &&
      gateway &&
      !gateway.localEmbedded
    ) {
      // Yield, compaction, and retries recheck the current session and exact live host;
      // an earlier attempt's availability must not determine its successor's tool catalog.
      const isCurrent = () => isAttemptCurrent() && resolveGatewayContext?.() === gateway;
      attempt.githubPublicationAvailable = await prepareGitHubPublicationAvailability({
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        agentId: attempt.agentId,
        assertCurrent: isCurrent,
      });
      if (!isCurrent()) {
        throw new Error("GitHub tool preparation outlived its admitted Gateway run");
      }
    }
    return run();
  });
}
