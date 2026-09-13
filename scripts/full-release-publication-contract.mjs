import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { canonicalizeJsonValue, compareAscii } from "./lib/canonical-json.mjs";
import { classifyReleaseTrain, parseReleaseVersion } from "./lib/release-version.mjs";

export const FULL_RELEASE_SOURCE_ADMISSION_CONTRACT = "1";
const purposes = ["publish", "diagnostic", "main-qualification", "postpublish-confidence"];
const maximumBytes = 128 * 1024;
const sha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const packageName = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;
const coverageInputs = {
  provider: "provider",
  mode: "mode",
  live_suite_filter: "liveSuiteFilter",
  cross_os_suite_filter: "crossOsSuiteFilter",
  release_package_spec: "releasePackageSpec",
  package_acceptance_package_spec: "packageAcceptancePackageSpec",
  codex_plugin_spec: "codexPluginSpec",
  npm_telegram_package_spec: "npmTelegramPackageSpec",
  npm_telegram_provider_mode: "npmTelegramProviderMode",
  npm_telegram_scenario: "npmTelegramScenario",
  plugin_prerelease_node_exclude_patterns_json: "pluginPrereleaseNodeExcludePatternsJson",
  skip_package_telegram_e2e: "skipPackageTelegramE2e",
  telegram_waiver: "telegramWaiver",
  allow_unreleased_changelog: "allowUnreleasedChangelog",
};

// This marker belongs to the top-level workflow env, not artifact-controlled data.
export function publicationSourceContract(workflowSource) {
  if (typeof workflowSource !== "string" || Buffer.byteLength(workflowSource) > 1024 * 1024) {
    throw new Error("missing or oversized source-admission workflow contract");
  }
  const matches = [
    ...workflowSource.matchAll(/^ {2}FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: *([^\r\n]+)$/gmu),
  ];
  if (!matches.length) {
    if (workflowSource.includes("FULL_RELEASE_SOURCE_ADMISSION_CONTRACT")) {
      throw new Error("unrecognized source-admission workflow contract encoding");
    }
    return undefined;
  }
  if (matches.length !== 1 || !/^(?:"1"|'1'|1)$/u.test(matches[0][1])) {
    throw new Error("unsupported source-admission workflow contract");
  }
  return FULL_RELEASE_SOURCE_ADMISSION_CONTRACT;
}

