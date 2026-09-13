import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { cache } from "lit/directives/cache.js";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../components/icons.ts";
import { markdownBlocks } from "../../../components/markdown-blocks.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import {
  renderAttachmentPreviewSkeleton,
  renderCompactAttachmentCard,
} from "./chat-attachment-card.ts";
import {
  htmlPreviewElement,
  isHtmlDocument,
  LazyCustomElementRequestController,
  renderHtmlPreview,
} from "./chat-html-preview.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
const TEXT_PREVIEW_TIMEOUT_MS = 10_000;

export function isTextAttachment(rawMimeType: string, filename: string): boolean {
  const mimeType = rawMimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType.startsWith("text/")) {
    return true;
  }
  if (
    /^application\/(?:(?:[\w.-]+\+)?(?:json|xml)|javascript|x-javascript|yaml|x-yaml)$/.test(
      mimeType,
    )
  ) {
    return true;
  }
  return (
    (!mimeType || mimeType === "application/octet-stream") &&
    /\.(?:txt|md|markdown|html?|log|csv|tsv|json|jsonl|xml|yaml|yml)$/i.test(filename)
  );
}

class ChatTextAttachment extends OpenClawLightDomContentsElement {
  @property({ type: Boolean }) compact = false;
  @property() embedSandboxMode: EmbedSandboxMode = "scripts";
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "";
  @property({ type: Number }) sizeBytes: number | undefined;

  @state() private text: string | null = null;
  @state() private failed = false;
  @state() private source = false;

  private readonly htmlPreviewLoader = new LazyCustomElementRequestController(this);
  private loadVersion = 0;
  private abortController: AbortController | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate("src");
  }

  override disconnectedCallback(): void {
    this.cancelLoad();
    this.htmlPreviewLoader.requestWhileActive(htmlPreviewElement, false);
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("sourceIdentity")) {
      this.source = false;
    }
    if (changed.has("src") || changed.has("sourceIdentity") || changed.has("sizeBytes")) {
      this.cancelLoad();
      this.text = null;
      this.failed = false;
      if (this.src) {
        void this.loadText();
      }
    }
  }

  private cancelLoad(): void {
    this.loadVersion += 1;
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private async loadText(): Promise<void> {
    if (this.sizeBytes !== undefined && this.sizeBytes > TEXT_PREVIEW_MAX_BYTES) {
      this.failed = true;
      return;
    }
    const version = this.loadVersion;
    const controller = new AbortController();
    this.abortController = controller;
    const timeout = setTimeout(() => controller.abort(), TEXT_PREVIEW_TIMEOUT_MS);
    try {
      // The caller supplies a resolved media ticket or blob, never a reusable credential.
      const response = await fetch(this.src, {
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Text attachment unavailable");
      }
      const bytes = await readResponseBytesWithinLimit(response, TEXT_PREVIEW_MAX_BYTES);
      if (!bytes) {
        throw new Error("Text attachment exceeds preview limit");
      }
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (text.includes("\0")) {
        throw new Error("Binary attachment");
      }
      if (version === this.loadVersion && this.isConnected) {
        this.text = text;
      }
    } catch {
      if (version === this.loadVersion && this.isConnected) {
        this.failed = true;
      }
    } finally {
      clearTimeout(timeout);
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
    }
  }

  override render() {
    const htmlDocument = isHtmlDocument(this.mimeType, this.label);
    const mimeType = this.mimeType.split(";", 1)[0]?.trim().toLowerCase();
    const markdown =
      mimeType === "text/markdown" ||
      mimeType === "text/x-markdown" ||
      /\.(?:md|markdown)$/i.test(this.label);
    // Cache detaches the reader before identity or validated-text changes replace it.
    const reader =
      this.text === null
        ? renderAttachmentPreviewSkeleton()
        : html`${keyed(
            this.sourceIdentity || this.loadVersion,
            html`${keyed(
              this.text,
              htmlDocument
                ? html`<div class="chat-html-preview" ?hidden=${this.source}>
                      ${renderHtmlPreview(this.htmlPreviewLoader, this.text, this.sourceIdentity || this.src, this.label, this.embedSandboxMode)}
                    </div>
                    <pre
                      class="sidebar-attachment-preview__text"
                      tabindex="0"
                      aria-label=${this.label}
                      ?hidden=${!this.source}
                    >
${this.text}</pre>`
                : markdown && !this.source
                  ? html`<article
                      class="sidebar-attachment-preview__markdown sidebar-markdown-reader sidebar-markdown"
                      dir=${detectTextDirection(this.text)}
                      aria-label=${this.label}
                      ${markdownBlocks()}
                    >
                      ${unsafeHTML(
                        toSanitizedMarkdownHtml(this.text, {
                          // The fetch already bounds document size; do not apply chat-message
                          // truncation or let an attachment load remote tracking images.
                          mode: "document",
                          remoteImages: false,
                          codeBlockInteraction: "interactive",
                        }),
                      )}
                    </article>`
                  : html`<pre
                      class="sidebar-attachment-preview__text"
                      tabindex="0"
                      aria-label=${this.label}
                    >
${this.text}</pre>`,
            )}`,
          )}`;
    return html`
      ${
        this.compact
          ? html`<div class="sidebar-file-toolbar">
              <span class="sidebar-file-toolbar__type" title=${this.mimeType}
                >${this.mimeType || this.label.split(".").at(-1)}</span
              >
              ${this.sizeBytes === undefined ? nothing : html`<span>${formatBytes(this.sizeBytes)}</span>`}
              <span class="sidebar-file-toolbar__actions">
                ${
                  (markdown || htmlDocument) && this.text !== null
                    ? html`<button
                        class="btn btn--sm"
                        type="button"
                        aria-pressed=${String(this.source)}
                        @click=${() => {
                          this.source = !this.source;
                        }}
                      >
                        ${this.source ? t("chat.workspaceFiles.preview") : htmlDocument ? t("chat.detailPanel.viewSource") : t("chat.detailPanel.viewRawText")}
                      </button>`
                    : nothing
                }
                <a
                  class="rail-header__action"
                  href=${this.src || nothing}
                  download=${this.label}
                  target="_blank"
                  rel="noreferrer"
                  aria-label=${t("chat.mediaPlayer.download", { filename: this.label })}
                  >${icons.download}</a
                >
              </span>
            </div>`
          : renderCompactAttachmentCard({
              kind: "document",
              label: this.label,
              mimeType: this.mimeType,
              sizeBytes: this.sizeBytes,
              downloadHref: this.src,
              downloadPending: !this.src,
            })
      }
      ${
        this.failed
          ? html`<p class="muted" role="status">${t("chat.attachments.textPreviewUnavailable")}</p>`
          : cache(reader)
      }
    `;
  }
}

if (!customElements.get("openclaw-chat-text-attachment")) {
  customElements.define("openclaw-chat-text-attachment", ChatTextAttachment);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-text-attachment": ChatTextAttachment;
  }
}
