import { describe, expect, it } from "vitest";
import { classifyQuotaRefreshCaller, quotaPublicDiagnostics } from "./quota-reset-diagnostics.mjs";

describe("quota failure public diagnostics", () => {
  it("publishes only health and transport facts when private evidence contains credentials", () => {
    const secret = "PRIVATE_CANARY_DO_NOT_PUBLISH";
    const result = quotaPublicDiagnostics({
      profile: { status: "expiring", expiresAt: 123, remainingMs: 45, access: secret },
      requests: [
        {
          atMs: 1,
          phase: "initial-exhaustion",
          transport: "websocket",
          path: `/private/${secret}/responses?token=${secret}`,
          headers: { authorization: secret },
          body: secret,
        },
      ],
      upgrades: [{ atMs: 2, path: `/v1/responses?token=${secret}`, headers: secret }],
      refreshes: [{ atMs: 3, caller: "codex-callback", stack: secret, body: secret }],
      nativeLog:
        `codex app-server stderr: failed to connect to websocket: HTTP error: 401 Unauthorized, url: https://${secret}\n` +
        `codex app-server stderr: failed to connect to websocket: ${secret}\n` +
        `unrelated prompt: failed to connect to websocket: HTTP error: 418 ${secret}`,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toEqual({
      schemaVersion: 1,
      omitted: { requests: 0, upgrades: 0, refreshes: 0, handshakeFailures: 0 },
      refreshReceiptAvailable: true,
      nativeLogAvailable: true,
      profile: { status: "expiring", expiresAt: 123, remainingMs: 45 },
      requests: [
        { atMs: 1, phase: "initial-exhaustion", transport: "websocket", endpoint: "responses" },
      ],
      upgrades: [{ atMs: 2, endpoint: "responses" }],
      refreshes: [{ atMs: 3, caller: "codex-callback" }],
      handshakeFailures: [
        { kind: "http", httpStatus: 401 },
        { kind: "unknown", httpStatus: null },
      ],
    });
  });

  it("keeps unavailable evidence and unknown fields explicit without copying input strings", () => {
    const secret = "PRIVATE_UNKNOWN_CANARY";
    const result = quotaPublicDiagnostics({
      profile: { status: secret, expiresAt: secret, remainingMs: Infinity },
      requests: [{ atMs: secret, phase: secret, transport: secret, path: secret }],
      refreshes: [{ atMs: Number.NaN, caller: secret, reason: secret }],
      nativeLog: undefined,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.profile).toEqual({ status: "unknown", expiresAt: null, remainingMs: null });
    expect(result.requests).toEqual([
      { atMs: null, phase: "other", transport: "unknown", endpoint: "other" },
    ]);
    expect(result.refreshes).toEqual([{ atMs: null, caller: "unknown" }]);
    expect(result.nativeLogAvailable).toBe(false);
    expect(quotaPublicDiagnostics({}).refreshReceiptAvailable).toBe(false);
  });

  it("bounds each diagnostic stream while retaining its latest facts", () => {
    const events = Array.from({ length: 140 }, (_, atMs) => ({ atMs }));
    const result = quotaPublicDiagnostics({
      requests: events,
      upgrades: events,
      refreshes: events,
      nativeLog:
        "codex app-server stderr: failed to connect to websocket: HTTP error: 401\n".repeat(140),
    });
    for (const stream of [result.requests, result.upgrades, result.refreshes]) {
      expect(stream).toHaveLength(128);
      expect(stream[0]?.atMs).toBe(12);
      expect(stream.at(-1)?.atMs).toBe(139);
    }
    expect(result.handshakeFailures).toHaveLength(128);
    expect(result.omitted).toEqual({
      requests: 12,
      upgrades: 12,
      refreshes: 12,
      handshakeFailures: 12,
    });
  });

  it.each([
    ["Error\n    at async refreshCodexAppServerAuthTokens (/private/token:1:2)", "codex-callback"],
    ["Error\n    at async noteAuthProfileHealthForTarget (/private/token:1:2)", "doctor"],
    ["Error\n    at async resolveApiKeyForProfile (/private/token:1:2)", "credential-resolution"],
    ["refreshCodexAppServerAuthTokens appears in an error message only", "unknown"],
    ["Error\n    at renamedOwner (/private/token:1:2)", "unknown"],
  ])("classifies observed call frames without publishing the stack", (stack, expected) => {
    expect(classifyQuotaRefreshCaller(stack)).toBe(expected);
  });
});
