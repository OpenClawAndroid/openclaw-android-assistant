import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type { WorkspaceStateSnapshot } from "../agents/workspace-state-store.kernel.js";
import type {
  ExecutionIdentityInspectionQuery,
  ExecutionIdentityInspectionOutcome,
} from "../audit/execution-identity-inspection.types.js";
import type { FleetCellRecord } from "../fleet/registry.types.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { OnboardingRecommendationsRecord } from "./onboarding-recommendations.contract.js";
import type { OpenClawAgentDatabaseRegistryReadResult } from "./openclaw-agent-db-contract.js";
import type { ConfigMachineState } from "./openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerErrorPayload } from "./openclaw-state-worker-error.js";
import type { ProfileDisplayRow } from "./user-profiles.types.js";

export type OpenClawStateReadLocation = {
  context: OpenClawStateWorkerContext;
  location: string;
  checkFreshAdmission: boolean;
  expectedIdentity?: string;
  snapshotRoot?: string;
};

export type OpenClawStateReadAuthority = {
  signal: AbortSignal;
  assertCurrent(this: void): void;
};

export type OpenClawStateReadCommand =
  | { type: "agentDatabaseRegistry.read" }
  | { type: "onboardingRecommendations.read"; configKey: string }
  | { type: "userProfiles.avatar.reconcile"; profileId: string }
  | { type: "audit.run.inspect"; input: ExecutionIdentityInspectionQuery }
  | { type: "fleet.list" }
  | { type: "fleet.get"; tenantId: string }
  | { type: "nodeHost.config" }
  | { type: "workspace.snapshot"; workspaceDir: string };
export type OpenClawStateReadRequest = {
  context: SqliteWorkerStateContext;
  databasePath: string;
  location: string;
  checkFreshAdmission: boolean;
  expectedIdentity?: string;
  snapshotRoot?: string;
  command: OpenClawStateReadCommand | { type: "admit" };
};
export type OpenClawStateReadReply = (
  | {
      ok: true;
      type: "agentDatabaseRegistry.read";
      sourceAdmitted?: true;
      result: OpenClawAgentDatabaseRegistryReadResult;
    }
  | {
      ok: true;
      type: "onboardingRecommendations.read";
      sourceAdmitted: true;
      record: OnboardingRecommendationsRecord | null;
    }
  | {
      ok: true;
      type: "userProfiles.avatar.reconcile";
      sourceAdmitted: true;
      profile: ProfileDisplayRow | undefined;
    }
  | {
      ok: true;
      type: "audit.run.inspect";
      sourceAdmitted: true;
      result: ExecutionIdentityInspectionOutcome;
    }
  | { ok: true; type: "admit" }
  | { ok: true; type: "fleet.list"; sourceAdmitted: true; cells: FleetCellRecord[] }
  | { ok: true; type: "fleet.get"; sourceAdmitted: true; cell: FleetCellRecord | undefined }
  | {
      ok: true;
      type: "nodeHost.config";
      sourceAdmitted: true;
      row: Pick<Selectable<ConfigMachineState>, "value_json" | "updated_at_ms"> | undefined;
    }
  | { ok: true; type: "workspace.snapshot"; sourceAdmitted: true; snapshot: WorkspaceStateSnapshot }
  | {
      ok: false;
      sourceAdmitted?: true;
      message: string;
      error: OpenClawStateWorkerErrorPayload | undefined;
    }
) & {
  /** A best-effort admission read completed without confirmed native cleanup. */
  nativeCleanupFailure?: { error: OpenClawStateWorkerErrorPayload | undefined };
};

export type OpenClawStateReadOutcome =
  | { value: Extract<OpenClawStateReadReply, { ok: true }> }
  | { error: unknown; sourceAdmitted?: true };

export type ReadResource = { close(): Promise<void> };
export type RetainedReadScope = {
  path: string;
  active: boolean;
  work: AsyncWorkScope;
  resources: Set<ReadResource>;
  close(): Promise<void>;
};

export type OpenClawStateReadOnlyDatabase = {
  db: DatabaseSync;
  path: string;
};
