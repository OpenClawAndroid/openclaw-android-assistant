import { createHash } from "node:crypto";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty as normalizeErrorSignal } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isContextOverflowError } from "../agents/failover/classify.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../agents/internal-runtime-context.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { extractCanvasFromDetails, extractCanvasFromText } from "../chat/canvas-render.js";
import { INTER_SESSION_PROMPT_PREFIX_BASE, normalizeInputProvenance } from "./input-provenance.js";
import { hasPersistedMedia } from "./user-turn-media.js";

export { readMessageToolResult } from "./message-tool-result.js";

export type PreparedSessionTranscriptDisplayCanvas = {
  boardWidgetName?: string;
  position: number;
  preferredHeight?: number;
  sandbox?: "scripts" | "strict";
  sourceEventSeq: number;
  title?: string;
  url: string;
  viewId?: string;
};

const ASSISTANT_ERROR_FALLBACK_TEXT = "The agent run failed before producing a reply.";
const ASSISTANT_CONTEXT_OVERFLOW_FALLBACK_TEXT =
  "Context overflow: this conversation is too large for the model. Try /compact, use /new to start a fresh session, or retry the command with a tighter output limit.";

function isContextOverflowErrorSignal(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (normalizeErrorSignal(value) === "context_overflow" || isContextOverflowError(value))
  );
}

export function isAssistantErrorMessage(message: Record<string, unknown>): boolean {
  return message.role === "assistant" && message.stopReason === "error";
}

export function getAssistantErrorFallbackText(message: Record<string, unknown>): string {
  return [message.errorCode, message.errorType, message.errorMessage].some(
    isContextOverflowErrorSignal,
  )
    ? ASSISTANT_CONTEXT_OVERFLOW_FALLBACK_TEXT
    : ASSISTANT_ERROR_FALLBACK_TEXT;
}

export function readMessageText(message: Record<string, unknown>): string | undefined {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return typeof message.text === "string" ? message.text : undefined;
  }
  const text = message.content.flatMap((block) => {
    const entry = readRecord(block);
    if (!entry) {
      return [];
    }
    return typeof entry.text === "string" &&
      (entry.type === "text" || entry.type === "input_text" || entry.type === "output_text")
      ? [entry.text]
      : [];
  });
  return text.length > 0 ? text.join("\n") : undefined;
}

function hasVisibleNonTextContent(message: Record<string, unknown>): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => {
      const entry = readRecord(block);
      if (!entry) {
        return true;
      }
      const type = entry.type;
      return (
        type !== "text" &&
        type !== "input_text" &&
        type !== "output_text" &&
        type !== "thinking" &&
        type !== "reasoning" &&
        type !== "redacted_thinking" &&
        type !== "toolCall" &&
        type !== "tool_call" &&
        type !== "toolUse" &&
        type !== "tool_use" &&
        type !== "toolResult" &&
        type !== "tool_result"
      );
    })
  );
}

function hasAnyNonTextContent(message: Record<string, unknown>): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => {
      const type = readRecord(block)?.type;
      return type !== "text" && type !== "input_text" && type !== "output_text";
    })
  );
}

export function normalizeHistoryType(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase().replaceAll("_", "") : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return readRecord(value);
  }
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function readToolName(record: Record<string, unknown>): string | undefined {
  for (const value of [record.name, record.toolName, record.tool_name, record.tool]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const fn = readRecord(record.function);
  return typeof fn?.name === "string" && fn.name.trim() ? fn.name.trim() : undefined;
}

function readToolCallId(record: Record<string, unknown>): string | undefined {
  for (const value of [
    record.id,
    record.toolCallId,
    record.tool_call_id,
    record.callId,
    record.call_id,
  ]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readToolArguments(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["arguments", "input", "args", "params"] as const) {
    const value = parseJsonRecord(record[key]);
    if (value) {
      return value;
    }
  }
  return parseJsonRecord(readRecord(record.function)?.arguments) ?? {};
}

function hasNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some(hasNonEmptyValue);
  }
  if (!value || typeof value !== "object") {
    return value != null;
  }
  return Object.values(readRecord(value) ?? {}).some(hasNonEmptyValue);
}

export type MessageToolCall = {
  callId?: string;
  requiresSourceRouteConfirmation: boolean;
  text: string;
};

