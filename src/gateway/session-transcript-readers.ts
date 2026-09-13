import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "../config/sessions/session-accessor.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  readRecentSessionTranscriptMessageEvents,
  readSessionTranscriptMessageEvents,
  visitSessionTranscriptMessageEvents,
  waitForSessionTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "../config/sessions/session-accessor.sqlite-active-events.js";
import {
  readRecentSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventById,
  readSessionTranscriptHistoryEventCount,
  readSessionTranscriptHistoryEventLookup,
  readSessionTranscriptHistoryEventPage,
  readSessionTranscriptHistoryEvents,
  type SessionTranscriptMessageByIdOptions,
} from "../config/sessions/session-accessor.sqlite-history-events.js";
import { resolveConcreteSessionStorePath } from "../config/sessions/session-accessor.transcript-target.js";
import { readRestoredSessionTranscript } from "../config/sessions/session-cold-storage-read.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { TranscriptRecentReadLimits } from "../sessions/transcript-anchor-page.js";
import type {
  TranscriptReadWindow,
  TranscriptReadWindowOptions,
} from "../sessions/transcript-read-window.js";
import { aggregateSessionTranscriptUsage } from "./session-transcript-derived-readers.js";
import { projectTranscriptEntryMessage } from "./session-transcript-message.js";
import {
  resolveTranscriptReadTarget,
  toTranscriptReadScope,
  type ResolvedTranscriptReadTarget,
} from "./session-transcript-read-target.js";
import type {
  ReadRecentSessionMessagesOptions,
  ReadSessionMessagesAsyncOptions,
  SessionTranscriptUsageSnapshot,
} from "./session-utils.fs.js";
import {
  ArchivedTranscriptReader,
  readLatestSessionUsageFromTranscriptFileAsync,
} from "./session-utils.fs.js";

export type { ReadSessionMessagesAsyncOptions };
export { capArrayByJsonBytes } from "./session-utils.fs.js";
export { attachOpenClawTranscriptMeta } from "./session-transcript-message.js";
export { readSessionTranscriptVisibleMessageDeltaCore } from "../config/sessions/session-accessor.sqlite-active-events.js";

export type { SessionTranscriptReadScope };

export type ReadRecentSessionMessagesResult = {
  olderOffset?: number;
  omittedOversized?: boolean;
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  displaySource?: string;
  readWindow?: TranscriptReadWindow;
  messages: unknown[];
  transcriptEvents?: TranscriptEvent[];
  transcriptPath?: string;
  transcriptSource?: "active" | "reset-archive";
  totalMessages: number;
};

type ReadSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
};

type ReadSessionMessageByIdResult = {
  message?: unknown;
  seq?: number;
  oversized: boolean;
  found: boolean;
  serializedBytes?: number;
};

function archivedTranscriptReader(target: ResolvedTranscriptReadTarget): ArchivedTranscriptReader {
  return new ArchivedTranscriptReader({
    agentId: target.agentId,
    sessionId: target.sessionId,
    storePath: target.storePath,
  });
}

function extractMessagePayloads(entries: readonly SessionTranscriptMessageEvent[]): unknown[] {
  return entries.map((entry) => asOptionalRecord(entry.event)?.message);
}

