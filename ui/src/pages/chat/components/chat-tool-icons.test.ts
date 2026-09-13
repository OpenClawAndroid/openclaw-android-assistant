import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";

describe("plugin tool icons", () => {
  it.each(
    [
      "browser",
      "canvas",
      "diffs",
      "lobster",
      "file_fetch",
      "file_write",
      "dir_list",
      "dir_fetch",
      "intent",
      "memory_search",
      "memory_get",
      "memory_recall",
      "memory_store",
      "memory_forget",
    ].flatMap((name) => ["assistant", "toolResult"].map((role) => [role, name])),
  )("keeps the activity glyph for %s %s rows without loading plugin artwork", (role, name) => {
    const container = document.createElement("div");
    const message =
      role === "assistant"
        ? { role, content: [{ type: "toolCall", id: "call", name, arguments: {} }] }
        : {
            role,
            toolCallId: "call",
            toolName: name,
            content: [{ type: "text", text: "Saved context." }],
          };
    const getPluginIcon = vi.fn(() => ({ url: "blob:plugin-icon", onError: vi.fn() }));
    render(
      renderGroupedMessage(prepareChatMessageRender(message), "message", {
        isStreaming: false,
        showReasoning: false,
        showToolCalls: true,
        pluginToolIcons: { get: getPluginIcon },
      }),
      container,
    );
    expect(container.querySelector(".chat-tool-msg-summary__icon img")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-summary__icon svg")).not.toBeNull();
    expect(getPluginIcon).not.toHaveBeenCalled();
  });

  it.each([
    ["assistant", "meeting_status"],
    ["toolResult", "meeting_status"],
    ["assistant", "mcp__other__browser"],
    ["toolResult", "mcp__other__browser"],
  ])("uses the plugin icon for %s %s rows", (role, name) => {
    const container = document.createElement("div");
    const message =
      role === "assistant"
        ? {
            role,
            content: [{ type: "toolCall", id: "call", name, arguments: {} }],
          }
        : {
            role,
            toolCallId: "call",
            toolName: name,
            content: [{ type: "text", text: "No active meetings." }],
          };
    const onError = vi.fn();
    const options = {
      isStreaming: false,
      showReasoning: false,
      showToolCalls: true,
      pluginToolIcons: new Map([[name, { url: "blob:meeting-icon", onError }]]),
    };
    render(renderGroupedMessage(prepareChatMessageRender(message), "message", options), container);
    const icon = container.querySelector<HTMLImageElement>(".chat-tool-msg-summary__icon img");
    expect(icon?.getAttribute("src")).toBe("blob:meeting-icon");
    expect(icon?.alt).toBe("");
    icon?.dispatchEvent(new Event("error"));
    expect(onError).toHaveBeenCalledOnce();

    render(
      renderGroupedMessage(prepareChatMessageRender(message), "message", {
        ...options,
        pluginToolIcons: new Map(),
      }),
      container,
    );
    expect(container.querySelector(".chat-tool-msg-summary__icon img")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-summary__icon svg")).not.toBeNull();
  });

  it("keeps the existing progress claw when a Lobster call looks like a command", () => {
    const container = document.createElement("div");
    render(
      renderGroupedMessage(
        prepareChatMessageRender({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call",
              name: "lobster",
              arguments: { command: "run", pipeline: "review" },
            },
          ],
        }),
        "message",
        { isStreaming: false, showReasoning: false, showToolCalls: true },
      ),
      container,
    );
    expect(container.querySelector(".chat-tool-msg-summary__icon .claw-icon__jaw")).not.toBeNull();
  });
});
