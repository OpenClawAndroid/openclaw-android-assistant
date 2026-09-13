// These consumers need the host-owned SQLite broker, which runs in forked processes.
export const databaseWorkerCoreTestFiles = [
  "src/agents/agent-tools.at-prefixed-remote-paths.test.ts",
  "src/agents/agent-tools.create-openclaw-coding-tools.test.ts",
  "src/agents/memory-write-provenance.test.ts",
  "src/commands/doctor-maintenance.worker.test.ts",
  "src/memory/memory-artifact-provenance.test.ts",
  "src/plugin-sdk/memory-host-core.test.ts",
  "src/plugin-sdk/memory-host-events.test.ts",
  "src/plugin-sdk/outbound-media.test.ts",
  "src/plugin-sdk/outbound-media.bulk.test.ts",
  "src/plugin-sdk/outbound-media.retention.test.ts",
  "src/plugin-sdk/provider-auth.test.ts",
  "src/plugin-sdk/provider-auth-copilot-cache.test.ts",
  "src/plugins/doctor-contract-registry.load-paths.test.ts",
  "src/tasks/task-registry.test.ts",
  "test/plugins/beam-http-identity.test.ts",
  "src/plugin-sdk/runtime-doctor-migrations.test.ts",
  "src/plugin-state/plugin-state-store.test.ts",
  "src/plugin-state/plugin-state-store.bulk.test.ts",
  "src/plugin-state/plugin-state-store.errors.test.ts",
  "src/plugin-state/plugin-state-store.expiry.test.ts",
  "src/plugin-state/plugin-state-store.fresh-store.test.ts",
  "src/plugin-state/plugin-state-store.retention.test.ts",
  "src/plugin-state/plugin-state-store.runtime.test.ts",
  "src/plugin-state/plugin-state-store.schema.test.ts",
];

const databaseWorkerCoreTestFileSet = new Set(databaseWorkerCoreTestFiles);

// Preserve watch admission for the two consumers previously inferred into fast lanes.
export const databaseWorkerCoreFormerFastKinds = new Map([
  ["src/plugin-sdk/memory-host-events.test.ts", "unitFastFakeTimers"],
  ["src/plugin-sdk/outbound-media.bulk.test.ts", "unitFast"],
]);

export const DATABASE_WORKER_WATCH_OWNER_ENV_KEY = "OPENCLAW_VITEST_DATABASE_WORKER_WATCH_OWNER";
export const DATABASE_WORKER_WATCH_TESTS_ENV_KEY = "OPENCLAW_VITEST_DATABASE_WORKER_WATCH_TESTS";

export function isDatabaseWorkerCoreTestFile(file) {
  return databaseWorkerCoreTestFileSet.has(file.replaceAll("\\", "/"));
}
