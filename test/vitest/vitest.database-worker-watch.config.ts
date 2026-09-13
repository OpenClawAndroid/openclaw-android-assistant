import { loadConfigFromFile, type UserConfig } from "vite";
import { defineConfig } from "vitest/config";
import {
  DATABASE_WORKER_WATCH_OWNER_ENV_KEY,
  DATABASE_WORKER_WATCH_TESTS_ENV_KEY,
  databaseWorkerCoreTestFiles,
} from "./vitest.database-worker-core-paths.mjs";
import { createInfraVitestConfig } from "./vitest.infra.config.ts";
import { intersectIncludePatterns, loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { resolveRepoRootPath } from "./vitest.shared.config.ts";

export function createDatabaseWorkerWatchVitestConfig(
  owner: UserConfig,
  workerTests: string[],
  env: Record<string, string | undefined> = process.env,
) {
  const infra = createInfraVitestConfig({ ...env, OPENCLAW_VITEST_INCLUDE_FILE: undefined });
  return defineConfig({
    test: {
      projects: [
        { ...owner, extends: false },
        {
          ...infra,
          extends: false,
          test: {
            ...infra.test,
            include:
              intersectIncludePatterns(
                workerTests,
                loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env),
              ) ?? workerTests,
          },
        },
      ],
    },
  });
}

export default defineConfig(async () => {
  const ownerPath = process.env[DATABASE_WORKER_WATCH_OWNER_ENV_KEY];
  if (!ownerPath) {
    throw new Error("database worker watch requires its selected test owner");
  }
  const workerTests: unknown = JSON.parse(
    process.env[DATABASE_WORKER_WATCH_TESTS_ENV_KEY] ?? "null",
  );
  if (
    !Array.isArray(workerTests) ||
    !workerTests.every(
      (file): file is string =>
        typeof file === "string" && databaseWorkerCoreTestFiles.includes(file),
    )
  ) {
    throw new Error("database worker watch requires its selected worker tests");
  }
  const owner = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    resolveRepoRootPath(ownerPath),
  );
  if (!owner) {
    throw new Error(`could not load database worker watch owner: ${ownerPath}`);
  }
  return createDatabaseWorkerWatchVitestConfig(owner.config, workerTests);
});
