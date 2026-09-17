import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import * as workerUrls from "./runtime-worker-url.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import {
  inspectSqliteSchemaHeader,
  prepareSqliteReadOnlyLocation,
} from "./sqlite-snapshot-source.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";

const processMocks = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  processMocks.execFile.mockImplementation(actual.execFile);
  Object.defineProperties(processMocks.execFile, Object.getOwnPropertyDescriptors(actual.execFile));
  return { ...actual, execFile: processMocks.execFile };
});

type Worker = { child: ChildProcess; closed: Promise<void>; settled: boolean; stderr: string };
const workers = new Map<string, Worker>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await Promise.all([...workers.values()].map((worker) => worker.closed));
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});
beforeEach(async () => {
  workers.clear();
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  processMocks.execFile.mockReset().mockImplementation((file, args, options, callback) => {
    const child = actual.execFile(file, args, options, callback);
    const marker = args?.indexOf(SQLITE_READONLY_CHILD_ARG) ?? -1;
    const root = args?.[marker + 2];
    if (marker >= 0 && args?.[marker + 1] === "reclaim" && root) {
      const worker: Worker = { child, settled: false, closed: Promise.resolve(), stderr: "" };
      child.stderr?.on("data", (chunk: Buffer | string) => {
        worker.stderr = `${worker.stderr}${String(chunk)}`.slice(-4000);
      });
      worker.closed = new Promise<void>((resolve) => {
        child.once("close", () => {
          worker.settled = true;
          resolve();
        });
      });
      workers.set(path.resolve(root), worker);
    }
    return child;
  });
});

