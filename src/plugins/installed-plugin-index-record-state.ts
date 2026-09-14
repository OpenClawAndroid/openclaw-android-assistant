import path from "node:path";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import {
  inspectPluginInstallRecordMap,
  type PluginInstallRecordMapState,
} from "../config/plugin-install-record-map.js";
import { readPersistedInstalledPluginIndexRowSync } from "./installed-plugin-index-row.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";
import type { PersistedInstalledPluginIndexCacheEntry } from "./plugin-cache-management.js";
import { getPluginCache, preparePluginCacheFact } from "./plugin-cache.js";
import { readPluginMetadataStateRow } from "./plugin-metadata-state-worker.js";

function readPersistedInstalledPluginIndexState(
  options: InstalledPluginIndexStoreOptions,
): PersistedInstalledPluginIndexCacheEntry["state"] {
  // The row reader owns unreadable-state failures; never cache them as missing or invalid.
  const row = readPersistedInstalledPluginIndexRowSync(options);
  return row ? { status: "present", value: safeParseJson(row.value_json) } : { status: "missing" };
}

/** Share the SQLite row while validating install records independently from index metadata. */
export function getPersistedInstalledPluginIndexCacheEntry(
  options: InstalledPluginIndexStoreOptions,
): PersistedInstalledPluginIndexCacheEntry {
  const cache = getPluginCache().persistedInstalledIndex;
  const key = path.resolve(resolveInstalledPluginIndexStorePath(options));
  const current = cache.get(key);
  if (current && "value" in current) {
    return current.value;
  }
  const entry = { state: readPersistedInstalledPluginIndexState(options) };
  cache.set(key, { value: entry });
  return entry;
}

/** Await one shared row, retaining its cache generation until publication completes. */
export async function preparePersistedInstalledPluginIndexCacheEntry(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<{ entry: PersistedInstalledPluginIndexCacheEntry; assertCurrent: () => void }> {
  const owner = getPluginCache();
  const key = path.resolve(resolveInstalledPluginIndexStorePath(options));
  const databaseOptions = resolveInstalledPluginIndexStateDatabaseOptions(options);
  const prepared = await preparePluginCacheFact(
    owner,
    owner.persistedInstalledIndex,
    key,
    async () => {
      const row = options.filePath?.endsWith(".json")
        ? undefined
        : await readPluginMetadataStateRow(
            "installed-index",
            databaseOptions,
            options.artifactPreservingReadOnly,
          );
      return {
        state: row
          ? { status: "present", value: safeParseJson(row.value_json) }
          : { status: "missing" },
      } satisfies PersistedInstalledPluginIndexCacheEntry;
    },
  );
  return { entry: prepared.value, assertCurrent: prepared.assertCurrent };
}

export function inspectPersistedInstalledPluginIndexInstallRecords(
  entry: PersistedInstalledPluginIndexCacheEntry,
): PluginInstallRecordMapState {
  if (!entry.records) {
    const state = entry.state;
    // The full index can be invalid while its canonical install ledger remains usable.
    const value = state.status === "present" ? state.value : undefined;
    const records = (value as { index?: { installRecords?: unknown } } | undefined)?.index
      ?.installRecords;
    entry.records =
      state.status === "missing"
        ? { status: "missing" }
        : records === undefined
          ? { status: "invalid" }
          : inspectPluginInstallRecordMap(records);
  }
  return entry.records;
}

export function inspectPersistedInstalledPluginIndexInstallRecordsSync(
  options: InstalledPluginIndexStoreOptions = {},
): PluginInstallRecordMapState {
  return inspectPersistedInstalledPluginIndexInstallRecords(
    getPersistedInstalledPluginIndexCacheEntry(options),
  );
}
