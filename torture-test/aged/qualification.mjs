// qualification.mjs — STORM-SEED-QUALIFY (US-012): assemble the honest
// seed-validation verdict + the committed readiness pointer.
//
// The spec's seed-validation gate (09-wave-5-storm.md → "Pre-storm arming")
// requires "the full gating oracle battery + O12 runs against the seeded
// state and must pass BEFORE the first storm launch".  This module reads the
// owned full-seed root's real evidence (manifest, census receipt, immutable
// snapshot sidecar, routing matrix, O12 run, generation report), the prepared
// SCRIPTED_REHEARSAL campaign (descriptor/state + arm results), the gate
// battery summaries, and the pinned tt-poly origin manifest, then emits TWO
// artifacts:
//
//   * /home/kaladin/matchlock-work/storm-seed-qualification.json — the
//     published, authoritative qualification (seed root, pins, counts,
//     generation wall time, per-oracle matrix with a classification for every
//     red, the honest `qualified` verdict + named blockers with Igor-decision
//     flags, the arming results, the campaign/pending candidate, and the
//     recomputed gate hashes).  Lives OUTSIDE the repo (host evidence).
//   * torture-test/storm-seed-readiness.json — a small COMMITTED pointer that
//     locates the published qualification + the on-disk campaign.  It is a
//     locator only, never authority, and never carries the seed corpus.
//
// Honesty rules encoded here (never relaxed):
//   * qualified === true iff EVERY gating oracle (O1..O11/O16) and O12 PASS
//     against the seeded state.  NOT_RUN and NOT_EVALUABLE are NOT passes.
//   * a red is classified NATIVE (product finding — record only), SUITE
//     (validator bug — fixed here) or ENVIRONMENT (host).  Nothing is
//     relabeled to make the verdict green.
//
// Importable + thin CLI: `node torture-test/aged/qualification.mjs` fits the
// current run's evidence; tests import the pure builders below.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { computeGateHashes } from "../bin/tt-storm-rehearsal.mjs";
import { O12_PINNED_CONTENT_SHA256, O12_PINNED_PROVENANCE_COMMIT } from "./validate.mjs";

export const QUALIFICATION_KIND = "storm-seed-qualification";
export const READINESS_KIND = "storm-seed-readiness";
export const GATING_ORACLES = Object.freeze([
  "O1", "O2", "O3z", "O4", "O5", "O6", "O7",
  "O8", "O9", "O10", "O11", "O16", "O12",
]);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function gitText(repoRoot, args) {
  const res = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return res.status === 0 ? (res.stdout || "").trim() : null;
}

/**
 * Read the working-tree provenance of the checkout that produced the
 * qualification.  `tree_dirty` is judged over TRACKED modifications only
 * (`--untracked-files=no`): the pointer/generator files are new artifacts of
 * this story, not drift in the qualified source.
 */
