import { getCompileCacheDir } from "node:module";

export function resolveNodeCompileCacheEnv(): NodeJS.ProcessEnv {
  const env = process.env;
  if (env.NODE_COMPILE_CACHE !== undefined || env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
    return env;
  }
  // Programmatic cache enablement applies only to the current Node instance.
  const directory = getCompileCacheDir?.();
  return directory ? { ...env, NODE_COMPILE_CACHE: directory } : env;
}
