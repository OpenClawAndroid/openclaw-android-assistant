import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type MessageToolResult = {
  callId?: string;
  sourceRouteConfirmed: boolean;
  successful: boolean;
};

function readMaybeJsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "string" ? safeParseJsonRecord(value) : readRecord(value);
}

function readMessageToolResultName(message: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(message.toolName) ??
    normalizeOptionalString(message.tool_name) ??
    normalizeOptionalString(message.name) ??
    normalizeOptionalString(message.tool)
  );
}

function readMessageToolResultCallId(message: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(message.toolCallId) ??
    normalizeOptionalString(message.tool_call_id) ??
    normalizeOptionalString(message.callId) ??
    normalizeOptionalString(message.call_id) ??
    normalizeOptionalString(message.id)
  );
}

function readToolResultOkValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const record = readMaybeJsonRecord(value);
  if (record && typeof record.ok === "boolean") {
    return record.ok;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const block of value) {
    const blockOk = readToolResultOkValue(block);
    if (blockOk !== undefined) {
      return blockOk;
    }
    const recordBlock = readRecord(block);
    for (const nested of [recordBlock?.text, recordBlock?.content]) {
      const nestedOk = readToolResultOkValue(nested);
      if (nestedOk !== undefined) {
        return nestedOk;
      }
    }
  }
  return undefined;
}

function isDryRunMessageToolRecord(record: Record<string, unknown>): boolean {
  if (record.dryRun === true || record.dry_run === true) {
    return true;
  }
  const status =
    normalizeOptionalString(record.deliveryStatus) ??
    normalizeOptionalString(record.delivery_status) ??
    normalizeOptionalString(record.status);
  return status?.toLowerCase() === "dry_run";
}

function hasDryRunToolResultValue(value: unknown): boolean {
  const record = readMaybeJsonRecord(value);
  if (record && isDryRunMessageToolRecord(record)) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((block) => {
    if (hasDryRunToolResultValue(block)) {
      return true;
    }
    const recordBlock = readRecord(block);
    return [recordBlock?.text, recordBlock?.content].some(hasDryRunToolResultValue);
  });
}

function hasSuppressedToolResultValue(value: unknown): boolean {
  const record = readMaybeJsonRecord(value);
  if (record) {
    const messageId = normalizeOptionalString(record.messageId)?.toLowerCase();
    const status = (
      normalizeOptionalString(record.deliveryStatus) ??
      normalizeOptionalString(record.delivery_status) ??
      normalizeOptionalString(record.status)
    )?.toLowerCase();
    if (
      record.delivered === false ||
      messageId === "skipped" ||
      messageId === "suppressed" ||
      status === "skipped" ||
      status === "suppressed"
    ) {
      return true;
    }
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((block) => {
    if (hasSuppressedToolResultValue(block)) {
      return true;
    }
    const recordBlock = readRecord(block);
    return [recordBlock?.text, recordBlock?.content].some(hasSuppressedToolResultValue);
  });
}

export function readMessageToolResult(message: Record<string, unknown>): MessageToolResult | null {
  const role =
    typeof message.role === "string" ? message.role.trim().toLowerCase().replaceAll("_", "") : "";
  const toolName = readMessageToolResultName(message)?.toLowerCase();
  if (role !== "toolresult" && role !== "tool" && role !== "function" && toolName !== "message") {
    return null;
  }
  if (toolName && toolName !== "message") {
    return null;
  }
  const resultValues = [message.result, message.output, message.content, message.text];
  const failed =
    message.isError === true ||
    (message.error != null && message.error !== false) ||
    resultValues.some(hasDryRunToolResultValue) ||
    [message.details, ...resultValues].some(hasSuppressedToolResultValue) ||
    resultValues.map(readToolResultOkValue).find((value) => value !== undefined) === false;
  const callId = readMessageToolResultCallId(message);
  return {
    ...(callId ? { callId } : {}),
    sourceRouteConfirmed: readRecord(message.details)?.sourceReplyRoute === "current-source",
    successful: !failed,
  };
}
