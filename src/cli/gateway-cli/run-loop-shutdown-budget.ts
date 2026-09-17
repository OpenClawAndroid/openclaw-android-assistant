import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../../daemon/launchd-plist.js";
import {
  GATEWAY_SERVICE_STOP_TIMEOUT_MS,
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
  GATEWAY_SUPERVISOR_EXIT_MARGIN_MS,
} from "../../infra/gateway-shutdown-budget.js";
import { readSystemdStopTimeout } from "../../infra/systemd-stop-timeout.js";

export async function resolveGatewayShutdownBudget(
  supervisor: string | null,
  info: (message: string) => void,
) {
  const stop =
    supervisor === "systemd"
      ? await readSystemdStopTimeout()
      : {
          timeoutMs:
            supervisor === "launchd"
              ? LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000
              : GATEWAY_SERVICE_STOP_TIMEOUT_MS,
          source: supervisor === "launchd" ? "launchd ExitTimeOut" : "Gateway stop policy",
        };
  const timeoutMs = Math.max(
    0,
    Math.min(GATEWAY_SHUTDOWN_TIMEOUT_MS, stop.timeoutMs - GATEWAY_SUPERVISOR_EXIT_MARGIN_MS),
  );
  const reserveMs = Math.min(GATEWAY_SHUTDOWN_RESERVE_MS, timeoutMs);
  return {
    timeoutMs,
    reserveMs,
    log: (phase: "startup" | "shutdown") => {
      info(
        `shutdown budget at ${phase}: drain=${Math.max(0, timeoutMs - GATEWAY_SHUTDOWN_RESERVE_MS)}ms shutdown=${timeoutMs}ms reserve=${reserveMs}ms exitMargin=${GATEWAY_SUPERVISOR_EXIT_MARGIN_MS}ms; source=${stop.source}=${stop.timeoutMs}ms`,
      );
    },
  };
}
