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

// Heavy campaign self-tests that are intentionally NOT part of run.sh. They
// drive full scripted-daemon / real-flag campaigns that legitimately exceed 60+
// minutes of ACTIVE progress on a contended machine (see run.sh for the full
// ordering rationale). run.sh must complete in a bounded window regardless of
// machine load and can never orphan a campaign on timeout, so these ten are
// excluded there and executed INDIVIDUALLY (each as its own `node --test`
// process under its own ceiling, no aggregate deadline) by
// bin/verify-heavy-campaign-tests.test.sh — the exact
// verify-builder-determinism.test.sh pattern. All EIGHT fixtures' golden bares
// are rebuilt hermetically inside tier1-e24-all-fixture-provision, which stays
// in run.sh (bounded). This list MUST stay in lock-step with run.sh's
// HEAVY_CAMPAIGN_TESTS and bin/verify-heavy-campaign-tests.test.sh; AC5 pins it.
const HEAVY_CAMPAIGN_TESTS = [
  "scripted-scenario-harness.test.ts",
  "tier0-repeatability.test.ts",
  "tier1-case-filter.test.ts",
  // MACP3 US-009: the bare-vacuity red-then-green proof drives a REAL bare
  // tier1 control campaign (scripted daemon) — same campaign class as the
  // other heavy proofs; must stay in lock-step with run.sh + the verify
  // script (AC5 pins the invariant).
  "tier1-bare-vacuity-red-green.test.ts",
  "tier1-e26-real-launch-proof.test.ts",
  "tier1-include-real-proof.test.ts",
  "tier1-real-case-proof.test.ts",
  "tier1-repeatability.test.ts",
  "tier1-scripted-probe-battery.test.ts",
  "tier1-kill-sentinel-survival.test.ts",
  "tier1-zero-real-launch-infra.test.ts",
  // MACP7 US-006: stale-state hygiene red-then-green proof (RED arm with the
  // reset bypassed + GREEN arm + pre-polluted campaign) — same campaign class
  // as the other heavy proofs; must stay in lock-step with run.sh + the
  // verify script (AC5 pins the invariant).
  "tier1-macp7-scripted-state-hygiene.test.ts",
  // MACP4 US-007: W2 dual-path proof (4 cells x systemd + forced-fallback
  // harness executions + two bare tier1 campaigns) — same campaign class as
  // the other heavy proofs; must stay in lock-step with run.sh + the verify
  // script (AC5 pins the invariant).
  "tier1-w2-darwin-capable-proof.test.ts",
  "tier2-repeatability.test.ts",
  "tier2-scripted-behaviors-materialization.test.ts",
  // US-002 (S29): fired-trigger corridor — must stay in lock-step with run.sh
  // + verify-heavy-campaign-tests.test.sh.
  "tier2-s29-fired-trigger-corridor.test.ts",
  // US-004 (S29): premise-redesign corridor — must stay in lock-step with
  // run.sh + verify-heavy-campaign-tests.test.sh.
  "tier2-s29-premise-redesign-corridor.test.ts",
];
const heavyCampaignScriptPath = path.join(
  repoRoot,
  "torture-test",
  "bin",
  "verify-heavy-campaign-tests.test.sh",
);

// run.sh is now the BOUNDED battery (the unbounded campaign tests live in the
// isolated invoke above). A single bounded run.sh finishes far faster than the
// old multi-hour aggregate; these ceilings are generous safety bounds, not
// expected durations. Per-run 1h; AC1 total covers TWO runs + harness overhead.
const RUN_SH_PER_RUN_TIMEOUT_MS = 3_600_000; // 1h per run.sh invocation
const AC1_TOTAL_BUDGET_MS = 10_800_000; // 3h (two 1h runs + overhead)

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
    // run.sh is the BOUNDED battery: the eight unbounded campaign tests
    // (tier0-repeatability, tier1-repeatability, tier1-real-case-proof,
    // tier1-e26-real-launch-proof, tier1-include-real-proof,
    // tier1-zero-real-launch-infra, tier1-case-filter,
    // scripted-scenario-harness) are excluded from run.sh and run individually by
    // bin/verify-heavy-campaign-tests.test.sh, so a single bounded run.sh
    // completes well within the per-run ceiling and cannot orphan a campaign on
    // timeout (the E2.4 verifier's option (b) — robust, contention-independent).
    // These ceilings are generous safety bounds, not expected durations.
    this.timeout = AC1_TOTAL_BUDGET_MS; // 3h for two bounded runs + overhead

    const output1 = execSync(`bash "${runShPath}"`, {
      cwd: repoRoot,
      env: CLEAN_ENV,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: RUN_SH_PER_RUN_TIMEOUT_MS, // 2h per run
      maxBuffer: 512 * 1024 * 1024,
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
      timeout: RUN_SH_PER_RUN_TIMEOUT_MS, // 2h per run
      maxBuffer: 512 * 1024 * 1024,
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

  // ── AC 5: heavy campaign tests are excluded from run.sh and isolated ──
  it("AC5: heavy campaign tests are excluded from run.sh and isolated-invoked", function () {
    // Harness-closure invariant (US-006): the unbounded campaign self-tests
    // CANNOT live in run.sh (run.sh must complete in a bounded window and never
    // orphan a campaign on timeout) and MUST be covered by the isolated
    // invocation script. This guard runs in milliseconds (no heavy execution)
    // and trips loudly if anyone re-adds a heavy test to the bounded battery
    // without excluding it, or drops it from the isolated invocation.
    const selfDir = path.join(repoRoot, "torture-test", "self-tests");
    const runSh = fs.readFileSync(runShPath, "utf-8");
    assert.ok(
      fs.existsSync(heavyCampaignScriptPath),
      `isolated invocation script must exist: ${heavyCampaignScriptPath}`,
    );
    const heavyScript = fs.readFileSync(heavyCampaignScriptPath, "utf-8");

    for (const base of HEAVY_CAMPAIGN_TESTS) {
      // 1. every heavy test file exists on disk.
      assert.ok(
        fs.existsSync(path.join(selfDir, base)),
        `heavy campaign test must exist: ${base}`,
      );
      // 2. run.sh declares it in HEAVY_CAMPAIGN_TESTS (explicitly excluded from
      //    the bounded battery) — removing the exclusion re-opens the unbounded
      //    closure and fails this guard.
      assert.match(
        runSh,
        new RegExp(`'${base.replace(/\./g, "\\.")}'`),
        `run.sh must list ${base} in HEAVY_CAMPAIGN_TESTS (excluded from the bounded battery)`,
      );
      // 3. the isolated invocation script executes it as its own process.
      assert.match(
        heavyScript,
        new RegExp(`'${base.replace(/\./g, "\\.")}'`),
        `verify-heavy-campaign-tests.test.sh must invoke ${base} individually`,
      );
    }

    // The exclusion filter must actually be plumbed through run.sh's loops (not
    // just declared dead code), otherwise a heavy test could still run in the
    // bounded battery.
    assert.match(runSh, /is_heavy "\$base"/, "run.sh must filter heavy tests in its test loops");
  });
});