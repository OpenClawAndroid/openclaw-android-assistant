import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { isAudioFileName } from "@openclaw/media-core/mime";
import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSessionPermissionCoreToolPolicy } from "../../agents/session-permission-exec-mode.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../agents/tool-fs-policy.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyMediaFailure,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { getMediaDir } from "../../media/store.js";
import { resolveSendableOutboundReplyParts } from "../../plugin-sdk/reply-payload.js";
import { resolveSessionWorkerPlacementContext } from "../session-worker-placement-context.js";
import { resolveSessionWorkspaceRoots } from "../session-workspace-roots.js";

type WebchatReplyMediaScope = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionEntry: SessionEntry | undefined;
};

function resolveWebchatReplyWorkspace(params: WebchatReplyMediaScope) {
  const entry = params.sessionEntry;
  const placement =
    entry?.sessionId && !entry.execNode && !entry.repositoryWorkspaceId
      ? resolveSessionWorkerPlacementContext()
          .workerSessionPlacementService?.getMany([entry.sessionId])
          .get(entry.sessionId)
      : undefined;
  // Placement can be remote before any workspace metadata has been published.
  const remote = Boolean(
    entry?.execNode ||
    entry?.repositoryWorkspaceId ||
    isCloudWorkerPlacementState(placement?.state),
  );
  return {
    remote,
    workspaceDir:
      !remote && entry
        ? (entry.sessionRoot ??
          resolveSessionWorkspaceRoots(params.cfg, params.agentId, entry).root)
        : resolveAgentWorkspaceDir(params.cfg, params.agentId),
  };
}

function resolveWebchatReplyWorkspaceOnly(params: WebchatReplyMediaScope): boolean {
  const mode = params.sessionEntry?.permissionMode;
  return mode
    ? resolveSessionPermissionCoreToolPolicy({ mode }).workspaceOnly
    : resolveEffectiveToolFsWorkspaceOnly(params);
}

/** Trusted audio bypasses staging, but its reader must use the same session workspace. */
export function getWebchatReplyMediaLocalRoots(
  params: WebchatReplyMediaScope & { storePath?: string },
): readonly string[] {
  const { remote, workspaceDir } = resolveWebchatReplyWorkspace(params);
  if (remote) {
    return [getMediaDir()];
  }
  const workspaceRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId, workspaceDir);
  const roots = resolveWebchatReplyWorkspaceOnly(params)
    ? workspaceRoots
    : [
        ...new Set([
          ...getAgentScopedMediaLocalRoots(params.cfg, params.agentId),
          ...workspaceRoots,
        ]),
      ];
  return appendLocalMediaParentRoots(roots, params.storePath ? [params.storePath] : undefined);
}

function shouldPreserveDisplayMediaUrl(payload: ReplyPayload, mediaUrl: string): boolean {
  if (mediaUrl.trim().toLowerCase().startsWith("data:")) {
    return true;
  }
  if (!isAudioFileName(mediaUrl)) {
    return false;
  }
  if (isPassThroughRemoteMediaSource(mediaUrl)) {
    return true;
  }
  // Trusted audio keeps its playback path and size cap; the reader still enforces local roots.
  return payload.trustedLocalMedia === true;
}

/** Normalize reply media paths for webchat display without leaking sensitive media. */
export async function normalizeWebchatReplyMediaPathsForDisplay(
  params: WebchatReplyMediaScope & {
    sessionKey: string;
    accountId?: string;
    payloads: ReplyPayload[];
  },
): Promise<ReplyPayload[]> {
  if (
    params.payloads.every(
      (payload) =>
        payload.sensitiveMedia === true ||
        resolveSendableOutboundReplyParts(payload).mediaUrls.every((url) =>
          shouldPreserveDisplayMediaUrl(payload, url),
        ),
    )
  ) {
    return params.payloads;
  }
  const { remote, workspaceDir } = resolveWebchatReplyWorkspace(params);
  if (!workspaceDir) {
    return params.payloads;
  }
  const workspaceOnly = resolveWebchatReplyWorkspaceOnly(params);
  const normalizeMediaPaths = createReplyMediaPathNormalizer({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    workspaceDir,
    sessionWorkspaceDir: workspaceOnly && !remote ? workspaceDir : undefined,
    workspaceOnly,
    allowHostWorkspace: !remote,
    accountId: params.accountId,
  });
  const normalized: ReplyPayload[] = [];
  for (const payload of params.payloads) {
    if (payload.sensitiveMedia === true) {
      // Suppressed media must not be copied into managed outbound storage for display.
      normalized.push(payload);
      continue;
    }
    const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
    if (!mediaUrls.some((mediaUrl) => shouldPreserveDisplayMediaUrl(payload, mediaUrl))) {
      normalized.push(await normalizeMediaPaths(payload));
      continue;
    }
    if (!mediaUrls.some((mediaUrl) => !shouldPreserveDisplayMediaUrl(payload, mediaUrl))) {
      normalized.push(payload);
      continue;
    }
    const mergedMediaUrls: string[] = [];
    const mergedAttachments: NonNullable<ReplyPayload["attachments"]> = [];
    const mediaFailures: ReplyMediaFailure[] = [
      ...(getReplyPayloadMetadata(payload)?.assistantMediaFailures ?? []),
    ];
    let text = payload.text;
    for (const [index, mediaUrl] of mediaUrls.entries()) {
      const attachment = payload.attachments?.[index];
      if (shouldPreserveDisplayMediaUrl(payload, mediaUrl)) {
        mergedMediaUrls.push(mediaUrl);
        mergedAttachments.push(attachment ?? {});
        continue;
      }
      const normalizedPayload = await normalizeMediaPaths({
        ...payload,
        text,
        mediaUrl,
        mediaUrls: [mediaUrl],
        attachments: attachment ? [attachment] : undefined,
      });
      const normalizedMediaUrls = resolveSendableOutboundReplyParts(normalizedPayload).mediaUrls;
      // Per-file copies have no WeakMap metadata, so every returned failure is new.
      mediaFailures.push(
        ...(getReplyPayloadMetadata(normalizedPayload)?.assistantMediaFailures ?? []),
      );
      text = normalizedPayload.text;
      if (normalizedMediaUrls.length === 0) {
        continue;
      }
      mergedMediaUrls.push(...normalizedMediaUrls);
      mergedAttachments.push(
        ...(normalizedPayload.attachments ?? normalizedMediaUrls.map(() => ({}))),
      );
    }
    const merged = copyReplyPayloadMetadata(payload, {
      ...payload,
      text,
      mediaUrl: mergedMediaUrls[0],
      mediaUrls: mergedMediaUrls,
      attachments: mergedAttachments,
    });
    normalized.push(
      mediaFailures.length > 0
        ? setReplyPayloadMetadata(merged, { assistantMediaFailures: mediaFailures })
        : merged,
    );
  }
  return normalized;
}
