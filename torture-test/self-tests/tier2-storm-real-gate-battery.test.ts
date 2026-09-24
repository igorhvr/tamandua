// Tier-2 STORM-REAL-PROFILE US-017 — the full REAL-profile gate battery.
//
// US-017 runs the whole REAL boundary gate battery (build/typecheck, the
// frozen 49-file storm self-test chain under the shared vaivm gate lock with
// the guard env and /usr/bin/false harnesses, the tier-2 consistency suite,
// every REAL behavior/negative self-test, and a SCRIPTED_REHEARSAL prepare
// regression) and records the observed result in the published contract.
//
// This file is the focused self-test for the battery machinery:
//   * the pure builder classifies every chain red against the DOCUMENTED
//     pre-existing host-environment deviation set — a red that is not
//     documented becomes a `new_red` and the battery FAILS;
//   * the fail-closed validator refuses a green verdict with an undeclared red,
//     a wrong lock/guard env, a chain that did not cover 49 files, a red
//     focused self-test or a missing/red scripted prepare regression;
//   * the contract projection validates, and
//   * when the retained battery + published contract exist, they are validated
//     as the recorded evidence (a drift sentinel, not a re-run).
//
// In-process only except the one real scripted-prepare regression, which is
// launch-free; no daemon, no model, no ports.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CHAIN_EXPECTED_FILES,
  CHAIN_HARNESS_GUARD_ENV,
  CHAIN_LOCK_PATH,
  DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES,
  GATE_BATTERY_KIND,
  GATE_BATTERY_PATH,
  buildStormRealGateBattery,
  classifyChainRedFiles,
  gateResultsForContract,
  parseNodeTestTotals,
  validateGateResults,
  validateStormRealGateBattery,
} from "../bin/tt-storm-real-gate-battery.mjs";
import {
  CONTRACT_PATH,
  validateStormRealProfileContract,
} from "../bin/tt-storm-real-contract.mjs";

const repoRoot = process.cwd();
const TT_STORM_CLI = path.join(repoRoot, "torture-test", "bin", "tt-storm");

const PUBLISHED_BATTERY = process.env.STORM_REAL_GATE_BATTERY ?? GATE_BATTERY_PATH;
const PUBLISHED_CONTRACT = process.env.STORM_REAL_PROFILE_CONTRACT ?? CONTRACT_PATH;

function syntheticSource(): any {
  return { branch: "feature/storm-real-profile", commit: "a".repeat(40), tree: "b".repeat(40), tree_dirty: false };
}

function chainSummary(redFiles: string[]): any {
  return {
    kind: "storm-chain-summary",
    head: "a".repeat(40),
    evidence_dir: "/tmp/storm-chain-us017",
    harness_guard_env: CHAIN_HARNESS_GUARD_ENV,
    lock: { path: CHAIN_LOCK_PATH, held_seconds: 151.5, untouched: true },
    file_count_expected: CHAIN_EXPECTED_FILES,
    file_count_observed: CHAIN_EXPECTED_FILES,
    red_files: redFiles.map((file) => ({ file, rc: 1 })),
    totals: { tests: 584, pass: 552, fail: 5, skipped: 7 },
  };
}

function greenFocused(): any[] {
  return [{ file: "torture-test/self-tests/tier2-storm-rehearsal-consistency.test.ts", verdict: "PASS", tests: 34, pass: 34, fail: 0, skipped: 2 }];
}

