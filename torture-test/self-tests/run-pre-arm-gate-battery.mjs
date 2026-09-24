#!/usr/bin/env node

// run-pre-arm-gate-battery.mjs — Storm O12-REPIN US-007 "each alone" pre-arm
// gate battery runner.
//
// Runs, each in its OWN process and serially:
//   * the three aged self-tests (aged-core, origin-pins, seed-readiness),
//   * every O12 self-test entry (the focused O12 tests + the reserved-key /
//     run-number probes + the fixture generator),
//   * the exact 49-file run #7 `test_cmd_extended` storm chain.
//
// Every child runs under TAMANDUA_TEST_GUARD=1 with
// TAMANDUA_PI_BINARY=TAMANDUA_HERMES_BINARY=TAMANDUA_DSH_BINARY=/usr/bin/false
// and NO ambient TAMANDUA_* authority (the runner strips every TAMANDUA_* key
// from the inherited env and re-adds only the gate keys). Each entry gets its
// own private TMPDIR. Full stdout/stderr logs, a `results.tsv` and a
// machine-readable `pre-arm-gate-battery-summary.json` are retained under
// `<repo>/torture-test/var/results/pre-arm-gate-battery-<ts>/`; nothing is
// ever disposed.
//
// IMPORTANT host note: the product TEST ISOLATION guard treats any path under
// the real user's ~/.tamandua as production. This runner therefore MUST run
// from a repo checkout OUTSIDE that prefix (the summary records
// environment.guard_safe_repo_root). The storm self-tests start contained
// daemons and cannot pass from a worktree that lives under
// ~/.tamandua/worktrees/... — run the battery from an owned detached worktree
// under /home/kaladin/matchlock-work/ (as run #7 did under /opt).
//
// The WHOLE battery is intended to be invoked under one held
// `flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  AGED_ENTRIES,
  O12_ENTRIES,
  STORM_CHAIN_49,
  summarizeBattery,
} from "./pre-arm-gate-battery-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(TT_ROOT, "..");
const DEFAULT_RESULTS_BASE = path.join(TT_ROOT, "var", "results");
const FALSE_HARNESS = "/usr/bin/false";
const PER_ENTRY_TIMEOUT_MS = 1_800_000;

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
  const args = { scope: "all", resultsBase: DEFAULT_RESULTS_BASE, label: null, lockPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[i];
    };
    if (flag === "--scope") args.scope = next();
    else if (flag === "--results-base") args.resultsBase = next();
    else if (flag === "--label") args.label = next();
    else if (flag === "--lock-path") args.lockPath = next();
    else if (flag === "--help" || flag === "-h") {
      process.stdout.write("usage: run-pre-arm-gate-battery.mjs [--scope all|aged|o12|storm] [--results-base DIR] [--label L] [--lock-path P]\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!["all", "aged", "o12", "storm"].includes(args.scope)) {
    throw new Error(`--scope must be all|aged|o12|storm (got ${args.scope})`);
  }
  return args;
}

/**
 * The explicit child env: the inherited env with EVERY TAMANDUA_* key removed
 * (no ambient run/worker/production-control authority), the frozen gate keys
 * re-added, and a private TMPDIR outside the real-state prefix.
 */
function gateEnv({ tmpdir, o12Dist = null }) {
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
  if (o12Dist) env.TAMANDUA_O12_PROBE_DIST = o12Dist;
  return env;
}

function buildEntries(scope) {
  const entries = [];
  if (scope === "all" || scope === "aged") {
    for (const rel of AGED_ENTRIES) {
      entries.push({ name: path.basename(rel), group: "aged", kind: "test", rel });
    }
  }
  if (scope === "all" || scope === "o12") {
    for (const definition of O12_ENTRIES) {
      entries.push({ group: "o12", ...definition });
    }
  }
  if (scope === "all" || scope === "storm") {
    for (const rel of STORM_CHAIN_49) {
      entries.push({ name: path.basename(rel), group: "storm", kind: "test", rel });
    }
  }
  return entries;
}

function argvFor(entry, absPath, workspace) {
  if (entry.kind === "test") return [process.execPath, "--test", absPath];
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries = buildEntries(args.scope);
  const startedAt = new Date().toISOString();
  const guardSafe = !isUnderRealState(REPO_ROOT);

  fs.mkdirSync(args.resultsBase, { recursive: true });
  const label = args.label ? `${safeName(args.label)}-` : "";
  const resultsDir = fs.mkdtempSync(path.join(args.resultsBase, `pre-arm-gate-battery-${label}${timestamp()}.`));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-arm-gate-battery-scratch."));
  const distDir = path.join(REPO_ROOT, "dist");

  const records = [];
  for (const entry of entries) {
    const absPath = path.join(REPO_ROOT, entry.rel);
    if (!fs.existsSync(absPath)) {
      records.push({
        name: entry.name, group: entry.group, kind: entry.kind, rel: entry.rel,
        exit_code: 127, signal: null, duration_ms: 0, pass: false,
        stdout_log: null, stderr_log: null, error: `missing file: ${absPath}`,
      });
      continue;
    }
    const entryScratch = fs.mkdtempSync(path.join(scratchDir, `${safeName(entry.name)}.`));
    const workspace = fs.mkdtempSync(path.join(TT_ROOT, "var", `oracle-self-test.battery-${safeName(entry.name)}.`));
    const argv = argvFor(entry, absPath, workspace);
    const startedMs = Date.now();
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: false,
      timeout: PER_ENTRY_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: gateEnv({ tmpdir: entryScratch, o12Dist: entry.group === "o12" ? distDir : null }),
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
      kind: entry.kind,
      rel: entry.rel,
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
    process.stdout.write(`${entry.group}\t${entry.name}\t${result.status === 0 ? "PASS" : "FAIL"}\t${durationMs}ms\n`);
  }

  const summary = {
    kind: "pre-arm-gate-battery-summary",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    scope: args.scope,
    results_dir: resultsDir,
    lock_path: args.lockPath,
    submitted_at: process.env.TT_GATE_SUBMITTED_AT ?? null,
    acquired_at: process.env.TT_GATE_ACQUIRED_AT ?? null,
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
    entries: records,
    ...summarizeBattery(records),
  };
  const summaryPath = path.join(resultsDir, "pre-arm-gate-battery-summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(
    path.join(resultsDir, "results.tsv"),
    `${records.map((r) => `${r.group}\t${r.name}\t${r.exit_code ?? "null"}\t${r.pass ? "PASS" : "FAIL"}`).join("\n")}\n`,
  );
  fs.writeFileSync(path.join(resultsDir, "storm-chain-files.txt"), `${STORM_CHAIN_49.join("\n")}\n`);

  process.stdout.write(`battery: ${summary.passed}/${summary.total} entries exited 0 (verdict ${summary.verdict})\n`);
  process.stdout.write(`groups: aged ${summary.by_group.aged.passed}/${summary.by_group.aged.total}, o12 ${summary.by_group.o12.passed}/${summary.by_group.o12.total}, storm ${summary.by_group.storm.passed}/${summary.by_group.storm.total}\n`);
  process.stdout.write(`guard_safe_repo_root: ${guardSafe}\n`);
  process.stdout.write(`battery evidence retained: ${resultsDir}\n`);
  if (summary.verdict !== "PASS") {
    process.stdout.write(`red files: ${summary.red_files.join(", ")}\n`);
    process.exit(1);
  }
}

main();
