import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});

const supportedVersions = {
  state: OPENCLAW_STATE_SCHEMA_VERSION,
  agent: OPENCLAW_AGENT_SCHEMA_VERSION,
};
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});
beforeEach(() => {
  vi.stubEnv("XDG_CACHE_HOME", tempDirs.make("openclaw-preflight-lifecycle-cache-"));
});

function expectReadLeaseHeld(databasePath: string) {
  let exclusion: ReturnType<typeof acquireStateDatabaseHandleExclusion> | undefined;
  try {
    expect(() => {
      exclusion = acquireStateDatabaseHandleExclusion({ databasePath, busyTimeoutMs: 0 });
    }).toThrow(/state-handles/);
  } finally {
    exclusion?.release();
  }
}

it.each(["success", "failure", "cancel"] as const)(
  "joins all direct-read children and releases their leases before %s settlement",
  async (outcome) => {
    const root = tempDirs.make("openclaw-preflight-reader-lifecycle-");
    const initializedEnv = { OPENCLAW_STATE_DIR: path.join(root, "initialized") };
    const paths = [
      openOpenClawAgentDatabase({ agentId: "first", env: initializedEnv }).path,
      openOpenClawAgentDatabase({ agentId: "second", env: initializedEnv }).path,
      openOpenClawAgentDatabase({ agentId: "queued", env: initializedEnv }).path,
    ] as const;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    for (const [index, pathname] of paths.entries()) {
      const database = new DatabaseSync(pathname);
      try {
        database.exec("PRAGMA journal_mode=DELETE;");
        if (outcome === "failure" && index === 0) {
          database.exec(
            "PRAGMA foreign_keys=OFF; CREATE TABLE lifecycle_parent(id INTEGER PRIMARY KEY); CREATE TABLE lifecycle_child(parent_id REFERENCES lifecycle_parent(id)); INSERT INTO lifecycle_child VALUES (42);",
          );
        }
      } finally {
        database.close();
      }
    }

    const marker = (name: string) => path.join(root, name);
    const preload = marker("pause-reader-close.cjs");
    const sources = paths.map((pathname) =>
      path.toNamespacedPath(fs.realpathSync.native(pathname)),
    );
    fs.writeFileSync(
      preload,
      `
      const fs = require('node:fs'), path = require('node:path');
      const { DatabaseSync } = require('node:sqlite');
      const root = ${JSON.stringify(root)}, sources = ${JSON.stringify(sources)};
      const close = DatabaseSync.prototype.close;
      DatabaseSync.prototype.close = function() {
        const location = this.location();
        const index = location ? sources.indexOf(path.toNamespacedPath(path.resolve(location))) : -1;
        if (index >= 0) {
          fs.writeFileSync(path.join(root, 'close-' + index), 'ready');
          if (index < 2) {
            const deadline = Date.now() + 15000;
            const pause = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(path.join(root, 'release-' + index))) {
              if (Date.now() > deadline) throw new Error('test reader close pause expired');
              Atomics.wait(pause, 0, 0, 10);
            }
          }
        }
        return close.call(this);
      };
      `,
    );
    for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
      vi.stubEnv(key, value);
    }
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation");
    vi.mocked(fork).mockClear();
    const controller = new AbortController();
    const cancellation = new Error("intentional reader cancellation");
    let settled = false;
    const run = preflightOpenClawDatabaseSchemas({
      env: { OPENCLAW_STATE_DIR: path.join(root, "absent-state") },
      supportedVersions,
      configuredAgentDatabaseCandidatePaths: paths,
      verifyCurrentSchemaShape: true,
      requireStartupMigrationReadiness: true,
      signal: controller.signal,
    });
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let childClosures: Promise<void>[] = [];
    try {
      await vi.waitFor(
        () => {
          expect(fs.existsSync(marker("close-0"))).toBe(true);
          expect(fs.existsSync(marker("close-1"))).toBe(true);
        },
        { timeout: 10_000 },
      );
      expect(settled).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(fork).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(marker("close-2"))).toBe(false);
      for (const pathname of paths.slice(0, 2)) {
        expectReadLeaseHeld(pathname);
      }

      const children = vi
        .mocked(fork)
        .mock.results.filter((result) => result.type === "return")
        .map(({ value }) => value);
      let closedChildren = 0;
      childClosures = children.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("close", () => {
              closedChildren += 1;
              resolve();
            });
          }),
      );
      if (outcome === "cancel") {
        controller.abort(cancellation);
        await expect(run).rejects.toBe(cancellation);
      } else {
        fs.writeFileSync(marker("release-0"), "resume");
        if (outcome === "failure") {
          await childClosures[0];
          // Drain the first child's result before checking the still-owned peer.
          await setImmediate();
          expect(settled).toBe(false);
          expectReadLeaseHeld(paths[1]);
          expect(fork).toHaveBeenCalledTimes(2);
        }
        fs.writeFileSync(marker("release-1"), "resume");
        if (outcome === "failure") {
          await expect(run).rejects.toMatchObject({ name: "SqliteIntegrityError" });
        } else {
          await expect(run).resolves.toEqual({ incompatible: [], indeterminate: [] });
        }
      }
      expect(closedChildren).toBe(2);
      expect(fork).toHaveBeenCalledTimes(outcome === "success" ? 3 : 2);
      expect(fs.existsSync(marker("close-2"))).toBe(outcome === "success");
      for (const databasePath of paths) {
        acquireStateDatabaseHandleExclusion({ databasePath, busyTimeoutMs: 0 }).release();
      }
    } finally {
      fs.writeFileSync(marker("release-0"), "resume");
      fs.writeFileSync(marker("release-1"), "resume");
      controller.abort(cancellation);
      await Promise.allSettled([run, ...childClosures]);
    }
  },
);

