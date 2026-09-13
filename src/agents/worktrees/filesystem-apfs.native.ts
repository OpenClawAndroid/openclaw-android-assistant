import { getSystemErrorName } from "node:util";
import koffi from "koffi";

const libc = koffi.load("/usr/lib/libSystem.B.dylib");
// Public Darwin vfsconf ABI (sys/mount.h). Filesystem type numbers are assigned
// by the kernel, so comparing statfs.type with a fixed APFS number is unsafe.
const vfsconf = koffi.struct({
  reserved1: "uint32_t",
  name: koffi.array("char", 15),
  type: "int",
  refcount: "int",
  flags: "int",
  reserved2: "uint32_t",
  reserved3: "uint32_t",
});
const getvfsbyname = libc.func("getvfsbyname", "int", ["str", koffi.out(koffi.pointer(vfsconf))]);
const clonefile = libc.func(
  "int clonefile(const char *source, const char *destination, int flags)",
);
const config = { type: 0 };

const getattrlist = libc.func(
  "int getattrlist(const char *path, const void *attributes, void *result, size_t size, unsigned long options)",
);
const aclGetFile = libc.func("void *acl_get_file(const char *path, int type)");
const aclGetEntry = libc.func("int acl_get_entry(void *acl, int entryId, _Out_ void **entry)");
const aclGetFlagset = libc.func("int acl_get_flagset_np(void *entry, _Out_ void **flags)");
const aclGetFlag = libc.func("int acl_get_flag_np(void *flags, uint32_t flag)");
const aclFree = libc.func("int acl_free(void *acl)");
const aclAttributes = Buffer.alloc(24);
aclAttributes.writeUInt16LE(5, 0); // ATTR_BIT_MAP_COUNT
aclAttributes.writeUInt32LE(0x00400000, 4); // ATTR_CMN_EXTENDED_SECURITY
// Darwin attribute buffers use 4-byte packing, including 64-bit timespecs.
const attributes = Buffer.alloc(24);
// Returned attrs, device, vnode type, mtime, ctime, owner, group, mode, file ID.
const commonAttributes = 0x82038c0a;
attributes.writeUInt16LE(5, 0);
attributes.writeUInt32LE(commonAttributes, 4);
attributes.writeUInt32LE(0x200, 16); // ATTR_FILE_DATALENGTH
attributes.writeUInt32LE(0x100, 20); // ATTR_CMNEXT_CLONEID

export type ApfsFileMetadata = {
  dev: number;
  type: number;
  mtimeSec: number;
  mtimeNs: number;
  ctimeSec: number;
  ctimeNs: number;
  uid: number;
  gid: number;
  mode: number;
  ino: bigint;
  size: bigint;
  cloneId: bigint;
};

export const apfsFilesystem = {
  type: getvfsbyname("apfs", config) === 0 ? config.type : undefined,
  readDirectoryAcl(
    this: void,
    directory: string,
  ): "none" | "non-inheritable" | "inheritable" | undefined {
    // acl_get_file reports ENOENT for both absent ACLs and absent paths. This
    // attribute header distinguishes an empty ACL from a failed read without
    // decoding the opaque security blob (FSOPT_NOFOLLOW | FSOPT_REPORT_FULLSIZE).
    const result = Buffer.alloc(12);
    if (getattrlist(directory, aclAttributes, result, result.length, 0x0001 | 0x0004) !== 0) {
      return undefined;
    }
    const length = result.readUInt32LE(0);
    const size = result.readUInt32LE(8);
    if (length < result.length || size > length - result.length) {
      return undefined;
    }
    if (size === 0) {
      return length === result.length ? "none" : undefined;
    }
    // Let libc own ACL decoding and storage. A changed/failed second read is
    // unknown, including ENOENT; only the successful empty header proves no ACL.
    const acl = aclGetFile(directory, 0x100); // ACL_TYPE_EXTENDED
    if (!acl) {
      return undefined;
    }
    try {
      const entry: unknown[] = [null];
      const flags: unknown[] = [null];
      for (let selection = 0; ; selection = -1) {
        // ACL_FIRST_ENTRY / ACL_NEXT_ENTRY
        const code = aclGetEntry(acl, selection, entry);
        if (code !== 0) {
          // Darwin returns -1/EINVAL at exhaustion, unlike POSIX/Linux's 0.
          return code === -1 && koffi.errno() === 22 ? "non-inheritable" : undefined;
        }
        if (aclGetFlagset(entry[0], flags) !== 0) {
          return undefined;
        }
        const files = aclGetFlag(flags[0], 0x20); // ACL_ENTRY_FILE_INHERIT
        const directories = aclGetFlag(flags[0], 0x40); // ACL_ENTRY_DIRECTORY_INHERIT
        if ((files !== 0 && files !== 1) || (directories !== 0 && directories !== 1)) {
          return undefined;
        }
        if (files === 1 || directories === 1) {
          return "inheritable";
        }
      }
    } finally {
      aclFree(acl);
    }
  },
  cloneDirectory(this: void, source: string, destination: string): Promise<void> {
    // Apple strongly discourages directory clonefile; its full rationale is unpublished:
    // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/clonefile.2
    // Descendants omit destination ACL inheritance (also noted in XNU's authorizer):
    // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_subr.c#L8879
    // The backend checks ACLs before/after this operation and lets Git handle
    // inheritance. General-purpose copies should use recursive copyfile instead.
    // One strict, atomic directory operation retains the measured speed benefit.
    // Run off-thread for lease renewal; callers must join it before cancellation
    // recovery, because an admitted clone has no mid-operation cancellation API.
    // CLONE_NOFOLLOW | CLONE_ACL preserves literal links and source ACLs; the
    // latter does not implement descendant inheritance. APFS internals are closed.
    return new Promise((resolve, reject) => {
      clonefile.async(
        source,
        destination,
        0x0001 | 0x0004,
        (error: Error | null, result: number) => {
          // Koffi restores the worker's errno only for this completion callback.
          const errno = koffi.errno();
          if (error) {
            reject(error);
          } else if (result !== 0) {
            const code = getSystemErrorName(-errno);
            reject(
              Object.assign(new Error(`${code}: clonefile '${source}' -> '${destination}'`), {
                code,
                errno,
              }),
            );
          } else {
            resolve();
          }
        },
      );
    });
  },
  readFileMetadata(this: void, file: string): ApfsFileMetadata | undefined {
    const result = Buffer.alloc(100);
    // Read identity, timestamps and data-stream identity in one native snapshot.
    // FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED leaves symlinks unresolved.
    if (
      getattrlist(file, attributes, result, result.length, 0x21) !== 0 ||
      result.readUInt32LE(0) !== result.length ||
      result.readUInt32LE(4) !== commonAttributes ||
      result.readUInt32LE(16) !== 0x200 ||
      result.readUInt32LE(20) !== 0x100
    ) {
      return undefined;
    }
    return {
      dev: result.readUInt32LE(24),
      type: result.readUInt32LE(28),
      mtimeSec: Number(result.readBigInt64LE(32)),
      mtimeNs: Number(result.readBigInt64LE(40)),
      ctimeSec: Number(result.readBigInt64LE(48)),
      ctimeNs: Number(result.readBigInt64LE(56)),
      uid: result.readUInt32LE(64),
      gid: result.readUInt32LE(68),
      mode: result.readUInt32LE(72),
      ino: result.readBigUInt64LE(76),
      size: result.readBigUInt64LE(84),
      cloneId: result.readBigUInt64LE(92),
    };
  },
};
