import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../../agents/stream-message-shared.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import {
  appendEligibleSessionTranscriptDisplayRowInTransaction,
  prepareSessionTranscriptDisplayProjection,
} from "./session-transcript-display.js";
import {
  plannedDisplaySnapshot,
  projectionRow,
  readDisplaySnapshot,
} from "./session-transcript-display.test-support.js";
import { readSessionTranscriptSourceGenerationTokenInTransaction } from "./session-transcript-source-generation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session transcript display semantics", () => {
  let env: NodeJS.ProcessEnv;
  const agentId = "main";

  beforeEach(() => {
    env = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-display-semantics-"),
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  async function persistEvents(name: string, events: Record<string, unknown>[]) {
    const sessionId = `display-semantics-${name}`;
    await upsertSessionEntryCore(
      { agentId, env, sessionKey: `agent:${agentId}:${name}` },
      { sessionId, updatedAt: 1 },
    );
    const sourceRows = [];
    for (const [seq, event] of events.entries()) {
      runOpenClawAgentWriteTransaction(
        (database) => {
          database.db
            .prepare(
              "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
            )
            .run(sessionId, seq, JSON.stringify(event), seq + 1);
          const sourceGeneration = readSessionTranscriptSourceGenerationTokenInTransaction(
            database.db,
            sessionId,
          );
          if (!sourceGeneration) {
            throw new Error("expected transcript source generation");
          }
          appendEligibleSessionTranscriptDisplayRowInTransaction(database.db, {
            event,
            seq,
            sessionId,
            sourceGeneration,
          });
        },
        { agentId, env },
      );
      sourceRows.push(projectionRow(seq, event, seq + 1));
      expect(readDisplaySnapshot({ agentId, env }, sessionId)).toEqual(
        plannedDisplaySnapshot(sourceRows),
      );
    }
    return readDisplaySnapshot({ agentId, env }, sessionId);
  }

  const message = (id: string, value: Record<string, unknown>) => ({
    id,
    message: value,
    type: "message",
  });

  it("matches current visibility and retains message-tool completion identity", async () => {
    const snapshot = await persistEvents("current-display-parity", [
      message("display-hidden", {
        role: "user",
        content: "hidden",
        display: false,
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
      message("runtime-context", {
        role: "custom",
        customType: "openclaw.runtime-context",
        content: "internal",
      }),
      message("empty-user", { role: "user", content: [{ type: "text", text: "" }] }),
      message("media-user", {
        role: "user",
        content: "",
        __openclaw: { media: [{ kind: "image", url: "https://example.com/image.png" }] },
      }),
      message("subagent-announce", {
        role: "user",
        content: "child completion",
        provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      }),
      message("sessions-send-user", {
        role: "user",
        content: "forwarded request",
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
      message("mixed-message-tool", {
        role: "assistant",
        content: [
          { type: "text", text: "Visible preface" },
          {
            type: "toolCall",
            id: "mixed-call",
            name: "message",
            arguments: { action: "send", message: "Delivered reply" },
          },
          {
            type: "toolCall",
            id: "same-text-call",
            name: "message",
            arguments: { action: "send", message: "Delivered reply" },
          },
        ],
      }),
      message("early-delivery", {
        role: "assistant",
        content: "Delivered reply",
        model: "delivery-mirror",
        openclawDeliveryMirror: { kind: "channel-final", toolCallId: "mixed-call" },
        provider: "openclaw",
      }),
      message("message-result", {
        role: "toolResult",
        toolCallId: "mixed-call",
        toolName: "message",
        details: { sourceReplySink: "internal-ui" },
        result: { ok: true },
      }),
    ]);

    expect(snapshot.rows).toEqual([
      { display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 0 },
      { display_ordinal: 1, kind: "opaque", revision: 1, source_event_seq: 1 },
      { display_ordinal: 2, kind: "opaque", revision: 1, source_event_seq: 2 },
      { display_ordinal: 3, kind: "user", revision: 1, source_event_seq: 3 },
      { display_ordinal: 4, kind: "opaque", revision: 1, source_event_seq: 4 },
      { display_ordinal: 5, kind: "assistant", revision: 1, source_event_seq: 5 },
      { display_ordinal: 6, kind: "assistant", revision: 1, source_event_seq: 6 },
      { display_ordinal: 7, kind: "assistant", revision: 2, source_event_seq: 7 },
      { display_ordinal: 8, kind: "opaque", revision: 1, source_event_seq: 8 },
    ]);
    expect(snapshot.sources).toEqual([
      {
        displayOrdinal: 7,
        position: 0,
        relation: "message_tool_mirror",
        sourceEventSeq: 6,
      },
      {
        displayOrdinal: 7,
        position: 0,
        relation: "message_tool_result",
        sourceEventSeq: 8,
      },
    ]);
    expect(snapshot.carry.filter((entry) => entry.kind === "message_tool")).toEqual([
      {
        kind: "message_tool",
        position: 0,
        relatedEventSeq: null,
        sourceEventSeq: 6,
        sourceOccurrence: 1,
      },
    ]);
  });

  it.each([
    { details: { status: "suppressed" }, name: "details.status suppression", result: { ok: true } },
    {
      details: { deliveryStatus: "suppressed" },
      name: "details.deliveryStatus suppression",
      result: { ok: true },
    },
    {
      details: { delivery_status: "suppressed" },
      name: "details.delivery_status suppression",
      result: { ok: true },
    },
    { name: "a bare false result", result: false, details: undefined },
    {
      name: "a nested JSON false result",
      result: [{ type: "text", text: '{"ok":false}' }],
      details: undefined,
    },
    {
      name: "a nested dry-run result",
      result: [{ type: "text", text: '{"dryRun":true}' }],
      details: undefined,
    },
  ])("does not mirror message-tool results containing $name", async ({ details, name, result }) => {
    const snapshot = await persistEvents(`negative-result-${name.replaceAll(" ", "-")}`, [
      message("call", {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "message",
            arguments: { action: "send", message: "must stay hidden" },
          },
        ],
      }),
      message("result", {
        role: "toolResult",
        toolCallId: "call",
        toolName: "message",
        ...(details ? { details } : {}),
        result,
      }),
      message("flush", { role: "assistant", content: "NO_REPLY" }),
    ]);
    expect(snapshot.carry).toEqual([]);
    expect(snapshot.sources).toEqual([]);
  });

  it("preserves assistant errors and settles carry across empty forwarded turns", async () => {
    const userSettled = await persistEvents("forwarded-user-stream-error", [
      message("error", {
        role: "assistant",
        content: STREAM_ERROR_FALLBACK_TEXT,
        stopReason: "error",
      }),
      message("empty-error", {
        role: "assistant",
        content: [],
        stopReason: "error",
      }),
      message("forwarded-user", {
        role: "user",
        content: "",
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
      message("later-assistant", { role: "assistant", content: "later reply" }),
    ]);
    expect(userSettled.rows).toMatchObject([
      { kind: "assistant", source_event_seq: 1 },
      { kind: "assistant", source_event_seq: 2 },
      { kind: "assistant", source_event_seq: 3 },
    ]);

    const assistantRepaired = await persistEvents("forwarded-assistant-stream-error", [
      message("error", {
        role: "assistant",
        content: STREAM_ERROR_FALLBACK_TEXT,
        stopReason: "error",
      }),
      message("forwarded-assistant", {
        role: "assistant",
        content: "forwarded reply",
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
    ]);
    expect(assistantRepaired.rows).toEqual([
      { display_ordinal: 0, kind: "assistant", revision: 2, source_event_seq: 1 },
    ]);
  });

  it("revises rows whose ordinals shift during stream-error collapse", async () => {
    const events = [
      message("error-1", {
        role: "assistant",
        content: STREAM_ERROR_FALLBACK_TEXT,
        stopReason: "error",
      }),
      message("opaque-1", { role: "system", content: "internal" }),
      message("error-2", {
        role: "assistant",
        content: STREAM_ERROR_FALLBACK_TEXT,
        stopReason: "error",
      }),
      message("opaque-2", { role: "system", content: "internal" }),
      message("repair", { role: "assistant", content: "recovered" }),
    ];
    const snapshot = await persistEvents("stream-error-shift-revision", events);
    expect(snapshot.rows).toEqual([
      { display_ordinal: 0, kind: "assistant", revision: 2, source_event_seq: 4 },
      { display_ordinal: 1, kind: "opaque", revision: 1, source_event_seq: 1 },
      { display_ordinal: 2, kind: "opaque", revision: 2, source_event_seq: 3 },
    ]);
    expect(
      prepareSessionTranscriptDisplayProjection(
        events.map((event, seq) => projectionRow(seq, event, seq + 1)),
      ).rows,
    ).toMatchObject([
      { displayOrdinal: 0, revision: 2, sourceEventSeq: 4 },
      { displayOrdinal: 1, revision: 1, sourceEventSeq: 1 },
      { displayOrdinal: 2, revision: 2, sourceEventSeq: 3 },
    ]);
  });
});
