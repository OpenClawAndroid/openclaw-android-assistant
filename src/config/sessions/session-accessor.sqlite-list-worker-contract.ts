import type { Result } from "@openclaw/normalization-core/result";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
  type OpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import type { ExactSessionEntry } from "./session-accessor.sqlite-contract.js";
import type { SessionEntryCacheSnapshot } from "./session-accessor.sqlite-entry-cache.js";

export type SessionListWorkerError = {
  message: string;
  graph?: OpenClawStateWorkerErrorPayload;
  errcode?: number;
  errstr?: string;
};

export function encodeSessionListWorkerError(error: unknown): SessionListWorkerError {
  return {
    message: error instanceof Error ? error.message : String(error),
    graph: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
    ...(error instanceof Error && "errcode" in error && typeof error.errcode === "number"
      ? { errcode: error.errcode }
      : {}),
    ...(error instanceof Error && "errstr" in error && typeof error.errstr === "string"
      ? { errstr: error.errstr }
      : {}),
  };
}

export function decodeSessionListWorkerError(value: SessionListWorkerError): Error {
  const error = new Error(value.message);
  if (value.graph) {
    retainOpenClawStateWorkerErrorPayload(error, value.graph);
  }
  return Object.assign(hydrateOpenClawStateWorkerError(error, { includeOrdinary: true }), {
    ...(value.errcode === undefined ? {} : { errcode: value.errcode }),
    ...(value.errstr === undefined ? {} : { errstr: value.errstr }),
  });
}

export type SessionListPageRead = {
  entries: ExactSessionEntry[];
  membershipKeys: string[];
};

type ReadInput = { validateCanonical: boolean; mainKey: string };
export type SessionListWorkerOperations = {
  inventory: {
    input: ReadInput;
    output: Result<
      (SessionEntryCacheSnapshot & { mainKey: string }) | undefined,
      SessionListWorkerError
    >;
  };
  selected: {
    input: ReadInput & { requests: string[][]; membershipIdentityId?: string };
    output: Result<
      | { results: Array<Result<SessionListPageRead, SessionListWorkerError>>; mainKey: string }
      | undefined,
      SessionListWorkerError
    >;
  };
};
