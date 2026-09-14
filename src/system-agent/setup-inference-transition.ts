import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readConfigFileSnapshot, transformConfigFileWithRetry } from "../config/config.js";
import { applyMergePatch, createMergePatch } from "../config/merge-patch.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { SetupInferenceOwnerDriftError } from "./setup-inference-core.js";

export type SetupInferenceConfigUndo = () => Promise<{ config: OpenClawConfig; written: boolean }>;
export type SetupInferenceConfigWriteOptions = {
  captureUndo: (undo: SetupInferenceConfigUndo) => void;
};
type SetupInferenceConfigWriter = (
  config: OpenClawConfig,
  options: SetupInferenceConfigWriteOptions,
) => Promise<OpenClawConfig>;
export type SetupInferenceConfigTarget = {
  write: SetupInferenceConfigWriter;
  read: () => Promise<{ config: OpenClawConfig; write: SetupInferenceConfigWriter }>;
};

function setupConfigPatchConflicts(base: unknown, current: unknown, patch: unknown): boolean {
  if (!isRecord(patch)) {
    return !isDeepStrictEqual(base, current);
  }
  if (
    isRecord(base) !== isRecord(current) ||
    (!isRecord(base) && !isDeepStrictEqual(base, current))
  ) {
    return true;
  }
  const before = isRecord(base) ? base : {};
  const now = isRecord(current) ? current : {};
  return Object.entries(patch).some(([key, change]) =>
    setupConfigPatchConflicts(before[key], now[key], change),
  );
}

export function restoreSetupInferenceConfig(
  current: OpenClawConfig,
  before: OpenClawConfig,
  after: OpenClawConfig,
) {
  if (!setupConfigPatchConflicts(before, current, createMergePatch(before, after))) {
    return { config: current, written: false };
  }
  const reverse = createMergePatch(after, before);
  if (setupConfigPatchConflicts(after, current, reverse)) {
    throw new SetupInferenceOwnerDriftError(
      "Newer connection settings superseded this activation. Those settings were preserved.",
    );
  }
  // SAFETY: The inverse patch is derived from the writer's typed before/after configs.
  return { config: applyMergePatch(current, reverse) as OpenClawConfig, written: true };
}

/** Captures only this file writer's effects, before its guarded commit can start. */
export function captureSetupInferenceFileUndo(
  snapshot: ConfigFileSnapshot,
  candidate: OpenClawConfig,
): SetupInferenceConfigUndo {
  return async () => {
    const current = await readConfigFileSnapshot();
    if (current.path !== snapshot.path) {
      throw new SetupInferenceOwnerDriftError(
        "The configuration owner changed before activation recovery.",
      );
    }
    const restored = restoreSetupInferenceConfig(
      current.sourceConfig,
      snapshot.sourceConfig,
      candidate,
    );
    if (!restored.written) {
      return { config: current.runtimeConfig ?? current.config, written: false };
    }
    const committed = await transformConfigFileWithRetry({
      base: "source",
      writeOptions: { expectedConfigPath: snapshot.path },
      transform: (config) => ({
        nextConfig: restoreSetupInferenceConfig(config, snapshot.sourceConfig, candidate).config,
      }),
    });
    return { config: committed.nextConfig, written: true };
  };
}

/** The config target compensates only its own write when credential activation refuses. */
export async function commitSetupInferenceActivation(params: {
  commit: (options: SetupInferenceConfigWriteOptions) => Promise<OpenClawConfig>;
  activate: () => Promise<void>;
}): Promise<OpenClawConfig> {
  let undoConfig: SetupInferenceConfigUndo | undefined;
  const config = await params.commit({
    captureUndo: (undo) => {
      undoConfig = undo;
    },
  });
  try {
    await params.activate();
    return config;
  } catch (error) {
    try {
      await undoConfig?.();
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `Activation failed and recovery could not complete. ${formatErrorMessage(recoveryError)}`,
        { cause: recoveryError },
      );
    }
    throw error;
  }
}
