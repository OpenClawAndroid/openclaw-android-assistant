import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const owner = ".github/actions/setup-pnpm-store-cache/seed-pnpm-from-image.mjs";
const wrapperAnchor =
  "37536c26ed40ab4134b6511e09f6b27f3ebb45687468f2406ca3805279a4e5ca158c1931350ad9774d6ab2108d71b3dbaeb39943159294375e4d053e8e05685c";
const nativeAnchor =
  "490560464711e17caa7fcf9535bb58d2bb5c1277c3ab8f11847df41d6a36fd47ea2847e57b6ace3321993a63750db330e19cc6e66598a02f353bb66a1c565c3f";

function fixture(options: { platform?: string; arch?: string; glibc?: boolean } = {}) {
  const root = tempDirs.make("pnpm-verified-download-");
  const image = path.join(root, "image");
  const registry = path.join(root, "registry");
  const runner = path.join(root, "runner");
  const bin = path.join(root, "bin");
  for (const dir of [image, registry, runner, bin]) {
    fs.mkdirSync(dir);
  }
  function archive(name: string, native: boolean) {
    const stage = path.join(root, native ? "native" : "wrapper");
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ version: "12.4.0" }));
    fs.writeFileSync(path.join(stage, "pnpm"), native ? "native-fixture\n" : "wrapper-fixture\n");
    const dest = path.join(registry, name);
    execFileSync("tar", ["-czf", dest, "-C", root, path.basename(stage)]);
    return createHash("sha512").update(fs.readFileSync(dest)).digest("hex");
  }
  const wrapperHash = archive("pnpm-12.4.0.tgz", false);
  const nativeHash = archive("exe.linux-x64-12.4.0.tgz", true);
  const calls = path.join(root, "curl-calls");
  const curl = path.join(bin, "curl");
  fs.writeFileSync(
    curl,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CURL_CALLS"
if [ "\${CURL_FIXTURE_EXIT:-0}" != 0 ]; then exit "$CURL_FIXTURE_EXIT"; fi
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output' ]; then shift; out="$1"; fi
  url="$1"
  shift
done
case "$url" in
  https://registry.npmjs.org/pnpm/-/pnpm-12.4.0.tgz) name=pnpm-12.4.0.tgz ;;
  https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.4.0.tgz) name=exe.linux-x64-12.4.0.tgz ;;
  *) exit 91 ;;
