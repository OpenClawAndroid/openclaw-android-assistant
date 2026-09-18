import type { Tool as SdkTool } from "@github/copilot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools as createRealOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { createCopilotToolBridge as createCopilotToolBridgeImpl } from "./tool-bridge.js";

export type CopilotToolBridgeInput = Parameters<typeof createCopilotToolBridgeImpl>[0];
type CopilotToolBridgeAttemptParams = NonNullable<CopilotToolBridgeInput["attemptParams"]>;
type CopilotToolBridgeTestInput = Omit<
  CopilotToolBridgeInput,
  "agentId" | "attemptParams" | "modelId" | "modelProvider" | "sessionId" | "spawnWorkspaceDir"
> &
  Partial<Pick<CopilotToolBridgeInput, "agentId" | "modelId" | "modelProvider" | "sessionId">> & {
    spawnWorkspaceDir?: CopilotToolBridgeInput["spawnWorkspaceDir"];
    attemptParams?: Omit<CopilotToolBridgeAttemptParams, "hostCapabilities"> &
      Partial<Pick<CopilotToolBridgeAttemptParams, "hostCapabilities">>;
  };
export type CopilotCodingToolsOptions = NonNullable<
  Parameters<NonNullable<CopilotToolBridgeInput["createOpenClawCodingTools"]>>[0]
>;
export const testHostCapabilities = createCopilotTestHostCapabilities(
  createRealOpenClawCodingTools,
);

export function createCopilotToolBridge(input: CopilotToolBridgeTestInput) {
  const { attemptParams, ...baseInput } = input;
  const preparedInput: CopilotToolBridgeInput = {
    agentId: "agent-1",
    modelId: "gpt-4o",
    modelProvider: "github-copilot",
    sessionId: "session-1",
    spawnWorkspaceDir: undefined,
    ...baseInput,
    attemptParams: {
      ...attemptParams,
      hostCapabilities: attemptParams?.hostCapabilities ?? testHostCapabilities,
    },
  };
  return createCopilotToolBridgeImpl(preparedInput);
}
type ConvertToolOptions = Pick<
  CopilotToolBridgeInput,
  "abortSignal" | "beforeExecute" | "onToolCompleted"
> & {
  onAgentToolResult?: NonNullable<CopilotToolBridgeInput["attemptParams"]>["onAgentToolResult"];
  observeToolTerminal?: NonNullable<CopilotToolBridgeInput["attemptParams"]>["observeToolTerminal"];
};

export async function convertOpenClawToolToSdkToolForTest(
  sourceTool: AnyAgentTool,
  options: ConvertToolOptions,
): Promise<SdkTool> {
  const bridge = await createCopilotToolBridge({
    abortSignal: options.abortSignal,
    allowModelTools: true,
    attemptParams:
      options.onAgentToolResult || options.observeToolTerminal
        ? {
            ...(options.onAgentToolResult ? { onAgentToolResult: options.onAgentToolResult } : {}),
            ...(options.observeToolTerminal
              ? { observeToolTerminal: options.observeToolTerminal }
              : {}),
          }
        : undefined,
    beforeExecute: options.beforeExecute,
    createOpenClawCodingTools: async () => [sourceTool],
    modelId: "gpt-test",
    onToolCompleted: options.onToolCompleted,
  });
  return expectDefined(bridge.promptToolPolicy.apply().tools[0], "Copilot SDK tool");
}
