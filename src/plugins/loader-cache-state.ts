export class PluginLoadReentryError extends Error {
  readonly cacheKey: string;

  constructor(cacheKey: string) {
    super(`plugin load reentry detected for cache key: ${cacheKey}`);
    this.name = "PluginLoadReentryError";
    this.cacheKey = cacheKey;
  }
}

export class PluginLoaderCacheState<T> {
  readonly #defaultMaxEntries: number;
  #maxEntries: number;
  readonly #registryCache = new Map<string, T>();
  readonly #inFlightLoads = new Set<string>();
  readonly #openAllowlistWarningCache = new Set<string>();

  constructor(defaultMaxEntries: number) {
    this.#defaultMaxEntries = Math.max(1, Math.floor(defaultMaxEntries));
    this.#maxEntries = this.#defaultMaxEntries;
  }

  get maxEntries(): number {
    return this.#maxEntries;
  }

  setMaxEntriesForTest(value?: number): void {
    this.#maxEntries =
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.floor(value))
        : this.#defaultMaxEntries;
    this.#evictOldestEntries();
  }

  clear(): void {
    this.#registryCache.clear();
    this.#inFlightLoads.clear();
    this.#openAllowlistWarningCache.clear();
  }

  get(cacheKey: string): T | undefined {
    const cached = this.#registryCache.get(cacheKey);
    if (!cached) {
      return undefined;
    }
    this.#registryCache.delete(cacheKey);
    this.#registryCache.set(cacheKey, cached);
    return cached;
  }

  set(cacheKey: string, state: T): void {
    if (this.#registryCache.has(cacheKey)) {
      this.#registryCache.delete(cacheKey);
    }
    this.#registryCache.set(cacheKey, state);
    this.#evictOldestEntries();
  }

  isLoadInFlight(cacheKey: string): boolean {
    return this.#inFlightLoads.has(cacheKey);
  }

  beginLoad(cacheKey: string): void {
    if (this.#inFlightLoads.has(cacheKey)) {
      throw new PluginLoadReentryError(cacheKey);
    }
    this.#inFlightLoads.add(cacheKey);
  }

  finishLoad(cacheKey: string): void {
    this.#inFlightLoads.delete(cacheKey);
  }

  hasOpenAllowlistWarning(cacheKey: string): boolean {
    return this.#openAllowlistWarningCache.has(cacheKey);
  }

  recordOpenAllowlistWarning(cacheKey: string): void {
    this.#openAllowlistWarningCache.add(cacheKey);
  }

  #evictOldestEntries(): void {
    while (this.#registryCache.size > this.#maxEntries) {
      const oldestEntry = this.#registryCache.keys().next();
      if (oldestEntry.done) {
        break;
      }
      this.#registryCache.delete(oldestEntry.value);
    }
  }
}
