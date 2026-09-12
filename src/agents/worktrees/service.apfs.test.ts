import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { getApfsCloneId } from "../../../test/helpers/apfs.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { listTemplates } from "./template-registry.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe.skipIf(process.platform !== "darwin")("managed worktrees on native APFS", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.unstubAllEnvs();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );

  it("clones through creation, independent provisioning, restore, invalidation and cleanup", async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-service-apfs-");
    const repo = await initializeRepository(root);
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\nsetup.txt\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await fs.writeFile(path.join(repo, "payload"), Buffer.alloc(128 * 1024, 0x5a));
    await fs.writeFile(path.join(repo, "executable"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.symlink("payload", path.join(repo, "link"));
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "source fixture");
    const originalHead = await git(repo, "rev-parse", "HEAD");
    await fs.mkdir(path.join(repo, ".openclaw"));
    await fs.writeFile(
      path.join(repo, ".openclaw", "worktree-setup.sh"),
      '#!/bin/sh\nprintf "%s" "$OPENCLAW_WORKTREE_PATH" > setup.txt\n',
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(repo, ".env.local"), "first");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    let now = Date.now();
    const service = new ManagedWorktreeService({ env, now: () => now, getConfig: () => ({}) });
    const first = await service.create({ repoRoot: repo, name: "first", baseRef: "HEAD" });
    const template = listTemplates(env)[0];
    assert(template);
    expect(template.backend).toBe("apfs");
    await fs.writeFile(path.join(repo, ".env.local"), "second");
    const second = await service.create({ repoRoot: repo, name: "second", baseRef: "HEAD" });
    expect(listTemplates(env).map((entry) => entry.id)).toEqual([template.id]);
    for (const record of [first, second]) {
      expect(getApfsCloneId(path.join(record.path, "payload"))).toBe(
        getApfsCloneId(path.join(template.path, "payload")),
      );
      expect(await git(record.path, "status", "--porcelain")).toBe("");
      expect(await git(record.path, "symbolic-ref", "--short", "HEAD")).toBe(record.branch);
      expect((await fs.stat(path.join(record.path, "executable"))).mode & 0o777).toBe(0o755);
      expect(await fs.readlink(path.join(record.path, "link"))).toBe("payload");
      expect(await fs.readFile(path.join(record.path, "setup.txt"), "utf8")).toBe(record.path);
    }
    expect(await fs.readFile(path.join(first.path, ".env.local"), "utf8")).toBe("first");
    expect(await fs.readFile(path.join(second.path, ".env.local"), "utf8")).toBe("second");
    await expect(fs.access(path.join(template.path, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.writeFile(path.join(first.path, "README.md"), "saved edit\n");
    await fs.writeFile(path.join(first.path, "untracked.txt"), "saved new file\n");
    expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("base\n");
    await service.remove({ id: first.id, reason: "native APFS proof" });
    const restored = await service.restore({ id: first.id });
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("saved edit\n");
    expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
      "saved new file\n",
    );
    await fs.writeFile(path.join(repo, "README.md"), "new source\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "invalidate template");
    const third = await service.create({ repoRoot: repo, name: "third", baseRef: "HEAD" });
    expect(await fs.readFile(path.join(third.path, "README.md"), "utf8")).toBe("new source\n");
    expect(listTemplates(env)[0]?.sourceCommit).toBe(await git(repo, "rev-parse", "HEAD"));
    now += IDLE_GC_MS + 1;
    expect((await service.gc()).removed).toEqual([]);
    expect(listTemplates(env)).toEqual([]);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("saved edit\n");
    expect(await git(second.path, "status", "--porcelain")).toBe("");
  });
});
