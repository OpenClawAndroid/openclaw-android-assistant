import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  resolveGatewayStartupRetryAfterMs,
} from "@openclaw/gateway-client/browser";
import type { ChatMetadataParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  chatMetadataCache,
  notifyChatMetadataListeners,
  type ChatMetadataEntry,
  type ChatMetadataPublication,
  type ChatMetadataRequest,
  type ChatMetadataResult,
  type ChatMetadataUpdate,
} from "./chat-metadata-cache.ts";

function metadataScopeKey(scope: ChatMetadataParams): string {
  return JSON.stringify([
    scope.agentId?.trim() ?? "",
    scope.sessionKey ?? null,
    scope.authProfileId ?? null,
  ]);
}

function metadataEntryFor(
  client: GatewayBrowserClient,
  params: ChatMetadataParams,
): ChatMetadataEntry {
  const key = metadataScopeKey(params);
  let cache = chatMetadataCache.get(client);
  if (!cache) {
    cache = new Map();
    chatMetadataCache.set(client, cache);
  }
  let entry = cache.get(key);
  if (!entry) {
    const created: ChatMetadataEntry = {
      scope: params,
      listeners: new Set(),
      release: () => {
        // Selected-account projections live with their consumers, not every conversation/draft.
        // Retire the writer too: a late startup/read cannot repopulate a released entry.
        if (
          (params.sessionKey || params.authProfileId) &&
          created.listeners.size === 0 &&
          !created.activeRequest &&
          !created.queuedRequest
        ) {
          created.writer = undefined;
          if (cache.get(key) === created) {
            cache.delete(key);
          }
        }
      },
    };
    entry = created;
    cache.set(key, entry);
  }
  return entry;
}

function waitForMetadataRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

async function requestChatMetadata(
  client: GatewayBrowserClient,
  params: ChatMetadataParams,
  deadlineAt?: number,
): Promise<ChatMetadataResult> {
  if (deadlineAt === undefined) {
    return client.request<ChatMetadataResult>("chat.metadata", params);
  }

  let latestStartupError: Error | undefined;

  while (true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw latestStartupError ?? new Error("New-session metadata retry deadline elapsed");
    }

    try {
      return await client.request<ChatMetadataResult>("chat.metadata", params, {
        timeoutMs: Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remainingMs),
      });
    } catch (error) {
      const requestError =
        error instanceof Error
          ? error
          : new Error("New-session metadata request failed", { cause: error });
      const retryAfterMs = resolveGatewayStartupRetryAfterMs(requestError);
      if (retryAfterMs === null) {
        throw requestError;
      }

      const retryRemainingMs = deadlineAt - Date.now();
      if (retryRemainingMs <= 0) {
        throw requestError;
      }

      latestStartupError = requestError;
      await waitForMetadataRetry(Math.min(retryAfterMs, retryRemainingMs));
    }
  }
}

function preparePublication(entry: ChatMetadataEntry): ChatMetadataPublication {
  const writer = {};
  entry.writer = writer;
  const isCurrent = () => entry.writer === writer;
  return {
    isCurrent,
    publish: (result: ChatMetadataResult & { models?: unknown; accountSelection?: unknown }) => {
      // Legacy/startup responses can carry models. The direct catalog is their only UI owner.
      const { models: _models, accountSelection: _accountSelection, ...metadata } = result;
      if (isCurrent()) {
        entry.result = metadata;
        notifyChatMetadataListeners(entry, { type: "result", result: metadata });
      }
      entry.release();
      return metadata;
    },
    fail: (error: unknown) => {
      if (isCurrent()) {
        notifyChatMetadataListeners(entry, { type: "error", error });
      }
      entry.release();
    },
  };
}

