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

describe("tt-poly-lite build-golden.sh", () => {
  const scriptPath = path.join(
    repoRoot,
    "torture-test",
    "fixtures-src",
    "tt-poly-lite",
    "build-golden.sh",
  );
  const goldenDir = path.join(
    repoRoot,
    "torture-test",
    "var",
    "fixtures",
    "golden",
  );
  const bareRepo = path.join(goldenDir, "tt-poly-lite.git");
  const hashFile = path.join(goldenDir, "tt-poly-lite.git.hashes");

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

  it("defines hash file path as tt-poly-lite.git.hashes", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("tt-poly-lite.git.hashes"),
      "hash file should be named tt-poly-lite.git.hashes",
    );
  });

  it("has seed order lists for both python and ts seeds", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (const id of ["POLY-BUG-P1", "POLY-BUG-P2", "POLY-BUG-P3", "POLY-BUG-P4",
                       "POLY-VULN-P1", "POLY-VULN-P2"]) {
      assert.ok(content.includes(id), `should reference ${id}`);
    }
    for (const id of ["POLY-BUG-T1", "POLY-BUG-T2", "POLY-BUG-T3", "POLY-BUG-T4",
                       "POLY-VULN-T1", "POLY-VULN-T2", "POLY-BRK-T1", "POLY-BRK-T2"]) {
      assert.ok(content.includes(id), `should reference ${id}`);
    }
  });

  it("has storm composition order with combined T1+T4 patch", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("POLY-BUG-T1-T4-combined.patch"),
      "should reference combined T1+T4 patch for storm",
    );
  });

  it("has all 8 phases documented", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    for (let i = 1; i <= 8; i++) {
      assert.ok(
        content.includes(`Phase ${i}`),
        `should have Phase ${i}`,
      );
    }
  });

  it("has cleanup trap for scratch directories", () => {
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("trap cleanup EXIT"),
      "should have cleanup trap",
    );
  });
});

// Integration tests — only run when TT_POLY_LITE_INTEGRATION=1 is set
describe("tt-poly-lite build-golden.sh integration", { skip: process.env.TT_POLY_LITE_INTEGRATION !== "1" }, () => {
  const scriptPath = path.join(
    repoRoot,
    "torture-test",
    "fixtures-src",
    "tt-poly-lite",
    "build-golden.sh",
  );
  const goldenDir = path.join(
    repoRoot,
    "torture-test",
    "var",
    "fixtures",
    "golden",
  );
  const bareRepo = path.join(goldenDir, "tt-poly-lite.git");
  const hashFile = path.join(goldenDir, "tt-poly-lite.git.hashes");

  it("creates golden bare repo with all seed refs", function () {
    this.timeout = 600_000;

    if (fs.existsSync(bareRepo)) {
      fs.rmSync(bareRepo, { recursive: true, force: true });
    }
    if (fs.existsSync(hashFile)) {
      fs.rmSync(hashFile, { force: true });
    }

    execSync(`bash "${scriptPath}"`, execOpts({ cwd: repoRoot, stdio: "pipe", timeout: 600_000 }));

    assert.ok(fs.existsSync(bareRepo), "golden bare repo should exist");

    const refs = execSync("git show-ref", execOpts({ cwd: bareRepo, stdio: "pipe", encoding: "utf-8" }));

    const expectedRefs = [
      "refs/heads/main",
      "refs/heads/broken-tests",
      "refs/heads/seed/storm",
      "refs/heads/seed/POLY-BUG-P1",
      "refs/heads/seed/POLY-BUG-P2",
      "refs/heads/seed/POLY-BUG-P3",
      "refs/heads/seed/POLY-BUG-P4",
      "refs/heads/seed/POLY-VULN-P1",
      "refs/heads/seed/POLY-VULN-P2",
      "refs/heads/seed/POLY-BUG-T1",
      "refs/heads/seed/POLY-BUG-T2",
      "refs/heads/seed/POLY-BUG-T3",
      "refs/heads/seed/POLY-BUG-T4",
      "refs/heads/seed/POLY-VULN-T1",
      "refs/heads/seed/POLY-VULN-T2",
    ];

    for (const ref of expectedRefs) {
      assert.ok(refs.includes(ref), `Expected ref ${ref} not found`);
    }
  });

  it("hash stability — two consecutive builds produce identical hashes", function () {
    this.timeout = 600_000;

    if (fs.existsSync(hashFile)) {
      fs.rmSync(hashFile, { force: true });
    }
    if (fs.existsSync(bareRepo)) {
      fs.rmSync(bareRepo, { recursive: true, force: true });
    }

    execSync(`bash "${scriptPath}"`, execOpts({ cwd: repoRoot, stdio: "pipe", timeout: 600_000 }));

    const firstHashes = fs.readFileSync(hashFile, "utf-8");

    const secondOutput = execSync(`bash "${scriptPath}"`, execOpts({
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 600_000,
    }));

    assert.ok(
      secondOutput.includes("Hash stability: IDENTICAL"),
      "Second build should report hash stability as IDENTICAL",
    );

    const secondHashes = fs.readFileSync(hashFile, "utf-8");
    assert.equal(
      firstHashes,
      secondHashes,
      "Two consecutive builds must produce identical hash files",
    );
  });
});

