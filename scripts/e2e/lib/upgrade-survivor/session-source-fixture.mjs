import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function captureLegacySessionSources(stateDir) {
  const directory = path.join(stateDir, "sessions");
  const sources = Object.fromEntries(
    fs.readdirSync(directory).map((name) => [
      name,
      createHash("sha256")
        .update(fs.readFileSync(path.join(directory, name)))
        .digest("hex"),
    ]),
  );
  assert(sources["sessions.json"], "Legacy session metadata was not seeded");
  return sources;
}

function usesMissingPathFixture() {
  return (
    ["base", "missing-load-path"].includes(process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO) &&
    process.env.OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE === "manual"
  );
}

function fixturePath() {
  return path.join(
    process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT,
    "missing-load-path/fixture.json",
  );
}

export function recordLegacySessionSources(stateDir) {
  if (!usesMissingPathFixture()) {
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath(), "utf8"));
  fixture.legacySessionSources = captureLegacySessionSources(stateDir);
  fs.writeFileSync(fixturePath(), `${JSON.stringify(fixture, null, 2)}\n`);
}

export function assertLegacySessionSourceDisposition(legacyStorePath, source) {
  if (!usesMissingPathFixture()) {
    assert(
      !fs.existsSync(legacyStorePath),
      `legacy sessions.json survived migration: ${legacyStorePath}`,
    );
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath(), "utf8"));
  assert.notEqual(source, "file", "Retained legacy sources must have canonical SQLite sessions");
  // Pending plugin migrations retain their sources after canonical SQLite import.
  assert.deepEqual(
    captureLegacySessionSources(path.dirname(path.dirname(legacyStorePath))),
    fixture.legacySessionSources,
    "Uninspected legacy session source bytes changed",
  );
}
