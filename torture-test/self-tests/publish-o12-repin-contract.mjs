#!/usr/bin/env node

// publish-o12-repin-contract.mjs — I/O runner for the O12-REPIN acceptance
// contract (US-009).
//
// Resolves the retained artifacts produced by US-002..US-008, shapes them
// through the pure builders in `o12-repin-contract.mjs`, validates the result,
// and atomically writes `/home/kaladin/matchlock-work/o12-repin-contract.json`.
// It prints the published contract's machine-readable summary to stdout.
//
// The artifact values are read from the retained JSON files (never retyped):
//   - fixture matrix      : torture-test/var/results/o12-gate-self-tests-*/
//   - seed-snapshot matrix: torture-test/var/results/o12-seed-snapshot-*/
//   - self-tests-alone    : torture-test/var/results/pre-arm-gate-battery-*/
//   - storm chain         : torture-test/var/results/storm-chain-*/
//   - aged validation     : <readiness seed.root>/evidence/seed-validation-report.json
//   - readiness pointer   : torture-test/storm-seed-readiness.json
//   - qualification       : /home/kaladin/matchlock-work/storm-seed-qualification.json
//
// Exit codes: 0 = published + validated; 1 = usage error; 2 = contract invalid
// (nothing written). No product/oracle behavior is changed by this script.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_OUTPUT_PATH,
  PUBLISHED_QUALIFICATION_PATH,
  READINESS_POINTER_REL,
  assembleContract,
  buildEightCaseEvidence,
  buildFinalHead,
  buildFixturesSection,
  buildGatesSection,
  buildNewPin,
  buildSchema10Rules,
  buildSeedSnapshotMatrix,
  buildValidationSection,
  extractFailClosedMessage,
  normalizeRunId,
  parseAgedPinConstants,
  validateContract,
} from "./o12-repin-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const RESULTS_BASE = path.join(TT_ROOT, "var", "results");
const BASE_REF = "integration/o12-repin";

