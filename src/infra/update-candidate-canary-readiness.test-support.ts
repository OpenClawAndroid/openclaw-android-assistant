import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";

export function registerCanaryReadinessBudgetTests(root: () => string) {
  it.each(
    ["startupz", "readyz"].flatMap((endpoint) =>
      ["headers", "body"].map((delay) => ({ endpoint, delay })),
    ),
  )("allows slow $endpoint $delay within the validation budget", async ({ endpoint, delay }) => {
    const timers = new Set<NodeJS.Timeout>();
    const server = createServer((request, response) => {
      const body = JSON.stringify({ status: "started", ready: true });
      const headers = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
      };
      if (request.url !== `/${endpoint}`) {
        headers();
        response.end(body);
        return;
      }
      if (delay === "body") {
        headers();
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (delay === "headers") {
          headers();
        }
        response.end(body);
      }, 1_200);
      timers.add(timer);
      response.once("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
    });
    const fetchHttp = globalThis.fetch;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a loopback HTTP listener");
      }
      vi.stubGlobal("fetch", (url: string, options: RequestInit) =>
        fetchHttp(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, options),
      );
      const result = await validateUpdateCandidateCanary({
        root: root(),
        stateDir: root(),
        config: {},
        env: {},
        timeoutMs: 6_000,
      });
      expect(result, result.logTail.join("\n")).toMatchObject({ status: "ok", phase: "readiness" });
      expect(result.logTail.join("\n")).toContain("startupz: started");
      expect(result.logTail.join("\n")).toContain("readyz: ready");
    } finally {
      vi.unstubAllGlobals();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });
}
