import type { DatabaseSync } from "node:sqlite";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SqliteSessionEntryRevision } from "./session-accessor.sqlite-entry-revision.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  getSessionMaintenanceActivityAt,
  shouldPreserveMaintenanceEntry,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type AgeFact = {
  token: SqliteSessionEntryRevision;
  oldestUpdatedAt: number;
  oldestDashboardActivityAt: number;
  next?: { policy: string; at: number };
};
type Activity = Parameters<typeof getSessionMaintenanceActivityAt>[0];

// Share the entry cache's raw-DML/external-commit revision, not its listing snapshot.
const ageFacts = new WeakMap<DatabaseSync, AgeFact>();

function stageAgeFact(db: DatabaseSync, fact: AgeFact): void {
  if (
    stageSqliteTransactionState(db, {
      stage: () => ageFacts.set(db, fact),
      rollback: () => ageFacts.delete(db),
      commit: () => {},
    })
  ) {
    return;
  }
  if (!db.isTransaction) {
    ageFacts.set(db, fact);
  }
}

export function hasSessionEntryMaintenanceAgeFact(db: DatabaseSync): boolean {
  return ageFacts.has(db);
}

export function readSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  token: SqliteSessionEntryRevision,
): AgeFact | undefined {
  const fact = ageFacts.get(db);
  if (
    fact?.token.dataVersion !== token.dataVersion ||
    fact.token.sessionNodesGeneration !== token.sessionNodesGeneration
  ) {
    ageFacts.delete(db);
    return undefined;
  }
  return fact;
}

function isDashboardKey(key: string): boolean {
  return parseAgentSessionKey(key)?.rest.startsWith("dashboard:") === true;
}

function includeEntryAge(fact: AgeFact, key: string, entry: Activity): void {
  // Only key-inherent protection is stable without rereading live admissions or row fields.
  if (shouldPreserveMaintenanceEntry({ key, entry: undefined })) {
    return;
  }
  fact.oldestUpdatedAt = Math.min(fact.oldestUpdatedAt, entry?.updatedAt ?? Infinity);
  if (isDashboardKey(key)) {
    fact.oldestDashboardActivityAt = Math.min(
      fact.oldestDashboardActivityAt,
      getSessionMaintenanceActivityAt(entry),
    );
  }
}

/** Tracked writes can only bring the conservative age boundary forward. */
export function advanceSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  generation: { before: number; after: number },
  update?: { sessionKey: string; entry: SessionEntry; previousEntry?: SessionEntry },
): void {
  const fact = ageFacts.get(db);
  if (!fact) {
    return;
  }
  if (!update || fact.token.sessionNodesGeneration !== generation.before) {
    ageFacts.delete(db);
    return;
  }
  const { entry, previousEntry } = update;
  const older =
    !previousEntry ||
    (previousEntry.archivedAt !== undefined && entry.archivedAt === undefined) ||
    entry.updatedAt < previousEntry.updatedAt ||
    getSessionMaintenanceActivityAt(entry) < getSessionMaintenanceActivityAt(previousEntry);
  const next: AgeFact = {
    ...fact,
    token: { ...fact.token, sessionNodesGeneration: generation.after },
    next: older ? undefined : fact.next,
  };
  if (entry.archivedAt === undefined) {
    includeEntryAge(next, update.sessionKey, entry);
  }
  stageAgeFact(db, next);
}

function agePolicy(maintenance: ResolvedSessionMaintenanceConfig): string {
  return JSON.stringify([
    maintenance.pruneAfterMs,
    maintenance.archiveDashboardAfterMs,
    maintenance.preserveRecentMs,
  ]);
}

function nextEntryAgeAt(
  key: string,
  entry: Activity,
  maintenance: ResolvedSessionMaintenanceConfig,
  now: number,
): number {
  if (shouldPreserveMaintenanceEntry({ key, entry: undefined })) {
    return Infinity;
  }
  const activityAt = getSessionMaintenanceActivityAt(entry);
  let next = Infinity;
  for (const [timestamp, age] of [
    [entry?.updatedAt ?? 0, maintenance.pruneAfterMs],
    [activityAt, isDashboardKey(key) ? maintenance.archiveDashboardAfterMs : null],
    [activityAt, maintenance.preserveRecentMs],
  ]) {
    if (timestamp != null && age != null && age > 0) {
      const at = timestamp + age + 1;
      if (at > now) {
        next = Math.min(next, at);
      }
    }
  }
  return next;
}

/** Plan facts use one timestamp projection; prompt payloads never enter JavaScript. */
export function recordSessionEntryMaintenanceAgeFact(
  database: OpenClawAgentDatabase,
  token: SqliteSessionEntryRevision,
  maintenance: ResolvedSessionMaintenanceConfig,
): void {
  const next = { policy: agePolicy(maintenance), at: Infinity };
  const fact: AgeFact = {
    token,
    oldestUpdatedAt: Infinity,
    oldestDashboardActivityAt: Infinity,
    next,
  };
  const now = Date.now();
  const query = getSessionKysely(database.db)
    .selectFrom("session_nodes")
    .select(["session_key", "updated_at", "last_activity_at", "last_interaction_at"])
    .select((eb) =>
      eb
        .case()
        .when(eb.fn<number>("json_valid", ["entry_json"]), "=", 1)
        .then(
          eb.cast<number>(
            eb.fn("json_extract", [eb.ref("entry_json"), eb.val("$.sessionStartedAt")]),
            "integer",
          ),
        )
        .else(null)
        .end()
        .as("session_started_at"),
    )
    .where("archived_at", "is", null);
  for (const row of iterateSqliteQuerySync(database.db, query)) {
    const activity = {
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at ?? undefined,
      lastInteractionAt: row.last_interaction_at ?? undefined,
      sessionStartedAt: row.session_started_at ?? undefined,
    };
    includeEntryAge(fact, row.session_key, activity);
    next.at = Math.min(next.at, nextEntryAgeAt(row.session_key, activity, maintenance, now));
  }
  stageAgeFact(database.db, fact);
}

/** Infinity leaves the kick's periodic recheck in charge of released live protection. */
export function readSessionEntryMaintenanceNextAgeAt(
  database: OpenClawAgentDatabase,
  token: SqliteSessionEntryRevision,
  maintenance: ResolvedSessionMaintenanceConfig,
): number | undefined {
  if (maintenance.mode !== "enforce") {
    return undefined;
  }
  const fact = readSessionEntryMaintenanceAgeFact(database.db, token);
  if (fact?.next?.policy === agePolicy(maintenance) && fact.next.at > Date.now()) {
    return fact.next.at;
  }
  recordSessionEntryMaintenanceAgeFact(database, token, maintenance);
  return ageFacts.get(database.db)?.next?.at;
}
