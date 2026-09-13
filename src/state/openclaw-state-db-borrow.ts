import type { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";

export type StateDatabaseBorrowers = {
  references: Set<object>;
  retiring: boolean;
  cleanupComplete: boolean;
  closeCoordinator?: ReturnType<typeof acquireStateDatabaseCoordinator>;
};

export function assertStateDatabaseBorrowersReleased(
  owner: StateDatabaseBorrowers | undefined,
  pathname: string,
): void {
  if (owner?.references.size) {
    throw new Error(`OpenClaw state database still has active native borrowers: ${pathname}`);
  }
}

/** The cache supplies native retirement; each reference owns only its release protocol. */
export function retainStateDatabaseReference(params: {
  owner: StateDatabaseBorrowers;
  retire(): void;
  retainFailedClose(): void;
}): { release(): void } {
  const { owner } = params;
  const reference = {};
  owner.references.add(reference);
  let released = false;
  return {
    release() {
      if (released || owner.cleanupComplete) {
        released = true;
        return;
      }
      owner.references.delete(reference);
      if (owner.references.size > 0) {
        released = true;
        return;
      }
      owner.retiring = true;
      try {
        params.retire();
      } catch (error) {
        // The released reference transfers failed cleanup to the canonical cache.
        params.retainFailedClose();
        throw error;
      }
      released = true;
    },
  };
}
