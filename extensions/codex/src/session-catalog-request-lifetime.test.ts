import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./app-server/client.js";
import { threadStartResult } from "./app-server/codex-app-server.test-fixtures.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import { getCurrentSharedClientEntry } from "./app-server/shared-client-lifecycle.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import { createCodexSessionCatalogControl } from "./session-catalog-control.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

type ListFrame = { id: number; params: CodexThreadListParams };
type CatalogResources = {
  transports: ReturnType<typeof createClientHarness>[];
  companion?: CodexAppServerClient;
};
const REQUEST_TIMEOUT_MS = 200;

function page(threadId: string) {
  return {
    data: [{ ...threadStartResult(threadId).thread, source: "cli" }],
    nextCursor: null,
  };
}

function poll(
  control: CodexSessionCatalogControl,
  params: CodexSessionCatalogPageParams = { limit: 1 },
) {
  const pending = control.listPage(params);
  // Observe rejection immediately, including when a failing assertion enters cleanup first.
  void pending.catch(() => undefined);
  return pending;
}

async function createCatalogHarness(agentDir: string, resources: CatalogResources) {
  const { transports } = resources;
  const frames: Array<ListFrame & { transport: ReturnType<typeof createClientHarness> }> = [];
  vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
    const transport = createClientHarness({
      onWrite: (line, send) => {
        const message = JSON.parse(line) as ListFrame & { method: string };
        if (message.method === "initialize") {
          send({ id: message.id, result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` } });
        } else if (message.method === "model/list" || message.params?.cursor === "warm") {
          send({ id: message.id, result: { data: [] } });
        } else if (message.method === "thread/list") {
          frames.push({ ...message, transport });
        } else if (message.method !== "initialized") {
          throw new Error(`Unexpected catalog fixture request: ${message.method}`);
        }
      },
    });
    transports.push(transport);
    return transport.client;
  });
  let config: OpenClawConfig = {
    agents: { list: ["main", "other"].map((id) => ({ id, agentDir, workspace: agentDir })) },
  };
  const pluginConfig = {
    appServer: {
      transport: "websocket",
      homeScope: "agent",
      url: "ws://127.0.0.1:1",
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
  };
  let now = 1_000;
  const newFactory = () =>
    createCodexSessionCatalogControl({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => config,
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
      now: () => now,
      env: {},
    });
  const factory = newFactory();
  const control = factory.forRequest("main");
  const runtime = resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig, env: {} });
  const companion = await getLeasedSharedCodexAppServerClient({
    agentDir,
    config,
    startOptions: runtime.start,
    authProfileId: null,
  });
  resources.companion = companion;
  await control.listPage({ cursor: "warm", limit: 1 });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return {
    control,
    factory,
    companion,
    transports,
    frames,
    newFactory,
    replaceConfig: () => {
      config = structuredClone(config);
    },
    expirePage: () => {
      now += 32_001;
    },
    async frame(index: number) {
      return await vi.waitFor(
        () => {
          const frame = frames[index];
          assert(frame, `Expected catalog request ${index}`);
          return frame;
        },
        { interval: 1 },
      );
    },
    reply(frame: (typeof frames)[number], threadId: string) {
      frame.transport.send({ id: frame.id, result: page(threadId) });
    },
    async expireWaiter() {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      await vi.waitFor(() => expect(getCurrentSharedClientEntry(companion)?.activeLeases).toBe(1), {
        interval: 1,
      });
    },
    async waitForRefresh() {
      await vi.waitFor(() => expect(getCurrentSharedClientEntry(companion)?.activeLeases).toBe(2), {
        interval: 1,
      });
      await nextTurn();
    },
  };
}

describe("catalog request lifetime across page-cache polls", () => {
  let agentDir: string;
  let h: Awaited<ReturnType<typeof createCatalogHarness>>;
  let resources: CatalogResources;

  beforeEach(async () => {
    resources = { transports: [] };
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-catalog-lifetime-"));
    h = await createCatalogHarness(agentDir, resources);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (resources.companion) {
      releaseLeasedSharedCodexAppServerClient(resources.companion);
    }
    const closed = await Promise.allSettled(
      resources.transports.map(({ client }) => client.closeAndWait()),
    );
    vi.restoreAllMocks();
    await fs.rm(agentDir, { recursive: true, force: true });
    expect(closed.every((result) => result.status === "fulfilled")).toBe(true);
  });

  it("lets a fresh cold poll fulfill the existing request without reviving its expired caller", async () => {
    const first = poll(h.control);
    const frame = await h.frame(0);
    await h.expireWaiter();
    await expect(first).rejects.toThrow("thread/list timed out");

    const current = poll(h.control);
    await h.waitForRefresh();
    expect(h.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS / 2);
    h.reply(frame, "current-result");
    await expect(current).resolves.toMatchObject({ sessions: [{ threadId: "current-result" }] });
    await expect(first).rejects.toThrow("thread/list timed out");
    expect(h.frames).toHaveLength(1);
    await expect(h.companion.request("model/list", {})).resolves.toEqual({ data: [] });
    expect(h.transports).toHaveLength(1);
  });

  it("serves stale pages immediately while a current refresh joins the expired refresh's request", async () => {
    const seed = poll(h.control);
    h.reply(await h.frame(0), "stale");
    const stale = await seed;
    h.expirePage();
    await expect(poll(h.control)).resolves.toEqual(stale);
    const refresh = await h.frame(1);
    await h.expireWaiter();

    await expect(poll(h.control)).resolves.toEqual(stale);
    await h.waitForRefresh();
    expect(h.frames).toHaveLength(2);
    h.reply(refresh, "refreshed");
    await vi.waitFor(async () => {
      await expect(poll(h.control)).resolves.toMatchObject({
        sessions: [{ threadId: "refreshed" }],
      });
    });
    expect(h.frames).toHaveLength(2);
  });

  it("discards an unobserved late refresh reply instead of making the stale page fresh", async () => {
    const seed = poll(h.control);
    h.reply(await h.frame(0), "stale");
    const stale = await seed;
    h.expirePage();
    await expect(poll(h.control)).resolves.toEqual(stale);
    const expired = await h.frame(1);
    await h.expireWaiter();
    h.reply(expired, "unobserved");
    await nextTurn();

    await expect(poll(h.control)).resolves.toEqual(stale);
    h.reply(await h.frame(2), "current-refresh");
    await vi.waitFor(async () => {
      await expect(poll(h.control)).resolves.toMatchObject({
        sessions: [{ threadId: "current-refresh" }],
      });
    });
    expect(h.frames).toHaveLength(3);
  });

  it.each(["config", "factory", "agent", "home", "query"] as const)(
    "does not join an expired request from another %s partition",
    async (partition) => {
      const first = poll(h.control);
      const expired = await h.frame(0);
      await h.expireWaiter();
      await expect(first).rejects.toThrow("thread/list timed out");
      let control = h.control;
      let params: CodexSessionCatalogPageParams = { limit: 1 };
      if (partition === "config") {
        h.replaceConfig();
      } else if (partition === "factory") {
        control = h.newFactory().forRequest("main");
      } else if (partition === "agent") {
        control = h.factory.forRequest("other");
      } else if (partition === "home") {
        const [home] = h.factory.homesForAgent("main");
        assert(home);
        control = h.factory.forRequest("main", {
          ...home,
          sourceHomeId: "separate-home",
        });
      } else {
        params = { limit: 1, cursor: "separate-query" };
      }
      const current = poll(control, params);
      const independent = await h.frame(1);
      // The semantic partition must survive even when normal acquisition selects one client.
      expect(independent.transport.client).toBe(expired.transport.client);
      h.reply(independent, "partition-result");
      await expect(current).resolves.toMatchObject({
        sessions: [{ threadId: "partition-result" }],
      });
      h.reply(expired, "old-result");
      await expect(first).rejects.toThrow("thread/list timed out");
      expect(h.frames).toHaveLength(2);
    },
  );

  it("allows an independently initiated poll to reconnect after the old connection closes", async () => {
    const first = poll(h.control);
    const old = await h.frame(0);
    old.transport.emitExit();
    await expect(first).rejects.toThrow();

    const current = poll(h.control);
    const replacement = await h.frame(1);
    expect(replacement.transport.client).not.toBe(old.transport.client);
    h.reply(replacement, "reconnected");
    await expect(current).resolves.toMatchObject({ sessions: [{ threadId: "reconnected" }] });
    expect(h.frames).toHaveLength(2);
    expect(h.transports).toHaveLength(2);
  });
});
