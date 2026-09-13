import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  normalizePublicationIntent,
  publicationIntentInputs,
  publicationSourceContract,
  publicationSourceJson,
  publicationSourceRequest,
  createPublicationSourceFact,
  validatePublicationSourceBinding,
  type PublicationSourceFact,
} from "../../scripts/full-release-publication-contract.mjs";
import { resolveReleaseContextIdentity } from "../../scripts/lib/release-context.mjs";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const repo = resolve(".");
const workflowPath = ".github/workflows/full-release-validation.yml";
type Step = {
  name: string;
  id?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
};
type Workflow = {
  on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
  jobs: Record<string, { steps: Step[]; if?: string; needs?: string | string[] }>;
};
const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;
const toolingPaths = [
  "package.json",
  "pnpm-lock.yaml",
  "scripts/preflight-frozen-target-contracts.mjs",
  "scripts/lib/frozen-target-source.mjs",
  "scripts/lib/docker-e2e-plan.mts",
  "scripts/lib/docker-e2e-scenarios.mts",
  "scripts/lib/official-external-channel-catalog.json",
  "scripts/lib/upgrade-survivor-policy.mjs",
  "scripts/lib/frozen-target-compat.sh",
  "scripts/resolve-frozen-codex-live-suite.mjs",
  "scripts/resolve-fs-safe-native-contract.mjs",
  "scripts/e2e/lib/upgrade-survivor/config-recipe.mts",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/plan-release-workflow-matrix.mjs",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/plugin-prerelease-test-plan.mts",
  "scripts/plan-targeted-docker-lane-groups.mjs",
  "scripts/lib/numeric-options.mjs",
  "scripts/release-plan-producer.mts",
  "scripts/release-plan-producer-core.mts",
  "scripts/release-plan-contract.mjs",
  "scripts/release-tooling-identity.mjs",
  "scripts/release-validation-intent.mjs",
  "scripts/lib/bounded-response.mjs",
  "scripts/lib/canonical-json.mjs",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/npm-core-release-packages.json",
  "scripts/lib/plugin-publication-candidates.ts",
  "scripts/lib/plugin-publication-collector.ts",
  "scripts/lib/plugin-publication-target.mjs",
  "scripts/lib/pnpm-lockfile-documents.mjs",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/release-version.mjs",
  "packages/normalization-core/src/record-coerce.ts",
  "packages/normalization-core/src/string-coerce.ts",
  "packages/plugin-package-contract/src/categories.ts",
  "packages/plugin-package-contract/src/index.ts",
  "scripts/full-release-publication-contract.mjs",
  "scripts/full-release-publication-admission.mts",
  "scripts/lib/plugin-npm-release.ts",
  "scripts/lib/npm-json-output.mts",
  "packages/normalization-core/src/expect.ts",
  "src/utils/run-with-concurrency.ts",
  "scripts/tsx.mjs",
  "scripts/lib/tsx-cli-shim.mjs",
  "scripts/lib/local-check-runtime.mts",
];
const selection = {
  route: "normal",
  npmDistTag: "latest",
  publishOpenclawNpm: true,
  pluginPublishScope: "all-publishable",
  plugins: [],
};
const windowsSelection = {
  ...selection,
  windowsNodeTag: "v0.5.0",
  windowsNodeInstallerDigests: { "installer.exe": `sha256:${"a".repeat(64)}` },
};

