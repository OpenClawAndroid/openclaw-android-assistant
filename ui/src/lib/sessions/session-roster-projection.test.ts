// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionCapability } from "./session-capability.ts";

describe("event-driven session list refresh", () => {
  it("bounds held-roster enumeration while reconciling overlapping session views", async () => {
    vi.useFakeTimers();
    const rows = Array.from({ length: 10 }, (_, index) => ({
      key: `agent:main:shared-${index}`,
      sessionId: `shared-${index}`,
      kind: "direct" as const,
      label: `Shared ${index}`,
      updatedAt: 1,
    }));
    const request = createGatewayRequestMock(async (method) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(
        rows.map((row) => ({ ...row })),
        1,
      );
    });
    const client = createTestGatewayClient(request);
    const { sessions, emitEvent } = createSessionCapabilityHarness(client.request.bind(client));
    const queries = Array.from({ length: 8 }, (_, index) => ({
      agentId: "main",
      search: "Shared",
      limit: 10 + index,
    }));
    const unsubscribers = queries.map((query) => sessions.subscribeList(query, () => undefined));
    const target = rows[0]!;
    const observed = vi.fn();
    let descriptor: ReturnType<SessionCapability["observeRow"]> | undefined;
    let visitedRows = 0;
    const tracked = new WeakSet<SessionsListResult["sessions"]>();
    const trackHeldRows = () => {
      const held = [
        sessions.state.result,
        ...queries.map((query) => sessions.listSnapshot(query).result),
      ];
      for (const result of held) {
        if (!result || tracked.has(result.sessions)) {
          continue;
        }
        const source = result.sessions;
        tracked.add(source);
        // Count complete source enumeration independently of reducer implementation and timing.
        Object.defineProperty(source, Symbol.iterator, {
          configurable: true,
          *value() {
            // Array values bypass this replaced iterator.
            for (const row of source.values()) {
              visitedRows += 1;
              yield row;
            }
          },
        });
      }
      return held.reduce((count, result) => count + (result?.sessions.length ?? 0), 0);
    };
    try {
      await sessions.refresh({ agentId: "main", force: true });
      for (const query of queries) {
        await sessions.refreshList({ ...query, force: true });
      }
      descriptor = sessions.observeRow({ key: target.key, agentId: "main" }, observed);
      observed.mockClear();
      const payload = {
        sessionKey: target.key,
        agentId: "main",
        sessionId: target.sessionId,
        reason: "update",
        label: "Shared updated",
        updatedAt: 2,
      };
      const consumers = [
        () => emitEvent({ type: "event", event: "sessions.changed", payload }),
        () => sessions.reconcileChanged(payload, { resultAgentId: "main" }),
      ];
      for (const consume of consumers) {
        const heldRowCount = trackHeldRows();
        visitedRows = 0;
        consume();
        // Allow per-view reduction and decoration; repeated whole-roster preparation is quadratic.
        expect(visitedRows).toBeLessThanOrEqual(heldRowCount * 12);
        expect(descriptor.row).toMatchObject({ label: payload.label, updatedAt: 2 });
        for (const query of queries) {
          const result = sessions.listSnapshot(query).result;
          expect(result?.sessions).toHaveLength(rows.length);
          expect(result?.sessions.find((row) => row.key === target.key)).toMatchObject({
            label: payload.label,
            updatedAt: 2,
          });
        }
      }
      expect(sessions.state.result?.sessions.find((row) => row.key === target.key)).toMatchObject({
        label: payload.label,
        updatedAt: 2,
      });
      expect(observed).toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(queries.length + 1);
    } finally {
      descriptor?.dispose();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      sessions.dispose();
      vi.useRealTimers();
    }
  });
});
