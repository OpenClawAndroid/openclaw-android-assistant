import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { GatewayAgentRow } from "../api/types.ts";
import { pathForAgentPanel, type RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import {
  commandPaletteCategoryLabel,
  filterCommandPaletteItems,
  type CommandPaletteItem,
} from "./command-palette-catalog-search.ts";
import { COMMAND_PALETTE_DIALOG_STYLE } from "./command-palette-contract.ts";
import { renderCommandPaletteResult } from "./command-palette-result.ts";
import { SESSION_ACTION_PREFIX } from "./command-palette-session-search.ts";
import { icons } from "./icons.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
} from "./panel-toggle-contract.ts";
import "./modal-dialog.ts";

type PaletteItem = CommandPaletteItem;
export type PaletteFilter = "all" | "sessions" | "messages";

type CommandPaletteProps = {
  basePath: string;
  open: boolean;
  query: string;
  activeId: string | null;
  filter: PaletteFilter;
  onFilterChange: (filter: PaletteFilter) => void;
  agents: readonly GatewayAgentRow[];
  agentIdentity?: AgentIdentityCapability;
  defaultAgentId: string;
  sessionItems: readonly PaletteItem[];
  catalogItems: readonly PaletteItem[];
  modelSearchError: string | null;
  sessionSearchPending: boolean;
  catalogSearchPending: boolean;
  sessionSearchFailed: boolean;
  sessionSearchPartial: boolean;
  sessionSearchIncomplete: boolean;
  archivedTranscriptsExcluded: number;
  onToggle: () => void;
  onQueryChange: (query: string) => void;
  onActiveIdChange: (id: string) => void;
  onNavigate?: ApplicationContext<RouteId>["navigate"];
  onSelectSession?: (sessionKey: string) => void;
  onSlashCommand?: (command: string) => void;
  desktopAvailable: boolean;
  custodianAvailable: boolean;
  onInputRef: (element: Element | undefined) => void;
};

function groupItems(items: PaletteItem[]): Array<[string, PaletteItem[]]> {
  const map = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const group = map.get(item.category) ?? [];
    group.push(item);
    map.set(item.category, group);
  }
  return [...map.entries()];
}

const paletteDialogLabelId = "cmd-palette-label";
const paletteInputId = "cmd-palette-input";
const paletteListboxId = "cmd-palette-listbox";

function selectItem(item: PaletteItem, props: CommandPaletteProps) {
  if (item.action.startsWith("nav:")) {
    // SAFETY: navigation actions are built from typed catalog RouteIds or the closed built-in list.
    const routeId = item.action.slice(4) as RouteId;
    if (item.agentId) {
      props.onNavigate?.(routeId, {
        pathname: pathForAgentPanel(item.agentId, null, props.basePath),
      });
    } else if (item.search || item.hash) {
      props.onNavigate?.(routeId, { search: item.search, hash: item.hash });
    } else {
      props.onNavigate?.(routeId);
    }
  } else if (item.action.startsWith(SESSION_ACTION_PREFIX)) {
    props.onSelectSession?.(item.action.slice(SESSION_ACTION_PREFIX.length));
  } else if (item.action === "panel:desktop") {
    window.dispatchEvent(new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
  } else if (item.action === "panel:custodian") {
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
  } else {
    props.onSlashCommand?.(item.action);
  }
  props.onToggle();
}

function closePalette(props: CommandPaletteProps) {
  props.onToggle();
}

function scrollActiveIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".cmd-palette__item--active");
    el?.scrollIntoView({ block: "nearest" });
  });
}

function handleKeydown(
  e: KeyboardEvent,
  props: CommandPaletteProps,
  items: PaletteItem[],
  activeIndex: number,
) {
  if (e.isComposing || e.keyCode === 229) {
    // Keep composition keys out of document shortcuts and the modal's Escape handler.
    e.stopPropagation();
    return;
  }
  // Footer disclosures and filter buttons keep native Enter/arrow-key behavior.
  if (e.key !== "Escape" && !(e.target instanceof HTMLInputElement)) {
    return;
  }
  if (items.length === 0 && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
    return;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      props.onActiveIdChange(items[(activeIndex + 1) % items.length]!.id);
      scrollActiveIntoView();
      break;
    case "ArrowUp":
      e.preventDefault();
      props.onActiveIdChange(items[(activeIndex - 1 + items.length) % items.length]!.id);
      scrollActiveIntoView();
      break;
    case "Enter":
      e.preventDefault();
      {
        const item = items[activeIndex];
        if (item) {
          selectItem(item, props);
        }
      }
      break;
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      closePalette(props);
      break;
  }
}

function getOptionId(index: number): string {
  return `cmd-palette-option-${index}`;
}

export function focusInput(el: Element | undefined) {
  if (el instanceof HTMLInputElement) {
    requestAnimationFrame(() => {
      if (el.isConnected) {
        el.focus();
      }
    });
  }
}

