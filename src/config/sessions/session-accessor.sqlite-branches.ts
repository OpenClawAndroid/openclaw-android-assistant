import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  readOpenClawAgentDatabaseIdentity,
  type OpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  normalizeSqliteSessionKey,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionBranchListParams,
  SessionBranchListResult,
  SessionBranchSummary,
} from "./session-accessor.types.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  isSessionTranscriptLeafControl,
  scanSessionTranscriptTree,
  type SessionTranscriptTree,
} from "./transcript-tree.js";

const BRANCH_HEADLINE_MAX_CHARS = 120;
const SESSION_BRANCH_CACHE_MAX_ENTRIES = 32;

type SessionBranchWatermark = { generation: string | null; maxSeq: number | null };
type SessionBranchCacheEntry = SessionBranchWatermark & {
  branches: SessionBranchSummary[];
  identity: OpenClawAgentDatabaseIdentity;
};
type SessionBranchPathSummary = Pick<SessionBranchSummary, "headline" | "messageCount">;

export type SessionBranchSummaryReadRequest = {
  database: { agentId: string; path: string };
  databaseIdentity: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
};
export type SessionBranchSummaryReadResult =
  | ({ status: "ok"; branches: SessionBranchSummary[] } & SessionBranchWatermark)
  | { status: "missing-session" | "failed" };

// Host and worker isolates share this policy, each retaining only their compact derived results.
const sessionBranchCache = new Map<string, SessionBranchCacheEntry>();

function sessionBranchCacheKey(databasePath: string, sessionId: string): string {
  return `${databasePath}\0${sessionId}`;
}

function cloneSessionBranchSummaries(branches: readonly SessionBranchSummary[]) {
  return branches.map((branch) => ({ ...branch }));
}

function readCachedSessionBranchSummaries(
  database: OpenClawAgentReadOnlyDatabase,
  sessionId: string,
  watermark: SessionBranchWatermark,
): SessionBranchSummary[] | undefined {
  const cacheKey = sessionBranchCacheKey(database.path, sessionId);
  const cached = sessionBranchCache.get(cacheKey);
  if (
    !cached ||
    cached.identity !== readOpenClawAgentDatabaseIdentity(database).identity ||
    cached.generation !== watermark.generation ||
    cached.maxSeq !== watermark.maxSeq
  ) {
    return undefined;
  }
  sessionBranchCache.delete(cacheKey);
  sessionBranchCache.set(cacheKey, cached);
  return cached.branches;
}

function cacheSessionBranchSummaries(
  database: OpenClawAgentReadOnlyDatabase,
  sessionId: string,
  snapshot: SessionBranchWatermark & { branches: SessionBranchSummary[] },
): void {
  const cacheKey = sessionBranchCacheKey(database.path, sessionId);
  sessionBranchCache.delete(cacheKey);
  sessionBranchCache.set(cacheKey, {
    branches: snapshot.branches,
    generation: snapshot.generation,
    maxSeq: snapshot.maxSeq,
    identity: readOpenClawAgentDatabaseIdentity(database).identity,
  });
  pruneMapToMaxSize(sessionBranchCache, SESSION_BRANCH_CACHE_MAX_ENTRIES);
}

function readSessionBranchWatermark(
  database: Pick<OpenClawAgentReadOnlyDatabase, "db">,
  sessionId: string,
): SessionBranchWatermark {
  const db = getSessionKysely(database.db);
  const maxSeq = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number>("seq").as("max_seq"))
      .where("session_id", "=", sessionId),
  )?.max_seq;
  const generation = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", sessionId),
  )?.generation;
  return { generation: generation ?? null, maxSeq: maxSeq ?? null };
}

