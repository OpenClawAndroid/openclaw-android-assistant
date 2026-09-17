import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as sqliteRuntime from "../../infra/node-sqlite.js";
import * as sqliteWorkerStore from "../../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resolveInternalSessionEffectsIdentity } from "./internal-session-key.js";
import {
  listSessionEntriesReadOnly,
  loadExactSessionEntryReadOnly,
  recordSessionParticipant,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { captureSessionEntryRead } from "./session-accessor.sqlite-entry-read-lifetime.js";
import {
  listSessionEntriesReadOnlyAsync,
  readSessionListPageReadOnlyAsync,
} from "./session-accessor.sqlite-list-read.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.js";

afterEach(() => vi.restoreAllMocks());

function fixture(state: OpenClawTestState) {
  const scope = { agentId: "main", env: state.env, projection: "list" as const };
  const keys = ["agent:main:alpha", "agent:main:beta"] as const;
  for (const [index, sessionKey] of keys.entries()) {
    replaceSessionEntrySync(
      { ...scope, sessionKey },
      {
        sessionId: sessionKey,
        updatedAt: index + 1,
        label: sessionKey,
        skillsSnapshot: { prompt: "synthetic saved instructions", skills: [] },
      },
    );
    recordSessionParticipant(
      { ...scope, sessionKey },
      { identity: { type: "profile", id: `person-${index}` }, promptedAt: 1 },
    );
  }
  return { scope, keys, database: openOpenClawAgentDatabase(scope) };
}

function holdNextBrokerResult() {
  const delivered = createDeferredCore();
  const release = createDeferredCore();
  const runOperation = sqliteWorkerStore.runSqliteWorkerStoreOperation;
  const work = vi
    .spyOn(sqliteWorkerStore, "runSqliteWorkerStoreOperation")
    .mockImplementationOnce(async (...args) => {
      const result = await runOperation(...args);
      delivered.resolve();
      await release.promise;
      return result;
    });
  return { delivered: delivered.promise, release: () => release.resolve(), work };
}

it("retains cold read-only inventory across requests without opening a host writer", async () => {
  await withOpenClawTestState({ label: "async-list-cold-observer" }, async (state) => {
    const { scope, keys, database } = fixture(state);
    await closeOpenClawAgentDatabaseByPathAsync(database.path, scope.agentId);
    const opening = vi.spyOn(sqliteWorkerStore, "openSqliteWorkerStore");
    const hostOpens = vi.spyOn(sqliteRuntime, "openNodeSqliteDatabase");
    const work = vi.spyOn(sqliteWorkerStore, "runSqliteWorkerStoreOperation");
    expect(isOpenClawAgentDatabaseOpen(database.path)).toBe(false);
    const first = await listSessionEntriesReadOnlyAsync({ ...scope, clone: false });
    expect(first.map(({ sessionKey }) => sessionKey)).toEqual(keys);
    for (let index = 0; index < 2; index++) {
      const next = await listSessionEntriesReadOnlyAsync({ ...scope, clone: false });
      expect(next[0]!.entry).toBe(first[0]!.entry);
      expect(next[1]!.entry).toBe(first[1]!.entry);
      expect(isOpenClawAgentDatabaseOpen(database.path)).toBe(false);
    }
    expect(opening).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
    expect(
      hostOpens.mock.calls
        .filter(([pathname]) => pathname === database.path)
        .every(([, options]) => options?.readOnly === true),
    ).toBe(true);
  });
});

it.each(["tracked write", "external same-value commit"] as const)(
  "keeps a later inventory cohort separate after a %s",
  async (mutation) => {
    await withOpenClawTestState({ label: "async-list-cohort" }, async (state) => {
      const { scope, keys, database } = fixture(state);
      const gate = holdNextBrokerResult();
      const first = listSessionEntriesReadOnlyAsync({ ...scope, clone: false });
      let later: ReturnType<typeof listSessionEntriesReadOnlyAsync> | undefined;
      let external: DatabaseSync | undefined;
      try {
        await Promise.race([gate.delivered, first]);
        expect(gate.work).toHaveBeenCalledTimes(1);
        if (mutation === "tracked write") {
          replaceSessionEntrySync(
            { ...scope, sessionKey: keys[0] },
            { sessionId: keys[0], updatedAt: 1, label: "new cohort" },
          );
        } else {
          external = new DatabaseSync(database.path);
          external
            .prepare("UPDATE session_nodes SET entry_json = entry_json WHERE session_key = ?")
            .run(keys[0]);
        }
        later = listSessionEntriesReadOnlyAsync({ ...scope, clone: false });
        void later.catch(() => {});
        await vi.waitFor(() => expect(gate.work).toHaveBeenCalledTimes(2));
        const current = await later;
        expect(current[0]!.entry.label).toBe(mutation === "tracked write" ? "new cohort" : keys[0]);
        gate.release();
        const detached = await first;
        expect(detached[0]!.entry.label).toBe(keys[0]);
        expect(detached[0]!.entry).not.toBe(current[0]!.entry);
        const warm = await listSessionEntriesReadOnlyAsync({ ...scope, clone: false });
        expect(warm[0]!.entry).toBe(current[0]!.entry);
        expect(gate.work).toHaveBeenCalledTimes(2);
      } finally {
        gate.release();
        await Promise.allSettled([first, ...(later ? [later] : [])]);
        external?.close();
      }
    });
  },
);

it("keeps retained entry reads independent of async inventory caching", async () => {
  await withOpenClawTestState({ label: "async-list-selected-hold" }, async (state) => {
    const { scope, keys, database } = fixture(state);
    const held = captureSessionEntryRead(database, keys[0]);
    const work = vi.spyOn(sqliteWorkerStore, "runSqliteWorkerStoreOperation");
    try {
      expect(held.isCurrent()).toBe(true);
      const inventory = await listSessionEntriesReadOnlyAsync({ ...scope, clone: false });
      expect(inventory.map(({ sessionKey }) => sessionKey)).toEqual(keys);
      expect(work).toHaveBeenCalledTimes(1);
      expect(held.isCurrent()).toBe(true);
      held.release();
      expect(held.isCurrent()).toBe(false);
      const warm = await listSessionEntriesReadOnlyAsync({ ...scope, clone: false });
      expect(warm[0]!.entry).toBe(inventory[0]!.entry);
      expect(warm[1]!.entry).toBe(inventory[1]!.entry);
      expect(work).toHaveBeenCalledTimes(1);
    } finally {
      held.release();
    }
  });
});

it("rejects delivered inventory after resource revocation and reopens for a later reader", async () => {
  await withOpenClawTestState({ label: "async-list-revoked-result" }, async (state) => {
    const { scope, keys, database } = fixture(state);
    await closeOpenClawAgentDatabaseByPathAsync(database.path, scope.agentId);
    const opening = vi.spyOn(sqliteWorkerStore, "openSqliteWorkerStore");
    const gate = holdNextBrokerResult();
    const first = listSessionEntriesReadOnlyAsync(scope);
    let closing: Promise<boolean> | undefined;
    try {
      await Promise.race([gate.delivered, first]);
      expect(gate.work).toHaveBeenCalledTimes(1);
      const rejected = expect(first).rejects.toThrow();
      closing = closeOpenClawAgentDatabaseByPathAsync(database.path, scope.agentId);
      gate.release();
      await rejected;
      await closing;
      expect(
        (await listSessionEntriesReadOnlyAsync(scope)).map(({ sessionKey }) => sessionKey),
      ).toEqual(keys);
      expect(opening).toHaveBeenCalledTimes(2);
      expect(isOpenClawAgentDatabaseOpen(database.path)).toBe(false);
    } finally {
      gate.release();
      await Promise.allSettled([first, ...(closing ? [closing] : [])]);
    }
  });
});

it("returns cold inventory through the worker and reuses current metadata without sharing clones", async () => {
  await withOpenClawTestState({ label: "async-list-inventory" }, async (state) => {
    const { scope, keys } = fixture(state);
    const hidden = resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "hidden" });
    replaceSessionEntrySync(
      { ...scope, sessionKey: hidden.sessionKey },
      { sessionId: hidden.sessionId, updatedAt: 1 },
    );
    const work = vi.spyOn(sqliteWorkerStore, "runSqliteWorkerStoreOperation");
    const first = await listSessionEntriesReadOnlyAsync({ ...scope, clone: false });
    expect(work).toHaveBeenCalled();
    expect(first.map(({ sessionKey }) => sessionKey)).toEqual(keys);
    expect(first.every(({ entry }) => entry.skillsSnapshot === undefined)).toBe(true);

    work.mockClear();
    const warm = await listSessionEntriesReadOnlyAsync({ ...scope, clone: false });
    expect(warm[0]!.entry).toBe(first[0]!.entry);
    const cloned = await listSessionEntriesReadOnlyAsync(scope);
    cloned[0]!.entry.participants![0]!.identity = { type: "profile", id: "caller-mutation" };
    expect((await listSessionEntriesReadOnlyAsync(scope))[0]!.entry.participants).toEqual([
      { identity: { type: "profile", id: "person-0" } },
    ]);
    expect(work).not.toHaveBeenCalled();
    expect(first).toEqual(listSessionEntriesReadOnly(scope));
  });
});

