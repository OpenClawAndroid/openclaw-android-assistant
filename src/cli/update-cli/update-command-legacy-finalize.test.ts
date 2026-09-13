import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "../../node-host/node-worker-process-identity.js";
import * as commandRunner from "../../process/exec.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

// Vitest cancellation ends its wrapper before the body unwinds. Keep the
// authority database and scratch inputs until that original body has joined.
const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

async function closeLegacyFixture(
  command: ReturnType<typeof commandRunner.runUtf8CommandWithTimeout> | undefined,
  release: () => void,
) {
  await fixture.verifyCleanup(async () => {
    const result = await command;
    assertLegacyCommandJoined(result);
    release();
    stateDatabase.closeOpenClawStateDatabase();
  });
}

function assertLegacyCommandJoined(
  result: Awaited<ReturnType<typeof commandRunner.runUtf8CommandWithTimeout>> | undefined,
) {
  if (result?.cleanup === "uncertain") {
    throw new Error("Legacy finalizer process cleanup is unverified");
  }
}

const scenarios = [
  "state-migrated-no-rollback",
  "rollback-state-unverified",
  "revoked",
  "retargeted",
  "grantless",
  "grantless-incumbent",
  "grantless-scratch",
  "grantless-scratch-incumbent",
  "grantless-scratch-owned",
  "grantless-scratch-owned-incumbent",
] as const;

it.for(scenarios)(
  "shipped legacy grant completes migrated finalization and native restart: %s",
  { timeout: 90_000 },
  (scenario, { signal }) => runLegacyFinalizationScenario(scenario, signal),
);

