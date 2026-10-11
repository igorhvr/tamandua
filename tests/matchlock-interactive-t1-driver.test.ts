/**
 * MTLK-INTERACTIVE-SUITE US-002 — T1 behavioral check of the frozen PTY driver.
 *
 * Runs the frozen driver's own self-test
 * (`scripts/tests/matchlock/runner/pty-selftest.sh`), which drives fixture
 * processes only — no VM, no model, no network — and asserts the driver's
 * reject-before-trusting controls hold. The self-test resolves `pty-drive.py`
 * relative to its own directory, so the suite can be checked out anywhere.
 *
 * This file spawns `bash` (node:child_process) and is therefore classified in
 * the serial lane; it is registered exactly once in tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const selftestPath = path.join(
  repoRoot,
  "scripts",
  "tests",
  "matchlock",
  "runner",
  "pty-selftest.sh",
);

/** The frozen driver content hash the self-test must self-report. */
const FROZEN_DRIVER_SHA256 = "75667065ab885728365e985141345055fae2360d9978163479c4c1ad3f3a382d";

/** The self-test needs a generous ceiling: it intentionally exercises multi-second sleeps. */
const SELFTEST_TIMEOUT_MS = 300_000;

describe("Matchlock interactive T1 driver self-test (MTLK-INTERACTIVE-SUITE US-002)", () => {
  it("runs the frozen self-test green with the frozen driver hash", () => {
    assert.ok(existsSync(selftestPath), `frozen self-test is missing at ${selftestPath}`);

    const result = spawnSync("bash", [selftestPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: SELFTEST_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.equal(
      result.error,
      undefined,
      `failed to spawn the frozen self-test: ${result.error?.message ?? "unknown error"}`,
    );
    assert.equal(
      result.status,
      0,
      `frozen self-test must exit 0; got ${result.status}\n--- output ---\n${output}`,
    );

    const summary = output.match(/PTY-SELFTEST-SUMMARY pass=(\d+) fail=(\d+)/);
    assert.ok(summary, `self-test output must contain a PTY-SELFTEST-SUMMARY line\n${output}`);
    assert.equal(Number(summary![2]), 0, `self-test must report fail=0\n${output}`);
    assert.ok(
      Number(summary![1]) >= 22,
      `self-test must report pass>=22; got ${summary![1]}\n${output}`,
    );

    assert.match(
      output,
      new RegExp(`PTY-SELFTEST-SHA ${FROZEN_DRIVER_SHA256}`),
      `self-test must report the frozen driver sha ${FROZEN_DRIVER_SHA256}\n${output}`,
    );

    assert.ok(
      !output.includes("SELFTEST-BAD"),
      `self-test must have no SELFTEST-BAD lines\n${output}`,
    );
  });
});
