import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assistantTextMessage,
  messageToolCall,
  messageToolResult,
  textContent,
  userTextMessage,
} from "./session-history-fixtures.test-support.js";
import { SessionHistorySseState } from "./session-history-state.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import * as sessionTranscriptReaders from "./session-transcript-readers.js";

describe("SessionHistorySseState", () => {
  test.each([
    { cursor: "1", expectedSeq: undefined },
    { cursor: "8", expectedSeq: 7 },
    { cursor: "9", expectedSeq: 8 },
    { cursor: "99", expectedSeq: 8 },
  ])(
    "keeps cursor $cursor stable when messages append during its read",
    async ({ cursor, expectedSeq }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId: "history-cursor-append",
          sessionKey: "agent:main:history-cursor-append",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        await replaceTranscriptEvents(target, [
          { type: "session", version: 3, id: target.sessionId },
          ...Array.from({ length: 8 }, (_, index) => ({
            type: "message",
            id: `row-${index + 1}`,
            parentId: index === 0 ? null : `row-${index}`,
            message: assistantTextMessage(`Message ${index + 1}`, index + 1),
          })),
        ]);
        const readPage = sessionTranscriptReaders.readSessionMessagesPageWithStatsAsync;
        const pageReadSpy = vi
          .spyOn(sessionTranscriptReaders, "readSessionMessagesPageWithStatsAsync")
          .mockImplementationOnce(async (...args) => {
            const page = await readPage(...args);
            for (const seq of [9, 10]) {
              await appendTranscriptMessage(target, {
                eventId: `row-${seq}`,
                message: assistantTextMessage(`Message ${seq}`, seq),
              });
            }
            return page;
          });
        try {
          const history = SessionHistorySseState.fromRawSnapshot({
            target,
            rawMessages: [],
            limit: 1,
            cursor,
          });

          const refreshed = await history.refreshAsync();

          expect(await sessionTranscriptReaders.readSessionMessageCountAsync(target)).toBe(10);
          expect(refreshed.messages).toMatchObject(
            expectedSeq === undefined
              ? []
              : [
                  {
                    content: textContent(`Message ${expectedSeq}`),
                    __openclaw: { id: `row-${expectedSeq}`, seq: expectedSeq },
                  },
                ],
          );
          expect(refreshed.nextCursor).toBe(
            expectedSeq === undefined ? undefined : String(expectedSeq),
          );
          expect(refreshed.hasMore).toBe(expectedSeq !== undefined);
        } finally {
          pageReadSpy.mockRestore();
        }
      });
    },
  );

  test.each([
    {
      name: "equal-length branch selection",
      cursor: "3",
      limit: 1,
      events: [
        ...["A", "B"].flatMap((branch) => [
          {
            type: "message",
            id: `${branch}1`,
            parentId: null,
            message: userTextMessage(`${branch} question`, 1),
          },
          {
            type: "message",
            id: `${branch}2`,
            parentId: `${branch}1`,
            message: assistantTextMessage("NO_REPLY", 2),
          },
          {
            type: "message",
            id: `${branch}3`,
            parentId: `${branch}2`,
            message: assistantTextMessage("NO_REPLY", 3),
          },
        ]),
        { type: "leaf", id: "select-A", parentId: "B3", targetId: "A3", appendParentId: "A3" },
      ],
      change: {
        type: "leaf",
        id: "select-B",
        parentId: "A3",
        targetId: "B3",
        appendParentId: "B3",
      },
      selectedIds: ["A1", "A2"],
      changedIds: ["B1", "B2", "B3"],
      stableMessageId: undefined,
    },
    {
      name: "reset with an unchanged newest message position",
      cursor: "5",
      limit: 1,
      events: [
        ...Array.from({ length: 4 }, (_, index) => ({
          type: "message",
          id: `M${index + 1}`,
          parentId: index === 0 ? null : `M${index}`,
          message: userTextMessage(`Message ${index + 1}`, index + 1),
        })),
        {
          type: "reset",
          id: "R1",
          parentId: "M4",
          firstKeptEntryId: "M3",
          reason: "new",
          timestamp: "2026-09-01T00:00:00.000Z",
        },
        { type: "message", id: "M5", parentId: "R1", message: assistantTextMessage("NO_REPLY", 5) },
        { type: "message", id: "M6", parentId: "M5", message: userTextMessage("Message 6", 6) },
      ],
      change: {
        type: "reset",
        id: "R2",
        parentId: "M6",
        firstKeptEntryId: "M2",
        reason: "new",
        timestamp: "2026-09-01T00:01:00.000Z",
      },
      selectedIds: ["R1", "M5"],
      changedIds: ["M2", "M3", "M4", "M5", "M6", "R2"],
      stableMessageId: "M5",
    },
  ])("rejects cursor continuation across $name", async (fixture) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "history-cursor-prefix-change",
        sessionKey: "agent:main:history-cursor-prefix-change",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await replaceTranscriptEvents(target, [
        { type: "session", version: 3, id: target.sessionId },
        ...fixture.events,
      ]);
      await waitForSessionTranscriptProjection(target);
      const readPage = sessionTranscriptReaders.readSessionMessagesPageWithStatsAsync;
      let changedPrefix = false;
      const pageReadSpy = vi
        .spyOn(sessionTranscriptReaders, "readSessionMessagesPageWithStatsAsync")
        .mockImplementation(async (...args) => {
          const page = await readPage(...args);
          if (args[1].maxMessages === 0 || changedPrefix) {
            return page;
          }
          changedPrefix = true;
          expect(page.messages).toMatchObject(
            fixture.selectedIds.map((id) => ({ __openclaw: { id } })),
          );

          await appendTranscriptEvent(target, fixture.change);
          await waitForSessionTranscriptProjection(target);
          const changed = await readPage(target, { offset: 0, maxMessages: 10 });
          expect(changed.messages).toMatchObject(
            fixture.changedIds.map((id) => ({ __openclaw: { id } })),
          );
          expect(page.displaySource).toEqual(expect.any(String));
          expect(changed.displaySource).toBe(page.displaySource);
          if (fixture.stableMessageId !== undefined) {
            const matchesAnchor = (message: unknown) =>
              readChatHistoryMessageId(message) === fixture.stableMessageId;
            const changedAnchor = changed.messages.find(matchesAnchor);
            expect(changedAnchor).toEqual(page.messages.find(matchesAnchor));
            expect(changedAnchor).toMatchObject({
              __openclaw: { id: "M5", seq: 4 },
            });
          }
          return page;
        });
      try {
        const history = SessionHistorySseState.fromRawSnapshot({
          target,
          rawMessages: [],
          limit: fixture.limit,
          cursor: fixture.cursor,
        });

        await expect(history.refreshAsync()).rejects.toThrow(
          SessionTranscriptProjectionUnavailableError,
        );
      } finally {
        pageReadSpy.mockRestore();
      }
    });
  });

  test.each(["sqlite", "reset-archive"] as const)(
    "keeps same-sequence siblings at the head of %s cursor history",
    async (source) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId: "history-cursor-siblings",
          sessionKey: "agent:main:history-cursor-siblings",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        const messages = [
          userTextMessage("send both here", 1),
          {
            role: "assistant",
            content: [
              messageToolCall("call-first", "First visible reply."),
              messageToolCall("call-second", "Second visible reply."),
            ],
          },
          messageToolResult("call-first", "first", 3),
          messageToolResult("call-second", "second", 4),
          assistantTextMessage("NO_REPLY", 5),
        ];
        const events = [
          { type: "session", version: 3, id: target.sessionId },
          ...messages.map((message, index) => ({
            type: "message",
            id: `row-${index + 1}`,
            parentId: index === 0 ? null : `row-${index}`,
            message,
          })),
        ];
        const archivePath = path.join(
          state.sessionsDir(),
          `${target.sessionId}.jsonl.reset.2026-09-01T00-00-00.000Z`,
        );
        if (source === "sqlite") {
          await replaceTranscriptEvents(target, events);
        } else {
          await fs.mkdir(state.sessionsDir(), { recursive: true });
          await fs.writeFile(archivePath, events.map((event) => JSON.stringify(event)).join("\n"));
        }
        let originalSnapshot: ReturnType<SessionHistorySseState["snapshot"]> | undefined;
        for (const cursor of ["6", "99"]) {
          const history = SessionHistorySseState.fromRawSnapshot({
            target,
            rawMessages: [],
            limit: 1,
            cursor,
          });

          const refreshed = await history.refreshAsync();
          originalSnapshot ??= refreshed;

          expect(refreshed.messages).toMatchObject([
            { role: "toolResult", toolCallId: "call-first", __openclaw: { seq: 3 } },
            { role: "toolResult", toolCallId: "call-second", __openclaw: { seq: 4 } },
            {
              content: textContent("First visible reply."),
              openclawMessageToolMirror: { toolCallId: "call-first" },
              __openclaw: { seq: 3 },
            },
            {
              content: textContent("Second visible reply."),
              openclawMessageToolMirror: { toolCallId: "call-second" },
              __openclaw: { seq: 4 },
            },
          ]);
          expect(refreshed.nextCursor).toBe("3");
          expect(refreshed.hasMore).toBe(true);
        }
        const older = await sessionTranscriptReaders.readSessionMessagesPageWithStatsAsync(target, {
          beforeSeq: 4,
          offset: 1,
          maxMessages: 2,
          allowResetArchiveFallback: true,
        });
        expect(older.messages).toMatchObject([
          { __openclaw: { seq: 1 } },
          { __openclaw: { seq: 2 } },
        ]);
        if (source === "reset-archive") {
          const readPage = sessionTranscriptReaders.readSessionMessagesPageWithStatsAsync;
          let archiveChanged = false;
          const pageReadSpy = vi
            .spyOn(sessionTranscriptReaders, "readSessionMessagesPageWithStatsAsync")
            .mockImplementationOnce(async (...args) => {
              const page = await readPage(...args);
              await fs.appendFile(
                archivePath,
                `\n${JSON.stringify({
                  type: "message",
                  id: "row-6",
                  parentId: "row-5",
                  message: assistantTextMessage("Replacement archive reply", 6),
                })}\n`,
              );
              archiveChanged = true;
              return page;
            });
          try {
            const history = SessionHistorySseState.fromRawSnapshot({
              target,
              rawMessages: [],
              limit: 1,
              cursor: "6",
            });
            await expect(history.refreshAsync()).resolves.toEqual(originalSnapshot);
            expect(archiveChanged).toBe(true);
          } finally {
            pageReadSpy.mockRestore();
          }
        }
      });
    },
  );
});
