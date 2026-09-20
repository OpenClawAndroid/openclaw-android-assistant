import { createServer, type Server } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { BrowserContext, Frame, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { resolveBrowserConfig } from "../config.js";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import * as pageCdp from "../pw-session.page-cdp.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { getFreePort } from "../test-port.js";
import { registerBrowserAgentRoutes } from "./agent.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const outside = '<button id="outside">Same</button>';
const pair = '<button id="first">Same</button><button id="second">Same</button>';
const group = `<section id="selected" role="group" aria-label="Selected">${pair}</section>`;
const cases = [
  {
    name: "selected root inside shadow DOM",
    html: '<div id="host"></div>',
    shadowRoot: true,
    ids: ["first", "second"],
  },
  {
    name: "transparent wrappers before depth filtering",
    html: `<div id="selected"><div><span>${pair}</span></div></div>`,
    depth: 0,
    ids: ["first", "second"],
  },
  {
    name: "hidden controls omitted",
    html: '<section id="selected" role="group"><button id="visible">Same</button><button id="hidden" hidden>Same</button></section>',
    ids: ["visible"],
  },
  {
    name: "selected root button",
    html: `${outside}<button id="selected">Same</button>`,
    ids: ["selected"],
  },
  {
    name: "selected single duplicate",
    html: `${outside}<section id="selected"><button id="first">Same</button></section>`,
    ids: ["first"],
  },
  { name: "selected duplicate pair", html: outside + group, ids: ["first", "second"] },
  {
    name: "same-origin frame selection",
    html: outside + group,
    frame: "same",
    ids: ["first", "second"],
  },
  {
    name: "external aria-owns order",
    html: `${outside}<section id="selected" role="group" aria-owns="second first"></section>${pair}`,
    ids: ["second", "first"],
  },
  {
    name: "shadow before light duplicate",
    html: '<section id="selected" role="group"><div id="host"></div><button id="light">Same</button></section>',
    shadow: true,
    ids: ["shadow", "light"],
  },
  {
    name: "filtered deep duplicate",
    html: `${outside}<section id="selected" role="group"><div role="group"><button id="deep">Same</button></div><button id="shallow">Same</button></section>`,
    depth: 1,
    ids: ["shallow"],
  },
  {
    name: "cross-origin OOP frame selection",
    html: outside + group,
    frame: "cross",
    ids: ["first", "second"],
  },
  {
    name: "DOM reorder after capture",
    html: outside + group,
    reorder: true,
    ids: ["first", "second"],
  },
  { name: "native aria control", html: group, native: true, ids: ["first", "second"] },
  {
    name: "unscoped external ownership control",
    html: `<section role="group" aria-owns="second first"></section>${pair}`,
    unscoped: true,
    ids: ["second", "first"],
  },
] as const;

describe.runIf(process.env.OPENCLAW_BROWSER_SCOPED_REFS_E2E === "1")(
  "Chromium scoped snapshot-to-action routes",
  () => {
    let context: BrowserContext;
    let page: Page;
    let fixture: Server;
    let fixturePort: number;
    let frameHtml = "";
    let cdpUrl: string;
    let targetId: string;
    let routes: ReturnType<typeof createBrowserRouteApp>;

    beforeAll(async () => {
      fixture = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(req.url === "/child" ? frameHtml : "<title>Scoped snapshot fixture</title>");
      });
      await new Promise<void>((resolve) => {
        fixture.listen(0, resolve);
      });
      const address = fixture.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing fixture port");
      }
      fixturePort = address.port;
      const port = await getFreePort();
      cdpUrl = `http://127.0.0.1:${port}`;
      context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-scoped-refs-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`, "--site-per-process"],
        },
      );
      page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      const session = await context.newCDPSession(page);
      ({
        targetInfo: { targetId },
      } = await session.send("Target.getTargetInfo"));
      await session.detach();
      const state: BrowserServerState = {
        port: 0,
        profiles: new Map(),
        resolved: resolveBrowserConfig({
          defaultProfile: "scoped",
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
          profiles: { scoped: { cdpUrl, color: "#123456", attachOnly: true } },
        }),
      };
      routes = createBrowserRouteApp();
      registerBrowserAgentRoutes(routes.app, createBrowserRouteContext({ getState: () => state }));
    }, 30_000);

    afterAll(async () => {
      await closePlaywrightBrowserConnection({ cdpUrl });
      await context?.close();
      if (fixture) {
        await new Promise<void>((resolve, reject) => {
          fixture.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });

    async function call(method: "get" | "post", route: string, values: Record<string, unknown>) {
      const handler = expectDefined(
        (method === "get" ? routes.getHandlers : routes.postHandlers).get(route),
        route,
      );
      const response = createBrowserRouteResponse();
      const input = { targetId, ...values };
      await handler(
        {
          params: {},
          query: method === "get" ? input : {},
          body: method === "post" ? input : undefined,
        },
        response.res,
      );
      return response;
    }

    it.each(cases)(
      "preserves $name identity",
      async (fixtureCase) => {
        await page.goto(`http://127.0.0.1:${fixturePort}/`);
        let scope: Page | Frame = page;
        if ("frame" in fixtureCase) {
          frameHtml = fixtureCase.html;
          const host = fixtureCase.frame === "cross" ? "localhost" : "127.0.0.1";
          await page.setContent(
            `<iframe id="frame" src="http://${host}:${fixturePort}/child"></iframe>`,
          );
          await page.frameLocator("#frame").locator("#selected").waitFor();
          scope = expectDefined(
            page.frames().find((frame) => frame !== page.mainFrame()),
            "fixture frame",
          );
          if (fixtureCase.frame === "cross") {
            const oopSession = await context.newCDPSession(scope);
            const { targetInfo } = await oopSession.send("Target.getTargetInfo");
            expect(targetInfo.type).toBe("iframe");
            await oopSession.detach();
          }
        } else {
          await page.setContent(fixtureCase.html);
        }
        if ("shadow" in fixtureCase) {
          await page.locator("#host").evaluate((el) => {
            el.attachShadow({ mode: "open" }).innerHTML = '<button id="shadow">Same</button>';
          });
        }
        if ("shadowRoot" in fixtureCase) {
          await page.locator("#host").evaluate((el, html) => {
            el.attachShadow({ mode: "open" }).innerHTML = html;
          }, group);
        }
        await scope.evaluate(() => {
          document.body.dataset.clicked = "[]";
          document.addEventListener("click", (event) => {
            const element = event.composedPath()[0];
            if (element instanceof Element) {
              document.body.dataset.clicked = JSON.stringify([
                ...JSON.parse(document.body.dataset.clicked ?? "[]"),
                element.id,
              ]);
            }
          });
        });
        const snapshot = await call("get", "/snapshot", {
          format: "ai",
          interactive: true,
          ...("native" in fixtureCase
            ? { refs: "aria" }
            : "unscoped" in fixtureCase
              ? {}
              : { selector: "#selected" }),
          ...("frame" in fixtureCase ? { frame: "#frame" } : {}),
          ...("depth" in fixtureCase ? { depth: fixtureCase.depth } : {}),
        });
        expect(snapshot.statusCode, JSON.stringify(snapshot.body)).toBe(200);
        const result = snapshot.body as {
          snapshot: string;
          refs: Record<string, { role: string; name?: string }>;
        };
        const refs = [...result.snapshot.matchAll(/\[ref=([^\]]+)\]/g)]
          .map((match) => match[1]!)
          .filter(
            (ref) => result.refs[ref]?.role === "button" && result.refs[ref]?.name === "Same",
          );
        expect.soft(refs).toHaveLength(fixtureCase.ids.length);
        if ("reorder" in fixtureCase) {
          await scope.locator("#second").evaluate((el) => el.parentElement?.prepend(el));
        }
        const outcomes = [];
        for (const ref of refs) {
          const clicked = await call("post", "/act", { kind: "click", ref, timeoutMs: 500 });
          outcomes.push(clicked.statusCode);
          expect.soft(clicked.statusCode, JSON.stringify(clicked.body)).toBe(200);
        }
        const clickedIds = await scope.evaluate(() =>
          JSON.parse(document.body.dataset.clicked ?? "[]"),
        );
        console.log(
          JSON.stringify({
            case: fixtureCase.name,
            snapshot: result.snapshot,
            outcomes,
            clickedIds,
          }),
        );
        expect(clickedIds).toEqual(fixtureCase.ids);
      },
      30_000,
    );

    it("rejects scoped publication when native markers cannot be installed", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      await page.setContent(outside + group);
      const binding = vi
        .spyOn(pageCdp, "markBackendDomRefsOnPage")
        .mockResolvedValueOnce(new Set());
      try {
        const snapshot = await call("get", "/snapshot", {
          format: "ai",
          selector: "#selected",
          interactive: true,
        });
        expect(snapshot.statusCode).toBe(500);
        expect(snapshot.body).toMatchObject({
          error: expect.stringContaining("before refs were bound"),
        });
      } finally {
        binding.mockRestore();
      }
    });

    it("does not retarget a removed scoped control to an outside duplicate", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      await page.setContent(`${outside}<button id="selected">Same</button><output></output>`);
      await page.locator("#outside").evaluate((el) =>
        el.addEventListener("click", () => {
          document.querySelector("output")!.textContent = "outside";
        }),
      );
      const snapshot = await call("get", "/snapshot", {
        format: "ai",
        selector: "#selected",
        interactive: true,
      });
      expect(snapshot.statusCode, JSON.stringify(snapshot.body)).toBe(200);
      const result = snapshot.body as { refs: Record<string, unknown> };
      const ref = Object.keys(result.refs)[0];
      await page.locator("#selected").evaluate((el) => el.remove());
      const action = await call("post", "/act", { kind: "click", ref, timeoutMs: 500 });
      expect(action.statusCode).toBeGreaterThanOrEqual(400);
      expect(await page.locator("output").textContent()).toBe("");
    });

    it("keeps absent roots empty and preserves selected states, URLs and limits", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      await page.setContent(
        '<section id="selected" role="group"><input type="checkbox" aria-label="Chosen" checked disabled><a href="https://example.test/docs">Docs</a></section>',
      );
      const missing = await call("get", "/snapshot", { format: "ai", selector: "#absent" });
      expect(missing.statusCode).toBe(200);
      expect(missing.body).toMatchObject({ snapshot: "(empty)", refs: {} });
      const selected = await call("get", "/snapshot", {
        format: "ai",
        selector: "#selected",
        urls: true,
      });
      expect(selected.statusCode, JSON.stringify(selected.body)).toBe(200);
      expect(selected.body).toMatchObject({
        snapshot: expect.stringMatching(/checkbox "Chosen".*\[checked\].*\[disabled\]/),
      });
      expect(selected.body).toMatchObject({
        snapshot: expect.stringContaining("https://example.test/docs"),
      });
      const refFree = await call("get", "/snapshot", {
        format: "ai",
        selector: "#selected",
        depth: 0,
        urls: true,
      });
      expect(refFree.body).toMatchObject({
        refs: {},
        snapshot: expect.stringContaining("https://example.test/docs"),
      });
      const bounded = await call("get", "/snapshot", {
        format: "ai",
        selector: "#selected",
        maxChars: 10,
      });
      expect(bounded.body).toMatchObject({ truncated: true });
    });

    it("keeps a frame URL appendix isolated from parent links", async () => {
      await page.goto(`http://127.0.0.1:${fixturePort}/`);
      frameHtml = '<a href="https://frame.test/docs">Frame docs</a>';
      await page.setContent(
        `<a href="https://parent.test/docs">Parent docs</a><iframe id="frame" src="http://localhost:${fixturePort}/child"></iframe>`,
      );
      await page.frameLocator("#frame").getByRole("link").waitFor();
      const snapshot = await call("get", "/snapshot", {
        format: "ai",
        frame: "#frame",
        urls: true,
      });
      expect(snapshot.statusCode, JSON.stringify(snapshot.body)).toBe(200);
      expect(snapshot.body).toMatchObject({
        snapshot: expect.stringContaining("Frame docs -> https://frame.test/docs"),
      });
      expect(snapshot.body).toMatchObject({
        snapshot: expect.not.stringContaining("https://parent.test/docs"),
      });
    });
  },
);
