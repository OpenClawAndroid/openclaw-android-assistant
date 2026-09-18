import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sqlitePostCommit from "../infra/sqlite-post-commit.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { updateTask, upsertTaskDeliveryState } from "./task-registry-mutation.js";
import { createProjectionTransactionDatabase } from "./task-registry-projection.test-support.js";
import { deleteTaskRecordById, resetTaskRegistryForTests } from "./task-registry-query.js";
import { markTaskTerminalById } from "./task-registry-record-api.js";
import {
  emitTaskRegistryObserverEvent,
  ensureTaskRegistryReadyAsync,
  runTaskRegistryWorkerMutation,
  taskDeliveryStates,
  tasks,
  tasks as authoritativeTasks,
  withTaskRegistryMutation,
} from "./task-registry-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRegistryObserverEvent } from "./task-registry.store.types.js";
import type { TaskRecord } from "./task-registry.types.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests();
});

function eventKey(event: TaskRegistryObserverEvent): string {
  if (event.kind === "restored") {
    return "restored";
  }
  const record = event.kind === "upserted" ? event.task : event.previous;
  return `${event.kind}:${record.taskId}:${record.runId}`;
}

async function prepare(records: TaskRecord[]) {
  const store = createInMemoryTaskRegistryStore({
    tasks: new Map(records.map((record) => [record.taskId, record])),
    deliveryStates: new Map(),
  });
  configureTaskRegistryRuntime({ store });
  const context = captureOpenClawStateWorkerContext();
  await ensureTaskRegistryReadyAsync(context);
  const events: string[] = [];
  configureTaskRegistryRuntime({ observers: { onEvent: (event) => events.push(eventKey(event)) } });
  return { store, context, events };
}

describe("worker publication scope", () => {
  const task: TaskRecord = {
    taskId: "existing-task",
    runtime: "cli",
    requesterSessionKey: "agent:main:parent",
    ownerKey: "agent:main:parent",
    childSessionKey: "agent:main:child",
    runId: "original-run",
    scopeKind: "session",
    task: "Existing child",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 1,
  };

  it.each([
    { selection: "run", registration: "before claim" },
    { selection: "child", registration: "before claim" },
    { selection: "run", registration: "after claim" },
    { selection: "child", registration: "after claim" },
  ])(
    "carries prior absence to a $selection scope registered $registration",
    async ({ selection, registration }) => {
      const { store, context, events } = await prepare([]);
      configureTaskRegistryRuntime({
        observers: {
          onEvent(event) {
            if (event.kind === "upserted") {
              events.push(event.task.task);
            }
          },
        },
      });
      const firstRow = { ...task, task: "First version" };
      const secondRow = { ...task, task: "Second version" };
      const broad =
        selection === "run" ? { runId: task.runId } : { childSessionKey: task.childSessionKey };
      const firstWritten = createDeferred();
      const secondWritten = createDeferred();
      const firstAck = createDeferred();
      const secondAck = createDeferred();
      const firstReadStarted = createDeferred();
      const firstReadRelease = createDeferred();
      const first = runTaskRegistryWorkerMutation(
        {
          admission: context.admission,
          scope: { taskId: task.taskId, ...broad },
          publicationRecords: () => new Map([[task.taskId, firstRow]]),
        },
        async () => {
          store.upsertTaskWithDeliveryState({ task: firstRow });
          firstWritten.resolve();
          await firstAck.promise;
          return firstRow;
        },
        async () => {
          firstReadStarted.resolve();
          await firstReadRelease.promise;
          return store.loadSnapshot();
        },
      );
      await firstWritten.promise;
      if (registration === "after claim") {
        firstAck.resolve();
        await Promise.race([firstReadStarted.promise, first]);
      }
      const second = runTaskRegistryWorkerMutation(
        {
          admission: context.admission,
          scope: { taskId: "second-proposed-id", ...broad },
          publicationRecords: () => new Map([[task.taskId, secondRow]]),
        },
        async () => {
          store.upsertTaskWithDeliveryState({ task: secondRow });
          secondWritten.resolve();
          await secondAck.promise;
          return secondRow;
        },
        async () => store.loadSnapshot(),
      );
      try {
        await secondWritten.promise;
        firstAck.resolve();
        firstReadRelease.resolve();
        await expect(first).resolves.toEqual(firstRow);
        expect(tasks.get(task.taskId)?.task).toBe("Second version");
        expect(events).toEqual([]);
        secondAck.resolve();
        await expect(second).resolves.toEqual(secondRow);
        expect(events).toEqual(["Second version"]);
      } finally {
        firstAck.resolve();
        firstReadRelease.resolve();
        secondAck.resolve();
        await Promise.allSettled([first, second]);
      }
    },
  );

  it.each(["owner", "requester"] as const)(
    "does not publish a child related only through its %s session",
    async (relation) => {
      const parentSession = "agent:main:parent";
      const background = {
        ...task,
        ownerKey: relation === "owner" ? parentSession : "agent:main:other",
        requesterSessionKey: relation === "requester" ? parentSession : "agent:main:other",
      };
      const foreground = {
        ...task,
        taskId: "foreground-task",
        childSessionKey: parentSession,
        runId: "foreground-run",
      };
      const { store, context, events } = await prepare([background]);
      const scope = { taskId: foreground.taskId, childSessionKey: parentSession };

      await runTaskRegistryWorkerMutation(
        {
          admission: context.admission,
          scope,
          publicationRecords: () => new Map([[foreground.taskId, foreground]]),
        },
        async () => store.upsertTaskWithDeliveryState({ task: foreground }),
        () => store.loadMutationSnapshotAsync(context, scope),
      );

      expect(events).toEqual(["upserted:foreground-task:foreground-run"]);
      expect(tasks.get(background.taskId)).toEqual(background);
    },
  );

  it.each(["rebound", "rebound then deleted"] as const)(
    "publishes known run-scoped records exactly once when %s",
    async (change) => {
      const { store, context, events } = await prepare([task]);
      const scope = { taskId: "requested-task", runId: task.runId };
      let reads = 0;

      await runTaskRegistryWorkerMutation(
        {
          admission: context.admission,
          scope,
          publicationRecords: () => new Map([[task.taskId, { ...task, task: "Committed" }]]),
        },
        async () => {
          store.upsertTaskWithDeliveryState({ task: { ...task, task: "Committed" } });
        },
        async () => {
          const snapshot = await store.loadMutationSnapshotAsync(context, scope);
          if (reads++ === 0) {
            expect(updateTask(task.taskId, { runId: "replacement-run" })).not.toBeNull();
            if (change === "rebound then deleted") {
              expect(deleteTaskRecordById(task.taskId)).toBe(true);
            }
          }
          return snapshot;
        },
      );

      expect(events).toEqual(
        change === "rebound"
          ? ["upserted:existing-task:replacement-run"]
          : ["upserted:existing-task:replacement-run", "deleted:existing-task:replacement-run"],
      );
      expect(reads).toBe(1);
      expect(tasks.get(task.taskId)?.runId).toBe(
        change === "rebound" ? "replacement-run" : undefined,
      );
    },
  );
});

