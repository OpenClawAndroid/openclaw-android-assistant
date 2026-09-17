import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as sqliteRuntime from "../../infra/node-sqlite.js";
import * as sqliteWorkerStore from "../../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import {
  listSessionEntriesReadOnlyAsync,
  readSessionListPageReadOnlyAsync,
} from "./session-accessor.sqlite-list-read.js";
import { addSessionMember } from "./session-sharing-store.js";

afterEach(() => vi.restoreAllMocks());

function observeNativeReaders() {
  const readers: Array<{
    pathname: string;
    db: ReturnType<typeof sqliteRuntime.openNodeSqliteDatabase>;
  }> = [];
  const nativeOpen = sqliteRuntime.openNodeSqliteDatabase;
  vi.spyOn(sqliteRuntime, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const db = nativeOpen(...args);
    if (args[1]?.readOnly) {
      readers.push({ pathname: args[0], db });
    }
    return db;
  });
  return {
    live: () => readers.filter(({ db }) => db.isOpen),
  };
}

async function seedReaderStore(state: OpenClawTestState, name: string) {
  const agentId = `capacity-${name}`;
  const sessionKey = `agent:${agentId}:entry`;
  const scope = { agentId, sessionKey, env: state.env, projection: "list" as const };
  replaceSessionEntrySync(scope, { sessionId: sessionKey, updatedAt: 1, label: name });
  addSessionMember(scope, { identityId: "viewer", addedBy: "owner" });
  const databasePath = openOpenClawAgentDatabase(scope).path;
  await closeOpenClawAgentDatabaseByPathAsync(databasePath, agentId);
  return { scope, databasePath };
}

it("lists more stores than the broker can retain without evicting active reads or final page observers", async () => {
  const readers = observeNativeReaders();
  await withOpenClawTestState({ label: "session-list-backend-capacity" }, async (state) => {
    const seed = (name: string) => seedReaderStore(state, name);
    const heldStore = await seed("held");
    const delivered = createDeferredCore();
    const release = createDeferredCore();
    const original = sqliteWorkerStore.runSqliteWorkerStoreOperation;
    vi.spyOn(sqliteWorkerStore, "runSqliteWorkerStoreOperation").mockImplementationOnce(
      async (...args) => {
        const value = await original(...args);
        delivered.resolve();
        await release.promise;
        return value;
      },
    );
    const held = listSessionEntriesReadOnlyAsync(heldStore.scope);
    let heldSettled = false;
    void held.then(
      () => {
        heldSettled = true;
      },
      () => {
        heldSettled = true;
      },
    );
    try {
      await Promise.race([delivered.promise, held]);
      expect(heldSettled).toBe(false);
      const stores: Array<Awaited<ReturnType<typeof seed>>> = [];
      // The shared broker permits 64 clients, including unrelated database consumers.
      for (let index = 0; index < 65; index++) {
        const store = await seed(String(index));
        stores.push(store);
        expect(await listSessionEntriesReadOnlyAsync(store.scope)).toMatchObject([
          { sessionKey: store.scope.sessionKey, entry: { label: String(index) } },
        ]);
        // One held accessor is exempt from the 64 idle observer limit.
        expect(readers.live().length).toBeLessThanOrEqual(65);
      }
      const scopes = stores.map(({ scope }) => ({ ...scope, sessionKeys: [scope.sessionKey] }));
      using page = await readSessionListPageReadOnlyAsync(scopes, {
        membershipIdentityId: "viewer",
      });
      expect(page.entries).toMatchObject(
        stores.map(({ scope }) => ({
          ok: true,
          value: {
            entries: [{ sessionKey: scope.sessionKey }],
            membershipKeys: [scope.sessionKey],
          },
        })),
      );
      expect(heldSettled).toBe(false);
      expect(readers.live()).toHaveLength(66);

      const first = stores[0]!;
      const external = new DatabaseSync(first.databasePath);
      try {
        external
          .prepare("DELETE FROM session_members WHERE session_key = ? AND identity_id = ?")
          .run(first.scope.sessionKey, "viewer");
      } finally {
        external.close();
      }
      // Old backend eviction must leave every selected store's admitted observer usable.
      expect(page.readCurrent({ membershipIdentityId: "viewer" })).toMatchObject(
        stores.map(({ scope }, index) => ({
          ok: true,
          value: {
            entries: [{ sessionKey: scope.sessionKey }],
            membershipKeys: index === 0 ? [] : [scope.sessionKey],
          },
        })),
      );
      expect(stores.every(({ databasePath }) => !isOpenClawAgentDatabaseOpen(databasePath))).toBe(
        true,
      );
      release.resolve();
      expect(await held).toMatchObject([
        { sessionKey: heldStore.scope.sessionKey, entry: { label: "held" } },
      ]);

      await closeOpenClawAgentDatabaseByPathAsync(first.databasePath, first.scope.agentId);
      expect(page.isCurrent()).toBe(false);
      expect(page.readCurrent()[0]?.ok).toBe(false);
      expect(await listSessionEntriesReadOnlyAsync(first.scope)).toMatchObject([
        { sessionKey: first.scope.sessionKey, entry: { label: "0" } },
      ]);
      using refreshed = await readSessionListPageReadOnlyAsync([scopes[0]!], {
        membershipIdentityId: "viewer",
      });
      expect(refreshed.entries).toMatchObject([{ ok: true, value: { membershipKeys: [] } }]);
      expect(isOpenClawAgentDatabaseOpen(first.databasePath)).toBe(false);
      page[Symbol.dispose]();
      refreshed[Symbol.dispose]();
      await listSessionEntriesReadOnlyAsync(first.scope);
      expect(readers.live()).toHaveLength(64);
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      expect(readers.live()).toHaveLength(0);
    } finally {
      release.resolve();
      await Promise.allSettled([held]);
    }
  });
});

