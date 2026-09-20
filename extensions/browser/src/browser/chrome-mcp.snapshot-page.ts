import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  evaluateChromeMcpScript,
  type ChromeMcpOperationOptions,
  type ChromeMcpProfileOptions,
} from "./chrome-mcp.js";
import type { SnapshotUrlEntry } from "./snapshot-urls.js";

const CHROME_MCP_OVERLAY_ATTR = "data-openclaw-mcp-overlay";

export type ChromeMcpSnapshotOperation = ChromeMcpOperationOptions & {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
};

export async function collectChromeMcpSnapshotUrls(
  params: ChromeMcpSnapshotOperation,
): Promise<SnapshotUrlEntry[]> {
  const result = await evaluateChromeMcpScript({
    ...params,
    fn: `() => {
      const seen = new Set();
      const out = [];
      for (const anchor of document.querySelectorAll("a[href]")) {
        const href = anchor.href || "";
        if (!href || seen.has(href)) continue;
        const text = (anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 121) || href;
        seen.add(href);
        out.push({ text, url: href });
        if (out.length >= 100) break;
      }
      return out;
    }`,
  }).catch(() => []);
  return Array.isArray(result)
    ? result
        .filter(
          (entry: unknown): entry is { text: string; url: string } =>
            isRecord(entry) && typeof entry.text === "string" && typeof entry.url === "string",
        )
        .map((entry) => {
          entry.text = truncateUtf16Safe(entry.text, 120) || entry.url;
          return entry;
        })
    : [];
}

export async function clearChromeMcpOverlay(params: ChromeMcpSnapshotOperation): Promise<void> {
  await evaluateChromeMcpScript({
    ...params,
    // Cleanup must outlive a route abort or injected labels remain in the user's tab.
    signal: undefined,
    fn: `() => {
      document.querySelectorAll("[${CHROME_MCP_OVERLAY_ATTR}]").forEach((node) => node.remove());
      return true;
    }`,
  }).catch(() => {});
}

export async function renderChromeMcpLabels(
  params: ChromeMcpSnapshotOperation & {
    refs: string[];
    clipToRef?: boolean;
  },
): Promise<{ labels: number; skipped: number }> {
  const refList = JSON.stringify(params.refs);
  const clipToRef = params.clipToRef === true ? "true" : "false";
  const result = await evaluateChromeMcpScript({
    ...params,
    args: params.refs,
    fn: `(...elements) => {
      const refs = ${refList};
      const clipToRef = ${clipToRef};
      document.querySelectorAll("[${CHROME_MCP_OVERLAY_ATTR}]").forEach((node) => node.remove());
      if (clipToRef && elements[0] instanceof Element) {
        elements[0].scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      }
      const root = document.createElement("div");
      root.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "labels");
      root.style.position = "fixed";
      root.style.inset = "0";
      root.style.pointerEvents = "none";
      root.style.zIndex = "2147483647";
      let labels = 0;
      let skipped = 0;
      elements.forEach((el, index) => {
        if (!(el instanceof Element)) {
          skipped += 1;
          return;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) {
          skipped += 1;
          return;
        }
        labels += 1;
        const badge = document.createElement("div");
        badge.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "label");
        badge.textContent = refs[index] || String(labels);
        badge.style.position = "fixed";
        badge.style.left = \`\${Math.max(0, rect.left)}px\`;
        badge.style.top = \`\${Math.max(0, rect.top + (clipToRef ? 2 : 0))}px\`;
        badge.style.transform = clipToRef ? "none" : "translateY(-100%)";
        badge.style.padding = "2px 6px";
        badge.style.borderRadius = "999px";
        badge.style.background = "#FF4500";
        badge.style.color = "#fff";
        badge.style.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
        badge.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
        badge.style.whiteSpace = "nowrap";
        root.appendChild(badge);
      });
      document.documentElement.appendChild(root);
      return { labels, skipped };
    }`,
  });
  const labels = isRecord(result) && typeof result.labels === "number" ? result.labels : 0;
  const skipped = isRecord(result) && typeof result.skipped === "number" ? result.skipped : 0;
  return { labels, skipped };
}
