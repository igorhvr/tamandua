/**
 * Tests for the syntax-check gate (scripts/syntax-check-tests.ts).
 *
 * This test validates that:
 * - The syntax-check script finds and parses .test.ts files
 * - It passes on clean files and exits 0
 * - It fails on files with syntax errors and exits 1
 * - It reports error location (file:line:col)
 * - The npm script check-test-syntax exists
 * - The run-all-lanes.sh pipeline includes the syntax gate before lanes
 * - The syntax gate blocks lane execution on failure
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { createTempHome, cleanChildEnv } from "./helpers/test-env.ts";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SYNTAX_CHECK_SCRIPT = path.join(REPO_ROOT, "scripts", "syntax-check-tests.ts");
const ALL_LANES_SCRIPT = path.join(REPO_ROOT, "scripts", "run-all-lanes.sh");

function makeTmpDir() {
  return createTempHome("tamandua-syntax-check-").root;
}

function writeText(filePath: string, text: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

// ── Script existence and basic behavior ──

describe("syntax-check-tests.ts", () => {
  it("exists", () => {
    assert.ok(fs.existsSync(SYNTAX_CHECK_SCRIPT), "scripts/syntax-check-tests.ts must exist");
  });

  it("passes on the clean tamandua repo", function () {
    // This test runs against the real repo tree (with TAMANDUA_REPO_ROOT).
    // It must pass because US-001 already fixed the stray });
    const result = execFileSync("npx", ["tsx", "scripts/syntax-check-tests.ts"], {
      cwd: REPO_ROOT,
      env: cleanChildEnv({ HOME: makeTmpDir() }),
      stdio: "pipe",
      encoding: "utf-8",
    });
    assert.ok(
      result.includes("Syntax gate passed"),
      "should report syntax gate passed: " + result.slice(0, 500),
    );
    assert.ok(
      result.includes("test file(s) parsed cleanly"),
      "should report file count: " + result.slice(0, 500),
    );
  });

  it("finds .test.ts files under src/", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "some.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("dummy", () => { it("ok", () => { assert.equal(1, 1); }); });\n',
      );

      const result = execFileSync("npx", ["tsx", SYNTAX_CHECK_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("Syntax gate passed"),
        "should pass on clean test file: " + result,
      );
      assert.ok(
        result.includes("1 test file"),
        "should find exactly 1 test file: " + result,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("finds .test.ts files under tests/", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "tests", "some.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("dummy", () => { it("ok", () => { assert.equal(1, 1); }); });\n',
      );

      const result = execFileSync("npx", ["tsx", SYNTAX_CHECK_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("Syntax gate passed"),
        "should pass on clean test file in tests/: " + result,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits 0 on clean test files", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "clean.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("clean suite", () => {\n' +
        '  it("test A", () => { assert.equal(1, 1); });\n' +
        '  it("test B", () => { assert.equal(2, 2); });\n' +
        '});\n',
      );

      execFileSync("npx", ["tsx", SYNTAX_CHECK_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir }),
        stdio: "pipe",
        encoding: "utf-8",
      });
      // No throw = exit 0
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits 1 on test file with syntax error (unbalanced braces)", () => {
    const tmpDir = makeTmpDir();
    try {
      // Extra stray }); — same class of error as the rugpull.test.ts regression
      writeText(path.join(tmpDir, "src", "broken.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("broken suite", () => {\n' +
        '  it("test A", () => { assert.equal(1, 1); });\n' +
        '  });\n' + // stray extra closer
        '});\n',
      );

      try {
        execFileSync("npx", ["tsx", SYNTAX_CHECK_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero on syntax error");
      } catch (e: any) {
        assert.equal(e.status, 1, "exit code must be 1 on syntax error");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports error location (file:line:col) for syntax errors", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "bad.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("bad", () => {\n' +
        '  it("oops", () => {\n' +
        '    ))))));\n' + // intentionally malformed expression
        '  });\n' +
        '});\n',
      );

      try {
        execFileSync("npx", ["tsx", SYNTAX_CHECK_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero");
      } catch (e: any) {
        assert.equal(e.status, 1, "exit code must be 1");
        const stderr = e.stderr || "";
        assert.ok(
          stderr.includes("src/bad.test.ts"),
          "stderr must mention the file name: " + stderr.slice(0, 500),
        );
        assert.ok(
          stderr.includes("Syntax gate FAILED"),
          "stderr must include FAILED message: " + stderr.slice(0, 500),
        );
        assert.ok(
          /\b\d+:\d+\b/.test(stderr),
          "stderr must include line:col: " + stderr.slice(0, 500),
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips node_modules, dist, and e2e-tests directories", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "real.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("dummy", () => { it("ok", () => { assert.equal(1, 1); }); });\n',
      );
      // Plant broken test file in excluded directories — it should be ignored
      writeText(path.join(tmpDir, "node_modules", "pkg", "broken.test.ts"),
        "this { is ( broken [ syntax {{{\n",
      );
      writeText(path.join(tmpDir, "dist", "broken.test.ts"),
        "this { is ( broken [ syntax {{{\n",
      );
      writeText(path.join(tmpDir, "e2e-tests", "broken.test.ts"),
        "this { is ( broken [ syntax {{{\n",
      );

      const result = execFileSync("npx", ["tsx", SYNTAX_CHECK_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("Syntax gate passed"),
        "should pass despite broken files in excluded dirs: " + result,
      );
      assert.ok(
        result.includes("1 test file"),
        "should only count the real test file: " + result,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports the correct number of test files parsed", () => {
    const tmpDir = makeTmpDir();
    try {
      for (let i = 0; i < 3; i++) {
        writeText(path.join(tmpDir, "src", `file${i}.test.ts`),
          'import { describe, it } from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          `describe("dummy${i}", () => { it("ok", () => { assert.equal(1, 1); }); });\n`,
        );
      }

      const result = execFileSync("npx", ["tsx", SYNTAX_CHECK_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("3 test file(s)"),
        "should report 3 test files: " + result,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Package.json script integration ──

describe("check-test-syntax npm script", () => {
  it("exists in package.json", () => {
    const pkgPath = path.join(REPO_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    assert.ok(
      pkg.scripts && pkg.scripts["check-test-syntax"],
      "package.json must have a check-test-syntax script",
    );
    assert.ok(
      pkg.scripts["check-test-syntax"].includes("syntax-check-tests.ts"),
      "check-test-syntax must invoke syntax-check-tests.ts: " + pkg.scripts["check-test-syntax"],
    );
  });

  it("runs successfully via npm run", () => {
    const tmpDir = makeTmpDir();
    // Symlink node_modules from the real repo so tsx resolves
    const realNodeModules = path.join(REPO_ROOT, "node_modules");
    try {
      // Copy the syntax-check script
      fs.mkdirSync(path.join(tmpDir, "scripts"), { recursive: true });
      fs.copyFileSync(SYNTAX_CHECK_SCRIPT, path.join(tmpDir, "scripts", "syntax-check-tests.ts"));
      fs.symlinkSync(realNodeModules, path.join(tmpDir, "node_modules"));

      writeText(path.join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: { "check-test-syntax": "tsx scripts/syntax-check-tests.ts" },
        devDependencies: { "typescript": "^5.9.3" },
      }));

      writeText(path.join(tmpDir, "src", "ok.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("dummy", () => { it("ok", () => { assert.equal(1, 1); }); });\n',
      );

      execFileSync("npm", ["run", "check-test-syntax"], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir }),
        stdio: "pipe",
        encoding: "utf-8",
      });
      // No throw = exit 0
    } finally {
      try { fs.unlinkSync(path.join(tmpDir, "node_modules")); } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── run-all-lanes.sh integration ──

describe("run-all-lanes.sh syntax gate integration", () => {
  function copyScripts(tmpDir: string) {
    fs.mkdirSync(path.join(tmpDir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });

    // Copy all orchestration scripts
    for (const script of ["run-all-lanes.sh", "run-serial-tests.sh", "run-parallel-tests.sh", "syntax-check-tests.ts"]) {
      fs.copyFileSync(
        path.join(REPO_ROOT, "scripts", script),
        path.join(tmpDir, "scripts", script),
      );
    }
  }

  function passTestContent() {
    return 'import { describe, it } from "node:test";\n' +
           'import assert from "node:assert/strict";\n' +
           'describe("dummy", () => {\n' +
           '  it("passes", () => { assert.equal(1, 1); });\n' +
           '});\n';
  }

  it("includes syntax gate before lane execution", () => {
    const content = fs.readFileSync(ALL_LANES_SCRIPT, "utf-8");
    assert.ok(
      content.includes("syntax-check-tests.ts"),
      "run-all-lanes.sh must reference syntax-check-tests.ts",
    );
    // Syntax gate must run before lanes
    const syntaxIdx = content.indexOf("syntax-check-tests.ts");
    const serialIdx = content.indexOf("run-serial-tests.sh");
    assert.ok(syntaxIdx >= 0, "syntax-check-tests.ts must be present");
    assert.ok(serialIdx >= 0, "run-serial-tests.sh must be present");
    assert.ok(
      syntaxIdx < serialIdx,
      "syntax gate must run before serial lane",
    );
  });

  it("runs syntax gate and passes on clean test files", () => {
    const tmpDir = makeTmpDir();
    const realNodeModules = path.join(REPO_ROOT, "node_modules");
    try {
      copyScripts(tmpDir);
      fs.symlinkSync(realNodeModules, path.join(tmpDir, "node_modules"));

      writeText(path.join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: {
          build: "echo 'build ok'",
          "check-test-syntax": "tsx scripts/syntax-check-tests.ts",
        },
        devDependencies: { "typescript": "^5.9.3" },
      }));

      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/serial.test.ts\n");
      writeText(path.join(tmpDir, "src", "serial.test.ts"), passTestContent());
      writeText(path.join(tmpDir, "src", "parallel.test.ts"), passTestContent());

      const result = execFileSync("bash", [path.join(tmpDir, "scripts", "run-all-lanes.sh")], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("Syntax gate passed"),
        "should include syntax gate passed message: " + result.slice(0, 1000),
      );
      assert.ok(
        result.includes("SERIAL lane"),
        "serial lane must run after syntax gate: " + result.slice(0, 1000),
      );
      assert.ok(
        result.includes("PARALLEL lane"),
        "parallel lane must run after syntax gate: " + result.slice(0, 1000),
      );
    } finally {
      try { fs.unlinkSync(path.join(tmpDir, "node_modules")); } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("blocks lane execution when syntax gate fails", () => {
    const tmpDir = makeTmpDir();
    const realNodeModules = path.join(REPO_ROOT, "node_modules");
    try {
      copyScripts(tmpDir);
      fs.symlinkSync(realNodeModules, path.join(tmpDir, "node_modules"));

      writeText(path.join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: {
          build: "echo 'build ok'",
          "check-test-syntax": "tsx scripts/syntax-check-tests.ts",
        },
        devDependencies: { "typescript": "^5.9.3" },
      }));

      // Plant a syntactically broken test file (extra stray }}); — same class as the regressions)
      writeText(path.join(tmpDir, "src", "broken.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("broken", () => {\n' +
        '  it("test", () => { assert.equal(1, 1); });\n' +
        '  });\n' + // stray extra closer
        '});\n',
      );

      try {
        execFileSync("bash", [path.join(tmpDir, "scripts", "run-all-lanes.sh")], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero when syntax gate fails");
      } catch (e: any) {
        assert.equal(e.status, 1, "exit code must be 1 when syntax gate fails");
        const stdout = e.stdout || "";
        const stderr = e.stderr || "";
        const combined = stdout + stderr;
        assert.ok(
          combined.includes("Syntax gate FAILED"),
          "must include Syntax gate FAILED: " + combined.slice(0, 500),
        );
        assert.ok(
          !stdout.includes("SERIAL lane"),
          "serial lane must NOT run when syntax gate fails: " + stdout.slice(0, 500),
        );
        assert.ok(
          !stdout.includes("PARALLEL lane"),
          "parallel lane must NOT run when syntax gate fails: " + stdout.slice(0, 500),
        );
        assert.ok(
          stderr.includes("Fix before running tests"),
          "must tell user to fix before running tests: " + stderr.slice(0, 500),
        );
      }
    } finally {
      try { fs.unlinkSync(path.join(tmpDir, "node_modules")); } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("syntax gate runs after build and before both lanes", () => {
    const content = fs.readFileSync(ALL_LANES_SCRIPT, "utf-8");

    const buildIdx = content.indexOf("npm run build");
    const syntaxIdx = content.indexOf("syntax-check-tests.ts");
    const serialIdx = content.indexOf("run-serial-tests.sh");
    const parallelIdx = content.indexOf("run-parallel-tests.sh");

    assert.ok(buildIdx >= 0, "build step required");
    assert.ok(syntaxIdx >= 0, "syntax gate required");
    assert.ok(serialIdx >= 0, "serial lane required");
    assert.ok(parallelIdx >= 0, "parallel lane required");

    assert.ok(
      buildIdx < syntaxIdx && syntaxIdx < serialIdx && serialIdx < parallelIdx,
      "order must be: build -> syntax gate -> serial lane -> parallel lane",
    );
  });

  it("reports number of parsed .test.ts files (BRCE guard emits count)", () => {
    const tmpDir = makeTmpDir();
    const realNodeModules = path.join(REPO_ROOT, "node_modules");
    try {
      copyScripts(tmpDir);
      fs.symlinkSync(realNodeModules, path.join(tmpDir, "node_modules"));

      writeText(path.join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: {
          build: "echo 'build ok'",
          "check-test-syntax": "tsx scripts/syntax-check-tests.ts",
        },
        devDependencies: { "typescript": "^5.9.3" },
      }));

      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/serial.test.ts\n");
      writeText(path.join(tmpDir, "src", "serial.test.ts"), passTestContent());
      writeText(path.join(tmpDir, "src", "parallel.test.ts"), passTestContent());

      const result = execFileSync("bash", [path.join(tmpDir, "scripts", "run-all-lanes.sh")], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        /test file\(s\) parsed cleanly/.test(result),
        "should report test file count: " + result.slice(0, 1000),
      );
    } finally {
      try { fs.unlinkSync(path.join(tmpDir, "node_modules")); } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
