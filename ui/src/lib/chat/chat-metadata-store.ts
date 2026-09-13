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
  type ChatMetadataResult,
  type ChatMetadataUpdate,
  type ChatMetadataWriter,
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
        if ((params.sessionKey || params.authProfileId) && created.listeners.size === 0) {
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
  opts?: { startupRetryWindowMs?: number },
): Promise<ChatMetadataResult> {
  const retryWindowMs = opts?.startupRetryWindowMs;
  if (retryWindowMs === undefined) {
    return client.request<ChatMetadataResult>("chat.metadata", params);
  }

  const deadlineAt = Date.now() + retryWindowMs;
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

function beginPublication(entry: ChatMetadataEntry, revalidating = false) {
  const writer: ChatMetadataWriter = { revalidating };
  entry.writer = writer;
  const isCurrent = () => entry.writer === writer;
  return {
    writer,
    isCurrent,
    publish: (result: ChatMetadataResult & { models?: unknown; accountSelection?: unknown }) => {
      writer.pending = undefined;
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
      writer.pending = undefined;
      if (isCurrent()) {
        notifyChatMetadataListeners(entry, { type: "error", error });
      }
      entry.release();
      throw error;
    },
  };
}

function beginChatMetadataRequest(
  entry: ChatMetadataEntry,
  request: Promise<ChatMetadataResult>,
  revalidating = false,
): Promise<ChatMetadataResult> {
  const { writer, publish, fail } = beginPublication(entry, revalidating);
  const pending = request.then(publish, fail);
  writer.pending = pending;
  notifyChatMetadataListeners(entry, { type: "loading" });
  return pending;
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
  const pending = entry.writer?.pending;
  if (pending) {
    return pending;
  }
  return beginChatMetadataRequest(entry, requestChatMetadata(client, entry.scope));
}

export function revalidateChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  opts?: { startupRetryWindowMs?: number },
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, scope);
  const writer = entry.writer;
  if (writer?.revalidating && writer.pending) {
    return writer.pending;
  }
  return beginChatMetadataRequest(entry, requestChatMetadata(client, entry.scope, opts), true);
}

export function beginChatMetadataPublication(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
) {
  const entry = metadataEntryFor(client, scope);
  const { isCurrent, publish } = beginPublication(entry);
  notifyChatMetadataListeners(entry, { type: "loading" });
  return { isCurrent, publish };
}
