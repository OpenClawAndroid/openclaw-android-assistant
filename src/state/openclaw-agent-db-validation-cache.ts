import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isPathInside } from "../infra/path-guards.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";

export type OpenClawAgentDatabaseValidation = {
  agentId: string;
  identity: string;
  /** Shared with admitted workers so owner invalidation revokes borrowed proof. */
  valid: SharedArrayBuffer;
};
type ValidationDatabase = { db: DatabaseSync; path: string; agentId: string };

// Ordinary close and eviction retain proof for this Gateway lifetime. Only a
// successful canonical open can create it; workers borrow it under admission.
const validatedPaths = resolveGlobalSingleton<Map<string, OpenClawAgentDatabaseValidation>>(
  Symbol.for("openclaw.agentDatabaseValidatedPaths"),
  () => new Map(),
  () => clearOpenClawAgentDatabaseValidationCache(),
);

function matchesValidation(
  database: ValidationDatabase,
  validation: OpenClawAgentDatabaseValidation,
): boolean {
  return (
    validation.agentId === database.agentId &&
    validation.identity === readOpenClawAgentDatabaseIdentity(database).identity &&
    Atomics.load(new Int32Array(validation.valid), 0) === 1
  );
}

export function getOpenClawAgentDatabaseValidation(
  database: ValidationDatabase,
): OpenClawAgentDatabaseValidation | undefined {
  const validation = validatedPaths.get(path.resolve(database.path));
  return validation && matchesValidation(database, validation) ? validation : undefined;
}

export function adoptOpenClawAgentDatabaseValidation(
  database: ValidationDatabase,
  validation: OpenClawAgentDatabaseValidation,
): boolean {
  if (!matchesValidation(database, validation)) {
    return false;
  }
  // A concurrent first opener can return another healthy receipt. Keep the
  // owner's existing revocation cell shared by workers already borrowing it.
  if (getOpenClawAgentDatabaseValidation(database)) {
    return true;
  }
  invalidateOpenClawAgentDatabaseValidation(database.path);
  validatedPaths.set(path.resolve(database.path), validation);
  return true;
}

export function setOpenClawAgentDatabaseValidation(
  database: ValidationDatabase,
): OpenClawAgentDatabaseValidation {
  const { identity } = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity !== "string") {
    throw new Error("Only persistent agent databases retain integrity validation");
  }
  const validation = {
    agentId: database.agentId,
    identity,
    valid: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  };
  Atomics.store(new Int32Array(validation.valid), 0, 1);
  invalidateOpenClawAgentDatabaseValidation(database.path);
  validatedPaths.set(path.resolve(database.path), validation);
  return validation;
}

export function invalidateOpenClawAgentDatabaseValidation(pathname: string): void {
  const resolved = path.resolve(pathname);
  const validation = validatedPaths.get(resolved);
  if (validation) {
    Atomics.store(new Int32Array(validation.valid), 0, 0);
    validatedPaths.delete(resolved);
  }
}

export function invalidateOpenClawAgentDatabaseValidationsForAgent(agentId: string): void {
  for (const [pathname, validation] of validatedPaths) {
    if (validation.agentId === agentId) {
      invalidateOpenClawAgentDatabaseValidation(pathname);
    }
  }
}

export function clearOpenClawAgentDatabaseValidationCache(rootPath?: string): void {
  for (const pathname of validatedPaths.keys()) {
    if (rootPath === undefined || isPathInside(rootPath, pathname)) {
      invalidateOpenClawAgentDatabaseValidation(pathname);
    }
  }
}
