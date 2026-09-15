import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { ConfigMachineStateDatabase } from "../state/config-machine-state.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

export const INSTALLED_PLUGIN_INDEX_STATE_KEY = "plugins.installedIndex";

export type PluginMetadataStateSelector = "installed-index" | "bundled-discovery";

/** Shared inspection commands use the same existing-only, artifact-preserving reader. */
export function readPluginMetadataStateRowSync(
  selector: PluginMetadataStateSelector,
  databaseOptions: Parameters<typeof withExistingOpenClawStateDatabaseReadOnly>[1],
  artifactPreservingReadOnly = false,
): { value_json: string } | undefined {
  const read = ({ db }: { db: DatabaseSync }) => {
    if (!tableExists(db, "config_machine_state")) {
      return undefined;
    }
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<ConfigMachineStateDatabase>(db)
        .selectFrom("config_machine_state")
        .select("value_json")
        .where(
          "state_key",
          "=",
          selector === "installed-index"
            ? INSTALLED_PLUGIN_INDEX_STATE_KEY
            : "plugins.bundledDiscovery",
        ),
    );
  };
  return artifactPreservingReadOnly
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(read, databaseOptions)
    : withExistingOpenClawStateDatabaseReadOnly(read, databaseOptions);
}

/** Read failures must escape before either projection can authorize recovery or rebuilding. */
export function readPersistedInstalledPluginIndexRowSync(
  options: InstalledPluginIndexStoreOptions,
): { value_json: string } | undefined {
  if (options.filePath?.endsWith(".json")) {
    return undefined;
  }
  return readPluginMetadataStateRowSync(
    "installed-index",
    resolveInstalledPluginIndexStateDatabaseOptions(options),
    options.artifactPreservingReadOnly,
  );
}
