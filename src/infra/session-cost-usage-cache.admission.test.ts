import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configEnv from "../config/config-env-vars.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import {
  acquireSessionCostUsageRefreshLock,
  deleteSessionCostUsageRollupsExcept,
  isSessionCostUsageRefreshRunning,
  readSessionCostUsageRollupRows,
  writeSessionCostUsageRollup,
} from "./session-cost-usage-cache.sqlite.js";
import * as integrityWorker from "./sqlite-integrity-worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
});

it.each(["acquire", "release", "rollup", "prune"] as const)(
  "queues warm usage %s behind the active writer reservation",
  async (operation) => {
    const root = tempDirs.make("openclaw-usage-writer-reservation-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const agentId = "usage-test";
      const database = openOpenClawAgentDatabase({ agentId });
      const databasePath = database.path;
      await writeSessionCostUsageRollup({
        agentId,
        databasePath,
        rollupId: "session.jsonl",
        previousValueJson: null,
        valueJson: '{"totalTokens":1}',
        updatedAt: 1,
      });
      let lock: Awaited<ReturnType<typeof acquireSessionCostUsageRefreshLock>> | undefined;
      if (operation === "release") {
        lock = await acquireSessionCostUsageRefreshLock(agentId, databasePath);
        expect(lock.acquired).toBe(true);
      }
      const readLock = () =>
        database.db
          .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
          .get("session-cost-usage", "refresh-lock");
      const readSnapshot = () => ({
        lock: readLock(),
        rows: readSessionCostUsageRollupRows(agentId, databasePath),
      });
      const before = readSnapshot();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const reservation = runOpenClawAgentWorkerWrite({ agentId, path: databasePath }, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let settled = false;
      const writing = (async () => {
        switch (operation) {
          case "acquire":
            lock = await acquireSessionCostUsageRefreshLock(agentId, databasePath);
            expect(lock.acquired).toBe(true);
            break;
          case "release":
            await lock!.release();
            break;
          case "rollup":
            expect(
              await writeSessionCostUsageRollup({
                agentId,
                databasePath,
                rollupId: "session.jsonl",
                previousValueJson: before.rows[0]!.valueJson,
                valueJson: '{"totalTokens":2}',
                updatedAt: 2,
              }),
            ).toBe(true);
            break;
          case "prune":
            await deleteSessionCostUsageRollupsExcept({
              agentId,
              databasePath,
              rows: before.rows,
              liveKeys: new Set(),
            });
            break;
        }
      })().finally(() => {
        settled = true;
      });
      const written = Promise.allSettled([writing]);
      try {
        try {
          await setImmediate();
          expect(readSnapshot()).toEqual(before);
          expect(settled).toBe(false);
        } finally {
          release.resolve();
          await reservation;
          await written;
        }
        await expect(writing).resolves.toBeUndefined();
        if (operation === "acquire") {
          expect(readLock()).toBeDefined();
        } else if (operation === "release") {
          expect(readLock()).toBeUndefined();
        } else {
          expect(readSessionCostUsageRollupRows(agentId, databasePath)).toEqual(
            operation === "prune"
              ? []
              : [{ key: "session.jsonl", valueJson: '{"totalTokens":2}', updatedAt: 2 }],
          );
        }
      } finally {
        await lock?.release();
      }
    });
  },
);

