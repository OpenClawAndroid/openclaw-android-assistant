import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveGatewaySessionStoreTargets } from "../config/sessions/combined-store-gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

type SessionRowScopeTarget = {
  agentId: string;
  storeTarget: { agentId: string; storePath: string };
};
type SessionRowScopeQuery = { agentId?: string; storePath?: string };
type SessionRowScope =
  | Pick<ReturnType<typeof prepareSessionRowScopes>, "physicalPaths">
  | undefined;

/** Early publications retain literal paths until topology has prepared their aliases. */
export function matchesSessionRowScope(
  row: SessionRowScopeTarget,
  query: SessionRowScopeQuery,
  scope: SessionRowScope,
  logicalOwnerOnly = false,
) {
  return (
    (!query.agentId ||
      row.agentId === query.agentId ||
      (!logicalOwnerOnly && row.storeTarget.agentId === query.agentId)) &&
    (!query.storePath ||
      (scope?.physicalPaths(query.storePath, query.agentId) ?? [query.storePath]).includes(
        row.storeTarget.storePath,
      ))
  );
}

export function selectMatchingSessionRows<T extends SessionRowScopeTarget>(
  params: {
    rows: ReadonlyMap<string, T>;
    indexes: {
      byKey: ReadonlyMap<string, ReadonlySet<string>>;
      byStore: ReadonlyMap<string, ReadonlySet<string>>;
      byAgent: ReadonlyMap<string, ReadonlySet<string>>;
    };
    scope: SessionRowScope;
  },
  query: SessionRowScopeQuery & { key?: string },
  kind = "key",
) {
  const {
    rows,
    indexes: { byKey, byStore, byAgent },
    scope,
  } = params;
  const candidates = query.key
    ? byKey.get(`${kind}:${query.key}`)
    : query.storePath
      ? new Set(
          (scope?.physicalPaths(query.storePath, query.agentId) ?? [query.storePath]).flatMap(
            (storePath) => Array.from(byStore.get(storePath) ?? []),
          ),
        )
      : query.agentId
        ? byAgent.get(query.agentId)
        : rows.keys();
  return [...(candidates ?? [])]
    .map((id) => rows.get(id))
    .filter((row): row is T => row !== undefined && matchesSessionRowScope(row, query, scope));
}

/** Resolve query-specific federation once when the physical topology is published. */
export function prepareSessionRowScopes(
  cfg: OpenClawConfig,
  agentIds: Iterable<string>,
  residentPaths: ReadonlyMap<string, string>,
) {
  const residentPath = (pathname: string) => residentPaths.get(pathname) ?? pathname;
  const filenames = new Map([...residentPaths].map(([filename, locator]) => [locator, filename]));
  const aliases = new Map<string, Map<string, string>>();
  const capture = (options: { agentId?: string; configuredAgentsOnly?: boolean }) => {
    try {
      const resolved = resolveGatewaySessionStoreTargets(cfg, {
        ...options,
        includeIncognito: false,
      });
      for (const [identity, physical] of resolved.physicalTargets) {
        const separator = identity.indexOf("\0");
        const agentId = identity.slice(0, separator);
        const locator = path.resolve(identity.slice(separator + 1));
        const owners = aliases.get(locator) ?? new Map<string, string>();
        owners.set(agentId, residentPath(physical.storePath));
        aliases.set(locator, owners);
      }
      const paths = resolved.durableTargets.map((target) =>
        residentPath(
          expectDefined(
            resolved.physicalTargets.get(`${target.agentId}\0${target.storePath}`),
            "physical source",
          ).storePath,
        ),
      );
      return {
        paths: new Map(paths.map((pathname, index) => [pathname, index])),
        path: paths.length === 1 ? (filenames.get(paths[0]!) ?? paths[0]!) : "(multiple)",
        configuredAgentIds: resolved.configuredAgentIds,
        agentId: resolved.requestedAgentId,
      };
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const all = capture({});
  const configured = capture({ configuredAgentsOnly: true });
  const agents = new Map(
    [...new Set([...listAgentIds(cfg), ...agentIds])].map((agentId) => [
      agentId,
      capture({ agentId }),
    ]),
  );
  const select = (options: { agentId?: string; configuredAgentsOnly?: boolean }) => {
    const requestedAgentId = options.agentId?.trim()
      ? normalizeAgentId(options.agentId)
      : undefined;
    const scope = requestedAgentId
      ? (agents.get(requestedAgentId) ?? {
          paths: new Map<string, number>(),
          path: "(multiple)",
          agentId: requestedAgentId,
          configuredAgentIds: undefined,
        })
      : options.configuredAgentsOnly
        ? configured
        : all;
    if (scope instanceof Error) {
      throw scope;
    }
    return scope;
  };
  return {
    select,
    physicalPaths(locator: string, agentId?: string) {
      const normalized = residentPath(path.resolve(locator));
      const owners = aliases.get(normalized);
      return agentId
        ? [owners?.get(normalizeAgentId(agentId)) ?? normalized]
        : owners
          ? [...new Set(owners.values())]
          : [normalized];
    },
  };
}
