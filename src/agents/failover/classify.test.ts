import { describe, expect, it } from "vitest";
import { classifyFailoverReason, classifyFailoverSignal } from "./classify.js";

describe("HTTP 402 prose classification", () => {
  it.each([
    {
      message: "Prompt tokens limit exceeded. See https://example.invalid/monthly/rate_limit",
      reason: "billing",
    },
    {
      message: "Organization spend limit reached. See https://example.invalid/subscription",
      reason: "rate_limit",
    },
    {
      message:
        '{"help":"https://example.invalid/subscription","message":"Workspace spend limit reached"}',
      reason: "rate_limit",
    },
  ])("classifies prose rather than URL hints: $message", ({ message, reason }) => {
    expect(classifyFailoverSignal({ status: 402, message }, { providerPlugin: null })).toEqual({
      kind: "reason",
      reason,
    });
  });

  it("does not treat a bare leading number and a URL as payment evidence", () => {
    expect(
      classifyFailoverReason(
        "402 records processed. See https://example.invalid/organizations/synthetic/settings/keys",
        { providerPlugin: null },
      ),
    ).toBeNull();
  });
});

describe("request validation behind gateway status codes", () => {
  it.each(["400 Your input exceeds the context window of this model", "413 status code (no body)"])(
    "preserves canonical assistant overflow evidence: %s",
    (message) => {
      expect(classifyFailoverSignal({ message })).toEqual({ kind: "context_overflow" });
    },
  );

  it.each([404, 500, 502])("preserves request-validation semantics for HTTP %s", (status) => {
    expect(
      classifyFailoverSignal({
        status,
        message: `${status} Unknown parameter: 'logprobs'`,
        errorType: "invalid_request_error",
        code: "unknown_parameter",
      }),
    ).toEqual({ kind: "reason", reason: "format" });
    expect(
      classifyFailoverReason(
        `${status} {"error":{"type":"invalid_request_error","message":"Unsupported parameter: logprobs"}}`,
      ),
    ).toBe("format");
  });

  it.each([
    "timeout",
    "overloaded",
    "server_error",
    "rate_limit",
    "authentication",
    "context_length_exceeded",
  ])("keeps an explicit rejection of %s ahead of message patterns", (parameter) => {
    const error = {
      type: "invalid_request_error",
      code: "unknown_parameter",
      message: `Unsupported parameter: ${parameter}`,
    };
    expect(
      classifyFailoverSignal({
        status: 500,
        message: `500 ${error.message}`,
        errorType: error.type,
        code: error.code,
        details: [JSON.stringify(error)],
      }),
    ).toEqual({ kind: "reason", reason: "format" });
    for (const separator of [" ", ": "]) {
      expect(classifyFailoverReason(`502${separator}${JSON.stringify({ error })}`)).toBe("format");
    }
  });

  it.each([
    { status: 401, reason: "auth" },
    { status: 402, reason: "billing" },
    { status: 429, reason: "rate_limit" },
    { status: 499, reason: "timeout" },
    { status: 529, reason: "overloaded" },
  ])("preserves HTTP $status policy for validation-coded errors", ({ status, reason }) => {
    expect(
      classifyFailoverSignal({
        status,
        message: `${status} Unknown parameter: 'logprobs'`,
        errorType: "invalid_request_error",
        code: "unknown_parameter",
      }),
    ).toEqual({ kind: "reason", reason });
  });
});

describe("Claude CLI logged-out failures", () => {
  const loggedOutMessage = "Not logged in · Please run /login";

  it("classifies the logged-out response as auth only for claude-cli", () => {
    expect(classifyFailoverReason(loggedOutMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(loggedOutMessage, { provider: "openai" })).toBeNull();
    expect(classifyFailoverReason(loggedOutMessage)).toBeNull();
  });
});

describe("OAuth session expiry", () => {
  const expiredMessage = "Failed to authenticate: OAuth session expired and could not be refreshed";

  it("classifies OAuth expiry as auth only for claude-cli", () => {
    expect(classifyFailoverReason(expiredMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(expiredMessage, { provider: "custom-cli" })).toBe(
      "session_expired",
    );
    expect(classifyFailoverReason(expiredMessage)).toBe("session_expired");
  });
});

describe("Gateway transcript validation vs provider session expiry", () => {
  it("keeps Gateway transcript validation local instead of session_expired", () => {
    expect(classifyFailoverReason("Invalid session transcript entry: model_change")).toBe("format");
    expect(
      classifyFailoverReason("Invalid session transcript entry: model_change", {
        provider: "openrouter",
      }),
    ).toBe("format");
  });

  it.each([
    "invalid session",
    "HTTP 404: session not found",
    "no such session",
    "conversation expired",
  ])("still treats provider session-expiry copy as session_expired: %s", (message) => {
    expect(classifyFailoverReason(message)).toBe("session_expired");
  });
});