it("invalidates warm inventory for external same-value commits and same-timestamp raw edits", async () => {
  await withOpenClawTestState({ label: "async-list-external" }, async (state) => {
    const { scope, keys, database } = fixture(state);
    const before = await listSessionEntriesReadOnlyAsync(scope);
    const external = new DatabaseSync(database.path);
    const work = vi.spyOn(sqliteWorkerStore, "runSqliteWorkerStoreOperation");
    try {
      external
        .prepare("UPDATE session_nodes SET entry_json = entry_json WHERE session_key = ?")
        .run(keys[0]);
      expect(await listSessionEntriesReadOnlyAsync(scope)).toEqual(before);
      expect(work).toHaveBeenCalled();
      work.mockClear();

      external
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify({ sessionId: keys[0], updatedAt: 1, label: "edited" }), keys[0]);
      external
        .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
        .run("new-person", keys[0]);
      expect(await listSessionEntriesReadOnlyAsync(scope)).toMatchObject([
        {
          sessionKey: keys[0],
          entry: {
            label: "edited",
            updatedAt: 1,
            participants: [{ identity: { type: "profile", id: "new-person" } }],
          },
        },
        { sessionKey: keys[1], entry: { label: keys[1] } },
      ]);
      expect(work).toHaveBeenCalled();
    } finally {
      external.close();
    }
  });
});

