import type { FSWatcher } from "chokidar";

// Retired roots leave the watcher registry before their asynchronous native closes settle.
const pendingWatcherCloses = new Set<Promise<void>>();

export function teardownSkillsPathWatcher(state: {
  watcher: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
}): Promise<void> {
  clearTimeout(state.timer);
  const closing = (async () => {
    try {
      const wasClosed = state.watcher.closed;
      const closed = state.watcher.close();
      if (!wasClosed) {
        // Chokidar removes listeners before pending scans settle. Their late errors
        // belong to the retired watcher and must not become unhandled events.
        state.watcher.on("error", () => {});
      }
      await closed;
    } catch {
      // Closing watchers is best effort, including during replacement and shutdown.
    }
  })();
  pendingWatcherCloses.add(closing);
  void closing.then(() => pendingWatcherCloses.delete(closing));
  return closing;
}

export async function joinSkillsWatcherCloses(): Promise<void> {
  await Promise.all(pendingWatcherCloses);
}
