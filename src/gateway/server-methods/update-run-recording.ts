import { createUpdateErrorFact } from "../../infra/update-failure-facts.js";
import { FreeBsdPkgOwnershipError } from "../../infra/update-freebsd-pkg-ownership.js";
import type { UpdateRestartSentinelMeta } from "../../infra/update-restart-sentinel-payload.js";
import {
  getUpdateRun,
  heartbeatUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import type { UpdateRunResult, UpdateRunnerOptions } from "../../infra/update-runner-types.js";

export function createUpdateRunRecording(
  runId: string,
  driver: UpdateRunRecord["origin"]["driver"],
  sentinelMeta: UpdateRestartSentinelMeta,
): Pick<UpdateRunnerOptions, "beforeGitMutation" | "progress"> {
  return {
    beforeGitMutation: async ({ sha, version }) => {
      recordUpdateRunPhase(runId, "staging", {
        target: { ...(sha ? { sha } : {}), ...(version ? { version } : {}) },
      });
      sentinelMeta.target = sha ?? version ?? sentinelMeta.target;
    },
    progress: {
      onHeartbeat: () => heartbeatUpdateRun(runId, driver),
      onStepStart: (step) =>
        recordUpdateRunStep(runId, {
          step: step.name,
          status: "in_progress",
          startedAtMs: Date.now(),
        }),
      onStepComplete: (step) => {
        for (const entry of updateRunStepsFromResultStep(step)) {
          recordUpdateRunStep(runId, { ...entry, endedAtMs: Date.now() });
        }
      },
    },
  };
}

export function createUnexpectedUpdateFailureResult(
  run: UpdateRunRecord,
  previous: UpdateRunResult,
  error: unknown,
): UpdateRunResult {
  const current = getUpdateRun(run.runId) ?? run;
  const activeStep = current.steps.findLast((step) => step.status === "in_progress");
  const name = activeStep?.step ?? current.phase;
  return {
    ...previous,
    status: "error",
    reason: error instanceof FreeBsdPkgOwnershipError ? error.reason : "unexpected-error",
    before: previous.before ?? current.before,
    after: previous.after ?? current.after,
    steps: [
      ...previous.steps,
      {
        name,
        command: "",
        cwd: previous.root ?? "",
        durationMs: Date.now() - (activeStep?.startedAtMs ?? current.createdAtMs),
        exitCode: 1,
        failureFacts: [createUpdateErrorFact(name, error)],
      },
    ],
    durationMs: Date.now() - current.createdAtMs,
  };
}
