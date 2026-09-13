import { Type } from "typebox";

const sessionProperties = {
  sessionId: Type.String(),
  name: Type.Optional(Type.String()),
};
const inputProperties = {
  stdinWritable: Type.Boolean(),
  waitingForInput: Type.Boolean(),
  idleMs: Type.Number(),
  lastOutputAt: Type.Number(),
};
const exitProperties = {
  exitCode: Type.Optional(Type.Number()),
  exitSignal: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  exitReason: Type.Optional(Type.String()),
  timedOut: Type.Optional(Type.Boolean()),
  noOutputTimedOut: Type.Optional(Type.Boolean()),
};
const terminalStatus = Type.Union([Type.Literal("completed"), Type.Literal("failed")]);
const sessionListProperties = {
  ...sessionProperties,
  startedAt: Type.Number(),
  runtimeMs: Type.Number(),
  cwd: Type.Optional(Type.String()),
  command: Type.String(),
  tail: Type.String(),
  truncated: Type.Boolean(),
};
const closed = { additionalProperties: false } as const;

/** Structured process details, shared by eager and lazy tool construction. */
export const ProcessToolOutputSchema = Type.Union([
  Type.Object({ status: Type.Literal("failed"), error: Type.String() }, closed),
  Type.Object(
    {
      status: Type.Literal("completed"),
      sessions: Type.Array(
        Type.Union([
          Type.Object(
            {
              ...sessionListProperties,
              status: Type.Literal("running"),
              pid: Type.Optional(Type.Number()),
              ...inputProperties,
            },
            closed,
          ),
          Type.Object(
            {
              ...sessionListProperties,
              status: Type.Union([terminalStatus, Type.Literal("killed")]),
              endedAt: Type.Number(),
              ...exitProperties,
            },
            closed,
          ),
        ]),
      ),
    },
    closed,
  ),
  Type.Object({ status: Type.Literal("running"), ...sessionProperties }, closed),
  Type.Object(
    {
      status: Type.Literal("running"),
      ...sessionProperties,
      ...inputProperties,
      aggregated: Type.String(),
      retryInMs: Type.Optional(Type.Number()),
    },
    closed,
  ),
  Type.Object(
    { status: terminalStatus, ...sessionProperties, ...exitProperties, aggregated: Type.String() },
    closed,
  ),
  Type.Object(
    {
      status: Type.Union([Type.Literal("running"), terminalStatus]),
      ...sessionProperties,
      ...exitProperties,
      ...Type.Partial(Type.Object(inputProperties)).properties,
      output: Type.String(),
      total: Type.Number(),
      totalLines: Type.Number(),
      totalChars: Type.Number(),
      truncated: Type.Boolean(),
    },
    closed,
  ),
  Type.Object({ status: Type.Literal("completed"), name: Type.Optional(Type.String()) }, closed),
]);
