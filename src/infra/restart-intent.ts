import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
// Persists short-lived gateway restart intent for supervisor SIGTERM handoff.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSystemdServiceName } from "../daemon/systemd-service-files.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { readGatewayOwnerLeaseFromDatabase } from "./gateway-owner-lease.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

const GATEWAY_RESTART_INTENT_KEY = "gateway-restart";
const GATEWAY_RESTART_INTENT_TTL_MS = 60_000;
const schemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
  "CREATE TABLE IF NOT EXISTS gateway_restart_intent (",
);
const schemaEndMarker = ") STRICT;";
const schemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(schemaEndMarker, schemaStart);
if (schemaStart < 0 || schemaEnd < 0) {
  throw new Error("Gateway restart intent schema markers are missing");
}
const schema = OPENCLAW_STATE_SCHEMA_SQL.slice(schemaStart, schemaEnd + schemaEndMarker.length);

const restartLog = createSubsystemLogger("restart");
type GatewayRestartIntentDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_intent">;

type GatewayRestartIntentPayload = {
  kind: "gateway-restart";
  pid: number;
  createdAt: number;
  reason?: string;
  force?: boolean;
  waitMs?: number;
};

export type GatewayRestartIntent = {
  reason?: string;
  force?: boolean;
  waitMs?: number;
  // Process-local only: persisted restart requests cannot delegate successor ownership.
  successorOwner?: {
    kind: "managed-update-handoff";
    handoffId: string;
    installRoot: string;
  };
};

export function normalizeRestartIntentReason(reason: string | undefined): string | undefined {
  const normalized = reason?.trim();
  return normalized ? truncateUtf16Safe(normalized, 200) : undefined;
}

export function writeGatewayRestartIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  targetPid?: number;
  intent?: GatewayRestartIntent;
  reason?: string;
}): boolean {
  const targetPid = asPositiveSafeInteger(opts.targetPid) ?? null;
  if (targetPid === null) {
    return false;
  }
  return writeGatewayRestartIntentForTargetSync(opts, () => targetPid);
}

export type GatewayRestartIntentService = {
  kind: "systemd" | "launchd";
  name: string;
};

/** Native service control keeps its selected service; resolve its serving process at admission. */
export function writeGatewayServiceRestartIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  targetPid?: number;
  service?: GatewayRestartIntentService;
  intent?: GatewayRestartIntent;
  reason?: string;
  assertCurrent: () => void;
  warn: (message: string) => void;
}): boolean {
  let ownershipUnverified = false;
  const written = writeGatewayRestartIntentForTargetSync(
    opts,
    (db) => {
      if (!opts.service) {
        return opts.targetPid;
      }
      try {
        const owner = readGatewayOwnerLeaseFromDatabase(db);
        ownershipUnverified = owner?.state === "unknown";
        const supervisor = owner?.supervisor;
        if (
          owner?.state === "live" &&
          owner.mode === "supervised" &&
          supervisor?.kind === opts.service.kind &&
          supervisor.name !== null &&
          (supervisor.kind === "systemd"
            ? resolveSystemdServiceName({ OPENCLAW_SYSTEMD_UNIT: supervisor.name }) ===
              resolveSystemdServiceName({ OPENCLAW_SYSTEMD_UNIT: opts.service.name })
            : supervisor.name === opts.service.name)
        ) {
          return owner.pid;
        }
      } catch {
        ownershipUnverified = true;
      }
      return opts.targetPid;
    },
    opts.assertCurrent,
  );
  if (ownershipUnverified) {
    opts.warn(
      "Could not verify the serving Gateway owner; using native service status for restart intent.",
    );
  }
  return written;
}