function projectSqliteHistoryEvents(entries: readonly SessionTranscriptMessageEvent[]): unknown[] {
  const messages: unknown[] = [];
  for (const entry of entries) {
    const message = projectTranscriptEntryMessage(entry.event, entry.seq, entry.displayPosition);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

function normalizeRecentSqliteReadOptions(
  opts?: Partial<ReadRecentSessionMessagesOptions> &
    TranscriptReadWindowOptions & { readOnly?: boolean },
) {
  const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
  const maxBytes =
    typeof opts?.maxBytes === "number" && Number.isFinite(opts.maxBytes)
      ? Math.max(1024, Math.floor(opts.maxBytes))
      : 8 * 1024 * 1024;
  const defaultMaxLines = maxMessages * 20 + 20;
  const maxLines =
    typeof opts?.maxLines === "number" && Number.isFinite(opts.maxLines)
      ? Math.max(maxMessages, Math.floor(opts.maxLines))
      : defaultMaxLines;
  return {
    maxMessages,
    maxBytes,
    maxLines,
    captureReadWindow: opts?.captureReadWindow,
    expectedReadWindow: opts?.expectedReadWindow,
    readOnly: opts?.readOnly,
  };
}

function readRecentSqliteMessageRecords(
  target: ResolvedTranscriptReadTarget,
  opts?: Partial<ReadRecentSessionMessagesOptions> &
    TranscriptReadWindowOptions & { readOnly?: boolean },
): {
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  displaySource?: string;
  readWindow?: TranscriptReadWindow;
  messages: unknown[];
  totalMessages: number;
} {
  const normalized = normalizeRecentSqliteReadOptions(opts);
  const page = readRecentSessionTranscriptHistoryEvents(toTranscriptReadScope(target), normalized);
  return {
    ...(Object.hasOwn(page, "activeLeafEntryId")
      ? { activeLeafEntryId: page.activeLeafEntryId }
      : {}),
    ...(page.deltaCursor ? { deltaCursor: page.deltaCursor } : {}),
    displaySource: page.displaySource,
    ...(page.readWindow ? { readWindow: page.readWindow } : {}),
    messages: projectSqliteHistoryEvents(page.events),
    totalMessages: page.totalMessages,
  };
}

/** Reads display messages asynchronously through the reader seam. */
export async function readSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions & { readOnly?: boolean },
): Promise<unknown[]> {
  return (await readSessionMessagesWithSourceAsync(scope, opts)).messages;
}

/** Reads display messages with source metadata through the reader seam. */
export async function readSessionMessagesWithSourceAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions & { readOnly?: boolean },
): Promise<ReadSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  const messages = await readRestoredSessionTranscript(
    toTranscriptReadScope(target),
    () =>
      opts.mode === "recent"
        ? readRecentSqliteMessageRecords(target, opts).messages
        : projectSqliteHistoryEvents(
            readSessionTranscriptHistoryEvents(toTranscriptReadScope(target), opts),
          ),
    opts,
  );
  if (messages.length === 0 && opts.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).read({ ...opts, resetArchiveOnly: true });
  }
  return {
    messages,
    transcriptPath: target.sessionFile,
  };
}

/** Finds one display message by transcript id through the reader seam. */
export async function readSessionMessageByIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
  opts?: SessionTranscriptMessageByIdOptions & { allowResetArchiveFallback?: boolean },
): Promise<ReadSessionMessageByIdResult> {
  const target = resolveTranscriptReadTarget(scope);
  const foundEvent = await readRestoredSessionTranscript(toTranscriptReadScope(target), () =>
    readSessionTranscriptHistoryEventById(toTranscriptReadScope(target), messageId, opts),
  );
  if (foundEvent) {
    return {
      found: true,
      message: projectTranscriptEntryMessage(
        foundEvent.event,
        foundEvent.seq,
        foundEvent.displayPosition,
      ),
      oversized: false,
      seq: foundEvent.seq,
      ...(foundEvent.serializedBytes !== undefined
        ? { serializedBytes: foundEvent.serializedBytes }
        : {}),
    };
  }
  if (opts?.allowResetArchiveFallback === true && !opts.currentOnly) {
    return await archivedTranscriptReader(target).readById(messageId, {
      ...opts,
      resetArchiveOnly: true,
    });
  }
  return { found: false, oversized: false };
}

/** Read exact membership while retaining full-history validity and empty-only archive fallback. */
export async function readSessionMessagesMatchingIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
): Promise<unknown[]> {
  const target = resolveTranscriptReadTarget(scope);
  const lookup = await readRestoredSessionTranscript(toTranscriptReadScope(target), () =>
    readSessionTranscriptHistoryEventLookup(toTranscriptReadScope(target), messageId),
  );
  const messages = lookup.hasDisplayMessages
    ? projectSqliteHistoryEvents(lookup.events)
    : await archivedTranscriptReader(target).readMessageCandidatesById(messageId, {
        allowResetArchiveFallback: true,
        resetArchiveOnly: true,
      });
  return messages.filter(
    (message) => asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id === messageId,
  );
}

/** Visits raw message payloads within the SQLite read snapshot. */
export async function visitSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  visit: (message: unknown, seq: number) => void,
): Promise<number> {
  const transcriptScope = toTranscriptReadScope(resolveTranscriptReadTarget(scope));
  return readRestoredSessionTranscript(transcriptScope, () => {
    let count = 0;
    visitSessionTranscriptMessageEvents(transcriptScope, (entry) => {
      const message = asOptionalRecord(entry.event)?.message;
      if (message !== undefined) {
        visit(message, entry.seq);
        count += 1;
      }
    });
    return count;
  });
}

