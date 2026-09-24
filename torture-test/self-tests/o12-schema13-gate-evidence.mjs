// o12-schema13-gate-evidence.mjs — pure shaping + validation for the
// O12-SCHEMA-13 US-006 gate evidence record.
//
// The record is the machine-readable link between the RETAINED gate artifacts
// (the self-tests-alone summary produced by
// `torture-test/self-tests/run-self-tests-alone.mjs`, the O12 gate self-test
// summary + fixture matrix produced by
// `torture-test/oracles/self-test/run-o12-gate-self-tests.mjs`, and the owned
// seed-snapshot materialization receipt) and the acceptance contract story
// (US-007), which must be able to read the exact gate commands, the frozen gate
// env and every per-entry exit WITHOUT the worktree.
//
// Every load-bearing value is taken from a retained artifact; only the
// invocation strings the operator actually ran, the recorded substitutions and
// the run identity are passed in as verbatim text (they are not derivable from
// any artifact). Kept free of I/O so the shape and the validator can be
// unit-tested without spawning anything; the publisher is the only writer.

/** The record's `kind`. */
export const GATE_EVIDENCE_KIND = "o12-schema13-gate-evidence";

/** The tracked path (repo-relative) the publisher writes. */
export const GATE_EVIDENCE_OUTPUT_REL = "torture-test/impl-tasks/o12-schema13-gate-evidence.json";

/** The required per-group entry counts the gate must report. */
export const EXPECTED_GATE_COUNTS = Object.freeze({ npf2: 2, aged: 4, o12: 8, qualification: 1 });

/** The gating groups (the informational `qualification` group never gates). */
export const GATING_GROUPS = Object.freeze(["npf2", "aged", "o12"]);

/** The required total across the gating groups. */
export const EXPECTED_REQUIRED_TOTAL = GATING_GROUPS.reduce(
  (total, group) => total + EXPECTED_GATE_COUNTS[group],
  0,
);

/** Shape one self-tests-alone entry (or O12 gate entry) for the record. */
export function shapeGateEntry(entry, { group = null } = {}) {
  if (!entry || typeof entry !== "object") throw new Error(`shapeGateEntry: entry must be an object`);
  return {
    name: entry.name ?? null,
    group: group ?? entry.group ?? null,
    half: entry.half ?? null,
    kind: entry.kind ?? null,
    rel: entry.rel ?? null,
    test_name_pattern: entry.test_name_pattern ?? null,
    argv: Array.isArray(entry.argv) ? [...entry.argv] : null,
    exit_code: entry.exit_code ?? null,
    signal: entry.signal ?? null,
    duration_ms: entry.duration_ms ?? null,
    verdict: entry.exit_code === 0 ? "PASS" : "FAIL",
    stdout_log: entry.stdout_log ?? null,
    stderr_log: entry.stderr_log ?? null,
  };
}

/** Shape the two O12 gate self-test summaries into the record's sections. */
function buildSelfTestsAloneSection(summary) {
  const entries = (summary.entries ?? []).map((entry) => shapeGateEntry(entry));
  return {
    results_dir: summary.results_dir ?? null,
    repo_root: summary.repo_root ?? null,
    git_head: summary.git_head ?? null,
    environment: {
      guard_safe_repo_root: summary.environment?.guard_safe_repo_root ?? null,
      real_state_prefix: summary.environment?.real_state_prefix ?? null,
      gate_env: summary.environment?.gate_env ?? null,
    },
    expected_counts: summary.expected_counts ?? null,
    total_required: summary.total_required ?? null,
    passed_required: summary.passed_required ?? null,
    failed_required: summary.failed_required ?? null,
    red_files: summary.red_files ?? null,
    verdict: summary.verdict ?? null,
    by_group: summary.by_group ?? null,
    entries,
  };
}

function buildO12GateSection(summary) {
  return {
    results_dir: summary.results_dir ?? null,
    repo_root: summary.repo_root ?? null,
    dist_dir: summary.dist_dir ?? null,
    gate_env: summary.gate_env ?? null,
    total: summary.total ?? null,
    passed: summary.passed ?? null,
    failed: summary.failed ?? null,
    red_files: summary.red_files ?? null,
    verdict: summary.verdict ?? null,
    matrix_pass: summary.matrix_pass ?? null,
    overall_verdict: summary.overall_verdict ?? null,
    fixture_matrix: {
      path: summary.fixture_matrix?.path ?? null,
      expected_fixture_count: summary.fixture_matrix?.expected_fixture_count ?? null,
      fixture_count: summary.fixture_matrix?.fixture_count ?? null,
      all_match: summary.fixture_matrix?.all_match ?? null,
      all_correction_cases_green: summary.fixture_matrix?.all_correction_cases_green ?? null,
      snapshot_immutability_ok: summary.fixture_matrix?.snapshot_immutability_ok ?? null,
      validation_ok: summary.fixture_matrix?.validation?.ok ?? null,
      validation_problems: summary.fixture_matrix?.validation?.problems ?? null,
    },
    entries: (summary.entries ?? []).map((entry) => shapeGateEntry(entry, { group: "o12-gate" })),
  };
}

