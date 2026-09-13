import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as integrity from "../infra/sqlite-integrity.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { snapshotPreflightSourceManifest } from "./openclaw-database-preflight.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([false, true])(
  "checks startup agent integrity off the main thread without changing source artifacts (foreign-key damage: %s)",
  async (damaged) => {
    const stateDir = tempDirs.make("openclaw-startup-integrity-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (damaged) {
      const database = new (requireNodeSqlite().DatabaseSync)(agentPath);
      try {
        database.exec(
          "PRAGMA foreign_keys = OFF; CREATE TABLE integrity_probe_parent(id INTEGER PRIMARY KEY); CREATE TABLE integrity_probe_child(parent_id INTEGER REFERENCES integrity_probe_parent(id)); INSERT INTO integrity_probe_child VALUES (42);",
        );
      } finally {
        database.close();
      }
    }
    const before = snapshotPreflightSourceManifest(stateDir);
    const check = integrity.assertSqliteIntegrity;
    const mainThreadAgentChecks: string[] = [];
    vi.spyOn(integrity, "assertSqliteIntegrity").mockImplementation((database, label) => {
      if (label === agentPath) {
        mainThreadAgentChecks.push(label);
      }
      return check(database, label);
    });

    const readiness = assertOpenClawDatabasesReady({
      env,
      operation: "gateway-startup",
      config: {},
    });
    if (damaged) {
      await expect(readiness).rejects.toMatchObject({
        name: "SqliteIntegrityError",
        message: expect.stringContaining(`foreign_key_check failed for ${agentPath}`),
      });
    } else {
      await expect(readiness).resolves.toBeUndefined();
    }
    expect(mainThreadAgentChecks).toEqual([]);
    expect(snapshotPreflightSourceManifest(stateDir)).toEqual(before);
  },
);
