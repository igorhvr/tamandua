#!/usr/bin/env node

// pre-arm-gate-battery.test.mjs — focused test for the O12-REPIN pre-arm gate
// battery selection/report machinery (Storm O12-REPIN US-007).
//
// Unit-tests the pure report shaping/validation and the frozen selection, and
// (when a retained battery run exists) validates the newest
// `pre-arm-gate-battery-summary.json` (override the results base with
// TAMANDUA_PRE_ARM_GATE_RESULTS=<dir>). It never spawns a test file and never
// writes into torture-test/var.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AGED_ENTRIES,
  EXPECTED_COUNTS,
  GROUPS,
  O12_ENTRIES,
  STORM_CHAIN_49,
  summarizeBattery,
  validateBatterySummary,
} from "./pre-arm-gate-battery-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const RESULTS_BASE = path.join(TT_ROOT, "var", "results");

const READINESS_CANDIDATES = [
  process.env.FIX9_READINESS_PATH,
  "/home/kaladin/matchlock-work/storm-rehearsal-fix9-readiness.json",
  "/root/matchlock-work/storm-rehearsal-fix9-readiness.json",
].filter(Boolean);

function selectionEntries({ red = null } = {}) {
  const entries = [];
  for (const rel of AGED_ENTRIES) {
    entries.push({ name: path.basename(rel), group: "aged", kind: "test", rel, exit_code: 0 });
  }
  for (const definition of O12_ENTRIES) {
    entries.push({ group: "o12", ...definition, exit_code: 0 });
  }
  for (const rel of STORM_CHAIN_49) {
    entries.push({ name: path.basename(rel), group: "storm", kind: "test", rel, exit_code: 0 });
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
    kind: "pre-arm-gate-battery-summary",
    repo_root: REPO_ROOT,
    environment: { guard_safe_repo_root: true },
    entries,
    ...summarizeBattery(entries),
  };
}

test("summarizeBattery totals each group and the battery honestly", () => {
  const green = summarizeBattery(selectionEntries());
  assert.equal(green.verdict, "PASS");
  assert.equal(green.total, EXPECTED_COUNTS.total);
  assert.equal(green.total, EXPECTED_COUNTS.aged + EXPECTED_COUNTS.o12 + EXPECTED_COUNTS.storm);
  assert.equal(green.failed, 0);
  for (const group of GROUPS) {
    assert.equal(green.by_group[group].total, EXPECTED_COUNTS[group], `${group} expected size`);
    assert.equal(green.by_group[group].verdict, "PASS");
  }

  const red = summarizeBattery(selectionEntries({ red: STORM_CHAIN_49[0].split("/").pop() }));
  assert.equal(red.verdict, "FAIL");
  assert.equal(red.failed, 1);
  assert.equal(red.by_group.storm.verdict, "FAIL");
  assert.equal(red.by_group.storm.failed, 1);
  assert.deepEqual(red.red_files, [STORM_CHAIN_49[0].split("/").pop()]);
  assert.equal(red.by_group.aged.verdict, "PASS");
});

test("the frozen selection is unique, on disk and storm-shaped", () => {
  assert.equal(STORM_CHAIN_49.length, 49);
  assert.equal(new Set(STORM_CHAIN_49).size, 49, "storm chain entries are unique");
  for (const rel of STORM_CHAIN_49) {
    assert.match(rel, /^torture-test\/self-tests\/.*\.test\.ts$/, `storm-shaped path: ${rel}`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `storm chain member exists: ${rel}`);
  }
  for (const rel of AGED_ENTRIES) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `aged entry exists: ${rel}`);
  }
  for (const definition of O12_ENTRIES) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, definition.rel)), `O12 entry exists: ${definition.rel}`);
  }
  const o12Names = O12_ENTRIES.map((entry) => entry.name);
  for (const required of [
    "o12.test.mjs",
    "o12-reserved-key-probe.mjs",
    "o12-run-number-probe.mjs",
    "o12-run-number-allocator-calibration.mjs",
  ]) {
    assert.ok(o12Names.includes(required), `O12 battery includes ${required}`);
  }
});

