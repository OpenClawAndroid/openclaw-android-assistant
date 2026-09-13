import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { addSession, appendOutput, markExited } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { createLazyProcessTool } from "./lazy-process-tool.js";

afterEach(() => {
  resetCodeModeTestState();
  resetProcessRegistryForTests();
});

it.each([createProcessTool, createLazyProcessTool])(
  "declares process results across listing, input, completion, logs, and failures (%#)",
  async (createTool) => {
    const tool = createTool();
    const session = createProcessSessionFixture({ id: "contract-process", backgrounded: true });
    session.stdin = { write: vi.fn((_data, done) => done?.(null)), end: vi.fn(), destroyed: false };
    addSession(session);
    appendOutput(session, "stdout", "first\nsecond\n");
    const invoke = async (action: string, extra: Record<string, unknown> = {}) => {
      const result = await tool.execute(action, { action, sessionId: session.id, ...extra });
      expect(tool.outputSchema).toBeDefined();
      expect(Value.Check(tool.outputSchema!, result.details), JSON.stringify(result.details)).toBe(
        true,
      );
      return result;
    };
    await invoke("list");
    await invoke("poll");
    await invoke("log", { offset: 1, limit: 1 });
    await invoke("write", { data: "hello" });
    await invoke("send-keys", { literal: "world" });
    await invoke("submit");
    await invoke("paste", { text: "paste" });
    await invoke("paste");
    await invoke("kill");
    markExited(session, null, "SIGTERM", "killed", "manual-cancel");
    await invoke("list");
    await invoke("poll");
    await invoke("log");
    await invoke("clear");
    await invoke("poll");
    const completed = createProcessSessionFixture({ id: "contract-completed", backgrounded: true });
    addSession(completed);
    markExited(completed, 0, null, "completed", "exit");
    await invoke("remove", { sessionId: completed.id });
    await invoke("invalid");
    expect(Value.Check(tool.outputSchema!, { status: "failed" })).toBe(false);
    expect(
      Value.Check(tool.outputSchema!, { status: "completed", sessions: [{ sessionId: 42 }] }),
    ).toBe(false);
  },
);

it("composes the lazy process list and log in a typechecked cell without inspecting raw output", async () => {
  const session = createProcessSessionFixture({ id: "typed-process", backgrounded: true });
  addSession(session);
  appendOutput(session, "stdout", "first\nsecond");
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, createLazyProcessTool()] });
  const result = resultDetails(
    await h.tools[0]!.execute("typed-process", {
      language: "typescript",
      typecheck: true,
      code: `
      const listed = await process({ action: "list" });
      if (!("sessions" in listed)) throw new Error("list failed");
      const running = listed.sessions.filter(session => session.status === "running");
      const logs = await Promise.all(running.map(async session => {
        const log = await process({ action: "log", sessionId: session.sessionId });
        if (!("output" in log)) throw new Error("log failed");
        return { id: session.sessionId, lines: log.totalLines, output: log.output.toUpperCase() };
      }));
      return logs;
    `,
    }),
  );
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "completed",
    value: [{ id: "typed-process", lines: 2, output: "FIRST\nSECOND" }],
  });
});
