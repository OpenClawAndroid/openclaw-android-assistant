import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { describe, expect, it, vi } from "vitest";
import { listWorkSessions } from "./work-sessions.js";

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod: vi.fn() }));

describe("report work sessions", () => {
  it("uses the authenticated request and projects only link metadata, excluding incognito", async () => {
    vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce({
      ok: true,
      payload: {
        sessions: [
          {
            key: "agent:writer:work",
            kind: "direct",
            displayName: "Review routing",
            owner: { actor: { type: "human", label: "Alice" } },
            status: "running",
            lastMessagePreview: "Not report evidence",
          },
          { key: "agent:writer:private", kind: "direct", incognito: true },
        ],
        hasMore: true,
        nextOffset: 80,
      },
    });
    const result = await listWorkSessions(40);
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("sessions.list", {
      limit: 40,
      offset: 40,
      sortBy: "activity",
      archived: false,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      configuredAgentsOnly: true,
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: true,
      includeLastMessage: false,
    });
    expect(result).toMatchObject({
      available: true,
      sessions: [
        { key: "agent:writer:work", owner: { actor: { label: "Alice" } }, status: "running" },
      ],
      nextOffset: 80,
    });
    expect(JSON.stringify(result)).not.toContain("Not report evidence");
    expect(JSON.stringify(result)).not.toContain("agent:writer:private");
  });

  it.each([{ ok: false }, { ok: true, payload: {} }])(
    "distinguishes failed discovery from an empty list (%j)",
    async (response) => {
      vi.mocked(dispatchGatewayMethod).mockResolvedValueOnce(response);
      expect(await listWorkSessions()).toEqual({ available: false });
    },
  );

  it("does not expose internal dispatch errors", async () => {
    vi.mocked(dispatchGatewayMethod).mockRejectedValueOnce(new Error("private transport detail"));
    expect(await listWorkSessions()).toEqual({ available: false });
  });
});
