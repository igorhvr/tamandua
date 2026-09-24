// o12-schema13-contract.mjs — pure assembly + validation for the O12-SCHEMA-13
// acceptance contract (torture-test/impl-tasks/o12-schema13-contract.json).
//
// O12-SCHEMA-13 teaches the O12 oracle the whole product schema chain
// 9..13 (11 = steps.target_moved_reroute_count, 12 = steps.preclaim_death_count
// with a DUAL main/matchlock lineage, 13 = runs.matchlock_policy).  This module
// shapes the run-level acceptance contract that records — with every load-
// bearing value read from a COMMITTED artifact, never retyped — the per-version
// column expectations, the v12 lineage classification, the runs.matchlock_policy
// value contract, the regenerated fixtures, the content pin and its swept
// consumers, the exact gate commands/exits and the final head.
//
// It is deliberately I/O-FREE: the publisher
// (`publish-o12-schema13-contract.mjs`) performs every read/write/import and
// hands parsed values to the builders here.  Keeping the shaping pure lets the
// contract shape and its validator be unit-tested without touching disk or
// spawning anything.  `validateContract(contract)` returns `{ ok, problems }`
// and never throws.

/** Contract envelope kind. */
export const CONTRACT_KIND = "o12-schema13-acceptance-contract";

/** Contract schema version (bumped only on a shape change). */
export const CONTRACT_SCHEMA_VERSION = 1;

/** Tracked (repo-relative) path the publisher writes by default. */
export const CONTRACT_OUTPUT_REL = "torture-test/impl-tasks/o12-schema13-contract.json";

/** Committed gate-evidence record the contract derives its gate facts from. */
export const GATE_EVIDENCE_REL = "torture-test/impl-tasks/o12-schema13-gate-evidence.json";

/** Committed sources the publisher reads the descriptors, pin and cases from. */
export const ORACLE_LIB_REL = "torture-test/oracles/lib/o12.mjs";
export const PIN_SOURCE_REL = "torture-test/aged/validate.mjs";
export const FIXTURE_GENERATOR_REL = "torture-test/oracles/self-test/generate-o12-fixtures.mjs";

/** Run/task identity recorded in the contract. */
export const O12_SCHEMA13_TASK = "O12-SCHEMA-13";
export const O12_SCHEMA13_BEAD = "tamandua-6sy.6.3.1";
export const O12_SCHEMA13_PARENT_BEAD = "tamandua-6sy.6.3";

/** The supported product schema chain (mirrors O12_SUPPORTED_SCHEMA_VERSIONS).
 * The publisher hard-asserts it against the live oracle, so it tracks the oracle
 * set; v14 (LEDGER-DIAG) adds only the non-core suite_results.log_path column,
 * so the per-version shapes below stay the six judgeable runs/steps universes. */
export const SUPPORTED_USER_VERSIONS = Object.freeze([9, 10, 11, 12, 13, 14]);

/** The six judgeable shapes the contract records expectations for. */
export const CONTRACT_SHAPES = Object.freeze([
  "v9",
  "v10",
  "v11",
  "v12-main",
  "v12-matchlock",
  "v13",
]);

/** The three legal v12 lineages (dual-lineage classification). */
export const V12_LINEAGE_IDS = Object.freeze(["main-v12", "matchlock-v12", "v12-superset"]);

/** The v12 discriminator columns (order mirrors resolveO12SchemaExpectation). */
export const V12_DISCRIMINATOR_COLUMNS = Object.freeze([
  "runs.matchlock_policy",
  "steps.preclaim_death_count",
]);

/** The frozen gating entry counts the committed gate evidence must report. */
export const EXPECTED_GATE_COUNTS = Object.freeze({ npf2: 2, aged: 4, o12: 8, qualification: 1 });

/** The gating groups (the informational `qualification` group never gates). */
export const GATING_GROUPS = Object.freeze(["npf2", "aged", "o12"]);

/** Total required (gating) entries: 2 + 4 + 8. */
export const EXPECTED_REQUIRED_TOTAL = 14;

/** The red arms the focused test proves the validator rejects. */
export const REQUIRED_RED_ARMS = Object.freeze([
  "tampered content_sha256",
  "tampered gate exit code",
  "missing section",
  "non-member supported version",
]);

/** The recorded VM substitutions the contract must surface (never silently). */
export const REQUIRED_SUBSTITUTION_MARKERS = Object.freeze([
  "/tmp/vaivm-gate.lock",
  "seed-snapshot-v13.sqlite",
]);

/** The eight sections the contract must carry, in publication order. */
export const CONTRACT_SECTIONS = Object.freeze([
  "per_version_expectations",
  "lineage_handling",
  "matchlock_policy",
  "fixtures",
  "repin",
  "gates",
  "validation",
  "final_head",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sortedUnique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string"))].sort();
}

/** Normalize the scheduler's bare run id to the canonical `run-<uuid>` form. */
export function normalizeRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) return null;
  return runId.startsWith("run-") ? runId : `run-${runId}`;
}

