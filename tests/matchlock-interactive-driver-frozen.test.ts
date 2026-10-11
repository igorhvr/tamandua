/**
 * MTLK-INTERACTIVE-SUITE US-002 — the PTY driver is FROZEN.
 *
 * The proven Python PTY driver (`scripts/tests/matchlock/runner/pty-drive.py`,
 * v5.7) is ported into the repo byte-for-byte from the preserved reference
 * campaign sources. It is deliberately NOT ported to node and MUST NOT be
 * edited in-repo: this test pins its content hash so any drift is caught, and
 * asserts the file carries no machine-specific absolute paths (the reference
 * sources contain environment-specific paths that must never leak into the
 * suite).
 *
 * The behavioral guarantee lives in
 * `tests/matchlock-interactive-t1-driver.test.ts` (serial lane), which executes
 * the frozen driver's own self-test. This file is pure-filesystem reads
 * (node:crypto only, no child_process, no dist import, no VM, no model), so it
 * stays in the parallel lane and needs no tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const driverPath = path.join(repoRoot, "scripts", "tests", "matchlock", "runner", "pty-drive.py");
const selftestPath = path.join(
  repoRoot,
  "scripts",
  "tests",
  "matchlock",
  "runner",
  "pty-selftest.sh",
);

/** The frozen driver v5.7 content hash from the reference manifest. */
const FROZEN_DRIVER_SHA256 = "75667065ab885728365e985141345055fae2360d9978163479c4c1ad3f3a382d";

/** The frozen self-test content hash from the reference manifest. */
const FROZEN_SELFTEST_SHA256 = "2315ed7a50cd94260c427c0c86e3b15e779242f3585493c0bd0a0ea7decd80f8";

/**
 * Absolute-path prefixes that identify a specific machine/operator checkout.
 * `/usr/bin/env` (the shebang) is intentionally allowed; everything else is
 * machine-specific and must not appear in the frozen driver.
 */
const MACHINE_SPECIFIC_PATH = /(?:\/home\/|\/Users\/|\/root\/|\/opt\/|\/var\/|\/etc\/|\/tmp\/|matchlock-work|mtlk-suites-reference)/;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

describe("Matchlock interactive driver is frozen (MTLK-INTERACTIVE-SUITE US-002)", () => {
  it("ships the PTY driver at scripts/tests/matchlock/runner/pty-drive.py", () => {
    assert.ok(existsSync(driverPath), `frozen driver is missing at ${driverPath}`);
    assert.ok(statSync(driverPath).isFile(), "pty-drive.py must be a regular file");
  });

  it("pins the exact frozen driver sha256", () => {
    assert.equal(
      sha256(driverPath),
      FROZEN_DRIVER_SHA256,
      "pty-drive.py must be byte-for-byte the frozen v5.7 reference driver",
    );
  });

  it("ships the frozen driver self-test next to the driver", () => {
    assert.ok(existsSync(selftestPath), `frozen self-test is missing at ${selftestPath}`);
    assert.ok(statSync(selftestPath).isFile(), "pty-selftest.sh must be a regular file");
    assert.equal(
      sha256(selftestPath),
      FROZEN_SELFTEST_SHA256,
      "pty-selftest.sh must be byte-for-byte the frozen reference self-test",
    );
  });

  it("contains no machine-specific absolute paths", () => {
    const lines = readFileSync(driverPath, "utf-8").split(/\r?\n/);
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.startsWith("#!")) continue; // shebang: /usr/bin/env
      if (MACHINE_SPECIFIC_PATH.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `frozen driver must not embed machine-specific absolute paths:\n${offenders.join("\n")}`,
    );
  });
});
