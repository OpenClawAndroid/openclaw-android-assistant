import { html, nothing, render, type RootPart } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { renderMarkdownMedia, type MarkdownMedia } from "./chat-message-media-markdown.ts";

registerChatMessageMetadataEnglish();

// The new-session preview shares text presentation without loading transcript actions or tools.
type DuplicateSuffix = {
  count: number;
  label: string;
};

// Bound synchronous parsing so large JSON messages cannot freeze the render loop.
const MAX_JSON_AUTOPARSE_CHARS = 20_000;

export function detectJson(text: string): { parsed: unknown; text: string } | null {
  const trimmed = text.trim();

  if (trimmed.length > MAX_JSON_AUTOPARSE_CHARS) {
    return null;
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      // Parsing is only for the summary; reserialization loses numeric precision and duplicate keys.
      return { parsed, text: trimmed };
    } catch {
      return null;
    }
  }
  return null;
}

function jsonSummaryLabel(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    return t(
      parsed.length === 1 ? "chat.codeBlock.jsonArrayItem" : "chat.codeBlock.jsonArrayItems",
      { count: String(parsed.length) },
    );
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    if (keys.length <= 4) {
      return `{ ${keys.join(", ")} }`;
    }
    return t("chat.codeBlock.jsonObjectKeys", { count: String(keys.length) });
  }
  return t("chat.codeBlock.jsonBadge");
}

export function renderMessageJson(
  result: NonNullable<ReturnType<typeof detectJson>>,
  open = false,
) {
  return html`<details class="chat-json-collapse" ?open=${open}>
    <summary class="chat-json-summary">
      <span class="chat-json-badge">${t("chat.codeBlock.jsonBadge")}</span>
      <span class="chat-json-label">${jsonSummaryLabel(result.parsed)}</span>
    </summary>
    <pre class="chat-json-content"><code>${result.text}</code></pre>
  </details>`;
}

// Character length owns normal disclosure; this high line cap only bounds newline-heavy prompts.
const USER_MESSAGE_COLLAPSED_CHAR_LIMIT = 1_200;
const USER_MESSAGE_COLLAPSED_LINE_LIMIT = 40;

function shouldCollapseUserMessage(markdown: string): boolean {
  return (
    markdown.length > USER_MESSAGE_COLLAPSED_CHAR_LIMIT ||
    markdown.split("\n", USER_MESSAGE_COLLAPSED_LINE_LIMIT + 1).length >
      USER_MESSAGE_COLLAPSED_LINE_LIMIT
  );
}

function userMessageOverflowRef(expanded: boolean) {
  let resizeObserver: ResizeObserver | null = null;
  return (element: Element | undefined) => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const update = () => {
      const disclosure = element.parentElement;
      const toggle = disclosure?.querySelector<HTMLButtonElement>(
        ":scope > .chat-message-disclosure__toggle",
      );
      if (!disclosure || !toggle) {
        return;
      }
      toggle.hidden = !expanded && element.scrollHeight <= element.clientHeight + 1;
    };
    // Lit resolves refs while siblings are still committing. Measure after the
    // toggle exists; it renders visible so collapsing never shifts row height,
    // and only content that fits the clamp hides it.
    queueMicrotask(update);
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(element);
    }
  };
}

export function renderMessageMarkdown(
  markdown: string,
  messageKey: string,
  opts: {
    role: string;
    isStreaming: boolean;
    isUserMessageExpanded?: (messageId: string) => boolean;
    onToggleUserMessageExpanded?: (messageId: string) => void;
    assistantMessageDisclosure?: AssistantMessageDisclosure;
  },
  markdownRenderOptions: MarkdownRenderOptions,
  duplicateSuffix?: DuplicateSuffix,
  media?: MarkdownMedia,
) {
  const disclosure = opts.assistantMessageDisclosure;
  const isAssistant = opts.role === "assistant";
  const recoverFullMessage =
    isAssistant || (opts.role === "user" && disclosure?.onRetryFullMessage);
  const recovered = recoverFullMessage && disclosure?.expanded;
  const text = renderMarkdownText(
    recovered ? (disclosure.markdown ?? markdown) : markdown,
    messageKey,
    opts.isStreaming,
    recovered ? { ...markdownRenderOptions, mode: "document" } : markdownRenderOptions,
    duplicateSuffix,
    isAssistant && opts.isStreaming ? messageKey : undefined,
    media,
  );
  // Exhausted recovery keeps the preview visible and offers manual re-entry.
  if (recoverFullMessage && disclosure?.onRetryFullMessage) {
    return html`
      ${text}
      <div class="chat-message-load-error">
        ${t("chat.messages.fullContentLoadExhausted")}
        <button
          type="button"
          class="chat-message-load-error__retry"
          @click=${disclosure.onRetryFullMessage}
        >
          ${t("common.retry")}
        </button>
      </div>
    `;
  }
  if (
    opts.role !== "user" ||
    !opts.onToggleUserMessageExpanded ||
    !shouldCollapseUserMessage(markdown)
  ) {
    return text;
  }

  const disclosureId = `user-message:${messageKey}`;
  const expanded = opts.isUserMessageExpanded?.(disclosureId) ?? false;
  return html`
    <div class="chat-message-disclosure ${expanded ? "is-expanded" : ""}">
      <div class="chat-message-disclosure__content" ${ref(userMessageOverflowRef(expanded))}>
        ${text}
      </div>
      <button
        class="chat-message-disclosure__toggle"
        type="button"
        aria-expanded=${String(expanded)}
        @click=${() => opts.onToggleUserMessageExpanded?.(disclosureId)}
      >
        ${t(expanded ? "chat.messages.showLess" : "chat.messages.showMore")}
        ${expanded ? icons.chevronUp : icons.chevronDown}
      </button>
    </div>
  `;
}

