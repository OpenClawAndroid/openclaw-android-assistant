import type {
  TranscriptAnchorPageOptions,
  TranscriptRecentReadLimits,
} from "../../sessions/transcript-anchor-page.js";
import type { TranscriptReadWindowOptions } from "../../sessions/transcript-read-window.js";
import type {
  SessionTranscriptMessageAnchorPage,
  SessionTranscriptMessageEventPage,
} from "./session-accessor.sqlite-active-events.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import { resolveVisibleHistoryEventCount } from "./session-accessor.sqlite-history-projection.js";
import {
  readTranscriptDisplayDeltaFromProjection,
  readSessionTranscriptHistoryEventsFromProjection,
  readRecentSessionTranscriptHistoryEventsFromProjection,
  readSessionTranscriptHistoryEventPageFromProjection,
  readSessionTranscriptHistoryEventByIdFromProjection,
  readSessionTranscriptHistoryEventLookupFromProjection,
  readSessionTranscriptHistoryAnchorPageFromProjection,
  type SessionTranscriptDisplayDeltaResult,
  type SessionTranscriptMessageById,
  type SessionTranscriptMessageByIdOptions,
} from "./session-accessor.sqlite-history-query.js";
import type { SessionTranscriptMessageEvent } from "./session-accessor.sqlite-projection-read.js";

export function readTranscriptDisplayDelta(
  scope: SessionTranscriptReadScope,
  limits: SessionTranscriptRawDeltaLimits = {},
): SessionTranscriptDisplayDeltaResult {
  const readLimits = { ...limits };
  return withCurrentProjectionSnapshot(scope, (projection) =>
    readTranscriptDisplayDeltaFromProjection(projection, readLimits),
  );
}

export function readSessionTranscriptHistoryEvents(
  scope: SessionTranscriptReadScope,
  options: { readOnly?: boolean } = {},
): SessionTranscriptMessageEvent[] {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readSessionTranscriptHistoryEventsFromProjection(projection),
    options,
  );
}

export function readRecentSessionTranscriptHistoryEvents(
  scope: SessionTranscriptReadScope,
  options: TranscriptRecentReadLimits & TranscriptReadWindowOptions & { readOnly?: boolean },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readRecentSessionTranscriptHistoryEventsFromProjection(projection, options),
    options,
  );
}

export function readSessionTranscriptHistoryEventPage(
  scope: SessionTranscriptReadScope,
  options: {
    maxMessages: number;
    offset: number;
    beforeSeq?: number;
    maxBytes?: number;
    readOnly?: boolean;
    recentAtHead?: TranscriptRecentReadLimits;
  } & TranscriptReadWindowOptions,
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readSessionTranscriptHistoryEventPageFromProjection(projection, options),
    options,
  );
}

export function readSessionTranscriptHistoryEventCount(scope: SessionTranscriptReadScope): number {
  return withCurrentProjectionSnapshot(scope, resolveVisibleHistoryEventCount);
}

export function readSessionTranscriptHistoryEventById(
  scope: SessionTranscriptReadScope,
  eventId: string,
  options: SessionTranscriptMessageByIdOptions = {},
): SessionTranscriptMessageById | undefined {
  return withCurrentProjectionSnapshot(scope, (projection) =>
    readSessionTranscriptHistoryEventByIdFromProjection(projection, eventId, options),
  );
}

export function readSessionTranscriptHistoryEventLookup(
  scope: SessionTranscriptReadScope,
  eventId: string,
): { events: SessionTranscriptMessageEvent[]; hasDisplayMessages: boolean } {
  return withCurrentProjectionSnapshot(scope, (projection) =>
    readSessionTranscriptHistoryEventLookupFromProjection(projection, eventId),
  );
}

export function readSessionTranscriptHistoryAnchorPage(
  scope: SessionTranscriptReadScope,
  options: TranscriptAnchorPageOptions & { readOnly?: boolean },
): SessionTranscriptMessageAnchorPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readSessionTranscriptHistoryAnchorPageFromProjection(projection, options),
    options,
  );
}
