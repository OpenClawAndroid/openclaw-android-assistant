import { anchorFromNavigationEvent } from "../lib/navigation-click.ts";
import {
  hovercardBootstrapIntentActive,
  LazyHovercardBootstrap,
  remainingHovercardOpenDelay,
  type HovercardBootstrapTrigger,
} from "./lazy-hovercard-registration.ts";
import type { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";
import {
  LINK_READER_HOVERCARD_OPEN_DELAY_MS,
  LINK_READER_HOVERCARD_PROVIDER_TAG,
  resolveLinkReaderTarget,
} from "./link-reader-target.ts";

const bootstrap = new LazyHovercardBootstrap<LinkReaderHovercardProvider>({
  tag: LINK_READER_HOVERCARD_PROVIDER_TAG,
  load: async () => (await import("./link-reader-hovercard.ts")).LinkReaderHovercardProvider,
});

export function previewTargetForAnchor(anchor: HTMLAnchorElement) {
  const provider = bootstrap.providerFor(anchor);
  const target =
    provider?.client && provider.readers
      ? resolveLinkReaderTarget(anchor.href, provider.readers)
      : null;
  return target?.reader.linkReader.previewMethod ? target : null;
}

async function activateHovercard(event: Event, trigger: HovercardBootstrapTrigger): Promise<void> {
  if (trigger === "pointer" && event instanceof PointerEvent && event.pointerType === "touch") {
    return;
  }
  const anchor = anchorFromNavigationEvent(event);
  const target = anchor ? previewTargetForAnchor(anchor) : null;
  if (!anchor || !target) {
    return;
  }
  const startedAt = performance.now();
  try {
    await bootstrap.define();
  } catch {
    return;
  }
  const provider = bootstrap.providerFor(anchor);
  // Definition can precede Lit replaying values assigned before the lazy upgrade.
  await provider?.updateComplete;
  const current = previewTargetForAnchor(anchor);
  if (
    !provider ||
    !anchor.isConnected ||
    current?.reader !== target.reader ||
    current.href !== target.href ||
    !hovercardBootstrapIntentActive(anchor, trigger)
  ) {
    return;
  }
  provider.activateFromBootstrap(
    anchor,
    target,
    trigger,
    trigger === "pointer"
      ? remainingHovercardOpenDelay(startedAt, LINK_READER_HOVERCARD_OPEN_DELAY_MS)
      : 0,
  );
}

export async function prefetchLinkReader(
  anchor: HTMLAnchorElement,
  signal: AbortSignal,
): Promise<void> {
  const target = previewTargetForAnchor(anchor);
  const owner = bootstrap.providerFor(anchor);
  if (!target || !owner?.client?.connected || signal.aborted) {
    return;
  }
  const { client, agentId, readers } = owner;
  await bootstrap.define();
  const provider = bootstrap.providerFor(anchor);
  await provider?.updateComplete;
  if (
    signal.aborted ||
    !anchor.isConnected ||
    anchor.href !== target.href ||
    document.hidden ||
    provider !== owner ||
    provider.client !== client ||
    provider.agentId !== agentId ||
    provider.readers !== readers
  ) {
    return;
  }
  await provider.prefetch(target, signal);
}

bootstrap.install(activateHovercard);