describe("publication dispatch transport", () => {
  const identity = { ref: "main", fullRef: "refs/heads/main", sha: "a".repeat(40) };
  const envelope = {
    trustedWorkflow: identity,
    validationPurpose: "publish",
    publicationSelection: selection,
  };
  it.each<{
    name: string;
    value: unknown;
    pass?: boolean;
    identityFailure?: boolean;
    extra?: Record<string, string>;
  }>([
    { name: "explicit identity", value: envelope, pass: true },
    {
      name: "direct identity inference",
      value: { ...envelope, trustedWorkflow: null },
      pass: true,
    },
    {
      name: "missing purpose",
      value: { trustedWorkflow: identity, publicationSelection: selection },
    },
    {
      name: "missing identity",
      value: { validationPurpose: "publish", publicationSelection: selection },
    },
    { name: "old flat identity", value: identity },
    { name: "extra envelope field", value: { ...envelope, extra: true } },
    {
      name: "extra identity field",
      value: { ...envelope, trustedWorkflow: { ...identity, extra: true } },
    },
    { name: "invalid intent", value: { ...envelope, validationPurpose: "diagnostic" } },
    {
      name: "wrong identity SHA",
      value: { ...envelope, trustedWorkflow: { ...identity, sha: "b".repeat(40) } },
      identityFailure: true,
    },
    {
      name: "conflicting representation",
      value: envelope,
      extra: { validation_purpose: "diagnostic" },
    },
    { name: "malformed JSON", value: "{" },
  ])(
    "decodes $name before identity effects in the real workflow bodies",
    ({ name, value, pass, identityFailure, extra }) => {
      const root = temps.make("openclaw-publication-transport-");
      for (const file of [
        "scripts/full-release-publication-contract.mjs",
        "scripts/release-tooling-identity.mjs",
        "scripts/lib/record-shared.mjs",
        "scripts/lib/canonical-json.mjs",
        "scripts/lib/release-version.mjs",
      ]) {
        const destination = join(root, "workflow", file);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(repo, file), destination);
      }
      const bin = join(root, "bin");
      mkdirSync(bin);
      const calls = join(root, "calls.jsonl");
      writeFileSync(
        join(bin, "gh"),
        `#!${process.execPath}
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) !== ${JSON.stringify(
          JSON.stringify([
            "api",
            `repos/openclaw/openclaw/compare/${identity.sha}...main`,
            "--method",
            "GET",
            "--jq",
            "{status}",
          ]),
        )}) process.exit(91);
console.log('{"status":"identical"}');
`,
        { mode: 0o755 },
      );
      const steps: Record<string, { outputs: Record<string, string> }> = {};
      const inputs = {
        trusted_workflow_json: typeof value === "string" ? value : JSON.stringify(value),
        ...extra,
      };
      const resolveTarget = expectDefined(workflow.jobs.resolve_target, "resolve_target job");
      const decoderIndex = resolveTarget.steps.findIndex(
        (step) => step.id === "publication_dispatch",
      );
      const identityIndex = resolveTarget.steps.findIndex((step) => step.id === "tooling_identity");
      expect(decoderIndex).toBeGreaterThan(0);
      expect(identityIndex).toBe(decoderIndex + 1);
      expect(identityIndex).toBeLessThan(
        resolveTarget.steps.findIndex((step) => step.id === "resolve"),
      );
      let status = 0;
      let stderr = "";
      const completed: string[] = [];
      for (const step of resolveTarget.steps.slice(decoderIndex, identityIndex + 1)) {
        const output = join(root, `${step.id}.out`);
        const env: Record<string, string> = {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_OUTPUT: output,
        };
        const context = {
          inputs,
          steps,
          toJSON: JSON.stringify,
          github: { token: "", ref: identity.fullRef, ref_name: identity.ref, sha: identity.sha },
          env: { RELEASE_ISOLATION_TOOLING_CONTRACT: "2" },
        };
        for (const [key, raw] of Object.entries(step.env ?? {})) {
          env[key] = raw.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_match, expression: string) =>
            String(evaluate(expression, context)),
          );
        }
        const result = spawnSync("bash", ["-c", expectDefined(step.run, "transport command")], {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 10_000,
        });
        status = result.status ?? 1;
        stderr += result.stderr;
        if (status !== 0) {
          break;
        }
        completed.push(step.id!);
        const outputs = Object.fromEntries(
          readFileSync(output, "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
        steps[step.id!] = { outputs };
      }
      if (pass) {
        expect(status, stderr).toBe(0);
        expect(
          JSON.parse(expectDefined(steps.tooling_identity?.outputs.json, "resolved identity")),
        ).toEqual(identity);
        expect(completed).toEqual(["publication_dispatch", "tooling_identity"]);
        const forwarded = expectDefined(
          steps.publication_dispatch?.outputs.trusted_workflow_json,
          "identity transport",
        );
        expect(forwarded ? JSON.parse(forwarded) : null).toEqual(
          name === "direct identity inference" ? null : identity,
        );
        expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
      } else {
        expect(status, stderr).toBe(1);
        expect(completed).toEqual(identityFailure ? ["publication_dispatch"] : []);
        expect(existsSync(calls)).toBe(false);
        expect(steps.tooling_identity).toBeUndefined();
      }
    },
  );
});

function evaluate(expression: string, context: Record<string, unknown>) {
  const source = expression.replace(/^\s*\$\{\{|\}\}\s*$/gu, "").trim();
  return runInNewContext(source, {
    ...context,
    always: () => true,
    success: () => true,
    cancelled: () => false,
    fromJSON: JSON.parse,
    contains: (value: string | unknown[], member: string) => value.includes(member),
  }) as unknown;
}

