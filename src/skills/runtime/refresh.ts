import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import chokidar, { type FSWatcher } from "chokidar";
import { isDefaultStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRealpathOrAbsolute } from "../../infra/boundary-path.js";
import { getFileWatchCapacityCode } from "../../infra/fs-watch-errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import {
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata,
} from "../loading/plugin-skills.js";
import {
  resolveAllowedSkillSymlinkTargetRealPaths,
  tryRealpath,
} from "../loading/symlink-targets.js";
import {
  normalizeWorkspaceSkillRoots,
  resolveWorkspaceSkillDirectories,
} from "../loading/workspace-skill-roots.js";
import { resolveWorkshopWatchRoots } from "../workshop/skills-root.js";
import { areOrderedArraysEqual } from "./ordered-array-equality.js";
import { createRawSkillFileScheduler } from "./refresh-file-stability.js";
import {
  bumpSkillsSnapshotVersion,
  markSkillsSupportingFilesChanged,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
  suspendSkillsSnapshotSources,
  type SkillsSourceScope,
} from "./refresh-state.js";
import { joinSkillsWatcherCloses, teardownSkillsPathWatcher } from "./refresh-watch-close.js";
import {
  createSkillsWatchPathFilter,
  DEFAULT_SKILLS_WATCH_IGNORED,
  getRawWatchedPath,
  isSkillDiscoveryFileWatchPath,
  isTrustedSymlinkSkillTarget,
  rawPathToString,
  readBudgetedDirEntries,
  resolveRawSkillsWatchPath,
  makeSkillsWatchTarget,
  resolveSkillsWatcherUsePolling,
  toWatchRoot,
} from "./refresh-watch-path.js";
export { registerSkillsChangeListener } from "./refresh-state.js";

type SkillsWatchChange = "skills" | "supporting";
type SkillsPathWatchState = {
  watcher: FSWatcher;
  watchRoot: string;
  depth: number;
  initialScan: "pending" | "ready" | "error";
  timer?: ReturnType<typeof setTimeout>;
  pendingPath?: string;
  pendingChange?: SkillsWatchChange;
  readonly subscribers: Set<string>;
};

type WatchTarget = {
  path: string;
  watchRoot: string;
  depth: number;
  executionOnly?: true;
};

type WatchTargetCacheEntry = {
  signature: string;
  targets: WatchTarget[];
};

const log = createSubsystemLogger("gateway/skills");
// Gateway startup imports this owner before serving turns. Shared watcher handles,
// including later rebuilds, must inherit that lifetime rather than the triggering turn.
const runInSkillsWatcherContext = AsyncLocalStorage.snapshot();
const GROUPED_SKILLS_WATCH_DEPTH = 6;
const CONFIGURED_ROOT_WATCH_DEPTH = 2;
const MAX_SYMLINK_WATCH_TARGETS_PER_ROOT = 100;
const MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT = 200;
const MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT = 2_000;
const SKILLS_WATCH_DEBOUNCE_MS = 250;
// One watcher per unique watched directory. Agent workspaces that include the
// same shared skill root (the global skills dir, the home skills dir, or a
// configured extra/plugin dir) subscribe to the same watcher instead of each
// opening its own, so open file descriptors scale with distinct directories
// rather than with agent count.
const pathWatchers = new Map<string, SkillsPathWatchState>();
let nativeWatchCapacityFailed = false;
// Watch targets each workspace is currently subscribed to, used to reconcile
// subscriptions and to detect watch-target changes across calls.
const workspaceWatchTargets = new Map<string, WatchTarget[]>();
// A watcher key may include an execution root, but refresh events and versions
// retain the configured agent workspace as their stable public identity.
const workspaceWatchOwners = new Map<
  string,
  { workspaceDir: string; sourceScope: SkillsSourceScope; sharedScanPending: boolean }
>();
// Resolved nested skill watch roots are filesystem-derived. Cache them so the
// per-turn watcher reconciliation path stays cheap until config or watched
// filesystem changes require a fresh root scan.
const workspaceWatchTargetCache = new Map<string, WatchTargetCacheEntry>();
const workspaceWatchLastEnsuredAt = new Map<string, number>();
// Session turns re-ensure their workspace; entries older than this are treated
// as abandoned subscriptions and evicted by the next ensure call.
const SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS = 60 * 60_000;
const MAX_SKILLS_WORKSPACE_WATCH_STATES = 128;

