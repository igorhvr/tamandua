// Tier-2 STORM-REHEARSAL FIX-4 US-011 / FIX-5 US-007 — gate-hash coverage
// self-test.
//
// The coordinator approval pins GATE_HASH_FILES, but the behavior this FIX-4
// introduces does not live only in the engine: the campaign-controlled hold
// primitive lives in the scripted runtimes (runtime-shared / runtime-pi /
// runtime-hermes), and the focused US-001..US-010 hold/window/Round-B tests
// are the evidence for it. US-011 adds both to the single source of truth so a
// fresh approval covers exactly the code that produces the rehearsal's holds
// and chaos recovery.
//
// FIX-5 (US-007) extends the same source of truth with the five fix5 behavior
// self-tests: the SF-11 hold-wiring proof, the SF-10 one-shot proof, the
// Round-B live-target matrix, and the two contained-private-daemon E2E proofs
// (one real held run; B-stopdel chaos on the live B5 with relaunchOf lineage).
//
// STORM-REAL (US-014) extends it again: the REAL/profile modules created by
// US-001..US-012 and their focused behavior/negative self-tests are now pinned
// so a fresh approval covers exactly the code that decides what a real storm
// does (profile selection, real-harness pins, spend/cap, scale, arming,
// unattended rounds) and the evidence proving its safety rules.
//
// This test pins:
//   (1) the three scripted-runtime source files AND every focused
//       FIX-4/FIX-5 hold/window/roundb/e2e self-test are members of
//       GATE_HASH_FILES;
//   (1b) the STORM-REAL profile/arming/spend/scale/unattended modules and
//       every REAL behavior/negative self-test are members of
//       GATE_HASH_FILES, and the complete pinned behavior self-test list
//       exactly matches GATE_HASH_FILES;
//   (2) computeGateHashes() returns a 64-hex sha256 for EVERY listed file and
//       its key set is exactly GATE_HASH_FILES (no dropped/extra keys);
//   (3) computeGateHashes() REFUSES with TT_GATE_FILE_MISSING when a listed
//       file is unreadable — a vanished gate file can never silently shrink
//       the pinned set;
//   (4) the consistency suite and this gate-coverage test are deliberately
//       NOT pinned.
//
// In-process only: no daemon, no harness, no model, no ports, no source edits.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { GATE_HASH_FILES, computeGateHashes } from "../bin/tt-storm-rehearsal.mjs";

// The three scripted runtimes carrying the hold primitive (requirement 1a/1c).
const REQUIRED_RUNTIME_FILES = [
  "torture-test/scripted-runtimes/runtime-shared.mjs",
  "torture-test/scripted-runtimes/runtime-pi.mjs",
  "torture-test/scripted-runtimes/runtime-hermes.mjs",
];

// The focused FIX-4 behavior self-tests created in US-001..US-010. The
// consistency suite (which mutates shared synthetic state) and the gate-set
// test itself are deliberately excluded from the pinned set.
const REQUIRED_FIX4_SELF_TESTS = [
  "torture-test/self-tests/tier2-storm-rehearsal-redbait-projection.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-runtime.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-behaviors.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-schedule.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-simultaneity-window.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-rounda-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-hold-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-chaos-honesty.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-pending-candidate.test.ts",
];

// FIX-5 (US-007): the five fix5 behavior/E2E self-tests that must be pinned
// alongside the FIX-4 set. The consistency suite and this gate-coverage test
// itself stay excluded (see the dedicated assertions below).
const REQUIRED_FIX5_SELF_TESTS = [
  "torture-test/self-tests/tier2-storm-rehearsal-hold-wiring.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-oneshot.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-live-target.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-stopdel-e2e.test.ts",
];

// STORM-REAL (US-014): the new REAL/profile modules pinned by the approval.
// Each carries one of the real-storm safety rules (profile identity, real
// harness resolution/pins, spend accounting + cap, capacity scale, aged-state
// adoption, seed-validation arming, unattended round budget) so a change to
// any of them must invalidate a stale approval.
const REQUIRED_REAL_MODULES = [
  "torture-test/bin/tt-storm-profile.mjs",
  "torture-test/bin/tt-storm-harness-pins.mjs",
  "torture-test/bin/tt-storm-spend.mjs",
  "torture-test/bin/tt-storm-scale.mjs",
  "torture-test/bin/tt-storm-arm.mjs",
  "torture-test/bin/tt-storm-seed-validation.mjs",
  "torture-test/bin/tt-storm-unattended.mjs",
];

