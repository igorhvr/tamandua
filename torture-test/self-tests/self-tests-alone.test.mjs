#!/usr/bin/env node

// self-tests-alone.test.mjs — focused test for the NPF-2 "self-tests alone"
// gate machinery (US-010).
//
// Unit-tests the pure selection/report shaping and validation, source-asserts
// the runner's gate env (no ambient TAMANDUA_* authority, guard=1, /usr/bin/false
// harnesses), and (when a retained gate run exists) validates the newest
// `self-tests-alone-summary.json` (override with
// TAMANDUA_SELF_TESTS_ALONE_RESULTS=<dir>). It never spawns a test file and
// never writes into torture-test/var.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AGED_ENTRIES,
  EXPECTED_COUNTS,
  EXPECTED_REQUIRED_TOTAL,
  GROUPS,
  INFORMATIONAL_GROUPS,
  NPF2_ENTRIES,
  O12_ENTRIES,
  QUALIFICATION_ENTRIES,
  REQUIRED_GROUPS,
  summarizeSelfTestsAlone,
  validateSelfTestsAloneSummary,
} from "./self-tests-alone-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const RESULTS_BASE = path.join(TT_ROOT, "var", "results");
const RUNNER_PATH = path.join(HERE, "run-self-tests-alone.mjs");

function selectionEntries({ red = null } = {}) {
  const entries = [];
  for (const definition of NPF2_ENTRIES) {
    entries.push({ ...definition, exit_code: 0, totals: { pass: 1, fail: 0 } });
  }
  for (const rel of AGED_ENTRIES) {
    entries.push({ name: path.basename(rel), group: "aged", kind: "test", rel, exit_code: 0 });
  }
  for (const definition of O12_ENTRIES) {
    entries.push({ group: "o12", ...definition, exit_code: 0 });
  }
  for (const rel of QUALIFICATION_ENTRIES) {
    entries.push({ name: path.basename(rel), group: "qualification", kind: "test", rel, exit_code: 0 });
  }
  if (red) {
    const target = entries.find((entry) => entry.name === red);
    assert.ok(target, `red fixture entry exists: ${red}`);
    target.exit_code = 1;
  }
  return entries;
}

function greenSummary() {
  const entries = selectionEntries();
  return {
    kind: "self-tests-alone-summary",
    repo_root: REPO_ROOT,
    git_head: "a".repeat(40),
    environment: { guard_safe_repo_root: true },
    entries,
    ...summarizeSelfTestsAlone(entries),
  };
}

test("the frozen selection is unique, on disk, and split into gating + informational groups", () => {
  assert.deepEqual([...REQUIRED_GROUPS], ["npf2", "aged", "o12"]);
  assert.deepEqual([...INFORMATIONAL_GROUPS], ["qualification"]);
  assert.deepEqual([...GROUPS], ["npf2", "aged", "o12", "qualification"]);

  assert.equal(NPF2_ENTRIES.length, 2, "NPF-2 runs the positive and negative halves");
  const halves = NPF2_ENTRIES.map((entry) => entry.half).sort();
  assert.deepEqual(halves, ["negative", "positive"]);
  for (const entry of NPF2_ENTRIES) {
    assert.equal(entry.rel, "torture-test/self-tests/tier2-storm-rehearsal-suite-ledger-e2e.test.ts");
    assert.match(entry.test_name_pattern, /P[0-9]/, `a test-name-pattern selects the ${entry.half} half`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, entry.rel)), `NPF-2 entry exists: ${entry.rel}`);
  }

  for (const rel of AGED_ENTRIES) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `aged entry exists: ${rel}`);
  }
  for (const definition of O12_ENTRIES) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, definition.rel)), `O12 entry exists: ${definition.rel}`);
  }
  for (const rel of QUALIFICATION_ENTRIES) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `qualification entry exists: ${rel}`);
  }

  const allNames = [...selectionEntries().map((entry) => entry.name)];
  assert.equal(new Set(allNames).size, allNames.length, "entry names are unique");

  assert.equal(EXPECTED_COUNTS.npf2, 2);
  assert.equal(EXPECTED_COUNTS.aged, 4, "the four change-owned aged self-tests");
  assert.equal(EXPECTED_COUNTS.o12, 8, "every O12 self-test entry");
  assert.equal(EXPECTED_COUNTS.qualification, 1);
  assert.equal(EXPECTED_REQUIRED_TOTAL, 14);
});

