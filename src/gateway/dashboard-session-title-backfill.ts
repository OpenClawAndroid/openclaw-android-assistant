import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isSessionTranscriptProjectionUnavailableError,
  patchSessionEntryCore,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptWatermark,
} from "../config/sessions/session-accessor.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { deriveGoalSessionTitle } from "./derive-goal-session-title.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";
import { hasExplicitSessionName, sessionTitleRequests } from "./session-title-state.js";
import { sqliteMessageEventWithSeq } from "./session-transcript-entry-message.js";

/** The projection caller schedules one legacy title per background work turn. */
export async function backfillSessionTitle(params: {
  agentId: string;
  storeAgentId?: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  sessionEntry: SessionEntry;
  lifecycleRevision?: string;
  shouldCommit?: () => boolean;
}): Promise<boolean> {
  const mayWrite = () => params.shouldCommit?.() !== false && !sessionTitleRequests.get(params);
  if (!mayWrite()) {
    return false;
  }
  const entry = params.sessionEntry;
  if (
    entry.incognito ||
    entry.status === "running" ||
    entry.sessionId !== params.sessionId ||
    entry.lifecycleRevision !== params.lifecycleRevision ||
    hasExplicitSessionName(entry)
  ) {
    return false;
  }
  const scope = { ...params, agentId: params.storeAgentId ?? params.agentId, sessionEntry: entry };
  try {
    const { totalMessages } = readSessionTranscriptMessageEventPage(scope, {
      maxMessages: 0,
      offset: 0,
    });
    if (!totalMessages) {
      return false;
    }
    const head = readSessionTranscriptBoundedMessageTailPage(scope, {
      maxMessages: 100,
      maxBytes: 64 * 1024,
      offset: Math.max(0, totalMessages - 100),
    });
    // An omitted first user message must not turn a later message into its title.
    if (head.totalMessages !== totalMessages || head.events.length !== head.scannedMessages) {
      return false;
    }
    let displayName: string | undefined;
    for (const event of head.events) {
      const message = asOptionalRecord(sqliteMessageEventWithSeq(event));
      const projected = projectSessionDisplayMessage(message);
      if (projected?.role === "user" && !hasInterSessionUserProvenance(message)) {
        displayName = deriveGoalSessionTitle(projected.text);
        break;
      }
    }
    if (!displayName) {
      return false;
    }
    let persisted = false;
    await patchSessionEntryCore(
      params,
      (current) =>
        current.sessionId === params.sessionId &&
        current.lifecycleRevision === params.lifecycleRevision &&
        current.status !== "running" &&
        !hasExplicitSessionName(current)
          ? { displayName: Buffer.from(displayName, "utf16le").toString("utf16le") }
          : null,
      {
        preserveActivity: true,
        skipMaintenance: true,
        shouldCommit: () =>
          mayWrite() &&
          readSessionTranscriptWatermark(scope).generation === (head.snapshot.generation ?? null),
        onCommitted: () => {
          persisted = true;
        },
      },
    );
    return persisted;
  } catch (error) {
    if (
      isSessionTranscriptProjectionUnavailableError(error) ||
      error instanceof SessionTranscriptColdError
    ) {
      return false;
    }
    throw error;
  }
}
