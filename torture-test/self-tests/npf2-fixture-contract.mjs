// npf2-fixture-contract.mjs — pure assembly + validation for the NPF-2 fixture
// contract published at /home/kaladin/matchlock-work/npf2-fixture-contract.json
// (US-013, the run's final NPF-2 deliverable).
//
// NPF-2 (from the run storm-rehearsal-exec10-contract) was a scripted-runtime
// gap: the scripted rehearsal test step never recorded suite-ledger evidence,
// so the product's finalize_merge ledger gate refused the FIRST attempt of
// every merge run with `LEDGER_EVIDENCE: missing` and rerouted it to the
// tester.  The fix (US-001/US-002) makes the scripted test step execute the
// shim-wrapped `{{input.TEST_CMD}}` (the product's public tamandua-test seam),
// exactly as the real tester does, so a REAL green suite_results row exists for
// the tested tree and the first finalize_merge attempt lands.  Part 2 (US-005..)
// replaced the pre-squash commit pin (killed by the merge-worktree squash) with
// a CONTENT-addressed SHA-256 pin over the documented O12 oracle set.
//
// This module shapes that contract.  It is I/O-free: the publisher
// (`publish-npf2-fixture-contract.mjs`) does all reads/writes and hands parsed
// artifacts to the builders here, so every value is read from retained evidence
// and never retyped.  Keeping the shaping pure lets the contract be unit-tested
// without touching disk or spawning anything.

import { parseAgedPinConstants } from "./o12-repin-contract.mjs";

/** Contract envelope kind. */
export const CONTRACT_KIND = "npf2-fixture-contract";

/** Contract schema version (bumped only on a shape change). */
export const CONTRACT_SCHEMA_VERSION = 1;

/** Canonical published contract path (outside the repository). */
export const CONTRACT_OUTPUT_PATH = "/home/kaladin/matchlock-work/npf2-fixture-contract.json";

/** Run/task identity recorded in the contract. */
export const NPF2_TASK = "NPF-2";
export const NPF2_BEAD = "tamandua-6sy.58";
export const NPF2_PARENT_BEAD = "tamandua-6sy.6.3.1";

/** The single shared storm gate lock the storm chain is held under. */
export const GATE_LOCK_PATH = "/home/kaladin/matchlock-work/vaivm-gate.lock";

/** The NPF-2 finding contract that first recorded the observation. */
export const NPF2_FINDING_CONTRACT = "/home/kaladin/matchlock-work/storm-rehearsal-exec10-contract.json";

/** Source of the evidence-command fix. */
export const EVIDENCE_SOURCE_REL = "torture-test/bin/tt-storm-rehearsal.mjs";

/** Source of the content-addressed O12 pin. */
export const PIN_SOURCE_REL = "torture-test/aged/validate.mjs";

/** Committed readiness pointer (locates the published qualification). */
export const READINESS_POINTER_REL = "torture-test/storm-seed-readiness.json";

/** Published (host-owned) qualification path. */
export const PUBLISHED_QUALIFICATION_PATH = "/home/kaladin/matchlock-work/storm-seed-qualification.json";

/** The evidence-command constant name in the rehearsal engine. */
export const EVIDENCE_COMMAND_CONSTANT = "TESTER_SUITE_EVIDENCE_COMMAND";

/** The content-pin constant name in the aged validator. */
export const CONTENT_PIN_CONSTANT = "O12_PINNED_CONTENT_SHA256";

/**
 * TORTURE-PORT US-006: why a retained pre-port aged report is anchored to the
 * current content pin instead of being rejected.  The committed readiness
 * pointer locates a seed-qualification copy produced under the schema-10 O12
 * content pin; the schema-9..13 re-pin (O12-SCHEMA-13 US-005) superseded it and
 * the seed is regenerated on this product, which is out of TORTURE-PORT scope.
 */
export const LEGACY_PRIOR_PIN_REASON =
  "the retained aged report was produced under the declared pre-port (schema-10) O12 content pin; "
  + "the O12-SCHEMA-13 US-005 re-pin superseded it and the seed is regenerated on this product "
  + "(out of TORTURE-PORT scope). The contract is anchored to the CURRENT content pin and the "
  + "retained report is recorded as legacy provenance, never as evidence for the current pin.";

/** The six sections the contract must carry, in publication order. */
export const CONTRACT_SECTIONS = Object.freeze([
  "design",
  "evidence",
  "new_pin",
  "gates",
  "final_squash",
]);