export function readMessageToolCalls(message: Record<string, unknown>): MessageToolCall[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  const routeFields = [
    "target",
    "targets",
    "to",
    "recipient",
    "recipients",
    "chatId",
    "chat_id",
    "channelId",
    "channel_id",
    "conversationId",
    "conversation_id",
    "threadId",
    "thread_id",
    "roomId",
    "room_id",
    "groupId",
    "group_id",
  ];
  return message.content.flatMap((block) => {
    const record = readRecord(block);
    const type = normalizeHistoryType(record?.type);
    if (
      !record ||
      (type !== "toolcall" && type !== "tooluse") ||
      readToolName(record)?.toLowerCase() !== "message"
    ) {
      return [];
    }
    const args = readToolArguments(record);
    const deliveryStatus = [args.deliveryStatus, args.delivery_status, args.status].find(
      (value): value is string => typeof value === "string" && Boolean(value.trim()),
    );
    if (
      typeof args.action !== "string" ||
      args.action.trim().toLowerCase() !== "send" ||
      args.dryRun === true ||
      args.dry_run === true ||
      deliveryStatus?.trim().toLowerCase() === "dry_run"
    ) {
      return [];
    }
    const text = ["message", "text", "content", "body", "caption"]
      .map((field) => args[field])
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if (!text) {
      return [];
    }
    const callId = readToolCallId(record);
    return [
      {
        ...(callId ? { callId } : {}),
        requiresSourceRouteConfirmation: routeFields.some((field) => hasNonEmptyValue(args[field])),
        text,
      },
    ];
  });
}

export function isForwardedSessionsSend(message: Record<string, unknown>): boolean {
  const provenance = normalizeInputProvenance(message.provenance);
  return (
    message.role === "assistant" &&
    provenance?.kind === "inter_session" &&
    provenance.sourceTool === "sessions_send"
  );
}

export function isDisplayHiddenMessage(message: Record<string, unknown>): boolean {
  return (
    message.display === false ||
    (message.role === "custom" && message.customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE)
  );
}

function isEmptyTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  if (!Array.isArray(content) || content.length === 0) {
    return Array.isArray(content);
  }
  let sawText = false;
  for (const block of content) {
    const entry = readRecord(block);
    if (!entry || entry.type !== "text") {
      return false;
    }
    sawText = true;
    if (typeof entry.text !== "string" || entry.text.trim().length > 0) {
      return false;
    }
  }
  return sawText;
}

function isSubagentAnnounceInterSessionUserMessage(message: Record<string, unknown>): boolean {
  const provenance = normalizeInputProvenance(message.provenance);
  if (provenance?.kind === "inter_session" && provenance.sourceTool === "subagent_announce") {
    return true;
  }
  const text = readMessageText(message) ?? "";
  return (
    text.includes(INTER_SESSION_PROMPT_PREFIX_BASE) && text.includes("sourceTool=subagent_announce")
  );
}

export function isHiddenUserMessage(message: Record<string, unknown>): boolean {
  return (
    message.role === "user" &&
    (isSubagentAnnounceInterSessionUserMessage(message) ||
      (isEmptyTextOnlyContent(message.content ?? message.text) && !hasPersistedMedia(message)))
  );
}

export function isSuppressedControlReply(message: Record<string, unknown>): boolean {
  const text = readMessageText(message);
  return Boolean(
    message.role === "assistant" &&
    text &&
    [SILENT_REPLY_TOKEN, "ANNOUNCE_SKIP", "REPLY_SKIP"].some((token) =>
      isSilentReplyText(text, token),
    ) &&
    !hasVisibleNonTextContent(message),
  );
}

export function isPureStreamError(message: Record<string, unknown>): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason === "error" &&
    readMessageText(message)?.trim() === STREAM_ERROR_FALLBACK_TEXT &&
    !hasAnyNonTextContent(message)
  );
}

export function isRenderableAssistant(message: Record<string, unknown>): boolean {
  if (
    message.role !== "assistant" ||
    isDisplayHiddenMessage(message) ||
    isPureStreamError(message) ||
    isSuppressedControlReply(message)
  ) {
    return false;
  }
  const text = readMessageText(message)?.trim();
  return Boolean(text || hasVisibleNonTextContent(message));
}

export function readTtsMarker(
  message: Record<string, unknown>,
): { spokenText?: string; textSha256?: string } | undefined {
  const marker = readRecord(message.openclawTtsSupplement);
  if (!marker) {
    return undefined;
  }
  const spokenText =
    typeof marker.spokenText === "string" && marker.spokenText.trim()
      ? marker.spokenText.trim()
      : undefined;
  const textSha256 =
    typeof marker.textSha256 === "string" && /^[a-f0-9]{64}$/u.test(marker.textSha256.trim())
      ? marker.textSha256.trim()
      : undefined;
  return spokenText || textSha256
    ? { ...(spokenText ? { spokenText } : {}), ...(textSha256 ? { textSha256 } : {}) }
    : undefined;
}

export function isTtsSupplement(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant" || !readTtsMarker(message) || !Array.isArray(message.content)) {
    return false;
  }
  let nonText = false;
  for (const block of message.content) {
    const entry = readRecord(block);
    if (!entry) {
      continue;
    }
    if (entry.type !== "text") {
      nonText = true;
      continue;
    }
    if (
      typeof entry.text === "string" &&
      entry.text.trim() &&
      entry.text.trim() !== "Audio reply"
    ) {
      return false;
    }
  }
  return nonText;
}

