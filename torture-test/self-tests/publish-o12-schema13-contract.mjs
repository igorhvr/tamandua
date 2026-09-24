#!/usr/bin/env node

// publish-o12-schema13-contract.mjs — I/O runner for the O12-SCHEMA-13
// acceptance contract.
//
// Reads only COMMITTED artifacts, derives every load-bearing value from them,
// shapes the contract through the pure builders in `o12-schema13-contract.mjs`,
// validates it and writes it atomically to the tracked path
// `torture-test/impl-tasks/o12-schema13-contract.json` (overridable with
// `--out`).  It never hand-types a pin hash, an exit code, a fixture count or a
// gate command.
//
// Committed sources read:
//   - torture-test/impl-tasks/o12-schema13-gate-evidence.json  (gate evidence)
//   - torture-test/oracles/lib/o12.mjs                         (schema descriptors)
//   - torture-test/aged/validate.mjs                           (pin constants)
//   - torture-test/oracles/self-test/generate-o12-fixtures.mjs (fixture case ids)
//
// Exit codes: 0 = published + validated; 1 = usage/IO error; 2 = contract
// invalid (nothing written).  It never touches the oracle, the product or the
// real state.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_OUTPUT_REL,
  EXPECTED_GATE_COUNTS,
  FIXTURE_GENERATOR_REL,
  GATE_EVIDENCE_REL,
  ORACLE_LIB_REL,
  PIN_SOURCE_REL,
  REQUIRED_RED_ARMS,
  SUPPORTED_USER_VERSIONS,
  assembleContract,
  buildFinalHead,
  buildFixtures,
  buildGates,
  buildLineageHandling,
  buildMatchlockPolicy,
  buildPerVersionExpectations,
  buildRepin,
  buildValidation,
  extractFailClosedMessage,
  extractFindingName,
  extractFixtureCaseIds,
  extractV12NeitherLineageMessage,
  normalizeRunId,
  parsePinConstants,
  validateContract,
} from "./o12-schema13-contract.mjs";
import { validateO12Schema13GateEvidence } from "./o12-schema13-gate-evidence.mjs";
import {
  O12_MATCHLOCK_POLICY_BACKEND,
  O12_MATCHLOCK_POLICY_CREDENTIAL_KEY_FRAGMENTS,
  O12_MATCHLOCK_POLICY_DSH_HOME_SOURCES,
  O12_MATCHLOCK_POLICY_HARNESS_KEYS,
  O12_MATCHLOCK_POLICY_HARNESSES,
  O12_MATCHLOCK_POLICY_HERMES_BLOCK_KEYS,
  O12_MATCHLOCK_POLICY_OPTIONAL_KEYS,
  O12_MATCHLOCK_POLICY_REQUIRED_KEYS,
  O12_MATCHLOCK_POLICY_VERSION,
  O12_SCHEMA_DESCRIPTORS,
  O12_SUPPORTED_SCHEMA_VERSIONS,
} from "../oracles/lib/o12.mjs";
import {
  O12_ORACLE_CONTENT_PATHS,
  O12_PINNED_ACCEPTANCE,
  O12_PINNED_ACCEPTANCE_DETAIL,
  O12_PINNED_CONTENT_SHA256,
  O12_PINNED_PROVENANCE_COMMIT,
  O12_PINNED_PROVENANCE_SUBJECT,
  computeO12OracleContentHash,
} from "../aged/validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const BASE_REF = "integration/o12-repin";

/** The O12 finding id an invalid runs.matchlock_policy value raises. */
const INVALID_POLICY_FINDING = "O12_SCHEMA_MATCHLOCK_POLICY_INVALID";

