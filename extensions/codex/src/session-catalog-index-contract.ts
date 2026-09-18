import type { CodexThreadListParams } from "./app-server/protocol.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import type { CodexCatalogListRequest } from "./session-catalog-list-request.js";

type CodexCatalogIndexRead = (
  params: CodexThreadListParams,
  remainingRows: number,
  /** Foreground accounting is separate from the background hydration attempt. */
  request?: CodexCatalogListRequest,
) => Promise<{
  rows: CodexCatalogIndexRow[];
  excludedThreadIds?: string[];
  nextCursor?: string;
  backwardsCursor?: string;
}>;

export type CodexCatalogIndexOptions = {
  homeId: string;
  localSessionsRoot?: string;
  state?: CodexCatalogState;
  readNative: CodexCatalogIndexRead;
  requestTimeoutMs?: number;
  assertCurrent: () => void;
  runBackground?: (run: () => Promise<void>) => Promise<void>;
};