export function ttsMarkerMatches(
  marker: { spokenText?: string; textSha256?: string },
  candidate: Record<string, unknown>,
): boolean {
  if (
    candidate.role !== "assistant" ||
    isForwardedSessionsSend(candidate) ||
    readTtsMarker(candidate)
  ) {
    return false;
  }
  const text = readMessageText(candidate)?.trim();
  if (!text) {
    return false;
  }
  return (
    marker.spokenText === text ||
    (marker.textSha256 !== undefined &&
      createHash("sha256").update(text).digest("hex") === marker.textSha256)
  );
}

function canonicalCanvasUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("/__openclaw__/canvas/documents/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return undefined;
  }
  const segments = value.slice("/__openclaw__/canvas/documents/".length).split("/");
  if (segments.length < 2 || segments.length > 17 || segments.some((segment) => !segment)) {
    return undefined;
  }
  const decoded: string[] = [];
  for (const segment of segments) {
    try {
      const part = decodeURIComponent(segment);
      if (
        encodeURIComponent(part) !== segment ||
        part.length > 128 ||
        part === "." ||
        part === ".." ||
        part.includes(":") ||
        part.includes("/") ||
        part.includes("\\") ||
        Array.from(part).some((char) => {
          const code = char.charCodeAt(0);
          return code < 0x20 || (code >= 0x7f && code <= 0x9f);
        })
      ) {
        return undefined;
      }
      decoded.push(part);
    } catch {
      return undefined;
    }
  }
  const documentId = decoded[0];
  return documentId &&
    documentId !== "." &&
    documentId !== ".." &&
    /^[A-Za-z0-9._-]{1,128}$/u.test(documentId)
    ? value
    : undefined;
}

function sanitizeCanvasPreview(
  value: unknown,
  sourceEventSeq: number,
): Omit<PreparedSessionTranscriptDisplayCanvas, "position"> | undefined {
  const preview = readRecord(value);
  const url = canonicalCanvasUrl(preview?.url);
  if (
    !preview ||
    preview.kind !== "canvas" ||
    preview.surface !== "assistant_message" ||
    preview.render !== "url" ||
    !url
  ) {
    return undefined;
  }
  const viewId =
    typeof preview.viewId === "string" &&
    preview.viewId.trim() &&
    preview.viewId.trim().length <= 128
      ? preview.viewId.trim()
      : undefined;
  const rawTitle = typeof preview.title === "string" ? preview.title.trim() : "";
  const title = rawTitle ? truncateUtf16Safe(rawTitle, 256) : undefined;
  const rawHeight =
    typeof preview.preferredHeight === "number" && Number.isFinite(preview.preferredHeight)
      ? Math.trunc(preview.preferredHeight)
      : undefined;
  const preferredHeight =
    rawHeight !== undefined && rawHeight >= 160 ? Math.min(rawHeight, 1200) : undefined;
  const sandbox =
    preview.sandbox === "strict" || preview.sandbox === "scripts" ? preview.sandbox : undefined;
  const boardWidgetName =
    typeof preview.boardWidgetName === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(preview.boardWidgetName)
      ? preview.boardWidgetName
      : undefined;
  return {
    ...(boardWidgetName ? { boardWidgetName } : {}),
    ...(preferredHeight ? { preferredHeight } : {}),
    ...(sandbox ? { sandbox } : {}),
    sourceEventSeq,
    ...(title ? { title } : {}),
    url,
    ...(viewId ? { viewId } : {}),
  };
}

export function readCanvasPreviews(
  message: Record<string, unknown>,
  sourceEventSeq: number,
): Array<Omit<PreparedSessionTranscriptDisplayCanvas, "position">> {
  const candidates: unknown[] = [];
  const direct = extractCanvasFromDetails(message.details);
  if (direct) {
    candidates.push(direct);
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const entry = readRecord(block);
      const details = extractCanvasFromDetails(entry?.details);
      if (details) {
        candidates.push(details);
      }
      if (entry?.type === "canvas" && entry.preview) {
        candidates.push(entry.preview);
      }
    }
  }
  const fromText = extractCanvasFromText(readMessageText(message), readToolName(message));
  if (fromText) {
    candidates.push(fromText);
  }
  const seen = new Set<string>();
  return candidates
    .flatMap((candidate) => {
      const canvas = sanitizeCanvasPreview(candidate, sourceEventSeq);
      if (!canvas) {
        return [];
      }
      const identity = canvas.viewId ?? canvas.url;
      if (seen.has(identity)) {
        return [];
      }
      seen.add(identity);
      return [canvas];
    })
    .slice(0, 16);
}
