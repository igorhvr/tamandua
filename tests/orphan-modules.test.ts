/**
 * DEDC orphan-module guard.
 *
 * A concurrent merge once restored the monolithic CLI after it had been split,
 * leaving the entire src/cli/commands tree disconnected while later changes
 * continued landing in those dead modules. This guard makes that failure mode
 * visible by requiring every source module to be imported or be a discovered
 * executable/package entrypoint.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// These two source surfaces predate package export metadata. They are kept
// deliberately: index.ts is the library facade, while cli/shared.ts is the
// reserved shared API for the planned CLI re-split. Keep this exceptional
// baseline short; runtime entrypoints belong in package/build metadata.
const SOURCE_SURFACE_EXCEPTIONS = new Set(["src/index.ts", "src/cli/shared.ts"]);

function normalizeRepositoryPath(filePath: string): string {
  return path.posix.normalize(filePath.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function sourcePathForCompiledPath(filePath: string): string | undefined {
  const normalized = normalizeRepositoryPath(filePath).replace(/[?#].*$/, "");
  const distIndex = normalized.lastIndexOf("dist/");
  if (distIndex < 0 || !/\.(?:js|mjs|cjs)$/.test(normalized)) return undefined;
  return `src/${normalized.slice(distIndex + "dist/".length).replace(/\.(?:js|mjs|cjs)$/, ".ts")}`;
}

function packageEntrypointValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(packageEntrypointValues);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(packageEntrypointValues);
  }
  return [];
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveImport(
  importer: string,
  specifier: string,
  modules: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  let resolved = normalizeRepositoryPath(path.posix.join(path.posix.dirname(importer), specifier));
  resolved = resolved.replace(/[?#].*$/, "");

  const compiledSource = sourcePathForCompiledPath(resolved);
  if (compiledSource && modules.has(compiledSource)) return compiledSource;

  const candidates = /\.(?:js|mjs|cjs)$/.test(resolved)
    ? [resolved.replace(/\.(?:js|mjs|cjs)$/, ".ts")]
    : resolved.endsWith(".ts")
      ? [resolved]
      : [`${resolved}.ts`, path.posix.join(resolved, "index.ts")];
  return candidates.find((candidate) => modules.has(candidate));
}

export function findOrphanModules(files: ReadonlyMap<string, string>): string[] {
  const normalizedFiles = new Map(
    [...files].map(([filePath, contents]) => [normalizeRepositoryPath(filePath), contents]),
  );
  const modules = new Set(
    [...normalizedFiles.keys()].filter(
      (filePath) => filePath.startsWith("src/") && filePath.endsWith(".ts") && !filePath.endsWith(".test.ts"),
    ),
  );
  const imported = new Set<string>();
  const entrypoints = new Set(
    [...SOURCE_SURFACE_EXCEPTIONS].filter((modulePath) => modules.has(modulePath)),
  );

  const packageSource = normalizedFiles.get("package.json");
  if (packageSource) {
    const packageJson = JSON.parse(packageSource) as Record<string, unknown>;
    for (const field of ["bin", "main", "module", "browser", "exports"]) {
      for (const entry of packageEntrypointValues(packageJson[field])) {
        const sourcePath = sourcePathForCompiledPath(entry);
        if (sourcePath && modules.has(sourcePath)) entrypoints.add(sourcePath);
      }
    }
  }

  const compiledReference = /(?:^|[^A-Za-z0-9_.-])(?:\.\.?\/)*dist\/([A-Za-z0-9_./-]+\.(?:js|mjs|cjs))\b/g;
  for (const [consumerPath, contents] of normalizedFiles) {
    for (const match of contents.matchAll(compiledReference)) {
      const sourcePath = sourcePathForCompiledPath(`dist/${match[1]}`);
      if (sourcePath && modules.has(sourcePath)) entrypoints.add(sourcePath);
    }
    for (const specifier of extractImportSpecifiers(contents)) {
      const importedPath = resolveImport(consumerPath, specifier, modules);
      if (importedPath && importedPath !== consumerPath) imported.add(importedPath);
    }
  }

  return [...modules]
    .filter((modulePath) => !entrypoints.has(modulePath) && !imported.has(modulePath))
    .sort();
}

describe("DEDC orphan-module scanner", () => {
  it("flags a known orphan while preserving an imported module", () => {
    const files = new Map([
      ["package.json", JSON.stringify({ bin: { fixture: "dist/app.js" } })],
      ["src/app.ts", 'import "./feature/connected.js";'],
      ["src/feature/connected.ts", "export const connected = true;"],
      ["src/feature/orphan.ts", "export const orphan = true;"],
    ]);

    assert.deepEqual(findOrphanModules(files), ["src/feature/orphan.ts"]);
  });

  it("resolves imports by directory instead of basename", () => {
    const files = new Map([
      ["package.json", JSON.stringify({ bin: { fixture: "dist/app.js" } })],
      ["src/app.ts", 'import "./used/shared.js";'],
      ["src/used/shared.ts", "export const used = true;"],
      ["src/orphan/shared.ts", "export const unused = true;"],
    ]);

    assert.deepEqual(findOrphanModules(files), ["src/orphan/shared.ts"]);
  });
});

function collectRepositoryFiles(repoRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  const roots = ["src", "scripts", "tests", "e2e-tests"];
  const readableExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".sh"]);

  function walk(relativeDir: string): void {
    const absoluteDir = path.join(repoRoot, relativeDir);
    if (!fs.existsSync(absoluteDir)) return;
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (entry.isFile() && readableExtensions.has(path.extname(entry.name))) {
        files.set(relativePath, fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
      }
    }
  }

  for (const root of roots) walk(root);
  for (const rootFile of ["package.json", "build", "install", "build-and-install"]) {
    const absolutePath = path.join(repoRoot, rootFile);
    if (fs.existsSync(absolutePath)) files.set(rootFile, fs.readFileSync(absolutePath, "utf8"));
  }
  return files;
}

describe("DEDC repository orphan-module guard", () => {
  it("has no disconnected non-test TypeScript modules", () => {
    const orphans = findOrphanModules(collectRepositoryFiles(process.cwd()));
    assert.deepEqual(
      orphans,
      [],
      `Disconnected source modules (${orphans.length}):\n${orphans.join("\n")}`,
    );
  });
});
