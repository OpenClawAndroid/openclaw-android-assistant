import { finished } from "node:stream/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientHarness } from "./test-support.js";

const prefix = '{"method":"item/commandExecution/outputDelta","params":{"delta":"';
const following = { method: "item/commandExecution/outputDelta", params: { delta: "following" } };
const notification = (delta: string) => ({
  method: "item/commandExecution/outputDelta",
  params: { delta },
});

describe("CodexAppServerClient message decoding", () => {
  const harnesses: ReturnType<typeof createClientHarness>[] = [];

  function createHarness() {
    const harness = createClientHarness({ autoEmitExit: false });
    harnesses.push(harness);
    const notifications: unknown[] = [];
    harness.client.addNotificationHandler((message) => {
      notifications.push(message);
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    return { ...harness, notifications, warn };
  }

  afterEach(async () => {
    for (const harness of harnesses) {
      const drained = Promise.all([
        finished(harness.process.stdout, { cleanup: true }),
        finished(harness.process.stderr, { cleanup: true }),
      ]);
      harness.emitExit();
      await drained;
      await expect(harness.client.closeAndWait()).resolves.toMatchObject({ exited: true });
    }
    harnesses.length = 0;
    vi.restoreAllMocks();
  });

  it.each([
    { name: "plain text", fragments: ["first", "second"], delta: "first\nsecond" },
    { name: "trailing spaces", fragments: ["first ", " second "], delta: "first \n second " },
    { name: "empty fragments", fragments: ["", "middle", "", ""], delta: "\nmiddle\n\n" },
    {
      name: "escaped quotes, backslashes, and Unicode",
      fragments: [
        String.raw`first \"quoted\"`,
        String.raw`path C:\\synthetic\\`,
        String.raw`unicode \u0061 \uD83D\uDE00`,
      ],
      delta: 'first "quoted"\npath C:\\synthetic\\\nunicode a 😀',
    },
    { name: "trailing backslash", fragments: ["first \\", "second"], delta: "first \\nsecond" },
    {
      name: "large text",
      fragments: ["x".repeat(1_100_000), "second"],
      delta: `${"x".repeat(1_100_000)}\nsecond`,
    },
  ])("preserves $name while recovering raw-newline strings", ({ fragments, delta }) => {
    const harness = createHarness();
    harness.process.stdout.write(` \t\n  ${prefix}${fragments.join("\n")}"}}\n`);
    harness.process.stdout.write(`\u00a0${JSON.stringify(following)}\u00a0\n`);
    expect(harness.notifications).toEqual([notification(delta), following]);
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it("bounds cumulative parse input for a fragmented message without delaying delivery", () => {
    const harness = createHarness();
    const fragments = Array.from({ length: 64 }, () => "x".repeat(128));
    const frame = `${prefix}${fragments.join("\n")}"}}\n`;
    const nativeParse = JSON.parse;
    let attemptedBytes = 0;
    const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      attemptedBytes += Buffer.byteLength(text);
      return nativeParse(text, reviver);
    });
    try {
      harness.process.stdout.write(frame);
    } finally {
      parse.mockRestore();
    }
    expect(harness.notifications).toEqual([notification(fragments.join("\n"))]);
    harness.send(following);
    expect(harness.notifications).toEqual([notification(fragments.join("\n")), following]);
    expect(harness.warn).not.toHaveBeenCalled();
    expect(attemptedBytes).toBeLessThanOrEqual(4 * Buffer.byteLength(frame));
  });

  it.each([
    { name: "invalid escape", fragment: String.raw`bad \q` },
    { name: "incomplete Unicode escape", fragment: String.raw`bad \u12` },
    { name: "invalid Unicode escape", fragment: String.raw`bad \u123x` },
    { name: "unescaped control", fragment: "bad\tvalue" },
    { name: "invalid completed frame", fragment: 'second"}} trailing' },
  ])("resynchronizes after a recovered $name", ({ fragment }) => {
    const harness = createHarness();
    harness.process.stdout.write(
      '{"method":"item/commandExecution/outputDelta","params":{"token":"synthetic-secret","delta":"first\n',
    );
    harness.process.stdout.write(`${fragment}\n`);
    harness.send(following);
    expect(harness.notifications).toEqual([following]);
    expect(harness.warn).toHaveBeenCalledExactlyOnceWith(
      "failed to parse codex app-server message",
      expect.objectContaining({ error: expect.any(SyntaxError), fragmentCount: 2 }),
    );
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain("synthetic-secret");
    expect(JSON.stringify(harness.warn.mock.calls)).toContain("<redacted>");
  });

  it.each([
    { bound: "length", complete: true },
    { bound: "length", complete: false },
    { bound: "lines", complete: true },
    { bound: "lines", complete: false },
  ])("retains the $bound recovery bound (complete: $complete)", ({ bound, complete }) => {
    const harness = createHarness();
    const fragments =
      bound === "length"
        ? ["x".repeat(8 * 1024 * 1024 - prefix.length - 3), "x"]
        : Array.from({ length: 1_000 }, () => "x");
    harness.process.stdout.write(`${prefix}${fragments.join("\n")}\n`);
    expect(harness.notifications).toEqual([]);
    expect(harness.warn).not.toHaveBeenCalled();
    harness.process.stdout.write(complete ? 'last"}}\n' : "continuation\n");
    harness.send(following);
    if (complete) {
      expect(harness.notifications).toEqual([
        notification(`${fragments.join("\n")}\nlast`),
        following,
      ]);
      expect(harness.warn).not.toHaveBeenCalled();
    } else {
      expect(harness.notifications).toEqual([following]);
      expect(harness.warn).toHaveBeenCalledExactlyOnceWith(
        "failed to parse codex app-server message",
        expect.objectContaining({ fragmentCount: fragments.length + 1 }),
      );
    }
  });
});
