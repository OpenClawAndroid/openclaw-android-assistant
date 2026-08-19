/**
 * Version and package pins for the managed Codex app-server runtime.
 */
/** Exact Codex app-server version shipped by the OpenClaw Codex bridge. */
export const CODEX_APP_SERVER_VERSION = "0.147.0";
/** Inclusive runtime compatibility floor for external app-server binaries. */
export const MIN_SUPPORTED_CODEX_APP_SERVER_VERSION = "0.147.0";
/** Inclusive runtime compatibility ceiling for external app-server binaries. */
// The ceiling is the newest Desktop build covered by upstream source inspection and
// a live Computer Use flow. Raising it requires equivalent protocol and live proof.
export const MAX_SUPPORTED_CODEX_APP_SERVER_VERSION = "0.148.0-alpha.15";
/** npm package name for the managed Codex app-server binary. */
export const MANAGED_CODEX_APP_SERVER_PACKAGE = "@openai/codex";
