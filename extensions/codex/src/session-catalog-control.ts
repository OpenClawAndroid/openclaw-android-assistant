import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveCodexAppServerLocalHomeDir } from "./app-server/auth-start-options.js";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import type { CodexManagedThreadStore } from "./app-server/managed-thread-store.js";
import { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import { assertCodexThreadForkParams } from "./app-server/protocol.js";
import type {
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  CodexThread,
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadListParams,
  CodexThreadListResponse,
  CodexThreadItemsListParams,
  CodexThreadItemsListResponse,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResponse,
} from "./app-server/protocol.js";
import type { CodexControlRequestObservation } from "./app-server/request-observation.js";
import { withTimeout } from "./app-server/timeout.js";
import { CodexCatalogLoadingError } from "./session-catalog-availability.js";
import {
  startCodexCatalogPageDiagnostics,
  startCodexCatalogControlRequestDiagnostics,
  type CodexCatalogPageDiagnostics,
} from "./session-catalog-diagnostics.js";
import { requireEligibleCodexThread } from "./session-catalog-eligibility.js";
import { codexCatalogResidentHomeKey } from "./session-catalog-events.js";
import { createCodexCatalogHomeResolver, type CodexCatalogHome } from "./session-catalog-homes.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import type { CodexCatalogIndex } from "./session-catalog-index.js";
import {
  currentCodexCatalogListRequest,
  withCodexCatalogListRequest,
  type CodexCatalogListRequest,
} from "./session-catalog-list-request.js";
import type { CodexCatalogPreviewCache } from "./session-catalog-native-projection.js";
import { readControlCursor, readPageParams } from "./session-catalog-parsing.js";
import { CodexCatalogSourceBackoff } from "./session-catalog-source-backoff.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

type CodexCatalogRequestOptions = {
  agentDir: string | undefined;
  config: OpenClawConfig | undefined;
  startOptions: CodexAppServerStartOptions;
};

type CodexCatalogControlSource = Pick<
  CodexCatalogHome,
  "appServer" | "localSessionsRoot" | "sourceHomeId" | "assertCurrent"
> & { agentDir?: string };

type CodexSessionCatalogRequestSnapshot = {
  beginList: (request?: CodexCatalogListRequest) => ReturnType<CodexCatalogSourceBackoff["begin"]>;
  index: () => Promise<CodexCatalogIndex>;
  requestTimeoutMs: number;
  listThreads(
    params: CodexThreadListParams,
    timeoutMs: number,
    observation?: CodexControlRequestObservation,
  ): Promise<CodexThreadListResponse>;
  listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
  listThreadItems(params: CodexThreadItemsListParams): Promise<CodexThreadItemsListResponse>;
  forkThread(
    params: CodexThreadForkParams,
    assertCurrent?: () => void,
  ): Promise<CodexThreadForkResponse>;
  readThread(threadId: string, includeTurns: boolean, timeoutMs?: number): Promise<CodexThread>;
  archiveThread(threadId: string, assertCurrent?: () => void): Promise<void>;
};

type CodexCatalogRequestMethod =
  | typeof CODEX_CONTROL_METHODS.archiveThread
  | typeof CODEX_CONTROL_METHODS.forkThread
  | typeof CODEX_CONTROL_METHODS.listThreads
  | typeof CODEX_CONTROL_METHODS.listThreadTurns
  | typeof CODEX_CONTROL_METHODS.listThreadItems
  | typeof CODEX_CONTROL_METHODS.readThread;

type CodexCatalogRequest = <M extends CodexCatalogRequestMethod>(
  method: M,
  requestParams: CodexAppServerRequestParams<M>,
  timeoutMs?: number,
  assertCurrent?: () => void,
  observation?: CodexControlRequestObservation,
) => Promise<CodexAppServerRequestResult<M>>;

function createCodexCatalogRequestSnapshot(
  requestTimeoutMs: number,
  request: CodexCatalogRequest,
  index: () => Promise<CodexCatalogIndex>,
  beginList: CodexSessionCatalogRequestSnapshot["beginList"],
  catalogRead = false,
): CodexSessionCatalogRequestSnapshot {
  const read = <M extends CodexCatalogRequestMethod>(
    method: M,
    params: CodexAppServerRequestParams<M>,
    timeoutMs?: number,
    observation?: CodexControlRequestObservation,
  ): Promise<CodexAppServerRequestResult<M>> => {
    // Index reads are charged by NativePages; hydration never borrows a caller's scope.
    const scope = catalogRead ? undefined : currentCodexCatalogListRequest();
    if (!scope) {
      return request(method, params, timeoutMs, undefined, observation);
    }
    return scope.read(timeoutMs ?? requestTimeoutMs, async (remaining) => {
      const attempt = beginList(scope);
      if (!attempt.allowed) {
        throw attempt.error;
      }
      return await request(method, params, remaining, undefined, observation);
    });
  };
  return {
    index,
    beginList,
    get requestTimeoutMs() {
      return catalogRead
        ? requestTimeoutMs
        : (currentCodexCatalogListRequest()?.remaining(requestTimeoutMs) ?? requestTimeoutMs);
    },
    listThreads: (params, timeoutMs, observation) =>
      read(CODEX_CONTROL_METHODS.listThreads, params, timeoutMs, observation),
    listThreadTurns: (params) => read(CODEX_CONTROL_METHODS.listThreadTurns, params),
    listThreadItems: (params) => read(CODEX_CONTROL_METHODS.listThreadItems, params),
    forkThread: (params, assertCurrent) =>
      request(
        CODEX_CONTROL_METHODS.forkThread,
        assertCodexThreadForkParams(params),
        undefined,
        assertCurrent,
      ),
    readThread: async (threadId, includeTurns, timeoutMs) =>
      (await read(CODEX_CONTROL_METHODS.readThread, { threadId, includeTurns }, timeoutMs)).thread,
    archiveThread: async (threadId, assertCurrent) => {
      await request(CODEX_CONTROL_METHODS.archiveThread, { threadId }, undefined, assertCurrent);
    },
  };
}

function createCodexSessionCatalogControlFromRequests(params: {
  forkContext?: CodexSessionCatalogControl["forkContext"];
  clientId?: string;
  retireConnection?: () => void;
  connectionFingerprint?: string;
  createRequestSnapshot: () => CodexSessionCatalogRequestSnapshot;
  localSessionsRoot?: string;
  sourceHomeId?: string;
  managedThreads?: CodexManagedThreadStore;
  now: () => number;
  withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"];
}): CodexSessionCatalogControl {
  return {
    forkContext: params.forkContext,
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...(params.connectionFingerprint
      ? { connectionFingerprint: params.connectionFingerprint }
      : {}),
    withPinnedConnection: params.withPinnedConnection,
    async initialize() {
      await (await params.createRequestSnapshot().index()).initialize();
    },
    requireEligibleThread: (threadId) =>
      requireEligibleCodexThread({
        threadId,
        requests: params.createRequestSnapshot(),
        localSessionsRoot: params.localSessionsRoot,
        sourceHomeId: params.sourceHomeId,
        managedThreads: params.managedThreads,
        now: params.now,
      }),
    retireConnection: params.retireConnection,
    async listPage(pageParams) {
      readControlCursor(pageParams.cursor, "request");
      const query = readPageParams(pageParams);
      return await withCodexCatalogListRequest(async (request) => {
        const requests = params.createRequestSnapshot();
        const deadline = request.deadline(requests.requestTimeoutMs);
        const index = await withTimeout(
          requests.index(),
          request.remaining(requests.requestTimeoutMs),
          "Codex session catalog is still loading",
          () => new CodexCatalogLoadingError(),
        );
        return await index.list(query, deadline);
      });
    },
    async listDescendantPage(listParams) {
      const requests = params.createRequestSnapshot();
      const response = await requests.listThreads(listParams, requests.requestTimeoutMs);
      return response;
    },
    async readThread(threadId, includeTurns = false) {
      const thread = await params.createRequestSnapshot().readThread(threadId, includeTurns);
      return thread;
    },
    async listTurnPage(listParams) {
      const response = await params.createRequestSnapshot().listThreadTurns(listParams);
      return response;
    },
    listItemPage: (listParams) => params.createRequestSnapshot().listThreadItems(listParams),
    async forkThread(forkParams, assertCurrent) {
      const requests = params.createRequestSnapshot();
      const index = forkParams.ephemeral === true ? undefined : await requests.index();
      const response = await requests.forkThread(forkParams, assertCurrent);
      if (index && !index.get(response.thread.id)) {
        await index.upsertThread(response.thread);
      }
      return response;
    },
    async archiveThread(threadId, assertCurrent) {
      const requests = params.createRequestSnapshot();
      const index = await requests.index();
      await requests.archiveThread(threadId, assertCurrent);
      index.archive(threadId);
    },
  };
}

/** Builds the passive catalog over the Codex plugin's canonical shared client. */
export function createCodexSessionCatalogControl(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  getPluginConfig: () => unknown;
  getRuntimeConfig: () => OpenClawConfig | undefined;
  resolveRuntimeOptions: typeof resolveCodexSupervisionAppServerRuntimeOptions;
  now?: () => number;
  managedThreads?: CodexManagedThreadStore;
  openResidentState?: (homeId: string) => CodexCatalogState;
}): CodexSessionCatalogControlFactory & { start(): Promise<void>; stop(): Promise<void> } {
  const now = params.now ?? Date.now;
  const sourceBackoff = new CodexCatalogSourceBackoff(now);
  const noConfig: OpenClawConfig = {};
  const getPluginConfig = () => params.getPluginConfig();
  const homeResolver = createCodexCatalogHomeResolver({
    config: params.config ?? {},
    getRuntimeConfig: params.getRuntimeConfig,
    getPluginConfig: params.getPluginConfig,
    resolveRuntimeOptions: params.resolveRuntimeOptions,
    ...(params.env ? { env: params.env } : {}),
  });
  const requestOptionsByConfig = new WeakMap<
    OpenClawConfig,
    Map<string, CodexCatalogRequestOptions>
  >();
  const indexes = new Map<string, CodexCatalogIndex>();
  const retiringState = new Map<string, Promise<void>>();
  const directHomes = new Map<string, Promise<string>>();
  let generation = params.getRuntimeConfig();
  let closed = false;
  let runBackground = (run: () => Promise<void>) => run();
  let retiring: Promise<void> = Promise.resolve();
  const residentFor = async (
    agentId: string | undefined,
    source?: CodexCatalogControlSource,
  ): Promise<CodexCatalogIndex> => {
    if (closed) {
      throw new Error("Codex resident catalog is closed");
    }
    const config = params.getRuntimeConfig();
    if (generation !== config) {
      generation = config;
      const closing: Promise<void>[] = [];
      for (const [homeId, index] of indexes) {
        const writes = index.retire().finally(() => {
          if (retiringState.get(homeId) === writes) {
            retiringState.delete(homeId);
          }
        });
        retiringState.set(homeId, writes);
        closing.push(writes, index.close());
      }
      retiring = Promise.allSettled([retiring, ...closing]).then(() => undefined);
      indexes.clear();
      directHomes.clear();
    }
    const runtime =
      source?.appServer ?? params.resolveRuntimeOptions({ pluginConfig: getPluginConfig() });
    const requestOptions = resolveRequestOptions(runtime.start, agentId, source);
    const key = source?.sourceHomeId ?? agentId ?? "";
    let home = directHomes.get(key);
    if (!home) {
      home = codexCatalogResidentHomeKey({
        startOptions: requestOptions.startOptions,
        agentDir: requestOptions.agentDir,
        sourceHomeId: source?.sourceHomeId,
      });
      directHomes.set(key, home);
    }
    const homeId = await home;
    // Only already-admitted writes can affect the replacement's snapshot.
    // Retired native reads remain owned by stop(), without delaying this list.
    await retiringState.get(homeId);
    if (closed || generation !== config) {
      throw new Error("Codex catalog configuration changed");
    }
    let index = indexes.get(homeId);
    if (!index) {
      const [
        { CodexCatalogIndex },
        { canReuseCodexCatalogPreview, projectCodexCatalogDeltaPage, projectCodexCatalogPage },
      ] = await Promise.all([
        import("./session-catalog-index.js"),
        import("./session-catalog-projection.js"),
      ]);
      source?.assertCurrent();
      if (closed || generation !== config) {
        throw new Error("Codex catalog configuration changed");
      }
      index = indexes.get(homeId);
      if (index) {
        return index;
      }
      const root =
        source?.localSessionsRoot ??
        (runtime.connectionClass !== "remote"
          ? path.join(
              resolveCodexAppServerLocalHomeDir(
                requestOptions.startOptions,
                requestOptions.agentDir,
                params.env,
              ),
              "sessions",
            )
          : undefined);
      let nativeAttempt: ReturnType<CodexCatalogSourceBackoff["begin"]> | undefined;
      const readNativePage = async <T extends { nextCursor?: string }>(
        query: CodexThreadListParams,
        remainingRows: number,
        project: (
          response: CodexThreadListResponse,
          diagnostics: CodexCatalogPageDiagnostics | undefined,
        ) => T | Promise<T>,
        foreground?: CodexCatalogListRequest,
      ): Promise<T> => {
        const requests = createRequestSnapshot(
          agentId,
          source,
          true,
          query.useStateDbOnly
            ? (thread) => {
                const row = index?.get(thread.id);
                return canReuseCodexCatalogPreview(row, thread) ? row?.preview : undefined;
              }
            : undefined,
          remainingRows,
        );
        const attempt = foreground
          ? requests.beginList(foreground)
          : query.cursor && nativeAttempt
            ? nativeAttempt
            : requests.beginList();
        if (!foreground) {
          nativeAttempt = attempt;
        }
        if (!attempt.allowed) {
          throw attempt.error;
        }
        const diagnostics = startCodexCatalogPageDiagnostics("cold");
        if (diagnostics) {
          diagnostics.fields.controlRequestCalls = 1;
        }
        const observation = startCodexCatalogControlRequestDiagnostics(diagnostics);
        let outcome: "resolved" | "rejected" = "rejected";
        try {
          const started = performance.now();
          let response: CodexThreadListResponse;
          try {
            response = await requests.listThreads(
              query,
              foreground?.remaining(requests.requestTimeoutMs) ?? requests.requestTimeoutMs,
              observation,
            );
          } finally {
            if (diagnostics) {
              const elapsed = performance.now() - started;
              diagnostics.fields.inclusiveControlRequestWaitMs = elapsed;
              diagnostics.fields.inclusiveControlRequestWaitMaxMs = elapsed;
            }
          }
          foreground?.assertActive();
          const page = await project(response, diagnostics);
          foreground?.assertActive();
          outcome = "resolved";
          if (!foreground && !page.nextCursor) {
            attempt.resolved();
            nativeAttempt = undefined;
          }
          return page;
        } catch (error) {
          observation?.rejected();
          if (!foreground) {
            attempt.rejected(error);
            nativeAttempt = undefined;
          }
          throw error;
        } finally {
          observation?.close();
          diagnostics?.finish(outcome);
        }
      };
      index = new CodexCatalogIndex({
        homeId,
        requestTimeoutMs: runtime.requestTimeoutMs,
        runBackground: (run) => runBackground(run),
        localSessionsRoot: root,
        state: params.openResidentState?.(homeId),
        assertCurrent: () => {
          source?.assertCurrent();
          if (closed || params.getRuntimeConfig() !== config) {
            throw new Error("Codex catalog configuration changed");
          }
        },
        readNative: (query, remainingRows, foreground) =>
          readNativePage(
            query,
            Math.min(64, remainingRows),
            async (response, diagnostics) => {
              const { sanitizeTerminalText } = await import("openclaw/plugin-sdk/text-chunking");
              const bounded = { ...response, data: response.data.slice(0, remainingRows) };
              const projection = {
                localSessionsRoot: root,
                sanitize: sanitizeTerminalText,
                diagnostics,
              };
              return query.useStateDbOnly
                ? await projectCodexCatalogDeltaPage(bounded, {
                    ...projection,
                    getRow: (threadId) => index?.get(threadId),
                  })
                : await projectCodexCatalogPage(bounded, projection);
            },
            foreground,
          ),
      });
      indexes.set(homeId, index);
    }
    return index;
  };
  const resolveRequestOptions = (
    startOptions: CodexAppServerStartOptions,
    agentId: string | undefined,
    source?: CodexCatalogControlSource,
  ): CodexCatalogRequestOptions => {
    source?.assertCurrent();
    const runtimeConfig = params.getRuntimeConfig();
    const agentDir =
      source?.agentDir ?? (agentId ? resolveAgentDir(runtimeConfig ?? {}, agentId) : undefined);
    const resolvedStartOptions = source?.appServer.start ?? startOptions;
    if (!runtimeConfig) {
      return {
        agentDir,
        config: undefined,
        startOptions: structuredClone(resolvedStartOptions),
      };
    }
    let byAgent = requestOptionsByConfig.get(runtimeConfig);
    const cacheKey = `${agentId ?? ""}\0${source?.sourceHomeId ?? ""}`;
    const cached = byAgent?.get(cacheKey);
    if (cached) {
      // Plugin start options derive from this same immutable config snapshot. Config reload changes
      // object identity; re-cloning on every poll only adds CPU and allocation to the catalog path.
      return cached;
    }
    const resolved = {
      agentDir,
      config: structuredClone(runtimeConfig),
      startOptions: structuredClone(resolvedStartOptions),
    };
    if (!byAgent) {
      byAgent = new Map();
      requestOptionsByConfig.set(runtimeConfig, byAgent);
    }
    byAgent.set(cacheKey, resolved);
    return resolved;
  };
  const createRequestSnapshot = (
    agentId: string | undefined,
    source?: CodexCatalogControlSource,
    catalogPreview?: true,
    catalogPreviewCache?: CodexCatalogPreviewCache,
    catalogRows?: number,
  ): CodexSessionCatalogRequestSnapshot => {
    const pluginConfig = getPluginConfig();
    const runtime = source?.appServer ?? params.resolveRuntimeOptions({ pluginConfig });
    const requestOptions = resolveRequestOptions(runtime.start, agentId, source);
    return createCodexCatalogRequestSnapshot(
      runtime.requestTimeoutMs,
      async (method, requestParams, timeoutMs, assertCurrent, observation) => {
        const { codexControlRequest } = await import("./command-rpc.js");
        return await codexControlRequest(pluginConfig, method, requestParams, {
          ...requestOptions,
          authProfileId: null,
          assertCurrent,
          ...(catalogPreview && method === CODEX_CONTROL_METHODS.listThreads
            ? {
                catalogPreview,
                catalogRows,
                ...(catalogPreviewCache ? { catalogPreviewCache } : {}),
              }
            : {}),
          ...(observation ? { controlObservation: observation } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      },
      () => residentFor(agentId, source),
      (request) =>
        sourceBackoff.begin(
          requestOptions.config ?? noConfig,
          agentId,
          source?.sourceHomeId,
          request,
        ),
      catalogPreview === true,
    );
  };

  const forRequest = (
    agentId: string | undefined,
    source?: CodexCatalogControlSource,
  ): CodexSessionCatalogControl => {
    source?.assertCurrent();
    const withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"] = async (
      run,
    ) => {
      const pluginConfig = getPluginConfig();
      const runtime = source?.appServer ?? params.resolveRuntimeOptions({ pluginConfig });
      const {
        agentDir,
        config: runtimeConfig,
        startOptions,
      } = resolveRequestOptions(runtime.start, agentId, source);
      let catalogIndex: Promise<CodexCatalogIndex> | undefined;
      // Capture the request's config/home before loading execution; imports must
      // not let a concurrent reload move this pinned operation to another owner.
      const {
        getLeasedSharedCodexAppServerClient,
        releaseLeasedSharedCodexAppServerClient,
        retireSharedCodexAppServerClientIfCurrent,
      } = await import("./app-server/shared-client.js");
      const { resolveCodexAppServerClientInstanceId } = await import("./app-server/client.js");
      const { requestCodexAppServerClientJson } = await import("./app-server/request.js");
      const client = await getLeasedSharedCodexAppServerClient({
        agentDir,
        config: runtimeConfig,
        startOptions,
        authProfileId: null,
        timeoutMs:
          currentCodexCatalogListRequest()?.remaining(runtime.requestTimeoutMs) ??
          runtime.requestTimeoutMs,
      });
      try {
        const requests = createCodexCatalogRequestSnapshot(
          runtime.requestTimeoutMs,
          async <M extends CodexCatalogRequestMethod>(
            method: M,
            requestParams: CodexAppServerRequestParams<M>,
            timeoutMs?: number,
            assertCurrent?: () => void,
            observation?: CodexControlRequestObservation,
          ): Promise<CodexAppServerRequestResult<M>> =>
            await requestCodexAppServerClientJson<CodexAppServerRequestResult<M>>({
              client,
              method,
              requestParams,
              config: runtimeConfig,
              timeoutMs: timeoutMs ?? runtime.requestTimeoutMs,
              assertCurrent,
              ...(observation ? { controlObservation: observation } : {}),
            }),
          () => (catalogIndex ??= residentFor(agentId, source)),
          (request) =>
            sourceBackoff.begin(runtimeConfig ?? noConfig, agentId, source?.sourceHomeId, request),
        );
        const pinnedControl: CodexSessionCatalogControl =
          createCodexSessionCatalogControlFromRequests({
            forkContext: agentDir
              ? {
                  client,
                  appServer: runtime,
                  pluginConfig,
                  agentDir,
                  localSessionsRoot: source?.localSessionsRoot,
                }
              : undefined,
            clientId: resolveCodexAppServerClientInstanceId(client),
            retireConnection: () => {
              retireSharedCodexAppServerClientIfCurrent(client);
            },
            connectionFingerprint: buildCodexAppServerConnectionFingerprint(runtime, agentDir),
            createRequestSnapshot: () => requests,
            ...(source?.localSessionsRoot ? { localSessionsRoot: source.localSessionsRoot } : {}),
            sourceHomeId: source?.sourceHomeId,
            managedThreads: params.managedThreads,
            now,
            withPinnedConnection: async (nestedRun) => await nestedRun(pinnedControl),
          });
        return await run(pinnedControl);
      } finally {
        releaseLeasedSharedCodexAppServerClient(client);
      }
    };
    const control = createCodexSessionCatalogControlFromRequests({
      createRequestSnapshot: () => createRequestSnapshot(agentId, source),
      ...(source?.localSessionsRoot ? { localSessionsRoot: source.localSessionsRoot } : {}),
      now,
      withPinnedConnection,
    });
    return {
      ...control,
      requireEligibleThread: (threadId) =>
        withPinnedConnection((pinned) => pinned.requireEligibleThread(threadId)),
      async listPage(pageParams: CodexSessionCatalogPageParams) {
        source?.assertCurrent();
        return await control.listPage(pageParams);
      },
    };
  };
  const forUpstream = async (agentId: string, connectionFingerprint: string) => {
    // A fingerprint is correlation only. A miss must stay fail-closed instead of selecting a
    // different home whose thread namespace could contain the same copied identifier.
    const source = (await homeResolver.forAgent(agentId)).find(
      (home) =>
        buildCodexAppServerConnectionFingerprint(home.appServer, home.agentDir) ===
        connectionFingerprint,
    );
    return source ? forRequest(agentId, source) : undefined;
  };
  return {
    async start() {
      const serviceScope = AsyncLocalStorage.snapshot();
      runBackground = (run) => serviceScope(run);
      for (const agentId of listAgentIds(params.getRuntimeConfig() ?? params.config ?? {})) {
        for (const source of await homeResolver.forAgent(agentId)) {
          // Implicit process HOME is admitted by the Gateway's request policy.
          // Explicit homes can hydrate at activation without bypassing that policy.
          if (source.usesProcessHomeFallback) {
            continue;
          }
          void forRequest(agentId, source)
            .initialize()
            .catch((error: unknown) =>
              embeddedAgentLog.warn("Codex catalog hydration failed", { error }),
            );
        }
      }
    },
    async stop() {
      closed = true;
      await Promise.allSettled([...indexes.values()].map((index) => index.close()));
      await retiring;
      indexes.clear();
      directHomes.clear();
    },
    forRequest,
    forUpstream,
    homesForAgent: homeResolver.forAgent,
    async forNode(agentId) {
      const source = await homeResolver.forNode(agentId);
      return {
        control: forRequest(source.agentId, source),
        sourceHomeId: source.sourceHomeId,
        codexHome: source.codexHome,
      };
    },
  };
}
