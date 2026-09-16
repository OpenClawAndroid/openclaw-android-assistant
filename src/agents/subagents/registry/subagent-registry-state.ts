import { isVitestRuntimeEnv } from "../../../infra/env.js";
import {
  emitSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../../sessions/session-lifecycle-events.js";
import { runOutsideAsyncWorkScope } from "../../../shared/async-work-scope.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  projectSubagentRunForMaintenance,
  projectSubagentRunForSessionList,
} from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
/**
 * Subagent registry state persistence bridge.
 *
 * Merges live runs with retained SQLite rows under the process-local registry owner.
 */
import {
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite,
  loadSubagentRunsForSessionFromSqlite,
  loadSubagentRunsByRunIdsFromSqlite,
  loadSubagentRegistryFromSqlite,
  loadSubagentMaintenanceRunsFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
  loadSubagentRunsForSessionsFromSqlite,
  saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import { collectSubagentSessionReadKeys } from "./subagent-session-read-scope.js";

type SubagentRunsCacheFill<T extends SubagentRunReadRecord> = {
  promise: Promise<void>;
  fallbackState?: SubagentRunsCacheState<T>;
};

type SubagentRunsCacheState<T extends SubagentRunReadRecord> = (
  | { snapshot: Map<string, T>; changes?: never }
  | { snapshot?: undefined; changes?: Map<string, T | undefined> }
) & {
  context?: OpenClawStateWorkerContext;
  pending?: SubagentRunsCacheFill<T>;
};

type SubagentRunsCache<T extends SubagentRunReadRecord> = {
  state: SubagentRunsCacheState<T>;
  captureContext?: () => OpenClawStateWorkerContext;
  load: () => Map<string, T>;
  copy: (entry: SubagentRunRecord) => T;
  project: (entry: SubagentRunRecord) => T;
};

const persistedSubagentRunsReadCache: SubagentRunsCache<SubagentRunRecord> = {
  state: {},
  load: loadSubagentRegistryFromSqlite,
  copy: structuredClone,
  project: (entry) => entry,
};
const persistedSubagentSessionListRunsReadCache: SubagentRunsCache<SubagentRunReadRecord> = {
  state: {},
  captureContext: captureOpenClawStateWorkerContext,
  load: () => loadSubagentSessionListRunsFromSqlite(),
  copy: projectSubagentRunForSessionList,
  project: projectSubagentRunForSessionList,
};
const persistedSubagentMaintenanceRunsReadCache: SubagentRunsCache<SubagentRunMaintenanceRecord> = {
  state: {},
  load: () => loadSubagentMaintenanceRunsFromSqlite(),
  copy: projectSubagentRunForMaintenance,
  project: projectSubagentRunForMaintenance,
};

// Read caches deliberately advance on failed best-effort writes. Keep notification facts
// commit-owned so a successful retry still refreshes the parent, including after archive.
const committedSwarmNotifications = new Map<
  string,
  { event: SessionLifecycleEvent; signature: string }
>();

function swarmNotification(entry: SubagentRunRecord | undefined) {
  if (
    !entry?.collect ||
    !entry.swarmRequesterSessionKey ||
    !entry.requesterAgentId ||
    !entry.groupId
  ) {
    return undefined;
  }
  return {
    event: {
      sessionKey: entry.swarmRequesterSessionKey,
      agentId: entry.requesterAgentId,
      reason: "swarm",
    },
    // Compare the summary's raw inputs, never child results, labels or error text.
    signature: JSON.stringify([
      entry.swarmRequesterSessionKey,
      entry.requesterAgentId,
      entry.groupId,
      entry.createdAt,
      entry.childSessionKey,
      entry.execution.status,
      entry.collectorCompletion?.status,
    ]),
  };
}

function updateCommittedSwarmNotifications(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
): SessionLifecycleEvent[] {
  const events = new Map<string, SessionLifecycleEvent>();
  const ids = changedRunIds ?? new Set([...committedSwarmNotifications.keys(), ...runs.keys()]);
  for (const runId of ids) {
    const previous = committedSwarmNotifications.get(runId);
    const next = swarmNotification(runs.get(runId));
    if (previous?.signature === next?.signature) {
      continue;
    }
    if (next) {
      committedSwarmNotifications.set(runId, next);
    } else {
      committedSwarmNotifications.delete(runId);
    }
    for (const notification of [previous, next]) {
      if (notification) {
        const event = notification.event;
        events.set(JSON.stringify([event.sessionKey, event.agentId]), event);
      }
    }
  }
  return [...events.values()];
}

type SubagentRegistryPersistListener = () => void;

const SUBAGENT_REGISTRY_PERSIST_LISTENERS = new Set<SubagentRegistryPersistListener>();

function emitSubagentRegistryPersisted(): void {
  for (const listener of SUBAGENT_REGISTRY_PERSIST_LISTENERS) {
    try {
      listener();
    } catch {
      // Persistence already succeeded; observers are best-effort.
    }
  }
}

/** Wake process-local readers after a registry mutation, even if persistence failed. */
export function onSubagentRegistryPersisted(listener: SubagentRegistryPersistListener): () => void {
  SUBAGENT_REGISTRY_PERSIST_LISTENERS.add(listener);
  return () => {
    SUBAGENT_REGISTRY_PERSIST_LISTENERS.delete(listener);
  };
}

function matchesSubagentCacheContext(
  previous: OpenClawStateWorkerContext | undefined,
  current: OpenClawStateWorkerContext | undefined,
): boolean {
  if (!previous) {
    return true;
  }
  if (
    !current ||
    previous.admission.identity.key !== current.admission.identity.key ||
    previous.maintenanceScope !== current.maintenanceScope
  ) {
    return false;
  }
  try {
    previous.admission.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

function applySubagentRunChanges<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
  changes: Map<string, T | undefined> | undefined,
): Map<string, T> {
  for (const [runId, entry] of changes ?? []) {
    if (entry) {
      runs.set(runId, entry);
    } else {
      runs.delete(runId);
    }
  }
  return runs;
}

function rememberSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
): void {
  let context: OpenClawStateWorkerContext | undefined;
  try {
    context = cache.captureContext?.();
  } catch (error) {
    if (!isStateDatabaseReadAdmissionInvalidatedError(error)) {
      throw error;
    }
    // Read retirement cannot turn committed or best-effort publication into a write failure.
    cache.state = {};
    return;
  }
  const previous = matchesSubagentCacheContext(cache.state.context, context) ? cache.state : {};
  const snapshot = previous.snapshot;
  if (!changedRunIds) {
    cache.state = {
      snapshot: new Map([...runs].map(([runId, entry]) => [runId, cache.copy(entry)])),
      context,
    };
    return;
  }
  if (!snapshot) {
    // Until the first full read, named writes cannot account for durable-only rows.
    const changes = previous.changes ?? new Map<string, T | undefined>();
    for (const runId of changedRunIds) {
      const entry = runs.get(runId);
      changes.set(runId, entry ? cache.copy(entry) : undefined);
    }
    // Named deltas keep pending and failed-fill waiters in the same cache cohort.
    previous.changes = changes;
    previous.context = context;
    cache.state = previous;
    return;
  }
  for (const runId of new Set(changedRunIds)) {
    const entry = runs.get(runId);
    if (entry) {
      snapshot.set(runId, cache.copy(entry));
    } else {
      snapshot.delete(runId);
    }
  }
  cache.state = { snapshot, context };
}

function rememberPersistedSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
): void {
  for (const cache of [
    persistedSubagentRunsReadCache,
    persistedSubagentSessionListRunsReadCache,
    persistedSubagentMaintenanceRunsReadCache,
  ]) {
    rememberSubagentRunsSnapshot(cache, runs, changedRunIds);
  }
}

