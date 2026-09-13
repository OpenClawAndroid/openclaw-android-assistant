import { createHash } from "node:crypto";
import { StatementSync } from "node:sqlite";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnePasswordBroker, type StandingGrant } from "./broker.js";
import type { OnePasswordConfig } from "./config.js";
import { MemoryKeyedStore, MemorySyncKeyedStore } from "./memory-store.test-support.js";
import { createOnePasswordTool } from "./tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const NOW = 10_000;
const invocation = { agentId: "agent-a", sessionKey: "session-a", sessionId: "conversation-a" };

function grantKey(agentId: string, slug: string) {
  return createHash("sha256")
    .update(JSON.stringify([agentId, slug]))
    .digest("hex");
}

function configured(slugs: string[]): OnePasswordConfig {
  return {
    vault: "Automation",
    defaultPolicy: "approve",
    cacheTtlSeconds: 300,
    grantTtlHours: 1,
    opTimeoutMs: 15_000,
    items: Object.fromEntries(
      slugs.map((slug) => [
        slug,
        { vault: "Automation", item: slug, field: "credential", policy: "approve" },
      ]),
    ),
  };
}

function grant(slug: string, agentId = invocation.agentId): StandingGrant {
  return {
    agentId,
    slug,
    grantedAtMs: NOW - 1,
    expiresAtMs: NOW + 60_000,
    targetFingerprint: createHash("sha256")
      .update(JSON.stringify(["Automation", slug, "credential"]))
      .digest("hex"),
  };
}

