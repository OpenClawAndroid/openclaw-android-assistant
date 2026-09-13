import { LitElement } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import { sessionProgressCardsForGateway } from "../lib/session-progress-cards.ts";
import { SessionProgressCardController } from "./session-progress-card-controller.ts";

describe("SessionProgressCardController", () => {
  it.each([true, false])(
    "keeps queued updates detached and reconnects once (session target: %s)",
    async (hasTarget) => {
      const target = hasTarget ? { sessionKey: "agent:main:progress-lifecycle" } : null;
      const request = vi.fn().mockResolvedValue({ card: null });
      const active = { snapshots: 0, events: 0 };
      const gateway = {
        snapshot: { phase: "connected", client: { request }, hello: null },
        subscribe: () => {
          active.snapshots += 1;
          return () => {
            active.snapshots -= 1;
          };
        },
        subscribeEvents: () => {
          active.events += 1;
          return () => {
            active.events -= 1;
          };
        },
      } as unknown as ApplicationGateway;
      const store = sessionProgressCardsForGateway(gateway);
      const subscribe = vi.spyOn(store, "subscribe");
      const watch = vi.spyOn(store, "watch");
      class ProgressHost extends LitElement {
        readonly progress = new SessionProgressCardController(this, {
          gateway: () => gateway,
          target: () => target,
        });
      }
      customElements.define(`test-progress-controller-${hasTarget}`, ProgressHost);
      const host = new ProgressHost();
      onTestFinished(() => {
        host.remove();
        vi.restoreAllMocks();
      });

      for (let connections = 1; connections <= 2; connections += 1) {
        document.body.append(host);
        await host.updateComplete;
        if (target) {
          await store.load(target);
          await host.updateComplete;
        }
        expect(subscribe).toHaveBeenCalledTimes(connections);
        expect(watch).toHaveBeenCalledTimes(hasTarget ? connections : 0);
        expect(request).toHaveBeenCalledTimes(hasTarget ? connections : 0);
        expect(active).toEqual({ snapshots: 1, events: 1 });

        // Lit still flushes this update after disconnectedCallback has released the store.
        host.requestUpdate();
        expect(host.isUpdatePending).toBe(true);
        host.remove();
        expect(active).toEqual({ snapshots: 0, events: 0 });
        await host.updateComplete;
        expect(host.isConnected).toBe(false);
        expect(active).toEqual({ snapshots: 0, events: 0 });
        expect(subscribe).toHaveBeenCalledTimes(connections);
        expect(watch).toHaveBeenCalledTimes(hasTarget ? connections : 0);
        expect(request).toHaveBeenCalledTimes(hasTarget ? connections : 0);
      }
    },
  );
});
