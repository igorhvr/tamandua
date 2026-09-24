#!/usr/bin/env node

// publish-npf2-fixture-contract.mjs — I/O runner for the NPF-2 fixture contract
// (US-013).
//
// Resolves the retained artifacts produced by US-003/US-004 (the NPF-2
// self-tests and their contained-run diagnostics), US-010 (self-tests alone),
// US-011 (the flocked 49-file storm chain) and US-012 (the aged re-validation
// of the content-addressed O12 pin), shapes them through the pure builders in
// `npf2-fixture-contract.mjs`, validates the result, and atomically writes
// `/home/kaladin/matchlock-work/npf2-fixture-contract.json`.  It prints the
// published contract's machine-readable summary to stdout.
//
// The artifact values are read from the retained JSON/log files (never
// retyped):
//   - self-tests alone    : <results-base>/self-tests-alone-*/self-tests-alone-summary.json
//   - NPF-2 positive/neg  : the diagnostics dir named in each npf2 entry's stdout log
//   - storm chain         : <results-base>/storm-chain-*/chain-summary.json
//   - aged validation     : <readiness.seed.root>/evidence/seed-validation-report.json
//   - readiness pointer   : <repo>/torture-test/storm-seed-readiness.json
//   - qualification       : /home/kaladin/matchlock-work/storm-seed-qualification.json
//
// Exit codes: 0 = published + validated; 1 = usage/IO error; 2 = contract
// invalid (nothing written).  No product/oracle behavior is changed here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_OUTPUT_PATH,
  EVIDENCE_COMMAND_CONSTANT,
  EVIDENCE_SOURCE_REL,
  PIN_SOURCE_REL,
  PUBLISHED_QUALIFICATION_PATH,
  READINESS_POINTER_REL,
  assembleContract,
  buildDesignSection,
  buildEvidenceHalf,
  buildEvidenceSection,
  buildFinalSquash,
  buildGatesSection,
  buildNewPin,
  classifyRetainedPin,
  normalizeRunId,
  parseAgedPinConstants,
  parseContentPaths,
  parseObservedFieldsFromStdout,
  parseRetainedDirFromStdout,
  parseSingleQuotedConstant,
  validateContract,
} from "./npf2-fixture-contract.mjs";
import { validateSelfTestsAloneSummary } from "./self-tests-alone-report.mjs";
import { validateChainSummary } from "./storm-chain-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");

function parseArgs(argv) {
  const opts = {
    repo: REPO_ROOT,
    resultsBase: null,
    readiness: null,
    qualification: PUBLISHED_QUALIFICATION_PATH,
    out: CONTRACT_OUTPUT_PATH,
    runId: process.env.TAMANDUA_RUN_ID ?? null,
    branch: null,
    selfTestsAlone: null,
    stormChain: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--repo") opts.repo = path.resolve(next());
    else if (arg === "--results-base") opts.resultsBase = path.resolve(next());
    else if (arg === "--readiness") opts.readiness = path.resolve(next());
    else if (arg === "--qualification") opts.qualification = path.resolve(next());
    else if (arg === "--out") opts.out = path.resolve(next());
    else if (arg === "--run-id") opts.runId = next();
    else if (arg === "--branch") opts.branch = next();
    else if (arg === "--self-tests-alone") opts.selfTestsAlone = path.resolve(next());
    else if (arg === "--storm-chain") opts.stormChain = path.resolve(next());
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.resultsBase) opts.resultsBase = path.join(opts.repo, "torture-test", "var", "results");
  if (!opts.readiness) opts.readiness = path.join(opts.repo, READINESS_POINTER_REL);
  return opts;
}

