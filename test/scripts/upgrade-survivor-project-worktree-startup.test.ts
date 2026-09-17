import { describe, expect, it } from "vitest";
import {
  assertProjectWorktreeImportReport,
  assertProjectWorktreeStartupLog,
  assertProjectWorktreeStartupPreservation,
} from "../../scripts/e2e/lib/upgrade-survivor/project-worktree-startup.mjs";

const sessionKey = "agent:main:dashboard:legacy-project-worktree";
const original = {
  stage: "published-import",
  shared: { project: [{ id: "project" }], worktrees: [{ id: "worktree" }] },
  agent: {
    sessions: [
      {
        session_key: sessionKey,
        current_session_id: "target",
        updated_at: 10,
        entry_json: JSON.stringify({
          sessionId: "target",
          updatedAt: 10,
          lastActivityAt: 10,
          projectId: "project",
          worktree: { id: "worktree", repoRoot: "/fixture/project" },
        }),
      },
      { session_key: "other", current_session_id: "sentinel", updated_at: 20, entry_json: "{}" },
    ],
    transcript: [{ session_id: "target", seq: 1, event_json: "original bytes", created_at: 10 }],
  },
};
function migrated(stage = "before-startup") {
  const result = { ...structuredClone(original), stage };
  const row = result.agent.sessions[0]!;
  const entry = JSON.parse(row.entry_json);
  entry.worktree.canonicalWorkspaceDir = "/fixture/project";
  row.entry_json = JSON.stringify(entry);
  return result;
}

function publishedImportEvidence() {
  const target = {
    agentId: "main",
    storePath: "/fixture/sessions.json",
    sqlitePath: "/fixture/agent.sqlite",
    legacyEntries: 2,
    referencedTranscriptFiles: 2,
    sqliteEntries: 2,
    importedEntries: 2,
    importedTranscriptEvents: 4,
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
    issues: [],
  };
  return {
    report: { mode: "import", targets: [target], migrationRun: { runId: "published-import" } },
    dryRun: {
      mode: "dry-run",
      targets: [
        {
          ...target,
          sqliteEntries: 0,
          importedEntries: 0,
          importedTranscriptEvents: 0,
          validatedEntries: 2,
          validatedTranscriptEvents: 4,
        },
      ],
    },
    manifest: {
      runId: "published-import",
      completedAt: "2026-09-16T10:42:34.189Z",
      targets: [
        {
          agentId: target.agentId,
          storePath: target.storePath,
          sqlitePath: target.sqlitePath,
          validationBeforeArchive: "passed",
          issues: [],
        },
      ],
    },
  };
}

