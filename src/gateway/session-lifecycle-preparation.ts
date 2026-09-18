import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";

export type GatewaySessionTitleModelSelection = Pick<
  SessionEntry,
  "agentRuntimeOverride" | "authProfileOverride" | "modelOverride" | "providerOverride"
>;

export type PreparedGatewaySessionLifecycle = {
  spawnedCwd?: string;
  sessionRoot?: string;
  worktree?: NonNullable<SessionEntry["worktree"]>;
  repositoryWorkspaceId?: string;
  pendingWorktree?: SessionEntry["pendingWorktree"];
  /** Reacquire source custody only around the final persistence operation. */
  withCommit?: <T>(run: (assertSourceCurrent: () => void) => Promise<T>) => Promise<T>;
  rollback?: () => Promise<void>;
};

export type PrepareGatewaySessionLifecycle = (target: {
  agentId: string;
  entry?: SessionEntry;
  key: string;
  storePath: string;
  titleModelSelection?: GatewaySessionTitleModelSelection | null;
  projectId?: string;
  /** Inherited or existing policy, resolved while the creation owner holds lifecycle custody. */
  sandboxRequired?: boolean;
}) => Promise<Result<PreparedGatewaySessionLifecycle, ErrorShape>>;

/** Join recorded commit actions even when the enclosing source scope fails during cleanup. */
export async function settleGatewaySessionLifecycleCommit<T>(
  commit: Promise<T>,
  afterCommit: () => void | Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await commit;
  } catch (error) {
    try {
      await afterCommit();
    } catch (postCommitError) {
      throw new AggregateError(
        [error, postCommitError],
        "Session reset source cleanup and post-commit actions failed",
        { cause: postCommitError },
      );
    }
    throw error;
  }
  await afterCommit();
  return result;
}

export async function rollbackGatewaySessionPreparation(params: {
  onError?: (error: unknown) => void;
  prepared?: PreparedGatewaySessionLifecycle;
}): Promise<void> {
  try {
    await params.prepared?.rollback?.();
  } catch (error) {
    params.onError?.(error);
  }
}
