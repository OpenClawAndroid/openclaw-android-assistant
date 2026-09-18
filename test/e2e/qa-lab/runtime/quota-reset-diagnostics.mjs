/** @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  return value !== null && typeof value === "object"
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value */
function entries(value) {
  return Array.isArray(value) ? value.slice(-128) : [];
}

/** @param {unknown} stack */
export function classifyQuotaRefreshCaller(stack) {
  if (typeof stack !== "string") {
    return "unknown";
  }
  if (/\bat (?:async )?refreshCodexAppServerAuthTokens\b/u.test(stack)) {
    return "codex-callback";
  }
  if (/\bat (?:async )?noteAuthProfileHealthForTarget\b/u.test(stack)) {
    return "doctor";
  }
  if (/\bat (?:async )?resolveApiKeyForProfile\b/u.test(stack)) {
    return "credential-resolution";
  }
  return "unknown";
}

/** @param {unknown} raw */
function endpoint(raw) {
  if (typeof raw !== "string") {
    return "unknown";
  }
  const pathname = raw.split("?")[0];
  if (pathname === "/oauth/token") {
    return "oauth-token";
  }
  if (pathname === "/catalog/models") {
    return "catalog";
  }
  if (pathname === "/core-wham/usage" || pathname === "/backend-api/wham/usage") {
    return "usage";
  }
  if (pathname.endsWith("/responses")) {
    return "responses";
  }
  return "other";
}

const phases = new Set(["healthy", "initial-exhaustion", "restored"]);
const statuses = new Set(["ok", "expiring", "expired", "missing", "static"]);
const callers = new Set(["codex-callback", "doctor", "credential-resolution"]);

/** Only allowlisted facts leave the synthetic fixture; raw evidence stays local.
 * @param {unknown} input
 */
export function quotaPublicDiagnostics(input) {
  const source = record(input);
  const profile = record(source.profile);
  const nativeLog = typeof source.nativeLog === "string" ? source.nativeLog : "";
  const handshakeFailures = nativeLog.split("\n").flatMap((line) => {
    if (
      !line.includes("codex app-server stderr:") ||
      !line.includes("failed to connect to websocket:")
    ) {
      return [];
    }
    const http = /HTTP error:\s*([45]\d{2})\b/u.exec(line);
    return [{ kind: http ? "http" : "unknown", httpStatus: http ? Number(http[1]) : null }];
  });
  return {
    schemaVersion: 1,
    omitted: {
      requests: Math.max(0, (Array.isArray(source.requests) ? source.requests.length : 0) - 128),
      upgrades: Math.max(0, (Array.isArray(source.upgrades) ? source.upgrades.length : 0) - 128),
      refreshes: Math.max(0, (Array.isArray(source.refreshes) ? source.refreshes.length : 0) - 128),
      handshakeFailures: Math.max(0, handshakeFailures.length - 128),
    },
    refreshReceiptAvailable: Array.isArray(source.refreshes),
    nativeLogAvailable: typeof source.nativeLog === "string",
    profile: {
      status:
        typeof profile.status === "string" && statuses.has(profile.status)
          ? profile.status
          : "unknown",
      expiresAt: finiteNumber(profile.expiresAt),
      remainingMs: finiteNumber(profile.remainingMs),
    },
    requests: entries(source.requests).map((entry) => {
      const value = record(entry);
      return {
        atMs: finiteNumber(value.atMs),
        phase: typeof value.phase === "string" && phases.has(value.phase) ? value.phase : "other",
        transport:
          value.transport === "http" || value.transport === "websocket"
            ? value.transport
            : "unknown",
        endpoint: endpoint(value.path),
      };
    }),
    upgrades: entries(source.upgrades).map((entry) => ({
      atMs: finiteNumber(record(entry).atMs),
      endpoint: endpoint(record(entry).path),
    })),
    refreshes: entries(source.refreshes).map((entry) => {
      const value = record(entry);
      return {
        atMs: finiteNumber(value.atMs),
        caller:
          typeof value.caller === "string" && callers.has(value.caller) ? value.caller : "unknown",
      };
    }),
    handshakeFailures: handshakeFailures.slice(-128),
  };
}
