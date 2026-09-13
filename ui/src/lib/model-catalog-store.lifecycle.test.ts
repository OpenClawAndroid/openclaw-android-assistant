import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../packages/gateway-client/src/pending-request.js";
import type { ModelCatalogResult } from "../api/types.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import {
  beginModelCatalogRead,
  clearModelCatalogCache,
  invalidateModelCatalogCache,
  publishModelCatalogResult,
  subscribeModelCatalogCache,
} from "./model-catalog-cache.ts";
import { loadModelCatalog, peekModelCatalog } from "./model-catalog-store.ts";

const scope = { agentId: "main", sessionKey: "agent:main:catalog" };
const stale = { models: [{ id: "stale", provider: "test", name: "Stale" }] };
const fresh = { models: [{ id: "fresh", provider: "test", name: "Fresh" }] };

afterEach(() => vi.useRealTimers());

function protocolFixture(requestTimeoutMs?: number) {
  const sent: Array<{ id: string; method: string; params: unknown }> = [];
  const protocol = new GatewayPendingRequests({
    createRequestId: () => "catalog",
    nowMs: Date.now,
    requestTimeoutMs,
  });
  const client = createTestGatewayClient((method, params, options) =>
    protocol.request({ send: (frame) => sent.push(JSON.parse(frame)) }, method, params, options),
  );
  return {
    client,
    sent,
    respond(index: number, payload: ModelCatalogResult) {
      const request = sent[index];
      if (!request) {
        throw new Error(`Missing catalog request ${index}`);
      }
      protocol.handleResponse({ type: "res", id: request.id, ok: true, payload });
    },
    close() {
      clearModelCatalogCache(client);
      protocol.flush(new Error("fixture closed"));
    },
  };
}

it("preserves inherited transport deadlines and explicit unbounded requests", async () => {
  vi.useFakeTimers();
  const fixture = protocolFixture(25);
  const inherited = loadModelCatalog(fixture.client, scope);
  const unbounded = loadModelCatalog(fixture.client, { ...scope, timeoutMs: null });
  const expired = expect(inherited).rejects.toMatchObject({
    name: GatewayProtocolRequestTimeoutError.name,
    timeoutMs: 25,
    requestSent: true,
  });
  try {
    await vi.advanceTimersByTimeAsync(100);
    await expired;
    fixture.respond(1, fresh);
    expect(await unbounded).toEqual(fresh);
  } finally {
    fixture.close();
    await Promise.allSettled([inherited, unbounded]);
  }
});

it.each([false, true])(
  "retains one transport through repeated invalidation (retiring consumers: %s)",
  async (retire) => {
    const fixture = protocolFixture();
    let controller = new AbortController();
    const reads = [loadModelCatalog(fixture.client, { ...scope, signal: controller.signal })];
    const results: Array<Promise<unknown>> = reads.map((read) =>
      read.catch((error: unknown) => error),
    );
    try {
      for (let index = 0; index < 8; index += 1) {
        invalidateModelCatalogCache(fixture.client);
        if (retire) {
          controller.abort(new Error("pane generation retired"));
          await expect(reads.at(-1)).rejects.toThrow("pane generation retired");
        }
        controller = new AbortController();
        const read = loadModelCatalog(fixture.client, { ...scope, signal: controller.signal });
        reads.push(read);
        results.push(read.catch((error: unknown) => error));
      }
      expect(fixture.sent).toHaveLength(1);
      fixture.respond(0, stale);
      await vi.waitFor(() => expect(fixture.sent).toHaveLength(2));
      fixture.respond(1, fresh);
      expect(await reads.at(-1)).toEqual(fresh);
      if (!retire) {
        expect(await reads[0]).toEqual(stale);
        expect(await Promise.all(reads.slice(1))).toEqual(Array.from({ length: 8 }, () => fresh));
      }
      expect(peekModelCatalog(fixture.client, scope)).toEqual(fresh);
      expect(fixture.sent.every((request) => request.method === "models.list")).toBe(true);
    } finally {
      fixture.close();
      await Promise.all(results);
    }
  },
);

