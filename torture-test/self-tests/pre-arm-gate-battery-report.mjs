// pre-arm-gate-battery-report.mjs — pure selection + report shaping for the
// O12-REPIN pre-arm gate battery (Storm O12-REPIN US-007).
//
// The battery is the "each alone" half of requirement 5: every aged self-test,
// every O12 self-test entry and every storm self-test in run #7's 49-file
// extended chain selection, each in its OWN `node --test` (or probe) process,
// under TAMANDUA_TEST_GUARD=1 with PI/HERMES/DSH pinned to /usr/bin/false.
//
// This module is I/O-free so the selection and the summary shape can be
// unit-tested without spawning anything. `run-pre-arm-gate-battery.mjs` is the
// only writer of the retained summary.

/** The 49-file run #7 `test_cmd_extended` storm chain, in chain order. */
export const STORM_CHAIN_49 = Object.freeze([
  "torture-test/self-tests/tier2-storm-orchestrator-recording-gate.test.ts",
  "torture-test/self-tests/tier2-storm-real-calibration.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-admission-snapshot.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-behaviors.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-boundary.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-chaos-guard.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-chaos-honesty.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-cleanup.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-consistency.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-daemon-env.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-daemon-provenance.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-exec-db.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-gate-coverage.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-gate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-behaviors.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-runtime.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-schedule.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-mcp-pounding.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-origin-containment.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-pending-candidate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-phase-predicate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-prepare.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-redbait-projection.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-rounda-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-abort.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-hold-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-simultaneity-window.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-workflow-graph.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-workflow-simulation.test.ts",
  "torture-test/self-tests/tier2-storm.test.ts",
  "torture-test/self-tests/tt-poly-storm-md-documentation.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-wiring.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-oneshot.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-live-target.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-stopdel-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-relaunch-taskfile.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-stopdel-terminal.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-launch-argv-containment.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-rugpull-origin.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-merge-events.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-rugpull-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-park-target.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-park-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-product-evidence-ids.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-evidence-audit.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-noop-evidence.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-extended-chain.test.ts",
]);

/**
 * The aged self-tests the battery runs (US-007 requirement (a)). Repo-relative.
 */
export const AGED_ENTRIES = Object.freeze([
  "torture-test/aged/self-test/aged-core.test.mjs",
  "torture-test/aged/self-test/origin-pins.test.mjs",
  "torture-test/aged/self-test/seed-readiness.test.mjs",
]);

/**
 * The O12 self-test entries the battery runs (US-007 requirement (b)). The
 * four named in the story plus the focused schema/seeding tests added by
 * US-001..US-004 so "every O12 self-test" is covered. Probes/generator run as
 * plain node scripts; the others as `node --test`.
 */
export const O12_ENTRIES = Object.freeze([
  { name: "o12.test.mjs", kind: "test", rel: "torture-test/oracles/self-test/o12.test.mjs" },
  { name: "o12-schema-version.test.mjs", kind: "test", rel: "torture-test/oracles/self-test/o12-schema-version.test.mjs" },
  { name: "o12-seed-snapshot.test.mjs", kind: "test", rel: "torture-test/oracles/self-test/o12-seed-snapshot.test.mjs" },
  { name: "o12-gate-self-tests.test.mjs", kind: "test", rel: "torture-test/oracles/self-test/o12-gate-self-tests.test.mjs" },
  { name: "o12-reserved-key-probe.mjs", kind: "probe", rel: "torture-test/oracles/self-test/o12-reserved-key-probe.mjs" },
  { name: "o12-run-number-probe.mjs", kind: "probe", rel: "torture-test/oracles/self-test/o12-run-number-probe.mjs" },
  { name: "o12-run-number-allocator-calibration.mjs", kind: "probe", rel: "torture-test/oracles/self-test/o12-run-number-allocator-calibration.mjs" },
  { name: "generate-o12-fixtures.mjs", kind: "generator", rel: "torture-test/oracles/self-test/generate-o12-fixtures.mjs" },
]);

