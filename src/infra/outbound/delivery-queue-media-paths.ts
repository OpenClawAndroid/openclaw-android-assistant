import path from "node:path";
import { resolveDeliveryQueueMediaDir } from "../../config/paths.js";

export const ARTIFACT_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[A-Za-z0-9]{1,10})?(?:\.part)?$/;

export function spoolRelativePath(
  absolutePath: string,
  stateDir: string | undefined,
): string | null {
  const spoolRoot = path.resolve(resolveDeliveryQueueMediaDir(stateDir));
  const candidate = path.resolve(absolutePath);
  const relative = path.relative(spoolRoot, candidate);
  return relative && !relative.includes(path.sep) && ARTIFACT_NAME_RE.test(relative)
    ? relative
    : null;
}
