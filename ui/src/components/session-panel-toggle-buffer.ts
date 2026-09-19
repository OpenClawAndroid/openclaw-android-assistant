import { normalizeDefaultMainSessionAliasForUi } from "../lib/sessions/session-key.ts";

export type SessionPanelToggleSlot = "browser" | "desktop" | "portal" | "terminal";

const INTENT_TTL_MS = 10_000;
const pendingToggles = new Map<string, { event: Event; createdAt: number }>();

function toggleKey(slot: SessionPanelToggleSlot, sessionKey?: string): string {
  return `${slot}:${sessionKey ? normalizeDefaultMainSessionAliasForUi(sessionKey) : ""}`;
}

export function panelToggleSessionKey(event: Event): string | undefined {
  return event instanceof CustomEvent && typeof event.detail?.sessionKey === "string"
    ? event.detail.sessionKey
    : undefined;
}

/**
 * The application shell exists before a session pane finishes mounting. Keep
 * the newest panel intent so an early command is delivered to that pane rather
 * than disappearing during route startup.
 */
export function rememberSessionPanelToggle(slot: SessionPanelToggleSlot, event: Event): void {
  for (const [key, pending] of pendingToggles) {
    if (Date.now() - pending.createdAt > INTENT_TTL_MS) {
      pendingToggles.delete(key);
    }
  }
  pendingToggles.set(toggleKey(slot, panelToggleSessionKey(event)), {
    event,
    createdAt: Date.now(),
  });
}

/** Clear an intent that the active pane already handled directly. */
export function clearSessionPanelToggle(slot: SessionPanelToggleSlot, event: Event): void {
  const key = toggleKey(slot, panelToggleSessionKey(event));
  if (pendingToggles.get(key)?.event === event) {
    pendingToggles.delete(key);
  }
}

/** Claim an intent only after a mounted pane becomes its active owner. */
export function takeSessionPanelToggle(
  slot: SessionPanelToggleSlot,
  sessionKey?: string,
): Event | null {
  const targetKey = toggleKey(slot, sessionKey);
  const key = pendingToggles.has(targetKey) ? targetKey : toggleKey(slot);
  const pending = pendingToggles.get(key) ?? null;
  pendingToggles.delete(key);
  return pending && Date.now() - pending.createdAt <= INTENT_TTL_MS ? pending.event : null;
}