// The focused REAL behavior/negative self-tests that are the evidence for the
// modules above (including the US-013 boundary negative battery).
const REQUIRED_REAL_SELF_TESTS = [
  "torture-test/self-tests/tier2-storm-real-profile.test.ts",
  "torture-test/self-tests/tier2-storm-real-harness-pins.test.ts",
  "torture-test/self-tests/tier2-storm-real-profile-approval.test.ts",
  "torture-test/self-tests/tier2-storm-real-daemon-env.test.ts",
  "torture-test/self-tests/tier2-storm-real-spend-accounting.test.ts",
  "torture-test/self-tests/tier2-storm-real-spend-cap.test.ts",
  "torture-test/self-tests/tier2-storm-real-report-spend.test.ts",
  "torture-test/self-tests/tier2-storm-real-lite-roster.test.ts",
  "torture-test/self-tests/tier2-storm-real-arm-aged-state.test.ts",
  "torture-test/self-tests/tier2-storm-real-seed-validation-arm.test.ts",
  "torture-test/self-tests/tier2-storm-real-storm-aged-contract.test.ts",
  "torture-test/self-tests/tier2-storm-real-unattended.test.ts",
  "torture-test/self-tests/tier2-storm-real-boundary-negative.test.ts",
];

// The pre-existing behavior self-tests already pinned before US-014. Kept
// explicit so the complete pinned-behavior list below can be asserted against
// GATE_HASH_FILES exactly (no dropped and no unexpected test entries).
const PRE_EXISTING_PINNED_SELF_TESTS = [
  "torture-test/self-tests/tier2-storm-real-calibration.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-prepare.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-gate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-boundary.test.ts",
];

// The COMPLETE pinned behavior self-test list. The gate-hash set must match it
// exactly: a newly added REAL/[fix] self-test that is not listed here, or a
// listed one that vanished from GATE_HASH_FILES, fails the equality test.
const EXPECTED_PINNED_SELF_TESTS = [
  ...PRE_EXISTING_PINNED_SELF_TESTS,
  ...REQUIRED_FIX4_SELF_TESTS,
  ...REQUIRED_FIX5_SELF_TESTS,
  ...REQUIRED_REAL_SELF_TESTS,
];

// The tests that must NEVER be pinned: the consistency suite mutates shared
// synthetic state and the gate-coverage test only asserts the gate set itself
// (pinning it would be self-referential).
const EXCLUDED_FROM_GATE_HASH_FILES = [
  "torture-test/self-tests/tier2-storm-rehearsal-consistency.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-gate-coverage.test.ts",
];

const HEX64 = /^[0-9a-f]{64}$/;
const repoRoot = process.env.TT_REPO_ROOT ?? path.resolve(process.cwd());