/** Publishes registry rows already committed by a cross-owner shared-state transaction. */
export function publishSubagentRunsAfterAtomicStore(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
  deferredObserverEvents: Array<() => void>,
): void {
  rememberPersistedSubagentRunsSnapshot(runs, changedRunIds);
  const events = updateCommittedSwarmNotifications(runs, changedRunIds);
  deferredObserverEvents.push(() => {
    emitSubagentRegistryPersisted();
    events.forEach(emitSessionLifecycleEvent);
  });
}

function shouldReadPersistedSubagentRuns(): boolean {
  return !isVitestRuntimeEnv() || process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE === "1";
}

function getPersistedSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  context = cache.captureContext?.(),
): Map<string, T> | null {
  if (!matchesSubagentCacheContext(cache.state.context, context)) {
    cache.state = { context };
    return null;
  }
  return cache.state.snapshot ?? null;
}

function loadPersistedSubagentRunsForRead<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
): Map<string, T> {
  const cached = getPersistedSubagentRunsSnapshot(cache);
  if (cached) {
    return cached;
  }
  const runs = applySubagentRunChanges(cache.load(), cache.state.changes);
  cache.state = { snapshot: runs, context: cache.captureContext?.() };
  return runs;
}

export function clearSubagentRunsReadCacheForTest(): void {
  committedSwarmNotifications.clear();
  persistedSubagentRunsReadCache.state = {};
  persistedSubagentSessionListRunsReadCache.state = {};
  persistedSubagentMaintenanceRunsReadCache.state = {};
}