test("the frozen 49 match run #7's published test_cmd_extended selection when present", () => {
  const readinessPath = READINESS_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!readinessPath) return;
  const readiness = JSON.parse(fs.readFileSync(readinessPath, "utf8"));
  const files = [];
  const re = /node --test (\S+)/g;
  let match = re.exec(readiness.test_cmd_extended ?? "");
  while (match) {
    files.push(match[1]);
    match = re.exec(readiness.test_cmd_extended ?? "");
  }
  assert.equal(files.length, 49, "run #7 chain selection has 49 files");
  assert.deepEqual([...STORM_CHAIN_49], files, "battery storm chain == run #7 test_cmd_extended");
});

test("validateBatterySummary accepts a green battery and rejects drift", () => {
  const green = greenSummary();
  const accepted = validateBatterySummary(green);
  assert.equal(accepted.ok, true, accepted.problems.join("; "));

  const red = greenSummary();
  red.entries.find((entry) => entry.group === "storm").exit_code = 1;
  const summarized = { ...red, ...summarizeBattery(red.entries) };
  assert.equal(validateBatterySummary(summarized).ok, false);

  const shortStorm = greenSummary();
  shortStorm.entries = shortStorm.entries.filter((entry) => !(entry.group === "storm" && entry.rel === STORM_CHAIN_49[10]));
  const shortSummary = { ...shortStorm, ...summarizeBattery(shortStorm.entries) };
  const shortValidation = validateBatterySummary(shortSummary);
  assert.equal(shortValidation.ok, false);
  assert.ok(shortValidation.problems.some((problem) => problem.includes("storm entry count")));

  const unsafe = greenSummary();
  unsafe.environment = { guard_safe_repo_root: false };
  const unsafeValidation = validateBatterySummary(unsafe);
  assert.equal(unsafeValidation.ok, false);
  assert.ok(unsafeValidation.problems.some((problem) => problem.includes("guard-safe")));

  const wrongVerdict = { ...greenSummary(), verdict: "FAIL" };
  assert.equal(validateBatterySummary(wrongVerdict).ok, false);

  assert.equal(validateBatterySummary(null).ok, false);
});

test("retained pre-arm gate battery run (when present) is a green, honest report", () => {
  const explicit = process.env.TAMANDUA_PRE_ARM_GATE_RESULTS;
  let resultsDir = explicit ? path.resolve(explicit) : null;
  if (!resultsDir && fs.existsSync(RESULTS_BASE)) {
    const candidates = fs.readdirSync(RESULTS_BASE)
      .filter((name) => name.startsWith("pre-arm-gate-battery-"))
      .map((name) => path.join(RESULTS_BASE, name))
      .map((dir) => {
        const summaryPath = path.join(dir, "pre-arm-gate-battery-summary.json");
        if (!fs.existsSync(summaryPath)) return null;
        return { dir, mtime: fs.statSync(summaryPath).mtimeMs, summary: JSON.parse(fs.readFileSync(summaryPath, "utf8")) };
      })
      .filter((candidate) => candidate !== null)
      // Only a FULL battery (scope all) covers all three groups; partial-scope
      // probe runs (aged-only / O12-only) are not held to the full contract.
      .filter((candidate) => candidate.summary.scope === "all")
      .sort((a, b) => b.mtime - a.mtime);
    resultsDir = candidates[0]?.dir ?? null;
  }
  if (!resultsDir) {
    process.stderr.write("no retained pre-arm gate battery run found; skipping retained-report assertions\n");
    return;
  }
  const summary = JSON.parse(fs.readFileSync(path.join(resultsDir, "pre-arm-gate-battery-summary.json"), "utf8"));
  const validation = validateBatterySummary(summary);
  assert.equal(validation.ok, true, validation.problems.join("; "));
  assert.equal(summary.verdict, "PASS", JSON.stringify(summary.red_files));
  assert.equal(summary.by_group.storm.total, 49);
  assert.equal(summary.by_group.storm.passed, 49);
});
