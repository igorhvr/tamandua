#!/usr/bin/env node

// storm-chain.test.mjs — focused tests for the O12-REPIN US-008 49-file storm
// chain machinery.
//
// Unit-tests the pure selection + summary shaping/validation, and (when a
// retained chain run exists) validates the newest `chain-summary.json`
// (override the results base with TAMANDUA_STORM_CHAIN_RESULTS=<dir>). It never
// acquires the flock, never spawns a test file and never writes into
// torture-test/var.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { STORM_CHAIN_49 } from "./pre-arm-gate-battery-report.mjs";
import {
  EXPECTED_CHAIN_FILE_COUNT,
  STORM_CHAIN_FILES,
  buildChainSummary,
  parseChainFileList,
  renderChainFileList,
  validateChainSummary,
} from "./storm-chain-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const RESULTS_BASE = path.join(TT_ROOT, "var", "results");

const RUN7_CANDIDATES = [
  process.env.STORM_CHAIN_RUN7_FILES,
  "/opt/tamandua-storm-seed.Hn3vQ8kL/torture-test/var/results/storm-chain-2026-09-15T12-01-28Z/chain-files.txt",
  "/opt/tamandua-storm-seed.Hn3vQ8kL/torture-test/var/results/storm-chain-2026-09-15T11-31-08Z/chain-files.txt",
].filter(Boolean);