setSkillsChangeListenerErrorHandler((err) => {
  log.warn(`skills change listener failed: ${String(err)}`);
});

function resolveWatchTargets(
  workspaceDir: string,
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
  executionWorkspaceDir: string | undefined,
  watcherKey: string,
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined,
): WatchTarget[] {
  const baseRoots = resolveWorkspaceSkillDirectories(workspaceDir).map(({ dir, source }) => ({
    path: dir,
    source,
  }));
  const executionRoots = executionWorkspaceDir
    ? resolveWorkspaceSkillDirectories(executionWorkspaceDir)
    : [];
  baseRoots.push(...resolveWorkshopWatchRoots(config, agentId));
  baseRoots.push({ path: path.join(CONFIG_DIR, "skills"), source: "openclaw-managed" });
  if (isDefaultStateDir()) {
    baseRoots.push({
      path: path.join(os.homedir(), ".agents", "skills"),
      source: "agents-skills-personal",
    });
  }
  const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => normalizeOptionalString(d) ?? "")
    .filter(Boolean)
    .map((dir) => resolveUserPath(dir));
  const pluginSkillRoots = pluginMetadataSnapshot
    ? resolvePluginSkillRootsFromMetadata({
        workspaceDir,
        config,
        metadataSnapshot: pluginMetadataSnapshot,
      })
    : resolvePluginSkillRoots({ workspaceDir, config });
  const pluginSkillDirs = pluginSkillRoots.map((root) => root.dir);
  const allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(config);
  const signature = JSON.stringify({
    basePaths: baseRoots.map((root) => toWatchRoot(root.path)),
    executionPaths: executionRoots.map((root) => toWatchRoot(root.dir)),
    extraDirs: extraDirs.map(toWatchRoot),
    pluginSkillDirs: pluginSkillDirs.map(toWatchRoot),
    allowSymlinkTargets: allowedSymlinkTargetRealPaths,
  });
  const cached = workspaceWatchTargetCache.get(watcherKey);
  if (cached?.signature === signature) {
    return cached.targets;
  }

  const targets = new Map<string, WatchTarget>();
  for (const root of baseRoots) {
    addSkillSourceWatchTargets(
      targets,
      root.path,
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
    );
  }
  for (const resolved of extraDirs) {
    addSkillSourceWatchTargets(targets, resolved, "openclaw-extra", allowedSymlinkTargetRealPaths);
  }
  for (const dir of pluginSkillDirs) {
    addSkillSourceWatchTargets(targets, dir, "openclaw-plugin", allowedSymlinkTargetRealPaths);
  }
  const executionTargets = new Map<string, WatchTarget>();
  for (const root of executionRoots) {
    addSkillSourceWatchTargets(
      executionTargets,
      root.dir,
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
    );
  }
  for (const [key, target] of executionTargets) {
    const shared = targets.get(key);
    if (shared) {
      shared.depth = Math.max(shared.depth, target.depth);
    } else {
      targets.set(key, { ...target, executionOnly: true });
    }
  }
  const sortedTargets = Array.from(targets.values()).toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  workspaceWatchTargetCache.set(watcherKey, { signature, targets: sortedTargets });
  return sortedTargets;
}

function addWatchTarget(targets: Map<string, WatchTarget>, raw: string, depth: number): void {
  const target = makeSkillsWatchTarget(raw, depth);
  target.depth = Math.max(target.depth, targets.get(target.path)?.depth ?? 0);
  targets.set(target.path, target);
}

function addSkillRootWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  rootDepth: number,
): string {
  addWatchTarget(targets, root, rootDepth);
  const companionSkillsRoot = path.join(root, "skills");
  addWatchTarget(targets, companionSkillsRoot, GROUPED_SKILLS_WATCH_DEPTH);
  return companionSkillsRoot;
}

function addSkillSourceWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  source: string,
  allowedSymlinkTargetRealPaths: readonly string[],
  rootDepth = path.basename(root) === "skills"
    ? GROUPED_SKILLS_WATCH_DEPTH
    : CONFIGURED_ROOT_WATCH_DEPTH,
): void {
  const companionSkillsRoot = addSkillRootWatchTargets(targets, root, rootDepth);
  // Both bounded scans share the source's containment identity for this preparation.
  // Trusted symlink leaves below remain registration-only, never recursive scans.
  const rootRealPath = resolveRealpathOrAbsolute(root);
  addTrustedSymlinkSkillWatchTargets(
    targets,
    root,
    source,
    allowedSymlinkTargetRealPaths,
    rootDepth,
    rootRealPath,
    rootRealPath,
  );
  addTrustedSymlinkSkillWatchTargets(
    targets,
    companionSkillsRoot,
    source,
    allowedSymlinkTargetRealPaths,
    GROUPED_SKILLS_WATCH_DEPTH,
    rootRealPath,
    resolveRealpathOrAbsolute(companionSkillsRoot),
  );
}

function addTrustedSymlinkSkillWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  source: string,
  allowedSymlinkTargetRealPaths: readonly string[],
  maxDepth: number,
  containmentRootRealPath: string,
  rootRealPath: string,
): void {
  try {
    if (
      fs.lstatSync(root).isSymbolicLink() &&
      isTrustedSymlinkSkillTarget(
        source,
        containmentRootRealPath,
        rootRealPath,
        allowedSymlinkTargetRealPaths,
      )
    ) {
      addSkillRootWatchTargets(targets, rootRealPath, maxDepth);
    }
  } catch {
    return;
  }
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let watched = 0;
  let directoryScans = 0;
  let rawEntries = 0;
  for (const queued of queue) {
    if (
      watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT ||
      directoryScans >= MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT ||
      rawEntries >= MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT
    ) {
      break;
    }
    const current = queued;
    if (!current) {
      continue;
    }
    const scan = readBudgetedDirEntries(
      current.dir,
      MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT - rawEntries,
    );
    directoryScans += 1;
    rawEntries += scan.scannedEntryCount;
    if (!scan.ok) {
      continue;
    }
    for (const entry of scan.entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT) {
        break;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const childPath = path.join(current.dir, entry.name);
      if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(childPath))) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        const targetRealPath = tryRealpath(childPath);
        if (
          targetRealPath &&
          isTrustedSymlinkSkillTarget(
            source,
            containmentRootRealPath,
            targetRealPath,
            allowedSymlinkTargetRealPaths,
          )
        ) {
          addSkillRootWatchTargets(targets, targetRealPath, GROUPED_SKILLS_WATCH_DEPTH);
          watched += 1;
        }
        continue;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: childPath, depth: current.depth + 1 });
      }
    }
  }
}

