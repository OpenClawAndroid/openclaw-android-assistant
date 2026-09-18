import path from "node:path";
import { DOMParser } from "linkedom";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { execFileUtf8 } from "./exec-file.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  buildScheduledTaskXml,
  resolveTaskName,
  resolveTaskScriptPath,
  resolveTaskUser,
} from "./schtasks-layout.js";
import type { ServiceDefinitionDrift } from "./service-audit-types.js";
import type { GatewayServiceEnv } from "./service-types.js";

function elementKey(node: ReturnType<DOMParser["parseFromString"]>["documentElement"]): string {
  return !node.parentElement || node.parentElement.tagName === "Task"
    ? node.tagName
    : `${elementKey(node.parentElement)}.${node.tagName}`;
}

export async function auditScheduledTaskDefinition(
  env: GatewayServiceEnv,
  findings: ServiceDefinitionDrift[],
  timeoutMs?: number,
): Promise<void> {
  const sourcePath = resolveTaskScriptPath(env);
  const query = await execSchtasks(["/Query", "/TN", resolveTaskName(env), "/XML"]);
  if (query.code !== 0) {
    throw new Error("Scheduled Task definition could not be read.");
  }
  const parser = new DOMParser();
  const installed = parser.parseFromString(
    query.stdout.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), ""),
    "text/xml",
  );
  if (installed.documentElement?.tagName !== "Task" || installed.doctype) {
    throw new Error("Scheduled Task definition could not be decoded.");
  }
  const taskUser = resolveTaskUser(env);
  const expected = parser.parseFromString(
    buildScheduledTaskXml({ taskDescription: "", taskUser, launchPath: sourcePath }),
    "text/xml",
  );
  const unknown = (key: string, reason: string) =>
    findings.push({
      kind: "unknown-edit",
      key,
      reason,
      sourcePath,
      message: `Scheduled Task ${key} contains an unrecognized setting.`,
    });
  const outdated = (key: string, current: string | null, value: string) =>
    findings.push({
      kind: "outdated",
      key,
      current,
      expected: value,
      sourcePath,
      message: `Scheduled Task ${key} differs from the installer value ${value}.`,
    });
  // Task Scheduler exports the installer's account as a SID rather than a name.
  let userSid: string | undefined;
  if (
    taskUser &&
    [...installed.querySelectorAll("Principal > UserId, LogonTrigger > UserId")].some(
      (node) => node.textContent.toLowerCase() !== taskUser.toLowerCase(),
    )
  ) {
    const encoded = Buffer.from(taskUser).toString("base64");
    const identity = await execFileUtf8(
      getWindowsPowerShellExePath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; $name=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ([Security.Principal.NTAccount]$name).Translate([Security.Principal.SecurityIdentifier]).Value`,
      ],
      { timeout: timeoutMs ?? 15_000 },
    );
    if (identity.code === 0 && /^S-1-[\d-]+$/u.test(identity.stdout.trim())) {
      userSid = identity.stdout.trim();
    }
  }
  const nativeDefaults: Record<string, string> = {
    "Settings.UseUnifiedSchedulingEngine": "false",
    "Settings.DisallowStartOnRemoteAppSession": "false",
    "Settings.Volatile": "false",
  };
  const released: Record<string, string> = {
    "Settings.DisallowStartIfOnBatteries": "true",
    "Settings.StopIfGoingOnBatteries": "true",
    "Principals.Principal.LogonType": "S4U",
    "Settings.RestartOnFailure.Count": "0",
    "Settings.RestartOnFailure.Interval": "PT0S",
  };
  const preserved =
    /^(?:RegistrationInfo\.(?:Description|Date|Author|URI)|Actions\.Exec\.Command)$/u;
  const seen = new Set<string>();
  for (const node of [installed.documentElement, ...installed.querySelectorAll("Task *")]) {
    const key = elementKey(node);
    const canonical =
      key === "Task"
        ? expected.documentElement
        : expected.querySelector(key.replaceAll(".", " > "));
    if (seen.has(key)) {
      unknown(key, "Duplicate native definition field.");
    }
    seen.add(key);
    for (const attribute of new Set([
      ...node.getAttributeNames(),
      ...(canonical?.getAttributeNames() ?? []),
    ])) {
      if (
        !(key === "Task" && attribute === "version") &&
        node.getAttribute(attribute) !== canonical?.getAttribute(attribute)
      ) {
        unknown(`${key}.@${attribute}`, "Native definition attribute differs from the installer.");
      }
    }
    const current = node.textContent;
    if (
      preserved.test(key) ||
      (node.tagName === "UserId" &&
        taskUser &&
        (current.toLowerCase() === taskUser.toLowerCase() || current === userSid))
    ) {
      continue;
    }
    if (
      nativeDefaults[key] === current ||
      (canonical && (node.children.length || current === canonical.textContent))
    ) {
      continue;
    }
    if (canonical && released[key] === current) {
      outdated(key, current, canonical.textContent);
    } else {
      unknown(key, "The key or value is not a recognized installer setting.");
    }
  }
  for (const node of expected.querySelectorAll("Task *")) {
    const key = elementKey(node);
    if (seen.has(key) || node.children.length || preserved.test(key)) {
      continue;
    }
    if (key.startsWith("Principals.") || key.endsWith("UserId")) {
      unknown(key, "Installer identity field is missing.");
    } else {
      outdated(key, null, node.textContent);
    }
  }
  const launcher = installed.querySelector("Actions > Exec > Command")?.textContent;
  if (
    !launcher ||
    ![sourcePath, sourcePath.replace(/\.cmd$/iu, ".vbs")].some(
      (candidate) =>
        path.win32.normalize(candidate).toLowerCase() ===
        path.win32.normalize(launcher).toLowerCase(),
    )
  ) {
    unknown("Actions.Exec.Command", "Native task points at an unrecognized launcher.");
  }
}
