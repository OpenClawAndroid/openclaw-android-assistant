import { html, nothing } from "lit";
import { createAsyncQuestionPanelProps } from "./chat-async-question.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import {
  createGatewayQuestionPanelProps,
  type QuestionPanelOptions,
  type QuestionPanelProps,
} from "./chat-question-card.ts";

export function renderComposerQuestionDock(panel: QuestionPanelProps | null) {
  return panel
    ? html`<div class="agent-chat__question-dock">
        <openclaw-chat-question-panel .props=${panel}></openclaw-chat-question-panel>
      </div>`
    : nothing;
}

export function resolveComposerQuestionPanel(
  props: ChatComposerProps,
  state: ChatComposerState,
  requestUpdate: () => void,
): QuestionPanelProps | null {
  const gatewayQuestions =
    props.gatewayQuestionPrompts?.filter((prompt) => prompt.status === "pending") ?? [];
  const asyncQuestions = props.asyncQuestions;
  const requests =
    props.disabledBanner?.kind === "composer-replacement"
      ? []
      : [
          ...gatewayQuestions.map((prompt) => ({
            key: `gateway:${prompt.id}`,
            panel: (options: QuestionPanelOptions) =>
              createGatewayQuestionPanelProps(prompt, {
                ...options,
                onChange: props.onGatewayQuestionChange,
                onSubmit: props.onGatewayQuestionSubmit
                  ? (answers) => props.onGatewayQuestionSubmit?.(prompt.id, answers)
                  : undefined,
                onSkip: props.onGatewayQuestionSkip
                  ? () => props.onGatewayQuestionSkip?.(prompt.id)
                  : undefined,
              }),
          })),
          ...(asyncQuestions?.submit
            ? asyncQuestions.pending.map((question) => ({
                key: JSON.stringify([asyncQuestions.scope, question.itemId]),
                panel: (options: QuestionPanelOptions) =>
                  createAsyncQuestionPanelProps(question, asyncQuestions, options),
              }))
            : []),
        ];
  // A newly arrived blocking request takes priority, but navigation can still
  // reach async questions without repeatedly switching back on every render.
  const newGatewayQuestion = gatewayQuestions.find(
    (prompt) => !state.gatewayQuestionIds.has(prompt.id),
  );
  state.gatewayQuestionIds = new Set(gatewayQuestions.map((prompt) => prompt.id));
  const activeGatewayQuestion = gatewayQuestions.some(
    (prompt) => state.activeQuestionKey === `gateway:${prompt.id}`,
  );
  if (newGatewayQuestion && !activeGatewayQuestion) {
    state.activeQuestionKey = `gateway:${newGatewayQuestion.id}`;
    state.questionCollapsed = false;
  }
  let index = requests.findIndex((request) => request.key === state.activeQuestionKey);
  if (index < 0) {
    index = 0;
    state.activeQuestionKey = requests[0]?.key ?? null;
    state.questionCollapsed = false;
  }
  const request = requests[index];
  if (!request) {
    return null;
  }
  const selectRequest = (next: number) => {
    state.activeQuestionKey = requests[next]!.key;
    state.questionCollapsed = false;
    requestUpdate();
  };
  return request.panel({
    collapsed: state.questionCollapsed,
    onCollapsedChange: (collapsed) => {
      state.questionCollapsed = collapsed;
      state.restoreComposerFocus = collapsed;
      requestUpdate();
    },
    requestPosition:
      requests.length > 1 ? { current: index + 1, total: requests.length } : undefined,
    onPreviousRequest: () => selectRequest((index - 1 + requests.length) % requests.length),
    onNextRequest: () => selectRequest((index + 1) % requests.length),
  });
}
