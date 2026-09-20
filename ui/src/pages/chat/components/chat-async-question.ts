import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html } from "lit";
import type { QuestionDraft } from "../../../app/question-prompt.ts";
import { t } from "../../../i18n/index.ts";
import { questionDraftValues } from "./chat-question-answer-controls.ts";
import type { QuestionPanelOptions, QuestionPanelProps } from "./chat-question-card.ts";

export type AsyncQuestions = {
  itemId: string;
  questions: { title: string; options?: string[] }[];
};

export type AsyncQuestionDraft = {
  answers: Map<string, QuestionDraft>;
  status?: "submitting" | "submitted" | "skipped";
  error?: string;
};

export type AsyncQuestionPresentation = {
  scope: string;
  pending: AsyncQuestions[];
  drafts: Map<string, AsyncQuestionDraft>;
  onChange: () => void;
  submit?: (message: string) => Promise<boolean>;
};

export function createAsyncQuestionPresentation(
  state: {
    asyncQuestionScope?: string;
    asyncQuestionDrafts: Map<string, AsyncQuestionDraft>;
    asyncQuestionRevision: number;
    transcriptRenderContext: { onAsyncQuestionSubmit?: AsyncQuestionPresentation["submit"] };
  },
  props: {
    messages?: readonly unknown[];
    sessionKey: string;
    currentAgentId?: string;
    connectionEpoch?: number;
    onAsyncQuestionSubmit?: AsyncQuestionPresentation["submit"];
    onRequestUpdate?: () => void;
  },
): AsyncQuestionPresentation {
  const scope = JSON.stringify([props.sessionKey, props.currentAgentId, props.connectionEpoch]);
  if (state.asyncQuestionScope !== scope) {
    state.asyncQuestionScope = scope;
    state.asyncQuestionDrafts = new Map();
  }
  const drafts = state.asyncQuestionDrafts;
  const isCurrent = () =>
    state.asyncQuestionScope === scope && state.asyncQuestionDrafts === drafts;
  const questions = new Map<string, AsyncQuestions>();
  for (const message of props.messages ?? []) {
    const question = readAsyncQuestions(message);
    if (question) {
      questions.set(question.itemId, question);
    }
  }
  return {
    scope,
    pending: [...questions.values()].filter((question) => {
      const status = drafts.get(question.itemId)?.status;
      return status !== "submitted" && status !== "skipped";
    }),
    drafts,
    onChange: () => {
      if (isCurrent()) {
        state.asyncQuestionRevision += 1;
        props.onRequestUpdate?.();
      }
    },
    submit: props.onAsyncQuestionSubmit
      ? async (message) => {
          if (!isCurrent()) {
            return false;
          }
          return (await state.transcriptRenderContext.onAsyncQuestionSubmit?.(message)) === true;
        }
      : undefined,
  };
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && value.trim().length > 0;
}

export function readAsyncQuestions(message: unknown): AsyncQuestions | null {
  if (!isRecord(message) || message.role !== "assistant") {
    return null;
  }
  const metadata = message.openclawAsyncDelivery;
  if (
    !isRecord(metadata) ||
    !boundedText(metadata.itemId, 256) ||
    !Array.isArray(metadata.questions) ||
    metadata.questions.length === 0 ||
    metadata.questions.length > 12
  ) {
    return null;
  }
  const questions: AsyncQuestions["questions"] = [];
  for (const question of metadata.questions) {
    if (
      !isRecord(question) ||
      !boundedText(question.title, 4096) ||
      (question.options !== undefined &&
        (!Array.isArray(question.options) ||
          question.options.length === 0 ||
          question.options.length > 4 ||
          !question.options.every((option) => boundedText(option, 256))))
    ) {
      return null;
    }
    questions.push({ title: question.title, options: question.options });
  }
  return { itemId: metadata.itemId, questions };
}

function quoteQuestion(title: string): string {
  const encoder = new TextEncoder();
  let quote = "";
  let bytes = 0;
  for (const character of title) {
    bytes += encoder.encode(character).length;
    if (bytes > 512) {
      break;
    }
    quote += character;
  }
  return `> ${quote.replace(/[\r\n]/g, " ")}`;
}

function getQuestionDraft(questions: AsyncQuestions, presentation: AsyncQuestionPresentation) {
  let draft = presentation.drafts.get(questions.itemId);
  if (!draft) {
    draft = {
      answers: new Map(
        questions.questions.map((question, index) => [
          String(index),
          { selected: new Set(question.options?.slice(0, 1)), freeText: "" },
        ]),
      ),
    };
    presentation.drafts.set(questions.itemId, draft);
  }
  return draft;
}

export function createAsyncQuestionPanelProps(
  questions: AsyncQuestions,
  presentation: AsyncQuestionPresentation,
  options: QuestionPanelOptions,
): QuestionPanelProps {
  const draft = getQuestionDraft(questions, presentation);
  const count = presentation.pending.reduce(
    (total, request) => total + request.questions.length,
    0,
  );
  return {
    model: {
      requestKey: JSON.stringify([presentation.scope, questions.itemId]),
      title: t("chat.asyncQuestions.title"),
      questions: questions.questions.map((question, index) => ({
        questionId: String(index),
        header: question.options ? question.title : t("chat.questions.answer"),
        question: question.title,
        options: (question.options ?? []).map((label) => ({ label })),
        isOther: true,
      })),
      autoFocus: false,
      nonBlocking: true,
      collapsed: options.collapsed ?? false,
      collapsedLabel: t(
        count === 1 ? "chat.asyncQuestions.pendingOne" : "chat.asyncQuestions.pendingMany",
        { count: String(count) },
      ),
      disabled: !presentation.submit,
      submitting: draft.status === "submitting",
      drafts: draft.answers,
      error: draft.error,
      requestPosition: options.requestPosition,
    },
    onChange: presentation.onChange,
    onCollapsedChange: options.onCollapsedChange,
    onPreviousRequest: options.onPreviousRequest,
    onNextRequest: options.onNextRequest,
    onSkip: () => {
      draft.status = "skipped";
      presentation.onChange();
    },
    onSubmit: async (answers: Record<string, string[]>) => {
      if (draft.status) {
        return;
      }
      draft.status = "submitting";
      draft.error = undefined;
      presentation.onChange();
      const message = questions.questions
        .map(
          (question, index) =>
            `${quoteQuestion(question.title)}\n\n${answers[String(index)]?.join(", ") ?? ""}`,
        )
        .join("\n\n");
      try {
        if (!(await presentation.submit?.(message))) {
          throw new Error(t("chat.asyncQuestions.sendFailed"));
        }
        draft.status = "submitted";
      } catch (error) {
        draft.status = undefined;
        draft.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        presentation.onChange();
      }
    },
  };
}

export function renderAsyncQuestionSummary(
  questions: AsyncQuestions,
  presentation: AsyncQuestionPresentation,
) {
  const draft = presentation.drafts.get(questions.itemId);
  return html`<div class="chat-question-summary" role="status">
    ${questions.questions.map(
      (question, index) => html`<div>
        <strong>${question.title}</strong>
        <div>
          ${
            draft?.status === "submitted"
              ? questionDraftValues(draft.answers.get(String(index))).join(", ")
              : t(
                  draft?.status === "skipped"
                    ? "chat.questions.skipped"
                    : "chat.asyncQuestions.inComposer",
                )
          }
        </div>
      </div>`,
    )}
  </div>`;
}
