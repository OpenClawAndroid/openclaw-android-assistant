import { describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

describe("gateway chat metadata runtime", () => {
  test("publishes mutable catalog progress and failure changes once each", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    const catalog = harness.getPreparedOwner()!.modelCatalog;
    try {
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledOnce();

      catalog.pendingProviders = ["test"];
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledTimes(2);
      catalog.pendingProviders = ["test"];
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledTimes(2);

      catalog.pendingProviders = undefined;
      catalog.refreshFailed = true;
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledTimes(3);

      catalog.refreshFailed = undefined;
      await harness.runtime.refresh();
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledTimes(4);
    } finally {
      await harness.runtime.stop();
    }
  });

  test.each([
    { settlement: "resolve", explicitInvalidation: true },
    { settlement: "reject", explicitInvalidation: true },
    { settlement: "resolve", explicitInvalidation: false },
    { settlement: "reject", explicitInvalidation: false },
  ] as const)(
    "retries a session projection after late $settlement (explicit invalidation: $explicitInvalidation)",
    async ({ settlement, explicitInvalidation }) => {
      const harness = createChatMetadataHarness();
      await harness.runtime.refresh();
      const releaseProjection = createDeferred();
      harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
        await releaseProjection.promise;
        if (settlement === "reject") {
          throw new Error("obsolete projection failed");
        }
        return {
          modelCatalog: facts.owner.modelCatalog.entries,
          models: facts.owner.modelCatalog.entries,
        };
      });

      let settled = false;
      const read = harness.runtime
        .read({
          agentId: "main",
          sessionEntry: {
            authProfileOverride: "test:session",
            authProfileOverrideSource: "user",
          },
        })
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(2));

      const nextConfig = {
        agents: { list: [{ id: "main", default: true }] },
        tools: { swarm: { enabled: true } },
      };
      harness.setConfig(nextConfig);
      harness.setOwner(createChatMetadataOwner(nextConfig, "replacement"));
      const releaseCommands = createDeferred();
      harness.buildCommands.mockImplementationOnce(async () => {
        await releaseCommands.promise;
        return { commands: [] };
      });
      if (explicitInvalidation) {
        harness.runtime.invalidate();
      }
      const refresh = harness.runtime.refresh();
      void read.catch(() => {});
      try {
        releaseProjection.resolve();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        releaseCommands.resolve();
        await refresh;
        await expect(read).resolves.toMatchObject({
          models: [expect.objectContaining({ id: "replacement" })],
          swarmEnabled: true,
        });
      } finally {
        releaseCommands.resolve();
        await Promise.allSettled([read, refresh]);
        await harness.runtime.stop();
      }
    },
  );

  test.each(["resolve", "reject"] as const)(
    "discards a late projection's %s after a usage-only revision changes",
    async (settlement) => {
      const harness = createChatMetadataHarness(undefined, { refreshOnRead: false });
      const blocked: AuthProfileStore = {
        version: 1,
        profiles: { "test:session": { type: "api_key", provider: "test", key: "not-real" } },
        usageStats: { "test:session": { cooldownUntil: Date.now() + 60_000 } },
      };
      harness.setAuthStore(blocked);
      const project = async ({ facts }: Parameters<typeof harness.buildProjection>[0]) => ({
        modelCatalog: facts.modelCatalog.entries,
        models: facts.modelCatalog.entries.map((entry) => ({
          ...entry,
          available: !facts.authStore.usageStats?.["test:session"]?.cooldownUntil,
        })),
      });
      harness.buildProjection.mockImplementation(project);
      await harness.runtime.refresh();
      const entered = createDeferred();
      const release = createDeferred();
      harness.buildProjection.mockImplementationOnce(async (params) => {
        entered.resolve();
        await release.promise;
        if (settlement === "reject") {
          throw new Error("obsolete usage projection failed");
        }
        return project(params);
      });
      const reading = harness.runtime.read({
        agentId: "main",
        sessionEntry: { authProfileOverride: "test:session" },
      });
      try {
        await entered.promise;
        harness.setAuthStore({ ...blocked, usageStats: {} });
        harness.setAuthStoreRevision(2);
        release.resolve();
        await expect(reading).resolves.toMatchObject({
          models: [expect.objectContaining({ available: true })],
        });
      } finally {
        release.resolve();
        await Promise.allSettled([reading, harness.runtime.stop()]);
      }
    },
  );
});
