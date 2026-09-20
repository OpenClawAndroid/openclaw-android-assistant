import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadModel, resolveModelFiles, verifyModel } from "./artifacts.js";
import type { ModelPreset } from "./catalog.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bytes = Buffer.from("synthetic model artifact");
const model: ModelPreset = {
  id: "fixture",
  name: "Fixture",
  family: "gliclass",
  maxTokens: 512,
  source: {
    kind: "hub",
    repository: "example/model",
    revision: "a".repeat(40),
    files: [
      {
        name: "model.onnx",
        path: "model.onnx",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  },
};

describe("ONNX artifact installation", () => {
  it("publishes only complete hash-verified files and reuses valid existing artifacts", async () => {
    const root = tempDirs.make("models-");
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response(bytes),
      finalUrl: "https://huggingface.co/fixture",
      release,
    });
    await downloadModel(root, model, new AbortController().signal);
    await verifyModel(root, model);
    expect(await fs.readFile(path.join(root, model.id, "model.onnx"))).toEqual(bytes);
    expect(release).toHaveBeenCalledOnce();
    vi.mocked(fetchWithSsrFGuard).mockClear();
    await downloadModel(root, model, new AbortController().signal);
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("removes partial downloads on integrity failure and joins response release", async () => {
    const root = tempDirs.make("bad-model-");
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("invalid"),
      finalUrl: "https://huggingface.co/fixture",
      release,
    });
    await expect(downloadModel(root, model, new AbortController().signal)).rejects.toThrow(
      /integrity/,
    );
    expect(await fs.readdir(path.join(root, model.id))).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses to overwrite an existing mismatched operator file", async () => {
    const root = tempDirs.make("existing-");
    await fs.mkdir(path.join(root, model.id));
    await fs.writeFile(path.join(root, model.id, "model.onnx"), "keep this");
    vi.mocked(fetchWithSsrFGuard).mockClear();
    await expect(downloadModel(root, model, new AbortController().signal)).rejects.toThrow(
      "model-integrity",
    );
    expect(await fs.readFile(path.join(root, model.id, "model.onnx"), "utf8")).toBe("keep this");
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("rejects local-export path traversal and mismatched source identity", async () => {
    const root = tempDirs.make("local-");
    const local: ModelPreset = {
      ...model,
      source: { kind: "local-export", repository: "example/model", revision: "a".repeat(40) },
    };
    await fs.mkdir(path.join(root, model.id));
    for (const files of [[{ name: "../other", size: 1, sha256: "a".repeat(64) }], []]) {
      await fs.writeFile(
        path.join(root, model.id, "model.json"),
        JSON.stringify({ modelId: "different", sourceRevision: "b".repeat(40), files }),
      );
      await expect(resolveModelFiles(root, local)).rejects.toThrow("model-integrity");
    }
  });
});
