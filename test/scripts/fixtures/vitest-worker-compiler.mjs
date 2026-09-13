import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashVitestWorkerArtifact } from "../../../scripts/lib/vitest-worker-artifacts.mts";

// Lifecycle fixtures publish real immutable files without compiling unrelated runtime code.
export function writeWorkerFixtureManifest(directory, inputSources, outputSources) {
  const started = performance.now();
  const inputs = Object.fromEntries(
    Object.entries(inputSources)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([filename, source]) => [filename, hashVitestWorkerArtifact(source)]),
  );
  const outputs = {};
  for (const [name, source] of Object.entries(outputSources).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const target = path.join(directory, "dist", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    outputs[name] = hashVitestWorkerArtifact(source);
  }
  const manifest = {
    identity: hashVitestWorkerArtifact(JSON.stringify([inputs, outputs])),
    inputs,
    outputs,
    durationMs: performance.now() - started,
  };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
  return manifest;
}

if (import.meta.main) {
  const [directory, input, receipt] = process.argv.slice(2);
  const { stripTypeScriptTypes } = await import("node:module");
  const { runtimeProcessEntrypoints } =
    await import("../../../src/infra/runtime-process-entrypoints.ts");
  const declaration = fileURLToPath(
    new URL("../../../src/infra/runtime-process-entrypoints.ts", import.meta.url),
  );
  const declarationSource = fs.readFileSync(declaration, "utf8");
  const workerSource = fs.readFileSync(input);
  const manifest = writeWorkerFixtureManifest(
    directory,
    {
      [declaration]: declarationSource,
      [input]: workerSource,
    },
    {
      // Preserve the actual declaration policy and hash the same bytes used for output.
      "infra/runtime-process-entrypoints.js": stripTypeScriptTypes(declarationSource),
      [runtimeProcessEntrypoints.sqliteReadOnly.distWorkerPath]: workerSource,
    },
  );
  fs.appendFileSync(
    receipt,
    JSON.stringify({
      pid: process.pid,
      directory,
      inputs: Object.keys(manifest.inputs).length,
      outputs: Object.keys(manifest.outputs).length,
    }) + "\n",
  );
}