it("retains the prepared page's borrowed host until disposal and never reads its uncommitted rows", async () => {
  const readers = observeNativeReaders();
  await withOpenClawTestState({ label: "session-list-borrowed-page" }, async (state) => {
    const scope = {
      agentId: "borrowed-page",
      sessionKey: "agent:borrowed-page:entry",
      env: state.env,
    };
    replaceSessionEntrySync(scope, { sessionId: "borrowed-entry", updatedAt: 1 });
    addSessionMember(scope, { identityId: "viewer", addedBy: "owner" });
    const database = openOpenClawAgentDatabase(scope);
    using page = await readSessionListPageReadOnlyAsync(
      [{ ...scope, sessionKeys: [scope.sessionKey], projection: "list" }],
      { membershipIdentityId: "viewer" },
    );
    expect(page.entries).toMatchObject([
      { ok: true, value: { membershipKeys: [scope.sessionKey] } },
    ]);
    expect(page.isCurrent()).toBe(true);
    expect(readers.live().some(({ pathname }) => pathname === database.path)).toBe(false);
    for (let index = 0; index < 65; index++) {
      openOpenClawAgentDatabase({ agentId: `borrowed-churn-${index}`, env: state.env });
    }
    expect(database.db.isOpen).toBe(true);
    expect(page.isCurrent()).toBe(true);
    expect(page.readCurrent()).toMatchObject([
      { ok: true, value: { membershipKeys: [scope.sessionKey] } },
    ]);

    database.db.exec("BEGIN IMMEDIATE");
    try {
      database.db
        .prepare("DELETE FROM session_members WHERE session_key = ? AND identity_id = ?")
        .run(scope.sessionKey, "viewer");
      expect(page.isCurrent()).toBe(false);
      expect(page.readCurrent()[0]?.ok).toBe(false);
    } finally {
      database.db.exec("ROLLBACK");
    }
    expect(page.readCurrent()).toMatchObject([
      { ok: true, value: { membershipKeys: [scope.sessionKey] } },
    ]);
    page[Symbol.dispose]();
    expect(page.isCurrent()).toBe(false);
    expect(() => page.readCurrent()).toThrow("disposed");
    openOpenClawAgentDatabase({ agentId: "borrowed-after-disposal", env: state.env });
    expect(database.db.isOpen).toBe(false);
  });
});

it("observes disposal-time native close failures and retains them for joined lifecycle cleanup", async () => {
  const readers = observeNativeReaders();
  await withOpenClawTestState({ label: "session-list-idle-close-failure" }, async (state) => {
    const selected = await seedReaderStore(state, "selected");
    using page = await readSessionListPageReadOnlyAsync([
      { ...selected.scope, sessionKeys: [selected.scope.sessionKey] },
    ]);
    const stores: Array<Awaited<ReturnType<typeof seedReaderStore>>> = [];
    for (let index = 0; index < 64; index++) {
      const store = await seedReaderStore(state, String(index));
      stores.push(store);
      await listSessionEntriesReadOnlyAsync(store.scope);
    }
    expect(readers.live()).toHaveLength(65);
    const oldest = stores[0]!;
    const observer = readers.live().find(({ pathname }) => pathname === oldest.databasePath)!.db;
    const closeFailure = new Error("synthetic observer close failure");
    const nativeClose = vi.spyOn(observer, "close").mockImplementationOnce(() => {
      throw closeFailure;
    });

    expect(() => page[Symbol.dispose]()).not.toThrow();
    await expect(listSessionEntriesReadOnlyAsync(selected.scope)).rejects.toMatchObject({
      name: "AggregateError",
      errors: [closeFailure],
    });
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(observer.isOpen).toBe(true);
    await closeOpenClawAgentDatabaseByPathAsync(oldest.databasePath, oldest.scope.agentId);
    expect(nativeClose).toHaveBeenCalledTimes(2);
    expect(observer.isOpen).toBe(false);
    expect(await listSessionEntriesReadOnlyAsync(selected.scope)).toMatchObject([
      { sessionKey: selected.scope.sessionKey },
    ]);
    await closeOpenClawAgentDatabasesAsync(state.stateDir);
    expect(readers.live()).toHaveLength(0);
  });
});