function greenScripted(): any {
  return { command: "tt-storm prepare --profile SCRIPTED_REHEARSAL", verdict: "PASS", campaign_id: "storm-...", profile: "SCRIPTED_REHEARSAL" };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("STORM-REAL-PROFILE US-017 REAL-profile gate battery", () => {
  it("B1: the documented host-environment deviation set is exact and is the only tolerated red set", () => {
    assert.deepEqual(
      [...DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES].sort(),
      [
        "torture-test/self-tests/tier2-storm-rehearsal-boundary.test.ts",
        "torture-test/self-tests/tier2-storm-rehearsal-hold-e2e.test.ts",
        "torture-test/self-tests/tier2-storm-rehearsal-park-e2e.test.ts",
        "torture-test/self-tests/tier2-storm-rehearsal-rugpull-e2e.test.ts",
        "torture-test/self-tests/tier2-storm-rehearsal-stopdel-e2e.test.ts",
      ].sort(),
    );
    const c = classifyChainRedFiles(DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES);
    assert.equal(c.new_reds.length, 0, "the documented set classifies with no new red");
    assert.equal(c.documented.length, DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES.length);
    const withNew = classifyChainRedFiles([...DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES, "torture-test/self-tests/tier2-storm.test.ts"]);
    assert.deepEqual(withNew.new_reds, ["torture-test/self-tests/tier2-storm.test.ts"], "an unfamiliar red is a new red");
  });

  it("B2: the builder records a 49/49 chain whose only reds are documented deviations as a green battery", () => {
    const battery: any = buildStormRealGateBattery({
      source: syntheticSource(),
      recordedAtUtc: "2026-09-23T00:00:00.000Z",
      evidenceDir: "/tmp/storm-chain-us017",
      chainSummary: chainSummary(DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES),
      focusedSelfTests: greenFocused(),
      build: { verdict: "PASS" },
      typecheck: { verdict: "PASS" },
      scriptedPrepareRegression: greenScripted(),
    });
    assert.equal(battery.kind, GATE_BATTERY_KIND);
    assert.equal(battery.gates.storm_chain.verdict, "PASS_WITH_DOCUMENTED_ENV_DEVIATIONS");
    assert.equal(battery.overall.verdict, "PASS_WITH_DOCUMENTED_ENV_DEVIATIONS");
    assert.deepEqual(battery.overall.new_reds, []);
    assert.deepEqual(battery.chain_classification.documented_not_observed, []);
    const verdict = validateStormRealGateBattery(battery);
    assert.equal(verdict.ok, true, `built battery must validate: ${JSON.stringify(verdict.issues)}`);
  });

  it("B3: an undocumented chain red makes the battery FAIL and is surfaced as new_reds", () => {
    const battery: any = buildStormRealGateBattery({
      source: syntheticSource(),
      chainSummary: chainSummary([...DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES, "torture-test/self-tests/tier2-storm-rehearsal-prepare.test.ts"]),
      focusedSelfTests: greenFocused(),
      build: { verdict: "PASS" },
      typecheck: { verdict: "PASS" },
      scriptedPrepareRegression: greenScripted(),
    });
    assert.equal(battery.gates.storm_chain.verdict, "FAIL");
    assert.deepEqual(battery.overall.new_reds, ["torture-test/self-tests/tier2-storm-rehearsal-prepare.test.ts"]);
    assert.equal(battery.overall.verdict, "FAIL");
    // A FAIL battery is still a valid document (honest), and the validator
    // must accept it while it must REFUSE a green one that hides a new red.
    assert.equal(validateStormRealGateBattery(battery).ok, true);
    const hidden: any = clone(battery);
    hidden.overall.verdict = "PASS_WITH_DOCUMENTED_ENV_DEVIATIONS";
    assert.equal(validateStormRealGateBattery(hidden).ok, false, "a green verdict hiding a new red is refused");
  });

  it("B4: the validator refuses lock/guard/file-count/focused/scripted drift", () => {
    const base: any = buildStormRealGateBattery({
      source: syntheticSource(),
      chainSummary: chainSummary(DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES),
      focusedSelfTests: greenFocused(),
      build: { verdict: "PASS" },
      typecheck: { verdict: "PASS" },
      scriptedPrepareRegression: greenScripted(),
    });
    assert.equal(validateStormRealGateBattery(base).ok, true);

    const wrongLock: any = clone(base);
    wrongLock.gates.storm_chain.lock.path = "/tmp/other.lock";
    assert.equal(validateStormRealGateBattery(wrongLock).ok, false, "a wrong gate lock is refused");

    const wrongGuard: any = clone(base);
    wrongGuard.gates.storm_chain.harness_guard_env = "TAMANDUA_PI_BINARY=/usr/bin/false";
    assert.equal(validateStormRealGateBattery(wrongGuard).ok, false, "a wrong guard/harness env is refused");

    const shortChain: any = clone(base);
    shortChain.gates.storm_chain.files_observed = 48;
    assert.equal(validateStormRealGateBattery(shortChain).ok, false, "a chain that missed a file is refused");

    const redFocused: any = clone(base);
    redFocused.gates.focused_self_tests = [{ file: "x.test.ts", verdict: "FAIL", fail: 1 }];
    assert.equal(validateStormRealGateBattery(redFocused).ok, false, "a red focused self-test is refused");

    const noScripted: any = clone(base);
    noScripted.gates.scripted_prepare_regression = { verdict: "FAIL" };
    assert.equal(validateStormRealGateBattery(noScripted).ok, false, "a red scripted prepare regression is refused");

    const wrongDocSet: any = clone(base);
    wrongDocSet.chain_classification.documented = [{ file: "only-one.test.ts", reason: "x" }];
    assert.equal(validateStormRealGateBattery(wrongDocSet).ok, false, "a redefined documented deviation set is refused");

    assert.equal(validateStormRealGateBattery({}).ok, false, "a non-battery object is refused");
  });

  it("B5: the contract projection validates and refuses a drifted/red projection", () => {
    const battery: any = buildStormRealGateBattery({
      source: syntheticSource(),
      chainSummary: chainSummary(DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES),
      focusedSelfTests: greenFocused(),
      build: { verdict: "PASS" },
      typecheck: { verdict: "PASS" },
      testCmd: { verdict: "PASS", serial_lane: { verdict: "PASSED", tests: 5030, fail: 0 }, parallel_lane: { verdict: "PASSED", tests: 4223, fail: 0 } },
      scriptedPrepareRegression: greenScripted(),
    });
    const gateResults: any = gateResultsForContract(battery, { batteryPath: GATE_BATTERY_PATH, batterySha256: "c".repeat(64) });
    assert.equal(validateGateResults(gateResults).ok, true, "the projection must validate");
    assert.equal(gateResults.test_cmd.serial_lane.verdict, "PASSED", "gate-specific TEST_CMD lane evidence is preserved, not dropped");
    assert.equal(gateResults.test_cmd.parallel_lane.verdict, "PASSED", "gate-specific TEST_CMD lane evidence is preserved, not dropped");
    assert.equal(gateResults.storm_chain.files_expected, CHAIN_EXPECTED_FILES);
    assert.equal(gateResults.gate_battery.overall_verdict, "PASS_WITH_DOCUMENTED_ENV_DEVIATIONS");
    assert.equal(gateResults.scripted_prepare_regression.verdict, "PASS");

    const badRed: any = clone(gateResults);
    badRed.storm_chain.red_files = ["torture-test/self-tests/tier2-storm.test.ts"];
    assert.equal(validateGateResults(badRed).ok, false, "an undeclared red is refused");

    const badNew: any = clone(gateResults);
    badNew.storm_chain.new_reds = ["x"];
    assert.equal(validateGateResults(badNew).ok, false, "a non-empty new_reds is refused");

    const badFocused: any = clone(gateResults);
    badFocused.focused_self_tests = [{ file: "x.test.ts", verdict: "FAIL" }];
    assert.equal(validateGateResults(badFocused).ok, false, "a red focused list is refused");

    const badScripted: any = clone(gateResults);
    badScripted.scripted_prepare_regression = { verdict: "NOT_RUN" };
    assert.equal(validateGateResults(badScripted).ok, false, "an unproven scripted regression is refused");

    const badOverall: any = clone(gateResults);
    badOverall.overall.verdict = "FAIL";
    assert.equal(validateGateResults(badOverall).ok, false, "a non-green overall verdict is refused");
  });

  it("B6: node:test totals are parsed from a bounded report (no fabricated counts)", () => {
    const text = "ℹ tests 12\nℹ pass 11\nℹ fail 1\nℹ skipped 1\n";
    assert.deepEqual(parseNodeTestTotals(text), { tests: 12, pass: 11, fail: 1, skipped: 1 });
    assert.deepEqual(parseNodeTestTotals("no totals here"), { tests: 0, pass: 0, fail: 0, skipped: 0 });
  });

  it("B7: the retained battery + published contract are valid, honest recorded evidence", () => {
    if (!fs.existsSync(PUBLISHED_BATTERY) && !fs.existsSync(PUBLISHED_CONTRACT)) return; // fresh host: out-of-band artifacts

    if (fs.existsSync(PUBLISHED_BATTERY)) {
      const battery: any = JSON.parse(fs.readFileSync(PUBLISHED_BATTERY, "utf8"));
      const verdict = validateStormRealGateBattery(battery);
      assert.equal(verdict.ok, true, `retained battery must validate: ${JSON.stringify(verdict.issues)}`);
      assert.ok(
        ["PASS", "PASS_WITH_DOCUMENTED_ENV_DEVIATIONS"].includes(battery.overall.verdict),
        `retained battery must be green (got ${battery.overall.verdict})`,
      );
      // Every observed red is documented; the red set was classified honestly.
      assert.deepEqual(
        [...new Set(battery.chain_classification.observed)].sort(),
        [...DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES].sort(),
        "the retained chain red set equals the documented host-environment deviation set",
      );
    }

    if (fs.existsSync(PUBLISHED_CONTRACT)) {
      const contract: any = JSON.parse(fs.readFileSync(PUBLISHED_CONTRACT, "utf8"));
      const contractVerdict = validateStormRealProfileContract(contract, { contractPath: PUBLISHED_CONTRACT });
      assert.equal(contractVerdict.ok, true, `published contract must validate: ${JSON.stringify(contractVerdict.issues)}`);
      const gateVerdict = validateGateResults(contract.gate_results);
      assert.equal(gateVerdict.ok, true, `published contract gate_results must validate: ${JSON.stringify(gateVerdict.issues)}`);
      assert.equal(contract.gate_results.storm_chain.files_expected, CHAIN_EXPECTED_FILES);
      assert.equal(contract.gate_results.storm_chain.files_observed, CHAIN_EXPECTED_FILES);
      assert.equal(contract.gate_results.storm_chain.lock.path, CHAIN_LOCK_PATH);
      assert.deepEqual(
        [...new Set(contract.gate_results.storm_chain.red_files)].sort(),
        [...DOCUMENTED_CHAIN_ENVIRONMENT_DEVIATION_FILES].sort(),
        "the recorded chain red set equals the documented host-environment deviation set",
      );
      assert.equal(contract.gate_results.scripted_prepare_regression.verdict, "PASS");
      assert.ok(
        contract.gate_results.gate_battery.sha256 === null || /^[0-9a-f]{64}$/.test(String(contract.gate_results.gate_battery.sha256)),
        "the contract points at a content-addressed battery artifact",
      );
    }
  });

  it("B8: a SCRIPTED_REHEARSAL prepare still succeeds (launch-free regression)", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tt-storm-real-gate-battery-"));
    try {
      const env: Record<string, string> = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const res = spawnSync(process.execPath, [TT_STORM_CLI, "prepare", "--profile", "SCRIPTED_REHEARSAL", "--fixture", "tt-poly"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 300_000,
        env: { ...env, TT_VAR: path.join(scratch, "var") },
      });
      const stdout = String(res.stdout ?? "");
      assert.equal(res.status, 0, `scripted prepare must still succeed:\n${stdout}\n${String(res.stderr ?? "")}`);
      assert.match(stdout, /SCRIPTED_REHEARSAL/, "the scripted prepare records the SCRIPTED_REHEARSAL profile");
      assert.match(stdout, /NO launches performed/, "the scripted prepare is launch-free");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});