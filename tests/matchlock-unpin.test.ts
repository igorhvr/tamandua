/**
 * MTLK-UNPIN regression (US-005 / bead tamandua-6sy.33.10.36).
 *
 * The Matchlock real-VM gate drivers must NOT pin a runtime sha256. They
 * resolve `matchlock` from PATH (with TAMANDUA_MATCHLOCK_RPC_BIN /
 * MATCHLOCK_GUEST_INIT / MATCHLOCK_GUEST_FUSED as OPTIONAL overrides), let
 * matchlock resolve its own guest-init when unset, and record the observed
 * `matchlock --version` + sha256 hashes as evidence instead of refusing on a
 * mismatch.
 *
 * Pure filesystem reads (no child_process, no VM, no network), so this file
 * stays in the parallel lane and needs no tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

const GATE_DRIVERS = [
  "run-matchlock-synthetic-e2e-test",
  "run-matchlock-dsh-gate-e2e-test",
  "run-matchlock-worktree-merge-e2e-test",
  "run-hermes-synthetic-e2e-test",
  "run-matchlock-long-home-e2e-test",
  "run-matchlock-empty-output-e2e-test",
  "run-matchlock-dsh-real-gate-e2e-test",
  "run-matchlock-dsh-profile-overlay-e2e-test",
  "run-matchlock-dsh-real-boot-gate-e2e-test",
  "run-matchlock-dsh-merge-worktree-e2e-test",
  "run-matchlock-dsh-merge-worktree-canary-e2e-test",
  "run-matchlock-hermes-merge-worktree-e2e-test",
  "run-matchlock-hermes-merge-worktree-canary-e2e-test",
] as const;

const GATE_TESTS = [
  "e2e-tests/matchlock-synthetic-gate.test.ts",
  "e2e-tests/matchlock-hermes-synthetic-gate.test.ts",
  "e2e-tests/matchlock-dsh-gate.test.ts",
  "e2e-tests/matchlock-dsh-profile-overlay-gate.test.ts",
  "e2e-tests/matchlock-empty-output-gate.test.ts",
  "e2e-tests/matchlock-long-home-gate.test.ts",
  "e2e-tests/matchlock-worktree-merge-gate.test.ts",
  "e2e-tests/matchlock-dsh-real-gate.test.ts",
  "e2e-tests/matchlock-dsh-real-boot-gate.test.ts",
] as const;

const OPTIONAL_OVERRIDES = [
  "TAMANDUA_MATCHLOCK_RPC_BIN",
  "MATCHLOCK_GUEST_INIT",
  "MATCHLOCK_GUEST_FUSED",
] as const;

// The previously-pinned runtime hashes and the retired /root runtime dir.
const RETIRED_PIN_HASHES = /a278f9c153c91a76bcfca3abe2ff4146996e48ad4f3b36e47026e605e9232136|f76f00fbc089dea1f1e5eba536778da9bee9f20f547a6779f14b76a700d35c06/;
const RETIRED_RUNTIME_DIR = /RUNTIME_DIR_DEFAULT|fuse-qual-refine-20260909T101655Z/;
const RETIRED_CONSTANTS = /EXPECTED_MATCHLOCK|EXPECTED_GUEST_INIT/;

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("MTLK-UNPIN: gate drivers are unpinned", () => {
  for (const driver of GATE_DRIVERS) {
    describe(driver, () => {
      const source = readRepoFile(driver);

      it("has no EXPECTED_* pin constants, pinned hashes or pinned runtime dir", () => {
        assert.doesNotMatch(source, RETIRED_CONSTANTS);
        assert.doesNotMatch(source, RETIRED_PIN_HASHES);
        assert.doesNotMatch(source, RETIRED_RUNTIME_DIR);
      });

      it("resolves matchlock from PATH and honors the optional overrides", () => {
        assert.match(source, /command -v matchlock/, "must resolve matchlock from PATH");
        for (const override of OPTIONAL_OVERRIDES) {
          assert.ok(source.includes(override), `must honor the optional ${override} override`);
        }
      });

      it("records the observed version and sha256 hashes as evidence", () => {
        assert.match(source, /--version/, "must record matchlock --version");
        assert.match(source, /sha256sum/, "must hash the resolved binaries");
        assert.match(source, /runtime-observed\.txt/, "must write runtime-observed.txt evidence");
        assert.match(source, /resolved by matchlock/, "must treat unset guest-init as matchlock-resolved");
      });
    });
  }

  it("all thirteen drivers exist and are shell scripts", () => {
    for (const driver of GATE_DRIVERS) {
      const source = readRepoFile(driver);
      assert.match(source, /^#!\/usr\/bin\/env bash/, `${driver} must be a bash script`);
    }
  });
});

describe("MTLK-UNPIN: gate tests no longer require the guest runtime to be pre-set", () => {
  for (const testFile of GATE_TESTS) {
    it(testFile, () => {
      const source = readRepoFile(testFile);
      assert.doesNotMatch(
        source,
        /assert\.ok\(GUEST_INIT\.length > 0/,
        "must not require MATCHLOCK_GUEST_INIT to be pre-set",
      );
      assert.doesNotMatch(
        source,
        /assert\.ok\(GUEST_FUSED\.length > 0/,
        "must not require MATCHLOCK_GUEST_FUSED to be pre-set",
      );
      assert.match(source, /function matchlockRuntimeEnv\(\)/, "must build the runtime env conditionally");
      assert.match(source, /resolved by matchlock|when unset, matchlock resolves/, "must document the unset-means-matchlock-resolves behavior");
    });
  }
});

describe("MTLK-UNPIN: the real-dsh boot gate is a first-class member of the family", () => {
  const BOOT_DRIVER = "run-matchlock-dsh-real-boot-gate-e2e-test";
  const BOOT_TEST = "e2e-tests/matchlock-dsh-real-boot-gate.test.ts";

  it("is enrolled in the unpin driver list and the gate test list", () => {
    assert.ok(
      (GATE_DRIVERS as readonly string[]).includes(BOOT_DRIVER),
      `GATE_DRIVERS must enroll ${BOOT_DRIVER}`,
    );
    assert.ok(
      (GATE_TESTS as readonly string[]).includes(BOOT_TEST),
      `GATE_TESTS must enroll ${BOOT_TEST}`,
    );
  });

  it("is enumerated by the README, the dsh qualification recipe and SKILL.md", () => {
    for (const file of ["README.md", "docs/matchlock-dsh-qualification.md", "skills/tamandua-agents/SKILL.md"]) {
      const source = readRepoFile(file);
      assert.ok(source.includes(BOOT_DRIVER), `${file} must enumerate ${BOOT_DRIVER}`);
      assert.ok(source.includes(BOOT_TEST), `${file} must name ${BOOT_TEST}`);
    }
  });

  it("AGENTS.md makes the real-dsh boot gate REQUIRED for dsh mount plan changes", () => {
    const agents = readRepoFile("AGENTS.md");
    assert.ok(agents.includes(BOOT_DRIVER), `AGENTS.md must name ${BOOT_DRIVER}`);
    assert.match(
      agents,
      /contained real-dsh boot gate is REQUIRED/,
      "AGENTS.md must mark the real-dsh boot gate as REQUIRED",
    );
    assert.match(agents, /dsh (Matchlock )?mount plan/i, "AGENTS.md must scope it to dsh mount plan changes");
  });

  it("the driver records runtime-observed.txt and resolves matchlock from PATH (no pins)", () => {
    const source = readRepoFile(BOOT_DRIVER);
    assert.match(source, /command -v matchlock/);
    assert.match(source, /runtime-observed\.txt/);
    assert.match(source, /--version/);
    assert.match(source, /sha256sum/);
    assert.match(source, /resolved by matchlock/);
    assert.doesNotMatch(source, RETIRED_CONSTANTS);
    assert.doesNotMatch(source, RETIRED_PIN_HASHES);
    assert.doesNotMatch(source, RETIRED_RUNTIME_DIR);
  });
});

describe("MTLK-UNPIN: docs describe observed-not-pinned behavior", () => {
  it("README Matchlock section records the unpinned runtime resolution", () => {
    const readme = readRepoFile("README.md");
    const heading = "##### Matchlock Execution (`--matchlock`)";
    const start = readme.indexOf(heading);
    assert.ok(start >= 0, "README must have the Matchlock Execution section");
    const section = readme.slice(start, readme.indexOf("##### Doctor Contract Check", start));
    assert.doesNotMatch(section, RETIRED_PIN_HASHES, "README must not carry the retired pins");
    assert.match(section, /unpinned/i);
    assert.match(section, /runtime-observed\.txt/);
  });

  it("the dsh qualification recipe records the unpinned runtime identity", () => {
    const doc = readRepoFile("docs/matchlock-dsh-qualification.md");
    assert.doesNotMatch(doc, RETIRED_PIN_HASHES, "recipe must not carry the retired pins");
    assert.match(doc, /unpinned/i);
    assert.match(doc, /runtime-observed\.txt/);
  });

  it("AGENTS.md documents the unpinned gate runtime", () => {
    const agents = readRepoFile("AGENTS.md");
    assert.doesNotMatch(agents, RETIRED_PIN_HASHES, "AGENTS.md must not carry the retired pins");
    assert.match(agents, /MTLK-UNPIN/);
    assert.match(agents, /runtime-observed\.txt/);
  });
});
