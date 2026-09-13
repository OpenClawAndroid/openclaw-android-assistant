import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";

describe("plugin tool icons", () => {
  it.each([
    ["assistant", "memory_search"],
    ["toolResult", "memory_search"],
    ["assistant", "memory_get"],
    ["toolResult", "memory_get"],
  ])("keeps the memory glyph for %s %s rows with plugin artwork", (role, name) => {
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
    render(
      renderGroupedMessage(prepareChatMessageRender(message), "message", {
        isStreaming: false,
        showReasoning: false,
        showToolCalls: true,
        pluginToolIcons: new Map([[name, { url: "blob:memory-plugin-icon", onError: vi.fn() }]]),
      }),
      container,
    );
    expect(container.querySelector(".chat-tool-msg-summary__icon img")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-summary__icon svg")).not.toBeNull();
  });

  it.each(["assistant", "toolResult"])("uses the plugin icon for %s tool rows", (role) => {
    const container = document.createElement("div");
    const message =
      role === "assistant"
        ? {
            role,
            content: [{ type: "toolCall", id: "call", name: "meeting_status", arguments: {} }],
          }
        : {
            role,
            toolCallId: "call",
            toolName: "meeting_status",
            content: [{ type: "text", text: "No active meetings." }],
          };
    const onError = vi.fn();
    const options = {
      isStreaming: false,
      showReasoning: false,
      showToolCalls: true,
      pluginToolIcons: new Map([["meeting_status", { url: "blob:meeting-icon", onError }]]),
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
});
