// self-tests-alone-report.mjs — pure selection + report shaping for the NPF-2
// "self-tests alone" gate (workflow US-010).
//
// The gate runs, each in its OWN `node --test` (or probe) process and each with
// its own private TMPDIR, under TAMANDUA_TEST_GUARD=1 with
// TAMANDUA_PI_BINARY=TAMANDUA_HERMES_BINARY=TAMANDUA_DSH_BINARY=/usr/bin/false
// and NO ambient TAMANDUA_* authority:
//
//   * npf2   — the NPF-2 positive and NPF-2 negative halves of
//              `tier2-storm-rehearsal-suite-ledger-e2e.test.ts`, each selected
//              by its own `--test-name-pattern` so the first-attempt landing
//              proof (P0/P1) and the refusal proof (P2a/P2) are each executed
//              ALONE in their own process;
//   * aged   — every aged self-test that this run's content-pin migration owns
//              (`aged-core`, `origin-pins`, `o12-content-pin`, `seed-root-copy`);
//   * o12    — every O12 self-test entry (the focused O12 tests, the
//              reserved-key / run-number probes and the fixture generator),
//              reusing the frozen O12 selection from
//              `pre-arm-gate-battery-report.mjs` so the two gates cannot drift.
//
// The aged `seed-readiness.test.mjs` host layer is the seed-qualification
// READINESS gate, not a change-owned self-test: its two host assertions
// (source-commit ancestry and the qualification's gate hashes) are refreshed
// by the aged re-validation story (US-012). It is still EXECUTED and retained
// here, in a non-gating `qualification` group, so the report is honest about
// its current colour without letting a stale published qualification veto the
// NPF-2 content-pin gate.
//
// This module is I/O-free so the selection and the summary shape can be
// unit-tested without spawning anything. `run-self-tests-alone.mjs` is the only
// writer of the retained summary.

import { O12_ENTRIES as FROZEN_O12_ENTRIES } from "./pre-arm-gate-battery-report.mjs";

const SUITE_LEDGER_E2E = "torture-test/self-tests/tier2-storm-rehearsal-suite-ledger-e2e.test.ts";

/**
 * The NPF-2 entries: one process per half. The positive half proves the first
 * `finalize_merge` attempt lands with real LEDGER_EVIDENCE (P0 preflight + P1);
 * the negative half proves the gate still refuses without the evidence step
 * (P2a preflight + P2).
 */
export const NPF2_ENTRIES = Object.freeze([
  {
    name: "npf2-positive",
    kind: "test",
    group: "npf2",
    half: "positive",
    rel: SUITE_LEDGER_E2E,
    test_name_pattern: "P0:|P1:",
  },
  {
    name: "npf2-negative",
    kind: "test",
    group: "npf2",
    half: "negative",
    rel: SUITE_LEDGER_E2E,
    test_name_pattern: "P2a:|P2:",
  },
]);

/**
 * The O12 self-test entries, re-exported from the frozen pre-arm battery
 * selection so the two gates cannot drift.
 */
export const O12_ENTRIES = FROZEN_O12_ENTRIES;

/** The aged self-tests this run's content-pin migration owns. Repo-relative. */
export const AGED_ENTRIES = Object.freeze([
  "torture-test/aged/self-test/aged-core.test.mjs",
  "torture-test/aged/self-test/origin-pins.test.mjs",
  "torture-test/aged/self-test/o12-content-pin.test.mjs",
  "torture-test/aged/self-test/seed-root-copy.test.mjs",
]);

/**
 * The non-gating qualification group: the aged seed-readiness gate is executed
 * and retained, but its colour is owned by US-012 (the qualification refresh)
 * and never vetoes this gate's verdict.
 */
export const QUALIFICATION_ENTRIES = Object.freeze([
  "torture-test/aged/self-test/seed-readiness.test.mjs",
]);

/** The required (gating) groups, in gate order. */
export const REQUIRED_GROUPS = Object.freeze(["npf2", "aged", "o12"]);

/** The informational (non-gating) groups, in gate order. */
export const INFORMATIONAL_GROUPS = Object.freeze(["qualification"]);

/** Every group the gate runs, in report order. */
export const GROUPS = Object.freeze([...REQUIRED_GROUPS, ...INFORMATIONAL_GROUPS]);

/** Expected entry counts per group. */
export const EXPECTED_COUNTS = Object.freeze({
  npf2: NPF2_ENTRIES.length,
  aged: AGED_ENTRIES.length,
  o12: FROZEN_O12_ENTRIES.length,
  qualification: QUALIFICATION_ENTRIES.length,
});

/** Expected number of gating (required-group) entries. */
export const EXPECTED_REQUIRED_TOTAL =
  EXPECTED_COUNTS.npf2 + EXPECTED_COUNTS.aged + EXPECTED_COUNTS.o12;

