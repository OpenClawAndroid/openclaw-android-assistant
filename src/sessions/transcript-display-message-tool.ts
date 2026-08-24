import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import {
  readMessageText,
  readMessageToolCalls,
  readMessageToolResult,
  type MessageToolCall,
} from "./transcript-display-classification.js";
import type {
  DisplayReducerRow,
  DisplayReducerState,
  PreparedSessionTranscriptDisplayCarry,
} from "./transcript-display-reducer-contract.js";

function messageToolCarry(state: DisplayReducerState): PreparedSessionTranscriptDisplayCarry[] {
  return state.carry.filter((entry) => entry.kind === "message_tool");
}

function replaceMessageToolCarry(
  state: DisplayReducerState,
  entries: PreparedSessionTranscriptDisplayCarry[],
): void {
  entries.forEach((entry, position) => {
    entry.kind = "message_tool";
    entry.position = position;
  });
  state.carry = [...state.carry.filter((entry) => entry.kind !== "message_tool"), ...entries];
}

function messageToolCallForCarry(
  state: DisplayReducerState,
  entry: PreparedSessionTranscriptDisplayCarry,
): MessageToolCall | undefined {
  const event = readRecord(state.readEvent(entry.sourceEventSeq));
  const message = readRecord(event?.message);
  return message ? readMessageToolCalls(message)[entry.sourceOccurrence] : undefined;
}

export function flushSessionTranscriptMessageToolMirrors(
  state: DisplayReducerState,
  anchor: DisplayReducerRow,
  selected?: readonly PreparedSessionTranscriptDisplayCarry[],
): void {
  const pending = messageToolCarry(state);
  const chosen = selected ?? pending.filter((entry) => entry.relatedEventSeq !== undefined);
  if (chosen.length > 0) {
    state.effects.addRelation(
      anchor,
      "message_tool_mirror",
      chosen.map((entry) => ({
        sourceEventSeq: entry.sourceEventSeq,
        sourceOccurrence: entry.sourceOccurrence,
      })),
    );
    state.effects.addRelation(
      anchor,
      "message_tool_result",
      chosen.flatMap((entry) =>
        entry.relatedEventSeq === undefined
          ? []
          : [{ sourceEventSeq: entry.relatedEventSeq, sourceOccurrence: 0 }],
      ),
    );
  }
  if (selected) {
    const flushed = new Set(selected);
    replaceMessageToolCarry(
      state,
      pending.filter((entry) => !flushed.has(entry)),
    );
  } else {
    replaceMessageToolCarry(state, []);
  }
}

export function handleSessionTranscriptMessageToolResult(
  state: DisplayReducerState,
  message: Record<string, unknown>,
  sourceEventSeq: number,
): void {
  const result = readMessageToolResult(message);
  if (!result?.successful) {
    return;
  }
  const pending = messageToolCarry(state);
  for (const entry of pending) {
    if (entry.relatedEventSeq !== undefined) {
      continue;
    }
    const call = messageToolCallForCarry(state, entry);
    if (
      !call ||
      (call.callId && result.callId !== call.callId) ||
      (call.requiresSourceRouteConfirmation && !result.sourceRouteConfirmed)
    ) {
      continue;
    }
    entry.relatedEventSeq = sourceEventSeq;
  }
  replaceMessageToolCarry(state, pending);
  const delivered = pending.filter(
    (entry) => entry.relatedEventSeq === sourceEventSeq && entry.deliveryEventSeq !== undefined,
  );
  const deliveryEventSeqs = new Set(
    delivered.flatMap((entry) =>
      entry.deliveryEventSeq === undefined ? [] : [entry.deliveryEventSeq],
    ),
  );
  for (const deliveryEventSeq of deliveryEventSeqs) {
    const anchor = state.effects.findRow(deliveryEventSeq);
    if (anchor) {
      flushSessionTranscriptMessageToolMirrors(
        state,
        anchor,
        delivered.filter((entry) => entry.deliveryEventSeq === deliveryEventSeq),
      );
    }
  }
}

export function handleSessionTranscriptDeliveryMirror(
  state: DisplayReducerState,
  message: Record<string, unknown>,
  row: DisplayReducerRow,
  sourceEventSeq: number,
): boolean {
  if (!isOpenClawDeliveryMirrorAssistantMessage(message)) {
    return false;
  }
  const text = readMessageText(message)?.trim();
  if (!text) {
    return false;
  }
  const deliveryMirrorCallId = readRecord(message.openclawDeliveryMirror)?.toolCallId;
  const candidates = messageToolCarry(state).filter((entry) => {
    const call = messageToolCallForCarry(state, entry);
    return (
      entry.deliveryEventSeq === undefined &&
      (typeof deliveryMirrorCallId === "string"
        ? call?.callId === deliveryMirrorCallId
        : call?.text.trim() === text)
    );
  });
  if (candidates.length !== 1) {
    return false;
  }
  const matching = candidates;
  const succeeded = matching.filter((entry) => entry.relatedEventSeq !== undefined);
  if (succeeded.length > 0) {
    flushSessionTranscriptMessageToolMirrors(state, row, succeeded);
  }
  const awaitingResult = matching.filter((entry) => entry.relatedEventSeq === undefined);
  for (const entry of awaitingResult) {
    entry.deliveryEventSeq = sourceEventSeq;
  }
  if (awaitingResult.length > 0) {
    replaceMessageToolCarry(state, messageToolCarry(state));
  }
  return true;
}
