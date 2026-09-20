import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";

const LEGACY_CAPTURE_PREFIXES = ["openclaw-plugin-build-", "openclaw-model-catalog-"];

/** Legacy roots have no custody token; inspection never authorizes their removal. */
export async function inspectLegacyPluginSourceCaptureRoots(stateDir: string) {
  const directory = path.resolve(stateDir, "tmp");
  const roots: Array<{ path: string; bytes: number }> = [];
  const warnings: string[] = [];
  const warn = (file: string, error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      warnings.push(`Could not inspect ${file}: ${String(error)}`);
    }
  };
  const measure = async (file: string): Promise<number> => {
    try {
      const stat = await fs.lstat(file);
      if (stat.isFile()) {
        return stat.size;
      }
      if (!stat.isDirectory()) {
        return 0;
      }
      let bytes = 0;
      for (const name of await fs.readdir(file)) {
        bytes += await measure(path.join(file, name));
      }
      return bytes;
    } catch (error) {
      warn(file, error);
      return 0;
    }
  };
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory()) {
      warnings.push(`Skipped non-directory or symbolic-link temporary path: ${directory}`);
    } else {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          LEGACY_CAPTURE_PREFIXES.some((prefix) => entry.name.startsWith(prefix))
        ) {
          const root = path.join(directory, entry.name);
          roots.push({ path: root, bytes: await measure(root) });
        }
      }
    }
  } catch (error) {
    warn(directory, error);
  }
  roots.sort((left, right) => left.path.localeCompare(right.path));
  return {
    directory,
    roots,
    totalBytes: roots.reduce((bytes, root) => bytes + root.bytes, 0),
    warnings,
  };
}
