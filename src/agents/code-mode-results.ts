import { randomUUID } from "node:crypto";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { toCodeModeJsonSafe } from "./code-mode-json.js";
import type { CodeModeConfig } from "./code-mode-worker-types.js";
import { ToolInputError } from "./tool-input-error.js";
import type { ToolSearchCatalogRef, ToolSearchToolContext } from "./tool-search-types.js";

type SavedResult = { json: string; bytes: number; networkContent: boolean };
type ResultsStore = {
  scope: string;
  maxBytes: number;
  bytes: number;
  entries: Map<string, SavedResult>;
  close: () => void;
};

// The existing admitted catalog owns these data, independently of cell VMs.
const stores = new WeakMap<ToolSearchCatalogRef, ResultsStore>();
const MAX_RESULTS = 64;

export function disposeCodeModeResults(owner: ToolSearchCatalogRef): void {
  stores.get(owner)?.close();
}

function resultShape(value: unknown, depth = 0): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return depth < 2 && value.length ? `Array<${resultShape(value[0], depth + 1)}>` : "Array";
  }
  if (typeof value === "object") {
    if (depth >= 2) {
      return "object";
    }
    return `{${Object.entries(value)
      .slice(0, 8)
      .map(
        ([key, field]) =>
          `${JSON.stringify(truncateUtf8Prefix(key, 24))}:${resultShape(field, depth + 1)}`,
      )
      .join(",")}}`;
  }
  return typeof value;
}

export type CodeModeResultsAccess = ReturnType<typeof createCodeModeResultsAccess>;

/** Capture cell authority now; never let an old cell adopt a replacement catalog. */
export function createCodeModeResultsAccess(
  ctx: ToolSearchToolContext,
  config: Pick<CodeModeConfig, "memoryLimitBytes" | "maxSnapshotBytes">,
) {
  const owner = ctx.catalogRef;
  const catalog = owner?.current;
  const entries = catalog?.entries;
  const scope = JSON.stringify([
    ctx.agentId,
    ctx.runId,
    ctx.sessionId,
    ctx.sessionKey,
    catalog?.counterScope,
  ]);
  const maxBytes = Math.min(config.memoryLimitBytes, config.maxSnapshotBytes);
  const currentStore = (create = false): ResultsStore => {
    ctx.abortSignal?.throwIfAborted();
    if (
      !owner?.current ||
      owner.current.counterScope !== catalog?.counterScope ||
      owner.current.entries !== entries
    ) {
      throw new ToolInputError(
        "Code Mode results are unavailable after the run catalog changed or closed.",
      );
    }
    const currentScope = JSON.stringify([
      ctx.agentId,
      ctx.runId,
      ctx.sessionId,
      ctx.sessionKey,
      owner.current.counterScope,
    ]);
    let store = stores.get(owner);
    if (currentScope !== scope || (store && store.scope !== scope)) {
      throw new ToolInputError("Code Mode results belong to a different run or session.");
    }
    if (!store && create) {
      const signal = ctx.abortSignal;
      const created: ResultsStore = {
        scope,
        maxBytes,
        bytes: 0,
        entries: new Map(),
        close: () => {
          created.entries.clear();
          created.bytes = 0;
          signal?.removeEventListener("abort", created.close);
          if (stores.get(owner) === created) {
            stores.delete(owner);
          }
        },
      };
      stores.set(owner, created);
      signal?.addEventListener("abort", created.close, { once: true });
      store = created;
    }
    if (!store) {
      throw new ToolInputError(
        "Code Mode result is unavailable or expired; fetch fresh data if needed.",
      );
    }
    return store;
  };
  const find = (id: unknown) => {
    if (typeof id !== "string" || !id) {
      throw new ToolInputError("results reference id must be a non-empty string.");
    }
    const store = currentStore();
    const entry = store.entries.get(id);
    if (!entry) {
      throw new ToolInputError(
        "Code Mode result is unavailable or expired; fetch fresh data if needed.",
      );
    }
    return { store, entry, id };
  };
  return {
    save(value: unknown, networkContent: boolean) {
      const normalized = toCodeModeJsonSafe(value);
      const json = JSON.stringify(normalized) ?? "null";
      const bytes = Buffer.byteLength(json, "utf8");
      const store = currentStore(true);
      if (
        store.entries.size >= MAX_RESULTS ||
        bytes > Math.min(store.maxBytes, maxBytes) - store.bytes
      ) {
        throw new ToolInputError(
          "Code Mode results capacity exceeded; delete saved references or save a smaller value. Existing references are unchanged.",
        );
      }
      const id = `result_${randomUUID()}`;
      store.entries.set(id, { json, bytes, networkContent });
      store.bytes += bytes;
      return {
        id,
        bytes,
        count: Array.isArray(normalized)
          ? normalized.length
          : normalized !== null && typeof normalized === "object"
            ? Object.keys(normalized).length
            : 1,
        shape: truncateUtf8Prefix(resultShape(normalized), 128),
        preview: truncateUtf8Prefix(json, 256),
        previewTruncated: bytes > 256,
      };
    },
    load(id: unknown) {
      const { entry } = find(id);
      return { value: JSON.parse(entry.json) as unknown, networkContent: entry.networkContent };
    },
    delete(id: unknown) {
      const { store, entry, id: key } = find(id);
      store.entries.delete(key);
      store.bytes -= entry.bytes;
      return true;
    },
  };
}
