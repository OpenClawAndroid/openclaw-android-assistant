import { serveWorkerTasks } from "openclaw/plugin-sdk/process-runtime";
import type { MemoryIndexTask, MemoryIndexTaskResult } from "./manager-cpu-worker-runtime.js";
import { prepareMemoryIndexChunks } from "./manager-index-preparation.js";

serveWorkerTasks<MemoryIndexTaskResult>(async (input, channel) => {
  // SAFETY: The paired runtime owns this private discriminated task protocol.
  const task = input as MemoryIndexTask;
  if (task.kind === "prepare") {
    return { kind: "prepared", value: prepareMemoryIndexChunks(task.input) };
  }
  if (task.kind !== "replace-session" || !channel) {
    throw new Error("Invalid memory indexing task");
  }
  const { replaceMemoryShadowSession } = await import("./manager-shadow-write.js");
  const result = await replaceMemoryShadowSession(task);
  // Normal Node cleanup has closed the database. Failed cleanup never reaches
  // this receipt; Bun requires native Worker exit even after a successful close.
  if (result.kind === "session-replaced" && !process.versions.bun) {
    channel.consumeInput();
  }
  return result;
});
