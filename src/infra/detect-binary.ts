// Detects safe executable names or paths without shell evaluation.
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { isSafeExecutableValue } from "./exec-safety.js";
import { isExecutableFile } from "./executable-path.js";
import { getWindowsSystem32ExePath } from "./windows-install-roots.js";

// Binary detection accepts safe executable names or explicit paths and avoids
// shell evaluation when probing PATH.
/** Return true when a safe executable name/path can be found on this host. */
export async function detectBinary(name: string): Promise<boolean> {
  if (!name?.trim()) {
    return false;
  }
  if (!isSafeExecutableValue(name)) {
    return false;
  }
  const resolved = name.startsWith("~") ? resolveUserPath(name) : name;
  if (
    path.isAbsolute(resolved) ||
    resolved.startsWith(".") ||
    resolved.includes("/") ||
    resolved.includes("\\")
  ) {
    // Callers execute this path as supplied. Let the filesystem resolve symlink/..
    // and trailing separators instead of changing their meaning with path.resolve.
    return isExecutableFile(resolved);
  }

  const command =
    process.platform === "win32"
      ? [getWindowsSystem32ExePath("where.exe"), name]
      : ["/usr/bin/env", "which", name];
  try {
    const result = await runCommandWithTimeout(command, { timeoutMs: 2000 });
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
