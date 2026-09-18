import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/service-audit-mocks.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { resolveLaunchAgentPlistPath } from "./launchd-service-files.js";
import { resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import { buildScheduledTaskXml, resolveTaskScriptPath } from "./schtasks-layout.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import { buildSystemdUnit } from "./systemd-unit.js";
import {
  execSystemctlUserMock,
  resetServiceAuditMocks,
} from "./test-helpers/service-audit-fixtures.js";

const native = vi.hoisted(() => ({ task: vi.fn() }));
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: native.task }));
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runExec: vi.fn(async (_command: string, args: string[], options: { input: Uint8Array }) =>
    decodeLaunchAgentPlistFixture(options.input, args[1]),
  ),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  resetServiceAuditMocks();
  native.task.mockReset();
});

async function systemdFixture(change: (unit: string) => string, dropIn?: string) {
  const home = dirs.make("definition-facts-systemd-");
  const sourcePath = path.join(home, ".config/systemd/user/openclaw-gateway.service");
  const command = {
    programArguments: ["/usr/bin/node", "/opt/openclaw/index.js", "gateway"],
    environment: {
      PATH: "/usr/bin:/bin",
      NODE_OPTIONS: "--max-old-space-size=4096",
      OPERATOR_SETTING: "operator-secret",
    },
    sourcePath,
    definitionPaths: [sourcePath],
  };
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  const content = change(buildSystemdUnit(command));
  await fs.writeFile(sourcePath, content);
  if (dropIn) {
    const file = `${sourcePath}.d/operator.conf`;
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, dropIn);
    command.definitionPaths.push(file);
  }
  return {
    content,
    sourcePath,
    command,
    env: { HOME: home },
    expectedServicePath: "/usr/bin:/bin",
  };
}

it("keeps current policy clean with recognized heap and arbitrary environment settings", async () => {
  const fixture = await systemdFixture((unit) => unit);
  const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
  expect(result).toEqual({ ok: true, issues: [] });
});

it("reports missing systemd policy separately from unchanged legacy repair issues", async () => {
  const fixture = await systemdFixture((unit) => unit.replace("Restart=always\n", ""));
  const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
  expect(result.ok).toBe(true);
  expect(result.issues).toEqual([]);
  expect(result.definitionDrift).toEqual([
    {
      kind: "outdated",
      key: "Service.Restart",
      current: null,
      expected: "always",
      sourcePath: fixture.sourcePath,
      message: expect.stringContaining("Service.Restart"),
    },
  ]);
  expect(await fs.readFile(fixture.sourcePath, "utf8")).toBe(fixture.content);
});

it("reports the missing base KillMode while legacy audit retains effective manager settings", async () => {
  const fixture = await systemdFixture((unit) => unit.replace("KillMode=mixed\n", ""));
  execSystemctlUserMock.mockResolvedValue({
    code: 0,
    stderr: "",
    termination: "exit",
    stdout:
      "LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=330s\n",
  });
  const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
  expect(result.issues).toEqual([]);
  expect(result.definitionDrift).toContainEqual(
    expect.objectContaining({
      kind: "outdated",
      key: "Service.KillMode",
      current: null,
      expected: "mixed",
    }),
  );
});

it.each(["base", "drop-in", "drop-in-unknown", "drop-in-dependency"])(
  "reports unknown %s edits without exposing their values",
  async (kind) => {
    const fixture = await systemdFixture(
      (unit) =>
        kind === "base"
          ? unit.replace("[Service]", "[Service]\nExecStartPre=/private/operator-secret")
          : unit,
      kind === "drop-in"
        ? "[Service]\nRestart=operator-secret\n"
        : kind === "drop-in-unknown"
          ? "[Service]\nExecStartPre=operator-secret\n"
          : kind === "drop-in-dependency"
            ? "[Unit]\nAfter=network-online.target operator-secret\n"
            : undefined,
    );
    const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
    expect(result.definitionDrift).toContainEqual(
      expect.objectContaining({
        kind: "unknown-edit",
        key:
          kind === "drop-in"
            ? "Service.Restart"
            : kind === "drop-in-dependency"
              ? "Unit.After"
              : "Service.ExecStartPre",
        sourcePath: expect.stringContaining(kind === "base" ? ".service" : "operator.conf"),
      }),
    );
    expect(JSON.stringify(result.definitionDrift)).not.toContain("operator-secret");
  },
);

it("reports unavailable drop-in inspection without adding a repair candidate", async () => {
  const fixture = await systemdFixture((unit) => unit);
  fixture.command.definitionPaths.push(`${fixture.sourcePath}.d/unreadable.conf`);
  const result = await auditGatewayServiceConfig({ ...fixture, platform: "linux" });
  expect(result.issues).toEqual([]);
  expect(result.definitionDriftError).toContain("inspection could not be completed");
});