function createSnapshotCandidates() {
  const env = {
    OPENCLAW_STATE_DIR: tempDirs.make("openclaw-preflight-lifecycle-state-"),
  };
  const directory = tempDirs.make("openclaw-preflight-lifecycle-agents-");
  const { DatabaseSync } = requireNodeSqlite();
  const paths = [0, 1, 2].map((index) => path.join(directory, `agent-${index}.sqlite`));

  // Closed WAL families retain the private snapshot recovery path.
  for (const pathname of paths) {
    const database = new DatabaseSync(pathname);
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version = ${supportedVersions.agent + 1};`);
    database.close();
    expect(fs.existsSync(`${pathname}-wal`)).toBe(false);
    expect(fs.existsSync(`${pathname}-shm`)).toBe(false);
  }

  return { env, paths };
}

it("drains started agent snapshots before rejecting cancellation", async () => {
  const fixture = createSnapshotCandidates();
  const agentPaths = new Set(fixture.paths.map((pathname) => fs.realpathSync.native(pathname)));
  const prepare = snapshots.prepareSqliteReadOnlyLocation;
  const cleanupRelease = createDeferred();
  const twoCleanupsStarted = createDeferred();
  const preparedAgentPaths: string[] = [];
  const preparedAgentLocations: string[] = [];
  const cleanedAgentPaths: string[] = [];
  let cleanupCount = 0;
  let activeAgentSnapshots = 0;
  let peakAgentSnapshots = 0;

  vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
    async (pathname, options) => {
      const prepared = await prepare(pathname, options);
      if (!agentPaths.has(pathname)) {
        return prepared;
      }

      preparedAgentPaths.push(pathname);
      preparedAgentLocations.push(prepared.location);
      activeAgentSnapshots += 1;
      peakAgentSnapshots = Math.max(peakAgentSnapshots, activeAgentSnapshots);

      return {
        ...prepared,
        cleanupAsync: async () => {
          cleanupCount += 1;
          if (cleanupCount === 2) {
            twoCleanupsStarted.resolve();
          }
          await cleanupRelease.promise;
          const removed = await prepared.cleanupAsync();
          activeAgentSnapshots -= 1;
          cleanedAgentPaths.push(pathname);
          return removed;
        },
      };
    },
  );

  const controller = new AbortController();
  const cancellation = new Error("intentional preflight cancellation");
  let settled = false;
  const run = preflightOpenClawDatabaseSchemas({
    env: fixture.env,
    supportedVersions,
    requireStartupMigrationReadiness: true,
    configuredAgentDatabaseCandidatePaths: fixture.paths,
    signal: controller.signal,
  });

  void run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  let settledBeforeCleanupRelease = true;
  let preparedBeforeCleanupRelease = -1;
  try {
    await withTestTimeout(
      twoCleanupsStarted.promise,
      10_000,
      "two agent snapshots did not reach cleanup",
    );

    expect(preparedAgentPaths).toHaveLength(2);
    expect(activeAgentSnapshots).toBe(2);
    expect(peakAgentSnapshots).toBe(2);
    expect(preparedAgentLocations).toHaveLength(2);
    for (const location of preparedAgentLocations) {
      expect(fs.existsSync(path.dirname(location))).toBe(true);
    }

    controller.abort(cancellation);
    await Promise.resolve();

    settledBeforeCleanupRelease = settled;
    preparedBeforeCleanupRelease = preparedAgentPaths.length;
  } finally {
    cleanupRelease.resolve();
    controller.abort(cancellation);
    await Promise.allSettled([run]);
  }

  await expect(run).rejects.toThrow("intentional preflight cancellation");

  expect(settledBeforeCleanupRelease).toBe(false);
  expect(preparedBeforeCleanupRelease).toBe(2);
  expect(preparedAgentPaths).toHaveLength(2);
  expect(cleanedAgentPaths).toHaveLength(2);
  expect(activeAgentSnapshots).toBe(0);
  expect(peakAgentSnapshots).toBe(2);
  for (const location of preparedAgentLocations) {
    expect(fs.existsSync(path.dirname(location))).toBe(false);
  }
});

it("drains a concurrent agent snapshot before propagating readiness failure", async () => {
  const fixture = createSnapshotCandidates();
  const agentPaths = new Set(fixture.paths.map((pathname) => fs.realpathSync.native(pathname)));
  const prepare = snapshots.prepareSqliteReadOnlyLocation;
  const secondPrepared = createDeferred();
  const peerCleanupStarted = createDeferred();
  const peerCleanupRelease = createDeferred();
  const failingCleanupDone = createDeferred();
  const preparedAgentPaths: string[] = [];
  const preparedAgentLocations: string[] = [];
  let peerCleanupFinished = false;

  vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
    async (pathname, options) => {
      const prepared = await prepare(pathname, options);
      if (!agentPaths.has(pathname)) {
        return prepared;
      }

      const ordinal = preparedAgentPaths.length;
      preparedAgentPaths.push(pathname);
      preparedAgentLocations.push(prepared.location);

      if (ordinal === 0) {
        await secondPrepared.promise;
        return {
          ...prepared,
          location: path.join(path.dirname(prepared.location), "missing.sqlite"),
          cleanupAsync: async () => {
            const removed = await prepared.cleanupAsync();
            failingCleanupDone.resolve();
            return removed;
          },
        };
      }

      if (ordinal === 1) {
        secondPrepared.resolve();
        return {
          ...prepared,
          cleanupAsync: async () => {
            peerCleanupStarted.resolve();
            await peerCleanupRelease.promise;
            const removed = await prepared.cleanupAsync();
            peerCleanupFinished = true;
            return removed;
          },
        };
      }

      return prepared;
    },
  );

  let settled = false;
  const run = preflightOpenClawDatabaseSchemas({
    env: fixture.env,
    supportedVersions,
    requireStartupMigrationReadiness: true,
    configuredAgentDatabaseCandidatePaths: fixture.paths,
  });

  void run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  let settledBeforePeerCleanupRelease = true;
  let preparedBeforePeerCleanupRelease = -1;
  try {
    await withTestTimeout(
      peerCleanupStarted.promise,
      10_000,
      "concurrent agent snapshot did not reach cleanup",
    );
    await withTestTimeout(
      failingCleanupDone.promise,
      10_000,
      "failing agent snapshot did not clean up",
    );
    await Promise.resolve();

    settledBeforePeerCleanupRelease = settled;
    preparedBeforePeerCleanupRelease = preparedAgentPaths.length;
  } finally {
    secondPrepared.resolve();
    peerCleanupRelease.resolve();
    await Promise.allSettled([run]);
  }

  await expect(run).rejects.toThrow();

  expect(settledBeforePeerCleanupRelease).toBe(false);
  expect(preparedBeforePeerCleanupRelease).toBe(2);
  expect(preparedAgentPaths).toHaveLength(2);
  expect(peerCleanupFinished).toBe(true);
  expect(preparedAgentLocations).toHaveLength(2);
  for (const location of preparedAgentLocations) {
    expect(fs.existsSync(path.dirname(location))).toBe(false);
  }
});
