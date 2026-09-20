import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { CDPSession } from "playwright-core";
// Browser tests cover pw session.page cdp plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_REF_MARKER_ATTRIBUTE,
  markBackendDomRefsOnPage,
  readMainFrameDocumentIdentityForPage,
  withPageScopedCdpClient,
  withCdpSnapshotRoot,
} from "./pw-session.page-cdp.js";

describe("pw-session page-scoped CDP client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears a root marker when its injection reply rejects after mutation", async () => {
    let markerInstalled = false;
    const root = {
      evaluate: vi
        .fn()
        .mockImplementationOnce(async () => {
          markerInstalled = true;
          throw new Error("Injection reply lost");
        })
        .mockImplementationOnce(async () => {
          markerInstalled = false;
        }),
    };
    const send = vi.fn();
    const run = vi.fn();
    await expect(withCdpSnapshotRoot({ root: root as never, send, run })).rejects.toThrow(
      "Injection reply lost",
    );
    expect(markerInstalled).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("uses Playwright page sessions", async () => {
    const sessionDetach = vi.fn(async () => {});
    const session = {
      send: vi.fn(async function (this: unknown) {
        expect(this).toBe(session);
        return { ok: true };
      }),
      detach: sessionDetach,
    };
    const newCDPSession = vi.fn(async () => session);
    const page = {
      context: () => ({
        newCDPSession,
      }),
    };

    await withPageScopedCdpClient({
      page: page as never,
      fn: async (pageSend) => {
        await pageSend("Emulation.setLocaleOverride", { locale: "en-US" });
      },
    });

    expect(newCDPSession).toHaveBeenCalledWith(page);
    expect(session.send).toHaveBeenCalledWith("Emulation.setLocaleOverride", { locale: "en-US" });
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("reads the main-frame loader identity through the existing page session", async () => {
    const sessionSend = vi.fn(async (method: string) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { loaderId: "LOADER_SAME_URL" } } }
        : {},
    );
    const sessionDetach = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({ send: sessionSend, detach: sessionDetach })),
      }),
    };

    await expect(readMainFrameDocumentIdentityForPage(page as never)).resolves.toBe(
      "cdp:LOADER_SAME_URL",
    );
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it.each(["attach", "command", "detach"] as const)(
    "bounds page CDP %s and releases its exact session",
    async (phase) => {
      vi.useFakeTimers();
      const gate = createDeferred<void>();
      const session = {
        send: vi.fn(async () => {
          if (phase === "command") {
            await gate.promise;
          }
          return {};
        }),
        detach: vi.fn(async () => {
          if (phase === "detach") {
            await gate.promise;
          }
        }),
      };
      const page = {
        context: () => ({
          newCDPSession: async () => {
            if (phase === "attach") {
              await gate.promise;
            }
            return session;
          },
        }),
      };
      const action = vi.fn(async (send: CDPSession["send"]) => {
        await send("Page.getFrameTree");
      });
      let failure: unknown;
      const operation = withPageScopedCdpClient({
        page: page as never,
        timeoutMs: 50,
        fn: action,
      }).catch((error: unknown) => {
        failure = error;
      });
      try {
        await vi.advanceTimersByTimeAsync(50);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain("timed out");
      } finally {
        gate.resolve();
        await operation;
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
      expect(session.detach).toHaveBeenCalledOnce();
      if (phase === "attach") {
        expect(action).not.toHaveBeenCalled();
      }
    },
  );

  it("bounds main-frame identity reads by default", async () => {
    vi.useFakeTimers();
    const gate = createDeferred<void>();
    const detach = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession: async () => ({
          send: async () => {
            await gate.promise;
            return {};
          },
          detach,
        }),
      }),
    };
    const identity = readMainFrameDocumentIdentityForPage(page as never);
    const rejected = expect(identity).rejects.toThrow("timed out after 5000ms");
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(detach).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it("requests the document before marking backend DOM refs on the page", async () => {
    let documentRequested = false;
    const sessionSend = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.getDocument") {
        documentRequested = true;
      }
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        if (!documentRequested) {
          throw new Error("Document needs to be requested first");
        }
        expect(params).toEqual({ backendNodeIds: [42, 84] });
        return { nodeIds: [101, 202] };
      }
      return {};
    });
    const sessionDetach = vi.fn(async () => {});
    const newCDPSession = vi.fn(async () => ({
      send: sessionSend,
      detach: sessionDetach,
    }));
    const evaluateAll = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession,
      }),
      locator: vi.fn(() => ({ evaluateAll })),
    };

    const marked = await markBackendDomRefsOnPage({
      page: page as never,
      refs: [
        { ref: "ax1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
    });

    expect(page.locator).toHaveBeenCalledWith(`[${BROWSER_REF_MARKER_ATTRIBUTE}]`);
    expect(evaluateAll).toHaveBeenCalledTimes(1);
    expect(marked).toEqual(new Set(["ax1", "ax2"]));
    expect(sessionSend).toHaveBeenNthCalledWith(1, "DOM.getDocument", { depth: 0 });
    expect(sessionSend).toHaveBeenNthCalledWith(2, "DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [42, 84],
    });
    expect(sessionSend).toHaveBeenNthCalledWith(3, "DOM.setAttributeValue", {
      nodeId: 101,
      name: BROWSER_REF_MARKER_ATTRIBUTE,
      value: "ax1",
    });
    expect(sessionSend).toHaveBeenNthCalledWith(4, "DOM.setAttributeValue", {
      nodeId: 202,
      name: BROWSER_REF_MARKER_ATTRIBUTE,
      value: "ax2",
    });
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("marks both generated role refs and raw accessibility refs", async () => {
    const sessionSend = vi.fn(async (method: string) => {
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        return { nodeIds: [101, 202] };
      }
      return {};
    });
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({
          send: sessionSend,
          detach: vi.fn(async () => {}),
        })),
      }),
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => {}) })),
    };

    const marked = await markBackendDomRefsOnPage({
      page: page as never,
      refs: [
        { ref: "e1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
    });

    expect(marked).toEqual(new Set(["e1", "ax2"]));
  });

  it("clears stale markers even when no backend refs are valid", async () => {
    const newCDPSession = vi.fn();
    const evaluateAll = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession,
      }),
      locator: vi.fn(() => ({ evaluateAll })),
    };

    const marked = await markBackendDomRefsOnPage({
      page: page as never,
      refs: [{ ref: "e1", backendDOMNodeId: 0 }],
    });

    expect(page.locator).toHaveBeenCalledWith(`[${BROWSER_REF_MARKER_ATTRIBUTE}]`);
    expect(evaluateAll).toHaveBeenCalledTimes(1);
    expect(newCDPSession).not.toHaveBeenCalled();
    expect(marked).toEqual(new Set());
  });

  it("keeps unmarked refs out of the marked set when marker writes fail", async () => {
    const sessionSend = vi.fn(async (method: string) => {
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        return { nodeIds: [101, 202] };
      }
      if (method === "DOM.setAttributeValue") {
        throw new Error("detached");
      }
      return {};
    });
    const sessionDetach = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({
          send: sessionSend,
          detach: sessionDetach,
        })),
      }),
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => {}) })),
    };

    const marked = await markBackendDomRefsOnPage({
      page: page as never,
      refs: [
        { ref: "ax1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
    });

    expect(marked).toEqual(new Set());
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });
});
