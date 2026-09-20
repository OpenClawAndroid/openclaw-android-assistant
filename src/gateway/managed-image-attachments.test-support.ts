import fs from "node:fs/promises";
import path from "node:path";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
} from "./managed-image-record-store.js";

export async function createFixture(
  stateDir: string,
  options?: {
    sessionKey?: string;
    agentId?: string;
    attachmentId?: string;
    filename?: string;
    contentType?: string;
    body?: Buffer;
    messageId?: string | null;
    createdAt?: string;
  },
) {
  const attachmentId = options?.attachmentId ?? "11111111-1111-4111-8111-111111111111";
  const sessionKey = options?.sessionKey ?? "agent:main:main";
  const filename = options?.filename ?? `${attachmentId}-cat-full.png`;
  const originalPath = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR, filename);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  const body = options?.body ?? Buffer.from("original-image");
  await fs.writeFile(originalPath, body);
  insertManagedImageRecord(
    {
      attachmentId,
      sessionKey,
      ...(options?.agentId ? { agentId: options.agentId } : {}),
      messageId: options?.messageId === undefined ? "msg-1" : options.messageId,
      createdAt: options?.createdAt ?? new Date().toISOString(),
      alt: "Cat",
      original: {
        mediaRoot: path.join(stateDir, "media"),
        mediaId: filename,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType: options?.contentType ?? "image/png",
        width: options?.contentType?.startsWith("image/") === false ? null : 1024,
        height: options?.contentType?.startsWith("image/") === false ? null : 768,
        sizeBytes: body.byteLength,
        filename: options?.filename ?? "cat.png",
      },
    },
    stateDir,
  );
  return { attachmentId, sessionKey, originalPath };
}
