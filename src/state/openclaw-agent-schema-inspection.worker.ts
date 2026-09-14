import { once } from "node:events";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import { serializeAgentSchemaInspectionError } from "./openclaw-agent-schema-inspection-response.js";
import {
  inspectAgentDatabaseSchema,
  type AgentSchemaInspectionInput,
} from "./openclaw-agent-schema-inspection.js";

if (!process.send || !process.disconnect) {
  throw new Error("Agent schema inspection requires parent IPC.");
}
const send = process.send.bind(process);
const disconnect = process.disconnect.bind(process);
// SAFETY: Only the schema preflight owner sends this private IPC input.
const [input] = (await once(process, "message")) as [AgentSchemaInspectionInput];
try {
  const inspected = tryInspectSqliteReadOnlyInProcess(input.pathname, (database) => {
    if (input.requireStartupMigrationReadiness) {
      // sqlite-allow-raw -- Match the disposable integrity child's connection-local cache budget.
      database.exec("PRAGMA cache_size = -65536;");
    }
    return inspectAgentDatabaseSchema(database, input);
  });
  const inspection = inspected?.value;
  send(
    {
      ok: true,
      inspection: inspection
        ? {
            ...inspection,
            ...(inspection.failure
              ? { failure: serializeAgentSchemaInspectionError(inspection.failure) }
              : {}),
          }
        : null,
    },
    disconnect,
  );
} catch (error) {
  send({ ok: false, error: serializeAgentSchemaInspectionError(error) }, disconnect);
}
