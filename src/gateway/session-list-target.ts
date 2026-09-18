import type { readSessionRowModelFacts } from "./session-row-model-facts.js";
import type { materializeSessionRow } from "./session-utils-row.js";

/** Cold rows prepare only the model facts needed by search. */
export type SessionListTargetLookup = (key: string) =>
  | {
      agentId: string;
      storeKey?: string;
      materialized?: Pick<ReturnType<typeof materializeSessionRow>, "source">;
      getModelFacts?: () => Pick<
        ReturnType<typeof readSessionRowModelFacts>,
        "selectedModel" | "rowModelIdentity" | "thinkingProjection"
      >;
    }
  | undefined;
