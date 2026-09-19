import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as authPaths from "../auth-profiles/path-resolve.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  noteRuntimeAuthProfileStorePersistedMutation,
} from "../auth-profiles/runtime-snapshots.js";
import * as sqliteRead from "../auth-profiles/sqlite-read.js";
import type { AuthProfileRowRead } from "../auth-profiles/types.js";
import { resolveDynamicModelAuthProfile } from "./model.registry-resolution.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  "one rotation",
  "continued rotation",
  "pinned profile rotation",
  "cleanup failure",
  "admission refusal",
] as const)("resolves model auth across %s during its captured read", async (change) => {
  const root = tempDirs.make("openclaw-model-auth-race-");
  const agentDir = path.join(root, "agents/main/agent");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.spyOn(authPaths, "resolveSharedAuthStoreOwnershipAsync").mockResolvedValue({
    location: "legacy-main",
  });
  const events: string[] = [];
  const refusal = new Error("Auth source admission revoked");
  const cleanupFailure = new Error("Auth child failed to close");
  let reads = 0;
  vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockImplementation(() => ({
    assertCurrent: () => {},
    dispose: async () => {
      events.push("disposed");
      if (change === "cleanup failure") {
        throw cleanupFailure;
      }
    },
    read: async (): Promise<AuthProfileRowRead> => {
      events.push("read");
      reads += 1;
      if (change === "admission refusal") {
        throw refusal;
      }
      const profileId = reads === 1 ? "custom:retired" : "custom:current";
      if (reads === 1 || change === "continued rotation") {
        noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
          credentialsChanged: true,
          stateChanged: false,
          profileIds: [profileId],
        });
      }
      return {
        store: {
          status: "readable",
          raw: {
            version: 1,
            profiles: { [profileId]: { type: "api_key", provider: "custom", key: "fixture" } },
          },
        },
        state: { status: "missing", reason: "row" },
        cacheable: true,
      };
    },
  }));

  const resolution = resolveDynamicModelAuthProfile({
    provider: "custom",
    modelId: "fixture",
    agentDir,
    ...(change === "pinned profile rotation" ? { authProfileId: "custom:retired" } : {}),
  });
  if (change === "one rotation") {
    await expect(resolution).resolves.toEqual({
      authProfileId: "custom:current",
      authProfileMode: "api_key",
    });
  } else if (change === "continued rotation") {
    await expect(resolution).rejects.toThrow("Auth profile store changed during its runtime read");
  } else if (change === "pinned profile rotation") {
    await expect(resolution).rejects.toMatchObject({
      code: "selected_auth_profile_unavailable",
      profileId: "custom:retired",
    });
  } else if (change === "admission refusal") {
    await expect(resolution).rejects.toBe(refusal);
  } else {
    await expect(resolution).rejects.toMatchObject({
      errors: [expect.any(Error), cleanupFailure],
    });
  }
  expect(events).toEqual(
    change === "cleanup failure" || change === "admission refusal"
      ? ["read", "disposed"]
      : ["read", "disposed", "read", "disposed"],
  );
});
