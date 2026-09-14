import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Systems workspace mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("loads the lazy workspace and keeps its machine picker aligned after navigation", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["environments.list", "node.list", "system.info"],
      methodResponses: {
        "environments.list": {
          environments: [
            { id: "gateway", type: "local", label: "Gateway machine", status: "available" },
            { id: "worker-one", type: "worker", label: "Cloud worker", status: "available" },
          ],
        },
        "node.list": { nodes: [] },
        "system.info": {
          machineName: "Gateway machine",
          hostname: "gateway.test",
          platform: "linux",
          release: "test",
          arch: "x64",
          osLabel: "Linux",
          nodeVersion: "v26",
          pid: 1,
          uptimeMs: 1000,
          cpuCount: 4,
          loadAverage: [0.5, 0.4, 0.3],
          memoryTotalBytes: 8192,
          memoryFreeBytes: 4096,
        },
      },
    });
    try {
      await page.goto(suite.server.baseUrl + "systems");
      await gateway.waitForRequest("environments.list");
      const inventory = page.locator(".systems-sidebar");
      await inventory.getByRole("button", { name: /Cloud worker/ }).click();
      await expect
        .poll(() => page.locator(".systems-heading h1").textContent())
        .toBe("Cloud worker");
      await page.locator('.sidebar-nav a[href$="/dashboards"]').click();
      await expect.poll(() => page.locator(".systems-sidebar").count()).toBe(0);
      await page.locator('.sidebar-nav a[href$="/systems"]').click();
      await expect
        .poll(() => page.locator(".systems-heading h1").textContent())
        .toBe("Cloud worker");
      await page.setViewportSize({ width: 640, height: 900 });
      const picker = page.locator(".systems-mobile-picker");
      await expect.poll(() => picker.isVisible()).toBe(true);
      expect(await picker.inputValue()).toBe("worker-one");
      expect(await page.locator("openclaw-systems-page").count()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