it("preserves selected order and tail-chunk membership after inventory projection", async () => {
  await withOpenClawTestState({ label: "async-list-selected" }, async (state) => {
    const { scope, keys } = fixture(state);
    const member = { identityId: "viewer", addedBy: "owner", addedAt: 1 };
    addSessionMember({ ...scope, sessionKey: keys[1] }, member);
    // Put the real member beyond the first membership-query chunk.
    const requests = [
      ...Array.from({ length: 450 }, (_, index) => `agent:main:missing-${index}`),
      keys[1],
      keys[0],
      keys[1],
    ];
    const read = (sessionKeys: readonly string[] = requests) =>
      readSessionListPageReadOnlyAsync([{ ...scope, sessionKeys }], {
        membershipIdentityId: " viewer ",
      });
    const work = vi.spyOn(sqliteWorkerStore, "runSqliteWorkerStoreOperation");
    using firstPage = await read();
    const first = firstPage.entries;
    expect(work).toHaveBeenCalled();
    expect(first).toMatchObject([
      {
        ok: true,
        value: {
          entries: [keys[1], keys[0], keys[1]].map((sessionKey) => ({
            sessionKey,
            entry: { sessionId: sessionKey },
          })),
          membershipKeys: [keys[1], keys[1]],
        },
      },
    ]);
    if (!first[0]?.ok) {
      throw new Error("Expected selected session metadata");
    }
    expect(first[0].value.entries.every(({ entry }) => entry.skillsSnapshot === undefined)).toBe(
      true,
    );
    await listSessionEntriesReadOnlyAsync(scope);
    removeSessionMember({ ...scope, sessionKey: keys[1] }, member.identityId);
    addSessionMember({ ...scope, sessionKey: keys[0] }, member);
    replaceSessionEntrySync(
      { ...scope, sessionKey: keys[0] },
      { sessionId: keys[0], updatedAt: 1, label: "revised" },
    );
    work.mockClear();
    using updatedPage = await read(keys);
    expect(updatedPage.entries).toMatchObject([
      {
        ok: true,
        value: {
          entries: [{ entry: { label: "revised" } }, { entry: { label: keys[1] } }],
          membershipKeys: [keys[0]],
        },
      },
    ]);
    expect(work).not.toHaveBeenCalled();
  });
});