// End-to-end validation tests — run when TT_POLY_LITE_INTEGRATION=1
describe("tt-poly-lite end-to-end validation", { skip: process.env.TT_POLY_LITE_INTEGRATION !== "1" }, () => {
  const scriptPath = path.join(
    repoRoot,
    "torture-test",
    "fixtures-src",
    "tt-poly-lite",
    "build-golden.sh",
  );
  const goldenDir = path.join(
    repoRoot,
    "torture-test",
    "var",
    "fixtures",
    "golden",
  );
  const bareRepo = path.join(goldenDir, "tt-poly-lite.git");
  const hashFile = path.join(goldenDir, "tt-poly-lite.git.hashes");
  const fixtureSrc = path.join(
    repoRoot,
    "torture-test",
    "fixtures-src",
    "tt-poly-lite",
  );

  let goldenReady = false;
  function ensureGolden(): void {
    if (goldenReady) return;
    if (!fs.existsSync(bareRepo) || !fs.existsSync(hashFile)) {
      if (fs.existsSync(hashFile)) fs.rmSync(hashFile, { force: true });
      if (fs.existsSync(bareRepo)) fs.rmSync(bareRepo, { recursive: true, force: true });
      execSync(`bash "${scriptPath}"`, execOpts({ cwd: repoRoot, stdio: "pipe", timeout: 600_000 }));
    }
    goldenReady = true;
  }

  function scratchClone(): string {
    const dir = tamanduaTempDir("tt-poly-lite-e2e-");
    execSync(`git clone "${bareRepo}" "${dir}"`, { stdio: "pipe" });
    return dir;
  }

  // AC 1–2: Scratch clone baseline green + timing
  it("AC-1: scratch clone baseline is green (./run-all-tests exits 0)", function () {
    this.timeout = 600_000;
    ensureGolden();
    const scratch = scratchClone();
    try {
      execSync("./run-all-tests", execOpts({ cwd: scratch, stdio: "pipe", timeout: 600_000 }));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("AC-2: scratch clone ./run-all-tests completes in under 4 minutes", function () {
    this.timeout = 600_000;
    ensureGolden();
    const scratch = scratchClone();
    try {
      const start = performance.now();
      execSync("./run-all-tests", execOpts({ cwd: scratch, stdio: "pipe", timeout: 600_000 }));
      const elapsed = (performance.now() - start) / 1000;
      assert.ok(elapsed < 240, `run-all-tests took ${elapsed.toFixed(1)}s — must be < 240s`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  // AC 3: Python BUG seed refs
  it("AC-3: python POLY-BUG seed refs — dormant or documented symptom", function () {
    this.timeout = 600_000;
    ensureGolden();

    const pyBugSeeds: Array<{ id: string; expectDormant: boolean }> = [
      { id: "POLY-BUG-P1", expectDormant: true },
      { id: "POLY-BUG-P2", expectDormant: false },
      { id: "POLY-BUG-P3", expectDormant: false },
      { id: "POLY-BUG-P4", expectDormant: false },
    ];

    for (const { id, expectDormant } of pyBugSeeds) {
      const scratch = scratchClone();
      try {
        execSync(`git checkout "seed/${id}"`, { cwd: scratch, stdio: "pipe" });
        execSync("bash python/bootstrap", { cwd: scratch, stdio: "pipe" });

        let result: string;
        try {
          result = execSync(".venv/bin/python -m pytest -q --tb=short", {
            cwd: path.join(scratch, "python"),
            stdio: "pipe",
            encoding: "utf-8",
          });
        } catch (e: unknown) {
          const err = e as { stdout?: string; status?: number };
          if (err.stdout) result = err.stdout;
          else throw e;
        }

        if (expectDormant) {
          assert.ok(!result!.includes("failed"),
            `${id}: expected dormant (green), but got failures`);
        } else {
          assert.ok(result!.includes("failed"),
            `${id}: expected documented symptom (failures), but suite is green`);
        }

        const fixPath = path.join(fixtureSrc, "python", "seeds", id, "fix.patch");
        if (fs.existsSync(fixPath)) {
          execSync(`patch -p1 -s --batch < "${fixPath}"`, { cwd: path.join(scratch, "python"), stdio: "pipe" });
          const fixResult = execSync(".venv/bin/python -m pytest -q --tb=short", {
            cwd: path.join(scratch, "python"),
            stdio: "pipe",
            encoding: "utf-8",
          });
          assert.ok(!fixResult.includes("failed"),
            `${id}: fix patch should restore green, but got failures`);
        }
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  // AC 4: TS BUG seed refs — dormant green
  it("AC-4: TS BUG seed refs — dormant (green)", function () {
    this.timeout = 600_000;
    ensureGolden();

    for (const id of ["POLY-BUG-T1", "POLY-BUG-T2", "POLY-BUG-T3", "POLY-BUG-T4"]) {
      const scratch = scratchClone();
      try {
        execSync(`git checkout "seed/${id}"`, { cwd: scratch, stdio: "pipe" });
        execSync("npm install", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe" }));
        execSync("npm test", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe", timeout: 60_000 }));

        const fixPath = path.join(fixtureSrc, "ts", "seeds", "fix", `${id}-fix.patch`);
        execSync(`git apply -p4 "${fixPath}"`, { cwd: scratch, stdio: "pipe" });
        execSync("npm test", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe", timeout: 60_000 }));
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  // AC 5: TS BRK seed refs — red
  it("AC-5: TS BRK seed refs — red (expected deterministic failures)", function () {
    this.timeout = 600_000;
    ensureGolden();

    for (const id of ["POLY-BRK-T1", "POLY-BRK-T2"]) {
      const scratch = scratchClone();
      try {
        execSync(`git checkout "seed/${id}"`, { cwd: scratch, stdio: "pipe" });
        execSync("npm install", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe" }));

        assert.throws(
          () => execSync("npm test", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe", timeout: 60_000 })),
          `${id}: expected test failure, but npm test passed`,
        );

        const fixPath = path.join(fixtureSrc, "ts", "seeds", "fix", `${id}-fix.patch`);
        execSync(`git apply -p4 "${fixPath}"`, { cwd: scratch, stdio: "pipe" });
        execSync("npm test", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe", timeout: 60_000 }));
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  // NOTE: Python BRK seeds (POLY-BRK-P1, POLY-BRK-P2) do NOT have individual
  // seed/ refs in the golden repo — they only exist on the broken-tests branch
  // and in the seed/storm composite. Their symptoms are verified via AC-7 and AC-8.

  // AC 7: seed/storm composite
  it("AC-7: seed/storm checkout shows all documented symptoms", function () {
    this.timeout = 600_000;
    ensureGolden();
    const scratch = scratchClone();
    try {
      execSync("git checkout seed/storm", { cwd: scratch, stdio: "pipe" });

      execSync("bash python/bootstrap", { cwd: scratch, stdio: "pipe" });
      let pyResult: string;
      try {
        pyResult = execSync(".venv/bin/python -m pytest -q --tb=line", {
          cwd: path.join(scratch, "python"), stdio: "pipe", encoding: "utf-8",
        });
      } catch (e: unknown) {
        const err = e as { stdout?: string; status?: number };
        if (err.stdout) pyResult = err.stdout;
        else throw e;
      }
      assert.ok(pyResult!.includes("failed"),
        "seed/storm: python suite should have failures (BUG + BRK symptoms)");

      execSync("npm install", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe" }));
      assert.throws(
        () => execSync("npm test", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe", timeout: 60_000 })),
        "seed/storm: ts suite should fail (BRK-T1 + BRK-T2 symptoms)",
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  // AC 8: broken-tests branch red
  it("AC-8: broken-tests branch is red (both python and ts fail)", function () {
    this.timeout = 600_000;
    ensureGolden();
    const scratch = scratchClone();
    try {
      execSync("git checkout broken-tests", { cwd: scratch, stdio: "pipe" });

      execSync("bash python/bootstrap", { cwd: scratch, stdio: "pipe" });
      let pyResult: string;
      try {
        pyResult = execSync(".venv/bin/python -m pytest -q --tb=short", {
          cwd: path.join(scratch, "python"), stdio: "pipe", encoding: "utf-8",
        });
      } catch (e: unknown) {
        const err = e as { stdout?: string; status?: number };
        if (err.stdout) pyResult = err.stdout;
        else throw e;
      }
      assert.ok(pyResult!.includes("failed"),
        "broken-tests: python suite should have BRK failures");

      execSync("npm install", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe" }));
      assert.throws(
        () => execSync("npm test", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe", timeout: 60_000 })),
        "broken-tests: ts suite should fail",
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  // AC 9: Junk probes verified
  it("AC-9: junk probes verified — untracked files present, operator-notes.local byte-identical", function () {
    this.timeout = 600_000;
    ensureGolden();
    const scratch = scratchClone();
    try {
      execSync("bash python/bootstrap", { cwd: scratch, stdio: "pipe" });
      execSync("npm install", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe" }));

      try {
        execSync(".venv/bin/python -m pytest -q", { cwd: path.join(scratch, "python"), stdio: "pipe" });
      } catch { /* may fail — we just need cache dirs */ }

      try {
        execSync("npm test", execOpts({ cwd: path.join(scratch, "ts"), stdio: "pipe", timeout: 60_000 }));
      } catch { /* may fail — we just need generated junk */ }

      for (const junk of ["python/__pycache__", "python/.pytest_cache"]) {
        if (fs.existsSync(path.join(scratch, junk))) {
          const status = execSync(`git status --porcelain "${junk}"`, { cwd: scratch, stdio: "pipe", encoding: "utf-8" });
          assert.ok(status === "" || status.startsWith("?"),
            `${junk}: should be untracked, got: "${status.trim()}"`);
        }
      }

      if (fs.existsSync(path.join(scratch, "ts", "package-lock.json"))) {
        const s = execSync("git status --porcelain ts/package-lock.json", { cwd: scratch, stdio: "pipe", encoding: "utf-8" });
        assert.ok(s === "" || s.startsWith("?"), "ts/package-lock.json: should be untracked");
      }

      const fixtureNotes = fs.readFileSync(path.join(fixtureSrc, "operator-notes.local"), "utf-8");
      const scratchNotes = fs.readFileSync(path.join(scratch, "operator-notes.local"), "utf-8");
      assert.equal(fixtureNotes, scratchNotes, "operator-notes.local must be byte-identical to fixture source");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
