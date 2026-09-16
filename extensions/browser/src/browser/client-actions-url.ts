/**
 * URL and JSON request construction for browser clients.
 */
import { fetchBrowserJson } from "./client-fetch.js";

/** Prefix a browser-control path with an optional base URL and profile query. */
export function withBaseUrl(baseUrl: string | undefined, path: string, profile?: string): string {
  const profilePath = profile
    ? `${path}${path.includes("?") ? "&" : "?"}profile=${encodeURIComponent(profile)}`
    : path;
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return profilePath;
  }
  return `${trimmed.replace(/\/$/, "")}${profilePath}`;
}

/** Send an explicit JSON payload without including transport options in the body. */
export async function postBrowserJson<T>(
  baseUrl: string | undefined,
  path: string,
  body: object,
  timeoutMs: number,
  opts?: { profile?: string; signal?: AbortSignal },
): Promise<T> {
  return await fetchBrowserJson<T>(withBaseUrl(baseUrl, path, opts?.profile), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
    signal: opts?.signal,
  });
}