it.each(["canonical identity", "native conversion"] as const)(
  "preserves per-key %s errors across the worker without suppressing healthy requests",
  async (corruption) => {
    await withOpenClawTestState({ label: "async-list-errors" }, async (state) => {
      const { scope, keys, database } = fixture(state);
      await listSessionEntriesReadOnlyAsync(scope);
      const external = new DatabaseSync(database.path);
      try {
        if (corruption === "canonical identity") {
          external
            .prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
            .run("different-session", keys[1]);
        } else {
          external
            .prepare("UPDATE session_participants SET contribution_count = ? WHERE session_key = ?")
            .run(9007199254740993n, keys[1]);
        }
        const work = vi.spyOn(sqliteWorkerStore, "runSqliteWorkerStoreOperation");
        using page = await readSessionListPageReadOnlyAsync(
          [[keys[0]], [keys[1]], ["agent:main:missing"], [keys[0], keys[1]]].map((sessionKeys) => ({
            agentId: scope.agentId,
            env: scope.env,
            projection: scope.projection,
            sessionKeys,
          })),
        );
        expect(work).toHaveBeenCalled();
        let originalError: unknown;
        try {
          loadExactSessionEntryReadOnly({ ...scope, sessionKey: keys[1] });
        } catch (error) {
          originalError = error;
        }
        if (!(originalError instanceof Error)) {
          throw new Error("Expected the exact synchronous read to reject the damaged row");
        }
        const expectedError = {
          name: originalError.name,
          message: originalError.message,
          code:
            corruption === "canonical identity"
              ? "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED"
              : "ERR_OUT_OF_RANGE",
        };
        expect(page.entries).toMatchObject([
          { ok: true, value: { entries: [{ sessionKey: keys[0] }], membershipKeys: [] } },
          { ok: false, error: expectedError },
          { ok: true, value: { entries: [], membershipKeys: [] } },
          { ok: false, error: expectedError },
        ]);
      } finally {
        external.close();
      }
    });
  },
);

it("reads process-held incognito metadata without creating a durable worker store", async () => {
  await withOpenClawTestState({ label: "async-list-incognito" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionKey: "agent:main:dashboard:incognito-metadata",
      projection: "list" as const,
    };
    const storePath = resolveIncognitoOpenClawAgentSqlitePath(scope);
    replaceSessionEntrySync(scope, { sessionId: "private", updatedAt: 1, label: "Private" });
    const opening = vi.spyOn(sqliteWorkerStore, "openSqliteWorkerStore");
    expect(await listSessionEntriesReadOnlyAsync({ ...scope, storePath })).toMatchObject([
      { sessionKey: scope.sessionKey, entry: { sessionId: "private", label: "Private" } },
    ]);
    using page = await readSessionListPageReadOnlyAsync([
      { ...scope, sessionKeys: [scope.sessionKey] },
    ]);
    expect(page.entries).toMatchObject([
      { ok: true, value: { entries: [{ entry: { sessionId: "private" } }], membershipKeys: [] } },
    ]);
    expect(opening).not.toHaveBeenCalled();
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
