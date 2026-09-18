import type { WorkerInferenceTerminalOutcome } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { AssistantMessage, Usage } from "../../llm/types.js";
import {
  projectWorkerProviderReplay,
  type WorkerMessageProjection,
} from "../../worker/transcript-message.js";

export type WorkerInferenceModelIdentity = {
  api: string;
  provider: string;
  model: string;
};

export const ERROR_MESSAGES = {
  "model-not-approved": "Model is not approved for this agent.",
  "invalid-context": "Inference context is invalid.",
  "epoch-mismatch": "Worker run epoch does not match.",
  "session-not-attached": "Worker session is not attached.",
  "provider-error": "Model provider request failed.",
  cancelled: "Inference request was cancelled.",
} as const satisfies Record<
  Extract<WorkerInferenceTerminalOutcome, { type: "error" }>["reason"],
  string
>;

export function inferenceError(
  reason: Extract<WorkerInferenceTerminalOutcome, { type: "error" }>["reason"],
  usage?: Usage,
  message: string = ERROR_MESSAGES[reason],
): WorkerInferenceTerminalOutcome {
  return {
    type: "error",
    reason,
    message,
    ...(usage ? { usage: structuredClone(usage) } : {}),
  };
}

export function projectWorkerInferenceTerminalMessage(params: {
  message: AssistantMessage;
  modelIdentity: WorkerInferenceModelIdentity;
  stopReason: Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">;
}): WorkerMessageProjection<Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"]> {
  const content = params.message.content.map((part) => {
    switch (part.type) {
      case "text":
        return {
          type: part.type,
          text: part.text,
          ...(part.textSignature ? { textSignature: part.textSignature } : {}),
        };
      case "thinking":
        return {
          type: part.type,
          thinking: part.thinking,
          ...(part.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
          ...(part.redacted !== undefined ? { redacted: part.redacted } : {}),
        };
      case "toolCall":
        return {
          type: part.type,
          id: part.id,
          name: part.name,
          arguments: structuredClone(part.arguments),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          ...(part.executionMode ? { executionMode: part.executionMode } : {}),
        };
      default:
        throw new Error("Unsupported assistant terminal content");
    }
  });
  const usage = params.message.usage;
  const projected: Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"] = {
    role: "assistant",
    // Provider adapters may retain transport scratch fields. Project the exact
    // closed worker schema so those fields cannot invalidate the terminal frame.
    content,
    api: params.modelIdentity.api,
    provider: params.modelIdentity.provider,
    model: params.modelIdentity.model,
    ...(params.message.responseModel ? { responseModel: params.message.responseModel } : {}),
    ...(params.message.responseId ? { responseId: params.message.responseId } : {}),
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      ...(usage.contextUsage?.state === "available"
        ? {
            contextUsage: {
              state: usage.contextUsage.state,
              promptTokens: usage.contextUsage.promptTokens,
              totalTokens: usage.contextUsage.totalTokens,
            },
          }
        : usage.contextUsage?.state === "unavailable"
          ? { contextUsage: { state: usage.contextUsage.state } }
          : {}),
      totalTokens: usage.totalTokens,
      cost: {
        input: usage.cost.input,
        output: usage.cost.output,
        cacheRead: usage.cost.cacheRead,
        cacheWrite: usage.cost.cacheWrite,
        total: usage.cost.total,
        ...(usage.cost.totalOrigin ? { totalOrigin: usage.cost.totalOrigin } : {}),
      },
    },
    stopReason: params.stopReason,
    timestamp: params.message.timestamp,
  };
  return projectWorkerProviderReplay({
    message: projected,
    providerReplay: params.message.providerReplay,
    purpose: "transcript",
  });
}