function createSkillsPathWatcher(target: WatchTarget): SkillsPathWatchState {
  const usePolling = resolveSkillsWatcherUsePolling();
  const pathFilter = createSkillsWatchPathFilter(target.path, usePolling);
  // Chokidar's missing-root fallback retains only the final basename, so it
  // misses creation through multiple absent parents. Watch the existing prefix
  // and restrict traversal to the logical root and its ancestor chain.
  const watcher = runInSkillsWatcherContext(() =>
    chokidar.watch(target.watchRoot, {
      ignoreInitial: true,
      followSymlinks: false,
      usePolling,
      // Observe every discovered skill plus its identity metadata directory,
      // which sits one level below the deepest admitted skill directory.
      depth:
        target.depth +
        1 +
        path.relative(target.watchRoot, target.path).split(path.sep).filter(Boolean).length,
      awaitWriteFinish: {
        stabilityThreshold: SKILLS_WATCH_DEBOUNCE_MS,
        pollInterval: 100,
      },
      ignored: pathFilter.ignored,
    }),
  );

  const state: SkillsPathWatchState = {
    watcher,
    watchRoot: target.watchRoot,
    depth: target.depth,
    initialScan: "pending",
    subscribers: new Set<string>(),
  };

  const publishChanges = (
    watcherKeys: Iterable<string>,
    changedPath?: string,
    change: SkillsWatchChange | "initial-scan" = "skills",
  ) => {
    const initialScan = change === "initial-scan";
    const affected = new Map<string, SkillsSourceScope[] | undefined>();
    for (const watcherKey of watcherKeys) {
      if (change !== "supporting") {
        workspaceWatchTargetCache.delete(watcherKey);
      }
      const owner = workspaceWatchOwners.get(watcherKey);
      if (!owner) {
        continue;
      }
      const shared = initialScan
        ? owner.sharedScanPending
        : workspaceWatchTargets.get(watcherKey)?.find((entry) => entry.path === target.path)
            ?.executionOnly !== true;
      if (initialScan) {
        owner.sharedScanPending &&= (workspaceWatchTargets.get(watcherKey) ?? []).some(
          (entry) => !entry.executionOnly && pathWatchers.get(entry.path)?.initialScan !== "ready",
        );
      }
      if (shared) {
        affected.set(owner.workspaceDir, undefined);
        continue;
      }
      if (affected.has(owner.workspaceDir) && !affected.get(owner.workspaceDir)) {
        continue;
      }
      const scopes = affected.get(owner.workspaceDir) ?? [];
      scopes.push(owner.sourceScope);
      affected.set(owner.workspaceDir, scopes);
    }
    for (const [workspaceDir, sourceScopes] of affected) {
      if (change === "supporting") {
        markSkillsSupportingFilesChanged({ workspaceDir, sourceScopes });
      } else {
        bumpSkillsSnapshotVersion({ workspaceDir, sourceScopes, reason: "watch", changedPath });
      }
    }
  };
  const settleInitialScan = (result: "ready" | "error") => {
    if (
      watcher.closed ||
      pathWatchers.get(target.path) !== state ||
      state.initialScan === "ready" ||
      state.initialScan === result
    ) {
      return;
    }
    state.initialScan = result;
    const readySubscribers: string[] = [];
    for (const watcherKey of state.subscribers) {
      const targets = workspaceWatchTargets.get(watcherKey);
      if (
        targets?.every((entry) => {
          const current = pathWatchers.get(entry.path);
          return current && !current.watcher.closed && current.initialScan !== "pending";
        })
      ) {
        readySubscribers.push(watcherKey);
      }
    }
    publishChanges(readySubscribers, undefined, "initial-scan");
  };

  const schedule = (changedPath?: string, change: SkillsWatchChange = "skills") => {
    // File-stability work may finish after this subscription has been closed.
    if (watcher.closed || (change === "supporting" && state.pendingChange === "skills")) {
      return;
    }
    state.pendingPath = changedPath ?? state.pendingPath;
    state.pendingChange = change;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const pendingPath = state.pendingPath;
      const pendingChange = state.pendingChange;
      state.pendingPath = undefined;
      state.pendingChange = undefined;
      state.timer = undefined;
      // Fan the change out to every workspace subscribed to this directory so a
      // shared skill root refreshes the snapshot for all agents that use it.
      publishChanges(state.subscribers, pendingPath, pendingChange);
    }, SKILLS_WATCH_DEBOUNCE_MS);
  };
  const scheduleRawSkillFile = createRawSkillFileScheduler({
    watcher,
    stabilityMs: SKILLS_WATCH_DEBOUNCE_MS,
    schedule,
    onError: (changedPath, err) => {
      log.warn(`skills watcher stability check failed (${changedPath}): ${String(err)}`);
    },
  });

  // ignoreInitial suppresses writes discovered before native watches are ready.
  // Reconcile the whole workspace once its initial scans finish, rather than
  // rebuilding metadata for every root that becomes ready.
  watcher.on("ready", () => settleInitialScan("ready"));
  watcher.on("all", (event, changedPath) => {
    const skillsRelevant = pathFilter.isRelevant(event, changedPath);
    if (skillsRelevant || pathFilter.isSupportingPath(changedPath)) {
      schedule(changedPath, skillsRelevant ? "skills" : "supporting");
    }
  });
  watcher.on("raw", (_eventName, rawPath, details) => {
    const rawPathText = rawPathToString(rawPath);
    if (!rawPathText) {
      const watchedPath = getRawWatchedPath(details);
      if (watchedPath && isPathInside(target.path, watchedPath)) {
        // Native filename loss can conceal a skill edit; content reconciliation decides.
        schedule(watchedPath);
      }
      return;
    }
    const changedPath = resolveRawSkillsWatchPath(rawPathText, details);
    if (
      changedPath &&
      isSkillDiscoveryFileWatchPath(changedPath) &&
      isPathInside(target.path, changedPath)
    ) {
      if (usePolling) {
        return;
      }
      scheduleRawSkillFile(changedPath);
    } else if (changedPath && pathFilter.isSupportingPath(changedPath)) {
      schedule(changedPath, "supporting");
    }
  });
  watcher.on("error", (err) => {
    if (watcher.closed) {
      return;
    }
    const capacityCode = usePolling ? undefined : getFileWatchCapacityCode(err);
    if (capacityCode) {
      if (!nativeWatchCapacityFailed) {
        nativeWatchCapacityFailed = true;
        log.warn(
          `skills native watcher capacity exhausted (${capacityCode}); refreshing skills during agent preparation`,
        );
        for (const active of pathWatchers.values()) {
          void teardownSkillsPathWatcher(active);
        }
      }
      return;
    }
    log.warn(`skills watcher error (${target.path}): ${String(err)}`);
    // A failed scan may never emit ready. Let healthy roots reconcile; if the
    // failed scan continues, its eventual ready still closes that read gap.
    settleInitialScan("error");
  });

  return state;
}

function subscribeWorkspaceToPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const existing = pathWatchers.get(watchTarget.path);
  if (
    existing &&
    existing.watchRoot === watchTarget.watchRoot &&
    existing.depth >= watchTarget.depth
  ) {
    existing.subscribers.add(workspaceDir);
    return;
  }
  if (existing) {
    // A changed ancestor or deeper target needs a rebuilt watcher, preserving subscribers.
    const next = createSkillsPathWatcher({
      ...watchTarget,
      depth: Math.max(existing.depth, watchTarget.depth),
    });
    for (const subscriber of existing.subscribers) {
      next.subscribers.add(subscriber);
      const owner = workspaceWatchOwners.get(subscriber);
      if (
        owner &&
        workspaceWatchTargets
          .get(subscriber)
          ?.some((target) => target.path === watchTarget.path && !target.executionOnly)
      ) {
        owner.sharedScanPending = true;
      }
    }
    next.subscribers.add(workspaceDir);
    void teardownSkillsPathWatcher(existing);
    pathWatchers.set(watchTarget.path, next);
    return;
  }
  const state = createSkillsPathWatcher(watchTarget);
  state.subscribers.add(workspaceDir);
  pathWatchers.set(watchTarget.path, state);
}

function unsubscribeWorkspaceFromPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const state = pathWatchers.get(watchTarget.path);
  if (!state) {
    return;
  }
  state.subscribers.delete(workspaceDir);
  if (state.subscribers.size === 0) {
    void teardownSkillsPathWatcher(state);
    pathWatchers.delete(watchTarget.path);
  }
}

function disposeWorkspaceWatchState(
  watcherKey: string,
  watchTargets: readonly WatchTarget[] = workspaceWatchTargets.get(watcherKey) ?? [],
): void {
  for (const watchTarget of watchTargets) {
    unsubscribeWorkspaceFromPath(watcherKey, watchTarget);
  }
  workspaceWatchTargets.delete(watcherKey);
  workspaceWatchOwners.delete(watcherKey);
  workspaceWatchTargetCache.delete(watcherKey);
  workspaceWatchLastEnsuredAt.delete(watcherKey);
  // Reacquisition invalidates after an unwatched interval. Disposal itself does
  // not change skills, including for other subscriptions sharing this workspace.
}

function evictWorkspaceWatchStates(now: number): void {
  const evict = (watcherKey: string) => {
    const owner = workspaceWatchOwners.get(watcherKey);
    disposeWorkspaceWatchState(watcherKey);
    if (!owner) {
      return;
    }
    const remainingOwners = Array.from(workspaceWatchOwners.values()).filter(
      (other) => other.workspaceDir === owner.workspaceDir,
    );
    if (remainingOwners.length === 0) {
      suspendSkillsSnapshotSources(owner.workspaceDir, {});
    }
    if (
      owner.sourceScope.executionWorkspaceDir &&
      !remainingOwners.some(
        (other) =>
          other.sourceScope.executionWorkspaceDir === owner.sourceScope.executionWorkspaceDir,
      )
    ) {
      suspendSkillsSnapshotSources(owner.workspaceDir, owner.sourceScope);
    }
  };
  const cutoff = now - SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS;
  for (const [watcherKey, lastEnsuredAt] of workspaceWatchLastEnsuredAt) {
    if (lastEnsuredAt < cutoff) {
      evict(watcherKey);
    }
  }
  for (const watcherKey of workspaceWatchLastEnsuredAt.keys()) {
    if (workspaceWatchLastEnsuredAt.size <= MAX_SKILLS_WORKSPACE_WATCH_STATES) {
      break;
    }
    evict(watcherKey);
  }
}

