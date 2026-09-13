import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat startup request priority" });
const sessionKey = "agent:research:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const historyText = "Authoritative selected conversation.";
const bulkMethods = ["sessions.list", "sessions.catalog.list"];

async function installStartupGateway(page: Page) {
  const config = { tools: { swarm: { enabled: true } } };
  return installMockGateway(page, {
    defaultAgentId: "main",
    assistantAgentId: "main",
    mainSessionKey: "agent:main:main",
    sessionKey,
    sessions: [{ key: sessionKey, kind: "direct", label: "Selected conversation", updatedAt: 1 }],
    historyMessages: [{ role: "assistant", content: historyText }],
    deferredMethods: ["chat.startup"],
    heldMethods: bulkMethods,
    featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
    methodResponses: {
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "research", name: "Research" },
        ],
      },
      "sessions.catalog.list": { catalogs: [] },
      "config.get": {
        raw: JSON.stringify(config),
        hash: "synthetic-swarm-enabled",
        config,
        sourceConfig: config,
        runtimeConfig: config,
      },
    },
  });
}

type Gateway = Awaited<ReturnType<typeof installStartupGateway>>;

async function openPendingChat(page: Page, gateway: Gateway) {
  await page.goto(`${suite.server.baseUrl}chat/research/selected-conversation-12345678`);
  const resolution = await gateway.waitForRequest("sessions.resolve");
  expect(resolution.params).toMatchObject({ agentId: "research", shortId: "12345678" });
  const startup = await gateway.waitForRequest("chat.startup");
  expect(startup.params).toMatchObject({ sessionKey });
  const subscription = await gateway.waitForRequest("sessions.subscribe");
  expect(subscription.params).toEqual({});
  await page
    .locator(".chat-pane-cache__pane--active .chat-thread .lazy-view-state--loading")
    .waitFor();
}

async function expectBulkReadsHeld(gateway: Gateway) {
  // Cover the event refresh debounce as well as immediate mount requests.
  const deadline = Date.now() + 500;
  do {
    for (const method of bulkMethods) {
      expect(await gateway.getRequests(method), `${method} before chat startup settled`).toEqual(
        [],
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  } while (Date.now() < deadline);
}

async function expectBulkReadsReleased(gateway: Gateway) {
  for (const method of bulkMethods) {
    await gateway.waitForRequest(method, { match: { agentId: "research" } });
    await gateway.resolveDeferred(method);
  }
}

suite.define(() => {
  it("loads selected history before automatic rosters, including event refreshes, and keeps live messages", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installStartupGateway(page);
      try {
        await openPendingChat(page, gateway);
        await expectBulkReadsHeld(gateway);
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "research",
          sessionKey,
          reason: "patch",
        });
        await gateway.emitGatewayEvent("presence", {
          presence: [{ instanceId: "synthetic-worker", mode: "node", host: "fixture", ts: 1 }],
        });
        await expectBulkReadsHeld(gateway);
        expect(await gateway.getRequests("sessions.list", { spawnedBy: sessionKey })).toEqual([]);

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "01-selected-chat-pending.png"),
          });
        }

        await gateway.resolveDeferred("chat.startup");
        const transcript = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await transcript.getByText(historyText, { exact: true }).waitFor();
        const composer = page.locator(
          ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
        );
        const draft = "Synthetic draft while background lists are pending.";
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await composer.fill(draft);
        await gateway.waitForRequest("sessions.messages.subscribe", { match: { key: sessionKey } });
        // Bulk replies are still held: the selected transcript and its live stream must work alone.
        await gateway.deferNext("chat.history");
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          messageId: "synthetic-live-answer",
          messageSeq: 2,
          session: { key: sessionKey, kind: "direct", updatedAt: 2 },
          message: {
            role: "user",
            content: [{ type: "text", text: "Live peer message after startup." }],
            __openclaw: { id: "synthetic-live-answer", seq: 2 },
          },
        });
        await transcript.getByText("Live peer message after startup.", { exact: true }).waitFor();
        expect(await composer.inputValue()).toBe(draft);
        expect(await composer.isEditable()).toBe(true);
        await composer.fill(`${draft} Still editable.`);
        expect(await composer.inputValue()).toBe(`${draft} Still editable.`);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "02-selected-chat-completed.png"),
          });
        }
        await expectBulkReadsReleased(gateway);
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: sessionKey } });
      } finally {
        await writeFile(
          path.join(suite.artifactDir, "selected-chat-startup-requests.json"),
          JSON.stringify(await gateway.getRequests(), null, 2),
        );
      }
    });
  });

  it("lets an explicit sidebar filter load while the selected transcript is still pending", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installStartupGateway(page);
      await openPendingChat(page, gateway);
      await expectBulkReadsHeld(gateway);
      await gateway.setSessionsListResponse({
        ts: 2,
        path: "",
        count: 1,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: [
          {
            key: "agent:research:archived-fixture",
            kind: "direct",
            label: "Archived fixture",
            updatedAt: 2,
            archived: true,
          },
        ],
      });
      await page.getByRole("button", { name: "Filter & sort" }).click();
      await page
        .locator(".sidebar-session-sort-menu")
        .getByRole("menuitemradio", { name: "Archived", exact: true })
        .click();
      await gateway.waitForRequest("sessions.list", {
        match: { agentId: "research", archived: true },
      });
      await gateway.resolveDeferred("sessions.list");
      await page
        .locator("openclaw-app-sidebar")
        .getByText("Archived fixture", { exact: true })
        .waitFor();
      expect(await gateway.getRequests("sessions.catalog.list")).toEqual([]);
      expect(await gateway.getRequests("sessions.list", { spawnedBy: sessionKey })).toEqual([]);
      expect(await page.getByText(historyText, { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      await page
        .locator(".chat-pane-cache__pane--active .chat-thread .lazy-view-state--loading")
        .waitFor();
      await gateway.resolveDeferred("chat.startup");
      await page.locator(".chat-thread").getByText(historyText, { exact: true }).waitFor();
    });
  });

  it.each(["failed startup", "New Session navigation"] as const)(
    "releases background reads after %s retires the pending chat",
    async (outcome) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installStartupGateway(page);
        await openPendingChat(page, gateway);
        await expectBulkReadsHeld(gateway);
        if (outcome === "failed startup") {
          await gateway.rejectDeferred("chat.startup", {
            code: "GATEWAY_UNAVAILABLE",
            message: "Synthetic history unavailable.",
          });
          await page.getByRole("alert").getByText("Synthetic history unavailable.").waitFor();
        } else {
          await page.locator("openclaw-app-sidebar .sidebar-brand__new-thread").click();
          await page.waitForURL((url) => url.pathname === "/new");
          await page.locator("openclaw-new-session-page").waitFor();
        }
        await expectBulkReadsReleased(gateway);
        if (outcome === "New Session navigation") {
          await gateway.resolveDeferred("chat.startup");
          expect(new URL(page.url()).pathname).toBe("/new");
          expect(await page.getByText(historyText, { exact: true }).isVisible()).toBe(false);
        }
      });
    },
  );
});
