#!/usr/bin/env npx tsx
/**
 * Syntax gate: parse all .test.ts files with TypeScript's strict parser
 * and report ONLY syntactic (parse-level) errors — unbalanced braces,
 * missing tokens, malformed statements — not pre-existing type errors.
 *
 * Runs in seconds. Catches merge artifacts like stray }); that lenient
 * parsers (Node 22 --experimental-strip-types) may tolerate.
 */
import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

function walk(dir: string, files: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name !== "node_modules" &&
        entry.name !== "dist" &&
        entry.name !== "e2e-tests"
      ) {
        walk(full, files);
      }
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
}

const repoRoot =
  process.env.TAMANDUA_REPO_ROOT || path.resolve(import.meta.dirname ?? __dirname, "..");

const testFiles: string[] = [];
for (const dir of ["src", "tests"]) {
  const d = path.join(repoRoot, dir);
  if (fs.existsSync(d)) walk(d, testFiles);
}

if (testFiles.length === 0) {
  console.error("No .test.ts files found under src/ or tests/");
  process.exit(1);
}

// Create one program with all test files. Syntactic diagnostics capture
// parser errors only — unbalanced braces, missing tokens, etc.
// Semantic (type) errors are filtered out.
const program = ts.createProgram({
  rootNames: testFiles,
  options: {
    noEmit: true,
    skipLibCheck: true,
    noLib: true,           // skip standard lib to avoid resolution noise
    strict: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    types: [],             // don't resolve @types/*
    typeRoots: [],         // don't resolve @types/*
  },
});

// Syntactic diagnostics = parser-level errors (TS1001–TS1499 range)
const diags = program.getSyntacticDiagnostics();

let errors = 0;
for (const d of diags) {
  if (d.file && d.start !== undefined) {
    // Only report diagnostics on our test files, not lib files
    const fileName = d.file.fileName;
    if (!testFiles.includes(fileName)) continue;
    const { line, character } =
      ts.getLineAndCharacterOfPosition(d.file, d.start);
    const rel = path.relative(repoRoot, fileName);
    console.error(
      `${rel}:${line + 1}:${character + 1} - ` +
        `${ts.flattenDiagnosticMessageText(d.messageText, "\n")} (TS${d.code})`,
    );
    errors++;
  }
}

if (errors > 0) {
  console.error(`\nSyntax gate FAILED — ${errors} syntactic error(s) in test files`);
  process.exit(1);
}

console.log(
  `Syntax gate passed: ${testFiles.length} test file(s) parsed cleanly`,
);
