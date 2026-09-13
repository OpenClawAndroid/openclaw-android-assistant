import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  extractWorkerBundleArchive,
  readWorkerBundleArchiveManifest,
  readWorkerBundleDirectoryManifest,
} from "./worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "./worker-bundle-hash.js";

describe("worker bundle archive", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;

  beforeEach(() => {
    root = tempDirs.make("openclaw-bundle-archive-");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts only a manifest-identical regular-file bundle", async () => {
    const source = path.join(root, "source");
    const archive = path.join(root, "bundle.tgz");
    const destination = path.join(root, "destination");
    await fs.mkdir(path.join(source, "dist"), { recursive: true });
    await fs.writeFile(path.join(source, "openclaw.mjs"), "#!/usr/bin/env node\n");
    await fs.chmod(path.join(source, "openclaw.mjs"), 0o700);
    await fs.writeFile(path.join(source, "dist", "worker.js"), "export const worker = true;\n");
    await fs.chmod(path.join(source, "dist", "worker.js"), 0o600);
    await fs.writeFile(path.join(source, "dist", "Upper.js"), "export const upper = true;\n");
    await fs.chmod(path.join(source, "dist", "Upper.js"), 0o600);
    const sourceManifest = await readWorkerBundleDirectoryManifest({
      root: source,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
    });
    const bundleHash = hashWorkerBundleManifest(sourceManifest);
    await tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, [
      "openclaw.mjs",
      "dist/worker.js",
      "dist/Upper.js",
    ]);

    await extractWorkerBundleArchive({
      tarballPath: archive,
      destination,
      expectedBundleHash: bundleHash,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
    });

    expect(
      hashWorkerBundleManifest(
        await readWorkerBundleDirectoryManifest({
          root: destination,
          limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
        }),
      ),
    ).toBe(bundleHash);
  });

  it("rejects archive links before extraction", async () => {
    const source = path.join(root, "source");
    const archive = path.join(root, "bundle.tgz");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "target"), "target");
    await fs.symlink("target", path.join(source, "openclaw.mjs"));
    await tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, [
      "openclaw.mjs",
    ]);

    await expect(
      readWorkerBundleArchiveManifest(archive, DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS),
    ).rejects.toThrow("Invalid worker bundle tar entry");
  });

  it.each(["replacement", "oversized", "symlink"] as const)(
    "handles a %s swapped in after directory entry inspection",
    async (kind) => {
      const source = path.join(root, "source");
      const filePath = path.join(source, "worker.mjs");
      const replacement = path.join(root, "replacement");
      const contents = "export const worker = true;\n";
      await fs.mkdir(source);
      await fs.writeFile(filePath, "old", { mode: 0o600 });
      if (kind === "symlink") {
        const outside = path.join(root, "outside");
        await fs.writeFile(outside, contents);
        await fs.symlink(outside, replacement);
      } else {
        await fs.writeFile(replacement, contents, { mode: 0o700 });
      }
      const lstat = fs.lstat.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stats = await lstat(...args);
        if (!replaced && String(args[0]) === filePath) {
          replaced = true;
          await fs.rename(replacement, filePath);
        }
        return stats;
      });

      const manifest = readWorkerBundleDirectoryManifest({
        root: source,
        limits: {
          maxEntries: 1,
          maxExpandedBytes: kind === "oversized" ? 3 : 1024,
        },
      });
      if (kind === "replacement") {
        await expect(manifest).resolves.toEqual([
          {
            path: "worker.mjs",
            mode: 0o700,
            size: Buffer.byteLength(contents),
            sha256: createHash("sha256").update(contents).digest("hex"),
          },
        ]);
      } else {
        await expect(manifest).rejects.toThrow(
          kind === "oversized" ? "directory exceeds its limits" : /symbolic link|symlink/iu,
        );
      }
      expect(replaced).toBe(true);
    },
  );

  it.each(["worker.mjs", "~/worker.mjs"])(
    "retains hardlinked %s and ignores directories and the install receipt in file limits",
    async (relativePath) => {
      const source = path.join(root, "source");
      const original = path.join(root, "worker.mjs");
      const contents = "export {};\n";
      await fs.mkdir(path.join(source, "empty"), { recursive: true });
      await fs.mkdir(path.dirname(path.join(source, relativePath)), { recursive: true });
      await fs.writeFile(original, contents, { mode: 0o700 });
      await fs.link(original, path.join(source, relativePath));
      await fs.writeFile(path.join(source, "bootstrap-receipt.json"), "{}\n");

      await expect(
        readWorkerBundleDirectoryManifest({
          root: source,
          limits: { maxEntries: 1, maxExpandedBytes: Buffer.byteLength(contents) },
          ignoreTopLevel: new Set(["bootstrap-receipt.json"]),
        }),
      ).resolves.toEqual([
        {
          path: relativePath,
          mode: 0o700,
          size: Buffer.byteLength(contents),
          sha256: createHash("sha256").update(contents).digest("hex"),
        },
      ]);
    },
  );

  it("rejects a valid archive under the wrong logical hash", async () => {
    const source = path.join(root, "source");
    const archive = path.join(root, "bundle.tgz");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "openclaw.mjs"), "worker");
    await tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, [
      "openclaw.mjs",
    ]);

    await expect(
      extractWorkerBundleArchive({
        tarballPath: archive,
        destination: path.join(root, "destination"),
        expectedBundleHash: "f".repeat(64),
        limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      }),
    ).rejects.toThrow("archive manifest does not match");
  });

  it("preserves the v1 bundle hash when Windows cannot retain Unix artifact modes", async () => {
    const source = path.join(root, "source");
    const archive = path.join(root, "unix-mode-bundle.tgz");
    const destination = path.join(root, "destination");
    await fs.mkdir(source);
    const artifacts = ["github-exec-launcher.mjs", "worker.mjs", "workspace-rsync-receiver.mjs"];
    for (const artifact of artifacts) {
      await fs.writeFile(
        path.join(source, artifact),
        `export const name = ${JSON.stringify(artifact)};\n`,
      );
      await fs.chmod(path.join(source, artifact), 0o700);
    }
    await tar.create({ cwd: source, file: archive, gzip: true, noDirRecurse: true }, artifacts);
    const bundleHash = hashWorkerBundleManifest(
      await readWorkerBundleArchiveManifest(archive, DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS),
    );
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      await expect(
        extractWorkerBundleArchive({
          tarballPath: archive,
          destination,
          expectedBundleHash: bundleHash,
          limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
        }),
      ).resolves.toBeUndefined();
      for (const artifact of artifacts) {
        await fs.chmod(path.join(destination, artifact), 0o666);
      }
      expect(
        hashWorkerBundleManifest(
          await readWorkerBundleDirectoryManifest({
            root: destination,
            limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
          }),
        ),
      ).toBe(bundleHash);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
