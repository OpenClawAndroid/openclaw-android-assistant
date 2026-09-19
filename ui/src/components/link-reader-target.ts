import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";

export const LINK_READER_HOVERCARD_OPEN_DELAY_MS = 250;
export const LINK_READER_HOVERCARD_PROVIDER_TAG = "openclaw-link-reader-hovercard-provider";

export type LinkReaderTarget = { href: string; reader: ControlUiLinkReaderDescriptor };
export const EMPTY_LINK_READERS: readonly ControlUiLinkReaderDescriptor[] = [];
const patterns = new WeakMap<ControlUiLinkReaderDescriptor, RegExp | null>();

/** Installed plugins declare exact HTTPS hosts and bounded, anchored pathname patterns. */
export function resolveLinkReaderTarget(
  value: string,
  readers: readonly ControlUiLinkReaderDescriptor[],
): LinkReaderTarget | null {
  if (!value || value.length > 8192) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  for (const reader of readers) {
    if (!reader.linkReader.hosts.includes(url.hostname)) {
      continue;
    }
    let pattern = patterns.get(reader);
    if (pattern === undefined) {
      try {
        pattern = new RegExp(reader.linkReader.pathPattern, "u");
      } catch {
        pattern = null;
      }
      patterns.set(reader, pattern);
    }
    if (pattern?.test(url.pathname)) {
      return { href: url.href, reader };
    }
  }
  return null;
}

export function linkReaderTargetKey(target: LinkReaderTarget): string {
  const url = new URL(target.href);
  url.hash = "";
  return target.reader.pluginId + ":" + target.reader.id + ":" + url.href;
}

/** Response identity includes the reader and query; an anchor only selects within that document. */
export function linkReaderResponseMatchesTarget(target: LinkReaderTarget, value: unknown): boolean {
  const returned =
    typeof value === "string" ? resolveLinkReaderTarget(value, [target.reader]) : null;
  return returned !== null && linkReaderTargetKey(returned) === linkReaderTargetKey(target);
}
