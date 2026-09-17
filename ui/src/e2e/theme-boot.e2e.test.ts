import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI theme continuity during startup" });
const profileId = "theme-reader";
const secondSessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const variants = [
  { system: "light", mode: "dark", saved: true },
  { system: "dark", mode: "light", saved: true },
  { system: "light", mode: "system", saved: true },
  { system: "dark", mode: "system", saved: true },
  { system: "light", mode: "system", saved: false },
  { system: "dark", mode: "system", saved: false },
] as const;

type ThemeFrame = {
  time: number;
  theme: string | undefined;
  mode: string | undefined;
  html: string;
  body: string;
  background: string;
};

declare global {
  interface Window {
    themeBootFrames: ThemeFrame[];
  }
}

suite.define(() => {
  for (const width of [1440, 390]) {
    it.each(variants)(
      `keeps every painted frame at ${width}px for system=$system mode=$mode saved=$saved`,
      async ({ system, mode, saved }) => {
        await suite.withPage(
          {
            colorScheme: system,
            deviceScaleFactor: 2,
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { width, height: 900 },
          },
          async ({ page }) => {
            const theme = saved ? "rose" : "claw";
            const resolvedMode = mode === "system" ? system : mode;
            const resolvedTheme = saved
              ? resolvedMode === "light"
                ? "rose-light"
                : "rose"
              : resolvedMode;
            const background = saved
              ? resolvedMode === "light"
                ? "rgb(250, 244, 237)"
                : "rgb(25, 23, 36)"
              : resolvedMode === "light"
                ? "rgb(250, 249, 247)"
                : "rgb(14, 16, 21)";
            const contentBackground =
              resolvedMode === "light"
                ? saved
                  ? "rgb(246, 239, 230)"
                  : "rgb(244, 241, 236)"
                : background;
            // Narrow chat chrome uses the selected palette's content surface.
            const allowedBackgrounds =
              width === 390 ? [background, contentBackground] : [background];
            const config = saved
              ? { ui: { prefs: { theme: "absolutely", themeMode: system } } }
              : {};
            const gateway = await installMockGateway(page, {
              presenceUsers: saved ? [{ id: profileId, name: "Theme Reader", self: true }] : [],
              sessions: [
                { key: "agent:main:main", kind: "direct", label: "Home", updatedAt: 2 },
                {
                  key: secondSessionKey,
                  kind: "direct",
                  label: "Second conversation",
                  updatedAt: 1,
                },
              ],
              deferredMethods: saved ? ["users.prefs.get"] : [],
              historyMessages: [{ role: "assistant", content: "Theme continuity is ready." }],
              methodResponses: {
                "config.get": { config, raw: JSON.stringify(config), hash: "theme-boot" },
              },
            });
            await page.addInitScript(
              (seed) => {
                if (!seed.saved || sessionStorage.getItem("theme-boot-seeded")) {
                  return;
                }
                sessionStorage.setItem("theme-boot-seeded", "1");
                localStorage.setItem(
                  `openclaw.control.settings.v1:${seed.gatewayUrl}`,
                  JSON.stringify({
                    gatewayUrl: seed.gatewayUrl,
                    theme: seed.theme,
                    themeMode: seed.mode,
                  }),
                );
                localStorage.setItem(
                  `openclaw.control.serverPrefs.v1:${seed.gatewayUrl}:profile:${seed.profileId}`,
                  JSON.stringify({ theme: seed.theme, themeMode: seed.mode }),
                );
              },
              {
                gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
                theme,
                mode,
                saved,
                profileId,
              },
            );
            // Observe the real boot document before module evaluation and retain
            // transient frames that a final-state assertion cannot detect.
            await page.addInitScript({
              content: `
                window.themeBootFrames = [];
                function sampleThemeFrame() {
                  const root = document.documentElement;
                  if (root && document.body) {
                    const html = getComputedStyle(root);
                    window.themeBootFrames.push({
                      time: performance.now(), theme: root.dataset.theme,
                      mode: root.dataset.themeMode, html: html.backgroundColor,
                      body: getComputedStyle(document.body).backgroundColor,
                      background: html.getPropertyValue('--bg').trim()
                    });
                  }
                  requestAnimationFrame(sampleThemeFrame);
                }
                requestAnimationFrame(sampleThemeFrame);
              `,
            });
            const settleFrames = () =>
              page.evaluate(
                () =>
                  new Promise<void>((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                  }),
              );
            const assertFrames = async () => {
              await settleFrames();
              const frames = await page.evaluate(() => window.themeBootFrames);
              expect(frames.length).toBeGreaterThan(0);
              expect(
                frames.filter(
                  (frame) =>
                    frame.theme !== resolvedTheme ||
                    frame.mode !== resolvedMode ||
                    !allowedBackgrounds.includes(frame.html) ||
                    !allowedBackgrounds.includes(frame.body),
                ),
                "No intermediate gateway palette may replace the saved appearance",
              ).toEqual([]);
            };
            for (const reload of [false, true]) {
              if (reload) {
                await page.reload();
              } else {
                await page.goto(`${suite.server.baseUrl}chat`);
              }
              if (saved) {
                await gateway.waitForRequest("users.prefs.get");
                await page.locator(".agent-chat__composer-combobox textarea").waitFor();
                await settleFrames();
                await gateway.resolveDeferred("users.prefs.get", {
                  status: "ok",
                  entries: { "ui.theme": theme, "ui.themeMode": mode },
                });
              }
              await page.getByText("Theme continuity is ready.", { exact: true }).waitFor();
              await assertFrames();
            }
            await page.locator(".shell-skip-link").focus();
            await page.keyboard.press("ControlOrMeta+Shift+,");
            await waitForControlUiRoute(page, {
              pathname: "/settings/appearance",
              routeId: "appearance",
            });
            await assertFrames();
            await page.goBack();
            await page.locator(".agent-chat__composer-combobox textarea").waitFor();
            await assertFrames();
            const newThread = page.locator("openclaw-app-sidebar .sidebar-brand__new-thread");
            if (width === 390) {
              await page.locator(".chat-pane__nav-toggle").first().click();
            }
            await page
              .locator(
                `.sidebar-recent-session[data-session-key="${secondSessionKey}"] a.sidebar-recent-session__link`,
              )
              .click();
            await gateway.waitForRequest("chat.startup", {
              match: { sessionKey: secondSessionKey },
            });
            await assertFrames();
            if (width === 390) {
              await page.locator(".chat-pane__nav-toggle").first().click();
            }
            await newThread.click();
            await page.locator(".new-session-page__message").waitFor();
            await assertFrames();
          },
        );
      },
    );
  }
});