function beginChatMetadataRequest(
  client: GatewayBrowserClient,
  entry: ChatMetadataEntry,
  revalidation: boolean,
  startupRetryDeadlineAt?: number,
): Promise<ChatMetadataResult> {
  const publication = preparePublication(entry);
  const queued = entry.queuedRequest;
  if (queued) {
    // Pending demand adopts the latest writer, but never adds another queued read.
    queued.publication = publication;
    queued.revalidation ||= revalidation;
    queued.setStartupRetryDeadline(startupRetryDeadlineAt);
    notifyChatMetadataListeners(entry, { type: "loading" });
    return queued.promise;
  }
  let resolve!: (result: ChatMetadataResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ChatMetadataResult>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  let started = false;
  let retryDeadlineAt = startupRetryDeadlineAt;
  let queueDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const request: ChatMetadataRequest = {
    promise,
    publication,
    revalidation,
    setStartupRetryDeadline: (deadlineAt) => {
      if (started || deadlineAt === undefined) {
        return;
      }
      retryDeadlineAt = Math.min(retryDeadlineAt ?? deadlineAt, deadlineAt);
      if (entry.queuedRequest !== request) {
        return;
      }
      clearTimeout(queueDeadlineTimer);
      queueDeadlineTimer = setTimeout(
        () => {
          if (entry.queuedRequest !== request) {
            return;
          }
          entry.queuedRequest = undefined;
          const error = new Error("New-session metadata retry deadline elapsed");
          request.publication.fail(error);
          reject(error);
          entry.release();
        },
        Math.max(0, retryDeadlineAt - Date.now()),
      );
    },
    start: () => {
      started = true;
      clearTimeout(queueDeadlineTimer);
      // Once dispatched, this request cannot regain publication authority after invalidation.
      const activePublication = request.publication;
      void (async () => {
        try {
          const result = await requestChatMetadata(client, entry.scope, retryDeadlineAt).finally(
            () => {
              // Observers may retry synchronously; retire the settled request before notifying them.
              entry.activeRequest = undefined;
              const next = entry.queuedRequest;
              entry.queuedRequest = undefined;
              if (next) {
                entry.activeRequest = next;
                next.start();
              }
            },
          );
          resolve(activePublication.publish(result));
        } catch (error) {
          activePublication.fail(error);
          reject(error);
        } finally {
          entry.release();
        }
      })();
    },
  };
  if (entry.activeRequest) {
    entry.queuedRequest = request;
  } else {
    entry.activeRequest = request;
  }
  request.setStartupRetryDeadline(startupRetryDeadlineAt);
  // Reserve ownership before consumers synchronously react to the new generation.
  notifyChatMetadataListeners(entry, { type: "loading" });
  if (entry.activeRequest === request) {
    request.start();
  }
  return promise;
}

export function peekChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
): ChatMetadataResult | undefined {
  return chatMetadataCache.get(client)?.get(metadataScopeKey(scope))?.result;
}

export function subscribeChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  listener: (update: ChatMetadataUpdate) => void,
): () => void {
  const entry = metadataEntryFor(client, scope);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if ((scope.sessionKey || scope.authProfileId) && entry.listeners.size === 0) {
      entry.writer = undefined;
      entry.result = undefined;
    }
    entry.release();
  };
}

export function loadChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, scope);
  if (entry.result) {
    return Promise.resolve(entry.result);
  }
  const request = entry.queuedRequest ?? entry.activeRequest;
  if (request?.publication.isCurrent()) {
    return request.promise;
  }
  return beginChatMetadataRequest(client, entry, false);
}

export function revalidateChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  opts?: { startupRetryWindowMs?: number },
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, scope);
  const request = entry.queuedRequest ?? entry.activeRequest;
  const deadlineAt =
    opts?.startupRetryWindowMs === undefined ? undefined : Date.now() + opts.startupRetryWindowMs;
  if (
    request?.publication.isCurrent() &&
    (request.revalidation || request === entry.queuedRequest)
  ) {
    request.revalidation = true;
    request.setStartupRetryDeadline(deadlineAt);
    return request.promise;
  }
  return beginChatMetadataRequest(client, entry, true, deadlineAt);
}

export function beginChatMetadataPublication(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
) {
  const entry = metadataEntryFor(client, scope);
  const { isCurrent, publish } = preparePublication(entry);
  notifyChatMetadataListeners(entry, { type: "loading" });
  return { isCurrent, publish };
}
