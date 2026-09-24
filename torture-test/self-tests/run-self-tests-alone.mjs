#!/usr/bin/env node

// run-self-tests-alone.mjs — the NPF-2 "self-tests alone" gate runner (US-010).
//
// Runs, each in its OWN process and serially:
//   * the NPF-2 positive and negative halves of
//     `tier2-storm-rehearsal-suite-ledger-e2e.test.ts` (each selected by its
//     own --test-name-pattern),
//   * the four change-owned aged self-tests (aged-core, origin-pins,
//     o12-content-pin, seed-root-copy),
//   * every O12 self-test entry (focused tests, probes, fixture generator),
//   * the non-gating seed-readiness qualification gate (executed + retained;
//     its colour is owned by the aged re-validation story US-012).
//
// Every child runs under TAMANDUA_TEST_GUARD=1 with
// TAMANDUA_PI_BINARY=TAMANDUA_HERMES_BINARY=TAMANDUA_DSH_BINARY=/usr/bin/false
// and NO ambient TAMANDUA_* authority (the runner strips every TAMANDUA_* key
// from the inherited env and re-adds only the gate keys). Each entry gets its
// own private TMPDIR outside the real-state prefix. Full stdout/stderr logs, a
// `results.tsv` and a machine-readable `self-tests-alone-summary.json` are
// retained under `<repo>/torture-test/var/results/self-tests-alone-<ts>.<rand>/`;
// nothing is ever disposed.
//
// IMPORTANT host note: the product TEST ISOLATION guard treats any path under
// the real user's ~/.tamandua as production, and the NPF-2 self-test starts a
// contained daemon. This runner therefore REFUSES to run from a repo checkout
// under that prefix (the summary records environment.guard_safe_repo_root).
// Run it from the owned detached gate worktree under /home/kaladin/matchlock-work/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  AGED_ENTRIES,
  EXPECTED_COUNTS,
  NPF2_ENTRIES,
  O12_ENTRIES,
  QUALIFICATION_ENTRIES,
  summarizeSelfTestsAlone,
} from "./self-tests-alone-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const DEFAULT_RESULTS_BASE = path.join(TT_ROOT, "var", "results");
const FALSE_HARNESS = "/usr/bin/false";
const PER_ENTRY_TIMEOUT_MS = 1_800_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** The real-state prefix the product guard treats as production (mirror). */
const REAL_STATE_DIR = path.join(os.userInfo().homedir, ".tamandua");

