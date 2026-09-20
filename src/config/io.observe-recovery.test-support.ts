import { vi } from "vitest";
import * as pluginModuleLoader from "../plugins/plugin-module-loader-cache.js";

export const clobberedUpdateChannelConfig = { update: { channel: "beta" } };
export const clobberedUpdateChannelRaw = `${JSON.stringify(clobberedUpdateChannelConfig, null, 2)}\n`;
export const recoverableTelegramConfig = {
  meta: { lastTouchedVersion: "2026.4.22" },
  update: { channel: "beta" },
  gateway: { mode: "local" },
  channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
};
export const recoverableCoreConfig = {
  meta: { lastTouchedVersion: "2026.4.22" },
  update: { channel: "beta" },
  gateway: { mode: "local" as const },
};
export const largeRecoverableCoreConfig = {
  ...recoverableCoreConfig,
  gateway: {
    ...recoverableCoreConfig.gateway,
    trustedProxies: Array.from({ length: 60 }, (_, index) => `192.0.2.${index}`),
  },
};

export async function prepareConfigRecoveryMigrationRuntime(): Promise<() => void> {
  const bindingRepair =
    await import("../commands/doctor/shared/legacy-config-binding-repair.runtime.js");
  const loadModule = pluginModuleLoader.getCachedPluginModuleLoader;
  // Keep the real migrations in Vitest's graph instead of transforming them
  // again through the synchronous source loader used by config recovery.
  const moduleLoader = vi
    .spyOn(pluginModuleLoader, "getCachedPluginModuleLoader")
    .mockImplementation((options) =>
      /legacy-config-binding-repair\.runtime\.[jt]s$/u.test(options.modulePath)
        ? () => bindingRepair
        : loadModule(options),
    );
  return () => moduleLoader.mockRestore();
}