function persistSubagentRuns(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  strict: boolean,
): void {
  let committed = false;
  try {
    if (changedRunIds) {
      saveSubagentRegistryChangesToSqlite(runs, changedRunIds);
    } else {
      saveSubagentRegistryToSqlite(runs);
    }
    committed = true;
  } catch (error) {
    if (strict) {
      throw error;
    }
  }
  // In-process readers must observe the authoritative memory snapshot before the wake.
  rememberPersistedSubagentRunsSnapshot(runs, changedRunIds);
  const events = committed ? updateCommittedSwarmNotifications(runs, changedRunIds) : [];
  emitSubagentRegistryPersisted();
  events.forEach(emitSessionLifecycleEvent);
}

export function persistSubagentRunsToDisk(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, false);
}

export function persistSubagentRunsToDiskOrThrow(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, true);
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromSqlite();
  rememberPersistedSubagentRunsSnapshot(restored);
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    const notification = swarmNotification(entry);
    if (notification) {
      committedSwarmNotifications.set(runId, notification);
    } else {
      committedSwarmNotifications.delete(runId);
    }
    subagentRuns.commitOwnership(entry);
    added += 1;
  }
  emitSubagentRegistryPersisted();
  return added;
}

function getSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<T>,
  scope?: {
    load?: () => Iterable<T>;
    fresh?: boolean;
    borrowPersisted?: boolean;
    matches: (entry: SubagentRunReadRecord) => boolean;
  },
): Map<string, T> {
  const merged = new Map<string, T>();
  if (shouldReadPersistedSubagentRuns()) {
    try {
      // Scoped reads use indexed SQL until a complete owner snapshot is available.
      const cached = scope?.load && !scope.fresh ? getPersistedSubagentRunsSnapshot(cache) : null;
      const persisted = scope?.load
        ? (cached?.values() ?? scope.load())
        : loadPersistedSubagentRunsForRead(cache).values();
      for (const entry of persisted) {
        if (!scope || scope.matches(entry)) {
          merged.set(
            entry.runId,
            scope?.load && !scope.borrowPersisted ? structuredClone(entry) : entry,
          );
        }
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  if (shouldReadPersistedSubagentRuns()) {
    for (const [runId, entry] of cache.state.changes ?? []) {
      if (entry && (!scope || scope.matches(entry))) {
        merged.set(runId, scope?.load && !scope.borrowPersisted ? structuredClone(entry) : entry);
      } else {
        merged.delete(runId);
      }
    }
  }
  for (const [runId, entry] of inMemoryRuns) {
    if (!scope || scope.matches(entry)) {
      merged.set(runId, cache.project(entry));
    } else {
      // Live memory wins even when a run moved out of the persisted scope.
      merged.delete(runId);
    }
  }
  return merged;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache);
}

export function getSubagentMaintenanceRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunMaintenanceRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentMaintenanceRunsReadCache);
}

