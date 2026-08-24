type BareNullableSqliteDatatype = "INTEGER" | "TEXT";

type LazyAdditiveAgentColumnDefinition = {
  columnName: string;
  dataType: BareNullableSqliteDatatype;
  tableName: "session_nodes";
};

type TranscriptProjectionSourceColumnDefinition = {
  columnName: "source_generation";
  dataType: "TEXT";
  tableName: "session_transcript_display_state" | "session_transcript_index_state";
};

// Session responsibility is feature-local and remains absent until the first
// explicit assignment. Bare nullable declarations keep older readers safe.
export const FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS = [
  { columnName: "owner_actor_type", dataType: "TEXT", tableName: "session_nodes" },
  { columnName: "owner_actor_id", dataType: "TEXT", tableName: "session_nodes" },
  { columnName: "owner_assigned_by_type", dataType: "TEXT", tableName: "session_nodes" },
  { columnName: "owner_assigned_by_id", dataType: "TEXT", tableName: "session_nodes" },
  { columnName: "owner_assigned_at", dataType: "INTEGER", tableName: "session_nodes" },
] as const satisfies readonly LazyAdditiveAgentColumnDefinition[];

// Projection ownership is derived state. A missing value makes old rows stale,
// while the bare nullable column remains safe for older same-version readers.
export const TRANSCRIPT_PROJECTION_SOURCE_COLUMN_DEFINITIONS = [
  {
    columnName: "source_generation",
    dataType: "TEXT",
    tableName: "session_transcript_index_state",
  },
  {
    columnName: "source_generation",
    dataType: "TEXT",
    tableName: "session_transcript_display_state",
  },
] as const satisfies readonly TranscriptProjectionSourceColumnDefinition[];
