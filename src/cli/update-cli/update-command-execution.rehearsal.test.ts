import "./update-command-execution.test-support.js";
import { expect, it, vi } from "vitest";
import type { UpdateCandidateRehearsal } from "../../infra/update-candidate-rehearsal.js";
import * as repairAgent from "../../infra/update-repair-agent.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import * as repair from "./update-command-repair.js";

const { executionParams, mocks, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

it.each(["unavailable", "repaired", "revoked"] as const)(
  "owns retained state through %s repair and requires fresh activation checks",
  async (outcome) => {
    await withOpenClawTestState({}, async (state) => {
      mocks.validateCanary.mockReset();
      await state.writeConfig({});
      const rehearsal: UpdateCandidateRehearsal = {
        sourceConfig: {},
        sourceConfigHash: "source-config",
        stateDir: state.path("private"),
        configPath: state.path("private/openclaw.json"),
        workspaceDir: state.path("private/workspace"),
        env: state.env,
        port: 1,
        snapshotCapacity: {
          sqliteBytes: 0,
          pluginBytes: 0,
          requiredBytes: 0,
          candidates: [],
          selection: { kind: "system-tmpdir", directory: state.path("private") },
          reason: "system-tmpdir",
        },
        cleanupDirectories: [],
        cleanup: async () => {},
      };
      const cleanup = vi.fn(async () => {});
      const params = executionParams("package");
      mocks.validateCanary.mockImplementationOnce(async (options) => {
        expect(options.retainFailedRehearsal).toBe(true);
        expect(options.sourceConfigHash).toEqual(expect.any(String));
        if (outcome === "revoked") {
          params.opts.recovery = {};
        }
        return {
          status: "error",
          reason: "doctor-failed",
          phase: "lint",
          durationMs: 1,
          steps: [],
          logTail: ["Repair needed."],
          retainedRehearsal: { rehearsal, cleanup },
        };
      });
      mocks.validateCanary.mockImplementationOnce(async (options) => {
        expect(cleanup).toHaveBeenCalledOnce();
        expect(options.rehearsal).toBeUndefined();
        expect(options.retainFailedRehearsal).toBe(false);
        return { status: "ok", phase: "readiness", steps: [], durationMs: 1, logTail: [] };
      });
      const runRepair = vi.spyOn(repair, "runUpdateCommandRepair");
      vi.spyOn(repairAgent, "prepareUnattendedUpdateRepair").mockImplementation(async (p) => {
        expect(cleanup).not.toHaveBeenCalled();
        expect(p.target.stateDir).toBe(rehearsal.stateDir);
        expect(await p.validate(new AbortController().signal)).toEqual({
          ok: false,
          score: 0,
          summary: "Repair needed.",
        });
        return {
          status: outcome === "repaired" ? "repaired" : "unavailable",
          attempts: [],
          finalValidation: { ok: outcome === "repaired", score: 0, summary: "Observed." },
        };
      });
      mocks.runPackageUpdate.mockImplementation(async ({ validateCandidate }) => {
        await validateCandidate("/candidate");
        return successfulUpdate;
      });
      const execution = await executeMutableUpdate(params);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(runRepair).toHaveBeenCalledTimes(outcome === "revoked" ? 0 : 1);
      expect(mocks.validateCanary).toHaveBeenCalledTimes(outcome === "repaired" ? 2 : 1);
      if (outcome === "revoked") {
        expect(execution).toMatchObject({
          result: { status: "error" },
          failure: { cause: { name: "UpdateCommandRecoveryPendingError" } },
        });
      }
    });
  },
);
