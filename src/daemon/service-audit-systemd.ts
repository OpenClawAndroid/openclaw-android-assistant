/** Audits effective systemd service settings and managed unit backups. */
import fs from "node:fs/promises";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { ServiceConfigIssue } from "./service-audit-types.js";
import { execSystemctlUser } from "./systemd-exec.js";
import { resolveSystemdServiceName, resolveSystemdUnitPath } from "./systemd-service-files.js";
import { parseSystemdTimeSpanMs, SYSTEMD_DEFAULT_STOP_TIMEOUT_MS } from "./systemd-time-span.js";
import { parseSystemdEnvAssignments, splitSystemdLogicalLines } from "./systemd-unit.js";

export const SYSTEMD_SERVICE_AUDIT_CODES = {
  systemdAfterNetworkOnline: "systemd-after-network-online",
  systemdRestartSec: "systemd-restart-sec",
  systemdWantsNetworkOnline: "systemd-wants-network-online",
  systemdKillModeProcessOrNone: "systemd-kill-mode-process-or-none",
  systemdKillModeControlGroup: "systemd-kill-mode-control-group",
  systemdUnitBackupUnsafe: "systemd-unit-backup-unsafe",
  systemdStopTimeout: "systemd-stop-timeout",
} as const;

const SYSTEMD_AUDIT_TIMEOUT_MS = 10_000;

function parseSystemdUnit(content: string): {
  after: Set<string>;
  wants: Set<string>;
  restartSec?: string;
  killMode?: string;
  stopTimeoutMs: number;
} {
  const after = new Set<string>();
  const wants = new Set<string>();
  let restartSec: string | undefined;
  let killMode: string | undefined;
  let stopTimeoutMs = SYSTEMD_DEFAULT_STOP_TIMEOUT_MS;
  let section = "";

  // Parse only unit keys relevant to service resilience; this is not a full
  // systemd parser. Stop timeout directives belong only to [Service].
  for (const rawLine of splitSystemdLogicalLines(content)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "TimeoutStopSec" && section === "[Service]") {
      const parsed = parseSystemdTimeSpanMs(value);
      if (!value) {
        stopTimeoutMs = SYSTEMD_DEFAULT_STOP_TIMEOUT_MS;
      } else if (parsed !== undefined) {
        stopTimeoutMs = parsed === 0 ? Infinity : parsed;
      }
    }
    if (!value) {
      continue;
    }
    if (key === "After" || key === "Wants") {
      const dependencies = key === "After" ? after : wants;
      for (const entry of value.split(/\s+/)) {
        if (entry) {
          dependencies.add(entry);
        }
      }
    } else if (key === "RestartSec") {
      restartSec = value;
    } else if (key === "KillMode") {
      killMode = value;
    }
  }

  return { after, wants, restartSec, killMode, stopTimeoutMs };
}

function isRestartSecPreferred(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const parsed = parseSystemdTimeSpanMs(value);
  if (parsed === undefined) {
    return false;
  }
  return Math.abs(parsed - 5_000) < 10;
}

