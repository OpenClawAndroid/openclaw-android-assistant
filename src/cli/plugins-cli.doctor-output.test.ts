import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  withPluginDiagnosticsReportForInspectionMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
} from "./plugins-cli-test-helpers.js";

const originalExitCode = process.exitCode;

describe("plugins cli Doctor JSON", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it.each([
    { name: "unclassified diagnostic", metadata: {} },
    {
      name: "classified diagnostic",
      metadata: { code: "workspace-scope-omitted" },
    },
    {
      name: "SDK compatibility diagnostic",
      metadata: {
        pluginId: "broken",
        code: "sdk-incompatible",
        sdkCompatibility: {
          seam: "openclaw/plugin-sdk/channel-runtime",
          coreVersion: "2026.9.4",
          builtWithOpenClawVersion: "2026.7.1",
          nestedSdk: true,
        },
      },
    },
  ] as const)("emits one sanitized JSON doctor report ($name)", async ({ metadata }) => {
    const homeDir = "/tmp/openclaw-plugin-doctor-home";
    withPluginDiagnosticsReportForInspectionMock.mockImplementation(async (_params, formatReport) =>
      formatReport({
        ...createEmptyPluginRegistry(),
        workspaceScope: "omitted",
        plugins: [
          createPluginRecord({
            id: "broken",
            origin: "config",
            source: `${homeDir}/plugins/broken/index.ts`,
            status: "error",
            error: `failed to load ${homeDir}/plugins/broken/runtime.ts`,
          }),
        ],
        diagnostics: [
          {
            level: "warn",
            pluginId: "broken",
            source: `${homeDir}/plugins/shadowed/index.ts`,
            message:
              "duplicate plugin id resolved by explicit config-selected plugin; " +
              `global plugin will be overridden by config plugin (${homeDir}/plugins/broken/index.ts)`,
          },
          {
            ...metadata,
            level: "warn",
            message: `failed to inspect ${homeDir}/plugins/unreadable`,
          },
        ],
      }),
    );

    await withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
      await runPluginsCommand(["plugins", "doctor", "--json"]);
    });

    expect(process.exitCode).toBe(1);
    expect(pluginsCliRuntimeLogs).toHaveLength(1);
    expect(runtimeErrors).toEqual([]);
    expect(pluginsCliRuntimeLogs[0]).not.toContain(homeDir);
    expect(pluginsCliRuntimeLogs[0]).not.toContain("Plugin errors:");
    expect(pluginsCliRuntimeLogs[0]).not.toContain("Docs:");
    expect(JSON.parse(pluginsCliRuntimeLogs[0] ?? "null")).toEqual({
      ok: false,
      pluginErrors: [
        {
          id: "broken",
          error: "failed to load $OPENCLAW_HOME/plugins/broken/runtime.ts",
          source: "$OPENCLAW_HOME/plugins/broken/index.ts",
        },
      ],
      diagnostics: [
        {
          ...metadata,
          level: "warn",
          message: "failed to inspect $OPENCLAW_HOME/plugins/unreadable",
        },
      ],
      sourceShadowing: [
        {
          pluginId: "broken",
          message:
            "duplicate plugin id resolved by explicit config-selected plugin; " +
            "global plugin will be overridden by config plugin ($OPENCLAW_HOME/plugins/broken/index.ts)",
          active: {
            source: "$OPENCLAW_HOME/plugins/broken/index.ts",
            origin: "config",
            status: "error",
            error: "failed to load $OPENCLAW_HOME/plugins/broken/runtime.ts",
          },
          shadowedSource: "$OPENCLAW_HOME/plugins/shadowed/index.ts",
          repair: [
            "openclaw plugins inspect broken",
            "edit or remove the config-selected plugin source",
            "openclaw plugins registry --refresh",
            "openclaw plugins reload broken",
          ],
        },
      ],
      compatibility: [],
      configurationWarnings: [],
    });
  });
});