esac
cp "$FIXTURE_REGISTRY/$name" "$out"
`,
    { mode: 0o755 },
  );
  const script = fs
    .readFileSync(owner, "utf8")
    .replaceAll("/opt/crabbox/toolchain-archives", image)
    .replaceAll("process.platform", JSON.stringify(options.platform ?? "linux"))
    .replaceAll("process.arch", JSON.stringify(options.arch ?? "x64"))
    .replace(
      "process.report?.getReport().header.glibcVersionRuntime",
      options.glibc === false ? "undefined" : '"fixture-glibc"',
    )
    .replaceAll(wrapperAnchor, wrapperHash)
    .replaceAll(nativeAnchor, nativeHash);
  const scriptPath = path.join(root, "seed.mjs");
  fs.writeFileSync(scriptPath, script);
  const spec = `pnpm@12.4.0+sha512.${wrapperHash}`;
  return {
    root,
    image,
    registry,
    runner,
    calls,
    spec,
    run(extraEnv: NodeJS.ProcessEnv = {}, selected = spec) {
      return spawnSync(process.execPath, [scriptPath, selected], {
        encoding: "utf8",
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          RUNNER_TEMP: runner,
          CURL_CALLS: calls,
          FIXTURE_REGISTRY: registry,
          ...extraEnv,
        },
      });
    },
  };
}

describe("pinned pnpm cold bootstrap", () => {
  it.each([{ platform: "darwin" }, { arch: "riscv64" }, { glibc: false }])(
    "leaves unsupported native selection with its owner: %j",
    (options) => {
      const f = fixture(options);
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(fs.existsSync(f.calls)).toBe(false);
    },
  );

  it("stops on a download error without retrying or publishing cache state", () => {
    const f = fixture();
    const result = f.run({ CURL_FIXTURE_EXIT: "22" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot download pinned pnpm archive");
    expect(result.stdout).toBe("");
    expect(fs.readFileSync(f.calls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fs.readdirSync(f.runner)).toEqual([]);
  });

  it("authenticates both missing archives into the existing private Corepack layout", () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    const root = path.join(result.stdout.trim(), "v1/pnpm/12.4.0");
    expect(fs.readFileSync(path.join(root, "pnpm"), "utf8")).toBe("wrapper-fixture\n");
    expect(fs.readFileSync(path.join(root, "node_modules/@pnpm/exe.linux-x64/pnpm"), "utf8")).toBe(
      "native-fixture\n",
    );
    expect(JSON.parse(fs.readFileSync(path.join(root, ".corepack"), "utf8"))).toEqual({
      locator: { name: "pnpm", reference: f.spec.slice(5) },
      bin: { pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" },
      hash: f.spec.split("+")[1],
    });
    expect(fs.readFileSync(f.calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(fs.readdirSync(f.runner)).toHaveLength(1);
  });

  it("uses authenticated image bytes without making a network request", () => {
    const f = fixture();
    for (const name of fs.readdirSync(f.registry)) {
      fs.copyFileSync(path.join(f.registry, name), path.join(f.image, name));
    }
    const result = f.run({ COREPACK_ENABLE_NETWORK: "0" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    expect(fs.existsSync(f.calls)).toBe(false);
  });

  it.each(["pnpm-12.4.0.tgz", "exe.linux-x64-12.4.0.tgz"])(
    "rejects substituted downloaded %s and removes incomplete state",
    (name) => {
      const f = fixture();
      fs.writeFileSync(path.join(f.registry, name), "substituted bytes");
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("checksum mismatch");
      expect(result.stdout).toBe("");
      expect(fs.readdirSync(f.runner)).toEqual([]);
    },
  );

  it.each([
    { COREPACK_ENABLE_NETWORK: "0" },
    { COREPACK_NPM_REGISTRY: "https://registry.example.test" },
    { COREPACK_INTEGRITY_KEYS: '{"npm":[]}' },
  ])("retains ordinary owner policy when cold network seeding is unavailable: %j", (env) => {
    const f = fixture();
    const result = f.run(env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(fs.existsSync(f.calls)).toBe(false);
    expect(fs.readdirSync(f.runner)).toEqual([]);
  });

  it("does not fetch an unrecognized version or changed packageManager integrity", () => {
    const f = fixture();
    for (const spec of [f.spec.replace("12.4.0", "12.4.1"), f.spec.replace(/.$/u, "z")]) {
      const result = f.run({}, spec);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(fs.existsSync(f.calls)).toBe(false);
  });
});

describe("pnpm version output owns its failure", () => {
  it.each([0, 42])("preserves the version probe exit status %s", (status) => {
    const root = tempDirs.make("pnpm-version-step-");
    const output = path.join(root, "outputs");
    fs.writeFileSync(output, "");
    const action = parse(
      fs.readFileSync(".github/actions/setup-pnpm-store-cache/action.yml", "utf8"),
    );
    const step = action.runs.steps.find((entry: { id?: string }) => entry.id === "pnpm-version");
    const run = `pnpm() { if [ ${status} -eq 0 ]; then printf '12.4.0\\n'; else return ${status}; fi; }\n${step.run}`;
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", run], {
      encoding: "utf8",
      cwd: root,
      env: { PATH: process.env.PATH, PROJECT_DIR: root, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(status);
    expect(fs.readFileSync(output, "utf8")).toBe(status === 0 ? "pnpm-version=12.4.0\n" : "");
  });
});
