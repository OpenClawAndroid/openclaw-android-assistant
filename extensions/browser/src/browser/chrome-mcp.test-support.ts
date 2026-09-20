import { afterEach, beforeEach, vi } from "vitest";
import type { ChromeMcpSession } from "./chrome-mcp-contracts.js";
import { resetChromeMcpSessionsForTest } from "./chrome-mcp-session.js";

export type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};
export type SessionPage = { id: number; url: string; selected?: boolean };

export function createPageSession(params: {
  pages: SessionPage[];
  pid: number;
  onTool?: (call: ToolCall) => unknown;
}): ChromeMcpSession {
  const callTool = vi.fn(async (call: ToolCall) => {
    const custom = await params.onTool?.(call);
    if (custom !== undefined) {
      return custom;
    }
    if (call.name === "list_pages") {
      return {
        structuredContent: {
          pages: params.pages.map(({ id, url, selected }) => ({ id, url, selected })),
        },
      };
    }
    if (call.name === "evaluate_script") {
      return { content: [{ type: "text", text: "```json\nnull\n```" }] };
    }
    throw new Error(`unexpected tool ${call.name}`);
  });
  const client = {
    callTool,
    listTools: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
  };
  return {
    client,
    transport: { pid: params.pid },
    closeTransport: () => client.close(),
    ready: Promise.resolve(),
  } as unknown as ChromeMcpSession;
}

export function installChromeMcpSessionTestHooks() {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
}
