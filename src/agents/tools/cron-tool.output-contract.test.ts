import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import ts from "typescript";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { clearCronJobActive, markCronJobActive } from "../../cron/active-jobs.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronJob } from "../../cron/types.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "../code-mode.test-support.js";
import { createCronTool } from "./cron-tool.js";

const job: CronJob = {
  id: "invoice-check",
  name: "Check unpaid invoices",
  enabled: true,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "Check unpaid invoices" },
  state: {},
};
const compactJob = {
  id: job.id,
  name: job.name,
  enabled: true,
  scheduleKind: "every",
  schedule: job.schedule,
  effectiveAgentId: "main",
  nextRunAt: null,
  nextRunAtMs: null,
  lastRunAt: null,
  lastRunAtMs: null,
  lastRunStatus: null,
  lastRunError: null,
};
const page = {
  total: 1,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
};
const list = { ...page, jobs: [compactJob], snapshotRevision: "inventory-revision" };
const deliveryPreview = { label: "Current conversation", detail: "No external delivery" };
const createJob = {
  name: job.name,
  schedule: job.schedule,
  sessionTarget: job.sessionTarget,
  wakeMode: job.wakeMode,
  payload: job.payload,
};

describe("automations output contract", () => {
  const { makeStorePath } = createCronStoreHarness({ prefix: "cron-code-mode-output-" });
  it.each([
    {
      name: "scheduler status",
      args: { action: "status" },
      reply: {
        enabled: true,
        triggersEnabled: true,
        storePath: "/synthetic/state.sqlite",
        storage: "sqlite",
        sqlitePath: "/synthetic/state.sqlite",
        jobs: 1,
        nextWakeAtMs: null,
      },
    },
    { name: "compact inventory", args: { action: "list" }, reply: list },
    { name: "job details", args: { action: "get", jobId: job.id }, reply: job },
    {
      name: "creation",
      args: { action: "add", job: createJob },
      reply: { ...job, deliveryPreview },
    },
    {
      name: "declarative convergence",
      args: { action: "add", job: { ...createJob, declarationKey: "invoices" } },
      reply: { created: false, updated: true, job, deliveryPreview },
    },
    {
      name: "update",
      args: { action: "update", jobId: job.id, job: { name: "Check invoices" } },
      reply: job,
    },
    {
      name: "removal",
      args: { action: "remove", jobId: job.id },
      reply: { ok: true, removed: true },
    },
    {
      name: "unsuccessful removal",
      args: { action: "remove", jobId: job.id },
      reply: { ok: false, removed: false },
    },
    {
      name: "queued run",
      args: { action: "run", jobId: job.id },
      reply: { ok: true, enqueued: true, runId: "run-invoices", processInstanceId: "gateway-1" },
    },
    {
      name: "skipped run",
      args: { action: "run", jobId: job.id },
      reply: { ok: true, ran: false, reason: "already-running", processInstanceId: "gateway-1" },
    },
    { name: "rejected run", args: { action: "run", jobId: job.id }, reply: { ok: false } },
    {
      name: "run history",
      args: { action: "runs", jobId: job.id },
      reply: {
        ...page,
        entries: [
          {
            ts: 1_800_000_000_000,
            jobId: job.id,
            action: "finished",
            status: "ok",
            summary: "Three unpaid invoices",
          },
        ],
      },
    },
    { name: "wake", args: { action: "wake", text: "Review invoices" }, reply: { ok: true } },
    {
      name: "unsuccessful wake",
      args: { action: "wake", text: "Review invoices" },
      reply: { ok: false, reason: "unwakeable-session-key" },
    },
  ])("describes $name through the real tool", async ({ args, reply }) => {
    const tool = createCronTool(undefined, { callGatewayTool: vi.fn().mockResolvedValue(reply) });
    const result = await tool.execute("call-contract", args);
    const schema = expectDefined(tool.outputSchema, "automations output schema");
    expect(Value.Errors(schema, result.details)).toEqual([]);
  });

  it.each(["isolated", "current"] as const)(
    "accepts successful removal with pending %s session cleanup without retrying",
    async (sessionTarget) => {
      onTestFinished(resetCodeModeTestState);
      const { storePath } = await makeStorePath();
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        sessionStorePath: path.join(path.dirname(storePath), "sessions.json"),
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const input = {
        ...createJob,
        id: `code-mode-cleanup-${sessionTarget}`,
        enabled: false,
        sessionTarget,
        sessionKey: "agent:main:cleanup-fixture",
        payload: { kind: "agentTurn" as const, message: "Synthetic pending cleanup" },
      };
      const activeJob = await cron.add(input);
      const marker = markCronJobActive(activeJob.id);
      const gatewayCall = vi.fn().mockImplementation(async () => await cron.remove(activeJob.id));
      const tool = createCronTool(undefined, { callGatewayTool: gatewayCall });
      const h = createCodeModeHarness();
      applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
      try {
        const result = await runUntilCompleted({
          execTool: expectDefined(h.tools[0], "Code Mode exec"),
          waitTool: expectDefined(h.tools[1], "Code Mode wait"),
          code: `return await automations({action:"remove",jobId:${JSON.stringify(activeJob.id)}});`,
        });
        expect(gatewayCall).toHaveBeenCalledOnce();
        expect(gatewayCall.mock.calls[0]?.[0]).toBe("cron.remove");
        expect(cron.getJob(activeJob.id)).toBeUndefined();
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "completed",
          value: { ok: true, removed: true, sessionCleanup: "pending" },
        });
      } finally {
        clearCronJobActive(activeJob.id, marker);
        // Reusing the id joins the owner's deferred cleanup before fixture teardown.
        await cron.add(input);
        cron.stop();
      }
    },
  );

  it("keeps older full inventories valid after compact fallback", async () => {
    const gatewayCall = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "invalid cron.list params: unexpected property 'compact'",
        }),
      )
      .mockResolvedValueOnce({
        ...page,
        snapshotRevision: "old-inventory",
        jobs: [{ ...job, effectiveAgentId: "main" }],
        deliveryPreviews: { [job.id]: deliveryPreview },
      });
    const tool = createCronTool(undefined, { callGatewayTool: gatewayCall });
    const result = await tool.execute("call-full", { action: "list" });
    expect(gatewayCall).toHaveBeenCalledTimes(2);
    expect(
      Value.Errors(expectDefined(tool.outputSchema, "automations output schema"), result.details),
    ).toEqual([]);
  });

  it("describes self-scoped status, inventory, and paced proposals", async () => {
    const runId = "automation-output-run";
    claimAgentRunContext(runId, {
      sessionKey: `agent:main:cron:${job.id}`,
      cronRunsByJobId: new Map([[job.id, { pacingEnabled: true }]]),
    });
    onTestFinished(() => clearAgentRunContext(runId));
    const tool = createCronTool(
      { selfRemoveOnlyJobId: job.id, runId },
      {
        callGatewayTool: vi
          .fn()
          .mockResolvedValueOnce({ enabled: true, jobs: 10 })
          .mockResolvedValueOnce(list),
      },
    );
    const schema = expectDefined(tool.outputSchema, "automations output schema");
    const status = await tool.execute("call-status", { action: "status" });
    expect(status.details).toEqual({ enabled: true });
    const inventory = await tool.execute("call-list", { action: "list" });
    expect(inventory.details).not.toHaveProperty("snapshotRevision");
    const proposal = await tool.execute("call-next", { action: "next_check", in: "30m" });
    for (const result of [status, inventory, proposal]) {
      expect(Value.Errors(schema, result.details)).toEqual([]);
    }
  });

  it("composes discovered automation results using the real generated declaration", async () => {
    onTestFinished(resetCodeModeTestState);
    const h = createCodeModeHarness();
    const tool = createCronTool(undefined, { callGatewayTool: vi.fn().mockResolvedValue(list) });
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
    const result = await runUntilCompleted({
      execTool: expectDefined(h.tools[0], "Code Mode exec"),
      waitTool: expectDefined(h.tools[1], "Code Mode wait"),
      code: 'const [tool] = await catalog.search("automations"); const listed = await tool({action:"list"}); const file = await API.read("tools/automations.d.ts"); return {names:listed.jobs.map(job=>job.name),file};',
    });
    expect(result).toMatchObject({ status: "completed", value: { names: [job.name] } });
    const { file } = result.value as { file: { content: string } };
    const fileName = "/automations-consumer.ts";
    const source = ts.createSourceFile(
      fileName,
      file.content +
        `
async function consume() {
  const result = await automations({ action: "list" });
  if ("jobs" in result && "nextOffset" in result) {
    const names: string[] = result.jobs.map(job => job.name);
    const next: number | null = result.nextOffset;
    // @ts-expect-error Invented invoice fields are not part of an automation.
    result.jobs[0].invoiceTotal;
    return { names, next };
  }
  if ("removed" in result && result.ok) {
    const cleanup: "pending" | undefined = result.sessionCleanup;
    return cleanup;
  }
  if ("entries" in result) {
    const summaries: (string | undefined)[] = result.entries.map(entry => entry.summary);
    return summaries;
  }
  if ("job" in result && result.job.payload.kind === "systemEvent") {
    const text: string = result.job.payload.text;
    return text;
  }
}
`,
      ts.ScriptTarget.ESNext,
      true,
    );
    const options = { noEmit: true, strict: true, types: [], target: ts.ScriptTarget.ESNext };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, ...args) => (name === fileName ? source : original(name, ...args));
    const program = ts.createProgram([fileName], options, host);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ).toEqual([]);
  });
});
