import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Usage calendar boundaries" });

suite.define(() => {
  it("keeps hour filtering responsive across the repeated local hour", async () => {
    const date = "2026-11-01";
    const start = Date.parse("2026-11-01T08:30:00Z");
    const end = Date.parse("2026-11-01T10:30:00Z");
    const activeAt = Date.parse("2026-11-01T10:15:00Z");
    const emptyTotals = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const totals = { ...emptyTotals, input: 100, totalTokens: 100 };
    const messages = {
      total: 1,
      user: 1,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      errors: 0,
    };
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
      ? suite.artifactDir
      : undefined;
    await suite.withPage(
      { locale: "en-US", timezoneId: "America/Los_Angeles", serviceWorkers: "block" },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date(end));
        expect(
          await page.evaluate(() =>
            ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"].map((timestamp) => {
              const value = new Date(timestamp);
              return [value.getHours(), value.getTimezoneOffset()];
            }),
          ),
        ).toEqual([
          [1, 420],
          [1, 480],
        ]);
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt: end,
              startDate: date,
              endDate: date,
              sessions: [
                {
                  key: "agent:main:timestamped-no-tokens",
                  label: "Messages without token usage",
                  agentId: "main",
                  updatedAt: end,
                  usage: {
                    ...emptyTotals,
                    firstActivity: start,
                    lastActivity: end,
                    activityDates: [date],
                    messageCounts: { ...messages, total: 2, user: 2 },
                    utcQuarterHourMessageCounts: [34, 42].map((quarterIndex) =>
                      Object.assign({ date, quarterIndex }, messages),
                    ),
                    // Timestamped messages without model usage still produce zero-token buckets.
                    utcQuarterHourTokenUsage: [34, 42].map((quarterIndex) =>
                      Object.assign({ date, quarterIndex }, emptyTotals),
                    ),
                  },
                },
                {
                  key: "agent:main:after-repeated-hour",
                  label: "After the repeated hour",
                  agentId: "main",
                  updatedAt: activeAt,
                  usage: {
                    ...totals,
                    firstActivity: activeAt,
                    lastActivity: activeAt,
                    activityDates: [date],
                    messageCounts: { ...messages, user: 0, assistant: 1 },
                    utcQuarterHourMessageCounts: [
                      { date, quarterIndex: 41, ...messages, user: 0, assistant: 1 },
                    ],
                    utcQuarterHourTokenUsage: [{ date, quarterIndex: 41, ...totals }],
                  },
                },
              ],
              totals,
              aggregates: {
                messages: { ...messages, total: 3, user: 2, assistant: 1 },
                tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
                byModel: [],
                byProvider: [],
                byAgent: [],
                byChannel: [],
                daily: [],
              },
            },
            "usage.cost": { updatedAt: end, days: 1, daily: [{ date, ...totals }], totals },
            "usage.status": { updatedAt: end, providers: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        await page.locator(".usage-select").selectOption("local");
        const dateInputs = await page.locator(".usage-date-input").all();
        expect(dateInputs).toHaveLength(2);
        for (const input of dateInputs) {
          await input.fill(date);
          await input.press("Tab");
        }
        await expect
          .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
          .toMatchObject({
            startDate: date,
            endDate: date,
            mode: "specific",
            timeZone: "America/Los_Angeles",
          });
        const titles = page.locator(".session-bar-title");
        const cells = page.locator(".usage-hour-cell");
        const unfilteredTitles = ["Messages without token usage", "After the repeated hour"];
        await expect.poll(() => titles.allTextContents()).toEqual(unfilteredTitles);
        await expect.poll(() => cells.count()).toBe(24);
        await expect.poll(() => cells.nth(2).getAttribute("aria-label")).toBe("2:00 · 100 tokens");
        await cells.nth(2).click();
        await expect.poll(() => cells.nth(2).getAttribute("aria-pressed")).toBe("true");
        await expect.poll(() => titles.allTextContents()).toEqual(unfilteredTitles);
        await cells.nth(2).click();
        await cells.nth(3).click();
        await expect.poll(() => titles.allTextContents()).toEqual([]);
        await page.getByRole("button", { name: "Remove hours filter", exact: true }).click();
        await expect.poll(() => titles.allTextContents()).toEqual(unfilteredTitles);
        await expect.poll(() => cells.nth(2).getAttribute("aria-pressed")).toBe("false");
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "repeated-hour-filter-restored.png"),
          });
          await writeFile(
            path.join(artifactDir, "repeated-hour-filter.json"),
            JSON.stringify({
              requests: await gateway.getRequests("sessions.usage"),
              restoredSessions: await titles.allTextContents(),
              selectedHours: await page.locator('.usage-hour-cell[aria-pressed="true"]').count(),
            }),
          );
        }
      },
    );
  });

  it("ends a local range at the next calendar midnight after a skipped midnight", async () => {
    const date = "2026-09-06";
    const updatedAt = Date.parse("2026-09-06T15:00:00Z");
    const totals = {
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const points = [
      "2026-09-06T03:59:59.999Z",
      "2026-09-06T04:00:00.000Z",
      "2026-09-07T02:59:59.999Z",
      "2026-09-07T03:00:00.000Z",
      "2026-09-07T03:30:00.000Z",
    ].map((timestamp) => ({
      timestamp: Date.parse(timestamp),
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: 0,
      cumulativeTokens: 100,
      cumulativeCost: 0,
    }));
    await suite.withPage(
      { locale: "en-US", timezoneId: "America/Santiago", serviceWorkers: "block" },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date(updatedAt));
        // Thread-local TZ cannot configure native Date; the browser context owns this zone.
        expect(
          await page.evaluate(() => {
            const start = new Date(2026, 8, 6);
            const end = new Date(2026, 8, 7);
            return [
              start.getHours(),
              end.getHours(),
              (end.getTime() - start.getTime()) / 3_600_000,
            ];
          }),
        ).toEqual([1, 0, 23]);
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt,
              startDate: date,
              endDate: date,
              sessions: [
                {
                  key: "agent:main:skipped-midnight",
                  label: "Skipped midnight",
                  agentId: "main",
                  updatedAt,
                  usage: { ...totals, activityDates: [date] },
                },
              ],
              totals,
              aggregates: {
                messages: {
                  total: 0,
                  user: 0,
                  assistant: 0,
                  toolCalls: 0,
                  toolResults: 0,
                  errors: 0,
                },
                tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
                byModel: [],
                byProvider: [],
                byAgent: [],
                byChannel: [],
                daily: [],
              },
            },
            "usage.cost": { updatedAt, days: 1, daily: [{ date, ...totals }], totals },
            "usage.status": { updatedAt, providers: [] },
            "sessions.usage.timeseries": { points },
            "sessions.usage.logs": { logs: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        await page.locator(".usage-select").selectOption("local");
        const dateInputs = await page.locator(".usage-date-input").all();
        expect(dateInputs).toHaveLength(2);
        for (const input of dateInputs) {
          await input.fill(date);
          await input.press("Tab");
        }
        await expect
          .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
          .toMatchObject({
            startDate: date,
            endDate: date,
            mode: "specific",
            timeZone: "America/Santiago",
          });
        await page.getByRole("button", { name: "Skipped midnight", exact: true }).click();
        await gateway.waitForRequest("sessions.usage.timeseries");
        const bars = page.locator(".session-detail-panel .ts-bar");
        await expect.poll(() => bars.count()).toBe(2);
        await expect
          .poll(() =>
            bars.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("aria-label")),
            ),
          )
          .toEqual([
            "Sep 6, 01:00 AM · 100 tokens · Out 0 · In 100 · CW 0 · CR 0",
            "Sep 6, 11:59 PM · 100 tokens · Out 0 · In 100 · CW 0 · CR 0",
          ]);
        await page.locator(".usage-select").selectOption("utc");
        await expect
          .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
          .toMatchObject({ startDate: date, endDate: date, mode: "utc" });
        await page.getByRole("button", { name: "Skipped midnight", exact: true }).click();
        await expect
          .poll(() =>
            bars.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("aria-label")),
            ),
          )
          .toEqual([
            "Sep 6, 03:59 AM · 100 tokens · Out 0 · In 100 · CW 0 · CR 0",
            "Sep 6, 04:00 AM · 100 tokens · Out 0 · In 100 · CW 0 · CR 0",
          ]);
      },
    );
  });
});
