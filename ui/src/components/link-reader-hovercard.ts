import { initialState, Task, TaskStatus } from "@lit/task";
import { parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing, ReactiveElement, render, type TemplateResult } from "lit";
import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderPreview,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n, t } from "../i18n/index.ts";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { anchorFromNavigationEvent } from "../lib/navigation-click.ts";
import "../styles/link-reader-hovercard.css";
import { subscribeToSharedRequest } from "../lib/shared-request-subscription.ts";
import {
  LINK_READER_HOVERCARD_OPEN_DELAY_MS,
  resolveLinkReaderTarget,
  linkReaderTargetKey,
  linkReaderResponseMatchesTarget,
  EMPTY_LINK_READERS,
  type LinkReaderTarget,
} from "./link-reader-target.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";

registerLinkReaderEnglish();

const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;

type LinkPreview = LinkReaderTarget & ControlUiLinkReaderPreview;

type CacheEntry = {
  preview?: ControlUiLinkReaderPreview;
  failed?: boolean;
  expiresAt: number;
  promise: Promise<ControlUiLinkReaderPreview>;
  controller: AbortController;
  subscribers: Set<object>;
};

type PreviewContext = {
  generation: number;
  recoveryScope: string;
  succeeded: boolean;
};

// Page-memory only. Providers share success, never credentials or persisted state.
const previewContexts = new WeakMap<GatewayBrowserClient, Map<string, PreviewContext>>();

function previewContextFor(
  client: GatewayBrowserClient,
  agentId: string | undefined,
): PreviewContext {
  let contexts = previewContexts.get(client);
  if (!contexts) {
    contexts = new Map();
    previewContexts.set(client, contexts);
  }
  const key = agentId ?? "";
  let context = contexts.get(key);
  if (
    !context ||
    context.generation !== client.connectionGeneration ||
    context.recoveryScope !== client.recoveryScope
  ) {
    context = {
      generation: client.connectionGeneration,
      recoveryScope: client.recoveryScope,
      succeeded: false,
    };
    contexts.set(key, context);
  }
  return context;
}

let nextHovercardId = 0;

function safePreviewImage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^data:image\/(?:gif|jpeg|png|webp);base64,/u.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.+$/u, "");
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin !== window.location.origin &&
      host.includes(".") &&
      !/(?:^|\.)(?:localhost|local|internal|localdomain)$/u.test(host) &&
      !parseCanonicalIpAddress(host)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function parsePreviewResponse(
  target: LinkReaderTarget,
  value: unknown,
): ControlUiLinkReaderPreview {
  const title = isRecord(value) ? readNonBlankString(value.title) : undefined;
  if (
    !isRecord(value) ||
    !title ||
    typeof value.url !== "string" ||
    !linkReaderResponseMatchesTarget(target, value.url)
  ) {
    throw new Error("Invalid link preview response");
  }
  const badgeValue = isRecord(value.badge) ? value.badge : undefined;
  const tone = (["neutral", "positive", "negative", "attention", "accent"] as const).find(
    (item) => item === badgeValue?.tone,
  );
  const badge =
    badgeValue && typeof badgeValue.label === "string" && tone
      ? { label: badgeValue.label, tone }
      : undefined;
  return {
    url: value.url,
    title,
    subtitle: readNonBlankString(value.subtitle),
    badge,
    author: readNonBlankString(value.author),
    createdAt: readNonBlankString(value.createdAt),
    updatedAt: readNonBlankString(value.updatedAt),
    imageUrl: safePreviewImage(readNonBlankString(value.imageUrl)),
    metadata: Array.isArray(value.metadata)
      ? value.metadata.flatMap((entry) =>
          isRecord(entry) && typeof entry.label === "string" && typeof entry.value === "string"
            ? [{ label: entry.label, value: entry.value }]
            : [],
        )
      : undefined,
  };
}

function renderAvatar(imageUrl: string | undefined) {
  return imageUrl
    ? html`<img
        class="link-reader-hovercard__image"
        alt=""
        decoding="async"
        crossorigin="anonymous"
        referrerpolicy="no-referrer"
        src=${imageUrl}
        @error=${(event: Event) => {
          if (event.currentTarget instanceof HTMLImageElement) {
            event.currentTarget.remove();
          }
        }}
      />`
    : nothing;
}

function renderCardLink(className: string, href: string, content: string | TemplateResult) {
  return html`<a
    class=${className}
    href=${href}
    target=${EXTERNAL_LINK_TARGET}
    rel=${buildExternalLinkRel()}
    >${content}</a
  >`;
}

