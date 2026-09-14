import { channel } from "node:diagnostics_channel";
import { expect, it } from "vitest";
import { startGatewayBenchDiagnostics } from "../../scripts/lib/gateway-bench-diagnostics.js";

it("aggregates captured work with bounded memory and drops content-bearing fields", () => {
  const source = channel("openclaw.session.write");
  const finish = startGatewayBenchDiagnostics();
  let result;
  try {
    for (let index = 0; index < 2; index += 1) {
      source.publish({
        operation: "session-entry.patch",
        outcome: "ok",
        writer: "foreground",
        queueWaitMs: 20 + index,
        writerExecutionMs: 2,
        storePath: "/private/example",
        agentId: "private-agent",
        error: "private-error",
      });
    }
    for (let index = 0; index < 300; index += 1) {
      source.publish({ operation: `session.synthetic-${index}`, outcome: "ok", elapsedMs: 1 });
    }
  } finally {
    result = finish();
  }
  expect(result.groups).toHaveLength(256);
  expect(result.droppedEvents).toBe(45);
  expect(result.collectionErrors).toBe(0);
  expect(result.groups[0]).toMatchObject({
    operation: "session-entry.patch",
    count: 2,
    metrics: {
      queueWaitMs: { count: 2, total: 41, max: 21 },
      writerExecutionMs: { count: 2, total: 4, max: 2 },
    },
  });
  expect(JSON.stringify(result)).not.toContain("private");
  source.publish({ operation: "session-entry.patch", outcome: "ok", queueWaitMs: 999 });
  expect(result.groups[0]).toMatchObject({ count: 2 });
});
