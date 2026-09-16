import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";

const WORKTREE_CREATE_LEASE_SCOPE = "core:managed-worktrees:create";
const WORKTREE_CREATE_LEASE_MS = 60_000;
const WORKTREE_CREATE_LEASE_WAIT_MS = 10 * 60_000;

/** Hold the existing shared capacity lease for managed or caller-owned creation. */
export async function withWorktreeAllocationLease<T>(
  params: {
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    commitGuard?: () => void;
  },
  run: (guard: WorktreeFilesystemOptions) => Promise<T>,
): Promise<T> {
  // Disk headroom is shared across repositories. Hold one renewable lease
  // through checkout, setup, snapshots, and publication, including CLI processes.
  return await withOpenClawStateLease(
    {
      scope: WORKTREE_CREATE_LEASE_SCOPE,
      key: "capacity",
      database: { scope: "shared", options: { env: params.env } },
      leaseMs: WORKTREE_CREATE_LEASE_MS,
      waitMs: WORKTREE_CREATE_LEASE_WAIT_MS,
      leaseLabel: "managed worktree allocation lease",
      operationLabel: "agents.worktrees.allocation",
      signal: params.signal,
    },
    async (lease) =>
      await run({
        signal: lease.signal,
        commitGuard: () => {
          lease.assertOwned();
          params.commitGuard?.();
        },
      }),
  );
}
