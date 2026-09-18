import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard side-panel selection",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard";
const boardSnapshot = {
  sessionKey,
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [],
};

suite.define(() => {
  it("keeps the selected Side chat and its transcript after reloading a dashboard", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1440 } }, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey,
        sessions: [
          {
            key: sessionKey,
            agentId: "main",
            sessionId: "dashboard-active-panel",
            kind: "direct",
            updatedAt: 1,
            boardFace: "dashboard",
            boardPresentation: "split",
          },
        ],
        featureMethods: ["board.get", "chat.metadata", "chat.startup"],
        methodResponses: {
          "board.get": boardSnapshot,
          "sessions.companion.state": {
            exchanges: [
              {
                question: "What should I check?",
                answer: "Keep this side conversation visible.",
                ts: 1_000,
              },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      await page.locator(".board-session-surface").waitFor();
      await page.locator(".chat-panel-swap").click();
      const dashboardMain = page.locator('[data-panel-slot="dashboard"][data-region="main"]');
      await dashboardMain.waitFor();
      await openChatSidePanelType(page, "Side chat");
      const sideChat = page.getByRole("tab", { name: "Side chat", exact: true });
      const answer = page
        .locator("openclaw-chat-session-rail")
        .getByText("Keep this side conversation visible.", { exact: true });
      await expect.poll(() => sideChat.getAttribute("aria-selected")).toBe("true");
      await answer.waitFor();

      await page.reload();
      await dashboardMain.waitFor();
      await expect.poll(() => sideChat.getAttribute("aria-selected")).toBe("true");
      await answer.waitFor();
    });
  });

  it("restores the saved main and side selection on ordinary dashboard revisits", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storageKey }) => {
          const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<
            string,
            unknown
          >;
          settings.boardSessionViews = { [key]: { activeTabId: "main" } };
          const sidebarSessionLayouts =
            settings.sidebarSessionLayouts && typeof settings.sidebarSessionLayouts === "object"
              ? (settings.sidebarSessionLayouts as Record<string, unknown>)
              : {};
          settings.sidebarSessionLayouts = {
            ...sidebarSessionLayouts,
            [key]: sidebarSessionLayouts[key] ?? {
              columns: [
                {
                  id: "side-panel-column",
                  side: "right",
                  panels: [
                    { id: "terminal", slot: "terminal" },
                    { id: "dashboard", slot: "dashboard" },
                    { id: "conversation", slot: "conversation" },
                  ],
                  activePanelId: "dashboard",
                  height: 360,
                  width: 480,
                },
              ],
              dock: "right",
              mainPanelId: "terminal",
              open: true,
            },
          };
          localStorage.setItem(storageKey, JSON.stringify(settings));
        },
        { key: sessionKey, storageKey: settingsKey },
      );
      await installMockGateway(page, {
        sessionKey,
        featureMethods: ["board.get", "chat.metadata", "chat.startup", "terminal.open"],
        methodResponses: { "board.get": boardSnapshot },
        terminalEnabled: true,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      await page.locator(".board-session-surface").waitFor();
      const terminal = page.locator('[data-panel-slot="terminal"][data-region="main"]');
      const dashboard = page.getByRole("tab", { name: "Dashboard", exact: true });
      await expect.poll(() => dashboard.getAttribute("aria-selected")).toBe("true");
      await terminal.waitFor();
      await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);

      await page.reload();
      await page.locator(".board-session-surface").waitFor();
      await expect.poll(() => dashboard.getAttribute("aria-selected")).toBe("true");
      await terminal.waitFor();
    });
  });
});
