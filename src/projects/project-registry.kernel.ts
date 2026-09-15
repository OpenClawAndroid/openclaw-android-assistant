import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { createOpenClawStateSchemaEnsurer } from "../state/openclaw-state-feature-schema.js";

export const ensureProjectRegistrySchema = createOpenClawStateSchemaEnsurer({
  table: "projects",
  operationLabel: "projects.registry.schema.ensure",
});

export function resolveRecordedProjectRootInDatabase(
  database: DatabaseSync,
  repoRoot: string,
): string | undefined {
  const db = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "projects">>(database);
  return executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("projects").select("repo_root").where("repo_root", "=", repoRoot),
  )?.repo_root;
}
