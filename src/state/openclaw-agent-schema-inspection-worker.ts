import { fork } from "node:child_process";
import fs from "node:fs";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { z } from "zod";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import {
  resolveSqliteInspectionBudget,
  sqliteInspectionTimeoutError,
} from "../infra/sqlite-readonly-worker.js";
import type {
  AgentSchemaInspection,
  AgentSchemaInspectionInput,
} from "./openclaw-agent-schema-inspection.js";

const inspectionResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), message: z.string() }),
  z.object({
    ok: z.literal(true),
    inspection: z
      .object({
        version: z.number().int().safe(),
        writerAppVersion: z.string().optional(),
        reason: z.string().optional(),
        agentSchemaMeta: z
          .object({
            agentId: z.string().nullable(),
            role: z.string().nullable(),
            schemaVersion: z.number().nullable(),
          })
          .nullable()
          .optional(),
      })
      .nullable(),
  }),
]);

/** Join the reader before releasing caller authority, including on cancellation. */
export function inspectAgentDatabaseSchemaInWorker(
  input: AgentSchemaInspectionInput,
  signal?: AbortSignal,
): Promise<AgentSchemaInspection | null> {
  signal?.throwIfAborted();
  const { timeoutMs, size } = resolveSqliteInspectionBudget(
    "schema inspection",
    input.pathname,
    fs.statSync(input.pathname).size,
  );
  const entry = resolveRuntimeProcessEntrypointUrl("agentSchemaInspection");
  const child = fork(entry, [], {
    execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    signal,
  });
  return new Promise((resolve, reject) => {
    let result: AgentSchemaInspection | null | undefined;
    let failure: Error | undefined;
    child.on("message", (message: unknown) => {
      const parsed = inspectionResponse.safeParse(message);
      if (!parsed.success) {
        failure = new Error("Invalid agent schema inspection response");
      } else if (!parsed.data.ok) {
        failure = new Error(parsed.data.message);
      } else {
        result = parsed.data.inspection;
      }
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, exitSignal) => {
      if (signal?.aborted) {
        reject(toStringifiedError(signal.reason));
      } else if (failure) {
        reject(failure);
      } else if (code !== 0 || result === undefined) {
        reject(
          exitSignal === "SIGKILL"
            ? sqliteInspectionTimeoutError("schema inspection", input.pathname, timeoutMs, size)
            : new Error(`Agent schema inspection exited ${code} without a completed result`),
        );
      } else {
        resolve(result);
      }
    });
    child.send(input, (error) => {
      if (error) {
        failure ??= error;
        child.kill("SIGKILL");
      }
    });
  });
}
