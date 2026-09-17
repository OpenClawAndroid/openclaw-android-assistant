import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  extractAssistantTextForPhase,
  parseAssistantTextSignature,
} from "../../../shared/chat-message-content.js";
import {
  sanitizeAssistantFinalAnswerText,
  sanitizeAssistantVisibleText,
} from "../../../shared/text/assistant-visible-text.js";

function isAssistantTextContentBlockType(value: unknown): boolean {
  return value === "text" || value === "input_text" || value === "output_text";
}
/** Selects the canonical answer before reply directives remove authored silence or media. */
export function resolveRawAssistantAnswerText(lastAssistant: AssistantMessage | undefined): string {
  if (!lastAssistant) {
    return "";
  }
  const finalAnswerText = extractAssistantTextForPhase(lastAssistant, {
    phase: "final_answer",
    sanitizeText: sanitizeAssistantFinalAnswerText,
  });
  if (finalAnswerText) {
    return normalizeOptionalString(finalAnswerText) ?? "";
  }
  if (Array.isArray(lastAssistant.content)) {
    const hasExplicitPhasedTextBlock = lastAssistant.content.some((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      // SAFETY: The object guard permits optional unknown fields; the selector and parser validate them.
      const record = block as { type?: unknown; textSignature?: unknown };
      return (
        isAssistantTextContentBlockType(record.type) &&
        Boolean(parseAssistantTextSignature(record)?.phase)
      );
    });
    if (!hasExplicitPhasedTextBlock) {
      const signedUnphasedParts = lastAssistant.content
        .map((block) => {
          if (!block || typeof block !== "object") {
            return null;
          }
          // SAFETY: The object guard permits optional unknown fields, validated before use below.
          const record = block as { type?: unknown; text?: unknown; textSignature?: unknown };
          const signature = parseAssistantTextSignature(record);
          if (
            !isAssistantTextContentBlockType(record.type) ||
            typeof record.text !== "string" ||
            !signature?.id ||
            signature.phase
          ) {
            return null;
          }
          const text = sanitizeAssistantFinalAnswerText(record.text);
          return text.trim() ? text : null;
        })
        .filter((value): value is string => typeof value === "string");
      if (signedUnphasedParts.length) {
        return normalizeOptionalString(signedUnphasedParts.join("\n")) ?? "";
      }
    }
  }
  return (
    normalizeOptionalString(
      extractAssistantTextForPhase(lastAssistant, {
        sanitizeText: sanitizeAssistantVisibleText,
      }),
    ) ?? ""
  );
}
