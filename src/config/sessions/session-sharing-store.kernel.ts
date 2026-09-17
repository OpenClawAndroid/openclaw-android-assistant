import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

type SessionMemberDatabase = Pick<OpenClawAgentKyselyDatabase, "session_members">;

const SESSION_MEMBERSHIP_QUERY_CHUNK_SIZE = 400;

export function getSessionMemberKysely(database: Pick<OpenClawAgentDatabase, "db">) {
  return getNodeSqliteKysely<SessionMemberDatabase>(database.db);
}

export function hasSessionMemberInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  normalizedIdentityId: string,
): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionMemberKysely(database)
        .selectFrom("session_members")
        .select("identity_id")
        .where("session_key", "=", sessionKey)
        .where("identity_id", "=", normalizedIdentityId),
    ),
  );
}

export function listSessionMembershipKeysInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  normalizedSessionKeys: readonly string[],
  normalizedIdentityId: string,
): Set<string> {
  const db = getSessionMemberKysely(database);
  const memberships = new Set<string>();
  for (
    let offset = 0;
    offset < normalizedSessionKeys.length;
    offset += SESSION_MEMBERSHIP_QUERY_CHUNK_SIZE
  ) {
    const chunk = normalizedSessionKeys.slice(offset, offset + SESSION_MEMBERSHIP_QUERY_CHUNK_SIZE);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_members")
        .select("session_key")
        .where("identity_id", "=", normalizedIdentityId)
        .where("session_key", "in", chunk),
    ).rows;
    for (const row of rows) {
      memberships.add(row.session_key);
    }
  }
  return memberships;
}