/**
 * Extract the fail-closed unknown-version message template from the O12 oracle
 * source.  The oracle throws an `OracleRuntimeError` naming the observed
 * `user_version` and the supported set `{9, 10, 11, 12, 13}`; the contract
 * records the source template so the behavior is traceable to lib/o12.mjs.
 */
export function extractFailClosedMessage(o12Source) {
  const match = String(o12Source ?? "").match(
    /snapshot PRAGMA user_version[\s\S]*?supported schema versions are \{[^`]*?\}\}/,
  );
  return match ? match[0].replace(/\s+/g, " ").trim() : null;
}

/** Extract the v12 neither-lineage fail-closed message template from source. */
export function extractV12NeitherLineageMessage(o12Source) {
  const match = String(o12Source ?? "").match(
    /snapshot PRAGMA user_version 12 carries neither[\s\S]*?Matchlock lineage\)/,
  );
  return match ? match[0].replace(/\s+/g, " ").trim() : null;
}

/**
 * Return `name` when the O12 oracle source literally carries it (a finding id
 * the contract records), else null.  Parsing the source keeps the finding id
 * derived from the oracle rather than hand-typed in the publisher.
 */
export function extractFindingName(o12Source, name) {
  return String(o12Source ?? "").includes(name) ? name : null;
}

/**
 * Parse the aged validator's frozen pin constants from its source text.
 * Parsing (rather than importing `validate.mjs`) keeps this module free of
 * top-level heavy imports; the publisher cross-checks the parsed values against
 * the constants it imports and against `computeO12OracleContentHash`.
 */
export function parsePinConstants(validateSource) {
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
  };
}

/** Parse the O12 fixture generator for its `o12-schema-*` case ids (sorted). */
export function extractFixtureCaseIds(generatorSource) {
  const ids = [];
  const re = /name:\s*'(o12-schema-[a-z0-9-]+)'/g;
  let match = re.exec(String(generatorSource ?? ""));
  while (match !== null) {
    ids.push(match[1]);
    match = re.exec(String(generatorSource ?? ""));
  }
  return sortedUnique(ids);
}

/**
 * Build the per-version expectations: one entry per judgeable shape
 * (9, 10, 11, 12-main, 12-matchlock, 13) with the required columns, the
 * declared type/default of every version-added column (from the descriptor's
 * columnDeclarations) and the expected verdict for that shape.
 */
export function buildPerVersionExpectations({ descriptors, supportedVersions }) {
  const shapeDescriptors = {
    v9: descriptors?.[9],
    v10: descriptors?.[10],
    v11: descriptors?.[11],
    "v12-main": descriptors?.[12]?.lineages?.["main-v12"],
    "v12-matchlock": descriptors?.[12]?.lineages?.["matchlock-v12"],
    v13: descriptors?.[13],
  };
  const entries = CONTRACT_SHAPES.map((shape) => {
    const descriptor = shapeDescriptors[shape];
    const declarations = isObject(descriptor?.columnDeclarations) ? descriptor.columnDeclarations : {};
    return {
      shape,
      user_version: descriptor?.user_version ?? null,
      lineage: descriptor?.lineage ?? null,
      required_columns: {
        runs: [...(descriptor?.coreTables?.runs ?? [])],
        steps: [...(descriptor?.coreTables?.steps ?? [])],
        stories: [...(descriptor?.coreTables?.stories ?? [])],
      },
      version_added_columns: Object.entries(declarations)
        .map(([column, declaration]) => ({
          column,
          type: declaration?.type ?? null,
          default: declaration?.default ?? null,
        }))
        .sort((a, b) => a.column.localeCompare(b.column)),
      // Every listed shape is exactly the column universe its descriptor
      // promises, so the oracle accepts it (the six fixture controls are PASS).
      expected_verdict: descriptor === undefined ? null : "PASS",
    };
  });
  return {
    supported_user_versions: [...(supportedVersions ?? SUPPORTED_USER_VERSIONS)],
    shapes: [...CONTRACT_SHAPES],
    shapes_source: ORACLE_LIB_REL,
    entries,
  };
}

/**
 * Build the v12 dual-lineage classification and the fail-closed unknown-version
 * rule, both derived from the live descriptors.
 */
export function buildLineageHandling({ descriptors, supportedVersions, failClosedMessage, neitherLineageMessage }) {
  const v12 = descriptors?.[12] ?? {};
  const lineages = isObject(v12.lineages) ? v12.lineages : {};
  const classifications = Object.entries(lineages).map(([lineage, descriptor]) => {
    const hasMatchlock = (descriptor?.coreTables?.runs ?? []).includes("matchlock_policy");
    const hasPreclaim = (descriptor?.coreTables?.steps ?? []).includes("preclaim_death_count");
    const rule = hasMatchlock && hasPreclaim
      ? "both discriminator columns present"
      : hasPreclaim
        ? "steps.preclaim_death_count present without runs.matchlock_policy"
        : "runs.matchlock_policy present without steps.preclaim_death_count";
    return {
      lineage,
      matchlock_policy_present: hasMatchlock,
      preclaim_death_count_present: hasPreclaim,
      rule,
    };
  });
  const versions = [...(supportedVersions ?? [])];
  return {
    supported_user_versions: versions,
    v12_dual_lineage: {
      user_version: 12,
      discriminator_columns: [...(v12.discriminators ?? V12_DISCRIMINATOR_COLUMNS)],
      classifications,
      neither_lineage: {
        behavior: "whole-oracle ERROR (exit 2, zero evidence artifacts)",
        names_observed_version: true,
        names_missing_columns: true,
        missing_columns: [...(v12.discriminators ?? V12_DISCRIMINATOR_COLUMNS)],
        message_template: neitherLineageMessage ?? null,
      },
    },
    unknown_user_version: {
      behavior: "whole-oracle ERROR (exit 2, zero evidence artifacts)",
      names_observed_version: true,
      names_supported_set: true,
      supported_set: versions,
      message_template: failClosedMessage ?? null,
    },
  };
}

/** Build the runs.matchlock_policy value contract from the oracle constants. */
export function buildMatchlockPolicy({ policy, findingName }) {
  const harnessKeys = isObject(policy?.harnessKeys) ? policy.harnessKeys : {};
  return {
    policy_version: policy?.policyVersion ?? null,
    backend: policy?.backend ?? null,
    harnesses: [...(policy?.harnesses ?? [])],
    required_keys: [...(policy?.requiredKeys ?? [])],
    optional_keys: [...(policy?.optionalKeys ?? [])],
    harness_submission_blocks: {
      pi: [...(harnessKeys.pi ?? [])],
      hermes: [...(harnessKeys.hermes ?? [])],
      dsh: [...(harnessKeys.dsh ?? [])],
    },
    hermes_submission_block_keys: [...(policy?.hermesBlockKeys ?? [])],
    dsh_home_sources: [...(policy?.dshHomeSources ?? [])],
    credential_key_fragments: [...(policy?.credentialKeyFragments ?? [])],
    null_native_semantics: {
      null: "native (non-Matchlock) run: VALID, no finding",
      scoped_to_universe:
        "the v13 and Matchlock-lineage v12 universes carry the column; a value there is judged",
      out_of_universe:
        "a version universe that does not carry the column is NOT_APPLICABLE and never policy-judged",
    },
    invalid_policy: {
      finding: findingName ?? null,
      effect: "makes R1 FAIL (exit 1, evidence still written) — never a whole-oracle ERROR",
      triggers:
        "unparseable JSON or a record failing the required key set / fixed-value enums / harness submission block / credential-key check",
    },
  };
}

/** Build the fixtures section: the schema 9..13 case ids + the pinned count. */
export function buildFixtures({ fixtureCaseIds, fixtureMatrix, sourcePath }) {
  return {
    fixture_case_ids: sortedUnique(fixtureCaseIds),
    fixture_count: fixtureMatrix?.fixture_count ?? null,
    expected_fixture_count: fixtureMatrix?.expected_fixture_count ?? null,
    all_match: fixtureMatrix?.all_match === true,
    all_correction_cases_green: fixtureMatrix?.all_correction_cases_green === true,
    snapshot_immutability_ok: fixtureMatrix?.snapshot_immutability_ok === true,
    fixture_matrix_validation_ok: fixtureMatrix?.validation_ok === true,
    fixture_matrix_validation_problems: [...(fixtureMatrix?.validation_problems ?? [])],
    generator_source: FIXTURE_GENERATOR_REL,
    source_artifact: sourcePath ?? null,
  };
}

/**
 * Build the re-pin section: the content sha256, its provenance and the swept
 * consumers (all derived by the publisher scanning the tree for the pin
 * constants — never hand-typed).
 */
export function buildRepin({ pin, contentPaths, sweptConsumers }) {
  return {
    content_sha256: pin?.content_sha256 ?? null,
    provenance_commit: pin?.provenance_commit ?? null,
    provenance_subject: pin?.provenance_subject ?? null,
    acceptance: pin?.acceptance ?? null,
    acceptance_detail: pin?.acceptance_detail ?? null,
    content_paths: Array.isArray(contentPaths) ? [...contentPaths] : [],
    content_paths_count: Array.isArray(contentPaths) ? contentPaths.length : 0,
    swept_consumers: sortedUnique(sweptConsumers),
    swept_consumer_count: sortedUnique(sweptConsumers).length,
    procedure:
      "re-pin by CONTENT hash (computeO12OracleContentHash), never by commit id; then sweep every consumer",
  };
}

/** Build the gates section from the committed gate-evidence record. */
export function buildGates({ gateEvidence, sourcePath }) {
  const evidence = isObject(gateEvidence) ? gateEvidence : {};
  const expected = isObject(evidence.gate?.expected_counts) ? evidence.gate.expected_counts : {};
  const self = isObject(evidence.self_tests_alone) ? evidence.self_tests_alone : {};
  const o12 = isObject(evidence.o12_gate) ? evidence.o12_gate : {};
  return {
    gate_evidence_path: sourcePath ?? null,
    gate_evidence_kind: evidence.kind ?? null,
    gating_groups: [...(evidence.gate?.gating_groups ?? [])],
    expected_counts: {
      npf2: expected.npf2 ?? null,
      aged: expected.aged ?? null,
      o12: expected.o12 ?? null,
      qualification: expected.qualification ?? null,
    },
    expected_required_total: evidence.gate?.expected_required_total ?? null,
    commands: [...(evidence.gate?.commands ?? [])],
    gate_env: { ...(self.environment?.gate_env ?? {}) },
    substitutions: [...(evidence.gate?.substitutions ?? [])],
    self_tests_alone: {
      verdict: self.verdict ?? null,
      total_required: self.total_required ?? null,
      passed_required: self.passed_required ?? null,
      failed_required: self.failed_required ?? null,
      by_group: isObject(self.by_group) ? JSON.parse(JSON.stringify(self.by_group)) : null,
      entries: (Array.isArray(self.entries) ? self.entries : []).map((entry) => ({
        name: entry?.name ?? null,
        group: entry?.group ?? null,
        half: entry?.half ?? null,
        kind: entry?.kind ?? null,
        exit_code: entry?.exit_code ?? null,
        verdict: entry?.verdict ?? null,
      })),
    },
    o12_gate: {
      total: o12.total ?? null,
      passed: o12.passed ?? null,
      failed: o12.failed ?? null,
      verdict: o12.verdict ?? null,
      overall_verdict: o12.overall_verdict ?? null,
      matrix_pass: o12.matrix_pass === true,
      fixture_matrix: isObject(o12.fixture_matrix) ? { ...o12.fixture_matrix } : null,
      entries: (Array.isArray(o12.entries) ? o12.entries : []).map((entry) => ({
        name: entry?.name ?? null,
        kind: entry?.kind ?? null,
        exit_code: entry?.exit_code ?? null,
        verdict: entry?.verdict ?? null,
      })),
    },
    seed_snapshot: isObject(evidence.seed_snapshot) ? JSON.parse(JSON.stringify(evidence.seed_snapshot)) : null,
  };
}

/** Build the validation section: the retained-evidence validation + scope. */
export function buildValidation({
  gateEvidenceValidation,
  fixtureMatrix,
  contentPinRecomputed,
  pin,
  vmSubstitutions,
  redArms,
  tortureOnly,
  sourcePathsTouched,
}) {
  return {
    gate_evidence_validated: gateEvidenceValidation?.ok === true,
    gate_evidence_problems: [...(gateEvidenceValidation?.problems ?? [])],
    content_pin_recomputed: contentPinRecomputed ?? null,
    content_pin_valid:
      typeof contentPinRecomputed === "string"
      && contentPinRecomputed === pin?.content_sha256,
    fixture_matrix_validation_ok: fixtureMatrix?.validation_ok === true,
    fixture_matrix_validation_problems: [...(fixtureMatrix?.validation_problems ?? [])],
    torture_only: tortureOnly === true,
    source_paths_touched: [...(sourcePathsTouched ?? [])],
    vm_substitutions: [...(vmSubstitutions ?? [])],
    red_arms: [...(redArms ?? [])],
  };
}

/** Build the final-head section from git facts derived at publish time. */
export function buildFinalHead({
  commit,
  tree,
  subject,
  branch,
  worktreeClean,
  srcModified,
  baseRef,
  untrackedFilesIgnored,
}) {
  return {
    commit: commit ?? null,
    tree: tree ?? null,
    subject: subject ?? null,
    branch: branch ?? null,
    base_ref: baseRef ?? null,
    worktree_clean: worktreeClean === true,
    src_modified: srcModified === true,
    untracked_files_ignored: untrackedFilesIgnored === true,
    status_scope: "tracked changes only (git status --porcelain --untracked-files=no)",
  };
}

/** Assemble the complete contract from already-shaped parts. */
export function assembleContract(parts) {
  return {
    kind: CONTRACT_KIND,
    schema_version: CONTRACT_SCHEMA_VERSION,
    task: O12_SCHEMA13_TASK,
    bead: O12_SCHEMA13_BEAD,
    parent_bead: O12_SCHEMA13_PARENT_BEAD,
    generated_at_utc: parts?.generated_at_utc ?? new Date().toISOString(),
    run_id: parts?.run_id ?? null,
    branch: parts?.branch ?? null,
    per_version_expectations: parts?.per_version_expectations,
    lineage_handling: parts?.lineage_handling,
    matchlock_policy: parts?.matchlock_policy,
    fixtures: parts?.fixtures,
    repin: parts?.repin,
    gates: parts?.gates,
    validation: parts?.validation,
    final_head: parts?.final_head,
  };
}

// ── validation ─────────────────────────────────────────────────────────────

function validateEnvelope(contract, problems) {
  if (contract.kind !== CONTRACT_KIND) {
    problems.push(`contract.kind ${JSON.stringify(contract.kind)} !== ${CONTRACT_KIND}`);
  }
  if (contract.schema_version !== CONTRACT_SCHEMA_VERSION) {
    problems.push(`contract.schema_version ${JSON.stringify(contract.schema_version)} !== ${CONTRACT_SCHEMA_VERSION}`);
  }
  for (const section of CONTRACT_SECTIONS) {
    if (!(section in contract)) problems.push(`contract is missing section ${section}`);
  }
}

function validatePerVersionExpectations(section, problems) {
  if (!isObject(section)) {
    problems.push("per_version_expectations is not an object");
    return;
  }
  if (!jsonEqual(section.supported_user_versions, [...SUPPORTED_USER_VERSIONS])) {
    problems.push(
      `per_version_expectations.supported_user_versions ${JSON.stringify(section.supported_user_versions)} !== ${JSON.stringify([...SUPPORTED_USER_VERSIONS])}`,
    );
  }
  const entries = section.entries;
  if (!Array.isArray(entries)) {
    problems.push("per_version_expectations.entries is not an array");
    return;
  }
  const shapes = entries.map((entry) => entry?.shape);
  for (const shape of CONTRACT_SHAPES) {
    if (!shapes.includes(shape)) problems.push(`per_version_expectations.entries missing shape ${shape}`);
  }
  for (const entry of entries) {
    const version = entry?.user_version;
    if (!SUPPORTED_USER_VERSIONS.includes(version)) {
      problems.push(
        `per_version_expectations shape ${JSON.stringify(entry?.shape)} has non-member user_version ${JSON.stringify(version)}`,
      );
    }
    if (!isObject(entry?.required_columns)
      || !Array.isArray(entry.required_columns.runs)
      || !Array.isArray(entry.required_columns.steps)
      || !Array.isArray(entry.required_columns.stories)) {
      problems.push(`per_version_expectations shape ${JSON.stringify(entry?.shape)} is missing required_columns`);
    }
    if (!Array.isArray(entry?.version_added_columns)) {
      problems.push(`per_version_expectations shape ${JSON.stringify(entry?.shape)} is missing version_added_columns`);
    } else {
      for (const column of entry.version_added_columns) {
        if (typeof column?.column !== "string" || column.column.length === 0) {
          problems.push(`per_version_expectations shape ${JSON.stringify(entry?.shape)} has a version-added column without a name`);
        } else if (typeof column.type !== "string" || column.type.length === 0) {
          problems.push(`per_version_expectations ${column.column} is missing its declared type`);
        }
        if (!("default" in column)) {
          problems.push(`per_version_expectations ${column.column} is missing its declared default`);
        }
      }
    }
    if (entry?.expected_verdict !== "PASS") {
      problems.push(
        `per_version_expectations shape ${JSON.stringify(entry?.shape)} verdict ${JSON.stringify(entry?.expected_verdict)} !== PASS`,
      );
    }
  }
}

function validateLineageHandling(section, problems) {
  if (!isObject(section)) {
    problems.push("lineage_handling is not an object");
    return;
  }
  if (!jsonEqual(section.supported_user_versions, [...SUPPORTED_USER_VERSIONS])) {
    problems.push(
      `lineage_handling.supported_user_versions ${JSON.stringify(section.supported_user_versions)} !== ${JSON.stringify([...SUPPORTED_USER_VERSIONS])}`,
    );
  }
  const dual = section.v12_dual_lineage;
  if (!isObject(dual)) {
    problems.push("lineage_handling.v12_dual_lineage is not an object");
  } else {
    if (dual.user_version !== 12) {
      problems.push(`lineage_handling.v12_dual_lineage.user_version ${JSON.stringify(dual.user_version)} !== 12`);
    }
    for (const column of V12_DISCRIMINATOR_COLUMNS) {
      if (!Array.isArray(dual.discriminator_columns) || !dual.discriminator_columns.includes(column)) {
        problems.push(`lineage_handling discriminator_columns must include ${column}`);
      }
    }
    const lineages = (Array.isArray(dual.classifications) ? dual.classifications : []).map((entry) => entry?.lineage);
    for (const lineage of V12_LINEAGE_IDS) {
      if (!lineages.includes(lineage)) {
        problems.push(`lineage_handling.classifications missing v12 lineage ${lineage}`);
      }
    }
    const neither = dual.neither_lineage ?? {};
    if (!/ERROR/.test(String(neither.behavior ?? ""))) {
      problems.push("lineage_handling.v12_dual_lineage.neither_lineage.behavior must be a whole-oracle ERROR");
    }
    if (neither.names_observed_version !== true || neither.names_missing_columns !== true) {
      problems.push("lineage_handling neither-lineage rule must name the observed version and the missing columns");
    }
  }
  const unknown = section.unknown_user_version ?? {};
  if (!/ERROR/.test(String(unknown.behavior ?? ""))) {
    problems.push("lineage_handling.unknown_user_version.behavior must be a whole-oracle ERROR");
  }
  if (unknown.names_observed_version !== true || unknown.names_supported_set !== true) {
    problems.push("lineage_handling.unknown_user_version must name the observed version and the supported set");
  }
  if (!jsonEqual(unknown.supported_set, [...SUPPORTED_USER_VERSIONS])) {
    problems.push(
      `lineage_handling.unknown_user_version.supported_set ${JSON.stringify(unknown.supported_set)} !== ${JSON.stringify([...SUPPORTED_USER_VERSIONS])}`,
    );
  }
  for (const key of ["message_template"]) {
    if (typeof unknown[key] !== "string" || unknown[key].length === 0) {
      problems.push(`lineage_handling.unknown_user_version.${key} missing`);
    }
  }
}

function validateMatchlockPolicy(section, problems) {
  if (!isObject(section)) {
    problems.push("matchlock_policy is not an object");
    return;
  }
  for (const key of ["version", "backend", "harness", "resolvedImageDigest", "resourceLimits"]) {
    if (!Array.isArray(section.required_keys) || !section.required_keys.includes(key)) {
      problems.push(`matchlock_policy.required_keys must include ${key}`);
    }
  }
  if (!Array.isArray(section.optional_keys)) {
    problems.push("matchlock_policy.optional_keys is not an array");
  }
  const blocks = section.harness_submission_blocks ?? {};
  for (const harness of ["pi", "hermes", "dsh"]) {
    if (!Array.isArray(blocks[harness])) {
      problems.push(`matchlock_policy.harness_submission_blocks.${harness} is not an array`);
    }
  }
  if (!Array.isArray(blocks.hermes) || blocks.hermes.length === 0) {
    problems.push("matchlock_policy hermes submission block must be non-empty");
  }
  if (!Array.isArray(blocks.dsh) || blocks.dsh.length === 0) {
    problems.push("matchlock_policy dsh submission block must be non-empty");
  }
  const native = section.null_native_semantics ?? {};
  if (!/native/.test(String(native.null ?? ""))) {
    problems.push("matchlock_policy.null_native_semantics.null must describe the native (non-Matchlock) case");
  }
  if (!/VALID/.test(String(native.null ?? ""))) {
    problems.push("matchlock_policy.null_native_semantics.null must state that NULL is VALID");
  }
  const invalid = section.invalid_policy ?? {};
  if (typeof invalid.finding !== "string" || !/^O12_SCHEMA_/.test(invalid.finding)) {
    problems.push("matchlock_policy.invalid_policy.finding must be the O12 finding id");
  }
  if (!/R1[\s\S]*FAIL/.test(String(invalid.effect ?? ""))) {
    problems.push("matchlock_policy.invalid_policy.effect must make R1 FAIL");
  }
}

function validateFixtures(section, problems) {
  if (!isObject(section)) {
    problems.push("fixtures is not an object");
    return;
  }
  if (section.fixture_count !== section.expected_fixture_count) {
    problems.push(`fixtures count ${section.fixture_count} !== expected ${section.expected_fixture_count}`);
  }
  if (typeof section.fixture_count !== "number" || section.fixture_count <= 0) {
    problems.push("fixtures.fixture_count must be a positive number");
  }
  if (section.all_match !== true) problems.push("fixtures.all_match is not true");
  if (section.all_correction_cases_green !== true) {
    problems.push("fixtures.all_correction_cases_green is not true");
  }
  if (section.snapshot_immutability_ok !== true) {
    problems.push("fixtures.snapshot_immutability_ok is not true");
  }
  const ids = Array.isArray(section.fixture_case_ids) ? section.fixture_case_ids : null;
  if (!ids || ids.length === 0) {
    problems.push("fixtures.fixture_case_ids must be a non-empty array");
    return;
  }
  const requiredFragments = [
    "o12-schema-v9",
    "o12-schema-v10",
    "o12-schema-v11",
    "o12-schema-v12-main",
    "o12-schema-v12-matchlock",
    "o12-schema-v13",
    "o12-schema-version-unsupported",
  ];
  for (const fragment of requiredFragments) {
    if (!ids.some((id) => typeof id === "string" && id.includes(fragment))) {
      problems.push(`fixtures.fixture_case_ids must include a case for ${fragment}`);
    }
  }
}

function validateRepin(section, problems) {
  if (!isObject(section)) {
    problems.push("repin is not an object");
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(String(section.content_sha256 ?? ""))) {
    problems.push(`repin.content_sha256 ${JSON.stringify(section.content_sha256)} is not a 64-hex content hash`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(section.provenance_commit ?? ""))) {
    problems.push(`repin.provenance_commit ${JSON.stringify(section.provenance_commit)} is not a full sha`);
  }
  if (typeof section.provenance_subject !== "string" || section.provenance_subject.length === 0) {
    problems.push("repin.provenance_subject missing");
  }
  if (!section.acceptance || section.acceptance === "NOT_ROOT_ACCEPTED") {
    problems.push(`repin.acceptance ${JSON.stringify(section.acceptance)} is not the accepted value`);
  }
  if (typeof section.acceptance_detail !== "string" || section.acceptance_detail.length === 0) {
    problems.push("repin.acceptance_detail missing");
  }
  if (!Array.isArray(section.content_paths) || section.content_paths.length === 0) {
    problems.push("repin.content_paths must record the pinned content set");
  }
  if (section.content_paths_count !== (section.content_paths ?? []).length) {
    problems.push("repin.content_paths_count disagrees with repin.content_paths");
  }
  const consumers = section.swept_consumers;
  if (!Array.isArray(consumers) || consumers.length === 0) {
    problems.push("repin.swept_consumers must be a non-empty array");
  } else if (!consumers.includes(PIN_SOURCE_REL)) {
    problems.push(`repin.swept_consumers must include the pin source ${PIN_SOURCE_REL}`);
  }
}

function validateGates(section, problems) {
  if (!isObject(section)) {
    problems.push("gates is not an object");
    return;
  }
  if (!jsonEqual(section.expected_counts, { ...EXPECTED_GATE_COUNTS })) {
    problems.push(
      `gates.expected_counts ${JSON.stringify(section.expected_counts)} !== ${JSON.stringify({ ...EXPECTED_GATE_COUNTS })}`,
    );
  }
  if (section.expected_required_total !== EXPECTED_REQUIRED_TOTAL) {
    problems.push(`gates.expected_required_total ${JSON.stringify(section.expected_required_total)} !== ${EXPECTED_REQUIRED_TOTAL}`);
  }
  if (!Array.isArray(section.commands) || section.commands.length === 0) {
    problems.push("gates.commands must record the exact commands that were run");
  }
  const env = section.gate_env ?? {};
  if (env.TAMANDUA_TEST_GUARD !== "1") problems.push("the frozen gate env must set TAMANDUA_TEST_GUARD=1");
  for (const key of ["TAMANDUA_PI_BINARY", "TAMANDUA_HERMES_BINARY", "TAMANDUA_DSH_BINARY"]) {
    if (env[key] !== "/usr/bin/false") problems.push(`the frozen gate env must pin ${key}=/usr/bin/false`);
  }
  const substitutionsText = (Array.isArray(section.substitutions) ? section.substitutions : []).join("\n");
  if (substitutionsText.length === 0) problems.push("gates.substitutions must record the VM substitutions");
  for (const marker of REQUIRED_SUBSTITUTION_MARKERS) {
    if (!substitutionsText.includes(marker)) {
      problems.push(`gates.substitutions must surface the VM substitution marker ${marker}`);
    }
  }

  const self = section.self_tests_alone ?? {};
  if (self.verdict !== "PASS") problems.push(`gates.self_tests_alone.verdict ${JSON.stringify(self.verdict)} !== PASS`);
  if (self.total_required !== EXPECTED_REQUIRED_TOTAL) {
    problems.push(`gates.self_tests_alone.total_required ${JSON.stringify(self.total_required)} !== ${EXPECTED_REQUIRED_TOTAL}`);
  }
  if (self.passed_required !== EXPECTED_REQUIRED_TOTAL) {
    problems.push(`gates.self_tests_alone.passed_required ${JSON.stringify(self.passed_required)} !== ${EXPECTED_REQUIRED_TOTAL}`);
  }
  if (self.failed_required !== 0) problems.push("gates.self_tests_alone.failed_required must be 0");
  const byGroup = self.by_group ?? {};
  for (const [group, expected] of Object.entries(EXPECTED_GATE_COUNTS)) {
    const block = byGroup[group];
    if (!block) {
      problems.push(`gates.self_tests_alone.by_group.${group} is missing`);
      continue;
    }
    if (block.total !== expected) {
      problems.push(`gates.self_tests_alone.by_group.${group}.total ${JSON.stringify(block.total)} !== ${expected}`);
    }
    if (GATING_GROUPS.includes(group) && (block.failed !== 0 || block.verdict !== "PASS")) {
      problems.push(`gates.self_tests_alone.by_group.${group} is red: ${JSON.stringify(block.red_files)}`);
    }
  }
  if (byGroup.qualification?.gating !== false) {
    problems.push("gates.self_tests_alone.by_group.qualification must be informational (gating false)");
  }
  const entries = Array.isArray(self.entries) ? self.entries : [];
  const gatingEntries = entries.filter((entry) => GATING_GROUPS.includes(entry?.group));
  if (gatingEntries.length !== EXPECTED_REQUIRED_TOTAL) {
    problems.push(`gates required entry records ${gatingEntries.length} !== ${EXPECTED_REQUIRED_TOTAL}`);
  }
  for (const entry of entries) {
    if (typeof entry?.exit_code !== "number") {
      problems.push(`gates.self_tests_alone entry ${entry?.name} must record a numeric exit_code`);
      continue;
    }
    if (entry.exit_code !== 0) {
      problems.push(`gates.self_tests_alone entry ${entry.name} exited ${entry.exit_code}`);
    }
    if (entry.verdict !== "PASS") {
      problems.push(`gates.self_tests_alone entry ${entry.name} verdict ${JSON.stringify(entry.verdict)} !== PASS`);
    }
  }

  const o12 = section.o12_gate ?? {};
  if (o12.overall_verdict !== "PASS") problems.push(`gates.o12_gate.overall_verdict ${JSON.stringify(o12.overall_verdict)} !== PASS`);
  if (o12.verdict !== "PASS") problems.push(`gates.o12_gate.verdict ${JSON.stringify(o12.verdict)} !== PASS`);
  if (o12.matrix_pass !== true) problems.push("gates.o12_gate.matrix_pass must be true");
  const matrix = o12.fixture_matrix ?? {};
  if (matrix.expected_fixture_count !== matrix.fixture_count) {
    problems.push(
      `gates.o12_gate.fixture_matrix expected ${JSON.stringify(matrix.expected_fixture_count)} !== observed ${JSON.stringify(matrix.fixture_count)}`,
    );
  }
  if (matrix.all_match !== true) problems.push("gates.o12_gate.fixture_matrix.all_match must be true");
  if (matrix.validation_ok !== true) problems.push("gates.o12_gate.fixture_matrix.validation_ok must be true");
  const o12Entries = Array.isArray(o12.entries) ? o12.entries : [];
  if (o12Entries.length === 0) problems.push("gates.o12_gate.entries must record the per-entry exits");
  for (const entry of o12Entries) {
    if (entry?.exit_code !== 0) problems.push(`gates.o12_gate entry ${entry?.name} exited ${entry?.exit_code}`);
    if (entry?.verdict !== "PASS") problems.push(`gates.o12_gate entry ${entry?.name} verdict must be PASS`);
  }
}

function validateValidation(section, problems) {
  if (!isObject(section)) {
    problems.push("validation is not an object");
    return;
  }
  if (section.gate_evidence_validated !== true) {
    problems.push("validation.gate_evidence_validated must be true");
  }
  if (!Array.isArray(section.gate_evidence_problems) || section.gate_evidence_problems.length !== 0) {
    problems.push("validation.gate_evidence_problems must be empty");
  }
  if (!/^[0-9a-f]{64}$/.test(String(section.content_pin_recomputed ?? ""))) {
    problems.push("validation.content_pin_recomputed must be the 64-hex recomputed content hash");
  }
  if (section.content_pin_valid !== true) {
    problems.push("validation.content_pin_valid must be true");
  }
  if (section.fixture_matrix_validation_ok !== true) {
    problems.push("validation.fixture_matrix_validation_ok must be true");
  }
  if (!Array.isArray(section.fixture_matrix_validation_problems) || section.fixture_matrix_validation_problems.length !== 0) {
    problems.push("validation.fixture_matrix_validation_problems must be empty");
  }
  if (section.torture_only !== true) problems.push("validation.torture_only must be true");
  if (!Array.isArray(section.source_paths_touched) || section.source_paths_touched.length !== 0) {
    problems.push("validation.source_paths_touched must be empty (no src/ edits)");
  }
  for (const key of REQUIRED_RED_ARMS) {
    if (!Array.isArray(section.red_arms) || !section.red_arms.includes(key)) {
      problems.push(`validation.red_arms must include ${JSON.stringify(key)}`);
    }
  }
  if (!Array.isArray(section.vm_substitutions) || section.vm_substitutions.length === 0) {
    problems.push("validation.vm_substitutions must record the substitutions");
  }
}

function validateFinalHead(section, problems) {
  if (!isObject(section)) {
    problems.push("final_head is not an object");
    return;
  }
  if (!/^[0-9a-f]{40}$/.test(String(section.commit ?? ""))) {
    problems.push(`final_head.commit ${JSON.stringify(section.commit)} is not a full sha`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(section.tree ?? ""))) {
    problems.push(`final_head.tree ${JSON.stringify(section.tree)} is not a full tree sha`);
  }
  if (section.worktree_clean !== true) problems.push("final_head.worktree_clean is not true");
  if (section.src_modified !== false) problems.push("final_head.src_modified must be false");
}

/**
 * Validate a complete contract.  Returns `{ ok, problems }` and never throws.
 * Every section is checked for its load-bearing invariant; a contract that
 * disagrees with the committed evidence is not publishable.
 */
export function validateContract(contract) {
  const problems = [];
  if (!isObject(contract)) return { ok: false, problems: ["contract is not an object"] };
  validateEnvelope(contract, problems);
  validatePerVersionExpectations(contract.per_version_expectations, problems);
  validateLineageHandling(contract.lineage_handling, problems);
  validateMatchlockPolicy(contract.matchlock_policy, problems);
  validateFixtures(contract.fixtures, problems);
  validateRepin(contract.repin, problems);
  validateGates(contract.gates, problems);
  validateValidation(contract.validation, problems);
  validateFinalHead(contract.final_head, problems);
  // Cross-section consistency: the re-pin pin and the recomputed pin are one
  // fact; a tampered content hash must not survive a clean recomputation record.
  if (isObject(contract.repin) && isObject(contract.validation)
    && contract.repin.content_sha256 !== contract.validation.content_pin_recomputed) {
    problems.push(
      `repin.content_sha256 ${JSON.stringify(contract.repin.content_sha256)} disagrees with validation.content_pin_recomputed ${JSON.stringify(contract.validation.content_pin_recomputed)}`,
    );
  }
  return { ok: problems.length === 0, problems };
}