describe("worker publication during canonical reads", () => {
  it.each(["rollback", "activity", "delivery"] as const)(
    "retains committed task publication across %s during its canonical read",
    async (change) => {
      const task: TaskRecord = {
        taskId: "publication-task",
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: "Original",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
      };
      const { store, context } = await prepare([task]);
      const published: string[] = [];
      configureTaskRegistryRuntime({
        observers: {
          onEvent(event) {
            if (event.kind === "upserted") {
              published.push(event.task.task);
            }
          },
        },
      });
      let changed = false;
      const readCurrent = vi.fn(async () => {
        const snapshot = store.loadSnapshot();
        if (changed) {
          return snapshot;
        }
        changed = true;
        if (change === "activity") {
          emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task }));
        } else if (change === "delivery") {
          upsertTaskDeliveryState({ taskId: task.taskId, lastNotifiedEventAt: 42 });
        } else {
          const database = createProjectionTransactionDatabase();
          const lookup = vi
            .spyOn(openClawStateDatabaseCache, "getOpenClawStateDatabaseIfOpenAtPath")
            .mockReturnValue(database);
          const stage = vi
            .spyOn(sqlitePostCommit, "stageSqliteTransactionState")
            .mockImplementation((_db, publication) => {
              publication.stage();
              expect(authoritativeTasks.get(task.taskId)?.task).toBe("Committed");
              publication.rollback();
              expect(authoritativeTasks.get(task.taskId)?.task).toBe("Original");
              return true;
            });
          try {
            withTaskRegistryMutation(() => {});
            expect(stage).toHaveBeenCalledTimes(1);
          } finally {
            stage.mockRestore();
            lookup.mockRestore();
          }
        }
        return snapshot;
      });
      await expect(
        runTaskRegistryWorkerMutation(
          {
            admission: context.admission,
            scope: { taskId: task.taskId },
            publicationRecords: () => new Map([[task.taskId, { ...task, task: "Committed" }]]),
          },
          async () => {
            store.upsertTaskWithDeliveryState({ task: { ...task, task: "Committed" } });
            return "committed";
          },
          readCurrent,
        ),
      ).resolves.toBe("committed");

      expect(authoritativeTasks.get(task.taskId)?.task).toBe("Committed");
      expect(published).toEqual(change === "activity" ? ["Original", "Committed"] : ["Committed"]);
      expect(readCurrent).toHaveBeenCalledTimes(1);
      if (change === "delivery") {
        expect(taskDeliveryStates.get(task.taskId)?.lastNotifiedEventAt).toBe(42);
      }
    },
  );

  it.each(["value", "absent"] as const)(
    "does not publish a held task snapshot after %s ABA",
    async (change) => {
      const task: TaskRecord = {
        taskId: "aba-task",
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: "Original",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
      };
      const { store, context } = await prepare(change === "value" ? [task] : []);
      const published: string[] = [];
      configureTaskRegistryRuntime({
        observers: {
          onEvent(event) {
            if (event.kind === "upserted") {
              published.push(event.task.task);
            } else if (event.kind === "deleted") {
              published.push("deleted");
            }
          },
        },
      });
      let reads = 0;
      await expect(
        runTaskRegistryWorkerMutation(
          {
            admission: context.admission,
            scope: { taskId: task.taskId },
            publicationRecords: () => new Map([[task.taskId, { ...task, task: "Held snapshot" }]]),
          },
          async () => {
            store.upsertTaskWithDeliveryState({ task: { ...task, task: "Held snapshot" } });
            return "committed";
          },
          async () => {
            const snapshot = store.loadSnapshot();
            if (reads++ === 0) {
              if (change === "value") {
                expect(updateTask(task.taskId, { task: "Intermediate" })).not.toBeNull();
                expect(updateTask(task.taskId, { task: "Original" })).not.toBeNull();
              } else {
                // The ordinary delete refreshes the committed row before removing it.
                expect(deleteTaskRecordById(task.taskId)).toBe(true);
              }
            }
            return snapshot;
          },
        ),
      ).resolves.toBe("committed");

      expect(authoritativeTasks.get(task.taskId)?.task).toBe(
        change === "value" ? "Original" : undefined,
      );
      expect(published).toEqual(change === "value" ? ["Intermediate", "Original"] : ["deleted"]);
      expect(reads).toBe(1);
    },
  );

  it.each(["unrelated read", "same-task read"] as const)(
    "settles one committed mutation during %s churn without replaying publication effects",
    async (change) => {
      const task: TaskRecord = {
        taskId: "committed-task",
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: "Committed publication",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
      };
      const { store, context } = await prepare([task, { ...task, taskId: "unrelated-task" }]);
      const published: string[] = [];
      configureTaskRegistryRuntime({
        observers: {
          onEvent(event) {
            if (event.kind === "upserted" && event.task.taskId === task.taskId) {
              published.push(event.task.notifyPolicy);
            }
          },
        },
      });
      let changes = 0;
      const advance = () => {
        if (changes++ < 3) {
          markTaskTerminalById({
            taskId: change === "same-task read" ? task.taskId : "unrelated-task",
            status: "succeeded",
            endedAt: 10 + changes,
          });
        }
      };
      const mutate = vi.fn(async () => {
        store.upsertTaskWithDeliveryState({ task: { ...task, notifyPolicy: "state_changes" } });
        return "committed";
      });
      const readCurrent = vi.fn(async () => {
        const snapshot = store.loadSnapshot();
        advance();
        return snapshot;
      });

      await expect(
        runTaskRegistryWorkerMutation(
          {
            admission: context.admission,
            scope: { taskId: task.taskId },
            publicationRecords: () =>
              new Map([[task.taskId, { ...task, notifyPolicy: "state_changes" }]]),
          },
          mutate,
          readCurrent,
        ),
      ).resolves.toBe("committed");

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(readCurrent).toHaveBeenCalledTimes(1);
      expect(published).toEqual(["state_changes"]);
      expect(authoritativeTasks.get(task.taskId)).toMatchObject({
        notifyPolicy: "state_changes",
        status: change === "same-task read" ? "succeeded" : "running",
      });
    },
  );
});
