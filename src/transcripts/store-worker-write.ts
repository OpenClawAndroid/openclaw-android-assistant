import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import { appendMeetingTranscriptUtterance } from "./store-sqlite.js";
import type { TranscriptWriteOperations } from "./store-worker-contract.js";

export function appendTranscriptInWorker(
  input: TranscriptWriteOperations["transcripts.append"]["input"],
  target: { database: OpenClawStateDatabase; path: string },
): void {
  const options = {
    ...target,
    env: getSqliteWorkerStateContext().environment,
    readOnly: input.readOnly,
  };
  ensureMeetingTranscriptsSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      appendMeetingTranscriptUtterance({ ...input, database: db });
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    },
    options,
    { operationLabel: "meeting-transcripts.utterance.append" },
  );
}
