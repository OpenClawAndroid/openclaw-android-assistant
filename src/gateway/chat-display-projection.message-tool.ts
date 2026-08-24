import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSessionsSendInterSessionUserMessage } from "../sessions/input-provenance.js";
import { readMessageToolResult } from "../sessions/message-tool-result.js";
import { readMessageToolCalls } from "../sessions/transcript-display-classification.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import {
  extractAssistantTextForSilentCheck,
  hasAssistantDisplayableNonTextContent,
  isProjectedSessionsSendForwardedMessage,
} from "./chat-display-projection.helpers.js";
import { displayTextForDuplicateCheck } from "./chat-display-projection.history.js";
import { isSuppressedControlReplyText } from "./control-reply-text.js";

type PendingMessageToolVisibleReply = {
  toolCallId?: string;
  text: string;
  requiresSourceRouteConfirmation: boolean;
  anchor: Record<string, unknown>;
  completionAnchor?: Record<string, unknown>;
  deliveryMirrorAnchor?: Record<string, unknown>;
  deliveryMirrorIndex?: number;
  sourceReplySink?: "internal-ui";
  succeeded: boolean;
};

function extractMessageToolVisibleReplies(
  message: Record<string, unknown>,
): Array<Omit<PendingMessageToolVisibleReply, "anchor" | "succeeded">> {
  return readMessageToolCalls(message).map((call) => {
    const reply: Omit<PendingMessageToolVisibleReply, "anchor" | "succeeded"> = {
      requiresSourceRouteConfirmation: call.requiresSourceRouteConfirmation,
      text: call.text,
    };
    if (call.callId) {
      reply.toolCallId = call.callId;
    }
    return reply;
  });
}

function isAssistantSilentControlReplyOnly(message: Record<string, unknown>): boolean {
  const text = extractAssistantTextForSilentCheck(message);
  return (
    text !== undefined &&
    isSuppressedControlReplyText(text) &&
    !hasAssistantDisplayableNonTextContent(message)
  );
}

function isRenderableAssistantDisplayMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const text = extractAssistantTextForSilentCheck(message);
  return text !== undefined && !isSuppressedControlReplyText(text);
}

function isSuccessfulMessageToolResult(
  message: Record<string, unknown>,
  pending: PendingMessageToolVisibleReply,
): boolean {
  const result = readMessageToolResult(message);
  if (!result?.successful) {
    return false;
  }
  if (pending.toolCallId) {
    return (
      result.callId === pending.toolCallId &&
      (!pending.requiresSourceRouteConfirmation || result.sourceRouteConfirmed)
    );
  }
  return !pending.requiresSourceRouteConfirmation || result.sourceRouteConfirmed;
}

function readMessageToolSourceReplySink(
  message: Record<string, unknown>,
): "internal-ui" | undefined {
  const details = readRecord(message.details);
  return details?.sourceReplySink === "internal-ui" ? "internal-ui" : undefined;
}

function buildMessageToolVisibleReplyMirror(
  pending: PendingMessageToolVisibleReply,
): Record<string, unknown> {
  const sourceMessageSeq = asPositiveSafeInteger(readRecord(pending.anchor["__openclaw"])?.seq);
  const deliveryMirror = [pending.deliveryMirrorAnchor, pending.completionAnchor].find((message) =>
    isOpenClawDeliveryMirrorAssistantMessage(message),
  );
  const content = Array.isArray(deliveryMirror?.content)
    ? deliveryMirror.content
    : [{ type: "text", text: pending.text }];
  const mirror: Record<string, unknown> = {
    role: "assistant",
    content,
    openclawMessageToolMirror: {
      toolName: "message",
      ...(pending.toolCallId ? { toolCallId: pending.toolCallId } : {}),
      ...(pending.sourceReplySink ? { sourceReplySink: pending.sourceReplySink } : {}),
      ...(pending.sourceReplySink && sourceMessageSeq ? { sourceMessageSeq } : {}),
    },
  };
  for (const field of ["timestamp", "createdAt", "agentId"] as const) {
    if (pending.anchor[field] !== undefined) {
      mirror[field] = pending.anchor[field];
    }
  }
  const transcriptMeta = readRecord((pending.completionAnchor ?? pending.anchor)["__openclaw"]);
  if (transcriptMeta) {
    mirror["__openclaw"] = { ...transcriptMeta };
  }
  return mirror;
}

function readMessageToolDeliveryMirrorText(message: Record<string, unknown>): string | undefined {
  // Delivery mirrors can arrive between a successful message-tool result and
  // the final NO_REPLY. The pending mirror is the display row; the raw mirror
  // would duplicate that same send.
  if (!isOpenClawDeliveryMirrorAssistantMessage(message)) {
    return undefined;
  }
  return displayTextForDuplicateCheck(message);
}