export type AssistantMessageDisclosure = {
  expanded: boolean;
  markdown?: string;
  message?: unknown;
  /** Set when automatic full-message retries exhausted; invoking re-enters the loader. */
  onRetryFullMessage?: () => void;
};

class MarkdownPartsDirective extends AsyncDirective {
  private messageKey: string | undefined;
  private source = "";
  private stableHtml = "";
  private fragments: string[] = [];
  private generation = {};
  private mediaSlots = new Map<number, { element: HTMLElement; part?: RootPart }>();
  private mediaRender = {};

  protected override disconnected() {
    for (const slot of this.mediaSlots.values()) {
      slot.part?.setConnected(false);
    }
  }

  protected override reconnected() {
    for (const slot of this.mediaSlots.values()) {
      slot.part?.setConnected(true);
    }
  }

  render(
    messageKey: string,
    source: string,
    [stableHtml, tailHtml]: readonly [string, string],
    media?: MarkdownMedia,
  ) {
    if (this.messageKey !== messageKey) {
      for (const slot of this.mediaSlots.values()) {
        render(nothing, slot.element);
      }
      this.mediaSlots.clear();
    }
    if (
      this.messageKey !== messageKey ||
      !source.startsWith(this.source) ||
      !stableHtml.startsWith(this.stableHtml)
    ) {
      this.fragments = [];
      this.stableHtml = "";
      this.generation = {};
    }
    if (stableHtml.length > this.stableHtml.length) {
      this.fragments.push(stableHtml.slice(this.stableHtml.length));
    }
    this.messageKey = messageKey;
    this.source = source;
    this.stableHtml = stableHtml;
    const usedSlots = new Set<number>();
    const mediaRender = (this.mediaRender = {});
    const positionedMedia = media
      ? {
          ...media,
          render: (item: MarkdownMedia["items"][number], index: number) => {
            let slot = this.mediaSlots.get(index);
            if (!slot) {
              slot = { element: document.createElement("span") };
              this.mediaSlots.set(index, slot);
            }
            usedSlots.add(index);
            // Markdown can move a media slot from its streaming tail into the
            // stable prefix. Keep the media renderer and decoded image mounted.
            slot.part = render(media.render(item, index), slot.element);
            slot.part.setConnected(this.isConnected);
            return slot.element;
          },
        }
      : undefined;
    queueMicrotask(() => {
      if (this.mediaRender !== mediaRender) {
        return;
      }
      for (const [index, slot] of this.mediaSlots) {
        if (!usedSlots.has(index)) {
          render(nothing, slot.element);
          this.mediaSlots.delete(index);
        }
      }
    });
    // Canonical HTML proves continuity; live DOM also contains the reader's
    // control choices and Markdown enhancements, which must stay on its nodes.
    return keyed(
      this.generation,
      html`${this.fragments.map((fragment) => renderMarkdownMedia(fragment, positionedMedia))}${renderMarkdownMedia(tailHtml, positionedMedia)}`,
    );
  }
}

const markdownParts = directive(MarkdownPartsDirective);

function renderMarkdownText(
  markdown: string,
  messageKey: string,
  isStreaming: boolean,
  markdownRenderOptions?: MarkdownRenderOptions,
  duplicateSuffix?: DuplicateSuffix,
  streamKey?: string,
  media?: MarkdownMedia,
) {
  const parts: [string, string] = isStreaming
    ? toStreamingMarkdownParts(markdown, markdownRenderOptions, streamKey)
    : [toSanitizedMarkdownHtml(markdown, markdownRenderOptions), ""];
  if (duplicateSuffix) {
    const terminalPart = parts[1].trim() ? 1 : 0;
    parts[terminalPart] = appendDuplicateSuffix(parts[terminalPart], duplicateSuffix);
  }
  const content = markdownParts(messageKey, markdown, parts, media);
  return html`
    <div class="chat-text" dir="${detectTextDirection(media?.text ?? markdown)}">${content}</div>
  `;
}

function appendDuplicateSuffix(rendered: string, suffix: DuplicateSuffix): string {
  const template = document.createElement("template");
  template.innerHTML = rendered;
  const terminalBlock = template.content.lastElementChild;
  const target = terminalBlock ? duplicateSuffixTextOwner(terminalBlock) : null;

  const badge = document.createElement("span");
  badge.className = "chat-duplicate-count";
  badge.setAttribute("aria-label", suffix.label);
  badge.textContent = `×${suffix.count}`;
  (target ?? template.content).append(document.createTextNode("\u00a0"), badge);
  return template.innerHTML;
}

function duplicateSuffixTextOwner(block: Element): Element | null {
  if (/^(?:P|H[1-6])$/u.test(block.tagName)) {
    return block;
  }
  if (!/^(?:BLOCKQUOTE|LI|OL|UL)$/u.test(block.tagName)) {
    // Fences, details, raw blocks, and table shells own interactive or copied
    // content. Keep the status marker after the whole terminal block.
    return null;
  }
  const terminalChild = block.lastElementChild;
  if (!terminalChild) {
    return block.textContent?.trim() ? block : null;
  }
  return duplicateSuffixTextOwner(terminalChild);
}
