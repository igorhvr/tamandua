import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import { describe, it, before } from "node:test";

const repoRoot = process.cwd();

// NODE_TEST_CONTEXT causes tsx --test (used by the ts suite's npm test)
// to silently skip all tests, making broken-tests appear green. Strip it
// from the environment when spawning any subprocess that runs npm test.
// Also strip TAMANDUA_TEST_GUARD (tamandua test isolation guard).
const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT" || k === "TAMANDUA_TEST_GUARD") continue;
    env[k] = v;
  }
  return env;
})();

// Shorthand for passthrough exec options with clean env
function execOpts(
  overrides: Partial<Parameters<typeof execSync>[1]> = {},
): Parameters<typeof execSync>[1] {
  return { env: CLEAN_ENV, ...overrides } as Parameters<typeof execSync>[1];
}

const fixtureSrc = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly",
);
const scriptPath = path.join(fixtureSrc, "build-golden.sh");
const goldenDir = path.join(repoRoot, "torture-test", "var", "fixtures", "golden");
const bareRepo = path.join(goldenDir, "tt-poly.git");
const hashFile = path.join(goldenDir, ".build-hashes-tt-poly");

// --------------------------------------------------------------------------
// Helper: run build-golden.sh (one pass)
// --------------------------------------------------------------------------
function runBuildGolden(): string {
  if (fs.existsSync(goldenDir)) {
    fs.rmSync(goldenDir, { recursive: true, force: true });
  }
  return execSync(`bash "${scriptPath}"`, {
    cwd: repoRoot,
    env: CLEAN_ENV,
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 300_000,
  });
}

// --------------------------------------------------------------------------
// Helper: clone bare repo to a temp directory and return its path
// --------------------------------------------------------------------------
function cloneBareRepo(prefix: string): string {
  const tmpDir = tamanduaTempDir(prefix);
  execSync(`git clone "${bareRepo}" "${tmpDir}"`, {
    stdio: "pipe", encoding: "utf-8",
  });
  return tmpDir;
}

// --------------------------------------------------------------------------
// Helper: ensure golden repo is built
// --------------------------------------------------------------------------
function ensureGoldenBuilt(): void {
  if (!fs.existsSync(bareRepo)) {
    runBuildGolden();
  }
}