/** Shape the owned seed-snapshot materialization receipt (v13 leg). */
function buildSeedSnapshotSection(receipt) {
  const snapshots = (receipt.snapshots ?? []).map((snapshot) => ({
    label: snapshot.label ?? null,
    case_id: snapshot.case_id ?? null,
    path: snapshot.path ?? null,
    basename: snapshot.basename ?? null,
    user_version: snapshot.user_version ?? null,
    lineage: snapshot.lineage ?? null,
    sha256: snapshot.sha256 ?? null,
    bytes: snapshot.bytes ?? null,
    mode: snapshot.mode ?? null,
  }));
  return {
    receipt_path: receipt.receiptPath ?? receipt.receipt_path ?? null,
    var_root: receipt.var_root ?? null,
    kind: receipt.kind ?? null,
    supported_user_versions: receipt.supported_user_versions ?? null,
    snapshots,
  };
}

/**
 * Build the gate-evidence record. `commands`, `substitutions` and the run
 * identity are verbatim operator text; everything else is a retained artifact.
 */
export function buildGateEvidence({
  runId,
  story,
  branch,
  base,
  head,
  commands = [],
  substitutions = [],
  selfTestsAlone,
  o12Gate,
  seedReceipt,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!selfTestsAlone || typeof selfTestsAlone !== "object") {
    throw new Error("buildGateEvidence: the self-tests-alone summary is required");
  }
  if (!o12Gate || typeof o12Gate !== "object") {
    throw new Error("buildGateEvidence: the O12 gate self-test summary is required");
  }
  return {
    kind: GATE_EVIDENCE_KIND,
    contract_version: 1,
    generated_at: generatedAt,
    run_id: runId ?? null,
    story: story ?? null,
    branch: branch ?? null,
    base: base ?? null,
    head: head ?? null,
    gate: {
      // The repo root + HEAD the gate actually ran from (a detached guard-safe
      // worktree), read from the retained summary.
      worktree: selfTestsAlone.repo_root ?? null,
      head: selfTestsAlone.git_head ?? null,
      // The gating entry counts the gate must report, and the selection is
      // frozen: 2 npf2 + 4 aged + 8 o12 = 14 gating + 1 informational.
      expected_counts: { ...EXPECTED_GATE_COUNTS },
      expected_required_total: EXPECTED_REQUIRED_TOTAL,
      gating_groups: [...GATING_GROUPS],
      commands: [...commands],
      substitutions: [...substitutions],
    },
    self_tests_alone: buildSelfTestsAloneSection(selfTestsAlone),
    o12_gate: buildO12GateSection(o12Gate),
    seed_snapshot: seedReceipt ? buildSeedSnapshotSection(seedReceipt) : null,
  };
}

/**
 * Validate the record (the retained artifact) against the pinned contract.
 * Returns `{ ok, problems }`; never throws.
 */
