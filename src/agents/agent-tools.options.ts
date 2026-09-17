import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import type { ChatType } from "../channels/chat-type.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GroupToolPolicyConfig } from "../config/types.tools.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { SkillSnapshot, SkillUsagePath } from "../skills/types.js";
import type { SkillWorkshopRunOptions } from "../skills/workshop/types.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";
import type { ToolOutcomeObserver } from "./agent-tools.before-tool-call.js";
import type { SkillInstructionDeliveryCache } from "./agent-tools.read.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import type { ProcessToolDefaults } from "./bash-tools.process.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import type { ConversationRecallContext } from "./conversation-recall.types.js";
import type { OpenClawCodingToolConstructionPlan } from "./core-tool-factory-descriptors.js";
import type { DelegationCapability } from "./delegation-capability.js";
import type { ModelAuthMode } from "./model-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import type { SandboxContext } from "./sandbox.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { TrustedSubagentCompletionHandoff } from "./subagents/announce/subagent-announce-handoff.js";
import type { PreparedSessionPermissionPolicy } from "./tool-fs-policy.js";
import type {
  ToolSearchCatalogRef,
  ToolSearchCatalogToolExecutor,
  ToolSearchToolContext,
} from "./tool-search.js";
import type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./tools/cron-tool.js";
import type { CronToolOptions } from "./tools/cron-tool.types.js";
import type { QuestionPromptDelivery } from "./tools/question-prompt-send.js";

