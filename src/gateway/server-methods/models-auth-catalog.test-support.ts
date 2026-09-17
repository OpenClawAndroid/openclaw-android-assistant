import { channel } from "node:diagnostics_channel";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getPreparedModelCatalogWorkerPoolSnapshot } from "../../agents/prepared-model-catalog-worker.js";

/** Observe the real catalog pool without replacing its worker or provider requests. */
export function observeCatalogWorkerTasks() {
  let completedTasks = 0;
  let completion = createDeferred();
  const tasks = channel("openclaw.worker.task");
  const record = (message: unknown) => {
    if (
      isRecord(message) &&
      message.worker === "prepared-model-catalog.worker.js" &&
      message.outcome === "ok"
    ) {
      completedTasks++;
      completion.resolve();
      completion = createDeferred();
    }
  };
  tasks.subscribe(record);
  return {
    nextCompletion: () => completion.promise,
    read: () => ({ ...getPreparedModelCatalogWorkerPoolSnapshot(), completedTasks }),
    close: () => tasks.unsubscribe(record),
  };
}
