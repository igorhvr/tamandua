// o12-repin-contract.mjs — pure assembly + validation for the O12-REPIN
// acceptance contract (torture-test/oracles/O12-CONTRACT.md is the oracle
// contract; THIS file shapes the run-level acceptance artifact published at
// /home/kaladin/matchlock-work/o12-repin-contract.json).
//
// US-009 is the run's final acceptance artifact. It records EVIDENCE PATHS and
// EXACT COUNTS read from the retained JSON artifacts produced by US-002..US-008
// — never hand-typed summaries. This module is I/O-free: the publisher
// (`publish-o12-repin-contract.mjs`) does all reads/writes and hands parsed
// objects to the builders here. Keeping the shaping pure lets the contract be
// unit-tested without touching disk or spawning anything.

/** Contract envelope kind. */
export const CONTRACT_KIND = "o12-repin-acceptance-contract";

/** Contract schema version (bumped only on a shape change). */
export const CONTRACT_SCHEMA_VERSION = 1;

/** Canonical published contract path (outside the repository). */
export const CONTRACT_OUTPUT_PATH = "/home/kaladin/matchlock-work/o12-repin-contract.json";

/** Run/task identity recorded in the contract. */
export const O12_REPIN_TASK = "O12-REPIN";
export const O12_REPIN_BEAD = "tamandua-6sy.6.3.1";
export const O12_REPIN_PARENT_BEAD = "tamandua-6sy.6.3";

/** Committed readiness pointer (locates the published qualification). */
export const READINESS_POINTER_REL = "torture-test/storm-seed-readiness.json";

/** Published (host-owned) qualification path. */
export const PUBLISHED_QUALIFICATION_PATH = "/home/kaladin/matchlock-work/storm-seed-qualification.json";

/** The single shared storm gate lock every chain/battery is held under. */
export const GATE_LOCK_PATH = "/home/kaladin/matchlock-work/vaivm-gate.lock";

/** The eight sections the contract must carry, in publication order. */
export const CONTRACT_SECTIONS = Object.freeze([
  "schema10_rules",
  "fixtures",
  "eight_case_evidence",
  "seed_snapshot_matrix",
  "new_pin",
  "gates",
  "validation",
  "final_head",
]);

