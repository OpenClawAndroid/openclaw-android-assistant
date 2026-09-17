import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { registerPreparedModelRuntimePublicationListener } from "../agents/prepared-model-runtime.publication-events.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
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
import { buildProjectedAgentRunIndex } from "../infra/agent-run-registry.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { listOpenIncognitoAgentDatabases } from "../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { retainUserProfileCatalog } from "../state/user-profile-list.js";
import { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { compareSessionEntryPairs } from "./session-list-order.js";
import { yieldSessionListWork } from "./session-projection-work.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import {
  readResidentSessionRow,
  readSessionRowEntry,
} from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";
import { prepareSessionRowScopes } from "./session-row-scope.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { resolveDeletedAgentIdFromSessionKey } from "./session-utils-store.js";

/** Committed publications own invalidation; each admitted physical store is hydrated once. */
export async function createSessionRowProjection(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  modelCatalog?: records.Inputs["modelCatalog"];
  getModelCatalog?: () => Promise<records.Inputs["modelCatalog"]>;
  context?: Parameters<typeof readSessionRowFacts>[0]["context"];
}) {
  // Publications may borrow startup admission; projection work retains its own authority.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let cfg = params.cfg;
  let modelCatalog = params.modelCatalog;
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
    catalogDirty = params.getModelCatalog ? Symbol("catalog") : undefined,
    disposed = false;
  let epoch = 0,
    preparedEpoch = -1;
  let materializedCount = 0;
  let scope: ReturnType<typeof prepareSessionRowScopes>;
  let pending: Promise<void> | undefined;
  let context = buildSessionListRowMetadataContext({ now: Date.now() });
  const subagentInputs = context.subagentRuns.inputs;
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
  function dependents(row: records.Row) {
    return new Set(records.references(row).flatMap((ref) => Array.from(byParent.get(ref) ?? [])));
  }
  function related(row: records.Row) {
    for (const id of dependents(row)) {
      dirty.add(id);
    }
    for (const parent of row.parents) {
      for (const id of byKey.get(parent) ?? []) {
        dirty.add(id);
      }
    }
  }
  function remove(id: string) {
    const row = rows.get(id);
    if (row) {
      related(row);
      records.index(row, indexes, true);
      rows.delete(id);
    }
    dirty.delete(id);
    backfill.remove(id);
  }
  function put(row: records.Row) {
    const previous = rows.get(records.identity(row));
    if (previous) {
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
        ...(context.subagentRunsByChildSessionKey.get(row.key) ?? []).map(
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
      related(row);
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
      related(next);
    }
    return next;
  }
  function inScope(row: records.Row, query: records.Query) {
    return (
      (!query.agentId ||
        row.agentId === query.agentId ||
        row.storeTarget.agentId === query.agentId) &&
      (!query.storePath ||
        (scope?.physicalPaths(query.storePath, query.agentId) ?? [query.storePath]).includes(
          row.storeTarget.storePath,
        ))
    );
  }
  function matching(query: records.Query, kind = "key") {
    const candidates = query.key
      ? byKey.get(`${kind}:${query.key}`)
      : query.storePath
        ? new Set(
            (scope?.physicalPaths(query.storePath, query.agentId) ?? [query.storePath]).flatMap(
              (path) => Array.from(byStore.get(path) ?? []),
            ),
          )
        : query.agentId
          ? byAgent.get(query.agentId)
          : rows.keys();
    return [...(candidates ?? [])]
      .map((id) => rows.get(id))
      .filter((row): row is records.Row => row !== undefined && inScope(row, query));
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
        if (replaced.has(target.storeTarget.storePath) && isAcpSessionKey(fields.key)) {
          // Retain partial ACP-key migration at physical admission, never on a clean read.
          resolveDeletedAgentIdFromSessionKey(cfg, fields.key, entry, {
            acpMetadataSessionKey: fields.key,
          });
        }
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
    if ("all" in change) {
      if (change.scope === "profiles") {
        context.userProfileIdentityById.clear();
      }
      topologyDirty ||= change.scope === "stores" || change.scope === "config";
      if (params.getModelCatalog && (change.scope === "catalog" || change.scope === "config")) {
        catalogDirty = Symbol("catalog");
      }
      for (const row of typeof change.scope === "string" ? rows.values() : matching(change.scope)) {
        dirty.add(records.identity(row));
        backfill.enqueue(records.identity(row), change);
      }
    } else {
      const query = { ...change, key: change.sessionKey };
      const exact = matching(query);
      const found = new Set([...exact, ...matching(query, "id")]);
      for (const previous of found) {
        dirty.add(records.identity(previous));
        related(previous);
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
          if (!inScope(row, change) || (!change.storePath && agentId !== source.agentId)) {
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
    void ensureMaterialized().catch(() => {
      /* Dirty keys retain failed background work for the next reader. */
    });
  }
  function prepare() {
    if (preparedEpoch === epoch) {
      return;
    }
    context = buildSessionListRowMetadataContext({
      now: Date.now(),
      subagentRuns: buildSubagentSessionListReadIndex(),
      userProfileIdentityById: context.userProfileIdentityById,
    });
    context.projectedAgentRuns = buildProjectedAgentRunIndex();
    Object.assign(subagentInputs, context.subagentRuns.inputs);
    preparedEpoch = epoch;
  }
  function materialize(row: records.Row, configuredAgentIds = new Set(listAgentIds(cfg))) {
    if (!row.entry) {
      return false;
    }
    const links = [...dependents(row)].flatMap((child) => {
      let value = rows.get(child);
      if (value && dirty.has(child)) {
        value = acquireEntry(value, readSessionRowEntry(value));
      }
      return value?.entry && [...value.parents].some((ref) => referenced(ref) === row)
        ? [{ key: value.key, entry: value.entry }]
        : [];
    });
    const prepared = readResidentSessionRow({
      row: { ...row, entry: row.entry },
      cfg,
      modelCatalog,
      configuredAgentIds,
      context,
      subagentInputs,
      gatewayContext: params.context,
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
    prepare();
    const configuredAgentIds = new Set(listAgentIds(cfg));
    for (const [offset, id] of ids.entries()) {
      if (offset > 0 && performance.now() - started >= 12) {
        break;
      }
      const current = rows.get(id),
        revision = epoch;
      const row = current && acquireEntry(current, readSessionRowEntry(current));
      if (row && materialize(row, configuredAgentIds) && epoch === revision && !catalogDirty) {
        dirty.delete(id);
      }
    }
  }
  async function refreshBatch() {
    if (topologyDirty) {
      topology();
    }
    if (catalogDirty) {
      const revision = catalogDirty;
      const next = await params.getModelCatalog?.();
      if (disposed || catalogDirty !== revision) {
        return;
      }
      modelCatalog = next;
      catalogDirty = undefined;
    }
    withAgentRosterFactsBatch(cfg, () => refresh([...dirty].slice(0, 64)));
  }
  async function drain() {
    for (;;) {
      if (disposed || (!topologyDirty && !catalogDirty && !dirty.size)) {
        return;
      }
      await refreshBatch();
      if (dirty.size || topologyDirty) {
        await yieldSessionListWork();
      }
    }
  }
  function ensureMaterialized(): Promise<void> {
    if (disposed || (!topologyDirty && !catalogDirty && !dirty.size)) {
      return pending ?? Promise.resolve();
    }
    return (pending ??= yieldSessionListWork()
      .then(() => inOwnerContext(drain))
      .then(
        () => {
          pending = undefined;
          if (!disposed && (topologyDirty || catalogDirty || dirty.size)) {
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
  const stop = [
    retainUserProfileCatalog(),
    sessionChanges.subscribe(mark),
    onSessionLifecycleEvent(mark),
    registerPreparedModelRuntimePublicationListener(() => mark({ all: true, scope: "catalog" })),
    onInternalSessionTranscriptUpdate((update) => {
      if (update.target) {
        mark(update.target);
      }
    }),
    onSessionIdentityMutation((mutation) => {
      for (const key of mutation.previous.sessionKeys) {
        for (const row of matching({ key, agentId: mutation.agentId })) {
          if (mutation.previous.sessionId && row.entry?.sessionId !== mutation.previous.sessionId) {
            continue;
          }
          related(row);
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
        prepare();
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
      const candidates = parent ? [...children].map((id) => rows.get(id)) : matching(query);
      return withAgentRosterFactsBatch(cfg, () =>
        candidates
          .map((row) =>
            row && dirty.has(records.identity(row))
              ? acquireEntry(row, readSessionRowEntry(row))
              : row,
          )
          .filter(records.hasEntry)
          .filter((row) => inScope(row, query) && (!query.agentId || row.agentId === query.agentId))
          .toSorted((a, b) =>
            compareSessionEntryPairs([a.key, a.entry], [b.key, b.entry], query.sortBy),
          ),
      );
    });
  }
  const present = (
    record: NonNullable<ReturnType<typeof describe>>,
    options: records.SnapshotOptions = {},
  ) => records.present(record, context, options);
  await inOwnerContext(refreshBatch).catch((error: unknown) => {
    dispose();
    throw error;
  });
  void ensureMaterialized().catch(() => {});
  backfill.start();
  return {
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
    present,
    ensureMaterialized,
    get materializedCount() {
      return materializedCount;
    },
    get dirtyRowCount() {
      return dirty.size;
    },
    get needsMaterialization() {
      return !disposed && (topologyDirty || Boolean(catalogDirty) || dirty.size > 0);
    },
    get state() {
      if (!disposed && topologyDirty) {
        inOwnerContext(topology);
      }
      if (!disposed) {
        prepare();
      }
      return { cfg, modelCatalog, rowContext: context, scope: scope.select };
    },
    isCurrent,
    selectEntries,
    select: (query: records.Query = {}) => selectEntries(query).filter(records.ready),
    snapshot(query: records.Lookup, options: records.SnapshotOptions = {}) {
      const record = describe(query);
      return record
        ? { row: present(record, options), lifecycleRunId: record.entry.lifecycleRunId }
        : { row: null };
    },
    dispose,
  };
}

export type SessionRowProjection = Awaited<ReturnType<typeof createSessionRowProjection>>;
