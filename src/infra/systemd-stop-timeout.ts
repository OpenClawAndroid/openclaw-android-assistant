import fs from "node:fs/promises";
import { parseKeyValueOutput } from "../daemon/runtime-parse.js";
import { execSystemctl, execSystemctlUser } from "../daemon/systemd-exec.js";
import {
  parseSystemdTimeSpanMs,
  SYSTEMD_DEFAULT_STOP_TIMEOUT_MS,
} from "../daemon/systemd-time-span.js";
import { normalizeSystemdUnit } from "./restart.js";

export type SystemdStopTimeout = { timeoutMs: number; source: string };

/** Read only the running unit, never a same-named unit in the other manager. */
export async function readSystemdStopTimeout(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SystemdStopTimeout> {
  const membership = await fs.readFile("/proc/self/cgroup", "utf8").catch(() => "");
  const memberships = membership.split("\n");
  // On hybrid/legacy hosts, resource controllers can stop at the user manager.
  // Only the systemd hierarchy identifies the Gateway's own service.
  const systemdMembership =
    memberships.find((line) => line.split(":")[1]?.split(",").includes("name=systemd")) ??
    memberships.find((line) => line.startsWith("0::"));
  const servicePath = systemdMembership?.slice(
    systemdMembership.indexOf(":", systemdMembership.indexOf(":") + 1) + 1,
  );
  const cgroupUnit = servicePath?.split("/").findLast((part) => part.endsWith(".service"));
  const unit = normalizeSystemdUnit(cgroupUnit ?? env.OPENCLAW_SYSTEMD_UNIT, env.OPENCLAW_PROFILE);
  const scope =
    cgroupUnit && servicePath
      ? /\/user@\d+\.service\//u.test(servicePath)
        ? "user"
        : "system"
      : undefined;
  const scopes = scope ? [scope] : ["user", "system"];
  for (const candidate of scopes) {
    const args = [
      "show",
      unit,
      "--no-page",
      "--property",
      "TimeoutStopUSec,InvocationID,LoadState",
    ];
    const result = await (
      candidate === "user" ? execSystemctlUser(env, args, 2_000) : execSystemctl(args, env, 2_000)
    ).catch(() => undefined);
    if (result?.code !== 0) {
      continue;
    }
    const properties = parseKeyValueOutput(result.stdout, "=");
    if (
      properties.loadstate !== "loaded" ||
      (env.INVOCATION_ID && properties.invocationid !== env.INVOCATION_ID)
    ) {
      continue;
    }
    const timeoutMs = parseSystemdTimeSpanMs(properties.timeoutstopusec ?? "");
    if (timeoutMs !== undefined) {
      return {
        timeoutMs: timeoutMs === 0 ? Infinity : timeoutMs,
        source: `systemd ${candidate} ${unit} TimeoutStopUSec`,
      };
    }
  }
  return {
    timeoutMs: SYSTEMD_DEFAULT_STOP_TIMEOUT_MS,
    source: `systemd ${unit} timeout unavailable; default TimeoutStopUSec`,
  };
}