it("keeps transport ownership after a pushed snapshot settles its consumers", async () => {
  const fixture = protocolFixture();
  const pushed = beginModelCatalogRead(fixture.client, scope);
  const first = loadModelCatalog(fixture.client, scope);
  let replacement: Promise<ModelCatalogResult> | undefined;
  try {
    expect(publishModelCatalogResult(pushed, scope, fresh)).toBe(true);
    expect(await first).toEqual(fresh);
    invalidateModelCatalogCache(fixture.client);
    replacement = loadModelCatalog(fixture.client, scope);
    expect(fixture.sent).toHaveLength(1);
    fixture.respond(0, stale);
    await vi.waitFor(() => expect(fixture.sent).toHaveLength(2));
    expect(peekModelCatalog(fixture.client, scope)).toBeUndefined();
    fixture.respond(1, fresh);
    expect(await replacement).toEqual(fresh);
  } finally {
    fixture.close();
    await Promise.allSettled([first, replacement]);
  }
});

it("settles queued readers from a current snapshot without starting another transport", async () => {
  const fixture = protocolFixture();
  const first = loadModelCatalog(fixture.client, scope);
  invalidateModelCatalogCache(fixture.client);
  const queued = loadModelCatalog(fixture.client, scope);
  try {
    const pushed = beginModelCatalogRead(fixture.client, scope);
    expect(publishModelCatalogResult(pushed, scope, fresh)).toBe(true);
    expect(await queued).toEqual(fresh);
    fixture.respond(0, stale);
    await first;
    expect(fixture.sent).toHaveLength(1);
    expect(peekModelCatalog(fixture.client, scope)).toEqual(fresh);
  } finally {
    fixture.close();
    await Promise.allSettled([first, queued]);
  }
});

it.each([false, true])(
  "retains timed-out transport across a retry (retry deadline expires: %s)",
  async (expireRetry) => {
    vi.useFakeTimers();
    const fixture = protocolFixture();
    const first = loadModelCatalog(fixture.client, { ...scope, timeoutMs: 100 });
    const expired = expect(first).rejects.toMatchObject({
      name: GatewayProtocolRequestTimeoutError.name,
      timeoutMs: 100,
      requestSent: true,
    });
    let retry: Promise<ModelCatalogResult> | undefined;
    let recovery: Promise<ModelCatalogResult> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(100);
      await expired;
      retry = loadModelCatalog(fixture.client, { ...scope, timeoutMs: 100 });
      const retryOutcome = retry.catch((error: unknown) => error);
      expect(fixture.sent).toHaveLength(1);
      if (expireRetry) {
        await vi.advanceTimersByTimeAsync(100);
        expect(await retryOutcome).toMatchObject({
          name: GatewayProtocolRequestTimeoutError.name,
          timeoutMs: 100,
          requestSent: false,
        });
      } else {
        await vi.advanceTimersByTimeAsync(40);
      }
      fixture.respond(0, stale);
      await vi.advanceTimersByTimeAsync(0);
      expect(peekModelCatalog(fixture.client, scope)).toBeUndefined();
      if (expireRetry) {
        expect(fixture.sent).toHaveLength(1);
        recovery = loadModelCatalog(fixture.client, { ...scope, timeoutMs: 100 });
      }
      expect(fixture.sent).toHaveLength(2);
      fixture.respond(1, fresh);
      expect(await (recovery ?? retry)).toEqual(fresh);
      expect(peekModelCatalog(fixture.client, scope)).toEqual(fresh);
    } finally {
      fixture.close();
      await Promise.allSettled([first, retry, recovery]);
    }
  },
);

it("retires queued work on connection clear without dispatching it after the old read", async () => {
  const fixture = protocolFixture();
  const first = loadModelCatalog(fixture.client, scope);
  invalidateModelCatalogCache(fixture.client);
  const queued = loadModelCatalog(fixture.client, scope);
  const rejected = expect(queued).rejects.toHaveProperty("name", "AbortError");
  try {
    clearModelCatalogCache(fixture.client);
    await rejected;
    fixture.respond(0, stale);
    await first;
    expect(fixture.sent).toHaveLength(1);
    expect(peekModelCatalog(fixture.client, scope)).toBeUndefined();
  } finally {
    fixture.close();
    await Promise.allSettled([first, queued]);
  }
});

