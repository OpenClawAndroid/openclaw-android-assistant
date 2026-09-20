import { buildControlUiSessionPath } from "openclaw/plugin-sdk/session-discussion";
import { WORK_SESSIONS_PAGE_SIZE } from "../limits.js";
import type { WorkSession, WorkSessions } from "../work-sessions.js";
import { banner, href, shell, type PageContext } from "./page.js";
import { escapeHtml } from "./shared.js";

function sessionRow(ctx: PageContext, session: WorkSession): string {
  const path = buildControlUiSessionPath({
    namespace: "chat",
    sessionKey: session.key,
    fallbackAgentId: session.agentId,
    basePath: ctx.controlUiBasePath,
    mainKey: ctx.mainKey,
    exactKey: true,
  });
  if (!path) {
    return "";
  }
  const title = session.label || session.displayName || session.derivedTitle || "Untitled session";
  const actor = session.owner?.actor;
  const owner = actor?.label || (actor?.type === "agent" ? "Agent-owned" : "Unassigned");
  const status = session.status ?? "idle";
  const tone =
    status === "running" || status === "queued"
      ? "info"
      : status === "failed" || status === "timeout"
        ? "warning"
        : "neutral";
  return `<li class="oc-resource-list-item work-session"><div class="work-session-main"><a class="work-session-title" href="${escapeHtml(path)}" target="_top" data-work-session-key="${escapeHtml(session.key)}"${session.agentId ? ` data-work-session-agent="${escapeHtml(session.agentId)}"` : ""}>${escapeHtml(title)}</a><span class="muted">${escapeHtml(owner)}${session.projectId ? ` · ${escapeHtml(session.projectId)}` : ""}</span></div><div class="work-session-meta"><span class="oc-badge oc-badge-${tone}">${escapeHtml(status)}</span></div></li>`;
}

function workSessionList(ctx: PageContext, result: WorkSessions): string {
  if (!result.available) {
    return banner(
      "warning",
      '<strong class="oc-banner-title">Work sessions unavailable</strong><p>Refresh this page to retry. Stored activity reports are still available.</p>',
    );
  }
  const rows = result.sessions.map((session) => sessionRow(ctx, session)).join("");
  return rows
    ? `<ul class="oc-resource-list work-sessions">${rows}</ul>`
    : '<p class="oc-empty">No work sessions are visible to you.</p>';
}

export function renderWorkSessionsPreview(ctx: PageContext, result: WorkSessions): string {
  return `<section class="home-card work-sessions-panel oc-card"><div class="home-card-top"><div><div class="oc-eyebrow">on this server</div><h2>Work sessions</h2><p>What people are working on, linked to their conversations.</p></div><a class="panel-link oc-action" href="${escapeHtml(href(ctx.basePath, "sessions"))}">All work sessions <span aria-hidden="true">→</span></a></div>${workSessionList(ctx, result)}</section>`;
}

export function renderWorkSessionsPage(
  ctx: PageContext,
  result: WorkSessions,
  offset: number,
): string {
  const page = href(ctx.basePath, "sessions");
  const previous =
    offset > 0
      ? `<a class="oc-action oc-action-ghost" href="${escapeHtml(page)}?offset=${Math.max(0, offset - WORK_SESSIONS_PAGE_SIZE)}">Newer sessions</a>`
      : "";
  const next =
    result.available && result.nextOffset !== undefined
      ? `<a class="oc-action" href="${escapeHtml(page)}?offset=${result.nextOffset}">Older sessions</a>`
      : "";
  return shell(
    ctx,
    "Work sessions",
    `<header class="people-header"><div><div class="oc-eyebrow">on this server</div><h1>Work sessions</h1><p>Open a conversation to see the work behind it. Owners and status come from the current session, not GitHub activity counts.</p><p class="muted">Most recent activity first. Archived, incognito, automated, and hidden subagent sessions are excluded. Access follows your session permissions.</p></div><a class="oc-action oc-action-ghost" href="${escapeHtml(page)}">Refresh</a></header><section class="oc-card" aria-label="Work sessions">${workSessionList(ctx, result)}</section><nav class="actions" aria-label="Session pages">${previous}${next}</nav>`,
    "sessions",
  );
}
