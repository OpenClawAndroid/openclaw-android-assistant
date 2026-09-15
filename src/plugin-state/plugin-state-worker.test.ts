import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { serialize } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_WORKER_MAX_RESULT_BYTES } from "../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
} from "./plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

describe("worker plugin state", () => {
  it("shares public keyed operations with the legacy store while SQL stays on the worker", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-coexistence" }, async () => {
      const options = {
        namespace: "claims",
        maxEntries: 10,
        overflowPolicy: "reject-new" as const,
      };
      const native = requireNodeSqlite();
      const prepare = vi.spyOn(native.DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(native.DatabaseSync.prototype, "exec");
      const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(native.StatementSync.prototype, method),
      );
      const sql = [prepare, exec, ...statements];
      try {
        const store = createPluginStateKeyedStore<number>("slack", options);
        const legacy = createPluginStateSyncKeyedStore<number>("slack", options);
        expect(() => createPluginStateKeyedStore("slack", { ...options, maxEntries: 0 })).toThrow(
          PluginStateStoreError,
        );
        await expect(store.lookup(" ")).rejects.toMatchObject({
          code: "PLUGIN_STATE_INVALID_INPUT",
          operation: "lookup",
        });
        expect(existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
        expect(await store.lookup("missing")).toBeUndefined();
        expect(await store.lookupMany(["missing", "missing"])).toEqual([
          { ok: true, value: undefined },
          { ok: true, value: undefined },
        ]);
        expect(await store.entries()).toEqual([]);
        expect(await store.count()).toBe(0);
        expect(existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
        await store.register("upsert", 5);
        expect(await store.lookup("upsert")).toBe(5);
        expect(await store.count()).toBe(1);
        expect(await store.entries()).toEqual([
          { key: "upsert", value: 5, createdAt: expect.any(Number) },
        ]);
        expect(await store.consume("upsert")).toBe(5);
        expect(await store.consume("upsert")).toBeUndefined();
        expect(await store.registerIfAbsent("worker", 2)).toBe(true);
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
        legacy.register("legacy", 1);
        expect(legacy.lookup("worker")).toBe(2);
        sql.forEach((method) => method.mockClear());
        expect(await store.registerIfAbsent("legacy", 3)).toBe(false);
        expect(await store.deleteIfEqual("worker", 1)).toBe(false);
        expect(await store.deleteIfEqual("worker", 2)).toBe(true);
        expect(await store.registerIfAbsent("fresh", 4)).toBe(true);
        await store.register("delete", 6);
        expect(await store.delete("delete")).toBe(true);
        expect(await store.delete("delete")).toBe(false);
        const cleared = createPluginStateKeyedStore<number>("slack", {
          ...options,
          namespace: "clear",
        });
        await cleared.register("removed", 7);
        await cleared.clear();
        expect(await cleared.entries()).toEqual([]);
        expect(await cleared.count()).toBe(0);
        expect(await store.lookupMany(["fresh", "legacy", "fresh"])).toEqual([
          { ok: true, value: 4 },
          { ok: true, value: 1 },
          { ok: true, value: 4 },
        ]);
        expect(await store.count()).toBe(2);
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
      } finally {
        sql.forEach((method) => method.mockRestore());
      }
      const persisted = createPluginStateSyncKeyedStore<number>("slack", options);
      expect(persisted.lookup("legacy")).toBe(1);
      expect(persisted.lookup("worker")).toBeUndefined();
      expect(persisted.lookup("fresh")).toBe(4);
      await closeOpenClawStateDatabaseAsync();
      expect(persisted.lookup("fresh")).toBe(4);
    });
  });

  it("lets only one concurrent public consume receive a retained value", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-consume" }, async () => {
      const store = createPluginStateKeyedStore<{ count: number }>("slack", {
        namespace: "consume",
        maxEntries: 10,
      });
      const value = { count: 1 };
      const registered = store.register("once", value);
      value.count = 99;
      await registered;
      const results = await Promise.all([store.consume("once"), store.consume("once")]);
      expect(results.filter((result) => result !== undefined)).toEqual([{ count: 1 }]);
      expect(results.filter((result) => result === undefined)).toHaveLength(1);
      expect(await store.lookup("once")).toBeUndefined();
    });
  });

  it("keeps worker listing order and expiry while refreshing register TTLs", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-ttl-order" }, async () => {
      const namespace = "ttl-order";
      const now = Date.now();
      seedPluginStateEntriesForTests([
        {
          pluginId: "slack",
          namespace,
          key: "z",
          value: 1,
          createdAt: now - 2_000,
          expiresAt: now + 86_400_000,
        },
        { pluginId: "slack", namespace, key: "a", value: 2, createdAt: now - 2_000 },
        {
          pluginId: "slack",
          namespace,
          key: "expired",
          value: 3,
          createdAt: now - 3_000,
          expiresAt: now - 1,
        },
      ]);
      const store = createPluginStateKeyedStore<number>("slack", {
        namespace,
        maxEntries: 10,
        defaultTtlMs: 60_000,
      });
      expect((await store.entries()).map(({ key }) => key)).toEqual(["a", "z"]);
      expect(await store.lookup("expired")).toBeUndefined();
      expect(await store.consume("expired")).toBeUndefined();
      expect(await store.delete("expired")).toBe(true);
      for (const [value, ttlMs] of [
        [4, undefined],
        [5, 120_000],
      ] as const) {
        const before = Date.now();
        await store.register("fresh", value, ttlMs === undefined ? undefined : { ttlMs });
        const after = Date.now();
        const entries = await store.entries();
        const fresh = entries.find(({ key }) => key === "fresh");
        expect(entries.map(({ key }) => key)).toEqual(["a", "z", "fresh"]);
        expect(fresh?.value).toBe(value);
        expect(fresh?.createdAt).toBeGreaterThanOrEqual(before);
        expect(fresh?.createdAt).toBeLessThanOrEqual(after);
        expect(fresh?.expiresAt).toBe((fresh?.createdAt ?? 0) + (ttlMs ?? 60_000));
      }
    });
  });

  it("returns complete entries and positional bulk values larger than a broker frame", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-large-reads" }, async () => {
      const namespace = "large-reads";
      const payloadBytes = 900_000;
      const count = Math.ceil(SQLITE_WORKER_MAX_RESULT_BYTES / payloadBytes) + 1;
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      const values = Array.from({ length: count }, (_, index) => ({
        index,
        payload: `${index}:${"x".repeat(payloadBytes)}`,
      }));
      const keys = values.map((_, index) => `key-${index}`);
      seedPluginStateEntriesForTests(
        values.map((value, index) => ({
          pluginId: "slack",
          namespace,
          key: keys[index]!,
          value,
          createdAt: 1000 + index,
        })),
      );
      await closeOpenClawStateDatabaseAsync();
      const expected = values.map((value) => [value.index, digest(value.payload)]);
      const store = createPluginStateKeyedStore<{ index: number; payload: string }>("slack", {
        namespace,
        maxEntries: count,
      });
      const native = requireNodeSqlite();
      const sql = [
        vi.spyOn(native.DatabaseSync.prototype, "prepare"),
        vi.spyOn(native.DatabaseSync.prototype, "exec"),
        ...(["get", "all", "run", "iterate"] as const).map((method) =>
          vi.spyOn(native.StatementSync.prototype, method),
        ),
      ];
      try {
        const entries = await store.entries();
        expect(serialize(entries).byteLength).toBeGreaterThan(SQLITE_WORKER_MAX_RESULT_BYTES);
        expect(entries.map((entry) => [entry.value.index, digest(entry.value.payload)])).toEqual(
          expected,
        );
        const request = [...keys.toReversed(), keys[0]!];
        const results = await store.lookupMany(request);
        expect(serialize(results).byteLength).toBeGreaterThan(SQLITE_WORKER_MAX_RESULT_BYTES);
        expect(
          results.map((result) =>
            result.ok && result.value ? [result.value.index, digest(result.value.payload)] : null,
          ),
        ).toEqual([...expected.toReversed(), expected[0]]);
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
      } finally {
        sql.forEach((method) => method.mockRestore());
      }
    });
  });

  it("preserves live-value equality, expiry, quota refusal, and corrupt JSON errors", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-contract" }, async () => {
      const options = {
        namespace: "conditional",
        maxEntries: 1,
        overflowPolicy: "reject-new" as const,
      };
      const legacy = createPluginStateSyncKeyedStore<unknown>("slack", options);
      const store = createPluginStateKeyedStore<unknown>("slack", options);
      expect(await store.registerIfAbsent("entry", 1)).toBe(true);
      expect(await store.deleteIfEqual("entry", "1")).toBe(false);
      const { db, path } = openOpenClawStateDatabase();
      const refused = await store.registerIfAbsent("extra", 2).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(PluginStateStoreError);
      expect(refused).toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        operation: "register",
        path,
      });
      expect(legacy.lookup("entry")).toBe(1);
      expect(legacy.lookup("extra")).toBeUndefined();

      seedPluginStateEntriesForTests([
        {
          pluginId: "slack",
          namespace: options.namespace,
          key: "entry",
          value: 1,
          expiresAt: Date.now() - 1,
        },
      ]);
      expect(await store.deleteIfEqual("entry", 1)).toBe(false);
      expect(await store.registerIfAbsent("entry", null)).toBe(true);
      expect(await store.deleteIfEqual("entry", null)).toBe(true);

      legacy.register("entry", false);
      db.prepare(
        "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
      ).run("invalid JSON", "slack", options.namespace, "entry");
      const corrupt = await store.deleteIfEqual("entry", false).catch((error: unknown) => error);
      expect(corrupt).toBeInstanceOf(PluginStateStoreError);
      expect(corrupt).toMatchObject({
        code: "PLUGIN_STATE_CORRUPT",
        operation: "delete",
        path,
        cause: expect.any(SyntaxError),
      });
    });
  });
});