describe("published project-worktree startup evidence", () => {
  it("requires update Doctor to repair the workspace before either Gateway startup", () => {
    expect(() =>
      assertProjectWorktreeStartupPreservation(original, original, "/fixture/project"),
    ).not.toThrow();
    for (const stage of ["before-startup", "after-first-stop", "after-second-stop"]) {
      expect(() =>
        assertProjectWorktreeStartupPreservation(migrated(stage), original, "/fixture/project"),
      ).not.toThrow();
      expect(() =>
        assertProjectWorktreeStartupPreservation(
          { ...original, stage },
          original,
          "/fixture/project",
        ),
      ).toThrow();
    }
    const premature = migrated("published-import");
    expect(() =>
      assertProjectWorktreeStartupPreservation(premature, premature, "/fixture/project"),
    ).toThrow();
    expect(() =>
      assertProjectWorktreeStartupPreservation(migrated("unknown"), original, "/fixture/project"),
    ).toThrow();
  });

  it.each([
    "activity",
    "generation",
    "transcript",
    "project",
    "unrelated",
    "missing",
    "wrong-workspace",
  ])("rejects a changed %s instead of accepting readiness as migration proof", (change) => {
    const result = migrated();
    if (change === "activity") {
      result.agent.sessions[0]!.updated_at++;
    }
    if (change === "generation") {
      result.agent.sessions[0]!.current_session_id = "replacement";
    }
    if (change === "transcript") {
      result.agent.transcript[0]!.event_json = "rewritten";
    }
    if (change === "project") {
      result.shared.project[0]!.id = "other";
    }
    if (change === "unrelated") {
      result.agent.sessions[1]!.entry_json = '{"changed":true}';
    }
    if (change === "missing") {
      result.agent.sessions.pop();
    }
    if (change === "wrong-workspace") {
      const entry = JSON.parse(result.agent.sessions[0]!.entry_json);
      entry.worktree.canonicalWorkspaceDir = "/fixture/agent-default";
      result.agent.sessions[0]!.entry_json = JSON.stringify(entry);
    }
    expect(() =>
      assertProjectWorktreeStartupPreservation(result, original, "/fixture/project"),
    ).toThrow();
  });

  it.each([
    {
      format: "raw message",
      migration: "session: recorded canonical workspaces for 1 managed-worktree session(s)",
      shutdownPrefix: "shutdown",
    },
    {
      format: "rendered console",
      migration:
        "2026-09-16T15:10:34.169+00:00 [gateway] session: recorded canonical workspaces for 1 managed-worktree session(s)",
      shutdownPrefix: "2026-09-16T15:10:35.584+00:00 [shutdown]",
    },
  ])(
    "requires clean shutdown without startup repair from $format logs",
    ({ migration, shutdownPrefix }) => {
      const closed = `${shutdownPrefix} completed cleanly in 19ms`;
      const warned = `${shutdownPrefix} completed in 19ms with warnings: database drain`;
      const failed = `${shutdownPrefix} failed in 19ms`;
      for (const start of ["first", "second"]) {
        expect(assertProjectWorktreeStartupLog(closed, start)).toEqual({
          backfills: [],
          cleanShutdown: true,
        });
        for (const log of [
          "gateway ready",
          migration,
          `${migration}\n${closed}`,
          warned,
          failed,
          `${closed}\n${warned}`,
          `${closed}\n${failed}`,
        ]) {
          expect(() => assertProjectWorktreeStartupLog(log, start)).toThrow();
        }
      }
    },
  );

  it("accepts published fresh-import counters with separate pre-archive validation", () => {
    const { report, dryRun, manifest } = publishedImportEvidence();
    const target = report.targets[0]!;
    expect(assertProjectWorktreeImportReport(report, target.storePath, dryRun, manifest)).toEqual(
      target,
    );
  });

  it("rejects incomplete import and dry-run receipts", () => {
    for (const change of [
      { agentId: "other" },
      { importedEntries: 1 },
      { importedTranscriptEvents: 3 },
      { sqliteEntries: 1 },
      { legacyEntries: 1 },
      { referencedTranscriptFiles: 1 },
      { validatedEntries: 1 },
      { validatedTranscriptEvents: 1 },
      { issues: [{ code: "transcript_missing" }] },
    ]) {
      const { report, dryRun, manifest } = publishedImportEvidence();
      const target = report.targets[0]!;
      expect(() =>
        assertProjectWorktreeImportReport(
          { ...report, targets: [{ ...target, ...change }] },
          target.storePath,
          dryRun,
          manifest,
        ),
      ).toThrow();
    }
    for (const change of [
      { validatedEntries: 1 },
      { validatedTranscriptEvents: 3 },
      { sqlitePath: "/fixture/other.sqlite" },
      { issues: [{ code: "transcript_malformed" }] },
    ]) {
      const { report, dryRun, manifest } = publishedImportEvidence();
      expect(() =>
        assertProjectWorktreeImportReport(
          report,
          report.targets[0]!.storePath,
          { ...dryRun, targets: [{ ...dryRun.targets[0], ...change }] },
          manifest,
        ),
      ).toThrow();
    }
  });

  it("requires a completed matching manifest with successful pre-archive validation", () => {
    for (const change of [
      { validationBeforeArchive: "not_run" },
      { validationBeforeArchive: "failed" },
      { validationBeforeArchive: undefined },
      { agentId: "other" },
      { storePath: "/fixture/other.json" },
      { sqlitePath: "/fixture/other.sqlite" },
      { issues: [{ code: "sqlite_entry_missing" }] },
    ]) {
      const { report, dryRun, manifest } = publishedImportEvidence();
      expect(() =>
        assertProjectWorktreeImportReport(report, report.targets[0]!.storePath, dryRun, {
          ...manifest,
          targets: [{ ...manifest.targets[0], ...change }],
        }),
      ).toThrow();
    }
    const { report, dryRun, manifest } = publishedImportEvidence();
    for (const invalid of [
      { ...manifest, completedAt: undefined },
      { ...manifest, failedAt: manifest.completedAt },
      { ...manifest, runId: "other-run" },
      { ...manifest, targets: [manifest.targets[0], manifest.targets[0]] },
    ]) {
      expect(() =>
        assertProjectWorktreeImportReport(report, report.targets[0]!.storePath, dryRun, invalid),
      ).toThrow();
    }
  });
});
