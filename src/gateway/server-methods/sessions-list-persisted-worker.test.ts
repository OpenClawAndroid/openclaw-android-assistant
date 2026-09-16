import fs from "node:fs";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import * as registryRead from "../../agents/subagents/registry/subagent-registry-read.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import {
  loadSubagentSessionListRunsFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

function run(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const now = Date.now();
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:controller",
    requesterAgentId: "main",
    requesterDisplayKey: "controller",
    task: "retained synthetic task",
    cleanup: "keep",
    createdAt: now - 100,
    execution: { status: "terminal", startedAt: now - 90, endedAt: now - 10 },
    completion: { required: false, resultText: "retained synthetic result" },
    delivery: { status: "not_required" },
    ...overrides,
  };
}
function readPersisted() {
  return runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext(),
    (worker) => worker.execute({ type: "subagents.sessionList", input: undefined }),
    { existingOnly: true },
  );
}

function pausePersistedRead(onDispatch?: () => void) {
  const dispatched = createDeferredCore();
  let resumeRead: (() => void) | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- apply below preserves the intercepted Worker receiver.
  const postMessage = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker["postMessage"]>
  ) {
    const message: unknown = args[0];
    if (isRecord(message) && message.type === "execute" && message.input instanceof Uint8Array) {
      const command: unknown = deserialize(message.input);
      if (isRecord(command) && command.type === "subagents.sessionList") {
        onDispatch?.();
        resumeRead = () => postMessage.apply(this, args);
        dispatched.resolve();
        return;
      }
    }
    return postMessage.apply(this, args);
  });
  return {
    dispatched: dispatched.promise,
    resume() {
      const dispatch = resumeRead;
      resumeRead = undefined;
      dispatch?.();
    },
  };
}

it.each(["replaced", "made private"])(
  "describes current session metadata after a worker read while the session is %s",
  async (change) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} } },
          gateway: {
            roles: {
              default: "reader",
              definitions: {
                reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
              },
            },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        const controller = "agent:main:controller";
        const ownerId = ensureProfileForEmail("owner@example.com").id;
        const viewerId = ensureProfileForEmail("viewer@example.com").id;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: controller },
          {
            sessionId: "original-session",
            updatedAt: Date.now(),
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: ownerId },
          },
        );
        const child = run("child", {
          requesterSessionKey: "agent:main:requester",
          controllerSessionKey: controller,
        });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: child.childSessionKey },
          { sessionId: "child-session", updatedAt: Date.now(), visibility: "shared" },
        );
        const collector = run("deleted", {
          collect: true,
          groupId: "retained-group",
          swarmRequesterSessionKey: controller,
          collectorCompletion: { status: "done" },
        });
        saveSubagentRegistryToSqlite(
          new Map([child, collector].map((entry) => [entry.runId, entry])),
        );
        clearSubagentRunsReadCacheForTest();
        const read = pausePersistedRead();
        const respond = vi.fn<RespondFn>();
        const request = sessionByKeyReadHandlers["sessions.describe"]!({
          req: { type: "req", id: "describe-worker", method: "sessions.describe" },
          params: { key: controller },
          client: identifiedClient(viewerId),
          context: requestContext(cfg),
          isWebchatConnect: () => false,
          respond,
        });
        try {
          expect(
            await Promise.race([
              read.dispatched.then(() => "worker"),
              Promise.resolve(request).then(() => "response"),
            ]),
          ).toBe("worker");
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: controller },
            change === "replaced"
              ? { sessionId: "replacement-session", label: "Current conversation" }
              : { visibility: "draft" },
          );
          read.resume();
          await request;
          expect(respond).toHaveBeenCalledTimes(1);
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          const result = respond.mock.calls[0]?.[1];
          if (change === "made private") {
            expect(result).toEqual({ session: null });
          } else {
            expect(result).toMatchObject({
              session: {
                sessionId: "replacement-session",
                displayName: "Current conversation",
                childSessions: [child.childSessionKey],
                swarm: { groups: [{ groupId: "retained-group", done: 1, failed: 0 }] },
              },
            });
            expect(JSON.stringify(result)).not.toContain("retained synthetic");
          }
        } finally {
          vi.restoreAllMocks();
          read.resume();
          await Promise.allSettled([request]);
          clearSubagentRunsReadCacheForTest();
        }
      },
    );
  },
);

