import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createWindowsJobBindings } from "../../src/process/supervisor/service-child-windows-job-native.ts";
import { isDirectRunUrl } from "./direct-run.mjs";
import type { WindowsJobLaunch } from "./managed-windows-job.mts";

const fail = (error: unknown) => {
  process.exitCode = 1;
  const message = {
    error: error instanceof Error ? error.message : String(error),
    ...(error && typeof error === "object" && "code" in error ? { code: error.code } : {}),
  };
  if (process.connected) {
    process.send?.(message, () => process.disconnect?.());
  }
};

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const name = process.argv[2];
    if (!name || !process.connected) {
      throw new Error("Windows command Job handoff is missing");
    }
    const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
    const api = createWindowsJobBindings(koffi);
    api.assertLayouts();
    const job = api.requireHandle(api.OpenJobObjectW(1, 0, name), "OpenJobObjectW(tooling)");
    const assigned = api.AssignProcessToJobObject(job, api.GetCurrentProcess());
    const assignmentError = assigned
      ? undefined
      : api.lastError("AssignProcessToJobObject(tooling launcher)");
    // The host is the sole handle owner; host death terminates this whole Job.
    const closed = api.CloseHandle(job);
    if (assignmentError) {
      throw assignmentError;
    }
    if (!closed) {
      throw api.lastError("CloseHandle(launcher Job copy)");
    }
    // User code cannot execute until containment is established and the host admits it.
    process.once("message", (launch: WindowsJobLaunch) => {
      try {
        const child = spawn(launch.command, launch.args, {
          ...launch.options,
          stdio: Array.from({ length: launch.inheritedFds }, (_, fd) => fd),
        });
        child.once("error", fail);
        child.once("spawn", () => process.disconnect?.());
        child.once("exit", (code) => {
          process.exitCode = code ?? 1;
        });
      } catch (error) {
        fail(error);
      }
    });
    process.send?.("job-ready");
  } catch (error) {
    fail(error);
  }
}
