import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CHILD_PROCESS_SPECIFIERS = new Set(["child_process", "node:child_process"]);

const DAEMONCTL_SPAWNER_REGEX =
  /\b(startDaemon|stopDaemon|restartDaemon|startMcp|stopMcp|restartMcp|startControlPlane|stopControlPlane|restartControlPlane|startDashboardStandalone|stopDashboardStandalone|restartDashboardStandalone)\s*\(/;

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function extractModuleSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const sourceFile = ts.createSourceFile(
    "classification-input.ts",
    content,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return [...specifiers];
}

function sourceCandidates(candidatePath: string): string[] {
  const extension = path.extname(candidatePath);
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return [`${candidatePath.slice(0, -extension.length)}.ts`];
  }
  if (extension === ".ts") return [candidatePath];
  if (extension !== "") return [];
  return [`${candidatePath}.ts`, path.join(candidatePath, "index.ts")];
}

export function resolveSourceImport(
  importerPath: string,
  specifier: string,
  repoRoot: string,
): string | null {
  if (!specifier.startsWith(".")) return null;

  const absoluteImport = path.resolve(path.dirname(importerPath), specifier);
  const distRoot = path.join(repoRoot, "dist");
  const srcRoot = path.join(repoRoot, "src");
  let sourceBase: string;

  if (absoluteImport === distRoot || absoluteImport.startsWith(`${distRoot}${path.sep}`)) {
    sourceBase = path.join(srcRoot, path.relative(distRoot, absoluteImport));
  } else if (
    absoluteImport === srcRoot ||
    absoluteImport.startsWith(`${srcRoot}${path.sep}`)
  ) {
    sourceBase = absoluteImport;
  } else {
    return null;
  }

  for (const candidate of sourceCandidates(sourceBase)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function fileImportsChildProcess(filePath: string): boolean {
  const content = readText(filePath);
  if (content === null) return false;
  return extractModuleSpecifiers(content).some((specifier) =>
    CHILD_PROCESS_SPECIFIERS.has(specifier),
  );
}

export function fileCallsDaemonSpawner(filePath: string): boolean {
  const content = readText(filePath);
  return content !== null && DAEMONCTL_SPAWNER_REGEX.test(content);
}

function importedBindingsBySource(filePath: string, repoRoot: string): Map<string, Set<string>> {
  const content = readText(filePath);
  const bindings = new Map<string, Set<string>>();
  if (content === null) return bindings;
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const resolved = resolveSourceImport(filePath, statement.moduleSpecifier.text, repoRoot);
    if (!resolved) continue;
    const names = bindings.get(resolved) ?? new Set<string>();
    const clause = statement.importClause;
    if (clause?.name) names.add("default");
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) names.add("*");
      else for (const element of clause.namedBindings.elements) names.add((element.propertyName ?? element.name).text);
    }
    bindings.set(resolved, names);
  }
  return bindings;
}

function spawningDependencyLocals(sourceModule: string, repoRoot: string): Map<string, string> {
  const content = readText(sourceModule);
  const locals = new Map<string, string>();
  if (content === null) return locals;
  const sourceFile = ts.createSourceFile(sourceModule, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const dependency = resolveSourceImport(sourceModule, statement.moduleSpecifier.text, repoRoot);
    if (!dependency || !fileImportsChildProcess(dependency)) continue;
    const clause = statement.importClause;
    if (clause?.name) locals.set(clause.name.text, dependency);
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) locals.set(clause.namedBindings.name.text, dependency);
      else for (const element of clause.namedBindings.elements) locals.set(element.name.text, dependency);
    }
  }
  return locals;
}

function importedExportUsesAny(sourceModule: string, exportNames: Set<string>, localNames: Set<string>): boolean {
  const content = readText(sourceModule);
  if (content === null || localNames.size === 0) return false;
  const sourceFile = ts.createSourceFile(sourceModule, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

  function containsImportedLocal(node: ts.Node): boolean {
    let found = false;
    function visit(child: ts.Node): void {
      if (ts.isIdentifier(child) && localNames.has(child.text)) found = true;
      else if (!found) ts.forEachChild(child, visit);
    }
    visit(node);
    return found;
  }

  for (const statement of sourceFile.statements) {
    const exported = ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
    if (!exported) continue;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name &&
        (exportNames.has("*") || exportNames.has(statement.name.text)) && containsImportedLocal(statement)) return true;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && (exportNames.has("*") || exportNames.has(declaration.name.text)) &&
            containsImportedLocal(declaration)) return true;
      }
    }
  }
  return false;
}

/**
 * Find process-spawning source modules reached from a test import.
 *
 * Besides checking source modules imported directly by the test, inspect one
 * additional source-import edge when an export imported by the test actually
 * references a binding from the process-spawning dependency. This catches
 * facade wrappers without classifying every pure export in a large module.
 */
export function findImportedProcessSpawners(
  testFilePath: string,
  repoRoot: string,
): string[] {
  const spawners = new Set<string>();

  for (const [importedModule, importedExports] of importedBindingsBySource(
    testFilePath,
    repoRoot,
  )) {
    if (fileImportsChildProcess(importedModule)) {
      spawners.add(importedModule);
    }
    const dependencyLocals = spawningDependencyLocals(importedModule, repoRoot);
    if (
      importedExportUsesAny(
        importedModule,
        importedExports,
        new Set(dependencyLocals.keys()),
      )
    ) {
      for (const dependency of dependencyLocals.values()) spawners.add(dependency);
    }
  }

  return [...spawners].sort();
}

export function classifyTestFile(filePath: string, repoRoot: string): string[] {
  const reasons: string[] = [];
  if (fileImportsChildProcess(filePath)) reasons.push("imports node:child_process");
  if (fileCallsDaemonSpawner(filePath)) reasons.push("calls daemonctl spawner");

  if (reasons.length === 0) {
    for (const sourceModule of findImportedProcessSpawners(filePath, repoRoot)) {
      reasons.push(
        `imports process-spawning source module ${path.relative(repoRoot, sourceModule)}`,
      );
    }
  }

  return reasons;
}

export interface SerialMembershipAudit {
  missing: string[];
  unjustified: string[];
}

export function auditSerialMembership(
  testFiles: string[],
  serialEntries: string[],
  repoRoot: string,
): SerialMembershipAudit {
  const serial = new Set(serialEntries);
  const classifications = new Map<string, string[]>();

  for (const testFile of testFiles) {
    classifications.set(path.relative(repoRoot, testFile), classifyTestFile(testFile, repoRoot));
  }

  const missing = [...classifications]
    .filter(([relativePath, reasons]) => reasons.length > 0 && !serial.has(relativePath))
    .map(([relativePath, reasons]) => `${relativePath} (${reasons.join("; ")})`)
    .sort();

  const unjustified = serialEntries
    .filter((entry) => (classifications.get(entry) ?? []).length === 0)
    .map(
      (entry) =>
        `${entry} (does not match the process-spawning classification rule)`,
    )
    .sort();

  return { missing, unjustified };
}