it("lists off-page controller links and deleted-collector totals while a sibling worker write settles", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      clearSubagentRunsReadCacheForTest();
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const controller = "agent:main:controller";
      const requester = "agent:main:requester";
      const child = run("child", {
        requesterSessionKey: requester,
        controllerSessionKey: controller,
      });
      const collector = run("deleted", {
        collect: true,
        groupId: "retained-group",
        swarmRequesterSessionKey: controller,
        collectorCompletion: { status: "done" },
      });
      for (const [key, updatedAt, spawnedBy] of [
        [requester, 100, undefined],
        [child.childSessionKey, 200, requester],
        [controller, 300, undefined],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          { sessionId: key, updatedAt, visibility: "shared", spawnedBy },
        );
      }
      saveSubagentRegistryToSqlite(
        new Map([child, collector].map((entry) => [entry.runId, entry])),
      );
      expect(await readPersisted()).toEqual(loadSubagentSessionListRunsFromSqlite());
      const key = { pluginId: "session-list-proof", namespace: "mixed-progress", key: "written" };
      const [result, written] = await Promise.all([
        listSessions({
          client: identifiedClient("owner@example.com"),
          context: requestContext(cfg),
          request: { limit: 1 },
        }),
        runOpenClawStateWorkerOperation(captureOpenClawStateWorkerContext(), (worker) =>
          worker.execute({
            type: "pluginState.register",
            input: {
              ...key,
              valueJson: "true",
              maxEntries: 4,
              maxPluginEntries: 4,
              overflowPolicy: "reject-new",
            },
          }),
        ),
      ]);
      expect(written).toEqual({ ok: true, value: undefined });
      expect(result).toMatchObject({
        count: 1,
        totalCount: 3,
        nextOffset: 1,
        sessions: [
          {
            key: controller,
            childSessions: [child.childSessionKey],
            swarm: { groups: [{ groupId: "retained-group", done: 1, failed: 0 }] },
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("retained synthetic");
      const { createEmbeddedCallGateway } =
        await import("../../agents/tools/embedded-gateway-stub.js");
      const { EmbeddedTuiBackend } = await import("../../tui/embedded-backend.js");
      for (const list of [
        () => createEmbeddedCallGateway()({ method: "sessions.list", params: { limit: 1 } }),
        () => new EmbeddedTuiBackend().listSessions({ limit: 1 }),
      ]) {
        clearSubagentRunsReadCacheForTest();
        expect(await list()).toMatchObject({
          sessions: [
            {
              key: controller,
              childSessions: [child.childSessionKey],
              swarm: { groups: [{ groupId: "retained-group", done: 1 }] },
            },
          ],
        });
      }
      expect(
        await runOpenClawStateWorkerOperation(captureOpenClawStateWorkerContext(), (worker) =>
          worker.execute({ type: "pluginState.lookup", input: key }),
        ),
      ).toEqual({ ok: true, value: true });
      clearSubagentRunsReadCacheForTest();
    },
  );
});

it.each(["missing", "future schema", "malformed schema", "malformed payload"])(
  "keeps %s storage read-only",
  async (shape) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = captureOpenClawStateWorkerContext();
      if (shape === "missing") {
        expect(await readPersisted()).toBeUndefined();
        expect(fs.existsSync(context.admission.databasePath)).toBe(false);
        return;
      }
      const record = run("valid");
      saveSubagentRegistryToSqlite(new Map([[record.runId, record]]));
      const { db } = openOpenClawStateDatabase();
      if (shape === "future schema") {
        const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
        db.exec(`PRAGMA user_version = ${version + 1}`);
      } else if (shape === "malformed schema") {
        db.enableDefensive?.(false);
        db.exec("PRAGMA writable_schema = ON");
        db.prepare(
          "INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('index', 'malformed_fixture', 'subagent_runs', 0, 'CREATE INDEX malformed_fixture ON subagent_runs(missing_column)')",
        ).run();
        db.exec("PRAGMA writable_schema = RESET");
      } else {
        db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?").run(
          "{bad json",
          record.runId,
        );
      }
      await closeOpenClawStateDatabaseAsync();
      const before = fs.readFileSync(context.admission.databasePath);
      if (shape === "malformed payload") {
        expect(await readPersisted()).toEqual(new Map());
      } else {
        await expect(readPersisted()).rejects.toThrow();
      }
      await closeOpenClawStateDatabaseAsync();
      expect(fs.readFileSync(context.admission.databasePath)).toEqual(before);
    });
  },
);

it("keeps the shared native fill outside a retired initiating request scope", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const controller = "agent:main:controller";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: controller },
        { sessionId: "request-scope-parent", updatedAt: Date.now(), visibility: "shared" },
      );
      const collector = run("retained", {
        collect: true,
        groupId: "scope-retained-group",
        swarmRequesterSessionKey: controller,
        collectorCompletion: { status: "done" },
      });
      saveSubagentRegistryToSqlite(new Map([[collector.runId, collector]]));
      clearSubagentRunsReadCacheForTest();
      const firstScope = new AsyncWorkScope();
      const secondScope = new AsyncWorkScope();
      const joined = createDeferredCore();
      const dispatchSignals: Array<AbortSignal | undefined> = [];
      const read = pausePersistedRead(() => dispatchSignals.push(getAsyncWorkSignal()));
      const prepare = registryRead.prepareSubagentSessionListReadIndex;
      let callers = 0;
      vi.spyOn(registryRead, "prepareSubagentSessionListReadIndex").mockImplementation(
        (...args) => {
          const result = prepare(...args);
          if (++callers === 2) {
            joined.resolve();
          }
          return result;
        },
      );
      const context = requestContext(cfg);
      const first = firstScope.run(() =>
        listSessions({
          client: identifiedClient("first@example.com"),
          context,
          request: { limit: 1 },
        }),
      );
      const observedFirst = first.then(
        () => undefined,
        () => undefined,
      );
      let second: ReturnType<typeof listSessions> | undefined;
      try {
        await read.dispatched;
        second = secondScope.track(() =>
          listSessions({
            client: identifiedClient("second@example.com"),
            context,
            request: { limit: 1 },
          }),
        );
        await joined.promise;
        await firstScope.drain();
        expect(firstScope.signal.aborted).toBe(true);
        read.resume();
        expect(await second).toMatchObject({
          sessions: [
            { key: controller, swarm: { groups: [{ groupId: "scope-retained-group", done: 1 }] } },
          ],
        });
        expect(dispatchSignals).toEqual([undefined]);
      } finally {
        read.resume();
        await Promise.allSettled([observedFirst, second]);
        await firstScope.drain();
        await secondScope.drain();
        vi.restoreAllMocks();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
});
