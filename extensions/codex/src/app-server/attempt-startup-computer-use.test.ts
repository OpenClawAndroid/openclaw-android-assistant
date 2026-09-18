// Exercises Computer Use readiness through the real Codex attempt startup owner.
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerInitialize,
  createAttemptThreadStarter,
  readHarnessRequestMethods,
  waitForRequest,
} from "./attempt-startup.test-support.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import type { CodexPluginConfig } from "./config.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { resetCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { clearSharedCodexAppServerClientAndWait } from "./shared-client.js";
import { createInferenceReadyClientHarness } from "./test-support.js";

const tempRoots = new Set<string>();
const pluginConfig: CodexPluginConfig = { appServer: { command: "codex" } };
const startThreadWithHarness = createAttemptThreadStarter(tempRoots, pluginConfig);

describe("Codex attempt Computer Use readiness", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    await clearSharedCodexAppServerClientAndWait();
    // Direct runtime tests supply the plugin root normally owned by loader registration.
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(undefined);
    defaultCodexPluginMetadataCache.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it.each([false, true])(
    "does not await optional live probes at turn startup (strictReadiness: %s)",
    async (strictReadiness) => {
      vi.useFakeTimers();
      const probeStarts: number[] = [];
      const userStarts: number[] = [];
      const harness = createInferenceReadyClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as {
            id: number;
            method: string;
            params?: { ephemeral?: boolean };
          };
          switch (request.method) {
            case "configRequirements/read":
              send({ id: request.id, result: { requirements: null } });
              break;
            case "plugin/read":
              send({
                id: request.id,
                result: { plugin: { summary: { installed: true, enabled: true } } },
              });
              break;
            case "mcpServerStatus/list":
              send({
                id: request.id,
                result: {
                  data: [{ name: "computer-use", tools: { list_apps: {} } }],
                  nextCursor: null,
                },
              });
              break;
            case "thread/start":
              (request.params?.ephemeral ? probeStarts : userStarts).push(Date.now());
              send({ id: request.id, result: threadStartResult() });
              break;
            case "thread/unsubscribe":
            case "thread/archive":
              send({ id: request.id, result: {} });
              break;
            // Leave mcpServer/tool/call unanswered to exercise the real 60s timeout.
          }
        },
      });
      const { run } = startThreadWithHarness(180_000, new AbortController().signal, {
        harness,
        pluginConfig: {
          ...pluginConfig,
          computerUse: {
            enabled: true,
            marketplacePath: "/marketplaces/desktop-tools/marketplace.json",
            strictReadiness,
            autoRepair: false,
          },
        },
      });
      let settled = false;
      const outcome = run
        .then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        )
        .finally(() => {
          settled = true;
        });
      await answerInitialize(harness);
      if (strictReadiness) {
        await waitForRequest(harness, "mcpServer/tool/call");
        const firstProbeStart = probeStarts[0];
        if (firstProbeStart === undefined) {
          throw new Error("The strict readiness probe did not start");
        }
        await vi.advanceTimersByTimeAsync(firstProbeStart + 59_999 - Date.now());
        expect(settled).toBe(false);
        expect(probeStarts).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
        expect(probeStarts).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(settled).toBe(true), { interval: 1, timeout: 1_000 });
        const { error } = await outcome;
        expect(error).toBeInstanceOf(AgentHarnessPreflightError);
        expect(error).toMatchObject({
          cause: {
            status: {
              reason: "live_test_failed",
              liveTest: { attempts: 2, durationMs: 120_000 },
            },
          },
        });
        expect(userStarts).toHaveLength(0);
        expect(
          readHarnessRequestMethods(harness).filter((method) => method === "thread/archive"),
        ).toHaveLength(2);
      } else {
        await vi.waitFor(() => expect(settled).toBe(true), { interval: 1, timeout: 1_000 });
        const { result, error } = await outcome;
        expect(error).toBeUndefined();
        expect(userStarts).toHaveLength(1);
        expect(probeStarts).toHaveLength(0);
        expect(readHarnessRequestMethods(harness)).not.toContain("mcpServer/tool/call");
        result?.turnRoute.release();
        result?.releaseSharedClientLease();
      }
      expect(readHarnessRequestMethods(harness)).not.toContain("config/mcpServer/reload");
    },
  );
});
