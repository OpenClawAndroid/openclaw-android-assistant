import { toUSVString } from "node:util";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SqliteSchemaHeader } from "./sqlite-schema-header.js";
import type { StateDatabaseCoordinatorRuntime } from "./state-database-coordinator.js";

// Keep the one-shot execFile output limit when inspections use IPC.
export const SQLITE_READONLY_WORKER_MAX_BUFFER = 1024 * 1024;

export type SqliteReadOnlyWorkerMode =
  | "sync"
  | "async"
  | "consolidated"
  | "schema-header"
  | "reclaim"
  | "auth-profile-rows";
export type SqliteReadOnlyWorkerResult =
  | { ok: true; location: string }
  | { ok: true; header: SqliteSchemaHeader }
  | { ok: true; warnings: string[] }
  | { ok: false; message: string };

export type SqliteAuthProfileRows = { store: unknown; state: unknown };
export type SqliteAuthProfileReadOptions = {
  mode: "auth-profile-rows";
  expectedIdentity: string;
  env: NodeJS.ProcessEnv;
  coordinatorRuntime: StateDatabaseCoordinatorRuntime;
  signal?: AbortSignal;
  stagingRoot?: never;
  agentSchemaVersionForOwnership?: never;
};
export type SqliteReadOnlyWorkerOptions =
  | SqliteAuthProfileReadOptions
  | {
      mode: Exclude<SqliteReadOnlyWorkerMode, "auth-profile-rows">;
      stagingRoot?: string;
      signal?: AbortSignal;
      agentSchemaVersionForOwnership?: number;
    };
export type SqliteReadOnlyWorkerOutput = { failure?: string; stderr: string; stdout: string };
export type SqliteReadOnlyWorkerValue =
  | string
  | SqliteSchemaHeader
  | string[]
  | SqliteAuthProfileRows;
export const SQLITE_READONLY_STDERR_TAIL_CHARS = 4_000;

function isAgentSchemaMeta(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 3 &&
      "agentId" in value &&
      (value.agentId === null || typeof value.agentId === "string") &&
      "role" in value &&
      (value.role === null || typeof value.role === "string") &&
      "schemaVersion" in value &&
      (value.schemaVersion === null || typeof value.schemaVersion === "number"))
  );
}

function isSqliteReadOnlyWorkerResult(value: unknown): value is SqliteReadOnlyWorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2 || !("ok" in value)) {
    return false;
  }
  if (value.ok === true && "header" in value) {
    const header = value.header;
    return (
      header !== null &&
      typeof header === "object" &&
      "userVersion" in header &&
      typeof header.userVersion === "number" &&
      Number.isInteger(header.userVersion) &&
      Object.keys(header).every(
        (key) => key === "userVersion" || key === "writerAppVersion" || key === "agentSchemaMeta",
      ) &&
      (!("writerAppVersion" in header) || typeof header.writerAppVersion === "string") &&
      (!("agentSchemaMeta" in header) || isAgentSchemaMeta(header.agentSchemaMeta))
    );
  }
  return (
    (value.ok === true && "location" in value && typeof value.location === "string") ||
    (value.ok === true &&
      "warnings" in value &&
      Array.isArray(value.warnings) &&
      value.warnings.every((warning) => typeof warning === "string")) ||
    (value.ok === false && "message" in value && typeof value.message === "string")
  );
}

export function createSqliteReadOnlyWorkerError(message: string, stderr: string): Error {
  // Node can split a decoded surrogate pair when its child stderr buffer overflows.
  const stderrTail = toUSVString(sliceUtf16Safe(stderr.trim(), -SQLITE_READONLY_STDERR_TAIL_CHARS));
  return new Error(
    `SQLite read-only worker ${message}${stderrTail ? `\nstderr (tail): ${stderrTail}` : ""}`,
  );
}

function parseSqliteReadOnlyWorkerResult(
  stdout: string,
  stderr: string,
): SqliteReadOnlyWorkerResult {
  if (!stdout.trim()) {
    throw createSqliteReadOnlyWorkerError("returned no JSON result", stderr);
  }
  let message: unknown;
  try {
    message = JSON.parse(stdout);
  } catch {
    throw createSqliteReadOnlyWorkerError("returned invalid JSON", stderr);
  }
  if (!isSqliteReadOnlyWorkerResult(message)) {
    throw createSqliteReadOnlyWorkerError("returned an invalid result", stderr);
  }
  return message;
}

export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: "schema-header",
): SqliteSchemaHeader;
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: "sync" | "async" | "consolidated",
): string;
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: "reclaim",
): string[];
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: SqliteReadOnlyWorkerMode,
): SqliteReadOnlyWorkerValue;
export function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: SqliteReadOnlyWorkerMode,
): SqliteReadOnlyWorkerValue {
  let result: SqliteReadOnlyWorkerResult;
  try {
    result = parseSqliteReadOnlyWorkerResult(params.stdout, params.stderr);
  } catch (error) {
    if (params.failure) {
      throw createSqliteReadOnlyWorkerError(params.failure, params.stderr);
    }
    throw error;
  }
  if (params.failure || !result.ok) {
    throw createSqliteReadOnlyWorkerError(
      !result.ok ? result.message : (params.failure ?? "failed"),
      params.stderr,
    );
  }
  if (mode === "schema-header" && "header" in result) {
    return result.header;
  }
  if ((mode === "sync" || mode === "async" || mode === "consolidated") && "location" in result) {
    return result.location;
  }
  if (mode === "reclaim" && "warnings" in result) {
    return result.warnings;
  }
  throw createSqliteReadOnlyWorkerError(
    "returned a result for a different operation",
    params.stderr,
  );
}