const HELP = `usage: publish-npf2-fixture-contract.mjs [options]

  --repo DIR            repository to read source/readiness from (default: this checkout)
  --results-base DIR    torture-test/var/results holding the retained gate artifacts
  --readiness FILE      committed storm-seed-readiness pointer
  --qualification FILE  published storm-seed-qualification.json
  --out FILE            contract output path (default ${CONTRACT_OUTPUT_PATH})
  --run-id ID           publishing run id (default $TAMANDUA_RUN_ID)
  --branch NAME         publishing branch (default: readiness pointer branch)
  --self-tests-alone D  explicit self-tests-alone results dir (bypasses newest-first search)
  --storm-chain D       explicit storm-chain results dir (bypasses newest-first search)
`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Children of `dir` as `{name, full, mtime}`, newest mtime first. */
function listChildrenNewestFirst(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    // Evidence locators on this host are SYMLINKS into an owned external var
    // root (the run worktree lives under the real-state prefix, so private
    // state must live outside it).  A symlinked evidence directory is a real
    // evidence directory: include it, and statSync (which follows the link)
    // supplies the mtime.  The `accept` predicate still verifies the expected
    // files inside, so a non-directory symlink is skipped safely.
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
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

/** Newest `<prefix>*` child whose `accept(full)` is truthy, or null. */
function findNewestValid(dir, prefix, accept) {
  for (const entry of listChildrenNewestFirst(dir)) {
    if (!entry.name.startsWith(prefix)) continue;
    try {
      const found = accept(entry.full);
      if (found) return found;
    } catch {
      // A corrupt/partial artifact never wins the newest-valid search.
    }
  }
  return null;
}

function resolveSelfTestsAlone(opts) {
  if (opts.selfTestsAlone) {
    const dir = fs.statSync(opts.selfTestsAlone).isDirectory()
      ? opts.selfTestsAlone
      : path.dirname(opts.selfTestsAlone);
    const summaryPath = path.join(dir, "self-tests-alone-summary.json");
    if (!fs.existsSync(summaryPath)) throw new Error(`no self-tests-alone-summary.json in ${dir}`);
    const summary = readJson(summaryPath);
    const validation = validateSelfTestsAloneSummary(summary);
    if (!validation.ok) throw new Error(`self-tests-alone summary rejected:\n- ${validation.problems.join("\n- ")}`);
    return { dir, summaryPath, summary };
  }
  return findNewestValid(opts.resultsBase, "self-tests-alone-", (dir) => {
    const summaryPath = path.join(dir, "self-tests-alone-summary.json");
    if (!fs.existsSync(summaryPath)) return null;
    const summary = readJson(summaryPath);
    const validation = validateSelfTestsAloneSummary(summary);
    return validation.ok ? { dir, summaryPath, summary } : null;
  });
}

function resolveStormChain(opts) {
  if (opts.stormChain) {
    const dir = fs.statSync(opts.stormChain).isDirectory()
      ? opts.stormChain
      : path.dirname(opts.stormChain);
    const summaryPath = path.join(dir, "chain-summary.json");
    if (!fs.existsSync(summaryPath)) throw new Error(`no chain-summary.json in ${dir}`);
    const summary = readJson(summaryPath);
    const validation = validateChainSummary(summary);
    if (!validation.ok) throw new Error(`storm-chain summary rejected:\n- ${validation.problems.join("\n- ")}`);
    return { dir, summaryPath, summary };
  }
  return findNewestValid(opts.resultsBase, "storm-chain-", (dir) => {
    const summaryPath = path.join(dir, "chain-summary.json");
    if (!fs.existsSync(summaryPath)) return null;
    const summary = readJson(summaryPath);
    const validation = validateChainSummary(summary);
    return validation.ok ? { dir, summaryPath, summary } : null;
  });
}

/** Read the single `<bare>.events.jsonl` stream retained for a contained run. */
function readRetainedEvents(retainedDir, bareRunId) {
  const files = fs.readdirSync(retainedDir).filter((name) => name.endsWith(".events.jsonl"));
  const file = files.find((name) => name.startsWith(String(bareRunId))) ?? files[0];
  if (!file) return { events: [], events_path: null };
  const eventsPath = path.join(retainedDir, file);
  const events = fs
    .readFileSync(eventsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  return { events, events_path: eventsPath };
}

/**
 * Resolve one NPF-2 half: the self-tests-alone entry, the diagnostics dir its
 * stdout log names, the contained-run summary and the product event stream.
 */
function resolveEvidenceHalf(selfTestsAlone, half) {
  const entry = (selfTestsAlone.summary.entries ?? []).find(
    (candidate) => candidate.group === "npf2" && candidate.half === half,
  );
  if (!entry) throw new Error(`self-tests-alone summary has no npf2 ${half} entry`);
  if (entry.exit_code !== 0 || entry.pass !== true) {
    throw new Error(`npf2 ${half} self-test is not green (exit ${entry.exit_code})`);
  }
  if (!entry.stdout_log || !fs.existsSync(entry.stdout_log)) {
    throw new Error(`npf2 ${half} stdout log missing: ${entry.stdout_log}`);
  }
  const stdout = fs.readFileSync(entry.stdout_log, "utf8");
  const retainedDir = parseRetainedDirFromStdout(stdout);
  if (!retainedDir) throw new Error(`npf2 ${half} stdout log does not name a retained diagnostics dir`);
  if (!fs.existsSync(retainedDir)) throw new Error(`npf2 ${half} retained diagnostics dir missing: ${retainedDir}`);
  const summaryPath = path.join(retainedDir, "summary.json");
  if (!fs.existsSync(summaryPath)) throw new Error(`npf2 ${half} retained summary.json missing: ${summaryPath}`);
  const runSummary = readJson(summaryPath);
  const { line: observedLine, fields } = parseObservedFieldsFromStdout(stdout);
  if (observedLine && fields.run) {
    const observedBare = normalizeRunId(fields.run)?.replace(/^run-/, "");
    if (observedBare && observedBare !== runSummary.run) {
      throw new Error(
        `npf2 ${half} observed run ${observedBare} disagrees with retained summary run ${runSummary.run}`,
      );
    }
  }
  const { events, events_path: eventsPath } = readRetainedEvents(retainedDir, runSummary.run);
  return buildEvidenceHalf({
    half,
    selfTestEntry: entry,
    observedLine,
    retainedDir,
    runSummary,
    events,
  });
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const repo = opts.repo;

  // ── source-of-truth design facts (parsed, never retyped) ──────────────
  const rehearsalSource = fs.readFileSync(path.join(repo, EVIDENCE_SOURCE_REL), "utf8");
  const evidenceCommand = parseSingleQuotedConstant(rehearsalSource, EVIDENCE_COMMAND_CONSTANT);
  if (!evidenceCommand) throw new Error(`could not parse ${EVIDENCE_COMMAND_CONSTANT} from ${EVIDENCE_SOURCE_REL}`);

  const validateSource = fs.readFileSync(path.join(repo, PIN_SOURCE_REL), "utf8");
  const contentPaths = parseContentPaths(validateSource);
  if (contentPaths.length === 0) throw new Error(`could not parse O12_ORACLE_CONTENT_PATHS from ${PIN_SOURCE_REL}`);
  const pin = parseAgedPinConstants(validateSource);

  const design = buildDesignSection({
    evidenceCommand,
    evidenceSourceRel: EVIDENCE_SOURCE_REL,
    contentPaths,
    contentPathsSourceRel: PIN_SOURCE_REL,
    scheme:
      "SHA-256 over the documented O12 content set in sorted relative-path order: for each path feed "
      + "'<rel>\\0<byteLength>\\0' then the file's exact bytes into one hash, so a rename, truncation or "
      + "byte edit changes the pin",
  });

  // ── NPF-2 evidence (positive first-attempt landing + negative refusal) ─
  const selfTestsAlone = resolveSelfTestsAlone(opts);
  if (!selfTestsAlone) throw new Error("no valid retained self-tests-alone summary found");
  const positive = resolveEvidenceHalf(selfTestsAlone, "positive");
  const negative = resolveEvidenceHalf(selfTestsAlone, "negative");
  const evidence = buildEvidenceSection({ positive, negative });

  // ── aged validation report / readiness pointer / qualification ────────
  const readiness = readJson(opts.readiness);
  const seedRoot = readiness?.seed?.root;
  if (typeof seedRoot !== "string" || seedRoot.length === 0) {
    throw new Error(`readiness pointer ${opts.readiness} has no seed.root`);
  }
  const reportPath = path.join(seedRoot, "evidence", "seed-validation-report.json");
  if (!fs.existsSync(reportPath)) throw new Error(`aged validation report missing: ${reportPath}`);
  const report = readJson(reportPath);
  const reportPin = report?.o12_pin;
  if (!reportPin || typeof reportPin !== "object" || Array.isArray(reportPin)) {
    throw new Error(`aged validation report ${reportPath} has no o12_pin block`);
  }
  // Cross-check the report against the validator's own constants (fail closed).
  // TORTURE-PORT US-006: a report under the DECLARED pre-port content pin is a
  // legacy artifact (the schema-9..13 re-pin moved the pin) and the seed is
  // regenerated on this product out of scope; the contract is anchored to the
  // LIVE validator constants and the retained report is recorded as legacy
  // provenance.  Any other mismatch is still rejected.
  const pinResolution = classifyRetainedPin({
    reportPin,
    validatorPin: pin,
    legacyContentSha256: pin.pre_port_content_sha256,
  });
  if (!pinResolution.ok) {
    throw new Error(`aged validation report ${reportPath}: ${pinResolution.problems.join("; ")}`);
  }
  const qualificationExists = fs.existsSync(opts.qualification);
  const qualification = qualificationExists ? readJson(opts.qualification) : null;

  const acceptanceEvidence = [
    { kind: "aged-validation-report", path: reportPath },
    { kind: "readiness-pointer", path: opts.readiness },
    { kind: "published-qualification", path: opts.qualification },
    { kind: "self-tests-alone-summary", path: selfTestsAlone.summaryPath },
    { kind: "npf2-positive-run-summary", path: path.join(positive.retained_dir, "summary.json") },
    { kind: "npf2-negative-run-summary", path: path.join(negative.retained_dir, "summary.json") },
  ];
  const newPin = buildNewPin({
    pin,
    contentPaths,
    contentPathsSourceRel: PIN_SOURCE_REL,
    acceptanceEvidence,
    legacyPriorReport: pinResolution.kind === "legacy_pre_port"
      ? { ...reportPin, report_path: reportPath }
      : null,
  });

  // ── gates: self-tests alone + the flocked 49-file storm chain ─────────
  const stormChain = resolveStormChain(opts);
  if (!stormChain) throw new Error("no valid retained 49-file storm chain summary found");
  const gates = buildGatesSection({
    selfTestsAlone: selfTestsAlone.summary,
    selfTestsAlonePath: selfTestsAlone.summaryPath,
    stormChain: stormChain.summary,
    stormChainPath: stormChain.summaryPath,
  });

  // ── final squash: story commits do not survive; content pin is anchor ──
  const finalSquash = buildFinalSquash({
    provenanceCommit: pin.provenance_commit,
    provenanceSubject: pin.provenance_subject,
    contentSha256: pin.content_sha256,
  });

  const branch = opts.branch ?? readJson(opts.readiness)?.branch ?? null;
  const contract = assembleContract({
    generated_at_utc: new Date().toISOString(),
    run_id: normalizeRunId(opts.runId),
    branch,
    design,
    evidence,
    new_pin: newPin,
    gates,
    final_squash: finalSquash,
  });
  contract.source_artifacts = [
    { kind: "evidence-source", path: path.join(repo, EVIDENCE_SOURCE_REL) },
    { kind: "pin-source", path: path.join(repo, PIN_SOURCE_REL) },
    ...acceptanceEvidence,
    { kind: "storm-chain-summary", path: stormChain.summaryPath },
  ];

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
    evidence_command: contract.design.evidence_command.command,
    positive: {
      run: contract.evidence.positive.run,
      finalize_merge_status: contract.evidence.positive.finalize_merge.status,
      finalize_merge_reroute_count: contract.evidence.positive.finalize_merge.reroute_count,
      tested_tree: contract.evidence.positive.tested_tree,
      merged_tree: contract.evidence.positive.merged_tree,
      green_suite_result_count: contract.evidence.positive.green_suite_result_count,
    },
    negative: {
      run: contract.evidence.negative.run,
      finalize_merge_reroute_count: contract.evidence.negative.finalize_merge.reroute_count,
      ledger_concession_count: contract.evidence.negative.finalize_merge.ledger_concession_count,
      suite_result_count: contract.evidence.negative.suite_result_count,
      ledger_evidence_missing: contract.evidence.negative.events.ledger_evidence_missing,
      landed_without_suite_evidence: contract.evidence.negative.events.landed_without_suite_evidence,
    },
    new_pin: {
      content_sha256: contract.new_pin.content_sha256,
      provenance_commit: contract.new_pin.provenance_commit,
      provenance_subject: contract.new_pin.provenance_subject,
      acceptance: contract.new_pin.acceptance,
    },
    gates: {
      lock_path: contract.gates.lock_path,
      self_tests_alone_verdict: contract.gates.self_tests_alone.verdict,
      self_tests_alone_head: contract.gates.self_tests_alone.git_head,
      storm_chain_verdict: contract.gates.storm_chain.verdict,
      storm_chain_files: contract.gates.storm_chain.file_count_observed,
      lock_submit_iso: contract.gates.storm_chain.lock?.submit_iso,
      lock_acquire_iso: contract.gates.storm_chain.lock?.acquire_iso,
      lock_release_iso: contract.gates.storm_chain.lock?.release_iso,
    },
    final_squash: {
      provenance_commit: contract.final_squash.provenance_commit,
      final_squash_hash: contract.final_squash.final_squash_hash,
      durable_anchor: contract.final_squash.durable_anchor.value,
    },
    validation_ok: validation.ok,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`publish-npf2-fixture-contract failed: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}

export { main, parseArgs, resolveEvidenceHalf, resolveSelfTestsAlone, resolveStormChain };
