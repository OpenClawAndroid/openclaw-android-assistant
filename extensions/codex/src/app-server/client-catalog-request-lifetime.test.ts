import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, isCodexAppServerIndeterminateTransportError } from "./client.js";
import { createClientHarness } from "./test-support.js";

type Harness = ReturnType<typeof createClientHarness>;
type RequestOptions = NonNullable<Parameters<CodexAppServerClient["request"]>[2]>;
type CatalogKey = NonNullable<RequestOptions["catalogListKey"]>;
type Page = { data: Array<{ id: string }> };

const harnesses: Harness[] = [];
const page: Page = { data: [{ id: "native-thread" }] };

function createHarness(options: Parameters<typeof createClientHarness>[0] = {}) {
  const harness = createClientHarness({ autoEmitExit: false, ...options });
  harnesses.push(harness);
  return harness;
}

function read(
  harness: Harness,
  catalogListKey: CatalogKey,
  options: RequestOptions = {},
  params: unknown = { limit: 1 },
) {
  const request = harness.client.request<Page>("thread/list", params, {
    timeoutMs: 1_000,
    ...options,
    catalogListKey,
  });
  // Teardown closes all fixture clients even if an assertion fails before a reply.
  void request.catch(() => undefined);
  return request;
}

function requestId(harness: Harness, index = 0): number {
  const request = JSON.parse(harness.writes[index] ?? "{}") as { id: number; method: string };
  expect(request.method).toBe("thread/list");
  expect(request.id).toBeTypeOf("number");
  return request.id;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.client.close();
    harness.emitExit();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex catalog request lifetime", () => {
  it("lets a fresh caller join a written request after its first waiter expires", async () => {
    const harness = createHarness();
    const key = { scope: {}, key: "home" };
    const controller = new AbortController();
    const expiredGuard = vi.fn();
    const first = read(harness, key, {
      timeoutMs: 100,
      signal: controller.signal,
      assertCurrent: expiredGuard,
    }).catch((error: unknown) => error);
    const id = requestId(harness);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toMatchObject({ reason: "timed out", mayHaveWritten: true });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const oldGuardCalls = expiredGuard.mock.calls.length;

    const second = read(harness, key, { timeoutMs: 500 });
    expect(harness.writes).toHaveLength(1);
    harness.send({ id, result: page });
    await expect(second).resolves.toEqual(page);
    expect(await first).toMatchObject({ reason: "timed out" });
    expect(expiredGuard).toHaveBeenCalledTimes(oldGuardCalls);
    expect(harness.client.getCloseError()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("registers before an immediate reply and does not retain the completed result", async () => {
    const harness = createHarness({
      onWrite(line, send) {
        const request = JSON.parse(line) as { id: number };
        send({ id: request.id, result: page });
      },
    });
    const key = { scope: {}, key: "home" };
    await expect(read(harness, key)).resolves.toEqual(page);
    await expect(read(harness, key)).resolves.toEqual(page);
    expect(harness.writes).toHaveLength(2);
    expect(requestId(harness, 1)).not.toBe(requestId(harness));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates denied and retired guards from another valid waiter", async () => {
    const harness = createHarness();
    const key = { scope: {}, key: "home" };
    const valid = read(harness, key);
    const denied = new Error("caller denied");
    await expect(
      read(harness, key, {
        assertCurrent: () => {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
    let current = true;
    const retired = new Error("caller retired");
    const guarded = read(harness, key, {
      assertCurrent: () => {
        if (!current) {
          throw retired;
        }
      },
    }).catch((error: unknown) => error);
    current = false;
    harness.send({ id: requestId(harness), result: page });
    await expect(valid).resolves.toEqual(page);
    expect(await guarded).toBe(retired);
    expect(harness.writes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["timeout", "abort"] as const)(
    "detaches repeated %s waiters without growing listeners or timers",
    async (mode) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const sharedController = new AbortController();
      for (let index = 0; index < 4; index += 1) {
        const controller = mode === "timeout" ? sharedController : new AbortController();
        const waiterSignal = controller.signal;
        const waiting = read(harness, key, { timeoutMs: 100, signal: waiterSignal }).catch(
          (error: unknown) => error,
        );
        expect(getEventListeners(waiterSignal, "abort")).toHaveLength(1);
        if (mode === "abort") {
          controller.abort(new Error("poll cancelled"));
        } else {
          await vi.advanceTimersByTimeAsync(100);
        }
        expect(await waiting).toMatchObject({
          reason: mode === "abort" ? "aborted" : "timed out",
          mayHaveWritten: true,
        });
        expect(getEventListeners(waiterSignal, "abort")).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
      }
      expect(harness.writes).toHaveLength(1);
      harness.send({ id: requestId(harness), result: page });
    },
  );

  it.each(["response", "overload"] as const)(
    "discards a late %s after all waiters detach without retrying",
    async (outcome) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const first = read(harness, key, { timeoutMs: 100 }).catch((error: unknown) => error);
      const oldId = requestId(harness);
      await vi.advanceTimersByTimeAsync(100);
      expect(await first).toMatchObject({ reason: "timed out" });
      harness.send(
        outcome === "response"
          ? { id: oldId, result: page }
          : { id: oldId, error: { code: -32001, message: "Server overloaded" } },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.writes).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);

      const next = read(harness, key);
      const newId = requestId(harness, 1);
      expect(newId).not.toBe(oldId);
      harness.send({ id: oldId, result: { data: [{ id: "late-old" }] } });
      const joined = read(harness, key);
      expect(harness.writes).toHaveLength(2);
      harness.send({ id: newId, result: page });
      await expect(Promise.all([next, joined])).resolves.toEqual([page, page]);
    },
  );

  it.each(["response", "rpc-error"] as const)(
    "honors the deadline before a late %s even when its timer has not run",
    async (outcome) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const late = read(harness, key, { timeoutMs: 100 }).catch((error: unknown) => error);
      const valid = read(harness, key, { timeoutMs: 500 }).catch((error: unknown) => error);
      vi.setSystemTime(1_100);
      harness.send(
        outcome === "response"
          ? { id: requestId(harness), result: page }
          : { id: requestId(harness), error: { code: -32602, message: "Invalid query" } },
      );
      expect(await late).toMatchObject({ reason: "timed out", mayHaveWritten: true });
      expect(await valid).toEqual(
        outcome === "response"
          ? page
          : expect.objectContaining({
              name: "CodexAppServerRpcError",
              code: -32602,
              method: "thread/list",
            }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["response first", "close first"] as const)(
    "settles once when %s and allows an independent successor connection",
    async (order) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const controller = new AbortController();
      const first = read(harness, key, { signal: controller.signal }).catch(
        (error: unknown) => error,
      );
      const id = requestId(harness);
      if (order === "response first") {
        harness.send({ id, result: page });
        harness.client.close();
        expect(await first).toEqual(page);
      } else {
        harness.client.close();
        harness.send({ id, result: page });
        expect(isCodexAppServerIndeterminateTransportError(await first)).toBe(true);
      }
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      const successor = createHarness();
      const next = read(successor, key);
      harness.send({ id, result: { data: [{ id: "old-connection" }] } });
      successor.send({ id: requestId(successor), result: page });
      await expect(next).resolves.toEqual(page);
      harness.emitExit();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["deadline", "abort"] as const)(
    "rechecks %s after a delivery guard while preserving a valid sibling",
    async (change) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const controller = new AbortController();
      let delivering = false;
      const guarded = read(harness, key, {
        timeoutMs: 100,
        signal: controller.signal,
        assertCurrent: () => {
          if (delivering) {
            if (change === "deadline") {
              vi.setSystemTime(1_100);
            } else {
              controller.abort(new Error("retired during guard"));
            }
          }
        },
      }).catch((error: unknown) => error);
      const sibling = read(harness, key, { timeoutMs: 500 });
      delivering = true;
      harness.send({ id: requestId(harness), result: page });
      expect(await guarded).toMatchObject({
        reason: change === "deadline" ? "timed out" : "aborted",
        mayHaveWritten: true,
      });
      await expect(sibling).resolves.toEqual(page);
      expect(harness.writes).toHaveLength(1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["scope", "key", "params", "client"] as const)(
    "does not share a request across different %s",
    async (partition) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const other = partition === "client" ? createHarness() : harness;
      const otherKey =
        partition === "scope"
          ? { ...key, scope: {} }
          : partition === "key"
            ? { ...key, key: "other-home" }
            : key;
      const first = read(harness, key);
      const second = read(
        other,
        otherKey,
        {},
        partition === "params" ? { limit: 2 } : { limit: 1 },
      );
      expect(harness.writes.length + (other === harness ? 0 : other.writes.length)).toBe(2);
      harness.send({ id: requestId(harness), result: page });
      const secondPage = { data: [{ id: "other-thread" }] };
      other.send({ id: requestId(other, other === harness ? 1 : 0), result: secondPage });
      await expect(Promise.all([first, second])).resolves.toEqual([page, secondPage]);
    },
  );

  it("retains a possibly written request after a callback error without closing its client", async () => {
    const harness = createHarness();
    const key = { scope: {}, key: "home" };
    const writeError = new Error("indeterminate write callback");
    let failWrite: ((error?: Error | null) => void) | undefined;
    const write = vi
      .spyOn(harness.process.stdin, "write")
      .mockImplementationOnce((chunk, encoding, callback) => {
        harness.writes.push(String(chunk));
        failWrite = typeof encoding === "function" ? encoding : callback;
        return false;
      });
    const first = read(harness, key).catch((error: unknown) => error);
    const sibling = read(harness, key).catch((error: unknown) => error);
    expect(failWrite).toBeTypeOf("function");
    failWrite!(writeError);
    write.mockRestore();
    expect(isCodexAppServerIndeterminateTransportError(await first)).toBe(true);
    expect(isCodexAppServerIndeterminateTransportError(await sibling)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.client.getCloseError()).toBeUndefined();
    const second = read(harness, key);
    expect(harness.writes).toHaveLength(1);
    harness.send({ id: requestId(harness), result: page });
    await expect(second).resolves.toEqual(page);

    const companion = harness.client.request("model/list", {}, { timeoutMs: 100 });
    const request = JSON.parse(harness.writes[1] ?? "{}") as { id: number; method: string };
    expect(request.method).toBe("model/list");
    harness.send({ id: request.id, result: { data: [] } });
    await expect(companion).resolves.toEqual({ data: [] });
  });

  it("lets only active callers retry overload and keeps an old id from clearing the retry", async () => {
    const harness = createHarness();
    const key = { scope: {}, key: "home" };
    const active = read(harness, key);
    const expired = read(harness, key, { timeoutMs: 5 }).catch((error: unknown) => error);
    const oldId = requestId(harness);
    harness.send({ id: oldId, error: { code: -32001, message: "Server overloaded" } });
    await vi.advanceTimersByTimeAsync(5);
    expect(await expired).toMatchObject({ reason: "timed out", mayHaveWritten: false });
    await vi.advanceTimersByTimeAsync(40);
    const newId = requestId(harness, 1);
    expect(newId).not.toBe(oldId);
    harness.send({ id: oldId, error: { code: -32001, message: "duplicate old reply" } });
    const joined = read(harness, key);
    expect(harness.writes).toHaveLength(2);
    harness.send({ id: newId, result: page });
    await expect(Promise.all([active, joined])).resolves.toEqual([page, page]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.writes).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps ordinary thread/list requests independent", async () => {
    const harness = createHarness();
    const first = harness.client.request("thread/list", { limit: 1 }, { timeoutMs: 100 });
    const second = harness.client.request("thread/list", { limit: 1 }, { timeoutMs: 100 });
    expect(harness.writes).toHaveLength(2);
    harness.send({ id: requestId(harness), result: page });
    harness.send({ id: requestId(harness, 1), result: page });
    await expect(Promise.all([first, second])).resolves.toEqual([page, page]);
  });
});