function parseArgs(argv) {
  const opts = {
    repo: REPO_ROOT,
    out: path.join(REPO_ROOT, CONTRACT_OUTPUT_REL),
    runId: process.env.TAMANDUA_RUN_ID ?? null,
    gateEvidence: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "--repo") opts.repo = path.resolve(next());
    else if (arg === "--out") opts.out = path.resolve(next());
    else if (arg === "--run-id") opts.runId = next();
    else if (arg === "--gate-evidence") opts.gateEvidence = path.resolve(next());
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

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(file) {
  return JSON.parse(readText(file));
}

/**
 * The swept-consumer list: tracked files that reference one of the pin
 * constants (or the pinned content hash literal).  Derived by scanning the
 * tree with `git grep`, never hand-typed.
 */
function scanPinConsumers(repo) {
  const patterns = [
    "O12_PINNED_CONTENT_SHA256",
    "O12_PINNED_PROVENANCE_COMMIT",
    "O12_PINNED_PROVENANCE_SUBJECT",
    "O12_PINNED_ACCEPTANCE",
    O12_PINNED_CONTENT_SHA256,
  ];
  const args = ["grep", "-l", "-F"];
  for (const pattern of patterns) args.push("-e", pattern);
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) return [];
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

/** Remove a tracked-file status line for `rel` (the artifact we publish). */
function withoutPath(porcelain, rel) {
  if (!rel) return porcelain;
  return porcelain
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => {
      const file = line.slice(3);
      return file !== rel;
    })
    .join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "usage: publish-o12-schema13-contract.mjs [--repo DIR] [--out FILE] [--run-id ID] [--gate-evidence FILE]\n",
    );
    return 0;
  }
  const repo = opts.repo;

  // ── committed sources: descriptors, pin, fixtures ─────────────────────
  const o12Source = readText(path.join(repo, ORACLE_LIB_REL));
  const validateSource = readText(path.join(repo, PIN_SOURCE_REL));
  const generatorSource = readText(path.join(repo, FIXTURE_GENERATOR_REL));

  const parsedPin = parsePinConstants(validateSource);
  for (const field of ["content_sha256", "provenance_commit", "provenance_subject", "acceptance", "acceptance_detail"]) {
    const imported = {
      content_sha256: O12_PINNED_CONTENT_SHA256,
      provenance_commit: O12_PINNED_PROVENANCE_COMMIT,
      provenance_subject: O12_PINNED_PROVENANCE_SUBJECT,
      acceptance: O12_PINNED_ACCEPTANCE,
      acceptance_detail: O12_PINNED_ACCEPTANCE_DETAIL,
    }[field];
    if (imported !== parsedPin[field]) {
      throw new Error(`pin constant ${field} drifted between the import and the source parse`);
    }
  }

  const supportedVersions = [...O12_SUPPORTED_SCHEMA_VERSIONS];
  if (JSON.stringify(supportedVersions) !== JSON.stringify([...SUPPORTED_USER_VERSIONS])) {
    throw new Error(
      `the oracle supported set ${JSON.stringify(supportedVersions)} no longer matches the contract's pinned member set`,
    );
  }

  // ── committed gate-evidence record ────────────────────────────────────
  const gateEvidencePath = opts.gateEvidence ?? path.join(repo, GATE_EVIDENCE_REL);
  const gateEvidence = readJson(gateEvidencePath);
  const gateEvidenceValidation = validateO12Schema13GateEvidence(gateEvidence);
  if (!gateEvidenceValidation.ok) {
    throw new Error(
      `committed gate evidence is invalid:\n- ${gateEvidenceValidation.problems.join("\n- ")}`,
    );
  }

  const fixtureMatrix = gateEvidence.o12_gate?.fixture_matrix ?? null;
  const fixtureCaseIds = extractFixtureCaseIds(generatorSource);

  // ── content pin recomputation ─────────────────────────────────────────
  const contentPinRecomputed = computeO12OracleContentHash({ repoRoot: repo });

  // ── derived shapes ────────────────────────────────────────────────────
  const perVersionExpectations = buildPerVersionExpectations({
    descriptors: O12_SCHEMA_DESCRIPTORS,
    supportedVersions,
  });
  const lineageHandling = buildLineageHandling({
    descriptors: O12_SCHEMA_DESCRIPTORS,
    supportedVersions,
    failClosedMessage: extractFailClosedMessage(o12Source),
    neitherLineageMessage: extractV12NeitherLineageMessage(o12Source),
  });
  const matchlockPolicy = buildMatchlockPolicy({
    policy: {
      policyVersion: O12_MATCHLOCK_POLICY_VERSION,
      backend: O12_MATCHLOCK_POLICY_BACKEND,
      harnesses: O12_MATCHLOCK_POLICY_HARNESSES,
      requiredKeys: O12_MATCHLOCK_POLICY_REQUIRED_KEYS,
      optionalKeys: O12_MATCHLOCK_POLICY_OPTIONAL_KEYS,
      harnessKeys: O12_MATCHLOCK_POLICY_HARNESS_KEYS,
      hermesBlockKeys: O12_MATCHLOCK_POLICY_HERMES_BLOCK_KEYS,
      dshHomeSources: O12_MATCHLOCK_POLICY_DSH_HOME_SOURCES,
      credentialKeyFragments: O12_MATCHLOCK_POLICY_CREDENTIAL_KEY_FRAGMENTS,
    },
    findingName: extractFindingName(o12Source, INVALID_POLICY_FINDING),
  });
  const fixtures = buildFixtures({
    fixtureCaseIds,
    fixtureMatrix,
    sourcePath: gateEvidence.o12_gate?.fixture_matrix?.path ?? gateEvidencePath,
  });
  const repin = buildRepin({
    pin: {
      content_sha256: O12_PINNED_CONTENT_SHA256,
      provenance_commit: O12_PINNED_PROVENANCE_COMMIT,
      provenance_subject: O12_PINNED_PROVENANCE_SUBJECT,
      acceptance: O12_PINNED_ACCEPTANCE,
      acceptance_detail: O12_PINNED_ACCEPTANCE_DETAIL,
    },
    contentPaths: [...O12_ORACLE_CONTENT_PATHS],
    sweptConsumers: scanPinConsumers(repo),
  });
  const gates = buildGates({ gateEvidence, sourcePath: gateEvidencePath });

  // ── git facts (final head + scope) ────────────────────────────────────
  const outRel = path.relative(repo, opts.out).split(path.sep).join("/");
  const outInsideRepo = outRel.length > 0 && !outRel.startsWith("..");
  const commit = git(repo, ["rev-parse", "HEAD"]);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const subject = git(repo, ["log", "-1", "--format=%s", "HEAD"]);
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseRefExists = git(repo, ["rev-parse", "--verify", "--quiet", BASE_REF]) !== null;
  const srcCommitted = baseRefExists
    ? (git(repo, ["diff", "--name-only", `${BASE_REF}...HEAD`, "--", "src/"]) ?? "")
    : "";
  const srcWorking = git(repo, ["status", "--porcelain", "--", "src/"]) ?? "";
  const srcPathsTouched = [...new Set(
    [...srcCommitted.split("\n"), ...srcWorking.split("\n").map((line) => line.slice(3))]
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  )].sort();
  const srcModified = srcPathsTouched.length > 0;

  let porcelain = git(repo, ["status", "--porcelain", "--untracked-files=no"]) ?? "";
  porcelain = withoutPath(porcelain, outInsideRepo ? outRel : null);
  const worktreeClean = porcelain.trim().length === 0;

  const finalHead = buildFinalHead({
    commit,
    tree,
    subject,
    branch,
    worktreeClean,
    srcModified,
    baseRef: baseRefExists ? BASE_REF : null,
    untrackedFilesIgnored: true,
  });

  const validation = buildValidation({
    gateEvidenceValidation,
    fixtureMatrix,
    contentPinRecomputed,
    pin: { content_sha256: O12_PINNED_CONTENT_SHA256 },
    vmSubstitutions: gates.substitutions,
    redArms: [...REQUIRED_RED_ARMS],
    tortureOnly: true,
    sourcePathsTouched: srcPathsTouched,
  });

  const contract = assembleContract({
    generated_at_utc: new Date().toISOString(),
    run_id: normalizeRunId(opts.runId),
    branch,
    per_version_expectations: perVersionExpectations,
    lineage_handling: lineageHandling,
    matchlock_policy: matchlockPolicy,
    fixtures,
    repin,
    gates,
    validation,
    final_head: finalHead,
  });

  const contractValidation = validateContract(contract);
  if (!contractValidation.ok) {
    process.stderr.write(`contract validation failed:\n- ${contractValidation.problems.join("\n- ")}\n`);
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
    supported_user_versions: contract.per_version_expectations.supported_user_versions,
    shapes: contract.per_version_expectations.entries.map((entry) => entry.shape),
    fixture_count: contract.fixtures.fixture_count,
    fixture_case_count: contract.fixtures.fixture_case_ids.length,
    matchlock_policy_finding: contract.matchlock_policy.invalid_policy.finding,
    repin: {
      content_sha256: contract.repin.content_sha256,
      provenance_commit: contract.repin.provenance_commit,
      swept_consumer_count: contract.repin.swept_consumer_count,
    },
    gates: {
      expected_counts: contract.gates.expected_counts,
      expected_required_total: contract.gates.expected_required_total,
      self_tests_alone_verdict: contract.gates.self_tests_alone.verdict,
      o12_gate_overall_verdict: contract.gates.o12_gate.overall_verdict,
      substitutions: contract.gates.substitutions.length,
    },
    validation: {
      gate_evidence_validated: contract.validation.gate_evidence_validated,
      content_pin_valid: contract.validation.content_pin_valid,
      torture_only: contract.validation.torture_only,
      source_paths_touched: contract.validation.source_paths_touched,
    },
    final_head: {
      commit: contract.final_head.commit,
      tree: contract.final_head.tree,
      worktree_clean: contract.final_head.worktree_clean,
      src_modified: contract.final_head.src_modified,
    },
    validation_ok: contractValidation.ok,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`publish-o12-schema13-contract failed: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