export function getSubagentRunsSnapshotForRunIds(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  runIds: readonly string[],
): Map<string, SubagentRunRecord> {
  const requested = new Set(runIds.map((runId) => runId.trim()));
  if (requested.size === 0) {
    return new Map();
  }
  const matches = (entry: SubagentRunReadRecord) =>
    requested.has(entry.runId) || Boolean(entry.swarmRunId && requested.has(entry.swarmRunId));
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    load: () => {
      const readSelected = () => {
        const projection = loadPersistedSubagentRunsForRead(
          persistedSubagentSessionListRunsReadCache,
        );
        const physicalRunIds = [...projection.values()].filter(matches).map((entry) => entry.runId);
        return { physicalRunIds, entries: loadSubagentRunsByRunIdsFromSqlite(physicalRunIds) };
      };
      let selected = readSelected();
      if (
        selected.entries.length !== selected.physicalRunIds.length ||
        selected.entries.some((entry) => !matches(entry))
      ) {
        // Another process may replace a physical row while preserving its stable collector id.
        persistedSubagentSessionListRunsReadCache.state = {};
        selected = readSelected();
      }
      return selected.entries;
    },
    matches,
  });
}

/** Fence pending reads when live registry ownership changes without a store publication. */
export function invalidateSubagentSessionListReadCache(): void {
  const cache = persistedSubagentSessionListRunsReadCache;
  const { pending: _pending, ...current } = cache.state;
  cache.state = current;
}

/** Consume accepted persisted rows and current memory in the same continuation. */
export async function withSubagentSessionListRunsSnapshotForRead<T>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  context: OpenClawStateWorkerContext,
  read: (runs: Map<string, SubagentRunReadRecord>) => T,
  yieldIfNeeded?: () => Promise<void> | undefined,
): Promise<T> {
  const cache = persistedSubagentSessionListRunsReadCache;
  const consume = (persisted?: Map<string, SubagentRunReadRecord>) => {
    const merged = applySubagentRunChanges(new Map(persisted), cache.state.changes);
    for (const [runId, entry] of inMemoryRuns) {
      merged.set(runId, cache.project(entry));
    }
    return read(merged);
  };
  const readPersisted = shouldReadPersistedSubagentRuns();
  const assertCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  let waiting = false;
  let settledFill: SubagentRunsCacheFill<SubagentRunReadRecord> | undefined;
  while (true) {
    // Yield before acceptance so persisted rows and live ownership stay in one continuation.
    const pause = yieldIfNeeded?.();
    if (pause) {
      await pause;
      // Another resumed caller may have spent the shared slice before this continuation.
      continue;
    }
    if (!readPersisted) {
      return read(new Map([...inMemoryRuns].map(([id, entry]) => [id, cache.project(entry)])));
    }
    assertCurrent();
    let state = cache.state;
    if (!matchesSubagentCacheContext(state.context, context)) {
      if (
        waiting &&
        state.context &&
        (state.context.admission.identity.key !== context.admission.identity.key ||
          state.context.maintenanceScope !== context.maintenanceScope)
      ) {
        throw new Error("Subagent session-list database owner changed during the read");
      }
      cache.state = state = { context };
    }
    const persisted = getPersistedSubagentRunsSnapshot(cache, context);
    if (persisted) {
      return consume(persisted);
    }
    // Existing waiters share a failed/absent read; a later independent call can retry.
    if (cache.state === settledFill?.fallbackState) {
      return consume();
    }
    if (!state.pending) {
      state.context = context;
      const fill: SubagentRunsCacheFill<SubagentRunReadRecord> = {
        promise: runOutsideAsyncWorkScope(() =>
          import("../../../state/openclaw-state-worker-store.js").then(
            ({ runOpenClawStateWorkerOperation }) =>
              runOpenClawStateWorkerOperation(
                context,
                async (worker) => {
                  const runs = await worker.execute({
                    type: "subagents.sessionList",
                    input: undefined,
                  });
                  assertCurrent();
                  if (cache.state.pending !== fill) {
                    return;
                  }
                  cache.state = {
                    snapshot: applySubagentRunChanges(runs ?? new Map(), cache.state.changes),
                    context,
                  };
                },
                { existingOnly: true },
              ),
          ),
        ),
      };
      state.pending = fill;
    }
    const fill = state.pending;
    waiting = true;
    try {
      await fill.promise;
    } catch {
      // Existing waiters share the fallback below; a later read can retry.
    }
    assertCurrent();
    if (cache.state.pending === fill) {
      cache.state.pending = undefined;
      fill.fallbackState = cache.state;
    }
    settledFill = fill;
  }
}

