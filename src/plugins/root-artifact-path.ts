import path from "node:path";
import { isMissingPathError } from "../infra/errno.js";
import { pluginCacheExistsSync, readPluginCacheDirectory } from "./plugin-cache-files.js";

/** Resolves artifact paths in the caller's layout and filename preference order. */
export function resolvePluginRootArtifactPath(
  rootDir: string,
  artifactPaths: readonly string[],
): string | null {
  for (const artifactPath of artifactPaths) {
    const candidate = path.join(rootDir, artifactPath);
    if (path.dirname(artifactPath) !== ".") {
      try {
        if (readPluginCacheDirectory(path.dirname(candidate)).length === 0) {
          continue;
        }
      } catch (error) {
        // Directory-list permissions do not determine whether a child can be accessed.
        if (isMissingPathError(error)) {
          continue;
        }
      }
    }
    if (pluginCacheExistsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
