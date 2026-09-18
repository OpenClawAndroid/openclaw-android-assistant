import { html, type TemplateResult } from "lit";
import { scrollState } from "../../../components/scroll-state.ts";
import "../../../components/tooltip.ts";
import "../../../styles/chat/selection-annotations.css";

export function renderAttachmentChip(options: {
  label: string;
  icon: TemplateResult;
  onClick?: () => void;
  onReveal?: () => void;
  keyboardClick?: boolean;
}) {
  return html`<span
    class="chat-attachment-thumb chat-attachment-thumb--file chat-selection-annotations__chip"
    role="button"
    tabindex="0"
    @pointerenter=${options.onReveal}
    @focusin=${options.onReveal}
    @click=${options.onClick}
    @keydown=${(event: KeyboardEvent) => {
      if (
        options.keyboardClick !== false &&
        (event.key === "Enter" || event.key === " ") &&
        event.currentTarget instanceof HTMLElement
      ) {
        event.preventDefault();
        event.currentTarget.click();
      }
    }}
  >
    <span class="chat-attachment-file">
      <span aria-hidden="true">${options.icon}</span>
      <span class="chat-attachment-preview-label" dir="auto">${options.label}</span>
    </span>
  </span>`;
}

export function renderAttachmentPreviewChip(options: {
  label: string;
  regionLabel: string;
  icon: TemplateResult;
  content: TemplateResult;
  onReveal?: () => void;
  openOnClick?: boolean;
}) {
  return html`<openclaw-tooltip
    class="chat-comment-preview"
    placement="top-start"
    auto-size
    .describe=${false}
    .openOnClick=${options.openOnClick ?? false}
  >
    ${renderAttachmentChip({
      label: options.label,
      icon: options.icon,
      onReveal: options.onReveal,
      onClick: options.openOnClick ? options.onReveal : undefined,
      keyboardClick: options.openOnClick ?? false,
    })}
    <div
      slot="content"
      class="chat-comment-preview__scroll"
      tabindex="0"
      role="region"
      aria-label=${options.regionLabel}
      ${scrollState()}
    >
      ${options.content}
    </div>
  </openclaw-tooltip>`;
}
