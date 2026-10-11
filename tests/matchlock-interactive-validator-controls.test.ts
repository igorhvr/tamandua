/**
 * MTLK-INTERACTIVE-SUITE US-004 — tier-aware receipt validator + requested
 * manifest behavioral controls.
 *
 * `scripts/tests/matchlock/fixtures/fixtures-validator.sh` exercises the
 * fail-closed `validator/validate-receipts.sh` and the `lib/manifest.sh`
 * recording API with one complete synthetic receipt set (must validate OK) and
 * every decisive negative control (each must FAIL). This test runs that fixture
 * suite for real and asserts:
 *
 *   - the fixture process exits 0 with no `FIXTURE-FAIL` line and a final
 *     `VALIDATOR FIXTURES RESULT: pass=<n> fail=0`;
 *   - the positive receipt set reaches the exact `VALIDATION-OK <evdir>` line;
 *   - each decisive manifest/validator control reports `ok`;
 *   - a requested T4 is validated through the bound M7 verdict file.
 *
 * The fixture drives no VM and no model; it only writes synthetic evidence
 * files under a private temp directory.
 *
 * This file spawns `bash` (node:child_process) and is therefore classified in
 * the serial lane; it is registered exactly once in tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const suiteDir = path.join(repoRoot, "scripts", "tests", "matchlock");
const validatorPath = path.join(suiteDir, "validator", "validate-receipts.sh");
const manifestPath = path.join(suiteDir, "lib", "manifest.sh");
const fixturePath = path.join(suiteDir, "fixtures", "fixtures-validator.sh");

/** Single-quote a string for safe interpolation into a `bash -c` script. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The decisive controls the fixture must report as `ok`. Each is a control name
 * printed by the fixture; the matching assertion is inside the fixture script.
 */
const DECISIVE_CONTROLS = [
  // positives (receipt set validates OK)
  "positive verdict line",
  "positive-t4 verdict line",
  "unrequested t3 status UNEXECUTED",
  "stray M7 does not mark t4 passed",
  // manifest semantics
  "post-freeze request refused rc=2",
  "re-init refused rc=2",
  "M3 recorded UNEXECUTED",
  "unexecuted-required rc=1",
  "finalize marks pending required case FAIL",
  "finalize leaves unrequested t3 UNEXECUTED",
  // decisive negatives
  "missing-case rc=1",
  "failed-verdict rc=1",
  "unowned-vm rc=1",
  "m7-fail-line rc=1",
  "contradictory rc=1",
  "identity rc=1",
  "m7-verdict-file rc=1",
  "m7-binding rc=1",
  "halted rc=1",
  "missing-manifest rc=1",
  "phase-done rc=1",
  "missing-identity rc=1",
] as const;

describe("Matchlock interactive validator/manifest controls (MTLK-INTERACTIVE-SUITE US-004)", () => {
  it("ships the manifest library, the tier-aware validator and its fixture suite", () => {
    assert.ok(existsSync(manifestPath), `missing ${manifestPath}`);
    assert.ok(existsSync(validatorPath), `missing ${validatorPath}`);
    assert.ok(existsSync(fixturePath), `missing ${fixturePath}`);
  });

  it("passes every manifest/receipt-validator control with fail=0", () => {
    const tmp = tamanduaTempDir("mtlk-validator-controls-");
    try {
      const script = [
        `export MTLK_VALIDATOR_FIXTURE_DIR=${shQuote(tmp)}`,
        `exec bash ${shQuote(fixturePath)}`,
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(
        result.error,
        undefined,
        `failed to spawn the fixture: ${result.error?.message ?? "unknown"}`,
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      assert.equal(result.status, 0, `fixture suite failed (exit ${result.status}):\n${output}`);
      assert.ok(
        !output.includes("FIXTURE-FAIL"),
        `the fixture reported a failing control:\n${output}`,
      );

      const summary = output.match(/VALIDATOR FIXTURES RESULT: pass=(\d+) fail=0/);
      assert.ok(
        summary,
        `expected a 'VALIDATOR FIXTURES RESULT: pass=N fail=0' line:\n${output}`,
      );
      assert.ok(
        Number(summary[1]) >= 15,
        `expected at least 15 passing controls, got ${summary[1]}`,
      );

      assert.match(
        output,
        /^VALIDATION-OK /m,
        `the positive receipt set must reach VALIDATION-OK:\n${output}`,
      );

      for (const label of DECISIVE_CONTROLS) {
        assert.ok(
          output.includes(`ok   - ${label}`),
          `decisive control did not pass: ${label}\n${output}`,
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