function readMessageToolDeliveryMirrorCallId(message: Record<string, unknown>): string | undefined {
  if (!isOpenClawDeliveryMirrorAssistantMessage(message)) {
    return undefined;
  }
  return normalizeOptionalString(readRecord(message.openclawDeliveryMirror)?.toolCallId);
}

export function mirrorMessageToolVisibleReplies(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  if (!messages.some((message) => readRecord(message))) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  const pending: PendingMessageToolVisibleReply[] = [];

  const clearPending = () => {
    if (pending.length > 0) {
      pending.length = 0;
    }
  };

  const flushSucceededMirrors = () => {
    for (const item of pending) {
      if (!item.succeeded) {
        continue;
      }
      next.push(buildMessageToolVisibleReplyMirror(item));
      changed = true;
    }
    clearPending();
  };

  const flushSelectedMirrors = (items: PendingMessageToolVisibleReply[]) => {
    if (items.length === 0) {
      return;
    }
    const selected = new Set(items);
    const remaining: PendingMessageToolVisibleReply[] = [];
    for (const item of pending) {
      if (selected.has(item) && item.succeeded) {
        next.push(buildMessageToolVisibleReplyMirror(item));
        changed = true;
        continue;
      }
      remaining.push(item);
    }
    pending.length = 0;
    pending.push(...remaining);
  };

  for (const message of messages) {
    const record = readRecord(message);
    if (!record) {
      next.push(message);
      continue;
    }

    if (
      (record.role === "user" && isSessionsSendInterSessionUserMessage(record)) ||
      isProjectedSessionsSendForwardedMessage(record)
    ) {
      next.push(message);
      continue;
    }

    if (record.role === "user") {
      clearPending();
      next.push(message);
      continue;
    }

    const flushAfterCurrentMessage: PendingMessageToolVisibleReply[] = [];
    const deliveryMirrorText = readMessageToolDeliveryMirrorText(record);
    const deliveryMirrorCallId = readMessageToolDeliveryMirrorCallId(record);
    const exactDeliveryMirrorPending = deliveryMirrorCallId
      ? pending.filter((item) => item.toolCallId === deliveryMirrorCallId)
      : [];
    const textMatchingDeliveryMirrorPending = deliveryMirrorText
      ? pending.filter((item) => item.text.trim() === deliveryMirrorText)
      : [];
    const matchingDeliveryMirrorPending = deliveryMirrorCallId
      ? exactDeliveryMirrorPending.length === 1
        ? exactDeliveryMirrorPending
        : []
      : textMatchingDeliveryMirrorPending.length === 1
        ? textMatchingDeliveryMirrorPending
        : [];
    const duplicateDeliveryMirror = matchingDeliveryMirrorPending.some((item) => item.succeeded);
    const visibleReplies = extractMessageToolVisibleReplies(record);
    if (visibleReplies.length > 0) {
      for (const reply of visibleReplies) {
        pending.push({
          ...reply,
          anchor: record,
          succeeded: false,
        });
      }
    } else if (deliveryMirrorText === undefined && isRenderableAssistantDisplayMessage(record)) {
      clearPending();
    }

    if (pending.length > 0) {
      for (const item of pending) {
        if (!item.succeeded && isSuccessfulMessageToolResult(record, item)) {
          item.succeeded = true;
          const sourceReplySink = readMessageToolSourceReplySink(record);
          if (sourceReplySink) {
            item.sourceReplySink = sourceReplySink;
          }
          item.completionAnchor = item.deliveryMirrorAnchor ?? record;
          if (item.deliveryMirrorAnchor) {
            if (typeof item.deliveryMirrorIndex === "number") {
              next[item.deliveryMirrorIndex] = { ...item.deliveryMirrorAnchor, display: false };
            }
            flushAfterCurrentMessage.push(item);
          }
        }
      }
      if (isAssistantSilentControlReplyOnly(record)) {
        flushSucceededMirrors();
      }
    }

    if (duplicateDeliveryMirror) {
      for (const item of matchingDeliveryMirrorPending) {
        item.completionAnchor = record;
      }
      flushSelectedMirrors(matchingDeliveryMirrorPending);
      changed = true;
      continue;
    }

    for (const item of matchingDeliveryMirrorPending) {
      item.deliveryMirrorAnchor = record;
      item.deliveryMirrorIndex = next.length;
    }
    next.push(message);
    flushSelectedMirrors(flushAfterCurrentMessage);
  }

  return changed ? next : messages;
}