/**
 * Total a list of per-entry run records into the gate summary block. A gating
 * entry passes only on exit code 0; a required group and the gate verdict are
 * PASS only when nothing gating is red. The informational `qualification`
 * group is summarized but never consulted for the verdict.
 */
export function summarizeSelfTestsAlone(entries) {
  const byGroup = {};
  for (const group of GROUPS) {
    const groupEntries = entries.filter((entry) => entry.group === group);
    const red = groupEntries.filter((entry) => entry.exit_code !== 0);
    byGroup[group] = {
      total: groupEntries.length,
      passed: groupEntries.length - red.length,
      failed: red.length,
      red_files: red.map((entry) => entry.name),
      verdict: red.length === 0 ? "PASS" : "FAIL",
      gating: REQUIRED_GROUPS.includes(group),
    };
  }
  const required = entries.filter((entry) => REQUIRED_GROUPS.includes(entry.group));
  const red = required.filter((entry) => entry.exit_code !== 0);
  return {
    kind: "self-tests-alone-summary",
    total_required: required.length,
    passed_required: required.length - red.length,
    failed_required: red.length,
    red_file_count: red.length,
    red_files: red.map((entry) => entry.name),
    verdict: red.length === 0 ? "PASS" : "FAIL",
    by_group: byGroup,
  };
}

/**
 * Validate a retained self-tests-alone summary. Returns `{ ok, problems }` and
 * never throws. A gate is honest only when every required group is present at
 * its expected size and green, the NPF-2 positive and negative halves are both
 * present and green, the informational qualification group ran, the gate ran
 * from a guard-safe repo root, and the verdict is PASS.
 */
export function validateSelfTestsAloneSummary(summary) {
  const problems = [];
  if (!summary || typeof summary !== "object") {
    return { ok: false, problems: ["summary is not an object"] };
  }
  if (summary.kind !== "self-tests-alone-summary") {
    problems.push(`summary.kind must be self-tests-alone-summary (got ${JSON.stringify(summary.kind)})`);
  }
  if (!Array.isArray(summary.entries)) {
    return { ok: false, problems: [...problems, "summary.entries must be an array"] };
  }
  if (summary.total_required !== EXPECTED_REQUIRED_TOTAL) {
    problems.push(`total_required ${summary.total_required} !== expected ${EXPECTED_REQUIRED_TOTAL}`);
  }
  const requiredEntries = summary.entries.filter((entry) => REQUIRED_GROUPS.includes(entry.group));
  if (requiredEntries.length !== EXPECTED_REQUIRED_TOTAL) {
    problems.push(`required entry count ${requiredEntries.length} !== expected ${EXPECTED_REQUIRED_TOTAL}`);
  }
  for (const group of GROUPS) {
    const block = summary.by_group?.[group];
    if (!block) {
      problems.push(`missing by_group.${group}`);
      continue;
    }
    if (block.total !== EXPECTED_COUNTS[group]) {
      problems.push(`by_group.${group}.total ${block.total} !== expected ${EXPECTED_COUNTS[group]}`);
    }
    if (REQUIRED_GROUPS.includes(group) && (block.verdict !== "PASS" || block.failed !== 0)) {
      problems.push(`by_group.${group} is red: ${JSON.stringify(block.red_files)}`);
    }
  }
  const red = requiredEntries.filter((entry) => entry.exit_code !== 0);
  if (red.length > 0) {
    problems.push(`red entries: ${red.map((entry) => `${entry.name}(${entry.exit_code})`).join(", ")}`);
  }
  const npf2 = summary.entries.filter((entry) => entry.group === "npf2");
  if (npf2.length !== EXPECTED_COUNTS.npf2) {
    problems.push(`npf2 entry count ${npf2.length} !== ${EXPECTED_COUNTS.npf2}`);
  } else {
    for (const half of ["positive", "negative"]) {
      const entry = npf2.find((candidate) => candidate.half === half);
      if (!entry) problems.push(`npf2 is missing its ${half} half`);
      else if (entry.exit_code !== 0) problems.push(`npf2 ${half} half exited ${entry.exit_code}`);
    }
  }
  const qualification = summary.entries.filter((entry) => entry.group === "qualification");
  if (qualification.length !== EXPECTED_COUNTS.qualification) {
    problems.push(`qualification entry count ${qualification.length} !== ${EXPECTED_COUNTS.qualification}`);
  }
  if (summary.verdict !== "PASS") {
    problems.push(`verdict is ${JSON.stringify(summary.verdict)}`);
  }
  if (typeof summary.repo_root !== "string" || !summary.repo_root.startsWith("/")) {
    problems.push("repo_root must be an absolute path");
  }
  if (summary.environment?.guard_safe_repo_root !== true) {
    problems.push("the gate did not run from a guard-safe repo root (outside the real-state prefix)");
  }
  return { ok: problems.length === 0, problems };
}