export function readSourceProvenance(repoRoot, { commit = null } = {}) {
  // A seed/readiness record may pin a STABLE source id instead of the
  // pre-squash story HEAD: this run's commits are squashed at landing, so a
  // story-commit sha would not survive.  `commit` is resolved through git (tree
  // and subject are read back, never typed); omit it to record HEAD.
  const resolved = commit ?? gitText(repoRoot, ["rev-parse", "HEAD"]);
  const tree = gitText(repoRoot, ["rev-parse", `${resolved}^{tree}`]);
  const subject = gitText(repoRoot, ["log", "-1", "--pretty=%s", resolved]);
  const porcelain = gitText(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  return {
    commit: resolved,
    tree,
    subject,
    tree_dirty: porcelain !== null && porcelain.length > 0,
    provenance: commit
      ? "durable source pin: the stable branch-base/upstream commit recorded from git (never a pre-squash story commit); tree_dirty is tracked-modification only (--untracked-files=no)"
      : "recorded from HEAD; tree_dirty is tracked-modification only (--untracked-files=no)",
  };
}

// ── per-row matrix + classification ──────────────────────────────────────
// Every routing row is echoed with the tooling's own status.  PASS rows carry
// classification "PASS"; the sole FAIL row carries its NATIVE/SUITE/
// ENVIRONMENT class from the classification ledger; NOT_RUN / NOT_EVALUABLE
// rows are scope-excluded (synthetic zero-token corpus) and are recorded as
// blockers, never as passes.
export function buildMatrix(report, classification) {
  const nativeById = new Map();
  for (const red of classification?.native_reds ?? []) {
    nativeById.set(red.oracle, red);
  }
  const suiteOracles = new Set((classification?.suite_reds ?? []).map((r) => r.oracle));
  const envOracles = new Set((classification?.environment_reds ?? []).map((r) => r.oracle));
  const rows = report?.routing?.rows ?? [];
  return rows.map((row) => {
    const oracle = row.oracle;
    let classificationOut;
    if (row.status === "PASS") classificationOut = "PASS";
    else if (row.status === "FAIL") {
      if (nativeById.has(oracle)) classificationOut = "NATIVE";
      else if (suiteOracles.has(oracle)) classificationOut = "SUITE";
      else if (envOracles.has(oracle)) classificationOut = "ENVIRONMENT";
      else classificationOut = "UNCLASSIFIED";
    } else if (row.status === "NOT_EVALUABLE") {
      classificationOut = "NOT_EVALUABLE";
    } else {
      classificationOut = "NOT_RUN";
    }
    return {
      oracle,
      status: row.status,
      classification: classificationOut,
      red: row.status === "FAIL",
      execution_kind: row.execution_kind ?? null,
      full_oracle_status: row.full_oracle_status ?? null,
      findings: (row.findings ?? []).map((f) => (typeof f === "string" ? f : f.id ?? f.summary ?? String(f))),
      counts: row.counts ?? null,
    };
  });
}

// ── honest verdict ───────────────────────────────────────────────────────
export function buildVerdict({ matrix, o12, o12Pin }) {
  const reds = matrix.filter((r) => r.red);
  const suiteReds = reds.filter((r) => r.classification === "SUITE");
  const nativeReds = reds.filter((r) => r.classification === "NATIVE");
  const envReds = reds.filter((r) => r.classification === "ENVIRONMENT");
  const notPass = matrix.filter((r) => r.status !== "PASS");

  const blockers = [];
  if (o12?.result === "FAIL") {
    blockers.push({
      id: "BLOCKER-O12-TIME-NATIVE",
      classification: "NATIVE",
      oracle: "O12",
      summary:
        "Real pinned O12 oracle FAILs the R3 timestamp-uniformity leg: product createRun/step-ops write created_at as ISO-8601 while updated_at uses SQLite's native 'YYYY-MM-DD HH:MM:SS' (24,166 mismatched pairs; steps.updated_at 19,166 SQLite-native + 7,360 ISO of 26,526).",
      igor_decision: true,
      beads: ["tamandua-6sy.31", "tamandua-6sy.27"],
      evidence: [
        "evidence/seed-validation-report.json",
        "evidence/seed-validation-classification.json",
        "evidence/o12/o12/2026-09-15T09-07-09-133Z/o12-run-evidence.json",
        "evidence/o12/o12/2026-09-15T09-07-09-133Z/o12-db-integrity.json",
        "evidence/db-full-post-2026-09-15T07-22-31-764Z.sqlite",
      ],
    });
  }
  if (o12Pin?.acceptance === "NOT_ROOT_ACCEPTED") {
    blockers.push({
      id: "BLOCKER-O12-PIN-NOT-ROOT-ACCEPTED",
      classification: "ENVIRONMENT",
      oracle: "O12",
      summary:
        `The O12 pin recorded in this report (${o12Pin.content_sha256 ?? o12Pin.commit ?? "unknown"}) is NOT_ROOT_ACCEPTED, so the run under it is provisional (pin drift, not seed corruption). Seed qualification requires the accepted schema-9..13 O12 CONTENT pin (content_sha256 ${O12_PINNED_CONTENT_SHA256}, provenance commit ${O12_PINNED_PROVENANCE_COMMIT.slice(0, 8)}, supports user_version {9, 10, 11, 12, 13}); the current pin is ROOT_ACCEPTED and does not raise this blocker.`,
      igor_decision: true,
      beads: ["tamandua-6sy.6.3.1"],
      evidence: ["evidence/seed-validation-report.json", "evidence/o12-reserved-baseline.json"],
    });
  }
  const notRun = matrix.filter((r) => r.status === "NOT_RUN").map((r) => r.oracle);
  const notEvaluable = matrix.filter((r) => r.status === "NOT_EVALUABLE").map((r) => r.oracle);
  if (notRun.length > 0) {
    blockers.push({
      id: "BLOCKER-ORACLES-NOT-RUN",
      classification: "NOT_RUN",
      oracle: null,
      oracles: notRun,
      summary:
        "The spec gate requires the full gating oracle battery against the seeded state; these oracles are NOT_RUN because their real semantics need a live campaign (real agent work, merge landings, process census, tripwire projections) that a zero-token synthetic corpus cannot produce.",
      igor_decision: true,
      beads: ["tamandua-6sy.6.4.1"],
      evidence: ["evidence/seed-validation-report.json", "evidence/seed-validation-classification.json"],
    });
  }
  if (notEvaluable.length > 0) {
    blockers.push({
      id: "BLOCKER-ORACLES-NOT-EVALUABLE",
      classification: "NOT_EVALUABLE",
      oracle: null,
      oracles: notEvaluable,
      summary:
        "O5 host-process census requires the campaign recorder layer owned by other runs; only the transport double's close receipt exists at seed level.",
      igor_decision: true,
      beads: ["tamandua-6sy.6.4.1"],
      evidence: ["evidence/seed-validation-report.json"],
    });
  }

  const qualified = matrix.length === GATING_ORACLES.length
    && reds.length === 0
    && notPass.length === 0
    && suiteReds.length === 0;
  return {
    qualified,
    qualified_reason: qualified
      ? "Every gating oracle and O12 PASS against the seeded state; the seed-validation gate is satisfied."
      : "The spec gate requires the full gating oracle battery + O12 to PASS against the seeded state; the final matrix contains FAIL / NOT_RUN / NOT_EVALUABLE rows, so the seed is NOT qualified.",
    blockers,
    suite_reds: suiteReds,
    native_reds: nativeReds,
    environment_reds: envReds,
    matrix_tally: {
      PASS: matrix.filter((r) => r.status === "PASS").length,
      FAIL: matrix.filter((r) => r.status === "FAIL").length,
      NOT_RUN: notRun.length,
      NOT_EVALUABLE: notEvaluable.length,
    },
    igor_decision_blockers: blockers.filter((b) => b.igor_decision).map((b) => b.id),
  };
}

// ── assembly ─────────────────────────────────────────────────────────────
/**
 * Build the published qualification object.  Every input is an on-disk
 * evidence path so a rerun is a pure recompute, never a hand edit.
 */
export function buildQualification({
  repoRoot,
  seedRoot,
  campaignDir,
  originPinsPath,
  armResultsPath,
  chainSummaryPath,
  selfTestsSummaryPath,
  runId,
  branch = "feature/storm-seed-qualify-20260915",
  sourceCommit = null,
  publishedPath,
  pointerPath,
  publishedAtUtc,
}) {
  const manifest = readJson(path.join(seedRoot, "manifest.json"));
  const generation = readJson(path.join(seedRoot, "evidence", "generation-report.json"));
  const censusReceipt = readJson(manifest.snapshot.censusReceipt.file);
  const report = readJson(path.join(seedRoot, "evidence", "seed-validation-report.json"));
  const classification = readJson(path.join(seedRoot, "evidence", "seed-validation-classification.json"));
  const originPins = readJson(originPinsPath);
  const descriptor = readJson(path.join(campaignDir, "descriptor.json"));
  const state = readJson(path.join(campaignDir, "state.json"));
  const arm = readJson(armResultsPath);
  const chain = readJson(chainSummaryPath);
  const selfTests = readJson(selfTestsSummaryPath);
  const source = readSourceProvenance(repoRoot, { commit: sourceCommit });
  const gateHashes = computeGateHashes({ repoRoot });
  const recordedGateHashes = descriptor.gate_hashes ?? {};
  const gateRels = [...new Set([...Object.keys(gateHashes), ...Object.keys(recordedGateHashes)])].sort();
  const gateDrift = gateRels
    .filter((rel) => gateHashes[rel] !== recordedGateHashes[rel])
    .map((rel) => ({ file: rel, recomputed: gateHashes[rel] ?? null, prepared: recordedGateHashes[rel] ?? null }));
  const gateMatch = gateDrift.length === 0;

  const matrix = buildMatrix(report, classification);
  const verdict = buildVerdict({ matrix, o12: report.o12?.stdoutJson ?? null, o12Pin: report.o12_pin ?? null });

  return {
    kind: QUALIFICATION_KIND,
    schema_version: 1,
    task: "STORM-SEED-QUALIFY",
    bead: "tamandua-6sy.6.4.1",
    parent_bead: "tamandua-6sy.6.4",
    sibling_bead: "tamandua-6sy.6.3.1",
    run_id: runId,
    branch,
    worktree: repoRoot,
    published_at_utc: publishedAtUtc,
    published_path: publishedPath,
    source,
    pins: {
      source: { commit: source.commit, tree: source.tree, subject: source.subject },
      origin: originPins.origin,
      origin_bare: originPins.bare,
      origin_pins: originPins.pins,
      origin_verification: originPins.verification,
      o12_oracle: report.o12_pin ?? null,
    },
    seed: {
      root: seedRoot,
      kind: manifest.seed_kind,
      allocated_at_utc: manifest.allocated_at_utc,
      allocated_by_run: manifest.allocated_by_run,
      manifest_qualified: manifest.qualified,
      counts: {
        runs: censusReceipt.db.runs,
        steps: censusReceipt.db.steps,
        run_worktrees: censusReceipt.db.run_worktrees,
        logical_events: censusReceipt.events.perRunLogicalLines,
      },
      by_status: censusReceipt.db.byStatus,
      disposition_counts: manifest.disposition_counts,
      seed_failures: {
        count: manifest.seed_failures.length,
        families: generation.seed_failures.families,
        note: generation.seed_failures.note,
      },
      db_snapshot: manifest.snapshot.db,
      reserved_baseline_sidecar: manifest.snapshot.reservedBaselineSidecar,
      events: censusReceipt.events,
      worktrees: {
        row_count: censusReceipt.worktrees.rowCount,
        directory_count: censusReceipt.worktrees.directoryCount,
        by_status: censusReceipt.worktrees.byStatus,
      },
    },
    generation: {
      under_flock: true,
      lock_path: "/home/kaladin/matchlock-work/vaivm-gate.lock",
      wall_time_seconds:
        generation.wall_time_seconds
        ?? generation.timing?.wall_time_seconds
        ?? generation.timing_seconds?.full_seed
        ?? null,
      timing_seconds: generation.timing ?? generation.timing_seconds ?? null,
      disk_bytes: generation.disk ?? generation.disk_bytes ?? null,
      logical_events_final:
        generation.volume?.logical_events_final
        ?? generation.events?.per_run_logical_lines
        ?? generation.logical_events_final
        ?? null,
      spec_scale_met: generation.spec_scale?.met ?? generation.spec_scale_met ?? null,
      spec_scale: generation.spec_scale ?? null,
    },
    validation: {
      report_path: path.join(seedRoot, "evidence", "seed-validation-report.json"),
      report_ts_utc: report.ts_utc,
      classification_path: path.join(seedRoot, "evidence", "seed-validation-classification.json"),
      validator_source_head: report.validator_source,
      matrix,
      matrix_tally: verdict.matrix_tally,
      suite_reds: verdict.suite_reds,
      native_reds: verdict.native_reds,
      environment_reds: verdict.environment_reds,
      o12: {
        result: report.o12?.stdoutJson?.result ?? null,
        exit_code: report.o12?.exitCode ?? null,
        findings: report.o12?.stdoutJson?.findings ?? [],
        counts:
          classification.o12_time_red?.counts
          ?? classification.native_reds?.[0]?.counts
          ?? null,
        legs: classification.o12_legs ?? null,
        schema: classification.o12_schema ?? null,
        observations: classification.observations ?? [],
      },
    },
    qualified: verdict.qualified,
    qualified_reason: verdict.qualified_reason,
    qualified_scope_note:
      "qualified := (full gating oracle battery + O12 PASS against the seeded state) — the spec's seed-validation gate. A synthetic zero-token corpus legitimately cannot exercise the live-campaign oracles; those rows stay NOT_RUN, never PASS.",
    blockers: verdict.blockers,
    igor_decision_blockers: verdict.igor_decision_blockers,
    arming: {
      campaign_id: state.campaign_id,
      campaign_dir: campaignDir,
      profile: descriptor.profile,
      label: descriptor.label,
      mode: state.mode,
      descriptor_kind: descriptor.kind,
      pending_candidate: state.pending_candidate,
      arm: arm.arm,
      no_storm_round_executed: arm.no_storm_round_executed,
      approval_file_created_by_this_story: arm.approval_file_created_by_this_story,
      approval_file_note: arm.approval_file_note,
      qualification_before_storm: state.qualification,
    },
    gates: {
      aged_o12_storm_self_tests_alone: {
        summary_path: selfTestsSummaryPath,
        head: selfTests.git_head ?? selfTests.head ?? null,
        env: selfTests.environment ?? selfTests.env ?? null,
        totals: selfTests.totals ?? null,
        verdict: selfTests.verdict ?? null,
        total_required: selfTests.total_required ?? null,
        passed_required: selfTests.passed_required ?? null,
        failed_required: selfTests.failed_required ?? null,
        red_file_count: selfTests.red_file_count ?? null,
        red_files: selfTests.red_files ?? [],
        by_group: selfTests.by_group ?? null,
      },
      storm_chain_49: {
        summary_path: chainSummaryPath,
        generated_at_utc: chain.generated_at_utc,
        file_count_expected: chain.file_count_expected,
        file_count_observed: chain.file_count_observed,
        red_file_count: chain.red_file_count,
        red_files: chain.red_files,
        totals: chain.totals,
        verdict: chain.verdict,
        harness_guard_env: chain.harness_guard_env,
        lock: chain.lock,
      },
    },
    gate_hashes: {
      recomputed_at_utc: publishedAtUtc,
      recomputed_source_commit: source.commit,
      files: gateHashes,
      count: Object.keys(gateHashes).length,
      prepared_campaign_descriptor: recordedGateHashes,
      matches_prepared_campaign_descriptor: gateMatch,
      drifted_files: gateDrift,
    },
    readiness_pointer: {
      path: pointerPath,
      kind: READINESS_KIND,
      note: "The committed pointer is a locator only; this file is the authority.",
    },
  };
}

/**
 * The committed readiness pointer: a small locator for the published
 * qualification + the prepared campaign.  Never carries seed corpus bytes.
 */
export function buildReadinessPointer({ qualification, qualificationPath, pointerPath }) {
  return {
    kind: READINESS_KIND,
    schema_version: 1,
    task: qualification.task,
    bead: qualification.bead,
    run_id: qualification.run_id,
    branch: qualification.branch,
    published_at_utc: qualification.published_at_utc,
    source: qualification.source,
    qualification: {
      path: qualificationPath,
      kind: QUALIFICATION_KIND,
      qualified: qualification.qualified,
      blocker_count: qualification.blockers.length,
      blocker_ids: qualification.blockers.map((b) => b.id),
      igor_decision_blockers: qualification.igor_decision_blockers,
    },
    seed: {
      root: qualification.seed.root,
      kind: qualification.seed.kind,
      counts: qualification.seed.counts,
      manifest_qualified: qualification.seed.manifest_qualified,
    },
    campaign: {
      id: qualification.arming.campaign_id,
      dir: qualification.arming.campaign_dir,
      profile: qualification.arming.profile,
      mode: qualification.arming.mode,
      pending_candidate: qualification.arming.pending_candidate,
    },
    gate_hashes: {
      count: qualification.gate_hashes.count,
      recompute_match: qualification.gate_hashes.matches_prepared_campaign_descriptor,
      matches_prepared_campaign_descriptor:
        qualification.gate_hashes.matches_prepared_campaign_descriptor,
      drifted_file_count: (qualification.gate_hashes.drifted_files ?? []).length,
    },
    note:
      "Readiness pointer only: it locates the published storm-seed-qualification.json and the prepared SCRIPTED_REHEARSAL campaign. It carries no seed corpus and grants no launch authority.",
  };
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, p);
  return p;
}

