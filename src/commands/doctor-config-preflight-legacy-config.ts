import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  parseConfigJson5,
  recoverConfigFromJsonRootSuffix,
  recoverConfigFromLastKnownGood,
} from "../config/io.js";
import { resolveCanonicalConfigPath } from "../config/paths.js";
import { inspectShippedPluginInstallConfigRecords } from "../config/plugin-install-config-migration.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveHomeDir } from "../utils.js";
import type { DoctorConfigPreflightPluginSnapshotRead } from "./doctor-config-preflight-plugin-index.js";
import type { planAutomaticConfigRepair } from "./doctor/shared/automatic-startup-config-repair.js";

/** Repair active legacy bytes before considering an older backup. */
export async function prepareDoctorConfigRecovery(params: {
  enabled: boolean;
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead;
  planRepair: (snapshot: ConfigFileSnapshot) => ReturnType<typeof planAutomaticConfigRepair>;
  readSnapshot: () => Promise<DoctorConfigPreflightPluginSnapshotRead>;
}) {
  let snapshotRead = params.snapshotRead;
  let snapshot = snapshotRead.snapshot;
  let activeConfigRepair: ReturnType<typeof planAutomaticConfigRepair> = null;
  if (params.enabled && snapshot.exists && !snapshot.valid) {
    const pendingPluginInstallConfig =
      inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig).status !== "missing";
    // One retired key must not discard newer valid settings by restoring an older backup.
    activeConfigRepair =
      typeof snapshot.raw === "string" && parseConfigJson5(snapshot.raw).ok
        ? params.planRepair(snapshot)
        : null;
    let configRepaired = false;
    if (!activeConfigRepair && (await recoverConfigFromJsonRootSuffix(snapshot))) {
      note("Removed non-JSON prefix from openclaw.json.", "Config");
      configRepaired = true;
    } else if (
      !activeConfigRepair &&
      // Config preparation imports these records; backup recovery would erase its source.
      !pendingPluginInstallConfig &&
      (await recoverConfigFromLastKnownGood({ snapshot, reason: "doctor-invalid-config" }))
    ) {
      note(
        "Restored openclaw.json from last-known-good; original saved as .clobbered.*.",
        "Config",
      );
      configRepaired = true;
    }
    if (configRepaired) {
      snapshotRead = await params.readSnapshot();
      snapshot = snapshotRead.snapshot;
    }
    if (!snapshot.valid && typeof snapshot.raw === "string" && !parseConfigJson5(snapshot.raw).ok) {
      throw new Error(
        `Config at ${snapshot.path} is not parseable and cannot be repaired automatically. The file remains unchanged. Inspect the exact parse error with ${formatCliCommand("openclaw config validate")}, then hand-edit the file; or move it aside and run ${formatCliCommand("openclaw onboard")} to generate a fresh config.`,
      );
    }
  }
  return { snapshotRead, activeConfigRepair };
}

export async function maybeMigrateLegacyConfig(): Promise<string[]> {
  const changes: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return changes;
  }

  const targetPath = resolveCanonicalConfigPath();
  const targetDir = path.dirname(targetPath);
  try {
    await fs.access(targetPath);
    return changes;
  } catch {
    // missing config
  }

  const legacyCandidates = [path.join(home, ".clawdbot", "clawdbot.json")];
  let legacyPath: string | null = null;
  for (const candidate of legacyCandidates) {
    try {
      await fs.access(candidate);
      legacyPath = candidate;
      break;
    } catch {
      // continue
    }
  }
  if (!legacyPath) {
    return changes;
  }

  await fs.mkdir(targetDir, { recursive: true });
  try {
    await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch (error) {
    // A concurrently created target wins; every other failure must remain actionable.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") {
      throw new Error(
        `Failed to migrate legacy config ${legacyPath} -> ${targetPath}: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
  }
  return changes;
}