export function renderCommandPalette(props: CommandPaletteProps) {
  if (!props.open) {
    return nothing;
  }
  const matches = filterCommandPaletteItems({
    ...props,
    includeSlashCommands: Boolean(props.onSlashCommand),
  });
  const matchesFilter = (item: PaletteItem, filter: PaletteFilter) =>
    filter === "all" || item.category === (filter === "sessions" ? "chats" : "messages");
  const grouped = groupItems(matches.filter((item) => matchesFilter(item, props.filter)));
  const notices = [
    props.sessionSearchFailed
      ? t("palette.searchFailed")
      : props.sessionSearchIncomplete
        ? t("palette.searchIncomplete")
        : props.sessionSearchPartial
          ? t("palette.searchPartial")
          : null,
    props.archivedTranscriptsExcluded > 0
      ? t("sessionsView.transcriptSearchArchivedExcluded", {
          count: String(props.archivedTranscriptsExcluded),
        })
      : null,
  ].filter((notice): notice is string => Boolean(notice));
  const items = grouped.flatMap(([, entries]) => entries);
  // Preserve explicit selection through transient result changes, but only
  // highlight and execute current rows; an absent choice selects the first row.
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === props.activeId),
  );
  const activeOptionId = items[activeIndex] ? getOptionId(activeIndex) : nothing;
  const paletteLabel = t("palette.placeholder");

  return html`
    <openclaw-modal-dialog
      class="cmd-palette-overlay palette"
      label=${paletteLabel}
      style=${COMMAND_PALETTE_DIALOG_STYLE}
      @modal-cancel=${() => closePalette(props)}
    >
      <div
        class="cmd-palette"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => handleKeydown(e, props, items, activeIndex)}
      >
        <label id=${paletteDialogLabelId} class="cmd-palette__label" for=${paletteInputId}
          >${paletteLabel}</label
        >
        <div class="cmd-palette__searchbar">
          <span class="nav-item__icon" aria-hidden="true">${icons.search}</span>
          <input
            ${ref(props.onInputRef)}
            autofocus
            id=${paletteInputId}
            class="cmd-palette__input"
            role="combobox"
            aria-autocomplete="list"
            aria-controls=${paletteListboxId}
            aria-activedescendant=${activeOptionId}
            aria-expanded="true"
            placeholder=${paletteLabel}
            .value=${props.query}
            @input=${(e: Event) => {
              if (e.currentTarget instanceof HTMLInputElement) {
                props.onQueryChange(e.currentTarget.value);
              }
            }}
          />
          ${
            props.query
              ? html`<button
                  class="cmd-palette__clear"
                  type="button"
                  aria-label=${t("palette.clearSearch")}
                  @click=${() => {
                    props.onQueryChange("");
                    focusInput(document.getElementById(paletteInputId) ?? undefined);
                  }}
                >
                  ${icons.x}
                </button>`
              : nothing
          }
          <kbd aria-hidden="true">${t("palette.escapeKey")}</kbd>
        </div>
        ${
          props.query.trim() && props.onSelectSession
            ? html`<div
                class="cmd-palette__filters"
                role="group"
                aria-label=${t("palette.filterLabel")}
              >
                ${(["all", "sessions", "messages"] as const).map((filter) => html`<button type="button" class="cmd-palette__filter" aria-pressed=${props.filter === filter ? "true" : "false"} @click=${() => props.onFilterChange(filter)}>${t(`palette.filters.${filter}`)}<span>${matches.filter((item) => matchesFilter(item, filter)).length}</span></button>`)}
              </div>`
            : nothing
        }
        ${
          props.sessionSearchPending || props.catalogSearchPending
            ? html`<div class="cmd-palette__empty" role="status">
                ${t(props.sessionSearchPending ? "palette.searchingSessions" : "palette.searchingCommands")}
              </div>`
            : nothing
        }
        <div
          id=${paletteListboxId}
          class="cmd-palette__results"
          role="listbox"
          aria-busy=${props.sessionSearchPending || props.catalogSearchPending ? "true" : "false"}
        >
          ${
            grouped.length === 0 &&
            !props.sessionSearchFailed &&
            !props.sessionSearchPending &&
            !props.catalogSearchPending
              ? html`<div class="cmd-palette__empty">
                  <span class="nav-item__icon" style="opacity:0.3;width:20px;height:20px"
                    >${icons.search}</span
                  >
                  <span>${t("palette.noResults")}</span>
                </div>`
              : grouped.map(
                  ([category, groupedItems]) => html`
                    <div class="cmd-palette__group-label">
                      ${commandPaletteCategoryLabel(category)}
                      <span class="cmd-palette__group-count">${groupedItems.length}</span>
                    </div>
                    ${groupedItems.map((item) => {
                      const globalIndex = items.indexOf(item);
                      const isActive = globalIndex === activeIndex;
                      const agentId = item.session
                        ? resolveUiSessionRowAgentId(item.session, props.defaultAgentId)
                        : item.agentId;
                      const agent = agentId
                        ? (props.agents.find((row) => row.id === agentId) ?? { id: agentId })
                        : undefined;
                      return html`
                        <div
                          id=${getOptionId(globalIndex)}
                          class="cmd-palette__item ${item.session ? "cmd-palette__item--session" : ""} ${isActive ? "cmd-palette__item--active" : ""}"
                          role="option"
                          aria-selected=${isActive ? "true" : "false"}
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            selectItem(item, props);
                          }}
                          @mouseenter=${() => props.onActiveIdChange(item.id)}
                        >
                          ${renderCommandPaletteResult(item, props.query, agent, props.agentIdentity?.get(agentId))}
                        </div>
                      `;
                    })}
                  `,
                )
          }
        </div>
        ${props.modelSearchError ? html`<div class="cmd-palette__source-error" role="status">${props.modelSearchError}</div>` : nothing}
        ${
          notices.length
            ? html`<details
                class="cmd-palette__notices"
                ?open=${props.sessionSearchFailed || items.length === 0}
              >
                <summary>
                  ${icons.info}<span
                    >${t("palette.searchNotices", { count: String(notices.length) })}</span
                  >
                </summary>
                <div role="status">${notices.map((notice) => html`<p>${notice}</p>`)}</div>
              </details>`
            : nothing
        }
        <div class="cmd-palette__footer">
          <span><kbd>↑↓</kbd> ${t("palette.footer.navigate")}</span>
          <span><kbd>↵</kbd> ${t("palette.footer.select")}</span>
          <span><kbd>${t("palette.escapeKey")}</kbd> ${t("palette.footer.close")}</span>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