function renderLoading(card: HTMLDivElement): void {
  card.dataset.loading = "true";
  card.removeAttribute("data-state");
  card.removeAttribute("data-cached");
  card.setAttribute("aria-label", t("linkReader.loadingPreview"));
  const rows = [
    ["header", ["badge", "subtitle", "time"]],
    ["title", ["title"]],
    ["footer", ["author", "metadata"]],
  ] as const;
  render(
    html`<div class="link-reader-hovercard__skeleton" aria-hidden="true">
      ${rows.map(([rowClass, parts]) => html`<div class=${"link-reader-hovercard__" + rowClass}>${parts.map((part) => html`<span class=${"skeleton link-reader-hovercard__placeholder--" + part}></span>`)}</div>`)}
    </div>`,
    card,
  );
}

function renderPreview(card: HTMLDivElement, preview: LinkPreview, seeded = false): void {
  card.dataset.loading = "false";
  card.dataset.cached = String(seeded);
  card.dataset.state = preview.badge?.tone ?? "neutral";
  const timestamp = preview.updatedAt ?? preview.createdAt;
  render(
    html`<div class="link-reader-hovercard__header">
        ${preview.badge ? html`<span class="link-reader-hovercard__state" data-tone=${preview.badge.tone}><span class="link-reader-hovercard__state-dot" aria-hidden="true"></span>${preview.badge.label}</span>` : nothing}
        ${renderCardLink("link-reader-hovercard__subtitle", preview.href, preview.subtitle ?? preview.reader.label)}
        ${seeded ? html`<span class="link-reader-hovercard__time">${t("linkReader.cachedPreview")}</span>` : timestamp ? html`<time class="link-reader-hovercard__time" datetime=${timestamp}>${formatRelativeTimestamp(Date.parse(timestamp))}</time>` : nothing}
      </div>
      ${renderCardLink("link-reader-hovercard__title", preview.href, preview.title)}
      <div class="link-reader-hovercard__footer">
        ${preview.author || preview.imageUrl ? html`<span class="link-reader-hovercard__author">${renderAvatar(preview.imageUrl)}${preview.author}</span>` : nothing}
        <span class="link-reader-hovercard__metadata"
          >${preview.metadata?.map(({ label, value }) => html`<span class="link-reader-hovercard__metric">${label ? label + ": " : ""}${value}</span>`)}</span
        >
      </div>`,
    card,
  );
  card.setAttribute("aria-label", t("linkReader.previewAriaLabel", { title: preview.title }));
}

export class LinkReaderHovercardProvider extends ReactiveElement {
  // Lit must replay values assigned before the lazy custom element upgrades,
  // otherwise own properties shadow the identity-resetting accessors below.
  static override properties = {
    client: { attribute: false, noAccessor: true },
    agentId: { attribute: false, noAccessor: true },
    readers: { attribute: false, noAccessor: true },
    previewSeeds: { attribute: false, noAccessor: true },
  };

  private gatewayClient: GatewayBrowserClient | null = null;
  private selectedAgentId: string | undefined;
  private readerDescriptors: readonly ControlUiLinkReaderDescriptor[] = EMPTY_LINK_READERS;

  get readers(): readonly ControlUiLinkReaderDescriptor[] {
    return this.readerDescriptors;
  }
  set readers(value: readonly ControlUiLinkReaderDescriptor[]) {
    if (
      value.length === this.readerDescriptors.length &&
      value.every((reader, index) => reader === this.readerDescriptors[index])
    ) {
      return;
    }
    this.invalidatePreviewContext();
    this.close();
    this.clearPreviews();
    this.readerDescriptors = value;
    this.seeds = null;
    this.dispatchEvent(new Event("link-reader-capabilities-changed"));
  }

  private seeds: {
    client: GatewayBrowserClient | null;
    agentId: string | undefined;
    generation: number | undefined;
    recoveryScope: string | undefined;
    previews: readonly ControlUiLinkReaderPreview[];
  } | null = null;

  get previewSeeds(): readonly ControlUiLinkReaderPreview[] {
    return this.seeds?.previews ?? [];
  }

  set previewSeeds(previews: readonly ControlUiLinkReaderPreview[]) {
    this.seeds = {
      client: this.client,
      agentId: this.agentId,
      generation: this.client?.connectionGeneration,
      recoveryScope: this.client?.recoveryScope,
      previews,
    };
    this.requestUpdate();
  }