function isUnderRealState(candidate) {
  const normalized = path.resolve(candidate);
  return normalized === REAL_STATE_DIR || normalized.startsWith(REAL_STATE_DIR + path.sep);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function safeName(name) {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function parseArgs(argv) {
  const args = { resultsBase: DEFAULT_RESULTS_BASE, label: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[i];
    };
    if (flag === "--results-base") args.resultsBase = next();
    else if (flag === "--label") args.label = next();
    else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "usage: run-self-tests-alone.mjs [--results-base DIR] [--label L]\n" +
          "  Runs the NPF-2 (positive+negative), aged and O12 self-tests each alone\n" +
          "  under the guard-safe gate env and retains logs + summary. Refuses to run\n" +
          "  from a checkout under the real ~/.tamandua prefix.\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

/** Build the full entry list in report order. */
export function buildEntries() {
  const entries = [];
  for (const definition of NPF2_ENTRIES) entries.push({ ...definition });
  for (const rel of AGED_ENTRIES) {
    entries.push({ name: path.basename(rel), group: "aged", kind: "test", rel });
  }
  for (const definition of O12_ENTRIES) {
    entries.push({ group: "o12", ...definition });
  }
  for (const rel of QUALIFICATION_ENTRIES) {
    entries.push({ name: path.basename(rel), group: "qualification", kind: "test", rel });
  }
  return entries;
}

/**
 * The explicit child env: the inherited env with EVERY TAMANDUA_* key removed
 * (no ambient run/worker/production-control authority), the frozen gate keys
 * re-added, and a private TMPDIR outside the real-state prefix.
 */
function gateEnv({ tmpdir, distDir = null, seedSnapshot = null }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("TAMANDUA_")) continue;
    if (value !== undefined) env[key] = value;
  }
  env.TAMANDUA_TEST_GUARD = "1";
  env.TAMANDUA_PI_BINARY = FALSE_HARNESS;
  env.TAMANDUA_HERMES_BINARY = FALSE_HARNESS;
  env.TAMANDUA_DSH_BINARY = FALSE_HARNESS;
  env.TMPDIR = tmpdir;
  if (distDir) env.TAMANDUA_O12_PROBE_DIST = distDir;
  // Host-portable seed-evidence override (an EVIDENCE LOCATION, not run/work
  // authority): o12.test.mjs's schema-pin assertion reads TAMANDUA_O12_SEED_SNAPSHOT
  // to point at an owned copy of the immutable v10 seed snapshot on a host that
  // has no /opt/tamandua-storm-seed.* (e.g. a Matchlock VM). Gated to the o12
  // group exactly like TAMANDUA_O12_PROBE_DIST.
  if (seedSnapshot) env.TAMANDUA_O12_SEED_SNAPSHOT = seedSnapshot;
  return env;
}

/** The argv for one entry (test / probe / generator). */
export function argvFor(entry, absPath, workspace) {
  if (entry.kind === "test") {
    const args = ["--test"];
    if (entry.test_name_pattern) args.push(`--test-name-pattern=${entry.test_name_pattern}`);
    args.push(absPath);
    return [process.execPath, ...args];
  }
  if (entry.kind === "generator") return [process.execPath, absPath, workspace];
  return [process.execPath, absPath];
}

function parseTotals(text) {
  const totals = { tests: null, pass: null, fail: null, skipped: null, cancelled: null, todo: null };
  for (const key of Object.keys(totals)) {
    const match = text.match(new RegExp(`(?:^|\\n)(?:ℹ|#) ${key} (\\d+)\\n`));
    if (match) totals[key] = Number(match[1]);
  }
  return totals;
}

function gitHead(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const guardSafe = !isUnderRealState(REPO_ROOT);
  if (!guardSafe) {
    process.stderr.write(
      `refusing to run the self-tests-alone gate from ${REPO_ROOT}: it is under the real-state prefix ${REAL_STATE_DIR}.\n` +
        "Run from the owned guard-safe gate worktree (e.g. /home/kaladin/matchlock-work/npf2-gate-71af02c8).\n",
    );
    process.exit(2);
  }

  const entries = buildEntries();
  const startedAt = new Date().toISOString();
  fs.mkdirSync(args.resultsBase, { recursive: true });
  const label = args.label ? `${safeName(args.label)}-` : "";
  const resultsDir = fs.mkdtempSync(path.join(args.resultsBase, `self-tests-alone-${label}${timestamp()}.`));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-tests-alone-scratch."));
  const distDir = path.join(REPO_ROOT, "dist");

  const records = [];
  for (const entry of entries) {
    const absPath = path.join(REPO_ROOT, entry.rel);
    if (!fs.existsSync(absPath)) {
      records.push({
        name: entry.name,
        group: entry.group,
        half: entry.half,
        kind: entry.kind,
        rel: entry.rel,
        test_name_pattern: entry.test_name_pattern,
        exit_code: 127,
        signal: null,
        duration_ms: 0,
        pass: false,
        stdout_log: null,
        stderr_log: null,
        error: `missing file: ${absPath}`,
      });
      process.stdout.write(`${entry.group}\t${entry.name}\tMISSING\n`);
      continue;
    }
    const entryScratch = fs.mkdtempSync(path.join(scratchDir, `${safeName(entry.name)}.`));
    const workspace = fs.mkdtempSync(path.join(TT_ROOT, "var", `oracle-self-test.alone-${safeName(entry.name)}.`));
    const argv = argvFor(entry, absPath, workspace);
    const startedMs = Date.now();
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: false,
      timeout: PER_ENTRY_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: gateEnv({
        tmpdir: entryScratch,
        distDir: entry.group === "o12" ? distDir : null,
        seedSnapshot: entry.group === "o12" ? (process.env.TAMANDUA_O12_SEED_SNAPSHOT ?? null) : null,
      }),
    });
    const durationMs = Date.now() - startedMs;
    const stdoutPath = path.join(resultsDir, `${safeName(entry.name)}.stdout.log`);
    const stderrPath = path.join(resultsDir, `${safeName(entry.name)}.stderr.log`);
    fs.writeFileSync(stdoutPath, result.stdout ?? "");
    fs.writeFileSync(stderrPath, result.stderr ?? "");
    const totals = parseTotals(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    records.push({
      name: entry.name,
      group: entry.group,
      half: entry.half,
      kind: entry.kind,
      rel: entry.rel,
      test_name_pattern: entry.test_name_pattern,
      argv,
      exit_code: result.status,
      signal: result.signal,
      duration_ms: durationMs,
      pass: result.status === 0,
      stdout_log: stdoutPath,
      stderr_log: stderrPath,
      private_tmpdir: entryScratch,
      workspace: entry.kind === "generator" ? workspace : undefined,
      totals,
    });
    process.stdout.write(
      `${entry.group}\t${entry.name}\t${result.status === 0 ? "PASS" : "FAIL"}\t${durationMs}ms\n`,
    );
  }

  const summary = {
    kind: "self-tests-alone-summary",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    git_head: gitHead(REPO_ROOT),
    results_dir: resultsDir,
    environment: {
      guard_safe_repo_root: guardSafe,
      real_state_prefix: REAL_STATE_DIR,
      gate_env: {
        TAMANDUA_TEST_GUARD: "1",
        TAMANDUA_PI_BINARY: FALSE_HARNESS,
        TAMANDUA_HERMES_BINARY: FALSE_HARNESS,
        TAMANDUA_DSH_BINARY: FALSE_HARNESS,
        tokens: "no ambient TAMANDUA_* authority; zero model tokens (false harnesses)",
      },
    },
    expected_counts: { ...EXPECTED_COUNTS },
    entries: records,
    ...summarizeSelfTestsAlone(records),
  };
  fs.writeFileSync(path.join(resultsDir, "self-tests-alone-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(
    path.join(resultsDir, "results.tsv"),
    `group\tname\thalf\texit_code\tverdict\tduration_ms\n${records
      .map(
        (r) =>
          `${r.group}\t${r.name}\t${r.half ?? ""}\t${r.exit_code ?? "null"}\t${r.pass ? "PASS" : "FAIL"}\t${r.duration_ms}`,
      )
      .join("\n")}\n`,
  );

  process.stdout.write(`self-tests-alone: ${summary.passed_required}/${summary.total_required} required entries exited 0 (verdict ${summary.verdict})\n`);
  for (const group of Object.keys(summary.by_group)) {
    const block = summary.by_group[group];
    process.stdout.write(
      `  ${group}: ${block.passed}/${block.total} ${block.gating ? "(gating)" : "(informational)"} ${block.verdict}\n`,
    );
  }
  process.stdout.write(`guard_safe_repo_root: ${guardSafe}\n`);
  process.stdout.write(`self-tests-alone evidence retained: ${resultsDir}\n`);
  if (summary.verdict !== "PASS") {
    process.stdout.write(`red files: ${summary.red_files.join(", ")}\n`);
    process.exit(1);
  }
}

// Only run when executed directly (keeps buildEntries/argvFor importable by the
// focused self-test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