function readSessionBranchSnapshot(
  database: OpenClawAgentReadOnlyDatabase,
  expected: Pick<
    SessionBranchSummaryReadRequest,
    "sessionKey" | "sessionId" | "lifecycleRevision"
  > & {
    databaseIdentity?: string;
  },
): SessionBranchSummaryReadResult {
  return runSqliteDeferredTransactionSync<SessionBranchSummaryReadResult>(
    database.db,
    () => {
      if (
        expected.databaseIdentity !== undefined &&
        readOpenClawAgentDatabaseIdentity(database).identity !== expected.databaseIdentity
      ) {
        return { status: "failed" };
      }
      const entry = readSessionEntryRow(database, expected.sessionKey)?.entry;
      if (!entry?.sessionId) {
        return { status: "missing-session" };
      }
      if (
        entry.sessionId !== expected.sessionId ||
        entry.lifecycleRevision !== expected.lifecycleRevision
      ) {
        return { status: "failed" };
      }
      assertSessionTranscriptHot(database.db, expected.sessionId);
      // The watermark and rows must describe the same snapshot, even when a peer appends.
      const watermark = readSessionBranchWatermark(database, expected.sessionId);
      const cached = readCachedSessionBranchSummaries(database, expected.sessionId, watermark);
      const branches =
        cached ??
        summarizeSessionBranches(loadTranscriptEventsFromDatabase(database, expected.sessionId));
      if (!cached) {
        cacheSessionBranchSummaries(database, expected.sessionId, { ...watermark, branches });
      }
      return { status: "ok", ...watermark, branches: cloneSessionBranchSummaries(branches) };
    },
    { operationLabel: "session branch summaries read" },
  );
}

/** The transcript worker opens and closes its own read-only handle; only summaries leave it. */
export function readSessionBranchSummariesInWorker(
  request: SessionBranchSummaryReadRequest,
): SessionBranchSummaryReadResult {
  const result = withFreshOpenClawAgentDatabaseReadOnly(
    (database) => readSessionBranchSnapshot(database, request),
    request.database,
  );
  return result.found ? result.value : { status: "missing-session" };
}

export function invalidateSessionBranchCache(
  databasePath: string,
  sessionIds: readonly string[],
): void {
  for (const sessionId of uniqueStrings(sessionIds)) {
    sessionBranchCache.delete(sessionBranchCacheKey(databasePath, sessionId));
  }
}

export async function listSessionBranches(
  params: SessionBranchListParams,
): Promise<SessionBranchListResult> {
  const sourceKey = normalizeSqliteSessionKey(params.sessionStoreKey ?? params.sessionKey);
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  try {
    const retained = retainOpenClawAgentDatabaseReadOnly(toDatabaseOptions(resolved));
    if (!retained.found) {
      return { status: "missing-session" };
    }
    const { database, claim } = retained;
    const completion = createDeferredCore();
    const controller = new AbortController();
    let unregister = () => {};
    try {
      const selected = readSessionEntryRow(database, sourceKey)?.entry;
      if (!selected?.sessionId) {
        return { status: "missing-session" };
      }
      const expected = {
        sessionKey: sourceKey,
        sessionId: selected.sessionId,
        lifecycleRevision: selected.lifecycleRevision,
      };
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        claim.assertCurrent();
      };
      unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: database.agentId,
        path: database.path,
        revoke: () => controller.abort(new Error("Session branch read was revoked")),
        close: () => completion.promise,
      });
      return await readRestoredSessionTranscript(
        { ...params, agentId: resolved.agentId, sessionId: selected.sessionId },
        async (): Promise<SessionBranchListResult> => {
          assertCurrent();
          const watermark = readSessionBranchWatermark(database, selected.sessionId);
          const cached = readCachedSessionBranchSummaries(database, selected.sessionId, watermark);
          let snapshot: SessionBranchSummaryReadResult;
          if (cached) {
            snapshot = { status: "ok", ...watermark, branches: cached };
          } else if (typeof claim.identity === "symbol") {
            // Incognito transcripts live only in this process's in-memory database.
            snapshot = readSessionBranchSnapshot(database, expected);
          } else {
            const { runSessionBranchSummaryWorkerRequest } =
              await import("./session-transcript-worker-runtime.js");
            assertCurrent();
            snapshot = await runSessionBranchSummaryWorkerRequest(
              {
                database: { agentId: database.agentId, path: database.path },
                databaseIdentity: claim.identity,
                ...expected,
              },
              controller.signal,
            );
          }
          assertCurrent();
          const current = readSessionEntryRow(database, sourceKey)?.entry;
          if (
            current?.sessionId !== expected.sessionId ||
            current.lifecycleRevision !== expected.lifecycleRevision
          ) {
            return { status: "failed" };
          }
          if (snapshot.status !== "ok") {
            return snapshot;
          }
          // Keep the worker's exact watermark; an append during the read invalidates the next lookup.
          cacheSessionBranchSummaries(database, selected.sessionId, snapshot);
          return { status: "ok", branches: cloneSessionBranchSummaries(snapshot.branches) };
        },
      );
    } finally {
      try {
        claim.release();
      } finally {
        completion.resolve();
        unregister();
      }
    }
  } catch {
    return { status: "failed" };
  }
}

