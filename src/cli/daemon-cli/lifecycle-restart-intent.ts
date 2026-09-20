import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { assertGatewayServiceUpdateCurrent } from "../../daemon/service-update-authority.js";
import type { GatewayService } from "../../daemon/service.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import {
  clearGatewayRestartIntentSync,
  type GatewayRestartIntent,
  type GatewayRestartIntentService,
  writeGatewayRestartIntentSync,
  writeGatewayServiceRestartIntentSync,
} from "../../infra/restart-intent.js";

export function createServiceRestartIntent(params: {
  serviceNoun: string;
  service: GatewayService;
  intent?: GatewayRestartIntent;
  warn: (message: string) => void;
}) {
  let recorded = false;
  let env = process.env;
  return {
    prepare: async () => {
      if (params.serviceNoun !== "Gateway" || recorded) {
        return;
      }
      const runtime = await params.service.readRuntime(process.env).catch(() => null);
      assertGatewayServiceUpdateCurrent();
      const nativeService = process.platform === "linux" || process.platform === "darwin";
      let service: GatewayRestartIntentService | undefined;
      if (nativeService) {
        try {
          const command = await params.service.readCommand(process.env, { requireEffective: true });
          assertGatewayServiceUpdateCurrent();
          env = mergeGatewayServiceEnv(process.env, command);
          service =
            process.platform === "linux"
              ? {
                  kind: "systemd",
                  name: runtime?.systemd?.unit ?? resolveSystemdServiceName(process.env),
                }
              : { kind: "launchd", name: resolveLaunchAgentLabel(process.env) };
        } catch {
          params.warn(
            "Could not verify the serving Gateway owner; using native service status for restart intent.",
          );
        }
      }
      assertGatewayServiceUpdateCurrent();
      const options = {
        env,
        targetPid: runtime?.pid,
        reason: "gateway.restart",
        ...(params.intent ? { intent: params.intent } : {}),
      };
      recorded = nativeService
        ? writeGatewayServiceRestartIntentSync({
            ...options,
            service,
            assertCurrent: assertGatewayServiceUpdateCurrent,
            warn: params.warn,
          })
        : writeGatewayRestartIntentSync(options);
    },
    clear: () => {
      if (recorded) {
        assertGatewayServiceUpdateCurrent();
        clearGatewayRestartIntentSync(env);
        recorded = false;
      }
    },
  };
}
