import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { isToolCardError } from "../../../lib/chat/tool-cards.ts";

/** Status belongs in the disclosure; diagnostics stay in the expanded tool output. */
export function renderToolFailures(cards: readonly ToolCard[], includeCount = true) {
  const failures = cards.filter(isToolCardError);
  const first = failures[0];
  if (!first) {
    return nothing;
  }
  const outcome =
    first.exitCode === undefined
      ? t("chat.toolCards.failed")
      : t("chat.toolCards.exitCode", { code: String(first.exitCode) });
  return html`<span class="chat-tool-failure"
    >${
      includeCount ? t("chat.toolCards.failureCount", { count: String(failures.length) }) : outcome
    }</span
  >`;
}