function parseArgs(argv) {
  const opts = {
    repo: REPO_ROOT,
    out: CONTRACT_OUTPUT_PATH,
    runId: process.env.TAMANDUA_RUN_ID ?? null,
    sinceEpochMs: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--repo") opts.repo = path.resolve(next());
    else if (arg === "--out") opts.out = path.resolve(next());
    else if (arg === "--run-id") opts.runId = next();
    else if (arg === "--since-epoch-ms") opts.sinceEpochMs = Number(next());
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) return null;
  return String(result.stdout ?? "").trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** List direct entry names of a directory, newest first by mtime. */
function newestFirst(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(dir, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { name: entry.name, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function findNewest(resultsBase, prefix, accept) {
  for (const entry of newestFirst(resultsBase)) {
    if (!entry.name.startsWith(prefix)) continue;
    const candidate = accept(entry.full);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Extract a `torture-test/var/results/<prefix>...` token from the pin's
 * acceptance detail, if present, and resolve it against the repo.
 */
function pinReferencedPath(detail, prefix, repo) {
  if (typeof detail !== "string") return null;
  const re = new RegExp(`torture-test/var/results/(${prefix}[A-Za-z0-9._-]+)`);
  const match = detail.match(re);
  if (!match) return null;
  const candidate = path.join(repo, "torture-test", "var", "results", match[1]);
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveFixtureMatrixDir(repo, pinDetail) {
  const fromPin = pinReferencedPath(pinDetail, "o12-gate-self-tests-", repo);
  if (fromPin && fs.existsSync(path.join(fromPin, "o12-fixture-matrix.json"))) return fromPin;
  return findNewest(path.join(repo, "torture-test", "var", "results"), "o12-gate-self-tests-", (dir) => {
    const matrixPath = path.join(dir, "o12-fixture-matrix.json");
    if (!fs.existsSync(matrixPath)) return null;
    const matrix = readJson(matrixPath);
    return matrix.all_match === true && matrix.all_correction_cases_green === true ? dir : null;
  });
}

function resolveSeedMatrixDir(repo, pinDetail) {
  const fromPin = pinReferencedPath(pinDetail, "o12-seed-snapshot-", repo);
  if (fromPin && fs.existsSync(path.join(fromPin, "seed-snapshot-matrix.json"))) return fromPin;
  return findNewest(path.join(repo, "torture-test", "var", "results"), "o12-seed-snapshot-", (dir) => {
    const matrixPath = path.join(dir, "seed-snapshot-matrix.json");
    if (!fs.existsSync(matrixPath)) return null;
    const matrix = readJson(matrixPath);
    return matrix.verdict === "EXPECTED_MATRIX" ? dir : null;
  });
}

function resolveBatterySummary(repo) {
  return findNewest(path.join(repo, "torture-test", "var", "results"), "pre-arm-gate-battery-", (dir) => {
    const summaryPath = path.join(dir, "pre-arm-gate-battery-summary.json");
    if (!fs.existsSync(summaryPath)) return null;
    const summary = readJson(summaryPath);
    return summary.scope === "all" && summary.verdict === "PASS" ? { dir, summaryPath, summary } : null;
  });
}

function resolveChainSummary(repo) {
  return findNewest(path.join(repo, "torture-test", "var", "results"), "storm-chain-", (dir) => {
    const summaryPath = path.join(dir, "chain-summary.json");
    if (!fs.existsSync(summaryPath)) return null;
    const summary = readJson(summaryPath);
    return summary.verdict === "PASS" && summary.file_count_observed === 49
      ? { dir, summaryPath, summary }
      : null;
  });
}

function resolveValidationReport(repo, readiness) {
  const seedRoot = readiness?.seed?.root;
  if (typeof seedRoot === "string" && seedRoot.length > 0) {
    const candidate = path.join(seedRoot, "evidence", "seed-validation-report.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  return findNewest(path.join(repo, "torture-test", "var", "results"), "o12-repin-seed-root-", (dir) => {
    const candidate = path.join(dir, "evidence", "seed-validation-report.json");
    return fs.existsSync(candidate) ? candidate : null;
  });
}

/** Top-level approval-file scan (bounded; never recursive into worktrees). */
function scanApprovalFiles(root, sinceEpochMs) {
  const changed = [];
  if (!fs.existsSync(root)) return changed;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return changed;
  }
  for (const entry of entries) {
    if (!/approval/i.test(entry.name)) continue;
    const full = path.join(root, entry.name);
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (sinceEpochMs === null || stat.mtimeMs >= sinceEpochMs) changed.push(full);
  }
  return changed;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write("usage: publish-o12-repin-contract.mjs [--repo DIR] [--out FILE] [--run-id ID]\n");
    return 0;
  }
  const repo = opts.repo;

  // ── source-of-truth pins / schema descriptors ─────────────────────────
  const validateSource = fs.readFileSync(path.join(repo, "torture-test", "aged", "validate.mjs"), "utf8");
  const pin = parseAgedPinConstants(validateSource);
  const o12Source = fs.readFileSync(path.join(repo, "torture-test", "oracles", "lib", "o12.mjs"), "utf8");
  const o12 = await import(new URL("../oracles/lib/o12.mjs", import.meta.url).href);
  const schema10Rules = buildSchema10Rules({
    supportedVersions: o12.O12_SUPPORTED_SCHEMA_VERSIONS,
    descriptors: o12.O12_SCHEMA_DESCRIPTORS,
    failClosedMessage: extractFailClosedMessage(o12Source),
  });

  // ── retained evidence artifacts ───────────────────────────────────────
  const fixtureDir = resolveFixtureMatrixDir(repo, pin.acceptance_detail);
  if (!fixtureDir) throw new Error("no valid retained O12 fixture matrix found");
  const fixtureMatrixPath = path.join(fixtureDir, "o12-fixture-matrix.json");
  const fixtureMatrix = readJson(fixtureMatrixPath);

  const seedDir = resolveSeedMatrixDir(repo, pin.acceptance_detail);
  if (!seedDir) throw new Error("no valid retained seed-snapshot matrix found");
  const seedMatrixPath = path.join(seedDir, "seed-snapshot-matrix.json");
  const seedMatrix = readJson(seedMatrixPath);

  const battery = resolveBatterySummary(repo);
  if (!battery) throw new Error("no green full-scope pre-arm gate battery summary found");
  const chain = resolveChainSummary(repo);
  if (!chain) throw new Error("no green 49-file storm chain summary found");

  const readinessPointerPath = path.join(repo, READINESS_POINTER_REL);
  const readiness = readJson(readinessPointerPath);
  const reportPath = resolveValidationReport(repo, readiness);
  if (!reportPath) throw new Error("no fresh aged validation report found");
  const report = readJson(reportPath);
  const qualification = fs.existsSync(PUBLISHED_QUALIFICATION_PATH)
    ? readJson(PUBLISHED_QUALIFICATION_PATH)
    : null;

  // The new_pin section is shaped from the AGED REPORT's own `o12_pin` block —
  // the artifact produced by the validator that ran the oracle over the seed
  // snapshot — never from hand-typed values.  The parsed source constants are
  // used only to cross-check that the report and the current validator agree;
  // a mismatch fails closed before anything is published.
  const reportPin = report?.o12_pin;
  if (!reportPin || typeof reportPin !== "object" || Array.isArray(reportPin)) {
    throw new Error(`aged validation report ${reportPath} has no o12_pin block`);
  }
  for (const field of ["content_sha256", "provenance_commit", "provenance_subject"]) {
    if (typeof reportPin[field] !== "string" || reportPin[field].length === 0) {
      throw new Error(`aged validation report o12_pin.${field} is missing`);
    }
    if (pin[field] !== reportPin[field]) {
      throw new Error(
        `aged validation report o12_pin.${field} ${JSON.stringify(reportPin[field])} !== validator source constant ${JSON.stringify(pin[field])}`,
      );
    }
  }

  // ── git head / clean-tree / no-src / no-approval confirmations ────────
  const commit = git(repo, ["rev-parse", "HEAD"]);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const subject = git(repo, ["log", "-1", "--format=%s", "HEAD"]);
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = git(repo, ["status", "--porcelain"]) ?? "";
  const worktreeClean = porcelain.length === 0;
  const baseRefExists = git(repo, ["rev-parse", "--verify", "--quiet", BASE_REF]) !== null;
  const srcCommittedDiff = baseRefExists
    ? (git(repo, ["diff", "--name-only", `${BASE_REF}...HEAD`, "--", "src/"]) ?? "")
    : "";
  const srcWorkingDiff = git(repo, ["status", "--porcelain", "--", "src/"]) ?? "";
  const srcModified = srcCommittedDiff.length > 0 || srcWorkingDiff.length > 0;

  let sinceEpochMs = opts.sinceEpochMs;
  if (sinceEpochMs === null && baseRefExists) {
    const firstCommitEpoch = git(repo, ["log", "--reverse", "--format=%ct", `${BASE_REF}..HEAD`]);
    if (firstCommitEpoch) {
      const first = firstCommitEpoch.split("\n").find((line) => line.trim().length > 0);
      if (first) sinceEpochMs = Number(first) * 1000;
    }
  }
  const repoApprovalMatches = porcelain
    .split("\n")
    .filter((line) => /approval/i.test(line))
    .map((line) => line.trim());
  const hostApprovalMatches = scanApprovalFiles("/home/kaladin/matchlock-work", sinceEpochMs);
  const approvalFilesChanged = [...repoApprovalMatches, ...hostApprovalMatches];

  const finalHead = buildFinalHead({
    commit,
    tree,
    subject,
    branch,
    worktreeClean,
    srcModified,
    approvalFilesChanged,
    baseRef: baseRefExists ? BASE_REF : null,
  });

  const acceptanceEvidence = [
    { kind: "o12-fixture-matrix", path: fixtureMatrixPath },
    { kind: "o12-gate-self-tests-summary", path: path.join(fixtureDir, "o12-gate-self-tests-summary.json") },
    { kind: "seed-snapshot-matrix", path: seedMatrixPath },
    { kind: "pre-arm-gate-battery-summary", path: battery.summaryPath },
    { kind: "storm-chain-summary", path: chain.summaryPath },
    { kind: "aged-validation-report", path: reportPath },
    { kind: "readiness-pointer", path: readinessPointerPath },
    { kind: "published-qualification", path: PUBLISHED_QUALIFICATION_PATH },
  ];

  const contract = assembleContract({
    generated_at_utc: new Date().toISOString(),
    run_id: normalizeRunId(opts.runId),
    branch,
    schema10_rules: schema10Rules,
    fixtures: buildFixturesSection(fixtureMatrix, fixtureMatrixPath),
    eight_case_evidence: buildEightCaseEvidence(fixtureMatrix),
    seed_snapshot_matrix: buildSeedSnapshotMatrix(seedMatrix, seedMatrixPath),
    new_pin: buildNewPin({
      pin: {
        content_sha256: reportPin.content_sha256,
        provenance_commit: reportPin.provenance_commit,
        provenance_subject: reportPin.provenance_subject,
        acceptance: reportPin.acceptance,
        acceptance_detail: reportPin.acceptance_detail,
        prior: pin.prior,
      },
      acceptanceEvidence,
    }),
    gates: buildGatesSection({
      batterySummary: battery.summary,
      batteryRetainedPath: battery.summaryPath,
      chainSummary: chain.summary,
      chainRetainedPath: chain.summaryPath,
    }),
    validation: buildValidationSection({
      report,
      reportPath,
      readiness,
      readinessPointerPath,
      qualification,
      qualificationPath: PUBLISHED_QUALIFICATION_PATH,
    }),
    final_head: finalHead,
  });

  const validation = validateContract(contract);
  if (!validation.ok) {
    process.stderr.write(`contract validation failed:\n- ${validation.problems.join("\n- ")}\n`);
    return 2;
  }

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const tmp = `${opts.out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(contract, null, 2)}\n`);
  fs.renameSync(tmp, opts.out);

  const summary = {
    kind: contract.kind,
    schema_version: contract.schema_version,
    published_path: opts.out,
    generated_at_utc: contract.generated_at_utc,
    run_id: contract.run_id,
    branch: contract.branch,
    supported_user_versions: contract.schema10_rules.supported_user_versions,
    fixture_count: contract.fixtures.fixture_count,
    eight_case_evidence_count: contract.eight_case_evidence.length,
    eight_case_all_green: contract.eight_case_evidence.every((entry) => entry.match && entry.expected === entry.observed),
    seed_snapshot_legs: {
      R1: contract.seed_snapshot_matrix.legs?.R1?.result,
      R2: contract.seed_snapshot_matrix.legs?.R2?.result,
      R3: contract.seed_snapshot_matrix.legs?.R3?.result,
      R4: contract.seed_snapshot_matrix.legs?.R4?.result,
      R5: contract.seed_snapshot_matrix.legs?.R5?.result,
      R6: contract.seed_snapshot_matrix.overall_result,
    },
    new_pin: {
      content_sha256: contract.new_pin.content_sha256,
      provenance_commit: contract.new_pin.provenance_commit,
      provenance_subject: contract.new_pin.provenance_subject,
      acceptance: contract.new_pin.acceptance,
    },
    gates: {
      lock_path: contract.gates.lock_path,
      self_tests_alone_verdict: contract.gates.aged_o12_storm_self_tests_alone.verdict,
      storm_chain_verdict: contract.gates.storm_chain_49.verdict,
      storm_chain_files: contract.gates.storm_chain_49.file_count_observed,
      lock_submit_iso: contract.gates.storm_chain_49.lock?.submit_iso,
      lock_acquire_iso: contract.gates.storm_chain_49.lock?.acquire_iso,
      lock_release_iso: contract.gates.storm_chain_49.lock?.release_iso,
    },
    final_head: {
      commit: contract.final_head.commit,
      tree: contract.final_head.tree,
      worktree_clean: contract.final_head.worktree_clean,
      src_modified: contract.final_head.src_modified,
      approval_files_created_or_modified: contract.final_head.approval_files_created_or_modified,
    },
    validation_ok: validation.ok,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`publish-o12-repin-contract failed: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
