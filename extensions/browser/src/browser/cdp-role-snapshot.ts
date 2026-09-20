import type { lookup as dnsLookupCb } from "node:dns";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { CdpProtocolSend, RawAXNode } from "./cdp-ax.js";
import { prepareCdpPageSession } from "./cdp-page-session.js";
import {
  findCursorInteractiveElements,
  resolveLinkUrls,
  resolveIframeFrameIds,
} from "./cdp-role-snapshot-dom.js";
import {
  buildRoleTree,
  renderRoleTree,
  type CdpRoleRef,
  type CdpRoleSnapshotOptions,
  type CursorInteractiveInfo,
} from "./cdp-role-snapshot-tree.js";
import { withCdpSocket } from "./cdp.helpers.js";
import { finalizeRoleSnapshot, type RoleSnapshotIdentityMode } from "./pw-role-snapshot.js";
import { appendRoleSnapshotDepthTruncationMarker } from "./snapshot-depth-limit.js";
import { CONTENT_ROLES, INTERACTIVE_ROLES } from "./snapshot-roles.js";
import { appendSnapshotUrls, type SnapshotUrlEntry } from "./snapshot-urls.js";

async function buildCdpRoleSnapshot(params: {
  send: CdpProtocolSend;
  rootBackendNodeId?: number;
  sessionId?: string;
  frameId?: string;
  options: CdpRoleSnapshotOptions;
  urls?: boolean;
  recurseIframes?: boolean;
  nextRef: { value: number };
}): Promise<{
  lines: string[];
  refs: Record<string, CdpRoleRef>;
  truncated: boolean;
}> {
  const res = (await params.send(
    params.rootBackendNodeId !== undefined
      ? "Accessibility.queryAXTree"
      : "Accessibility.getFullAXTree",
    params.rootBackendNodeId !== undefined
      ? { backendNodeId: params.rootBackendNodeId }
      : params.frameId
        ? { frameId: params.frameId }
        : undefined,
    params.sessionId,
  )) as { nodes?: RawAXNode[] }; // SAFETY: Both selected Accessibility commands return AXNode arrays; missing nodes are handled below.
  const { tree, roots } = buildRoleTree(
    Array.isArray(res.nodes) ? res.nodes : [],
    params.rootBackendNodeId,
  );
  // Scoped captures preserve role-snapshot membership; page-wide cursor discovery
  // would add controls outside the selected root or from another frame.
  const cursorElements =
    params.rootBackendNodeId !== undefined
      ? new Map<number, CursorInteractiveInfo>()
      : await findCursorInteractiveElements(params.send, params.sessionId);
  for (const node of tree) {
    if (node.backendDOMNodeId && cursorElements.has(node.backendDOMNodeId)) {
      const cursorInfo = cursorElements.get(node.backendDOMNodeId);
      node.cursorInfo = cursorInfo;
      if (!node.name && cursorInfo?.text) {
        node.name = cursorInfo.text;
      }
    }
  }

  const counts = new Map<string, number>();
  const refs: Record<string, CdpRoleRef> = {};
  for (const node of tree) {
    const role = node.role.toLowerCase();
    const shouldRef =
      INTERACTIVE_ROLES.has(role) ||
      (CONTENT_ROLES.has(role) && Boolean(node.name)) ||
      role === "iframe" ||
      Boolean(node.cursorInfo);
    if (!shouldRef || node.transparent) {
      continue;
    }
    const key = `${role}:${node.name}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    const ref = `e${params.nextRef.value}`;
    params.nextRef.value += 1;
    node.ref = ref;
    node.nth = nth;
    refs[ref] = {
      role,
      ...(node.name ? { name: node.name } : {}),
      nth,
      ...(node.backendDOMNodeId ? { backendDOMNodeId: node.backendDOMNodeId } : {}),
      ...(params.frameId ? { frameId: params.frameId } : {}),
    };
  }
  for (const node of tree) {
    if (node.ref && counts.get(`${node.role.toLowerCase()}:${node.name}`) === 1) {
      delete refs[node.ref]?.nth;
    }
  }

  const iframeFrameIds = await resolveIframeFrameIds(params.send, tree, params.sessionId);
  for (const node of tree) {
    if (node.backendDOMNodeId && iframeFrameIds.has(node.backendDOMNodeId)) {
      node.frameId = iframeFrameIds.get(node.backendDOMNodeId);
      if (node.ref && refs[node.ref]) {
        expectDefined(refs[node.ref], "owned CDP role reference").frameId = node.frameId;
      }
    }
  }

  if (params.urls) {
    const urls = await resolveLinkUrls(params.send, refs, params.sessionId);
    for (const node of tree) {
      if (node.backendDOMNodeId && urls.has(node.backendDOMNodeId)) {
        node.url = urls.get(node.backendDOMNodeId);
      }
    }
  }

  let lines: string[] = [];
  const renderState = {
    truncated: false,
    recordIframePositions: params.recurseIframes,
    flattenInteractive: params.rootBackendNodeId !== undefined,
  };
  for (const root of roots) {
    renderRoleTree(tree, root, lines, params.options, renderState);
  }

  if (params.recurseIframes) {
    let childLinesByIndex: Map<number, string[]> | undefined;
    for (const iframe of tree) {
      if (iframe.iframeLineIndex === undefined || !iframe.frameId) {
        continue;
      }
      const child = await buildCdpRoleSnapshot({
        ...params,
        frameId: iframe.frameId,
        recurseIframes: false,
      }).catch(() => null);
      if (!child) {
        continue;
      }
      renderState.truncated ||= child.truncated;
      if (!child.lines.length) {
        continue;
      }
      Object.assign(refs, child.refs);
      (childLinesByIndex ??= new Map()).set(iframe.iframeLineIndex, child.lines);
    }
    if (childLinesByIndex) {
      const expanded: string[] = [];
      for (let index = 0; index < lines.length; index++) {
        expanded.push(lines[index]!);
        const childLines = childLinesByIndex.get(index);
        if (childLines) {
          for (const childLine of childLines) {
            expanded.push(`  ${childLine}`);
          }
        }
      }
      lines = expanded;
    }
  }

  return {
    lines,
    refs,
    truncated: renderState.truncated,
  };
}

/** Build a role/name text snapshot with stable refs from CDP DOM and AX data. */
type CdpRoleSnapshotRequest = {
  urlEntries?: SnapshotUrlEntry[];
  options?: CdpRoleSnapshotOptions;
  urls?: boolean;
  recurseIframes?: boolean;
  timeoutMs?: number;
  maxChars?: number;
  delta?: { mode: RoleSnapshotIdentityMode; previousKeys?: ReadonlySet<string> };
};

/** Capture and format refs with their backend identities on the caller-owned CDP session. */
export async function snapshotRoleViaCdpSession(
  opts: CdpRoleSnapshotRequest & {
    send: CdpProtocolSend;
    rootBackendNodeId?: number;
  },
): Promise<{
  snapshot: string;
  truncated?: boolean;
  refs: Record<string, CdpRoleRef>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
  newElements?: number;
}> {
  await prepareCdpPageSession(opts.send);
  const built = await buildCdpRoleSnapshot({
    send: opts.send,
    rootBackendNodeId: opts.rootBackendNodeId,
    options: opts.options ?? {},
    urls: opts.urls,
    recurseIframes: opts.recurseIframes ?? true,
    nextRef: { value: 1 },
  });
  const renderedSnapshot =
    built.lines.join("\n").trim() ||
    (opts.options?.interactive
      ? "(no interactive elements)"
      : opts.rootBackendNodeId !== undefined
        ? "(empty)"
        : "(empty page)");
  const finalized = finalizeRoleSnapshot({
    snapshot: appendSnapshotUrls(
      built.truncated
        ? appendRoleSnapshotDepthTruncationMarker(renderedSnapshot)
        : renderedSnapshot,
      opts.urlEntries ?? [],
    ),
    refs: built.refs,
    maxChars: opts.maxChars,
    delta: opts.delta,
  });
  return built.truncated && !finalized.truncated ? { ...finalized, truncated: true } : finalized;
}

export async function snapshotRoleViaCdp(
  opts: CdpRoleSnapshotRequest & {
    wsUrl: string;
    lookup?: typeof dnsLookupCb;
  },
) {
  return await withCdpSocket(
    opts.wsUrl,
    async (send) => await snapshotRoleViaCdpSession({ ...opts, send }),
    { commandTimeoutMs: opts.timeoutMs ?? 5000, lookup: opts.lookup },
  );
}
