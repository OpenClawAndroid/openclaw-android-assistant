import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

beforeEach(() => {
  spawnSyncMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("managed handoff Windows process identities", () => {
  it.each([
    { name: "a prompt probe", probeMs: 25, available: true, acquired: true },
    { name: "a probe slower than one second", probeMs: 2_000, available: true, acquired: true },
    { name: "an unavailable creation time", probeMs: 25, available: false, acquired: false },
    { name: "an exhausted identity budget", probeMs: 10_000, available: true, acquired: false },
  ])("preserves lease ownership with $name", async ({ probeMs, available, acquired }) => {
    const createdAt = "2026-09-01T09:00:00.123Z";
    spawnSyncMock.mockImplementation(
      (_command: string, _args: string[], options: { timeout: number }) => {
        vi.advanceTimersByTime(Math.min(probeMs, options.timeout));
        const completed = available && probeMs <= options.timeout;
        return { status: completed ? 0 : 1, stdout: completed ? createdAt : "" };
      },
    );
    const store = createManagedHandoffLeaseStore({
      databasePath: "unused-handoff-identity.sqlite",
      serviceManagerEnv: { SystemRoot: "C:\\Windows" },
    });

    await withMockedPlatform("win32", async () => {
      if (acquired) {
        expect(store.processIdentity(42)).toEqual({
          pid: 42,
          startIdentity: String(Date.parse(createdAt)),
        });
      } else {
        expect(() => store.processIdentity(42)).toThrow(
          "managed handoff process start identity is unavailable",
        );
      }
    });
  });
});
