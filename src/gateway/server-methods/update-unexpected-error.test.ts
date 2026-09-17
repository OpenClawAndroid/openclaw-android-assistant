import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import {
  invokeUpdateRun,
  runGatewayUpdateMock,
  runPostCoreFinalizeAfterGatewayUpdateMock,
  sentinelState,
} from "./update.test-harness.js";

describe("update.run unexpected-error diagnostics", () => {
  it.each(["runner", "finalization"])("retains report facts when %s throws", async (source) => {
    const error = Object.assign(
      new Error(
        "EACCES: permission denied, open '/Users/example/private-file' token=synthetic-secret\nprivate second line",
      ),
      { code: "EACCES" },
    );
    const recovery = { serviceRestartSafe: true as const, version: "1.0.0" };
    runGatewayUpdateMock.mockImplementationOnce(async (opts) => {
      await opts?.beforeGitMutation?.({ sha: "a".repeat(40), version: "2.0.0" });
      const step = { name: "build", command: "pnpm build", index: 0, total: 1 };
      opts?.progress?.onStepStart?.(step);
      if (source === "runner") {
        throw error;
      }
      opts?.progress?.onStepComplete?.({ ...step, exitCode: 0, durationMs: 1 });
      return {
        status: "error",
        mode: "git",
        before: { version: "1.0.0" },
        after: { version: "2.0.0" },
        recovery,
        durationMs: 1,
        steps: [{ ...step, cwd: "", exitCode: 0, durationMs: 1 }],
      };
    });
    if (source === "finalization") {
      runPostCoreFinalizeAfterGatewayUpdateMock.mockRejectedValueOnce(error);
    }
    const logGateway = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    let payload: { runId: string; result: UpdateRunResult } | undefined;
    await invokeUpdateRun(
      {},
      (_ok, response) => {
        payload = response as typeof payload;
      },
      undefined,
      { logGateway },
    );

    const response = expectDefined(payload, "update response");
    const recordedRun = expectDefined(getUpdateRun(response.runId), "recorded update run");
    const phase = source === "runner" ? "build" : "validating";
    expect(recordedRun.target).toMatchObject({
      kind: "git",
      sha: "a".repeat(40),
      version: "2.0.0",
    });
    expect(recordedRun.steps).toContainEqual(
      expect.objectContaining({
        step: phase,
        status: "failed",
        failureFacts: [
          {
            check: phase,
            code: "EACCES",
            message: expect.stringContaining("EACCES: permission denied, open [redacted-path]"),
          },
        ],
      }),
    );
    expect(response.result).toMatchObject({
      status: "error",
      mode: "git",
      reason: "unexpected-error",
    });
    if (source === "finalization") {
      expect(response.result.recovery).toEqual(recovery);
      expect(sentinelState.capturedPayload?.stats?.recovery).toEqual(recovery);
      expect(response.result.steps).toContainEqual(
        expect.objectContaining({ name: "build", exitCode: 0 }),
      );
    }
    const report = await prepareUpdateFailureReport({
      attemptId: response.runId,
      result: response.result,
      recordedRun,
    });
    expect(report.body).toContain(`Update target: ${"a".repeat(40)}`);
    expect(report.body).toContain("Update mode: git");
    expect(report.body).toContain(`Failed phase ${phase}:`);
    expect(report.body).toContain("EACCES; Permission denied");
    expect(report.body).toContain(
      source === "finalization"
        ? "Recovery outcome: verified safe to restart"
        : "Recovery outcome: not recorded",
    );
    for (const privateText of [
      "/Users/example",
      "private-file",
      "synthetic-secret",
      "private second line",
    ]) {
      expect(JSON.stringify(recordedRun)).not.toContain(privateText);
      expect(report.body).not.toContain(privateText);
    }
    expect(logGateway.warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });
});
