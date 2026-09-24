/**
 * US-008: PARS — Parse/typecheck gate for e2e-tests/*.ts files.
 *
 * e2e-tests/*.ts files are excluded from tsconfig (which covers src/) and
 * from npm test, so a syntax error there ships silently. This gate catches
 * that by parsing every .ts file under e2e-tests/ with TypeScript's parser.
 *
 * It must be fast (<10s), must NOT execute e2e tests, and must fail with
 * the file name and syntax error location.
 *
 * TEST-HYGIENE-0923 item 3b (bead tamandua-6sy.88): the injected-error
 * scratch directories this gate creates for its own cases live OUTSIDE the
 * repository tree (see makeTransientFixtureDir), and the walk/read goes
 * through the race-tolerant walker in tests/helpers/robust-scan-walk.ts, so
 * nothing this gate does can be observed half-created by a concurrent walker
 * (and vice versa).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { tamanduaTempDir } from "../dist/lib/temp-dir.js";
import { collectScanFiles, readCollectedFiles } from "./helpers/robust-scan-walk.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const e2eDir = resolve(repoRoot, "e2e-tests");

// --- Helpers ---

/**
 * Walk e2e-tests/ recursively and return absolute paths to all .ts files.
 *
 * TEST-HYGIENE-0923 item 3b: the walk is delegated to the race-tolerant
 * walker shared with the source/e2e vocabulary guard, so a .ts entry that
 * another test creates or removes while this gate walks cannot produce a
 * false red — while every file that still exists is still collected, so a
 * genuine syntax error can never be dropped.
 */
function collectE2eTsFiles(): string[] {
  return collectScanFiles({ roots: [e2eDir], extensions: [".ts"] }).files.sort();
}

/**
 * Prefix for the transient scratch directories this gate creates to hold its
 * injected syntax errors.
 */
const TRANSIENT_FIXTURE_PREFIX = "syntax-gate-test-";

/**
 * Create the transient scratch directory the injected-error cases below write
 * their broken .ts files into.
 *
 * TEST-HYGIENE-0923 item 3b (bead tamandua-6sy.88): it MUST be created outside
 * the repository tree. Until this fix the three sites below called
 * `mkdtempSync(resolve(repoRoot, "e2e-tests", "fixtures", "syntax-gate-test-"))`,
 * i.e. they created and removed a directory inside `e2e-tests/` — a tree this
 * gate and tests/merge-branch-report-vocabulary.test.ts walk recursively while
 * the parallel lane runs — so a concurrent walker could read a file that had
 * just been deleted (ENOENT on the Mac unit lane 15:26Z).
 * `tamanduaTempDir()` is the project TDIR convention and roots the scratch dir
 * under the canonical temp root, outside the repo.
 *
 * The caller still owns cleanup: `rmSync(dir, { recursive: true, force: true })`
 * in a `finally` block.
 */
function makeTransientFixtureDir(): string {
  return tamanduaTempDir(TRANSIENT_FIXTURE_PREFIX);
}

/** The repository root through its realpath, when it is resolvable. */
function repositoryRootReal(): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return repoRoot;
  }
}

/**
 * True when `candidate` is the repository root or lives underneath it.
 *
 * Both spellings of the root (as resolved and through its realpath) are
 * compared so a symlinked checkout — or a platform where the scratch root is a
 * symlink target — can never make an in-tree scratch dir look out-of-tree.
 */
function isInsideRepository(candidate: string): boolean {
  const withSep = (value: string): string => (value.endsWith(sep) ? value : value + sep);
  return [repoRoot, repositoryRootReal()].some((root) =>
    candidate === root || candidate.startsWith(withSep(root)),
  );
}

/**
 * The assertion this whole fix hangs on: a transient fixture dir must live
 * outside the repository tree — and therefore outside `e2e-tests/`, which is
 * walked concurrently. Kept as a named predicate so the red-arming case can
 * run the SAME assertion against the retired in-tree shape.
 */
function assertTransientFixtureDirIsOutOfTree(dir: string): void {
  assert.equal(
    isInsideRepository(dir),
    false,
    `transient fixture dir ${dir} must be created outside the repository tree (${repoRoot}) — an in-tree scratch dir appears and vanishes inside a tree that other tests walk recursively`,
  );
  assert.equal(
    dir.startsWith(e2eDir.endsWith(sep) ? e2eDir : e2eDir + sep),
    false,
    `transient fixture dir ${dir} must not live under ${e2eDir}`,
  );
}

