import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { collectEagerRuntimeImportClosure } from "./eager-import-closure.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { source: 'import type { Missing } from "./missing.mts";', loadsModule: false },
  { source: 'import { type Missing } from "./missing.mts";', loadsModule: true },
  { source: 'export type { Missing } from "./missing.mts";', loadsModule: false },
  { source: 'export { type Missing } from "./missing.mts";', loadsModule: true },
])("matches plain Node's dependency requirement for $source", ({ source, loadsModule }) => {
  const root = tempDirs.make("openclaw-eager-import-closure-");
  const entry = join(root, "entry.mts");
  writeFileSync(entry, `${source}\nconsole.log("entry executed");\n`);
  const result = spawnSync(process.execPath, [entry], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
  expect(result.status, result.stderr).toBe(loadsModule ? 1 : 0);
  const input = relative(process.cwd(), entry).replaceAll("\\", "/");
  if (loadsModule) {
    expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(() => collectEagerRuntimeImportClosure([input])).toThrow("unresolved ./missing.mts");
  } else {
    expect(result.stdout.trim()).toBe("entry executed");
    expect(collectEagerRuntimeImportClosure([input])).toEqual([input]);
  }
});
