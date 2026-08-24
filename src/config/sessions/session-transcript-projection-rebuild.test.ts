import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../../agents/stream-message-shared.js";
import { HEARTBEAT_PROMPT } from "../../auto-reply/heartbeat.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn, upsertSessionEntryCore } from "./session-accessor.js";
import {
  dryRunMessageToolEvents,
  dryRunMessageToolResultEvents,
} from "./session-transcript-display.expected-test-support.js";
import {
  appendEligibleSessionTranscriptDisplayRowInTransaction,
  prepareSessionTranscriptDisplayProjection,
} from "./session-transcript-display.js";
import {
  canvasUrlWithLength,
  plannedDisplaySnapshot,
  projectionFixture as projection,
  projectionRow as row,
  readDisplayRowIdentities,
  readDisplaySnapshot,
  readRequiredSourceGeneration,
  serializeDisplayTables,
} from "./session-transcript-display.test-support.js";
import { reconcileSessionTranscriptDisplayProjection } from "./session-transcript-reconcile.js";

type SessionTranscriptProjectionSourceRow = ReturnType<typeof row>;
const SESSION_ID = "projection-session";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("canonical session transcript projection", () => {
  let env: NodeJS.ProcessEnv;
  const scope = {
    agentId: "main",
    sessionId: SESSION_ID,
    sessionKey: "agent:main:projection-session",
  };

  beforeEach(() => {
    env = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-transcript-projection-"),
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  function readProjectionSourceRows(): SessionTranscriptProjectionSourceRow[] {
    return openOpenClawAgentDatabase({ agentId: scope.agentId, env })
      .db.prepare(
        "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
      )
      .all(scope.sessionId)
      .map((entry) => {
        const sourceRow = entry as { created_at: number; event_json: string; seq: number };
        return {
          createdAt: sourceRow.created_at,
          event: JSON.parse(sourceRow.event_json),
          seq: sourceRow.seq,
        };
      });
  }

  function readDisplayRows(sessionId = scope.sessionId) {
    return openOpenClawAgentDatabase({ agentId: scope.agentId, env })
      .db.prepare(
        "SELECT display_ordinal, kind, source_event_seq FROM session_transcript_display_rows WHERE session_id = ? ORDER BY display_ordinal",
      )
      .all(sessionId);
  }

  async function expectIncrementalDisplayParity(name: string, events: Record<string, unknown>[]) {
    const sessionId = `${scope.sessionId}-${name}`;
    const sessionKey = `${scope.sessionKey}-${name}`;
    await upsertSessionEntryCore(
      { agentId: scope.agentId, env, sessionKey },
      { sessionId, updatedAt: 1 },
    );
    const sourceRows: SessionTranscriptProjectionSourceRow[] = [];
    let previousIdentities: Array<{ display_ordinal: number; row_id: string }> = [];
    for (const [seq, event] of events.entries()) {
      runOpenClawAgentWriteTransaction(
        (database) => {
          database.db
            .prepare(
              "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
            )
            .run(sessionId, seq, JSON.stringify(event), seq + 1);
          appendEligibleSessionTranscriptDisplayRowInTransaction(database.db, {
            event,
            seq,
            sessionId,
            sourceGeneration: readRequiredSourceGeneration(database.db, sessionId),
          });
        },
        { agentId: scope.agentId, env },
      );
      sourceRows.push(row(seq, event, seq + 1));
      const snapshot = readDisplaySnapshot({ agentId: scope.agentId, env }, sessionId);
      expect(snapshot, `prefix ${seq} of ${name}`).toEqual(plannedDisplaySnapshot(sourceRows));
      const identities = readDisplayRowIdentities({ agentId: scope.agentId, env }, sessionId);
      for (const previous of previousIdentities) {
        const current = identities.find(
          (identity) => identity.display_ordinal === previous.display_ordinal,
        );
        if (current) {
          expect(current.row_id, `row identity ${previous.display_ordinal} of ${name}`).toBe(
            previous.row_id,
          );
        }
      }
      previousIdentities = identities;
    }
    return readDisplaySnapshot({ agentId: scope.agentId, env }, sessionId);
  }

  it("projects one deterministic active branch for both rebuild owners", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 3 }),
      row(1, {
        id: "root",
        message: { content: "root text", role: "user" },
        parentId: null,
        type: "message",
      }),
      row(2, {
        id: "abandoned",
        message: { content: "abandoned text", role: "assistant" },
        parentId: "root",
        type: "message",
      }),
      row(3, {
        id: "active",
        message: { content: "active text", role: "assistant" },
        parentId: "root",
        type: "message",
      }),
    ]);

    expect(result).toMatchObject({
      activeEventCount: 2,
      activeMessageCount: 2,
      leafEventId: "active",
      sessionId: SESSION_ID,
      sourceIndexedSeq: 3,
      sourceTranscriptUpdatedAt: 42,
    });
    expect(result.activeRows).toEqual([
      { activePosition: 0, eventSeq: 1, messagePosition: 0 },
      { activePosition: 1, eventSeq: 3, messagePosition: 1 },
    ]);
    expect(
      result.displayRows.map(({ displayOrdinal, kind, sourceEventSeq }) => ({
        displayOrdinal,
        kind,
        sourceEventSeq,
      })),
    ).toEqual([
      { displayOrdinal: 0, kind: "user", sourceEventSeq: 1 },
      { displayOrdinal: 1, kind: "assistant", sourceEventSeq: 3 },
    ]);
    expect(result.ftsRows).toEqual([
      { messageId: "root", role: "user", text: "root text", timestamp: 1_000 },
      { messageId: "active", role: "assistant", text: "active text", timestamp: 3_000 },
    ]);
  });

  it("matches incremental append and rebuild after excluding the header and abandoned branch", async () => {
    await persistSessionTranscriptTurn(
      { ...scope, env },
      {
        messages: [
          { eventId: "root", parentId: null, message: { role: "user", content: "root" } },
          {
            eventId: "abandoned",
            parentId: "root",
            message: { role: "assistant", content: "abandoned" },
          },
          {
            eventId: "active",
            parentId: "root",
            message: { role: "assistant", content: "active" },
          },
        ].map((message) => Object.assign(message, { maintainDisplayProjection: true })),
        touchSessionEntry: false,
      },
    );
    await reconcileSessionTranscriptDisplayProjection({ agentId: scope.agentId, env });

    const planned = prepareSessionTranscriptDisplayProjection(readProjectionSourceRows()).rows.map(
      ({ displayOrdinal, kind, sourceEventSeq }) => ({
        display_ordinal: displayOrdinal,
        kind,
        source_event_seq: sourceEventSeq,
      }),
    );
    expect(readDisplayRows()).toEqual(planned);
    expect(planned).toEqual([
      { display_ordinal: 0, kind: "user", source_event_seq: 1 },
      { display_ordinal: 1, kind: "assistant", source_event_seq: 3 },
    ]);
  });

  it("keeps incremental and rebuild semantics equal after every stateful prefix", async () => {
    const message = (id: string, value: Record<string, unknown>) => ({
      id,
      message: value,
      type: "message",
    });
    const canvasDetails = (url: string, id: string) => ({
      mcpAppPreview: {
        kind: "canvas",
        presentation: {
          preferred_height: 1400,
          sandbox: "scripts",
          target: "assistant_message",
          title: "Canvas title",
        },
        view: { boardWidgetName: "status", id, url },
      },
    });
    await expectIncrementalDisplayParity("heartbeat", [
      message("heartbeat-user", { role: "user", content: HEARTBEAT_PROMPT }),
      message("heartbeat-ok", { role: "assistant", content: "HEARTBEAT_OK" }),
      message("heartbeat-system", { role: "system", content: "internal" }),
      message("heartbeat-visible", { role: "user", content: "visible" }),
    ]);
    await expectIncrementalDisplayParity("stream-error", [
      message("stream-error", {
        role: "assistant",
        content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
        stopReason: "error",
      }),
      message("stream-hidden", { role: "assistant", content: "NO_REPLY" }),
      message("stream-repair", { role: "assistant", content: "Recovered reply" }),
    ]);
    await expectIncrementalDisplayParity("message-tool", [
      message("message-call", {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-message",
            name: "message",
            arguments: { action: "send", message: "RAW_TOOL_CALL_SENTINEL" },
          },
        ],
      }),
      message("message-result", {
        role: "toolResult",
        toolCallId: "call-message",
        toolName: "message",
        content: [{ type: "text", text: "RAW_TOOL_RESULT_SENTINEL" }],
        details: { sourceReplyRoute: "current-source" },
        result: { ok: true },
      }),
      message("message-flush", { role: "assistant", content: "NO_REPLY" }),
    ]);
    await expectIncrementalDisplayParity("tts", [
      message("tts-target", { role: "assistant", content: "Spoken answer" }),
      message("tts-intervening-user", { role: "user", content: "later prompt" }),
      message("tts-supplement", {
        role: "assistant",
        content: [
          { type: "text", text: "Audio reply" },
          { type: "audio", url: "/media/tts.mp3" },
        ],
        openclawTtsSupplement: { spokenText: "Spoken answer" },
      }),
    ]);
    await expectIncrementalDisplayParity("canvas", [
      message("canvas-target", { role: "assistant", content: "Initial assistant" }),
      message("canvas-tool", {
        role: "toolResult",
        toolCallId: "canvas-call",
        toolName: "canvas",
        content: [{ type: "text", text: "RAW_CANVAS_RESULT_SENTINEL" }],
        details: canvasDetails(
          "/__openclaw__/canvas/documents/cv_status/assets/status%20page.html",
          "cv_status",
        ),
      }),
      message("canvas-next-assistant", { role: "assistant", content: "Final assistant" }),
    ]);

    const serialized = serializeDisplayTables({ agentId: scope.agentId, env });
    expect(serialized).not.toContain("RAW_TOOL_CALL_SENTINEL");
    expect(serialized).not.toContain("RAW_TOOL_RESULT_SENTINEL");
    expect(serialized).not.toContain("RAW_CANVAS_RESULT_SENTINEL");
  });

  it("preserves unmatched message sends across a selective delivery-mirror flush", async () => {
    const message = (id: string, value: Record<string, unknown>) => ({
      id,
      message: value,
      type: "message",
    });
    const call = (id: string, text: string) =>
      message(`call-${id}`, {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id,
            name: "message",
            arguments: { action: "send", message: text },
          },
        ],
      });
    const result = (id: string) =>
      message(`result-${id}`, {
        role: "toolResult",
        toolCallId: id,
        toolName: "message",
        result: { ok: true },
      });
    await expectIncrementalDisplayParity("selective-message-mirror", [
      call("call-a", "Reply A"),
      result("call-a"),
      call("call-b", "Reply B"),
      result("call-b"),
      message("delivery-a", {
        role: "assistant",
        content: "Reply A",
        model: "delivery-mirror",
        openclawDeliveryMirror: { kind: "channel-final" },
        provider: "openclaw",
      }),
      message("flush-b", { role: "assistant", content: "NO_REPLY" }),
    ]);

    await expectIncrementalDisplayParity("unmatched-message-mirror", [
      call("call-unmatched", "Expected reply"),
      result("call-unmatched"),
      message("delivery-other", {
        role: "assistant",
        content: "Different reply",
        model: "delivery-mirror",
        openclawDeliveryMirror: { kind: "channel-final" },
        provider: "openclaw",
      }),
      message("unmatched-flush", { role: "assistant", content: "NO_REPLY" }),
    ]);

    await expectIncrementalDisplayParity("lookalike-message-mirror", [
      call("call-lookalike", "Expected reply"),
      result("call-lookalike"),
      message("lookalike-delivery", {
        role: "assistant",
        content: "Expected reply",
        openclawDeliveryMirror: { kind: "channel-final" },
      }),
      message("lookalike-flush", { role: "assistant", content: "NO_REPLY" }),
    ]);

    await expectIncrementalDisplayParity("same-source-message-mirror", [
      message("multi-call", {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "same-source-a",
            name: "message",
            arguments: { action: "send", message: "Reply A" },
          },
          {
            type: "toolCall",
            id: "same-source-b",
            name: "message",
            arguments: { action: "send", message: "Reply B" },
          },
        ],
      }),
      result("same-source-a"),
      result("same-source-b"),
      message("same-source-delivery-a", {
        role: "assistant",
        content: "Reply A",
        model: "delivery-mirror",
        openclawDeliveryMirror: { kind: "channel-final" },
        provider: "openclaw",
      }),
      message("same-source-flush-b", { role: "assistant", content: "NO_REPLY" }),
    ]);

    await expectIncrementalDisplayParity("delivery-mirror-canvas", [
      message("canvas-target", { role: "assistant", content: "Initial assistant" }),
      message("canvas-tool", {
        role: "toolResult",
        toolCallId: "canvas-call",
        toolName: "canvas",
        details: {
          mcpAppPreview: {
            kind: "canvas",
            presentation: {
              preferred_height: 1400,
              sandbox: "scripts",
              target: "assistant_message",
              title: "Canvas title",
            },
            view: {
              boardWidgetName: "status",
              id: "cv_status",
              url: "/__openclaw__/canvas/documents/cv_status/assets/status%20page.html",
            },
          },
        },
      }),
      call("canvas-message-call", "Reply A"),
      result("canvas-message-call"),
      message("canvas-delivery", {
        role: "assistant",
        content: "Reply A",
        model: "delivery-mirror",
        openclawDeliveryMirror: { kind: "channel-final" },
        provider: "openclaw",
      }),
    ]);
  });

  it("keeps forwarded sends and settled negative transitions out of semantic carry", async () => {
    const message = (id: string, value: Record<string, unknown>) => ({
      id,
      message: value,
      type: "message",
    });
    await expectIncrementalDisplayParity("forwarded-message-tool", [
      message("forwarded-call", {
        role: "assistant",
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        content: [
          {
            type: "toolCall",
            id: "forwarded-call",
            name: "message",
            arguments: { action: "send", message: "Forwarded send" },
          },
        ],
      }),
      message("forwarded-result", {
        role: "toolResult",
        toolCallId: "forwarded-call",
        toolName: "message",
        result: { ok: true },
      }),
      message("forwarded-flush", { role: "assistant", content: "NO_REPLY" }),
    ]);

    await expectIncrementalDisplayParity("normalized-forwarded-message-tool", [
      message("forwarded-call", {
        role: "assistant",
        provenance: { kind: "inter_session", sourceTool: " sessions_send " },
        content: [
          {
            type: "toolCall",
            id: "normalized-forwarded-call",
            name: "message",
            arguments: { action: "send", message: "Forwarded send" },
          },
        ],
      }),
      message("forwarded-result", {
        role: "toolResult",
        toolCallId: "normalized-forwarded-call",
        toolName: "message",
        result: { ok: true },
      }),
      message("forwarded-flush", { role: "assistant", content: "NO_REPLY" }),
    ]);

    await expectIncrementalDisplayParity("dry-run-message-tool", dryRunMessageToolEvents());

    await expectIncrementalDisplayParity(
      "dry-run-message-tool-result",
      dryRunMessageToolResultEvents(),
    );

    await expectIncrementalDisplayParity("forwarded-heartbeat", [
      message("heartbeat", { role: "user", content: HEARTBEAT_PROMPT }),
      message("forwarded", {
        role: "assistant",
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        content: [
          {
            type: "toolCall",
            id: "forwarded-heartbeat-call",
            name: "message",
            arguments: { action: "send", message: "Forwarded send" },
          },
        ],
      }),
      message("visible", { role: "user", content: "visible turn" }),
    ]);

    await expectIncrementalDisplayParity("settled-stream-error", [
      message("error", {
        role: "assistant",
        content: STREAM_ERROR_FALLBACK_TEXT,
        stopReason: "error",
      }),
      message("user", { role: "user", content: "new turn" }),
      message("assistant", { role: "assistant", content: "new reply" }),
    ]);

    await expectIncrementalDisplayParity("multiple-stream-errors", [
      message("error-1", {
        role: "assistant",
        content: STREAM_ERROR_FALLBACK_TEXT,
        stopReason: "error",
      }),
      message("error-2", {
        role: "assistant",
        content: STREAM_ERROR_FALLBACK_TEXT,
        stopReason: "error",
      }),
      message("repair", { role: "assistant", content: "recovered" }),
    ]);

    await expectIncrementalDisplayParity("structured-stream-error", [
      message("error", {
        role: "assistant",
        content: [
          { type: "text", text: STREAM_ERROR_FALLBACK_TEXT },
          { type: "reasoning", text: "private" },
          { type: "toolCall", id: "read-1", name: "read", arguments: {} },
        ],
        stopReason: "error",
      }),
      message("assistant", { role: "assistant", content: "later reply" }),
    ]);

    await expectIncrementalDisplayParity("mismatched-tts", [
      message("target", { role: "assistant", content: "Original" }),
      message("supplement", {
        role: "assistant",
        content: [{ type: "audio", url: "/media/tts.mp3" }],
        openclawTtsSupplement: { spokenText: "Different" },
      }),
    ]);
  });

  it("applies deterministic carry caps and canvas v1 bounds", async () => {
    const assistantEvents = Array.from({ length: 65 }, (_, seq) => ({
      id: `assistant-${seq}`,
      message: { role: "assistant", content: `answer ${seq}` },
      type: "message",
    }));
    await expectIncrementalDisplayParity("tts-carry-cap", assistantEvents);

    const canvas = prepareSessionTranscriptDisplayProjection([
      row(0, {
        id: "assistant",
        message: { role: "assistant", content: "target" },
        type: "message",
      }),
      row(1, {
        id: "canvas",
        message: {
          role: "toolResult",
          toolName: "canvas",
          details: {
            mcpAppPreview: {
              kind: "canvas",
              presentation: {
                preferred_height: 50_000,
                sandbox: "scripts",
                target: "assistant_message",
                title: "x".repeat(300),
              },
              view: {
                boardWidgetName: "status",
                id: "cv_status",
                url: "/__openclaw__/canvas/documents/cv_status/index%20page.html",
              },
            },
          },
        },
        type: "message",
      }),
    ]).rows[0]?.canvases[0];
    expect(canvas).toMatchObject({
      boardWidgetName: "status",
      preferredHeight: 1200,
      sandbox: "scripts",
      sourceEventSeq: 1,
      url: "/__openclaw__/canvas/documents/cv_status/index%20page.html",
      viewId: "cv_status",
    });
    expect(canvas?.title).toHaveLength(256);

    const streamEvents = Array.from({ length: 9 }, (_, seq) => ({
      id: `stream-${seq}`,
      message: {
        role: "assistant",
        content: STREAM_ERROR_FALLBACK_TEXT,
        stopReason: "error",
      },
      type: "message",
    }));
    await expectIncrementalDisplayParity("stream-carry-cap", streamEvents);

    const messageEvents = Array.from({ length: 17 }, (_, seq) => ({
      id: `message-${seq}`,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `call-${seq}`,
            name: "message",
            arguments: { action: "send", message: `message ${seq}` },
          },
        ],
      },
      type: "message",
    }));
    await expectIncrementalDisplayParity("message-carry-cap", messageEvents);

    await expectIncrementalDisplayParity("heartbeat-carry-cap", [
      {
        id: "heartbeat-0",
        message: { role: "user", content: HEARTBEAT_PROMPT },
        type: "message",
      },
      {
        id: "heartbeat-1",
        message: { role: "user", content: HEARTBEAT_PROMPT },
        type: "message",
      },
    ]);

    const canvasEvents = [
      {
        id: "canvas-target",
        message: { role: "assistant", content: "target" },
        type: "message",
      },
      ...Array.from({ length: 17 }, (_, index) => ({
        id: `canvas-${index}`,
        message: {
          role: "toolResult",
          toolName: "canvas",
          details: {
            mcpAppPreview: {
              kind: "canvas",
              presentation: { target: "assistant_message" },
              view: {
                id: `view-${index}`,
                url: `/__openclaw__/canvas/documents/cv_test/${index}.html`,
              },
            },
          },
        },
        type: "message",
      })),
    ];
    await expectIncrementalDisplayParity("canvas-carry-cap", canvasEvents);
  });

  it.each([
    "https://example.com/canvas",
    "/__openclaw__/canvas/documents/cv_test/../index.html",
    "/__openclaw__/canvas/documents/cv_test/%2findex.html",
    "/__openclaw__/canvas/documents/cv_test/%2Findex.html",
    "/__openclaw__/canvas/documents/cv_test/%41.html",
    "/__openclaw__/canvas/documents/cv_test/%zz",
    "/__openclaw__/canvas/documents/cv_test/index.html?token=secret",
    "/__openclaw__/canvas/documents/cv_test/index.html#fragment",
    "/__openclaw__/canvas/documents/cv_test/",
    `/__openclaw__/canvas/documents/cv_test/${"x".repeat(129)}`,
    `/__openclaw__/canvas/documents/${"d".repeat(129)}/index.html`,
    `/__openclaw__/canvas/documents/cv_test/${Array.from({ length: 17 }, () => "x").join("/")}`,
    "/__openclaw__/canvas/documents/cv_test/path\\name.html",
    "/__openclaw__/canvas/documents/cv_test/%00index.html",
    "/__openclaw__/canvas/documents/cv_test/%C2%80index.html",
    "/__openclaw__/canvas/documents/cv_test/name%3Avalue",
    canvasUrlWithLength(2049),
  ])("rejects unsafe persisted canvas URL %s", (url) => {
    const result = prepareSessionTranscriptDisplayProjection([
      row(0, {
        id: "assistant",
        message: { role: "assistant", content: "target" },
        type: "message",
      }),
      row(1, {
        id: "canvas",
        message: {
          role: "toolResult",
          toolName: "canvas",
          details: {
            mcpAppPreview: {
              kind: "canvas",
              presentation: { target: "assistant_message" },
              view: { id: "cv_test", url },
            },
          },
        },
        type: "message",
      }),
    ]);
    expect(result.rows.flatMap((entry) => entry.canvases)).toEqual([]);
  });

  it("accepts exact canvas URL and persisted-field boundaries", () => {
    const sixteenSegments = `/__openclaw__/canvas/documents/cv/${Array.from(
      { length: 16 },
      (_, index) => `s${index}`,
    ).join("/")}`;
    const acceptedUrls = [
      canvasUrlWithLength(2048),
      `/__openclaw__/canvas/documents/${"d".repeat(128)}/index.html`,
      sixteenSegments,
    ];
    for (const [index, url] of acceptedUrls.entries()) {
      const result = prepareSessionTranscriptDisplayProjection([
        row(0, {
          id: `assistant-${index}`,
          message: { role: "assistant", content: "target" },
          type: "message",
        }),
        row(1, {
          id: `canvas-${index}`,
          message: {
            role: "toolResult",
            toolName: "canvas",
            content: [
              {
                type: "canvas",
                preview: {
                  boardWidgetName: `a${"b".repeat(63)}`,
                  kind: "canvas",
                  preferredHeight: 160,
                  render: "url",
                  sandbox: "strict",
                  surface: "assistant_message",
                  title: "t".repeat(257),
                  url,
                  viewId: "v".repeat(128),
                },
              },
            ],
          },
          type: "message",
        }),
      ]);
      expect(result.rows[0]?.canvases).toEqual([
        {
          boardWidgetName: `a${"b".repeat(63)}`,
          position: 0,
          preferredHeight: 160,
          sandbox: "strict",
          sourceEventSeq: 1,
          title: "t".repeat(256),
          url,
          viewId: "v".repeat(128),
        },
      ]);
    }

    const omitted = prepareSessionTranscriptDisplayProjection([
      row(0, {
        id: "assistant",
        message: { role: "assistant", content: "target" },
        type: "message",
      }),
      row(1, {
        id: "canvas",
        message: {
          role: "toolResult",
          toolName: "canvas",
          content: [
            {
              type: "canvas",
              preview: {
                boardWidgetName: "Invalid Widget",
                kind: "canvas",
                preferredHeight: 159,
                render: "url",
                sandbox: "trusted",
                surface: "assistant_message",
                url: "/__openclaw__/canvas/documents/cv/index.html",
                viewId: "v".repeat(129),
              },
            },
          ],
        },
        type: "message",
      }),
    ]).rows[0]?.canvases[0];
    expect(omitted).toEqual({
      position: 0,
      sourceEventSeq: 1,
      url: "/__openclaw__/canvas/documents/cv/index.html",
    });
  });

  it("caps and deduplicates canvas facts while omitting unsupported fields", () => {
    const previews = Array.from({ length: 17 }, (_, index) => ({
      type: "canvas",
      preview: {
        boardWidgetName: "Invalid Widget",
        className: "private-class",
        kind: "canvas",
        preferredHeight: 100,
        render: "url",
        sandbox: "trusted",
        style: "color:red",
        surface: "assistant_message",
        title: `Canvas ${index}`,
        url: `/__openclaw__/canvas/documents/cv_test/${index}.html`,
        viewId: index === 16 ? "view-15" : `view-${index}`,
      },
      rawText: "RAW_CANVAS_TEXT",
    }));
    const result = prepareSessionTranscriptDisplayProjection([
      row(0, {
        id: "assistant",
        message: { role: "assistant", content: "target" },
        type: "message",
      }),
      row(1, {
        id: "canvas",
        message: {
          role: "toolResult",
          toolName: "canvas",
          content: previews,
        },
        type: "message",
      }),
    ]);
    const canvases = result.rows[0]?.canvases ?? [];
    expect(canvases).toHaveLength(16);
    expect(canvases.every((canvas) => canvas.preferredHeight === undefined)).toBe(true);
    expect(canvases.every((canvas) => canvas.sandbox === undefined)).toBe(true);
    expect(canvases.every((canvas) => canvas.boardWidgetName === undefined)).toBe(true);
    expect(JSON.stringify(canvases)).not.toContain("RAW_CANVAS_TEXT");
    expect(JSON.stringify(canvases)).not.toContain("private-class");
    expect(JSON.stringify(canvases)).not.toContain("color:red");
  });

  it("keeps persisted row timestamps for timestamp-less and invalid-timestamp messages", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 3 }),
      row(
        1,
        {
          id: "old-user",
          message: { content: [{ text: "old content", type: "text" }], role: "user" },
          parentId: null,
          type: "message",
        },
        1_700_000_000_000,
      ),
      row(
        2,
        {
          id: "invalid-timestamp",
          message: { content: "still old", role: "assistant" },
          parentId: "old-user",
          timestamp: "not a date",
          type: "message",
        },
        1_700_000_001_000,
      ),
    ]);

    expect(result.ftsRows.map(({ messageId, timestamp }) => ({ messageId, timestamp }))).toEqual([
      { messageId: "old-user", timestamp: 1_700_000_000_000 },
      { messageId: "invalid-timestamp", timestamp: 1_700_000_001_000 },
    ]);
  });

  it("respects a leaf-control rewind without indexing the abandoned continuation", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 3 }),
      row(1, {
        id: "root",
        message: { content: "keep", role: "user" },
        parentId: null,
        type: "message",
      }),
      row(2, {
        id: "abandoned",
        message: { content: "remove", role: "assistant" },
        parentId: "root",
        type: "message",
      }),
      row(3, {
        appendParentId: "root",
        id: "rewind",
        parentId: "abandoned",
        targetId: "root",
        type: "leaf",
      }),
    ]);

    expect(result.leafEventId).toBe("root");
    expect(result.activeRows).toEqual([{ activePosition: 0, eventSeq: 1, messagePosition: 0 }]);
    expect(result.ftsRows.map((entry) => entry.messageId)).toEqual(["root"]);
  });

  it("keeps legacy flat-message ordering and searchable identities", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 1 }),
      row(1, {
        id: "legacy-user",
        message: { content: "first", role: "user" },
        type: "message",
      }),
      row(2, {
        id: "legacy-assistant",
        message: { content: "second", role: "assistant" },
        type: "message",
      }),
    ]);

    expect(result.activeRows).toEqual([
      { activePosition: 0, eventSeq: 1, messagePosition: 0 },
      { activePosition: 1, eventSeq: 2, messagePosition: 1 },
    ]);
    expect(result.ftsRows.map((entry) => entry.messageId)).toEqual([
      "legacy-user",
      "legacy-assistant",
    ]);
    expect(result.sourceIndexedSeq).toBe(2);
  });
});
