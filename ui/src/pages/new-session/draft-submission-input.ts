import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { trimHumanMentions } from "../../lib/chat/human-mentions.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { buildChatApiAttachments } from "../chat/attachment-api.ts";
import { prepareBackgroundSessionCompletion } from "./background-session-notice.ts";
import type { DraftStartupResumption } from "./draft-session-startup.ts";
import type { PendingSessionPlacementRecoveryState } from "./session-placement-recovery-state.ts";

/** Freeze the selected or recovered input before creation can yield to another draft. */
export function prepareDraftSubmission(
  context: ApplicationContext,
  draft: {
    message: string;
    mentions: readonly HumanMention[];
    attachmentDraft: { attachments: ChatAttachment[] };
    pendingPlacement: PendingSessionPlacementRecoveryState;
  },
  agentId: string,
  startup?: DraftStartupResumption,
  background = false,
) {
  const pending = draft.pendingPlacement;
  const pendingPlacement = !startup && Boolean(pending.sessionKey);
  const submitted = trimHumanMentions(draft.message, draft.mentions);
  const message = startup?.params.message ?? (pendingPlacement ? pending.message : submitted.text);
  const mentions = (
    startup ? startup.params.mentions : pendingPlacement ? pending.mentions : submitted.mentions
  )?.map(({ profileId, start, end }) => ({ profileId, start, end }));
  const attachments = draft.attachmentDraft.attachments;
  const draftAttachments = startup
    ? startup.params.attachments
    : pendingPlacement
      ? undefined
      : buildChatApiAttachments(attachments);
  const apiAttachments = pendingPlacement ? pending.attachments : draftAttachments;
  const submissionAgentId =
    startup?.params.agentId ?? (pendingPlacement ? pending.agentId : normalizeAgentId(agentId));
  const gatewayUrl = pendingPlacement ? pending.gatewayUrl : context.gateway.connection.gatewayUrl;
  const client = context.gateway.snapshot.client;
  if (!client || !context.gateway.snapshot.hello) {
    return null;
  }
  const completeInBackground = prepareBackgroundSessionCompletion({
    enabled: background,
    agentId: submissionAgentId,
    client,
    context,
  });
  const recoveryScope = pendingPlacement ? pending.recoveryScope : client.recoveryScope;
  return {
    pendingPlacement,
    message,
    mentions,
    attachments,
    draftAttachments,
    apiAttachments,
    agentId: submissionAgentId,
    gatewayUrl,
    client,
    recoveryScope,
    completeInBackground,
    hasInitialTurn: Boolean(message || apiAttachments?.length),
  };
}

export function prepareDraftSubmissionTurn(
  context: ApplicationContext,
  input: NonNullable<ReturnType<typeof prepareDraftSubmission>>,
  createdAt: number,
) {
  const { hello, selfUser } = context.gateway.snapshot;
  const sender = resolveCurrentUserIdentity(hello, input.client.instanceId, selfUser) ?? undefined;
  return {
    text: input.message,
    mentions: input.mentions,
    attachments: input.attachments,
    createdAt,
    sender,
  };
}
