import type { SystemInfoResult } from "../../../packages/gateway-protocol/src/schema/system-info.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

/** Read process counters without projecting sessions, tasks, or channel state. */
export function readGatewayProcessVitals(
  getEventLoopHealth: (() => GatewayEventLoopHealth | undefined) | undefined,
): Pick<SystemInfoResult, "eventLoop" | "processMemory"> {
  const eventLoop = getEventLoopHealth?.();
  const memory = process.memoryUsage();
  return {
    ...(eventLoop ? { eventLoop } : {}),
    processMemory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
  };
}
