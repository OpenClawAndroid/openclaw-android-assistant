import type { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

export type AcpDispatchDeliveryMeta = {
  toolCallId?: string;
  allowEdit?: boolean;
  skipTts?: boolean;
  /** Transport-only finals retain their runtime source instead of adding final text. */
  transcriptSource?: { kind: "blocks" | "fallback" } | { kind: "final"; text: string };
};

type ToolMessageHandle = {
  channel: string;
  accountId?: string;
  to: string;
  threadId?: string | number;
  messageId: string;
};

export type AcpBlockText = {
  text: string;
  transcriptText?: string;
  needsFinalDelivery: boolean;
  // A terminal-only surface can confirm a block yet still need final delivery.
  delivered?: true;
};

export type AcpDispatchDeliveryState = {
  startedReplyLifecycle: boolean;
  blockTexts: AcpBlockText[];
  accumulatedBlockTtsText: string;
  accumulatedFinalText: string;
  accumulatedDeliveredFinalText: string;
  pendingTranscriptOutcomes: Promise<void>[];
  cleanBlockTtsDirectiveText?: ReturnType<typeof createTtsDirectiveTextStreamCleaner>;
  deliveredFinalReply: boolean;
  pendingAnswerDelivery: boolean;
  pendingFinalTtsMedia: boolean;
  deliveredAnswerFinalToUser: boolean;
  deliveredFinalTtsMedia: boolean;
  deliveredVisibleText: boolean;
  failedVisibleTextDelivery: boolean;
  queuedUntrackedVisibleTextDeliveries: number;
  settledUntrackedVisibleText: boolean;
  routedCounts: Record<ReplyDispatchKind, number>;
  suppressionReason?: NormalizeReplySkipReason;
  toolMessageByCallId: Map<string, ToolMessageHandle>;
};
