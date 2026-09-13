import { describe, expect, it } from "vitest";
import { buildSandboxHostDocument, decodeSandboxHostCsp } from "../agents/sandbox-host.js";
import type { BoardWidgetDocument } from "../boards/board-store.js";
import {
  buildBoardWidgetContentSecurityPolicy,
  buildBoardWidgetSandboxPath,
} from "./board-sandbox.js";

function document(
  grantState: "pending" | "granted",
  netOrigins = ["https://api.open-meteo.com"],
): BoardWidgetDocument {
  return {
    html: "<!doctype html>",
    revision: 1,
    sha256: "a".repeat(64),
    viewGeneration: "b".repeat(32),
    grantState,
    declared: { netOrigins },
  };
}

describe("board widget sandbox CSP", () => {
  it("emits no network authority while a declaration is pending", () => {
    const path = buildBoardWidgetSandboxPath(document("pending"));
    const encoded = new URL(path, "https://sandbox.example").searchParams.get("csp");

    expect(decodeSandboxHostCsp(encoded)).toEqual({ blockDescendantFrames: true });
    const policy = buildSandboxHostDocument().headers["Content-Security-Policy"];
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("webrtc 'block'");
    expect(buildBoardWidgetContentSecurityPolicy(document("pending"))).toContain(
      "connect-src 'none'",
    );
    expect(buildBoardWidgetContentSecurityPolicy(document("pending"))).toContain("webrtc 'block'");
  });

  it("emits only the granted widget origins", () => {
    const path = buildBoardWidgetSandboxPath(
      document("granted", [
        "https://api.open-meteo.com",
        "https://status.example:8443",
        "https://[2001:db8::1]:9443",
      ]),
    );
    const encoded = new URL(path, "https://sandbox.example").searchParams.get("csp");
    const csp = decodeSandboxHostCsp(encoded);

    expect(csp).toEqual({
      connectDomains: [
        "https://api.open-meteo.com",
        "https://status.example:8443",
        "https://[2001:db8::1]:9443",
      ],
      blockDescendantFrames: true,
    });
    expect(buildSandboxHostDocument(csp).headers["Content-Security-Policy"]).toContain(
      "connect-src https://api.open-meteo.com https://status.example:8443 https://[2001:db8::1]:9443",
    );
    expect(
      buildBoardWidgetContentSecurityPolicy(document("granted", csp?.connectDomains)),
    ).toContain(
      "connect-src https://api.open-meteo.com https://status.example:8443 https://[2001:db8::1]:9443",
    );
  });

  it("adds the requested descendant-frame guard before resetting document port offers", () => {
    const proxy = buildSandboxHostDocument({ blockDescendantFrames: true }).html;
    const genericProxy = buildSandboxHostDocument().html;

    expect(proxy).toContain("const blockDescendantFrames = true");
    expect(proxy).toContain("sandbox descendant browsing contexts are disabled");
    expect(proxy).toContain('lock(Document.prototype,\\"createElement\\"');
    expect(proxy).toContain('wrapSetter(Element.prototype,\\"innerHTML\\"');
    expect(proxy).toContain('wrapMethod(Element.prototype,\\"setHTMLUnsafe\\"');
    expect(proxy).toContain('lock(globalThis,\\"open\\",undefined)');
    const guardedHtmlIndex = proxy.indexOf("const guardedHtml = guardDocument(params.html)");
    expect(guardedHtmlIndex).toBeGreaterThan(-1);
    expect(proxy.indexOf("widgetPortsOffered.clear()", guardedHtmlIndex)).toBeGreaterThan(
      guardedHtmlIndex,
    );
    expect(proxy).toContain("const apply=Reflect.apply");
    expect(proxy).toContain('if (html.slice(index, index + 4) !== "<!--") break');
    expect(proxy).toContain('const commentEnd = html.indexOf("-->", index + 4)');
    expect(genericProxy).toContain("const blockDescendantFrames = false");
    expect(genericProxy).not.toContain('lock(Document.prototype,\\"createElement\\"');
  });

  it("blocks scripted popups regardless of whether descendant-frame hardening is enabled", () => {
    const path = buildBoardWidgetSandboxPath(document("pending"));
    const encoded = new URL(path, "https://sandbox.example").searchParams.get("csp");
    const csp = decodeSandboxHostCsp(encoded);

    expect(csp?.blockDescendantFrames).toBe(true);
    for (const { html: proxy } of [buildSandboxHostDocument(csp), buildSandboxHostDocument()]) {
      expect(proxy).toContain('frame.setAttribute("sandbox", "allow-scripts allow-forms")');
      expect(proxy).not.toContain("allow-popups");
    }
  });
});