export function ensureSkillsWatcher(params: {
  workspaceDir: string;
  executionWorkspaceDir?: string;
  config?: OpenClawConfig;
  agentId?: string;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}) {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return;
  }
  const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: params.executionWorkspaceDir,
  });
  const watcherKey = JSON.stringify([workspaceDir, executionWorkspaceDir, params.agentId]);
  const sourceScope = { executionWorkspaceDir };
  const owner = {
    workspaceDir,
    sourceScope,
    sharedScanPending: workspaceWatchOwners.get(watcherKey)?.sharedScanPending ?? false,
  };
  workspaceWatchOwners.set(watcherKey, owner);
  const refreshInputs = {
    sourceScope,
    config: params.config,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
  };
  const now = Date.now();
  const watchEnabled = params.config?.skills?.load?.watch !== false;
  const previousTargets = workspaceWatchTargets.get(watcherKey) ?? [];

  if (!watchEnabled) {
    disposeWorkspaceWatchState(watcherKey, previousTargets);
    evictWorkspaceWatchStates(now);
    return;
  }

  // Map order breaks equal-clock ties and promotes reuse without adding a generation.
  workspaceWatchLastEnsuredAt.delete(watcherKey);
  workspaceWatchLastEnsuredAt.set(watcherKey, now);
  evictWorkspaceWatchStates(now);
  if (nativeWatchCapacityFailed) {
    // Reconcile file-backed sources during preparation while native observation
    // is unavailable, without reopening watches.
    workspaceWatchTargetCache.delete(watcherKey);
    bumpSkillsSnapshotVersion({ workspaceDir, refreshInputs, reason: "watch" });
    return;
  }
  const watchTargets = resolveWatchTargets(
    workspaceDir,
    params.config,
    params.agentId,
    executionWorkspaceDir,
    watcherKey,
    params.pluginMetadataSnapshot,
  );
  // resolveWatchTargets returns stable sorted order, so positional equality is intentional.
  const targetsMatch = (previous: WatchTarget, next: WatchTarget) =>
    previous.path === next.path &&
    previous.watchRoot === next.watchRoot &&
    previous.depth === next.depth &&
    previous.executionOnly === next.executionOnly;
  const targetsUnchanged = areOrderedArraysEqual(previousTargets, watchTargets, targetsMatch);
  const watcherDepthsCoverTargets = watchTargets.every(
    (watchTarget) => (pathWatchers.get(watchTarget.path)?.depth ?? -1) >= watchTarget.depth,
  );
  if (targetsUnchanged && watcherDepthsCoverTargets) {
    return;
  }
  const coveredTargets = previousTargets.length
    ? previousTargets
    : Array.from(workspaceWatchOwners).flatMap(([key, other]) =>
        other.workspaceDir === workspaceDir ? (workspaceWatchTargets.get(key) ?? []) : [],
      );
  const sharedTargetsChanged =
    watchTargets.some(
      (target) =>
        !target.executionOnly && !coveredTargets.some((previous) => targetsMatch(previous, target)),
    ) ||
    previousTargets.some(
      (previous) =>
        !previous.executionOnly && !watchTargets.some((target) => targetsMatch(previous, target)),
    );
  const nextTargetKeys = new Set(watchTargets.map((target) => target.path));
  for (const watchTarget of previousTargets) {
    if (!nextTargetKeys.has(watchTarget.path)) {
      unsubscribeWorkspaceFromPath(watcherKey, watchTarget);
    }
  }
  for (const watchTarget of watchTargets) {
    subscribeWorkspaceToPath(watcherKey, watchTarget);
  }
  workspaceWatchTargets.set(watcherKey, watchTargets);
  owner.sharedScanPending ||= watchTargets.some(
    (target) => !target.executionOnly && pathWatchers.get(target.path)?.initialScan !== "ready",
  );

  // Acquisition must invalidate reads cached during an unwatched interval,
  // before the first consumer runs or the asynchronous initial scan completes.
  if (!targetsUnchanged) {
    bumpSkillsSnapshotVersion({
      workspaceDir,
      sourceScopes: sharedTargetsChanged ? undefined : [sourceScope],
      refreshInputs,
      reason: "watch-targets",
      changedPath: watchTargets.map((target) => target.path).join("|"),
    });
  }
}

export async function closeSkillsWatchers(resetState = false): Promise<void> {
  if (resetState) {
    resetSkillsRefreshStateForTest();
  }
  const active = Array.from(pathWatchers.values());
  nativeWatchCapacityFailed = false;
  pathWatchers.clear();
  workspaceWatchTargets.clear();
  workspaceWatchOwners.clear();
  workspaceWatchTargetCache.clear();
  workspaceWatchLastEnsuredAt.clear();
  for (const state of active) {
    void teardownSkillsPathWatcher(state);
  }
  await joinSkillsWatcherCloses();
}
