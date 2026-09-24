// storm-chain-report.mjs — pure selection + summary shaping/validation for the
// O12-REPIN US-008 49-file storm chain run.
//
// US-008 reproduces run #7's full 49-file storm self-test chain exactly as run
// #7 ran it: one `node --test` per file, serially, with the WHOLE chain held
// under one `flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock`.
// `STORM_CHAIN_FILES` is that selection. It is the same 49 paths as run #7's
// `chain-files.txt` (the `storm-rehearsal-fix9-readiness.json`
// `test_cmd_extended` selection), written in the order run #7 recorded them
// (ASCII sort), so a generated `chain-files.txt` byte-matches run #7's file.
//
// This module is I/O-free so the selection and the summary shape can be
// unit-tested without spawning anything or acquiring the flock. The runner
// (`storm-chain-runner.sh`) writes `results.tsv` + `meta-*.env`; the
// summarizer (`storm-chain-summarize.mjs`) is the only writer of
// `chain-summary.json`.

/**
 * The 49-file run #7 storm chain, in run #7 `chain-files.txt` order (ASCII
 * sort). This is the canonical selection US-008 must reproduce byte-for-byte.
 */
export const STORM_CHAIN_FILES = Object.freeze([
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
  "torture-test/self-tests/tier2-storm-rehearsal-evidence-audit.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-exec-db.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-extended-chain.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-gate-coverage.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-gate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-behaviors.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-oneshot.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-runtime.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-schedule.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-hold-wiring.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-launch-argv-containment.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-mcp-pounding.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-merge-events.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-noop-evidence.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-origin-containment.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-park-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-park-target.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-pending-candidate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-phase-predicate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-prepare.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-product-evidence-ids.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-redbait-projection.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-relaunch-taskfile.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-rounda-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-abort.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-hold-release.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-roundb-live-target.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-rugpull-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-rugpull-origin.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-simultaneity-window.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-stopdel-e2e.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-stopdel-terminal.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-workflow-graph.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-workflow-simulation.test.ts",
  "torture-test/self-tests/tier2-storm.test.ts",
  "torture-test/self-tests/tt-poly-storm-md-documentation.test.ts",
]);

/** The exact file count the chain contract pins. */
export const EXPECTED_CHAIN_FILE_COUNT = 49;

/** The shared storm gate lock the whole chain is held under. */
export const GATE_LOCK_PATH = "/home/kaladin/matchlock-work/vaivm-gate.lock";

/** The frozen harness/guard env every chain child runs under. */
export const CHAIN_GUARD_ENV = Object.freeze({
  TAMANDUA_TEST_GUARD: "1",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/usr/bin/false",
});

/** Render the canonical chain selection as a newline-terminated file body. */
export function renderChainFileList(files = STORM_CHAIN_FILES) {
  return `${files.join("\n")}\n`;
}

