import type { Result } from "@openclaw/normalization-core/result";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { PluginStateRegisterEntryParams } from "./plugin-state-store.kernel.js";
import type {
  PluginStateEntry,
  PluginStateStoreErrorCode,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";
import type { PluginStateWorkerFailure } from "./plugin-state-worker-errors.js";

type Namespace = { pluginId: string; namespace: string };
type Key = Namespace & { key: string };
type Register = Omit<PluginStateRegisterEntryParams, "createdAtMs"> & { maxPluginEntries: number };

export type PluginStateWorkerOperations = {
  "pluginState.register": { input: Register; output: Result<void, PluginStateWorkerFailure> };
  "pluginState.registerIfAbsent": {
    input: Register;
    output: Result<boolean, PluginStateWorkerFailure>;
  };
  "pluginState.deleteIfEqual": {
    input: Key & { expected: string | number | boolean | null };
    output: Result<boolean, PluginStateWorkerFailure>;
  };
  "pluginState.lookup": { input: Key; output: Result<unknown, PluginStateWorkerFailure> };
  "pluginState.lookupMany": {
    input: Namespace & { keys: readonly string[] };
    output: Result<Array<Result<unknown, PluginStateWorkerFailure>>, PluginStateWorkerFailure>;
  };
  "pluginState.consume": { input: Key; output: Result<unknown, PluginStateWorkerFailure> };
  "pluginState.delete": { input: Key; output: Result<boolean, PluginStateWorkerFailure> };
  "pluginState.entries": {
    input: Namespace;
    output: Result<PluginStateEntry<unknown>[], PluginStateWorkerFailure>;
  };
  "pluginState.count": { input: Namespace; output: Result<number, PluginStateWorkerFailure> };
  "pluginState.clear": { input: Namespace; output: Result<void, PluginStateWorkerFailure> };
};

export const pluginStateWorkerOperations = {
  "pluginState.register": {
    operation: "register",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to register plugin state entry.",
  },
  "pluginState.registerIfAbsent": {
    operation: "register",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to register plugin state entry.",
  },
  "pluginState.deleteIfEqual": {
    operation: "delete",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to conditionally delete plugin state entry.",
  },
  "pluginState.lookup": {
    operation: "lookup",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to read plugin state entry.",
  },
  "pluginState.lookupMany": {
    operation: "lookup",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to read plugin state entries.",
  },
  "pluginState.consume": {
    operation: "consume",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to consume plugin state entry.",
  },
  "pluginState.delete": {
    operation: "delete",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to delete plugin state entry.",
  },
  "pluginState.entries": {
    operation: "entries",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to list plugin state entries.",
  },
  "pluginState.count": {
    operation: "count",
    code: "PLUGIN_STATE_READ_FAILED",
    message: "Failed to count plugin state entries.",
  },
  "pluginState.clear": {
    operation: "clear",
    code: "PLUGIN_STATE_WRITE_FAILED",
    message: "Failed to clear plugin state namespace.",
  },
} as const satisfies Record<
  keyof PluginStateWorkerOperations,
  {
    operation: PluginStateStoreOperation;
    code: PluginStateStoreErrorCode;
    message: string;
  }
>;

/** Selects the plugin-state branch of the shared actor's typed command union. */
export function isPluginStateWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<PluginStateWorkerOperations> {
  return Object.hasOwn(pluginStateWorkerOperations, command.type);
}