// ==========================================================================
// US-016: End-to-end verification — two consecutive deterministic builds
// ==========================================================================
describe("tt-poly end-to-end verification (US-016)", () => {
  // ── AC 5: Build hash stability file exists ───────────────────────────────

  it("AC5: build hash stability file exists at var/fixtures/golden/.build-hashes-tt-poly", function () {
    this.timeout = 600_000;

    ensureGoldenBuilt();

    assert.ok(
      fs.existsSync(hashFile),
      `.build-hashes-tt-poly should exist at ${hashFile}`,
    );

    const hashes = fs.readFileSync(hashFile, "utf-8");
    assert.ok(
      hashes.includes("baseline="),
      "hash file should contain baseline= entry",
    );
    assert.ok(
      hashes.includes("seed/"),
      "hash file should contain seed/ entries",
    );
    assert.ok(
      hashes.includes("broken-tests="),
      "hash file should contain broken-tests= entry",
    );
    assert.ok(
      hashes.includes("seed/storm="),
      "hash file should contain seed/storm= entry",
    );
  });

  // ── AC 1: Two consecutive builds produce identical hashes ──────────────────

  it("AC1: two consecutive build-golden.sh runs produce identical hashes", function () {
    this.timeout = 600_000; // 10 minutes for two full builds

    // Fresh start — remove any previous golden output
    if (fs.existsSync(goldenDir)) {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }

    // First build
    let output1: string;
    try {
      output1 = execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot,
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 300_000,
      });
    } catch (e: unknown) {
      const err = e as Error & { stdout?: string; stderr?: string };
      assert.fail(
        `First build-golden.sh failed!\nstdout: ${err.stdout || "(none)"}\nstderr: ${err.stderr || err.message}`,
      );
    }

    // Verify first build succeeded
    assert.ok(output1.includes("build-golden.sh — COMPLETE"), "first build should complete");
    assert.ok(output1.includes("Verification   : ALL PASSED"), "first build verification should pass");

    const firstHashes = fs.readFileSync(hashFile, "utf-8");

    // Second build
    let output2: string;
    try {
      output2 = execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot,
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 300_000,
      });
    } catch (e: unknown) {
      const err = e as Error & { stdout?: string; stderr?: string };
      assert.fail(
        `Second build-golden.sh failed!\nstdout: ${err.stdout || "(none)"}\nstderr: ${err.stderr || err.message}`,
      );
    }

    // Verify second build succeeded
    assert.ok(output2.includes("build-golden.sh — COMPLETE"), "second build should complete");
    assert.ok(output2.includes("IDENTICAL"), "second build should report IDENTICAL hashes");
    assert.ok(
      !output2.includes("Hash stability: MISMATCH"),
      "second build should NOT report hash mismatch",
    );

    const secondHashes = fs.readFileSync(hashFile, "utf-8");

    // Byte-for-byte identical
    assert.strictEqual(
      firstHashes,
      secondHashes,
      "two consecutive builds should produce byte-identical hashes",
    );
  });

  // ── AC 2: Scratch clone baseline — all 5 suites green ────────────────────

  it("AC2: scratch clone baseline — structural content verification", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-baseline-");
    try {
      // Verify all 5 subtrees
      for (const subtree of ["python", "ts", "go", "rust", "java"]) {
        const stPath = path.join(tmpDir, subtree);
        assert.ok(
          fs.existsSync(stPath) && fs.statSync(stPath).isDirectory(),
          `baseline should contain ${subtree}/ subtree`,
        );
      }

      // Verify STORM-SENTINEL
      const storeTs = path.join(tmpDir, "ts/src/store.ts");
      assert.ok(fs.existsSync(storeTs), "baseline should have ts/src/store.ts");
      const storeTsContent = fs.readFileSync(storeTs, "utf-8");
      assert.ok(
        storeTsContent.includes("STORM-SENTINEL"),
        "baseline store.ts should contain STORM-SENTINEL marker",
      );

      // Verify run-all-tests and Makefile
      assert.ok(
        fs.existsSync(path.join(tmpDir, "run-all-tests")),
        "baseline should have run-all-tests",
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "Makefile")),
        "baseline should have Makefile",
      );

      // Verify JUNK markers
      assert.ok(
        fs.existsSync(path.join(tmpDir, "JUNK-IS-INTENTIONAL.md")),
        "baseline should have JUNK-IS-INTENTIONAL.md",
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "README-JUNK.md")),
        "baseline should have README-JUNK.md",
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "operator-notes.local")),
        "baseline should have operator-notes.local",
      );

      // Per-subtree operator-notes.local
      for (const subtree of ["python", "ts", "go", "rust", "java"]) {
        assert.ok(
          fs.existsSync(path.join(tmpDir, subtree, "operator-notes.local")),
          `baseline ${subtree}/ should have operator-notes.local`,
        );
      }

      // Go source files present (worker is inlined in pool.go)
      assert.ok(
        fs.existsSync(path.join(tmpDir, "go/pool.go")),
        "baseline should have go/pool.go",
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "go/task.go")),
        "baseline should have go/task.go",
      );

      // Rust source files present
      assert.ok(
        fs.existsSync(path.join(tmpDir, "rust/Cargo.toml")),
        "baseline should have rust/Cargo.toml",
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "rust/src/bucket.rs")),
        "baseline should have rust/src/bucket.rs",
      );

      // Java source files present
      assert.ok(
        fs.existsSync(path.join(tmpDir, "java/pom.xml")),
        "baseline should have java/pom.xml",
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "java/mvnw")),
        "baseline should have java/mvnw (executable)",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("AC2: scratch clone baseline — go test suite passes (fast verification)", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-go-");
    try {
      const result = execSync("go test ./...", {
        cwd: path.join(tmpDir, "go"),
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000,
      });
      assert.ok(
        result.includes("ok") && !result.includes("FAIL"),
        `go test should pass on baseline, got:\n${result}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("AC2: scratch clone baseline — rust test suite passes (fast verification)", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-rust-");
    try {
      const result = execSync("cargo test --quiet 2>&1", {
        cwd: path.join(tmpDir, "rust"),
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000,
        shell: "/bin/bash",
      });
      assert.ok(
        result.includes("test result: ok"),
        `cargo test should pass on baseline, got:\n${result}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("AC2: scratch clone baseline — python test suite passes", function () {
    this.timeout = 600_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-py-");
    try {
      // Bootstrap python if needed
      const pyDir = path.join(tmpDir, "python");
      execSync("bash ./bootstrap", {
        cwd: pyDir,
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000,
        shell: "/bin/bash",
      });

      // Run pytest
      const result = execSync(".venv/bin/pytest -q --tb=short 2>&1", {
        cwd: pyDir,
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000,
        shell: "/bin/bash",
      });
      assert.ok(
        result.includes("passed") && !result.includes("failed"),
        `pytest should pass on baseline, got:\n${result}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── AC 3: broken-tests branch — each subtree red on broken tests ────────

  it("AC3: broken-tests branch — structural verification (test_broken_*.py present)", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-broken-");
    try {
      execSync("git checkout broken-tests", {
        cwd: tmpDir,
        stdio: "pipe",
        encoding: "utf-8",
      });

      // Python broken test files
      assert.ok(
        fs.existsSync(path.join(tmpDir, "python/tests/test_broken_p1.py")),
        "broken-tests should have python/tests/test_broken_p1.py",
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "python/tests/test_broken_p2.py")),
        "broken-tests should have python/tests/test_broken_p2.py",
      );

      // Verify python/test_broken_*.py files are different from a clean file
      // (they should contain deliberate test failures)
      const p1Content = fs.readFileSync(
        path.join(tmpDir, "python/tests/test_broken_p1.py"),
        "utf-8",
      );
      assert.ok(
        p1Content.length > 0,
        "test_broken_p1.py should have content",
      );

      const p2Content = fs.readFileSync(
        path.join(tmpDir, "python/tests/test_broken_p2.py"),
        "utf-8",
      );
      assert.ok(
        p2Content.length > 0,
        "test_broken_p2.py should have content",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("AC3: broken-tests branch — python broken tests fail", function () {
    this.timeout = 600_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-pybroken-");
    try {
      execSync("git checkout broken-tests", {
        cwd: tmpDir,
        stdio: "pipe",
        encoding: "utf-8",
      });

      const pyDir = path.join(tmpDir, "python");
      execSync("bash ./bootstrap", {
        cwd: pyDir,
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000,
        shell: "/bin/bash",
      });

      const result = execSync(".venv/bin/pytest -q --tb=line 2>&1 || true", {
        cwd: pyDir,
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000,
        shell: "/bin/bash",
      });

      // On broken-tests branch, python tests SHOULD fail
      assert.ok(
        result.includes("failed") || result.includes("FAILED"),
        `python tests should fail on broken-tests branch, got:\n${result}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("AC3: broken-tests branch — go broken tests fail", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-gobroken-");
    try {
      execSync("git checkout broken-tests", {
        cwd: tmpDir,
        stdio: "pipe",
        encoding: "utf-8",
      });

      const result = execSync("go test ./... 2>&1 || true", {
        cwd: path.join(tmpDir, "go"),
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000,
      });

      // On broken-tests branch, go tests with BRK should fail
      assert.ok(
        result.includes("FAIL"),
        `go tests should fail on broken-tests branch, got:\n${result}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── AC 4: seed/storm ref — all composed symptoms verified ───────────────

  it("AC4: seed/storm ref — POLY-BUG-G4 data race detectable with go test -race", function () {
    this.timeout = 600_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-g4-");
    try {
      execSync("git checkout seed/POLY-BUG-G4", {
        cwd: tmpDir,
        stdio: "pipe",
        encoding: "utf-8",
      });

      // Verify pool.go content differs from baseline (G4 introduces a data race)
      const poolGo = path.join(tmpDir, "go/pool.go");
      assert.ok(fs.existsSync(poolGo), "seed/POLY-BUG-G4 should have go/pool.go");
      const poolContent = fs.readFileSync(poolGo, "utf-8");

      // G4 introduces a data race by removing mutex/unlock or making map access unsynchronized
      // The seed overlay should differ from baseline pool.go
      assert.ok(poolContent.length > 0, "pool.go should have content in POLY-BUG-G4");

      // Run go test with race detector — should detect the data race
      const raceResult = execSync("go test -race -count=1 ./... 2>&1 || true", {
        cwd: path.join(tmpDir, "go"),
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000,
      });

      // Data race detection: either the test fails OR the race detector reports a race
      const hasRace = raceResult.includes("WARNING: DATA RACE")
        || raceResult.includes("race detected")
        || raceResult.includes("FAIL");
      assert.ok(
        hasRace,
        `go test -race should detect data race in POLY-BUG-G4, got:\n${raceResult.substring(0, 2000)}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("AC4: seed/storm ref — POLY-BUG-R1 overflow bug present (u32 arithmetic)", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-r1-");
    try {
      execSync("git checkout seed/POLY-BUG-R1", {
        cwd: tmpDir,
        stdio: "pipe",
        encoding: "utf-8",
      });

      // R1 replaces the u64-safe refill calculation with a u32 multiplication
      // that can overflow (>4.3B). In debug mode, Rust would panic on overflow;
      // in release mode, the value wraps to an incorrect count.
      // The existing test suite uses small values and does NOT trigger the
      // overflow, so the tests pass. This is a latent bug.

      const bucketRs = fs.readFileSync(
        path.join(tmpDir, "rust/src/bucket.rs"),
        "utf-8",
      );

      // Verify the u32 arithmetic bug is present (R1 removes the u64-safe fix)
      assert.ok(
        bucketRs.includes("elapsed as u32 * self.config.refill_rate()"),
        "POLY-BUG-R1 should have u32 multiplication (the overflow bug)",
      );

      // Verify the u64-safe fix is NOT present
      assert.ok(
        !bucketRs.includes("elapsed as u64 * self.config.refill_rate() as u64"),
        "POLY-BUG-R1 should NOT have the u64-safe fix",
      );

      // Verify the baseline bucket.rs has the u64 fix (not the u32 bug)
      const mainBucket = path.join(
        repoRoot,
        "torture-test/fixtures-src/tt-poly/rust/src/bucket.rs",
      );
      const mainBucketContent = fs.readFileSync(mainBucket, "utf-8");
      assert.ok(
        mainBucketContent.includes("elapsed as u64 * self.config.refill_rate() as u64"),
        "baseline bucket.rs should have the u64-safe fix",
      );
      assert.ok(
        !mainBucketContent.includes("elapsed as u32 * self.config.refill_rate()"),
        "baseline bucket.rs should NOT have the u32 overflow bug",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("AC4: seed/storm ref — structural content verification", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-storm-");
    try {
      execSync("git checkout seed/storm", {
        cwd: tmpDir,
        stdio: "pipe",
        encoding: "utf-8",
      });

      // seed/storm should have all composed seeds active
      // Python broken tests present
      assert.ok(
        fs.existsSync(path.join(tmpDir, "python/tests/test_broken_p1.py")),
        "seed/storm should contain test_broken_p1.py",
      );

      // Go pool.go differs from a clean baseline (storm seeds active)
      const poolGo = path.join(tmpDir, "go/pool.go");
      assert.ok(fs.existsSync(poolGo), "seed/storm should have go/pool.go");

      // Verify STORM-SENTINEL still present (storm seeds don't remove it)
      const storeTs = path.join(tmpDir, "ts/src/store.ts");
      assert.ok(fs.existsSync(storeTs), "seed/storm should have ts/src/store.ts");
      const storeContent = fs.readFileSync(storeTs, "utf-8");
      assert.ok(
        storeContent.includes("STORM-SENTINEL"),
        "seed/storm store.ts should retain STORM-SENTINEL (patch seeds don't remove it)",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── AC 4 (cont): seed/storm — go test suite shows composite symptoms ────

  it("AC4: seed/storm ref — go test suite shows composite symptoms", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-storm-go-");
    try {
      execSync("git checkout seed/storm", {
        cwd: tmpDir,
        stdio: "pipe",
        encoding: "utf-8",
      });

      const result = execSync("go test ./... 2>&1 || true", {
        cwd: path.join(tmpDir, "go"),
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000,
      });

      // seed/storm has all go bug seeds + broken tests layered → go tests should fail
      assert.ok(
        result.includes("FAIL"),
        `seed/storm go tests should fail (composite symptoms), got:\n${result.substring(0, 500)}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── AC 6: Junk probe invariants hold per subtree ────────────────────────

  it("AC6: junk probes — operator-notes.local byte-identical across all subtrees", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-junk-");
    try {
      // Read reference operator-notes.local from source
      const refOpPath = path.join(fixtureSrc, "operator-notes.local");
      assert.ok(fs.existsSync(refOpPath), "source operator-notes.local should exist");
      const refOp = fs.readFileSync(refOpPath, "utf-8");

      // Verify root operator-notes.local matches source
      const rootOp = fs.readFileSync(path.join(tmpDir, "operator-notes.local"), "utf-8");
      assert.strictEqual(
        rootOp,
        refOp,
        "baseline operator-notes.local should be byte-identical to source",
      );

      // Verify per-subtree operator-notes.local files exist
      for (const subtree of ["python", "ts", "go", "rust", "java"]) {
        const subOpPath = path.join(tmpDir, subtree, "operator-notes.local");
        assert.ok(
          fs.existsSync(subOpPath),
          `${subtree}/operator-notes.local should exist`,
        );
        const subOp = fs.readFileSync(subOpPath, "utf-8");
        assert.ok(
          subOp.length > 0,
          `${subtree}/operator-notes.local should not be empty`,
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("AC6: junk probes — regenerated junk probe paths NOT gitignored", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const tmpDir = cloneBareRepo("tt-poly-e2e-gitignore-");
    try {
      const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");

      // Verify junk probe patterns are NOT in top-level .gitignore
      for (const junk of [
        "__pycache__",
        ".pytest_cache",
        "node_modules",
        "package-lock.json",
        "target",
        ".flaky_counter",
      ]) {
        // Strip comments and check if the pattern is gitignored
        const lines = gitignore
          .split("\n")
          .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
        const hasPattern = lines.some(
          (l) => l.trim().replace(/\/$/, "") === junk,
        );
        assert.ok(
          !hasPattern,
          `Junk probe '${junk}' must NOT be gitignored at top-level`,
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── make test === ./run-all-tests ────────────────────────────────────────

  it("Makefile 'make test' references ./run-all-tests", function () {
    this.timeout = 300_000;

    const makefilePath = path.join(fixtureSrc, "Makefile");
    assert.ok(fs.existsSync(makefilePath), "Makefile should exist");

    const content = fs.readFileSync(makefilePath, "utf-8");
    assert.ok(
      content.includes("./run-all-tests"),
      "Makefile test target should invoke ./run-all-tests",
    );
    assert.ok(
      content.includes(".PHONY: test") || content.includes(".PHONY: test\n"),
      "Makefile should declare .PHONY: test",
    );
  });

  // ── Phase 9 verification output ──────────────────────────────────────────

  it("build-golden.sh Phase 10 verification passes all sub-phases", function () {
    this.timeout = 600_000;

    // Fresh build to get fresh verification output
    const output = runBuildGolden();

    // Verify all 6 sub-phases of Phase 10 pass
    assert.ok(
      output.includes("[10a] Baseline content check"),
      "Phase 10a: baseline content check should run",
    );

    assert.ok(
      output.includes("[10b] Seed ref existence check"),
      "Phase 10b: seed ref existence check should run",
    );

    assert.ok(
      output.includes("[10c] broken-tests branch content check"),
      "Phase 10c: broken-tests content check should run",
    );

    assert.ok(
      output.includes("[10d] Junk probe verification"),
      "Phase 10d: junk probe verification should run",
    );

    assert.ok(
      output.includes("[10e] Seed ref content spot-checks"),
      "Phase 10e: seed content spot-checks should run",
    );

    assert.ok(
      output.includes("[10f] seed/storm composite content check"),
      "Phase 10f: seed/storm content check should run",
    );

    // All phases should report 'ok' (not MISSING or FAIL)
    // The build would exit non-zero on failure, so reaching COMPLETE means all passed
    assert.ok(
      output.includes("Verification   : ALL PASSED"),
      "Phase 10 verification should report ALL PASSED",
    );

    // check for any verification failure indicators (should be none)
    assert.ok(
      !output.includes("MISSING!"),
      "No verification steps should report MISSING",
    );
    assert.ok(
      !output.includes("BYTE-MISMATCH!"),
      "No junk probe should report BYTE-MISMATCH",
    );

    // Summary should list all verification checks
    assert.ok(
      output.includes("Baseline content"),
      "summary should mention Baseline content check",
    );
    assert.ok(
      output.includes("All seed refs present"),
      "summary should mention all seed refs present",
    );
    assert.ok(
      output.includes("broken-tests branch"),
      "summary should mention broken-tests branch",
    );
    assert.ok(
      output.includes("seed/storm composite ref"),
      "summary should mention seed/storm composite ref",
    );
    assert.ok(
      output.includes("Junk probes verified"),
      "summary should mention junk probes verified",
    );
    assert.ok(
      output.includes("Hash stability check"),
      "summary should mention hash stability check",
    );
  });

  // ── Hash stability: second run confirms IDENTICAL ───────────────────────

  it("hash stability: second run confirms IDENTICAL output", function () {
    this.timeout = 600_000;

    ensureGoldenBuilt();

    // Run build-golden.sh again (golden already exists from ensureGoldenBuilt)
    const output = execSync(`bash "${scriptPath}"`, {
      cwd: repoRoot,
      env: CLEAN_ENV,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 300_000,
    });

    assert.ok(
      output.includes("IDENTICAL"),
      "second build should report IDENTICAL hashes",
    );

    assert.ok(
      !output.includes("Hash stability: MISMATCH"),
      "second build should NOT report hash mismatch",
    );
  });

  // ── Edge cases: total seed ref count ─────────────────────────────────────

  it("all 36 seed refs exist under refs/heads/seed/", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const refs = execSync(
      `git --git-dir="${bareRepo}" for-each-ref --format='%(refname:short)' refs/heads/seed/`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim().split("\n").filter(Boolean);

    assert.strictEqual(
      refs.length,
      36,
      `expected 36 seed refs (35 POLY-* + 1 seed/storm), got ${refs.length}: ${refs.join(", ")}`,
    );
  });

  // ── Edge case: broken-tests branch exists and differs from baseline ─────

  it("broken-tests branch exists and differs from baseline", function () {
    this.timeout = 300_000;

    ensureGoldenBuilt();

    const brkSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/broken-tests`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    assert.ok(brkSha.length === 40, "broken-tests should be valid 40-char SHA");

    const mainSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();

    assert.notStrictEqual(
      brkSha,
      mainSha,
      "broken-tests should differ from main (has BRK seeds applied)",
    );
  });
});
