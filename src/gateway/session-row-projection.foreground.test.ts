import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as sessions from "../config/sessions/session-accessor.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import {
  identifiedClient,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createSessionRowProjection } from "./session-row-projection.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

it.each(["before transcript work", "before the title commit"] as const)(
  "gives an in-flight Gateway request priority %s and resumes legacy backfill afterward",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      resetGatewayWorkAdmission();
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:foreground-backfill",
        sessionId: "foreground-backfill",
      };
      sessions.replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await sessions.persistSessionTranscriptTurn(scope, {
        messages: [{ message: { role: "user", content: "Recover the legacy session title" } }],
        touchSessionEntry: false,
        updateMode: "none",
      });
      const entered = createDeferredCore();
      const response = createDeferredCore();
      const titlePrepared = createDeferredCore();
      const titleCommit = createDeferredCore();
      const patch = sessions.patchSessionEntryCore;
      if (phase === "before the title commit") {
        vi.spyOn(sessions, "patchSessionEntryCore").mockImplementationOnce(async (...args) => {
          titlePrepared.resolve();
          await titleCommit.promise;
          return patch(...args);
        });
      }
      const request = () =>
        handleGatewayRequest({
          req: { type: "req", id: "foreground-read", method: "health", params: {} },
          context: requestContext(cfg),
          client: identifiedClient("owner@example.com"),
          isWebchatConnect: () => false,
          respond: vi.fn(),
          extraHandlers: {
            health: async ({ respond }) => {
              entered.resolve();
              await response.promise;
              respond(true, {});
            },
          },
        });
      let foreground: Promise<void> | undefined;
      if (phase === "before transcript work") {
        foreground = request();
        await entered.promise;
      }
      const projection = await createSessionRowProjection({ cfg });
      try {
        if (phase === "before the title commit") {
          await titlePrepared.promise;
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          foreground = request();
          await entered.promise;
          titleCommit.resolve();
        }
        const reads = vi.spyOn(sessions, "readSessionTranscriptMessageEventPage");
        for (let turn = 0; turn < 5; turn++) {
          await nextTurn();
        }
        expect(reads).not.toHaveBeenCalled();
        expect(sessions.loadSessionEntry(scope)?.displayName).toBeUndefined();
        response.resolve();
        await foreground;
        await vi.waitFor(() =>
          expect(sessions.loadSessionEntry(scope)?.displayName).toBe(
            "Recover the legacy session title",
          ),
        );
      } finally {
        titleCommit.resolve();
        response.resolve();
        await foreground;
        projection.dispose();
      }
    });
  },
);
