/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const container = document.createElement("div");
afterEach(() => {
  render(null, container);
  container.remove();
  resetChatViewState();
  resetTranscriptTestDom();
});

it("submits the docked answer after editing its draft without unrelated chat updates", async () => {
  installTranscriptDomMocks();
  document.body.append(container);
  const submit = vi.fn(async () => true);
  const props = createChatProps({
    sessionKey: "agent:main:main",
    messages: [
      {
        role: "assistant",
        content: "Which audience?",
        openclawAsyncDelivery: {
          itemId: "audience",
          questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
        },
      },
    ],
    onAsyncQuestionSubmit: submit,
    onRequestUpdate: () => render(renderChat(props), container),
  });
  render(renderChat(props), container);
  await vi.waitFor(() =>
    expect(container.querySelector(".chat-question-panel__other")).not.toBeNull(),
  );
  const answer = container.querySelector<HTMLInputElement>(".chat-question-panel__other")!;
  answer.value = "New contributors";
  answer.dispatchEvent(new Event("input", { bubbles: true }));
  await Promise.resolve();
  container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
  await vi.waitFor(() =>
    expect(submit).toHaveBeenCalledExactlyOnceWith("> Which audience?\n\nNew contributors"),
  );
  await vi.waitFor(() => expect(container.querySelector(".agent-chat__question-dock")).toBeNull());
  expect(container.querySelector(".chat-question-summary")?.textContent).toContain(
    "New contributors",
  );
});
