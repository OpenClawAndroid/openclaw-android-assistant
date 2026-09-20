import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as rehearsals from "../../infra/update-candidate-rehearsal.js";
import * as repairAgent from "../../infra/update-repair-agent.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runUpdateCommandRepair } from "./update-command-repair.js";

const runtime = vi.hoisted(() => ({
  withUpdateRepairEnvironment: vi.fn((_target, run) => run()),
  prepareUpdateRepairInference: vi.fn(),
  runUpdateRepairTurn: vi.fn(),
}));
vi.mock("../../infra/update-repair-agent.runtime.js", () => runtime);
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each([false, true])(
  "reuses migrated validation before inference and checks subsequent repair writes (route: %s)",
  async (hasRoute) => {
    await withOpenClawTestState({}, async (state) => {
      const copiedState = state.path("retained-canary");
      const configPath = path.join(copiedState, "openclaw.json");
      const marker = path.join(copiedState, "repair.txt");
      await fs.mkdir(copiedState);
      await fs.writeFile(configPath, '{"meta":{"migrations":{"utilityModelSeparation":true}}}');
      const cleanup = vi.fn(async () => fs.rm(copiedState, { recursive: true, force: true }));
      const rehearsal: rehearsals.UpdateCandidateRehearsal = {
        sourceConfig: {},
        sourceConfigHash: "original-source",
        stateDir: copiedState,
        configPath,
        workspaceDir: copiedState,
        env: { ...state.env, OPENCLAW_STATE_DIR: copiedState, OPENCLAW_CONFIG_PATH: configPath },
        port: 1,
        snapshotCapacity: {
          sqliteBytes: 0,
          pluginBytes: 0,
          requiredBytes: 0,
          candidates: [],
          selection: { kind: "system-tmpdir", directory: copiedState },
          reason: "system-tmpdir",
        },
        cleanupDirectories: [copiedState],
        cleanup,
      };
      const snapshot = vi
        .spyOn(rehearsals, "prepareUpdateCandidateRehearsal")
        .mockRejectedValue(new Error("A settled candidate must not be copied again."));
      // Exercise the real repair loop; the worker transport owns this same callback contract.
      vi.spyOn(repairAgent, "prepareUnattendedUpdateRepair").mockImplementation(
        repairAgent.runUpdateRepairLoop,
      );
      runtime.prepareUpdateRepairInference.mockResolvedValue(
        hasRoute
          ? {
              ok: true,
              route: {
                runner: "embedded",
                agentId: "main",
                provider: "fixture",
                model: "repair",
                modelLabel: "fixture/repair",
                agentDir: copiedState,
                runConfig: {},
              },
              modelFallbacks: [],
            }
          : { ok: false, reason: "No usable inference route is available." },
      );
      runtime.runUpdateRepairTurn.mockImplementation(async () => {
        await fs.writeFile(marker, "repaired");
        return {
          toolCalls: 1,
          exitCode: 0,
          envelope: { final: "Repair complete.", status: "ok" },
        };
      });
      const initialValidation = { ok: false, score: 0, summary: "Candidate needs repair." };
      const validate = vi.fn<Parameters<typeof runUpdateCommandRepair>[0]["validate"]>(
        async (_signal, assertCurrent, observed) => {
          assertCurrent();
          expect(observed).toBe(rehearsal);
          expect(await fs.readFile(marker, "utf8")).toBe("repaired");
          return { ok: true, score: 0, summary: "Repair writes verified." };
        },
      );
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const result = await runUpdateCommandRepair({
        root: state.path("installed"),
        candidateRoot: state.path("candidate"),
        env: state.env,
        run: { runId: run.runId, env: state.env },
        phase: "validating",
        mode: "npm",
        validation: {
          status: "error",
          reason: "doctor-failed",
          phase: "lint",
          durationMs: 0,
          steps: [],
          logTail: [initialValidation.summary],
          retainedRehearsal: { rehearsal, cleanup },
        },
        validate,
      });
      expect(snapshot).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
      await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(runtime.prepareUpdateRepairInference).toHaveBeenCalledOnce();
      expect(validate).toHaveBeenCalledTimes(hasRoute ? 1 : 0);
      expect(runtime.runUpdateRepairTurn).toHaveBeenCalledTimes(hasRoute ? 1 : 0);
      expect(result).toMatchObject(
        hasRoute
          ? { status: "repaired", finalValidation: { ok: true } }
          : { status: "unavailable", attempts: [], finalValidation: initialValidation },
      );
      expect(getUpdateRun(run.runId, { env: state.env })?.repair).toEqual([
        expect.objectContaining({ status: hasRoute ? "succeeded" : "skipped" }),
      ]);
    });
  },
);