export function publishQualification({ qualification, pointer, qualificationPath, pointerPath }) {
  writeJson(qualificationPath, qualification);
  writeJson(pointerPath, pointer);
  return { qualificationPath, pointerPath };
}

// ── Thin CLI (only when invoked directly) ────────────────────────────────
function usage() {
  return [
    "Usage: node torture-test/aged/qualification.mjs --seed-root <dir> --campaign <dir> \\",
    "         [--origin-pins <file>] [--arm-results <file>] [--chain-summary <file>] \\",
    "         [--self-tests-summary <file>] [--run-id <id>] [--branch <name>] \\",
    "         [--source-commit <sha>] [--out <file>] [--pointer <file>]",
    "",
    "--source-commit records a STABLE branch-base/upstream commit as the source",
    "pin (the run's story commits are squashed at landing), resolved via git.",
    "",
    "Assemble the STORM-SEED-QUALIFY qualification JSON + committed readiness",
    "pointer from the seed root's real evidence.  Exit 0 iff the qualification",
    "was written (the verdict may be honest-false).",
  ].join("\n");
}

export function runCli(argv) {
  const flag = (name, def = null) => {
    const i = argv.indexOf(name);
    return i === -1 ? def : argv[i + 1];
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
  const seedRoot = flag("--seed-root");
  const campaignDir = flag("--campaign");
  if (!seedRoot || !campaignDir) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const resultsDir = path.join(repoRoot, "torture-test", "var", "results");
  const publishedPath = flag("--out", "/home/kaladin/matchlock-work/storm-seed-qualification.json");
  const pointerPath = flag("--pointer", path.join(repoRoot, "torture-test", "storm-seed-readiness.json"));
  const qualification = buildQualification({
    repoRoot,
    seedRoot,
    campaignDir,
    originPinsPath: flag("--origin-pins", path.join(resultsDir, "storm-origin-pins-20260915T045634Z.json")),
    armResultsPath: flag("--arm-results", path.join(resultsDir, "storm-arm-results-20260915T094658Z.json")),
    chainSummaryPath: flag("--chain-summary", path.join(resultsDir, "storm-chain-2026-09-15T12-01-28Z", "chain-summary.json")),
    selfTestsSummaryPath: flag("--self-tests-summary", path.join(resultsDir, "self-tests-alone-2026-09-15T10-35-50Z", "selftest-alone-summary.json")),
    runId: flag("--run-id", "run-d0506ff9-0e1c-4405-b673-920391308881"),
    branch: flag("--branch", "feature/storm-seed-qualify-20260915"),
    sourceCommit: flag("--source-commit", null),
    publishedPath,
    pointerPath,
    publishedAtUtc: flag("--published-at", new Date().toISOString()),
  });
  const pointer = buildReadinessPointer({ qualification, qualificationPath: publishedPath, pointerPath });
  publishQualification({ qualification, pointer, qualificationPath: publishedPath, pointerPath });
  process.stdout.write(`${JSON.stringify({
    qualification_path: publishedPath,
    pointer_path: pointerPath,
    qualified: qualification.qualified,
    blockers: qualification.blockers.map((b) => b.id),
    matrix_tally: qualification.validation.matrix_tally,
    gate_hashes_count: qualification.gate_hashes.count,
    gate_hashes_match: qualification.gate_hashes.matches_prepared_campaign_descriptor,
  }, null, 2)}\n`);
  return 0;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
  process.exitCode = runCli(process.argv.slice(2));
}
