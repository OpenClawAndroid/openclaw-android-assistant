import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";

// Snapshot preparation can be disk-heavy; overlap one additional agent
// without fanning out across every registered database.
export const AGENT_DATABASE_PREFLIGHT_CONCURRENCY = 2;

export async function preflightAgentDatabasesBounded<T>(
  targets: readonly T[],
  inspect: (
    target: T,
    inspection: OpenClawDatabaseSchemaPreflight,
    claimAgentTarget: (realPath: string, agentId: string | undefined) => boolean,
  ) => Promise<void>,
  result: OpenClawDatabaseSchemaPreflight,
  signal?: AbortSignal,
): Promise<void> {
  const inspectedAgentPaths = new Set<string>();
  const inspectedAgentTargets = new Set<string>();
  const claimAgentTarget = (realPath: string, agentId: string | undefined) => {
    const inspectionKey = `${realPath}\0${agentId ?? ""}`;
    if (
      inspectedAgentTargets.has(inspectionKey) ||
      (agentId === undefined && inspectedAgentPaths.has(realPath))
    ) {
      return false;
    }
    inspectedAgentPaths.add(realPath);
    inspectedAgentTargets.add(inspectionKey);
    return true;
  };

  const inspections: Array<OpenClawDatabaseSchemaPreflight | undefined> = [];
  const failures = new Map<number, unknown>();
  let nextInspectionIndex = 0;

  const worker = async () => {
    while (true) {
      if (signal?.aborted || failures.size > 0) {
        return;
      }

      const index = nextInspectionIndex;
      if (index >= targets.length) {
        return;
      }
      nextInspectionIndex += 1;

      const target = targets[index];
      if (target === undefined) {
        continue;
      }

      const inspection: OpenClawDatabaseSchemaPreflight = {
        incompatible: [],
        indeterminate: [],
      };
      try {
        await inspect(target, inspection, claimAgentTarget);
        inspections[index] = inspection;
      } catch (error) {
        failures.set(index, error);
        return;
      }
    }
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(AGENT_DATABASE_PREFLIGHT_CONCURRENCY, targets.length),
      },
      () => worker(),
    ),
  );

  // Workers are fully joined before propagating failure or cancellation so
  // every started database close and snapshot cleanup has completed.
  for (let index = 0; index < targets.length; index += 1) {
    if (failures.has(index)) {
      throw failures.get(index);
    }
  }
  signal?.throwIfAborted();

  // Preserve serial-result ordering even when inspections finish out of order.
  for (const inspection of inspections) {
    if (inspection === undefined) {
      continue;
    }
    result.incompatible.push(...inspection.incompatible);
    result.indeterminate.push(...inspection.indeterminate);
    if (inspection.agentRefusals?.length) {
      (result.agentRefusals ??= []).push(...inspection.agentRefusals);
    }
    if (inspection.pendingMigrations?.length) {
      (result.pendingMigrations ??= []).push(...inspection.pendingMigrations);
    }
  }
}
