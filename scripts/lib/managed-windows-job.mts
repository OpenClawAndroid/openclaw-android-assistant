import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createWindowsJobBindings } from "../../src/process/supervisor/service-child-windows-job-native.ts";
import { resolveManagedWindowsJobEntrypointUrl } from "./managed-windows-job-entrypoint.mts";

export type ManagedWindowsJob = {
  inspect: () => number[];
  beginStop: () => void;
  stop: () => void;
  close: () => void;
};

export type WindowsJobLaunch = {
  command: string;
  args: string[];
  options: Omit<SpawnOptions, "stdio" | "signal">;
  inheritedFds: number;
};

let native: ReturnType<typeof createWindowsJobBindings> | undefined;
function bindings() {
  if (!native) {
    const require = createRequire(import.meta.url);
    const koffi: typeof import("koffi").default = require("koffi");
    native = createWindowsJobBindings(koffi);
    native.assertLayouts();
  }
  return native;
}

/** One retained kernel Job owns the launcher and every command descendant. */
export function spawnWindowsJobChild(
  command: string,
  args: string[],
  options: SpawnOptions,
): { child: ChildProcess; job: ManagedWindowsJob } | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  const configuredStdio = options.stdio;
  const stdio: Exclude<StdioOptions, string> = Array.isArray(configuredStdio)
    ? [...configuredStdio]
    : Array.from({ length: 3 }, () => configuredStdio ?? "pipe");
  while (stdio.length < 3) {
    stdio.push("pipe");
  }
  // Existing IPC callers own their protocol. Failed taskkill stays unverified without a Job.
  if (stdio.includes("ipc")) {
    return undefined;
  }
  const api = bindings();
  const name = `Local\\OpenClawTooling-${randomUUID()}`;
  const handle = api.requireHandle(api.CreateJobObjectW(null, name), "CreateJobObjectW(tooling)");
  let stopped = false;
  let closed = false;
  const job: ManagedWindowsJob = {
    beginStop: () => {
      stopped = true;
    },
    inspect: () => {
      if (closed) {
        throw new Error("Windows command Job is closed");
      }
      return api.readJobProcessIds(handle);
    },
    stop: () => {
      stopped = true;
      if (closed) {
        return;
      }
      if (!api.TerminateJobObject(handle, 1)) {
        throw api.lastError("TerminateJobObject(tooling)");
      }
    },
    close: () => {
      stopped = true;
      if (!closed) {
        if (!api.CloseHandle(handle)) {
          throw api.lastError("CloseHandle(tooling Job)");
        }
        closed = true;
      }
    },
  };
  try {
    if (!api.SetExtendedLimits(handle, 9, api.extendedLimits, api.extendedLimitsSize)) {
      throw api.lastError("SetInformationJobObject(tooling)");
    }
    const { stdio: _stdio, signal: _signal, ...commandOptions } = options;
    const inheritedFds = stdio.length;
    // Match spawn's synchronous input snapshot across the asynchronous Job admission.
    const commandEnv = { ...(options.env ?? process.env) };
    const launch: WindowsJobLaunch = {
      command,
      args: [...args],
      options: {
        ...commandOptions,
        cwd: options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
        env: commandEnv,
      },
      inheritedFds,
    };
    stdio.push("ipc");
    const child = spawn(
      process.execPath,
      [fileURLToPath(resolveManagedWindowsJobEntrypointUrl()), name],
      {
        cwd: launch.options.cwd,
        // Windows environment keys are case-insensitive. Preloads belong inside the Job.
        env: Object.fromEntries(
          Object.entries(commandEnv).filter(([key]) => key.toUpperCase() !== "NODE_OPTIONS"),
        ),
        stdio,
        windowsHide: options.windowsHide,
        signal: options.signal,
      },
    );
    let admitted = false;
    child.on("message", (message: unknown) => {
      if (message === "job-ready" && !admitted && !stopped) {
        admitted = true;
        child.send(launch, (error) => {
          if (error) {
            child.emit("error", error);
          }
        });
      } else if (message && typeof message === "object" && "error" in message) {
        child.emit(
          "error",
          Object.assign(
            new Error(String(message.error)),
            "code" in message ? { code: message.code } : {},
          ),
        );
      }
    });
    return { child, job };
  } catch (error) {
    job.close();
    throw error;
  }
}
