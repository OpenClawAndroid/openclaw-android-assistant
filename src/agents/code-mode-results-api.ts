const content = `type CodeModeResultReference = {
  id: string;
  bytes: number;
  /** Array length, object key count, or 1 for a scalar. */
  count: number;
  /** Shallow sample of field types, not a schema or validation guarantee. */
  shape: string;
  /** Bounded JSON prefix; may not be complete parseable JSON. */
  preview: string;
  previewTruncated: boolean;
};
/** Up to 64 references share min(memoryLimitBytes, maxSnapshotBytes) encoded JSON
 * bytes (10 MiB by default), separately from the cell inbox. Full stores reject
 * saves without evicting entries. References survive cells and wait, but expire
 * on agent-run end/abort, catalog replacement, permission changes, or restart.
 * Saved data is a snapshot, not current external state. Result operations are
 * unavailable in restartSafe cells because references are transient.
 */
declare const results: {
  /** Save normalized JSON for later cells. Returns the descriptor above: emit it directly;
   * its preview, shape, and count are already prepared. The full JSON stays stored.
   * Example: return await results.save(await tool({}));
   */
  save(value: unknown): Promise<CodeModeResultReference>;
  /** Read a detached JSON copy. Inspect the saved preview before using unknown fields. */
  load(id: string): Promise<unknown>;
  /** Free capacity. Missing or expired references reject. */
  delete(id: string): Promise<boolean>;
};`;

export const CODE_MODE_RESULTS_API_FILE = {
  path: "results.d.ts",
  description: "Temporary JSON results shared across cells in the current agent run.",
  bytes: Buffer.byteLength(content, "utf8"),
  content,
};