function runLegacyFinalizationScenario(scenario: (typeof scenarios)[number], signal: AbortSignal) {
  return fixture.run(async () => {
    signal.throwIfAborted();
    const scratch = fs.realpathSync(fixture.createTempDir("legacy-native-finalize-"));
    const root = fs.realpathSync(process.cwd());
    const configPath = path.join(scratch, "openclaw.json");
    const scratchEnvironment = scenario.includes("-scratch");
    const ownedEnvironment = scenario.includes("-owned");
    const incumbent = scenario.endsWith("-incumbent");
    const normalTemp = path.join(scratch, "normal-temp");
    const workerTemp = path.join(scratch, "worker-temp");
    const unsafePreferred = path.join(scratch, "unavailable-preferred");
    if (scratchEnvironment) {
      fs.mkdirSync(normalTemp);
      fs.mkdirSync(workerTemp);
      // Force the real POSIX fallback without touching /tmp/openclaw. Windows
      // already skips preferredDir. Keep os.tmpdir and secure filesystem checks real.
      fs.writeFileSync(unsafePreferred, "not a directory");
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: scratch,
      USERPROFILE: scratch,
      OPENCLAW_HOME: scratch,
      OPENCLAW_STATE_DIR: scratch,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_TEST_RUNTIME_LOG: "1",
      ...(scratchEnvironment
        ? {
            TMPDIR: ownedEnvironment ? workerTemp : normalTemp,
            TMP: ownedEnvironment ? workerTemp : normalTemp,
            TEMP: ownedEnvironment ? workerTemp : normalTemp,
            OPENCLAW_TEST_LEGACY_TEMP_FALLBACK: "1",
          }
        : {}),
    };
    for (const name of [
      "OPENCLAW_SERVICE_KIND",
      "OPENCLAW_SERVICE_MARKER",
      "OPENCLAW_SERVICE_REPAIR_POLICY",
    ]) {
      delete env[name];
    }
    let command: ReturnType<typeof commandRunner.runUtf8CommandWithTimeout> | undefined;
    let releaseParent: (() => void) | undefined;
    let releaseChild: (() => void) | undefined;
    try {
      fs.writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const originalEnvironment = ownedEnvironment
        ? { ...env, TMPDIR: normalTemp, TMP: normalTemp, TEMP: normalTemp }
        : env;
      const leaseDirectory = scratchEnvironment
        ? resolvePreferredOpenClawTmpDir({
            preferredDir: unsafePreferred,
            tmpdir: () => normalTemp,
          })
        : scratch;
      const databasePath = path.join(leaseDirectory, "managed-update-handoffs.sqlite");
      const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: env });
      const acquired = store.acquire(root, randomUUID(), { kind: "update" });
      if (acquired.kind !== "acquired") {
        throw new Error("Missing original owner");
      }
      releaseParent = () => {
        store.release(acquired.lease);
      };
      // Exact v2026.9.4 producer format (3a9d69db): real UUID child registration,
      // parent row and private input, with no later lineage or database-pin fields.
      const child = store.acquire(`${root}/.openclaw-update-child-${randomUUID()}`, runId, {
        kind: "update",
      });
      if (child.kind !== "acquired") {
        throw new Error("Missing legacy child");
      }
      let bound = child.lease;
      releaseChild = () => {
        store.release(bound);
      };
      const executor = {
        runId,
        root,
        databasePath,
        parent: acquired.lease,
        childKey: child.lease.key,
      };
      const entry = path.join(scratch, "native-entry.mjs");
      const loader = path.resolve("scripts/tsx.mjs");
      // Both receiver imports share the same graph and service-authority scope.
      const owner = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExecutor);
      const exec = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExec).href;
      fs.writeFileSync(
        entry,
        `
      ${owner.pathname.endsWith(".ts") ? `await import(${JSON.stringify(loader)});` : ""}
      const fs=await import("node:fs");
      const {DatabaseSync}=await import("node:sqlite");
      const {runGatewayServiceUpdateCommand}=await import(${JSON.stringify(owner.href)});
      const {execFileUtf8}=await import(${JSON.stringify(exec)});
      const mode=process.argv[process.argv.indexOf("--update-executor")+1];
      await runGatewayServiceUpdateCommand(mode,"restart",async()=>{
        fs.writeFileSync(${JSON.stringify(scratch + "/receiver-pid")},JSON.stringify({pid:process.pid,parent:process.ppid}));
        if(${JSON.stringify(scenario)}==="revoked") {
          const db=new DatabaseSync(${JSON.stringify(databasePath)});
          db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run("revoked",${JSON.stringify(root)});db.close();
        }
        if(${JSON.stringify(scenario)}==="retargeted") {
          fs.copyFileSync(${JSON.stringify(databasePath)},${JSON.stringify(databasePath + ".copy")});
          fs.renameSync(${JSON.stringify(databasePath + ".copy")},${JSON.stringify(databasePath)});
        }
        const r=await execFileUtf8(process.execPath,["-e",${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(scratch + "/native-effect")},"restarted")`)}]);
        if(r.code!==0)throw new Error(r.stderr);
        process.stdout.write(JSON.stringify({action:"restart",ok:true,result:"restarted"}));
      });
    `,
      );
      const snapshot = {
        path: configPath,
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: {},
        resolved: {},
        valid: true,
        runtimeConfig: {},
        config: {},
        issues: [],
        warnings: [],
        legacyIssues: [],
      };
      const grantless = scenario.startsWith("grantless");
      if (grantless && !incumbent) {
        expect(store.release(bound)).toBe(true);
        expect(store.release(acquired.lease)).toBe(true);
      }
      const input = {
        ...(grantless ? {} : { executor }),
        bufferedSteps: [],
        resultPath: path.join(scratch, "result.json"),
        params: {
          root,
          ...(ownedEnvironment ? { ownedManagedUpdateEnv: originalEnvironment } : {}),
          mutationStarted: true,
          installKindChanged: false,
          configSnapshot: snapshot,
          requestedChannel: null,
          storedChannel: "stable",
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: true,
          opts: { json: true, yes: true, run: { runId, env } },
          result: { status: "ok", mode: "npm", root, steps: [], durationMs: 0 },
          controlPlaneUpdateSentinelMeta: null,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          packageUpdateNodeRunner: process.execPath,
          updateStepTimeoutMs: 20000,
          rollbackBlockedReason:
            scenario === "rollback-state-unverified" ? scenario : "state-migrated-no-rollback",
        },
      };
      command = commandRunner.runUtf8CommandWithTimeout(
        [
          process.execPath,
          "--import",
          loader,
          fileURLToPath(
            new URL("./update-command-legacy-finalize.test-support.ts", import.meta.url),
          ),
        ],
        {
          input: JSON.stringify(input),
          env: scratchEnvironment
            ? { ...originalEnvironment, TMPDIR: workerTemp, TMP: workerTemp, TEMP: workerTemp }
            : env,
          baseEnv: {},
          cwd: root,
          timeoutMs: 60000,
          signal,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          beforeInput(pid) {
            if (grantless) {
              return;
            }
            const registered = store.bind(child.lease, pid);
            if (!registered) {
              throw new Error("Legacy binding failed");
            }
            bound = registered;
          },
        },
      );
      const result = await command;
      assertLegacyCommandJoined(result);
      signal.throwIfAborted();
      const details = result.stderr + "\n" + result.stdout;
      if (incumbent) {
        expect(result.code, details).not.toBe(0);
        expect(fs.existsSync(path.join(scratch, "receiver-pid"))).toBe(false);
        expect(store.current(acquired.lease)).toBe(true);
        expect(fs.existsSync(path.join(scratch, "native-effect"))).toBe(false);
      } else if (scenario === "revoked" || scenario === "retargeted") {
        expect(fs.existsSync(path.join(scratch, "receiver-pid")), details).toBe(true);
        expect(fs.existsSync(path.join(scratch, "native-effect")), details).toBe(false);
        expect(result.code, details).not.toBe(0);
      } else {
        expect(result.code, details).toBe(0);
        expect(JSON.parse(fs.readFileSync(input.resultPath, "utf8")), details).toMatchObject({
          exitCode: 0,
          terminalRunId: runId,
          result: { status: "ok" },
        });
        expect(fs.readFileSync(path.join(scratch, "native-effect"), "utf8")).toBe("restarted");
        const receiver = JSON.parse(fs.readFileSync(path.join(scratch, "receiver-pid"), "utf8"));
        expect(receiver.parent).toBe(
          Number(fs.readFileSync(path.join(scratch, "finalizer-pid"), "utf8")),
        );
        expect(receiver.pid).not.toBe(receiver.parent);
        expect(getUpdateRun(runId, { env })).toMatchObject({ status: "succeeded" });
        if (!grantless) {
          expect(store.release(bound)).toBe(true);
          expect(store.release(acquired.lease)).toBe(true);
        }
        expect(store.read(root).kind).toBe("absent");
      }
      if (scratchEnvironment) {
        // Neither healthy completion nor refusal may create a worker-private
        // competing lease database. This is the shipped producer's temp override.
        const workerLeasePath = path.join(
          workerTemp,
          typeof process.getuid === "function" ? `openclaw-${process.getuid()}` : "openclaw",
          "managed-update-handoffs.sqlite",
        );
        expect(fs.existsSync(workerLeasePath), details).toBe(false);
      }
    } finally {
      await closeLegacyFixture(command, () => {
        releaseChild?.();
        releaseParent?.();
      });
    }
  });
}

it.for(["joined", "uncertain"] as const)(
  "joins the legacy fixture before releasing its inputs (cleanup=%s)",
  async (cleanup, { signal: contextSignal }) => {
    contextSignal.throwIfAborted();
    // A failed drain deliberately retains its claim. Isolate that expected
    // refusal from the resource owner running the surrounding suite.
    const namespace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "legacy-cleanup-owner-")),
    );
    const owner = createVitestResourceOwner(namespace);
    for (const key of ["TMPDIR", "TMP", "TEMP"]) {
      vi.stubEnv(key, namespace);
    }
    const cancellation = new AbortController();
    const rescue = new AbortController();
    const signal = AbortSignal.any([contextSignal, cancellation.signal]);
    const reason = new Error("legacy fixture canceled");
    const ready = createDeferred();
    const joined = createDeferred();
    const returnResult = createDeferred();
    const run = commandRunner.runUtf8CommandWithTimeout;
    const closeDatabase = stateDatabase.closeOpenClawStateDatabase;
    const remove = fs.promises.rm;
    const events: string[] = [];
    let scratch = "";
    let childKey = "";
    let fixtureEnv: NodeJS.ProcessEnv | undefined;
    let identity: ReturnType<typeof requireNodeWorkerProcessIdentity> | undefined;
    let command: ReturnType<typeof run> | undefined;
    let output = "";
    const root = fs.realpathSync(process.cwd());
    const leaseStore = () => {
      if (!fixtureEnv) {
        throw new Error("Legacy fixture command environment was not captured");
      }
      return createManagedHandoffLeaseStore({
        databasePath: path.join(scratch, "managed-update-handoffs.sqlite"),
        serviceManagerEnv: fixtureEnv,
      });
    };
    const unblock = () => {
      returnResult.resolve();
      rescue.abort(contextSignal.reason);
    };
    contextSignal.addEventListener("abort", unblock, { once: true });
    vi.spyOn(commandRunner, "runUtf8CommandWithTimeout").mockImplementation((_argv, options) => {
      if (typeof options === "number") {
        throw new Error("Legacy fixture lost its command options");
      }
      expect(options.signal).toBe(signal);
      fixtureEnv = options.env;
      if (!fixtureEnv) {
        throw new Error("Legacy fixture lost its command environment");
      }
      scratch = fixtureEnv.OPENCLAW_STATE_DIR!;
      childKey = (JSON.parse(String(options.input)) as { executor: { childKey: string } }).executor
        .childKey;
      // Substitute only this fixture payload, not the real runner, admission,
      // cancellation or process-tree owner used by the legacy scenario.
      command = run(
        [
          process.execPath,
          "-e",
          'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
        ],
        {
          ...options,
          signal: AbortSignal.any([options.signal!, rescue.signal]),
          beforeInput(pid) {
            options.beforeInput!(pid);
            identity = requireNodeWorkerProcessIdentity(pid);
          },
          onOutputChunk(chunk, stream) {
            if (stream === "stdout") {
              output = (output + chunk.toString("utf8")).slice(-16);
              if (output.includes("ready\n")) {
                ready.resolve();
              }
            }
          },
        },
      );
      return command.then(async (result): Promise<Awaited<ReturnType<typeof run>>> => {
        assertLegacyCommandJoined(result);
        events.push("command-joined");
        joined.resolve();
        await returnResult.promise;
        return { ...result, cleanup: cleanup === "uncertain" ? "uncertain" : result.cleanup };
      });
    });
    vi.spyOn(stateDatabase, "closeOpenClawStateDatabase").mockImplementation(() => {
      expect(leaseStore().read(root).kind).toBe("absent");
      expect(leaseStore().read(childKey).kind).toBe("absent");
      events.push("database-closed");
      closeDatabase();
    });
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (String(target) === scratch) {
        expect(events).toEqual(["command-joined", "database-closed"]);
        events.push("inputs-removed");
      }
      await remove(target, options);
    });
    const body = runLegacyFinalizationScenario("revoked", signal);
    const outcome = body.catch((error: unknown) => error);
    let drain: Promise<void> | undefined;
    let drained = false;
    try {
      await Promise.race([
        ready.promise,
        body.then(() => {
          throw new Error("Legacy fixture ended before child readiness");
        }),
      ]);
      expect(identity).toBeDefined();
      expect(inspectNodeWorkerProcessIdentity(identity!)).toBe("live");
      cancellation.abort(reason);
      // This driver is outside fixture.run: teardown must wait for the actual
      // scenario continuation, not await itself or only the command's exit.
      drain = fixture.cleanup().then(() => {
        drained = true;
      });
      void drain.catch(() => {});
      await Promise.race([joined.promise, body]);
      expect(inspectNodeWorkerProcessIdentity(identity!)).toBe("dead");
      expect(events).toEqual(["command-joined"]);
      expect(drained).toBe(false);
      expect(fs.existsSync(scratch)).toBe(true);
      expect(leaseStore().read(root).kind).toBe("current");
      expect(leaseStore().read(childKey).kind).toBe("current");
      returnResult.resolve();
      if (cleanup === "uncertain") {
        await expect(body).rejects.toThrow("Legacy finalizer process cleanup is unverified");
        await expect(drain).rejects.toThrow("Fixture cleanup unverified");
        expect(events).toEqual(["command-joined"]);
        expect(fs.existsSync(scratch)).toBe(true);
        expect(leaseStore().read(root).kind).toBe("current");
        expect(leaseStore().read(childKey).kind).toBe("current");
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      } else {
        expect(await outcome).toBe(reason);
        await drain;
        expect(events).toEqual(["command-joined", "database-closed", "inputs-removed"]);
        expect(fs.existsSync(scratch)).toBe(false);
        expect(() => owner.assertReleased()).not.toThrow();
      }
    } finally {
      try {
        unblock();
        const result = await command;
        assertLegacyCommandJoined(result);
        await outcome;
        await (drain ?? fixture.cleanup()).catch(() => {});
        // Only the injected uncertainty is rescued: the real command above
        // has joined. Never delete another owner's retained or live inputs.
        if (scratch && fs.existsSync(scratch)) {
          for (const key of [childKey, root]) {
            const row = leaseStore().read(key);
            if (row.kind === "current") {
              leaseStore().release(row.lease);
            }
          }
        }
        closeDatabase();
        fs.rmSync(namespace, { recursive: true, force: true });
      } finally {
        contextSignal.removeEventListener("abort", unblock);
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }
  },
);
