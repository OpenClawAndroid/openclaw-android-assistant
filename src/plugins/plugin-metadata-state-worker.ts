import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { PluginMetadataStateSelector } from "./installed-plugin-index-row.js";

/** Read raw metadata through the shared inspection actor, without creating state. */
export async function readPluginMetadataStateRow(
  selector: PluginMetadataStateSelector,
  options: { path?: string; env?: NodeJS.ProcessEnv },
  artifactPreservingReadOnly = false,
): Promise<{ value_json: string } | undefined> {
  const preserveArtifacts = artifactPreservingReadOnly || isArtifactPreservingStateRead();
  const context = captureOpenClawStateWorkerContext(options);
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  context.admission.assertCurrent();
  return runOpenClawStateWorkerOperation(
    context,
    async (scope) => {
      const row = await scope.execute({
        type: "plugins.metadata.read",
        input: { selector, artifactPreservingReadOnly: preserveArtifacts },
      });
      context.admission.assertCurrent();
      if (row === undefined) {
        return undefined;
      }
      if (!isRecord(row) || typeof row.value_json !== "string") {
        throw new Error("Shared-state worker returned an invalid plugin metadata row");
      }
      return { value_json: row.value_json };
    },
    { existingOnly: true },
  );
}