function writeGatewayRestartIntentForTargetSync(
  opts: { env?: NodeJS.ProcessEnv; intent?: GatewayRestartIntent; reason?: string },
  resolveTargetPid: (db: DatabaseSync) => number | undefined,
  assertCurrent?: () => void,
): boolean {
  const env = opts.env ?? process.env;
  try {
    if (!existsSync(resolveOpenClawStateSqlitePath(env))) {
      restartLog.info("skipped gateway restart intent: no existing state database");
      return false;
    }
    const reason = normalizeRestartIntentReason(opts.reason ?? opts.intent?.reason);
    const waitMs =
      typeof opts.intent?.waitMs === "number" &&
      Number.isFinite(opts.intent.waitMs) &&
      opts.intent.waitMs >= 0
        ? Math.floor(opts.intent.waitMs)
        : null;
    // The old Gateway still owns the schema until the restart hands off.
    return runExistingOpenClawStateWriteTransaction(
      ({ db }) => {
        // Coordinator/BEGIN admission can block while the supervised owner changes.
        assertCurrent?.();
        const targetPid = asPositiveSafeInteger(resolveTargetPid(db)) ?? null;
        assertCurrent?.();
        if (targetPid === null) {
          return false;
        }
        const createdAt = Date.now();
        const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .insertInto("gateway_restart_intent")
            .values({
              intent_key: GATEWAY_RESTART_INTENT_KEY,
              kind: "gateway-restart",
              pid: targetPid,
              created_at: createdAt,
              reason: reason ?? null,
              force: opts.intent?.force ? 1 : null,
              wait_ms: waitMs,
              updated_at_ms: createdAt,
            })
            .onConflict((conflict) =>
              conflict.column("intent_key").doUpdateSet({
                kind: (eb) => eb.ref("excluded.kind"),
                pid: (eb) => eb.ref("excluded.pid"),
                created_at: (eb) => eb.ref("excluded.created_at"),
                reason: (eb) => eb.ref("excluded.reason"),
                force: (eb) => eb.ref("excluded.force"),
                wait_ms: (eb) => eb.ref("excluded.wait_ms"),
                updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
              }),
            ),
        );
        return true;
      },
      { env },
      { schemaSql: schema, operationLabel: "gateway.restart-intent.write" },
    );
  } catch (err) {
    // Revoked native control authority must not become a best-effort storage warning.
    assertCurrent?.();
    restartLog.warn(`failed to write gateway restart intent: ${String(err)}`);
    return false;
  }
}

export function clearGatewayRestartIntentSync(env: NodeJS.ProcessEnv = process.env): void {
  try {
    runExistingOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .deleteFrom("gateway_restart_intent")
            .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY),
        );
      },
      { env },
      { schemaSql: schema, operationLabel: "gateway.restart-intent.clear" },
    );
  } catch {}
}

function readGatewayRestartIntentPayloadSync(
  env: NodeJS.ProcessEnv,
): GatewayRestartIntentPayload | null {
  try {
    const { db } = openOpenClawStateDatabase({ env });
    const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
    const parsed = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("gateway_restart_intent")
        .select(["kind", "pid", "created_at", "reason", "force", "wait_ms"])
        .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY),
    );
    if (
      parsed?.kind === "gateway-restart" &&
      typeof parsed.pid === "number" &&
      Number.isFinite(parsed.pid) &&
      typeof parsed.created_at === "number" &&
      Number.isFinite(parsed.created_at) &&
      (parsed.reason === null || typeof parsed.reason === "string") &&
      (parsed.force === null ||
        (typeof parsed.force === "number" && Number.isFinite(parsed.force))) &&
      (parsed.wait_ms === null ||
        (typeof parsed.wait_ms === "number" &&
          Number.isFinite(parsed.wait_ms) &&
          parsed.wait_ms >= 0))
    ) {
      const reason = normalizeRestartIntentReason(parsed.reason ?? undefined);
      return {
        kind: "gateway-restart",
        pid: parsed.pid,
        createdAt: parsed.created_at,
        ...(reason ? { reason } : {}),
        ...(parsed.force ? { force: true } : {}),
        ...(typeof parsed.wait_ms === "number" ? { waitMs: Math.floor(parsed.wait_ms) } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function consumeGatewayRestartIntentPayloadSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): GatewayRestartIntent | null {
  const payload = readGatewayRestartIntentPayloadSync(env);
  clearGatewayRestartIntentSync(env);
  if (!payload) {
    return null;
  }
  if (payload.pid !== process.pid) {
    return null;
  }
  const ageMs = now - payload.createdAt;
  if (ageMs < 0 || ageMs > GATEWAY_RESTART_INTENT_TTL_MS) {
    return null;
  }
  return {
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.force ? { force: true } : {}),
    ...(typeof payload.waitMs === "number" ? { waitMs: payload.waitMs } : {}),
  };
}

export function consumeGatewayRestartIntentSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  return consumeGatewayRestartIntentPayloadSync(env, now) !== null;
}