/** Parse a `chain-files.txt` body into non-empty trimmed lines. */
export function parseChainFileList(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function toNumber(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build the honest chain summary. `rows` are the per-file records read from
 * `results.tsv` (string or numeric fields). `lock` carries the already-parsed
 * submit/acquire/release metadata. The verdict is PASS only when the observed
 * file count equals the expected 49, no file is missing, no unexpected file
 * ran, and every file exited 0.
 */
export function buildChainSummary({
  files,
  rows,
  lock = {},
  generatedAtUtc = new Date().toISOString(),
  evidenceDir = null,
  repo = null,
  head = null,
  harnessGuardEnv = null,
  run7 = null,
  task = "O12-REPIN",
  story = "US-008",
} = {}) {
  const expected = [...files];
  const normalizedRows = rows.map((row) => ({
    idx: String(row.idx),
    file: String(row.file),
    rc: toNumber(row.rc, 1),
    tests: toNumber(row.tests),
    pass: toNumber(row.pass),
    fail: toNumber(row.fail),
    skipped: toNumber(row.skipped),
    duration_ms: String(row.duration_ms ?? ""),
  }));

  const observedSet = new Set(normalizedRows.map((row) => row.file));
  const expectedSet = new Set(expected);
  const missingFiles = expected.filter((file) => !observedSet.has(file));
  const unexpectedFiles = [...observedSet].filter((file) => !expectedSet.has(file));

  const redFiles = normalizedRows
    .filter((row) => row.rc !== 0)
    .map((row) => ({
      file: row.file,
      rc: row.rc,
      tests: row.tests,
      pass: row.pass,
      fail: row.fail,
      skipped: row.skipped,
      log: evidenceDir ? `${evidenceDir}/logs/${row.file.split("/").pop()}.log` : null,
    }));

  const totals = normalizedRows.reduce(
    (acc, row) => {
      acc.tests += row.tests;
      acc.pass += row.pass;
      acc.fail += row.fail;
      acc.skipped += row.skipped;
      return acc;
    },
    { tests: 0, pass: 0, fail: 0, skipped: 0 },
  );

  const expectedCount = expected.length;
  const verdict =
    redFiles.length === 0 &&
    missingFiles.length === 0 &&
    unexpectedFiles.length === 0 &&
    normalizedRows.length === expectedCount &&
    expectedCount === EXPECTED_CHAIN_FILE_COUNT
      ? "PASS"
      : "FAIL";

  const submitEpoch = toFloat(lock.submit_epoch);
  const acquireEpoch = toFloat(lock.acquire_epoch);
  const releaseEpoch = toFloat(lock.release_epoch);
  const lockWaitSeconds =
    submitEpoch !== null && acquireEpoch !== null ? acquireEpoch - submitEpoch : null;
  const lockHeldSeconds =
    acquireEpoch !== null && releaseEpoch !== null ? releaseEpoch - acquireEpoch : null;

  return {
    kind: "storm-chain-summary",
    story,
    task,
    generated_at_utc: generatedAtUtc,
    evidence_dir: evidenceDir,
    repo,
    head,
    mode: "chain",
    harness_guard_env: harnessGuardEnv,
    lock: {
      path: lock.path ?? GATE_LOCK_PATH,
      submit_iso: lock.submit_iso ?? null,
      submit_epoch: lock.submit_epoch ?? null,
      acquire_iso: lock.acquire_iso ?? null,
      acquire_epoch: lock.acquire_epoch ?? null,
      release_iso: lock.release_iso ?? null,
      release_epoch: lock.release_epoch ?? null,
      wait_seconds: lockWaitSeconds,
      held_seconds: lockHeldSeconds,
      holder_pid: lock.holder_pid ?? null,
      stat_before: lock.stat_before ?? null,
      stat_after: lock.stat_after ?? null,
      untouched: lock.untouched ?? null,
    },
    file_count_expected: expectedCount,
    file_count_observed: normalizedRows.length,
    missing_files: missingFiles,
    unexpected_files: unexpectedFiles,
    red_file_count: redFiles.length,
    red_files: redFiles,
    totals,
    verdict,
    files: expected,
    results: normalizedRows,
    run7_chain_files: run7,
  };
}

/**
 * Validate a chain summary. Returns `{ ok, problems }` and never throws. A
 * chain is honest only when the selection is the exact 49 paths, every file
 * observed, nothing red, the totals carry no failures, the verdict is PASS,
 * and the lock timing/identity was recorded without altering the lock.
 */
export function validateChainSummary(summary) {
  const problems = [];
  if (!summary || typeof summary !== "object") {
    return { ok: false, problems: ["summary is not an object"] };
  }
  if (summary.kind !== "storm-chain-summary") {
    problems.push(`summary.kind must be storm-chain-summary (got ${JSON.stringify(summary.kind)})`);
  }
  if (summary.file_count_expected !== EXPECTED_CHAIN_FILE_COUNT) {
    problems.push(`file_count_expected ${summary.file_count_expected} !== ${EXPECTED_CHAIN_FILE_COUNT}`);
  }
  if (summary.file_count_observed !== EXPECTED_CHAIN_FILE_COUNT) {
    problems.push(`file_count_observed ${summary.file_count_observed} !== ${EXPECTED_CHAIN_FILE_COUNT}`);
  }
  if (!Array.isArray(summary.files) || summary.files.length !== EXPECTED_CHAIN_FILE_COUNT) {
    problems.push(`files must be the ${EXPECTED_CHAIN_FILE_COUNT}-path selection`);
  } else if (JSON.stringify(summary.files) !== JSON.stringify([...STORM_CHAIN_FILES])) {
    problems.push("files does not match the canonical chain selection byte-for-byte");
  }
  if (!Array.isArray(summary.results) || summary.results.length !== EXPECTED_CHAIN_FILE_COUNT) {
    problems.push(`results must have ${EXPECTED_CHAIN_FILE_COUNT} rows`);
  }
  if (Array.isArray(summary.missing_files) && summary.missing_files.length > 0) {
    problems.push(`missing files: ${summary.missing_files.join(", ")}`);
  }
  if (Array.isArray(summary.unexpected_files) && summary.unexpected_files.length > 0) {
    problems.push(`unexpected files: ${summary.unexpected_files.join(", ")}`);
  }
  if (summary.red_file_count !== 0 || (Array.isArray(summary.red_files) && summary.red_files.length > 0)) {
    problems.push(`red files: ${JSON.stringify(summary.red_files)}`);
  }
  if (summary.totals?.fail !== 0) {
    problems.push(`totals.fail ${summary.totals?.fail} !== 0`);
  }
  if (summary.verdict !== "PASS") {
    problems.push(`verdict is ${JSON.stringify(summary.verdict)}`);
  }
  const lock = summary.lock ?? {};
  if (!lock.path) problems.push("lock.path missing");
  for (const key of ["submit_iso", "acquire_iso", "release_iso"]) {
    if (typeof lock[key] !== "string" || lock[key].length === 0) {
      problems.push(`lock.${key} missing (submit/acquire/release timestamps required)`);
    }
  }
  if (lock.untouched === false) {
    problems.push("lock file was modified by the run");
  }
  return { ok: problems.length === 0, problems };
}
