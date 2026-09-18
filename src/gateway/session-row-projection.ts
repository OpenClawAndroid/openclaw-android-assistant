import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import {
  loadCombinedSessionStoreForGatewayCore,
  projectGatewaySessionEntry,
} from "../config/sessions/combined-store-gateway.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import {
  listSessionEntriesReadOnly,
  resolveSessionKeyBySessionId,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { listOpenIncognitoAgentDatabases } from "../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { retainUserProfileCatalog } from "../state/user-profile-list.js";
import { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { yieldSessionListWork } from "./session-projection-work.js";
import { withPreparedSessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { createSessionRowProjectionCatalog } from "./session-row-projection-catalog.js";
import { createSessionRowProjectionContext } from "./session-row-projection-context.js";
import {
  createSessionRowMaterializationBatch,
  readResidentSessionRow,
  readSessionRowEntry,
} from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowProjectionTranscriptUpdates } from "./session-row-projection-transcript.js";
import {
  matchesSessionRowScope,
  prepareSessionRowScopes,
  selectMatchingSessionRows,
} from "./session-row-scope.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";

/** Committed publications own invalidation; each admitted physical store is hydrated once. */
export async function createSessionRowProjection(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  modelCatalog?: records.Inputs["modelCatalog"];
  getModelCatalog?: () => Promise<records.Inputs["modelCatalog"]>;
  context?: Parameters<typeof readSessionRowFacts>[0]["context"];
  placementFactsReader?: Parameters<typeof readSessionRowFacts>[0]["placementFactsReader"];
}) {
  // Publications may borrow startup admission; projection work retains its own authority.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let cfg = params.cfg;
  const rows = new Map<string, records.Row>();
  let stores = new Map<
    string,
    { target: SessionStoreTarget; agentId: string; identity: string | symbol; filename: string }
  >();
  const byStore = new Map<string, Set<string>>(),
    byAgent = new Map<string, Set<string>>();
  const byParent = new Map<string, Set<string>>(),
    byKey = new Map<string, Set<string>>();
  const indexes = { byStore, byAgent, byParent, byKey };
  const dirty = new Set<string>();
  let topologyDirty = true,
    disposed = false;
  let epoch = 0;
  let materializedCount = 0;
  let scope: ReturnType<typeof prepareSessionRowScopes>;
  let pending: Promise<void> | undefined;
  const catalog = createSessionRowProjectionCatalog({
    modelCatalog: params.modelCatalog,
    getModelCatalog: params.getModelCatalog,
    onInvalidated: () => mark({ all: true, scope: "catalog" }),
    onRefreshed(adopted) {
      if (adopted) {
        // Rows served during renewal used the previous catalog and must be presented again.
        epoch++;
        for (const id of rows.keys()) {
          dirty.add(id);
        }
      }
      void ensureMaterialized().catch(() => {});
    },
  });
  const metadata = createSessionRowProjectionContext();
  const backfill = createSessionRowProjectionBackfill({
    ready: ensureMaterialized,
    read: (id) => rows.get(id),
    current: (row) => !topologyDirty && isCurrent(row),
    publish(row, fields) {
      const current = rows.get(records.identity(row));
      if (
        current &&
        (current.lastMessagePreview !== fields.lastMessagePreview ||
          !isDeepStrictEqual(current.fallbackModel, fields.fallbackModel))
      ) {
        Object.assign(current, {
          lastMessagePreview: fields.lastMessagePreview,
          fallbackModel: fields.fallbackModel,
        });
        dirty.add(records.identity(current));
        void ensureMaterialized().catch(() => {});
      }
    },
  });
  function remove(id: string) {
    transcriptUpdates.remove(id);
    const row = rows.get(id);
    if (row) {
      records.markRelated(row, indexes, dirty);
      records.index(row, indexes, true);
      rows.delete(id);
    }
    dirty.delete(id);
    backfill.remove(id);
  }
  function put(row: records.Row) {
    const previous = rows.get(records.identity(row));
    if (previous) {
      if (previous.generation !== row.generation) {
        transcriptUpdates.remove(records.identity(row));
      }
      records.index(previous, indexes, true);
    }
    rows.set(records.identity(row), row);
    records.index(row, indexes);
  }
  function acquireEntry(row: records.Row, storedEntry: SessionEntry | undefined) {
    if (!storedEntry || storedEntry.incognito) {
      remove(records.identity(row));
      return undefined;
    }
    const entry = projectGatewaySessionEntry(cfg, storedEntry);
    const parents = new Set(
      [
        storedEntry.parentSessionKey ?? resolveSessionParentSessionKey(row.key),
        storedEntry.spawnedBy,
        ...(metadata.current.subagentRunsByChildSessionKey.get(row.key) ?? []).map(
          (run) => run.controllerSessionKey || run.requesterSessionKey,
        ),
      ].flatMap((key) =>
        key && key !== row.key
          ? [records.parentReference(cfg, key, row.agentId, row.storeTarget.storePath)]
          : [],
      ),
    );
    const changed = !isDeepStrictEqual([storedEntry, parents], [row.storedEntry, row.parents]);
    if (changed) {
      records.markRelated(row, indexes, dirty);
    }
    const generation =
      !row.entry ||
      (row.entry.sessionId === entry.sessionId &&
        row.entry.lifecycleRevision === entry.lifecycleRevision)
        ? row.generation
        : Symbol("row");
    const next = {
      ...row,
      storedEntry,
      entry,
      parents,
      generation,
      fallbackModel: records.sameFallbackModelFacts(row.storedEntry, storedEntry)
        ? row.fallbackModel
        : undefined,
      ...(generation !== row.generation
        ? { lastMessagePreview: undefined, fallbackModel: undefined, materialized: undefined }
        : {}),
    };
    put(next);
    if (changed) {
      records.markRelated(next, indexes, dirty);
    }
    return next;
  }
  function matching(query: records.Query, kind = "key") {
    return selectMatchingSessionRows({ rows, indexes, scope }, query, kind);
  }
  function lookup(query: records.Lookup) {
    if (disposed) {
      return undefined;
    }
    const { agentId } = query;
    const exact = matching(query).filter((row) => row.agentId === agentId);
    if (exact.length) {
      return records.first(exact, stores.keys());
    }
    const key = resolveStoredSessionKeyForAgentStore({
      cfg,
      sessionKey: query.key,
      agentId,
    });
    if (isIncognitoSessionKey(key)) {
      const ephemeralPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
      if (!listOpenIncognitoAgentDatabases().some((store) => store.storePath === ephemeralPath)) {
        return undefined;
      }
      const row = records.create({
        key,
        agentId,
        storeTarget: { agentId, storePath: ephemeralPath },
      });
      const storedEntry = readSessionRowEntry(row);
      return storedEntry
        ? Object.assign(row, { storedEntry, entry: projectGatewaySessionEntry(cfg, storedEntry) })
        : undefined;
    }
    const candidates = matching({ ...query, key }).filter((row) => row.agentId === agentId);
    return records.first(candidates, stores.keys());
  }
  function referenced(ref: string) {
    return records.first(
      [...(byKey.get(ref) ?? [])].flatMap((id) => rows.get(id) ?? []),
      stores.keys(),
    );
  }
  function topology() {
    const revision = epoch;
    cfg = params.getConfig?.() ?? cfg;
    const admitted = new Set<string>();
    const nextStores: typeof stores = new Map();
    const replaced = new Set<string>();
    const loaded = loadCombinedSessionStoreForGatewayCore(cfg, {
      includeIncognito: false,
      preserveSentinelOwners: "physical",
      loadEntries(target, projection) {
        const opened = withOpenClawAgentDatabaseReadOnly(readOpenClawAgentDatabaseIdentity, {
          agentId: target.agentId,
          path: target.storePath,
        });
        if (!opened.found) {
          return [];
        }
        const databaseIdentity = opened.value.identity;
        const previous =
          stores.get(target.storePath) ??
          [...stores.values()].find((source) => source.identity === databaseIdentity);
        nextStores.set(target.storePath, {
          target,
          agentId: previous?.agentId ?? target.agentId,
          identity: databaseIdentity,
          filename: opened.value.filename,
        });
        if (previous?.identity === databaseIdentity) {
          return [...(byStore.get(previous.target.storePath) ?? [])].flatMap((id) => {
            const row = rows.get(id);
            const entry = row && (row.storedEntry ?? readSessionRowEntry(row));
            return row && entry ? [{ sessionKey: row.key, entry }] : [];
          });
        }
        replaced.add(target.storePath);
        return listSessionEntriesReadOnly({ ...target, projection, clone: false });
      },
      onStoreLoaded(target, agentId) {
        const source = nextStores.get(target.storePath);
        if (source) {
          source.agentId = agentId;
        }
      },
    });
    for (const [key, target] of loaded.targetsBySessionKey) {
      const entry = target.entry;
      if (!entry || entry.incognito || isIncognitoSessionKey(key)) {
        continue;
      }
      const fields = {
        key: target.storeKey ?? key,
        agentId: target.agentId,
        storeTarget: target.storeTarget,
      };
      const id = records.identity(fields);
      admitted.add(id);
      if (!rows.has(id) || replaced.has(target.storeTarget.storePath)) {
        remove(id);
        acquireEntry(records.create(fields), entry);
        dirty.add(id);
        backfill.enqueue(id);
      }
    }
    for (const id of rows.keys()) {
      if (!admitted.has(id)) {
        remove(id);
      }
    }
    stores = nextStores;
    scope = prepareSessionRowScopes(
      cfg,
      byAgent.keys(),
      new Map([...stores].map(([locator, source]) => [source.filename, locator])),
    );
    topologyDirty = epoch !== revision;
  }
  function mark(change: SessionRowChange) {
    epoch++;
    metadata.invalidate(change);
    if ("all" in change) {
      topologyDirty ||= change.scope === "stores" || change.scope === "config";
      if (change.scope === "catalog" || change.scope === "config") {
        catalog.invalidate();
      }
      for (const row of typeof change.scope === "string" ? rows.values() : matching(change.scope)) {
        dirty.add(records.identity(row));
        backfill.enqueue(records.identity(row), change);
      }
    } else if (change.scope === "automation") {
      records.markAutomation(matching({ key: change.sessionKey }), change.agentId, dirty);
    } else {
      const query = { ...change, key: change.sessionKey };
      const exact = matching(query);
      const found = new Set([...exact, ...matching(query, "id")]);
      for (const previous of found) {
        dirty.add(records.identity(previous));
        records.markRelated(previous, indexes, dirty);
        const row = inOwnerContext(() => {
          const entry = readSessionRowEntry(previous);
          return records.changesRowStructure(previous, entry)
            ? acquireEntry(previous, entry)
            : previous;
        });
        if (!row) {
          continue;
        }
        backfill.enqueue(records.identity(row));
      }
      if (
        !exact.length &&
        !isInternalSessionEffectsKey(change.sessionKey) &&
        !isIncognitoSessionKey(change.sessionKey)
      ) {
        for (const source of stores.values()) {
          const agentId = parseAgentSessionKey(change.sessionKey)?.agentId ?? source.agentId;
          const row = records.create({
            key: change.sessionKey,
            agentId,
            storeTarget: source.target,
          });
          if (
            !matchesSessionRowScope(row, change, scope) ||
            (!change.storePath && agentId !== source.agentId)
          ) {
            continue;
          }
          put(row);
          dirty.add(records.identity(row));
          if (!inOwnerContext(() => acquireEntry(row, readSessionRowEntry(row)))) {
            continue;
          }
          backfill.enqueue(records.identity(row));
        }
      }
    }
    // Dirty keys retain failed background work for the next reader.
    void ensureMaterialized().catch(() => {});
  }
  function materialize(
    row: records.Row,
    configuredAgentIds = new Set(listAgentIds(cfg)),
    readRow = readResidentSessionRow,
  ) {
    if (!row.entry) {
      return false;
    }
    const links = [...records.dependents(row, byParent)].flatMap((child) => {
      let value = rows.get(child);
      if (value && dirty.has(child)) {
        value = acquireEntry(value, readSessionRowEntry(value));
      }
      return value?.entry && [...value.parents].some((ref) => referenced(ref) === row)
        ? [{ key: value.key, entry: value.entry }]
        : [];
    });
    // Keyed child refreshes reorder the parent index; presentation must stay stable.
    links.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const prepared = readRow({
      row: { ...row, entry: row.entry },
      cfg,
      modelCatalog: catalog.current,
      configuredAgentIds,
      context: metadata.current,
      subagentInputs: metadata.subagentInputs,
      gatewayContext: params.context,
      placementFactsReader: params.placementFactsReader,
      links,
      readSourceEntry: (key) => {
        const source = referenced(
          records.parentReference(cfg, key, row.agentId, row.storeTarget.storePath),
        );
        return (
          source &&
          (dirty.has(records.identity(source)) ? readSessionRowEntry(source) : source.storedEntry)
        );
      },
    });
    if (!isIncognitoSessionKey(row.key) && rows.get(records.identity(row)) !== row) {
      return false;
    }
    Object.assign(row, prepared, { materializedSequence: ++materializedCount });
    return true;
  }
  function refresh(ids: readonly string[]) {
    if (disposed) {
      return;
    }
    const started = performance.now();
    metadata.prepare(epoch);
    const configuredAgentIds = new Set(listAgentIds(cfg));
    const readRow = createSessionRowMaterializationBatch();
    for (const [offset, id] of ids.entries()) {
      if (offset > 0 && performance.now() - started >= 12) {
        break;
      }
      const current = rows.get(id),
        revision = epoch;
      const row = current && acquireEntry(current, readSessionRowEntry(current));
      if (row && materialize(row, configuredAgentIds, readRow) && epoch === revision) {
        dirty.delete(id);
      }
      if (epoch !== revision) {
        break;
      }
    }
  }
  async function refreshBatch() {
    if (topologyDirty) {
      topology();
    }
    if (catalog.needsInitialRead) {
      await catalog.refresh();
    }
    withAgentRosterFactsBatch(cfg, () => {
      // Refresh can change dirty membership; snapshot only the next batch before consuming it.
      const ids: string[] = [];
      for (const id of dirty) {
        ids.push(id);
        if (ids.length === 64) {
          break;
        }
      }
      refresh(ids);
    });
  }
  function needsMaterialization() {
    return !disposed && (topologyDirty || catalog.needsInitialRead || dirty.size > 0);
  }
  async function drain() {
    while (needsMaterialization()) {
      await refreshBatch();
      if (dirty.size || topologyDirty) {
        await yieldSessionListWork();
      }
    }
  }
  function ensureMaterialized(): Promise<void> {
    if (!disposed && !catalog.needsInitialRead) {
      void inOwnerContext(() => catalog.refresh());
    }
    if (!needsMaterialization()) {
      return pending ?? Promise.resolve();
    }
    return (pending ??= yieldSessionListWork()
      .then(() => inOwnerContext(drain))
      .then(
        () => {
          pending = undefined;
          if (needsMaterialization()) {
            return ensureMaterialized();
          }
          return undefined;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      ));
  }
  const transcriptUpdates = createSessionRowProjectionTranscriptUpdates({
    matching,
    mark,
    read: (id) => rows.get(id),
    refresh(id) {
      epoch++;
      dirty.add(id);
      backfill.enqueue(id);
      void ensureMaterialized().catch(() => {});
    },
  });
  const stop = [
    retainUserProfileCatalog(),
    sessionChanges.subscribe(mark),
    onSessionLifecycleEvent(mark),
    onSessionIdentityMutation((mutation) => {
      for (const key of mutation.previous.sessionKeys) {
        for (const row of matching({ key, agentId: mutation.agentId })) {
          if (mutation.previous.sessionId && row.entry?.sessionId !== mutation.previous.sessionId) {
            continue;
          }
          records.markRelated(row, indexes, dirty);
          if ("current" in mutation && mutation.current.sessionKeys.includes(row.key)) {
            put({
              ...row,
              entry: undefined,
              storedEntry: undefined,
              materialized: undefined,
              lastMessagePreview: undefined,
              fallbackModel: undefined,
              generation: Symbol("row"),
            });
            dirty.add(records.identity(row));
          } else {
            remove(records.identity(row));
          }
        }
      }
      if ("current" in mutation) {
        for (const sessionKey of mutation.current.sessionKeys) {
          mark({ agentId: mutation.agentId, sessionKey });
        }
      } else {
        void ensureMaterialized().catch(() => {});
      }
    }),
  ];
  function isCurrent(row: records.Row) {
    const current = isIncognitoSessionKey(row.key)
      ? lookup({ ...row, storePath: row.storeTarget.storePath })
      : rows.get(records.identity(row));
    return records.isCurrentGeneration(row, current);
  }
  const describe = (query: records.Lookup, captured?: records.Row) =>
    inOwnerContext(() => {
      if (disposed) {
        return undefined;
      }
      if (topologyDirty) {
        topology();
      }
      let row = lookup(query);
      if (row && isIncognitoSessionKey(row.key)) {
        metadata.prepare(epoch);
        materialize(row);
      } else if (row && dirty.has(records.identity(row))) {
        // Keyed reads refresh only their owner; unrelated bulk work never gates a response.
        const id = records.identity(row);
        withAgentRosterFactsBatch(cfg, () => refresh([id]));
        row = lookup(query);
      }
      if (captured && !isCurrent(captured)) {
        return undefined;
      }
      return records.ready(row) ? row : undefined;
    });
  function dispose() {
    disposed = true;
    catalog.dispose();
    transcriptUpdates.dispose();
    backfill.dispose();
    for (const unsubscribe of stop) {
      unsubscribe();
    }
    for (const map of [rows, stores, byStore, byAgent, byParent, byKey]) {
      map.clear();
    }
    dirty.clear();
  }
  function selectEntries(query: records.Query = {}) {
    if (disposed) {
      return [];
    }
    return inOwnerContext(() => {
      if (topologyDirty) {
        inOwnerContext(topology);
      }
      const parent = query.parentSessionKey;
      const owner = parent && parseAgentSessionKey(parent)?.agentId;
      const agents = owner ? [owner] : query.agentId ? [query.agentId] : byAgent.keys();
      const children = new Set<string>();
      if (parent) {
        for (const ref of [
          ...[...agents].map((agentId) => records.parentReference(cfg, parent, agentId)),
          ...matching({ ...query, key: parent }).map((row) =>
            records.physical(row.storeTarget.storePath, parent),
          ),
        ]) {
          for (const id of byParent.get(ref) ?? []) {
            children.add(id);
          }
        }
      }
      return withAgentRosterFactsBatch(cfg, () => {
        const sessionIdOrKey = query.sessionIdOrKey;
        let keys: Set<string> | undefined;
        if (sessionIdOrKey) {
          // Broad publications can change IDs before the resident index has caught up.
          for (const id of dirty) {
            const row = rows.get(id);
            if (row && matchesSessionRowScope(row, query, scope, true)) {
              acquireEntry(row, readSessionRowEntry(row));
            }
          }
          const indexed = { ...query, key: sessionIdOrKey };
          keys = new Set([...matching(indexed, "id"), ...matching(indexed)].map((row) => row.key));
        }
        // Keep every physical competitor; federation precedes ID and visibility filtering.
        const candidates = keys
          ? [...keys].flatMap((key) => matching({ ...query, key }))
          : parent
            ? [...children].map((id) => rows.get(id))
            : matching(query);
        const selected = candidates
          .map((row) =>
            row && !sessionIdOrKey && dirty.has(records.identity(row))
              ? acquireEntry(row, readSessionRowEntry(row))
              : row,
          )
          .filter(records.hasEntry)
          .filter((row) => matchesSessionRowScope(row, query, scope, true));
        return records.sort(selected, query.sortBy);
      });
    });
  }
  await inOwnerContext(refreshBatch).catch((error: unknown) => {
    dispose();
    throw error;
  });
  void ensureMaterialized().catch(() => {});
  backfill.start();
  const projection = {
    capture(query: records.Lookup) {
      if (!disposed && topologyDirty) {
        inOwnerContext(topology);
      }
      const row = lookup(query);
      return row && dirty.has(records.identity(row))
        ? (acquireEntry(row, readSessionRowEntry(row)) ?? row)
        : row;
    },
    findBySessionId(query: { sessionId: string; agentId?: string; storePath?: string }) {
      if (
        !query.agentId ||
        !query.storePath ||
        !isIncognitoOpenClawAgentSqlitePath(query.storePath, { agentId: query.agentId })
      ) {
        return matching({ ...query, key: query.sessionId }, "id");
      }
      const key = !disposed && resolveSessionKeyBySessionId(query);
      const row = key ? lookup({ ...query, agentId: query.agentId, key }) : undefined;
      return row?.entry?.sessionId === query.sessionId ? [row] : [];
    },
    describe,
    present: (record: records.MaterializedRow, options?: records.SnapshotOptions) =>
      records.present(record, metadata.current, options),
    withPreparedExactRows<T>(
      queries: (config: OpenClawConfig) => readonly records.Lookup[],
      consume: (read: SessionRowReadView) => T,
    ): ReturnType<typeof withPreparedSessionRows<T>> {
      return withPreparedSessionRows(projection, () => !disposed, queries, consume);
    },
    ensureMaterialized,
    get materializedCount() {
      return materializedCount;
    },
    get dirtyRowCount() {
      return dirty.size;
    },
    get needsMaterialization() {
      return needsMaterialization();
    },
    get state() {
      if (!disposed && topologyDirty) {
        inOwnerContext(topology);
      }
      if (!disposed) {
        metadata.prepare(epoch);
      }
      return {
        cfg,
        modelCatalog: catalog.current,
        rowContext: metadata.current,
        scope: scope.select,
      };
    },
    isCurrent,
    selectEntries,
    select: (query: records.Query = {}) => selectEntries(query).filter(records.ready),
    snapshot(query: records.Lookup, options: records.SnapshotOptions = {}) {
      const record = describe(query);
      return record
        ? {
            row: records.present(record, metadata.current, options),
            lifecycleRunId: record.entry.lifecycleRunId,
          }
        : { row: null };
    },
    dispose,
  };
  return projection;
}

export type SessionRowProjection = Awaited<ReturnType<typeof createSessionRowProjection>>;
