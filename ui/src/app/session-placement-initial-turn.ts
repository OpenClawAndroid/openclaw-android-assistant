import type { ChatAttachment, ChatQueueItem } from "../lib/chat/chat-types.ts";
import type { SessionPlacementRecovery } from "../lib/sessions/session-placement-recovery.ts";

export function buildPlacementStartupInitialTurn(params: {
  recovery: SessionPlacementRecovery;
  attachments: ChatAttachment[];
  createdAt: number;
  checking?: boolean;
  error?: string;
}): ChatQueueItem {
  const { recovery, attachments, createdAt, checking, error } = params;
  return {
    id: recovery.messageId,
    text: recovery.message,
    ...(recovery.mentions?.length ? { mentions: recovery.mentions } : {}),
    attachments,
    createdAt,
    sessionKey: recovery.sessionKey,
    agentId: recovery.agentId,
    sendRunId: recovery.messageId,
    sendAttempts: 1,
    sendState: error
      ? "failed"
      : checking
        ? "unconfirmed"
        : recovery.phase === "paused"
          ? recovery.reason === "unconfirmed"
            ? "unconfirmed"
            : "failed"
          : "sending",
    ...(error || recovery.phase === "paused"
      ? { sendError: error ?? (recovery.phase === "paused" ? recovery.error : undefined) }
      : {}),
  };
}
