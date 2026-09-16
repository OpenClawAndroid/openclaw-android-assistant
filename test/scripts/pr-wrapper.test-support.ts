import { cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export function copyPrWrapperSources(destination: string): string[] {
  // Keep fixture sources and commits on the production inventory. Extracted
  // execution tests catch missing dependencies without a second source list.
  const components = [
    "scripts/pr",
    "scripts/pr-lib",
    ...readFileSync("scripts/pr-lib/wrapper-components.txt", "utf8").trim().split("\n"),
  ];
  for (const component of components) {
    mkdirSync(dirname(join(destination, component)), { recursive: true });
    cpSync(component, join(destination, component), { recursive: true });
  }
  return components;
}

export function linkPrWrapperDependencies(destination: string): void {
  // Fixture initialization may repeat; stale-base squash merges have reintroduced
  // duplicate initialization twice.
  const modulesDir = join(destination, "node_modules");
  mkdirSync(modulesDir, { recursive: true });
  // Use installed third-party packages only, never workspace source or loader mocks.
  for (const dependency of ["tsx", "zod", "minimatch", "yaml"]) {
    const linkedDependency = join(modulesDir, dependency);
    if (lstatSync(linkedDependency, { throwIfNoEntry: false })) {
      continue;
    }
    symlinkSync(
      realpathSync(join("node_modules", dependency)),
      linkedDependency,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}
