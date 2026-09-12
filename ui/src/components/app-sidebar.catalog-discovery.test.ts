/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  deferred,
  mountSidebar,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.ts";

async function settle(sidebar: SidebarLifecycleState) {
  await vi.advanceTimersByTimeAsync(0);
  await sidebar.updateComplete;
}

async function mountDiscovery(request: ReturnType<typeof vi.fn>) {
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: {
      features: { methods: ["sessions.catalog.list"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const mounted = await mountSidebar(gateway.gateway, createSessions("main", ["agent:main:main"]));
  mounted.sidebar.connected = true;
  await mounted.sidebar.updateComplete;
  await settle(mounted.sidebar);
  return mounted;
}

describe("AppSidebar hidden catalog discovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retains cursor progress across bounded refreshes beyond five empty pages", async () => {
    let furthestPage = 1;
    const request = vi.fn((_method, params: { cursors?: Record<string, string> }) => {
      const cursor = params.cursors?.["gateway:local"];
      const page = cursor ? Number(cursor.slice("page-".length)) : 1;
      furthestPage = Math.max(furthestPage, page);
      return Promise.resolve(
        page === 8
          ? catalogPage([{ threadId: "found", name: "Discovered session" }])
          : catalogPage([], `page-${page + 1}`),
      );
    });
    const { sidebar } = await mountDiscovery(request);
    expect(furthestPage).toBe(2);
    for (let page = 3; page <= 8; page += 1) {
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(furthestPage).toBe(page - 1);
      await vi.advanceTimersByTimeAsync(1);
      await settle(sidebar);
      expect(furthestPage).toBe(page);
    }
    expect(sidebar.textContent).toContain("Discovered session");
    expect(sidebar.sessionData.sessionCatalogPageDepths.values().next().value).toBe(7);
    await sidebar.sessionData.refreshSessionCatalogs();
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Discovered session");
  });

  it.each(["request", "catalog", "host", "missing host", "missing catalog"] as const)(
    "stops automatic paging after a %s failure",
    async (failure) => {
      let failing = true;
      const request = vi.fn((_method, params: { cursors?: Record<string, string> }) => {
        if (!params.cursors) {
          return Promise.resolve(catalogPage([], "page-2"));
        }
        if (!failing) {
          return Promise.resolve(
            catalogPage([{ threadId: "recovered", name: "Recovered session" }]),
          );
        }
        if (failure === "request") {
          return Promise.reject(new Error("Discovery unavailable"));
        }
        const page = catalogPage([], "page-3");
        const error = { code: "UNAVAILABLE", message: "Discovery unavailable" };
        if (failure === "catalog") {
          page.catalogs[0]!.error = error;
        } else if (failure === "host") {
          page.catalogs[0]!.hosts[0]!.error = error;
        } else if (failure === "missing host") {
          page.catalogs[0]!.hosts = [];
        } else {
          page.catalogs = [];
        }
        return Promise.resolve(page);
      });
      const { sidebar } = await mountDiscovery(request);
      expect(request).toHaveBeenCalledTimes(2);
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(2);
      const catalog = sidebar.sessionData.sessionCatalogs[0]!;
      expect((catalog.error ?? catalog.hosts[0]!.error)?.code).toBe(
        failure.startsWith("missing") ? "PAGINATION_FAILED" : "UNAVAILABLE",
      );
      expect(catalog.hosts[0]!.nextCursor).toBe("page-2");
      expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);

      failing = false;
      await sidebar.sessionData.refreshSessionCatalogs();
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Recovered session");
      expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-2" },
      });
    },
  );

  it.each(["request", "catalog", "host", "missing host", "missing catalog"] as const)(
    "preserves discovery progress and stops advancing after a %s replay failure",
    async (failure) => {
      let failing = false;
      const request = vi.fn((_method, params: { cursors?: Record<string, string> }) => {
        const cursor = params.cursors?.["gateway:local"];
        if (!cursor) {
          return Promise.resolve(catalogPage([], "page-2"));
        }
        if (cursor === "page-3") {
          return Promise.resolve(catalogPage([{ threadId: "found", name: "Recovered discovery" }]));
        }
        const page = catalogPage([], "page-3");
        if (failing) {
          const error = { code: "UNAVAILABLE", message: "Replay unavailable" };
          if (failure === "request") {
            return Promise.reject(new Error(error.message));
          }
          if (failure === "catalog") {
            page.catalogs[0]!.error = error;
          } else if (failure === "host") {
            page.catalogs[0]!.hosts[0]!.error = error;
          } else if (failure === "missing host") {
            page.catalogs[0]!.hosts = [];
          } else {
            page.catalogs = [];
          }
        }
        return Promise.resolve(page);
      });
      const { sidebar } = await mountDiscovery(request);
      expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.nextCursor).toBe("page-3");
      expect(sidebar.sessionData.sessionCatalogPageDepths.values().next().value).toBe(1);

      failing = true;
      await sidebar.sessionData.refreshSessionCatalogs();
      await sidebar.updateComplete;
      const host = sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!;
      expect(host.error?.code).toBe(
        failure.startsWith("missing") ? "PAGINATION_FAILED" : "UNAVAILABLE",
      );
      expect(host.nextCursor).toBe("page-3");
      expect(sidebar.sessionData.sessionCatalogPageDepths.values().next().value).toBe(1);
      expect(
        request.mock.calls.some(([, params]) => params.cursors?.["gateway:local"] === "page-3"),
      ).toBe(false);
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();

      failing = false;
      await sidebar.sessionData.refreshSessionCatalogs();
      await sidebar.updateComplete;
      expect(
        request.mock.calls.slice(-3).map(([, params]) => params.cursors?.["gateway:local"]),
      ).toEqual([undefined, "page-2", "page-3"]);
      expect(sidebar.textContent).toContain("Recovered discovery");
      expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.error).toBeUndefined();
      expect(sidebar.sessionData.sessionCatalogPageDepths.values().next().value).toBe(2);
    },
  );

  it.each([1, 2])("stops a %i-page cursor cycle without a request loop", async (cycleLength) => {
    const request = vi.fn((_method, params: { cursors?: Record<string, string> }) => {
      const cursor = params.cursors?.["gateway:local"];
      return Promise.resolve(
        catalogPage([], cursor === "page-a" && cycleLength === 2 ? "page-b" : "page-a"),
      );
    });
    const { sidebar } = await mountDiscovery(request);
    if (cycleLength === 2) {
      await vi.advanceTimersByTimeAsync(10_000);
      await settle(sidebar);
    }
    const host = sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!;
    expect(host.error?.code).toBe("PAGINATION_FAILED");
    const requests = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledTimes(requests);
    expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();
  });

  it("retains an issued discovery page while hidden and resumes from its cursor", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const pending = deferred<ReturnType<typeof catalogPage>>();
    const request = vi.fn((_method, params: { cursors?: Record<string, string> }) => {
      const cursor = params.cursors?.["gateway:local"];
      return cursor === "page-2"
        ? pending.promise
        : Promise.resolve(
            cursor === "page-3"
              ? catalogPage([{ threadId: "found", name: "Visible again" }])
              : catalogPage([], "page-2"),
          );
    });
    try {
      const { sidebar } = await mountDiscovery(request);
      expect(request).toHaveBeenCalledTimes(2);
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      pending.resolve(catalogPage([], "page-3"));
      await settle(sidebar);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(2);
      expect(sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.nextCursor).toBe("page-3");
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(50);
      await settle(sidebar);
      expect(sidebar.textContent).toContain("Visible again");
      expect(request).toHaveBeenLastCalledWith("sessions.catalog.list", {
        agentId: "main",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "page-3" },
      });
    } finally {
      visibilitySpy.mockRestore();
    }
  });
});
