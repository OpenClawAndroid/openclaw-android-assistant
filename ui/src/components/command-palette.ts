// Control UI component renders the command palette.
import { consume } from "@lit/context";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { property, state } from "lit/decorators.js";
import type { RouteId } from "../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { filterVisibleSessionRows, getVisibleSessionRows } from "../lib/sessions/index.ts";
import {
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../lib/sessions/session-key.ts";
import { searchVisibleSessionTranscripts } from "../lib/sessions/transcript-search.ts";
import { GatewayPageController } from "../lit/gateway-page-controller.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  getStaticCommandPaletteCatalogItems,
  loadCommandPaletteCatalogItems,
  toCommandPaletteItems,
  type CommandPaletteItem,
} from "./command-palette-catalog-search.ts";
import { isCommandPaletteShortcut } from "./command-palette-contract.ts";
import {
  buildCommandPaletteSessionItems,
  SESSION_SEARCH_LIMIT,
} from "./command-palette-session-search.ts";
import { focusInput, renderCommandPalette, type PaletteFilter } from "./command-palette-view.ts";

type PaletteItem = CommandPaletteItem;

const SESSION_SEARCH_DEBOUNCE_MS = 50;
const SESSION_SEARCH_MIN_CHARS = 2;
const SESSION_SEARCH_MAX_PAGES = 4;
const SESSION_SEARCH_PAGE_SIZE = 50;
const SESSION_TRANSCRIPT_MAX_LIST_PAGES = 4;
const SESSION_TRANSCRIPT_MAX_REQUESTS = 4;
const SESSION_TRANSCRIPT_MAX_SESSION_KEYS = 200;
const CATALOG_CACHE_TTL_MS = 30_000;

