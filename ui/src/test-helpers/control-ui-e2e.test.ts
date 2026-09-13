// Control UI tests cover control ui e2e behavior.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { captureSidebarUiProof } from "../e2e/sidebar-customization.test-support.ts";
import { createControlUiE2eArtifactDir } from "./control-ui-e2e-artifacts.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  resolvePlaywrightChromiumExecutablePath,
  systemChromiumExecutableCandidates,
  waitForControlUiRoute,
} from "./control-ui-e2e.ts";

describe("shared proof capture", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it.each([
    { shardIndex: "5", shardCount: "6", failure: "none", sendLabel: "Send message" },
    { shardIndex: undefined, shardCount: undefined, failure: "none", sendLabel: "Loading chat" },
    {
      shardIndex: undefined,
      shardCount: undefined,
      failure: "screenshot",
      sendLabel: "private-label",
    },
    {
      shardIndex: undefined,
      shardCount: undefined,
      failure: "storage",
      sendLabel: "Sending message...",
    },
  ])(
    "retains safe failure state despite $failure failure ($sendLabel; $shardIndex/$shardCount)",
    async ({ shardIndex, shardCount, failure, sendLabel }) => {
      const parent = tempDirs.make("control-ui-failure-proof-");
      const diagnosticParent = failure === "storage" ? path.join(parent, "blocked") : parent;
      if (failure === "storage") {
        writeFileSync(diagnosticParent, "not a directory");
      }
      vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", diagnosticParent);
      const logs = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
      const app = document.createElement("openclaw-app");
      Object.assign(app, {
        runtime: {
          context: {
            gateway: {
              snapshot: {
                phase: failure === "storage" ? "private-phase" : "connected",
                hello: { token: "private-hello" },
              },
            },
            agents: { state: { connected: true } },
          },
        },
      });
      const composer = document.createElement("div");
      composer.className = "agent-chat__composer-combobox";
      const textarea = document.createElement("textarea");
      textarea.value = failure === "storage" ? "" : "private-draft";
      textarea.disabled = failure === "storage";
      composer.append(textarea);
      const send = document.createElement("button");
      send.className = "chat-send-btn--send";
      send.setAttribute("aria-label", sendLabel);
      send.setAttribute("aria-busy", failure === "storage" ? "true" : "false");
      send.disabled = failure !== "none" || sendLabel === "Loading chat";
      const providerHead = document.createElement("div");
      providerHead.className = "model-providers__head";
      const badge = document.createElement("span");
      badge.className = "settings-status";
      badge.textContent = failure === "none" ? "Ready" : "private-badge";
      providerHead.append(badge);
      document.body.append(app, composer, send, providerHead);
      const modelResponses =
        failure === "none"
          ? {}
          : {
              list: {
                ok: true,
                payload: {
                  models:
                    failure === "screenshot"
                      ? []
                      : [
                          { id: "private-model", available: true },
                          { available: false, unavailableReason: "private-reason" },
                          { available: "private-availability" },
                        ],
                  pendingProviders: [],
                  providerOutcomes:
                    failure === "screenshot"
                      ? []
                      : [
                          {
                            provider: "private-provider",
                            profileId: "private-profile",
                            status: "ready",
                          },
                          { status: "private-outcome" },
                        ],
                },
              },
              authStatus: {
                ok: true,
                payload: {
                  providers:
                    failure === "screenshot"
                      ? []
                      : [
                          {
                            profiles: [
                              {
                                profileId: "private-profile",
                                status: "ok",
                                token: "private-token",
                              },
                              { status: "expired" },
                              { status: "private-health" },
                            ],
                          },
                        ],
                },
              },
            };
      vi.stubEnv("VITEST_SHARD_INDEX", shardIndex);
      vi.stubEnv("VITEST_SHARD_COUNT", shardCount);
      vi.stubEnv("SHARD_INDEX", shardIndex ? undefined : "unrelated-shard");
      vi.stubEnv("GITHUB_JOB", "checks-ui-e2e");
      vi.stubEnv("GITHUB_RUN_ID", "123456");
      vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
      writeFileSync(path.join(parent, "prior.png"), "prior-proof");
      // SAFETY: this fixture implements the Page boundary used by failure diagnostics.
      const page = {
        evaluate: async (read: () => unknown) => read(),
        isClosed: () => false,
        url: () => "http://127.0.0.1/chat",
        screenshot: async (options: { path: string }) => {
          expect(
            logs.mock.calls.some(([message]) => message === "[control-ui-e2e] failure state"),
          ).toBe(true);
          if (failure === "screenshot") {
            throw new Error("private-screenshot-error");
          }
          writeFileSync(options.path, "failure-proof");
          return Buffer.from("failure-proof");
        },
      } as unknown as Page;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const original = new Error("private-original-error");
        const failedAction = async () => {
          try {
            throw original;
          } catch (error) {
            await captureControlUiE2eFailureDiagnostics(page, {
              error: original,
              label: "chat.send",
              modelResponses,
            });
            throw error;
          }
        };
        await expect(failedAction()).rejects.toBe(original);
      }
      const directories = readdirSync(parent, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory(),
      );
      const summaries = logs.mock.calls
        .filter(([message]) => message === "[control-ui-e2e] failure state")
        .map(([, summary]) => summary);
      expect(summaries).toHaveLength(2);
      for (const summary of summaries) {
        expect(summary).toMatchObject({
          browser: {
            gatewayPhase: failure === "storage" ? "unknown" : "connected",
            connected: true,
            documentReadyState: expect.stringMatching(/^(?:loading|interactive|complete)$/u),
            providerStatuses: [
              {
                status: failure === "none" ? "Ready" : "unknown",
                length: badge.textContent.length,
              },
            ],
            composer: {
              draftLength: failure === "storage" ? 0 : 13,
              nonempty: failure !== "storage",
              disabled: failure === "storage",
              send: {
                label: sendLabel === "private-label" ? "unknown" : sendLabel,
                labelLength: sendLabel.length,
                disabled: failure !== "none" || sendLabel === "Loading chat",
                busy: failure === "storage",
              },
            },
          },
          models: {
            listSeen: failure !== "none",
            listOk: failure === "none" ? null : true,
            models: failure === "none" ? null : failure === "screenshot" ? 0 : 3,
            available: failure === "none" ? null : failure === "screenshot" ? 0 : 1,
            unavailable: failure === "none" ? null : failure === "screenshot" ? 0 : 1,
            unknownAvailability: failure === "none" ? null : failure === "screenshot" ? 0 : 1,
            pendingProviders: failure === "none" ? null : 0,
            providerOutcomes:
              failure === "none"
                ? null
                : {
                    ready: failure === "storage" ? 1 : 0,
                    "auth-rejected": 0,
                    unavailable: 0,
                    unknown: failure === "storage" ? 1 : 0,
                  },
            authSeen: failure !== "none",
            authOk: failure === "none" ? null : true,
            profiles:
              failure === "none"
                ? null
                : {
                    ok: failure === "storage" ? 1 : 0,
                    expiring: 0,
                    expired: failure === "storage" ? 1 : 0,
                    missing: 0,
                    static: 0,
                    unknown: failure === "storage" ? 1 : 0,
                  },
          },
        });
      }
      expect(JSON.stringify(logs.mock.calls)).not.toContain("private-");
      expect(directories).toHaveLength(failure === "storage" ? 0 : 2);
      for (const directory of directories) {
        const root = path.join(parent, directory.name);
        const files = readdirSync(root);
        expect(files).toHaveLength(failure === "screenshot" ? 1 : 2);
        const reportFile = files.find((file) => file.endsWith(".json"));
        expect(reportFile).toBeDefined();
        const report = JSON.parse(readFileSync(path.join(root, reportFile!), "utf8"));
        expect(report).toMatchObject({
          label: "chat.send",
          captureErrors:
            failure === "screenshot" ? [expect.stringContaining("private-screenshot-error")] : [],
          ci: {
            githubJob: "checks-ui-e2e",
            runAttempt: "2",
            runId: "123456",
            shardIndex: shardIndex ?? null,
            vitestShardCount: shardCount ?? null,
          },
        });
        if (failure === "screenshot") {
          expect(report.screenshot).toBeNull();
        } else {
          expect(files).toContain(report.screenshot);
          expect(readFileSync(path.join(root, report.screenshot), "utf8")).toBe("failure-proof");
        }
      }
      expect(readFileSync(path.join(parent, "prior.png"), "utf8")).toBe("prior-proof");
    },
  );

  it("keeps shared capture disabled until its gate is enabled and uses the supplied owner", async () => {
    const parent = tempDirs.make("control-ui-proof-capture-");
    vi.stubEnv("OPENCLAW_UI_E2E_ARTIFACT_DIR", parent);
    vi.stubEnv("OPENCLAW_CAPTURE_UI_PROOF", "0");
    let directory: string | undefined;
    const owner = {
      get artifactDir() {
        return (directory ??= createControlUiE2eArtifactDir("sidebar", parent));
      },
    };
    const screenshot = vi.fn(async (options: { path: string }) => {
      // A broken caller must fail before it can write outside this test's owned directory.
      expect(options.path).toBe(path.join(owner.artifactDir, "state.png"));
      writeFileSync(options.path, "sidebar-proof");
      return Buffer.from("sidebar-proof");
    });
    const video = vi.fn(() => null);
    // SAFETY: this fixture implements the non-recording Page boundary used by the capture helper.
    const page = { screenshot, video } as unknown as Page;

    await captureSidebarUiProof(owner, page, "state.png");
    expect(readdirSync(parent)).toEqual([]);
    expect(screenshot).not.toHaveBeenCalled();
    expect(video).not.toHaveBeenCalled();

    vi.stubEnv("OPENCLAW_CAPTURE_UI_PROOF", "1");
    await captureSidebarUiProof(owner, page, "state.png");
    expect(readFileSync(path.join(owner.artifactDir, "state.png"), "utf8")).toBe("sidebar-proof");
  });
});