/** Public options for building one plugin-owned agent tool surface. */
export type OpenClawCodingToolsOptions = {
  agentId?: string;
  /** Retained policy owner; execution identity remains agentId/runSessionKey. */
  policyAgentId?: string;
  exec?: ExecToolDefaults & ProcessToolDefaults;
  messageProvider?: string;
  /** Canonical transport channel when tool-policy provider differs from delivery channel. */
  messageChannel?: string;
  /**
   * How this run shows a blocking question tool's prompt. Left unset by harnesses
   * whose tool lifecycle reserves the prompt for them.
   */
  questionPrompt?: QuestionPromptDelivery;
  /** Capabilities declared by the gateway client that originated this run. */
  clientCaps?: string[];
  gatewayUiCommandTarget?: import("../gateway/ui-command-target.types.js").GatewayUiCommandTarget;
  /** Host-admitted dashboard authoring without an originating inline renderer. */
  pinnedWidgetAuthoring?: boolean;
  /** Out-of-band plugin bindings attached by the run initiator. */
  toolBindings?: Readonly<Record<string, unknown>>;
  /** Trusted runtime-only authorization for one bounded cross-conversation recall pass. */
  conversationRecall?: ConversationRecallContext;
  /** Normalized conversation kind when the caller already has channel metadata. */
  chatType?: ChatType;
  /** Specific ingress provider used only for transport tool availability. */
  toolPolicyMessageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  /** Trusted platform-native conversation id for the active inbound turn. */
  nativeChannelId?: string;
  /** Opaque host-issued capability for current-turn channel message actions. */
  messageActionTurnCapability?: string;
  sandbox?: SandboxContext | null;
  stagedMediaPaths?: ReadonlyMap<string, string>;
  sessionKey?: string;
  /**
   * The durable store session key for the live run when it differs from the
   * sandbox/policy session key used to construct the tool set.
   */
  runSessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  /**
   * Explicit one-shot local CLI runs should not keep plugin-owned process
   * resources alive after emitting their result.
   */
  oneShotCliRun?: boolean;
  /** Stable run identifier for this agent invocation. */
  runId?: string;
  requesterThinkingLevel?: ThinkLevel;
  requesterModel?: SpawnedToolContext["requesterModel"];
  /** Exact admitted run instance for lifecycle-bound subprocess capabilities. */
  operationalRunInstance?: OperationalRunInstanceRef;
  /** Session-owned desktop resolved before optional paired-node discovery. */
  computerTransport?: import("./tools/computer-tool.js").ComputerToolTransport | null;
  /** Host-prepared effective paired-node Computer Use surface. */
  pairedNodeComputerUse?: import("./computer-use-node-capabilities.js").PreparedPairedComputerUse;
  /** Device-scoped operator session allowed to review approvals initiated by this run. */
  approvalReviewerDeviceId?: string;
  /** Diagnostic trace context for hook/log correlation during this run. */
  trace?: DiagnosticTraceContext;
  /** What initiated this run (for trigger-specific tool restrictions). */
  trigger?: string;
  /** Stable cron job identifier populated for cron-triggered runs. */
  jobId?: string;
  /** Relative workspace path that memory-triggered writes may append to. */
  memoryFlushWritePath?: string;
  agentDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  /** Task working directory for coding tools. Defaults to workspaceDir. */
  cwd?: string;
  workspaceDir?: string;
  /** Additional containment for a trusted scheduled workspace; never weakens configured policy. */
  requireWorkspaceOnly?: true;
  sessionPermissionPolicy?: PreparedSessionPermissionPolicy;
  /**
   * Workspace directory that spawned subagents should inherit.
   * When sandboxing uses a copied workspace (`ro` or `none`), workspaceDir is the
   * sandbox copy but subagents should inherit the real agent workspace instead.
   * Defaults to workspaceDir when not set.
   */
  spawnWorkspaceDir?: string;
  config?: OpenClawConfig;
  /** Explicitly distinguishes live Gateway session policy from a pinned run override. */
  sessionConfigSource?: "runtime" | "pinned";
  /** Host-bound target for auxiliary history/search, separate from execution identity. */
  sessionReadScopeKey?: string;
  abortSignal?: AbortSignal;
  /** Disable hook-owned diagnostics when an outer runtime owns tool diagnostics. */
  emitBeforeToolCallDiagnostics?: boolean;
  /** Skip hook wrapping when an outer tool-call boundary owns hook execution. */
  wrapBeforeToolCallHook?: boolean;
  /**
   * Provider of the currently selected model (used for provider-specific tool quirks).
   * Example: "anthropic", "openai", "google", "openai".
   */
  modelProvider?: string;
  /** Model id for the current provider (used for model-specific tool gating). */
  modelId?: string;
  /** Internal review-run restrictions and proposal provenance. */
  skillWorkshop?: SkillWorkshopRunOptions;
  /** Attempt-local authority to start or redirect delegated work. */
  delegationCapability?: DelegationCapability;
  /** Model API for the current provider (used for provider-native tool arbitration). */
  modelApi?: string;
  /** Model context window in tokens (used to scale read-tool output budget). */
  modelContextWindowTokens?: number;
  /** Resolved runtime model compatibility hints. */
  modelCompat?: ModelCompatConfig;
  /** If false, keep OpenClaw web_search even when a provider-native search tool is active. */
  suppressManagedWebSearch?: boolean;
  webFetchHostnameAllowlistRef?: { value?: string[] };
  webSearchEnabled?: boolean;
  /**
   * Auth mode for the current provider. We only need this for Anthropic OAuth
   * tool-name blocking quirks.
   */
  modelAuthMode?: ModelAuthMode;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Routable target for the current conversation when it differs from the native channel ID. */
  currentMessagingTarget?: string;
  /** Normalized conversation id exposed to tool hooks. Defaults to currentChannelId. */
  hookChannelId?: string;
  /** Channel-owned sender/chat metadata exposed to subprocess environments. */
  channelContext?: PluginHookChannelContext;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Current inbound message id for action fallbacks (e.g. Telegram react). */
  currentMessageId?: string | number;
  /** True when the current inbound turn carried audio media. */
  currentInboundAudio?: boolean;
  /** Dynamic audio state for runs that can accept steered input after tool creation. */
  hasCurrentInboundAudio?: () => boolean;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Trusted provider role ids for the requester in this group turn. */
  memberRoleIds?: string[];
  /** Parent session key for subagent group policy inheritance. */
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** Allow plugin tools for this run to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
  /** Runtime-scoped explicit allowlist used to materialize matching plugin tools. */
  runtimeToolAllowlist?: string[];
  /** Host-prepared proof that this exact session can request Gateway publication. */
  githubPublicationAvailable?: boolean;
  /** True when runtimeToolAllowlist is real parent authority that child sessions inherit. */
  inheritRuntimeToolAllowlist?: boolean;
  /** Mutable spawn capability snapshot refreshed after late-bound runtime tools are authorized. */
  inheritedToolAllowlistRef?: string[];
  /** Mutable cron creator cap ref for callers that append final runtime tools later. */
  cronCreatorToolAllowlistRef?: CronCreatorToolAllowlistEntry[];
  /** Mutable proof that the cron cap reached the final executable surface. */
  cronCreatorToolAllowlistCaptureRef?: CronToolsAllowCaptureRef;
  /** Visible fail-closed reason for queued Codex configured-MCP cron mutations. */
  cronCreatorAuthorityUnavailableReason?: CronToolOptions["creatorAuthorityUnavailableReason"];
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** Mutable model-context generation used to expire screenshot coordinate frames. */
  computerContextEpoch?: { value: number };
  /** Attempt-local full skill reads that remain visible in the model context. */
  skillInstructionDeliveryCache?: SkillInstructionDeliveryCache;
  /** Registers run-owned cleanup for tools that hold node resources. */
  registerRunCleanup?: (cleanup: (reason: string) => Promise<void>) => void;
  /** Require explicit message targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** Visible source replies must be sent through the message tool when set to message_tool_only. */
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Action sink available for model-proposed follow-up tasks. */
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  inboundEventKind?: InboundEventKind;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  /** Collector runs never open operator approval flows. */
  swarmCollector?: boolean;
  /** Synthetic structured_output schema for collector runs. */
  swarmOutputSchema?: Record<string, unknown>;
  /** Keep the message tool available even when the selected profile omits it. */
  forceMessageTool?: boolean;
  /** Include the heartbeat response tool for structured heartbeat outcomes. */
  enableHeartbeatTool?: boolean;
  /** Keep the heartbeat response tool available even when the selected profile omits it. */
  forceHeartbeatTool?: boolean;
  /** If false, build plugin tools only while preserving the shared policy pipeline. */
  includeCoreTools?: boolean;
  /** Include Tool Search control tools when enabled for this run. */
  includeToolSearchControls?: boolean;
  /** Executes cataloged tools through the active agent run lifecycle. */
  toolSearchCatalogExecutor?: ToolSearchCatalogToolExecutor;
  /** Runtime-local Tool Search catalog ref shared with attempt compaction. */
  toolSearchCatalogRef?: ToolSearchCatalogRef;
  /** Already-admitted skill locations for mistaken tool-id recovery. */
  codeModeSkills?: ToolSearchToolContext["codeModeSkills"];
  /** Limits which tool families are materialized before the shared policy pipeline runs. */
  toolConstructionPlan?: OpenClawCodingToolConstructionPlan;
  /** Ring-zero OpenClaw tool; set only by the OpenClaw agent runner. */
  systemAgentTool?: import("./tools/system-agent-tool.js").SystemAgentToolOptions;
  /** Trusted sender identity bit for command/channel-action auth and owner-gated plugin tools. */
  senderIsOwner?: boolean;
  /** Auth profiles already loaded for this run; used for prompt-time tool availability. */
  authProfileStore?: AuthProfileStore;
  /** Callback invoked when sessions_yield tool is called. */
  onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
  /** Side-effect-free runtime completion claimant composed with the durable subagent claim. */
  claimYieldCompletion?: () => boolean | Promise<boolean>;
  /** Optional instrumentation callback for tool preparation stage timing. */
  recordToolPrepStage?: (name: string) => void;
  /** Live observer called after wrapped tool outcomes are recorded. */
  onToolOutcome?: ToolOutcomeObserver;
  /** Reads the sticky untrusted-content flag for the current user turn. */
  isTurnTainted?: () => boolean;
  /** Supplies run-global model-call ordering for parallel tool outcomes. */
  allocateToolOutcomeOrdinal?: (toolCallId?: string) => number;
  /** Runtime-only resolved skill paths that the read tool may load under workspaceOnly. */
  skillsSnapshot?: SkillSnapshot;
  /** Original identities for sandbox-materialized skill instruction paths. */
  skillUsagePaths?: SkillUsagePath[];
  /** Prepared conversation-scoped facts for callers that already resolved this run context. */
  conversationCapabilityProfile?: ResolvedConversationCapabilityProfile;
  /** Trusted conversation policy prepared at channel ingress. */
  conversationToolPolicy?: GroupToolPolicyConfig;
  inputProvenance?: InputProvenance;
  /** Consumed in-process completion capability; never derived from model-facing input. */
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  /** Trusted server-stamped authority for an explicitly capped scheduled run. */
  scheduledToolPolicy?: ScheduledToolPolicyContext;
};