export class CommandPalette extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) onNavigate?: ApplicationContext<RouteId>["navigate"];
  @property({ attribute: false }) onSelectSession?: (sessionKey: string) => void;
  @property({ attribute: false }) onSlashCommand?: (command: string) => void;
  @property({ attribute: false }) desktopAvailable = false;
  @property({ attribute: false }) custodianAvailable = false;
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext<RouteId>;
  @state() private open = false;
  @state() private query = "";
  @state() private activeId: string | null = null;
  @state() private filter: PaletteFilter = "all";
  @state() private sessionItems: readonly PaletteItem[] = [];
  @state() private catalogItems: readonly PaletteItem[] = [];
  @state() private modelSearchError: string | null = null;
  @state() private sessionSearchPending = false;
  @state() private sessionSearchFailed = false;
  @state() private sessionSearchPartial = false;
  @state() private archivedTranscriptsExcluded = 0;
  @state() private sessionSearchIncomplete = false;

  private readonly subscriptions = new SubscriptionsController(this);
  @state() private sessionSearchTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private sessionSearchId = 0;
  @state() private catalogLoad?: {
    client: NonNullable<ApplicationContext<RouteId>["gateway"]["snapshot"]["client"]>;
    agentId: string;
    promise: Promise<void>;
    loadedAt?: number;
  };
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.clearSessionSearch();
      this.clearCatalogSearch();
    },
    ensureInitialData: () => this.scheduleSessionSearch(this.query),
  });

  constructor() {
    super();
    this.subscriptions.watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    );
    this.subscriptions.watch(
      () => this.context?.agentIdentity,
      (identity, notify) => identity.subscribe(notify),
    );
    this.subscriptions.effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (
            this.context?.gateway === gateway &&
            (event.event === "config.changed" || event.event === "chat.metadata.changed")
          ) {
            if (this.open) {
              void this.ensureCatalogItems(true);
            } else {
              this.clearCatalogSearch();
            }
          }
        }),
    );
    this.subscriptions.watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => {
        this.clearCatalogSearch();
        this.scheduleSessionSearch(this.query);
      },
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleGlobalKeydown);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleGlobalKeydown);
    this.open = false;
    this.query = "";
    this.activeId = null;
    this.clearSessionSearch();
    this.clearCatalogSearch();
    super.disconnectedCallback();
  }

  openPalette() {
    this.open = true;
    this.filter = "all";
    this.query = "";
    this.activeId = null;
    this.clearSessionSearch();
  }

  get isOpen(): boolean {
    return this.open;
  }

  readonly togglePalette = () => {
    if (this.open) {
      this.open = false;
      this.clearSessionSearch();
      return;
    }
    this.openPalette();
  };

  private readonly handleInputRef = (element: Element | undefined) => {
    if (this.open) {
      focusInput(element);
    }
  };

  private clearSessionSearch() {
    if (this.sessionSearchTimer !== null) {
      globalThis.clearTimeout(this.sessionSearchTimer);
      this.sessionSearchTimer = null;
    }
    this.sessionSearchId += 1;
    this.sessionItems = [];
    this.sessionSearchPending = false;
    this.sessionSearchFailed = false;
    this.sessionSearchPartial = false;
    this.archivedTranscriptsExcluded = 0;
    this.sessionSearchIncomplete = false;
  }

  private clearCatalogSearch() {
    this.catalogLoad = undefined;
    this.catalogItems = [];
    this.modelSearchError = null;
  }

  private ensureCatalogItems(force = false): Promise<void> {
    const context = this.context;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    if (!context || !this.gateway.connected || !gateway || !client) {
      return Promise.resolve();
    }
    const agentId =
      context.agentSelection.state.selectedId ?? resolveUiSelectedGlobalAgentId(gateway.snapshot);
    const current = this.catalogLoad;
    if (
      !force &&
      current?.client === client &&
      current.agentId === agentId &&
      (current.loadedAt === undefined || Date.now() - current.loadedAt < CATALOG_CACHE_TTL_MS)
    ) {
      return current.promise;
    }
    const snapshot = gateway.snapshot;
    const previousModels =
      current?.client === client && current.agentId === agentId
        ? this.catalogItems.filter((item) => item.category === "models")
        : [];
    const promise = loadCommandPaletteCatalogItems({
      client,
      agentId,
      agents: () => context.agents?.ensureList?.() ?? Promise.resolve(null),
      methodAvailable: (method) => Boolean(isGatewayMethodAdvertised(snapshot, method)),
    }).then(({ items, modelRequestFailed, modelSearchError }) => {
      if (
        this.catalogLoad?.promise === promise &&
        this.context?.gateway === gateway &&
        this.context?.agentSelection === context.agentSelection &&
        gateway.snapshot.client === client
      ) {
        this.catalogItems = [
          ...toCommandPaletteItems(items),
          ...(modelRequestFailed ? previousModels : []),
        ];
        this.modelSearchError = modelSearchError;
        this.catalogLoad = { ...this.catalogLoad, loadedAt: modelRequestFailed ? 0 : Date.now() };
      }
    });
    this.catalogLoad = { client, agentId, promise };
    return promise;
  }

  private scheduleSessionSearch(query: string) {
    // Invalidate the previous query immediately so late responses cannot
    // repopulate selectable stale rows during the debounce window.
    this.clearSessionSearch();
    const search = normalizeOptionalString(query);
    if (!this.open || !search || search.length < SESSION_SEARCH_MIN_CHARS) {
      return;
    }
    this.sessionSearchPending = Boolean(
      this.onSelectSession && this.context?.sessions && this.gateway.connected,
    );
    this.sessionSearchTimer = globalThis.setTimeout(() => {
      this.sessionSearchTimer = null;
      void this.ensureCatalogItems();
      if (this.onSelectSession) {
        void this.searchSessions(search);
      } else {
        this.sessionSearchPending = false;
      }
    }, SESSION_SEARCH_DEBOUNCE_MS);
  }

  private async searchSessions(search: string) {
    const context = this.context;
    const sessions = context?.sessions;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    if (!sessions || gateway?.snapshot.phase !== "connected" || !client) {
      this.sessionSearchPending = false;
      return;
    }
    const requestId = ++this.sessionSearchId;
    const isCurrent = () =>
      requestId === this.sessionSearchId &&
      this.open &&
      this.context?.sessions === sessions &&
      this.context?.gateway === gateway &&
      this.context?.agentSelection === context?.agentSelection &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected";
    const transcriptSearchAvailable = isGatewayMethodAdvertised(
      gateway.snapshot,
      "sessions.search",
    );
    const defaultAgentId =
      context?.agentSelection.state.selectedId ?? resolveUiSelectedGlobalAgentId(gateway.snapshot);
    const transcriptSearch = transcriptSearchAvailable
      ? searchVisibleSessionTranscripts({
          client,
          query: search,
          result: undefined,
          listSessions: sessions.list,
          listOptions: {
            includeGlobal: false,
            includeUnknown: false,
            configuredAgentsOnly: true,
          },
          resolveAgentId: (sessionKey) =>
            parseAgentSessionKey(sessionKey)?.agentId ?? defaultAgentId,
          isCurrent,
          maxListPages: SESSION_TRANSCRIPT_MAX_LIST_PAGES,
          maxSearchRequests: SESSION_TRANSCRIPT_MAX_REQUESTS,
          maxSessionKeys: SESSION_TRANSCRIPT_MAX_SESSION_KEYS,
          mapPageRows: (rows) =>
            filterVisibleSessionRows(rows, {
              agentId: "",
              defaultAgentId,
              filterByAgent: false,
            }),
        })
          .then((result) => ({ error: false as const, result }))
          .catch(() => ({ error: true as const, result: null }))
      : Promise.resolve(null);
    const visibleRows: ReturnType<typeof getVisibleSessionRows> = [];
    const visibleKeys = new Set<string>();
    const seenOffsets = new Set<number>([0]);
    let pagesLoaded = 0;
    let offset: number | undefined;
    try {
      while (visibleRows.length < SESSION_SEARCH_LIMIT && pagesLoaded < SESSION_SEARCH_MAX_PAGES) {
        const result = await sessions.list({
          search,
          limit: SESSION_SEARCH_PAGE_SIZE,
          ...(offset === undefined ? {} : { offset }),
          includeGlobal: false,
          includeUnknown: false,
        });
        pagesLoaded += 1;
        if (!isCurrent() || !result) {
          return;
        }
        const pageRows = getVisibleSessionRows(result, {
          agentId: "",
          defaultAgentId,
          filterByAgent: false,
        });
        for (const row of pageRows) {
          if (!visibleKeys.has(row.key)) {
            visibleKeys.add(row.key);
            visibleRows.push(row);
          }
        }
        if (visibleRows.length >= SESSION_SEARCH_LIMIT || !result.hasMore) {
          break;
        }
        const nextOffset =
          typeof result.nextOffset === "number" && Number.isFinite(result.nextOffset)
            ? Math.max(0, Math.floor(result.nextOffset))
            : result.sessions.length > 0
              ? (offset ?? 0) + result.sessions.length
              : null;
        // Malformed pagination must not turn a palette query into an RPC loop.
        if (nextOffset === null || seenOffsets.has(nextOffset)) {
          break;
        }
        seenOffsets.add(nextOffset);
        offset = nextOffset;
      }
      const transcriptOutcome = await transcriptSearch;
      if (!isCurrent()) {
        return;
      }
      const transcriptResult = transcriptOutcome?.result ?? null;
      this.sessionSearchPartial = transcriptOutcome?.error === true;
      this.archivedTranscriptsExcluded = transcriptResult?.archivedTranscriptsExcluded ?? 0;
      this.sessionSearchIncomplete =
        transcriptOutcome?.error !== true &&
        (transcriptResult?.indexing === true || transcriptResult?.truncated === true);
      this.sessionItems = buildCommandPaletteSessionItems({
        visibleRows,
        visibleKeys,
        transcriptResult,
        search,
      });
    } catch {
      // Session search is best-effort; navigation commands stay usable. But a
      // failed search must not render as "No results" — that reads as a
      // successful search with zero matches and hides gateway-side failures
      // (e.g. a store needing doctor migration) from the operator.
      if (isCurrent()) {
        this.sessionSearchFailed = true;
      }
    } finally {
      if (isCurrent()) {
        this.sessionSearchPending = false;
      }
    }
  }

  private readonly handleGlobalKeydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (!event.defaultPrevented && event.key === "Escape" && this.open) {
      event.preventDefault();
      this.togglePalette();
      return;
    }
    if (isCommandPaletteShortcut(event)) {
      event.preventDefault();
      this.togglePalette();
    }
  };

  override render() {
    return renderCommandPalette({
      basePath: this.context?.basePath ?? "",
      open: this.open,
      query: this.query,
      activeId: this.activeId,
      filter: this.filter,
      onFilterChange: (filter) => {
        this.filter = filter;
        this.activeId = null;
      },
      agents: this.context?.agents.state.agentsList?.agents ?? [],
      agentIdentity: this.context?.agentIdentity,
      defaultAgentId:
        this.context?.agentSelection.state.selectedId ??
        resolveUiSelectedGlobalAgentId(this.context?.gateway.snapshot ?? {}),
      sessionItems: this.sessionItems,
      modelSearchError: this.modelSearchError,
      catalogItems: [
        ...toCommandPaletteItems(
          getStaticCommandPaletteCatalogItems(
            hasOperatorAdminAccess(this.context?.gateway.snapshot.hello?.auth ?? null),
            this.context?.nativeDeviceSettings,
          ),
        ),
        ...this.catalogItems,
      ],
      sessionSearchPending: this.sessionSearchPending,
      catalogSearchPending: Boolean(
        normalizeOptionalString(this.query) &&
        ((this.sessionSearchTimer !== null && this.gateway.connected) ||
          (this.catalogLoad && this.catalogLoad.loadedAt === undefined)),
      ),
      sessionSearchFailed: this.sessionSearchFailed,
      sessionSearchPartial: this.sessionSearchPartial,
      sessionSearchIncomplete: this.sessionSearchIncomplete,
      archivedTranscriptsExcluded: this.archivedTranscriptsExcluded,
      desktopAvailable: this.desktopAvailable,
      custodianAvailable: this.custodianAvailable,
      onToggle: this.togglePalette,
      onQueryChange: (query) => {
        this.query = query;
        if (!query.trim()) {
          this.filter = "all";
        }
        this.activeId = null;
        this.scheduleSessionSearch(query);
      },
      onActiveIdChange: (id) => {
        this.activeId = id;
      },
      onNavigate: this.onNavigate,
      onSelectSession: this.onSelectSession,
      onSlashCommand: this.onSlashCommand,
      onInputRef: this.handleInputRef,
    });
  }
}

if (!customElements.get("openclaw-command-palette")) {
  customElements.define("openclaw-command-palette", CommandPalette);
}
