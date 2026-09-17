import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";

export function collectEagerRuntimeImportClosure(inputs: readonly string[]): string[] {
  const root = process.cwd();
  const { config } = ts.readConfigFile("tsconfig.json", (file) => ts.sys.readFile(file));
  const { options } = ts.convertCompilerOptionsFromJson(config.compilerOptions, root);
  const runtimeHost = {
    ...ts.sys,
    fileExists: (file: string) => !/\.d\.[cm]?ts$/.test(file) && ts.sys.fileExists(file),
  };
  const resolutionCache = ts.createModuleResolutionCache(root, (file) => file, options);
  const closure = new Set(inputs.map((file) => file.split(sep).join("/")));
  for (const file of closure) {
    if (!/\.[cm]?[jt]s$/.test(file)) {
      continue;
    }
    // Erase type-only edges; lazy runtime entrypoints remain explicit fixture roots.
    const { outputText } = ts.transpileModule(readFileSync(resolve(root, file), "utf8"), {
      fileName: file,
      compilerOptions: { ...options, module: ts.ModuleKind.ESNext },
    });
    const source = ts.createSourceFile(file, outputText, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (
        (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      const dependency = ts.resolveModuleName(
        specifier,
        resolve(root, file),
        options,
        runtimeHost,
        resolutionCache,
      ).resolvedModule;
      if (!dependency) {
        if (specifier.startsWith(".")) {
          throw new Error(`${file}: unresolved ${specifier}`);
        }
        continue;
      }
      if (!dependency.isExternalLibraryImport) {
        closure.add(relative(root, dependency.resolvedFileName).split(sep).join("/"));
      }
    }
  }
  return [...closure].toSorted();
}
