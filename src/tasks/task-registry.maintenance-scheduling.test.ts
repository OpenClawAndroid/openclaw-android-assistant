import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  setTaskRegistryMaintenanceRuntimeForTests,
  startTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import { createPreparedMaintenanceRead } from "./task-registry.maintenance.test-support.js";
import { flushAsyncWork, withTaskRegistryTempDir } from "./task-registry.test-support.js";

beforeEach(() => {
  resetGatewayWorkAdmission();
});

afterEach(() => {
  stopTaskRegistryMaintenance();
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

describe("task-registry maintenance scheduling", () => {
  it("does not leak unhandled rejections when the scheduled maintenance sweep fails", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      setTaskRegistryMaintenanceRuntimeForTests({
        listAcpSessionEntries: async () => [],
        readAcpSessionEntry: () => ({
          cfg: {},
          storePath: "",
          sessionKey: "",
          storeSessionKey: "",
          entry: undefined,
          storeReadFailed: false,
        }),
        listSessionEntries: () => [],
        resolveStorePath: () => "",
        parseAgentSessionKey: () => null,
        isCronJobActive: () => false,
        getAgentRunContext: () => undefined,
        hasActiveAcpTurn: () => false,
        hasActiveTaskForChildSessionKey: () => false,
        deleteTaskRecordById: () => false,
        ensureTaskRegistryReady: () => {},
        getTaskById: () => undefined,
        getTaskRegistryMaintenanceTask: () => undefined,
        prepareTaskRegistryRead: async () => createPreparedMaintenanceRead(),
        getTaskRegistryMaintenanceSnapshot: () => {
          throw new Error("maintenance boom");
        },
        listTaskRecords: () => [],
        markTaskLostById: () => null,
        markTaskTerminalById: () => null,
        maybeDeliverTaskTerminalUpdate: async () => null,
        resolveTaskForLookupToken: () => undefined,
        setTaskCleanupAfterById: () => null,
        isRuntimeAuthoritative: () => true,
        listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: () => [],
      });

      try {
        startTaskRegistryMaintenance();
        await vi.advanceTimersByTimeAsync(5_000);
        await flushAsyncWork();
        expect(unhandled).toStrictEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    });
  });
});