it("preserves an explicit refresh when queued readers receive an ordinary snapshot", async () => {
  const fixture = protocolFixture();
  const first = loadModelCatalog(fixture.client, scope);
  invalidateModelCatalogCache(fixture.client);
  const queued = loadModelCatalog(fixture.client, scope);
  const refresh = loadModelCatalog(fixture.client, { ...scope, refresh: true });
  let queuedSettled = false;
  void queued.then(() => (queuedSettled = true));
  try {
    const pushed = beginModelCatalogRead(fixture.client, scope);
    expect(publishModelCatalogResult(pushed, scope, stale)).toBe(true);
    expect(await first).toEqual(stale);
    expect(queuedSettled).toBe(false);
    expect(fixture.sent).toHaveLength(1);
    fixture.respond(0, stale);
    await vi.waitFor(() => expect(fixture.sent).toHaveLength(2));
    expect(fixture.sent[1]?.params).toMatchObject({ ...scope, refresh: true });
    fixture.respond(1, fresh);
    expect(await Promise.all([queued, refresh])).toEqual([fresh, fresh]);
    expect(peekModelCatalog(fixture.client, scope)).toEqual(fresh);
  } finally {
    fixture.close();
    await Promise.allSettled([first, queued, refresh]);
  }
});

it("includes queue residence in a numeric deadline after transport starts", async () => {
  vi.useFakeTimers();
  const fixture = protocolFixture();
  const first = loadModelCatalog(fixture.client, { ...scope, timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(40);
  invalidateModelCatalogCache(fixture.client);
  const queued = loadModelCatalog(fixture.client, { ...scope, timeoutMs: 100 });
  const rejected = expect(queued).rejects.toMatchObject({
    name: GatewayProtocolRequestTimeoutError.name,
    timeoutMs: 100,
    requestSent: true,
  });
  let settled = false;
  void queued.then(
    () => (settled = true),
    () => (settled = true),
  );
  try {
    await vi.advanceTimersByTimeAsync(20);
    fixture.respond(0, stale);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(79);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  } finally {
    fixture.close();
    await Promise.allSettled([first, queued]);
  }
});

it.each([false, true])(
  "shares a reserved explicit refresh with reentrant listeners (retired: %s)",
  async (retire) => {
    const fixture = protocolFixture();
    const controller = new AbortController();
    let reentrant: Promise<ModelCatalogResult> | undefined;
    let listening = true;
    const unsubscribe = subscribeModelCatalogCache(fixture.client, () => {
      if (listening) {
        listening = false;
        reentrant = loadModelCatalog(fixture.client, {
          ...scope,
          refresh: true,
          signal: controller.signal,
        });
        if (retire) {
          controller.abort();
        }
      }
    });
    const refresh = loadModelCatalog(fixture.client, { ...scope, refresh: true });
    try {
      expect(reentrant).toBeDefined();
      expect(fixture.sent).toHaveLength(1);
      fixture.respond(0, fresh);
      expect(await refresh).toEqual(fresh);
      if (retire) {
        await expect(reentrant).rejects.toHaveProperty("name", "AbortError");
      } else {
        expect(await reentrant).toEqual(fresh);
      }
      expect(fixture.sent).toHaveLength(1);
    } finally {
      unsubscribe();
      fixture.close();
      await Promise.allSettled([refresh, reentrant]);
    }
  },
);

it("rejects an aborted queued consumer immediately without sending its retired demand", async () => {
  const fixture = protocolFixture();
  const first = loadModelCatalog(fixture.client, scope);
  invalidateModelCatalogCache(fixture.client);
  const controller = new AbortController();
  const queued = loadModelCatalog(fixture.client, { ...scope, signal: controller.signal });
  const rejected = expect(queued).rejects.toHaveProperty("name", "AbortError");
  try {
    controller.abort();
    await rejected;
    fixture.respond(0, stale);
    await first;
    expect(fixture.sent).toHaveLength(1);
    expect(peekModelCatalog(fixture.client, scope)).toBeUndefined();
  } finally {
    fixture.close();
    await Promise.allSettled([first, queued]);
  }
});