describe("resolvePlaywrightChromiumExecutablePath", () => {
  it("uses a runnable system Chromium when the cached Playwright executable cannot start", () => {
    const systemExecutable = systemChromiumExecutableCandidates[1];

    expect(
      resolvePlaywrightChromiumExecutablePath(
        "/cache/chromium/chrome",
        {},
        (candidate) => candidate === systemExecutable,
      ),
    ).toBe(systemExecutable);
  });

  it("keeps explicit Chromium overrides authoritative", () => {
    expect(
      resolvePlaywrightChromiumExecutablePath(
        "/cache/chromium/chrome",
        { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: " /custom/chromium " },
        () => false,
      ),
    ).toBe("/custom/chromium");
  });
});

describe("waitForControlUiRoute", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps polling while a new tab has no app element", async () => {
    // SAFETY: this fixture implements the Page methods used by the route helper.
    const page = {
      async waitForFunction(
        predicate: (target: { routeId: string }) => boolean,
        target: { routeId: string },
      ) {
        expect(predicate(target)).toBe(false);
        const app = document.createElement("openclaw-app");
        Object.assign(app, {
          runtime: {
            router: {
              getState: () => ({
                status: "success",
                resolvedLocation: { pathname: window.location.pathname },
                matches: [{ routeId: "chat" }],
                pendingMatches: [],
              }),
            },
          },
        });
        document.body.append(app);
        expect(predicate(target)).toBe(true);
        return { dispose: vi.fn() };
      },
      evaluate: (read: () => unknown) => read(),
    } as unknown as Page;

    await waitForControlUiRoute(page, { routeId: "chat" });
  });

  it("preserves readiness failures when the app is still absent", async () => {
    const cause = new Error("Route readiness failed");
    // SAFETY: this fixture implements the Page methods used by the route helper.
    const page = {
      waitForFunction: vi.fn().mockRejectedValue(cause),
      evaluate: (read: () => unknown) => read(),
    } as unknown as Page;

    await expect(waitForControlUiRoute(page, { routeId: "chat" })).rejects.toMatchObject({
      cause,
      message: expect.stringContaining('"router":null'),
    });
  });
});
