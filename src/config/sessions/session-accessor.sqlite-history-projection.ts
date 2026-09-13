import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { TranscriptReadWindow } from "../../sessions/transcript-read-window.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-active-projection.js";
import { readTranscriptDisplaySource } from "./session-accessor.sqlite-display-position.js";
import { isVisibleHistoryNonMessageEventSql } from "./session-accessor.sqlite-history-interval.js";
import {
  resolveTranscriptBoundaryWindow,
  resolveVisibleMessagePositions,
} from "./session-accessor.sqlite-reset-window.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";

export type VisibleHistoryBoundary = {
  displayPosition: number;
  eventId: string;
  eventSeq: number;
  messagePosition: number;
  serializedBytes: number;
};

export type VisibleHistoryProjection = {
  boundaries: VisibleHistoryBoundary[];
  displaySource?: string;
  latestResetRawSeq: number | null;
  total: number;
};

export function resolveVisibleHistoryProjection(
  projection: CurrentTranscriptProjection,
): VisibleHistoryProjection {
  const displaySource = readTranscriptDisplaySource(projection);
  if (projection.state.activeEventCount === projection.state.activeMessageCount) {
    return {
      boundaries: [],
      displaySource,
      latestResetRawSeq: null,
      total: projection.state.activeMessageCount,
    };
  }
  const visibleMessages = resolveVisibleMessagePositions(projection);
  const latestResetRawSeq = resolveTranscriptBoundaryWindow(projection)?.boundarySeq ?? null;
  const db = getActiveTranscriptKysely(projection.database);
  const lastMessagePosition = db
    .selectFrom("session_transcript_active_events")
    .select("active_position")
    .where("session_id", "=", projection.resolved.sessionId)
    .where("message_position", "is not", null)
    .orderBy("message_position", "desc")
    .limit(1);
  const rows = executeSqliteQuerySync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin(
        db
          .selectFrom("transcript_event_identities")
          .select(["session_id", "event_id", "seq", "event_type"])
          .modifyEnd(
            // Whole-session reads select marker types; reset windows join their bounded active rows.
            /* kysely-allow-raw: preserve selective canonical index access after ANALYZE. */
            visibleMessages.boundaryActivePosition === undefined
              ? sql`INDEXED BY idx_agent_transcript_event_sequence`
              : sql`INDEXED BY idx_agent_transcript_event_identity_sequence`,
          )
          .as("identity"),
        (join) =>
          join
            .onRef("identity.session_id", "=", "active.session_id")
            .onRef("identity.seq", "=", "active.event_seq"),
      )
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select([
        "identity.event_id",
        "identity.seq",
        /* kysely-allow-raw: history byte caps include each event's JSONL newline. */
        sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
      ])
      .select((eb) =>
        eb
          .case()
          // Resolve the last message once so trailing markers cannot rescan an empty suffix.
          .when("active.active_position", "<", lastMessagePosition)
          .then(
            eb
              .selectFrom("session_transcript_active_events as next")
              .select("next.message_position")
              .whereRef("next.session_id", "=", "active.session_id")
              .whereRef("next.active_position", ">", "active.active_position")
              .where("next.message_position", "is not", null)
              .orderBy("next.active_position", "asc")
              .limit(1),
          )
          .else(null)
          .end()
          .as("next_message_position"),
      )
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where((eb) => {
        const type = eb.ref("identity.event_type");
        const event = eb.ref("event.event_json");
        const activeEventSeq = eb.ref("active.event_seq");
        const eventSeq = eb.ref("event.seq");
        if (visibleMessages.boundaryActivePosition === undefined) {
          return isVisibleHistoryNonMessageEventSql(type, event, activeEventSeq, eventSeq);
        }
        const inWindow = eb("active.active_position", ">=", visibleMessages.boundaryActivePosition);
        // Fence the JSON argument while leaving type/range predicates visible to the planner.
        return eb.and([
          inWindow,
          isVisibleHistoryNonMessageEventSql(
            type,
            eb.case().when(inWindow).then(event).else(null).end(),
            activeEventSeq,
            eventSeq,
          ),
        ]);
      })
      .orderBy("active.active_position", "asc"),
  ).rows;
  const boundaries = rows.map((row, index): VisibleHistoryBoundary => {
    // Kept messages precede the latest reset; later markers share its logical window.
    // Rebase raw positions so discarded messages cannot shift those markers.
    const nextMessagePosition = row.next_message_position ?? projection.state.activeMessageCount;
    const messagePosition =
      visibleMessages.kept.length + Math.max(0, nextMessagePosition - visibleMessages.postStart);
    return {
      displayPosition: messagePosition + index,
      eventId: row.event_id,
      eventSeq: row.seq,
      messagePosition,
      serializedBytes: row.serialized_bytes,
    };
  });
  return {
    boundaries,
    displaySource,
    latestResetRawSeq,
    total: visibleMessages.total + boundaries.length,
  };
}

