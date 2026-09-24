#!/usr/bin/env node
/**
 * torture-port-verify.test.mjs — self-test for the TORTURE-PORT contract validator.
 *
 * Port-owned artifact (matches torture-test/impl-tasks/torture-port-*).
 * Run: node --test torture-test/impl-tasks/torture-port-verify.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  AGED_SELF_TESTS,
  CORE_RECORDING_KEY_TESTS,
  DEFAULT_CONTRACT,
  DROPPED_PATHS,
  EXPECTED_BATTERY_EXCLUDED_HEAVY,
  EXPECTED_BATTERY_NEW_SINCE_PREVIOUS,
  EXPECTED_CORE_RECORDING_FILES,
  EXPECTED_CORE_RECORDING_ADAPTATION_IDS,
  EXPECTED_GATE_SUMMARY,
  EXPECTED_O12_CONTENT_SHA256,
  EXPECTED_O12_FIXTURE_COUNT,
  EXPECTED_PARALLEL_LANE,
  EXPECTED_SELF_TESTS_ALONE_COUNTS,
  EXPECTED_SELF_TESTS_ALONE_ENTRIES,
  EXPECTED_SELF_TESTS_ALONE_REQUIRED,
  EXPECTED_SERIAL_LANE,
  EXPECTED_STORM_CHAIN_FILE_COUNT,
  EXPECTED_STORM_GATE_FILES,
  O12_DOCUMENTED_ENTRIES,
  PREVIOUS_BATTERY_SHAPE,
  REQUIRED_FIXTURE_TOOLCHAINS,
  REQUIRED_GATE_IDS,
  REQUIRED_SMOKES,
  REPO_ROOT,
  RUN7_CHAIN_SHAPE,
  STORM_BASE_SEAMS_TEST,
  adaptedPathsFromContract,
  collectAgedState,
  collectO12State,
  collectOverlayState,
  deriveBatterySelection,
  expectedOutsidePaths,
  gateSummaryFromContract,
  isPortArtifact,
  refOverlayInventory,
  runAgedRedArms,
  runContractRedArms,
  runCoreRecordingRedArms,
  runEnvironmentRedArms,
  runGatesRedArms,
  runO12RedArms,
  runOverlayRedArms,
  runProductSuiteRedArms,
  runSelfTestsAloneRedArms,
  runStormChainRedArms,
  runStormRedArms,
  runTortureBatteryRedArms,
  validateAgedAdaptation,
  validateContract,
  validateCoreRecordingAdaptation,
  validateEnvironmentReceipt,
  validateGates,
  validateO12Adaptation,
  validateOverlay,
  validateProductSuiteGate,
  validateSelfTestsAloneGate,
  validateStormAdaptation,
  validateStormChainGate,
  validateTortureBatteryGate,
} from "./torture-port-verify.mjs";

import path from "node:path";

import { validateSelfTestsAloneSummary } from "../self-tests/self-tests-alone-report.mjs";
import { validateChainSummary } from "../self-tests/storm-chain-report.mjs";

const contract = JSON.parse(fs.readFileSync(DEFAULT_CONTRACT, "utf8"));

test("contract is valid JSON and passes the validator", () => {
  const { paths } = expectedOutsidePaths(contract);
  const errors = validateContract(contract, paths);
  assert.deepEqual(errors, []);
});

test("pinned inventory accounts for exactly 213 outside paths", () => {
  const { paths } = expectedOutsidePaths(contract);
  assert.equal(paths.length, 213);
  const covered = new Set(contract.outsideFiles.map((f) => f.path));
  for (const p of paths) assert.ok(covered.has(p), `missing path ${p}`);
  assert.equal(contract.inventory.pathCount, 213);
});

test("every outside-file group has a decision in {a,b,c} plus evidence", () => {
  for (const g of contract.groups) {
    assert.ok(["a", "b", "c"].includes(g.decision), `${g.name} decision`);
    assert.ok(typeof g.evidence === "string" && g.evidence.length > 0, `${g.name} evidence`);
    assert.ok(typeof g.fileCount === "number" && g.fileCount > 0, `${g.name} fileCount`);
  }
});

test("launcher section records run-torture-test present and identical", () => {
  assert.equal(contract.launcher.required_additional, "none");
  assert.equal(contract.launcher.run_torture_test.present_on_base, true);
  assert.equal(contract.launcher.run_torture_test.identical_to_src, true);
});

test("red arm: a missing decision is rejected", () => {
  const { paths } = expectedOutsidePaths(contract);
  const copy = JSON.parse(JSON.stringify(contract));
  delete copy.groups[0].decision;
  const errors = validateContract(copy, paths);
  assert.ok(errors.length > 0, "expected the missing decision to be rejected");
  assert.ok(
    errors.some((e) => /decision must be one of a\|b\|c/.test(e)),
    `expected decision error, got: ${errors.join("; ")}`,
  );
});

test("all validator red arms are rejected", () => {
  const { paths } = expectedOutsidePaths(contract);
  const arms = runContractRedArms(contract, paths);
  assert.ok(arms.length >= 9, `expected several red arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(failed, [], `red arms that did not reject: ${failed.map((a) => a.name).join(", ")}`);
});

// --- US-002 overlay equality -------------------------------------------------

test("live torture tree matches refs/remotes/src/torture apart from port artifacts and recorded adaptations", () => {
  const state = collectOverlayState();
  const adaptedPaths = adaptedPathsFromContract(contract);
  const errors = validateOverlay(state, { adaptedPaths, requireAdaptedDiffs: true });
  assert.deepEqual(errors, []);
  for (const p of state.overlayDiffPaths) {
    assert.ok(
      isPortArtifact(p) || adaptedPaths.includes(p),
      `non-port, unrecorded overlay path: ${p}`,
    );
  }
  assert.ok(adaptedPaths.length > 0, "the port must record its torture-tree adaptations");
});

test("every recorded adaptation differs from SRC (no stale allowlist)", () => {
  const state = collectOverlayState();
  const adaptedPaths = adaptedPathsFromContract(contract);
  const diffSet = new Set(state.overlayDiffPaths);
  for (const p of adaptedPaths) {
    assert.ok(diffSet.has(p), `recorded adaptation does not differ from SRC: ${p}`);
  }
});

test("no path outside torture-test/ differs from BASE", () => {
  const state = collectOverlayState();
  assert.deepEqual(state.nonTortureDiffPaths, []);
});

test("the 9 dropped base-only paths are absent and rationale is pinned", () => {
  assert.equal(DROPPED_PATHS.length, 9);
  assert.equal(new Set(DROPPED_PATHS).size, 9);
  const state = collectOverlayState();
  assert.deepEqual(state.presentDroppedPaths, []);
});

test("reference overlay inventory is 190 added / 44 modified / 9 dropped", () => {
  const inv = refOverlayInventory();
  assert.equal(inv.added, 190);
  assert.equal(inv.modified, 44);
  assert.equal(inv.dropped, 9);
  assert.equal(inv.other, 0);
});

test("overlay validator rejects a source-ref drift", () => {
  const errors = validateOverlay({
    overlayDiffPaths: ["torture-test/self-tests/not-in-src.test.ts"],
  });
  assert.ok(errors.some((e) => /differs from refs\/remotes\/src\/torture/.test(e)), errors.join("; "));
});

test("overlay validator rejects product-path drift", () => {
  const errors = validateOverlay({ nonTortureDiffPaths: ["src/server/db.ts"] });
  assert.ok(errors.some((e) => /outside torture-test\/ differs from BASE/.test(e)), errors.join("; "));
});

test("overlay validator rejects a dropped path that is still present", () => {
  const errors = validateOverlay({ presentDroppedPaths: [DROPPED_PATHS[0]] });
  assert.ok(errors.some((e) => /dropped base-only path is still present/.test(e)), errors.join("; "));
});

test("overlay validator exempts port-owned torture-port-* artifacts", () => {
  const errors = validateOverlay({
    overlayDiffPaths: [
      "torture-test/impl-tasks/torture-port-contract.json",
      "torture-test/impl-tasks/torture-port-verify.mjs",
    ],
  });
  assert.deepEqual(errors, []);
});

test("overlay red arms all behave (drift rejected, port artifacts and adaptations accepted)", () => {
  const state = collectOverlayState();
  const adaptedPaths = adaptedPathsFromContract(contract);
  const arms = runOverlayRedArms(state, { adaptedPaths });
  assert.ok(arms.length >= 5, `expected several overlay arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(failed, [], `overlay arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`);
  assert.ok(arms.some((a) => a.name === "port-artifacts-exempt"), "missing port-artifacts-exempt control");
  assert.ok(arms.some((a) => a.name === "recorded-adaptation-exempt"), "missing recorded-adaptation-exempt control");
});

// --- US-003 environment readiness -------------------------------------------

test("environment receipt passes the validator", () => {
  assert.ok(contract.environmentReceipt, "contract.environmentReceipt missing");
  const errors = validateEnvironmentReceipt(contract.environmentReceipt);
  assert.deepEqual(errors, []);
});

test("environment receipt records node/npm, all five fixture toolchains and disk headroom", () => {
  const r = contract.environmentReceipt;
  assert.equal(typeof r.node, "string");
  assert.equal(r.node, "v24.21.0");
  assert.equal(typeof r.npm, "string");
  for (const name of REQUIRED_FIXTURE_TOOLCHAINS) {
    const t = r.fixture_toolchains[name];
    assert.ok(t, `fixture toolchain ${name} missing`);
    assert.equal(t.present, true, `${name} not present`);
    assert.equal(t.buildPassed, true, `${name} build probe not passed`);
    assert.equal(t.testPassed, true, `${name} test probe not passed`);
  }
  assert.equal(r.all_fixture_toolchains_present, true);
  assert.ok(r.disk_headroom.availableBytes >= r.disk_headroom.thresholdBytes);
  assert.equal(r.disk_headroom.ok, true);
  assert.equal(r.disk_headroom.thresholdBytes, 64424509440, "threshold must be 60 GiB");
});

test("environment receipt records tt-verify-environment counts with zero FAILs", () => {
  const ve = contract.environmentReceipt.verify_environment;
  assert.equal(ve.exit_code, 0);
  assert.equal(ve.tier, "tier2");
  assert.equal(ve.counts.fail, 0);
  assert.equal(ve.counts.pass, 26);
  assert.equal(ve.counts.skipped, 7);
  assert.equal(ve.counts.total, 33);
  assert.equal(
    ve.counts.pass + ve.counts.fail + ve.counts.skipped,
    ve.counts.total,
    "counts must sum",
  );
});

test("environment receipt records both fast smokes exit 0 with retained logs", () => {
  const smokes = contract.environmentReceipt.smoke_tests;
  assert.equal(smokes.length, 2);
  for (const name of REQUIRED_SMOKES) {
    const s = smokes.find((x) => x.name === name);
    assert.ok(s, `smoke ${name} missing`);
    assert.equal(s.exit_code, 0, `${name} exit code`);
    const abs = path.isAbsolute(s.log) ? s.log : path.join(REPO_ROOT, s.log);
    assert.ok(fs.existsSync(abs), `retained log missing: ${s.log}`);
    assert.ok(fs.statSync(abs).size > 0, `retained log empty: ${s.log}`);
  }
});

test("environment receipt records the unavailable Inlet temperature honestly", () => {
  const r = contract.environmentReceipt;
  assert.match(r.inlet_temperature, /unavailable/);
  assert.equal(r.thermal_check_command, "sudo -n ipmitool sdr type Temperature | grep Inlet");
});

test("retained environment evidence directory exists under torture-test/var/results", () => {
  const dir = contract.gateResults["US-003"].retained_evidence_dir;
  assert.match(dir, /^torture-test\/var\/results\/torture-port-us003-environment-/);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, dir)));
});

test("environment red arm: a missing node version is rejected", () => {
  const copy = JSON.parse(JSON.stringify(contract.environmentReceipt));
  delete copy.node;
  const errors = validateEnvironmentReceipt(copy);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => /missing non-empty node/.test(e)), errors.join("; "));
});

test("environment red arms all behave", () => {
  const arms = runEnvironmentRedArms(contract.environmentReceipt);
  assert.ok(arms.length >= 9, `expected several environment arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(failed, [], `environment arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`);
});

// --- US-004 aged/seed adaptation --------------------------------------------

test("live aged state passes the adaptation validator", async () => {
  const state = await collectAgedState();
  const errors = validateAgedAdaptation(state);
  assert.deepEqual(errors, []);
});

test("aged state pins the unchanged O12 content and resolves both provenance commits", async () => {
  const state = await collectAgedState();
  assert.equal(state.contentPin, EXPECTED_O12_CONTENT_SHA256, "the port must not re-pin the O12 content");
  assert.equal(state.provenance.resolves, true, "O12 provenance commit must resolve");
  assert.equal(state.provenance.observedSubject, state.provenance.subject, "O12 provenance subject must be real");
  assert.equal(state.pointer.resolves, true, "pointer source commit must resolve");
  assert.equal(state.pointer.observedTree, state.pointer.tree, "pointer source tree must match");
  assert.equal(state.pointer.observedSubject, state.pointer.subject, "pointer source subject must match");
  // On the schema-13 product both historical commits are pre-port, so both
  // records must carry their explicit legacy declaration.
  if (state.provenance.isAncestor !== true) assert.equal(state.provenance.legacy, true);
  if (state.pointer.isAncestor !== true) assert.equal(state.pointer.legacyNotAncestor, true);
});

test("aged red arm: an unreachable provenance without a legacy declaration is rejected", () => {
  const state = {
    contentPin: EXPECTED_O12_CONTENT_SHA256,
    provenance: {
      commit: "a".repeat(40),
      subject: "s",
      resolves: true,
      isAncestor: false,
      legacy: false,
      legacyReason: "",
      observedSubject: "s",
    },
    pointer: {
      commit: "b".repeat(40),
      tree: "c".repeat(40),
      subject: "p",
      resolves: true,
      isAncestor: true,
      observedTree: "c".repeat(40),
      observedSubject: "p",
      legacyNotAncestor: false,
      legacyReason: "",
    },
  };
  const errors = validateAgedAdaptation(state);
  assert.ok(
    errors.some((e) => /not an ancestor of HEAD and is not declared legacy/.test(e)),
    errors.join("; "),
  );
});

test("aged red arms all behave (drift rejected, live state accepted)", async () => {
  const state = await collectAgedState();
  const arms = runAgedRedArms(state);
  assert.ok(arms.length >= 11, `expected several aged arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(failed, [], `aged arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`);
  assert.ok(arms.some((a) => a.name === "aged-state-accepted"), "missing aged-state-accepted control");
  assert.deepEqual(AGED_SELF_TESTS, ["aged-core", "origin-pins", "seed-root-copy", "seed-readiness"]);
});

// --- US-005 O12 oracle adaptation -------------------------------------------

test("live O12 state passes the adaptation validator", async () => {
  const state = await collectO12State(contract);
  const errors = validateO12Adaptation(state);
  assert.deepEqual(errors, []);
});

test("O12 embedded pin equals the live recomputed content hash", async () => {
  const state = await collectO12State(contract);
  assert.equal(state.pin, EXPECTED_O12_CONTENT_SHA256, "the port must not re-pin the O12 content");
  assert.equal(state.recomputed, state.pin, "a live recomputation must equal the embedded pin");
  assert.equal(state.receipt.content_pin.repin_required, false, "no re-pin is required");
});

test("the contract records all eight documented O12 entries with exit 0", () => {
  const receipt = contract.gateResults?.["US-005"];
  assert.ok(receipt, "gateResults.US-005 must exist");
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.entries.length, 8);
  for (const definition of O12_DOCUMENTED_ENTRIES) {
    const entry = receipt.entries.find((e) => e.name === definition.name);
    assert.ok(entry, `missing recorded entry ${definition.name}`);
    assert.equal(entry.exit_code, 0);
    assert.equal(entry.kind, definition.kind);
  }
});

test("the contract records the 78/78 fixture matrix and a PASS gate runner", () => {
  const receipt = contract.gateResults?.["US-005"];
  assert.equal(receipt.matrix.expected_fixture_count, EXPECTED_O12_FIXTURE_COUNT);
  assert.equal(receipt.matrix.fixture_count, EXPECTED_O12_FIXTURE_COUNT);
  assert.equal(receipt.matrix.all_match, true);
  assert.equal(receipt.matrix.snapshot_immutability_ok, true);
  assert.equal(receipt.matrix.all_correction_cases_green, true);
  assert.equal(receipt.matrix.validation_ok, true);
  assert.equal(receipt.gate_runner.exit_code, 0);
  assert.equal(receipt.gate_runner.verdict, "PASS");
  assert.equal(receipt.gate_runner.entries_passed, receipt.gate_runner.entries_total);
});

test("the eight recorded O12 entry logs exist and are non-empty", () => {
  const selfTests = contract.storyEvidence?.["US-005"]?.selfTests;
  assert.ok(Array.isArray(selfTests), "storyEvidence.US-005.selfTests must be an array");
  for (const definition of O12_DOCUMENTED_ENTRIES) {
    const entry = selfTests.find((e) => e.name === definition.name);
    assert.ok(entry, `missing recorded self-test ${definition.name}`);
    const abs = path.isAbsolute(entry.log) ? entry.log : path.join(REPO_ROOT, entry.log);
    assert.ok(fs.existsSync(abs), `retained log missing: ${entry.log}`);
    assert.ok(fs.statSync(abs).size > 0, `retained log is empty: ${entry.log}`);
  }
});

test("the contract records the content-pin self-test green with a retained log", () => {
  const pin = contract.gateResults?.["US-005"]?.content_pin;
  assert.ok(pin?.self_test, "content_pin.self_test must be recorded");
  assert.equal(pin.self_test.name, "o12-content-pin.test.mjs");
  assert.equal(pin.self_test.exit_code, 0);
  assert.equal(pin.self_test.fail, 0);
  assert.ok(pin.self_test.tests > 0);
  const abs = path.isAbsolute(pin.self_test.log) ? pin.self_test.log : path.join(REPO_ROOT, pin.self_test.log);
  assert.ok(fs.existsSync(abs), `retained content-pin log missing: ${pin.self_test.log}`);
  assert.ok(fs.statSync(abs).size > 0, "retained content-pin log is empty");
});

test("o12 red arm: a live content-hash drift is rejected", async () => {
  const state = await collectO12State(contract);
  const copy = structuredClone(state);
  copy.recomputed = "f".repeat(64);
  const errors = validateO12Adaptation(copy);
  assert.ok(
    errors.some((e) => /live content hash .* != pinned/.test(e)),
    errors.join("; "),
  );
});

test("o12 red arms all behave (drift rejected, live state accepted)", async () => {
  const state = await collectO12State(contract);
  const arms = runO12RedArms(state);
  assert.ok(arms.length >= 11, `expected several o12 arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(failed, [], `o12 arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`);
  assert.ok(arms.some((a) => a.name === "o12-state-accepted"), "missing o12-state-accepted control");
});

// --- US-007 storm orchestrator/execution adaptation -------------------------

function stormState() {
  const receipt = contract.gateResults?.["US-007"] ?? null;
  const adaptationIds = (Array.isArray(contract.adaptations) ? contract.adaptations : [])
    .map((a) => a?.id)
    .filter((id) => typeof id === "string");
  return { receipt, adaptationIds };
}

test("live US-007 storm focused-gate state passes the adaptation validator", () => {
  const errors = validateStormAdaptation(stormState());
  assert.deepEqual(errors, []);
});

test("the contract records the focused storm gate with 0 red files and the base-seam test", () => {
  const receipt = contract.gateResults?.["US-007"];
  assert.ok(receipt, "gateResults.US-007 must be recorded");
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.focused_run?.file_count, EXPECTED_STORM_GATE_FILES);
  assert.equal(receipt.focused_run?.red_files, 0);
  assert.equal(receipt.focused_run?.fail, 0);
  assert.equal(receipt.product_file_changed, false);
  const baseSeam = receipt.entries?.find((e) => e.name === STORM_BASE_SEAMS_TEST);
  assert.ok(baseSeam, "the base-seam conformance entry must be recorded");
  assert.equal(baseSeam.exit_code, 0);
  assert.equal(baseSeam.fail, 0);
  assert.ok(baseSeam.tests >= 7);
});

test("every recorded US-007 focused-gate log exists and is non-empty", () => {
  const entries = contract.gateResults?.["US-007"]?.entries ?? [];
  assert.ok(entries.length > 0, "at least one focused-gate entry must be recorded");
  for (const entry of entries) {
    const abs = path.isAbsolute(entry.log) ? entry.log : path.join(REPO_ROOT, entry.log);
    assert.ok(fs.existsSync(abs), `retained log missing: ${entry.log}`);
    assert.ok(fs.statSync(abs).size > 0, `retained log is empty: ${entry.log}`);
  }
});

test("storm red arms all behave (corruptions rejected, live state accepted)", () => {
  const arms = runStormRedArms(stormState());
  assert.ok(arms.length >= 12, `expected several storm arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(failed, [], `storm arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`);
  assert.ok(arms.some((a) => a.name === "storm-state-accepted"), "missing storm-state-accepted control");
});

// --- US-008 core-recording / scripted-runtime adaptation ---------------------

function coreRecordingState() {
  const receipt = contract.gateResults?.["US-008"] ?? null;
  const adaptationIds = (Array.isArray(contract.adaptations) ? contract.adaptations : [])
    .map((a) => a?.id)
    .filter((id) => typeof id === "string");
  return { receipt, adaptationIds };
}

test("live US-008 core-recording focused-gate state passes the adaptation validator", () => {
  const errors = validateCoreRecordingAdaptation(coreRecordingState());
  assert.deepEqual(errors, []);
});

test("the contract records the focused core-recording gate with 18 files, 0 red and the four key tests green", () => {
  const receipt = contract.gateResults?.["US-008"];
  assert.ok(receipt, "gateResults.US-008 must be recorded");
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.focused_run?.file_count, EXPECTED_CORE_RECORDING_FILES);
  assert.equal(receipt.entries?.length, EXPECTED_CORE_RECORDING_FILES);
  assert.equal(receipt.focused_run?.red_files, 0);
  assert.equal(receipt.focused_run?.fail, 0);
  assert.equal(receipt.product_file_changed, false);
  for (const name of CORE_RECORDING_KEY_TESTS) {
    const entry = receipt.entries?.find((e) => e.name === name);
    assert.ok(entry, `key self-test ${name} must be recorded`);
    assert.equal(entry.exit_code, 0, `${name} must exit 0`);
    assert.equal(entry.fail, 0, `${name} must have no failures`);
    assert.ok(entry.tests > 0, `${name} must record tests`);
  }
});

test("the five US-008 adaptations are recorded in the contract", () => {
  const ids = (contract.adaptations ?? []).map((a) => a.id);
  for (const id of EXPECTED_CORE_RECORDING_ADAPTATION_IDS) {
    assert.ok(ids.includes(id), `missing adaptation ${id}`);
  }
});

test("every recorded US-008 core-recording log exists and is non-empty", () => {
  const entries = contract.gateResults?.["US-008"]?.entries ?? [];
  assert.ok(entries.length > 0, "at least one focused-run entry must be recorded");
  for (const entry of entries) {
    const abs = path.isAbsolute(entry.log) ? entry.log : path.join(REPO_ROOT, entry.log);
    assert.ok(fs.existsSync(abs), `retained log missing: ${entry.log}`);
    assert.ok(fs.statSync(abs).size > 0, `retained log is empty: ${entry.log}`);
  }
});

test("the ported runtimes carry the base seams they track", () => {
  const dsh = fs.readFileSync(path.join(REPO_ROOT, "torture-test", "scripted-runtimes", "runtime-dsh.mjs"), "utf8");
  assert.ok(dsh.includes("session.v3.jsonl.zstd"), "runtime-dsh.mjs must use the dsh v3 session format");
  assert.ok(!dsh.includes('"session.jsonl.zstd"'), "runtime-dsh.mjs must not write the pre-v3 session file");
  const pi = fs.readFileSync(path.join(REPO_ROOT, "torture-test", "scripted-runtimes", "runtime-pi.mjs"), "utf8");
  assert.ok(pi.includes('mode === "stream-die-before-claim"'), "runtime-pi.mjs must port stream-die-before-claim");
});

test("core-recording red arms all behave (corruptions rejected, live state accepted)", () => {
  const arms = runCoreRecordingRedArms(coreRecordingState());
  assert.ok(arms.length >= 14, `expected several core-recording arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(failed, [], `core-recording arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`);
  assert.ok(
    arms.some((a) => a.name === "core-recording-state-accepted"),
    "missing core-recording-state-accepted control",
  );
});

// --- US-009 self-tests-alone gate -------------------------------------------

function selfTestsAloneState() {
  const receipt = contract.gateResults?.["US-009"] ?? null;
  return { receipt };
}

test("live US-009 self-tests-alone gate state passes the validator", () => {
  const errors = validateSelfTestsAloneGate(selfTestsAloneState());
  assert.deepEqual(errors, []);
});

test("the contract records the self-tests-alone gate as 14/14 with the frozen group counts", () => {
  const receipt = contract.gateResults?.["US-009"];
  assert.ok(receipt, "gateResults.US-009 must be recorded");
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.guard_safe_repo_root, true);
  assert.equal(receipt.product_file_changed, false);
  assert.equal(receipt.all_exit_zero, true);
  assert.equal(receipt.total_required, EXPECTED_SELF_TESTS_ALONE_REQUIRED);
  assert.equal(receipt.passed_required, EXPECTED_SELF_TESTS_ALONE_REQUIRED);
  assert.equal(receipt.failed_required, 0);
  assert.deepEqual(receipt.red_files, []);
  assert.deepEqual(receipt.expected_counts, { ...EXPECTED_SELF_TESTS_ALONE_COUNTS });
  assert.equal(receipt.entries?.length, EXPECTED_SELF_TESTS_ALONE_ENTRIES);
  for (const [group, expected] of Object.entries(EXPECTED_SELF_TESTS_ALONE_COUNTS)) {
    assert.equal(receipt.by_group?.[group]?.total, expected, `by_group.${group}.total`);
    const gating = ["npf2", "aged", "o12"].includes(group);
    assert.equal(receipt.by_group?.[group]?.gating, gating, `by_group.${group}.gating`);
    if (gating) {
      assert.equal(receipt.by_group?.[group]?.passed, expected, `by_group.${group}.passed`);
      assert.equal(receipt.by_group?.[group]?.verdict, "PASS", `by_group.${group}.verdict`);
    }
  }
  assert.match(receipt.summary_path, /self-tests-alone-summary\.json$/);
});

test("the retained self-tests-alone summary exists and revalidates through the gate validator", () => {
  const receipt = contract.gateResults?.["US-009"];
  const summaryRel = receipt?.summary_path;
  assert.ok(typeof summaryRel === "string" && summaryRel.length > 0, "summary_path must be recorded");
  const summaryAbs = path.isAbsolute(summaryRel) ? summaryRel : path.join(REPO_ROOT, summaryRel);
  assert.ok(fs.existsSync(summaryAbs), `retained summary missing: ${summaryRel}`);
  const summary = JSON.parse(fs.readFileSync(summaryAbs, "utf8"));
  const validation = validateSelfTestsAloneSummary(summary);
  assert.equal(validation.ok, true, validation.problems.join("; "));
  assert.equal(summary.total_required, EXPECTED_SELF_TESTS_ALONE_REQUIRED);
  assert.equal(summary.passed_required, EXPECTED_SELF_TESTS_ALONE_REQUIRED);
  assert.equal(summary.environment?.guard_safe_repo_root, true);
  assert.equal(summary.by_group?.npf2?.total, EXPECTED_SELF_TESTS_ALONE_COUNTS.npf2);
  assert.equal(summary.by_group?.aged?.total, EXPECTED_SELF_TESTS_ALONE_COUNTS.aged);
  assert.equal(summary.by_group?.o12?.total, EXPECTED_SELF_TESTS_ALONE_COUNTS.o12);
  assert.equal(summary.by_group?.qualification?.total, EXPECTED_SELF_TESTS_ALONE_COUNTS.qualification);
});

test("every recorded US-009 per-entry stdout/stderr log exists (stdout non-empty)", () => {
  const entries = contract.gateResults?.["US-009"]?.entries ?? [];
  assert.ok(entries.length > 0, "at least one gate entry must be recorded");
  for (const entry of entries) {
    for (const key of ["stdout_log", "stderr_log"]) {
      const logPath = entry[key];
      assert.ok(typeof logPath === "string" && logPath.length > 0, `${entry.name} must record ${key}`);
      const abs = path.isAbsolute(logPath) ? logPath : path.join(REPO_ROOT, logPath);
      assert.ok(fs.existsSync(abs), `retained ${key} missing: ${logPath}`);
      if (key === "stdout_log") {
        assert.ok(fs.statSync(abs).size > 0, `retained stdout log is empty: ${logPath}`);
      }
    }
  }
});

test("self-tests-alone red arms all behave (corruptions rejected, live state accepted)", () => {
  const arms = runSelfTestsAloneRedArms(selfTestsAloneState());
  assert.ok(arms.length >= 16, `expected several self-tests-alone arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(failed, [], `self-tests-alone arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`);
  assert.ok(
    arms.some((a) => a.name === "self-tests-alone-state-accepted"),
    "missing self-tests-alone-state-accepted control",
  );
});

// --- US-010 49-file storm chain gate ----------------------------------------

function stormChainState() {
  const receipt = contract.gateResults?.["US-010"] ?? null;
  return { receipt };
}

test("live US-010 storm-chain gate state passes the validator", () => {
  const errors = validateStormChainGate(stormChainState());
  assert.deepEqual(errors, []);
});

test("the contract records the 49-file chain all exit 0 with zero red files and a PASS verdict", () => {
  const receipt = contract.gateResults?.["US-010"];
  assert.ok(receipt, "gateResults.US-010 must be recorded");
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.all_exit_zero, true);
  assert.equal(receipt.product_file_changed, false);
  assert.equal(receipt.guard_safe_repo_root, true);
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.file_count_expected, EXPECTED_STORM_CHAIN_FILE_COUNT);
  assert.equal(receipt.file_count_observed, EXPECTED_STORM_CHAIN_FILE_COUNT);
  assert.equal(receipt.red_file_count, 0);
  assert.equal(receipt.totals?.fail, 0);
  assert.equal(receipt.run7_chain_files_byte_match, true);
  assert.equal(receipt.entries?.length, EXPECTED_STORM_CHAIN_FILE_COUNT);
  assert.equal(receipt.expected?.file_count, RUN7_CHAIN_SHAPE.file_count);
  assert.equal(receipt.expected?.red_file_count, 0);
  assert.equal(receipt.expected?.verdict, "PASS");
  assert.ok(receipt.expected?.run7_shape, "the run #7 shape must be recorded");
  assert.equal(receipt.expected.run7_shape.tests, RUN7_CHAIN_SHAPE.tests);
  assert.equal(receipt.expected.run7_shape.pass, RUN7_CHAIN_SHAPE.pass);
  assert.equal(receipt.expected.run7_shape.fail, RUN7_CHAIN_SHAPE.fail);
  assert.equal(receipt.expected.run7_shape.skipped, RUN7_CHAIN_SHAPE.skipped);
  assert.ok(
    typeof receipt.differences_note === "string" && receipt.differences_note.length > 0,
    "every difference from the run #7 shape must be explained",
  );
  assert.match(receipt.summary_path, /chain-summary\.json$/);
});

test("the retained chain summary exists and revalidates through the chain validator", () => {
  const receipt = contract.gateResults?.["US-010"];
  const summaryRel = receipt?.summary_path;
  assert.ok(typeof summaryRel === "string" && summaryRel.length > 0, "summary_path must be recorded");
  const summaryAbs = path.isAbsolute(summaryRel) ? summaryRel : path.join(REPO_ROOT, summaryRel);
  assert.ok(fs.existsSync(summaryAbs), `retained summary missing: ${summaryRel}`);
  const summary = JSON.parse(fs.readFileSync(summaryAbs, "utf8"));
  const validation = validateChainSummary(summary);
  assert.equal(validation.ok, true, validation.problems.join("; "));
  assert.equal(summary.file_count_expected, EXPECTED_STORM_CHAIN_FILE_COUNT);
  assert.equal(summary.file_count_observed, EXPECTED_STORM_CHAIN_FILE_COUNT);
  assert.equal(summary.red_file_count, 0);
  assert.equal(summary.verdict, "PASS");
  assert.equal(summary.totals?.fail, 0);
  assert.equal(summary.run7_chain_files?.byte_match, true);
  for (const key of ["tests", "pass", "fail", "skipped"]) {
    assert.equal(summary.totals?.[key], receipt.totals?.[key], `summary/receipt totals.${key}`);
  }
  const resultsDir = path.isAbsolute(receipt.results_dir)
    ? receipt.results_dir
    : path.join(REPO_ROOT, receipt.results_dir);
  for (const artifact of [
    "chain-files.txt",
    "results.tsv",
    "chain-report.md",
    "lock-stat-before.txt",
    "lock-stat-after.txt",
  ]) {
    assert.ok(fs.existsSync(path.join(resultsDir, artifact)), `retained ${artifact}`);
  }
  assert.equal(
    fs.readFileSync(path.join(resultsDir, "results.tsv"), "utf8").trim().split("\n").length,
    EXPECTED_STORM_CHAIN_FILE_COUNT + 1,
  );
});

test("every recorded US-010 chain entry is green and names a real chain file", () => {
  const entries = contract.gateResults?.["US-010"]?.entries ?? [];
  assert.equal(entries.length, EXPECTED_STORM_CHAIN_FILE_COUNT);
  for (const entry of entries) {
    assert.match(entry.file, /^torture-test\/self-tests\/.*\.test\.ts$/, `chain-shaped path: ${entry.file}`);
    assert.equal(entry.rc, 0, `${entry.file} rc`);
    assert.equal(entry.fail, 0, `${entry.file} fail`);
    assert.ok(Number.isFinite(entry.tests) && entry.tests >= 0, `${entry.file} tests`);
  }
});

test("storm-chain red arms all behave (corruptions rejected, live state accepted)", () => {
  const arms = runStormChainRedArms(stormChainState());
  assert.ok(arms.length >= 15, `expected several storm-chain arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(failed, [], `storm-chain arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`);
  assert.ok(
    arms.some((a) => a.name === "storm-chain-state-accepted"),
    "missing storm-chain-state-accepted control",
  );
});

// --- US-011 full torture battery gate ---------------------------------------

function tortureBatteryState() {
  const receipt = contract.gateResults?.["US-011"] ?? null;
  return { receipt };
}

test("live US-011 battery gate state passes the validator", () => {
  const errors = validateTortureBatteryGate(tortureBatteryState());
  assert.deepEqual(errors, []);
});

test("the live battery selection is the previous shape plus the enumerated additions", () => {
  const selection = deriveBatterySelection();
  assert.equal(selection.excluded_count, EXPECTED_BATTERY_EXCLUDED_HEAVY);
  assert.equal(selection.heavy.length, EXPECTED_BATTERY_EXCLUDED_HEAVY);
  assert.equal(
    selection.passed_count,
    PREVIOUS_BATTERY_SHAPE.passed + EXPECTED_BATTERY_NEW_SINCE_PREVIOUS.length,
    "the live non-heavy selection must equal the previous green shape plus every enumerated addition",
  );
  for (const rel of EXPECTED_BATTERY_NEW_SINCE_PREVIOUS) {
    const base = rel.replace("torture-test/self-tests/", "");
    assert.ok(selection.passed.includes(base), `live selection missing enumerated addition ${rel}`);
  }
});

test("the contract records the battery gate, the previous shape and the enumerated delta", () => {
  const receipt = contract.gateResults?.["US-011"];
  assert.ok(receipt, "gateResults.US-011 must be recorded");
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.all_exit_zero, true);
  assert.equal(receipt.product_file_changed, false);
  assert.equal(receipt.guard_safe_repo_root, true);
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.observed?.failed, 0);
  assert.equal(receipt.observed?.excluded_heavy, EXPECTED_BATTERY_EXCLUDED_HEAVY);
  assert.equal(receipt.observed?.file_records, receipt.observed?.passed);
  assert.equal(receipt.previous_green_shape?.passed, PREVIOUS_BATTERY_SHAPE.passed);
  assert.equal(receipt.previous_green_shape?.failed, PREVIOUS_BATTERY_SHAPE.failed);
  assert.equal(receipt.previous_green_shape?.excluded_heavy, PREVIOUS_BATTERY_SHAPE.excluded_heavy);
  assert.equal(receipt.previous_green_shape?.commit, PREVIOUS_BATTERY_SHAPE.commit);
  assert.deepEqual(receipt.new_since_previous, [...EXPECTED_BATTERY_NEW_SINCE_PREVIOUS]);
  assert.equal(
    receipt.observed.passed,
    PREVIOUS_BATTERY_SHAPE.passed + receipt.new_since_previous.length,
    "every difference from the previous shape is enumerated",
  );
  assert.ok(receipt.wall_time_seconds > 0, "wall time must be recorded");
  assert.ok(typeof receipt.counts_note === "string" && receipt.counts_note.length > 0);
  assert.match(receipt.summary_path, /battery-summary\.json$/);
  assert.match(receipt.full_log_path, /full\.log$/);
});

test("the retained battery summary and full log carry the exact run.sh outcome", () => {
  const receipt = contract.gateResults?.["US-011"];
  const summaryAbs = path.isAbsolute(receipt.summary_path)
    ? receipt.summary_path
    : path.join(REPO_ROOT, receipt.summary_path);
  assert.ok(fs.existsSync(summaryAbs), `retained summary missing: ${receipt.summary_path}`);
  const summary = JSON.parse(fs.readFileSync(summaryAbs, "utf8"));
  assert.equal(summary.kind, "torture-battery-summary");
  assert.equal(summary.exit_code, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.verdict, "PASS");
  assert.equal(summary.passed, receipt.observed.passed);
  assert.equal(summary.excluded_heavy, receipt.observed.excluded_heavy);
  assert.equal(summary.guard_safe_repo_root, true);

  const logAbs = path.isAbsolute(receipt.full_log_path)
    ? receipt.full_log_path
    : path.join(REPO_ROOT, receipt.full_log_path);
  assert.ok(fs.existsSync(logAbs), `retained full log missing: ${receipt.full_log_path}`);
  assert.ok(fs.statSync(logAbs).size > 0, "retained full log is empty");
  const logText = fs.readFileSync(logAbs, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(
    logText.includes(`=== Results: ${receipt.observed.passed} passed, 0 failed ===`),
    "the retained log must carry the exact run.sh results line",
  );
  assert.equal(
    (logText.match(/skip \(heavy\/isolated\):/g) ?? []).length,
    EXPECTED_BATTERY_EXCLUDED_HEAVY,
    "the retained log must show the frozen heavy-campaign exclusions",
  );
  assert.match(logText, /Working tree: clean/);

  const resultsDir = path.isAbsolute(receipt.results_dir)
    ? receipt.results_dir
    : path.join(REPO_ROOT, receipt.results_dir);
  for (const artifact of ["full.log", "battery-summary.json", "battery-meta.log", "battery-runner.sh"]) {
    assert.ok(fs.existsSync(path.join(resultsDir, artifact)), `retained artifact missing: ${artifact}`);
  }
});

test("battery red arms all behave (corruptions rejected, live state accepted)", () => {
  const arms = runTortureBatteryRedArms(tortureBatteryState());
  assert.ok(arms.length >= 18, `expected several battery arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(failed, [], `battery arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`);
  assert.ok(
    arms.some((a) => a.name === "battery-state-accepted"),
    "missing battery-state-accepted control",
  );
});

// --- US-012 product build + two-lane unit suite gate ------------------------

function productSuiteState() {
  const receipt = contract.gateResults?.["US-012"] ?? null;
  return { receipt };
}

test("live US-012 product-suite gate state passes the validator", () => {
  const errors = validateProductSuiteGate(productSuiteState());
  assert.deepEqual(errors, []);
});

test("the contract records a green build and both lanes with the frozen counts", () => {
  const receipt = contract.gateResults?.["US-012"];
  assert.ok(receipt, "gateResults.US-012 must be recorded");
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.all_exit_zero, true);
  assert.equal(receipt.product_file_changed, false);
  assert.equal(receipt.build?.exit_code, 0);
  assert.match(receipt.build?.head ?? "", /^[0-9a-f]{40}$/);
  assert.equal(receipt.suite?.exit_code, 0);
  assert.match(receipt.suite?.tree_hash ?? "", /^[0-9a-f]{40}$/);
  assert.equal(receipt.suite?.cached, false, "the story commit ran a real uncached suite");
  assert.equal(receipt.suite?.prior_cached_execution?.real_execution, true);
  const lanes = receipt.suite?.lanes ?? {};
  assert.deepEqual(
    { tests: lanes.serial?.tests, pass: lanes.serial?.pass, fail: lanes.serial?.fail, skipped: lanes.serial?.skipped },
    EXPECTED_SERIAL_LANE,
  );
  assert.deepEqual(
    { tests: lanes.parallel?.tests, pass: lanes.parallel?.pass, fail: lanes.parallel?.fail, skipped: lanes.parallel?.skipped },
    EXPECTED_PARALLEL_LANE,
  );
  assert.equal(lanes.serial?.verdict, "PASSED");
  assert.equal(lanes.parallel?.verdict, "PASSED");
  assert.equal(receipt.product_scope?.base_ref, "6e5f2427");
  assert.deepEqual(receipt.product_scope?.changed, []);
  assert.equal(receipt.product_scope?.clean, true);
  assert.ok(receipt.wall_time_seconds > 0, "wall time must be recorded");
  assert.match(receipt.build?.log ?? "", /\.log$/);
  assert.match(receipt.suite?.log ?? "", /\.log$/);
});

test("the retained build and suite logs carry the exact outcome and lane verdicts", () => {
  const receipt = contract.gateResults?.["US-012"];
  const buildAbs = path.isAbsolute(receipt.build.log)
    ? receipt.build.log
    : path.join(REPO_ROOT, receipt.build.log);
  assert.ok(fs.existsSync(buildAbs), `retained build log missing: ${receipt.build.log}`);
  const buildText = fs.readFileSync(buildAbs, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(buildText.includes("BUILD_RC=0"), "build log must record BUILD_RC=0");
  assert.match(buildText, /npm run build/);

  const suiteAbs = path.isAbsolute(receipt.suite.log)
    ? receipt.suite.log
    : path.join(REPO_ROOT, receipt.suite.log);
  assert.ok(fs.existsSync(suiteAbs), `retained suite log missing: ${receipt.suite.log}`);
  const logText = fs.readFileSync(suiteAbs, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(logText.includes("TEST_RC=0"), "suite log must record TEST_RC=0");
  assert.doesNotMatch(logText, /TAMANDUA-TEST CACHED/, "a real run must not show a cache replay");
  assert.match(logText, />>> SERIAL lane: PASSED|Serial lane:\s+PASSED/);
  assert.match(logText, />>> PARALLEL lane: PASSED|Parallel lane:\s+PASSED/);
  for (const [name, lane] of [
    ["serial", EXPECTED_SERIAL_LANE],
    ["parallel", EXPECTED_PARALLEL_LANE],
  ]) {
    for (const key of ["tests", "pass", "fail", "skipped"]) {
      assert.match(
        logText,
        new RegExp(`${key} ${lane[key]}\\b`),
        `suite log must report ${name} ${key} ${lane[key]}`,
      );
    }
  }
});

test("the live product scope has no change outside torture-test/", () => {
  const receipt = contract.gateResults?.["US-012"];
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "6e5f2427", "--", ".", ":(exclude)torture-test"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  assert.deepEqual(changed, []);
  assert.deepEqual(receipt.product_scope?.changed, []);
});

test("product-suite red arms all behave (corruptions rejected, live state accepted)", () => {
  const arms = runProductSuiteRedArms(productSuiteState());
  assert.ok(arms.length >= 28, `expected several product-suite arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(
    failed,
    [],
    `product-suite arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`,
  );
  assert.ok(
    arms.some((a) => a.name === "product-suite-state-accepted"),
    "missing product-suite-state-accepted control",
  );
});

// --- US-013 final contract: every gate result + final scope audit ----------

function gatesState() {
  return {
    gateResults: contract.gateResults ?? {},
    finalScopeAudit: contract.finalScopeAudit ?? null,
  };
}

const ALL_CHECK_NAMES = [
  "contract",
  "overlay",
  "environment",
  "aged",
  "o12",
  "storm",
  "core-recording",
  "self-tests-alone",
  "storm-chain",
  "battery",
  "product-suite",
  "gates",
];

test("live US-013 gates state passes the validator", () => {
  const errors = validateGates(gatesState());
  assert.deepEqual(errors, []);
});

test("the contract records every required gate result with result PASS", () => {
  for (const id of REQUIRED_GATE_IDS) {
    const receipt = contract.gateResults?.[id];
    assert.ok(receipt, `gateResults.${id} must be recorded`);
    assert.equal(receipt.result, "PASS", `gateResults.${id}.result`);
    assert.ok(
      typeof receipt.story === "string" && receipt.story.length > 0,
      `gateResults.${id}.story`,
    );
  }
  // US-003..US-008 are presence/PASS only; US-009..US-012 carry the counts.
  for (const id of ["US-009", "US-010", "US-011", "US-012"]) {
    assert.equal(contract.gateResults[id].all_exit_zero, true, `${id}.all_exit_zero`);
    assert.equal(contract.gateResults[id].product_file_changed, false, `${id}.product_file_changed`);
  }
});

test("the contract records the four headline gate counts", () => {
  const summary = gateSummaryFromContract(contract);
  assert.deepEqual(summary, EXPECTED_GATE_SUMMARY);
  // And the raw receipt fields the acceptance criteria name.
  assert.equal(contract.gateResults["US-009"].total_required, 14);
  assert.equal(contract.gateResults["US-009"].passed_required, 14);
  assert.deepEqual(contract.gateResults["US-009"].red_files, []);
  assert.equal(contract.gateResults["US-010"].file_count_observed, 49);
  assert.equal(contract.gateResults["US-010"].red_file_count, 0);
  assert.equal(contract.gateResults["US-011"].observed.failed, 0);
  assert.equal(contract.gateResults["US-011"].observed.excluded_heavy, 18);
  assert.equal(contract.gateResults["US-012"].build.exit_code, 0);
  assert.equal(contract.gateResults["US-012"].suite.exit_code, 0);
  assert.equal(contract.gateResults["US-012"].suite.lanes.serial.verdict, "PASSED");
  assert.equal(contract.gateResults["US-012"].suite.lanes.parallel.verdict, "PASSED");
});

test("the contract records an empty final scope audit against BASE 6e5f2427", () => {
  const audit = contract.finalScopeAudit;
  assert.ok(audit, "finalScopeAudit must be recorded");
  assert.equal(audit.base_ref, "6e5f2427");
  assert.deepEqual(audit.changed, []);
  assert.equal(audit.changed_count, 0);
  assert.equal(audit.scope_clean, true);
  assert.match(audit.command, /git diff --name-only 6e5f2427/);
  assert.match(audit.command, /exclude\)torture-test/);
});

test("the live product scope has no change outside torture-test/ (US-013)", () => {
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "6e5f2427", "--", ".", ":(exclude)torture-test"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  assert.deepEqual(changed, []);
  assert.deepEqual(contract.finalScopeAudit?.changed, []);
});

test("gates red arms all behave, including a missing gate result", () => {
  const arms = runGatesRedArms(gatesState());
  assert.ok(arms.length >= 20, `expected several gates arms, got ${arms.length}`);
  const failed = arms.filter((a) => !a.ok);
  assert.deepEqual(
    failed,
    [],
    `gates arms that misbehaved: ${failed.map((a) => a.name).join(", ")}`,
  );
  for (const name of [
    "missing-gate-result-US-009",
    "missing-gate-result-US-010",
    "missing-gate-result-US-011",
    "missing-gate-result-US-012",
  ]) {
    assert.ok(
      arms.some((a) => a.name === name && a.ok),
      `the ${name} red arm must be present and rejected`,
    );
  }
  assert.ok(arms.some((a) => a.name === "gates-state-accepted"), "missing gates-state-accepted control");
});

test("--check gates and --check all exit 0 via the CLI", () => {
  const script = path.join(REPO_ROOT, "torture-test", "impl-tasks", "torture-port-verify.mjs");
  const gatesOut = execFileSync(process.execPath, [script, "--check", "gates"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.match(gatesOut, /gates validation: PASS/);
  assert.match(gatesOut, /missing-gate-result-US-011 — rejected as expected/);

  const allOut = execFileSync(process.execPath, [script, "--check", "all"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.match(allOut, /--check all: 12\/12 checks PASS/);
  for (const name of ALL_CHECK_NAMES) {
    assert.match(allOut, new RegExp(`all-check PASS: ${name.replace(/[-/]/g, "\\$&")}`));
  }
});
