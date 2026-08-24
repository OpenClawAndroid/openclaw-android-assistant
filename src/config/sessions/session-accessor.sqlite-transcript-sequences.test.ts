import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readCommittedTranscriptMessageSequence,
  rememberCommittedTranscriptMessageSequencesInTransaction,
} from "./session-accessor.sqlite-transcript-sequences.js";
import { replaceSessionTranscriptSourceGenerationInTransaction } from "./session-transcript-source-generation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("committed transcript message sequences", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("omits a sequence when the active projection source is stale", async () => {
    const scope = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-committed-sequence-") },
      sessionId: "committed-sequence",
      sessionKey: "agent:main:committed-sequence",
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "seed", message: { role: "user", content: "seed" } }],
      touchSessionEntry: false,
    });
    const message = {
      appended: true,
      message: { role: "user", content: "seed" },
      messageId: "seed",
    };
    const options = { agentId: scope.agentId, env: scope.env };
    const database = openOpenClawAgentDatabase(options);

    runOpenClawAgentWriteTransaction((writeDatabase) => {
      rememberCommittedTranscriptMessageSequencesInTransaction(writeDatabase, scope.sessionId, [
        message,
      ]);
    }, options);
    expect(readCommittedTranscriptMessageSequence(message)).toBe(1);

    runOpenClawAgentWriteTransaction((writeDatabase) => {
      replaceSessionTranscriptSourceGenerationInTransaction(writeDatabase, scope.sessionId);
      rememberCommittedTranscriptMessageSequencesInTransaction(writeDatabase, scope.sessionId, [
        message,
      ]);
    }, options);

    expect(readCommittedTranscriptMessageSequence(message)).toBeUndefined();
    expect(
      database.db
        .prepare(
          "SELECT source_generation FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ source_generation: null });
  });
});
