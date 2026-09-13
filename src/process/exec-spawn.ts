import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import process from "node:process";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { killProcessTree } from "./kill-tree.js";
import { resolveSafeChildProcessInvocation } from "./windows-command.js";

export const COMMAND_PROCESS_TREE_KILL_GRACE_MS = 300;

type CommandProcessScope = {
  signal: AbortSignal;
  children: Set<() => void>;
};

const commandProcessScope = new AsyncLocalStorage<CommandProcessScope>();

export function resolveCommandProcessSignal(signal?: AbortSignal): AbortSignal | undefined {
  const inherited = commandProcessScope.getStore()?.signal;
  return inherited ? AbortSignal.any(signal ? [inherited, signal] : [inherited]) : signal;
}

/** Cleanup helpers must outlive cancellation of the commands they are settling. */
export function runOutsideCommandProcessScope<T>(run: () => T): T {
  return commandProcessScope.exit(run);
}

/** Terminal command deadlines stop their children before the caller permits rollback. */
export async function withCommandProcessScope<T>(
  run: (stop: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const inherited = resolveCommandProcessSignal(signal);
  const scope: CommandProcessScope = {
    signal: inherited ? AbortSignal.any([inherited, controller.signal]) : controller.signal,
    children: new Set(),
  };
  const stop = () => {
    controller.abort();
    for (const stopChild of scope.children) {
      stopChild();
    }
    scope.children.clear();
  };
  return await commandProcessScope.run(scope, async () => {
    try {
      return await run(stop);
    } finally {
      stop();
    }
  });
}

function retainCommandProcess<OptionsType extends ExecaOptions>(
  scope: CommandProcessScope,
  child: ResultPromise<OptionsType>,
): void {
  const pid = child.pid;
  // Windows executable finalizers retain a Job until process exit; dead launcher
  // PIDs cannot safely identify their surviving descendants through taskkill.
  if (pid === undefined || process.platform === "win32") {
    return;
  }
  const startedAt = getFileLockProcessStartTime(pid);
  const stop = () => {
    const nativeChild = child.nodeChildProcess;
    // A live direct child holds PID custody even when its optional timestamp probe failed.
    if (nativeChild.exitCode !== null || nativeChild.signalCode !== null) {
      const currentStart = getFileLockProcessStartTime(pid);
      if (currentStart !== null && currentStart !== startedAt) {
        return;
      }
    }
    killProcessTree(pid, { detached: true, force: true });
  };
  scope.children.add(stop);
  const release = () => {
    try {
      // A direct child can exit while descendants retain its pipes or mutate
      // installed files. Keep that group owned until it actually disappears.
      process.kill(-pid, 0);
      return;
    } catch (error) {
      if (extractErrorCode(error) !== "ESRCH") {
        return;
      }
    }
    scope.children.delete(stop);
  };
  void child.then(release, release);
}

export function shouldSpawnWithShell(params: {
  resolvedCommand: string;
  platform: NodeJS.Platform;
}): boolean {
  // SECURITY: never enable `shell` for argv-based execution.
  // `shell` routes through cmd.exe on Windows, which turns untrusted argv values
  // (like chat prompts passed as CLI args) into command-injection primitives.
  // If you need a shell, use an explicit shell-wrapper argv (e.g. `cmd.exe /c ...`)
  // and validate/escape at the call site.
  void params;
  return false;
}

type SpawnCommandOptions = ExecaOptions & {
  baseEnv?: NodeJS.ProcessEnv;
  /** The command runner routes scope cancellation through its termination owner. */
  inheritScopeCancellation?: boolean;
};

export function spawnCommandWithInvocation<
  OptionsType extends SpawnCommandOptions = SpawnCommandOptions,
>(
  argv: string[],
  options: OptionsType = {} as OptionsType,
): {
  child: ResultPromise<OptionsType>;
  invocation: ReturnType<typeof resolveSafeChildProcessInvocation>;
} {
  const scope = commandProcessScope.getStore();
  if (scope?.signal.aborted) {
    throw new Error("Command process scope is closed");
  }
  const {
    baseEnv,
    env,
    windowsVerbatimArguments,
    cancelSignal,
    inheritScopeCancellation = true,
    ...execaOptions
  } = options;
  const commandEnv = resolveCommandEnv({ argv, baseEnv, env });
  const invocation = resolveSafeChildProcessInvocation({
    argv,
    cwd: execaOptions.cwd,
    env: commandEnv,
    windowsVerbatimArguments,
  });
  const child = execa(invocation.command, invocation.args, {
    ...execaOptions,
    cancelSignal: inheritScopeCancellation
      ? resolveCommandProcessSignal(cancelSignal)
      : cancelSignal,
    ...(scope ? { killDescendants: true } : {}),
    env: commandEnv,
    extendEnv: false,
    shell: false,
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  } as ExecaOptions) as unknown as ResultPromise<OptionsType>;
  if (scope) {
    retainCommandProcess(scope, child);
  }
  return { child, invocation };
}

/** Spawn through the canonical argv, environment, and Windows safety boundary. */
export function spawnCommand<OptionsType extends SpawnCommandOptions = SpawnCommandOptions>(
  argv: string[],
  options: OptionsType = {} as OptionsType,
): ResultPromise<OptionsType> {
  return spawnCommandWithInvocation(argv, options).child;
}

export function resolveCommandEnv(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const baseEnv = params.baseEnv ?? process.env;
  const platform = params.platform ?? process.platform;
  const argv = params.argv;
  const shouldSuppressNpmFund = (() => {
    const cmd = path.basename(argv[0] ?? "");
    if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") {
      return true;
    }
    if (cmd === "node" || cmd === "node.exe") {
      const script = argv[1] ?? "";
      return script.includes("npm-cli.js");
    }
    return false;
  })();

  const resolvedEnv = mergeProcessEnv([baseEnv, params.env], platform);
  if (shouldSuppressNpmFund) {
    if (resolvedEnv.NPM_CONFIG_FUND == null) {
      resolvedEnv.NPM_CONFIG_FUND = "false";
    }
    if (resolvedEnv.npm_config_fund == null) {
      resolvedEnv.npm_config_fund = "false";
    }
  }
  return markOpenClawExecEnv(resolvedEnv);
}
