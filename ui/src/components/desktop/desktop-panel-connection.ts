import type { DesktopObserveResult, WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import type { DesktopConnectionHandle, DesktopSizingMode } from "./desktop-client.ts";

export type DesktopAppId = WorkerDesktopAppId;
export type DesktopCredentials = { username?: string; password?: string };

export type PendingDesktopConnection = {
  environmentId: string;
  control: boolean;
  observed?: DesktopObserveResult;
  operationId: number;
};

export type ObservedDesktopConnection = PendingDesktopConnection & {
  observed: DesktopObserveResult;
};

/** Owns viewer handoff and bounded retention while the Desktop presenter is hidden. */
export class DesktopConnectionHandoff {
  private current: DesktopConnectionHandle | null = null;
  private retained: DesktopConnectionHandle | null = null;
  private connected = false;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;

  get handle(): DesktopConnectionHandle | null {
    return this.connected ? this.current : null;
  }

  begin(retainViewer: boolean): void {
    this.clearHiddenTimer();
    const retained = retainViewer ? (this.connected ? this.current : this.retained) : null;
    const current = this.current;
    const previous = this.retained;
    this.current = null;
    this.retained = retained;
    this.connected = false;
    if (current !== retained) {
      current?.disconnect();
    }
    if (previous !== retained) {
      previous?.disconnect();
    }
    retained?.disableInput();
  }

  /** Returns whether presentation needs a fresh source lookup. */
  setPresented(presented: boolean, retire: () => void): boolean {
    const retained = this.hiddenTimer !== null;
    this.clearHiddenTimer();
    if (presented) {
      if (retained) {
        this.current?.setPresented(true);
      }
      return !retained;
    }
    if (this.handle?.setPresented(false)) {
      this.hiddenTimer = setTimeout(retire, 30_000);
    } else {
      retire();
    }
    return false;
  }

  private clearHiddenTimer(): void {
    if (this.hiddenTimer !== null) {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
  }

  attach(handle: DesktopConnectionHandle): void {
    this.current = handle;
  }

  setSizingMode(mode: DesktopSizingMode): void {
    // Preparation hides the input handle, but sizing still belongs to the
    // current viewer. Never update the retained, retired controller.
    this.current?.setSizingMode(mode);
  }

  markConnected(): void {
    // A returned handle or observe result is not the RFB authentication boundary.
    this.connected = true;
    const retained = this.retained;
    this.retained = null;
    retained?.disconnect();
  }

  disconnect(): void {
    this.begin(false);
  }
}
