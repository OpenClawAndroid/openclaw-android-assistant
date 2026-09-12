import { vi } from "vitest";
import type { PluginRuntime, RuntimeLogger } from "../../plugins/runtime/types.js";

export type MeetingBrowserFixtureOptions = {
  url: string;
  tabId: string;
  title: string;
  tabOpen?: boolean;
  browserError?: Error;
  followOpenedUrl?: boolean;
  leaveSessionMatched?: true;
  status?: (state: MeetingBrowserFixtureState, script: string) => Record<string, unknown>;
};

type MeetingBrowserFixtureState = {
  tabOpen: boolean;
  targetId: string;
  tabUrl: string;
  sessionConflict: boolean;
  inCall: boolean;
  meetingEnded: boolean;
  meetingEndedOnce: boolean;
  tabListFailures: number;
};

export function createMeetingBrowserFixture(options: MeetingBrowserFixtureOptions) {
  const state: MeetingBrowserFixtureState = {
    tabOpen: options.tabOpen ?? false,
    targetId: options.tabId,
    tabUrl: options.url,
    sessionConflict: false,
    inCall: true,
    meetingEnded: false,
    meetingEndedOnce: false,
    tabListFailures: 0,
  };
  const tab = () => ({ targetId: state.targetId, title: options.title, url: state.tabUrl });
  const result = (value: Record<string, unknown>) => ({ result: JSON.stringify(value) });
  const browserResult = (params: Record<string, unknown>) => {
    if (options.browserError) {
      throw options.browserError;
    }
    if (params.path === "/tabs") {
      if (state.tabListFailures > 0) {
        state.tabListFailures -= 1;
        throw new Error("browser node unavailable");
      }
      return { tabs: state.tabOpen ? [tab()] : [] };
    }
    if (params.path === "/tabs/open") {
      state.tabOpen = true;
      const requestedUrl = (params.body as { url?: unknown } | undefined)?.url;
      state.tabUrl =
        options.followOpenedUrl === true && typeof requestedUrl === "string"
          ? requestedUrl
          : options.url;
      return tab();
    }
    if (params.path === "/tabs/focus") {
      return { ok: true };
    }
    if (params.path === "/act") {
      const scriptValue = (params.body as { fn?: unknown } | undefined)?.fn;
      const script = typeof scriptValue === "string" ? scriptValue : "";
      if (script.includes("leaveAction")) {
        return result({
          departed: true,
          ...(options.leaveSessionMatched ? { sessionMatched: true } : {}),
          urlMatched: true,
        });
      }
      if (script.includes("expectedSessionId")) {
        return result({
          droppedLines: 0,
          lines: state.sessionConflict ? [{ text: "Archived caption" }] : [],
          sessionMatched: true,
          urlMatched: true,
        });
      }
      return result(
        options.status?.(state, script) ?? {
          cameraOff: true,
          inCall: true,
          micMuted: true,
          title: options.title,
          url: state.tabUrl,
        },
      );
    }
    if (params.method === "DELETE" && params.path === `/tabs/${state.targetId}`) {
      state.tabOpen = false;
      return { ok: true };
    }
    throw new Error(`unexpected browser request ${String(params.method)} ${String(params.path)}`);
  };
  const gatewayRequest = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    browserResult(params),
  );
  const runtime = {
    gateway: { isAvailable: vi.fn(async () => true), request: gatewayRequest },
    system: {
      runCommandWithTimeout: vi.fn(async () => ({
        code: 0,
        stdout: "BlackHole 2ch",
        stderr: "",
      })),
    },
  } as unknown as PluginRuntime;
  return { state, runtime, gatewayRequest, browserResult };
}

export type MeetingBrowserFixture = ReturnType<typeof createMeetingBrowserFixture>;

export function createMeetingNodeBrowserFixture(
  options: MeetingBrowserFixtureOptions & { nodeCommand: string },
) {
  const browser = createMeetingBrowserFixture(options);
  const invoke = vi.fn(async (request: Record<string, unknown>) => {
    const params = (request.params as Record<string, unknown>) ?? {};
    if (request.command === "browser.proxy") {
      return { payload: { result: browser.browserResult(params) } };
    }
    return params.action === "start"
      ? { payload: { audioBridge: { type: "node-command-pair" }, bridgeId: "bridge-1" } }
      : { payload: { ok: true } };
  });
  const runtime = {
    nodes: {
      invoke,
      list: vi.fn(async () => ({
        nodes: [
          {
            caps: ["browser"],
            commands: ["browser.proxy", options.nodeCommand],
            connected: true,
            nodeId: "node-1",
          },
        ],
      })),
    },
  } as unknown as PluginRuntime;
  return { ...browser, runtime, invoke };
}

export function meetingBrowserActScripts(harness: MeetingBrowserFixture, since = 0) {
  return harness.gatewayRequest.mock.calls
    .slice(since)
    .filter(([, params]) => params.path === "/act")
    .map(([, params]) => {
      const fn = (params.body as { fn?: unknown } | undefined)?.fn;
      return typeof fn === "string" ? fn : "";
    });
}

export const createMeetingLogger = (): RuntimeLogger => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
});