function fixture(
  options: {
    version?: string;
    targetContextRef?: string;
    purpose?: string;
    selection?: Record<string, unknown> | null;
    sameSha?: boolean;
    toolingFullRef?: string;
    androidPin?: string;
    legacyPlatforms?: "absent-helper" | "dormant-helper";
    fault?:
      | "readme"
      | "candidate-object"
      | "tooling-object"
      | "bootstrap"
      | "import"
      | "yaml"
      | "symlink"
      | "non-utf8"
      | "dirty-candidate"
      | "dirty-android-pin"
      | "platform-helper"
      | "platform-helper-object"
      | "unselected";
  } = {},
) {
  const root = temps.make("frv-publication-admission-");
  const tooling = join(root, "workflow");
  let target = join(root, "target");
  const temporary = join(root, "tmp");
  for (const directory of [tooling, target, temporary]) {
    mkdirSync(directory);
  }
  const write = (directory: string, path: string, bytes: string | Buffer) => {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  const git = (directory: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "--no-lazy-fetch",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const commit = (directory: string) => {
    git(directory, "add", ".");
    git(directory, "commit", "-qm", "fixture");
    return git(directory, "rev-parse", "HEAD");
  };
  git(target, "init", "-q");
  const version = options.version ?? "2026.9.9";
  write(target, "package.json", JSON.stringify({ name: "openclaw", version, type: "module" }));
  const androidVersion = JSON.stringify({
    version: options.androidPin ?? version.split("-")[0],
  });
  write(target, "apps/android/version.json", androidVersion);
  writePublishablePluginFixture(target, { version, publishTo: "both" });
  if (options.fault === "unselected") {
    const other = writePublishablePluginFixture(target, {
      extensionId: "other-plugin",
      version,
      publishTo: "both",
    });
    rmSync(join(other.packageDir, "README.md"));
  }
  if (options.fault === "readme") {
    rmSync(join(target, "extensions/demo-plugin/README.md"));
  }
  if (options.fault === "symlink") {
    rmSync(join(target, "extensions/demo-plugin/README.md"));
    symlinkSync("package.json", join(target, "extensions/demo-plugin/README.md"));
  }
  if (options.fault === "non-utf8") {
    const directory = Buffer.concat([
      Buffer.from(join(target, "extensions") + "/"),
      Buffer.from([0xff]),
    ]);
    mkdirSync(directory);
    writeFileSync(Buffer.concat([directory, Buffer.from("/package.json")]), "{}");
  }
  let targetSha = commit(target);
  git(tooling, "init", "-q", "-b", "main");
  for (const path of toolingPaths) {
    write(tooling, path, readFileSync(join(repo, path)));
  }
  write(
    tooling,
    "scripts/lib/release-publish-children.sh",
    readFileSync(join(repo, "scripts/lib/release-publish-children.sh")),
  );
  for (const directory of [".github/workflows", "scripts/e2e/lib/upgrade-survivor/config-recipe"]) {
    cpSync(join(repo, directory), join(tooling, directory), { recursive: true });
  }
  if (options.legacyPlatforms) {
    write(
      tooling,
      ".github/workflows/openclaw-release-publish.yml",
      [
        "jobs:",
        "  publish:",
        "    steps:",
        "      - run: |",
        "          promote_windows_release_assets() {",
        "            dispatch_workflow windows-node-release.yml",
        "          }",
        "          promote_android_release_asset() {",
        "            dispatch_workflow android-release.yml",
        "          }",
        "  publish_docker:",
        "    uses: ./.github/workflows/docker-release.yml",
        "  publish_vcr:",
        "    uses: ./.github/workflows/vercel-container-registry-publish.yml",
        "",
      ].join("\n"),
    );
    write(tooling, "scripts/lib/release-publish-children.sh", "unrecognized unused shell data\n");
  }
  if (options.legacyPlatforms === "absent-helper" || options.fault === "platform-helper") {
    rmSync(join(tooling, "scripts/lib/release-publish-children.sh"));
  }
  if (options.sameSha) {
    const manifest = JSON.parse(readFileSync(join(tooling, "package.json"), "utf8"));
    write(
      tooling,
      "package.json",
      JSON.stringify({ ...manifest, version, dependencies: { yaml: "2.9.0" } }),
    );
    writePublishablePluginFixture(tooling, { version, publishTo: "both" });
    write(tooling, "apps/android/version.json", androidVersion);
  }
  let toolingSha = commit(tooling);
  const toolingFullRef = options.toolingFullRef ?? "refs/heads/main";
  const toolingRef = toolingFullRef.replace(/^refs\/heads\//u, "");
  if (toolingFullRef !== "refs/heads/main") {
    const base = toolingSha;
    write(tooling, "main-only.txt", "main-only\n");
    commit(tooling);
    git(tooling, "checkout", "-qb", toolingRef, base);
    write(tooling, "alpha-only.txt", "alpha-only\n");
    toolingSha = commit(tooling);
    expect(
      spawnSync("git", ["merge-base", "--is-ancestor", toolingSha, "main"], {
        cwd: tooling,
      }).status,
    ).toBe(1);
  }
  if (options.sameSha) {
    target = tooling;
    targetSha = toolingSha;
  }
  for (const [fault, directory, path] of [
    ["candidate-object", target, "extensions/demo-plugin/README.md"],
    ["tooling-object", tooling, "scripts/release-plan-producer-core.mts"],
    ["platform-helper-object", tooling, "scripts/lib/release-publish-children.sh"],
  ] as const) {
    if (options.fault === fault) {
      const oid = git(directory, "rev-parse", `HEAD:${path}`);
      rmSync(join(directory, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    }
  }
  if (options.fault === "bootstrap") {
    write(
      tooling,
      "scripts/release-plan-producer.mts",
      readFileSync(join(tooling, "scripts/release-plan-producer.mts"), "utf8") +
        "\n// changed bootstrap\n",
    );
  }
  if (options.fault === "import") {
    write(
      tooling,
      "scripts/lib/bounded-response.mjs",
      readFileSync(join(tooling, "scripts/lib/bounded-response.mjs"), "utf8") +
        "\n// changed import\n",
    );
  }
  if (options.fault === "dirty-candidate") {
    write(target, "extensions/demo-plugin/package.json", "not JSON");
  }
  if (options.fault === "dirty-android-pin") {
    write(target, "apps/android/version.json", JSON.stringify({ version: "2026.8.1" }));
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  const forbidden = join(root, "forbidden");
  const requests = join(root, "identity-requests.jsonl");
  for (const command of ["npm", "curl", "wget", "docker", "git-remote-fixture"]) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${forbidden}'\nexit 91\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const args = process.argv.slice(2);
const expected = ${JSON.stringify(
      toolingFullRef === "refs/heads/main"
        ? [
            "api",
            `repos/openclaw/openclaw/compare/${toolingSha}...main`,
            "--method",
            "GET",
            "--jq",
            "{status}",
          ]
        : ["api", `repos/openclaw/openclaw/git/ref/heads/${toolingRef}`, "--method", "GET"],
    )};
if (JSON.stringify(args) !== JSON.stringify(expected)) {
  require("node:fs").appendFileSync(${JSON.stringify(forbidden)}, "unexpected gh request");
  process.exit(91);
}
require("node:fs").appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + "\\n");
process.stdout.write(${JSON.stringify(
      JSON.stringify(
        toolingFullRef === "refs/heads/main"
          ? { status: "identical" }
          : { ref: toolingFullRef, object: { type: "commit", sha: toolingSha } },
      ),
    )});
`,
    { mode: 0o755 },
  );
  const inputs = {
    ...Object.fromEntries(
      Object.entries(workflow.on.workflow_dispatch.inputs).map(([key, value]) => [
        key,
        value.default ?? "",
      ]),
    ),
    ref: targetSha,
    expected_sha: targetSha,
    target_context_ref: options.targetContextRef ?? "release/2026.9.9",
    release_profile: "beta",
    run_release_soak: false,
    rerun_group: "ci",
    trusted_workflow_json: JSON.stringify({
      trustedWorkflow: { ref: toolingRef, fullRef: toolingFullRef, sha: toolingSha },
      validationPurpose: options.purpose ?? "publish",
      publicationSelection: options.selection === null ? null : (options.selection ?? selection),
    }),
  };
  // These commands start after the existing target-identity owner; retain its
  // real version/context contract without claiming to exercise remote ancestry.
  expect(resolveReleaseContextIdentity(inputs.target_context_ref, version)).not.toBeNull();
  const steps: Record<string, { outputs: Record<string, string>; outcome: string }> = {
    resolve: { outputs: { sha: targetSha }, outcome: "success" },
    release_inputs: {
      outputs: { coverage_policy: "", target_version: version, skip_package_telegram_e2e: "false" },
      outcome: "success",
    },
    tooling_identity: {
      outputs: {
        json: JSON.stringify({ fullRef: toolingFullRef, ref: toolingRef, sha: toolingSha }),
      },
      outcome: "success",
    },
    filters: {
      outputs: {
        repo_live_suite_filter: "",
        qa_filter_seen: "",
        live_suite_filter: "",
        cross_os_suite_filter: "",
      },
      outcome: "success",
    },
    candidate_request: { outputs: { request_sha256: "" }, outcome: "success" },
    ...(options.sameSha
      ? { frozen_selection: { outputs: { parser_required: "false" }, outcome: "success" } }
      : {}),
  };
  const context = {
    inputs,
    steps,
    github: {
      workspace: root,
      sha: toolingSha,
      ref: toolingFullRef,
      ref_name: toolingRef,
      repository: "openclaw/openclaw",
      run_id: "123",
      run_attempt: 1,
      workflow_ref: `openclaw/openclaw/${workflowPath}@${toolingFullRef}`,
    },
  };
  const effects: string[] = [];
  let status = 0;
  let stderr = "";
  const resolveTarget = expectDefined(workflow.jobs.resolve_target, "resolve_target job");
  const start = resolveTarget.steps.findIndex((step) => step.id === "release_inputs") + 1;
  const end = resolveTarget.steps.findIndex((step) => step.name === "Summarize target");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  for (const step of [
    expectDefined(
      resolveTarget.steps.find((candidate) => candidate.id === "publication_dispatch"),
      "dispatch decoder",
    ),
    ...resolveTarget.steps.slice(start, end),
  ]) {
    // The same-SHA control exercises the actual publication commands, not the
    // separate C/D contract, whose complete current-source fixture is different.
    if (
      options.sameSha &&
      [
        "Plan frozen source admission",
        "Acquire selected contract objects",
        "Admit frozen source contracts",
      ].includes(step.name)
    ) {
      continue;
    }
    if (step.if && !evaluate(step.if, context)) {
      continue;
    }
    if (!step.run) {
      continue;
    }
    if (step.name === "Provision trusted admission parser") {
      // Installation is a separate prerequisite proof; this fixture exercises its
      // actual selection predicate and the producer's verified runtime consumer.
      expect(step["working-directory"]).toBe("workflow");
      expect(step.run.trim()).toBe(
        "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts",
      );
      if (options.fault === "yaml") {
        mkdirSync(join(tooling, "node_modules"));
        for (const dependency of ["tsx", "typescript", "p-map"]) {
          symlinkSync(
            realpathSync(join(repo, "node_modules", dependency)),
            join(tooling, "node_modules", dependency),
            "dir",
          );
        }
        cpSync(realpathSync(join(repo, "node_modules/yaml")), join(tooling, "node_modules/yaml"), {
          recursive: true,
        });
        write(
          tooling,
          "node_modules/yaml/dist/index.js",
          readFileSync(join(tooling, "node_modules/yaml/dist/index.js"), "utf8") +
            "\n// changed YAML\n",
        );
      } else {
        symlinkSync(join(repo, "node_modules"), join(tooling, "node_modules"), "dir");
      }
      effects.push(step.name);
      continue;
    }
    const output = join(temporary, `output-${effects.length}`);
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      LANG: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_LAZY_FETCH: "1",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: toolingSha,
      GITHUB_REF: toolingFullRef,
      GITHUB_REF_NAME: toolingRef,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: temporary,
    };
    for (const [name, value] of Object.entries(step.env ?? {})) {
      env[name] = value.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_match, expression: string) =>
        String(evaluate(expression, { ...context, toJSON: JSON.stringify })),
      );
    }
    if (options.sameSha) {
      for (const name of ["PUBLICATION_TARGET_ROOT", "ADMISSION_SELECTED_ROOT"]) {
        if (env[name]) {
          env[name] = target;
        }
      }
    }
    effects.push(step.name);
    const result = spawnSync("bash", ["-c", step.run], {
      cwd: step["working-directory"] ? join(root, step["working-directory"]) : root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    status = result.status ?? 1;
    stderr += result.stderr;
    if (result.error) {
      stderr += `${step.name}: ${result.error.message}`;
    }
    if (result.status !== 0) {
      stderr += `\nFailed step: ${step.name}\n${result.stdout}`;
    }
    if (status !== 0) {
      break;
    }
    if (step.id) {
      const outputs = existsSync(output)
        ? Object.fromEntries(
            readFileSync(output, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const split = line.indexOf("=");
                return [line.slice(0, split), line.slice(split + 1)];
              }),
          )
        : {};
      steps[step.id] = { outputs, outcome: "success" };
    }
  }
  if (!options.sameSha) {
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  }
  expect(existsSync(forbidden), stderr).toBe(false);
  const factPath = join(temporary, "publication-source-admission.json");
  const fact =
    existsSync(factPath) && readFileSync(factPath, "utf8").trim()
      ? (JSON.parse(readFileSync(factPath, "utf8")) as PublicationSourceFact)
      : undefined;
  return {
    status,
    stderr,
    effects,
    steps,
    fact,
    targetSha,
    toolingSha,
    requests: existsSync(requests)
      ? readFileSync(requests, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [],
  };
}

describe("FRV publication source admission", () => {
  it.each([
    ["2026.9.9", "normal", false],
    ["2026.9.9-1", "normal", false],
    ["2026.9.9", "prepared", false],
    ["2026.9.9-1", "prepared", false],
    ["2026.9.9", "normal", true],
    ["2026.9.9-1", "prepared", true],
  ] as const)(
    "preserves beta-first %s publication through %s with Windows=%s",
    (version, route, windows) => {
      const result = fixture({
        version,
        targetContextRef: `v${version}`,
        selection: { ...(windows ? windowsSelection : selection), route, npmDistTag: "beta" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact).toMatchObject({
        status: "source-admitted",
        publicationSelection: { route, npmDistTag: "beta" },
        projection: { version },
      });
      const platforms = expectDefined(result.fact?.projection?.platforms, "source platforms");
      expect(platforms).toContainEqual({
        id: "linux",
        source: ".github/workflows/linux-app-release-request.yml",
      });
      if (windows) {
        expect(platforms).toContainEqual(expect.objectContaining({ id: "windows" }));
      } else {
        expect(platforms).not.toContainEqual(expect.objectContaining({ id: "windows" }));
      }
    },
    30_000,
  );

  it.each([
    ["refs/heads/release/2026.9.9", "2026.9.9", "normal", "beta", "release/2026.9.9"],
    [
      "refs/heads/extended-stable/2026.8.33",
      "2026.8.33",
      "extended-stable",
      "extended-stable",
      "extended-stable/2026.8.33",
    ],
  ])(
    "admits canonical branch inventory through actual divergent %s tooling",
    (toolingFullRef, version, route, npmDistTag, targetContextRef) => {
      const result = fixture({
        toolingFullRef,
        version,
        targetContextRef,
        selection: { ...selection, route, npmDistTag },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.targetSha).not.toBe(result.toolingSha);
      expect(result.fact).toMatchObject({
        status: "source-admitted",
        tooling: { ref: toolingFullRef, sha: result.toolingSha },
        projection: { version },
      });
      expect(result.requests).toEqual([
        [
          "api",
          `repos/openclaw/openclaw/git/ref/${toolingFullRef.slice("refs/".length)}`,
          "--method",
          "GET",
        ],
      ]);
    },
    30_000,
  );

  it("admits alpha inventory through actual divergent Tideclaw tooling", () => {
    const toolingFullRef = "refs/heads/tideclaw/alpha/2026-09-13-1200Z";
    const result = fixture({
      toolingFullRef,
      version: "2026.9.9-alpha.1",
      targetContextRef: "v2026.9.9-alpha.1",
      selection: { ...selection, route: "alpha", npmDistTag: "alpha" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.targetSha).not.toBe(result.toolingSha);
    expect(result.fact).toMatchObject({
      status: "source-admitted",
      candidateSha: result.targetSha,
      tooling: { ref: toolingFullRef, sha: result.toolingSha },
      projection: { version: "2026.9.9-alpha.1" },
    });
    const publisher = parse(
      readFileSync(join(repo, ".github/workflows/openclaw-release-publish.yml"), "utf8"),
    ) as Workflow;
    expect(
      evaluate(expectDefined(publisher.jobs.publish_docker?.if, "Docker predicate"), {
        inputs: {
          tag: "v2026.9.9-alpha.1",
          publish_openclaw_npm: true,
          publish_docker_only: false,
        },
        needs: { publish: { result: "success" }, verify_core_npm_registry: { result: "success" } },
      }),
    ).toBe(false);
    expect(
      evaluate(expectDefined(publisher.jobs.publish_vcr?.if, "VCR predicate"), {
        needs: { publish_docker: { result: "skipped" } },
      }),
    ).toBe(false);
    expect(result.fact?.projection?.platforms).toEqual([]);
    expect(result.requests).toEqual([
      [
        "api",
        "repos/openclaw/openclaw/git/ref/heads/tideclaw/alpha/2026-09-13-1200Z",
        "--method",
        "GET",
      ],
    ]);
  }, 30_000);

  it("rejects a committed publisher metadata defect before successful root resolution", () => {
    const result = fixture({ fault: "readme" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("README.md must exist");
    for (const id of [
      "normal_ci",
      "prepare_npm_package",
      "prepare_docker_release",
      "docker_runtime_assets_preflight",
    ]) {
      const job = expectDefined(workflow.jobs[id], `${id} job`);
      expect([job.needs].flat()).toContain("resolve_target");
      expect(
        evaluate(job.if ?? "", {
          github: { run_attempt: 1 },
          inputs: { rerun_group: "all" },
          needs: {
            resolve_target: {
              result: result.status === 0 ? "success" : "failure",
              outputs: {
                candidate_required: "true",
                target_version:
                  id === "docker_runtime_assets_preflight" ? "2026.9.9-alpha.1" : "2026.9.9",
              },
            },
            evidence_reuse: { outputs: { reuse: "false" } },
          },
        }),
      ).toBe(false);
    }
  }, 30_000);

  it.each([false, true])(
    "admits complete committed inventory with same SHA=%s",
    (sameSha) => {
      const result = fixture({ sameSha, fault: sameSha ? undefined : "dirty-candidate" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact).toMatchObject({
        status: "source-admitted",
        candidateSha: result.targetSha,
        tooling: { sha: result.toolingSha },
        coverage: { rerun_group: "ci", release_profile: "beta", run_release_soak: "false" },
      });
      expect(result.fact?.projection?.packages).toEqual(
        expect.arrayContaining([
          { name: "openclaw", version: "2026.9.9", targets: ["npm"] },
          { name: "@openclaw/demo-plugin", version: "2026.9.9", targets: ["clawhub", "npm"] },
        ]),
      );
      expect(result.fact?.projection?.platforms).toEqual(
        expect.arrayContaining([
          { id: "docker", source: ".github/workflows/docker-release.yml" },
          { id: "linux", source: ".github/workflows/linux-app-release-request.yml" },
          { id: "vcr", source: ".github/workflows/vercel-container-registry-publish.yml" },
        ]),
      );
      expect(result.effects).toContain("Provision trusted admission parser");
    },
    30_000,
  );

  it.each(["diagnostic", "main-qualification", "postpublish-confidence"])(
    "retains %s without publication bootstrap or added installation",
    (purpose) => {
      const result = fixture({ purpose, selection: null, fault: "readme" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact).toMatchObject({
        status: "not-applicable",
        validationPurpose: purpose,
        inventoryDigest: null,
        projection: null,
      });
      expect(result.effects).not.toContain("Provision trusted admission parser");
      expect(result.effects).not.toContain("Acquire publication source metadata");
    },
    30_000,
  );

  it.each([
    "candidate-object",
    "tooling-object",
    "bootstrap",
    "import",
    "yaml",
    "symlink",
    "non-utf8",
    "platform-helper",
    "platform-helper-object",
  ] as const)(
    "fails closed for %s without selected execution or registry access",
    (fault) => {
      const result = fixture({ fault });
      expect(result.status, result.stderr).toBe(1);
      expect(result.fact).toBeUndefined();
      expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
    },
    30_000,
  );

  it.each([
    ["2026.9.9-alpha.1", "alpha", "alpha", "v2026.9.9-alpha.1", false],
    ["2026.9.9-beta.1", "normal", "beta", "release/2026.9.9", false],
    ["2026.9.9", "normal", "latest", "release/2026.9.9", true],
    ["2026.9.9", "normal", "beta", "v2026.9.9", true],
    ["2026.9.9-1", "normal", "beta", "v2026.9.9-1", true],
  ] as const)(
    "matches actual Windows publication selection for %s through %s to %s",
    (version, route, npmDistTag, targetContextRef, expected) => {
      const publisher = parse(
        readFileSync(join(repo, ".github/workflows/openclaw-release-publish.yml"), "utf8"),
      ) as Workflow;
      const enabled = evaluate(
        expectDefined(publisher.jobs.publish_windows?.if, "Windows predicate"),
        {
          inputs: {
            tag: `v${version}`,
            npm_dist_tag: npmDistTag,
            windows_node_tag: windowsSelection.windowsNodeTag,
            windows_node_installer_digests: JSON.stringify(
              windowsSelection.windowsNodeInstallerDigests,
            ),
          },
          needs: { finalize_github_release: { result: "success" } },
        },
      );
      expect(enabled).toBe(expected);
      const result = fixture({
        version,
        targetContextRef,
        selection: { ...windowsSelection, route, npmDistTag },
      });
      if (!enabled) {
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("Windows assets require a stable publication");
        if (route === "alpha") {
          expect(result.effects).not.toContain("Provision trusted admission parser");
        } else {
          expect(result.effects).toContain("Admit publication source");
        }
        expect(result.fact).toBeUndefined();
        return;
      }
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact?.projection?.platforms).toContainEqual({
        id: "windows",
        source: ".github/workflows/windows-node-release.yml",
      });
    },
    30_000,
  );

  it("verifies the full inventory before projecting selected plugins", () => {
    const result = fixture({
      fault: "unselected",
      selection: {
        ...selection,
        publishOpenclawNpm: false,
        pluginPublishScope: "selected",
        plugins: ["@openclaw/demo-plugin"],
      },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("README.md must exist");
  }, 30_000);

  it.each(["absent-helper", "dormant-helper"] as const)(
    "preserves inline platform tooling with %s",
    (legacyPlatforms) => {
      const result = fixture({ legacyPlatforms, selection: windowsSelection });
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact?.projection?.platforms).toEqual([
        { id: "android", source: ".github/workflows/android-release.yml" },
        { id: "docker", source: ".github/workflows/docker-release.yml" },
        { id: "vcr", source: ".github/workflows/vercel-container-registry-publish.yml" },
        { id: "windows", source: ".github/workflows/windows-node-release.yml" },
      ]);
    },
    30_000,
  );

  it("rejects unknown selected packages rather than turning them into an empty publication", () => {
    const result = fixture({
      selection: {
        ...selection,
        publishOpenclawNpm: false,
        pluginPublishScope: "selected",
        plugins: ["@openclaw/unknown"],
      },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/unknown|not found|not publishable/iu);
  }, 30_000);

  it.each(["normal", "alpha"])(
    "rejects %s core plus selected plugins before provisioning",
    (route) => {
      const result = fixture({
        selection: {
          ...selection,
          route,
          npmDistTag: route === "alpha" ? "alpha" : "latest",
          pluginPublishScope: "selected",
          plugins: ["@openclaw/demo-plugin"],
        },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("core publication requires all-publishable plugins");
      expect(result.effects).not.toContain("Provision trusted admission parser");
      expect(result.fact).toBeUndefined();
    },
    30_000,
  );

  it.each([
    ["2026.9.9-beta.1", "normal", "beta", "release/2026.9.9"],
    ["2026.9.9", "prepared", "latest", "release/2026.9.9"],
    ["2026.9.9-alpha.1", "alpha", "alpha", "v2026.9.9-alpha.1"],
    ["2026.8.33", "extended-stable", "extended-stable", "extended-stable/2026.8.33"],
  ])(
    "admits %s through the existing %s source policy",
    (version, route, npmDistTag, targetContextRef) => {
      const result = fixture({
        version,
        targetContextRef,
        selection: { ...selection, route, npmDistTag },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.fact?.projection?.version).toBe(version);
      expect(result.fact?.targetContextRef).toBe(targetContextRef);
      const platforms = expectDefined(result.fact?.projection?.platforms, "source platforms");
      if (version === "2026.9.9") {
        expect(platforms).toContainEqual({
          id: "linux",
          source: ".github/workflows/linux-app-release-request.yml",
        });
      } else {
        expect(platforms).not.toContainEqual(expect.objectContaining({ id: "linux" }));
      }
      if (route === "extended-stable") {
        expect(result.fact?.projection?.packages).toEqual(
          expect.arrayContaining([{ name: "@openclaw/demo-plugin", version, targets: ["npm"] }]),
        );
      }
    },
    30_000,
  );

  it.each([
    ["2026.9.9-beta.1", "latest", "release/2026.9.9"],
    ["2026.9.9-alpha.1", "beta", "v2026.9.9-alpha.1"],
    ["2026.8.33", "beta", "extended-stable/2026.8.33"],
  ])(
    "rejects incompatible committed %s publication to %s",
    (version, npmDistTag, targetContextRef) => {
      const result = fixture({
        version,
        targetContextRef,
        selection: { ...selection, npmDistTag },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("publication selection does not match");
      expect(result.fact).toBeUndefined();
    },
    30_000,
  );

  it("projects a selected plugin without claiming core publication or changing focused coverage", () => {
    const result = fixture({
      selection: {
        ...selection,
        publishOpenclawNpm: false,
        pluginPublishScope: "selected",
        plugins: ["@openclaw/demo-plugin"],
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.fact?.projection?.packages).toEqual([
      { name: "@openclaw/demo-plugin", version: "2026.9.9", targets: ["clawhub", "npm"] },
    ]);
    expect(result.fact?.projection?.platforms).not.toContainEqual(
      expect.objectContaining({ id: "linux" }),
    );
    expect(result.fact?.coverage.rerun_group).toBe("ci");
  }, 30_000);

  it.each([
    { version: "2026.9.9", pin: "2026.9.9", core: true, selected: true },
    { version: "2026.9.9-1", pin: "2026.9.9", core: true, selected: true },
    { version: "2026.9.9", pin: "2026.8.1", core: true, selected: false },
    { version: "2026.9.9", pin: "2026.9.09", core: true, selected: false },
    { version: "2026.9.9", pin: "2026.9.9", core: false, selected: false },
    { version: "2026.9.9-alpha.1", pin: "2026.9.9", core: true, selected: false },
    { version: "2026.9.9-beta.1", pin: "2026.9.9", core: true, selected: false },
    { version: "2026.8.33", pin: "2026.8.33", core: true, selected: false },
  ])(
    "projects Android from committed $version pin=$pin core=$core without qualification",
    ({ version, pin, core, selected }) => {
      const npmDistTag = version.includes("-alpha.")
        ? "alpha"
        : version.includes("-beta.")
          ? "beta"
          : version === "2026.8.33"
            ? "extended-stable"
            : "latest";
      const result = fixture({
        version,
        targetContextRef:
          npmDistTag === "alpha"
            ? `v${version}`
            : npmDistTag === "extended-stable"
              ? `extended-stable/${version}`
              : `release/${version.replace(/-beta\.[0-9]+$/u, "")}`,
        androidPin: pin,
        fault: "dirty-android-pin",
        selection: {
          ...selection,
          npmDistTag,
          publishOpenclawNpm: core,
          route: ["alpha", "extended-stable"].includes(npmDistTag) ? npmDistTag : "normal",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const platforms = expectDefined(result.fact?.projection?.platforms, "source platforms");
      if (selected) {
        expect(platforms).toContainEqual({
          id: "android",
          source: ".github/workflows/android-release.yml",
        });
      } else {
        expect(platforms).not.toContainEqual(expect.objectContaining({ id: "android" }));
      }
      if (npmDistTag !== "extended-stable") {
        for (const id of ["docker", "vcr"]) {
          if (core && npmDistTag !== "alpha") {
            expect(platforms).toContainEqual(expect.objectContaining({ id }));
          } else {
            expect(platforms).not.toContainEqual(expect.objectContaining({ id }));
          }
        }
      }
    },
    30_000,
  );

  it.each(["v2026.9.9", "2026.9.9\nextra=value"])(
    "rejects an invalid committed Android pin %j before admitting its source",
    (androidPin) => {
      const result = fixture({ androidPin });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("must pin an exact YYYY.M.PATCH Android version");
      expect(result.fact).toBeUndefined();
    },
    30_000,
  );

  it("keeps every expensive first-hop consumer behind successful resolution", () => {
    for (const id of [
      "normal_ci",
      "prepare_npm_package",
      "prepare_docker_release",
      "docker_runtime_assets_preflight",
    ]) {
      const job = expectDefined(workflow.jobs[id], `${id} job`);
      expect([job.needs].flat()).toContain("resolve_target");
      for (const result of ["success", "failure"]) {
        expect(
          evaluate(job.if ?? "", {
            github: { run_attempt: 1 },
            inputs: { rerun_group: "all" },
            needs: {
              resolve_target: {
                result,
                outputs: {
                  candidate_required: "true",
                  target_version:
                    id === "docker_runtime_assets_preflight" ? "2026.9.9-alpha.1" : "2026.9.9",
                },
              },
              evidence_reuse: { outputs: { reuse: "false" } },
            },
          }),
        ).toBe(result === "success");
      }
    }
  });
});

describe("publication source intent and durable binding", () => {
  it.each([
    "scripts/full-release-publication-contract.mjs",
    "scripts/full-release-publication-admission.mts",
  ])("imports %s from stdin without entering its CLI", (path) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "--input-type=module", "-"],
      {
        cwd: repo,
        input: `await import(${JSON.stringify(pathToFileURL(join(repo, path)).href)}); process.stdout.write("imported\\n");`,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("imported\n");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["vbad", false],
    ["latest", false],
    ["v0.5", false],
    ["v0.5.0", true],
    ["v0.5.0-rc.1", true],
  ])("validates Windows source tag %s using its native version contract", (tag, valid) => {
    const normalize = () =>
      normalizePublicationIntent(
        "publish",
        JSON.stringify({ ...windowsSelection, windowsNodeTag: tag }),
      );
    if (valid) {
      expect(normalize().publicationSelection?.windowsNodeTag).toBe(tag);
    } else {
      expect(normalize).toThrow("invalid Windows source tag");
    }
  });

  it.each([
    ["", ""],
    ["unknown", ""],
    ["publish", ""],
    ["diagnostic", JSON.stringify(selection)],
    ["publish", JSON.stringify({ ...selection, extra: true })],
    ["publish", JSON.stringify({ ...selection, pluginPublishScope: "selected" })],
    ["publish", JSON.stringify({ ...selection, route: "prepared", publishOpenclawNpm: false })],
  ])("rejects contradictory purpose/selection %s %s", (purpose, value) => {
    expect(() => normalizePublicationIntent(purpose, value)).toThrow();
  });

  it("keeps canonical reusable intent free of per-parent identities", () => {
    expect(
      publicationIntentInputs(normalizePublicationIntent("publish", JSON.stringify(selection))),
    ).toEqual({
      validationPurpose: "publish",
      publicationSelectionJson: publicationSourceJson(selection),
    });
  });

  it("requires exact workflow capability and rejects missing or relabeled new evidence", () => {
    expect(publicationSourceContract('env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n')).toBe(
      "1",
    );
    expect(
      publicationSourceContract('env:\n  RELEASE_ISOLATION_TOOLING_CONTRACT: "2"\n'),
    ).toBeUndefined();
    expect(() =>
      publicationSourceContract('env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "2"\n'),
    ).toThrow();
    const request = publicationSourceRequest({
      PUBLICATION_INPUTS_JSON: JSON.stringify({
        trusted_workflow_json: JSON.stringify({
          trustedWorkflow: null,
          validationPurpose: "diagnostic",
          publicationSelection: null,
        }),
        ref: "main",
        release_profile: "full",
      }),
      PUBLICATION_TOOLING_JSON: JSON.stringify({ fullRef: "refs/heads/main", sha: "a".repeat(40) }),
      PUBLICATION_TARGET_SHA: "b".repeat(40),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
    });
    const source = createPublicationSourceFact(request, null, null);
    expect(
      validatePublicationSourceBinding({ sourceAdmissionContract: "1", sourceAdmission: source }),
    ).toEqual(source);
    expect(() => validatePublicationSourceBinding({}, { sourceAdmissionContract: "1" })).toThrow(
      "contract missing",
    );
    expect(() => validatePublicationSourceBinding({ sourceAdmissionContract: "1" })).toThrow();
    expect(() => validatePublicationSourceBinding({ sourceAdmission: source })).toThrow(
      "workflow contract",
    );
    expect(() =>
      validatePublicationSourceBinding({
        sourceAdmissionContract: "1",
        sourceAdmission: { ...source, validationPurpose: "publish" },
      }),
    ).toThrow();
    expect(() =>
      validatePublicationSourceBinding({
        sourceAdmissionContract: "1",
        sourceAdmission: source,
        targetSha: "c".repeat(40),
      }),
    ).toThrow("targetSha mismatch");
    expect(() =>
      validatePublicationSourceBinding(
        {
          sourceAdmissionContract: "1",
          sourceAdmission: source,
        },
        { targetContextRef: "release/2026.9.9" },
      ),
    ).toThrow("targetContextRef mismatch");
    expect(() =>
      validatePublicationSourceBinding({
        sourceAdmissionContract: "1",
        sourceAdmission: source,
        trustedWorkflow: {
          fullRef: `refs/tags/release-publish/${"a".repeat(12)}-123`,
          sha: "a".repeat(40),
        },
      }),
    ).toThrow("trustedWorkflowFullRef mismatch");
    const admitted = createPublicationSourceFact(
      {
        ...request,
        ...normalizePublicationIntent("publish", JSON.stringify(selection)),
      },
      { packages: [], platforms: [] },
      {
        version: "2026.9.9",
        packages: [{ name: "openclaw", version: "2026.9.9", targets: ["npm"] }],
        platforms: [],
      },
    );
    const mutations = [
      (value: Record<string, any>) => {
        delete value.projection.packages[0].version;
      },
      (value: Record<string, any>) => {
        value.projection.packages[0].version = "invalid";
      },
      (value: Record<string, any>) => {
        value.projection.packages[0].targets = [];
      },
      (value: Record<string, any>) => {
        value.projection.packages[0].targets = ["other"];
      },
      (value: Record<string, any>) => {
        value.projection.packages[0].extra = true;
      },
      (value: Record<string, any>) => {
        value.projection.platforms = [{ id: "docker" }];
      },
      (value: Record<string, any>) => {
        delete value.coverage.rerun_group;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(admitted);
      mutate(changed);
      const { digest: _digest, ...content } = changed;
      changed.digest = createHash("sha256").update(publicationSourceJson(content)).digest("hex");
      expect(() =>
        validatePublicationSourceBinding({
          sourceAdmissionContract: "1",
          sourceAdmission: changed,
        }),
      ).toThrow();
    }
    for (const version of ["2026.9.9-alpha.1", "2026.9.9-beta.1", "2026.8.33", "2026.8.33-1"]) {
      const changed = structuredClone(admitted);
      changed.publicationSelection = normalizePublicationIntent(
        "publish",
        JSON.stringify(windowsSelection),
      ).publicationSelection;
      changed.projection!.version = version;
      changed.projection!.platforms = [
        { id: "windows", source: ".github/workflows/windows-node-release.yml" },
      ];
      const { digest: _digest, ...content } = changed;
      changed.digest = createHash("sha256").update(publicationSourceJson(content)).digest("hex");
      expect(() =>
        validatePublicationSourceBinding({
          sourceAdmissionContract: "1",
          sourceAdmission: changed,
        }),
      ).toThrow("Windows assets require a stable publication");
    }
  });
});