export function validateO12Schema13GateEvidence(record) {
  const problems = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, problems: ["record is not an object"] };
  }
  if (record.kind !== GATE_EVIDENCE_KIND) problems.push(`kind must be ${GATE_EVIDENCE_KIND}`);

  const gate = record.gate ?? {};
  if (!Array.isArray(gate.commands) || gate.commands.length === 0) {
    problems.push("gate.commands must record the exact commands that were run");
  }
  if (!Array.isArray(gate.substitutions)) {
    problems.push("gate.substitutions must be an array (may be empty, never absent)");
  }
  if (gate.expected_required_total !== EXPECTED_REQUIRED_TOTAL) {
    problems.push(`gate.expected_required_total ${gate.expected_required_total} !== ${EXPECTED_REQUIRED_TOTAL}`);
  }
  if (typeof gate.worktree !== "string" || !gate.worktree.startsWith("/")) {
    problems.push("gate.worktree must be the absolute guard-safe repo root the gate ran from");
  }
  if (typeof gate.head !== "string" || !/^[0-9a-f]{40}$/.test(gate.head)) {
    problems.push("gate.head must be the full gate-worktree HEAD commit");
  }

  const gateEnv = record.self_tests_alone?.environment?.gate_env ?? {};
  if (gateEnv.TAMANDUA_TEST_GUARD !== "1") problems.push("the frozen gate env must set TAMANDUA_TEST_GUARD=1");
  for (const key of ["TAMANDUA_PI_BINARY", "TAMANDUA_HERMES_BINARY", "TAMANDUA_DSH_BINARY"]) {
    if (gateEnv[key] !== "/usr/bin/false") problems.push(`the frozen gate env must pin ${key}=/usr/bin/false`);
  }
  if (record.self_tests_alone?.environment?.guard_safe_repo_root !== true) {
    problems.push("the gate must have run from a guard-safe repo root (outside the real-state prefix)");
  }

  const entries = Array.isArray(record.self_tests_alone?.entries) ? record.self_tests_alone.entries : [];
  const byGroup = record.self_tests_alone?.by_group ?? {};
  for (const group of Object.keys(EXPECTED_GATE_COUNTS)) {
    const block = byGroup[group];
    if (!block) {
      problems.push(`self_tests_alone.by_group.${group} is missing`);
      continue;
    }
    if (block.total !== EXPECTED_GATE_COUNTS[group]) {
      problems.push(`by_group.${group}.total ${block.total} !== expected ${EXPECTED_GATE_COUNTS[group]}`);
    }
    if (GATING_GROUPS.includes(group) && (block.failed !== 0 || block.verdict !== "PASS")) {
      problems.push(`by_group.${group} is red: ${JSON.stringify(block.red_files)}`);
    }
  }
  if (byGroup.qualification?.gating !== false) {
    problems.push("the qualification group must be recorded as informational (gating false)");
  }
  const requiredEntries = entries.filter((entry) => GATING_GROUPS.includes(entry.group));
  if (requiredEntries.length !== EXPECTED_REQUIRED_TOTAL) {
    problems.push(`required entry records ${requiredEntries.length} !== expected ${EXPECTED_REQUIRED_TOTAL}`);
  }
  for (const entry of entries) {
    if (typeof entry.exit_code !== "number") {
      problems.push(`entry ${entry.name} must record a numeric exit_code`);
      continue;
    }
    if (GATING_GROUPS.includes(entry.group) && entry.exit_code !== 0) {
      problems.push(`gating entry ${entry.name} exited ${entry.exit_code}`);
    }
    if (entry.verdict !== (entry.exit_code === 0 ? "PASS" : "FAIL")) {
      problems.push(`entry ${entry.name} verdict ${entry.verdict} contradicts exit_code ${entry.exit_code}`);
    }
    if (entry.group === "qualification" && entry.exit_code !== 0) {
      problems.push(`the informational qualification entry exited ${entry.exit_code} (recorded, not gating)`);
    }
  }
  if (record.self_tests_alone?.total_required !== EXPECTED_REQUIRED_TOTAL) {
    problems.push(`self_tests_alone.total_required ${record.self_tests_alone?.total_required} !== ${EXPECTED_REQUIRED_TOTAL}`);
  }
  if (record.self_tests_alone?.passed_required !== EXPECTED_REQUIRED_TOTAL) {
    problems.push(`self_tests_alone.passed_required ${record.self_tests_alone?.passed_required} !== ${EXPECTED_REQUIRED_TOTAL}`);
  }
  if (record.self_tests_alone?.verdict !== "PASS") {
    problems.push(`self_tests_alone.verdict is ${JSON.stringify(record.self_tests_alone?.verdict)}`);
  }

  const o12 = record.o12_gate ?? {};
  if (o12.overall_verdict !== "PASS") problems.push(`o12_gate.overall_verdict is ${JSON.stringify(o12.overall_verdict)}`);
  if (o12.verdict !== "PASS") problems.push(`o12_gate.verdict is ${JSON.stringify(o12.verdict)}`);
  if (o12.matrix_pass !== true) problems.push("o12_gate.matrix_pass must be true");
  const matrix = o12.fixture_matrix ?? {};
  if (matrix.expected_fixture_count !== matrix.fixture_count) {
    problems.push(`fixture matrix expected_fixture_count ${matrix.expected_fixture_count} !== fixture_count ${matrix.fixture_count}`);
  }
  if (typeof matrix.fixture_count !== "number" || matrix.fixture_count <= 0) {
    problems.push("fixture matrix fixture_count must be a positive number");
  }
  if (matrix.all_match !== true) problems.push("fixture matrix all_match must be true");
  if (matrix.all_correction_cases_green !== true) problems.push("fixture matrix all_correction_cases_green must be true");
  if (matrix.validation_ok !== true) problems.push("fixture matrix validation must be ok");
  const o12Entries = Array.isArray(o12.entries) ? o12.entries : [];
  if (o12Entries.length === 0) problems.push("o12_gate.entries must record the per-entry exits");
  for (const entry of o12Entries) {
    if (entry.exit_code !== 0) problems.push(`o12 gate entry ${entry.name} exited ${entry.exit_code}`);
  }

  const snapshots = record.seed_snapshot?.snapshots ?? null;
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    problems.push("seed_snapshot.snapshots must record the owned seed stores");
  } else {
    const v13 = snapshots.find((snapshot) => snapshot.label === "v13");
    if (!v13) problems.push('seed_snapshot must record the owned v13 seed store (label "v13")');
    else {
      if (v13.user_version !== 13) problems.push(`the owned v13 seed store must be stamped 13 (got ${v13.user_version})`);
      if (typeof v13.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v13.sha256)) {
        problems.push("the owned v13 seed store must record its sha256");
      }
      if (v13.mode !== 292 /* 0o444 */) problems.push(`the owned v13 seed store must be retained read-only (got mode ${v13.mode})`);
    }
  }
  return { ok: problems.length === 0, problems };
}