test("summarizeSelfTestsAlone totals each group honestly and never gates on the qualification group", () => {
  const green = summarizeSelfTestsAlone(selectionEntries());
  assert.equal(green.kind, "self-tests-alone-summary");
  assert.equal(green.verdict, "PASS");
  assert.equal(green.total_required, EXPECTED_REQUIRED_TOTAL);
  assert.equal(green.failed_required, 0);
  for (const group of REQUIRED_GROUPS) {
    assert.equal(green.by_group[group].total, EXPECTED_COUNTS[group], `${group} expected size`);
    assert.equal(green.by_group[group].verdict, "PASS");
    assert.equal(green.by_group[group].gating, true);
  }
  assert.equal(green.by_group.qualification.gating, false);

  // A red NPF-2 half fails the gate.
  const redNpf2 = summarizeSelfTestsAlone(selectionEntries({ red: "npf2-negative" }));
  assert.equal(redNpf2.verdict, "FAIL");
  assert.equal(redNpf2.by_group.npf2.verdict, "FAIL");
  assert.deepEqual(redNpf2.red_files, ["npf2-negative"]);

  // A red aged self-test fails the gate.
  const redAged = summarizeSelfTestsAlone(selectionEntries({ red: "aged-core.test.mjs" }));
  assert.equal(redAged.verdict, "FAIL");
  assert.equal(redAged.by_group.aged.verdict, "FAIL");
  assert.equal(redAged.by_group.npf2.verdict, "PASS");

  // A red qualification entry is RECORDED but does NOT fail the gate (US-012 owns it).
  const redQualification = summarizeSelfTestsAlone(selectionEntries({ red: "seed-readiness.test.mjs" }));
  assert.equal(redQualification.verdict, "PASS", "the informational qualification group never gates");
  assert.equal(redQualification.by_group.qualification.verdict, "FAIL");
  assert.equal(redQualification.by_group.qualification.failed, 1);
  assert.deepEqual(redQualification.red_files, []);
});

test("validateSelfTestsAloneSummary accepts a green gate and rejects drift", () => {
  const accepted = validateSelfTestsAloneSummary(greenSummary());
  assert.equal(accepted.ok, true, accepted.problems.join("; "));

  const redNpf2 = greenSummary();
  redNpf2.entries.find((entry) => entry.name === "npf2-positive").exit_code = 1;
  Object.assign(redNpf2, summarizeSelfTestsAlone(redNpf2.entries));
  assert.equal(validateSelfTestsAloneSummary(redNpf2).ok, false);

  const redAged = greenSummary();
  redAged.entries.find((entry) => entry.name === "aged-core.test.mjs").exit_code = 1;
  Object.assign(redAged, summarizeSelfTestsAlone(redAged.entries));
  assert.equal(validateSelfTestsAloneSummary(redAged).ok, false);

  // A red qualification entry alone must NOT invalidate a green gate.
  const redQualification = greenSummary();
  redQualification.entries.find((entry) => entry.name === "seed-readiness.test.mjs").exit_code = 1;
  Object.assign(redQualification, summarizeSelfTestsAlone(redQualification.entries));
  const qualificationValidation = validateSelfTestsAloneSummary(redQualification);
  assert.equal(qualificationValidation.ok, true, qualificationValidation.problems.join("; "));

  const missingHalf = greenSummary();
  missingHalf.entries = missingHalf.entries.filter((entry) => entry.half !== "negative");
  Object.assign(missingHalf, summarizeSelfTestsAlone(missingHalf.entries));
  const missingValidation = validateSelfTestsAloneSummary(missingHalf);
  assert.equal(missingValidation.ok, false);
  assert.ok(missingValidation.problems.some((problem) => problem.includes("npf2 entry count")));

  const missingQualification = greenSummary();
  missingQualification.entries = missingQualification.entries.filter((entry) => entry.group !== "qualification");
  Object.assign(missingQualification, summarizeSelfTestsAlone(missingQualification.entries));
  const missingQualificationValidation = validateSelfTestsAloneSummary(missingQualification);
  assert.equal(missingQualificationValidation.ok, false);
  assert.ok(missingQualificationValidation.problems.some((problem) => problem.includes("qualification entry count")));

  const unsafe = greenSummary();
  unsafe.environment = { guard_safe_repo_root: false };
  const unsafeValidation = validateSelfTestsAloneSummary(unsafe);
  assert.equal(unsafeValidation.ok, false);
  assert.ok(unsafeValidation.problems.some((problem) => problem.includes("guard-safe")));

  const wrongVerdict = { ...greenSummary(), verdict: "FAIL" };
  assert.equal(validateSelfTestsAloneSummary(wrongVerdict).ok, false);

  assert.equal(validateSelfTestsAloneSummary(null).ok, false);
  assert.equal(validateSelfTestsAloneSummary({ kind: "self-tests-alone-summary" }).ok, false);
});

