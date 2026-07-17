/**
 * SPL2 self-defending CLI structure guards.
 *
 * The earlier SPLC split was silently undone when a concurrent branch, forked
 * before the split, restored the monolithic cli.ts during conflict resolution.
 * Behavior remained byte-identical, so behavior tests passed while the command
 * modules became dead code. These static checks make that regression loud.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const REPO_ROOT = process.cwd();
const CLI_PATH = "src/cli/cli.ts";
const COMMANDS_DIR = "src/cli/commands";

// The measured post-SPL2 dispatcher is 356 lines. 356 × 1.30 = 462.8, so 463
// gives approximately 30% routing/help headroom while ensuring the former
// ~3,255-line monolith can never be restored without failing this test.
const CLI_LINE_CEILING = 463;

// cli.ts owns only usage rendering and orchestration. Parsing the TypeScript AST
// avoids regex false positives from comments, strings, nested functions, or syntax
// formatting while keeping a deliberately small top-level implementation budget.
const TOP_LEVEL_FUNCTION_BUDGET = 3;
const ALLOWED_TOP_LEVEL_FUNCTIONS = new Set(["getUsageText", "printUsage", "main"]);

function normalize(filePath: string): string {
  return path.posix.normalize(filePath.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function collectProductionTypeScript(relativeDir: string): string[] {
  const files: string[] = [];

  function walk(directory: string): void {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true })) {
      const relativePath = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(relativePath);
      }
    }
  }

  walk(relativeDir);
  return files.sort();
}

function staticImportSpecifiers(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function resolveStaticImport(
  importer: string,
  specifier: string,
  sourceModules: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const unresolved = normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = /\.(?:js|mjs|cjs)$/.test(unresolved)
    ? [unresolved.replace(/\.(?:js|mjs|cjs)$/, ".ts")]
    : unresolved.endsWith(".ts")
      ? [unresolved]
      : [`${unresolved}.ts`, path.posix.join(unresolved, "index.ts")];
  return candidates.find((candidate) => sourceModules.has(candidate));
}

export function findUnreachableCommandModules(
  sources: ReadonlyMap<string, string>,
  root = CLI_PATH,
): string[] {
  const normalizedSources = new Map(
    [...sources].map(([filePath, source]) => [normalize(filePath), source]),
  );
  const sourceModules = new Set(normalizedSources.keys());
  const reachable = new Set<string>();
  const pending = [normalize(root)];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const source = normalizedSources.get(current);
    if (source === undefined) continue;
    for (const specifier of staticImportSpecifiers(source, current)) {
      const imported = resolveStaticImport(current, specifier, sourceModules);
      if (imported && !reachable.has(imported)) pending.push(imported);
    }
  }

  return [...sourceModules]
    .filter((filePath) => filePath.startsWith(`${COMMANDS_DIR}/`) && !reachable.has(filePath))
    .sort();
}

function repositoryCliSources(): Map<string, string> {
  const files = [CLI_PATH, ...collectProductionTypeScript("src/cli")];
  return new Map(
    [...new Set(files)].map((filePath) => [
      filePath,
      fs.readFileSync(path.join(REPO_ROOT, filePath), "utf8"),
    ]),
  );
}

function topLevelFunctionNames(source: string): string[] {
  const sourceFile = ts.createSourceFile(CLI_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sourceFile.statements
    .filter(ts.isFunctionDeclaration)
    .map((statement) => statement.name?.text ?? "<anonymous>");
}

describe("SPL2 CLI static structure", () => {
  it("finds named command modules disconnected from a dispatcher-rooted import graph", () => {
    const sources = new Map([
      [CLI_PATH, 'import "./commands/connected.js";'],
      ["src/cli/commands/connected.ts", 'export { value } from "./nested/value.js";'],
      ["src/cli/commands/nested/value.ts", "export const value = true;"],
      ["src/cli/commands/disconnected.ts", "export const disconnected = true;"],
    ]);

    assert.deepEqual(findUnreachableCommandModules(sources), [
      "src/cli/commands/disconnected.ts",
    ]);
  });

  it("keeps every command module reachable from src/cli/cli.ts", () => {
    const unreachable = findUnreachableCommandModules(repositoryCliSources());
    assert.deepEqual(
      unreachable,
      [],
      `Command modules unreachable from ${CLI_PATH} (${unreachable.length}):\n${unreachable.join("\n")}`,
    );
  });

  it("keeps cli.ts below its post-split line ceiling", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, CLI_PATH), "utf8");
    const lineCount = source.trimEnd().split(/\r?\n/).length;

    assert.ok(
      lineCount <= CLI_LINE_CEILING,
      `${CLI_PATH} grew to ${lineCount} lines (ceiling: ${CLI_LINE_CEILING}); move command logic into ${COMMANDS_DIR}/`,
    );
  });

  it("keeps only the dispatcher orchestration function implementations in cli.ts", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, CLI_PATH), "utf8");
    const functionNames = topLevelFunctionNames(source);
    const unexpected = functionNames.filter((name) => !ALLOWED_TOP_LEVEL_FUNCTIONS.has(name));

    assert.ok(
      functionNames.length <= TOP_LEVEL_FUNCTION_BUDGET && unexpected.length === 0,
      `${CLI_PATH} has top-level functions [${functionNames.join(", ")}]; budget is ${TOP_LEVEL_FUNCTION_BUDGET} and command implementations belong in ${COMMANDS_DIR}/`,
    );
  });
});
