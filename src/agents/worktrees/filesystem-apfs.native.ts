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

export const apfsFilesystem = {
  type: getvfsbyname("apfs", config) === 0 ? config.type : undefined,
  cloneFile(this: void, source: string, destination: string): void {
    // CLONE_NOFOLLOW | CLONE_ACL preserves links themselves and file ACLs.
    // Unlike cp -c and Node's best-effort copy flag, clonefile never copies data
    // as a fallback when cloning is unsupported or crosses a filesystem.
    if (clonefile(source, destination, 0x0001 | 0x0004) !== 0) {
      const errno = koffi.errno();
      const code = getSystemErrorName(-errno);
      throw Object.assign(new Error(`${code}: clonefile '${source}' -> '${destination}'`), {
        code,
        errno,
      });
    }
  },
};
