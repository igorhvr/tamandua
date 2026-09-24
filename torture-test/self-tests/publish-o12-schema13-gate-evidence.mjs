#!/usr/bin/env node

// publish-o12-schema13-gate-evidence.mjs — I/O runner for the O12-SCHEMA-13
// gate evidence record (US-006).
//
// Reads the RETAINED gate artifacts and shapes them (through the pure module
// `o12-schema13-gate-evidence.mjs` into
// `torture-test/impl-tasks/o12-schema13-gate-evidence.json`, validated before
// anything is written. The contract story (US-007) consumes the record so a
// reviewer can audit the exact gate commands, the frozen gate env, every
// per-entry exit and the retained log paths without the worktree.
//
// Artifact values are READ, never retyped:
//   - self-tests alone : <results-base>/self-tests-alone-*/self-tests-alone-summary.json
//   - O12 gate         : <results-base>/o12-gate-self-tests-*/o12-gate-self-tests-summary.json
//   - seed stores      : var/owned-seed-snapshots-*/owned-seed-snapshots-receipt.json
// Only the invocation strings actually run, the recorded substitutions and the
// run identity are verbatim operator text (`--command`, `--substitution`,
// `--run-id`, ...), because no artifact can carry them.
//
// Exit codes: 0 = published + validated; 1 = usage/IO error; 2 = record invalid
// (nothing written). It never touches the oracle, the product or the real state.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GATE_EVIDENCE_OUTPUT_REL,
  buildGateEvidence,
  validateO12Schema13GateEvidence,
} from "./o12-schema13-gate-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const VAR_ROOT = path.join(TT_ROOT, "var");
const RESULTS_BASE = path.join(VAR_ROOT, "results");

function parseArgs(argv) {
  const args = {
    selfTestsAlone: null,
    o12Gate: null,
    seedReceipt: null,
    commands: [],
    substitutions: [],
    runId: null,
    story: null,
    branch: null,
    base: null,
    head: null,
    out: path.join(REPO_ROOT, GATE_EVIDENCE_OUTPUT_REL),
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    if (flag === "--self-tests-alone") args.selfTestsAlone = next();
    else if (flag === "--o12-gate") args.o12Gate = next();
    else if (flag === "--seed-receipt") args.seedReceipt = next();
    else if (flag === "--command") args.commands.push(next());
    else if (flag === "--substitution") args.substitutions.push(next());
    else if (flag === "--run-id") args.runId = next();
    else if (flag === "--story") args.story = next();
    else if (flag === "--branch") args.branch = next();
    else if (flag === "--base") args.base = next();
    else if (flag === "--head") args.head = next();
    else if (flag === "--out") args.out = path.resolve(next());
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "usage: publish-o12-schema13-gate-evidence.mjs [--self-tests-alone DIR] [--o12-gate DIR] [--seed-receipt PATH]\n"
          + "       --command '<exact command>' [--command ...] [--substitution '<key>=<value>']...\n"
          + "       [--run-id ID] [--story ID] [--branch B] [--base SHA] [--head SHA] [--out PATH] [--dry-run]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

/** Newest retained directory matching `prefix` that contains `file`. */
function newestRetainedDir(prefix, file) {
  let names;
  try {
    names = fs.readdirSync(RESULTS_BASE);
  } catch {
    return null;
  }
  const candidates = names
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(RESULTS_BASE, name))
    .map((dir) => {
      const candidate = path.join(dir, file);
      if (!fs.existsSync(candidate)) return null;
      return { dir, candidate, mtime: fs.statSync(candidate).mtimeMs };
    })
    .filter((candidate) => candidate !== null)
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.dir ?? null;
}

/** Newest owned seed-snapshot materialization receipt under var/. */
function newestSeedReceipt() {
  const entries = fs.existsSync(VAR_ROOT)
    ? fs.readdirSync(VAR_ROOT).filter((name) => name.startsWith("owned-seed-snapshots-"))
    : [];
  const candidates = entries
    .map((name) => path.join(VAR_ROOT, name, "owned-seed-snapshots-receipt.json"))
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({ candidate, mtime: fs.statSync(candidate).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) return null;
  const chosen = candidates[0].candidate;
  const receipt = JSON.parse(fs.readFileSync(chosen, "utf8"));
  receipt.receiptPath = chosen;
  return receipt;
}

function readJson(file, label) {
  if (!file || !fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.commands.length === 0) throw new Error("at least one --command is required");

  const selfTestsAloneDir = args.selfTestsAlone
    ? path.resolve(args.selfTestsAlone)
    : newestRetainedDir("self-tests-alone-", "self-tests-alone-summary.json");
  const o12GateDir = args.o12Gate
    ? path.resolve(args.o12Gate)
    : newestRetainedDir("o12-gate-self-tests-", "o12-gate-self-tests-summary.json");

  const selfTestsAlone = readJson(
    path.join(selfTestsAloneDir ?? "", "self-tests-alone-summary.json"),
    "self-tests-alone summary",
  );
  const o12Gate = readJson(
    path.join(o12GateDir ?? "", "o12-gate-self-tests-summary.json"),
    "O12 gate self-test summary",
  );
  const seedReceipt = args.seedReceipt
    ? { ...readJson(path.resolve(args.seedReceipt), "owned seed-snapshot receipt"), receiptPath: path.resolve(args.seedReceipt) }
    : newestSeedReceipt();

  const record = buildGateEvidence({
    runId: args.runId,
    story: args.story,
    branch: args.branch,
    base: args.base,
    head: args.head,
    commands: args.commands,
    substitutions: args.substitutions,
    selfTestsAlone,
    o12Gate,
    seedReceipt,
  });

  const validation = validateO12Schema13GateEvidence(record);
  if (!validation.ok) {
    process.stderr.write("o12-schema13 gate evidence is INVALID; nothing written:\n");
    for (const problem of validation.problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(2);
  }

  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    const tmp = `${args.out}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tmp, args.out);
  }
  process.stdout.write(
    `o12-schema13 gate evidence ${args.dryRun ? "(dry-run) " : ""}valid: ${args.out}\n`,
  );
  process.stdout.write(`  self-tests alone: ${record.self_tests_alone.passed_required}/${record.self_tests_alone.total_required} required entries exited 0 (verdict ${record.self_tests_alone.verdict})\n`);
  for (const [group, block] of Object.entries(record.self_tests_alone.by_group ?? {})) {
    process.stdout.write(`  ${group}: ${block.passed}/${block.total} ${block.gating ? "(gating)" : "(informational)"} ${block.verdict}\n`);
  }
  process.stdout.write(`  o12 gate: ${record.o12_gate.passed}/${record.o12_gate.total} entries exited 0 (verdict ${record.o12_gate.verdict}), fixture matrix ${record.o12_gate.fixture_matrix.fixture_count}/${record.o12_gate.fixture_matrix.expected_fixture_count} expected-fixture count\n`);
  process.exit(0);
}

try {
  main();
} catch (error) {
  process.stderr.write(`publish-o12-schema13-gate-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
