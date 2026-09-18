import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { expect, it, vi } from "vitest";
import * as nodeRuntimeDiagnostics from "../../commands/node-runtime-diagnostics.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import * as updateGlobal from "../../infra/update-global.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { expectGitMetadataPreview } from "../update-cli-invocation.test-support.js";
import { printResult } from "./progress.js";
import * as shared from "./shared.js";
import { updateStatusCommand } from "./status.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();
const privateDiagnostic = "registry.internal.example /private/operator/npmrc";
const cases = [
  {
    kind: "registry lookup error",
    code: "target-registry-metadata",
    detail: /registry/i,
    metadata: { ...targetMetadata, version: null, error: privateDiagnostic },
  },
  {
    kind: "missing exact version",
    code: "target-version-resolution",
    detail: /version/i,
    metadata: { ...targetMetadata, version: null },
  },
  {
    kind: "mismatched exact version",
    code: "target-version-resolution",
    detail: /version/i,
    metadata: { ...targetMetadata, version: "2026.9.1" },
  },
  {
    kind: "missing target schema metadata",
    code: "target-schema-metadata",
    detail: /database|schema/i,
    metadata: { ...targetMetadata, schemaVersions: undefined },
  },
  {
    kind: "unresolved registry dist-tag",
    code: "target-registry-dist-tag",
    detail: /dist-tag|registry/i,
    metadata: targetMetadata,
  },
];

it.each(cases)(
  "explains $kind in CLI JSON, summary, and bounded diagnostics before creating state",
  async ({ code, detail, metadata }) => {
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue(metadata);
    if (code === "target-registry-dist-tag") {
      vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
        tag: "latest",
        version: null,
      });
    }

    await expect(
      updateCommand({
        ...(code === "target-registry-dist-tag" ? { channel: "stable" } : { tag: "2026.9.2" }),
        yes: true,
        json: true,
        restart: false,
      }),
    ).rejects.toMatchObject({ code: 1 });

    const result = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0] as UpdateRunResult;
    expect(result).toMatchObject({
      status: "error",
      mode: "npm",
      reason: "target-metadata-preflight",
      steps: [
        expect.objectContaining({
          failureFacts: [expect.objectContaining({ code, message: expect.stringMatching(detail) })],
        }),
      ],
    });
    const message = result.steps[0]?.failureFacts?.[0]?.message;
    expect(message).toMatch(/openclaw update/);
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    printResult(result, {});
    expect(log.mock.calls.flat().join("\n")).toContain(message);

    const report = await prepareUpdateFailureReport({ attemptId: "metadata-admission", result });
    expect(report.body).toContain(code);
    expect(report.body).toContain(message);
    expect(report.body).toMatch(detail);
    expect(report.body).toContain("openclaw update");
    expect(report.body).not.toContain("registry.internal.example");
    expect(report.body).not.toContain("/private/operator/npmrc");
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  },
);

it("keeps metadata failure details in update status JSON for an existing profile", async () => {
  openOpenClawStateDatabase();
  vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
    ...targetMetadata,
    version: null,
    error: privateDiagnostic,
  });
  await expect(
    updateCommand({ tag: "2026.9.2", yes: true, json: true, restart: false }),
  ).rejects.toMatchObject({ code: 1 });

  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(fixture.root);
  vi.spyOn(nodeRuntimeDiagnostics, "collectNodeRuntimeFindings").mockResolvedValue([]);
  vi.spyOn(updateCheck, "checkUpdateStatus").mockResolvedValue({
    root: fixture.root,
    installKind: "package",
    packageManager: "npm",
    registry: { latestVersion: "2026.9.2" },
  });
  await updateStatusCommand({ json: true });
  expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
    expect.objectContaining({
      lastRun: expect.objectContaining({
        status: "failed",
        reason: "target-metadata-preflight",
        origin: expect.objectContaining({ nextAction: expect.stringContaining("openclaw update") }),
        steps: expect.arrayContaining([
          expect.objectContaining({
            failureFacts: [
              expect.objectContaining({
                code: "target-registry-metadata",
                message: expect.stringMatching(/registry[\s\S]*openclaw update/i),
              }),
            ],
          }),
        ]),
      }),
    }),
  );
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
});

it.each(["npm", "pnpm", "bun"] as const)(
  "keeps the %s owner visible when target policy refuses before version lookup",
  async (manager) => {
    openOpenClawStateDatabase();
    vi.spyOn(updateGlobal, "detectGlobalInstallManagerForRoot").mockResolvedValue(manager);
    await expect(
      updateCommand({ tag: "main", json: true, yes: true, restart: false }),
    ).rejects.toMatchObject({ code: 1 });
    const result = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0] as UpdateRunResult;
    expect(result).toMatchObject({
      status: "error",
      mode: manager,
      reason: "unsupported-package-target",
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    printResult(result, {});
    expect(log.mock.calls.flat().join("\n")).toContain(`Update mode: ${manager}`);
    const report = await prepareUpdateFailureReport({ attemptId: "target-policy", result });
    expect(report.body).toContain(`Update mode: ${manager}`);

    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(fixture.root);
    vi.spyOn(nodeRuntimeDiagnostics, "collectNodeRuntimeFindings").mockResolvedValue([]);
    vi.spyOn(updateCheck, "checkUpdateStatus").mockResolvedValue({
      root: fixture.root,
      installKind: "package",
      packageManager: manager,
    });
    await updateStatusCommand({ json: true });
    expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ packageManager: manager }),
        lastRun: expect.objectContaining({ target: expect.objectContaining({ kind: "package" }) }),
      }),
    );
    expect(packageMetadata.fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  },
);

it("previews unreadable Git target metadata with its reason and next step", async () => {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", fixture.root]);
  vi.mocked(commandRun.prepareUpdateCommand).mockRestore();
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(fixture.root);

  await updateCommand({ dryRun: true, json: true, restart: false });

  expectGitMetadataPreview(vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0]);
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
  expect(packageMetadata.fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
});
