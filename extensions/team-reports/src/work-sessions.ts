import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { z } from "zod";
import { WORK_SESSIONS_PAGE_SIZE } from "./limits.js";

const workSessionSchema = z.object({
  key: z.string(),
  agentId: z.string().optional(),
  displayName: z.string().optional(),
  label: z.string().optional(),
  derivedTitle: z.string().optional(),
  owner: z
    .object({
      actor: z.object({
        type: z.enum(["human", "agent", "system"]),
        label: z.string().optional(),
      }),
    })
    .optional(),
  status: z.enum(["queued", "running", "done", "failed", "killed", "timeout"]).optional(),
  projectId: z.string().optional(),
  incognito: z.literal(true).optional(),
});
const workSessionsSchema = z.object({
  sessions: z.array(workSessionSchema),
  hasMore: z.boolean().optional(),
  nextOffset: z.number().int().nonnegative().nullable().optional(),
});

export type WorkSession = z.infer<typeof workSessionSchema>;
export type WorkSessions =
  | { available: true; sessions: WorkSession[]; nextOffset?: number }
  | { available: false };

/** Request-local projection only: never retain one viewer's sessions in the report store. */
export async function listWorkSessions(
  offset = 0,
  limit = WORK_SESSIONS_PAGE_SIZE,
): Promise<WorkSessions> {
  try {
    const response = await dispatchGatewayMethod("sessions.list", {
      limit,
      offset,
      sortBy: "activity",
      archived: false,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      configuredAgentsOnly: true,
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: true,
      includeLastMessage: false,
    });
    const result = response.ok ? workSessionsSchema.safeParse(response.payload) : undefined;
    if (!result?.success) {
      return { available: false };
    }
    return {
      available: true,
      // Incognito rows never belong in a team activity view, even for their owner.
      sessions: result.data.sessions.filter((row) => !row.incognito),
      ...(result.data.hasMore && result.data.nextOffset != null
        ? { nextOffset: result.data.nextOffset }
        : {}),
    };
  } catch {
    // Session discovery must fail visibly without taking stored reports offline.
    return { available: false };
  }
}
