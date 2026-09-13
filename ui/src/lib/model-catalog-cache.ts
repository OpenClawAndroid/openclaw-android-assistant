import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelCatalogResult } from "../api/types.ts";

export type ModelCatalogReadScope = Pick<
  ModelsListParams,
  "agentId" | "sessionKey" | "authProfileId"
>;

export type ModelCatalogClient = Pick<GatewayBrowserClient, "request">;
export type ModelCatalogRequest = {
  refresh: boolean;
  controller?: AbortController;
  promise: Promise<ModelCatalogResult>;
  resolve: (result: ModelCatalogResult) => void;
  subscribers: Set<object>;
};

type ModelCatalogCache = {
  entries: Map<string, ModelCatalogEntry>;
  reads: Set<ModelCatalogRead>;
  nextRead: number;
};

export type ModelCatalogRead = {
  client: ModelCatalogClient;
  cache: ModelCatalogCache;
  scope?: ModelsListParams;
  signal?: AbortSignal;
  order: number;
  unresolvedScope: boolean;
};
export type ModelCatalogEntry = {
  scope: ModelCatalogReadScope;
  result?: ModelCatalogResult;
  invalidated?: boolean;
  expiresAt?: number;
  publishedRead?: number;
  pending: Map<GatewayProtocolRequestOptions["timeoutMs"], ModelCatalogRequest>;
};

// Application lifecycle invalidation must not eagerly load catalog readers or presentation.
export const modelCatalogCache = new WeakMap<ModelCatalogClient, ModelCatalogCache>();
const observers = new WeakMap<ModelCatalogClient, Set<() => void>>();

export function subscribeModelCatalogCache(
  client: ModelCatalogClient,
  listener: () => void,
): () => void {
  const listeners = observers.get(client) ?? new Set();
  observers.set(client, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observers.delete(client);
    }
  };
}

function notifyModelCatalogCache(client: ModelCatalogClient): void {
  for (const listener of Array.from(observers.get(client) ?? [])) {
    listener();
  }
}

export function beginModelCatalogRead(
  client: ModelCatalogClient,
  scope?: ModelsListParams,
  signal?: AbortSignal,
  unresolvedScope = false,
): ModelCatalogRead {
  const cache: ModelCatalogCache = modelCatalogCache.get(client) ?? {
    entries: new Map(),
    reads: new Set(),
    nextRead: 0,
  };
  modelCatalogCache.set(client, cache);
  const read: ModelCatalogRead = {
    client,
    cache,
    scope,
    signal,
    unresolvedScope,
    order: ++cache.nextRead,
  };
  cache.reads.add(read);
  return read;
}

const MAX_CACHED_MODEL_CATALOGS = 64;

export function trimModelCatalogCache(cache: ModelCatalogCache): void {
  for (const [key, entry] of cache.entries) {
    if (cache.entries.size <= MAX_CACHED_MODEL_CATALOGS) {
      return;
    }
    if (entry.pending.size === 0) {
      cache.entries.delete(key);
      // Unresolved reads cannot outlive the publication order of an evicted projection.
      for (const read of cache.reads) {
        if (read.unresolvedScope) {
          cache.reads.delete(read);
        }
      }
    }
  }
}

export function modelCatalogParams(options: ModelsListParams): ModelsListParams {
  const { agentId, view = "configured", ...params } = options;
  return { view, ...params, ...(agentId === undefined ? {} : { agentId: agentId.trim() }) };
}

export function modelCatalogKey(params: ModelsListParams): string {
  const { refresh: _refresh, ...projection } = params;
  return JSON.stringify(
    Object.entries(projection)
      .filter(([, value]) => value !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

export function publishModelCatalogResult(
  read: ModelCatalogRead,
  params: ModelsListParams,
  result: ModelCatalogResult,
): boolean {
  const { cache, client } = read;
  if (modelCatalogCache.get(client) !== cache || !cache.reads.has(read) || read.signal?.aborted) {
    return false;
  }
  const key = modelCatalogKey(modelCatalogParams(params));
  if (read.scope) {
    const expected = modelCatalogParams(read.scope);
    if (expected.agentId === undefined) {
      expected.agentId = params.agentId;
    }
    if (modelCatalogKey(expected) !== key) {
      return false;
    }
  }
  const entry: ModelCatalogEntry = cache.entries.get(key) ?? { scope: params, pending: new Map() };
  if (!params.refresh && (entry.publishedRead ?? 0) > read.order) {
    return false;
  }
  const discoverySucceeded = !result.refreshFailed;
  // Partial inventory updates display without settling another reader's discovery.
  for (const pending of cache.reads) {
    if (
      discoverySucceeded &&
      pending !== read &&
      pending.scope &&
      modelCatalogKey(modelCatalogParams(pending.scope)) === key &&
      (params.refresh || !pending.scope.refresh)
    ) {
      cache.reads.delete(pending);
    }
  }
  cache.reads.delete(read);
  if (params.refresh && discoverySucceeded) {
    for (const other of cache.entries.values()) {
      if (other !== entry) {
        invalidateModelCatalogEntry(other);
      }
    }
    cache.reads.clear();
  }
  entry.result = result;
  entry.invalidated = !discoverySucceeded;
  entry.publishedRead = read.order;
  // Cooldown expiry changes readiness without publishing a new Gateway generation.
  entry.expiresAt = discoverySucceeded
    ? result.models.reduce(
        (expiresAt, model) => Math.min(expiresAt, model.unavailableUntil ?? Infinity),
        Infinity,
      )
    : undefined;
  cache.entries.delete(key);
  cache.entries.set(key, entry);
  for (const [budget, pending] of entry.pending) {
    if (discoverySucceeded && (params.refresh || !pending.refresh)) {
      pending.resolve(result);
      entry.pending.delete(budget);
    }
  }
  trimModelCatalogCache(cache);
  notifyModelCatalogCache(client);
  return true;
}

export function invalidateModelCatalogEntry(entry: ModelCatalogEntry): void {
  entry.invalidated = true;
  entry.expiresAt = undefined;
  entry.pending.clear();
}

/** A connection boundary retires even the last accepted display snapshot. */
export function clearModelCatalogCache(client: ModelCatalogClient): void {
  modelCatalogCache.delete(client);
  notifyModelCatalogCache(client);
}

/** Retire read eligibility while preserving the last accepted, scoped display snapshot. */
export function invalidateModelCatalogCache(
  client: ModelCatalogClient,
  scope?: ModelCatalogReadScope & { sessionsOnly?: boolean },
): void {
  const cache = modelCatalogCache.get(client);
  if (!cache) {
    return;
  }
  const matches = (readScope: ModelCatalogReadScope | undefined) =>
    !scope ||
    !readScope ||
    ((!scope.sessionsOnly || readScope.sessionKey !== undefined) &&
      (scope.agentId === undefined ||
        readScope.agentId === undefined ||
        readScope.agentId === scope.agentId.trim()) &&
      (scope.sessionKey === undefined || readScope.sessionKey === scope.sessionKey) &&
      (scope.authProfileId === undefined || readScope.authProfileId === scope.authProfileId));
  for (const read of cache.reads) {
    if (matches(read.scope)) {
      cache.reads.delete(read);
    }
  }
  for (const entry of cache.entries.values()) {
    if (matches(entry.scope)) {
      invalidateModelCatalogEntry(entry);
    }
  }
  trimModelCatalogCache(cache);
  notifyModelCatalogCache(client);
}