function firstExisting(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function greenRows() {
  return STORM_CHAIN_FILES.map((file, i) => ({
    idx: String(i + 1),
    file,
    rc: "0",
    tests: "3",
    pass: "3",
    fail: "0",
    skipped: "0",
    duration_ms: "10.0",
  }));
}

function greenSummary(overrides = {}) {
  return buildChainSummary({
    files: STORM_CHAIN_FILES,
    rows: greenRows(),
    lock: {
      path: "/home/kaladin/matchlock-work/vaivm-gate.lock",
      submit_iso: "2026-01-01T00:00:00Z",
      submit_epoch: "1000.0",
      acquire_iso: "2026-01-01T00:05:00Z",
      acquire_epoch: "1300.0",
      release_iso: "2026-01-01T00:15:00Z",
      release_epoch: "1900.0",
      holder_pid: "4242",
      stat_before: "stat LOCK size=0 mode=644",
      stat_after: "stat LOCK size=0 mode=644",
      untouched: true,
    },
    evidenceDir: "/tmp/storm-chain-evidence",
    repo: "/tmp/repo",
    head: "deadbeef",
    harnessGuardEnv: "TAMANDUA_TEST_GUARD=1 TAMANDUA_PI_BINARY=/usr/bin/false",
    generatedAtUtc: "2026-01-01T00:15:01Z",
    ...overrides,
  });
}

test("the frozen chain selection is the 49-file run #7 chain in chain-files order", () => {
  assert.equal(STORM_CHAIN_FILES.length, EXPECTED_CHAIN_FILE_COUNT);
  assert.equal(new Set(STORM_CHAIN_FILES).size, EXPECTED_CHAIN_FILE_COUNT, "selection is unique");
  assert.deepEqual(
    [...STORM_CHAIN_FILES].sort(),
    [...STORM_CHAIN_49].sort(),
    "same 49 paths as run #7's test_cmd_extended selection",
  );
  for (const rel of STORM_CHAIN_FILES) {
    assert.match(rel, /^torture-test\/self-tests\/.*\.test\.ts$/, `storm-shaped path: ${rel}`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `chain member exists: ${rel}`);
  }

  const run7Path = firstExisting(RUN7_CANDIDATES);
  if (!run7Path) {
    process.stderr.write("run #7 chain-files.txt not present; skipping byte-match assertion\n");
    return;
  }
  assert.equal(
    renderChainFileList(),
    fs.readFileSync(run7Path, "utf8"),
    `canonical selection byte-matches run #7 (${run7Path})`,
  );
});

test("parseChainFileList / renderChainFileList round-trip", () => {
  assert.equal(parseChainFileList(renderChainFileList()).length, EXPECTED_CHAIN_FILE_COUNT);
  assert.deepEqual(parseChainFileList(renderChainFileList()), [...STORM_CHAIN_FILES]);
  assert.deepEqual(parseChainFileList("\n a \n\nb\n"), ["a", "b"]);
  assert.deepEqual(parseChainFileList(""), []);
});

test("buildChainSummary totals a green chain and computes the lock timings", () => {
  const summary = greenSummary();
  assert.equal(summary.verdict, "PASS");
  assert.equal(summary.file_count_expected, 49);
  assert.equal(summary.file_count_observed, 49);
  assert.deepEqual(summary.missing_files, []);
  assert.deepEqual(summary.unexpected_files, []);
  assert.equal(summary.red_file_count, 0);
  assert.deepEqual(summary.red_files, []);
  assert.equal(summary.totals.tests, 147);
  assert.equal(summary.totals.pass, 147);
  assert.equal(summary.totals.fail, 0);
  assert.equal(summary.lock.wait_seconds, 300);
  assert.equal(summary.lock.held_seconds, 600);
});

test("buildChainSummary is honest about red, missing, short and extra files", () => {
  const red = greenRows();
  red[7].rc = "1";
  const redSummary = greenSummary({ rows: red });
  assert.equal(redSummary.verdict, "FAIL");
  assert.equal(redSummary.red_file_count, 1);
  assert.equal(redSummary.red_files[0].file, STORM_CHAIN_FILES[7]);

  const missing = greenRows().filter((row) => row.file !== STORM_CHAIN_FILES[20]);
  const missingSummary = greenSummary({ rows: missing });
  assert.equal(missingSummary.verdict, "FAIL");
  assert.deepEqual(missingSummary.missing_files, [STORM_CHAIN_FILES[20]]);

  const extra = [...greenRows(), { ...greenRows()[0], idx: "50", file: "torture-test/self-tests/not-in-chain.test.ts" }];
  const extraSummary = greenSummary({ rows: extra });
  assert.equal(extraSummary.verdict, "FAIL");
  assert.deepEqual(extraSummary.unexpected_files, ["torture-test/self-tests/not-in-chain.test.ts"]);

  const short = greenSummary({ files: STORM_CHAIN_FILES.slice(0, 3), rows: greenRows().slice(0, 3) });
  assert.equal(short.verdict, "FAIL");
});

test("validateChainSummary accepts the green chain and rejects drift", () => {
  const accepted = validateChainSummary(greenSummary());
  assert.equal(accepted.ok, true, accepted.problems.join("; "));

  const red = greenSummary({ rows: greenRows().map((row, i) => (i === 0 ? { ...row, rc: "2" } : row)) });
  assert.equal(validateChainSummary(red).ok, false);

  const noLockTimes = greenSummary();
  delete noLockTimes.lock.release_iso;
  const noLockValidation = validateChainSummary(noLockTimes);
  assert.equal(noLockValidation.ok, false);
  assert.ok(noLockValidation.problems.some((problem) => problem.includes("release_iso")));

  const touchedLock = greenSummary();
  touchedLock.lock.untouched = false;
  assert.equal(validateChainSummary(touchedLock).ok, false);

  const wrongFiles = greenSummary();
  wrongFiles.files = wrongFiles.files.map((file, i) => (i === 0 ? "torture-test/self-tests/wrong.test.ts" : file));
  assert.equal(validateChainSummary(wrongFiles).ok, false);

  assert.equal(validateChainSummary(null).ok, false);
});

test("retained storm chain run (when present) is a green, honest report", () => {
  const explicit = process.env.TAMANDUA_STORM_CHAIN_RESULTS;
  let resultsDir = explicit ? path.resolve(explicit) : null;
  if (!resultsDir && fs.existsSync(RESULTS_BASE)) {
    const candidates = fs
      .readdirSync(RESULTS_BASE)
      .filter((name) => name.startsWith("storm-chain-"))
      .map((name) => path.join(RESULTS_BASE, name))
      .map((dir) => {
        const summaryPath = path.join(dir, "chain-summary.json");
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
    process.stderr.write("no retained storm chain run found; skipping retained-report assertions\n");
    return;
  }
  const summary = JSON.parse(fs.readFileSync(path.join(resultsDir, "chain-summary.json"), "utf8"));
  const validation = validateChainSummary(summary);
  assert.equal(validation.ok, true, validation.problems.join("; "));
  assert.equal(summary.verdict, "PASS", JSON.stringify(summary.red_files));
  assert.equal(summary.file_count_expected, 49);
  assert.equal(summary.file_count_observed, 49);
  assert.equal(summary.red_file_count, 0);
  assert.equal(summary.totals.fail, 0);
  assert.equal(summary.lock.untouched, true);
  assert.equal(summary.run7_chain_files?.byte_match, true);
  for (const script of ["chain-wrapper.sh", "chain-runner.sh", "chain-files.txt"]) {
    assert.ok(fs.existsSync(path.join(resultsDir, script)), `retained evidence includes ${script}`);
  }
  const run7Path = summary.run7_chain_files?.path ?? firstExisting(RUN7_CANDIDATES);
  if (run7Path) {
    assert.equal(
      fs.readFileSync(path.join(resultsDir, "chain-files.txt"), "utf8"),
      fs.readFileSync(run7Path, "utf8"),
      "retained chain-files.txt byte-matches run #7",
    );
  }
});
