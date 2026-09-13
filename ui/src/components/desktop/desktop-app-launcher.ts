import type {
  DesktopSource,
  WorkerDesktopAppId,
  WorkerDesktopLaunchResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";

/** Keeps app-launch feedback scoped to the current desktop presentation. */
export class DesktopAppLauncher {
  app: WorkerDesktopAppId | null = null;
  error: string | null = null;
  private operationId = 0;

  constructor(private readonly onChange: () => void) {}

  clear(): void {
    this.operationId += 1;
    this.app = null;
    this.error = null;
    this.onChange();
  }

  async launch(
    client: GatewayBrowserClient,
    source: DesktopSource,
    app: WorkerDesktopAppId,
  ): Promise<void> {
    const operationId = ++this.operationId;
    this.app = app;
    this.error = null;
    this.onChange();
    try {
      await client.request<WorkerDesktopLaunchResult>("desktop.launch", { source, app });
    } catch (error) {
      if (operationId !== this.operationId) {
        return;
      }
      this.error = formatUiError(error);
    }
    if (operationId === this.operationId) {
      this.app = null;
      this.onChange();
    }
  }
}