/** The exact note explaining why `final_squash_hash` is null. */
export const FINAL_SQUASH_NOTE =
  "The run's own story commits do not survive the merge-worktree squash into "
  + "integration/o12-repin: the merger rewrites the branch history, so no story "
  + "commit hash from this run is reachable afterwards. final_squash_hash is therefore "
  + "explicitly null (not unknown and not fabricated). The durable anchor is the "
  + "content-addressed O12 pin (content_sha256 over the documented oracle bytes); a future "
  + "squash rewrites commit hashes but not those bytes, so the pin survives, and the landing "
  + "squash commit is recorded as provenance only (never as the pin).";

/** The NPF-2 finding as recorded by the run that observed it. */
export const NPF2_FINDING = Object.freeze({
  id: "NPF-2",
  title:
    "First finalize_merge attempt of every merge run is refused by the suite-ledger gate and rerouted",
  origin_contract: NPF2_FINDING_CONTRACT,
  observable_before:
    "The scripted test step never recorded suite-ledger evidence, so the product's ledger gate "
    + "refused the first finalize_merge attempt with FAILURE_CLASS refused_permanent "
    + "'no matching TSTX suite execution exists / LEDGER_EVIDENCE: missing' and rerouted it to the "
    + "upstream producer; the eventual landing also carried merge.landed_without_suite_evidence.",
  fixed_behavior:
    "The scripted test step now executes the shim-wrapped {{input.TEST_CMD}} through the product's "
    + "public tamandua-test seam, exactly like the real tester, recording a real green suite_results "
    + "row for the tested tree; the first finalize_merge attempt then lands with LEDGER_EVIDENCE present.",
  classification: "fixture/scripted-runtime contract gap (not a product defect), fixed in torture-test/**",
});

/** True when `value` is a non-null, non-array object. */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalize the scheduler's bare run id to the canonical `run-<uuid>` form. */
export function normalizeRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) return null;
  return runId.startsWith("run-") ? runId : `run-${runId}`;
}

/**
 * Parse `export const NAME = '...'` (single-quoted) out of a source text.
 * Returns null when absent.
 */
export function parseSingleQuotedConstant(source, name) {
  const match = String(source ?? "").match(
    new RegExp(`export const ${name}\\s*=\\s*'([^']*)'`),
  );
  return match ? match[1] : null;
}

/**
 * Parse the O12_ORACLE_CONTENT_PATHS list out of the aged validator source.
 * The documented content set is the durable unit the content pin addresses, so
 * the contract records the exact list the validator hashes.
 */
