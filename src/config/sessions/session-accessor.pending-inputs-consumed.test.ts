import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
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

  const stagePrivate = async (text = "private child marker", assertCurrent = () => {}) => {
    const receipt = expectDefined(
      await stageSessionPendingInput(scope(), {
        runId: "announce:private-child",
        trackCompletion: true,
        assertCurrent,
        message: {
          ...message("announce:private-child"),
          content: text,
          display: false,
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
      }),
      "Expected private input custody",
    );
    receipts.push(receipt);
    return receipt;
  };
  const completionRows = () =>
    database().db.prepare("SELECT * FROM session_input_completions").all();
  const pendingCount = () =>
    database().db.prepare("SELECT COUNT(*) AS count FROM session_pending_inputs").get()?.count;

  it("opens a same-version store without completion tracking and installs it only on private use", async () => {
    const version = database().db.prepare("PRAGMA user_version").get();
    database().db.exec("DROP TABLE session_input_completions");
    closeOpenClawAgentDatabasesForTest();
    const hasCompletionTable = () =>
      Boolean(
        database()
          .db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_input_completions'")
          .get(),
      );
    expect(hasCompletionTable()).toBe(false);
    const ordinary = await stage("ordinary-without-feature");
    expect(hasCompletionTable()).toBe(false);
    ordinary.finish("cancelled");
    await stagePrivate();
    expect(hasCompletionTable()).toBe(true);
    expect(database().db.prepare("PRAGMA user_version").get()).toEqual(version);
    closeOpenClawAgentDatabasesForTest();
    expect(hasCompletionTable()).toBe(true);
  });

  it("preserves a message-hook veto when retrying already committed private input", async () => {
    const first = await stagePrivate();
    promoteSync(first);
    first.finish("interrupted");
    const replay = await stageSessionPendingInput(scope(), {
      runId: "announce:private-child",
      trackCompletion: true,
      assertCurrent: () => {},
      message: first.message,
      prepareMessageAfterIdempotencyCheck: () => undefined,
    });
    expect(replay).toBeUndefined();
    expect(completionRows()).toEqual([]);
  });

  it.each([false, true])(
    "retains operator cancellation across restart (input consumed=%s)",
    async (consumed) => {
      const first = await stagePrivate();
      if (consumed) {
        promoteSync(first);
      }
      const cancelled = buildAgentRunTerminalOutcome({ status: "error", stopReason: "rpc" });
      first.complete!(cancelled);
      expect(first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }))).toEqual(cancelled);
      expect(pendingCount()).toBe(0);
      rotateAgentEventLifecycleGeneration();
      closeOpenClawAgentDatabasesForTest();
      const retry = await stagePrivate();
      expect(retry.completion).toMatchObject({ reason: "cancelled", stopReason: "rpc" });
      expect(() => retry.run(() => "stopped work")).toThrow("already completed");
      expect(completionRows()).toMatchObject([{ succeeded: 0 }]);
    },
  );

  it("retries a restart interruption instead of treating it as an operator stop", async () => {
    const first = await stagePrivate();
    promoteSync(first);
    first.complete!(buildAgentRunTerminalOutcome({ status: "timeout", stopReason: "restart" }));
    first.finish("interrupted");
    rotateAgentEventLifecycleGeneration();
    closeOpenClawAgentDatabasesForTest();
    const retry = await stagePrivate();
    expect(retry.completion).toBeUndefined();
    retry.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
    expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
  });

  it.each([false, true])(
    "reconciles successful private processing after restart (input consumed=%s)",
    async (consumed) => {
      const first = await stagePrivate();
      if (consumed) {
        promoteSync(first);
      }
      let nextSpawns = 0;
      nextSpawns += 1;
      first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
      expect(pendingCount()).toBe(0);
      expect(completionRows()).toMatchObject([{ succeeded: 1, run_id: "announce:private-child" }]);
      // The child delivery save has not happened. A fresh process has only the DB.
      rotateAgentEventLifecycleGeneration();
      closeOpenClawAgentDatabasesForTest();
      const replay = await stagePrivate();
      expect(replay.completion).toMatchObject({ status: "ok", reason: "completed" });
      expect(() =>
        replay.run(() => {
          nextSpawns += 1;
        }),
      ).toThrow("already completed");
      expect(nextSpawns).toBe(1);
      expect(pendingCount()).toBe(0);
      await expect(stagePrivate("different child marker")).rejects.toThrow("conflicts");
    },
  );

  it.each([false, true])(
    "retains uncompleted private work across restart (input consumed=%s)",
    async (consumed) => {
      const first = await stagePrivate();
      if (consumed) {
        promoteSync(first);
      }
      expect(completionRows()).toEqual([]);
      rotateAgentEventLifecycleGeneration();
      closeOpenClawAgentDatabasesForTest();
      const resumed = await stagePrivate();
      expect(resumed.completion).toBeUndefined();
      expect(resumed.run(() => "one resumed execution")).toBe("one resumed execution");
      resumed.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
      expect(pendingCount()).toBe(0);
      expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
      await expect(stagePrivate("changed committed payload")).rejects.toThrow("conflicts");
    },
  );

  it("keeps private failed attempts retryable without letting stale failure replace success", async () => {
    const first = await stagePrivate();
    first.complete!(
      buildAgentRunTerminalOutcome({ status: "error", error: "provider unavailable" }),
    );
    expect(completionRows()).toMatchObject([{ succeeded: 0 }]);
    first.finish("interrupted");
    const retry = await stagePrivate();
    retry.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
    expect(() => first.complete!(buildAgentRunTerminalOutcome({ status: "error" }))).toThrow(
      "released",
    );
    expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
    expect(pendingCount()).toBe(0);
  });

  it("rolls back private success and input retirement together", async () => {
    const first = await stagePrivate();
    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
        throw new Error("before commit");
      }, options()),
    ).toThrow("before commit");
    expect(completionRows()).toEqual([]);
    expect(pendingCount()).toBe(1);
    first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
    expect(pendingCount()).toBe(0);
  });

  it("keeps committed private success when a postcommit observer fails", async () => {
    const first = await stagePrivate();
    expect(() =>
      runOpenClawAgentWriteTransaction((current) => {
        deferOpenClawAgentPostCommitPublication(current, () => {
          throw new Error("observer failed");
        });
        first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }));
      }, options()),
    ).toThrow("observer failed");
    expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
    expect(pendingCount()).toBe(0);
  });

  it.each(["owner", "session", "lifecycle"] as const)(
    "rejects a private completion after %s changes",
    async (boundary) => {
      let current = true;
      const first = await stagePrivate("private child marker", () => {
        if (!current) {
          throw new Error("owner changed");
        }
      });
      if (boundary === "owner") {
        current = false;
      }
      if (boundary === "session") {
        await upsertSessionEntryCore(scope(), { sessionId: "replacement-parent", updatedAt: 2 });
      }
      if (boundary === "lifecycle") {
        rotateAgentEventLifecycleGeneration();
      }
      expect(() => first.complete!(buildAgentRunTerminalOutcome({ status: "ok" }))).toThrow();
      expect(completionRows()).toEqual([]);
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
