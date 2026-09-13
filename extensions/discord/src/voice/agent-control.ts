import {
  controlRealtimeVoiceAgentRun,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlResult,
} from "openclaw/plugin-sdk/realtime-voice";
import { getDiscordRuntime } from "../runtime.js";
import type { DiscordVoiceIngressContext } from "./ingress.js";
import type { VoiceSessionEntry } from "./session.js";

type DiscordVoiceAgentControlOutcome =
  | { handled: true; result: RealtimeVoiceAgentControlResult; speakText?: string }
  | { handled: false; result?: RealtimeVoiceAgentControlResult };

type DiscordVoiceAgentControlParams = {
  entry: VoiceSessionEntry;
  accountId: string;
  text: string;
  mode?: unknown;
  toolsAllow?: string[];
  context: DiscordVoiceIngressContext;
  resolveContext?: () => Promise<DiscordVoiceIngressContext | null>;
  isCurrent: () => boolean;
};

export async function controlDiscordVoiceAgentRun(params: DiscordVoiceAgentControlParams) {
  const context = params.resolveContext ? await params.resolveContext() : params.context;
  const assertCurrent = () => {
    if (
      !context ||
      context.senderIsOwner !== params.context.senderIsOwner ||
      context.isCurrent?.() === false ||
      params.entry.sessionLifecycle.status !== "active" ||
      !params.isCurrent()
    ) {
      throw new DOMException(
        "Discord voice speaker authorization changed before run control",
        "AbortError",
      );
    }
  };
  assertCurrent();
  return controlRealtimeVoiceAgentRun({
    sessionKey: params.entry.route.sessionKey,
    text: params.text,
    ...(params.mode !== undefined ? { mode: params.mode } : {}),
    getToolAuthorityOverlay: () => {
      assertCurrent();
      const session = getDiscordRuntime().agent.session.getSessionEntry({
        agentId: params.entry.route.agentId,
        sessionKey: params.entry.route.sessionKey,
        readConsistency: "latest",
      });
      assertCurrent();
      return {
        originatingChannel: "discord",
        messageProvider: "discord-voice",
        agentAccountId: params.accountId,
        senderIsOwner: params.context.senderIsOwner,
        disableTools: false,
        traceAuthorized: false,
        toolsAllow: params.toolsAllow,
        permissionMode: session?.permissionMode,
        toolOverrides: session?.toolOverrides,
        chatType: session?.chatType,
        spawnedBy: session?.spawnedBy,
      };
    },
  });
}

export async function maybeControlDiscordVoiceAgentRun(
  params: DiscordVoiceAgentControlParams,
): Promise<DiscordVoiceAgentControlOutcome> {
  if (!shouldAutoControlRealtimeVoiceAgentText(params.text)) {
    return { handled: false };
  }
  const result = await controlDiscordVoiceAgentRun(params);
  if (!result.active) {
    return { handled: false, result };
  }
  return {
    handled: true,
    result,
    ...(result.speak && !result.suppress ? { speakText: result.message } : {}),
  };
}
