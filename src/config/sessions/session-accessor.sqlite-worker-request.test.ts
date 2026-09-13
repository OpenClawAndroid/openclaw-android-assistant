import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import { runSqliteMutationWorkerRequest } from "./session-accessor.sqlite-worker-request.js";

test("runs reused Worker request callbacks in the requesting operation context", async () => {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     parentPort.postMessage({ type: "commit-request", operationId: 7 });
     parentPort.postMessage({ type: "reclaimed", operationId: 7, result: "done", settled: true });`,
    { eval: true, execArgv: [] },
  );
  const owner = new AsyncLocalStorage<string>();
  const observed: Array<{ event: string; owner: string | undefined }> = [];
  try {
    await expect(
      owner.run("request-7", () =>
        runSqliteMutationWorkerRequest({
          worker,
          operationId: 7,
          completion: "exit",
          onCommitRequest: () => {
            observed.push({ event: "message", owner: owner.getStore() });
          },
          onExit: () => {
            observed.push({ event: "exit", owner: owner.getStore() });
          },
          withWriteAdmission: async () => {
            throw new Error("Synthetic Worker must not request write admission");
          },
        }),
      ),
    ).resolves.toBe("done");
    expect(observed).toEqual([
      { event: "message", owner: "request-7" },
      { event: "exit", owner: "request-7" },
    ]);
  } finally {
    await worker.terminate();
  }
});
