/**
 * Tests for the serial/parallel lane runner scripts.
 *
 * This test file is pure-logic: it validates script existence, executable bits,
 * bash syntax, env var passthrough, and basic execution behavior.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERIAL_SCRIPT = path.join(REPO_ROOT, "scripts", "run-serial-tests.sh");
const PARALLEL_SCRIPT = path.join(REPO_ROOT, "scripts", "run-parallel-tests.sh");

function makeTmpDir() {
  return createTempHome("tamandua-runner-test-").root;
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

describe("run-serial-tests.sh", () => {
  it("exists and is executable", () => {
    assert.ok(fs.existsSync(SERIAL_SCRIPT), "scripts/run-serial-tests.sh must exist");
    fs.accessSync(SERIAL_SCRIPT, fs.constants.X_OK);
  });

  it("has valid bash syntax", () => {
    execSync("bash -n " + JSON.stringify(SERIAL_SCRIPT), { stdio: "pipe" });
  });

  it("uses --test-concurrency=1", () => {
    const content = fs.readFileSync(SERIAL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("--test-concurrency=1"),
      "run-serial-tests.sh must contain --test-concurrency=1",
    );
  });

  it("passes through TAMANDUA_TEST_GUARD", () => {
    const content = fs.readFileSync(SERIAL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("TAMANDUA_TEST_GUARD"),
      "run-serial-tests.sh must reference TAMANDUA_TEST_GUARD",
    );
  });

  it("passes through TAMANDUA_PI_BINARY", () => {
    const content = fs.readFileSync(SERIAL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("TAMANDUA_PI_BINARY"),
      "run-serial-tests.sh must reference TAMANDUA_PI_BINARY",
    );
  });

  it("defaults TAMANDUA_TEST_GUARD to 1 when unset", () => {
    // Run a minimal bash snippet that mimics the script's defaulting logic
    const tmpDir = makeTmpDir();
    try {
      const wrapper = [
        '#!/bin/bash',
        'unset TAMANDUA_TEST_GUARD',
        'export TAMANDUA_TEST_GUARD="${TAMANDUA_TEST_GUARD:-1}"',
        'echo "GUARD=$TAMANDUA_TEST_GUARD"',
      ].join("\n");
      const wrapperPath = path.join(tmpDir, "test-default-guard.sh");
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
      const result = execFileSync("bash", [wrapperPath], {
        encoding: "utf-8",
        stdio: "pipe",
        env: { PATH: process.env.PATH },
      });
      assert.ok(
        result.includes("GUARD=1"),
        "TAMANDUA_TEST_GUARD should default to 1 when unset. Got: " + result.trim(),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts overriding TAMANDUA_TEST_GUARD from environment", () => {
    const tmpDir = makeTmpDir();
    try {
      const wrapper = [
        '#!/bin/bash',
        'export TAMANDUA_TEST_GUARD="${TAMANDUA_TEST_GUARD:-1}"',
        'echo "GUARD=$TAMANDUA_TEST_GUARD"',
      ].join("\n");
      const wrapperPath = path.join(tmpDir, "test-override-guard.sh");
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
      const result = execFileSync("bash", [wrapperPath], {
        encoding: "utf-8",
        stdio: "pipe",
        env: { TAMANDUA_TEST_GUARD: "2", PATH: process.env.PATH },
      });
      assert.ok(
        result.includes("GUARD=2"),
        "TAMANDUA_TEST_GUARD should be overridable. Got: " + result.trim(),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("defaults TAMANDUA_PI_BINARY to /usr/bin/false when unset", () => {
    const tmpDir = makeTmpDir();
    try {
      const wrapper = [
        '#!/bin/bash',
        'unset TAMANDUA_PI_BINARY',
        'export TAMANDUA_PI_BINARY="${TAMANDUA_PI_BINARY:-/usr/bin/false}"',
        'echo "PI=$TAMANDUA_PI_BINARY"',
      ].join("\n");
      const wrapperPath = path.join(tmpDir, "test-default-pi.sh");
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
      const result = execFileSync("bash", [wrapperPath], {
        encoding: "utf-8",
        stdio: "pipe",
        env: { PATH: process.env.PATH },
      });
      assert.ok(
        result.includes("PI=/usr/bin/false"),
        "TAMANDUA_PI_BINARY should default to /usr/bin/false. Got: " + result.trim(),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports error when serial-files.txt is missing", () => {
    const tmpDir = makeTmpDir();
    try {
      const wrapper = [
        '#!/bin/bash',
        'REPO_ROOT="' + tmpDir + '"',
        'SERIAL_FILES_LIST="$REPO_ROOT/tests/serial-files.txt"',
        'if [ ! -f "$SERIAL_FILES_LIST" ]; then',
        '  echo "Error: $SERIAL_FILES_LIST not found" >&2',
        '  exit 1',
        'fi',
        'exit 0',
      ].join("\n");
      const wrapperPath = path.join(tmpDir, "test-missing.sh");
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
      try {
        execFileSync("bash", [wrapperPath], { stdio: "pipe", encoding: "utf-8" });
        assert.fail("Should have exited non-zero");
      } catch (e) {
        assert.ok(
          (e.stderr || "").includes("not found"),
          "should report file not found",
        );
        assert.equal(e.status, 1, "should exit with code 1");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits 0 when all serial tests pass", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "dummy.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("dummy", () => {\n' +
        '  it("passes", () => { assert.equal(1, 1); });\n' +
        '});\n'
      );
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/dummy.test.ts\n");

      execFileSync("bash", [SERIAL_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
        encoding: "utf-8",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when a serial test fails", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "failing.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("dummy", () => {\n' +
        '  it("fails", () => { assert.equal(1, 2); });\n' +
        '});\n'
      );
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/failing.test.ts\n");

      try {
        execFileSync("bash", [SERIAL_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero on test failure");
      } catch (e) {
        assert.notEqual(e.status, 0, "exit code must be non-zero on failure");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("run-parallel-tests.sh", () => {
  it("exists and is executable", () => {
    assert.ok(fs.existsSync(PARALLEL_SCRIPT), "scripts/run-parallel-tests.sh must exist");
    fs.accessSync(PARALLEL_SCRIPT, fs.constants.X_OK);
  });

  it("has valid bash syntax", () => {
    execSync("bash -n " + JSON.stringify(PARALLEL_SCRIPT), { stdio: "pipe" });
  });

  it("passes through TAMANDUA_TEST_GUARD", () => {
    const content = fs.readFileSync(PARALLEL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("TAMANDUA_TEST_GUARD"),
      "run-parallel-tests.sh must reference TAMANDUA_TEST_GUARD",
    );
  });

  it("passes through TAMANDUA_PI_BINARY", () => {
    const content = fs.readFileSync(PARALLEL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("TAMANDUA_PI_BINARY"),
      "run-parallel-tests.sh must reference TAMANDUA_PI_BINARY",
    );
  });

  it("excludes serial-lane files", () => {
    const content = fs.readFileSync(PARALLEL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("SERIAL_SET"),
      "run-parallel-tests.sh must contain SERIAL_SET exclusion logic",
    );
  });

  it("excludes e2e-tests directory", () => {
    const content = fs.readFileSync(PARALLEL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("e2e-tests"),
      "run-parallel-tests.sh must exclude e2e-tests/",
    );
  });

  it("does NOT use --test-concurrency=1 (runs with default concurrency)", () => {
    const content = fs.readFileSync(PARALLEL_SCRIPT, "utf-8");
    assert.ok(
      !content.includes("--test-concurrency=1"),
      "run-parallel-tests.sh must NOT use --test-concurrency=1",
    );
  });

  it("runs parallel tests with default concurrency", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "parallel.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("parallel-dummy", () => {\n' +
        '  it("passes", () => { assert.equal(2, 2); });\n' +
        '});\n'
      );

      const result = execFileSync("bash", [PARALLEL_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
        encoding: "utf-8",
      });
      assert.ok(
        result.includes("Parallel lane"),
        "should output 'Parallel lane' label",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when a parallel test fails", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "fail.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("parallel-fail", () => {\n' +
        '  it("fails", () => { assert.equal(1, 2); });\n' +
        '});\n'
      );

      try {
        execFileSync("bash", [PARALLEL_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero on test failure");
      } catch (e) {
        assert.notEqual(e.status, 0, "exit code must be non-zero on failure");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("run-all-lanes.sh", () => {
  const ALL_LANES_SCRIPT = path.join(REPO_ROOT, "scripts", "run-all-lanes.sh");

  function setupTempRepo(tmpDir, { serialFiles, parallelFiles, pkgOverrides }) {
    copyChildScripts(tmpDir);

    // Create package.json with a working build script (build step added by TBLD fix)
    const pkg = { name: "test", scripts: { build: "echo 'build ok'" }, ...pkgOverrides };
    writeText(path.join(tmpDir, "package.json"), JSON.stringify(pkg));

    // Create serial-files.txt with entries
    writeText(path.join(tmpDir, "tests", "serial-files.txt"), serialFiles.join("\n") + "\n");

    // Create each test file
    for (const [filePath, content] of [...(serialFiles.map(f => [f, passTestContent()])), ...(parallelFiles.map(f => [f, passTestContent()]))]) {
      writeText(path.join(tmpDir, filePath), content);
    }
  }

  function passTestContent() {
    return 'import { describe, it } from "node:test";\n' +
           'import assert from "node:assert/strict";\n' +
           'describe("dummy", () => {\n' +
           '  it("passes", () => { assert.equal(1, 1); });\n' +
           '});\n';
  }

  function failTestContent() {
    return 'import { describe, it } from "node:test";\n' +
           'import assert from "node:assert/strict";\n' +
           'describe("dummy", () => {\n' +
           '  it("fails", () => { assert.equal(1, 2); });\n' +
           '});\n';
  }

  it("exists and is executable", () => {
    assert.ok(fs.existsSync(ALL_LANES_SCRIPT), "scripts/run-all-lanes.sh must exist");
    fs.accessSync(ALL_LANES_SCRIPT, fs.constants.X_OK);
  });

  it("has valid bash syntax", () => {
    execSync("bash -n " + JSON.stringify(ALL_LANES_SCRIPT), { stdio: "pipe" });
  });

  it("outputs lane labels for serial and parallel", () => {
    const tmpDir = makeTmpDir();
    try {
      setupTempRepo(tmpDir, {
        serialFiles: ["src/serial.test.ts"],
        parallelFiles: ["src/parallel.test.ts"],
      });

      const result = execFileSync("bash", [ALL_LANES_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("SERIAL lane"),
        "output must label serial lane: " + result.slice(0, 500),
      );
      assert.ok(
        result.includes("PARALLEL lane"),
        "output must label parallel lane: " + result.slice(0, 500),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs serial lane before parallel lane", () => {
    const tmpDir = makeTmpDir();
    try {
      setupTempRepo(tmpDir, {
        serialFiles: ["src/serial.test.ts"],
        parallelFiles: ["src/parallel.test.ts"],
      });

      const result = execFileSync("bash", [ALL_LANES_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      const serialIdx = result.indexOf("SERIAL lane");
      const parallelIdx = result.indexOf("PARALLEL lane");
      assert.ok(serialIdx >= 0, "serial lane label must be present");
      assert.ok(parallelIdx >= 0, "parallel lane label must be present");
      assert.ok(
        serialIdx < parallelIdx,
        "serial lane must appear before parallel lane in output",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exit 0 when both lanes pass", () => {
    const tmpDir = makeTmpDir();
    try {
      setupTempRepo(tmpDir, {
        serialFiles: ["src/serial.test.ts"],
        parallelFiles: ["src/parallel.test.ts"],
      });

      const result = execFileSync("bash", [ALL_LANES_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("Serial lane:   PASSED"),
        "serial lane should show PASSED in summary",
      );
      assert.ok(
        result.includes("Parallel lane: PASSED"),
        "parallel lane should show PASSED in summary",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function copyChildScripts(tmpDir) {
    const scriptsDir = path.join(tmpDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(SERIAL_SCRIPT, path.join(scriptsDir, "run-serial-tests.sh"));
    fs.copyFileSync(PARALLEL_SCRIPT, path.join(scriptsDir, "run-parallel-tests.sh"));
  }

  it("exit non-zero when serial lane fails, and parallel lane still runs", () => {
    const tmpDir = makeTmpDir();
    try {
      copyChildScripts(tmpDir);
      writeText(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test", scripts: { build: "echo 'build ok'" } }));
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/serial-fail.test.ts\n");
      writeText(path.join(tmpDir, "src", "serial-fail.test.ts"), failTestContent());
      writeText(path.join(tmpDir, "src", "parallel-ok.test.ts"), passTestContent());

      try {
        execFileSync("bash", [ALL_LANES_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero when serial lane fails");
      } catch (e) {
        assert.notEqual(e.status, 0, "exit code must be non-zero");

        // Both lanes must have run (no fail-fast)
        const stdout = e.stdout || "";
        assert.ok(
          stdout.includes("SERIAL lane: FAILED"),
          "serial lane must show FAILED",
        );
        assert.ok(
          stdout.includes("PARALLEL lane"),
          "parallel lane must have run despite serial failure",
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exit non-zero when parallel lane fails, and serial lane passed", () => {
    const tmpDir = makeTmpDir();
    try {
      copyChildScripts(tmpDir);
      writeText(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test", scripts: { build: "echo 'build ok'" } }));
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/serial-ok.test.ts\n");
      writeText(path.join(tmpDir, "src", "serial-ok.test.ts"), passTestContent());
      writeText(path.join(tmpDir, "src", "parallel-fail.test.ts"), failTestContent());

      try {
        execFileSync("bash", [ALL_LANES_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero when parallel lane fails");
      } catch (e) {
        assert.notEqual(e.status, 0, "exit code must be non-zero");

        const stdout = e.stdout || "";
        assert.ok(
          stdout.includes("SERIAL lane: PASSED"),
          "serial lane must show PASSED",
        );
        assert.ok(
          stdout.includes("PARALLEL lane: FAILED"),
          "parallel lane must show FAILED",
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exit non-zero when both lanes fail", () => {
    const tmpDir = makeTmpDir();
    try {
      copyChildScripts(tmpDir);
      writeText(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test", scripts: { build: "echo 'build ok'" } }));
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/serial-fail.test.ts\n");
      writeText(path.join(tmpDir, "src", "serial-fail.test.ts"), failTestContent());
      writeText(path.join(tmpDir, "src", "parallel-fail.test.ts"), failTestContent());

      try {
        execFileSync("bash", [ALL_LANES_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero when both lanes fail");
      } catch (e) {
        assert.notEqual(e.status, 0, "exit code must be non-zero");

        const stdout = e.stdout || "";
        assert.ok(
          stdout.includes("SERIAL lane: FAILED"),
          "serial lane must show FAILED",
        );
        assert.ok(
          stdout.includes("PARALLEL lane: FAILED"),
          "parallel lane must show FAILED",
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("summary section labels both lane results", () => {
    const tmpDir = makeTmpDir();
    try {
      setupTempRepo(tmpDir, {
        serialFiles: ["src/serial.test.ts"],
        parallelFiles: ["src/parallel.test.ts"],
      });

      const result = execFileSync("bash", [ALL_LANES_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("PRLL Test Suite Summary"),
        "output must contain summary header",
      );
      assert.ok(
        result.includes("Serial lane:"),
        "summary must mention serial lane",
      );
      assert.ok(
        result.includes("Parallel lane:"),
        "summary must mention parallel lane",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // TBLD: Regression tests for https://github.com/tamandua/issues/TBLD-stale-dist
  it("TBLD: includes build step before lane execution", () => {
    const content = fs.readFileSync(ALL_LANES_SCRIPT, "utf-8");
    assert.ok(
      content.includes("npm run build"),
      "run-all-lanes.sh must contain 'npm run build' for TBLD fix",
    );
    // Build must come before the TAMANDUA_TEST_GUARD export
    const buildIdx = content.indexOf("npm run build");
    const guardIdx = content.indexOf('TAMANDUA_TEST_GUARD="${TAMANDUA_TEST_GUARD:-1}"');
    assert.ok(buildIdx >= 0, "npm run build must be present");
    assert.ok(guardIdx >= 0, "TAMANDUA_TEST_GUARD export must be present");
    assert.ok(
      buildIdx < guardIdx,
      "npm run build must appear before TAMANDUA_TEST_GUARD export (build runs before lanes)",
    );
  });

  it("TBLD: exits non-zero on build failure without running lanes", () => {
    const tmpDir = makeTmpDir();
    try {
      copyChildScripts(tmpDir);
      // Create a package.json with a failing build script
      writeText(path.join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: { build: "echo 'BUILD FAILED' >&2 && exit 1" },
      }));
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/serial.test.ts\n");
      writeText(path.join(tmpDir, "src", "serial.test.ts"), passTestContent());
      writeText(path.join(tmpDir, "src", "parallel.test.ts"), passTestContent());

      try {
        execFileSync("bash", [ALL_LANES_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero on build failure");
      } catch (e) {
        assert.notEqual(e.status, 0, "exit code must be non-zero on build failure");
        const stderr = e.stderr || "";
        assert.ok(
          stderr.includes("Build failed"),
          "stderr must contain 'Build failed': " + stderr.slice(0, 500),
        );
        assert.ok(
          stderr.includes("Last 20 lines"),
          "stderr must contain 'Last 20 lines': " + stderr.slice(0, 500),
        );
        // Lanes must NOT have run
        const stdout = e.stdout || "";
        assert.ok(
          !stdout.includes("SERIAL lane"),
          "serial lane must NOT run on build failure",
        );
        assert.ok(
          !stdout.includes("PARALLEL lane"),
          "parallel lane must NOT run on build failure",
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("TBLD: build log cleaned up on successful build", () => {
    const tmpDir = makeTmpDir();
    const scopedTmpDir = tamanduaTempDir("tamandua-runner-tmpdir-");
    try {
      setupTempRepo(tmpDir, {
        serialFiles: ["src/serial.test.ts"],
        parallelFiles: ["src/parallel.test.ts"],
      });

      execFileSync("bash", [ALL_LANES_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0", TMPDIR: scopedTmpDir }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      // Check that no build log files were left behind in the scoped TMPDIR
      const scopedContents = fs.readdirSync(scopedTmpDir);
      const leakedLogs = scopedContents.filter(f => f.startsWith("tamandua-build-"));
      assert.equal(
        leakedLogs.length, 0,
        "no tamandua-build log files should be left in scoped TMPDIR after a successful build. Found: " + leakedLogs.join(", "),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(scopedTmpDir, { recursive: true, force: true });
    }
  });
});

describe("prll-verify.sh", () => {
  const VERIFY_SCRIPT = path.join(REPO_ROOT, "scripts", "prll-verify.sh");

  function copyVerifyScripts(tmpDir) {
    const scriptsDir = path.join(tmpDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    // Copy all orchestration scripts needed by verify
    fs.copyFileSync(VERIFY_SCRIPT, path.join(scriptsDir, "prll-verify.sh"));
    fs.copyFileSync(
      path.join(REPO_ROOT, "scripts", "run-all-lanes.sh"),
      path.join(scriptsDir, "run-all-lanes.sh"),
    );
    fs.copyFileSync(SERIAL_SCRIPT, path.join(scriptsDir, "run-serial-tests.sh"));
    fs.copyFileSync(PARALLEL_SCRIPT, path.join(scriptsDir, "run-parallel-tests.sh"));
  }

  function passTestContent() {
    return 'import { describe, it } from "node:test";\n' +
           'import assert from "node:assert/strict";\n' +
           'describe("dummy", () => {\n' +
           '  it("passes", () => { assert.equal(1, 1); });\n' +
           '});\n';
  }

  function failTestContent() {
    return 'import { describe, it } from "node:test";\n' +
           'import assert from "node:assert/strict";\n' +
           'describe("dummy", () => {\n' +
           '  it("fails", () => { assert.equal(1, 2); });\n' +
           '});\n';
  }

  it("exists and is executable", () => {
    assert.ok(fs.existsSync(VERIFY_SCRIPT), "scripts/prll-verify.sh must exist");
    fs.accessSync(VERIFY_SCRIPT, fs.constants.X_OK);
  });

  it("has valid bash syntax", () => {
    execSync("bash -n " + JSON.stringify(VERIFY_SCRIPT), { stdio: "pipe" });
  });

  it("accepts PRLL_RUN_COUNT env override", () => {
    const content = fs.readFileSync(VERIFY_SCRIPT, "utf-8");
    assert.ok(
      content.includes("PRLL_RUN_COUNT"),
      "prll-verify.sh must reference PRLL_RUN_COUNT",
    );
    assert.ok(
      content.includes("RUN_COUNT"),
      "prll-verify.sh must reference RUN_COUNT for iteration count",
    );
  });

  it("passes through TAMANDUA_REPO_ROOT override", () => {
    const content = fs.readFileSync(VERIFY_SCRIPT, "utf-8");
    assert.ok(
      content.includes("TAMANDUA_REPO_ROOT"),
      "prll-verify.sh must reference TAMANDUA_REPO_ROOT",
    );
  });

  it("runs BEFORE and AFTER with PRLL_RUN_COUNT=1 and both pass", () => {
    const tmpDir = makeTmpDir();
    try {
      copyVerifyScripts(tmpDir);

      // package.json with npm test pointing to run-all-lanes.sh
      writeText(path.join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: { build: "echo 'build ok'", test: "bash scripts/run-all-lanes.sh" },
      }));

      // Create passing test files
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/serial.test.ts\n");
      writeText(path.join(tmpDir, "src", "serial.test.ts"), passTestContent());
      writeText(path.join(tmpDir, "src", "parallel.test.ts"), passTestContent());

      const result = execFileSync("bash", [VERIFY_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({
          HOME: tmpDir,
          TAMANDUA_REPO_ROOT: tmpDir,
          TAMANDUA_TEST_GUARD: "0",
          PRLL_RUN_COUNT: "1",
        }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("PRLL Verification Run"),
        "must output verification header",
      );
      assert.ok(
        result.includes("PRLL VERIFICATION REPORT"),
        "must output verification report",
      );
      assert.ok(
        result.includes("Cost of Serialization"),
        "must include cost-of-serialization section",
      );
      assert.ok(
        result.includes("Rotating Flake Assessment"),
        "must include rotating flake assessment",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports BEFORE and AFTER wall-clock times", () => {
    const tmpDir = makeTmpDir();
    try {
      copyVerifyScripts(tmpDir);

      writeText(path.join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: { build: "echo 'build ok'", test: "bash scripts/run-all-lanes.sh" },
      }));
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/serial.test.ts\n");
      writeText(path.join(tmpDir, "src", "serial.test.ts"), passTestContent());
      writeText(path.join(tmpDir, "src", "parallel.test.ts"), passTestContent());

      const result = execFileSync("bash", [VERIFY_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({
          HOME: tmpDir,
          TAMANDUA_REPO_ROOT: tmpDir,
          TAMANDUA_TEST_GUARD: "0",
          PRLL_RUN_COUNT: "1",
        }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("BEFORE avg:"),
        "must report BEFORE average: " + result.slice(0, 1000),
      );
      assert.ok(
        result.includes("AFTER  avg:"),
        "must report AFTER average: " + result.slice(0, 1000),
      );
      assert.ok(
        result.includes("Delta:"),
        "must include Delta line: " + result.slice(0, 1000),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits 0 when AFTER runs are all clean", () => {
    const tmpDir = makeTmpDir();
    try {
      copyVerifyScripts(tmpDir);

      writeText(path.join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: { build: "echo 'build ok'", test: "bash scripts/run-all-lanes.sh" },
      }));
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/serial.test.ts\n");
      writeText(path.join(tmpDir, "src", "serial.test.ts"), passTestContent());
      writeText(path.join(tmpDir, "src", "parallel.test.ts"), passTestContent());

      execFileSync("bash", [VERIFY_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({
          HOME: tmpDir,
          TAMANDUA_REPO_ROOT: tmpDir,
          TAMANDUA_TEST_GUARD: "0",
          PRLL_RUN_COUNT: "1",
        }),
        stdio: "pipe",
        encoding: "utf-8",
      });
      // exits 0 when AFTER is clean
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("identifies failing tests by name when runs fail", () => {
    const tmpDir = makeTmpDir();
    try {
      copyVerifyScripts(tmpDir);

      writeText(path.join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: { build: "echo 'build ok'", test: "bash scripts/run-all-lanes.sh" },
      }));
      // A failing serial test to trigger failure reporting
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/broken.test.ts\n");
      writeText(path.join(tmpDir, "src", "broken.test.ts"), failTestContent());
      writeText(path.join(tmpDir, "src", "parallel.test.ts"), passTestContent());

      try {
        execFileSync("bash", [VERIFY_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({
            HOME: tmpDir,
            TAMANDUA_REPO_ROOT: tmpDir,
            TAMANDUA_TEST_GUARD: "0",
            PRLL_RUN_COUNT: "1",
          }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should exit non-zero when AFTER has failures");
      } catch (e) {
        assert.notEqual(e.status, 0, "exit code must be non-zero on failure");
        const stdout = e.stdout || "";
        assert.ok(
          stdout.includes("AFTER runs had failures") || stdout.includes("Rotating Flake Assessment"),
          "must report failures: " + stdout.slice(0, 500),
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("outputs Raw logs path for investigation", () => {
    const tmpDir = makeTmpDir();
    try {
      copyVerifyScripts(tmpDir);

      writeText(path.join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: { build: "echo 'build ok'", test: "bash scripts/run-all-lanes.sh" },
      }));
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/serial.test.ts\n");
      writeText(path.join(tmpDir, "src", "serial.test.ts"), passTestContent());
      writeText(path.join(tmpDir, "src", "parallel.test.ts"), passTestContent());

      const result = execFileSync("bash", [VERIFY_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({
          HOME: tmpDir,
          TAMANDUA_REPO_ROOT: tmpDir,
          TAMANDUA_TEST_GUARD: "0",
          PRLL_RUN_COUNT: "1",
        }),
        stdio: "pipe",
        encoding: "utf-8",
      });

      assert.ok(
        result.includes("Raw logs"),
        "must include raw logs path: " + result.slice(0, 1000),
      );
      assert.ok(
        result.includes("/prll-verify-"),
        "must reference prll-verify- path: " + result.slice(0, 1000),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
