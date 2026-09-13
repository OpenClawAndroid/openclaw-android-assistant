import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";

export function renderSessionActivitySummary(
  row: GatewaySessionRow,
  onRetry?: (row: GatewaySessionRow) => void,
) {
  const summary = row.activitySummary;
  const state =
    summary?.state === "current" && !summary.text ? "missing" : (summary?.state ?? "missing");
  const feedback =
    state === "updating"
      ? t("activityFeed.recapUpdating")
      : state === "stale"
        ? t("activityFeed.recapStale")
        : state === "unavailable"
          ? t("activityFeed.recapUnavailable")
          : state === "missing"
            ? t("activityFeed.recapMissing")
            : "";
  return html`<div
    class="activity-feed__recap"
    data-activity-recap=${row.key}
    data-state=${state}
    aria-label=${t("activityFeed.recap")}
    title=${
      summary?.updatedAt
        ? t("activityFeed.recapUpdated", {
            time: formatRelativeTimestamp(summary.updatedAt, { fallback: "" }),
          })
        : nothing
    }
  >
    ${summary?.text ? html`<p class="activity-feed__recap-text">${summary.text}</p>` : nothing}
    ${
      feedback
        ? html`<div class="activity-feed__recap-feedback">
            <span>${feedback}</span>
            ${
              onRetry &&
              summary?.canEnsure === true &&
              (state === "unavailable" || state === "stale")
                ? html`<button class="activity-feed__recap-retry" @click=${() => onRetry(row)}>
                    ${t("activityFeed.recapRetry")}
                  </button>`
                : nothing
            }
          </div>`
        : nothing
    }
  </div>`;
}
