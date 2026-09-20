import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";

const { note } = vi.hoisted(() => ({ note: vi.fn() }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  note.mockClear();
});

async function runCaptureReport(stateDir: string, repair = false) {
  const contribution = resolveDoctorHealthContributions().find(
    (entry) => entry.id === "doctor:legacy-plugin-source-captures",
  );
  expect(contribution, "legacy capture report must be registered with Doctor").toBeDefined();
  const ctx = createDoctorHealthFlowContext({
    env: { OPENCLAW_STATE_DIR: stateDir },
    options: { repair },
  });
  ctx.prompter.shouldRepair = repair;
  await contribution!.run(ctx);
  return note.mock.calls.map(([message]) => String(message)).join("\n");
}

function write(root: string, filename: string, contents: string) {
  const file = path.join(root, filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

it.each([false, true])(
  "reports legacy roots without deleting them (repair=%s), with a safely bounded manual command",
  async (repair) => {
    const parent = temp.make("doctor-plugin-captures-");
    const stateDir = path.join(parent, "state with ' quote");
    const tmp = path.join(stateDir, "tmp");
    const plugin = write(tmp, "openclaw-plugin-build-live/source.cjs", "abc");
    write(tmp, "openclaw-plugin-build-live/nested/module.cjs", "defg");
    const catalog = write(tmp, "openclaw-model-catalog-old/catalog.cjs", "12345");
    const managed = write(tmp, "plugin-captures/owner/captures/source.cjs", "managed");
    const nested = write(tmp, "unrelated/openclaw-plugin-build-nested/source.cjs", "nested");
    const ordinaryFile = write(tmp, "openclaw-plugin-build-file", "ordinary");
    const outside = write(parent, "outside/sentinel", "x".repeat(1024));
    fs.symlinkSync(path.dirname(outside), path.join(tmp, "openclaw-plugin-build-link"), "junction");
    fs.symlinkSync(path.dirname(outside), path.join(path.dirname(plugin), "external"), "junction");

    const output = await runCaptureReport(stateDir, repair);
    expect(output).toContain("2 legacy plugin capture root(s), 12 B");
    expect(output).toContain("openclaw-plugin-build-live");
    expect(output).toContain("openclaw-model-catalog-old");
    expect(output).toContain("including with --fix");
    expect(output).toContain(
      "every Gateway, CLI process, and container using this state directory has stopped",
    );
    expect(fs.readFileSync(plugin, "utf8")).toBe("abc");
    expect(fs.readFileSync(catalog, "utf8")).toBe("12345");

    // The printed command is executable advice: prove its quoting and scope on offline fixtures.
    if (repair && process.platform !== "win32") {
      const command = output.split("\n").find((line) => line.startsWith("find "));
      expect(command).toBeDefined();
      const result = spawnSync("/bin/sh", ["-c", command!], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(fs.existsSync(plugin)).toBe(false);
      expect(fs.existsSync(catalog)).toBe(false);
      for (const preserved of [managed, nested, ordinaryFile, outside]) {
        expect(fs.existsSync(preserved), preserved).toBe(true);
      }
      expect(fs.lstatSync(path.join(tmp, "openclaw-plugin-build-link")).isSymbolicLink()).toBe(
        true,
      );
    }
  },
);

it("does not inspect through a symbolic-link temporary directory", async () => {
  const stateDir = temp.make("doctor-plugin-captures-symlink-");
  const outside = temp.make("doctor-plugin-captures-outside-");
  const sentinel = write(outside, "openclaw-plugin-build-live/source.cjs", "private source");
  fs.symlinkSync(outside, path.join(stateDir, "tmp"), "junction");

  const output = await runCaptureReport(stateDir, true);
  expect(output).toContain("symbolic-link temporary path");
  expect(output).not.toContain("find ");
  expect(fs.readFileSync(sentinel, "utf8")).toBe("private source");
});

it("keeps filesystem inspection errors advisory and missing temporary directories silent", async () => {
  const stateDir = temp.make("doctor-plugin-captures-unreadable-");
  await runCaptureReport(stateDir, true);
  expect(note).not.toHaveBeenCalled();
  fs.mkdirSync(path.join(stateDir, "tmp"));
  vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
  );

  const output = await runCaptureReport(stateDir, true);
  expect(output).toContain("inspection was incomplete");
  expect(output).toContain("permission denied");
  expect(output).not.toContain("find ");
});
