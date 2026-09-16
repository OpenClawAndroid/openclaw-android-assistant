import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import type { WorktreeFilesystemBackend } from "./filesystem-backend.types.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { listTemplates } from "./template-registry.js";

vi.mock("./filesystem-backend.js", () => ({ detectWorktreeFilesystemBackend: vi.fn() }));
const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("ManagedWorktreeService sparse isolation", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  let backend: WorktreeFilesystemBackend;
  beforeEach(async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-worktree-sparse-isolation-");
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const now = Date.now();
    backend = createCopyWorktreeBackend();
    vi.mocked(detectWorktreeFilesystemBackend).mockReset().mockResolvedValue(backend);
    service = new ManagedWorktreeService({ env, now: () => now, getConfig: () => ({}) });
  });

  it.each([false, true])(
    "preserves isolated source and guarded fallback through sparse/disable order (companion-before-disable=%s)",
    async (companionBeforeDisable) => {
      await fs.mkdir(path.join(repo, ".openclaw/worktree-profiles"), { recursive: true });
      await fs.mkdir(path.join(repo, "selected"), { recursive: true });
      await fs.mkdir(path.join(repo, "excluded"), { recursive: true });
      await fs.writeFile(path.join(repo, "selected/source.txt"), "selected\n");
      await fs.writeFile(path.join(repo, "excluded/source.txt"), "excluded\n");
      await fs.writeFile(path.join(repo, ".gitignore"), "excluded/ignored.txt\n");
      await fs.writeFile(path.join(repo, ".openclaw/worktree-profiles/selected"), "selected\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "source profile");
      const commit = await git(repo, "rev-parse", "HEAD");
      const targets = new Map<string, string>([["repository", repo]]);
      const backends: { name: string; actual: string; expected: string }[] = [];
      const trace: { phase: string; targets: unknown[] }[] = [];
      const gitPath = (target: string, name: string) =>
        git(target, "rev-parse", "--path-format=absolute", "--git-path", name);
      const optional = async (file: string) => {
        try {
          return await fs.readFile(file, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        }
      };
      const observe = async (phase: string) => {
        for (const name of targets.keys()) {
          if (name.startsWith("template-")) {
            targets.delete(name);
          }
        }
        for (const template of listTemplates(env)) {
          targets.set(`template-${template.id}`, template.path);
        }
        const samples = [];
        for (const [name, target] of targets) {
          const indexPath = await gitPath(target, "index");
          const headPath = await gitPath(target, "HEAD");
          const worktreeConfigPath = await gitPath(target, "config.worktree");
          const patternPath = await gitPath(target, "info/sparse-checkout");
          samples.push({
            name,
            target,
            headPath,
            headFile: await fs.readFile(headPath, "utf8"),
            commit: await git(target, "rev-parse", "HEAD"),
            indexPath,
            indexSha256: createHash("sha256")
              .update(await fs.readFile(indexPath))
              .digest("hex"),
            indexEntries: await git(target, "ls-files", "-t"),
            commonDir: await git(target, "rev-parse", "--path-format=absolute", "--git-common-dir"),
            effectiveConfig: await git(target, "config", "--show-origin", "--show-scope", "--list"),
            commonConfig: await fs.readFile(await gitPath(target, "config"), "utf8"),
            worktreeConfigPath,
            worktreeConfig: await optional(worktreeConfigPath),
            patternPath,
            patterns: await optional(patternPath),
          });
        }
        trace.push({ phase, targets: samples });
        expect(new Set(samples.map((s) => s.indexPath)).size).toBe(samples.length);
        expect(samples.every((s) => s.commit === commit)).toBe(true);
        expect(new Set(samples.map((s) => s.commonDir)).size).toBe(1);
      };
      const create = async (name: string, profiles?: string[]) => {
        const siblings = await Promise.all(
          [...targets.entries()]
            .filter(([label]) => !label.startsWith("template-"))
            .map(async ([label, target]) => ({
              label,
              index: await gitPath(target, "index"),
              head: await gitPath(target, "HEAD"),
              indexBytes: await fs.readFile(await gitPath(target, "index")),
              headBytes: await fs.readFile(await gitPath(target, "HEAD")),
            })),
        );
        const calls = vi.mocked(backend.cloneTemplate).mock.calls.length;
        const created = await service.create({ repoRoot: repo, name, baseRef: commit, profiles });
        backends.push({
          name,
          actual:
            vi.mocked(backend.cloneTemplate).mock.calls.length > calls ? "fixture-clone" : "git",
          expected: name === "full-cold" || name === "full-warm" ? "fixture-clone" : "git",
        });
        for (const sibling of siblings) {
          expect(await fs.readFile(sibling.index), sibling.label).toEqual(sibling.indexBytes);
          expect(await fs.readFile(sibling.head), sibling.label).toEqual(sibling.headBytes);
        }
        targets.set(name, created.path);
        await observe(name);
        return created;
      };
      // Original order: cold full -> warm full -> sparse -> native disable ->
      // subsequent full -> sparse/reuse -> full. Companion adds a full create
      // while the first sparse checkout is still sparse to catch contamination.
      const cold = await create("full-cold");
      const warm = await create("full-warm");
      const sparseA = await create("sparse-a", ["selected"]);
      await fs.writeFile(path.join(sparseA.path, "selected/source.txt"), "sparse edit\n");
      await fs.mkdir(path.join(sparseA.path, "excluded"), { recursive: true });
      await fs.writeFile(path.join(sparseA.path, "excluded/ignored.txt"), "retained ignored\n");
      const companion = companionBeforeDisable ? await create("full-companion") : undefined;
      await git(sparseA.path, "sparse-checkout", "disable");
      await observe("native-disable-a");
      const fullB = await create("full-after-disable");
      const sparseC = await create("sparse-c", ["selected"]);
      await fs.writeFile(path.join(sparseC.path, "selected/source.txt"), "sparse reuse edit\n");
      expect((await service.create({ repoRoot: repo, name: "sparse-c", baseRef: commit })).id).toBe(
        sparseC.id,
      );
      await expect(
        service.create({
          repoRoot: repo,
          name: "sparse-c",
          baseRef: commit,
          profiles: ["selected"],
        }),
      ).rejects.toThrow(/new worktree/);
      await observe("sparse-c-reuse");
      const fullD = await create("full-with-sparse-c");
      for (const target of [
        cold.path,
        warm.path,
        fullB.path,
        fullD.path,
        ...(companion ? [companion.path] : []),
        ...listTemplates(env).map((t) => t.path),
      ]) {
        expect(await fs.readFile(path.join(target, "selected/source.txt"), "utf8")).toBe(
          "selected\n",
        );
        expect(await fs.readFile(path.join(target, "excluded/source.txt"), "utf8")).toBe(
          "excluded\n",
        );
        expect(await git(target, "ls-files", "-t")).not.toMatch(/^S /m);
        expect(await git(target, "config", "--show-origin", "--show-scope", "--list")).not.toMatch(
          /core\.sparsecheckout=true/,
        );
      }
      expect(await fs.readFile(path.join(sparseA.path, "selected/source.txt"), "utf8")).toBe(
        "sparse edit\n",
      );
      expect(await fs.readFile(path.join(sparseA.path, "excluded/ignored.txt"), "utf8")).toBe(
        "retained ignored\n",
      );
      expect(await fs.readFile(path.join(sparseA.path, "excluded/source.txt"), "utf8")).toBe(
        "excluded\n",
      );
      expect(await fs.readFile(path.join(sparseC.path, "selected/source.txt"), "utf8")).toBe(
        "sparse reuse edit\n",
      );
      await expect(fs.access(path.join(sparseC.path, "excluded/source.txt"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
      expect(await git(sparseC.path, "ls-files", "-t")).toMatch(/^S excluded\/source.txt$/m);
      expect(await git(sparseC.path, "merge-base", "HEAD", "main")).toBe(commit);
      expect(await git(sparseC.path, "rev-parse", "--is-shallow-repository")).toBe("false");
      // Git enables shared worktreeConfig for sparse state. The existing guard
      // deliberately keeps later full creates on Git, even after native disable.
      // Collect all states before comparing the documented fallback sequence.
      for (const row of backends) {
        expect(row.actual, JSON.stringify(trace, null, 2)).toBe(row.expected);
      }
    },
  );
});
