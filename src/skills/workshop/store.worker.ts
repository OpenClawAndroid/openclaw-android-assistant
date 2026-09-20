import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import { listStoredSkillProposalEventsInDatabase } from "./store-sqlite-event.js";
import { ensureSkillWorkshopSchemaInDatabase } from "./store-sqlite-schema.js";

type Operations = Pick<OpenClawStateWorkerOperations, "workshop.events.list">;

export function isSkillWorkshopCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<Operations> {
  return command.type === "workshop.events.list";
}

export function executeSkillWorkshopCommand(
  command: SqliteWorkerCommand<Operations>,
  database: OpenClawStateDatabase,
  databasePath: string,
): Operations[keyof Operations]["output"] {
  const options = {
    database,
    path: databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  ensureSkillWorkshopSchemaInDatabase(database, options);
  return listStoredSkillProposalEventsInDatabase(database.db, command.input);
}