export function parseContentPaths(source) {
  const match = String(source ?? "").match(
    /export const O12_ORACLE_CONTENT_PATHS = Object\.freeze\(\[([\s\S]*?)\]\)/,
  );
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

/** Re-exported so callers can cross-check the published pin against the source. */
export { parseAgedPinConstants };

/**
 * Classify the retained aged report's `o12_pin` block against the validator's
 * live constants.  Returns `{ ok, kind, problems }`:
 *
 *   * `current`          — the report pins the live content set (the normal
 *                          case; every comparable field must agree);
 *   * `legacy_pre_port`  — the report pins the DECLARED pre-port (schema-10)
 *                          content hash.  The report predates the schema-9..13
 *                          re-pin and the seed is regenerated on this product
 *                          (out of scope), so the contract is anchored to the
 *                          live constants and the report is recorded as legacy
 *                          provenance;
 *   * rejected           — any other pin, or a current-content report whose
 *                          provenance/acceptance fields disagree, still fails
 *                          closed.
 */
export function classifyRetainedPin({ reportPin, validatorPin, legacyContentSha256 }) {
  const problems = [];
  if (!isObject(reportPin)) return { ok: false, kind: null, problems: ["aged report o12_pin is not an object"] };
  if (!isObject(validatorPin)) return { ok: false, kind: null, problems: ["validator pin is not an object"] };
  const hex64 = /^[0-9a-f]{64}$/;
  if (!hex64.test(String(reportPin.content_sha256 ?? ""))) {
    problems.push(`aged report o12_pin.content_sha256 ${JSON.stringify(reportPin.content_sha256)} is not a 64-hex content hash`);
  }
  if (!hex64.test(String(validatorPin.content_sha256 ?? ""))) {
    problems.push(`validator content pin ${JSON.stringify(validatorPin.content_sha256)} is not a 64-hex content hash`);
  }
  if (problems.length > 0) return { ok: false, kind: null, problems };

  if (reportPin.content_sha256 === validatorPin.content_sha256) {
    // The report claims the live pin: it must agree on every comparable field
    // (the original fail-closed cross-check).
    for (const field of ["provenance_commit", "provenance_subject", "acceptance"]) {
      if (typeof reportPin[field] !== "string" || reportPin[field].length === 0) {
        problems.push(`aged report o12_pin.${field} is missing`);
      } else if (reportPin[field] !== validatorPin[field]) {
        problems.push(
          `aged report o12_pin.${field} ${JSON.stringify(reportPin[field])} !== validator source constant ${JSON.stringify(validatorPin[field])}`,
        );
      }
    }
    return problems.length > 0
      ? { ok: false, kind: null, problems }
      : { ok: true, kind: "current", problems: [] };
  }

  if (legacyContentSha256 && reportPin.content_sha256 === legacyContentSha256) {
    return { ok: true, kind: "legacy_pre_port", problems: [] };
  }

  problems.push(
    `aged report o12_pin.content_sha256 ${JSON.stringify(reportPin.content_sha256)} is neither the current content pin `
    + `${JSON.stringify(validatorPin.content_sha256)} nor the declared pre-port pin ${JSON.stringify(legacyContentSha256 ?? "<undeclared>")}`,
  );
  return { ok: false, kind: null, problems };
}

/**
 * Extract the retained diagnostics directory the NPF-2 self-test printed
 * (`US-003/US-004 diagnostics retained at <dir>`).  Returns null when absent.
 */
export function parseRetainedDirFromStdout(stdout) {
  const match = String(stdout ?? "").match(/diagnostics retained at (\S+)/);
  return match ? match[1] : null;
}

/**
 * Parse the `US-003 observed:` / `US-004 observed:` key=value line the NPF-2
 * self-test prints.  Returns `{ line, fields }`; `fields` is empty when the
 * line is absent.  Values are read from the log so the contract never retypes
 * what the self-test measured.
 */
export function parseObservedFieldsFromStdout(stdout) {
  const match = String(stdout ?? "").match(/US-00[34] observed: (?<line>[^\n]*)/);
  if (!match) return { line: null, fields: {} };
  const line = match.groups.line.trim();
  const fields = {};
  for (const token of line.split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    fields[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { line, fields };
}

/**
 * Build the design section: the evidence-command fix and the content-addressed
 * pin.  Every load-bearing value comes from the source artifacts (the parsed
 * command constant, the parsed content-path list) or from the aged report's pin
 * block — nothing is retyped here.
 */
export function buildDesignSection({ evidenceCommand, evidenceSourceRel, contentPaths, contentPathsSourceRel, scheme }) {
  return {
    evidence_command: {
      constant: EVIDENCE_COMMAND_CONSTANT,
      command: evidenceCommand,
      source_rel: evidenceSourceRel,
      consumer:
        "the TESTED_TREE-producing agent's behavior entry (graph-derived from each workflow.yml: "
        + "tester in feature-dev/security-audit-merge, verifier in bug-fix/quarantine-broken-tests-merge); "
        + "attached additively and to every per-story entry when the behavior is the story-loop array",
      shim: "tamandua-test (the product's public suite-ledger seam)",
      mechanism:
        "the scripted test step executes the claim-time rendered TEST_CMD, which runs the zero-token "
        + "suite command through the shim and records a real green suite_results row keyed to the tested tree",
      negative_configuration:
        "suiteEvidence:false omits the command from every behavior entry; the gate then still refuses the "
        + "first finalize_merge attempt (the US-004 regression)",
      no_fabrication:
        "no code path writes a suite_results row directly; the only mechanism that records evidence is "
        + "executing the shim",
      path_extra:
        "the contained daemon's rendered PATH includes <repo>/bin (rehearsalDaemonPathExtra) so the bare "
        + "tamandua-test shim resolves inside the env -i worker",
    },
    content_pin: {
      constant: CONTENT_PIN_CONSTANT,
      scheme,
      source_rel: contentPathsSourceRel,
      paths: [...contentPaths],
      path_count: contentPaths.length,
      provenance_role:
        "the landing squash commit is recorded as PROVENANCE only; the durable anchor is the "
        + "content_sha256, which a future merge-worktree squash cannot invalidate",
    },
    npf2_finding: { ...NPF2_FINDING },
  };
}

/**
 * Summarize the product events of one contained run for the merge-hold corridor:
 * whether the first finalize_merge attempt was rerouted by the ledger gate,
 * whether the landing was annotated `merge.landed_without_suite_evidence`, and
 * whether a real merge landed.  Pure over already-parsed event objects.
 */
export function summarizeMergeEvents(events) {
  const list = Array.isArray(events) ? events.filter(isObject) : [];
  const reroutes = list.filter((entry) => entry.event === "step.rerouted" && entry.stepId === "finalize_merge");
  const refusals = reroutes.filter((entry) => /LEDGER_EVIDENCE: missing/.test(String(entry.detail ?? "")));
  const landedWithout = list.filter((entry) => entry.event === "merge.landed_without_suite_evidence");
  const landed = list.filter((entry) => entry.event === "merge.landed");
  const refusal = refusals[0] ?? null;
  const failureClass = refusal ? (/FAILURE_CLASS:\s*(\S+)/.exec(String(refusal.detail))?.[1] ?? null) : null;
  return {
    event_count: list.length,
    finalize_merge_reroute_count: reroutes.length,
    finalize_merge_rerouted: reroutes.length > 0,
    ledger_evidence_missing: refusals.length > 0,
    ledger_refusal_failure_class: failureClass,
    ledger_refusal_detail: refusal ? String(refusal.detail) : null,
    ledger_refusal_at: refusal ? (refusal.ts ?? null) : null,
    merge_landed: landed.length > 0,
    landed_without_suite_evidence: landedWithout.length > 0,
    landed_without_suite_evidence_events: landedWithout.map((entry) => ({
      ts: entry.ts ?? null,
      gateMode: entry.gateMode ?? null,
      treeHash: entry.treeHash ?? null,
      cmdHash: entry.cmdHash ?? null,
    })),
  };
}

/**
 * Shape one NPF-2 half (positive or negative) from its retained self-test
 * entry, the stdout log's observed line, the retained run summary and the
 * summarized events.  All values are read from those artifacts.
 */
export function buildEvidenceHalf({ half, selfTestEntry, observedLine, retainedDir, runSummary, events }) {
  const runRow = runSummary?.runRow ?? {};
  let context = {};
  try {
    context = JSON.parse(String(runRow.context ?? "{}"));
  } catch {
    context = {};
  }
  const finalize = runSummary?.finalizeMergeStep ?? {};
  const testStep = runSummary?.testStep ?? {};
  const suiteResults = Array.isArray(runSummary?.suiteResults) ? runSummary.suiteResults : [];
  const testedTree = context.tested_tree ?? null;
  const mergedTree = context.merged_tree ?? null;
  const green = suiteResults.filter((row) => row?.exit_code === 0);
  const eventSummary = summarizeMergeEvents(events);
  return {
    half,
    self_test: {
      name: selfTestEntry?.name ?? null,
      rel: selfTestEntry?.rel ?? null,
      test_name_pattern: selfTestEntry?.test_name_pattern ?? null,
      group: selfTestEntry?.group ?? null,
      exit_code: selfTestEntry?.exit_code ?? null,
      pass: selfTestEntry?.pass === true,
      duration_ms: selfTestEntry?.duration_ms ?? null,
      totals: selfTestEntry?.totals ?? null,
      stdout_log: selfTestEntry?.stdout_log ?? null,
      stderr_log: selfTestEntry?.stderr_log ?? null,
      private_tmpdir: selfTestEntry?.private_tmpdir ?? null,
    },
    observed_line: observedLine ?? null,
    retained_dir: retainedDir ?? null,
    summary_path: retainedDir ? `${retainedDir}/summary.json` : null,
    label: runSummary?.label ?? null,
    observed_at: runSummary?.observedAt ?? null,
    run: runSummary?.run ?? null,
    run_status: runRow?.status ?? null,
    workflow_id: runSummary?.workflowId ?? null,
    finalize_merge: {
      status: finalize.status ?? null,
      reroute_count: finalize.reroute_count ?? null,
      terminal_reroute_count: finalize.terminal_reroute_count ?? null,
      ledger_concession_count: finalize.ledger_concession_count ?? null,
    },
    test_step: {
      step_id: testStep.step_id ?? null,
      status: testStep.status ?? null,
    },
    tested_tree: testedTree,
    merged_tree: mergedTree,
    merged_commit: context.merged_commit ?? null,
    target: context.target ?? null,
    suite_results: suiteResults.map((row) => ({
      id: row?.id ?? null,
      exit_code: row?.exit_code ?? null,
      tree_hash: row?.tree_hash ?? null,
      run_id: row?.run_id ?? null,
      step_id: row?.step_id ?? null,
      cmd_display: row?.cmd_display ?? null,
      created_at: row?.created_at ?? null,
    })),
    suite_result_count: suiteResults.length,
    green_suite_result_count: green.length,
    suite_result_tree_matches_landed: green.length > 0 && mergedTree !== null
      && green.every((row) => row.tree_hash === mergedTree),
    events: eventSummary,
  };
}

/** Assemble the whole evidence section from the two shaped halves. */
export function buildEvidenceSection({ positive, negative }) {
  return { positive, negative };
}

/**
 * Shape new_pin from the aged validation report's own `o12_pin` block plus the
 * parsed validator constants (the publisher cross-checks the two before
 * calling this).  The durable pin is `content_sha256`; the landed squash commit
 * is provenance.  The content-path list is carried so the pin's unit is
 * explicit.
 */
export function buildNewPin({ pin, contentPaths, contentPathsSourceRel, acceptanceEvidence = [], legacyPriorReport = null }) {
  const out = {
    constant: CONTENT_PIN_CONSTANT,
    content_sha256: pin?.content_sha256 ?? null,
    provenance_commit: pin?.provenance_commit ?? null,
    provenance_subject: pin?.provenance_subject ?? null,
    acceptance: pin?.acceptance ?? null,
    acceptance_detail: pin?.acceptance_detail ?? null,
    content_paths: [...contentPaths],
    content_path_count: contentPaths.length,
    content_paths_source_rel: contentPathsSourceRel,
    acceptance_evidence: [...acceptanceEvidence],
  };
  if (legacyPriorReport) {
    out.legacy_prior_pin = {
      content_sha256: legacyPriorReport.content_sha256 ?? null,
      provenance_commit: legacyPriorReport.provenance_commit ?? null,
      provenance_subject: legacyPriorReport.provenance_subject ?? null,
      acceptance: legacyPriorReport.acceptance ?? null,
      report_path: legacyPriorReport.report_path ?? null,
      reason: LEGACY_PRIOR_PIN_REASON,
    };
  }
  return out;
}

/** The self-tests-alone and storm-chain gate blocks, shaped from their summaries. */
export function buildGatesSection({ selfTestsAlone, selfTestsAlonePath, stormChain, stormChainPath }) {
  const entries = Array.isArray(selfTestsAlone?.entries) ? selfTestsAlone.entries : [];
  return {
    lock_path: GATE_LOCK_PATH,
    self_tests_alone: {
      summary_path: selfTestsAlonePath ?? null,
      kind: selfTestsAlone?.kind ?? null,
      verdict: selfTestsAlone?.verdict ?? null,
      git_head: selfTestsAlone?.git_head ?? null,
      repo_root: selfTestsAlone?.repo_root ?? null,
      started_at: selfTestsAlone?.started_at ?? null,
      finished_at: selfTestsAlone?.finished_at ?? null,
      total_required: selfTestsAlone?.total_required ?? null,
      passed_required: selfTestsAlone?.passed_required ?? null,
      failed_required: selfTestsAlone?.failed_required ?? null,
      red_file_count: selfTestsAlone?.red_file_count ?? null,
      red_files: selfTestsAlone?.red_files ?? null,
      expected_counts: selfTestsAlone?.expected_counts ?? null,
      by_group: selfTestsAlone?.by_group ?? null,
      environment: selfTestsAlone?.environment ?? null,
      entries: entries.map((entry) => ({
        name: entry?.name ?? null,
        group: entry?.group ?? null,
        half: entry?.half ?? null,
        rel: entry?.rel ?? null,
        test_name_pattern: entry?.test_name_pattern ?? null,
        exit_code: entry?.exit_code ?? null,
        pass: entry?.pass === true,
        duration_ms: entry?.duration_ms ?? null,
        totals: entry?.totals ?? null,
        stdout_log: entry?.stdout_log ?? null,
        stderr_log: entry?.stderr_log ?? null,
      })),
    },
    storm_chain: {
      summary_path: stormChainPath ?? null,
      kind: stormChain?.kind ?? null,
      verdict: stormChain?.verdict ?? null,
      head: stormChain?.head ?? null,
      repo: stormChain?.repo ?? null,
      file_count_expected: stormChain?.file_count_expected ?? null,
      file_count_observed: stormChain?.file_count_observed ?? null,
      red_file_count: stormChain?.red_file_count ?? null,
      red_files: stormChain?.red_files ?? null,
      totals: stormChain?.totals ?? null,
      harness_guard_env: stormChain?.harness_guard_env ?? null,
      lock: stormChain?.lock ?? null,
      run7_chain_files: stormChain?.run7_chain_files ?? null,
    },
  };
}

/**
 * Shape final_squash.  `final_squash_hash` is ALWAYS null: the run's own story
 * commits do not survive the merge-worktree squash, so no hash from this run is
 * a durable final hash.  The landed squash commit is provenance and the content
 * pin is the durable anchor.
 */
export function buildFinalSquash({ provenanceCommit, provenanceSubject, contentSha256 }) {
  return {
    provenance_commit: provenanceCommit ?? null,
    provenance_subject: provenanceSubject ?? null,
    final_squash_hash: null,
    final_squash_hash_reason: "run story commits are rewritten by the merge-worktree squash",
    story_commits_survive_squash: false,
    durable_anchor: {
      kind: "content_sha256",
      constant: CONTENT_PIN_CONSTANT,
      value: contentSha256 ?? null,
      source_rel: PIN_SOURCE_REL,
    },
    note: FINAL_SQUASH_NOTE,
  };
}

/** Assemble the complete contract from already-shaped parts. */
export function assembleContract(parts) {
  return {
    kind: CONTRACT_KIND,
    schema_version: CONTRACT_SCHEMA_VERSION,
    task: NPF2_TASK,
    bead: NPF2_BEAD,
    parent_bead: NPF2_PARENT_BEAD,
    generated_at_utc: parts.generated_at_utc ?? new Date().toISOString(),
    run_id: parts.run_id ?? null,
    branch: parts.branch ?? null,
    design: parts.design,
    evidence: parts.evidence,
    new_pin: parts.new_pin,
    gates: parts.gates,
    final_squash: parts.final_squash,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

function validateDesign(design, problems) {
  if (!isObject(design)) {
    problems.push("design is not an object");
    return;
  }
  const command = design.evidence_command ?? {};
  if (command.constant !== EVIDENCE_COMMAND_CONSTANT) {
    problems.push(`design.evidence_command.constant ${JSON.stringify(command.constant)} !== ${EVIDENCE_COMMAND_CONSTANT}`);
  }
  if (typeof command.command !== "string" || !command.command.includes("{{input.TEST_CMD}}")) {
    problems.push(`design.evidence_command.command ${JSON.stringify(command.command)} must be the {{input.TEST_CMD}} placeholder`);
  }
  if (!command.source_rel) problems.push("design.evidence_command.source_rel missing");
  const pin = design.content_pin ?? {};
  if (pin.constant !== CONTENT_PIN_CONSTANT) {
    problems.push(`design.content_pin.constant ${JSON.stringify(pin.constant)} !== ${CONTENT_PIN_CONSTANT}`);
  }
  if (!Array.isArray(pin.paths) || pin.paths.length === 0) {
    problems.push("design.content_pin.paths is empty");
  }
  if (pin.path_count !== (Array.isArray(pin.paths) ? pin.paths.length : null)) {
    problems.push("design.content_pin.path_count does not equal paths length");
  }
  if (!pin.source_rel) problems.push("design.content_pin.source_rel missing");
  if (design.npf2_finding?.id !== "NPF-2") {
    problems.push(`design.npf2_finding.id ${JSON.stringify(design.npf2_finding?.id)} !== NPF-2`);
  }
}

function validatePositiveHalf(positive, problems) {
  if (!isObject(positive)) {
    problems.push("evidence.positive is not an object");
    return;
  }
  if (positive.half !== "positive") problems.push("evidence.positive.half must be positive");
  if (positive.self_test?.pass !== true || positive.self_test?.exit_code !== 0) {
    problems.push("evidence.positive.self_test must be green (exit 0)");
  }
  if (positive.run_status !== "completed") {
    problems.push(`evidence.positive.run_status ${JSON.stringify(positive.run_status)} !== completed`);
  }
  const finalize = positive.finalize_merge ?? {};
  if (finalize.status !== "done") {
    problems.push(`evidence.positive.finalize_merge.status ${JSON.stringify(finalize.status)} !== done`);
  }
  if (finalize.reroute_count !== 0 || finalize.terminal_reroute_count !== 0) {
    problems.push(
      `evidence.positive.finalize_merge must land on the FIRST attempt (reroute_count ${JSON.stringify(finalize.reroute_count)})`,
    );
  }
  if (!(positive.green_suite_result_count >= 1)) {
    problems.push("evidence.positive must record at least one green suite_results row");
  }
  if (positive.suite_result_tree_matches_landed !== true) {
    problems.push("evidence.positive.suite_results must be keyed to the landed tree");
  }
  const events = positive.events ?? {};
  if (events.finalize_merge_rerouted !== false || events.finalize_merge_reroute_count !== 0) {
    problems.push("evidence.positive must have no finalize_merge step.rerouted event");
  }
  if (events.landed_without_suite_evidence !== false) {
    problems.push("evidence.positive must not carry merge.landed_without_suite_evidence");
  }
  if (!positive.tested_tree || !positive.merged_tree) {
    problems.push("evidence.positive.tested_tree / merged_tree missing");
  }
}

function validateNegativeHalf(negative, problems) {
  if (!isObject(negative)) {
    problems.push("evidence.negative is not an object");
    return;
  }
  if (negative.half !== "negative") problems.push("evidence.negative.half must be negative");
  if (negative.self_test?.pass !== true || negative.self_test?.exit_code !== 0) {
    problems.push("evidence.negative.self_test must be green (exit 0)");
  }
  if (negative.suite_result_count !== 0 || (Array.isArray(negative.suite_results) && negative.suite_results.length !== 0)) {
    problems.push("evidence.negative must record ZERO suite_results rows");
  }
  const finalize = negative.finalize_merge ?? {};
  if (!(finalize.reroute_count >= 1) || !(finalize.ledger_concession_count >= 1)) {
    problems.push(
      `evidence.negative must show the first-attempt refusal + concession reroute (reroute_count ${JSON.stringify(finalize.reroute_count)})`,
    );
  }
  const events = negative.events ?? {};
  if (events.ledger_evidence_missing !== true || events.finalize_merge_rerouted !== true) {
    problems.push("evidence.negative must carry the LEDGER_EVIDENCE: missing finalize_merge reroute");
  }
  if (events.landed_without_suite_evidence !== true) {
    problems.push("evidence.negative must carry merge.landed_without_suite_evidence");
  }
  if (negative.run_status !== "completed") {
    problems.push("evidence.negative.run_status must be completed (default gate mode is fail-open)");
  }
}

function validateNewPin(pin, problems) {
  if (!isObject(pin)) {
    problems.push("new_pin is not an object");
    return;
  }
  if (!HEX64.test(String(pin.content_sha256 ?? ""))) {
    problems.push(`new_pin.content_sha256 ${JSON.stringify(pin.content_sha256)} is not a 64-hex content hash`);
  }
  if (!HEX40.test(String(pin.provenance_commit ?? ""))) {
    problems.push(`new_pin.provenance_commit ${JSON.stringify(pin.provenance_commit)} is not a full sha`);
  }
  if (!pin.provenance_subject) problems.push("new_pin.provenance_subject missing");
  if (!pin.acceptance || pin.acceptance === "NOT_ROOT_ACCEPTED") {
    problems.push(`new_pin.acceptance ${JSON.stringify(pin.acceptance)} is not the accepted value`);
  }
  if (!Array.isArray(pin.content_paths) || pin.content_paths.length === 0) {
    problems.push("new_pin.content_paths is empty");
  }
  if (!Array.isArray(pin.acceptance_evidence) || pin.acceptance_evidence.length === 0) {
    problems.push("new_pin.acceptance_evidence is empty");
  }
  if (pin.legacy_prior_pin !== undefined) {
    const legacy = pin.legacy_prior_pin;
    if (!isObject(legacy)) {
      problems.push("new_pin.legacy_prior_pin must be an object");
    } else {
      if (!HEX64.test(String(legacy.content_sha256 ?? ""))) {
        problems.push(`new_pin.legacy_prior_pin.content_sha256 ${JSON.stringify(legacy.content_sha256)} is not a 64-hex content hash`);
      }
      if (legacy.content_sha256 === pin.content_sha256) {
        problems.push("new_pin.legacy_prior_pin.content_sha256 must differ from the current content pin");
      }
      if (!legacy.reason) problems.push("new_pin.legacy_prior_pin.reason missing");
    }
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
  const alone = gates.self_tests_alone ?? {};
  if (alone.verdict !== "PASS" || alone.failed_required !== 0 || alone.red_file_count !== 0) {
    problems.push(
      `gates.self_tests_alone must be green (verdict ${JSON.stringify(alone.verdict)}, failed_required ${JSON.stringify(alone.failed_required)})`,
    );
  }
  const npf2 = alone.by_group?.npf2;
  if (!npf2 || npf2.verdict !== "PASS" || npf2.failed !== 0 || npf2.total !== 2) {
    problems.push("gates.self_tests_alone.by_group.npf2 must be 2/2 PASS");
  }
  for (const group of ["aged", "o12"]) {
    const block = alone.by_group?.[group];
    if (!block || block.verdict !== "PASS" || block.failed !== 0) {
      problems.push(`gates.self_tests_alone.by_group.${group} is red`);
    }
  }
  const chain = gates.storm_chain ?? {};
  if (chain.verdict !== "PASS") problems.push(`gates.storm_chain.verdict ${JSON.stringify(chain.verdict)} !== PASS`);
  if (chain.file_count_expected !== 49 || chain.file_count_observed !== 49) {
    problems.push("gates.storm_chain must observe exactly 49 files");
  }
  if (chain.red_file_count !== 0) problems.push("gates.storm_chain.red_file_count must be 0");
  if (chain.totals?.fail !== 0) problems.push("gates.storm_chain.totals.fail must be 0");
  const lock = chain.lock ?? {};
  if (lock.path !== GATE_LOCK_PATH) problems.push("gates.storm_chain.lock.path must be the shared gate lock");
  for (const key of ["submit_iso", "acquire_iso", "release_iso"]) {
    if (typeof lock[key] !== "string" || lock[key].length === 0) {
      problems.push(`gates.storm_chain.lock.${key} missing (flock timing required)`);
    }
  }
  if (lock.untouched === false) problems.push("gates.storm_chain.lock was modified");
}

function validateFinalSquash(finalSquash, newPin, problems) {
  if (!isObject(finalSquash)) {
    problems.push("final_squash is not an object");
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(finalSquash, "final_squash_hash")) {
    problems.push("final_squash.final_squash_hash must be present");
  }
  if (finalSquash.final_squash_hash !== null) {
    problems.push(`final_squash.final_squash_hash ${JSON.stringify(finalSquash.final_squash_hash)} must be null`);
  }
  if (finalSquash.story_commits_survive_squash !== false) {
    problems.push("final_squash.story_commits_survive_squash must be false");
  }
  if (!HEX40.test(String(finalSquash.provenance_commit ?? ""))) {
    problems.push(`final_squash.provenance_commit ${JSON.stringify(finalSquash.provenance_commit)} is not a full sha`);
  }
  if (finalSquash.provenance_commit !== newPin?.provenance_commit) {
    problems.push("final_squash.provenance_commit must equal new_pin.provenance_commit");
  }
  if (finalSquash.provenance_subject !== newPin?.provenance_subject) {
    problems.push("final_squash.provenance_subject must equal new_pin.provenance_subject");
  }
  const note = String(finalSquash.note ?? "");
  if (!/squash/i.test(note)) problems.push("final_squash.note must name the merge-worktree squash");
  if (!/content[- ]?address|content_sha256|content pin/i.test(note)) {
    problems.push("final_squash.note must name the content-addressed pin as the durable anchor");
  }
  const anchor = finalSquash.durable_anchor ?? {};
  if (anchor.kind !== "content_sha256" || anchor.value !== newPin?.content_sha256) {
    problems.push("final_squash.durable_anchor must be the new_pin.content_sha256");
  }
}

/**
 * Validate a complete contract. Returns `{ ok, problems }` and never throws.
 * A contract that disagrees with the retained evidence is not publishable.
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
  validateDesign(contract.design, problems);
  validatePositiveHalf(contract.evidence?.positive, problems);
  validateNegativeHalf(contract.evidence?.negative, problems);
  validateNewPin(contract.new_pin, problems);
  validateGates(contract.gates, problems);
  validateFinalSquash(contract.final_squash, contract.new_pin, problems);
  return { ok: problems.length === 0, problems };
}
