import { afterEach, describe, expect, it, vi } from "vitest";
import radiusPlugin from "../../extensions/radius/index.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import { registerSingleProviderPlugin } from "../test-utils/plugin-registration.js";
import { WizardSession } from "../wizard/session.js";
import { runProviderPluginAuthMethodUnpersisted } from "./provider-auth-method.js";
import type { ProviderAuthMethod } from "./provider-authentication.types.js";

const { openHostBrowser, guardedFetch } = vi.hoisted(() => ({
  openHostBrowser: vi.fn(async () => true),
  guardedFetch: vi.fn(),
}));
vi.mock("../infra/browser-open.js", () => ({ openUrl: openHostBrowser }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));

afterEach(() => vi.clearAllMocks());

const destination = "https://provider.example/oauth?state=fixture-state";
const browserMethod: ProviderAuthMethod = {
  id: "oauth",
  label: "OAuth",
  kind: "oauth",
  run: async (ctx) => {
    await ctx.openUrl(destination);
    return { profiles: [] };
  },
};

const options = {
  config: {},
  runtime: createNonExitingRuntime(),
  method: browserMethod,
};

describe("runProviderPluginAuthMethodUnpersisted", () => {
  it.each([false, true])(
    "delivers destinations to presenting clients (remote=%s)",
    async (isRemote) => {
      const openUrl = vi.fn(async () => undefined);
      await runProviderPluginAuthMethodUnpersisted({
        ...options,
        isRemote,
        prompter: createWizardPrompter({ openUrl }),
        method: {
          ...browserMethod,
          run: async (ctx) => {
            expect(ctx.isRemote).toBe(isRemote);
            return browserMethod.run(ctx);
          },
        },
      });
      expect(openUrl).toHaveBeenCalledExactlyOnceWith(destination);
      expect(openHostBrowser).not.toHaveBeenCalled();
    },
  );

  it.each([false, undefined, true])(
    "preserves host opening for non-presenting CLI prompts (remote=%s)",
    async (isRemote) => {
      await runProviderPluginAuthMethodUnpersisted({
        ...options,
        isRemote,
        prompter: createWizardPrompter(),
      });
      if (isRemote === true) {
        expect(openHostBrowser).not.toHaveBeenCalled();
      } else {
        expect(openHostBrowser).toHaveBeenCalledExactlyOnceWith(destination);
      }
    },
  );

  it("keeps explicit browser overrides authoritative", async () => {
    const openUrl = vi.fn(async () => undefined);
    const presentUrl = vi.fn(async () => undefined);
    await runProviderPluginAuthMethodUnpersisted({
      ...options,
      isRemote: false,
      openUrl,
      prompter: createWizardPrompter({ openUrl: presentUrl }),
    });
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(destination);
    expect(presentUrl).not.toHaveBeenCalled();
    expect(openHostBrowser).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps the registered Radius device destination with its code and cancellation (remote=%s)",
    async (isRemote) => {
      guardedFetch.mockResolvedValueOnce({
        response: Response.json({
          device_code: "synthetic-device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://radius.earendil.com/device",
          expires_in: 300,
          interval: 5,
        }),
        release: async () => undefined,
      });
      const provider = await registerSingleProviderPlugin(radiusPlugin);
      const method = provider.auth.find((entry) => entry.id === "oauth");
      if (!method) {
        throw new Error("Radius did not register its OAuth method");
      }
      const session = new WizardSession(async (prompter, signal) => {
        await runProviderPluginAuthMethodUnpersisted({
          ...options,
          method,
          prompter,
          signal,
          isRemote,
        });
      });
      try {
        const pending = await session.next();
        expect(pending.step).toMatchObject({
          type: "progress",
          externalUrl: "https://radius.earendil.com/device",
          deviceCode: { code: "ABCD-EFGH", expiresInMinutes: 5 },
        });
        expect(openHostBrowser).not.toHaveBeenCalled();
        session.cancel();
        expect(await session.next()).toMatchObject({ done: true, status: "cancelled" });
      } finally {
        session.cancel();
        await session.whenSettled();
      }
      expect(guardedFetch).toHaveBeenCalledOnce();
    },
  );
});
