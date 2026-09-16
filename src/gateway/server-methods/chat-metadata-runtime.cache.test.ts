import { expect, test } from "vitest";
import { createChatMetadataHarness } from "./chat-metadata-runtime.test-support.js";

test("bounds retained commands and neutral projections instead of warming the fleet", async () => {
  const agentIds = Array.from({ length: 200 }, (_, index) => `agent-${index}`);
  const harness = createChatMetadataHarness({
    agents: { list: agentIds.map((id, index) => ({ id, default: index === 0 })) },
  });
  try {
    await harness.runtime.refresh();
    expect(harness.buildCommands).not.toHaveBeenCalled();
    expect(harness.buildProjection).not.toHaveBeenCalled();
    for (const readPolicy of ["current", "ready"] as const) {
      await expect(
        harness.runtime.readStartup({ agentId: "agent-0", readPolicy }),
      ).resolves.toBeUndefined();
    }
    expect(harness.buildProjection).not.toHaveBeenCalled();

    const first = await harness.runtime.read({ agentId: "agent-0" });
    expect(await harness.runtime.read({ agentId: "agent-0" })).toEqual(first);
    expect(harness.buildCommands).toHaveBeenCalledOnce();
    expect(harness.buildProjection).toHaveBeenCalledOnce();
    for (const agentId of agentIds.slice(1)) {
      await harness.runtime.read({ agentId });
    }
    expect(harness.buildCommands).toHaveBeenCalledTimes(agentIds.length);
    expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length);
    const retained: string[] = [];
    for (const agentId of agentIds) {
      if (await harness.runtime.readStartup({ agentId, readPolicy: "ready" })) {
        retained.push(agentId);
      }
    }
    expect(retained).toEqual(agentIds.slice(-64));
    expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length);

    expect(await harness.runtime.read({ agentId: "agent-0" })).toEqual(first);
    expect(harness.buildCommands).toHaveBeenCalledTimes(agentIds.length + 1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length + 1);
  } finally {
    await harness.runtime.stop();
  }
});
