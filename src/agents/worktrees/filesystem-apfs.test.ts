import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { getApfsCloneId } from "../../../test/helpers/apfs.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";

describe.skipIf(process.platform !== "darwin")("APFS worktree filesystem", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const options = { commitGuard: () => {} };
  afterEach(() => vi.restoreAllMocks());

  it("shares file data while preserving modes, dotfiles, and literal symlinks", async () => {
    const root = tempDirs.make("openclaw-apfs-clone-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const backend = await detectWorktreeFilesystemBackend(root, options);
    assert(backend);
    expect(backend.id).toBe("apfs");
    await backend.createTemplate(source, options);
    await fs.mkdir(path.join(source, "nested"));
    await fs.writeFile(path.join(source, "nested", ".payload"), Buffer.alloc(1024 * 1024, 0x5a));
    await fs.chmod(path.join(source, "nested", ".payload"), 0o751);
    await fs.chmod(path.join(source, "nested"), 0o750);
    await fs.symlink("nested/.payload", path.join(source, "link"));

    await backend.cloneTemplate(source, destination, options);
    const original = path.join(source, "nested", ".payload");
    const cloned = path.join(destination, "nested", ".payload");
    expect(getApfsCloneId(cloned)).toBe(getApfsCloneId(original));
    expect((await fs.stat(cloned)).ino).not.toBe((await fs.stat(original)).ino);
    expect((await fs.stat(cloned)).mode & 0o777).toBe(0o751);
    expect((await fs.stat(path.join(destination, "nested"))).mode & 0o777).toBe(0o750);
    expect(await fs.readlink(path.join(destination, "link"))).toBe("nested/.payload");
    await fs.writeFile(cloned, "independent edit");
    expect(await fs.readFile(original)).toEqual(Buffer.alloc(1024 * 1024, 0x5a));
    expect(getApfsCloneId(cloned)).not.toBe(getApfsCloneId(original));

    await expect(backend.cloneTemplate(source, destination, options)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await fs.readFile(cloned, "utf8")).toBe("independent edit");
  });

  it("does not select APFS for another filesystem", async () => {
    const root = tempDirs.make("openclaw-apfs-detection-");
    const stats = await fs.statfs(root);
    vi.spyOn(fs, "statfs").mockResolvedValue(Object.assign(stats, { type: -1 }));
    expect(await detectWorktreeFilesystemBackend(root, options)).toBeNull();
  });

  it("stops cloning when allocation authority is revoked between files", async () => {
    const root = tempDirs.make("openclaw-apfs-cancellation-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const backend = await detectWorktreeFilesystemBackend(root, options);
    assert(backend);
    await backend.createTemplate(source, options);
    await fs.writeFile(path.join(source, "a"), "first");
    await fs.writeFile(path.join(source, "b"), "second");
    const { apfsFilesystem } = await import("./filesystem-apfs.native.js");
    const clone = apfsFilesystem.cloneFile;
    let authorized = true;
    vi.spyOn(apfsFilesystem, "cloneFile").mockImplementation((from, to) => {
      clone(from, to);
      authorized = false;
    });

    await expect(
      backend.cloneTemplate(source, destination, {
        commitGuard: () => {
          if (!authorized) {
            throw new Error("allocation lease lost");
          }
        },
      }),
    ).rejects.toThrow("allocation lease lost");
    expect(await fs.readdir(destination)).toHaveLength(1);
    expect(await fs.readdir(source)).toHaveLength(2);
  });
});
