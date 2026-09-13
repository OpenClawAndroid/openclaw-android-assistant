import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordStartupRecoveryStoreResult } from "../../agents/main-session-recovery/main-session-restart-recovery-diagnostics.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { recordStartupMigrationWarnings } from "../../infra/state-migrations.messages.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { healthHandlers } from "./health.js";

afterEach(() => {
  resetConfigRuntimeState();
});

async function callStatus(config: OpenClawConfig, scopes = ["operator.read"]) {
  setRuntimeConfigSnapshot(config, config);
  const respond = vi.fn();
  await healthHandlers.status!({
    req: {} as never,
    params: { includeChannelSummary: false },
    respond: respond as never,
    context: {} as never,
    client: { connect: { role: "operator", scopes } } as never,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("Gateway status owner routing", () => {
  it("reports current startup recovery failures with restricted details until their store heals", async () => {
    await withStateDirEnv("openclaw-gateway-recovery-warning-", async ({ stateDir }) => {
      const target = { agentId: "main", storePath: path.join(stateDir, "sessions.json") };
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const config = { agents: { entries: { main: {} } }, session: { store: target.storePath } };
      const outcome = { ok: false, error: new Error("private store temporarily locked") } as const;
      try {
        recordStartupRecoveryStoreResult({ target, lifecycleGeneration, outcome });
        const reader = await callStatus(config);
        expect(reader.mock.calls[0]?.[1].startupRecoveryWarning).toContain("1 session store");
        expect(reader.mock.calls[0]?.[1].startupRecoveryWarning).not.toContain("private store");
        const admin = await callStatus(config, ["operator.admin"]);
        expect(admin.mock.calls[0]?.[1].startupRecoveryWarning).toContain(
          "private store temporarily locked",
        );

        recordStartupRecoveryStoreResult({ target, lifecycleGeneration, outcome: { ok: true } });
        const healed = await callStatus(config, ["operator.admin"]);
        expect(healed.mock.calls[0]?.[1].startupRecoveryWarning).toBeUndefined();

        rotateAgentEventLifecycleGeneration();
        recordStartupRecoveryStoreResult({ target, lifecycleGeneration, outcome });
        const restarted = await callStatus(config, ["operator.admin"]);
        expect(restarted.mock.calls[0]?.[1].startupRecoveryWarning).toBeUndefined();
      } finally {
        rotateAgentEventLifecycleGeneration();
      }
    });
  });

  it("uses the configured system owner without making public main aliases implicit", async () => {
    await withStateDirEnv("openclaw-gateway-status-owner-", async ({ stateDir }) => {
      const config = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, molty: {} },
        },
        session: { store: path.join(stateDir, "agents", "{agentId}", "sessions.json") },
      } satisfies OpenClawConfig;

      const respond = await callStatus(config);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          processMemory: {
            rssBytes: expect.any(Number),
            heapUsedBytes: expect.any(Number),
            heapTotalBytes: expect.any(Number),
          },
        }),
      );
      expect(respond.mock.calls[0]?.[2]).toBeUndefined();
      expect(resolveRequestedSessionAgentId(config, "main")).toMatchObject({ ok: false });
      expect(resolveRequestedSessionAgentId(config, "agent:molty:main")).toEqual({
        ok: true,
        agentId: "molty",
      });
    });
  });

  it("keeps single-agent status unchanged", async () => {
    await withStateDirEnv("openclaw-gateway-status-single-", async ({ stateDir }) => {
      const respond = await callStatus({
        agents: { entries: { main: {} } },
        session: { store: path.join(stateDir, "sessions.json") },
      });

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[2]).toBeUndefined();
    });
  });

  it("limits startup migration details to admin status while readers retain the repair hint", async () => {
    await withStateDirEnv("openclaw-gateway-status-warning-", async ({ stateDir }) => {
      const warning = `EACCES: permission denied, open '${path.join(stateDir, "private-bindings.json")}'`;
      recordStartupMigrationWarnings([warning]);
      const config = {
        agents: { entries: { main: {} } },
        session: { store: path.join(stateDir, "sessions.json") },
      };
      const hint =
        'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.';

      const reader = await callStatus(config);
      const readerPayload = reader.mock.calls[0]?.[1];
      expect(reader.mock.calls[0]?.[0]).toBe(true);
      expect(readerPayload.startupMigrationWarning).toContain(hint);
      expect(readerPayload.startupMigrationWarning).not.toContain(stateDir);
      expect(readerPayload.startupMigrationWarning).not.toContain("EACCES");

      const admin = await callStatus(config, ["operator.admin"]);
      expect(admin.mock.calls[0]?.[0]).toBe(true);
      expect(admin.mock.calls[0]?.[1].startupMigrationWarning).toContain(warning);
      expect(admin.mock.calls[0]?.[1].startupMigrationWarning).toContain(hint);
    });
  });
});
