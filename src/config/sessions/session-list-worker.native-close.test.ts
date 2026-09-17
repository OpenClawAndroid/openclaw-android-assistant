import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { revokeAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import {
  listSessionEntriesReadOnlyAsync,
  readSessionListPageReadOnlyAsync,
} from "./session-accessor.sqlite-list-read.js";
import { addSessionMember } from "./session-sharing-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function expectCompetingWriterBlocked(databasePath: string): void {
  // A same-process connection can trust SQLite's inode table after a raw close
  // dropped the kernel lock. The independent process tests actual exclusion.
  const competitor = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(process.argv[1]);
        try {
          database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK;");
          process.exitCode = 2;
        } catch (error) {
          if (error.errcode !== 5) throw error;
          process.stdout.write("SQLITE_BUSY");
        } finally {
          database.close();
        }
      `,
      databasePath,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(competitor.error).toBeUndefined();
  expect(competitor.status, competitor.stderr).toBe(0);
  expect(competitor.stdout).toBe("SQLITE_BUSY");
}

async function retireMetadataReader(databasePath: string): Promise<void> {
  const pending = revokeAgentDatabaseResources({ path: databasePath, agentId: "main" });
  expect(pending.length).toBeGreaterThan(0);
  await Promise.all(pending);
}

describe.runIf(process.platform === "linux" && !process.versions.bun)(
  "metadata worker native reader retirement",
  () => {
    it.each(["DELETE", "WAL"] as const)(
      "preserves the main writer's %s lock and reads only committed metadata and membership",
      async (journalMode) => {
        const env = { OPENCLAW_STATE_DIR: tempDirs.make("metadata-worker-native-close-") };
        const sessionKey = "agent:main:native-close";
        const sessionId = "native-close-session";
        const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
        const scope = { agentId: "main", env, sessionKey };
        const listScope = { ...scope, storePath: databasePath, projection: "list" as const };
        let writer: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
        try {
          replaceSessionEntrySync(scope, { sessionId, updatedAt: 1, label: "committed" });
          addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 1 });
          writer = openOpenClawAgentDatabase({ agentId: "main", env });
          expect(writer.db.prepare(`PRAGMA journal_mode=${journalMode}`).get()).toEqual({
            journal_mode: journalMode.toLowerCase(),
          });
          writer.db.exec("BEGIN IMMEDIATE");
          writer.db
            .prepare(
              "UPDATE session_nodes SET entry_json = ?, label = ?, updated_at = ? WHERE session_key = ?",
            )
            .run(JSON.stringify({ sessionId, updatedAt: 2, label: "next" }), "next", 2, sessionKey);
          writer.db
            .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
            .run(sessionKey);
          writer.db
            .prepare("UPDATE session_members SET identity_id = ? WHERE session_key = ?")
            .run("next-guest", sessionKey);

          expectCompetingWriterBlocked(databasePath);
          expect(
            await listSessionEntriesReadOnlyAsync({ ...listScope, clone: false }),
          ).toMatchObject([{ sessionKey, entry: { sessionId, updatedAt: 1, label: "committed" } }]);
          await retireMetadataReader(databasePath);
          expect(writer.db.isOpen).toBe(true);
          expect(writer.db.isTransaction).toBe(true);
          expectCompetingWriterBlocked(databasePath);

          // Retirement makes the selected-row request enter a fresh worker owner,
          // rather than borrowing the preceding inventory's warm host snapshot.
          const readPage = async (membershipIdentityId: string) => {
            using page = await readSessionListPageReadOnlyAsync(
              [{ ...listScope, sessionKeys: [sessionKey] }],
              {
                membershipIdentityId,
              },
            );
            return page.entries;
          };
          expect(await readPage("guest")).toMatchObject([
            {
              ok: true,
              value: {
                entries: [{ sessionKey, entry: { sessionId, updatedAt: 1, label: "committed" } }],
                membershipKeys: [sessionKey],
              },
            },
          ]);
          await retireMetadataReader(databasePath);
          expect(writer.db.isOpen).toBe(true);
          expect(writer.db.isTransaction).toBe(true);
          expectCompetingWriterBlocked(databasePath);

          writer.db.exec("COMMIT");
          expect(
            await listSessionEntriesReadOnlyAsync({ ...listScope, clone: false }),
          ).toMatchObject([{ sessionKey, entry: { sessionId, updatedAt: 2, label: "next" } }]);
          expect(await readPage("guest")).toMatchObject([
            {
              ok: true,
              value: {
                entries: [{ sessionKey, entry: { sessionId, updatedAt: 2, label: "next" } }],
                membershipKeys: [],
              },
            },
          ]);
          expect(await readPage("next-guest")).toMatchObject([
            { ok: true, value: { membershipKeys: [sessionKey] } },
          ]);
        } finally {
          if (writer?.db.isOpen && writer.db.isTransaction) {
            writer.db.exec("ROLLBACK");
          }
          await closeOpenClawAgentDatabaseByPathAsync(databasePath, "main");
          closeOpenClawStateDatabaseForTest();
        }
      },
    );
  },
);
