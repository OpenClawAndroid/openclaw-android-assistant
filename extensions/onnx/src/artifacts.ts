import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ModelFile, ModelPreset } from "./catalog.js";
import { OnnxWorkerError } from "./protocol.js";

const ExportSchema = Type.Object(
  {
    modelId: Type.String(),
    sourceRevision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
    files: Type.Array(
      Type.Object(
        {
          name: Type.Union([
            Type.Literal("model.onnx"),
            Type.Literal("tokenizer.json"),
            Type.Literal("tokenizer_config.json"),
            Type.Literal("config.json"),
            Type.Literal("special_tokens_map.json"),
          ]),
          size: Type.Integer({ minimum: 1, maximum: 1_500_000_000 }),
          sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: 5 },
    ),
  },
  { additionalProperties: false },
);

async function readBounded(file: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
      throw new OnnxWorkerError("model-integrity");
    }
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) {
        throw new OnnxWorkerError("model-integrity");
      }
      offset += bytesRead;
    }
    return data;
  } catch (error) {
    if (error instanceof OnnxWorkerError) {
      throw error;
    }
    throw new OnnxWorkerError("model-missing");
  } finally {
    await handle?.close();
  }
}

export async function resolveModelFiles(root: string, model: ModelPreset): Promise<ModelFile[]> {
  if (model.source.kind === "hub") {
    return model.source.files;
  }
  let value: unknown;
  try {
    value = JSON.parse(
      (await readBounded(path.join(root, model.id, "model.json"), 32768)).toString("utf8"),
    );
  } catch (error) {
    if (error instanceof OnnxWorkerError) {
      throw error;
    }
    throw new OnnxWorkerError("model-integrity");
  }
  if (
    !Value.Check(ExportSchema, value) ||
    value.modelId !== model.id ||
    value.sourceRevision !== model.source.revision
  ) {
    throw new OnnxWorkerError("model-integrity");
  }
  const names = value.files.map((file) => file.name);
  if (
    new Set(names).size !== names.length ||
    !names.includes("model.onnx") ||
    !names.includes("tokenizer.json")
  ) {
    throw new OnnxWorkerError("model-integrity");
  }
  return value.files.map((file) => ({ name: file.name, bytes: file.size, sha256: file.sha256 }));
}

export async function readModelArtifact(
  root: string,
  model: ModelPreset,
  file: ModelFile,
): Promise<Buffer> {
  const limit = file.name === "model.onnx" ? 1_500_000_000 : 16_777_216;
  if (file.bytes > limit) {
    throw new OnnxWorkerError("model-integrity");
  }
  const data = await readBounded(path.join(root, model.id, file.name), limit);
  if (
    data.length !== file.bytes ||
    createHash("sha256").update(data).digest("hex") !== file.sha256
  ) {
    throw new OnnxWorkerError("model-integrity");
  }
  return data;
}

export async function verifyModel(root: string, model: ModelPreset): Promise<void> {
  for (const file of await resolveModelFiles(root, model)) {
    await readModelArtifact(root, model, file);
  }
}

export async function downloadModel(
  root: string,
  model: ModelPreset,
  signal: AbortSignal,
): Promise<void> {
  if (model.source.kind !== "hub") {
    throw new Error(
      `${model.id} requires a local export. Use the plugin's export-gliclass-instruct.py helper.`,
    );
  }
  const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");
  const destination = path.join(root, model.id);
  await fs.mkdir(destination, { recursive: true });
  for (const file of model.source.files) {
    signal.throwIfAborted();
    const target = path.join(destination, file.name);
    const existing = await fs.lstat(target).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (existing) {
      await readModelArtifact(root, model, file);
      continue;
    }
    const temp = path.join(destination, `.${file.name}.${randomUUID()}.partial`);
    try {
      const url = `https://huggingface.co/${model.source.repository}/resolve/${model.source.revision}/${file.path}`;
      const guarded = await fetchWithSsrFGuard({
        url,
        requireHttps: true,
        maxRedirects: 5,
        signal,
      });
      try {
        if (!guarded.response.ok || !guarded.response.body) {
          throw new Error(`Model download failed: HTTP ${guarded.response.status}.`);
        }
        const handle = await fs.open(temp, "wx", 0o600);
        const reader = guarded.response.body.getReader();
        const hash = createHash("sha256");
        let size = 0;
        try {
          while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            size += chunk.value.byteLength;
            if (size > file.bytes) {
              throw new Error("Model download exceeds its pinned size.");
            }
            hash.update(chunk.value);
            await handle.writeFile(chunk.value);
          }
          if (size !== file.bytes || hash.digest("hex") !== file.sha256) {
            throw new Error("Model download failed its pinned integrity check.");
          }
        } finally {
          try {
            await reader.cancel();
          } finally {
            reader.releaseLock();
            await handle.close();
          }
        }
      } finally {
        try {
          await guarded.response.body?.cancel();
        } finally {
          await guarded.release();
        }
      }
      signal.throwIfAborted();
      // Publishing with link never overwrites an existing operator artifact.
      try {
        await fs.link(temp, target);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
        await readModelArtifact(root, model, file);
      }
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}