it.each([
  { closing: false, retarget: false, refresh: false },
  { closing: true, retarget: false, refresh: false },
  { closing: false, retarget: true, refresh: false },
  { closing: false, retarget: true, refresh: true },
])(
  "joins pending native admission before a usage write (closing=$closing, retarget=$retarget, refresh=$refresh)",
  async ({ closing, retarget, refresh }) => {
    const root = tempDirs.make("openclaw-usage-admission-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const agentId = "usage-test";
      const databasePath = openOpenClawAgentDatabase({ agentId }).path;
      closeOpenClawAgentDatabasesForTest();
      const cwd = retarget
        ? vi.spyOn(process, "cwd").mockReturnValue(path.dirname(databasePath))
        : undefined;
      const retargeted = path.join(root, "other-cwd");
      if (retarget) {
        fs.mkdirSync(retargeted);
      }
      const sessionsDir = path.join(root, "sessions");
      const sessionFile = path.join(sessionsDir, "session.jsonl");
      if (refresh) {
        fs.mkdirSync(sessionsDir);
        fs.writeFileSync(
          sessionFile,
          JSON.stringify({ message: { role: "user", content: "hello" } }),
        );
      }
      const cachePath = retarget ? path.basename(databasePath) : databasePath;
      const nativeFinished = createDeferredCore();
      const release = createDeferredCore();
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (...args) => {
          try {
            await check(...args);
            nativeFinished.resolve();
            await release.promise;
          } catch (error) {
            nativeFinished.reject(error);
            throw error;
          }
        },
      );
      const opening = withOpenClawAgentDatabaseAsync(
        { agentId, path: databasePath },
        () => undefined,
      );
      const opened = Promise.allSettled([opening]);
      let writeSettled = false;
      const writing = Promise.resolve()
        .then(async () =>
          refresh
            ? await refreshCostUsageCacheForAgent({
                agentId,
                databasePath: cachePath,
                sessionsDir,
                agentDir: path.join(root, "agent-config"),
              })
            : await writeSessionCostUsageRollup({
                agentId,
                databasePath: cachePath,
                rollupId: "session.jsonl",
                previousValueJson: null,
                valueJson: '{"totalTokens":7}',
                updatedAt: 1,
              }),
        )
        .finally(() => {
          writeSettled = true;
        });
      const written = Promise.allSettled([writing]);
      let drain: Promise<void> | undefined;
      let drained = false;
      try {
        await nativeFinished.promise;
        await setImmediate();
        expect(writeSettled).toBe(false);
        expect(readSessionCostUsageRollupRows(agentId, databasePath)).toEqual([]);
        cwd?.mockReturnValue(retargeted);
        if (closing) {
          drain = closeOpenClawAgentDatabasesAsync(root).then(() => {
            drained = true;
          });
          await setImmediate();
          expect(drained).toBe(false);
        }
        release.resolve();
        await opened;
        const [outcome] = await written;
        if (closing) {
          await drain;
          expect(outcome.status).toBe("rejected");
          expect(readSessionCostUsageRollupRows(agentId, databasePath)).toEqual([]);
        } else {
          expect(outcome).toEqual({ status: "fulfilled", value: refresh ? "refreshed" : true });
          expect(fs.existsSync(path.join(retargeted, path.basename(databasePath)))).toBe(false);
          const rows = readSessionCostUsageRollupRows(agentId, databasePath);
          if (refresh) {
            expect(rows.map((row) => row.key)).toEqual([sessionFile]);
          } else {
            expect(rows).toEqual([
              { key: "session.jsonl", valueJson: '{"totalTokens":7}', updatedAt: 1 },
            ]);
          }
        }
      } finally {
        release.resolve();
        await opened;
        await written;
        await drain;
      }
    });
  },
);

it("keeps refresh ownership after a rejected release until deletion commits", async () => {
  const root = tempDirs.make("openclaw-usage-lock-release-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    const agentId = "usage-test";
    const owners = await Promise.all([
      acquireSessionCostUsageRefreshLock(agentId),
      acquireSessionCostUsageRefreshLock(agentId),
    ]);
    expect(owners.map((owner) => owner.acquired)).toEqual([true, false]);
    await owners[1].release();
    expect(await isSessionCostUsageRefreshRunning(agentId)).toBe(true);
    const database = openOpenClawAgentDatabase({ agentId });
    database.db.exec(`
      CREATE TEMP TRIGGER reject_refresh_release BEFORE DELETE ON cache_entries
      WHEN OLD.scope = 'session-cost-usage' AND OLD.key = 'refresh-lock'
      BEGIN SELECT RAISE(ABORT, 'release rejected'); END;
    `);
    await expect(owners[0].release()).rejects.toThrow("release rejected");
    expect(await isSessionCostUsageRefreshRunning(agentId)).toBe(true);
    database.db.exec("DROP TRIGGER reject_refresh_release");
    await owners[0].release();
    expect(await isSessionCostUsageRefreshRunning(agentId)).toBe(false);
    const replacement = await acquireSessionCostUsageRefreshLock(agentId);
    expect(replacement.acquired).toBe(true);
    await owners[0].release();
    expect(await isSessionCostUsageRefreshRunning(agentId)).toBe(true);
    await replacement.release();
  });
});

