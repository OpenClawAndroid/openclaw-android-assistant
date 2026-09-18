type CurrencyOptions = {
  local: boolean;
  reconcileFiles(): Promise<void>;
  reconcileNative(): Promise<void>;
  runBackground?: (run: () => Promise<void>) => Promise<void>;
  report(error: unknown): void;
};

/** One periodic reconciliation cycle per home, without a recursive watcher inventory. */
export class CodexCatalogCurrency {
  private timer: ReturnType<typeof setInterval> | undefined;
  private initial: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: CurrencyOptions) {}

  hasActiveWork(): boolean {
    return this.initial !== undefined || this.running !== undefined;
  }

  start(): void {
    if (this.closed || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.running) {
        return;
      }
      const run = async () => {
        await this.options.reconcileFiles();
        await this.options.reconcileNative();
      };
      this.running = (this.options.runBackground ? this.options.runBackground(run) : run())
        .catch((error: unknown) => this.options.report(error))
        .finally(() => {
          this.running = undefined;
        });
    }, 30_000);
    this.timer.unref();
    if (this.options.local) {
      // Restored snapshots serve immediately; the initial delta scan runs separately.
      this.initial = setTimeout(() => {
        this.initial = undefined;
        void this.options.reconcileFiles().catch((error: unknown) => this.options.report(error));
      }, 0);
      this.initial.unref();
    }
  }

  close(): Promise<void> | undefined {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.initial);
    this.initial = undefined;
    return this.running;
  }
}
