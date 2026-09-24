// refresh-readiness.mjs — NPF-2 US-012: refresh the committed storm-seed
// readiness pointer and the published seed qualification from the fresh aged
// re-validation of the retained aged-state seed snapshot.
//
// The durable O12 pin is the CONTENT hash of the oracle set; the recorded
// provenance commit (the run's base HEAD, never a pre-squash story commit) is
// provenance ONLY.  On the TORTURE-PORT product that commit is a pre-port source
// and is marked `legacy_not_ancestor` in the refreshed pair.  Re-running
// `tt-storm-aged validate` on an owned copy of the retained seed root proves the
// accepted content pin still evaluates the immutable user_version-10 snapshot
// (R1/R2/R4/R5 PASS, R3 FAIL native TIME).  This module re-shapes the
// qualification + pointer from that fresh evidence, never by hand-editing
// values:
//
//   * the preserved sections (arming campaign, gates, origin pins, generation)
//     come from the existing published qualification;
//   * the dynamic sections (seed root/counts, source, O12 pin, validation
//     matrix/verdict, gate-hash boundary) are recomputed from the fresh copy.
//
// Gate-hash honesty: the qualification records the gate files RECOMPUTED from
// the current tree and separately the prepared campaign descriptor's pin.  The
// NPF-2 fix changed four gate files after the campaign was prepared, so
// `matches_prepared_campaign_descriptor` is honestly false and the exact
// `drifted_files` are named — the qualification must never claim a match it did
// not observe.
//
// Pure builders + a thin CLI (`node torture-test/aged/refresh-readiness.mjs`).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { computeGateHashes } from "../bin/tt-storm-rehearsal.mjs";
import {
  QUALIFICATION_KIND,
  READINESS_KIND,
  buildMatrix,
  buildVerdict,
  buildReadinessPointer,
} from "./qualification.mjs";
import {
  O12_PINNED_CONTENT_SHA256,
  O12_PINNED_PROVENANCE_COMMIT,
  O12_PINNED_PROVENANCE_SUBJECT,
  O12_PINNED_PROVENANCE_LEGACY_REASON,
  O12_PINNED_ACCEPTANCE,
} from "./validate.mjs";
import { findLatestDbIntegrity, extractLegMatrix } from "./seed-root-copy.mjs";

export const REFRESH_KIND = "storm-seed-readiness-refresh";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function gitText(repoRoot, args) {
  const res = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return res.status === 0 ? (res.stdout || "").trim() : null;
}

/**
 * Compare the freshly recomputed gate-file hashes against the prepared campaign
 * descriptor's pin.  Returns the recomputed map, the descriptor map and the
 * exact drifted files; a mismatch is recorded, never hidden.
 */
export function compareGateHashes({ gateHashes, preparedCampaignDescriptor } = {}) {
  const files = { ...(gateHashes ?? {}) };
  const prepared = { ...(preparedCampaignDescriptor ?? {}) };
  const rels = [...new Set([...Object.keys(files), ...Object.keys(prepared)])].sort();
  const drifted = [];
  for (const rel of rels) {
    if (files[rel] !== prepared[rel]) {
      drifted.push({ file: rel, recomputed: files[rel] ?? null, prepared: prepared[rel] ?? null });
    }
  }
  return {
    files,
    count: Object.keys(files).length,
    prepared_campaign_descriptor: prepared,
    matches_prepared_campaign_descriptor: drifted.length === 0,
    drifted_files: drifted,
  };
}

/**
 * Resolve the durable provenance record for the O12 content pin.  On the run it
 * was authored the provenance commit was reachable from HEAD; on the
 * TORTURE-PORT product it is a pre-port source commit, so the returned record
 * carries `legacy_not_ancestor`/`legacy_reason` when it is not an ancestor (the
 * seed-readiness self-test requires that explicit declaration before accepting
 * an unreachable source).  The tree/subject are resolved from git, never
 * retyped.
 */
