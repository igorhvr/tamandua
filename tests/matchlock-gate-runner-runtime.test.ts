/**
 * DSH-OVERLAY-FSYNC-FIX US-007 — the Matchlock VM gate runners resolve the
 * SYSTEM runtime from PATH, not a frozen accepted-hash pin.
 *
 * Why: on vaimetal the system matchlock (0.2.17 / `a3add95`) is the runtime the
 * run must be gated against, but the legacy gate runners hard-refused it
 * (`REFUSED-BY-LEGACY-HASH-PINS` in the #34 contract) before any VM booted.
 * US-007 removed the pins from the three gates this run requires:
 *
 *   - run-matchlock-synthetic-e2e-test
 *   - run-matchlock-dsh-profile-overlay-e2e-test
 *   - run-matchlock-dsh-real-boot-gate-e2e-test
 *
 * On the union port the MTLK-UNPIN work (US-005, tamandua-6sy.33.10.36)
 * extends the same treatment to the WHOLE gate family: every
 * `run-matchlock-*` driver resolves the system runtime from PATH and records
 * observed identity, so no driver hard-codes the retired pins. The
 * accepted-hash values survive only as a documented qualification record
 * (`docs/matchlock-dsh-qualification.md` section 3); see
 * `tests/matchlock-unpin.test.ts` for the full enumeration.
 *
 * Pure filesystem reads (no child_process, no dist import), so this file stays
 * in the parallel lane and needs no `tests/serial-files.txt` entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

/** The accepted paired-runtime pins (qualification record; not enforced here). */
const ACCEPTED_MATCHLOCK_SHA =
  "a278f9c153c91a76bcfca3abe2ff4146996e48ad4f3b36e47026e605e9232136";
const ACCEPTED_GUEST_INIT_SHA =
  "f76f00fbc089dea1f1e5eba536778da9bee9f20f547a6779f14b76a700d35c06";

/** The gate runners unpinned by DSH-OVERLAY-FSYNC-FIX US-007 / MTLK-UNPIN. */
const UNPINNED_RUNNERS = [
  "run-matchlock-synthetic-e2e-test",
  "run-matchlock-dsh-profile-overlay-e2e-test",
  "run-matchlock-dsh-gate-e2e-test",
] as const;

/** The runner that was already system-runtime based before US-007. */
const REAL_BOOT_RUNNER = "run-matchlock-dsh-real-boot-gate-e2e-test";

function readRunner(name: string): string {
  return readFileSync(resolve(repoRoot, name), "utf-8");
}

describe("US-007 matchlock gate runners resolve the system runtime (no pins)", () => {
  for (const name of UNPINNED_RUNNERS) {
    it(`${name} no longer hard-codes or enforces the accepted-hash pins`, () => {
      const content = readRunner(name);
      assert.ok(
        !content.includes(ACCEPTED_MATCHLOCK_SHA),
        `${name} must not hard-code the accepted matchlock sha`,
      );
      assert.ok(
        !content.includes(ACCEPTED_GUEST_INIT_SHA),
        `${name} must not hard-code the accepted guest-init sha`,
      );
      assert.ok(
        !content.includes("EXPECTED_MATCHLOCK"),
        `${name} must not compute an EXPECTED_MATCHLOCK pin`,
      );
      assert.ok(
        !content.includes("hash mismatch"),
        `${name} must not refuse the runtime on a hash mismatch`,
      );
    });

    it(`${name} resolves matchlock/guest-init from PATH (or an explicit env override)`, () => {
      const content = readRunner(name);
      assert.ok(
        content.includes("command -v matchlock"),
        `${name} must resolve the matchlock CLI from PATH`,
      );
      assert.ok(
        content.includes("command -v guest-init"),
        `${name} must resolve guest-init from PATH`,
      );
      for (const envName of [
        "TAMANDUA_MATCHLOCK_RPC_BIN",
        "MATCHLOCK_GUEST_INIT",
        "MATCHLOCK_GUEST_FUSED",
      ]) {
        assert.ok(
          content.includes(envName),
          `${name} must still honour the ${envName} override`,
        );
      }
    });
  }

  it(`${REAL_BOOT_RUNNER} stays system-runtime based with no pins`, () => {
    const content = readRunner(REAL_BOOT_RUNNER);
    assert.ok(!content.includes(ACCEPTED_MATCHLOCK_SHA));
    assert.ok(!content.includes(ACCEPTED_GUEST_INIT_SHA));
    assert.ok(!content.includes("hash mismatch"));
    assert.ok(content.includes("/usr/local/bin/matchlock"));
  });

  it(`${REAL_BOOT_RUNNER} forces node --test to exit once the tests settle`, () => {
    const content = readRunner(REAL_BOOT_RUNNER);
    assert.ok(
      content.includes("node --test --test-force-exit"),
      "the real-boot runner must use --test-force-exit (the test file leaves a " +
        "dormant libuv handle behind; plain `node --test` waits for the 8-minute " +
        "service timeout after a green result)",
    );
  });

  it("no matchlock gate runner carries the retired accepted-hash pins", () => {
    // Union port MTLK-UNPIN: the whole gate family is system-runtime based;
    // the retired pins must not reappear in any driver. The UNPIN residue
    // follow-up enrolled the four merge-worktree drivers, so all thirteen
    // `run-matchlock-*` drivers are covered here.
    const drivers = [
      "run-matchlock-synthetic-e2e-test",
      "run-matchlock-dsh-gate-e2e-test",
      "run-matchlock-dsh-profile-overlay-e2e-test",
      "run-matchlock-dsh-real-boot-gate-e2e-test",
      "run-matchlock-dsh-real-gate-e2e-test",
      "run-matchlock-worktree-merge-e2e-test",
      "run-matchlock-long-home-e2e-test",
      "run-matchlock-empty-output-e2e-test",
      "run-hermes-synthetic-e2e-test",
      "run-matchlock-dsh-merge-worktree-e2e-test",
      "run-matchlock-dsh-merge-worktree-canary-e2e-test",
      "run-matchlock-hermes-merge-worktree-e2e-test",
      "run-matchlock-hermes-merge-worktree-canary-e2e-test",
    ] as const;
    for (const name of drivers) {
      const content = readRunner(name);
      assert.ok(
        !content.includes(ACCEPTED_MATCHLOCK_SHA),
        `${name} must not hard-code the retired accepted matchlock sha`,
      );
      assert.ok(
        !content.includes(ACCEPTED_GUEST_INIT_SHA),
        `${name} must not hard-code the retired accepted guest-init sha`,
      );
      assert.ok(
        !content.includes("hash mismatch"),
        `${name} must not refuse the runtime on a hash mismatch`,
      );
    }
  });
});
