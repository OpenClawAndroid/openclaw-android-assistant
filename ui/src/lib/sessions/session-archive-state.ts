import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { projectSessionResultRows } from "./reconcile.ts";
import type { SessionArchiveVisibility } from "./session-capability.ts";

type ConfirmedArchiveState = Pick<
  GatewaySessionRow,
  "archivedAt" | "archivedBy" | "archiveReason" | "sessionId"
>;

export function createSessionArchiveState(
  publishedRow: (key: string) => GatewaySessionRow | undefined,
  onChange: () => void,
) {
  const confirmed = new Map<string, ConfirmedArchiveState>();
  const pending = new Map<string, { sessionId: string | undefined; token: symbol }>();
  const clear = (key: string) => {
    confirmed.delete(key.trim());
    pending.delete(key.trim());
  };
  return {
    clear,
    clearAll: () => {
      confirmed.clear();
      pending.clear();
    },
    observe: (key: string, archived: boolean | null, row?: GatewaySessionRow): void => {
      const normalizedKey = key.trim();
      if (!normalizedKey || archived === null) {
        return;
      }
      if (!archived) {
        // A worker-status event can still describe the unarchived session
        // while its archive request waits for cleanup.
        confirmed.delete(normalizedKey);
        return;
      }
      const previous = confirmed.get(normalizedKey);
      if (pending.get(normalizedKey)?.sessionId === row?.sessionId) {
        pending.delete(normalizedKey);
      }
      confirmed.set(normalizedKey, {
        archivedAt: row?.archivedAt ?? previous?.archivedAt,
        archivedBy: row?.archivedBy ?? previous?.archivedBy,
        archiveReason: row?.archiveReason ?? previous?.archiveReason,
        sessionId: row?.sessionId || previous?.sessionId,
      });
    },
    apply: (result: SessionsListResult | null): SessionsListResult | null => {
      if (!result || confirmed.size === 0) {
        return result;
      }
      const sessions = result.sessions.map((row) => {
        const archive = confirmed.get(row.key);
        if (!archive) {
          return row;
        }
        if (archive.sessionId && archive.sessionId !== row.sessionId) {
          // An id-less row may be a same-key replacement whose identity has not arrived.
          // Do not transfer archive state; retire it only after a different identity appears.
          if (row.sessionId) {
            confirmed.delete(row.key);
          }
          return row;
        }
        if (row.archived === true) {
          return row;
        }
        return {
          ...row,
          archived: true,
          ...(archive.archivedAt !== undefined ? { archivedAt: archive.archivedAt } : {}),
          ...(archive.archivedBy ? { archivedBy: archive.archivedBy } : {}),
          ...(archive.archiveReason ? { archiveReason: archive.archiveReason } : {}),
        };
      });
      return projectSessionResultRows(result, sessions);
    },
    visibility: (key: string): SessionArchiveVisibility | undefined => {
      const normalizedKey = key.trim();
      const pendingArchive = pending.get(normalizedKey);
      const row = publishedRow(normalizedKey);
      if (pendingArchive && (!row || row.sessionId === pendingArchive.sessionId)) {
        return "pending";
      }
      const archive = confirmed.get(normalizedKey);
      if (!archive) {
        return undefined;
      }
      // Share the archive confirmation with event-driven actions, but never
      // hide a same-key replacement whose durable identity does not match.
      return archive.sessionId && row && archive.sessionId !== row.sessionId
        ? undefined
        : "archived";
    },
    beginPending: (key: string, sessionId: string | undefined): (() => void) | null => {
      const normalizedKey = key.trim();
      const current = pending.get(normalizedKey);
      if (!normalizedKey || (current && current.sessionId === sessionId)) {
        return null;
      }
      const token = Symbol("session-archive");
      pending.set(normalizedKey, { sessionId, token });
      onChange();
      return () => {
        // A reconnect or same-key replacement can begin a newer archive.
        if (pending.get(normalizedKey)?.token !== token) {
          return;
        }
        pending.delete(normalizedKey);
        onChange();
      };
    },
  };
}
