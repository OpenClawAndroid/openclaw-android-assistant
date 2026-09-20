import fs from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import type { WorkspaceSkillSourceRequest } from "../loading/workspace-skill-sources.js";
import {
  decodeSkillWorkerRequest,
  skillWorkerLines,
  writeSkillWorkerResult,
} from "./workspace-worker-io.js";

type WatchRequest = Pick<WorkspaceSkillSourceRequest, "sourcePlan" | "executionWorkspaceDir">;

/** A dedicated subprocess reuses native Skills owners on either kind of workspace host. */
export async function serveWorkspaceSkills(options: {
  workspace: string;
  home: string;
  operation: string;
  input: Readable;
  output: Writable;
}): Promise<void> {
  const { workspace, operation, input, output } = options;
  const write = (value: unknown) => writeSkillWorkerResult(output, value);
  if (operation === "watch") {
    const { ensureSkillsWatcher, closeSkillsWatchers, registerSkillsChangeListener } =
      await import("./refresh.js");
    const lines = skillWorkerLines(input);
    let stopped = false;
    let queued = false;
    let unavailable = false;
    let unsubscribe: (() => void) | undefined;
    try {
      // SAFETY: The same-version watch adapter sends this contract; workspace identity is checked next.
      const request = (await lines.read()) as WatchRequest;
      assertWorkspace(request, workspace);
      const params = { ...request, workspaceDir: workspace };
      unsubscribe = registerSkillsChangeListener((event) => {
        if (stopped || event.workspaceDir !== workspace) {
          return;
        }
        if (event.reason === "watch-unavailable") {
          unavailable = true;
        }
        output.write(
          `${JSON.stringify(event.reason === "watch-unavailable" ? "unavailable" : "change")}\n`,
        );
        // Native events also invalidate discovery targets (for example a new symlink).
        if (event.reason === "watch" && !queued && !unavailable) {
          queued = true;
          queueMicrotask(() => {
            queued = false;
            if (!stopped && !unavailable) {
              ensureSkillsWatcher(params);
            }
          });
        }
      });
      ensureSkillsWatcher(params);
      try {
        await lines.read();
        throw new Error("Unexpected message on the skill watch subscription");
      } catch (error) {
        if (!input.readableEnded && !input.destroyed) {
          throw error;
        }
      }
    } finally {
      stopped = true;
      unsubscribe?.();
      lines.close();
      await closeSkillsWatchers();
    }
    return;
  }

  const chunks: Buffer[] = [];
  const inputChunks: AsyncIterable<unknown> = input;
  for await (const raw of inputChunks) {
    if (typeof raw === "string") {
      chunks.push(Buffer.from(raw));
    } else if (raw instanceof Uint8Array) {
      chunks.push(Buffer.from(raw));
    } else {
      throw new Error("Skill worker input must be bytes");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const decoded = decodeSkillWorkerRequest(text);
  switch (operation) {
    case "readInstructions": {
      const { filePath } = decoded;
      if (typeof filePath !== "string") {
        throw new Error("Skill instruction path is required");
      }
      await write(await fs.readFile(filePath, "utf8"));
      return;
    }
    case "resolveResource": {
      const { resolveExplicitSkillResource } = await import("./resources.js");
      await write(
        await resolveExplicitSkillResource(
          // SAFETY: The same-version adapter serializes the selected resource's native contract.
          decoded as Parameters<typeof resolveExplicitSkillResource>[0],
        ),
      );
      return;
    }
    case "readResources": {
      // SAFETY: The same-version adapter sends the selected Skill and native missing-root policy.
      const request = decoded as {
        skill: Parameters<typeof readSkillResourceFiles>[0];
        allowMissingRoot: boolean;
      };
      const { readSkillResourceFiles } = await import("./resources.js");
      await write(
        await readSkillResourceFiles(request.skill, { allowMissingRoot: request.allowMissingRoot }),
      );
      return;
    }
    case "discovery": {
      // SAFETY: The adapter serializes the native source plan; workspace identity is checked next.
      const discovery = decoded as WorkspaceSkillSourceRequest;
      assertWorkspace(discovery, workspace);
      const { readWorkspaceSkillSources } = await import("../loading/workspace-skill-loader.js");
      await write(readWorkspaceSkillSources(discovery));
      return;
    }
    default:
      throw new Error(`Unknown skill worker operation: ${operation}`);
  }
}

function assertWorkspace(request: WatchRequest, workspace: string) {
  if (request.sourcePlan.workspaceDir !== workspace) {
    throw new Error("Skill request does not match the provisioned workspace");
  }
}