  private seedPreview(target: LinkReaderTarget): LinkPreview | undefined {
    const seeds = this.seeds;
    if (
      !seeds ||
      seeds.client !== this.client ||
      seeds.agentId !== this.agentId ||
      seeds.generation !== this.client?.connectionGeneration ||
      seeds.recoveryScope !== this.client?.recoveryScope
    ) {
      return undefined;
    }
    const seed = seeds.previews.find((preview) => {
      const seedTarget = resolveLinkReaderTarget(preview.url, [target.reader]);
      return seedTarget && linkReaderTargetKey(seedTarget) === linkReaderTargetKey(target);
    });
    return seed ? { ...seed, ...target } : undefined;
  }

  get client(): GatewayBrowserClient | null {
    return this.gatewayClient;
  }

  set client(value: GatewayBrowserClient | null) {
    if (value === this.gatewayClient) {
      return;
    }
    this.invalidatePreviewContext();
    this.close();
    this.clearPreviews();
    this.gatewayClient = value;
    this.dispatchEvent(new Event("link-reader-capabilities-changed"));
  }

  get agentId(): string | undefined {
    return this.selectedAgentId;
  }

  set agentId(value: string | undefined) {
    if (value === this.selectedAgentId) {
      return;
    }
    this.invalidatePreviewContext();
    this.close();
    this.clearPreviews();
    this.selectedAgentId = value;
    this.dispatchEvent(new Event("link-reader-capabilities-changed"));
  }

  private readonly cache = new Map<string, CacheEntry>();
  private previewContext: PreviewContext | null = null;
  private allowLoading = false;
  private requestStarted = false;

  private invalidatePreviewContext(): void {
    this.seeds = null;
    this.previewContext = null;
  }

  private syncPreviewContext(): PreviewContext | null {
    const context = this.client ? previewContextFor(this.client, this.agentId) : null;
    if (context !== this.previewContext) {
      // Clearing cached facts also updates inline projections under this new context.
      this.previewContext = context;
      this.close();
      this.clearPreviews();
    }
    return context;
  }
  private syncInlineStates(): void {
    this.syncPreviewContext();
    for (const anchor of this.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")) {
      // Nested providers retain their own agent and connection identity.
      let owner = anchor.parentElement;
      while (owner && !(owner instanceof LinkReaderHovercardProvider)) {
        owner = owner.parentElement;
      }
      if (owner !== this) {
        continue;
      }
      const target = resolveLinkReaderTarget(anchor.href, this.readers);
      const preview = target ? this.cachedPreview(target)?.preview : undefined;
      if (!preview?.badge) {
        delete anchor.dataset.linkReaderTone;
        anchor.removeAttribute("aria-description");
      } else {
        anchor.setAttribute("aria-description", preview.badge.label);
        anchor.dataset.linkReaderTone = preview.badge.tone;
      }
    }
  }

  private readonly inlineObserver = new MutationObserver(() => this.syncInlineStates());

  private clearPreviews(): void {
    for (const entry of this.cache.values()) {
      entry.controller.abort();
    }
    this.cache.clear();
    this.syncInlineStates();
  }

  async prefetch(target: LinkReaderTarget, signal: AbortSignal): Promise<void> {
    if (
      !this.isConnected ||
      !this.client?.connected ||
      !this.readers.includes(target.reader) ||
      !target.reader.linkReader.previewMethod ||
      signal.aborted
    ) {
      return;
    }
    this.syncPreviewContext();
    await this.loadPreview(target, signal);
    if (!signal.aborted) {
      this.syncInlineStates();
    }
  }