describe("US-011 gate-hash coverage", () => {
  it("pins the three scripted-runtime hold files", () => {
    for (const rel of REQUIRED_RUNTIME_FILES) {
      assert.ok(GATE_HASH_FILES.includes(rel), `${rel} must be in GATE_HASH_FILES`);
    }
  });

  it("pins every new US-001..US-010 hold/window/roundb self-test", () => {
    for (const rel of REQUIRED_FIX4_SELF_TESTS) {
      assert.ok(GATE_HASH_FILES.includes(rel), `${rel} must be in GATE_HASH_FILES`);
    }
  });

  it("pins every fix5 behavior/E2E self-test (SF-11 wiring, SF-10 one-shot, Round-B live targets, two contained-daemon E2E)", () => {
    for (const rel of REQUIRED_FIX5_SELF_TESTS) {
      assert.ok(GATE_HASH_FILES.includes(rel), `${rel} must be in GATE_HASH_FILES`);
    }
    // The fix5 set and the fix4 set are disjoint: a fix5 file pinned twice or a
    // fix4 file duplicated would silently change the approved hash set shape.
    const overlap = REQUIRED_FIX5_SELF_TESTS.filter((rel) => REQUIRED_FIX4_SELF_TESTS.includes(rel));
    assert.deepEqual(overlap, [], `fix5 and fix4 pinned sets must be disjoint, found: ${JSON.stringify(overlap)}`);
  });

  it("pins the STORM-REAL profile/pins/spend/scale/arming/unattended modules and their behavior tests", () => {
    for (const rel of REQUIRED_REAL_MODULES) {
      assert.ok(GATE_HASH_FILES.includes(rel), `${rel} must be in GATE_HASH_FILES`);
    }
    for (const rel of REQUIRED_REAL_SELF_TESTS) {
      assert.ok(GATE_HASH_FILES.includes(rel), `${rel} must be in GATE_HASH_FILES`);
    }
    // The real set must be disjoint from the fix4/fix5 sets — a duplicated
    // entry would silently change the approved hash set shape.
    const overlap = REQUIRED_REAL_SELF_TESTS.filter(
      (rel) => REQUIRED_FIX4_SELF_TESTS.includes(rel) || REQUIRED_FIX5_SELF_TESTS.includes(rel),
    );
    assert.deepEqual(overlap, [], `real and fix4/fix5 pinned sets must be disjoint, found: ${JSON.stringify(overlap)}`);
  });

  it("the pinned behavior self-test list exactly matches GATE_HASH_FILES", () => {
    const pinnedTests = GATE_HASH_FILES.filter((rel) => rel.endsWith(".test.ts")).sort();
    assert.deepEqual(
      pinnedTests,
      [...EXPECTED_PINNED_SELF_TESTS].sort(),
      "GATE_HASH_FILES behavior-test set must equal the pinned behavior list (no dropped or unexpected test entries)",
    );
  });

  it("does not pin the consistency suite or the gate-coverage test itself", () => {
    for (const rel of EXCLUDED_FROM_GATE_HASH_FILES) {
      assert.ok(!GATE_HASH_FILES.includes(rel), `${rel} must stay out of the pinned behavior set`);
    }
  });

  it("every listed gate file exists and is hashed to 64 hex chars", () => {
    const hashes = computeGateHashes();
    // Exact key-set equality: every listed file hashed, nothing extra.
    assert.deepEqual(
      Object.keys(hashes).sort(),
      [...GATE_HASH_FILES].sort(),
      "computeGateHashes key set must equal GATE_HASH_FILES",
    );
    for (const rel of GATE_HASH_FILES) {
      assert.ok(fs.existsSync(path.join(repoRoot, rel)), `listed gate file must exist on disk: ${rel}`);
      assert.match(hashes[rel], HEX64, `gate hash for ${rel} must be a 64-char lowercase hex sha256`);
    }
  });

  it("refuses with TT_GATE_FILE_MISSING when a listed gate file is unreadable", () => {
    // A real-fs mirror that throws for ONE listed gate file (the first
    // scripted runtime) and delegates everything else to node:fs.
    const unreadableRel = REQUIRED_RUNTIME_FILES[0];
    const unreadableAbs = path.join(repoRoot, unreadableRel);
    const refusingFsx = {
      readFileSync(p: string | URL, ...rest: any[]) {
        if (String(p) === unreadableAbs) throw new Error("EACCES: simulated unreadable gate file");
        return (fs.readFileSync as any)(p, ...rest);
      },
    };
    let refused: any = null;
    try {
      computeGateHashes({ fsx: refusingFsx, repoRoot });
    } catch (err) {
      refused = err;
    }
    assert.ok(refused, "computeGateHashes must throw when a listed gate file is unreadable");
    assert.equal(refused.code, "TT_GATE_FILE_MISSING", "refusal code must be TT_GATE_FILE_MISSING");
    assert.match(String(refused.message), new RegExp(unreadableRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "refusal must name the unreadable file");
  });

  it("refuses when ANY single listed file vanishes (never silently shrinks the set)", () => {
    // Prove the fail-closed property is not special to the runtimes: inject a
    // mirror that refuses every path and confirm the code, then one that
    // refuses a non-runtime listed self-test.
    const denyAllFsx = { readFileSync: () => { throw new Error("ENOENT: all denied"); } };
    let denied: any = null;
    try {
      computeGateHashes({ fsx: denyAllFsx, repoRoot });
    } catch (err) {
      denied = err;
    }
    assert.equal(denied?.code, "TT_GATE_FILE_MISSING", "deny-all mirror must refuse with TT_GATE_FILE_MISSING");

    const selfTestRel = REQUIRED_FIX4_SELF_TESTS[0];
    const selfTestAbs = path.join(repoRoot, selfTestRel);
    const denyingOneFsx = {
      readFileSync(p: string | URL, ...rest: any[]) {
        if (String(p) === selfTestAbs) throw new Error("ENOENT: simulated vanished self-test");
        return (fs.readFileSync as any)(p, ...rest);
      },
    };
    let oneDenied: any = null;
    try {
      computeGateHashes({ fsx: denyingOneFsx, repoRoot });
    } catch (err) {
      oneDenied = err;
    }
    assert.equal(oneDenied?.code, "TT_GATE_FILE_MISSING", "a vanished listed self-test must also refuse");
  });
});