/** The eight O12-CLOSE correction cases US-002 keeps green. */
export const EIGHT_CORRECTION_CASE_IDS = Object.freeze([
  "o12-close-partial-run-baseline",
  "o12-close-partial-key-baseline",
  "o12-close-non-reserved-only-baseline",
  "o12-close-v2-unknown-key",
  "o12-close-key-introduced",
  "o12-close-empty-string-divergence",
  "o12-close-seven-orphans-count",
  "o12-close-run-number-allocator-characterization",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalize the scheduler's bare run id to the canonical `run-<uuid>` form. */
export function normalizeRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) return null;
  return runId.startsWith("run-") ? runId : `run-${runId}`;
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Extract the fail-closed unknown-version message template from the O12 oracle
 * source. The oracle throws an `OracleRuntimeError` naming the observed
 * `user_version` and the supported set `{9, 10}`; the contract records the
 * source template so the behavior is traceable to `lib/o12.mjs`.
 */
export function extractFailClosedMessage(o12Source) {
  const match = String(o12Source ?? "").match(
    /snapshot PRAGMA user_version[\s\S]*?supported schema versions are \{[^`]*?\}\}/,
  );
  return match ? match[0].replace(/\s+/g, " ").trim() : null;
}

/**
 * Parse the aged validator's frozen O12 pin constants from the source text.
 * Parsing (rather than importing) keeps this module free of `validate.mjs`
 * top-level side effects; the publisher cross-checks the parsed values against
 * the aged validation report's own `o12_pin` block.
 *
 * The durable pin is CONTENT-addressed (NPF-2 Part 2 / US-005): the 64-hex
 * `content_sha256` of the documented O12 oracle set, with the landed squash
 * commit recorded as provenance only.  The pre-squash `O12_PINNED_COMMIT`
 * (064e9cb5) is unreachable after the merge-worktree squash and is no longer
 * parsed or validated.  The prior RUN45 schema-9 pin stays as a provisional
 * reference.
 */
export function parseAgedPinConstants(validateSource) {
  const source = String(validateSource ?? "");
  const grab = (name) => {
    const re = new RegExp(`export const ${name} =\\s*\\n?\\s*"([^"]*)"`);
    const match = source.match(re);
    return match ? match[1] : null;
  };
  return {
    content_sha256: grab("O12_PINNED_CONTENT_SHA256"),
    provenance_commit: grab("O12_PINNED_PROVENANCE_COMMIT"),
    provenance_subject: grab("O12_PINNED_PROVENANCE_SUBJECT"),
    acceptance: grab("O12_PINNED_ACCEPTANCE"),
    acceptance_detail: grab("O12_PINNED_ACCEPTANCE_DETAIL"),
    // TORTURE-PORT US-006: the declared pre-port (schema-10) content pin.  The
    // retained seed report hashes to this value; consumers anchor such a report
    // to the CURRENT content pin and record the report as legacy provenance.
    pre_port_content_sha256: grab("O12_PRE_PORT_CONTENT_SHA256"),
    pre_port_provenance_commit: grab("O12_PRE_PORT_PROVENANCE_COMMIT"),
    pre_port_provenance_subject: grab("O12_PRE_PORT_PROVENANCE_SUBJECT"),
    prior: {
      commit: grab("O12_PRIOR_PIN"),
      acceptance: grab("O12_PRIOR_ACCEPTANCE"),
    },
  };
}

/**
 * Build the schema-10 rules section from the live O12 schema descriptors: the
 * supported-version set, the exact v9->v10 `runs` column delta, and the
 * fail-closed unknown-version behavior.
 */
export function buildSchema10Rules({ supportedVersions, descriptors, failClosedMessage }) {
  const versions = Array.isArray(supportedVersions) ? [...supportedVersions] : [];
  const v9Runs = descriptors?.[9]?.coreTables?.runs ?? null;
  const v10Runs = descriptors?.[10]?.coreTables?.runs ?? null;
  const added = Array.isArray(v9Runs) && Array.isArray(v10Runs)
    ? v10Runs.filter((column) => !v9Runs.includes(column))
    : [];
  const removed = Array.isArray(v9Runs) && Array.isArray(v10Runs)
    ? v9Runs.filter((column) => !v10Runs.includes(column))
    : [];
  const deltaColumns = [...added.map((c) => `runs.${c}`), ...removed.map((c) => `runs.${c}`)];
  return {
    supported_user_versions: versions,
    supported_versions_source:
      "torture-test/oracles/lib/o12.mjs O12_SUPPORTED_SCHEMA_VERSIONS",
    contract_doc: "torture-test/oracles/O12-CONTRACT.md",
    v9_to_v10_delta: {
      added_columns: added.map((c) => `runs.${c}`),
      removed_columns: removed.map((c) => `runs.${c}`),
      columns: deltaColumns,
      v9_runs_columns: v9Runs,
      v10_runs_columns: v10Runs,
      derived_from: "src/db.ts applySchema v9 and v10 (read-only; no src/ edits)",
    },
    v10_column: {
      column: "runs.matchlock_policy",
      type: "TEXT (nullable)",
      present_in: [10],
      absent_in: [9],
      requirement:
        "a user_version-10 snapshot missing runs.matchlock_policy is malformed for v10 and fails closed as whole-oracle ERROR",
    },
    unknown_user_version: {
      behavior: "whole-oracle ERROR (exit code 2, zero evidence artifacts)",
      names_observed_version: true,
      names_supported_set: true,
      supported_set: versions,
      message_template: failClosedMessage,
    },
  };
}

/** Summarize the regenerated fixture set: counts, schema distribution, workspace. */
export function buildFixturesSection(fixtureMatrix, sourcePath = null) {
  const entries = Array.isArray(fixtureMatrix?.entries) ? fixtureMatrix.entries : [];
  const distribution = {};
  for (const entry of entries) {
    const key = entry?.schema_user_version === null || entry?.schema_user_version === undefined
      ? "non-evaluable"
      : String(entry.schema_user_version);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  return {
    expected_fixture_count: fixtureMatrix?.expected_fixture_count ?? null,
    fixture_count: fixtureMatrix?.fixture_count ?? null,
    all_match: fixtureMatrix?.all_match === true,
    all_correction_cases_green: fixtureMatrix?.all_correction_cases_green === true,
    schema_distribution: distribution,
    fixture_names: entries.map((entry) => entry?.name ?? null),
    retained_workspace: fixtureMatrix?.workspace ?? null,
    generation_receipt_root: fixtureMatrix?.generation_receipt?.root ?? null,
    generation_receipt_count: fixtureMatrix?.generation_receipt?.fixture_count ?? null,
    source_artifact: sourcePath,
  };
}

/**
 * Map the eight O12-CLOSE correction cases to their fixture names with
 * expected/observed results straight from the fixture matrix. Fails closed if
 * the matrix does not surface all eight.
 */
export function buildEightCaseEvidence(fixtureMatrix) {
  const cases = Array.isArray(fixtureMatrix?.correction_cases) ? fixtureMatrix.correction_cases : [];
  return cases.map((entry) => ({
    case_id: entry?.case_id ?? null,
    kind: entry?.kind ?? null,
    fixture: entry?.fixture ?? null,
    label: entry?.label ?? null,
    expected: entry?.expected ?? null,
    observed: entry?.observed ?? null,
    match: entry?.match === true,
    present: entry?.present === true,
    probes: Array.isArray(entry?.probes) ? entry.probes : undefined,
  }));
}

/** Shape the US-004 R1..R6 seed-snapshot matrix with exact counts and evidence paths. */
export function buildSeedSnapshotMatrix(seedMatrix, sourcePath = null) {
  const legs = seedMatrix?.legs ?? null;
  return {
    user_version: seedMatrix?.schema?.user_version ?? null,
    supported_user_versions: seedMatrix?.schema?.supported_user_versions ?? null,
    supported_version: seedMatrix?.schema?.supported_version ?? null,
    overall_result: seedMatrix?.overall_result ?? null,
    verdict: seedMatrix?.verdict ?? null,
    legs,
    r3_attribution: seedMatrix?.r3_attribution ?? null,
    evidence: seedMatrix?.evidence ?? null,
    copied_artifacts: seedMatrix?.copied_artifacts ?? null,
    source_artifact: sourcePath,
  };
}

/**
 * Shape the new O12 pin from the aged validation report's own `o12_pin` block:
 * the content-addressed pin (`content_sha256`) plus the provenance commit that
 * landed that content, the acceptance status/detail and the acceptance
 * evidence paths.  The legacy pre-squash `commit`/`tree`/`subject` are gone:
 * the sha-256 of the oracle BYTES is the durable anchor a future squash cannot
 * invalidate.
 */
export function buildNewPin({ pin, acceptanceEvidence = [] }) {
  return {
    content_sha256: pin?.content_sha256 ?? null,
    provenance_commit: pin?.provenance_commit ?? null,
    provenance_subject: pin?.provenance_subject ?? null,
    acceptance: pin?.acceptance ?? null,
    acceptance_detail: pin?.acceptance_detail ?? null,
    acceptance_evidence: [...acceptanceEvidence],
    prior_pin: pin?.prior
      ? {
        commit: pin.prior.commit,
        acceptance: pin.prior.acceptance,
        label: "schema-9-only prior pin kept provisional",
      }
      : null,
  };
}

/**
 * Shape the gate battery results: the US-007 aged/O12/storm self-tests alone
 * plus the US-008 49-file storm chain held under one flock.
 */
export function buildGatesSection({ batterySummary, batteryRetainedPath, chainSummary, chainRetainedPath }) {
  const groups = batterySummary?.by_group ?? {};
  return {
    lock_path: GATE_LOCK_PATH,
    aged_o12_storm_self_tests_alone: {
      summary_path: batteryRetainedPath ?? batterySummary?.results_dir ?? null,
      origin_results_dir: batterySummary?.results_dir ?? null,
      scope: batterySummary?.scope ?? null,
      total: batterySummary?.total ?? null,
      passed: batterySummary?.passed ?? null,
      failed: batterySummary?.failed ?? null,
      verdict: batterySummary?.verdict ?? null,
      by_group: groups,
      submitted_at: batterySummary?.submitted_at ?? null,
      acquired_at: batterySummary?.acquired_at ?? null,
      finished_at: batterySummary?.finished_at ?? null,
      guard_safe_repo_root: batterySummary?.environment?.guard_safe_repo_root ?? null,
      gate_env: batterySummary?.environment?.gate_env ?? null,
    },
    storm_chain_49: {
      summary_path: chainRetainedPath ?? chainSummary?.evidence_dir ?? null,
      origin_evidence_dir: chainSummary?.evidence_dir ?? null,
      file_count_expected: chainSummary?.file_count_expected ?? null,
      file_count_observed: chainSummary?.file_count_observed ?? null,
      red_file_count: chainSummary?.red_file_count ?? null,
      red_files: chainSummary?.red_files ?? null,
      totals: chainSummary?.totals ?? null,
      verdict: chainSummary?.verdict ?? null,
      harness_guard_env: chainSummary?.harness_guard_env ?? null,
      lock: chainSummary?.lock ?? null,
      run7_chain_files: chainSummary?.run7_chain_files ?? null,
    },
  };
}

/** Shape the validation section: fresh aged report + readiness pointer + qualification. */
export function buildValidationSection({
  report,
  reportPath,
  readiness,
  readinessPointerPath,
  qualification,
  qualificationPath,
}) {
  return {
    aged_validation_report: reportPath,
    validator_source_head: report?.validator_source?.head?.sha ?? null,
    o12_pin: report?.o12_pin ?? null,
    o12_result: report?.o12?.stdoutJson?.result ?? null,
    o12_exit_code: report?.o12?.exitCode ?? null,
    readiness_pointer: readinessPointerPath ?? null,
    readiness_pointer_kind: readiness?.kind ?? null,
    readiness_pointer_run_id: readiness?.run_id ?? null,
    readiness_pointer_branch: readiness?.branch ?? null,
    readiness_pointer_source_commit: readiness?.source?.commit ?? null,
    readiness_pointer_source_tree: readiness?.source?.tree ?? null,
    readiness_pointer_qualified: readiness?.qualification?.qualified ?? null,
    published_qualification: qualificationPath ?? null,
    published_qualification_kind: qualification?.kind ?? null,
    published_qualification_qualified: qualification?.qualified ?? null,
    published_qualification_blockers: qualification?.blocker_ids ?? null,
    gate_hash_count: Array.isArray(qualification?.gate_hashes)
      ? qualification.gate_hashes.length
      : qualification?.gate_hashes && typeof qualification.gate_hashes === "object"
        ? Object.keys(qualification.gate_hashes).length
        : null,
  };
}

/** Shape the final head plus the clean-tree / no-src / no-approval confirmations. */
export function buildFinalHead({
  commit,
  tree,
  subject,
  branch,
  worktreeClean,
  srcModified,
  approvalFilesChanged,
  baseRef = null,
}) {
  return {
    commit: commit ?? null,
    tree: tree ?? null,
    subject: subject ?? null,
    branch: branch ?? null,
    base_ref: baseRef,
    worktree_clean: worktreeClean === true,
    src_modified: srcModified === true,
    approval_files_created_or_modified: Array.isArray(approvalFilesChanged) && approvalFilesChanged.length > 0,
    approval_files_changed: Array.isArray(approvalFilesChanged) ? [...approvalFilesChanged] : [],
    status_porcelain_empty: worktreeClean === true,
  };
}

/** Assemble the complete contract from already-shaped parts. */
export function assembleContract(parts) {
  return {
    kind: CONTRACT_KIND,
    schema_version: CONTRACT_SCHEMA_VERSION,
    task: O12_REPIN_TASK,
    bead: O12_REPIN_BEAD,
    parent_bead: O12_REPIN_PARENT_BEAD,
    generated_at_utc: parts.generated_at_utc ?? new Date().toISOString(),
    run_id: parts.run_id ?? null,
    branch: parts.branch ?? null,
    schema10_rules: parts.schema10_rules,
    fixtures: parts.fixtures,
    eight_case_evidence: parts.eight_case_evidence,
    seed_snapshot_matrix: parts.seed_snapshot_matrix,
    new_pin: parts.new_pin,
    gates: parts.gates,
    validation: parts.validation,
    final_head: parts.final_head,
  };
}

function validateSchema10Rules(rules, problems) {
  if (!isObject(rules)) {
    problems.push("schema10_rules is not an object");
    return;
  }
  if (!jsonEqual(rules.supported_user_versions, [9, 10])) {
    problems.push(`schema10_rules.supported_user_versions ${JSON.stringify(rules.supported_user_versions)} !== [9,10]`);
  }
  const added = rules.v9_to_v10_delta?.added_columns;
  if (!Array.isArray(added) || !added.includes("runs.matchlock_policy")) {
    problems.push("schema10_rules.v9_to_v10_delta.added_columns must include runs.matchlock_policy");
  }
  if (rules.v10_column?.column !== "runs.matchlock_policy") {
    problems.push(`schema10_rules.v10_column.column ${JSON.stringify(rules.v10_column?.column)} !== runs.matchlock_policy`);
  }
  if (!Array.isArray(rules.v9_to_v10_delta?.v9_runs_columns)
    || rules.v9_to_v10_delta.v9_runs_columns.includes("matchlock_policy")) {
    problems.push("schema10_rules v9 runs column universe must not include matchlock_policy");
  }
  if (!Array.isArray(rules.v9_to_v10_delta?.v10_runs_columns)
    || !rules.v9_to_v10_delta.v10_runs_columns.includes("matchlock_policy")) {
    problems.push("schema10_rules v10 runs column universe must include matchlock_policy");
  }
  const unknown = rules.unknown_user_version ?? {};
  if (!/ERROR/.test(String(unknown.behavior ?? ""))) {
    problems.push("schema10_rules.unknown_user_version.behavior must be whole-oracle ERROR");
  }
  if (unknown.names_observed_version !== true || unknown.names_supported_set !== true) {
    problems.push("schema10_rules.unknown_user_version must name the observed version and the supported set");
  }
  if (!jsonEqual(unknown.supported_set, [9, 10])) {
    problems.push(`schema10_rules.unknown_user_version.supported_set ${JSON.stringify(unknown.supported_set)} !== [9,10]`);
  }
}

function validateFixtures(fixtures, problems) {
  if (!isObject(fixtures)) {
    problems.push("fixtures is not an object");
    return;
  }
  if (fixtures.fixture_count !== fixtures.expected_fixture_count) {
    problems.push(`fixtures count ${fixtures.fixture_count} !== expected ${fixtures.expected_fixture_count}`);
  }
  if (fixtures.all_match !== true) problems.push("fixtures.all_match is not true");
  if (fixtures.all_correction_cases_green !== true) {
    problems.push("fixtures.all_correction_cases_green is not true");
  }
  if (!Array.isArray(fixtures.fixture_names) || fixtures.fixture_names.length !== fixtures.fixture_count) {
    problems.push("fixtures.fixture_names length does not equal fixture_count");
  }
}

function validateEightCaseEvidence(cases, problems) {
  if (!Array.isArray(cases)) {
    problems.push("eight_case_evidence is not an array");
    return;
  }
  if (cases.length !== EIGHT_CORRECTION_CASE_IDS.length) {
    problems.push(`eight_case_evidence length ${cases.length} !== ${EIGHT_CORRECTION_CASE_IDS.length}`);
  }
  const ids = cases.map((entry) => entry?.case_id);
  for (const expectedId of EIGHT_CORRECTION_CASE_IDS) {
    if (!ids.includes(expectedId)) problems.push(`eight_case_evidence missing case ${expectedId}`);
  }
  for (const entry of cases) {
    if (entry?.match !== true) {
      problems.push(`eight_case_evidence case ${JSON.stringify(entry?.case_id)} is not green`);
    }
    if (entry?.expected !== entry?.observed) {
      problems.push(
        `eight_case_evidence case ${JSON.stringify(entry?.case_id)} expected ${JSON.stringify(entry?.expected)} != observed ${JSON.stringify(entry?.observed)}`,
      );
    }
    if (entry?.present !== true) {
      problems.push(`eight_case_evidence case ${JSON.stringify(entry?.case_id)} is not present`);
    }
  }
}

function validateSeedMatrix(seed, problems) {
  if (!isObject(seed)) {
    problems.push("seed_snapshot_matrix is not an object");
    return;
  }
  if (seed.user_version !== 10) {
    problems.push(`seed_snapshot_matrix.user_version ${JSON.stringify(seed.user_version)} !== 10`);
  }
  if (!jsonEqual(seed.supported_user_versions, [9, 10])) {
    problems.push("seed_snapshot_matrix.supported_user_versions must be [9,10]");
  }
  const expectedLegs = { R1: "PASS", R2: "PASS", R3: "FAIL", R4: "PASS", R5: "PASS" };
  for (const [leg, result] of Object.entries(expectedLegs)) {
    if (seed.legs?.[leg]?.result !== result) {
      problems.push(`seed_snapshot_matrix.legs.${leg}.result ${JSON.stringify(seed.legs?.[leg]?.result)} !== ${result}`);
    }
  }
  const r3 = seed.legs?.R3;
  if (r3?.pair_format_mismatch_count !== 24166) {
    problems.push(`seed_snapshot_matrix R3 pair_format_mismatch_count ${JSON.stringify(r3?.pair_format_mismatch_count)} !== 24166`);
  }
  if (r3?.runs_pair_mismatch_count !== 5000 || r3?.steps_pair_mismatch_count !== 19166) {
    problems.push("seed_snapshot_matrix R3 pair split must be 5000 runs + 19166 steps");
  }
  if (seed.overall_result !== "FAIL") {
    problems.push(`seed_snapshot_matrix.overall_result ${JSON.stringify(seed.overall_result)} !== FAIL`);
  }
  if (seed.r3_attribution?.not_seed_corruption !== true || seed.r3_attribution?.not_validator_defect !== true) {
    problems.push("seed_snapshot_matrix.r3_attribution must attribute R3 to the native TIME product defect");
  }
  if (!seed.source_artifact) problems.push("seed_snapshot_matrix.source_artifact missing");
}

function validateNewPin(pin, problems) {
  if (!isObject(pin)) {
    problems.push("new_pin is not an object");
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(String(pin.content_sha256 ?? ""))) {
    problems.push(`new_pin.content_sha256 ${JSON.stringify(pin.content_sha256)} is not a 64-hex content hash`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(pin.provenance_commit ?? ""))) {
    problems.push(`new_pin.provenance_commit ${JSON.stringify(pin.provenance_commit)} is not a full sha`);
  }
  if (!pin.acceptance || pin.acceptance === "NOT_ROOT_ACCEPTED") {
    problems.push(`new_pin.acceptance ${JSON.stringify(pin.acceptance)} is not the accepted value`);
  }
  if (!Array.isArray(pin.acceptance_evidence) || pin.acceptance_evidence.length === 0) {
    problems.push("new_pin.acceptance_evidence is empty");
  }
}

function validateGates(gates, problems) {
  if (!isObject(gates)) {
    problems.push("gates is not an object");
    return;
  }
  if (gates.lock_path !== GATE_LOCK_PATH) {
    problems.push(`gates.lock_path ${JSON.stringify(gates.lock_path)} !== ${GATE_LOCK_PATH}`);
  }
  const alone = gates.aged_o12_storm_self_tests_alone ?? {};
  if (alone.verdict !== "PASS" || alone.failed !== 0) {
    problems.push(`gates self-tests-alone verdict ${JSON.stringify(alone.verdict)} / failed ${JSON.stringify(alone.failed)}`);
  }
  for (const group of ["aged", "o12", "storm"]) {
    const block = alone.by_group?.[group];
    if (!block) problems.push(`gates self-tests-alone missing by_group.${group}`);
    else if (block.verdict !== "PASS" || block.failed !== 0) {
      problems.push(`gates self-tests-alone by_group.${group} is red: ${JSON.stringify(block.red_files)}`);
    }
  }
  const chain = gates.storm_chain_49 ?? {};
  if (chain.verdict !== "PASS") problems.push(`gates.storm_chain_49.verdict ${JSON.stringify(chain.verdict)} !== PASS`);
  if (chain.file_count_expected !== 49 || chain.file_count_observed !== 49) {
    problems.push("gates.storm_chain_49 must observe exactly 49 files");
  }
  if (chain.red_file_count !== 0) problems.push("gates.storm_chain_49.red_file_count must be 0");
  if (chain.totals?.fail !== 0) problems.push("gates.storm_chain_49.totals.fail must be 0");
  const lock = chain.lock ?? {};
  if (lock.path !== GATE_LOCK_PATH) problems.push("gates.storm_chain_49.lock.path must be the shared gate lock");
  for (const key of ["submit_iso", "acquire_iso", "release_iso"]) {
    if (typeof lock[key] !== "string" || lock[key].length === 0) {
      problems.push(`gates.storm_chain_49.lock.${key} missing (flock timing required)`);
    }
  }
  if (lock.untouched === false) problems.push("gates.storm_chain_49.lock was modified");
}

function validateValidation(validation, problems) {
  if (!isObject(validation)) {
    problems.push("validation is not an object");
    return;
  }
  if (!validation.aged_validation_report) problems.push("validation.aged_validation_report missing");
  if (!validation.readiness_pointer) problems.push("validation.readiness_pointer missing");
  if (!validation.published_qualification) problems.push("validation.published_qualification missing");
  if (validation.published_qualification !== PUBLISHED_QUALIFICATION_PATH) {
    problems.push("validation.published_qualification is not the canonical published qualification path");
  }
}

function validateFinalHead(finalHead, problems) {
  if (!isObject(finalHead)) {
    problems.push("final_head is not an object");
    return;
  }
  if (!/^[0-9a-f]{40}$/.test(String(finalHead.commit ?? ""))) {
    problems.push(`final_head.commit ${JSON.stringify(finalHead.commit)} is not a full sha`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(finalHead.tree ?? ""))) {
    problems.push(`final_head.tree ${JSON.stringify(finalHead.tree)} is not a full tree sha`);
  }
  if (finalHead.worktree_clean !== true) problems.push("final_head.worktree_clean is not true");
  if (finalHead.src_modified !== false) problems.push("final_head.src_modified must be false");
  if (finalHead.approval_files_created_or_modified !== false) {
    problems.push("final_head.approval_files_created_or_modified must be false");
  }
}

/**
 * Validate a complete contract. Returns `{ ok, problems }` and never throws.
 * Every section is checked for its load-bearing invariant; a contract that
 * disagrees with the retained evidence is not publishable.
 */
export function validateContract(contract) {
  const problems = [];
  if (!isObject(contract)) return { ok: false, problems: ["contract is not an object"] };
  if (contract.kind !== CONTRACT_KIND) {
    problems.push(`contract.kind ${JSON.stringify(contract.kind)} !== ${CONTRACT_KIND}`);
  }
  if (contract.schema_version !== CONTRACT_SCHEMA_VERSION) {
    problems.push(`contract.schema_version ${JSON.stringify(contract.schema_version)} !== ${CONTRACT_SCHEMA_VERSION}`);
  }
  for (const section of CONTRACT_SECTIONS) {
    if (!(section in contract)) problems.push(`contract is missing section ${section}`);
  }
  validateSchema10Rules(contract.schema10_rules, problems);
  validateFixtures(contract.fixtures, problems);
  validateEightCaseEvidence(contract.eight_case_evidence, problems);
  validateSeedMatrix(contract.seed_snapshot_matrix, problems);
  validateNewPin(contract.new_pin, problems);
  validateGates(contract.gates, problems);
  validateValidation(contract.validation, problems);
  validateFinalHead(contract.final_head, problems);
  return { ok: problems.length === 0, problems };
}
