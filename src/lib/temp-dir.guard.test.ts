/**
 * Guard test: prevents regressions that reintroduce direct os.tmpdir() or
 * hardcoded /tmp paths after the TDIR consolidation.
 *
 * Scans src/, tests/, e2e-tests/ (TypeScript) and scripts/ (shell) for
 * direct usage outside the documented allowlist.  Each allowlist entry
 * carries an inline comment explaining WHY it is permitted.
 *
 * When this test fails, read the failure message, then migrate the new
 * usage to tamanduaTempDir() or tamanduaTempRoot() from src/lib/temp-dir.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// -------------------------------------------------------------------
// Allowlists
// -------------------------------------------------------------------

/**
 * Files permitted to call os.tmpdir() directly.
 *
 * Every entry MUST have a comment explaining why direct usage is
 * acceptable in that file.  New entries require the same.
 */
const OS_TMPDIR_ALLOWLIST: Record<string, string> = {
  // The temp-dir helper itself — uses os.tmpdir() as the fallback when
  // directory creation under /tmp/tamandua-test fails (permissions, RO /tmp).
  "src/lib/temp-dir.ts":
    "helper itself uses os.tmpdir() as fallback on mkdir failure",

  // Tests for the temp-dir helper must exercise the fallback path.
  "src/lib/temp-dir.test.ts":
    "must test the os.tmpdir() fallback behavior",

  // HOME fallback for subprocess environments.  os.tmpdir() is the correct
  // fallback here — it's a per-user writeable directory suitable as a HOME
  // substitute, NOT a temp asset managed by Tamandua.
  "e2e-tests/helpers/scripted-hermes-runtime.test.ts":
    "HOME fallback for subprocess env — not a temp asset",
  "e2e-tests/helpers/scripted-hermes.test.ts":
    "HOME fallback for subprocess env — not a temp asset",

  // Comment-only mention: "on macOS os.tmpdir() is behind the /var → /private/var symlink"
  // explains macOS realpath behavior in an assertion helper — not a call.
  "src/server/dashboard.test.ts":
    "comment explaining macOS os.tmpdir() symlink behavior — not a call",

  // The guard test itself — contains os.tmpdir() in the detection regex and
  // test assertions/allowlist data.  Self-reference is unavoidable.
  "src/lib/temp-dir.guard.test.ts":
    "the guard test itself — detection regex and test data",


};

/**
 * Files permitted to contain "/tmp/" inside string literals.
 *
 * Every entry MUST have a comment explaining why the /tmp path is
 * acceptable.  New entries require the same.
 */
const TMP_PATH_ALLOWLIST: Record<string, string> = {
  // The helper itself defines the default /tmp/tamandua-test base path.
  "src/lib/temp-dir.ts":
    "defines the default /tmp/tamandua-test base directory",

  // Temp-dir unit tests reference /tmp/tamandua-test in assertion messages.
  "src/lib/temp-dir.test.ts":
    "test assertion references default /tmp/tamandua-test path",

  // The guard test itself — references /tmp in allowlist entries,
  // test names ("hardcoded /tmp/ paths"), and failure messages.
  "src/lib/temp-dir.guard.test.ts":
    "the guard test itself — allowlist data and test names",

  // ── Fixture data — fake paths used only in test assertions / DB seeds ──
  // None of these create actual temp directories.

  "src/server/dashboard.test.ts":
    "test fixture — fake /tmp/nonexistent* paths in DB seeds",
  "tests/step-ops.test.ts":
    "test fixture — fake /tmp/harness-*, /tmp/repo repository paths",
  "tests/cli-worktree.test.ts":
    "test fixture — fake /tmp/origin, /tmp/fake-worktree, /tmp/tamandua-wt/*",
  "tests/orphaned-step-recovery.test.ts":
    "test fixture — { repo: '/tmp/test' } context data",
  "tests/reroute-paths.test.ts":
    "test fixture — { repo: '/tmp/repo' } context data",
  "tests/run-registration-failure.test.ts":
    "test fixture — /tmp/my-repo, /tmp/project repository paths",
  "tests/test-tmp-cleanup-guard.test.ts":
    "test fixture — /tmp/tamandua-* test names and comments",

  // JSDoc comment example: "/tmp/tamandua-test-XXXXX" — shows the pattern
  // but the actual code uses tamanduaTempDir(), not a hardcoded path.
  "tests/helpers/test-env.ts":
    "JSDoc comment example — actual code uses tamanduaTempDir()",

  "src/cli/wizard-evaluator.test.ts":
    `test fixture — "/tmp/test" working directory for wizard eval`,
  "src/cli/workflow-run-args.test.ts":
    `test fixture — "/tmp/repo", "/tmp/myapp" as CLI --context arguments`,
  "src/db.test.ts":
    "test fixture — fake /tmp/worktrees/* worktree paths",
  "src/installer/agent-scheduler-harness-routing.test.ts":
    `test fixture — "/tmp/work" harness working directory`,
  "src/installer/catalog-version.test.ts":
    `test fixture — "/tmp/test", "/tmp/test-source" stamp paths`,
  "src/installer/status.test.ts":
    "test fixture — fake /tmp/tamandua-worktrees/*, /tmp/wt/* worktree paths",
  "src/server/control-client.test.ts":
    `test fixture — "/tmp/test-repo" origin repository for suite record tests`,
  "src/server/mcp-server.test.ts":
    "test fixture — fake /tmp/remote-harness, /tmp/harness, /tmp/test-project",

  // ── Bundled e2e fixture (not Tamandua runtime code) ──
  "e2e-tests/fixtures/sample-project-vuln/test/server.test.ts":
    "e2e fixture file from sample project — not Tamandua runtime code",

  // Test assertion expects a nonexistent path; /tmp/nonexistent-path-...
  // is a deliberate sentinel value that will never exist.
  "e2e-tests/helpers/smoke-helpers.test.ts":
    "test fixture — deliberately nonexistent path for assertion",

  // Guard configuration test data.  /tmp/should-not-leak-* paths are
  // fixture strings, not real temp directories.
  "e2e-tests/workflows-smoke.test.ts":
    "test fixture — guard configuration paths for isolation testing",

  // ── Shell scripts ──

  // Shell script that respects the TAMANDUA_TEST_TMPDIR env override with
  // a /tmp/tamandua-test default — this IS the canonical pattern for shell
  // scripts in the project.
  "scripts/prll-verify.sh":
    "uses TAMANDUA_TEST_TMPDIR with /tmp/tamandua-test default (correct pattern)",

};

