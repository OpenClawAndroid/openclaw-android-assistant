import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import {
  clickChromeMcpCoords,
  closeChromeMcpSession,
  evaluateChromeMcpScript,
  listChromeMcpTabs,
  navigateChromeMcpPage,
  openChromeMcpTab,
  selectChromeMcpOption,
  takeChromeMcpSnapshot,
} from "./chrome-mcp.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_MCP_E2E === "1")(
  "pinned Chrome MCP in Chromium",
  () => {
    it("preserves native input, option values, and operation outcomes", async () => {
      const port = await getFreePort();
      const profile = { cdpUrl: `http://127.0.0.1:${port}` };
      const profileName = "mcp-contract-proof";
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-mcp-contract-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.setContent(`<!doctype html>
        <input id="focus" style="position:absolute;left:10px;top:10px;width:100px;height:30px">
        <iframe style="position:absolute;left:200px;top:10px;width:100px;height:80px;border:0"
          srcdoc="<button style='width:80px;height:50px' onclick='parent.document.body.dataset.frame = event.isTrusted'>Frame</button>"></iframe>
        <div id="shadow" style="position:absolute;left:400px;top:10px"></div>
        <select aria-label="Country" style="position:absolute;left:10px;top:120px">
          <option value="CA">Region</option><option value="US">Region</option>
          <option value="">Empty</option><option value="  spaced  ">Spaced</option>
        </select>
        <script>
          document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML =
            '<button style="width:80px;height:50px">Shadow</button>';
          document.querySelector('#shadow').shadowRoot.querySelector('button').onclick =
            (event) => { document.body.dataset.shadow = event.isTrusted; };
          document.querySelector('select').addEventListener('change', () => {
            document.body.dataset.selected = document.querySelector('select').value;
          });
        </script>`);
        const tabs = await listChromeMcpTabs(profileName, profile, { timeoutMs: 30_000 });
        const target = { profileName, profile, targetId: tabs[0]!.targetId, timeoutMs: 10_000 };
        await clickChromeMcpCoords({ ...target, x: 30, y: 25 });
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("focus");
        await clickChromeMcpCoords({ ...target, x: 230, y: 35 });
        await clickChromeMcpCoords({ ...target, x: 430, y: 35 });
        expect(
          await page.evaluate(() => ({
            frame: document.body.dataset.frame,
            shadow: document.body.dataset.shadow,
          })),
        ).toMatchObject({
          frame: "true",
          shadow: "true",
        });
        const root = await takeChromeMcpSnapshot(target);
        const nodes: ChromeMcpSnapshotNode[] = [root];
        let uid: string | undefined;
        while (nodes.length) {
          const node = nodes.pop()!;
          if (node.role?.toLowerCase() === "combobox" && node.name === "Country") {
            uid = node.id;
          }
          nodes.push(...(node.children ?? []));
        }
        expect(uid).toBeTypeOf("string");
        for (const value of ["US", "", "  spaced  "]) {
          await selectChromeMcpOption({ ...target, uid: uid!, value });
          expect(await page.locator("select").inputValue()).toBe(value);
          expect(await page.evaluate(() => document.body.dataset.selected)).toBe(value);
        }
        await expect(
          evaluateChromeMcpScript({
            ...target,
            fn: "() => { document.body.dataset.evaluations = String(Number(document.body.dataset.evaluations ?? 0) + 1); }",
          }),
        ).resolves.toBeUndefined();
        expect(await page.evaluate(() => document.body.dataset.evaluations)).toBe("1");

        const unreachableUrl = `http://127.0.0.1:${await getFreePort()}/unreachable`;
        await expect(navigateChromeMcpPage({ ...target, url: unreachableUrl })).rejects.toThrow(
          "ERR_CONNECTION_REFUSED",
        );
        await expect(
          openChromeMcpTab(profileName, unreachableUrl, profile, {
            timeoutMs: 10_000,
            cdpPolicy: { dangerouslyAllowPrivateNetwork: true },
          }),
        ).rejects.toThrow("ERR_CONNECTION_REFUSED");
        expect(await listChromeMcpTabs(profileName, profile)).toHaveLength(1);
      } finally {
        try {
          await closeChromeMcpSession(profileName);
        } finally {
          await context.close();
        }
      }
    }, 120_000);
  },
);