it.each(["other-source", "disappeared", "reload-pending"])(
  "does not report a complete definition inspection when %s",
  async (state) => {
    const fixture = await systemdFixture((unit) => unit);
    if (state === "other-source") {
      fixture.command.sourcePath = path.join(fixture.env.HOME, "system.service");
      fixture.command.definitionPaths = [fixture.command.sourcePath];
      await fs.unlink(fixture.sourcePath);
    } else if (state === "disappeared") {
      await fs.unlink(fixture.sourcePath);
    }
    const result = await auditGatewayServiceConfig({
      ...fixture,
      command: {
        ...fixture.command,
        ...(state === "reload-pending" ? { reloadPending: true } : {}),
      },
      platform: "linux",
    });
    expect(result.definitionDrift).toBeUndefined();
    expect(result.definitionDriftError).toEqual(expect.any(String));
  },
);

it.each([false, true])(
  "distinguishes missing launchd policy from custom policy: custom=%s",
  async (custom) => {
    const home = dirs.make("definition-facts-launchd-");
    const env = { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") };
    const sourcePath = resolveLaunchAgentPlistPath(env);
    const command = {
      programArguments: ["/usr/bin/node", "/opt/openclaw/index.js", "gateway"],
      environment: { PATH: "/usr/bin:/bin" },
    };
    const { stdoutPath } = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
    const original = buildLaunchAgentPlist({
      ...command,
      label: "ai.openclaw.gateway",
      stdoutPath,
      stderrPath: stdoutPath,
    }).replace(
      /<key>ExitTimeOut<\/key>\s*<integer>20<\/integer>/u,
      custom ? "<key>ExitTimeOut</key><integer>600</integer>" : "",
    );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, original);
    const result = await auditGatewayServiceConfig({
      env,
      command,
      platform: "darwin",
      expectedServicePath: "/usr/bin:/bin",
    });
    expect(result.issues).toEqual([]);
    expect(result.definitionDrift).toEqual([
      expect.objectContaining(
        custom
          ? {
              kind: "unknown-edit",
              key: "ExitTimeOut",
              reason: expect.any(String),
            }
          : { kind: "outdated", key: "ExitTimeOut", current: null, expected: 20 },
      ),
    ]);
    if (custom) {
      expect(JSON.stringify(result.definitionDrift)).not.toContain("600");
    }
    expect(await fs.readFile(sourcePath, "utf8")).toBe(original);
  },
);

it.each(["0", "9", undefined])(
  "reports Scheduled Task retry policy without triggering repair: count=%s",
  async (count) => {
    const home = dirs.make("definition-facts-task-");
    const env = { USERPROFILE: home, OPENCLAW_STATE_DIR: home, USERNAME: "fixture" };
    const command = { programArguments: ["node", "C:\\openclaw\\index.js", "gateway"] };
    const xml = buildScheduledTaskXml({
      taskDescription: "fixture",
      taskUser: "fixture",
      launchPath: resolveTaskScriptPath(env),
    }).replace("<Count>3</Count>", count === undefined ? "" : `<Count>${count}</Count>`);
    native.task.mockResolvedValue({ code: 0, stdout: xml, stderr: "" });
    const result = await auditGatewayServiceConfig({ env, command, platform: "win32" });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.definitionDrift).toEqual([
      expect.objectContaining(
        count !== "9"
          ? {
              kind: "outdated",
              key: "Settings.RestartOnFailure.Count",
              current: count ?? null,
              expected: "3",
            }
          : {
              kind: "unknown-edit",
              key: "Settings.RestartOnFailure.Count",
              reason: expect.any(String),
            },
      ),
    ]);
    expect(native.task).toHaveBeenCalledExactlyOnceWith([
      "/Query",
      "/TN",
      "OpenClaw Gateway",
      "/XML",
    ]);
  },
);

it("reports failed native task inspection independently from legacy issues", async () => {
  native.task.mockResolvedValue({ code: 1, stdout: "", stderr: "operator-secret" });
  const result = await auditGatewayServiceConfig({
    env: { USERPROFILE: dirs.make("definition-facts-task-unavailable-") },
    command: { programArguments: ["node", "C:\\openclaw\\index.js", "gateway"] },
    platform: "win32",
  });
  expect(result.issues).toEqual([]);
  expect(result.definitionDriftError).toContain("inspection could not be completed");
  expect(JSON.stringify(result)).not.toContain("operator-secret");
});