export function getSubagentSessionListRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKeys?: readonly string[],
): Map<string, SubagentRunReadRecord> {
  if (controllerSessionKeys) {
    const keys = new Set(controllerSessionKeys.map((key) => key.trim()).filter(Boolean));
    if (keys.size === 0) {
      return new Map();
    }
    return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentSessionListRunsReadCache, {
      load: () => loadSubagentSessionListRunsFromSqlite([...keys]).values(),
      matches: (entry) => keys.has(entry.controllerSessionKey?.trim() || entry.requesterSessionKey),
    });
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentSessionListRunsReadCache);
}

function getSubagentSessionTreeSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
  cache: SubagentRunsCache<T>,
  load: () => { sessionKeys: Set<string>; runs: Map<string, T>; complete: boolean },
): Map<string, T> {
  if (!sessionKeys.some((key) => key.trim())) {
    return new Map();
  }
  const cached = shouldReadPersistedSubagentRuns() ? getPersistedSubagentRunsSnapshot(cache) : null;
  let selected = collectSubagentSessionReadKeys(
    sessionKeys,
    cached?.values() ?? [],
    inMemoryRuns.values(),
  );
  return getSubagentRunsSnapshot(inMemoryRuns, cache, {
    // The loader owns cache selection so topology and metadata use the same source.
    fresh: true,
    // Descendant queries only inspect records, matching their unscoped snapshots.
    borrowPersisted: true,
    load: () => {
      if (cached) {
        return cached.values();
      }
      const snapshot = load();
      // A tree covering every physical row may populate the existing full cache.
      if (snapshot.complete) {
        applySubagentRunChanges(snapshot.runs, cache.state.changes);
        snapshot.sessionKeys = collectSubagentSessionReadKeys(
          sessionKeys,
          snapshot.runs.values(),
          inMemoryRuns.values(),
        );
        cache.state = {
          snapshot: snapshot.runs,
          context: cache.captureContext?.(),
        };
      }
      selected = snapshot.sessionKeys;
      return snapshot.runs.values();
    },
    matches: (entry) => selected.has(entry.childSessionKey.trim()),
  });
}

/** Exact rows share the owner snapshot while projecting only their complete requester trees. */
export function getSubagentSessionListRunsSnapshotForSessions(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
): Map<string, SubagentRunReadRecord> {
  return getSubagentSessionTreeSnapshot(
    inMemoryRuns,
    sessionKeys,
    persistedSubagentSessionListRunsReadCache,
    () => loadSubagentRunsForSessionsFromSqlite(sessionKeys, inMemoryRuns.values(), "session-list"),
  );
}

/** Settlement reads retain the canonical codec and raw local reservation ownership. */
export function getSubagentRunsSnapshotForSessions(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
): Map<string, SubagentRunRecord> {
  return getSubagentSessionTreeSnapshot(
    inMemoryRuns,
    sessionKeys,
    persistedSubagentRunsReadCache,
    () => loadSubagentRunsForSessionsFromSqlite(sessionKeys, inMemoryRuns.values(), "full"),
  );
}

export function getSubagentRunsSnapshotForController(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = controllerSessionKey.trim();
  if (!key) {
    return new Map();
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    load: () => loadSubagentRunsForControllerFromSqlite(key),
    matches: (entry) => (entry.controllerSessionKey?.trim() || entry.requesterSessionKey) === key,
  });
}

/** Current-turn results use the owner snapshot or hydrate only their scoped payloads. */
export function getSubagentRunsSnapshotForSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = sessionKey.trim();
  if (!key) {
    return new Map();
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    load: () => loadSubagentRunsForSessionFromSqlite(key),
    matches: (entry) =>
      entry.controllerSessionKey?.trim() === key || entry.requesterSessionKey.trim() === key,
  });
}

export function getSubagentRunsSnapshotForChildSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = childSessionKey.trim();
  if (!key) {
    return new Map();
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    load: () => loadSubagentRunsForChildSessionFromSqlite(key),
    matches: (entry) => entry.childSessionKey === key,
  });
}
