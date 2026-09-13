import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  replaceTranscriptEvents,
  upsertSessionEntryCore,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { loadSessionPullRequestReferences } from "./control-ui-session-pr-references.js";
import * as transcriptReaders from "./session-transcript-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repository = { owner: "openclaw", repo: "openclaw" };
const pr = (number: number) => `https://github.com/openclaw/openclaw/pull/${number}`;
const text = (value: string) => [{ type: "text", text: value }];

describe("session pull request references", () => {
  let scope: SessionTranscriptReadScope & { sessionKey: string; storePath: string };
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const stateDir = tempDirs.make("openclaw-session-pr-references-");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const config = { session: { store: storePath }, agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config, config);
    scope = {
      agentId: "main",
      sessionId: "session-pr-references",
      sessionKey: "agent:main:pr-references",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    envSnapshot.restore();
  });

  async function writeMessages(messages: Array<Record<string, unknown>>) {
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      ...messages.map((message, index) => ({
        type: "message",
        id: `message-${index}`,
        parentId: index > 0 ? `message-${index - 1}` : null,
        message,
      })),
    ]);
  }

  it("finds the latest assistant PRs across tool activity without promoting other sources", async () => {
    await writeMessages([
      { role: "assistant", content: text(pr(300)) },
      { role: "assistant", content: pr(301) },
      {
        role: "assistant",
        content: text("Merged [PR](https://github.com/OpenClaw/OpenClaw/pull/302/files)."),
      },
      ...Array.from({ length: 150 }, () => ({
        role: "toolResult",
        content: text(`${pr(900)} ${"tool output ".repeat(800)}`),
      })),
      { role: "user", content: text(pr(901)) },
      {
        role: "assistant",
        content: text(pr(902)),
        openclawDisplayContent: [
          ...text(`Open: [PR](${pr(303)}). Again: ${pr(303)}#discussion_r1`),
          { type: "thinking", thinking: pr(903) },
          { type: "image", url: pr(904) },
          {
            type: "text",
            text: [
              "https://github.com/another/repo/pull/905",
              "https://github.com/openclaw/openclaw/issues/906",
              "https://github.com.evil.example/openclaw/openclaw/pull/907",
              "https://github.com@evil.example/openclaw/openclaw/pull/908",
              "https://github.com:444/openclaw/openclaw/pull/909",
              "https://github.com/openclaw/openclaw/pull/0",
              "https://github.com/openclaw/openclaw/pull/03",
            ].join(" "),
          },
        ],
      },
    ]);

    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([
      303, 302, 301,
    ]);
  });

  it("does not recover PR references hidden by a session reset", async () => {
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "old",
        parentId: null,
        message: { role: "assistant", content: text(pr(1)) },
      },
      {
        type: "reset",
        id: "reset",
        parentId: "old",
        reason: "reset",
        timestamp: "2026-09-13T00:00:00.000Z",
      },
      {
        type: "message",
        id: "new",
        parentId: "reset",
        message: { role: "assistant", content: text(pr(2)) },
      },
    ]);

    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([2]);
  });

  it("discards references when the session changes during the history read", async () => {
    await writeMessages([{ role: "assistant", content: text(pr(1)) }]);
    const read = transcriptReaders.readSessionMessageByIdAsync;
    vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync").mockImplementationOnce(
      async (...args) => {
        const page = await read(...args);
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          lifecycleRevision: "replacement",
          updatedAt: 2,
        });
        return page;
      },
    );

    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([]);
  });

  it("keeps a history read failure distinct from an empty reference list", async () => {
    await writeMessages([{ role: "assistant", content: text(pr(1)) }]);
    vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync").mockRejectedValueOnce(
      new Error("history unavailable"),
    );

    await expect(loadSessionPullRequestReferences(scope, repository)).rejects.toThrow(
      "history unavailable",
    );
  });

  it("bounds total canonical payload hydration while retaining the newest references", async () => {
    await writeMessages([
      { role: "assistant", content: text(`${pr(1)} ${"x".repeat(80 * 1024)}`) },
      { role: "assistant", content: text(`${pr(2)} ${"x".repeat(80 * 1024)}`) },
      { role: "assistant", content: text(`${pr(3)} ${"x".repeat(150 * 1024)}`) },
    ]);

    await expect(loadSessionPullRequestReferences(scope, repository)).resolves.toEqual([2]);
  });
});
