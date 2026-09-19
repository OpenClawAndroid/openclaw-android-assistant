import {
  clearSessionPanelToggle,
  panelToggleSessionKey,
  takeSessionPanelToggle,
  type SessionPanelToggleSlot,
} from "../../components/session-panel-toggle-buffer.ts";
import {
  terminalIntentQueue,
  terminalToggleIntent,
} from "../../components/terminal/terminal-pending-actions.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { closeSlot, openSlot, setSidebarDock } from "./sidebar-layout.ts";

type PanelTagName =
  | "openclaw-browser-panel"
  | "openclaw-desktop-panel"
  | "openclaw-portals-page"
  | "openclaw-terminal-panel";

interface ActivePanelOwner {
  renderRoot: ParentNode;
  state: ChatPageHost;
  updateComplete: Promise<unknown>;
}

interface SessionPanelToggleControllerOptions {
  current: () => ActivePanelOwner | null;
  pending: Map<SessionPanelToggleSlot, Event>;
  requestUpdate: () => void;
  updateSidebarLayout: (layout: ChatPageHost["sidebarLayout"]) => void;
}

/** Owns shell-to-pane panel intent handoff for the active chat presentation. */
export class ChatPaneSessionPanelToggleController {
  constructor(private readonly options: SessionPanelToggleControllerOptions) {}

  handle(slot: SessionPanelToggleSlot, tagName: PanelTagName, event: Event): boolean {
    const owner = this.options.current();
    if (!owner) {
      return false;
    }
    const requestedSession = panelToggleSessionKey(event);
    if (requestedSession && !areUiSessionKeysEquivalent(requestedSession, owner.state.sessionKey)) {
      return false;
    }
    clearSessionPanelToggle(slot, event);
    const ownerSessionKey = owner.state.sessionKey;
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (detail?.open === false) {
      this.options.pending.delete(slot);
      this.options.updateSidebarLayout(closeSlot(owner.state.sidebarLayout, slot));
      return true;
    }
    let layout = openSlot(owner.state.sidebarLayout, slot);
    if (detail?.dock === "right" || detail?.dock === "bottom") {
      layout = setSidebarDock(layout, detail.dock);
    }
    const panel = layout.columns
      .flatMap((column) => column.panels)
      .find((entry) => entry.slot === slot);
    if (
      panel &&
      slot === "desktop" &&
      requestedSession &&
      typeof detail?.environmentId === "string"
    ) {
      panel.environmentId = detail.environmentId;
    }
    if (panel && slot === "portal" && typeof detail?.portalId === "string") {
      panel.portalId = detail.portalId;
      delete panel.environmentId;
    } else if (panel && slot === "portal" && typeof detail?.environmentId === "string") {
      panel.environmentId = detail.environmentId;
      delete panel.portalId;
    }
    if (slot === "terminal") {
      const intent = terminalToggleIntent(event, resolveChatAgentId(owner.state));
      const embeddedTerminal = owner.renderRoot.querySelector("openclaw-terminal-panel[embedded]");
      const terminalConstructor = customElements.get("openclaw-terminal-panel");
      const embeddedTerminalMounted =
        embeddedTerminal !== null &&
        terminalConstructor !== undefined &&
        embeddedTerminal instanceof terminalConstructor;
      if (intent) {
        void terminalIntentQueue.queue(intent, {
          deferUntilHostChange: !embeddedTerminalMounted,
        });
      }
      this.options.updateSidebarLayout(layout);
      return true;
    }
    this.options.pending.set(slot, event);
    this.options.updateSidebarLayout(layout);
    void Promise.all([
      customElements.whenDefined("openclaw-chat-sidebar-region"),
      customElements.whenDefined(tagName),
    ])
      .then(async () => {
        this.options.requestUpdate();
        await owner.updateComplete;
        if (
          this.options.pending.get(slot) !== event ||
          this.options.current()?.state !== owner.state ||
          owner.state.sessionKey !== ownerSessionKey
        ) {
          return;
        }
        const region = owner.renderRoot.querySelector<
          HTMLElementTagNameMap["openclaw-chat-sidebar-region"]
        >("openclaw-chat-sidebar-region");
        await region?.updateComplete;
        if (
          this.options.pending.get(slot) !== event ||
          this.options.current()?.state !== owner.state ||
          owner.state.sessionKey !== ownerSessionKey
        ) {
          return;
        }
        region?.deliverPanelEvent(slot, event);
      })
      .finally(() => {
        if (this.options.pending.get(slot) === event) {
          this.options.pending.delete(slot);
          this.options.requestUpdate();
        }
      });
    return true;
  }

  flush(): void {
    const owner = this.options.current();
    if (!owner) {
      return;
    }
    for (const [slot, tagName] of [
      ["terminal", "openclaw-terminal-panel"],
      ["browser", "openclaw-browser-panel"],
      ["desktop", "openclaw-desktop-panel"],
      ["portal", "openclaw-portals-page"],
    ] as const) {
      const event = takeSessionPanelToggle(slot, owner.state.sessionKey);
      if (event) {
        this.handle(slot, tagName, event);
      }
    }
  }
}
