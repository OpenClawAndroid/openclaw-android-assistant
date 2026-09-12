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
  cloneDirectory(this: void, source: string, destination: string): Promise<void> {
    // Directory clonefile is atomic and strict. Apple's recommended recursive
    // copyfile traverses in userspace and loses the bulk operation's speed.
    // Run off-thread so the allocation lease can renew during large clones.
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