function object(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function text(value, label, limit = 4096) {
  if (typeof value !== "string" || value.length > limit) {
    throw new Error(`invalid ${label}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new Error(`invalid ${label}`);
    }
  }
  return value;
}

export function publicationSourceJson(value) {
  const json = JSON.stringify(canonicalizeJsonValue(value));
  if (Buffer.byteLength(json) > maximumBytes) {
    throw new Error("source admission exceeds byte limit");
  }
  return json;
}

function publicationSourceDigest(value) {
  return createHash("sha256").update(publicationSourceJson(value)).digest("hex");
}

export function normalizePublicationIntent(purpose, selectionJson = "") {
  if (!purposes.includes(purpose)) {
    throw new Error(`validation_purpose must be explicit: ${purposes.join(", ")}`);
  }
  if (purpose !== "publish") {
    if (selectionJson !== "") {
      throw new Error("nonpublish purpose must omit publication selection");
    }
    return { validationPurpose: purpose, publicationSelection: null };
  }
  if (
    typeof selectionJson !== "string" ||
    !selectionJson ||
    Buffer.byteLength(selectionJson) > 16 * 1024
  ) {
    throw new Error("publish purpose requires bounded publication_selection_json");
  }
  let selected;
  try {
    selected = JSON.parse(selectionJson);
  } catch {
    throw new Error("invalid publication selection JSON");
  }
  object(
    selected,
    [
      "route",
      "npmDistTag",
      "publishOpenclawNpm",
      "pluginPublishScope",
      "plugins",
      "windowsNodeTag",
      "windowsNodeInstallerDigests",
    ],
    "publication selection",
  );
  if (
    !["normal", "prepared", "extended-stable", "alpha"].includes(selected.route) ||
    !["alpha", "beta", "latest", "extended-stable"].includes(selected.npmDistTag) ||
    typeof selected.publishOpenclawNpm !== "boolean" ||
    !["selected", "all-publishable"].includes(selected.pluginPublishScope) ||
    !Array.isArray(selected.plugins) ||
    selected.plugins.length > 256 ||
    selected.plugins.some((name) => typeof name !== "string" || !packageName.test(name))
  ) {
    throw new Error("invalid publication selection operands");
  }
  const plugins = [...new Set(selected.plugins)].toSorted(compareAscii);
  if ((selected.pluginPublishScope === "selected") !== plugins.length > 0) {
    throw new Error("selected publication requires names; all-publishable must omit names");
  }
  if (selected.publishOpenclawNpm && selected.pluginPublishScope !== "all-publishable") {
    throw new Error("core publication requires all-publishable plugins");
  }
  if (
    (selected.route === "extended-stable") !== (selected.npmDistTag === "extended-stable") ||
    (selected.route === "alpha") !== (selected.npmDistTag === "alpha")
  ) {
    throw new Error("publication route and npm dist-tag disagree");
  }
  if (
    ["prepared", "extended-stable"].includes(selected.route) &&
    (selected.pluginPublishScope !== "all-publishable" || !selected.publishOpenclawNpm)
  ) {
    throw new Error("prepared and extended-stable require the complete core/plugin publication");
  }
  const windows = {};
  if (selected.windowsNodeTag !== undefined || selected.windowsNodeInstallerDigests !== undefined) {
    if (selected.route === "extended-stable") {
      throw new Error("extended-stable does not select Windows assets");
    }
    if (!["beta", "latest"].includes(selected.npmDistTag)) {
      throw new Error("Windows assets require a stable publication");
    }
    windows.windowsNodeTag = text(selected.windowsNodeTag, "Windows source tag", 256);
    if (
      !/^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/u.test(
        windows.windowsNodeTag,
      )
    ) {
      throw new Error("invalid Windows source tag");
    }
    const digests = selected.windowsNodeInstallerDigests;
    if (
      !digests ||
      typeof digests !== "object" ||
      Array.isArray(digests) ||
      !Object.keys(digests).length ||
      Object.keys(digests).length > 16 ||
      Object.entries(digests).some(
        ([name, value]) =>
          !/^[A-Za-z0-9._-]+$/u.test(name) ||
          typeof value !== "string" ||
          !/^sha256:[a-f0-9]{64}$/u.test(value),
      )
    ) {
      throw new Error("invalid Windows installer digest map");
    }
    windows.windowsNodeInstallerDigests = digests;
  }
  return {
    validationPurpose: purpose,
    publicationSelection: {
      route: selected.route,
      npmDistTag: selected.npmDistTag,
      publishOpenclawNpm: selected.publishOpenclawNpm,
      pluginPublishScope: selected.pluginPublishScope,
      plugins,
      ...windows,
    },
  };
}

export function publicationIntentInputs(intent) {
  const normalized = normalizePublicationIntent(
    intent.validationPurpose,
    intent.publicationSelection === null ? "" : publicationSourceJson(intent.publicationSelection),
  );
  return {
    validationPurpose: normalized.validationPurpose,
    publicationSelectionJson:
      normalized.publicationSelection === null
        ? ""
        : publicationSourceJson(normalized.publicationSelection),
  };
}

export function decodePublicationDispatchEnvelope(raw) {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > maximumBytes) {
    throw new Error("trusted_workflow_json requires a bounded source-admission envelope");
  }
  const value = object(
    JSON.parse(raw),
    ["trustedWorkflow", "validationPurpose", "publicationSelection"],
    "source-admission envelope",
  );
  if (Object.keys(value).length !== 3) {
    throw new Error("source-admission envelope requires identity, purpose and selection");
  }
  const trustedWorkflow = value.trustedWorkflow;
  if (trustedWorkflow !== null) {
    object(trustedWorkflow, ["ref", "fullRef", "sha"], "source-admission tooling identity");
    if (
      Object.keys(trustedWorkflow).length !== 3 ||
      typeof trustedWorkflow.ref !== "string" ||
      !/^[A-Za-z0-9._/-]+$/u.test(trustedWorkflow.ref) ||
      !["refs/heads/", "refs/tags/"].some(
        (prefix) => trustedWorkflow.fullRef === prefix + trustedWorkflow.ref,
      ) ||
      typeof trustedWorkflow.sha !== "string" ||
      !sha.test(trustedWorkflow.sha)
    ) {
      throw new Error("invalid source-admission tooling identity");
    }
  }
  return {
    trustedWorkflow,
    ...normalizePublicationIntent(
      value.validationPurpose,
      value.publicationSelection === null ? "" : publicationSourceJson(value.publicationSelection),
    ),
  };
}

export function publicationDispatchEnvelope(trustedWorkflow, intent) {
  return publicationSourceJson(
    decodePublicationDispatchEnvelope(publicationSourceJson({ trustedWorkflow, ...intent })),
  );
}

function dispatchEnvelopeFromInputs(inputs) {
  if (
    Object.hasOwn(inputs, "validation_purpose") ||
    Object.hasOwn(inputs, "publication_selection_json")
  ) {
    throw new Error("source intent must use only the trusted_workflow_json envelope");
  }
  return decodePublicationDispatchEnvelope(inputs.trusted_workflow_json);
}

export function publicationSourceRequest(env) {
  const inputs = JSON.parse(env.PUBLICATION_INPUTS_JSON);
  const { trustedWorkflow, ...intent } = dispatchEnvelopeFromInputs(inputs);
  const tooling = JSON.parse(env.PUBLICATION_TOOLING_JSON);
  if (
    trustedWorkflow &&
    ["ref", "fullRef", "sha"].some((key) => trustedWorkflow[key] !== tooling[key])
  ) {
    throw new Error("source-admission tooling differs from resolved identity");
  }
  const coverage = {};
  for (const key of [
    ...Object.keys(coverageInputs),
    "release_profile",
    "rerun_group",
    "evidence_package_spec",
    "fail_fast",
    "dispatch_release_evidence",
  ]) {
    coverage[key] = text(String(inputs[key] ?? ""), key);
  }
  coverage.live_suite_filter = env.PUBLICATION_LIVE_FILTER ?? coverage.live_suite_filter;
  coverage.cross_os_suite_filter =
    env.PUBLICATION_CROSS_OS_FILTER ?? coverage.cross_os_suite_filter;
  coverage.skip_package_telegram_e2e =
    env.PUBLICATION_SKIP_TELEGRAM ?? coverage.skip_package_telegram_e2e;
  coverage.allow_unreleased_changelog = String(
    inputs.allow_unreleased_changelog === true ||
      inputs.allow_unreleased_changelog === "true" ||
      (!inputs.target_context_ref && ["main", "refs/heads/main"].includes(inputs.ref)),
  );
  coverage.run_release_soak = String(
    inputs.run_release_soak === true ||
      inputs.run_release_soak === "true" ||
      ["stable", "full"].includes(inputs.release_profile),
  );
  coverage.coverage_policy = text(env.PUBLICATION_COVERAGE_POLICY ?? "", "coverage policy");
  return {
    repository: env.GITHUB_REPOSITORY,
    candidateSha: env.PUBLICATION_TARGET_SHA,
    targetContextRef: text(env.PUBLICATION_TARGET_CONTEXT || inputs.ref, "target context"),
    tooling: { ref: tooling.fullRef, sha: tooling.sha },
    workflow: { ref: env.GITHUB_REF, sha: env.GITHUB_SHA },
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    ...intent,
    coverage,
  };
}

export function createPublicationSourceFact(request, inventory, projection) {
  const fact = {
    kind: "openclaw.full-release-source-admission/v1",
    contract: FULL_RELEASE_SOURCE_ADMISSION_CONTRACT,
    ...request,
    status: request.validationPurpose === "publish" ? "source-admitted" : "not-applicable",
    inventoryDigest: inventory === null ? null : publicationSourceDigest(inventory),
    projection,
  };
  const result = { ...fact, digest: publicationSourceDigest(fact) };
  return validatePublicationSourceFact(result);
}

function validatePublicationSourceFact(value, expected = {}) {
  object(
    value,
    [
      "kind",
      "contract",
      "repository",
      "candidateSha",
      "targetContextRef",
      "tooling",
      "workflow",
      "runId",
      "runAttempt",
      "validationPurpose",
      "publicationSelection",
      "coverage",
      "status",
      "inventoryDigest",
      "projection",
      "digest",
    ],
    "source admission fact",
  );
  if (
    value.kind !== "openclaw.full-release-source-admission/v1" ||
    value.contract !== FULL_RELEASE_SOURCE_ADMISSION_CONTRACT ||
    value.repository !== "openclaw/openclaw" ||
    !sha.test(value.candidateSha) ||
    !/^[1-9][0-9]*$/u.test(value.runId) ||
    !Number.isSafeInteger(value.runAttempt) ||
    value.runAttempt < 1
  ) {
    throw new Error("invalid source admission identity");
  }
  text(value.targetContextRef, "source target context");
  for (const identity of [value.tooling, value.workflow]) {
    object(identity, ["ref", "sha"], "source tooling/workflow identity");
    if (
      !sha.test(identity.sha) ||
      !/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(identity.ref)
    ) {
      throw new Error("invalid source tooling/workflow identity");
    }
  }
  if (value.tooling.sha !== value.workflow.sha) {
    throw new Error("source tooling differs from executed workflow");
  }
  const intent = publicationIntentInputs(value);
  const coverageKeys = [
    ...Object.keys(coverageInputs),
    "release_profile",
    "rerun_group",
    "evidence_package_spec",
    "fail_fast",
    "dispatch_release_evidence",
    "run_release_soak",
    "coverage_policy",
  ];
  object(value.coverage, coverageKeys, "source admission coverage");
  if (coverageKeys.some((key) => !Object.hasOwn(value.coverage, key))) {
    throw new Error("source admission coverage is incomplete");
  }
  for (const entry of Object.values(value.coverage)) {
    text(entry, "source admission coverage");
  }
  if (value.validationPurpose === "publish") {
    if (value.status !== "source-admitted" || !digest.test(value.inventoryDigest)) {
      throw new Error("publish source admission requires verified complete inventory");
    }
    object(value.projection, ["version", "packages", "platforms"], "publication source projection");
    text(value.projection.version, "projection version", 128);
    const version = parseReleaseVersion(value.projection.version);
    if (!version) {
      throw new Error("invalid projection version");
    }
    if (!Array.isArray(value.projection.packages) || !Array.isArray(value.projection.platforms)) {
      throw new Error("invalid publication source projection");
    }
    if (
      (value.publicationSelection.windowsNodeTag ||
        value.projection.platforms.some((entry) => entry?.id === "windows")) &&
      classifyReleaseTrain(version) !== "stable"
    ) {
      throw new Error("Windows assets require a stable publication");
    }
    for (const [entries, name] of [
      [value.projection.packages, "name"],
      [value.projection.platforms, "id"],
    ]) {
      if (
        entries.length > 512 ||
        new Set(entries.map((entry) => entry?.[name])).size !== entries.length
      ) {
        throw new Error("duplicate or oversized publication source projection");
      }
      for (const entry of entries) {
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          !text(entry[name], "projection identity", 256)
        ) {
          throw new Error("invalid publication source projection entry");
        }
        if (name === "name") {
          object(entry, ["name", "version", "targets"], "publication package projection");
          if (
            !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(entry.name) ||
            typeof entry.version !== "string" ||
            !parseReleaseVersion(entry.version) ||
            !Array.isArray(entry.targets) ||
            entry.targets.length === 0 ||
            entry.targets.some((target) => !["npm", "clawhub"].includes(target)) ||
            JSON.stringify(entry.targets) !==
              JSON.stringify([...new Set(entry.targets)].toSorted(compareAscii))
          ) {
            throw new Error("invalid publication package version or targets");
          }
        } else {
          object(entry, ["id", "source"], "publication platform projection");
          if (
            !/^[a-z][a-z0-9-]*$/u.test(entry.id) ||
            typeof entry.source !== "string" ||
            !/^\.github\/workflows\/[a-z0-9][a-z0-9-]*\.yml$/u.test(entry.source)
          ) {
            throw new Error("invalid publication platform source");
          }
        }
      }
      if (entries.some((entry, index) => index > 0 && entries[index - 1][name] >= entry[name])) {
        throw new Error("publication projection must retain canonical ordering");
      }
    }
  } else if (
    value.status !== "not-applicable" ||
    value.inventoryDigest !== null ||
    value.projection !== null
  ) {
    throw new Error("nonpublish source admission must be not-applicable");
  }
  const { digest: actualDigest, ...content } = value;
  if (!digest.test(actualDigest) || actualDigest !== publicationSourceDigest(content)) {
    throw new Error("source admission digest mismatch");
  }
  const bindings = {
    repository: value.repository,
    targetSha: value.candidateSha,
    targetContextRef: value.targetContextRef,
    trustedWorkflowFullRef: value.tooling.ref,
    trustedWorkflowSha: value.tooling.sha,
    parentRunId: value.runId,
    sourceParentRunAttempt: value.runAttempt,
    workflowSha: value.workflow.sha,
    workflowRef: value.workflow.ref.replace(/^refs\/(?:heads|tags)\//u, ""),
    releaseProfile: value.coverage.release_profile,
    rerunGroup: value.coverage.rerun_group,
    runReleaseSoak: value.coverage.run_release_soak,
    ...intent,
  };
  for (const [key, wanted] of Object.entries(expected)) {
    if (
      wanted !== undefined &&
      Object.hasOwn(bindings, key) &&
      String(bindings[key]) !== String(wanted)
    ) {
      throw new Error(`source admission ${key} mismatch`);
    }
  }
  return value;
}

export function validatePublicationSourceBinding(record, expected = {}) {
  const contract = record.sourceAdmissionContract;
  if (
    expected.sourceAdmissionContract !== undefined &&
    contract !== expected.sourceAdmissionContract
  ) {
    throw new Error("source admission contract missing or mismatched");
  }
  if (contract === undefined) {
    if (
      record.sourceAdmission !== undefined ||
      record.validationInputs?.validationPurpose !== undefined ||
      record.validationInputs?.publicationSelectionJson !== undefined
    ) {
      throw new Error("source admission omitted its workflow contract");
    }
    return undefined;
  }
  if (contract !== FULL_RELEASE_SOURCE_ADMISSION_CONTRACT) {
    throw new Error("unsupported source admission contract");
  }
  if (record.runId !== undefined && (!record.validationInputs || !record.trustedWorkflow)) {
    throw new Error("source admission manifest omitted its inputs or canonical tooling identity");
  }
  const fact = validatePublicationSourceFact(record.sourceAdmission, {
    targetSha: record.targetSha,
    parentRunId: record.runId ?? record.parentRunId,
    workflowSha: record.workflowSha,
    workflowRef: record.workflowRef,
    sourceParentRunAttempt: record.sourceParentRunAttempt ?? record.parentRunAttempt,
    releaseProfile: record.releaseProfile,
    rerunGroup: record.rerunGroup,
    runReleaseSoak: record.runReleaseSoak,
    ...(record.trustedWorkflow
      ? {
          trustedWorkflowFullRef: record.trustedWorkflow.fullRef,
          trustedWorkflowSha: record.trustedWorkflow.sha,
        }
      : {}),
    ...expected,
  });
  if (record.validationInputs) {
    const context = record.validationInputs.targetContextRef || record.targetRef;
    if (context !== fact.targetContextRef) {
      throw new Error("source admission target context differs from manifest");
    }
    const intent = publicationIntentInputs(fact);
    for (const [key, value] of Object.entries(intent)) {
      if (record.validationInputs[key] !== value) {
        throw new Error(`source admission ${key} differs from manifest`);
      }
    }
    for (const [input, key] of Object.entries(coverageInputs)) {
      if (String(record.validationInputs[key] ?? "") !== fact.coverage[input]) {
        throw new Error(`source admission coverage ${key} differs from manifest`);
      }
    }
    if ((record.validationInputs.coveragePolicy ?? "") !== fact.coverage.coverage_policy) {
      throw new Error("source admission coverage policy differs from manifest");
    }
  }
  return fact;
}

export function publicationSourceReuseIdentity(fact) {
  if (fact === undefined) {
    return undefined;
  }
  validatePublicationSourceFact(fact);
  return {
    validationPurpose: fact.validationPurpose,
    publicationSelection: fact.publicationSelection,
    inventoryDigest: fact.inventoryDigest,
    projection: fact.projection,
  };
}

let invokedAsMain = false;
if (process.argv[1]) {
  try {
    invokedAsMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // Inline and stdin importers need not have a filesystem entrypoint.
  }
}
if (invokedAsMain) {
  try {
    if (process.argv[2] === "--dispatch") {
      const envelope = dispatchEnvelopeFromInputs(JSON.parse(process.env.PUBLICATION_INPUTS_JSON));
      const identity =
        envelope.trustedWorkflow === null ? "" : publicationSourceJson(envelope.trustedWorkflow);
      appendFileSync(process.env.GITHUB_OUTPUT, `trusted_workflow_json=${identity}\n`);
    } else if (process.argv[2] === "--request") {
      const request = publicationSourceRequest(process.env);
      const normalized = publicationIntentInputs(request);
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `required=${request.validationPurpose === "publish"}\nvalidation_purpose=${normalized.validationPurpose}\npublication_selection_json=${normalized.publicationSelectionJson}\n`,
        );
      }
      process.stdout.write(publicationSourceJson(request) + "\n");
    } else if (process.argv[2] === "--not-applicable") {
      const retained = JSON.parse(readFileSync(process.argv[3], "utf8"));
      if (retained.validationPurpose === "publish") {
        throw new Error("publish requires source inventory");
      }
      process.stdout.write(
        publicationSourceJson(createPublicationSourceFact(retained, null, null)) + "\n",
      );
    } else {
      throw new Error("unsupported source admission operation");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