// -------------------------------------------------------------------
// File discovery
// -------------------------------------------------------------------

function globFiles(dir: string, suffix: string): string[] {
  const result: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...globFiles(full, suffix));
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        result.push(full);
      }
    }
  } catch {
    // directory may not exist (e.g. missing e2e-tests/ in some envs)
  }
  return result;
}

function toRelative(p: string): string {
  return path.relative(REPO_ROOT, p);
}

// -------------------------------------------------------------------
// Scanners
// -------------------------------------------------------------------

const RE_OS_TMPDIR = /os\.tmpdir\(\)/;

function fileCallsOsTmpdir(filePath: string): boolean {
  try {
    return RE_OS_TMPDIR.test(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return false;
  }
}

const RE_TMP_PATH = /\/tmp\//;

function fileHasTmpPath(filePath: string): boolean {
  try {
    return RE_TMP_PATH.test(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

describe("temp-dir-guard", () => {
  // ---- os.tmpdir() guard -------------------------------------------------

  it("os.tmpdir() calls are only in allowed files", () => {
    const allTsFiles = [
      ...globFiles(path.join(REPO_ROOT, "src"), ".ts"),
      ...globFiles(path.join(REPO_ROOT, "tests"), ".ts"),
      ...globFiles(path.join(REPO_ROOT, "e2e-tests"), ".ts"),
    ];

    const violations: string[] = [];

    for (const fullPath of allTsFiles) {
      const rel = toRelative(fullPath);
      if (fileCallsOsTmpdir(fullPath) && !(rel in OS_TMPDIR_ALLOWLIST)) {
        violations.push(rel);
      }
    }

    assert.deepEqual(
      violations,
      [],
      violations.length > 0
        ? `Direct os.tmpdir() call found in file(s) outside the allowlist. ` +
            `Migrate to tamanduaTempDir() or tamanduaTempRoot() from src/lib/temp-dir.ts. ` +
            `If the usage is legitimate, add the file to OS_TMPDIR_ALLOWLIST in ` +
            `src/lib/temp-dir.guard.test.ts with an explanatory comment.\n` +
            `Violations (${violations.length}):\n${violations.join("\n")}`
        : "",
    );
  });

  // ---- /tmp/ path guard --------------------------------------------------

  it("hardcoded /tmp/ paths are only in allowed files", () => {
    // TypeScript files under src/, tests/, e2e-tests/
    const allTsFiles = [
      ...globFiles(path.join(REPO_ROOT, "src"), ".ts"),
      ...globFiles(path.join(REPO_ROOT, "tests"), ".ts"),
      ...globFiles(path.join(REPO_ROOT, "e2e-tests"), ".ts"),
    ];

    // Shell scripts under scripts/
    const allShFiles = globFiles(path.join(REPO_ROOT, "scripts"), ".sh");

    const tsViolations: string[] = [];
    const shViolations: string[] = [];

    for (const fullPath of allTsFiles) {
      const rel = toRelative(fullPath);
      if (fileHasTmpPath(fullPath) && !(rel in TMP_PATH_ALLOWLIST)) {
        tsViolations.push(rel);
      }
    }

    for (const fullPath of allShFiles) {
      const rel = toRelative(fullPath);
      if (fileHasTmpPath(fullPath) && !(rel in TMP_PATH_ALLOWLIST)) {
        shViolations.push(rel);
      }
    }

    const allViolations = [...tsViolations, ...shViolations];

    assert.deepEqual(
      allViolations,
      [],
      allViolations.length > 0
        ? `Hardcoded /tmp/ path found in file(s) outside the allowlist. ` +
            `Migrate to tamanduaTempDir() or tamanduaTempRoot() from src/lib/temp-dir.ts ` +
            `(for TypeScript), or use TAMANDUA_TEST_TMPDIR with /tmp/tamandua-test default ` +
            `(for shell scripts). If the usage is legitimate, add the file to ` +
            `TMP_PATH_ALLOWLIST in src/lib/temp-dir.guard.test.ts with an explanatory comment.\n` +
            `Violations (${allViolations.length}):\n${allViolations.join("\n")}`
        : "",
    );
  });

  // ---- macOS realpath sanity ---------------------------------------------

  it("all tmp paths resolve through fs.realpathSync on macOS", () => {
    // On macOS /tmp is a symlink to /private/tmp.  Verify that any /tmp
    // directory we depend on during test execution is accessible via its
    // realpath.  This is not a full scan but a smoke check.
    const root = "/tmp/tamandua-test";
    const resolved = fs.realpathSync(root);

    // If the directory exists, realpath should have resolved the symlink.
    if (fs.existsSync(root)) {
      assert.ok(
        resolved.endsWith("tamandua-test"),
        `/tmp/tamandua-test realpath should end with tamandua-test, got ${resolved}`,
      );
    }
  });
});
