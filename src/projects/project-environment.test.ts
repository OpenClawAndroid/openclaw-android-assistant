import path from "node:path";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  checkout: vi.fn(),
  refresh: vi.fn(),
  forbiddenSqlite: vi.fn(() => {
    throw new Error("Project environment tests must not open SQLite");
  }),
  forbiddenFilesystem: vi.fn(() => {
    throw new Error("Project environment tests must not access the filesystem");
  }),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    realpath: mocks.forbiddenFilesystem,
    stat: mocks.forbiddenFilesystem,
    rm: mocks.forbiddenFilesystem,
    rmdir: mocks.forbiddenFilesystem,
  },
}));
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: mocks.forbiddenSqlite,
}));
vi.mock("../infra/kysely-sync.js", () => ({
  executeSqliteQuerySync: mocks.forbiddenSqlite,
  executeSqliteQueryTakeFirstSync: mocks.forbiddenSqlite,
  getNodeSqliteKysely: mocks.forbiddenSqlite,
}));
vi.mock("../state/openclaw-state-db.js", () => ({
  openOpenClawStateDatabase: mocks.forbiddenSqlite,
  runOpenClawStateWriteTransaction: mocks.forbiddenSqlite,
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runWithOpenClawStateLeaseWorker: async (
    _lease: unknown,
    context: unknown,
    run: (
      scope: { execute: (command: unknown) => Promise<unknown> },
      identity: { scope: string; key: string; owner: string },
    ) => Promise<unknown>,
  ) =>
    await run(
      { execute: async (command) => await mocks.execute(context, command) },
      { scope: "projects.checkout", key: "fixture-checkout", owner: "fixture-owner" },
    ),
}));
vi.mock("../state/openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: (databasePath: string) => ({
    databasePath,
    assertCurrent() {},
  }),
}));
vi.mock("../state/openclaw-state-db-async-lifecycle.js", () => ({
  getOpenClawDatabaseMaintenanceScope: () => undefined,
}));
vi.mock("../infra/state-database-coordinator.js", () => ({
  captureStateDatabaseCoordinatorRuntime: () => ({
    directory: "/synthetic-coordinator",
    keepAlive: false,
  }),
}));
vi.mock("./project-checkout.js", () => ({
  withProjectCheckoutLifecycle: mocks.checkout,
}));
vi.mock("./project-clone-runtime.js", () => ({
  ProjectCloneError: class extends Error {},
  refreshProjectCheckout: mocks.refresh,
}));
vi.mock("./project-registry.kernel.js", () => ({
  ensureProjectRegistrySchema: mocks.forbiddenSqlite,
  rowToProject: mocks.forbiddenSqlite,
}));

import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { refreshProjectClone } from "./project-clone.js";
import type { ProjectRegistryRecord } from "./project-registry.kernel.js";

const root = path.resolve("/synthetic-project-state");
const databasePath = path.join(root, "state", "openclaw.sqlite");
const project: ProjectRegistryRecord = {
  id: "fixture-project",
  displayName: "Project",
  repoRoot: path.resolve("/synthetic-repository/project"),
  source: "cloned",
  originUrl: "https://github.com/example/project.git",
};

it.each(["plain", "precloned"] as const)(
  "retains %s Windows state for refresh after caller changes",
  async (environment) => {
    await withMockedPlatform("win32", async () => {
      vi.clearAllMocks();
      const supplied: NodeJS.ProcessEnv = {
        HOME: path.resolve("/synthetic-home"),
        USERPROFILE: path.resolve("/synthetic-home"),
        NODE_ENV: "test",
        OPENCLAW_TEST_FAST: "1",
        OpenClaw_State_Dir: root,
        OpenClaw_Supervisor_Mode: "external",
      };
      const caller =
        environment === "precloned" ? cloneEnvWithPlatformSemantics(supplied) : supplied;
      const options = { env: caller };
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const lease: OpenClawStateLeaseContext = {
        signal: new AbortController().signal,
        assertOwned() {},
        assertOwnedInTransaction: mocks.forbiddenSqlite,
      };
      mocks.checkout.mockImplementation(async (_root, _options, run) => {
        entered.resolve();
        await resume.promise;
        return await run(lease);
      });
      mocks.refresh.mockResolvedValue(undefined);
      mocks.execute.mockResolvedValue(project);
      const pending = refreshProjectClone(project, options);
      const joined = pending.then(
        () => undefined,
        () => undefined,
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Project operation completed before its awaited boundary");
          }),
        ]);
        caller.OpenClaw_State_Dir = path.resolve("/mutated-project-state");
        caller.OpenClaw_Supervisor_Mode = "internal";
        options.env = { ...caller, OpenClaw_State_Dir: path.resolve("/replaced-project-state") };
        resume.resolve();
        await pending;
        expect(mocks.execute).toHaveBeenCalled();
        for (const [context] of mocks.execute.mock.calls) {
          expect(context.environment).toEqual({
            OPENCLAW_STATE_DIR: root,
            OPENCLAW_SUPERVISOR_MODE: "external",
          });
          expect(context.admission.databasePath).toBe(databasePath);
        }
        for (const [, captured] of mocks.checkout.mock.calls) {
          expect(captured.path).toBe(databasePath);
          expect(captured.env.OPENCLAW_STATE_DIR).toBe(root);
          expect(captured.env.OPENCLAW_SUPERVISOR_MODE).toBe("external");
          expect(captured.env).not.toBe(caller);
        }
        expect(mocks.refresh).toHaveBeenCalledWith(
          { target: project.repoRoot, url: project.originUrl },
          expect.objectContaining({ env: expect.objectContaining({ OPENCLAW_STATE_DIR: root }) }),
        );
        expect(caller.OpenClaw_State_Dir).toBe(path.resolve("/mutated-project-state"));
        expect(mocks.forbiddenSqlite).not.toHaveBeenCalled();
        expect(mocks.forbiddenFilesystem).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await joined;
      }
    });
  },
);