function fixture(count = 3, payloadBytes = 4096) {
  const root = tempDirs.make("sqlite-reclaim-cancellation-");
  const cacheHome = path.join(root, "cache");
  const cache = path.join(cacheHome, "openclaw");
  const source = path.join(root, "source.sqlite");
  const gatePath = path.join(root, "gate.sqlite");
  const marker = path.join(root, "entered.json");
  const harness = path.join(root, "worker.mts");
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(source);
  database.exec(
    "PRAGMA user_version=3; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');",
  );
  database.close();
  const gate = new sqlite.DatabaseSync(gatePath);
  gate.exec("CREATE TABLE gate(value INTEGER); BEGIN IMMEDIATE;");
  fs.mkdirSync(cache, { recursive: true });
  const payload = Buffer.alloc(payloadBytes);
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const roots = Array.from({ length: count }, (_, index) => {
    const parent = path.join(
      cache,
      `openclaw-sqlite-readonly-12345-${String(index).padStart(6, "0")}`,
    );
    const container = path.join(parent, "openclaw");
    const inner = path.join(container, "openclaw-sqlite-readonly-12345-Worker");
    fs.mkdirSync(inner, { recursive: true });
    const copy = path.join(inner, "database.sqlite");
    fs.writeFileSync(copy, payload);
    for (const entry of [copy, inner, container, parent]) {
      fs.utimesSync(entry, stale, stale);
    }
    return parent;
  });
  fs.writeFileSync(
    harness,
    `
    import fs from 'node:fs';
    import path from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    if (process.argv[3] === 'reclaim') {
      const remove = fs.rmSync;
      let entered = false;
      fs.rmSync = (file, options) => {
        const relative = path.relative(path.toNamespacedPath(${JSON.stringify(cache)}), path.toNamespacedPath(path.resolve(String(file))));
        if (!entered && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(String(file)) === 'database.sqlite') {
          entered = true;
          fs.writeFileSync(${JSON.stringify(`${marker}.partial`)}, JSON.stringify({
            claimedRoot: path.join(${JSON.stringify(cache)}, relative.split(path.sep)[0]), file: String(file),
          }));
          fs.renameSync(${JSON.stringify(`${marker}.partial`)}, ${JSON.stringify(marker)});
          const gate = new DatabaseSync(${JSON.stringify(gatePath)});
          try { gate.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE; ROLLBACK;'); }
          finally { gate.close(); }
        }
        return remove(file, options);
      };
    }
    await import(${JSON.stringify(new URL("./sqlite-readonly-location.worker.ts", import.meta.url).href)});
    `,
  );
  vi.stubEnv("XDG_CACHE_HOME", cacheHome);
  vi.spyOn(workerUrls, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(harness));
  let watcher: fs.FSWatcher;
  let timer: ReturnType<typeof setTimeout>;
  const entered = new Promise<{ claimedRoot: string; file: string }>((resolve, reject) => {
    watcher = fs.watch(root, () => {
      if (fs.existsSync(marker)) {
        resolve(JSON.parse(fs.readFileSync(marker, "utf8")));
      }
    });
    watcher.once("error", reject);
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Reclaimer did not reach the directory gate: ${workers.get(path.resolve(cache))?.stderr ?? "no child stderr"}`,
          ),
        ),
      30_000,
    );
  }).finally(() => {
    watcher.close();
    clearTimeout(timer);
  });
  const release = () => {
    if (gate.isTransaction) {
      gate.exec("ROLLBACK");
    }
  };
  return {
    cache,
    source,
    roots,
    entered,
    release,
    worker() {
      const worker = workers.get(path.resolve(cache));
      if (!worker) {
        throw new Error("Reclaim child was not observed");
      }
      return worker;
    },
    close() {
      release();
      gate.close();
      watcher.close();
      clearTimeout(timer);
    },
  };
}

async function readSnapshot(source: string, signal?: AbortSignal): Promise<void> {
  const prepared = await prepareSqliteReadOnlyLocation(source, { signal });
  try {
    const db = new (requireNodeSqlite().DatabaseSync)(prepared.location, { readOnly: true });
    try {
      expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value: "preserved" });
    } finally {
      db.close();
    }
  } finally {
    expect(await prepared.cleanupAsync()).toBe(true);
  }
}

function createOwnedDatabase() {
  const stateDir = tempDirs.make("sqlite-reclaim-owned-state-");
  const bootstrapCache = path.join(stateDir, "bootstrap-cache");
  vi.stubEnv("XDG_CACHE_HOME", bootstrapCache);
  const options = {
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    path: path.join(stateDir, "state", "openclaw.sqlite"),
  };
  openOpenClawStateDatabase(options).db.exec(
    "CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');",
  );
  return { options, bootstrapCache };
}

it("detaches a cancelled snapshot caller while reclamation finishes its directory", async () => {
  for (const mode of ["snapshot", "header", "update", "owned"] as const) {
    const owned = mode === "owned" ? createOwnedDatabase() : undefined;
    const f = mode === "snapshot" ? fixture(64, 4 * 1024 * 1024) : fixture();
    const controller = new AbortController();
    const reason = new DOMException(`${mode} caller stopped`, "AbortError");
    const operation = withSqliteReadOnlyWorkerScope(async () => {
      if (mode === "snapshot") {
        await readSnapshot(f.source, controller.signal);
      } else if (mode === "header") {
        await inspectSqliteSchemaHeader(f.source, { signal: controller.signal });
      } else if (mode === "update") {
        await readUpdateStateSchemaVersions({
          stateDir: path.dirname(f.source),
          config: {},
          signal: controller.signal,
        });
      } else {
        if (!owned) {
          throw new Error("Owned database fixture is unavailable");
        }
        // Cold-open repair must not consume the backlog reserved for the owned snapshot.
        vi.stubEnv("XDG_CACHE_HOME", owned.bootstrapCache);
        const owner = await acquireOpenClawStateDatabaseFileExclusion(owned.options.path);
        try {
          await owner.mutate(owner.assertCurrent, async () => {
            openOpenClawStateDatabase(owned.options);
            vi.stubEnv("XDG_CACHE_HOME", path.dirname(f.cache));
            await readSnapshot(owned.options.path, controller.signal);
          });
        } finally {
          owner.release();
        }
      }
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      const entered = await f.entered;
      const started = performance.now();
      controller.abort(reason);
      const error = await operation;
      const cancellationMs = performance.now() - started;
      const workerWasRunning = !f.worker().settled;
      const directoryWasPresent = fs.existsSync(entered.file);
      f.release();
      await f.worker().closed;
      console.log(JSON.stringify({ mode, cancellationMs }));
      expect(error).toBe(reason);
      expect(error).toMatchObject({ name: "AbortError" });
      expect.soft(cancellationMs, mode).toBeLessThan(250);
      expect.soft(workerWasRunning, mode).toBe(true);
      expect.soft(directoryWasPresent, mode).toBe(true);
      expect(fs.existsSync(entered.claimedRoot)).toBe(false);
    } finally {
      controller.abort(reason);
      f.release();
      await operation;
      await workers.get(path.resolve(f.cache))?.closed;
      f.close();
    }
  }
});

it("keeps a shared reclamation pass alive for another snapshot caller", async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error("first snapshot caller stopped");
  const first = withSqliteReadOnlyWorkerScope(() => readSnapshot(f.source, controller.signal)).then(
    () => undefined,
    (error: unknown) => error,
  );
  let second: Promise<void> | undefined;
  try {
    await f.entered;
    let secondSettled = false;
    second = readSnapshot(f.source).finally(() => {
      secondSettled = true;
    });
    const started = performance.now();
    controller.abort(reason);
    const error = await first;
    const cancellationMs = performance.now() - started;
    const workerWasRunning = !f.worker().settled;
    const survivorWasPending = !secondSettled;
    f.release();
    await second;
    await f.worker().closed;
    console.log(JSON.stringify({ sharedCancellationMs: cancellationMs }));
    expect(error).toBe(reason);
    expect(cancellationMs).toBeLessThan(250);
    expect(workerWasRunning).toBe(true);
    expect(survivorWasPending).toBe(true);
    expect(f.worker().child.exitCode).toBe(0);
    expect(f.worker().child.signalCode).toBeNull();
    expect(fs.readdirSync(f.cache)).toEqual([]);
  } finally {
    controller.abort(reason);
    f.release();
    await Promise.allSettled([first, second]);
    await workers.get(path.resolve(f.cache))?.closed;
    f.close();
  }
});

it("stops an unobserved reclamation pass at the next directory boundary", async () => {
  const f = fixture();
  const controllers = [new AbortController(), new AbortController()] as const;
  const first = readSnapshot(f.source, controllers[0].signal).catch((error: unknown) => error);
  let second: Promise<unknown> | undefined;
  try {
    const entered = await f.entered;
    const untouched = f.roots.filter((root) => fs.existsSync(root));
    expect(untouched).toHaveLength(f.roots.length - 1);
    second = readSnapshot(f.source, controllers[1].signal).catch((error: unknown) => error);
    for (const controller of controllers) {
      controller.abort();
    }
    const errors = await Promise.all([first, second]);
    f.release();
    await f.worker().closed;
    expect(errors).toEqual(controllers.map((controller) => controller.signal.reason));
    expect(f.worker().child.exitCode).toBe(0);
    expect(f.worker().child.signalCode).toBeNull();
    expect(fs.existsSync(entered.claimedRoot)).toBe(false);
    expect(f.roots.filter((root) => fs.existsSync(root))).toEqual(untouched);
    for (const root of untouched) {
      expect(fs.readdirSync(root)).toEqual(["openclaw"]);
    }
    await readSnapshot(f.source);
    await f.worker().closed;
    expect(fs.readdirSync(f.cache)).toEqual([]);
  } finally {
    for (const controller of controllers) {
      controller.abort();
    }
    f.release();
    await Promise.allSettled([first, second]);
    await workers.get(path.resolve(f.cache))?.closed;
    f.close();
  }
});
