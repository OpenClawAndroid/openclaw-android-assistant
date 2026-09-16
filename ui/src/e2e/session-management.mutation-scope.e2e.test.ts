import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps the selected agent's rows and pagination after a previous agent's rename settles", async () => {
    const artifactDir = createControlUiE2eArtifactDir("session-mutation-scope");
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const original = sessionRow("agent:main:rename-cross-agent", "Original name", 3);
    const mainRows = [sessionRow("agent:main:main", "Main", 1), original];
    const researchRows = [
      sessionRow("agent:research:main", "Research", 4),
      sessionRow("agent:research:first", "Research first", 3),
      sessionRow("agent:research:second", "Research second", 2),
    ];
    const gateway = await installMockGateway(page, {
      sessions: [...mainRows, ...researchRows],
      sessionKey: original.key,
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", name: "Main" },
            { id: "research", name: "Research" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "sessions.list": {
          cases: [
            {
              match: { agentId: "research", offset: 2 },
              response: sessionsListResponse(researchRows.slice(2), { offset: 2, totalCount: 3 }),
            },
            {
              match: { agentId: "research" },
              response: sessionsListResponse(researchRows.slice(0, 2), {
                hasMore: true,
                nextOffset: 2,
                totalCount: 3,
              }),
            },
            { response: sessionsListResponse(mainRows) },
          ],
        },
      },
    });
    const sidebar = page.locator("openclaw-app-sidebar");
    const rowFor = (key: string) =>
      sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
    const capture = (stage: string) =>
      page.screenshot({ path: path.join(artifactDir, `${stage}.png`) });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, original.key));
      await rowFor(original.key).waitFor({ state: "visible" });
      await gateway.deferNext("sessions.patch", { key: original.key, label: "Renamed original" });
      await page.locator(".chat-pane__session-title-button").click();
      const input = page.locator(".chat-pane__session-title-input");
      await input.fill("Renamed original");
      await input.press("Enter");
      const request = await waitForPatch(gateway, (params) => params.label === "Renamed original");
      expect(request.params).toMatchObject({
        key: original.key,
        expectedSessionId: original.sessionId,
      });
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator("wa-dropdown.sidebar-agent-menu")
        .getByRole("menuitemradio", { name: "Research", exact: true })
        .click();
      await rowFor(researchRows[1]!.key).waitFor({ state: "visible" });
      await sidebar
        .getByRole("button", { name: "Load more sessions", exact: true })
        .waitFor({ state: "visible" });
      await capture("before-rename-response");
      const listsBefore = (
        await gateway.getRequests("sessions.list", { agentId: "main", includeGlobal: true })
      ).length;
      await gateway.deferNext("sessions.list", { agentId: "main", includeGlobal: true });
      await gateway.resolveDeferred("sessions.patch");
      await gateway.waitForRequest("sessions.list", {
        after: listsBefore,
        match: { agentId: "main", includeGlobal: true },
      });
      await gateway.resolveDeferred("sessions.list");
      await capture("after-rename-response");
      await rowFor(researchRows[1]!.key).waitFor({ state: "visible" });
      await sidebar.getByRole("button", { name: "Load more sessions", exact: true }).click();
      await gateway.waitForRequest("sessions.list", { match: { agentId: "research", offset: 2 } });
      await rowFor(researchRows[2]!.key).waitFor({ state: "visible" });
      await capture("after-pagination");
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator("wa-dropdown.sidebar-agent-menu")
        .getByRole("menuitemradio", { name: "Main", exact: true })
        .click();
      await expect.poll(() => rowFor(original.key).textContent()).toContain("Renamed original");
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator("wa-dropdown.sidebar-agent-menu")
        .getByRole("menuitemradio", { name: "Research", exact: true })
        .click();
      await rowFor(researchRows[1]!.key).waitFor({ state: "visible" });
      await sidebar.getByRole("button", { name: "Load more sessions", exact: true }).click();
      await rowFor(researchRows[2]!.key).waitFor({ state: "visible" });
    } finally {
      await capture("final-state");
      await writeFile(
        path.join(artifactDir, "observations.json"),
        JSON.stringify(
          {
            url: page.url(),
            rows: await sidebar.locator(".sidebar-recent-session").allTextContents(),
            listRequests: (await gateway.getRequests("sessions.list")).map(({ params }) => params),
            patchRequests: (await gateway.getRequests("sessions.patch")).map(
              ({ params }) => params,
            ),
          },
          null,
          2,
        ),
      );
      await context.close();
    }
  });
});