  private activeAnchor: HTMLAnchorElement | null = null;
  private activeTarget: LinkReaderTarget | null = null;
  // Which surface opened the current card: gates whether focus landing inside
  // the portaled card (e.g. clicking the title link) can hold it open, so a
  // pointer-driven open still fully releases on mouse-out (see handleCardPointerLeave).
  private activeTrigger: "focus" | "pointer" | null = null;
  private readonly hovercard = new PortaledHovercardController(() => this.close());
  private stopI18n: (() => void) | null = null;
  private readonly previewTask = new Task(this, {
    autoRun: false,
    args: () => [this.activeTarget] as const,
    // Share metadata, not navigation: each activation owns its full validated URL.
    task: async ([target], { signal }) =>
      target ? { ...(await this.loadPreview(target, signal)), ...target } : initialState,
  });
  private readonly activeAnchorObserver = new MutationObserver(() => {
    const anchor = this.activeAnchor;
    // The card is portaled outside the routed tree, whose replacement can remove
    // a hovered link without a pointer event reaching this delegated handler.
    if (anchor && (!this.contains(anchor) || anchor.href !== this.activeTarget?.href)) {
      this.close();
    }
  });

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "contents";
    this.inlineObserver.observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    this.addEventListener("pointerover", this.handlePointerOver);
    this.addEventListener("pointerout", this.handlePointerOut);
    this.addEventListener("focusin", this.handleFocusIn);
    this.addEventListener("focusout", this.handleFocusOut);
    this.addEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.addEventListener("click", this.handleClick);
    this.stopI18n ??= i18n.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    this.removeEventListener("pointerover", this.handlePointerOver);
    this.removeEventListener("pointerout", this.handlePointerOut);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.removeEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.removeEventListener("click", this.handleClick);
    this.inlineObserver.disconnect();
    this.stopI18n?.();
    this.stopI18n = null;
    this.close();
    this.clearPreviews();
    super.disconnectedCallback();
  }

  protected override updated(): void {
    const context = this.syncPreviewContext();
    this.syncInlineStates();
    if (!this.activeAnchor) {
      return;
    }
    const anchor = this.activeAnchor;
    const target = this.activeTarget;
    if (!anchor || !target || !this.requestStarted) {
      return;
    }
    if (!this.isConnected || !this.contains(anchor) || anchor.href !== target.href) {
      this.close();
      return;
    }
    this.previewTask.render({
      pending: () => {
        const seed = this.seedPreview(target);
        if (this.hovercard.held) {
          if (seed) {
            this.show(anchor, seed, true);
          } else if (this.allowLoading && context?.succeeded) {
            this.show(anchor);
          }
        }
      },
      complete: (preview) => {
        if (preview.href === target.href && (this.hovercard.card || this.hovercard.held)) {
          this.show(anchor, preview);
        }
      },
      error: () => {
        const seed = this.seedPreview(target);
        if (seed && (this.hovercard.card || this.hovercard.held)) {
          this.show(anchor, seed, true);
        } else {
          this.close();
        }
      },
    });
  }

  private readonly handlePointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      return;
    }
    const anchor = anchorFromNavigationEvent(event);
    const target = anchor ? resolveLinkReaderTarget(anchor.href, this.readers) : null;
    if (!anchor || !target?.reader.linkReader.previewMethod) {
      return;
    }
    this.activateFromBootstrap(anchor, target, "pointer", LINK_READER_HOVERCARD_OPEN_DELAY_MS);
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const anchor = anchorFromNavigationEvent(event);
    if (!anchor || anchor !== this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.pointerInside = false;
    this.scheduleIntentClose();
  };

  private scheduleIntentClose(): void {
    if (this.previewTask.status === TaskStatus.PENDING && !this.hovercard.held) {
      this.close();
    } else {
      this.hovercard.scheduleClose();
    }
  }

  private readonly handleCardPointerLeave = () => {
    this.hovercard.pointerOverCard = false;
    // A pointer-opened card must release fully on mouse-out even if a click
    // inside the card (e.g. the title link) left it focused; otherwise it
    // would stay stuck open with nothing left driving the intent.
    if (this.activeTrigger === "pointer") {
      this.hovercard.cardFocusInside = false;
    }
    this.hovercard.scheduleClose();
  };

  private readonly handleFocusIn = (event: Event) => {
    if (this.hovercard.restoringFocus) {
      return;
    }
    const anchor = anchorFromNavigationEvent(event);
    const target = anchor ? resolveLinkReaderTarget(anchor.href, this.readers) : null;
    if (!anchor || !target?.reader.linkReader.previewMethod) {
      return;
    }
    this.activateFromBootstrap(anchor, target, "focus", 0);
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeAnchor.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.focusInside = false;
    this.scheduleIntentClose();
  };

  private readonly handleClick = () => {
    this.close();
  };

  activateFromBootstrap(
    anchor: HTMLAnchorElement,
    target: LinkReaderTarget,
    trigger: "focus" | "pointer",
    delay: number,
  ): void {
    let owner: Element | null = anchor.parentElement;
    while (owner && !(owner instanceof LinkReaderHovercardProvider)) {
      owner = owner.parentElement;
    }
    // Nested providers own their agent scope even when intent bubbles to the app provider.
    if (owner !== this) {
      return;
    }
    if (
      !this.client ||
      !this.readers.includes(target.reader) ||
      !target.reader.linkReader.previewMethod
    ) {
      return;
    }
    this.activate(anchor, target, delay);
    this.activeTrigger = trigger;
    if (trigger === "pointer") {
      this.hovercard.pointerInside = true;
    } else {
      this.hovercard.focusInside = true;
    }
  }

  private activate(anchor: HTMLAnchorElement, target: LinkReaderTarget, delay: number): void {
    const context = this.syncPreviewContext();
    if (anchor === this.activeAnchor && this.activeTarget?.href === target.href) {
      return;
    }
    this.close();
    // Known session details remain useful while remote enrichment is unavailable.
    if (this.cachedPreview(target)?.failed && !this.seedPreview(target)) {
      return;
    }
    this.allowLoading = Boolean(context?.succeeded && !this.cachedPreview(target));
    this.activeAnchor = anchor;
    this.activeTarget = target;
    this.activeAnchorObserver.observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    // Unseeded links stay quiet until this identity has shown useful remote details.
    this.hovercard.scheduleOpen(
      delay,
      () => {
        if (this.syncPreviewContext() !== context) {
          return;
        }
        this.requestStarted = true;
        const seed = this.seedPreview(target);
        if (seed) {
          this.show(anchor, seed, true);
        }
        void this.previewTask.run([target]);
      },
      anchor,
    );
  }

  private show(anchor: HTMLAnchorElement, preview?: LinkPreview, seeded = false): void {
    const existing = this.hovercard.card;
    const card =
      existing ??
      createPortaledHovercard(
        "openclaw-link-reader-hovercard-" + ++nextHovercardId,
        "link-reader-hovercard",
      );
    if (preview) {
      renderPreview(card, preview, seeded);
    } else {
      renderLoading(card);
    }
    if (existing) {
      this.hovercard.position();
    } else {
      // The provider's delegated listeners do not see the portaled card.
      card.addEventListener("pointerleave", this.handleCardPointerLeave);
      card.addEventListener("keydown", this.hovercard.handleCardKeyDown);
      this.hovercard.markTrigger(anchor);
      this.hovercard.mount(anchor, card, "vertical", true, () => render(nothing, card));
    }
    if (preview && !seeded && this.previewContext) {
      this.previewContext.succeeded = true;
    }
  }

  private cachedPreview(target: LinkReaderTarget): CacheEntry | undefined {
    const cached = this.cache.get(linkReaderTargetKey(target));
    return cached && !cached.controller.signal.aborted && cached.expiresAt > Date.now()
      ? cached
      : undefined;
  }

  private loadPreview(
    target: LinkReaderTarget,
    signal: AbortSignal,
  ): Promise<ControlUiLinkReaderPreview> {
    const key = linkReaderTargetKey(target);
    const now = Date.now();
    const cached = this.cachedPreview(target);
    this.cache.delete(key);
    // Dismissal invalidates only that request, even before its rejection settles.
    if (cached) {
      this.cache.set(key, cached);
      return subscribeToSharedRequest(cached, {}, signal);
    }

    const controller = new AbortController();
    const client = this.client;
    const context = this.previewContext;
    const agentId = this.agentId;
    const load = async (): Promise<ControlUiLinkReaderPreview> => {
      const method = target.reader.linkReader.previewMethod;
      if (!client || !method || !this.readers.includes(target.reader)) {
        throw new Error("Link preview requires an available reader");
      }
      const response = await client.request<ControlUiLinkReaderPreview>(
        method,
        {
          ...(agentId ? { agentId } : {}),
          url: target.href,
        },
        { signal: controller.signal },
      );
      return parsePreviewResponse(target, response);
    };

    const entry: CacheEntry = {
      expiresAt: now + SUCCESS_CACHE_MS,
      controller,
      subscribers: new Set(),
      promise: load()
        .then((preview) => {
          if (
            !controller.signal.aborted &&
            this.cache.get(key) === entry &&
            client === this.client &&
            agentId === this.agentId &&
            client &&
            previewContextFor(client, agentId) === context
          ) {
            entry.preview = preview;
            this.syncInlineStates();
          }
          return preview;
        })
        .catch((error: unknown) => {
          // Keep short-lived failures cached so repeatedly crossing a broken or
          // private link does not burn the service rate limit.
          entry.failed = true;
          entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
          this.syncInlineStates();
          throw error;
        }),
    };
    this.cache.set(key, entry);
    this.syncInlineStates();
    while (this.cache.size > CACHE_LIMIT) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.cache.delete(oldestKey);
    }
    // Each visible transcript or popup owns its subscription, not the shared fetch.
    return subscribeToSharedRequest(entry, {}, signal);
  }

  private close(): void {
    this.requestStarted = false;
    this.allowLoading = false;
    this.hovercard.reset();
    this.activeAnchorObserver.disconnect();
    void this.previewTask.run([null]);
    this.activeAnchor = null;
    this.activeTarget = null;
    this.activeTrigger = null;
  }
}
