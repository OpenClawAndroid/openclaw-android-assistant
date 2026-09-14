import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { z } from "zod";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

const nativeErrorDetailsSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  errcode: z.number().optional(),
});

export const agentSchemaInspectionErrorSchema = nativeErrorDetailsSchema.extend({
  name: z.string(),
  cause: nativeErrorDetailsSchema.optional(),
  stateError: z.unknown().optional(),
});

type InspectionError = z.infer<typeof agentSchemaInspectionErrorSchema>;

function nativeErrorDetails(error: Error) {
  // SAFETY: Node's filesystem and SQLite errors attach these optional diagnostic fields.
  const nativeError = error as Error & { code?: string; errcode?: number };
  return { message: error.message, code: nativeError.code, errcode: nativeError.errcode };
}

export function serializeAgentSchemaInspectionError(value: unknown): InspectionError {
  const error = toStringifiedError(value);
  return {
    name: error.name,
    ...nativeErrorDetails(error),
    ...(error.cause instanceof Error ? { cause: nativeErrorDetails(error.cause) } : {}),
    stateError: encodeOpenClawStateWorkerError(error),
  };
}

export function restoreAgentSchemaInspectionError(value: InspectionError): Error {
  const cause = value.cause
    ? Object.assign(new Error(value.cause.message), value.cause)
    : undefined;
  const error = Object.assign(new Error(value.message, cause ? { cause } : undefined), {
    name: value.name,
    code: value.code,
    errcode: value.errcode,
  });
  if (value.stateError) {
    retainOpenClawStateWorkerErrorPayload(error, value.stateError);
  }
  return hydrateOpenClawStateWorkerError(error);
}
