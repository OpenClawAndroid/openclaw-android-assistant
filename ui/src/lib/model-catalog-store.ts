import {
  GatewayProtocolRequestTimeoutError,
  resolveSafeTimeoutDelayMs,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
import type {
  ModelsListParams,
  ModelsSnapshotEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import type { ModelCatalogResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import {
  invalidateModelCatalogCache,
  invalidateModelCatalogEntry,
  beginModelCatalogRead,
  getModelCatalogCache,
  modelCatalogCache,
  modelCatalogKey,
  modelCatalogParams,
  publishModelCatalogResult,
  type ModelCatalogReadScope,
  type ModelCatalogClient,
  type ModelCatalogRead,
  type ModelCatalogRequest,
  type ModelCatalogRequestLane,
} from "./model-catalog-cache.ts";
import { subscribeToSharedRequest } from "./shared-request-subscription.ts";

export type ChatModelCatalogState = {
  hasSnapshot: boolean;
  refreshFailed?: boolean;
  pendingProviders?: readonly string[];
  status: "idle" | "loading" | "ready" | "error" | "offline";
};

export function resolveModelCatalogState(
  result: Pick<ModelCatalogResult, "models" | "refreshFailed"> &
    Pick<ChatModelCatalogState, "pendingProviders">,
  {
    connected = true,
    loading = false,
    error = null,
  }: {
    connected?: boolean;
    loading?: boolean;
    error?: string | null;
  } = {},
): ChatModelCatalogState {
  return {
    hasSnapshot: result.models.length > 0 || (!loading && !error),
    refreshFailed: result.refreshFailed,
    pendingProviders: result.pendingProviders,
    status: !connected ? "offline" : error ? "error" : loading ? "loading" : "ready",
  };
}

export function modelCatalogRefreshError(
  result: ModelCatalogResult,
  failureMessage?: string,
): string | null {
  return result.refreshFailed
    ? (failureMessage ??
        t(
          result.models.length
            ? "chat.modelControls.modelsRefreshFailed"
            : "chat.modelControls.modelsUnavailable",
        ))
    : null;
}

/** A synchronous display read; the Gateway remains the authority for sending and mutations. */
export function peekModelCatalog(
  client: ModelCatalogClient,
  options: ModelsListParams,
  { allowStale = false }: { allowStale?: boolean } = {},
): ModelCatalogResult | undefined {
  const cache = modelCatalogCache.get(client)?.entries;
  const key = modelCatalogKey(modelCatalogParams(options));
  const entry = cache?.get(key);
  if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    invalidateModelCatalogEntry(entry);
    // Keep ordering until bounded eviction so an older unresolved read cannot refill this slot.
  }
  if (entry?.invalidated && !allowStale) {
    return undefined;
  }
  if (cache && entry?.result) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry?.result;
}

function createModelCatalogRequest(params: {
  client: ModelCatalogClient;
  scope: ModelsListParams;
  timeoutMs: GatewayProtocolRequestOptions["timeoutMs"];
  cache: ModelCatalogRead["cache"];
  lane: ModelCatalogRequestLane;
  queued: boolean;
  releaseLane: () => void;
}): ModelCatalogRequest {
  const { client, cache, lane, timeoutMs } = params;
  const controller = new AbortController();
  const completion = createDeferredCore<ModelCatalogResult>();
  const duration =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? resolveSafeTimeoutDelayMs(timeoutMs, { minMs: 0 })
      : undefined;
  const deadline = duration === undefined ? undefined : Date.now() + duration;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let requestSent = false;
  const retireCompletion = () => {
    clearTimeout(deadlineTimer);
    cache.reads.delete(pending.read);
    pending.settled = true;
    if (lane.queued === pending) {
      lane.queued = undefined;
      params.releaseLane();
    }
  };
  const finishTransport = () => {
    if (lane.active !== pending) {
      return;
    }
    lane.active = undefined;
    const next = lane.queued;
    if (next && modelCatalogCache.get(client) === cache) {
      lane.queued = undefined;
      lane.active = next;
      next.start();
    }
    params.releaseLane();
  };
  const pending: ModelCatalogRequest = {
    refresh: params.scope.refresh === true,
    controller,
    read: beginModelCatalogRead(client, params.scope, controller.signal),
    preparing: true,
    settled: false,
    subscribers: new Set(),
    promise: completion.promise,
    resolve: (result) => {
      if (!pending.settled) {
        retireCompletion();
        completion.resolve(result);
      }
    },
    reject: (error) => {
      if (!pending.settled) {
        retireCompletion();
        completion.reject(error);
      }
    },
    start: () => {
      if (started) {
        return;
      }
      started = true;
      if (pending.settled) {
        finishTransport();
        return;
      }
      const remaining = deadline === undefined ? undefined : deadline - Date.now();
      if (params.queued && duration !== undefined && remaining !== undefined && remaining <= 0) {
        pending.reject(
          new GatewayProtocolRequestTimeoutError({
            method: "models.list",
            timeoutMs: duration,
            requestSent: false,
          }),
        );
        finishTransport();
        return;
      }
      const read = pending.read;
      const requestParams = { ...params.scope, ...(pending.refresh ? { refresh: true } : {}) };
      try {
        // Gateway aborts and timeouts discard correlation without cancelling server work.
        // Keep explicit deadlines local so retries cannot overlap an unresolved transport.
        const request =
          timeoutMs === undefined
            ? client.request<ModelCatalogResult>("models.list", requestParams)
            : client.request<ModelCatalogResult>("models.list", requestParams, {
                timeoutMs: duration === undefined ? timeoutMs : null,
                ...(duration === undefined
                  ? {}
                  : {
                      onSent: () => {
                        requestSent = true;
                      },
                    }),
              });
        void request
          .then((result) => {
            publishModelCatalogResult(read, requestParams, result);
            pending.resolve(result);
          })
          .catch(pending.reject)
          .finally(finishTransport);
      } catch (error) {
        pending.reject(error);
        finishTransport();
      }
    },
  };
  controller.signal.addEventListener("abort", () => pending.reject(controller.signal.reason), {
    once: true,
  });
  if (duration !== undefined) {
    deadlineTimer = setTimeout(
      () =>
        pending.reject(
          new GatewayProtocolRequestTimeoutError({
            method: "models.list",
            timeoutMs: duration,
            requestSent,
          }),
        ),
      duration,
    );
  }
  return pending;
}

/** Cache exact Gateway projections for this connection until its lifecycle invalidates them. */
export async function loadModelCatalog(
  client: ModelCatalogClient,
  options: ModelsListParams & Pick<GatewayProtocolRequestOptions, "signal" | "timeoutMs">,
): Promise<ModelCatalogResult> {
  const { signal, timeoutMs, ...requestOptions } = options;
  signal?.throwIfAborted();
  const params = modelCatalogParams(requestOptions);
  if (!params.refresh) {
    const result = peekModelCatalog(client, params);
    if (result) {
      return result;
    }
  }
  const owner = getModelCatalogCache(client);
  const key = modelCatalogKey(params);
  const budgets =
    owner.requests.get(key) ??
    new Map<GatewayProtocolRequestOptions["timeoutMs"], ModelCatalogRequestLane>();
  owner.requests.set(key, budgets);
  const lane: ModelCatalogRequestLane = budgets.get(timeoutMs) ?? {};
  budgets.set(timeoutMs, lane);
  const releaseLane = () => {
    if (!lane.active && !lane.queued) {
      budgets.delete(timeoutMs);
      if (budgets.size === 0) {
        owner.requests.delete(key);
      }
    }
  };
  const existing = lane.queued ?? lane.active;
  if (
    existing &&
    !existing.settled &&
    !existing.controller.signal.aborted &&
    (existing.preparing || (!params.refresh && owner.reads.has(existing.read)))
  ) {
    return await subscribeToSharedRequest(existing, {}, signal);
  }
  const adopting = lane.queued !== undefined;
  const pending =
    lane.queued ??
    createModelCatalogRequest({
      client,
      scope: params,
      timeoutMs,
      cache: owner,
      lane,
      queued: lane.active !== undefined,
      releaseLane,
    });
  if (lane.active) {
    lane.queued = pending;
  } else {
    lane.active = pending;
  }
  pending.preparing = true;
  pending.refresh ||= params.refresh === true;
  const subscription = subscribeToSharedRequest(pending, {}, signal);
  if (params.refresh) {
    invalidateModelCatalogCache(client);
  }
  if (modelCatalogCache.get(client) !== owner) {
    pending.reject(new DOMException("Model catalog connection retired", "AbortError"));
  } else if (adopting || params.refresh) {
    owner.reads.delete(pending.read);
    pending.read = beginModelCatalogRead(
      client,
      { ...params, ...(pending.refresh ? { refresh: true } : {}) },
      pending.controller.signal,
    );
  }
  pending.preparing = false;
  if (lane.active === pending) {
    pending.start();
  }
  return await subscription;
}

export function subscribeModelCatalogChanges(
  gateway: ApplicationGateway,
  listener: () => void,
  scope?: ModelCatalogReadScope,
): () => void {
  return gateway.subscribeEvents((event) => {
    if (event.event === "config.changed" || event.event === "chat.metadata.changed") {
      listener();
    } else if (event.event === "models.snapshot" && scope) {
      // SAFETY: The authenticated connect dispatcher emits this as ModelsSnapshotEvent.
      const publication = event.payload as ModelsSnapshotEvent;
      if (
        modelCatalogKey(modelCatalogParams(scope)) ===
        modelCatalogKey(modelCatalogParams(publication.scope))
      ) {
        listener();
      }
    }
  });
}