export function resolvePinProvenanceSource(repoRoot) {
  const tree = gitText(repoRoot, ["rev-parse", `${O12_PINNED_PROVENANCE_COMMIT}^{tree}`]);
  const anc = spawnSync(
    "git",
    ["-C", repoRoot, "merge-base", "--is-ancestor", O12_PINNED_PROVENANCE_COMMIT, "HEAD"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const isAncestor = anc.status === 0;
  return {
    commit: O12_PINNED_PROVENANCE_COMMIT,
    tree,
    subject: O12_PINNED_PROVENANCE_SUBJECT,
    tree_dirty: false,
    provenance:
      "durable O12 content-pin provenance: the landed squash commit recorded from HEAD; the CONTENT hash (not this commit) is the pin",
    legacy_not_ancestor: !isAncestor,
    ...(isAncestor ? {} : { legacy_reason: O12_PINNED_PROVENANCE_LEGACY_REASON }),
  };
}

/**
 * Build the refreshed published qualification from the fresh aged re-validation
 * evidence.  Preserved sections come from `existing`; dynamic sections are
 * recomputed.  Pure (no I/O).
 */
export function buildRefreshedQualification({
  existing,
  refreshedBy = null,
  source,
  seedRoot,
  seedManifest,
  censusReceipt,
  report,
  classification,
  gateHashes,
  preparedCampaignDescriptor,
  gateHashesSourceCommit = null,
  publishedAtUtc,
  publishedPath,
  pointerPath,
} = {}) {
  const pre = existing ?? {};
  const matrix = buildMatrix(report, classification);
  const verdict = buildVerdict({
    matrix,
    o12: report?.o12?.stdoutJson ?? null,
    o12Pin: report?.o12_pin ?? null,
  });
  const gate = compareGateHashes({ gateHashes, preparedCampaignDescriptor });
  const reportPath = path.join(seedRoot, "evidence", "seed-validation-report.json");
  const classificationPath = path.join(seedRoot, "evidence", "seed-validation-classification.json");

  const seedCounts = censusReceipt?.db
    ? {
        runs: censusReceipt.db.runs,
        steps: censusReceipt.db.steps,
        run_worktrees: censusReceipt.db.run_worktrees,
        logical_events: censusReceipt.events?.perRunLogicalLines,
      }
    : (pre.seed?.counts ?? null);

  return {
    ...pre,
    kind: QUALIFICATION_KIND,
    schema_version: 1,
    task: pre.task ?? "STORM-SEED-QUALIFY",
    bead: pre.bead ?? null,
    parent_bead: pre.parent_bead ?? null,
    sibling_bead: pre.sibling_bead ?? null,
    run_id: pre.run_id ?? null,
    branch: pre.branch ?? null,
    worktree: pre.worktree ?? null,
    published_at_utc: publishedAtUtc,
    published_path: publishedPath,
    refreshed_by: refreshedBy,
    source,
    pins: { ...(pre.pins ?? {}), o12_oracle: report?.o12_pin ?? null },
    seed: {
      ...(pre.seed ?? {}),
      root: seedRoot,
      kind: seedManifest?.seed_kind ?? pre.seed?.kind,
      allocated_at_utc: seedManifest?.allocated_at_utc ?? pre.seed?.allocated_at_utc,
      allocated_by_run: seedManifest?.allocated_by_run ?? pre.seed?.allocated_by_run,
      manifest_qualified: seedManifest?.qualified ?? pre.seed?.manifest_qualified,
      counts: seedCounts,
      by_status: censusReceipt?.db?.byStatus ?? pre.seed?.by_status,
      disposition_counts: seedManifest?.disposition_counts ?? pre.seed?.disposition_counts,
      db_snapshot: seedManifest?.snapshot?.db ?? pre.seed?.db_snapshot,
      reserved_baseline_sidecar:
        seedManifest?.snapshot?.reservedBaselineSidecar ?? pre.seed?.reserved_baseline_sidecar,
      events: censusReceipt?.events ?? pre.seed?.events,
      worktrees: censusReceipt?.worktrees
        ? {
            row_count: censusReceipt.worktrees.rowCount,
            directory_count: censusReceipt.worktrees.directoryCount,
            by_status: censusReceipt.worktrees.byStatus,
          }
        : pre.seed?.worktrees,
    },
    validation: {
      ...(pre.validation ?? {}),
      report_path: reportPath,
      report_ts_utc: report?.ts_utc ?? null,
      classification_path: classificationPath,
      validator_source_head: report?.validator_source ?? null,
      matrix,
      matrix_tally: verdict.matrix_tally,
      suite_reds: verdict.suite_reds,
      native_reds: verdict.native_reds,
      environment_reds: verdict.environment_reds,
      o12: {
        result: report?.o12?.stdoutJson?.result ?? null,
        exit_code: report?.o12?.exitCode ?? null,
        findings: report?.o12?.stdoutJson?.findings ?? [],
        counts: classification?.native_reds?.[0]?.counts ?? null,
        observations: classification?.observations ?? [],
      },
    },
    qualified: verdict.qualified,
    qualified_reason: verdict.qualified_reason,
    qualified_scope_note: pre.qualified_scope_note,
    blockers: verdict.blockers,
    igor_decision_blockers: verdict.igor_decision_blockers,
    gate_hashes: {
      ...(pre.gate_hashes ?? {}),
      recomputed_at_utc: publishedAtUtc,
      recomputed_source_commit: gateHashesSourceCommit ?? source?.commit ?? null,
      files: gate.files,
      count: gate.count,
      prepared_campaign_descriptor: gate.prepared_campaign_descriptor,
      matches_prepared_campaign_descriptor: gate.matches_prepared_campaign_descriptor,
      drifted_files: gate.drifted_files,
    },
    readiness_pointer: {
      path: pointerPath,
      kind: READINESS_KIND,
      note: "The committed pointer is a locator only; this file is the authority.",
    },
  };
}

/**
 * Validate the refreshed pair against the US-012 acceptance contract.  Returns
 * `{ ok, problems }`; never throws.
 */
export function validateRefreshedReadiness({
  qualification,
  pointer,
  legMatrix,
  qualificationPath,
  expectedContentSha256 = O12_PINNED_CONTENT_SHA256,
  expectedProvenanceCommit = O12_PINNED_PROVENANCE_COMMIT,
  expectedAcceptance = O12_PINNED_ACCEPTANCE,
} = {}) {
  const problems = [];
  if (!qualification || typeof qualification !== "object") {
    return { ok: false, problems: ["qualification is not an object"] };
  }
  if (qualification.kind !== QUALIFICATION_KIND) {
    problems.push(`qualification.kind ${JSON.stringify(qualification.kind)} !== ${QUALIFICATION_KIND}`);
  }
  if (qualification.task !== "STORM-SEED-QUALIFY") {
    problems.push(`qualification.task ${JSON.stringify(qualification.task)} !== STORM-SEED-QUALIFY`);
  }
  if (!pointer || typeof pointer !== "object") {
    problems.push("readiness pointer is not an object");
  } else {
    if (pointer.kind !== READINESS_KIND) {
      problems.push(`pointer.kind ${JSON.stringify(pointer.kind)} !== ${READINESS_KIND}`);
    }
    if (pointer.seed?.root !== qualification.seed?.root) {
      problems.push(`pointer.seed.root ${pointer.seed?.root} !== qualification ${qualification.seed?.root}`);
    }
    if (pointer.source?.commit !== qualification.source?.commit) {
      problems.push(`pointer.source.commit ${pointer.source?.commit} !== qualification ${qualification.source?.commit}`);
    }
    if (pointer.qualification?.path !== qualificationPath) {
      problems.push(`pointer.qualification.path ${pointer.qualification?.path} !== ${qualificationPath}`);
    }
  }

  const pin = qualification.pins?.o12_oracle ?? {};
  if (pin.content_sha256 !== expectedContentSha256) {
    problems.push(`o12_oracle.content_sha256 ${pin.content_sha256} !== ${expectedContentSha256}`);
  }
  if (pin.provenance_commit !== expectedProvenanceCommit) {
    problems.push(`o12_oracle.provenance_commit ${pin.provenance_commit} !== ${expectedProvenanceCommit}`);
  }
  if (pin.acceptance !== expectedAcceptance) {
    problems.push(`o12_oracle.acceptance ${pin.acceptance} !== ${expectedAcceptance}`);
  }

  if (legMatrix) {
    const legs = legMatrix.legs ?? {};
    for (const leg of ["R1", "R2", "R4", "R5"]) {
      if (legs[leg]?.result !== "PASS") {
        problems.push(`${leg} ${legs[leg]?.result} !== PASS (must stay EVALUABLE/PASS under the content pin)`);
      }
    }
    if (legs.R3?.result !== "FAIL") {
      problems.push(`R3 ${legs.R3?.result} !== FAIL (native TIME finding expected)`);
    }
    if (legMatrix.overall !== "FAIL") {
      problems.push(`leg matrix overall ${legMatrix.overall} !== FAIL`);
    }
  }

  if (qualification.qualified !== false) {
    problems.push("an honest seed qualification stays false while the native TIME red is open");
  }
  const timeBlocker = (qualification.blockers ?? []).find((b) => b.id === "BLOCKER-O12-TIME-NATIVE");
  if (!timeBlocker) {
    problems.push("BLOCKER-O12-TIME-NATIVE is missing");
  } else {
    if (timeBlocker.classification !== "NATIVE") problems.push("O12 TIME blocker is not classified NATIVE");
    if (timeBlocker.igor_decision !== true) problems.push("O12 TIME blocker is not flagged for Igor");
  }

  const gate = qualification.gate_hashes ?? {};
  if (!Array.isArray(gate.drifted_files)) {
    problems.push("gate_hashes.drifted_files must be an array");
  } else if (gate.matches_prepared_campaign_descriptor !== (gate.drifted_files.length === 0)) {
    problems.push("gate_hashes matches/drifted_files disagree");
  }
  return { ok: problems.length === 0, problems };
}

// ── Thin CLI ─────────────────────────────────────────────────────────────
function usage() {
  return [
    "Usage: node torture-test/aged/refresh-readiness.mjs --seed-root <copy> [--qualification <file>]",
    "         [--pointer <file>] [--repo <dir>] [--campaign <dir>] [--published-at <iso>]",
    "",
    "Re-shapes the published seed qualification + the committed readiness pointer",
    "from a fresh aged re-validation of the retained seed snapshot copy.  Exit 0",
    "iff the refreshed pair validates against the US-012 acceptance contract.",
  ].join("\n");
}

function flag(argv, name, def = null) {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
}

export function runCli(argv, { repoRoot = REPO_ROOT } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const seedRoot = flag(argv, "--seed-root");
  if (!seedRoot) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const publishedPath = flag(argv, "--qualification", "/home/kaladin/matchlock-work/storm-seed-qualification.json");
  const pointerPath = flag(argv, "--pointer", path.join(repoRoot, "torture-test", "storm-seed-readiness.json"));
  const publishedAtUtc = flag(argv, "--published-at", new Date().toISOString());
  const existing = fs.existsSync(publishedPath) ? readJson(publishedPath) : {};
  const campaignDir = flag(argv, "--campaign", existing?.arming?.campaign_dir ?? null);

  const seedManifest = readJson(path.join(seedRoot, "manifest.json"));
  const report = readJson(path.join(seedRoot, "evidence", "seed-validation-report.json"));
  const classification = readJson(path.join(seedRoot, "evidence", "seed-validation-classification.json"));
  const censusReceiptFile = seedManifest?.snapshot?.censusReceipt?.file
    ?? path.join(seedRoot, "receipts", "census-full-post.json");
  const censusReceipt = fs.existsSync(censusReceiptFile) ? readJson(censusReceiptFile) : null;
  const descriptorFile = campaignDir ? path.join(campaignDir, "descriptor.json") : null;
  const descriptor = descriptorFile && fs.existsSync(descriptorFile) ? readJson(descriptorFile) : null;

  const source = resolvePinProvenanceSource(repoRoot);
  const gateHashes = computeGateHashes({ repoRoot });
  const repoHead = gitText(repoRoot, ["rev-parse", "HEAD"]);
  const qualification = buildRefreshedQualification({
    existing,
    refreshedBy: {
      run_id: process.env.TAMANDUA_RUN_ID ?? null,
      head: repoHead,
      at_utc: publishedAtUtc,
    },
    source,
    seedRoot,
    seedManifest,
    censusReceipt,
    report,
    classification,
    gateHashes,
    preparedCampaignDescriptor: descriptor?.gate_hashes ?? {},
    gateHashesSourceCommit: repoHead,
    publishedAtUtc,
    publishedPath,
    pointerPath,
  });
  const pointer = buildReadinessPointer({ qualification, qualificationPath: publishedPath, pointerPath });

  const dbIntegrityFile = findLatestDbIntegrity(seedRoot);
  const legMatrix = dbIntegrityFile ? extractLegMatrix(readJson(dbIntegrityFile)) : null;
  const validation = validateRefreshedReadiness({
    qualification,
    pointer,
    legMatrix,
    qualificationPath: publishedPath,
  });

  fs.mkdirSync(path.dirname(publishedPath), { recursive: true });
  fs.writeFileSync(publishedPath, `${JSON.stringify(qualification, null, 2)}\n`, "utf8");
  fs.writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");

  process.stdout.write(
    `${JSON.stringify(
      {
        qualification_path: publishedPath,
        pointer_path: pointerPath,
        seed_root: seedRoot,
        qualified: qualification.qualified,
        blockers: qualification.blockers.map((b) => b.id),
        o12_pin: qualification.pins?.o12_oracle?.content_sha256 ?? null,
        provenance_commit: qualification.pins?.o12_oracle?.provenance_commit ?? null,
        gate_hashes: {
          count: qualification.gate_hashes.count,
          matches_prepared_campaign_descriptor: qualification.gate_hashes.matches_prepared_campaign_descriptor,
          drifted_file_count: qualification.gate_hashes.drifted_files.length,
        },
        validation,
      },
      null,
      2,
    )}\n`,
  );
  return validation.ok ? 0 : 1;
}

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
  process.exitCode = runCli(process.argv.slice(2));
}
