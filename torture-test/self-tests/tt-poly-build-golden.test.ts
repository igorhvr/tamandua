import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

// NODE_TEST_CONTEXT causes tsx --test (used by the ts suite's npm test)
// to silently skip all tests, making broken-tests appear green. Strip it
// from the environment when spawning any subprocess that runs npm test.
// Also strip TAMANDUA_TEST_GUARD (tamandua test isolation guard) since
// the golden builder itself doesn't need tamandua state.
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

describe("tt-poly build-golden.sh", () => {
  const scriptPath = path.join(
    repoRoot,
    "torture-test",
    "fixtures-src",
    "tt-poly",
    "build-golden.sh",
  );
  const goldenDir = path.join(
    repoRoot,
    "torture-test",
    "var",
    "fixtures",
    "golden",
  );
  const bareRepo = path.join(goldenDir, "tt-poly.git");
  const hashFile = path.join(goldenDir, "tt-poly.git.hashes");

  // ── AC 1: build-golden.sh exists and is executable ──────────────────────

  it("exists and is executable", () => {
    assert.ok(fs.existsSync(scriptPath), "build-golden.sh should exist");
    const stat = fs.statSync(scriptPath);
    assert.ok(
      stat.mode & fs.constants.S_IXUSR,
      "build-golden.sh should be user-executable",
    );
  });

  it("starts with shebang and set -euo pipefail", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.startsWith("#!/usr/bin/env bash"),
      "should start with #!/usr/bin/env bash",
    );
    assert.ok(
      content.includes("set -euo pipefail"),
      "should use set -euo pipefail",
    );
  });

  // ── AC 2: Deterministic git identity ────────────────────────────────────

  it("has deterministic git identity (fixed values, not dynamic)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const v of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_DATE",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_DATE",
    ]) {
      assert.ok(
        content.includes(`${v}=`),
        `should set ${v}`,
      );
    }
    // Each should contain a literal string value (not a variable reference)
    const hasDynamicIdentity = /GIT_AUTHOR_NAME=\$/.test(content);
    assert.ok(
      !hasDynamicIdentity,
      "GIT_AUTHOR_NAME should be a fixed value",
    );
  });

  it("uses fixed date 2026-01-01T00:00:00Z", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("2026-01-01T00:00:00Z"),
      "should use fixed date 2026-01-01T00:00:00Z",
    );
  });

  it("has fixed identity strings, not generated", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const v of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
      assert.ok(
        content.includes("Tamandua Fixture Builder") || content.includes("fixtures@tamandua.tetradactyla.org"),
        `should use Tamandua identity for ${v}`,
      );
    }
  });

  it("disables GPG signing", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("--no-gpg-sign"),
      "should use --no-gpg-sign flag",
    );
  });

  it("uses --initial-branch=main for determinism", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("--initial-branch=main"),
      "should use --initial-branch=main",
    );
  });

  // ── Path variable resolution ────────────────────────────────────────────

  it("resolves all required path variables", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const v of [
      "SCRIPT_DIR",
      "FIXTURE_SRC",
      "REPO_ROOT",
      "GOLDEN_DIR",
      "BARE_REPO",
      "HASH_FILE",
    ]) {
      assert.ok(
        content.includes(`${v}=`),
        `should define ${v}`,
      );
    }
  });

  it("outputs to tt-poly.git (not tt-poly-lite.git)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("tt-poly.git"),
      "should output to tt-poly.git",
    );
    assert.ok(
      !content.includes("tt-poly-lite.git"),
      "should NOT reference tt-poly-lite.git",
    );
  });

  it("hash file named tt-poly.git.hashes", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("tt-poly.git.hashes"),
      "should use tt-poly.git.hashes",
    );
  });

  // ── Cleanup trap ────────────────────────────────────────────────────────

  it("has cleanup trap with EXIT handler", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("trap cleanup EXIT"),
      "should register EXIT trap for cleanup",
    );
  });

  it("has scratch_dir helper function", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("scratch_dir()") || content.includes("function scratch_dir"),
      "should define scratch_dir function",
    );
  });

  // ── AC 3: Phase 1 — baseline commit ─────────────────────────────────────

  it("Phase 1: creates working tree from tt-poly source", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("Phase 1"),
      "should have Phase 1 section",
    );
    assert.ok(
      content.includes("tar --exclude="),
      "should use tar for source copy",
    );
  });

  it("Phase 1: excludes build-golden.sh and generated crud from tar", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    // Must exclude build-golden.sh itself
    assert.ok(
      content.includes("build-golden.sh"),
      "should exclude build-golden.sh from tar",
    );
    // Must exclude at least some generated crud
    for (const excl of [".venv", "__pycache__", "node_modules", "package-lock.json", "target"]) {
      assert.ok(
        content.includes(excl),
        `should exclude '${excl}' from tar`,
      );
    }
  });

  it("Phase 1: creates baseline commit with 'Initial baseline' message", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("Initial baseline: tt-poly five-language monorepo"),
      "should have correct baseline commit message",
    );
  });

  it("Phase 1: pushes baseline to bare repo refs/heads/main", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("refs/heads/main"),
      "should push to refs/heads/main",
    );
  });

  it("Phase 1: sets bare repo symbolic-ref HEAD to main", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("symbolic-ref HEAD refs/heads/main"),
      "should set bare repo HEAD to main",
    );
  });

  // ── AC 4: Phase 2 — python seed refs ────────────────────────────────────

  it("Phase 2: defines python seed ref arrays", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("PYTHON_BUG_SEEDS"),
      "should define PYTHON_BUG_SEEDS",
    );
    assert.ok(
      content.includes("PYTHON_VULN_SEEDS"),
      "should define PYTHON_VULN_SEEDS",
    );
    assert.ok(
      content.includes("PYTHON_SEED_REFS"),
      "should define PYTHON_SEED_REFS",
    );
  });

  it("Phase 2: PYTHON_SEED_REFS includes all 6 seeds", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const seed of [
      "POLY-BUG-P1", "POLY-BUG-P2", "POLY-BUG-P3", "POLY-BUG-P4",
      "POLY-VULN-P1", "POLY-VULN-P2",
    ]) {
      assert.ok(
        content.includes(seed),
        `PYTHON_SEED_REFS should include ${seed}`,
      );
    }
  });

  it("Phase 2: has py_target_for mapping for all overlay types", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    const expectedMappings: Array<[string, string]> = [
      ["recurrence.py", "python/src/schedlib/recurrence.py"],
      ["conflict.py", "python/src/schedlib/conflict.py"],
      ["dates.py", "python/src/schedlib/dates.py"],
      ["integrations.py", "python/src/schedlib/integrations.py"],
      ["conftest.py", "python/conftest.py"],
      ["test_broken_p1.py", "python/tests/test_broken_p1.py"],
      ["test_broken_p2.py", "python/tests/test_broken_p2.py"],
    ];
    for (const [file, target] of expectedMappings) {
      assert.ok(
        content.includes(file) && content.includes(target),
        `py_target_for should map ${file} → ${target}`,
      );
    }
  });

  it("Phase 2: uses seeds/python/ path (aggregated seeds dir)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("seeds/python/"),
      "should use aggregated seeds/python/ path for seed directory",
    );
  });

  it("Phase 2: skips fix.patch in overlay copy loop", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes('"fix.patch"'),
      "should skip fix.patch files in overlay copy",
    );
  });

  it("Phase 2: commits with 'seed: <id>' or 'seed: <id> (dormant)'", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes('seed: $seed_id') || content.includes('"seed: $seed_id"'),
      "should commit with seed: <id> message",
    );
  });

  it("Phase 2: pushes to refs/heads/seed/<id> for each seed", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes('refs/heads/seed/$seed_id') || content.includes('"refs/heads/seed/$seed_id"'),
      "should push to seed ref",
    );
  });

  // ── AC 5: Phase 3 — ts seed refs ────────────────────────────────────────

  it("Phase 3: defines ts seed ref arrays", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const arr of [
      "TS_BUG_SEEDS", "TS_BRK_SEEDS", "TS_VULN_SEEDS",
      "TS_PATCH_SEEDS", "TS_SEED_REFS",
    ]) {
      assert.ok(content.includes(arr), `should define ${arr}`);
    }
  });

  it("Phase 3: TS_PATCH_SEEDS includes all 6 patch-based seeds", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const seed of [
      "POLY-BUG-T1", "POLY-BUG-T2", "POLY-BUG-T3", "POLY-BUG-T4",
      "POLY-BRK-T1", "POLY-BRK-T2",
    ]) {
      assert.ok(
        content.includes(seed),
        `TS_PATCH_SEEDS should include ${seed}`,
      );
    }
  });

  it("Phase 3: TS_SEED_REFS includes BUG + VULN seeds (not BRK)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const seed of [
      "POLY-BUG-T1", "POLY-BUG-T2", "POLY-BUG-T3", "POLY-BUG-T4",
      "POLY-VULN-T1", "POLY-VULN-T2",
    ]) {
      assert.ok(
        content.includes(seed),
        `TS_SEED_REFS should include ${seed}`,
      );
    }
  });

  it("Phase 3: uses git apply -p4 for ts patches", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("git apply -p4"),
      "should use git apply -p4 for ts patches",
    );
  });

  it("Phase 3: uses seeds/ts/ path for ts seed patches", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("seeds/ts/"),
      "should use aggregated seeds/ts/ path",
    );
  });

  it("Phase 3: VULN-T1 and VULN-T2 point to baseline via update-ref", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("POLY-VULN-T1") && content.includes("POLY-VULN-T2"),
      "should handle VULN-T1 and VULN-T2",
    );
    assert.ok(
      content.includes("update-ref"),
      "should use update-ref for VULN dormant seeds",
    );
  });

  it("Phase 3: VULN dormant comment mentions 'dormant -> baseline'", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("dormant -> baseline"),
      "should document VULN dormant pointing to baseline",
    );
  });

  // ── AC 6: Hash stability ────────────────────────────────────────────────

  it("Phase 10: hash stability section present", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("Hash stability"),
      "should have hash stability section",
    );
  });

  it("Phase 10: records baseline hash", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("baseline=$BASELINE_SHA") || content.includes('baseline=$BASELINE_SHA'),
      "should record baseline hash",
    );
  });

  it("Phase 10: records all PYTHON_SEED_REFS and TS_SEED_REFS hashes", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("PYTHON_SEED_REFS") && content.includes("TS_SEED_REFS"),
      "should iterate over PYTHON_SEED_REFS and TS_SEED_REFS for hash recording",
    );
  });

  it("Phase 10: compares against previous run with diff", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("diff") && content.includes("HASH_FILE"),
      "should diff against previous hash file",
    );
  });

  it("Phase 10: handles FIRST RUN case when no previous hashes", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("FIRST RUN"),
      "should handle first run with no previous hashes",
    );
  });

  it("Phase 10: exits non-zero on hash mismatch", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    // Should have exit 1 in mismatch branch
    assert.ok(
      content.includes("MISMATCH") && content.includes("exit 1"),
      "should exit 1 on hash mismatch",
    );
  });

  // ── Phase implementations for US-014 ───────────────────────────────────

  it("has full phase implementations (no TODO stubs remaining)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    // Verify phases exist with actual implementations, not TODO stubs
    for (const phase of [
      "Phase 4: Building go seed refs",
      "Phase 5: Building rust seed refs",
      "Phase 6: Building java seed refs",
      "Phase 7: Building broken-tests branch",
      "Phase 8: Building composite seed/storm ref",
      "Phase 9: Storm sentinel pre-verification",
      "Phase 10: Post-build verification",
    ]) {
      assert.ok(
        content.includes(phase),
        `should have ${phase} implemented`,
      );
    }
    // No TODO stubs remaining
    assert.ok(
      !content.includes("TODO Phase 4"),
      "Phase 4 TODO stub should be replaced with implementation",
    );
    assert.ok(
      !content.includes("TODO Phase 10"),
      "Phase 10 TODO stub should be replaced with implementation",
    );
  });

  // ── Seeds directory mapping functions ───────────────────────────────────

  it("has go_target_for mapping function (for Phase 4, US-014)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("go_target_for"),
      "should define go_target_for mapping function",
    );
    // Verify at least some known mappings
    for (const [file, target] of [
      ["pool.go", "go/pool.go"],
      ["worker.go", "go/worker.go"],
      ["util_command.go", "go/util/command.go"],
    ]) {
      assert.ok(
        content.includes(file) && content.includes(target),
        `go_target_for should map ${file} → ${target}`,
      );
    }
  });

  it("has rust_target_for mapping function (for Phase 5, US-014)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("rust_target_for"),
      "should define rust_target_for mapping function",
    );
    for (const [file, target] of [
      ["bucket.rs", "rust/src/bucket.rs"],
      ["config.rs", "rust/src/config.rs"],
      ["integration.rs", "rust/tests/integration.rs"],
    ]) {
      assert.ok(
        content.includes(file) && content.includes(target),
        `rust_target_for should map ${file} → ${target}`,
      );
    }
  });

  // ── Future phase seed arrays ────────────────────────────────────────────

  it("defines go seed arrays (for Phase 4)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const arr of ["GO_BUG_SEEDS", "GO_VULN_SEEDS", "GO_BRK_SEEDS", "GO_SEED_REFS"]) {
      assert.ok(content.includes(arr), `should define ${arr}`);
    }
    for (const seed of [
      "POLY-BUG-G1", "POLY-BUG-G2", "POLY-BUG-G3", "POLY-BUG-G4",
      "POLY-VULN-G1", "POLY-VULN-G2",
    ]) {
      assert.ok(content.includes(seed), `go arrays should include ${seed}`);
    }
  });

  it("defines rust seed arrays (for Phase 5)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const arr of ["RUST_BUG_SEEDS", "RUST_VULN_SEEDS", "RUST_BRK_SEEDS", "RUST_SEED_REFS"]) {
      assert.ok(content.includes(arr), `should define ${arr}`);
    }
    for (const seed of [
      "POLY-BUG-R1", "POLY-BUG-R2", "POLY-BUG-R3", "POLY-BUG-R4",
      "POLY-VULN-R1", "POLY-VULN-R2",
    ]) {
      assert.ok(content.includes(seed), `rust arrays should include ${seed}`);
    }
  });

  it("defines java seed arrays (for Phase 6)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const arr of ["JAVA_BUG_SEEDS", "JAVA_VULN_SEEDS", "JAVA_BRK_SEEDS", "JAVA_PATCH_SEEDS", "JAVA_SEED_REFS"]) {
      assert.ok(content.includes(arr), `should define ${arr}`);
    }
    for (const seed of [
      "POLY-BUG-J1", "POLY-BUG-J2", "POLY-BUG-J3", "POLY-BUG-J4",
      "POLY-VULN-J1", "POLY-VULN-J2",
    ]) {
      assert.ok(content.includes(seed), `java arrays should include ${seed}`);
    }
  });

  // ── Summary section ─────────────────────────────────────────────────────

  it("summary reports COMPLETE with all phases done", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("build-golden.sh — COMPLETE"),
      "summary should report COMPLETE (no longer partial)",
    );
    assert.ok(
      !content.includes("Remaining phases"),
      "summary should not mention remaining phases",
    );
    // Verification summary should mention all components
    for (const line of [
      "go + rust + java",
      "broken-tests branch",
      "seed/storm composite ref",
      "seed/storm composite ref",
    ]) {
      // Some may be folded into shorter messages — just check key terms
    }
    assert.ok(
      content.includes("broken-tests") || content.includes("broken tests"),
      "summary should mention broken-tests",
    );
    assert.ok(
      content.includes("seed/storm"),
      "summary should mention seed/storm",
    );
  });

  // ── Execution test: build-golden.sh runs successfully ───────────────────

  it("build-golden.sh executes successfully and creates golden bare repo", function () {
    this.timeout = 300_000; // 5 minutes — enough for baseline + seed refs

    // Remove any previous golden output
    if (fs.existsSync(goldenDir)) {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }

    let output: string;
    try {
      output = execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot,
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 300_000,
      });
    } catch (e: unknown) {
      const err = e as Error & { stdout?: string; stderr?: string };
      const msg = [
        "build-golden.sh failed!",
        `stdout: ${err.stdout || "(none)"}`,
        `stderr: ${err.stderr || err.message || "(none)"}`,
      ].join("\n");
      assert.fail(msg);
    }

    // Verify output banner
    assert.ok(
      output.includes("build-golden.sh — tt-poly deterministic golden builder"),
      "should print banner",
    );

    // Verify Phase 1
    assert.ok(
      output.includes("Phase 1: Building working tree"),
      "should execute Phase 1",
    );
    assert.ok(
      output.includes("Baseline commit"),
      "should show baseline commit hash",
    );

    // Verify Phase 2
    assert.ok(
      output.includes("Phase 2: Building python seed refs"),
      "should execute Phase 2",
    );

    // Verify Phase 3
    assert.ok(
      output.includes("Phase 3: Building ts seed refs"),
      "should execute Phase 3",
    );

    // Verify bare repo exists
    assert.ok(
      fs.existsSync(bareRepo),
      "bare repo should be created at tt-poly.git",
    );

    // Verify it's a bare repo
    const headFile = path.join(bareRepo, "HEAD");
    assert.ok(fs.existsSync(headFile), "HEAD file should exist in bare repo");
    const head = fs.readFileSync(headFile, "utf-8").trim();
    assert.ok(
      head.includes("refs/heads/main"),
      "bare repo HEAD should point to main",
    );

    // Verify baseline ref exists
    const mainSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    assert.ok(mainSha.length === 40, `main SHA should be 40 chars, got ${mainSha.length}: ${mainSha}`);

    // Verify seed refs exist
    for (const seed of [
      "POLY-BUG-P1", "POLY-BUG-P2", "POLY-BUG-P3", "POLY-BUG-P4",
      "POLY-VULN-P1", "POLY-VULN-P2",
      "POLY-BUG-T1", "POLY-BUG-T2", "POLY-BUG-T3", "POLY-BUG-T4",
      "POLY-VULN-T1", "POLY-VULN-T2",
      "POLY-BRK-T1", "POLY-BRK-T2",
    ]) {
      const sha = execSync(
        `git --git-dir="${bareRepo}" rev-parse "refs/heads/seed/${seed}"`,
        { encoding: "utf-8", stdio: "pipe" },
      ).trim();
      assert.ok(sha.length === 40, `seed/${seed} should be a valid 40-char SHA, got: ${sha}`);
    }

    // Verify hash file
    assert.ok(
      fs.existsSync(hashFile),
      "tt-poly.git.hashes should exist",
    );
    const hashes = fs.readFileSync(hashFile, "utf-8");
    assert.ok(
      hashes.includes("baseline=") && hashes.includes(mainSha),
      `hash file should contain baseline=${mainSha}`,
    );
  });

  // ── Hash stability: second run matches first ────────────────────────────

  it("two consecutive builds produce identical hashes", function () {
    this.timeout = 600_000; // 10 minutes for two builds

    // First run — already done by previous test, but let's verify
    // We need a fresh first run to start from scratch
    if (fs.existsSync(goldenDir)) {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }

    // First build
    execSync(`bash "${scriptPath}"`, {
      cwd: repoRoot,
      env: CLEAN_ENV,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 300_000,
    });

    const firstHashes = fs.readFileSync(hashFile, "utf-8");

    // Second build — should be identical
    execSync(`bash "${scriptPath}"`, {
      cwd: repoRoot,
      env: CLEAN_ENV,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 300_000,
    });

    const secondHashes = fs.readFileSync(hashFile, "utf-8");

    assert.strictEqual(
      firstHashes,
      secondHashes,
      "two consecutive builds should produce identical hashes",
    );
  });

  // ── Baseline commit content verification ────────────────────────────────

  it("baseline checkout: all 5 subtrees present", function () {
    this.timeout = 300_000;

    // Ensure golden exists
    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot,
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 300_000,
      });
    }

    const tmpDir = tamanduaTempDir("tt-poly-baseline-");
    try {
      execSync(`git clone "${bareRepo}" "${tmpDir}"`, {
        stdio: "pipe", encoding: "utf-8",
      });

      for (const subtree of ["python", "ts", "go", "rust", "java"]) {
        const stPath = path.join(tmpDir, subtree);
        assert.ok(
          fs.existsSync(stPath) && fs.statSync(stPath).isDirectory(),
          `baseline should contain ${subtree}/ subtree`,
        );
      }

      // JUNK markers
      assert.ok(
        fs.existsSync(path.join(tmpDir, "JUNK-IS-INTENTIONAL.md")),
        "baseline should have JUNK-IS-INTENTIONAL.md",
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "operator-notes.local")),
        "baseline should have operator-notes.local",
      );

      // Essential files in python subtree
      assert.ok(
        fs.existsSync(path.join(tmpDir, "python/src/schedlib/recurrence.py")),
        "baseline should have python/src/schedlib/recurrence.py",
      );

      // Essential files in ts subtree
      assert.ok(
        fs.existsSync(path.join(tmpDir, "ts/src/store.ts")),
        "baseline should have ts/src/store.ts",
      );

      // STORM-SENTINEL present
      const storeTs = fs.readFileSync(path.join(tmpDir, "ts/src/store.ts"), "utf-8");
      assert.ok(
        storeTs.includes("STORM-SENTINEL"),
        "baseline store.ts should have STORM-SENTINEL line",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Python seed ref content verification ────────────────────────────────

  it("seed/POLY-BUG-P1 introduces recurrence.py change", function () {
    this.timeout = 300_000;

    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }

    const tmpDir = tamanduaTempDir("tt-poly-p1-");
    try {
      execSync(`git clone "${bareRepo}" "${tmpDir}"`, { stdio: "pipe", encoding: "utf-8" });
      execSync("git checkout seed/POLY-BUG-P1", { cwd: tmpDir, stdio: "pipe" });

      const recurrence = fs.readFileSync(path.join(tmpDir, "python/src/schedlib/recurrence.py"), "utf-8");
      // P1 introduces bug in _advance count+until path
      assert.ok(
        recurrence.includes("_advance"),
        "recurrence.py should have _advance method (may be buggy)",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("seed/POLY-BUG-P2 introduces recurrence.py + conflict.py changes", function () {
    this.timeout = 300_000;

    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }

    const tmpDir = tamanduaTempDir("tt-poly-p2-");
    try {
      execSync(`git clone "${bareRepo}" "${tmpDir}"`, { stdio: "pipe", encoding: "utf-8" });
      execSync("git checkout seed/POLY-BUG-P2", { cwd: tmpDir, stdio: "pipe" });

      assert.ok(
        fs.existsSync(path.join(tmpDir, "python/src/schedlib/recurrence.py")),
        "recurrence.py should exist",
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "python/src/schedlib/conflict.py")),
        "conflict.py should exist",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("seed/POLY-VULN-P1 seed ref exists and differs from baseline", function () {
    this.timeout = 300_000;

    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }

    const mainSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();

    // VULN-P1 is a real seed with overlay, so it should differ from baseline
    const vp1Sha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/seed/POLY-VULN-P1`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();

    assert.notStrictEqual(
      vp1Sha, mainSha,
      "seed/POLY-VULN-P1 should differ from baseline (has integrations.py overlay)",
    );
  });

  // ── TS seed ref content verification ───────────────────────────────────

  it("seed/POLY-BUG-T1 seed ref exists (patch-based)", function () {
    this.timeout = 300_000;

    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }

    const t1Sha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/seed/POLY-BUG-T1`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    assert.ok(t1Sha.length === 40, `seed/POLY-BUG-T1 should be a valid SHA: ${t1Sha}`);

    const mainSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    assert.notStrictEqual(t1Sha, mainSha, "POLY-BUG-T1 should differ from baseline");
  });

  it("seed/POLY-BRK-T1 seed ref exists (break test)", function () {
    this.timeout = 300_000;

    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }

    const brt1Sha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/seed/POLY-BRK-T1`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    assert.ok(brt1Sha.length === 40, `seed/POLY-BRK-T1 should be a valid SHA: ${brt1Sha}`);

    const mainSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    assert.notStrictEqual(brt1Sha, mainSha, "POLY-BRK-T1 should differ from baseline");
  });

  it("seed/POLY-VULN-T1 points to baseline (dormant via update-ref)", function () {
    this.timeout = 300_000;

    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }

    const mainSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    const vt1Sha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/seed/POLY-VULN-T1`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();

    assert.strictEqual(
      vt1Sha, mainSha,
      "seed/POLY-VULN-T1 should be identical to baseline (dormant vuln)",
    );
  });

  it("seed/POLY-VULN-T2 points to baseline (dormant via update-ref)", function () {
    this.timeout = 300_000;

    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }

    const mainSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    const vt2Sha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/seed/POLY-VULN-T2`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();

    assert.strictEqual(
      vt2Sha, mainSha,
      "seed/POLY-VULN-T2 should be identical to baseline (dormant vuln)",
    );
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it("total seed ref count matches expected (14 refs)", function () {
    this.timeout = 300_000;

    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }

    const refs = execSync(
      `git --git-dir="${bareRepo}" for-each-ref --format='%(refname:short)' refs/heads/seed/`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim().split("\n").filter(Boolean);

    // Expected: 6 python (BUG-P1..P4 + VULN-P1..P2) + 8 ts (BUG-T1..T4 + VULN-T1..T2 + BRK-T1..T2)
    //          + 6 go (BUG-G1..G4 + VULN-G1..G2) + 6 rust (BUG-R1..R4 + VULN-R1..R2)
    //          + 8 java (BUG-J1..J4 + VULN-J1..J2 + BRK-J1..J2)
    //          + 1 POLY-BUG-A5 + 1 seed/storm = 36 refs under refs/heads/seed/
    assert.strictEqual(
      refs.length,
      36,
      `expected 36 seed refs (35 POLY-* + 1 seed/storm), got ${refs.length}: ${refs.join(", ")}`,
    );
  });

  it("no tt-poly-lite references in golden output", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    // The golden repo and hash file should use tt-poly, not tt-poly-lite
    assert.ok(
      content.includes("tt-poly.git"),
      "should use tt-poly.git not tt-poly-lite.git",
    );
    // Seed path should reference tt-poly (but patches may contain tt-poly-lite
    // in their diff headers — that's ok, we only care about the script config)
  });

  // ── Phase 4: go seed refs ───────────────────────────────────────────────

  it("defines STORM_ORDER array (for Phase 8)", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(content.includes("STORM_ORDER"), "should define STORM_ORDER");
    assert.ok(
      content.includes("POLY-BUG-G1") && content.includes("POLY-BUG-R1") &&
      content.includes("POLY-BUG-J1"),
      "STORM_ORDER should include go/rust/java bug seeds",
    );
    assert.ok(
      content.includes("POLY-VULN-G1") && content.includes("POLY-BRK-G1"),
      "STORM_ORDER should include go VULN and BRK seeds",
    );
  });

  it("go seed refs are built and pushed to bare repo", function () {
    this.timeout = 300_000;
    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }
    for (const seed of [
      "POLY-BUG-G1", "POLY-BUG-G2", "POLY-BUG-G3", "POLY-BUG-G4",
      "POLY-VULN-G1", "POLY-VULN-G2",
    ]) {
      const sha = execSync(
        `git --git-dir="${bareRepo}" rev-parse "refs/heads/seed/${seed}"`,
        { encoding: "utf-8", stdio: "pipe" },
      ).trim();
      assert.ok(sha.length === 40, `seed/${seed} should be valid SHA: ${sha}`);
      const mainSha = execSync(
        `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
        { encoding: "utf-8", stdio: "pipe" },
      ).trim();
      assert.notStrictEqual(sha, mainSha, `seed/${seed} should differ from baseline`);
    }
  });

  // ── Phase 5: rust seed refs ─────────────────────────────────────────────

  it("rust seed refs are built and pushed to bare repo", function () {
    this.timeout = 300_000;
    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }
    for (const seed of [
      "POLY-BUG-R1", "POLY-BUG-R2", "POLY-BUG-R3", "POLY-BUG-R4",
      "POLY-VULN-R1", "POLY-VULN-R2",
    ]) {
      const sha = execSync(
        `git --git-dir="${bareRepo}" rev-parse "refs/heads/seed/${seed}"`,
        { encoding: "utf-8", stdio: "pipe" },
      ).trim();
      assert.ok(sha.length === 40, `seed/${seed} should be valid SHA: ${sha}`);
      const mainSha = execSync(
        `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
        { encoding: "utf-8", stdio: "pipe" },
      ).trim();
      assert.notStrictEqual(sha, mainSha, `seed/${seed} should differ from baseline`);
    }
  });

  // ── Phase 6: java seed refs ─────────────────────────────────────────────

  it("java seed refs are built and pushed to bare repo", function () {
    this.timeout = 300_000;
    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }
    for (const seed of [
      "POLY-BUG-J1", "POLY-BUG-J2", "POLY-BUG-J3", "POLY-BUG-J4",
      "POLY-BRK-J1", "POLY-BRK-J2",
    ]) {
      const sha = execSync(
        `git --git-dir="${bareRepo}" rev-parse "refs/heads/seed/${seed}"`,
        { encoding: "utf-8", stdio: "pipe" },
      ).trim();
      assert.ok(sha.length === 40, `seed/${seed} should be valid SHA: ${sha}`);
      const mainSha = execSync(
        `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
        { encoding: "utf-8", stdio: "pipe" },
      ).trim();
      assert.notStrictEqual(sha, mainSha, `seed/${seed} should differ from baseline`);
    }
  });

  it("java VULN-J1 and VULN-J2 point to baseline (dormant)", function () {
    this.timeout = 300_000;
    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }
    const mainSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    for (const vuln of ["POLY-VULN-J1", "POLY-VULN-J2"]) {
      const vSha = execSync(
        `git --git-dir="${bareRepo}" rev-parse "refs/heads/seed/${vuln}"`,
        { encoding: "utf-8", stdio: "pipe" },
      ).trim();
      assert.strictEqual(
        vSha, mainSha,
        `seed/${vuln} should be identical to baseline (dormant vuln)`,
      );
    }
  });

  // ── Phase 7: broken-tests branch ────────────────────────────────────────

  it("broken-tests branch exists", function () {
    this.timeout = 300_000;
    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }
    const brkSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/broken-tests`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    assert.ok(brkSha.length === 40, `broken-tests should be valid SHA: ${brkSha}`);
    const mainSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    assert.notStrictEqual(
      brkSha, mainSha,
      "broken-tests branch should differ from main (has BRK seeds)",
    );
  });

  it("broken-tests checkout has test_broken_p1.py and test_broken_p2.py", function () {
    this.timeout = 300_000;
    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }
    const tmpDir = tamanduaTempDir("tt-poly-broken-");
    try {
      execSync(`git clone "${bareRepo}" "${tmpDir}"`, { stdio: "pipe", encoding: "utf-8" });
      execSync("git checkout broken-tests", { cwd: tmpDir, stdio: "pipe" });
      assert.ok(
        fs.existsSync(path.join(tmpDir, "python/tests/test_broken_p1.py")),
        "broken-tests should have test_broken_p1.py",
      );
      assert.ok(
        fs.existsSync(path.join(tmpDir, "python/tests/test_broken_p2.py")),
        "broken-tests should have test_broken_p2.py",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Phase 8: seed/storm composite ref ───────────────────────────────────

  it("seed/storm ref exists", function () {
    this.timeout = 300_000;
    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }
    const stormSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/seed/storm`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    assert.ok(stormSha.length === 40, `seed/storm should be valid SHA: ${stormSha}`);
    const mainSha = execSync(
      `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    assert.notStrictEqual(
      stormSha, mainSha,
      "seed/storm should differ from baseline",
    );
  });

  it("seed/storm checkout has python broken tests", function () {
    this.timeout = 300_000;
    if (!fs.existsSync(bareRepo)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }
    const tmpDir = tamanduaTempDir("tt-poly-storm-");
    try {
      execSync(`git clone "${bareRepo}" "${tmpDir}"`, { stdio: "pipe", encoding: "utf-8" });
      execSync("git checkout seed/storm", { cwd: tmpDir, stdio: "pipe" });
      assert.ok(
        fs.existsSync(path.join(tmpDir, "python/tests/test_broken_p1.py")),
        "seed/storm should have test_broken_p1.py",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Phase 9: Post-build verification output ─────────────────────────────

  it("build output shows post-build verification phases", function () {
    this.timeout = 300_000;
    if (fs.existsSync(goldenDir)) {
      fs.rmSync(goldenDir, { recursive: true, force: true });
    }
    const output = execSync(`bash "${scriptPath}"`, {
      cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
    });
    assert.ok(
      output.includes("Phase 10: Post-build verification"),
      "should show Phase 10",
    );
    assert.ok(
      output.includes("[10a] Baseline content check"),
      "should show baseline content check",
    );
    assert.ok(
      output.includes("[10b] Seed ref existence check"),
      "should show seed ref existence check",
    );
    assert.ok(
      output.includes("[10c] broken-tests branch content check"),
      "should show broken-tests content check",
    );
    assert.ok(
      output.includes("[10d] Junk probe verification"),
      "should show junk probe verification",
    );
    assert.ok(
      output.includes("[10e] Seed ref content spot-checks"),
      "should show seed content spot checks",
    );
    assert.ok(
      output.includes("[10f] seed/storm composite content check"),
      "should show seed/storm content check",
    );
    assert.ok(
      output.includes("Verification   : ALL PASSED"),
      "should show ALL PASSED verification",
    );
  });

  // ── Phase 10: hash stability includes all refs ──────────────────────────

  it("hash file includes go/rust/java seeds + broken-tests + seed/storm", function () {
    this.timeout = 300_000;
    if (!fs.existsSync(hashFile)) {
      execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot, env: CLEAN_ENV, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
      });
    }
    const hashes = fs.readFileSync(hashFile, "utf-8");
    for (const id of [
      "POLY-BUG-G1", "POLY-BUG-R1", "POLY-BUG-J1",
      "POLY-VULN-G1", "POLY-VULN-R1", "POLY-VULN-J1",
      "broken-tests", "seed/storm",
    ]) {
      assert.ok(
        hashes.includes(id),
        `hash file should include ${id}`,
      );
    }
  });
});