export function resolveVisibleHistoryRange(
  history: VisibleHistoryProjection,
  start: number,
  endExclusive: number,
) {
  const boundedStart = Math.min(Math.max(0, start), history.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), history.total);
  const selectedBoundaries = history.boundaries.filter(
    (boundary) => boundary.displayPosition >= boundedStart && boundary.displayPosition < boundedEnd,
  );
  const boundaries = new Map(
    selectedBoundaries.map((boundary) => [boundary.displayPosition, boundary] as const),
  );
  const boundariesBefore = history.boundaries.filter(
    (boundary) => boundary.displayPosition < boundedStart,
  ).length;
  const messageStart = boundedStart - boundariesBefore;
  const messageEnd = messageStart + boundedEnd - boundedStart - selectedBoundaries.length;
  return { boundedEnd, boundedStart, boundaries, messageEnd, messageStart };
}

export function resolveHistoryMessageSequence(
  visible: ReturnType<typeof resolveVisibleMessagePositions>,
  history: VisibleHistoryProjection,
  messagePosition: number,
): number | undefined {
  const logicalPosition =
    messagePosition >= visible.postStart
      ? visible.kept.length + messagePosition - visible.postStart
      : visible.kept.indexOf(messagePosition);
  if (logicalPosition < 0) {
    return undefined;
  }
  // Boundaries follow active order; equal positions all precede this message.
  let precedingBoundaries = 0;
  let end = history.boundaries.length;
  while (precedingBoundaries < end) {
    const middle = Math.floor((precedingBoundaries + end) / 2);
    // The half-open search range stays inside the dense boundary projection.
    if (history.boundaries[middle]!.messagePosition <= logicalPosition) {
      precedingBoundaries = middle + 1;
    } else {
      end = middle;
    }
  }
  return logicalPosition + 1 + precedingBoundaries;
}

export function captureHistoryReadWindow(
  history: VisibleHistoryProjection,
  events: readonly SessionTranscriptMessageEvent[],
): TranscriptReadWindow {
  const anchor = events.at(-1);
  return {
    source: history.displaySource,
    latestResetRawSeq: history.latestResetRawSeq,
    ...(anchor ? { anchor: { rawSeq: anchor.eventSeq, seq: anchor.seq } } : {}),
  };
}

export function assertHistoryReadWindow(
  projection: CurrentTranscriptProjection,
  history: VisibleHistoryProjection,
  expected: TranscriptReadWindow | undefined,
): void {
  if (!expected) {
    return;
  }
  if (
    expected.source !== history.displaySource ||
    expected.latestResetRawSeq !== history.latestResetRawSeq
  ) {
    throw new SessionTranscriptProjectionUnavailableError(projection.resolved.sessionId);
  }
  const anchor = expected.anchor;
  if (!anchor) {
    return;
  }
  const row = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("session_transcript_active_events")
      .select("message_position")
      .where("session_id", "=", projection.resolved.sessionId)
      .where("event_seq", "=", anchor.rawSeq),
  );
  const position = row?.message_position;
  const boundary =
    position === null
      ? history.boundaries.find((entry) => entry.eventSeq === anchor.rawSeq)
      : undefined;
  const seq =
    position === undefined
      ? undefined
      : position === null
        ? boundary && boundary.displayPosition + 1
        : resolveHistoryMessageSequence(
            resolveVisibleMessagePositions(projection),
            history,
            position,
          );
  if (seq !== anchor.seq) {
    throw new SessionTranscriptProjectionUnavailableError(projection.resolved.sessionId);
  }
}
