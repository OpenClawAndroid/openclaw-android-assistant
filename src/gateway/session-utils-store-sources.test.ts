import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewaySessionStoreReadSources } from "./session-utils-store-sources.js";

it("bounds roster reads per preparation and observes later mutable fleet changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const agentIds = ["main", ...Array.from({ length: 47 }, (_, i) => `worker-${i}`)];
    let entryReads = 0;
    const entries = new Proxy(Object.fromEntries(agentIds.map((agentId) => [agentId, {}])), {
      get(target, property, receiver) {
        if (Object.hasOwn(target, property)) {
          entryReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries } };
    const prepare = () =>
      prepareGatewaySessionStoreReadSources({
        cfg,
        currentSource: { agentId: database.agentId, path: database.path },
        env: state.env,
        registryPath: openOpenClawStateDatabase().path,
      });

    const first = prepare();
    expect(Object.keys(first.sources)).toEqual(agentIds);
    expect(entryReads).toBeLessThan(agentIds.length * 16);

    entries.added = {};
    entryReads = 0;
    expect(Object.keys(prepare().sources)).toEqual([...agentIds, "added"]);
    expect(entryReads).toBeLessThan((agentIds.length + 1) * 16);
    expect(Object.keys(first.sources)).toEqual(agentIds);
  });
});

it("binds source addresses before asynchronous callers yield", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const currentSource = { agentId: database.agentId, path: database.path };
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const env = { ...state.env };
    const prepared = prepareGatewaySessionStoreReadSources({
      cfg,
      currentSource,
      env,
      registryPath: openOpenClawStateDatabase().path,
    });

    await Promise.resolve();
    cfg.session = { store: path.join(state.stateDir, "moved", "{agentId}", "sessions.json") };
    env.OPENCLAW_STATE_DIR = state.path("different-state");

    expect(prepared.sources.main).toEqual([currentSource]);
    expect(() => prepared.assertCurrent()).not.toThrow();
  });
});

it("bounds fixed-store discovery per operation and refreshes the next source roster", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storeDir = state.path("stores");
    fs.mkdirSync(storeDir, { recursive: true });
    const storePath = path.join(storeDir, "shared.json");
    const agentIds = ["main", ...Array.from({ length: 11 }, (_, i) => `worker-${i}`)];
    const entries = Object.fromEntries(agentIds.map((agentId) => [agentId, {}]));
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries,
        defaults: { systemAgent: { agentId: "main" }, sessionStore: { agentId: "main" } },
      },
      session: { store: storePath },
    };
    const openStore = (agentId: string) =>
      openOpenClawAgentDatabase({
        agentId,
        env: state.env,
        path: path.join(
          storeDir,
          agentId === "main" ? "shared.sqlite" : `shared.${agentId}.sqlite`,
        ),
      });
    const databases = agentIds.map(openStore);
    const currentSource = { agentId: "main", path: databases[0]!.path };
    const prepare = () =>
      prepareGatewaySessionStoreReadSources({
        cfg,
        currentSource,
        env: state.env,
        registryPath: openOpenClawStateDatabase().path,
      });
    const expectedSources = () =>
      Object.fromEntries(
        databases.map(({ agentId, path: databasePath }) => [
          agentId,
          [{ agentId, path: databasePath }],
        ]),
      );
    const readdir = vi.spyOn(fs, "readdirSync");
    syncBuiltinESMExports();
    const expectBoundedDiscovery = () => {
      const prepared = prepare();
      expect(prepared.sources).toEqual(expectedSources());
      expect(prepared.sources.main?.[0]).toBe(currentSource);
      expect(
        readdir.mock.calls.filter(([pathname]) => pathname === storeDir).length,
      ).toBeLessThanOrEqual(databases.length * 8);
      return prepared;
    };
    try {
      const first = expectBoundedDiscovery();
      entries.added = {};
      databases.push(openStore("added"));
      readdir.mockClear();
      const second = expectBoundedDiscovery();
      expect(Object.keys(first.sources)).toEqual(agentIds);
      expect(Object.keys(second.sources)).toEqual([...agentIds, "added"]);
    } finally {
      readdir.mockRestore();
      syncBuiltinESMExports();
    }
  });
});