/** Counts display messages asynchronously through the reader seam. */
export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
): Promise<number> {
  const target = resolveTranscriptReadTarget(scope);
  const transcriptScope = toTranscriptReadScope(target);
  const readCount = () =>
    readRestoredSessionTranscript(transcriptScope, () =>
      readSessionTranscriptHistoryEventCount(transcriptScope),
    );
  try {
    return await readCount();
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    // The failed read already scheduled the rebuild; wait before assigning
    // a sequence so a concurrent send cannot fail or reuse a stale count.
    await waitForSessionTranscriptProjection(transcriptScope);
    return await readCount();
  }
}

/** Reads recent messages with total-count metadata asynchronously through the reader seam. */
export async function readRecentSessionMessagesWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadRecentSessionMessagesOptions & TranscriptReadWindowOptions & { readOnly?: boolean },
): Promise<ReadRecentSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  const { activeLeafEntryId, deltaCursor, displaySource, readWindow, messages, totalMessages } =
    await readRestoredSessionTranscript(
      toTranscriptReadScope(target),
      () => readRecentSqliteMessageRecords(target, opts),
      opts,
    );
  if (totalMessages === 0 && messages.length === 0 && opts.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).readRecentWithStats({
      ...opts,
      resetArchiveOnly: true,
    });
  }
  return {
    ...(activeLeafEntryId !== undefined ? { activeLeafEntryId } : {}),
    ...(deltaCursor ? { deltaCursor } : {}),
    displaySource,
    ...(readWindow ? { readWindow } : {}),
    messages,
    totalMessages,
    transcriptPath: target.sessionFile,
    transcriptSource: "active",
  };
}

/** Reads one offset page with total-count metadata through the reader seam. */
export async function readSessionMessagesPageWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: TranscriptReadWindowOptions & {
    offset: number;
    maxMessages: number;
    beforeSeq?: number;
    recentAtHead?: TranscriptRecentReadLimits;
    maxBytes?: number;
    allowResetArchiveFallback?: boolean;
    readOnly?: boolean;
  },
): Promise<ReadRecentSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  const page = await readRestoredSessionTranscript(
    toTranscriptReadScope(target),
    () => readSessionTranscriptHistoryEventPage(toTranscriptReadScope(target), opts),
    opts,
  );
  if (page.totalMessages === 0 && opts.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).readPage({ ...opts, resetArchiveOnly: true });
  }
  return {
    ...(Object.hasOwn(page, "activeLeafEntryId")
      ? { activeLeafEntryId: page.activeLeafEntryId }
      : {}),
    ...(page.olderOffset !== undefined ? { olderOffset: page.olderOffset } : {}),
    ...(page.deltaCursor ? { deltaCursor: page.deltaCursor } : {}),
    ...(page.omittedOversized ? { omittedOversized: true } : {}),
    messages: projectSqliteHistoryEvents(page.events),
    displaySource: page.displaySource,
    ...(page.readWindow ? { readWindow: page.readWindow } : {}),
    totalMessages: page.totalMessages,
    transcriptPath: target.sessionFile,
    transcriptSource: "active",
  };
}

/** Reads aggregate usage from a full transcript asynchronously through the reader seam. */
export async function readLatestSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const artifactFile = scope.sessionFile?.trim();
  const concreteStorePath = resolveConcreteSessionStorePath(scope.storePath);
  const targetAgentId = scope.agentId?.trim() || resolveAgentIdFromSessionKey(scope.sessionKey);
  const hasCompleteTarget = Boolean(targetAgentId && scope.sessionKey?.trim() && concreteStorePath);
  if (
    !hasCompleteTarget &&
    artifactFile &&
    path.isAbsolute(artifactFile) &&
    artifactFile.endsWith(".jsonl")
  ) {
    return await readLatestSessionUsageFromTranscriptFileAsync(
      scope.sessionId,
      concreteStorePath,
      artifactFile,
      undefined,
    );
  }
  const target = resolveTranscriptReadTarget(scope);
  return readRestoredSessionTranscript(toTranscriptReadScope(target), () =>
    aggregateSessionTranscriptUsage(
      extractMessagePayloads(readSessionTranscriptMessageEvents(toTranscriptReadScope(target))),
    ),
  );
}

/** Reads aggregate usage from a bounded transcript tail synchronously through the reader seam. */
export function readRecentSessionUsageFromTranscript(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): SessionTranscriptUsageSnapshot | null {
  const target = resolveTranscriptReadTarget(scope);
  const page = readRecentSessionTranscriptMessageEvents(toTranscriptReadScope(target), {
    maxBytes: Math.max(1024, Math.floor(Number.isFinite(maxBytes) ? maxBytes : 8 * 1024 * 1024)),
    maxLines: 1000,
    maxMessages: 1000,
  });
  return aggregateSessionTranscriptUsage(extractMessagePayloads(page.events));
}