test("the runner strips ambient TAMANDUA_* authority and pins the gate env + private TMPDIR", () => {
  const source = fs.readFileSync(RUNNER_PATH, "utf8");
  assert.match(source, /key\.startsWith\("TAMANDUA_"\)/, "the runner strips every ambient TAMANDUA_* key");
  assert.match(source, /TAMANDUA_TEST_GUARD = "1"/);
  assert.match(source, /TAMANDUA_PI_BINARY = FALSE_HARNESS/);
  assert.match(source, /TAMANDUA_HERMES_BINARY = FALSE_HARNESS/);
  assert.match(source, /TAMANDUA_DSH_BINARY = FALSE_HARNESS/);
  assert.match(source, /FALSE_HARNESS = "\/usr\/bin\/false"/);
  assert.match(source, /env\.TMPDIR = tmpdir/, "each entry gets its own private TMPDIR");
  assert.match(source, /--test-name-pattern=\$\{entry\.test_name_pattern\}/, "NPF-2 halves are selected by pattern");
  assert.match(source, /isUnderRealState\(REPO_ROOT\)/, "the runner refuses a non-guard-safe repo root");
  assert.match(source, /kind: "self-tests-alone-summary"/);
  assert.match(source, /self-tests-alone-summary\.json/);
  assert.match(source, /results\.tsv/);
  assert.match(source, /process\.exit\(1\)/, "a red gate exits non-zero");
});

test("retained self-tests-alone run (when present) is a green, honest report", () => {
  const explicit = process.env.TAMANDUA_SELF_TESTS_ALONE_RESULTS;
  let resultsDir = explicit ? path.resolve(explicit) : null;
  if (!resultsDir && fs.existsSync(RESULTS_BASE)) {
    const candidates = fs
      .readdirSync(RESULTS_BASE)
      .filter((name) => name.startsWith("self-tests-alone-"))
      .map((name) => path.join(RESULTS_BASE, name))
      .map((dir) => {
        const summaryPath = path.join(dir, "self-tests-alone-summary.json");
        if (!fs.existsSync(summaryPath)) return null;
        return {
          dir,
          mtime: fs.statSync(summaryPath).mtimeMs,
          summary: JSON.parse(fs.readFileSync(summaryPath, "utf8")),
        };
      })
      .filter((candidate) => candidate !== null)
      .sort((a, b) => b.mtime - a.mtime);
    resultsDir = candidates[0]?.dir ?? null;
  }
  if (!resultsDir) {
    process.stderr.write("no retained self-tests-alone run found; skipping retained-report assertions\n");
    return;
  }

  const summary = JSON.parse(fs.readFileSync(path.join(resultsDir, "self-tests-alone-summary.json"), "utf8"));
  const validation = validateSelfTestsAloneSummary(summary);
  assert.equal(validation.ok, true, validation.problems.join("; "));
  assert.equal(summary.verdict, "PASS", JSON.stringify(summary.red_files));
  assert.equal(summary.total_required, EXPECTED_REQUIRED_TOTAL);
  assert.equal(summary.by_group.npf2.total, 2);
  assert.equal(summary.by_group.npf2.passed, 2);
  assert.equal(summary.by_group.aged.total, EXPECTED_COUNTS.aged);
  assert.equal(summary.by_group.o12.total, EXPECTED_COUNTS.o12);
  assert.equal(summary.environment.guard_safe_repo_root, true);
  assert.ok(typeof summary.git_head === "string" && /^[0-9a-f]{40}$/.test(summary.git_head), "the gate records its gate-worktree HEAD");
  assert.ok(fs.existsSync(path.join(resultsDir, "results.tsv")), "results.tsv retained");
  for (const entry of summary.entries) {
    assert.ok(entry.stdout_log && fs.existsSync(entry.stdout_log), `stdout log retained: ${entry.name}`);
    assert.ok(entry.stderr_log && fs.existsSync(entry.stderr_log), `stderr log retained: ${entry.name}`);
    assert.ok(typeof entry.private_tmpdir === "string" && path.isAbsolute(entry.private_tmpdir), `private TMPDIR recorded: ${entry.name}`);
  }
});
