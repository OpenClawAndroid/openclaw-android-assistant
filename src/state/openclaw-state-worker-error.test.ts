import { describe, expect, it, vi } from "vitest";
import { SqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { decodeSqliteWorkerReplyError } from "../infra/sqlite-worker-broker-reply.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../infra/startup-maintenance-required.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  OpenClawStateExternalOwnershipError,
  OpenClawStateOwnershipError,
  OpenClawStateOwnershipMetadataError,
} from "./openclaw-state-ownership.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

function roundTrip(error: Error): Error {
  const payload = encodeOpenClawStateWorkerError(error);
  if (!payload) {
    throw new Error("expected a canonical shared-state error payload");
  }
  const retained = new Error("remote error");
  retainOpenClawStateWorkerErrorPayload(retained, structuredClone(payload));
  const decoded = hydrateOpenClawStateWorkerError(retained);
  if (decoded === retained) {
    throw new Error("expected a decoded shared-state error");
  }
  return decoded;
}

describe("shared-state worker error transport", () => {
  it("uses the validated wire root when retaining an unopened error graph", () => {
    const retained = new Error("remote aggregate");
    retainOpenClawStateWorkerErrorPayload(retained, {
      version: 1,
      root: 1,
      nodes: [
        { type: "newer-schema", name: "SqliteSchemaVersionError", message: "newer" },
        { type: "aggregate", name: "AggregateError", message: "wrapper", errors: [{ ref: 0 }] },
      ],
    });
    const hydrated = hydrateOpenClawStateWorkerError(retained);
    expect(hydrated).toBeInstanceOf(AggregateError);
    expect(findStartupMaintenanceRequiredError(hydrated)).toBeInstanceOf(SqliteSchemaVersionError);
  });

  it("keeps outcome-unknown explicit instead of hydrating a maintenance payload", () => {
    const payload = encodeOpenClawStateWorkerError(new SqliteSchemaVersionError("newer schema"));
    if (!payload) {
      throw new Error("Expected canonical payload");
    }
    const failure = decodeSqliteWorkerReplyError(
      {
        request: {
          type: "execute",
          id: 1,
          actor: 1,
          input: new Uint8Array(),
          stateContext: {
            environment: { OPENCLAW_STATE_DIR: "/fixture" },
            coordinatorRuntime: { directory: "/fixture/coordinator", keepAlive: false },
          },
        },
        bytes: 0,
        resolve: () => undefined,
        reject: () => undefined,
        detach: () => undefined,
      },
      {
        name: "SqliteWorkerError",
        message: "write outcome unknown",
        code: "outcome-unknown",
        sharedState: payload,
      },
    );
    expect(hydrateOpenClawStateWorkerError(failure)).toBe(failure);
    expect(failure).toMatchObject({ code: "outcome-unknown" });
    expect(findStartupMaintenanceRequiredError(failure)).toBeUndefined();
  });

  it("hydrates a cached rejection independently for each caller without rewriting its graph", async () => {
    const payload = encodeOpenClawStateWorkerError(new SqliteSchemaVersionError("newer schema"));
    if (!payload) {
      throw new Error("Expected canonical payload");
    }
    const remote = new Error("remote failure");
    retainOpenClawStateWorkerErrorPayload(remote, payload);
    expect(Object.keys(remote)).toEqual([]);
    expect(JSON.stringify(remote)).toBe("{}");
    const untouched = new Error("local cleanup");
    const original = new AggregateError([remote, remote, untouched], "open and cleanup failed", {
      cause: remote,
    });
    original.errors.push(original);
    const first = hydrateOpenClawStateWorkerError(original);
    vi.resetModules();
    const [codec, errors] = await Promise.all([
      import("./openclaw-state-worker-error.js"),
      import("../infra/startup-maintenance-required.js"),
    ]);
    const second = codec.hydrateOpenClawStateWorkerError(original);
    if (!(first instanceof AggregateError) || !(second instanceof AggregateError)) {
      throw new Error("Expected hydrated aggregate wrappers");
    }
    expect(first).not.toBe(second);
    expect(first.errors[0]).not.toBe(second.errors[0]);
    expect(first.errors[0]).toBeInstanceOf(StartupMaintenanceRequiredError);
    expect(second.errors[0]).toBeInstanceOf(errors.StartupMaintenanceRequiredError);
    for (const result of [first, second]) {
      expect(result.cause).toBe(result.errors[0]);
      expect(result.errors[1]).toBe(result.errors[0]);
      expect(result.errors[2]).toBe(untouched);
      expect(result.errors[3]).toBe(result);
    }
    expect(original.cause).toBe(remote);
    expect(original.errors).toEqual([remote, remote, untouched, original]);
  });

  it("retains aliases inside materialized wire graphs without merging distinct caller graphs", async () => {
    const refusal = new SqliteSchemaVersionError("newer schema");
    const original = new AggregateError([refusal, refusal], "wire graph", { cause: refusal });
    refusal.cause = original;
    const payload = encodeOpenClawStateWorkerError(original);
    if (!payload) {
      throw new Error("Expected canonical wire graph");
    }
    const retained = new Error("remote error");
    retainOpenClawStateWorkerErrorPayload(retained, payload);
    const first = hydrateOpenClawStateWorkerError(retained);
    const second = hydrateOpenClawStateWorkerError(retained);
    const combined = new AggregateError([first, second], "separate calls");
    vi.resetModules();
    const [codec, errors] = await Promise.all([
      import("./openclaw-state-worker-error.js"),
      import("../infra/startup-maintenance-required.js"),
    ]);
    const result = codec.hydrateOpenClawStateWorkerError(combined);
    if (!(result instanceof AggregateError)) {
      throw new Error("Expected aggregate wrapper");
    }
    expect(result.errors[0]).not.toBe(result.errors[1]);
    for (const graph of result.errors) {
      if (!(graph instanceof AggregateError)) {
        throw new Error("Expected materialized wire graph");
      }
      expect(graph.cause).toBe(graph.errors[0]);
      expect(graph.errors[0]).toBe(graph.errors[1]);
      expect(graph.errors[0]).toBeInstanceOf(errors.StartupMaintenanceRequiredError);
      const cause: unknown = graph.errors[0];
      if (!(cause instanceof Error)) {
        throw new Error("Expected hydrated cause");
      }
      expect(cause.cause).toBe(graph);
    }
    expect(combined.errors).toEqual([first, second]);
  });

  it("leaves ordinary and already-current error graphs identical", () => {
    const local = new Error("caller rejected");
    const ordinary = new AggregateError([local], "caller and cleanup", { cause: local });
    local.cause = ordinary;
    expect(hydrateOpenClawStateWorkerError(ordinary)).toBe(ordinary);
    const current = roundTrip(new SqliteSchemaVersionError("current caller"));
    const wrapped = new AggregateError([current], "current graph", { cause: current });
    expect(hydrateOpenClawStateWorkerError(wrapped)).toBe(wrapped);
    expect(hydrateOpenClawStateWorkerError("caller rejection")).toBe("caller rejection");
  });

  it.each([
    {
      error: new OpenClawStateOwnershipError("owner refused"),
      constructor: OpenClawStateOwnershipError,
      fields: {},
    },
    {
      error: new OpenClawStateOwnershipMetadataError("/fixture/state.sqlite", "invalid metadata"),
      constructor: OpenClawStateOwnershipMetadataError,
      fields: { databasePath: "/fixture/state.sqlite" },
    },
    {
      error: new OpenClawStateExternalOwnershipError("/fixture/state.sqlite", "fixture-manager"),
      constructor: OpenClawStateExternalOwnershipError,
      fields: { databasePath: "/fixture/state.sqlite", managerId: "fixture-manager" },
    },
  ])("preserves ownership classification for $error.name", ({ error, constructor, fields }) => {
    const decoded = roundTrip(error);
    expect(decoded).toBeInstanceOf(constructor);
    expect(decoded).toBeInstanceOf(OpenClawStateOwnershipError);
    expect(decoded).toMatchObject({ ...fields, name: error.name, message: error.message });
  });

  it.each([
    {
      error: new StartupMaintenanceRequiredError("legacy-session-store", "session migration"),
      constructor: StartupMaintenanceRequiredError,
      fields: { kind: "legacy-session-store", reason: "session store migration" },
    },
    {
      error: new SqliteSchemaVersionError("newer schema"),
      constructor: SqliteSchemaVersionError,
      fields: { kind: "newer-schema", reason: "a newer OpenClaw build" },
    },
    {
      error: new OpenClawStateDatabaseSchemaMigrationRequiredError(
        "audit-events-v2",
        "/fixture/state.sqlite",
      ),
      constructor: OpenClawStateDatabaseSchemaMigrationRequiredError,
      fields: {
        kind: "audit-events-v2",
        pathname: "/fixture/state.sqlite",
        reason: "state database schema migration",
      },
    },
    {
      error: new OpenClawAgentDatabaseMediaMigrationRequiredError("/fixture/agent.sqlite", 11),
      constructor: OpenClawAgentDatabaseMediaMigrationRequiredError,
      fields: {
        kind: "agent-media",
        pathname: "/fixture/agent.sqlite",
        schemaVersion: 11,
        reason: "offline media migration",
      },
    },
  ])("preserves maintenance classification for $error.name", ({ error, constructor, fields }) => {
    const decoded = roundTrip(error);
    expect(decoded).toBeInstanceOf(constructor);
    expect(findStartupMaintenanceRequiredError(decoded)).toBe(decoded);
    expect(decoded).toMatchObject({
      ...fields,
      code: "gateway.maintenance_required",
      name: error.name,
      message: error.message,
    });
  });

  it("preserves shared causes, cycles, and newer-schema precedence through aggregate wrappers", () => {
    const repair = new OpenClawStateDatabaseSchemaMigrationRequiredError(
      "audit-events-v2",
      "/fixture/state.sqlite",
    );
    const newer = new SqliteSchemaVersionError("a newer schema wins");
    const wrapper = Object.assign(new Error("operation failed", { cause: repair }), {
      code: "EWRAPPED",
    });
    const root = new AggregateError([wrapper, repair, newer], "operation and cleanup failed", {
      cause: wrapper,
    });
    repair.cause = root;

    const decoded = roundTrip(root);
    expect(decoded).toBeInstanceOf(AggregateError);
    if (!(decoded instanceof AggregateError)) {
      throw new Error("expected aggregate wrapper");
    }
    expect(decoded.cause).toBe(decoded.errors[0]);
    const restoredWrapper: unknown = decoded.errors[0];
    const restoredRepair: unknown = decoded.errors[1];
    if (!(restoredWrapper instanceof Error) || !(restoredRepair instanceof Error)) {
      throw new Error("expected restored error causes");
    }
    expect(restoredWrapper).toMatchObject({ code: "EWRAPPED" });
    expect(restoredWrapper.cause).toBe(restoredRepair);
    expect(restoredRepair.cause).toBe(decoded);
    expect(findStartupMaintenanceRequiredError(decoded)).toBe(decoded.errors[2]);
    expect(findStartupMaintenanceRequiredError(decoded)?.kind).toBe("newer-schema");
  });

  it("keeps scalar causes without reviving arbitrary classes or serializing object fields", () => {
    class CustomError extends Error {}
    const custom = Object.assign(new CustomError("custom wrapper", { cause: "detail" }), {
      name: "CustomError",
      code: 17,
      privateState: { token: "fixture-not-for-transport" },
    });
    const original = new AggregateError(
      [
        new OpenClawStateOwnershipError("canonical refusal"),
        custom,
        "plain failure",
        2,
        true,
        null,
        undefined,
        { token: "fixture-not-for-transport" },
      ],
      "multiple errors",
    );
    const payload = encodeOpenClawStateWorkerError(original);
    expect(JSON.stringify(payload)).not.toContain("fixture-not-for-transport");
    expect(payload?.nodes.every((node) => !("stack" in node))).toBe(true);
    const decoded = roundTrip(original);
    if (!(decoded instanceof AggregateError)) {
      throw new Error("expected aggregate wrapper");
    }
    expect(decoded.errors[1]).toBeInstanceOf(Error);
    expect(decoded.errors[1]).not.toBeInstanceOf(CustomError);
    expect(decoded.errors[1]).toMatchObject({ name: "CustomError", code: 17, cause: "detail" });
    expect(decoded.errors.slice(2)).toEqual(["plain failure", 2, true, null, undefined, undefined]);
  });

  it("leaves unrelated errors and name-only imitations on the ordinary transport", () => {
    const imitation = Object.assign(new Error("imitation"), { name: "SqliteSchemaVersionError" });
    for (const error of [
      new Error("ordinary"),
      imitation,
      new AggregateError([imitation], "ordinary aggregate"),
      { cause: new OpenClawStateOwnershipError("nested object") },
    ]) {
      expect(encodeOpenClawStateWorkerError(error)).toBeUndefined();
    }
  });

  const validNode = {
    type: "maintenance",
    kind: "audit-events-v2",
    name: "StartupMaintenanceRequiredError",
    message: "migration required",
  };
  it.each([
    undefined,
    { version: 2, root: 0, nodes: [validNode] },
    { version: 1, root: 1, nodes: [validNode] },
    { version: 1, root: 0, nodes: [] },
    { version: 1, root: 0, nodes: [{ ...validNode, type: "CustomError" }] },
    { version: 1, root: 0, nodes: [{ ...validNode, kind: "unknown-migration" }] },
    { version: 1, root: 0, nodes: [{ ...validNode, cause: { ref: 1 } }] },
    { version: 1, root: 0, nodes: [{ ...validNode, cause: { value: {} } }] },
    { version: 1, root: 0, nodes: [{ ...validNode, code: {} }] },
    { version: 1, root: 0, nodes: [{ ...validNode, stack: "not transported" }] },
    {
      version: 1,
      root: 0,
      nodes: [{ type: "aggregate", name: "AggregateError", message: "missing edges" }],
    },
    {
      version: 1,
      root: 0,
      nodes: [{ type: "error", name: "Error", message: "unrelated" }, validNode],
    },
    {
      version: 1,
      root: 0,
      nodes: [
        {
          type: "agent-media-migration",
          name: "Error",
          message: "invalid version",
          pathname: "/fixture/agent.sqlite",
          schemaVersion: -1,
        },
      ],
    },
  ])("rejects malformed or noncanonical payload %#", (payload) => {
    const retained = new Error("ordinary transport failure");
    retainOpenClawStateWorkerErrorPayload(retained, payload);
    expect(hydrateOpenClawStateWorkerError(retained)).toBe(retained);
  });
});
