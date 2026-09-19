import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  getSkillsSourceVersion,
} from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

type SkillsChangeEvent = NonNullable<Parameters<typeof bumpSkillsSnapshotVersion>[0]>;
const { createdWatchers, watchMock, watchForSkillRoot } = createSkillsWatcherMock();
let refreshModule: typeof import("./refresh.js");
let fixtureWorkspaceDir: string;

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

describe("skills watcher subscription lifecycle", () => {
  const fixture = useSkillsWatcherFixture();
  const { createFixtureDirectory } = fixture;
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
  });
  beforeEach(() => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    watchMock.mockClear();
    createdWatchers.length = 0;
    fixtureWorkspaceDir = fixture.workspaceDir;
  });

  it("stops fanning a shared-directory change to a workspace after it unsubscribes", async () => {
    vi.useFakeTimers();
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const sharedRoot = await createFixtureDirectory("shared");
    const config = { skills: { load: { extraDirs: [sharedRoot] } } };
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
    const sharedWatcher = watchForSkillRoot(sharedRoot).watcher;

    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [sharedRoot], watch: false } } },
    });
    seen.length = 0;
    expect(sharedWatcher.close).not.toHaveBeenCalled();
    const changedPath = path.join(sharedRoot, "demo", "SKILL.md");
    sharedWatcher.emit("all", "change", changedPath);
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([{ workspaceDir: secondWorkspace, reason: "watch", changedPath }]);
  });

  it("preserves workspace invalidation on watch disable without changing other workspaces", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const workspaceDir = fixtureWorkspaceDir;
    const otherWorkspace = await createFixtureDirectory("other-workspace");
    refreshModule.ensureSkillsWatcher({ workspaceDir: otherWorkspace });
    const otherVersion = getSkillsSnapshotVersion(otherWorkspace);
    const globalVersion = getSkillsSnapshotVersion();
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    const firstVersion = bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch",
      changedPath: `${workspaceDir}/skills/demo/SKILL.md`,
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { watch: false } } },
    });

    const nextVersion = getSkillsSnapshotVersion(workspaceDir);
    expect(nextVersion).toBe(firstVersion);
    expect(getSkillsSnapshotVersion(otherWorkspace)).toBe(otherVersion);
    expect(getSkillsSnapshotVersion()).toBe(globalVersion);
    vi.setSystemTime(new Date(nextVersion));
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(nextVersion);
  });

  it("evicts idle workspace subscriptions on a later ensure call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const idleWorkspaceDir = fixtureWorkspaceDir;
    const activeWorkspaceDir = await createFixtureDirectory("workspace-active");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: idleWorkspaceDir,
      config: { skills: { load: {} } },
    });
    const idleSkillsWatcher = watchForSkillRoot(path.join(idleWorkspaceDir, "skills")).watcher;
    const firstVersion = bumpSkillsSnapshotVersion({
      workspaceDir: idleWorkspaceDir,
      reason: "watch",
    });
    const globalVersion = getSkillsSnapshotVersion();

    vi.advanceTimersByTime(60 * 60_000 + 1_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: {} } },
    });

    expect(idleSkillsWatcher.close).toHaveBeenCalledTimes(1);
    const evictedVersion = getSkillsSnapshotVersion(idleWorkspaceDir);
    expect(evictedVersion).toBe(firstVersion);
    expect(getSkillsSnapshotVersion()).toBe(globalVersion);
    vi.setSystemTime(new Date(evictedVersion));
    refreshModule.ensureSkillsWatcher({ workspaceDir: idleWorkspaceDir });
    expect(getSkillsSnapshotVersion(idleWorkspaceDir)).toBeGreaterThan(evictedVersion);
  });

  it("keeps another execution subscription for the workspace alive after disposal", async () => {
    vi.useFakeTimers();
    const workspaceDir = fixtureWorkspaceDir;
    const executionWorkspaceDir = await createFixtureDirectory("remaining-worktree");
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir });
    const version = getSkillsSnapshotVersion(workspaceDir);
    const globalVersion = getSkillsSnapshotVersion();
    const watcher = watchForSkillRoot(path.join(workspaceDir, "skills")).watcher;
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { watch: false } } },
    });

    expect(watcher.close).not.toHaveBeenCalled();
    expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    expect(getSkillsSnapshotVersion()).toBe(globalVersion);
    expect(seen).toEqual([]);
    const changedPath = path.join(workspaceDir, "skills", "demo", "SKILL.md");
    watcher.emit("all", "change", changedPath);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([{ workspaceDir, reason: "watch", changedPath }]);
  });

  it("keeps refreshed workspace subscriptions within the idle TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const activeWorkspaceDir = fixtureWorkspaceDir;
    const otherWorkspaceDir = await createFixtureDirectory("workspace-other");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: {} } },
    });
    const activeSkillsWatcher = watchForSkillRoot(path.join(activeWorkspaceDir, "skills")).watcher;

    vi.advanceTimersByTime(30 * 60_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: {} } },
    });
    vi.advanceTimersByTime(31 * 60_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: otherWorkspaceDir,
      config: { skills: { load: {} } },
    });

    expect(activeSkillsWatcher.close).not.toHaveBeenCalled();
  });

  it.each(["execution", "base"] as const)(
    "keeps an idle %s source active while another consumer remains",
    async (scope) => {
      vi.useFakeTimers();
      const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
      const workspaceDir = fixtureWorkspaceDir;
      const executionWorkspaceDir = await createFixtureDirectory("shared-execution");
      const idleScope = {
        executionWorkspaceDir: scope === "execution" ? executionWorkspaceDir : undefined,
      };
      const skillDir = await createFixtureDirectory(
        scope === "execution" ? "shared-execution/skills/demo" : "workspace/skills/demo",
      );
      const skillFile = path.join(skillDir, "SKILL.md");
      await fs.writeFile(
        skillFile,
        "---\nname: demo\ndescription: Demo\n---\nOriginal instructions\n",
      );
      await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
        const options = {
          ...idleScope,
          agentId: "agent-b",
          bundledSkillsDir: "",
          managedSkillsDir: path.join(workspaceDir, "missing-managed"),
        };
        const original = loadWorkspaceSkills(workspaceDir, options)[0]!.skill.contentHash;
        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          ...idleScope,
          agentId: "agent-a",
        });
        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          executionWorkspaceDir,
          agentId: "agent-b",
        });
        vi.advanceTimersByTime(30 * 60_000);
        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          executionWorkspaceDir,
          agentId: "agent-b",
        });
        const sourceVersion = getSkillsSourceVersion(workspaceDir, idleScope);
        vi.advanceTimersByTime(31 * 60_000);
        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          executionWorkspaceDir,
          agentId: "agent-b",
        });
        expect(getSkillsSourceVersion(workspaceDir, idleScope)).toBe(sourceVersion);

        const version = getSkillsSnapshotVersion(workspaceDir);
        await fs.appendFile(skillFile, "\nUpdated instructions\n");
        bumpSkillsSnapshotVersion({ reason: "workshop" });
        expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
        expect(loadWorkspaceSkills(workspaceDir, options)[0]!.skill.contentHash).not.toBe(original);

        vi.advanceTimersByTime(60 * 60_000 + 1_000);
        refreshModule.ensureSkillsWatcher({
          workspaceDir: await createFixtureDirectory("other-active-workspace"),
        });
        const retiredVersion = getSkillsSnapshotVersion(workspaceDir);
        await fs.appendFile(skillFile, "\nInstructions changed while retired\n");
        bumpSkillsSnapshotVersion({ reason: "workshop" });
        expect(getSkillsSnapshotVersion(workspaceDir)).toBe(retiredVersion);

        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          executionWorkspaceDir:
            scope === "base"
              ? await createFixtureDirectory("new-execution-workspace")
              : executionWorkspaceDir,
        });
        expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(retiredVersion);
      });
    },
  );
});
