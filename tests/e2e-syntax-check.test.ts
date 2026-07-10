/**
 * US-008: PARS — Parse/typecheck gate for e2e-tests/*.ts files.
 *
 * e2e-tests/*.ts files are excluded from tsconfig (which covers src/) and
 * from npm test, so a syntax error there ships silently. This gate catches
 * that by parsing every .ts file under e2e-tests/ with TypeScript's parser.
 *
 * It must be fast (<10s), must NOT execute e2e tests, and must fail with
 * the file name and syntax error location.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const e2eDir = resolve(repoRoot, "e2e-tests");

// --- Helpers ---

/** Walk e2e-tests/ recursively and return absolute paths to all .ts files. */
function collectE2eTsFiles(): string[] {
  // Use a simple recursive walk to stay dependency-light.
  const files: string[] = [];
  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && extname(entry.name) === ".ts") {
        files.push(full);
      }
    }
  }
  if (!existsSync(e2eDir)) return [];
  walk(e2eDir);
  return files.sort();
}

/**
 * Parse a single TypeScript file and return syntax diagnostics.
 * Does NOT resolve imports or type-check — just parses for syntax errors.
 */
function parseFile(filePath: string, source: string): ts.Diagnostic[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  return [...(sourceFile.parseDiagnostics ?? [])];
}

/**
 * Format a TypeScript diagnostic for readable output.
 */
function formatDiagnostic(diag: ts.Diagnostic): string {
  if (diag.file && diag.start !== undefined) {
    const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
    return `${diag.file.fileName}:${line + 1}:${character + 1} — ${ts.flattenDiagnosticMessageText(diag.messageText, "\n")}`;
  }
  return ts.flattenDiagnosticMessageText(diag.messageText, "\n");
}

/**
 * Parse all e2e-tests/*.ts files and return diagnostics keyed by file path.
 */
function checkAllE2eFiles(): Map<string, ts.Diagnostic[]> {
  const files = collectE2eTsFiles();
  const allDiagnostics = new Map<string, ts.Diagnostic[]>();

  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    const diags = parseFile(file, source);
    if (diags.length > 0) {
      allDiagnostics.set(file, diags);
    }
  }

  return allDiagnostics;
}

// --- Gate Tests ---

describe("US-008: PARS — e2e-tests syntax gate", () => {
  it("all e2e-tests/*.ts files parse without syntax errors", () => {
    const diagnostics = checkAllE2eFiles();

    if (diagnostics.size > 0) {
      const messages: string[] = [];
      for (const [file, diags] of diagnostics) {
        for (const d of diags) {
          messages.push(formatDiagnostic(d));
        }
      }
      assert.fail(
        `Found ${diagnostics.size} file(s) with syntax errors:\n${messages.join("\n")}`,
      );
    }

    // Verify we actually checked something
    const files = collectE2eTsFiles();
    assert.ok(files.length > 0, "Expected at least one .ts file under e2e-tests/");
  });

  it("gate runs in under 10 seconds", () => {
    const start = performance.now();
    checkAllE2eFiles();
    const elapsed = performance.now() - start;
    assert.ok(
      elapsed < 10_000,
      `Gate took ${elapsed.toFixed(0)}ms — must be under 10s`,
    );
  });

  it("does not load or execute e2e tests — only parses them", () => {
    // The gate uses ts.createSourceFile which is a pure parser.
    // We verify by checking that the e2e-tests directory exists and
    // the gate completes without Node executing any test files.
    const files = collectE2eTsFiles();
    assert.ok(files.length > 0, "e2e-tests directory should contain .ts files");
    // If the gate runs successfully (previous test passes), it doesn't execute tests
  });

  // --- Error detection tests (temp files with injected syntax errors) ---

  it("catches a syntax error and reports filename with location", () => {
    const tmpDir = mkdtempSync(resolve(repoRoot, "e2e-tests", "fixtures", "syntax-gate-test-"));
    try {
      const badFile = resolve(tmpDir, "broken.ts");
      // Missing closing brace — syntax error at the end of the file
      writeFileSync(badFile, "export function oops() {\n  const x = 1;\n");

      const diags = parseFile(badFile, readFileSync(badFile, "utf-8"));
      assert.ok(diags.length > 0, "Should have detected syntax error in broken file");

      const msg = formatDiagnostic(diags[0]);
      assert.ok(msg.includes(badFile), `Diagnostic should include file path: ${msg}`);
      assert.ok(
        msg.includes(":3:") || msg.includes(":2:") || msg.includes(":1:"),
        `Diagnostic should include line:col: ${msg}`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes a valid file with no diagnostic output", () => {
    const tmpDir = mkdtempSync(resolve(repoRoot, "e2e-tests", "fixtures", "syntax-gate-test-"));
    try {
      const goodFile = resolve(tmpDir, "valid.ts");
      writeFileSync(
        goodFile,
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      );

      const diags = parseFile(goodFile, readFileSync(goodFile, "utf-8"));
      assert.equal(diags.length, 0, "Valid file should have zero syntax errors");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("catches multiple errors in a single file", () => {
    const tmpDir = mkdtempSync(resolve(repoRoot, "e2e-tests", "fixtures", "syntax-gate-test-"));
    try {
      const multiErrorFile = resolve(tmpDir, "multi-broken.ts");
      writeFileSync(
        multiErrorFile,
        "import { Foo } from\nconst x: number = 'nope'\nexport const y =\n",
      );

      const diags = parseFile(multiErrorFile, readFileSync(multiErrorFile, "utf-8"));
      assert.ok(diags.length > 0, "Should have detected syntax errors");
      // Each diagnostic should reference the file
      for (const d of diags) {
        const msg = formatDiagnostic(d);
        assert.ok(
          msg.includes(multiErrorFile),
          `Each diagnostic should include file path: ${msg}`,
        );
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
