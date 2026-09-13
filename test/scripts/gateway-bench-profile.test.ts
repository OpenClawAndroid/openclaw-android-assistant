import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { controlGatewayProfile } from "../../scripts/lib/gateway-bench-profile.js";

const workload = `
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const keepAlive = setInterval(() => {}, 1000);
process.once('disconnect', () => clearInterval(keepAlive));
let worker, idle;
function createWorker() {
    worker = new Worker(\`
      const { parentPort } = require('node:worker_threads');
      let total = 0;
      function allocateForProfile() {
        const until = Date.now() + 500;
        while (Date.now() < until) {
          const rows = Array.from({length: 10000}, (_, i) => ({i, values: [i, i + 1]}));
          total += rows[rows.length - 1].values[1];
        }
        parentPort.postMessage(total);
      }
      parentPort.on('message', allocateForProfile);
    \`, {eval: true, execArgv: []});
    worker.once('message', () => process.send({complete: true, threadId: worker.threadId}));
}
process.on('message', (message) => {
  if (message.prepare) {
    idle = new Worker('setInterval(() => {}, 1000)', {eval: true, execArgv: []});
    createWorker();
    Promise.all([once(idle, 'online'), once(worker, 'online')]).then(() => process.send({prepared: true}));
  }
  if (message.run) {
    if (worker) worker.postMessage('run');
    else {
      createWorker();
      worker.once('online', () => worker.postMessage('run'));
    }
  }
  if (message.retire) Promise.all([worker, idle].filter(Boolean).map(w => w.terminate()))
    .then(() => process.send({retired: true}));
});
(async () => {
  // A retired worker consumes a native ID before the inspector allocates any target IDs.
  const retired = new Worker('', {eval: true, execArgv: []});
  await once(retired, 'exit');
  await import(process.argv[1]);
  process.send({ready: true});
})();
`;

async function waitMessage(child: ChildProcess, field: string) {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", finish);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onMessage = (message: Record<string, unknown>) => {
      if (message[field]) {
        finish();
      }
    };
    const onExit = () => finish(new Error(`Profile fixture exited before ${field}`));
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", finish);
  });
}

it.each([
  ["cpu", false],
  ["heap", false],
  ["cpu", true],
  ["heap", true],
] as const)(
  "maps %s profiles to native workers with preexisting=%s and records retirement",
  async (kind, preexisting) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-worker-profile-"));
    const profilePath = path.join(directory, kind);
    const child = spawn(
      process.execPath,
      [
        "-e",
        workload,
        new URL("../../scripts/lib/gateway-bench-profile-preload.ts", import.meta.url).href,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    try {
      await waitMessage(child, "ready");
      if (preexisting) {
        const prepared = waitMessage(child, "prepared");
        child.send({ prepare: true });
        await prepared;
      }
      await controlGatewayProfile(child, kind, "start", profilePath, { includeWorkers: true });
      const complete = once(child, "message");
      child.send({ run: true });
      const [completed] = await complete;
      expect(completed.complete).toBe(true);
      await controlGatewayProfile(child, kind, "stop", profilePath, { includeWorkers: true });
      const manifest = JSON.parse(await readFile(`${profilePath}.workers.json`, "utf8"));
      expect(manifest.workers).toHaveLength(preexisting ? 2 : 1);
      let profiledThreadId: number | undefined;
      for (const recording of manifest.workers) {
        expect(recording).toMatchObject({
          completed: true,
          inspectorWorkerId: expect.any(String),
          threadId: expect.any(Number),
        });
        const profile = await readFile(recording.profilePath, "utf8");
        if (profile.includes("allocateForProfile")) {
          profiledThreadId = recording.threadId;
        }
      }
      expect(profiledThreadId).toBe(completed.threadId);
      expect(
        manifest.samples.some((sample: { workers: Array<{ threadId: number }> }) =>
          sample.workers.some((worker) => worker.threadId === completed.threadId),
        ),
      ).toBe(true);
      expect(await readFile(profilePath, "utf8")).not.toBe("");

      const retiredPath = path.join(directory, `${kind}-retired`);
      await controlGatewayProfile(child, kind, "start", retiredPath, { includeWorkers: true });
      const retired = waitMessage(child, "retired");
      child.send({ retire: true });
      await retired;
      await controlGatewayProfile(child, kind, "stop", retiredPath, { includeWorkers: true });
      const incomplete = JSON.parse(await readFile(`${retiredPath}.workers.json`, "utf8"));
      for (const recording of incomplete.workers) {
        expect(recording.completed).not.toBe(true);
        expect(recording.error).toBeTruthy();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
