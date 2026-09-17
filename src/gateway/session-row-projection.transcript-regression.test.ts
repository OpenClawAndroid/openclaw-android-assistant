import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import * as transcripts from "../config/sessions/session-accessor.js";
import * as activeEvents from "../config/sessions/session-accessor.sqlite-active-events.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as rowInputs from "./session-utils-row.js";

afterEach(() => vi.restoreAllMocks());

it("serves describe during a 2,048-session drain without transcript reads in row materialization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const count = 2_048;
    const content = "Synthetic transcript payload. ".repeat(512);
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < count; index++) {
          const sessionId = `legacy-${index}`;
          const sessionKey = `agent:main:${sessionId}`;
          writeSessionEntry(
            database,
            sessionKey,
            {
              sessionId,
              updatedAt: index + 1,
              ...(index === count / 2
                ? {
                    status: "done" as const,
                    lastRunId: "fallback-run",
                    providerOverride: "unit-test",
                    modelOverride: "selected",
                    fallbackNotice: {
                      kind: "active" as const,
                      selectedModel: "unit-test/selected",
                      activeModel: "unit-test/fallback",
                    },
                  }
                : {}),
            },
            { canonicalPreviousEntry: null, previousEntry: null },
          );
          appendTranscriptEventsInTransaction(
            database,
            { agentId: "main", sessionId, sessionKey },
            [
              { type: "session", version: 3, id: sessionId },
              {
                type: "message",
                id: "user",
                parentId: null,
                message: { role: "user", content: `Explain legacy session ${index}` },
              },
              {
                type: "message",
                id: "assistant",
                parentId: "user",
                message: { role: "assistant", content },
              },
            ],
          );
        }
      },
      { agentId: "main" },
    );
    for (const index of [0, count - 1]) {
      expect(
        transcripts.readSessionTranscriptMessageEventPage(
          {
            agentId: "main",
            sessionId: `legacy-${index}`,
            sessionKey: `agent:main:legacy-${index}`,
          },
          { maxMessages: 2, offset: 0 },
        ),
      ).toMatchObject({ totalMessages: 2, events: [expect.anything(), expect.anything()] });
    }
    console.log("Prepared 2,048 legacy rows and transcript graphs");
    let inMaterialization = false;
    let materializationTranscriptReads = 0;
    const readInputs = rowInputs.readSessionRowInputs;
    vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation((params) => {
      inMaterialization = true;
      try {
        return readInputs(params);
      } finally {
        inMaterialization = false;
      }
    });
    const readPage = transcripts.readSessionTranscriptMessageEventPage;
    vi.spyOn(transcripts, "readSessionTranscriptMessageEventPage").mockImplementation((...args) => {
      if (inMaterialization) {
        materializationTranscriptReads++;
      }
      return readPage(...args);
    });
    let materializationUsageReads = 0;
    const readUsage = activeEvents.readRecentSessionTranscriptMessageEvents;
    vi.spyOn(activeEvents, "readRecentSessionTranscriptMessageEvents").mockImplementation(
      (...args) => {
        if (inMaterialization) {
          materializationUsageReads++;
        }
        return readUsage(...args);
      },
    );
    let materializationBoundedReads = 0;
    const readBounded = activeEvents.readSessionTranscriptBoundedMessageTailPage;
    vi.spyOn(activeEvents, "readSessionTranscriptBoundedMessageTailPage").mockImplementation(
      (...args) => {
        if (inMaterialization) {
          materializationBoundedReads++;
        }
        return readBounded(...args);
      },
    );
    const context = requestContext(cfg);
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    const initializing = createSessionRowProjection({ cfg });
    await nextTurn();
    const requestStarted = performance.now();
    const projection = await initializing;
    bindSessionRowProjection(context, () => projection);
    const startupMs = performance.now() - started;
    const respond = vi.fn();
    try {
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "under-drain", method: "sessions.describe" },
        params: { key: "agent:main:legacy-2047", includeDerivedTitles: true },
        context,
        client: null,
        isWebchatConnect: () => false,
        respond,
      });
      const describeMs = performance.now() - requestStarted;
      const remainingAtResponse = projection.dirtyRowCount;
      await projection.ensureMaterialized();
      const initialDrainMs = performance.now() - started;
      const initialDrainCpu = process.threadCpuUsage(cpu);
      sessionChanges.emit({ all: true, scope: "config" });
      const dirtyRequestStarted = performance.now();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "dirty-drain", method: "sessions.describe" },
        params: { key: "agent:main:legacy-2047" },
        context,
        client: null,
        isWebchatConnect: () => false,
        respond,
      });
      const dirtyDescribeMs = performance.now() - dirtyRequestStarted;
      console.log(
        JSON.stringify({
          count,
          startupMs,
          initialDrainMs,
          initialDrainThreadCpuMs: (initialDrainCpu.user + initialDrainCpu.system) / 1000,
          describeMs,
          dirtyDescribeMs,
          remainingAtResponse,
          materializationTranscriptReads,
          materializationUsageReads,
          materializationBoundedReads,
        }),
      );
      expect(respond).toHaveBeenCalledWith(true, {
        session: expect.objectContaining({ key: "agent:main:legacy-2047" }),
      });
      expect(materializationTranscriptReads).toBe(0);
      expect(materializationUsageReads).toBe(0);
      expect(materializationBoundedReads).toBe(0);
      expect(describeMs).toBeLessThan(100);
      expect(dirtyDescribeMs).toBeLessThan(100);
      // A response must not depend on completion of unrelated resident rows.
      expect(remainingAtResponse).toBeGreaterThan(0);
    } finally {
      projection.dispose();
    }
  });
}, 120_000);
