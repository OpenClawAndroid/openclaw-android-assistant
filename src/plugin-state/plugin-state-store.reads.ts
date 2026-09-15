import { toUSVString } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { executeSqliteQuerySync, sqliteStringSet } from "../infra/kysely-sync.js";
import {
  getPluginStateKysely,
  iteratePluginStateEntries,
  parseStoredJson,
  rowToEntry,
  type PluginStateDatabase,
} from "./plugin-state-store.kernel.js";
import { PluginStateStoreError, type PluginStateEntry } from "./plugin-state-store.types.js";

export function lookupPluginStateEntries(
  store: PluginStateDatabase,
  params: { pluginId: string; namespace: string; keys: readonly string[] },
): Array<Result<unknown, PluginStateStoreError>> {
  const now = Date.now();
  const rows = executeSqliteQuerySync(
    store.db,
    getPluginStateKysely(store.db)
      .selectFrom("plugin_state_entries")
      .select(["entry_key", "value_json"])
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "in", sqliteStringSet(params.keys))
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)])),
  ).rows;
  const values = new Map(rows.map((row) => [row.entry_key, row.value_json]));
  return params.keys.map((key): Result<unknown, PluginStateStoreError> => {
    // Match node:sqlite text binding, including lone UTF-16 surrogates.
    const raw = values.get(toUSVString(key));
    try {
      return ok(raw === undefined ? undefined : parseStoredJson(raw, "lookup", store.path));
    } catch (error) {
      // Let ordered readers stop before a later corrupt value, just as with lookup.
      if (error instanceof PluginStateStoreError && error.code === "PLUGIN_STATE_CORRUPT") {
        return err(error);
      }
      throw error;
    }
  });
}

export function listPluginStateEntries(
  store: PluginStateDatabase,
  params: { pluginId: string; namespace: string },
): PluginStateEntry<unknown>[] {
  const rows = iteratePluginStateEntries(store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    now: Date.now(),
  });
  const entries: PluginStateEntry<unknown>[] = [];
  let decodeFailure: { error: unknown } | undefined;
  for (const row of rows) {
    if (decodeFailure) {
      continue;
    }
    try {
      entries.push(rowToEntry(row, "entries", store.path));
    } catch (error) {
      // Finish the SQL read so a later step failure still precedes JSON errors.
      decodeFailure = { error };
    }
  }
  if (decodeFailure) {
    throw decodeFailure.error;
  }
  return entries;
}
