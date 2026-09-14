import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state as litState } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  isOptionalElementDefined,
  LazyCustomElementRequestController,
  type OptionalCustomElement,
} from "../../app/lazy-custom-element.ts";
import {
  clearLazyShellAction,
  persistLazyShellAction,
  readLazyShellAction,
} from "../../app/lazy-shell-action.ts";
import { retryStaleChunkReloadWhenReachable } from "../../app/stale-chunk-reload.ts";
import { toolIcons } from "../../components/icons-tools.ts";
import { renderLazyViewError } from "../../components/lazy-view-error.ts";
import { DEBUG_OVERLAY_REQUEST_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../../styles/debug.css";
import { renderDebugOverlayLoading } from "./debug-overlay-loading.ts";

const DEBUG_OVERLAY_CONTENT = {
  tagName: "openclaw-debug-overlay-content",
  get label() {
    return t("debug.overlay.title");
  },
  loadModule: () => import("./debug-overlay-content.ts"),
} satisfies OptionalCustomElement;

export class DebugOverlay extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @litState() private mode: "closed" | "expanded" | "minimized" = "closed";

  private contentKey = 0;
  private recoveryActionPending = false;
  private readonly content = new LazyCustomElementRequestController(this, undefined, (canReload) =>
    retryStaleChunkReloadWhenReachable({
      canReload: () => {
        if (!canReload()) {
          return false;
        }
        this.recoveryActionPending = persistLazyShellAction({
          eventType: DEBUG_OVERLAY_REQUEST_EVENT,
        });
        return this.recoveryActionPending;
      },
    }),
  );

  override disconnectedCallback(): void {
    this.close();
    super.disconnectedCallback();
  }

  toggle(): void {
    if (this.mode === "minimized") {
      this.mode = "expanded";
      return;
    }
    if (this.mode === "expanded") {
      this.close();
      return;
    }
    this.mode = "expanded";
    this.contentKey += 1;
    document.addEventListener("keydown", this.handleKeydown, true);
    if (!isOptionalElementDefined(DEBUG_OVERLAY_CONTENT)) {
      // Automatic stale-chunk reloads can happen before the manual Retry path.
      this.recoveryActionPending = persistLazyShellAction({
        eventType: DEBUG_OVERLAY_REQUEST_EVENT,
      });
      this.content.request(DEBUG_OVERLAY_CONTENT, () => this.clearRecoveryAction());
    }
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }
    if (this.mode === "minimized" && !event.composedPath().includes(this)) {
      return;
    }
    event.preventDefault();
    this.close();
  };

  private readonly close = (): void => {
    this.mode = "closed";
    document.removeEventListener("keydown", this.handleKeydown, true);
    this.content.close();
    this.clearRecoveryAction();
  };

  private clearRecoveryAction(): void {
    if (!this.recoveryActionPending) {
      return;
    }
    if (readLazyShellAction()?.eventType === DEBUG_OVERLAY_REQUEST_EVENT) {
      clearLazyShellAction();
    }
    this.recoveryActionPending = false;
  }

  private renderContent() {
    const loadState = this.content.visibleState;
    if (loadState?.status === "error") {
      return renderLazyViewError({
        actionLabel: t("common.retry"),
        error: loadState.error,
        stale: loadState.stale,
        subtitle: loadState.element.label,
        onRetry: () => this.content.retry(),
      });
    }
    if (!isOptionalElementDefined(DEBUG_OVERLAY_CONTENT)) {
      return this.mode === "minimized"
        ? html`<div class="debug-overlay__compact-loading" role="status">
            ${t("common.loading")}
          </div>`
        : renderDebugOverlayLoading();
    }
    return keyed(
      this.contentKey,
      html`<openclaw-debug-overlay-content
        .context=${this.context}
        .minimized=${this.mode === "minimized"}
      ></openclaw-debug-overlay-content>`,
    );
  }

  override render() {
    if (this.mode === "closed") {
      return nothing;
    }
    return html`
      <aside
        class="debug-overlay ${this.mode === "minimized" ? "debug-overlay--minimized" : ""}"
        aria-label=${t("debug.overlay.title")}
      >
        <header class="debug-overlay__header">
          <div>
            ${this.mode === "minimized" ? nothing : html`<div class="debug-overlay__eyebrow">${t("debug.overlay.eyebrow")}</div>`}
            <h2>${t("debug.overlay.title")}</h2>
          </div>
          <div class="debug-overlay__controls">
            <button
              type="button"
              class="debug-overlay__control"
              aria-label=${t(this.mode === "minimized" ? "debug.overlay.expand" : "debug.overlay.minimize")}
              title=${t(this.mode === "minimized" ? "debug.overlay.expand" : "debug.overlay.minimize")}
              @click=${() => {
                this.mode = this.mode === "minimized" ? "expanded" : "minimized";
              }}
            >
              ${this.mode === "minimized" ? toolIcons.maximize : toolIcons.minimize}
            </button>
            <button
              type="button"
              class="debug-overlay__control debug-overlay__close"
              aria-label=${t("common.close")}
              @click=${this.close}
            >
              ×
            </button>
          </div>
        </header>
        <div class="debug-overlay__body">${this.renderContent()}</div>
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-debug-overlay")) {
  customElements.define("openclaw-debug-overlay", DebugOverlay);
}
