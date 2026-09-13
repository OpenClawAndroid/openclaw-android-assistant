import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { createPreUpdateConfigSnapshot } from "../../config/backup-rotation.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { resolveConfigPath } from "../../config/paths.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

export type UpdateConfigSnapshot = {
  path: string;
  raw: string | null;
  hash: string;
  doctorOwned?: boolean;
};

export async function readUpdateConfigSnapshot(path: string): Promise<UpdateConfigSnapshot> {
  const raw = await fs.readFile(path, "utf8").catch((error: unknown) => {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    return null;
  });
  return { path, raw, hash: hashConfigRaw(raw) };
}

export async function createUpdateConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await createPreUpdateConfigSnapshot({
    configPath: resolveConfigPath(env),
    fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
  });
}

export async function readUpdateCandidateSource(
  env: NodeJS.ProcessEnv,
  legacyConfigPlan?: LegacyConfigUpdatePlan,
) {
  if (legacyConfigPlan) {
    const context = await captureTargetDatabaseSchemaContext(env, {
      legacyConfigPlan,
    });
    if (context.legacyConfigPlan) {
      return { config: context.config, hash: hashConfigRaw(context.configSnapshot.raw) };
    }
  }
  const snapshot = await withOwnedManagedUpdateEnv(env, () =>
    readConfigFileSnapshot({ skipPluginValidation: true, observe: false }),
  );
  return { config: snapshot.config, hash: hashConfigRaw(snapshot.raw) };
}
