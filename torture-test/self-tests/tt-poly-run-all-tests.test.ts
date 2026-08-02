import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// This test file performs read-only validation against fixtures-src —
// no commands are executed inside fixtures-src.

const repoRoot = process.cwd();
const ttPolyDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly",
);
const scriptPath = path.join(ttPolyDir, "run-all-tests");
const ttPolyLiteScriptPath = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly-lite",
  "run-all-tests",
);

describe("tt-poly run-all-tests script (US-007)", () => {
  const scriptContent = fs.readFileSync(scriptPath, "utf-8");

  it("run-all-tests exists and is executable", () => {
    assert.ok(fs.existsSync(scriptPath), "run-all-tests should exist");
    const stat = fs.statSync(scriptPath);
    assert.ok(
      stat.isFile(),
      "run-all-tests should be a regular file",
    );
    // Check executable bit (owner, group, or other)
    const mode = stat.mode & 0o111;
    assert.ok(mode !== 0, "run-all-tests should be executable");
  });

  it("has correct shebang", () => {
    const firstLine = scriptContent.split("\n")[0];
    assert.ok(
      firstLine.startsWith("#!/usr/bin/env bash"),
      "should have #!/usr/bin/env bash shebang",
    );
  });

  it("uses set -euo pipefail for strict error handling", () => {
    assert.ok(
      scriptContent.includes("set -euo pipefail"),
      "should use set -euo pipefail",
    );
  });

  it("resolves ROOT_DIR relative to script location", () => {
    assert.ok(
      scriptContent.includes('ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"'),
      "should resolve ROOT_DIR from script dir",
    );
  });

  it("has OVERALL_EXIT accumulator initialized to 0", () => {
    assert.ok(
      scriptContent.includes("OVERALL_EXIT=0"),
      "should initialize OVERALL_EXIT=0",
    );
  });

  it("exits with OVERALL_EXIT at end of script", () => {
    assert.ok(
      scriptContent.includes("exit $OVERALL_EXIT"),
      "should exit with OVERALL_EXIT",
    );
  });

  it("contains colour handling for terminal and non-terminal output", () => {
    assert.ok(
      scriptContent.includes("if [ -t 1 ]; then"),
      "should check if stdout is a terminal",
    );
    assert.ok(
      scriptContent.includes("GREEN='\\033[0;32m'"),
      "should define GREEN colour",
    );
    assert.ok(
      scriptContent.includes("RED='\\033[0;31m'"),
      "should define RED colour",
    );
  });

  it("has banner, pass_msg, and fail_msg helper functions", () => {
    assert.ok(
      scriptContent.match(/^banner\(\)/m),
      "should have banner() function",
    );
    assert.ok(
      scriptContent.match(/^pass_msg\(\)/m),
      "should have pass_msg() function",
    );
    assert.ok(
      scriptContent.match(/^fail_msg\(\)/m),
      "should have fail_msg() function",
    );
  });

  // ── python/ suite ──────────────────────────────────────────────────

  it("contains python/ suite section with bootstrap logic", () => {
    assert.ok(
      scriptContent.includes("[python/] tt-poly python suite"),
      "should have python banner",
    );
    assert.ok(
      scriptContent.includes('if [ ! -d "$ROOT_DIR/python/.venv" ]'),
      "should check for python .venv",
    );
    assert.ok(
      scriptContent.includes("bash \"$ROOT_DIR/python/bootstrap\""),
      "should run python bootstrap",
    );
    assert.ok(
      scriptContent.includes(
        '(cd "$ROOT_DIR/python" && .venv/bin/pytest -q --tb=short)',
      ),
      "should run pytest from python/ directory",
    );
    assert.ok(
      scriptContent.match(/"python suite"/g)?.length && true,
      "should have pass/fail message for python suite",
    );
  });

  it("python suite failure sets OVERALL_EXIT=1 but continues", () => {
    // Check that OVERALL_EXIT=1 appears in the python fail_msg block
    assert.ok(
      /fail_msg "python suite"\s*\n\s*OVERALL_EXIT=1/.test(scriptContent),
      "python failure should set OVERALL_EXIT=1",
    );
  });

  // ── ts/ suite ──────────────────────────────────────────────────────

  it("contains ts/ suite section with npm bootstrap logic", () => {
    assert.ok(
      scriptContent.includes("[ts/] tt-poly typescript suite"),
      "should have ts banner",
    );
    assert.ok(
      scriptContent.includes('if [ ! -d "$ROOT_DIR/ts/node_modules" ]'),
      "should check for ts node_modules",
    );
    assert.ok(
      scriptContent.includes("npm install --no-audit --no-fund"),
      "should run npm install for bootstrap",
    );
    assert.ok(
      scriptContent.includes('(cd "$ROOT_DIR/ts" && npm test)'),
      "should run npm test from ts/ directory",
    );
  });

  it("ts suite failure sets OVERALL_EXIT=1 but continues", () => {
    assert.ok(
      /fail_msg "ts suite"\s*\n\s*OVERALL_EXIT=1/.test(scriptContent),
      "ts failure should set OVERALL_EXIT=1",
    );
  });

  // ── go/ suite ──────────────────────────────────────────────────────

  it("contains go/ suite section with no bootstrap", () => {
    assert.ok(
      scriptContent.includes("[go/] tt-poly go suite"),
      "should have go banner",
    );
    assert.ok(
      scriptContent.includes('(cd "$ROOT_DIR/go" && go test ./...)'),
      "should run go test from go/ directory",
    );
  });

  it("go suite failure sets OVERALL_EXIT=1 but continues", () => {
    assert.ok(
      /fail_msg "go suite"\s*\n\s*OVERALL_EXIT=1/.test(scriptContent),
      "go failure should set OVERALL_EXIT=1",
    );
  });

  // ── rust/ suite ────────────────────────────────────────────────────

  it("contains rust/ suite section with cargo test", () => {
    assert.ok(
      scriptContent.includes("[rust/] tt-poly rust suite"),
      "should have rust banner",
    );
    assert.ok(
      scriptContent.includes('(cd "$ROOT_DIR/rust" && cargo test --quiet)'),
      "should run cargo test --quiet from rust/ directory",
    );
  });

  it("rust suite failure sets OVERALL_EXIT=1 but continues", () => {
    assert.ok(
      /fail_msg "rust suite"\s*\n\s*OVERALL_EXIT=1/.test(scriptContent),
      "rust failure should set OVERALL_EXIT=1",
    );
  });

  // ── java/ suite ────────────────────────────────────────────────────

  it("contains java/ suite section with JAVA_HOME detection", () => {
    assert.ok(
      scriptContent.includes("[java/] tt-poly java suite"),
      "should have java banner",
    );
    assert.ok(
      scriptContent.includes('if [ -z "${JAVA_HOME:-}" ]'),
      "should check JAVA_HOME is set",
    );
    assert.ok(
      scriptContent.includes("JAVA_HOME is not set"),
      "should report missing JAVA_HOME error",
    );
    assert.ok(
      scriptContent.includes('if [ ! -d "$JAVA_HOME" ]'),
      "should check JAVA_HOME directory exists",
    );
    assert.ok(
      scriptContent.includes("JAVA_HOME ($JAVA_HOME) does not exist"),
      "should report invalid JAVA_HOME error",
    );
    assert.ok(
      scriptContent.includes(
        '(cd "$ROOT_DIR/java" && ./mvnw -q -B test)',
      ),
      "should run mvnw test from java/ directory",
    );
  });

  it("java suite handles missing JAVA_HOME as failure", () => {
    assert.ok(
      /fail_msg "java suite \(JAVA_HOME not set\)"/.test(scriptContent),
      "should fail with JAVA_HOME not set message",
    );
    assert.ok(
      /fail_msg "java suite \(JAVA_HOME not found\)"/.test(scriptContent),
      "should fail with JAVA_HOME not found message",
    );
  });

  // ── execution order ────────────────────────────────────────────────

  it("runs suites in correct order: python, ts, go, rust, java", () => {
    const pythonIdx = scriptContent.indexOf("[python/]");
    const tsIdx = scriptContent.indexOf("[ts/]");
    const goIdx = scriptContent.indexOf("[go/]");
    const rustIdx = scriptContent.indexOf("[rust/]");
    const javaIdx = scriptContent.indexOf("[java/]");

    assert.ok(pythonIdx >= 0, "python banner should exist");
    assert.ok(tsIdx >= 0, "ts banner should exist");
    assert.ok(goIdx >= 0, "go banner should exist");
    assert.ok(rustIdx >= 0, "rust banner should exist");
    assert.ok(javaIdx >= 0, "java banner should exist");

    assert.ok(pythonIdx < tsIdx, "python should run before ts");
    assert.ok(tsIdx < goIdx, "ts should run before go");
    assert.ok(goIdx < rustIdx, "go should run before rust");
    assert.ok(rustIdx < javaIdx, "rust should run before java");
  });

  // ── summary ────────────────────────────────────────────────────────

  it("has ALL SUITES PASSED / ONE OR MORE SUITES FAILED summary", () => {
    assert.ok(
      scriptContent.includes("ALL SUITES PASSED"),
      "should have ALL SUITES PASSED message",
    );
    assert.ok(
      scriptContent.includes("ONE OR MORE SUITES FAILED"),
      "should have ONE OR MORE SUITES FAILED message",
    );
  });

  // ── parity with tt-poly-lite reference ─────────────────────────────

  it("follows tt-poly-lite/run-all-tests structural pattern", () => {
    const liteContent = fs.readFileSync(ttPolyLiteScriptPath, "utf-8");

    // Both should share the same core structure
    assert.ok(
      liteContent.includes("set -euo pipefail"),
      "tt-poly-lite reference uses set -euo pipefail",
    );
    assert.ok(
      liteContent.includes("OVERALL_EXIT=0"),
      "tt-poly-lite reference uses OVERALL_EXIT",
    );

    // Extensions in tt-poly beyond tt-poly-lite
    assert.ok(
      scriptContent.includes("[go/]"),
      "tt-poly adds go suite not in lite",
    );
    assert.ok(
      scriptContent.includes("[rust/]"),
      "tt-poly adds rust suite not in lite",
    );
    assert.ok(
      scriptContent.includes("[java/]"),
      "tt-poly adds java suite not in lite",
    );
  });

  // ── bootstrap containment ──────────────────────────────────────────

  it("only bootstraps python and ts (not go/rust/java)", () => {
    // python: has bootstrap
    assert.ok(
      scriptContent.includes("bootstrap"),
      "should mention bootstrap",
    );
    // go: should NOT have bootstrap logic
    assert.ok(
      !/go.*bootstrap/i.test(
        scriptContent.slice(scriptContent.indexOf("[go/]")),
      ),
      "go should not have bootstrap",
    );
    // rust: should NOT have bootstrap logic
    assert.ok(
      !/rust.*bootstrap/i.test(
        scriptContent.slice(scriptContent.indexOf("[rust/]")),
      ),
      "rust should not have bootstrap",
    );
    // java: has JAVA_HOME detection but not a bootstrap directory
    assert.ok(
      !scriptContent.includes("java/bootstrap"),
      "java should not have bootstrap script",
    );
  });

  // ── individual suite pass/fail messages ────────────────────────────

  it("has pass_msg/fail_msg for all 5 suites", () => {
    for (const suite of ["python", "ts", "go", "rust", "java"]) {
      assert.ok(
        new RegExp(`pass_msg "${suite}( | suite)"?`).test(scriptContent),
        `should have pass_msg for ${suite}`,
      );
      assert.ok(
        new RegExp(`fail_msg "${suite}( | suite)"?`).test(scriptContent),
        `should have fail_msg for ${suite}`,
      );
    }
  });
});