function summarizeSessionBranches(events: readonly TranscriptEvent[]): SessionBranchSummary[] {
  const tree = scanSessionTranscriptTree(events);
  const pathSummaries = new Map<string, SessionBranchPathSummary>();
  return (
    sessionBranchTipNodes(tree)
      .toSorted(
        (left, right) =>
          Number(right.id === tree.leafId) - Number(left.id === tree.leafId) ||
          right.index - left.index,
      )
      // SAFETY: scanSessionTranscriptTree inserts every returned node into byId.
      .map((node) => summarizeSessionBranch(tree, tree.byId.get(node.id)!, pathSummaries))
  );
}

export function sessionBranchTipNodes(tree: SessionTranscriptTree<TranscriptEvent>) {
  const referencedParents = new Set(
    tree.nodes.flatMap((node) =>
      isSessionTranscriptLeafControl(node.entry) || node.parentId === null ? [] : [node.parentId],
    ),
  );
  return tree.nodes.filter(
    (node) =>
      !isSessionTranscriptLeafControl(node.entry) &&
      (node.id === tree.leafId || !referencedParents.has(node.id)),
  );
}

function summarizeSessionBranch(
  tree: SessionTranscriptTree<TranscriptEvent>,
  leaf: SessionTranscriptTree<TranscriptEvent>["nodes"][number],
  summaries: Map<string, SessionBranchPathSummary>,
): SessionBranchSummary {
  const uncachedPath: typeof tree.nodes = [];
  const seen = new Set<string>();
  let current = leaf;
  // Stop at the first cached ancestor so every shared prefix is summarized once.
  // A cycle still produces the empty summary returned by the path selector.
  while (!summaries.has(current.id)) {
    if (seen.has(current.id)) {
      uncachedPath.length = 0;
      break;
    }
    seen.add(current.id);
    uncachedPath.push(current);
    const parent = current.parentId === null ? undefined : tree.byId.get(current.parentId);
    if (!parent) {
      break;
    }
    current = parent;
  }

  let summary = summaries.get(current.id);
  for (const node of uncachedPath.toReversed()) {
    const record = asRecord(node.entry);
    const headline = record?.type === "message" ? extractHeadlineText(record.message) : undefined;
    summary = {
      headline: headline ?? summary?.headline ?? "",
      messageCount: (summary?.messageCount ?? 0) + (record?.type === "message" ? 1 : 0),
    };
    summaries.set(node.id, summary);
  }

  const timestamp = asRecord(leaf.entry)?.timestamp;
  return {
    leafEntryId: leaf.id,
    headline: truncateBranchHeadline(summary?.headline ?? ""),
    messageCount: summary?.messageCount ?? 0,
    ...(typeof timestamp === "string" && timestamp.trim() ? { updatedAt: timestamp } : {}),
    active: tree.leafId === leaf.id,
  };
}

function extractHeadlineText(messageValue: unknown): string | undefined {
  const message = asRecord(messageValue);
  if (message?.role !== "user" && message?.role !== "assistant") {
    return undefined;
  }
  const text =
    message.role === "assistant"
      ? extractAssistantPhaseText(message)
      : extractEditorText(message.content ?? message.text);
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function truncateBranchHeadline(value: string): string {
  const characters = Array.from(value);
  return characters.length <= BRANCH_HEADLINE_MAX_CHARS
    ? value
    : `${characters.slice(0, BRANCH_HEADLINE_MAX_CHARS - 1).join("")}…`;
}

export function extractEditorText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
  return text || undefined;
}