it("reads the committed refresh lock while acquisition waits for the writer reservation", async () => {
  const root = tempDirs.make("openclaw-usage-status-race-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    const agentId = "usage-test";
    const database = openOpenClawAgentDatabase({ agentId });
    database.db
      .prepare("INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
      .run("session-cost-usage", "refresh-lock", "{}", 1);
    const readLock = () =>
      database.db
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get("session-cost-usage", "refresh-lock");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const reservation = runOpenClawAgentWorkerWrite({ agentId, path: database.path }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let owner: Awaited<ReturnType<typeof acquireSessionCostUsageRefreshLock>> | undefined;
    const acquiring = acquireSessionCostUsageRefreshLock(agentId, database.path).then((lock) => {
      owner = lock;
      return lock;
    });
    let observed: boolean | undefined;
    const reading = isSessionCostUsageRefreshRunning(agentId, database.path).then((running) => {
      observed = running;
      return running;
    });
    const outcomes = Promise.allSettled([acquiring, reading]);
    try {
      await setImmediate();
      expect(observed).toBe(false);
      expect(owner).toBeUndefined();
      expect(readLock()).toEqual({ value_json: "{}" });
      release.resolve();
      await reservation;
      const acquired = await acquiring;
      expect(acquired.acquired).toBe(true);
      expect(await reading).toBe(false);
      expect(await isSessionCostUsageRefreshRunning(agentId, database.path)).toBe(true);
      await acquired.release();
      expect(readLock()).toBeUndefined();
      expect(await isSessionCostUsageRefreshRunning(agentId, database.path)).toBe(false);
    } finally {
      release.resolve();
      await reservation;
      await outcomes;
      await owner?.release();
    }
  });
});

it("releases the acquired refresh lock after the caller changes its state directory", async () => {
  const originalRoot = tempDirs.make("openclaw-usage-lock-origin-");
  const otherRoot = tempDirs.make("openclaw-usage-lock-other-");
  const agentId = "usage-test";
  await withEnvAsync({ OPENCLAW_STATE_DIR: originalRoot }, async () => {
    const databasePath = openOpenClawAgentDatabase({ agentId }).path;
    const original = await acquireSessionCostUsageRefreshLock(agentId);
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: otherRoot }, async () => {
        const other = await acquireSessionCostUsageRefreshLock(agentId);
        try {
          await original.release();
          expect(await isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(false);
          expect(await isSessionCostUsageRefreshRunning(agentId)).toBe(true);
        } finally {
          await other.release();
        }
      });
    } finally {
      await original.release();
    }
  });
});

it("keeps a queued usage lock and release in its mixed-case Windows state root", async () => {
  await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
    const agentId = "usage-test";
    const options = { agentId, env: state.env };
    const database = openOpenClawAgentDatabase(options);
    const shared = openOpenClawStateDatabase({ env: state.env });
    const registry = () =>
      shared.db.prepare("SELECT agent_id, path FROM agent_databases ORDER BY agent_id, path").all();
    const beforeRegistry = registry();
    const readLock = () =>
      database.db
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get("session-cost-usage", "refresh-lock");
    const defaultRoot = path.join(state.home, ".openclaw");
    const laterRoot = state.path("later-state");
    expect(fs.existsSync(defaultRoot)).toBe(false);
    expect(fs.existsSync(laterRoot)).toBe(false);
    const originalEnv = process.env;
    const hostPlatform = process.platform;
    const mixedCaseEnv = { ...originalEnv };
    for (const key of Object.keys(mixedCaseEnv)) {
      if (key.toUpperCase() === "OPENCLAW_STATE_DIR") {
        delete mixedCaseEnv[key];
      }
    }
    mixedCaseEnv.OpenClaw_State_Dir = state.stateDir;
    const cloneEnv = configEnv.cloneEnvWithPlatformSemantics;
    expect(mixedCaseEnv.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(withMockedPlatform("win32", () => cloneEnv(mixedCaseEnv)).OPENCLAW_STATE_DIR).toBe(
      state.stateDir,
    );
    const clone = vi.spyOn(configEnv, "cloneEnvWithPlatformSemantics").mockImplementation((input) =>
      // Only the pure clone sees Windows; path resolution and SQLite use the real host.
      withMockedPlatform("win32", () => cloneEnv(input)),
    );
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const reservation = runOpenClawAgentWorkerWrite(
      { ...options, path: database.path },
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    let owner: Awaited<ReturnType<typeof acquireSessionCostUsageRefreshLock>> | undefined;
    let acquiring: ReturnType<typeof acquireSessionCostUsageRefreshLock> | undefined;
    try {
      await entered.promise;
      process.env = mixedCaseEnv;
      acquiring = acquireSessionCostUsageRefreshLock(agentId).then((lock) => {
        owner = lock;
        return lock;
      });
      void acquiring.catch(() => {});
      process.env = { ...originalEnv, OPENCLAW_STATE_DIR: laterRoot };
      expect(process.platform).toBe(hostPlatform);
      await setImmediate();
      expect(readLock()).toBeUndefined();
      expect(owner).toBeUndefined();
      release.resolve();
      await reservation;
      const acquired = await acquiring;
      expect(acquired.acquired).toBe(true);
      expect(readLock()).toMatchObject({ value_json: expect.any(String) });
      expect(registry()).toEqual(beforeRegistry);
      expect(fs.existsSync(defaultRoot)).toBe(false);
      expect(fs.existsSync(laterRoot)).toBe(false);
      await acquired.release();
      expect(readLock()).toBeUndefined();
      expect(registry()).toEqual(beforeRegistry);
      expect(fs.existsSync(defaultRoot)).toBe(false);
      expect(fs.existsSync(laterRoot)).toBe(false);
    } finally {
      process.env = originalEnv;
      release.resolve();
      await Promise.allSettled([reservation, acquiring]);
      try {
        await owner?.release();
      } finally {
        clone.mockRestore();
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
      }
    }
  });
});