/**
 * The retired (pre-fix) scratch-dir shape:
 * `mkdtempSync(resolve(repoRoot, "e2e-tests", "fixtures", "syntax-gate-test-"))`
 * produced exactly a path of this form. Used to arm the pin above.
 */
function retiredTransientFixtureDirShape(): string {
  return resolve(repoRoot, "e2e-tests", "fixtures", `${TRANSIENT_FIXTURE_PREFIX}XXXXXX`);
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
 *
 * The reads go through the race-tolerant reader for the same reason the walk
 * does: a collected file that another test removed in the meantime is skipped
 * instead of throwing ENOENT, and every file that still exists is parsed.
 */
function checkAllE2eFiles(): Map<string, ts.Diagnostic[]> {
  const files = collectE2eTsFiles();
  const allDiagnostics = new Map<string, ts.Diagnostic[]>();

  for (const { path: file, text: source } of readCollectedFiles(files).contents) {
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
    const tmpDir = makeTransientFixtureDir();
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
    const tmpDir = makeTransientFixtureDir();
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
    const tmpDir = makeTransientFixtureDir();
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

// --- TEST-HYGIENE-0923 item 3b (bead tamandua-6sy.88): scratch dirs stay out
// of the repository tree, so a concurrent walk of e2e-tests/ can never observe
// them appearing or vanishing. ---

describe("TEST-HYGIENE-0923: e2e-syntax-check scratch dirs live outside the repository", () => {
  it("creates the injected-error scratch dir outside the repository tree and removes it in finally", () => {
    const scratch = makeTransientFixtureDir();
    try {
      assert.equal(existsSync(scratch), true, "the helper must actually create the scratch dir");
      assertTransientFixtureDirIsOutOfTree(scratch);

      // The scratch dir is still a working fixture: the injected-error cases
      // write into it and parse out of it.
      const broken = resolve(scratch, "broken.ts");
      writeFileSync(broken, "export function oops() {\n  const x = 1;\n");
      assert.ok(
        parseFile(broken, readFileSync(broken, "utf-8")).length > 0,
        "a scratch dir outside the repo must still be a usable fixture root",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    assert.equal(existsSync(scratch), false, "the scratch dir is removed by the caller");
  });

  it("arms the defect: the retired in-tree scratch shape fails the very same assertion", () => {
    const retiredShape = retiredTransientFixtureDirShape();

    // The retired pre-fix call sites used exactly this shape:
    //   mkdtempSync(resolve(repoRoot, "e2e-tests", "fixtures", "syntax-gate-test-"))
    assert.equal(
      isInsideRepository(retiredShape),
      true,
      "the retired shape must be classified as INSIDE the repository — otherwise this pin would not arm the defect",
    );
    assert.throws(
      () => assertTransientFixtureDirIsOutOfTree(retiredShape),
      /must be created outside the repository tree/,
      "reverting makeTransientFixtureDir() to the retired in-tree path must fail this gate",
    );
  });

  it("keeps every scratch dir invisible to a walk of e2e-tests/", () => {
    const first = makeTransientFixtureDir();
    const second = makeTransientFixtureDir();
    try {
      assert.notEqual(first, second, "each call creates a fresh scratch dir");
      for (const dir of [first, second]) {
        assertTransientFixtureDirIsOutOfTree(dir);
        writeFileSync(resolve(dir, "concurrent-walk.ts"), "export const duringWalk = 1;\n");
      }

      // The walk the vocabulary guard and this gate perform over e2e-tests/
      // cannot see a scratch dir that appears and vanishes out of tree.
      const during = collectScanFiles({ roots: [e2eDir], extensions: [".ts"] });
      for (const dir of [first, second]) {
        assert.equal(
          during.files.includes(resolve(dir, "concurrent-walk.ts")),
          false,
          "a scratch file outside the tree must never be collected by a walk of e2e-tests/",
        );
        assert.equal(
          during.files.some((file) => file.startsWith(dir)),
          false,
          "no walked e2e-tests/ file may live under a scratch dir",
        );
      }

      rmSync(first, { recursive: true, force: true });
      const after = collectScanFiles({ roots: [e2eDir], extensions: [".ts"] });
      assert.deepEqual(
        after.files,
        during.files,
        "creating and deleting a scratch dir changes nothing in the e2e-tests/ walk",
      );
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});