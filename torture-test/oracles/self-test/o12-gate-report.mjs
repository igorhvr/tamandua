// o12-gate-report.mjs — pure report-shaping/validation for the O12-REPIN
// gate self-test runs (Storm O12-REPIN US-003).
//
// Kept free of I/O so the retained `o12-fixture-matrix.json` and
// `o12-gate-self-tests-summary.json` shapes can be unit-tested without
// spawning the oracle. `o12-fixture-matrix.mjs` and
// `run-o12-gate-self-tests.mjs` are the only writers.

/** The stdout/exit contract shared by every O12 oracle invocation. */
export const EXIT_BY_RESULT = Object.freeze({ PASS: 0, FAIL: 1, ERROR: 2, NOT_EVALUABLE: 3 });

/**
 * The eight executable O12-CLOSE correction cases (Storm O12-close): seven
 * named fixtures plus the run-number allocator characterization (the real-API
 * probe + the SQL-replica calibration). Every case must be present and green.
 */
export const O12_CORRECTION_CASES = Object.freeze([
  { case_id: 'o12-close-partial-run-baseline', kind: 'fixture', fixture: 'o12-close-partial-run-baseline', label: 'partial-run baseline' },
  { case_id: 'o12-close-partial-key-baseline', kind: 'fixture', fixture: 'o12-close-partial-key-baseline', label: 'partial-key baseline' },
  { case_id: 'o12-close-non-reserved-only-baseline', kind: 'fixture', fixture: 'o12-close-non-reserved-only-baseline', label: 'nonreserved-only baseline' },
  { case_id: 'o12-close-v2-unknown-key', kind: 'fixture', fixture: 'o12-close-v2-unknown-key', label: 'malformed v2 nonreserved (unknown key)' },
  { case_id: 'o12-close-key-introduced', kind: 'fixture', fixture: 'o12-close-key-introduced', label: 'introduced known-absent key' },
  { case_id: 'o12-close-empty-string-divergence', kind: 'fixture', fixture: 'o12-close-empty-string-divergence', label: 'changed empty string' },
  { case_id: 'o12-close-seven-orphans-count', kind: 'fixture', fixture: 'o12-close-seven-orphans-count', label: 'real orphan rows exact count' },
  {
    case_id: 'o12-close-run-number-allocator-characterization',
    kind: 'probe',
    fixture: null,
    label: 'run-number allocator characterization (real-API probe + SQL replica)',
  },
]);

/** The fixture names of the seven fixture-backed correction cases. */
export const O12_CORRECTION_CASE_FIXTURES = Object.freeze(
  O12_CORRECTION_CASES.filter((entry) => entry.kind === 'fixture').map((entry) => entry.fixture),
);

/**
 * Build the eight correction-case records. The seven fixture cases read their
 * expected/observed from the matrix entries; the probe case reads the two
 * allocator probe results. A correction case is `match` only when its own
 * evidence is exactly as documented.
 */
export function buildCorrectionCases(entries, probeResults = {}) {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return O12_CORRECTION_CASES.map((definition) => {
    if (definition.kind === 'fixture') {
      const entry = byName.get(definition.fixture);
      return {
        ...definition,
        expected: entry?.expected ?? null,
        observed: entry?.observed ?? null,
        match: Boolean(entry && entry.match === true && entry.expected === entry.observed),
        present: Boolean(entry),
      };
    }
    const probeNames = ['o12-run-number-probe.mjs', 'o12-run-number-allocator-calibration.mjs'];
    const probes = probeNames.map((name) => {
      const result = probeResults[name] ?? null;
      return {
        name,
        exit_code: result?.exit_code ?? null,
        pass: result ? result.exit_code === 0 : false,
        report_probe: result?.report_probe ?? null,
        delete_recreate_reuse_observed: result?.delete_recreate_reuse_observed ?? null,
        live_rows_unique: result?.live_rows_unique ?? null,
        calibration_kind: result?.calibration_kind ?? null,
      };
    });
    const observed = probes.every((probe) => probe.pass
      && probe.delete_recreate_reuse_observed === true
      && probe.live_rows_unique === true) ? 'PASS' : 'FAIL';
    return {
      ...definition,
      expected: 'PASS',
      observed,
      match: observed === 'PASS',
      present: probes.every((probe) => probe.exit_code !== null),
      probes,
    };
  });
}

/**
 * Total a list of per-entry run records into the summary block. An entry is a
 * pass only on exit code 0; the verdict is PASS only when nothing is red.
 */
export function summarizeRun(entries) {
  const red = entries.filter((entry) => entry.exit_code !== 0);
  return {
    total: entries.length,
    passed: entries.length - red.length,
    failed: red.length,
    red_file_count: red.length,
    red_files: red.map((entry) => entry.name),
    verdict: red.length === 0 ? 'PASS' : 'FAIL',
  };
}

/**
 * Validate the retained fixture matrix. Returns `{ ok, problems }`; never
 * throws. Every generated fixture must have expected == observed == the exit
 * code its result maps to, the immutable snapshot must be unchanged, and all
 * eight correction cases must be present and green.
 */
export function validateMatrix(matrix) {
  const problems = [];
  if (!matrix || typeof matrix !== 'object') {
    return { ok: false, problems: ['matrix is not an object'] };
  }
  if (matrix.kind !== 'o12-fixture-matrix') {
    problems.push(`matrix.kind must be o12-fixture-matrix (got ${JSON.stringify(matrix.kind)})`);
  }
  if (!Array.isArray(matrix.entries)) {
    return { ok: false, problems: [...problems, 'matrix.entries must be an array'] };
  }
  if (matrix.fixture_count !== matrix.entries.length) {
    problems.push(`fixture_count ${matrix.fixture_count} !== entries length ${matrix.entries.length}`);
  }
  if (matrix.expected_fixture_count !== matrix.fixture_count) {
    problems.push(`expected_fixture_count ${matrix.expected_fixture_count} !== fixture_count ${matrix.fixture_count}`);
  }
  for (const entry of matrix.entries) {
    if (entry.expected !== entry.observed) {
      problems.push(`${entry.name}: expected ${entry.expected} !== observed ${entry.observed}`);
    }
    if (entry.exit_code !== entry.exit_expected) {
      problems.push(`${entry.name}: exit_code ${entry.exit_code} !== exit_expected ${entry.exit_expected}`);
    }
    if (EXIT_BY_RESULT[entry.observed] !== entry.exit_code) {
      problems.push(`${entry.name}: observed ${entry.observed} does not map to exit_code ${entry.exit_code}`);
    }
    if (entry.match !== true) {
      problems.push(`${entry.name}: match must be true`);
    }
    if (entry.snapshot_unchanged !== true) {
      problems.push(`${entry.name}: immutable snapshot hash changed`);
    }
    if (entry.expected === 'ERROR' && (entry.evidence_files_added ?? []).length !== 0) {
      problems.push(`${entry.name}: ERROR fixture wrote evidence files ${JSON.stringify(entry.evidence_files_added)}`);
    }
  }
  const cases = Array.isArray(matrix.correction_cases) ? matrix.correction_cases : [];
  const byId = new Map(cases.map((entry) => [entry.case_id, entry]));
  for (const definition of O12_CORRECTION_CASES) {
    const record = byId.get(definition.case_id);
    if (!record) {
      problems.push(`correction case missing: ${definition.case_id}`);
      continue;
    }
    if (record.expected !== record.observed || record.match !== true) {
      problems.push(`correction case not green: ${definition.case_id} (expected ${record.expected}, observed ${record.observed})`);
    }
  }
  return { ok: problems.length === 0, problems };
}
