import fs from "node:fs/promises";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

export async function releaseSessionTestDirectories(roots: readonly string[]) {
  for (const root of roots) {
    await releaseGatewaySessionStoreFixture(root);
  }
}

export async function removeSessionTestDirectories(roots: readonly string[]) {
  await releaseSessionTestDirectories(roots);
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

export async function removeChatTestDirectory(dir: string): Promise<void> {
  await releaseSessionTestDirectories([dir]);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