describe("onepassword list with SQLite grants", () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    resetPluginStateStoreForTests();
    env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("onepassword-list-") };
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
  });

  function openGrants() {
    return createPluginStateKeyedStoreForTests<StandingGrant>("onepassword", {
      namespace: "grants",
      maxEntries: 1_024,
      overflowPolicy: "evict-oldest",
      env,
    });
  }

  function setup(slugs: string[], grants: PluginStateKeyedStore<StandingGrant> = openGrants()) {
    const getItem = vi.fn(async () => {
      throw new Error("list must not retrieve a secret");
    });
    const broker = new OnePasswordBroker({
      resolveConfig: () => configured(slugs),
      opClient: { getItem },
      stores: { grants, audit: new MemoryKeyedStore(), pending: new MemorySyncKeyedStore() },
    });
    const list = (agentId: string | undefined = invocation.agentId) =>
      createOnePasswordTool(broker, { ...invocation, agentId }).execute("list", { action: "list" });
    return { list, getItem };
  }

  it("does not fetch other agents' grants to list the configured items", async () => {
    const grants = openGrants();
    const slugs = ["second", "first"];
    for (const agentId of [
      invocation.agentId,
      ...Array.from({ length: 31 }, (_, i) => `other-${i}`),
    ]) {
      for (const slug of slugs) {
        await grants.register(grantKey(agentId, slug), grant(slug, agentId));
      }
    }
    const { list, getItem } = setup(slugs, grants);
    let queries = 0;
    let fetchedRows = 0;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the native receiver when recording actual fetched rows.
    const iterate = StatementSync.prototype.iterate;
    const spy = vi.spyOn(StatementSync.prototype, "iterate").mockImplementation(function (
      this: StatementSync,
      ...params: Parameters<typeof iterate>
    ) {
      const rows = Array.from(iterate.apply(this, params));
      if (this.sourceSQL.includes('"plugin_state_entries"') && params.includes("grants")) {
        queries += 1;
        fetchedRows += rows.length;
      }
      return rows.values();
    });
    try {
      expect((await list()).details).toEqual({
        ok: true,
        items: ["first", "second"].map((slug) => ({
          slug,
          description: "",
          policy: "approve",
          standingGrantActive: true,
        })),
      });
    } finally {
      spy.mockRestore();
    }
    expect(queries).toBeLessThanOrEqual(1);
    expect(fetchedRows).toBeLessThanOrEqual(slugs.length);
    expect(getItem).not.toHaveBeenCalled();
  });

  it.each([true, false])("validates selected grants with bulk support=%s", async (bulk) => {
    const grants = openGrants();
    const slugs = ["wrong-slug", "wrong-agent", "retargeted", "missing", "expired", "active"];
    for (const slug of slugs.filter((value) => value !== "missing")) {
      await grants.register(grantKey(invocation.agentId, slug), {
        ...grant(slug),
        ...(slug === "wrong-agent" ? { agentId: "other" } : {}),
        ...(slug === "wrong-slug" ? { slug: "other" } : {}),
        ...(slug === "expired" ? { expiresAtMs: NOW } : {}),
        ...(slug === "retargeted" ? { targetFingerprint: "old-target" } : {}),
      });
    }
    const { lookupMany: _lookupMany, ...olderStore } = grants;
    const { list, getItem } = setup(slugs, bulk ? grants : olderStore);
    expect((await list()).details).toEqual({
      ok: true,
      items: [...slugs].toSorted().map((slug) => ({
        slug,
        description: "",
        policy: "approve",
        standingGrantActive: slug === "active",
      })),
    });
    expect(getItem).not.toHaveBeenCalled();
  });

  it("ignores unrelated corrupt JSON but reports selected corruption", async () => {
    const grants = openGrants();
    const key = grantKey(invocation.agentId, "selected");
    await grants.register(key, grant("selected"));
    await grants.register("unrelated", grant("unrelated", "other"));
    const { db } = openOpenClawStateDatabase({ env });
    const corrupt = db.prepare(
      "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = 'onepassword' AND namespace = 'grants' AND entry_key = ?",
    );
    corrupt.run("{", "unrelated");
    expect((await setup(["selected"], grants).list()).details).toMatchObject({
      ok: true,
      items: [{ slug: "selected", standingGrantActive: true }],
    });
    const { lookupMany: _lookupMany, ...olderStore } = grants;
    expect((await setup(["selected"], olderStore).list()).details).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_STATE_CORRUPT" },
    });
    corrupt.run("{", key);
    expect((await setup(["selected"], grants).list()).details).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_STATE_CORRUPT" },
    });
  });

  it("treats null and expired rows as inactive without changing stored rows", async () => {
    const grants = openGrants();
    for (const slug of ["null-value", "expired-row"]) {
      await grants.register(grantKey(invocation.agentId, slug), grant(slug));
    }
    const { db } = openOpenClawStateDatabase({ env });
    db.prepare("UPDATE plugin_state_entries SET value_json = 'null' WHERE entry_key = ?").run(
      grantKey(invocation.agentId, "null-value"),
    );
    db.prepare("UPDATE plugin_state_entries SET expires_at = ? WHERE entry_key = ?").run(
      NOW,
      grantKey(invocation.agentId, "expired-row"),
    );
    const rows = () => db.prepare("SELECT * FROM plugin_state_entries ORDER BY entry_key").all();
    const before = rows();
    expect((await setup(["null-value", "expired-row"], grants).list()).details).toMatchObject({
      ok: true,
      items: [
        { slug: "expired-row", standingGrantActive: false },
        { slug: "null-value", standingGrantActive: false },
      ],
    });
    expect(rows()).toEqual(before);
  });

  it("skips grant reads without an agent and never retries a rejected bulk read", async () => {
    const grants = openGrants();
    const entries = vi.fn(grants.entries);
    const lookup = vi.fn(grants.lookup);
    const lookupMany = vi.fn(async () => {
      throw new Error("grant read unavailable");
    });
    const { list, getItem } = setup(["selected"], { ...grants, entries, lookup, lookupMany });
    expect((await list("")).details).toMatchObject({
      ok: true,
      items: [{ standingGrantActive: false }],
    });
    expect(lookupMany).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
    expect((await list()).details).toMatchObject({
      ok: false,
      error: { message: "grant read unavailable" },
    });
    expect(lookupMany).toHaveBeenCalledTimes(1);
    expect(entries).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });
});
