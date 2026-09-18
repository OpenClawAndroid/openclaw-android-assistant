import { isDeepStrictEqual } from "node:util";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { resolveProjectedAgentRunModel } from "../infra/agent-run-registry.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { compareSessionEntryPairs } from "./session-list-order.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import * as rowProjection from "./session-utils-row.js";

export type Row = {
  key: string;
  agentId: string;
  storeTarget: SessionStoreTarget;
  storedEntry?: SessionEntry;
  entry?: SessionEntry;
  materialized?: ReturnType<typeof rowProjection.materializeSessionRow>;
  materializedSequence?: number;
  lastMessagePreview?: string;
  fallbackModel?: ReturnType<
    typeof rowProjection.readSessionRowInputs
  >["presentation"]["activeModel"];
  facts?: ReturnType<typeof readSessionRowFacts>;
  membership: ReadonlySet<string>;
  parents: Set<string>;
  generation: string | symbol;
};
export type Query = {
  agentId?: string;
  storePath?: string;
  key?: string;
  sessionIdOrKey?: string;
  parentSessionKey?: string;
  sortBy?: Parameters<typeof compareSessionEntryPairs>[2] | null;
};
export type Inputs = Parameters<typeof rowProjection.readSessionRowInputs>[0];
export type SnapshotOptions = Pick<
  Inputs,
  "now" | "includeDerivedTitles" | "includeLastMessage" | "excludedChildKeys"
> & { active?: boolean };
export type Lookup = { agentId: string; key: string; storePath?: string };
type RowTarget = Pick<Row, "agentId" | "key" | "storeTarget">;
export const identity = (row: RowTarget) =>
  `${row.agentId}\0${row.storeTarget.storePath}\0${row.key}`;
export const physical = (storePath: string, key: string) => `physical:${storePath}\0${key}`;
const logical = (agentId: string, key: string) => `logical:${agentId}\0${key}`;
const references = (row: RowTarget) => [
  logical(row.agentId, row.key),
  physical(row.storeTarget.storePath, row.key),
];
export function dependents(row: Row, byParent: ReadonlyMap<string, Set<string>>) {
  return new Set(references(row).flatMap((ref) => Array.from(byParent.get(ref) ?? [])));
}
export function markRelated(
  row: Row,
  indexes: {
    byParent: ReadonlyMap<string, Set<string>>;
    byKey: ReadonlyMap<string, Set<string>>;
  },
  dirty: Set<string>,
) {
  for (const id of dependents(row, indexes.byParent)) {
    dirty.add(id);
  }
  for (const parent of row.parents) {
    for (const id of indexes.byKey.get(parent) ?? []) {
      dirty.add(id);
    }
  }
}

/** Mark resident logical owners without changing stored entries, relatives, or backfill. */
export function markAutomation(
  rows: Iterable<Row>,
  agentId: string | undefined,
  dirty: Set<string>,
) {
  for (const row of rows) {
    if (!agentId || row.agentId === agentId) {
      dirty.add(identity(row));
    }
  }
}

export function create(target: RowTarget, entry?: SessionEntry): Row {
  return {
    ...target,
    storedEntry: entry,
    parents: new Set(),
    membership: new Set(),
    generation: Symbol("row"),
  };
}
export type EntryRow = Row & Required<Pick<Row, "entry">>;
export type MaterializedRow = EntryRow & Required<Pick<Row, "materialized">>;
export function hasEntry(row: Row | undefined): row is EntryRow {
  return Boolean(row?.entry);
}
export function ready(row: Row | undefined): row is MaterializedRow {
  return Boolean(row?.entry && row.materialized);
}

export function sort<T extends EntryRow>(rows: T[], sortBy: Query["sortBy"]): T[] {
  return sortBy === null
    ? rows
    : rows.toSorted((a, b) => compareSessionEntryPairs([a.key, a.entry], [b.key, b.entry], sortBy));
}

export function sameFallbackModelFacts(previous: Row["storedEntry"], current: SessionEntry) {
  return (
    previous?.modelProvider === current.modelProvider &&
    previous?.model === current.model &&
    previous?.lastRunId === current.lastRunId &&
    isDeepStrictEqual(previous?.fallbackNotice, current.fallbackNotice)
  );
}

export function first(candidates: Row[], storePaths: Iterable<string>) {
  return candidates.length < 2
    ? candidates[0]
    : [...storePaths].flatMap((sourcePath) =>
        candidates.filter((row) => row.storeTarget.storePath === sourcePath),
      )[0];
}

export function present(
  record: MaterializedRow,
  context: SessionListRowContext,
  options: SnapshotOptions = {},
) {
  const now = options.now ?? Date.now();
  const live = resolveProjectedAgentRunModel({
    agentId: record.agentId,
    sessionId: record.entry.sessionId,
    index: context.projectedAgentRuns!,
  });
  const active = options.active ?? (live !== undefined || record.entry.status === "running");
  const row = rowProjection.presentSessionRow(record.materialized, {
    now,
    subagentRuns: context.subagentRuns.atTime(now),
    activeModel: active ? (live ?? undefined) : record.fallbackModel,
    excludedChildKeys: options.excludedChildKeys,
  });
  Object.assign(row, record.facts?.present());
  if (!options.includeDerivedTitles) {
    delete row.derivedTitle;
  }
  if (!options.includeLastMessage) {
    delete row.lastMessagePreview;
  }
  return row;
}

export function index(
  row: Row,
  indexes: {
    byStore: Map<string, Set<string>>;
    byAgent: Map<string, Set<string>>;
    byKey: Map<string, Set<string>>;
    byParent: Map<string, Set<string>>;
  },
  deleting = false,
) {
  const { byStore, byAgent, byKey, byParent } = indexes;
  const id = identity(row);
  for (const [map, keys] of [
    [byStore, [row.storeTarget.storePath]],
    [byAgent, [row.agentId]],
    [byKey, [`key:${row.key}`, row.entry && `id:${row.entry.sessionId}`, ...references(row)]],
    [byParent, row.parents],
  ] satisfies [Map<string, Set<string>>, Iterable<string | undefined>][]) {
    for (const key of keys) {
      if (key) {
        const values = map.get(key) ?? new Set<string>();
        if (deleting) {
          values.delete(id);
        } else {
          values.add(id);
        }
        if (values.size) {
          map.set(key, values);
        } else {
          map.delete(key);
        }
      }
    }
  }
}

export function changesRowStructure(row: Row, entry: Row["storedEntry"]): boolean {
  const previous = row.storedEntry;
  return (
    !previous ||
    !entry ||
    previous.sessionId !== entry.sessionId ||
    previous.lifecycleRevision !== entry.lifecycleRevision ||
    previous.parentSessionKey !== entry.parentSessionKey ||
    previous.spawnedBy !== entry.spawnedBy ||
    previous.incognito !== entry.incognito
  );
}

export function isCurrentGeneration(row: Row, current: Row | undefined): boolean {
  return (
    current?.generation === row.generation &&
    (!isIncognitoSessionKey(row.key) ||
      (current.entry?.sessionId === row.entry?.sessionId &&
        current.entry?.lifecycleRevision === row.entry?.lifecycleRevision))
  );
}

export function parentReference(
  cfg: Inputs["cfg"],
  key: string,
  fallbackAgentId: string,
  sourcePath?: string,
) {
  if (sourcePath && (key === "global" || key === "unknown")) {
    return physical(sourcePath, key);
  }
  const agentId = parseAgentSessionKey(key)?.agentId ?? fallbackAgentId;
  return logical(agentId, resolveStoredSessionKeyForAgentStore({ cfg, agentId, sessionKey: key }));
}
