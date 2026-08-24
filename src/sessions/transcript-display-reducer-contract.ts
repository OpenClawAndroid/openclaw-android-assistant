import type { PreparedSessionTranscriptDisplayCanvas } from "./transcript-display-classification.js";

export type SessionTranscriptDisplayRowKind =
  | "assistant"
  | "compaction"
  | "opaque"
  | "reset"
  | "user";

type SessionTranscriptDisplayRelation =
  | "message_tool_mirror"
  | "message_tool_result"
  | "tts_supplement"
  | "turn_boundary";

export type SessionTranscriptDisplayCarryKind =
  | "canvas_pending"
  | "heartbeat_boundary"
  | "message_tool"
  | "stream_error"
  | "tts_candidate";

type PreparedSessionTranscriptDisplaySource = {
  position: number;
  relation: SessionTranscriptDisplayRelation;
  sourceEventSeq: number;
  sourceOccurrence: number;
};

export type PreparedSessionTranscriptDisplayCarry = {
  deliveryEventSeq?: number;
  kind: SessionTranscriptDisplayCarryKind;
  position: number;
  relatedEventSeq?: number;
  sourceEventSeq: number;
  sourceOccurrence: number;
};

type SessionTranscriptDisplaySourceReference = {
  sourceEventSeq: number;
  sourceOccurrence: number;
};

type PlannedSessionTranscriptDisplayRow = {
  canvases: PreparedSessionTranscriptDisplayCanvas[];
  kind: SessionTranscriptDisplayRowKind;
  semanticSources: PreparedSessionTranscriptDisplaySource[];
  sourceEventSeq: number;
};

export type PreparedSessionTranscriptDisplayRow = PlannedSessionTranscriptDisplayRow & {
  displayOrdinal: number;
  revision: number;
  rowId: string;
  rowVersion: number;
};

export type DisplayReducerRow = PlannedSessionTranscriptDisplayRow & {
  displayOrdinal: number;
  revision: number;
  rowId: string;
};

export type DisplayReducerEffects = {
  addCanvases: (
    row: DisplayReducerRow,
    sourceEventSeq: number,
    canvases: Array<Omit<PreparedSessionTranscriptDisplayCanvas, "position">>,
  ) => void;
  addRelation: (
    row: DisplayReducerRow,
    relation: SessionTranscriptDisplayRelation,
    sources: readonly SessionTranscriptDisplaySourceReference[],
  ) => void;
  appendRow: (kind: SessionTranscriptDisplayRowKind, sourceEventSeq: number) => DisplayReducerRow;
  beginSource: () => void;
  findRow: (sourceEventSeq: number) => DisplayReducerRow | undefined;
  removeCanvases: (sourceEventSeq: number) => void;
  replaceStreamRows: (
    pendingSourceEventSeqs: readonly number[],
    sourceEventSeq: number,
  ) => DisplayReducerRow;
};

export type DisplayReducerState = {
  carry: PreparedSessionTranscriptDisplayCarry[];
  effects: DisplayReducerEffects;
  readEvent: (sourceEventSeq: number) => unknown;
};

export type { PreparedSessionTranscriptDisplayCanvas };
