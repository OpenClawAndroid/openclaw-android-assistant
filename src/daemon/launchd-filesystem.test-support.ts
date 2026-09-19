import { vi } from "vitest";

export function createLaunchdFileReadMocks(state: {
  files: Map<string, string>;
  fileModes: Map<string, number>;
}) {
  const readContents = (file: string) => {
    const data = state.files.get(file);
    if (data === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), {
        code: "ENOENT",
      });
    }
    return data;
  };
  return {
    open: vi.fn(async (file: string) => {
      const data = readContents(file);
      const mode = state.fileModes.get(file) ?? 0o666;
      return {
        readFile: async () => data,
        stat: async () => ({ mode }),
        close: async () => undefined,
      };
    }),
    readFile: vi.fn(async (file: string) => readContents(file)),
  };
}