export async function auditSystemdUnit(
  env: Record<string, string | undefined>,
  issues: ServiceConfigIssue[],
  timeoutMs?: number,
) {
  const unitPath = resolveSystemdUnitPath(env);
  await auditSystemdUnitBackup(unitPath, issues);
  let content;
  try {
    content = await fs.readFile(unitPath, "utf8");
  } catch {
    return;
  }

  // The manager owns merged drop-ins and dependency links. Fall back wholesale
  // to the base unit only when its bounded effective-state query fails.
  // `systemctl show` still exits 0 for masked and not-found units, with empty
  // After/Wants and RestartUSec=100ms defaults. Those are not loaded settings.
  const manager = await execSystemctlUser(
    env,
    [
      "show",
      `${resolveSystemdServiceName(env)}.service`,
      "--no-page",
      "--property",
      "After,Wants,RestartUSec,KillMode,LoadState,TimeoutStopUSec",
    ],
    timeoutMs && timeoutMs > 0 ? timeoutMs : SYSTEMD_AUDIT_TIMEOUT_MS,
  );
  const entries = manager.code === 0 ? parseKeyValueOutput(manager.stdout, "=") : undefined;
  const loadState = normalizeLowercaseStringOrEmpty(entries?.loadstate);
  if (loadState && loadState !== "loaded") {
    return;
  }
  const parsed = entries
    ? {
        after: new Set(entries.after?.split(/\s+/).filter(Boolean)),
        wants: new Set(entries.wants?.split(/\s+/).filter(Boolean)),
        restartSec: entries.restartusec,
        killMode: entries.killmode,
        stopTimeoutMs:
          parseSystemdTimeSpanMs(entries.timeoutstopusec ?? "") ?? SYSTEMD_DEFAULT_STOP_TIMEOUT_MS,
      }
    : parseSystemdUnit(content);
  if (parsed.stopTimeoutMs > 0 && parsed.stopTimeoutMs < GATEWAY_SERVICE_STOP_TIMEOUT_MS) {
    issues.push({
      code: SYSTEMD_SERVICE_AUDIT_CODES.systemdStopTimeout,
      message: `TimeoutStopSec=${GATEWAY_SERVICE_STOP_TIMEOUT_MS / 1_000} or longer is required for the Gateway drain and final cleanup; inspect unit and drop-in overrides.`,
      detail: `${unitPath}: ${parsed.stopTimeoutMs / 1_000}s (${entries ? "systemd manager" : "base unit; manager unavailable"})`,
      level: "recommended",
    });
  }
  if (!parsed.after.has("network-online.target")) {
    issues.push({
      code: SYSTEMD_SERVICE_AUDIT_CODES.systemdAfterNetworkOnline,
      message: "Missing systemd After=network-online.target",
      detail: unitPath,
      level: "recommended",
    });
  }
  if (!parsed.wants.has("network-online.target")) {
    issues.push({
      code: SYSTEMD_SERVICE_AUDIT_CODES.systemdWantsNetworkOnline,
      message: "Missing systemd Wants=network-online.target",
      detail: unitPath,
      level: "recommended",
    });
  }
  if (!isRestartSecPreferred(parsed.restartSec)) {
    issues.push({
      code: SYSTEMD_SERVICE_AUDIT_CODES.systemdRestartSec,
      message: "RestartSec does not match the recommended 5s",
      detail: unitPath,
      level: "recommended",
    });
  }
  const killMode = normalizeLowercaseStringOrEmpty(parsed.killMode) || "control-group";
  if (killMode !== "mixed") {
    issues.push({
      code:
        killMode === "process" || killMode === "none"
          ? SYSTEMD_SERVICE_AUDIT_CODES.systemdKillModeProcessOrNone
          : SYSTEMD_SERVICE_AUDIT_CODES.systemdKillModeControlGroup,
      message:
        "KillMode=mixed is required to drain active turns before final service child cleanup; inspect unit and drop-in overrides.",
      detail: `${unitPath}: ${killMode}`,
      level: "recommended",
    });
  }
}

async function auditSystemdUnitBackup(unitPath: string, issues: ServiceConfigIssue[]) {
  const backupPath = `${unitPath}.bak`;
  let stat;
  try {
    stat = await fs.lstat(backupPath);
  } catch {
    return;
  }
  const mode = stat.mode & 0o777;
  const embeddedKeys = new Set<string>();
  let unreadable = false;
  if (stat.isFile()) {
    const content = await fs.readFile(backupPath, "utf8").catch(() => {
      unreadable = true;
      return "";
    });
    for (const rawLine of splitSystemdLogicalLines(content)) {
      const line = rawLine.trim();
      const separator = line.indexOf("=");
      if (separator < 0 || line.slice(0, separator).trim() !== "Environment") {
        continue;
      }
      for (const { key, value } of parseSystemdEnvAssignments(line.slice(separator + 1).trim())) {
        const normalizedKey = key.toUpperCase();
        if (
          value &&
          (normalizedKey === "OPENCLAW_GATEWAY_TOKEN" ||
            normalizedKey === "OPENCLAW_GATEWAY_PASSWORD")
        ) {
          embeddedKeys.add(normalizedKey);
        }
      }
    }
  }
  if (stat.isFile() && !unreadable && embeddedKeys.size === 0 && (mode & 0o077) === 0) {
    return;
  }
  const detail = [
    backupPath,
    !stat.isFile() ? "not a regular file" : undefined,
    unreadable ? "unreadable" : undefined,
    embeddedKeys.size > 0 ? `embedded keys: ${[...embeddedKeys].toSorted().join(", ")}` : undefined,
    (mode & 0o077) !== 0 ? `mode: ${mode.toString(8).padStart(3, "0")}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  issues.push({
    code: SYSTEMD_SERVICE_AUDIT_CODES.systemdUnitBackupUnsafe,
    message:
      embeddedKeys.size > 0
        ? "Systemd service backup exposes gateway credentials; reinstall the service and rotate the embedded credentials."
        : "Systemd service backup is unsafe; reinstall the service to replace it.",
    detail,
    level: "recommended",
  });
}
