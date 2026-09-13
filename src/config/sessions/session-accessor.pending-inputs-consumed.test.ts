import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import {
  closeOpenClawAgentDatabasesForTest,
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("committed pending input release", () => {
  const fixture = useTempSessionsFixture("pending-input-consumed-release-");
  const scope = () => ({
    agentId: "main",
    sessionKey: "agent:main:consumed-release",
    sessionId: "consumed-session",
    storePath: fixture.storePath(),
  });
  const options = () => toDatabaseOptions(resolveSqliteScope(scope()));
  const database = () => openOpenClawAgentDatabase(options());
  const receipts: SessionPendingInputReceipt[] = [];
  const message = (id: string) => ({
    role: "user" as const,
    content: "Synthetic accepted input",
    timestamp: 1,
    idempotencyKey: `${id}:user`,
  });
  const stage = async (id: string) => {
    const receipt = expectDefined(
      await stageSessionPendingInput(scope(), {
        runId: id,
        message: message(id),
        assertCurrent: () => {},
      }),
      "Expected staged input custody",
    );
    receipts.push(receipt);
    return receipt;
  };
  const prepare = async (collected: boolean) => {
    const first = await stage("first");
    const sources = [first];
    if (!collected) {
      return { receipt: first, sources };
    }
    sources.push(await stage("second"));
    const receipt = expectDefined(
      bindSessionPendingInputSources(sources, message("aggregate")),
      "Expected collected input custody",
    );
    return { receipt, sources };
  };
  const promoteSync = (receipt: SessionPendingInputReceipt) =>
    expect(
      receipt.run(() => appendTranscriptMessageSync(scope(), { message: receipt.message })),
    ).toMatchObject({ ok: true, value: { appended: true } });

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId: scope().sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
    closeOpenClawAgentDatabasesForTest();
  });

  it.each(
    [false, true].flatMap((collected) =>
      [false, true].map((observerFails) => ({ collected, observerFails })),
    ),
  )(
    "releases consumed custody without a writer lock (collected=$collected, observerFails=$observerFails)",
    async ({ collected, observerFails }) => {
      const { receipt, sources } = await prepare(collected);
      if (observerFails) {
        expect(() =>
          runOpenClawAgentWriteTransaction((current) => {
            deferOpenClawAgentPostCommitPublication(current, () => {
              throw new Error("postcommit observer failed");
            });
            promoteSync(receipt);
          }, options()),
        ).toThrow("postcommit observer failed");
      } else {
        expect(
          await receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message })),
        ).toMatchObject({ appended: true });
      }
      expect(receipt.run(() => true)).toBe(true);
      const primary = database();
      const foreign = new DatabaseSync(primary.path);
      try {
        foreign.exec("BEGIN IMMEDIATE");
        runWithSqliteBusyTimeout(primary.db, 1, () => {
          expect(() => receipt.finish("cancelled")).not.toThrow();
          for (const source of sources) {
            expect(() => source.run(() => {})).toThrow("ownership ended");
          }
          expect(foreign.isTransaction).toBe(true);
          // The foreign writer must still own its native lock after release returns.
          expect(() => primary.db.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
        });
      } finally {
        if (primary.db.isTransaction) {
          primary.db.exec("ROLLBACK");
        }
        if (foreign.isTransaction) {
          foreign.exec("ROLLBACK");
        }
        foreign.close();
      }
      expect(
        primary.db
          .prepare("SELECT state, consumed_event_id FROM session_pending_inputs ORDER BY seq")
          .all(),
      ).toEqual(
        collected
          ? sources.map(() => ({ state: "queued", consumed_event_id: receipt.inputId }))
          : [],
      );
    },
  );

  it.each(
    [false, true].flatMap((collected) =>
      ["outer", "savepoint"].map((rollback) => ({ collected, rollback })),
    ),
  )(
    "still terminalizes input after staged consumption rolls back (collected=$collected, rollback=$rollback)",
    async ({ collected, rollback }) => {
      const { receipt, sources } = await prepare(collected);
      const consumeThenFail = () => {
        promoteSync(receipt);
        throw new Error("rollback after consumption");
      };
      if (rollback === "outer") {
        expect(() => runOpenClawAgentWriteTransaction(consumeThenFail, options())).toThrow(
          "rollback after consumption",
        );
      } else {
        runOpenClawAgentWriteTransaction(() => {
          expect(() => runOpenClawAgentWriteTransaction(consumeThenFail, options())).toThrow(
            "rollback after consumption",
          );
        }, options());
      }
      receipt.finish("cancelled");
      expect(
        database()
          .db.prepare("SELECT state, consumed_event_id FROM session_pending_inputs ORDER BY seq")
          .all(),
      ).toEqual(sources.map(() => ({ state: "cancelled", consumed_event_id: null })));
    },
  );
});