/** Expected entry counts per group. */
export const EXPECTED_COUNTS = Object.freeze({
  aged: AGED_ENTRIES.length,
  o12: O12_ENTRIES.length,
  storm: STORM_CHAIN_49.length,
  total: AGED_ENTRIES.length + O12_ENTRIES.length + STORM_CHAIN_49.length,
});

/** The groups in battery order. */
export const GROUPS = Object.freeze(["aged", "o12", "storm"]);

/**
 * Total a list of per-entry run records into the battery summary block. An
 * entry passes only on exit code 0; every group and the battery verdict are
 * PASS only when nothing in them is red.
 */
export function summarizeBattery(entries) {
  const byGroup = {};
  for (const group of GROUPS) {
    const groupEntries = entries.filter((entry) => entry.group === group);
    const red = groupEntries.filter((entry) => entry.exit_code !== 0);
    byGroup[group] = {
      total: groupEntries.length,
      passed: groupEntries.length - red.length,
      failed: red.length,
      red_file_count: red.length,
      red_files: red.map((entry) => entry.name),
      verdict: red.length === 0 ? "PASS" : "FAIL",
    };
  }
  const red = entries.filter((entry) => entry.exit_code !== 0);
  return {
    kind: "pre-arm-gate-battery-summary",
    total: entries.length,
    passed: entries.length - red.length,
    failed: red.length,
    red_file_count: red.length,
    red_files: red.map((entry) => entry.name),
    verdict: red.length === 0 ? "PASS" : "FAIL",
    by_group: byGroup,
  };
}

/**
 * Validate a retained pre-arm gate battery summary. Returns `{ ok, problems }`
 * and never throws. A battery is honest only when every entry exited 0, all
 * three groups are present with their expected sizes, the storm group is the
 * exact 49-file chain, and the verdict is PASS.
 */
export function validateBatterySummary(summary) {
  const problems = [];
  if (!summary || typeof summary !== "object") {
    return { ok: false, problems: ["summary is not an object"] };
  }
  if (summary.kind !== "pre-arm-gate-battery-summary") {
    problems.push(`summary.kind must be pre-arm-gate-battery-summary (got ${JSON.stringify(summary.kind)})`);
  }
  if (!Array.isArray(summary.entries)) {
    return { ok: false, problems: [...problems, "summary.entries must be an array"] };
  }
  if (summary.total !== summary.entries.length) {
    problems.push(`total ${summary.total} !== entries length ${summary.entries.length}`);
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
    if (block.verdict !== "PASS" || block.failed !== 0) {
      problems.push(`by_group.${group} is red: ${JSON.stringify(block.red_files)}`);
    }
  }
  const red = summary.entries.filter((entry) => entry.exit_code !== 0);
  if (red.length > 0) {
    problems.push(`red entries: ${red.map((entry) => `${entry.name}(${entry.exit_code})`).join(", ")}`);
  }
  const storm = summary.entries.filter((entry) => entry.group === "storm").map((entry) => entry.rel);
  if (storm.length !== STORM_CHAIN_49.length) {
    problems.push(`storm entry count ${storm.length} !== ${STORM_CHAIN_49.length}`);
  } else {
    for (let i = 0; i < STORM_CHAIN_49.length; i += 1) {
      if (storm[i] !== STORM_CHAIN_49[i]) {
        problems.push(`storm entry ${i} is ${storm[i]}, expected ${STORM_CHAIN_49[i]}`);
        break;
      }
    }
  }
  if (summary.verdict !== "PASS") {
    problems.push(`verdict is ${JSON.stringify(summary.verdict)}`);
  }
  if (typeof summary.repo_root !== "string" || !summary.repo_root.startsWith("/")) {
    problems.push("repo_root must be an absolute path");
  }
  if (summary.environment?.guard_safe_repo_root !== true) {
    problems.push("the battery did not run from a guard-safe repo root (outside the real-state prefix)");
  }
  return { ok: problems.length === 0, problems };
}
