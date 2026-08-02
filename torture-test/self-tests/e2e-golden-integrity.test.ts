import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before } from "node:test";

// US-006: End-to-end verification — golden dir integrity + validate-all behavior
//
// Verifies that self-tests are hermetic (no longer destroy shared golden state)
// and that validate-all.sh correctly exits non-zero on vacuous all-skipped runs.
//
// This test file is NOT picked up by run.sh (name doesn't match tt-poly-* or
// scripted-runtime-*) to avoid infinite recursion when calling run.sh internally.

const repoRoot = process.cwd();

// Strip NODE_TEST_CONTEXT/TAMANDUA_TEST_GUARD from child process env
const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT" || k === "TAMANDUA_TEST_GUARD") continue;
    env[k] = v;
  }
  return env;
})();

function execOpts(
  overrides: Partial<Parameters<typeof execSync>[1]> = {},
): Parameters<typeof execSync>[1] {
  return { env: CLEAN_ENV, ...overrides } as Parameters<typeof execSync>[1];
}

const goldenDir = path.join(repoRoot, "torture-test", "var", "fixtures", "golden");
const runShPath = path.join(repoRoot, "torture-test", "self-tests", "run.sh");
const validateAllPath = path.join(repoRoot, "torture-test", "probes", "validate-all.sh");

// Compute a stable snapshot of the golden dir (sha256sum of every file, sorted).
// This ignores mtimes and focuses on content integrity.
function snapshotGoldenDir(): string {
  return execSync(
    `find "${goldenDir}" -type f -exec sha256sum {} \\; | sort`,
    { encoding: "utf-8", stdio: "pipe" },
  );
}

describe("US-006: golden dir integrity + validate-all verification", () => {
  let preSnapshot: string;

  // ── BEFORE: snapshot golden dir ───────────────────────────────────────
  before(function () {
    assert.ok(fs.existsSync(goldenDir), `golden dir must exist: ${goldenDir}`);
    preSnapshot = snapshotGoldenDir();
  });

  // ── AC 1: run.sh passes twice consecutively ───────────────────────────
  it("AC1: run.sh passes twice consecutively", function () {
    this.timeout = 600_000; // 10 min for two full runs

    const output1 = execSync(`bash "${runShPath}"`, {
      cwd: repoRoot,
      env: CLEAN_ENV,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 300_000,
    });

    assert.match(
      output1,
      /Results: \d+ passed, 0 failed/,
      `First run.sh must have all passing tests:\n${output1.slice(-500)}`,
    );

    const output2 = execSync(`bash "${runShPath}"`, {
      cwd: repoRoot,
      env: CLEAN_ENV,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 300_000,
    });

    assert.match(
      output2,
      /Results: \d+ passed, 0 failed/,
      `Second run.sh must have all passing tests:\n${output2.slice(-500)}`,
    );
  });

  // ── AC 2: golden dir byte-identical after both run.sh invocations ─────
  it("AC2: golden dir is byte-identical after both run.sh invocations", function () {
    const postSnapshot = snapshotGoldenDir();

    // Report what golden bares exist
    const bares = fs
      .readdirSync(goldenDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith(".git"))
      .map((d) => d.name)
      .sort();
    const bareList = bares.join(", ");

    assert.strictEqual(
      postSnapshot,
      preSnapshot,
      `golden dir must be byte-identical after run.sh.\n`
        + `Golden bares present: ${bareList}\n`
        + `Pre-line-count: ${preSnapshot.split("\n").length}\n`
        + `Post-line-count: ${postSnapshot.split("\n").length}`,
    );
  });

  // ── AC 3: validate-all.sh against empty golden dir exits 2 ────────────
  it("AC3: validate-all.sh against empty golden dir exits 2", function () {
    const emptyDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "e2e-empty-golden-"),
    );

    try {
      let rc = 0;
      let output = "";
      try {
        output = execSync(`bash "${validateAllPath}" --golden-dir "${emptyDir}"`, {
          cwd: repoRoot,
          env: CLEAN_ENV,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 30_000,
        });
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        rc = err.status ?? 1;
        output = (err.stdout ?? "") + (err.stderr ?? "");
      }

      assert.strictEqual(
        rc,
        2,
        `validate-all.sh against empty dir must exit 2, got ${rc}.\nOutput: ${output.slice(-500)}`,
      );

      assert.match(
        output,
        /INFRASTRUCTURE ERROR|All probes were skipped|golden bares may not exist/,
        `must report infrastructure error for all-skipped:\n${output.slice(-500)}`,
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // ── AC 4: validate-all.sh --self-test exits 0 ────────────────────────
  it("AC4: validate-all.sh --self-test exits 0 with all tests green", function () {
    const output = execSync(`bash "${validateAllPath}" --self-test`, {
      cwd: repoRoot,
      env: CLEAN_ENV,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 60_000,
    });

    assert.match(
      output,
      /Self-tests:/,
      `--self-test output must contain results header:\n${output.slice(-500)}`,
    );

    assert.match(
      output,
      /Passed: \d+\s+Failed: 0/,
      `--self-test must have zero failures:\n${output.slice(-500)}`,
    );

    assert.match(
      output,
      /Failed: 0/,
      `--self-test must report Failed: 0:\n${output.slice(-500)}`,
    );
  });
});
