#!/usr/bin/env node
// core-recording-cells.mjs — CORE-CELLS US-006 (original CORE US-008):
// zero-token frequent-gate entrypoint with complete registered membership,
// expected/executed accounting and per-cell evidence.
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.4. ONE explicit zero-token core
// command that runs the complete recorded-cell set:
//   * recorded cells US-002..US-005 (original CORE US004-US007): TCMD x4,
//     BRUN x2 corridors, RVOC/RCNT, PHNT — each as its own committed
//     regression file, executed as its own `node --test` process;
//   * required foundational regression files (contract, capture/sanitize,
//     replay-adapter conformance, replay-executor) as their own `node --test`
//     processes, plus the CORE-MOTOR designated conformance gate
//     (core-recording-motor-gate.mjs) as its own `node` process.
//
// Registered membership lives in the PURE data module
// core-recording-cells-membership.mjs (deep-frozen). The entrypoint reports
// expected vs executed counts at two levels: registered producers (9) and
// recorded sub-cells (10: TCMD x4, BRUN x2, RVOC/RCNT x2, PHNT x2). A
// producer/cell that is MISSING, RED or INTERRUPTED can never make the
// entrypoint exit green.
//
// Per-cell evidence (cells-summary.json + per-cell cell-result.json):
//   exact source path (absolute), git tree/commit (snapshot), host, argv,
//   UTC-Z start/end, producer exit/signal and the FULL producer log (never a
//   preview). Failure and interruption propagate to a non-zero exit. Real
//   elapsed duration is measured (Date.now wall clock, UTC-Z iso stamps)
//   with no invented minutes target and no exclusions of red/slow cells.
//
// Zero tokens by construction: every producer is a committed local test file
// driven through the real isolated zero-token motor; no provider/model/API
// call is possible. Torture-only tooling: no product code, personas,
// permissions, installed catalog, daemon configuration or live hooks.
//
// Usage (repo root; dist/ built for the FULL run; clean committed tree for
// evidence runs):
//   node torture-test/bin/core-recording-cells.mjs --help
//   node torture-test/bin/core-recording-cells.mjs --membership
//   node torture-test/bin/core-recording-cells.mjs \
//       [--evidence-dir <fresh retained root>]
//   TT_CORE_CELLS_MANIFEST=<path> node torture-test/bin/core-recording-cells.mjs
//       [--evidence-dir <fresh retained root>]     # TEST-ONLY synthetic seam
//
// `--help` is side-effect-free: it prints usage and exits 0 BEFORE any fs
// write, process spawn, port bind or signal handler installation.
//
// Exit codes: 0 only when every registered producer executed green and
// expected == executed (nothing missing/red/interrupted); 1 for any
// missing/red/unexecuted producer; 130 (SIGINT) / 143 (SIGTERM) when the run
// was interrupted (never green); 2 for usage/parse/preflight refusal.
//
// R4b integration: the checked-in independent per-landing review runner
// described by torture-test/impl-tasks/R4b-review-and-operator-safety.md is
// NOT YET LANDED in this checkout (R4b is scoped-task documentation only;
// the R4b task record lives in impl-tasks/; no runner source exists under
// torture-test/bin or torture-test/self-tests). This entrypoint therefore
// RECORDS the precise integration dependency (see RECORDED_DEPENDENCIES in
// cells-summary.json) instead of wiring live hooks or adding bypass flags,
// and never claims to replace both-host release certification.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CORE_CELLS_ENTRYPOINT_VERSION,
  CELL_MANIFEST_VERSION,
  CORE_CELLS_MEMBERSHIP,
  expectedProducerCount,
  expectedRecordedCellCount,
  recordedCellIds,
  validateOverrideManifest,
} from "./core-recording-cells-membership.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
const REVIEW_LOGS = path.join(REPO_ROOT, "torture-test", "var", "review-logs");

const EXIT = Object.freeze({
  ok: 0,
  runFailed: 1,
  usage: 2,
  interruptedSigint: 130,
  interruptedSigterm: 143,
});

const TERM_GRACE_MS = 5000; // bounded window before SIGKILL fallback on interrupt
const KILL_GRACE_MS = 3000; // bounded window after SIGKILL before giving up

const USAGE = `core-recording-cells.mjs — CORE-CELLS zero-token frequent-gate entrypoint

Runs the complete registered recorded-cell set (US-002..US-005: TCMD x4, BRUN
x2 corridors, RVOC/RCNT, PHNT) plus the required foundational regression
files (contract, capture/sanitize, replay-adapter conformance, replay-executor,
motor-gate) with expected/executed accounting and per-cell evidence.

USAGE
  node torture-test/bin/core-recording-cells.mjs --help
  node torture-test/bin/core-recording-cells.mjs --membership
  node torture-test/bin/core-recording-cells.mjs [--evidence-dir <path>]

OPTIONS
  -h, --help              Print this usage and exit 0. Side-effect free: no
                          state files, no processes, no ports.
      --membership        Print the registered membership (producers, recorded
                          cells, file-existence checks) and exit. Read-only:
                          never executes a producer and never writes anything.
      --evidence-dir <p>  Retained evidence root for a FULL run (per-cell
                          full logs, per-cell results, cells-summary.json).
                          Default: torture-test/var/review-logs/core-cells-<UTC>Z/

ENVIRONMENT (test-only seam)
  TT_CORE_CELLS_MANIFEST=<path>  JSON override manifest (see
      core-recording-cells-membership.mjs validateOverrideManifest for the
      schema). FULL-run only; used by the hermetic
      tier0-core-recording-entrypoint.test.ts to prove missing/red/interrupted
      cells never yield a green exit without executing the real cells.

REGISTERED MEMBERSHIP
  foundational (5): contract, capture-sanitize, replay-adapter-conformance,
    replay-executor, motor-gate
  recorded (4): tcmd-cells (TCMD x4), brun-cell (BRUN x2 corridors),
    rvoc-rcnt-cells (RVOC/RCNT), phnt-cells (PHNT x2 accounts)
  recorded sub-cells: 10

EXIT CODES
  0   every registered producer executed green (expected == executed)
  1   any producer/cell missing, red or unexecuted
  2   usage error / override-manifest refusal / preflight refusal
  130 interrupted by SIGINT (SIGTERM -> 143) — never green

FULL-RUN PREREQUISITES
  dist/ built (npm run build) and a clean committed tree for evidence runs.
  Producers run sequentially, each as its own node --test process (one
  torture self-test file per process). Evidence and per-cell logs are RETAINED
  under the evidence root; nothing is removed.

R4b NOTE
  The checked-in independent per-landing review runner (R4b-review-and-
  operator-safety.md US-002) is not yet landed in this checkout; this
  entrypoint records that integration dependency instead of wiring live hooks
  or bypass flags, and does not replace both-host release certification.
`;

// ── arg parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { help: false, membership: false, evidenceDir: null, manifestEnv: null, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--membership") opts.membership = true;
    else if (arg === "--evidence-dir") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) opts.unknown.push("--evidence-dir requires a path argument");
      else {
        opts.evidenceDir = v;
        i += 1;
      }
    } else opts.unknown.push(arg);
  }
  opts.manifestEnv = process.env.TT_CORE_CELLS_MANIFEST ?? null;
  return opts;
}

// ── tiny shared utilities ────────────────────────────────────────────

function isoUtc(date = new Date()) {
  return date.toISOString();
}

function stampUtc() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function gitCapture(args) {
  try {
    const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", timeout: 15000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function gitHead() {
  return gitCapture(["rev-parse", "HEAD"]);
}
function gitTree() {
  return gitCapture(["rev-parse", "HEAD^{tree}"]);
}
function gitStatusShort() {
  try {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf-8", timeout: 15000 });
    return r.status === 0 ? r.stdout.split("\n").filter((l) => l.length > 0) : null;
  } catch {
    return null;
  }
}

function parseTapCounts(stdoutText) {
  const counts = {};
  for (const key of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const re = new RegExp(`^# ${key} (\\d+)$`, "gm");
    let m;
    let last = null;
    while ((m = re.exec(stdoutText)) !== null) last = Number(m[1]);
    if (last !== null) counts[key] = last;
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

function describeSpawnError(err) {
  if (err === null || typeof err !== "object") return String(err);
  const code = err.code ? ` code=${err.code}` : "";
  const msg = err.message ?? String(err);
  return `${msg}${code}`;
}

// ── membership mode (read-only) ──────────────────────────────────────

function membershipRows() {
  return CORE_CELLS_MEMBERSHIP.producers.map((p) => {
    const abs = path.isAbsolute(p.file) ? p.file : path.join(REPO_ROOT, p.file);
    return { producer: p, abs, exists: fs.existsSync(abs) };
  });
}

function runMembership() {
  const rows = membershipRows();
  const missing = rows.filter((r) => !r.exists);
  const recordedIds = recordedCellIds();
  const recordedProducers = CORE_CELLS_MEMBERSHIP.producers.filter((p) => p.scope === "recorded");
  const foundational = CORE_CELLS_MEMBERSHIP.producers.filter((p) => p.scope === "foundational");

  const out = [];
  out.push("CORE-CELLS entrypoint membership (read-only; nothing executed, nothing written)");
  out.push(`registered producers: ${expectedProducerCount()} (foundational ${foundational.length}, recorded ${recordedProducers.length})`);
  out.push(`recorded sub-cells: ${expectedRecordedCellCount()}`);
  out.push("");
  for (const p of CORE_CELLS_MEMBERSHIP.producers) {
    const row = rows.find((r) => r.producer === p);
    out.push(`  ${row.exists ? "present" : "MISSING"}  ${p.id.padEnd(22)} ${p.scope.padEnd(12)} ${p.kind.padEnd(10)} ${p.file}`);
  }
  if (recordedIds.length > 0) {
    out.push("");
    out.push("recorded sub-cell ids (order-stable):");
    for (const id of recordedIds) out.push(`  - ${id}`);
  }
  const text = `${out.join("\n")}\n`;
  process.stdout.write(text);
  return missing.length === 0 ? EXIT.ok : EXIT.runFailed;
}

// ── full-run ─────────────────────────────────────────────────────────

let interruptSignal = null;
let interruptAtUtc = null;
let activeChild = null; // exact owned child handle of the current producer

function installInterruptHandlers() {
  const onSignal = (sig) => {
    if (interruptSignal !== null) return; // settle once
    interruptSignal = sig;
    interruptAtUtc = isoUtc();
    // Best-effort: stop the exact owned child of the in-flight producer. The
    // child close resolves the in-flight promise, the loop then observes the
    // interrupt and marks the cell interrupted (never green).
    if (activeChild !== null && activeChild.exitCode === null && activeChild.signalCode === null) {
      const child = activeChild;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      // SIGKILL fallback bounded by TERM_GRACE_MS; cleared on child close so
      // a promptly-exiting child does not hold the event loop open for the
      // whole grace window.
      const killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, TERM_GRACE_MS);
      child.once("close", () => clearTimeout(killTimer));
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

function interruptedExitCode() {
  if (interruptSignal === "SIGINT") return EXIT.interruptedSigint;
  if (interruptSignal === "SIGTERM") return EXIT.interruptedSigterm;
  return EXIT.runFailed;
}

function producerAbsPath(producer) {
  return path.isAbsolute(producer.file) ? producer.file : path.join(REPO_ROOT, producer.file);
}

function resolveManifest(opts) {
  if (opts.manifestEnv === null) {
    return { source: "builtin", producers: CORE_CELLS_MEMBERSHIP.producers };
  }
  let raw;
  try {
    raw = fs.readFileSync(opts.manifestEnv, "utf8");
  } catch (err) {
    return { error: `cannot read TT_CORE_CELLS_MANIFEST ${opts.manifestEnv}: ${describeSpawnError(err)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `TT_CORE_CELLS_MANIFEST ${opts.manifestEnv} is not valid JSON: ${describeSpawnError(err)}` };
  }
  const verdict = validateOverrideManifest(parsed);
  if (!verdict.ok) {
    return { error: `TT_CORE_CELLS_MANIFEST ${opts.manifestEnv} refused: ${verdict.errors.join("; ")}` };
  }
  return { source: `override:${opts.manifestEnv}`, producers: parsed.producers };
}

function buildProducerEnv(envRoot, producerId) {
  const base = path.join(envRoot, producerId);
  const home = path.join(base, "home");
  const tmp = path.join(base, "tmp");
  const state = path.join(base, "state");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmp,
    TAMANDUA_STATE_DIR: state,
    TAMANDUA_DB_PATH: path.join(state, "tamandua.db"),
    TAMANDUA_TEST_GUARD: "1",
  };
  for (const k of ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

async function runOneProducer(producer, ctx) {
  const id = producer.id;
  const abs = producerAbsPath(producer);
  const cellDir = path.join(ctx.evidenceRoot, "cells", id);
  fs.mkdirSync(cellDir, { recursive: true });
  const logPath = path.join(cellDir, "producer.log");
  const logFileRel = path.join("cells", id, "producer.log");
  const resultFileRel = path.join("cells", id, "cell-result.json");
  const env = buildProducerEnv(ctx.envRoot, id);
  const baseResult = {
    id,
    kind: producer.kind,
    scope: producer.scope,
    story: producer.story,
    title: producer.title,
    file: abs,
    cellIds: producer.cells.map((c) => c.id),
    host: os.hostname(),
    gitHead: ctx.gitHead,
    gitTree: ctx.gitTree,
    gitSnapshotAtUtc: ctx.gitSnapshotAtUtc,
    resultFile: resultFileRel,
    logFile: logFileRel,
  };

  if (!fs.existsSync(abs)) {
    return { ...baseResult, status: "missing", pid: null, argv: null, startUtc: null, endUtc: null, elapsedMs: null, exitCode: null, signal: null, tap: null, logFile: null, error: `producer file not found: ${abs}` };
  }

  let argv;
  if (producer.kind === "gate") {
    const gateEvidenceDir = path.join(cellDir, "gate-evidence");
    argv = [process.execPath, abs, "--evidence-dir", gateEvidenceDir];
  } else {
    argv = [process.execPath, "--test", "--test-reporter=tap", abs];
  }

  const startUtc = isoUtc();
  const startMs = Date.now();
  activeChild = null;
  const result = await new Promise((resolve) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log = fs.createWriteStream(logPath, { flags: "w" });
    const child = spawn(argv[0], argv.slice(1), { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let stdoutText = "";
    child.stdout.on("data", (chunk) => {
      stdoutText += chunk.toString("utf8");
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      log.write(chunk);
    });
    child.on("error", (err) => {
      try {
        log.end();
      } catch {
        /* noop */
      }
      resolve({ ok: false, error: describeSpawnError(err), exitCode: null, signal: null, pid: child.pid ?? null });
    });
    child.on("close", (code, signal) => {
      try {
        log.end();
      } catch {
        /* noop */
      }
      resolve({ ok: true, exitCode: code, signal, stdoutText, pid: child.pid ?? null });
    });
  });

  const endUtc = isoUtc();
  const elapsedMs = Date.now() - startMs;

  let status;
  if (!result.ok) status = "red"; // spawn error: a failed producer, never green
  else if (interruptSignal !== null && result.signal !== null) status = "interrupted";
  else if (interruptSignal !== null && result.exitCode !== null) status = "interrupted";
  else if (result.exitCode === 0) status = "green";
  else status = "red";

  return {
    ...baseResult,
    status,
    pid: result.pid,
    argv,
    startUtc,
    endUtc,
    elapsedMs,
    exitCode: result.exitCode,
    signal: result.signal,
    tap: producer.kind === "node-test" && result.ok ? parseTapCounts(result.stdoutText) : null,
    error: result.error ?? null,
  };
}

async function runFull(opts) {
  // Manifest resolution happens BEFORE any evidence-root write so an invalid
  // override manifest is refused with zero state effects.
  const manifest = resolveManifest(opts);
  if (manifest.error !== undefined) {
    process.stderr.write(`core-recording-cells: ${manifest.error}\n`);
    return EXIT.usage;
  }

  // The evidence root MUST be absolute: child producers (notably the
  // CORE-MOTOR gate) build sandbox wrapper/launcher paths from it, and a
  // repo-relative root makes those paths resolve against a child daemon's
  // workdir (exec "…: not found" → launch probe failure). Default and
  // user-supplied relative roots are resolved against the current cwd.
  const evidenceRoot = path.resolve(
    opts.evidenceDir ?? path.join(REVIEW_LOGS, `core-cells-${stampUtc()}Z`),
  );
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const envRoot = path.join(evidenceRoot, "producer-env");
  const logPath = path.join(evidenceRoot, "cells-run.log");
  const log = fs.createWriteStream(logPath, { flags: "w" });
  const note = (line) => {
    const text = typeof line === "string" ? line : JSON.stringify(line);
    log.write(`${text}\n`);
    process.stdout.write(`${text}\n`);
  };

  const producers = manifest.producers;

  // Manifest-derived membership numbers (built-in registry or test override).
  const manifestRecordedProducers = producers.filter((p) => p.scope === "recorded");
  const manifestRecordedIds = [];
  for (const p of manifestRecordedProducers) {
    for (const c of p.cells) manifestRecordedIds.push(c.id);
  }
  const manifestExpectedRecordedCells = manifestRecordedIds.length;

  // Preflight ONLY for the built-in membership: the recorded cells and the
  // motor gate execute the real isolated motor through dist/ (built product).
  if (manifest.source === "builtin") {
    const cli = path.join(REPO_ROOT, "dist", "cli", "cli.js");
    const daemon = path.join(REPO_ROOT, "dist", "server", "daemon.js");
    if (!fs.existsSync(cli) || !fs.existsSync(daemon)) {
      log.end();
      process.stderr.write("core-recording-cells: dist/ is not built (dist/cli/cli.js + dist/server/daemon.js required). Run `npm run build` first.\n");
      return EXIT.usage;
    }
  }

  const timingUtcStart = isoUtc();
  const startMs = Date.now();
  const gitHeadStart = gitHead();
  const gitTreeStart = gitTree();
  const gitStatusStart = gitStatusShort();
  const host = os.hostname();

  note(`CORE-CELLS entrypoint full run — ${manifest.source}`);
  note(`repo ${REPO_ROOT} host ${host} node ${process.version}`);
  note(`evidence root ${evidenceRoot}`);
  note(`gitHead ${gitHeadStart ?? "unknown"} gitTree ${gitTreeStart ?? "unknown"} gitTreeDirtyAtStart ${(gitStatusStart ?? []).length > 0}`);
  note(`registered producers ${producers.length} (expected), recorded sub-cells ${manifestExpectedRecordedCells}`);

  installInterruptHandlers();

  const results = [];
  for (const producer of producers) {
    if (interruptSignal !== null) {
      const abs = producerAbsPath(producer);
      results.push({
        id: producer.id,
        kind: producer.kind,
        scope: producer.scope,
        story: producer.story,
        title: producer.title,
        file: abs,
        cellIds: producer.cells.map((c) => c.id),
        host,
        gitHead: gitHeadStart,
        gitTree: gitTreeStart,
        gitSnapshotAtUtc: timingUtcStart,
        status: "unexecuted",
        pid: null,
        argv: null,
        startUtc: null,
        endUtc: null,
        elapsedMs: null,
        exitCode: null,
        signal: null,
        tap: null,
        resultFile: null,
        logFile: null,
        error: `not executed: run interrupted by ${interruptSignal}`,
      });
      continue;
    }
    const res = await runOneProducer(producer, {
      evidenceRoot,
      envRoot,
      gitHead: gitHeadStart,
      gitTree: gitTreeStart,
      gitSnapshotAtUtc: timingUtcStart,
    });
    results.push(res);
    if (res.resultFile) {
      fs.writeFileSync(path.join(evidenceRoot, res.resultFile), `${JSON.stringify(res, null, 2)}\n`, "utf8");
    }
    note(`cell ${res.id.padEnd(24)} ${res.status.padEnd(12)} exit=${res.exitCode ?? "-"} signal=${res.signal ?? "-"} ${res.elapsedMs !== null ? `${res.elapsedMs}ms` : "-"} log=${res.logFile ?? "-"}`);
  }

  const timingUtcEnd = isoUtc();
  const elapsedMs = Date.now() - startMs;
  const gitStatusEnd = gitStatusShort();

  // ── accounting ─────────────────────────────────────────────────────
  const count = (status) => results.filter((r) => r.status === status).length;
  const accounting = {
    expectedProducers: producers.length,
    executedProducers: count("green") + count("red") + count("interrupted"),
    green: count("green"),
    red: count("red"),
    missing: count("missing"),
    interrupted: count("interrupted"),
    unexecuted: count("unexecuted"),
  };

  // Recorded-subcell accounting: a recorded cell is green only when its
  // producer executed green; red/missing/interrupted/unexecuted map 1:1 from
  // the producer outcome. Derived from the ACTUAL manifest in use so override
  // (synthetic) manifests account their own cells.
  const recordedCells = [];
  const recordedCount = { green: 0, red: 0, missing: 0, interrupted: 0, unexecuted: 0 };
  for (const producer of manifestRecordedProducers) {
    const res = results.find((r) => r.id === producer.id);
    if (!res) continue;
    for (const cell of producer.cells) {
      recordedCells.push({ id: cell.id, provenanceRunId: cell.provenanceRunId, producerId: producer.id, status: res.status });
      recordedCount[res.status] = (recordedCount[res.status] ?? 0) + 1;
    }
  }

  const gitTreeDirtyAtStart = (gitStatusStart ?? []).length > 0;
  const gitTreeDirtyAtEnd = (gitStatusEnd ?? []).length > 0;

  const summary = {
    contract: "core-cells-entrypoint-1",
    version: CORE_CELLS_ENTRYPOINT_VERSION,
    manifestVersion: CELL_MANIFEST_VERSION,
    mode: "full",
    argv: process.argv.slice(1),
    repoRoot: REPO_ROOT,
    host,
    node: { execPath: process.execPath, version: process.version },
    manifestSource: manifest.source,
    gitHead: gitHeadStart,
    gitTree: gitTreeStart,
    gitTreeDirtyAtStart,
    gitStatusShortAtStart: gitStatusStart ?? [],
    gitTreeDirtyAtEnd,
    gitStatusShortAtEnd: gitStatusEnd ?? [],
    timingUtcStart,
    timingUtcEnd,
    elapsedMs,
    evidenceRoot,
    membership: {
      expectedProducers: producers.length,
      expectedFoundational: producers.filter((p) => p.scope === "foundational").length,
      expectedRecordedProducers: manifestRecordedProducers.length,
      expectedRecordedCells: manifestExpectedRecordedCells,
      recordedCellIds: manifestRecordedIds,
    },
    accounting,
    recordedCellsAccounting: {
      expectedRecordedCells: manifestExpectedRecordedCells,
      green: recordedCount.green,
      red: recordedCount.red,
      missing: recordedCount.missing,
      interrupted: recordedCount.interrupted,
      unexecuted: recordedCount.unexecuted,
    },
    recordedCells,
    producers: results,
    interrupted: interruptSignal === null ? null : { signal: interruptSignal, atUtc: interruptAtUtc },
    // R4b integration dependency (see header note + impl-tasks/R4b-review-and-operator-safety.md).
    dependencies: {
      perLandingReviewRunner: {
        present: false,
        note: "the checked-in independent per-landing review runner described by R4b US-002 (safe pinned review runner) is NOT yet landed in this checkout — R4b is scoped-task documentation (impl-tasks/R4b-review-and-operator-safety.md). CORE acceptance stays open until that runner exists and this entrypoint is wired into the per-landing review path; no live hooks, no bypass flags.",
      },
    },
    exitCode: 0, // placeholder, filled below
  };

  let exitCode;
  if (interruptSignal !== null) {
    exitCode = interruptedExitCode();
  } else if (accounting.missing > 0 || accounting.red > 0 || accounting.unexecuted > 0 || accounting.green !== accounting.expectedProducers) {
    exitCode = EXIT.runFailed;
  } else {
    exitCode = EXIT.ok;
  }
  summary.exitCode = exitCode;

  fs.writeFileSync(path.join(evidenceRoot, "cells-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  note("");
  note(`result: ${exitCode === 0 ? "ALL GREEN" : exitCode === EXIT.runFailed ? "RED/MISSING/UNEXECUTED — non-green exit" : `INTERRUPTED (${interruptSignal ?? "signal"})`}`);
  note(`accounting: expected ${accounting.expectedProducers} producers | executed ${accounting.executedProducers} | green ${accounting.green} | red ${accounting.red} | missing ${accounting.missing} | interrupted ${accounting.interrupted} | unexecuted ${accounting.unexecuted}`);
  note(`recorded cells: expected ${manifestExpectedRecordedCells} | green ${recordedCount.green} | red ${recordedCount.red} | missing ${recordedCount.missing} | interrupted ${recordedCount.interrupted} | unexecuted ${recordedCount.unexecuted}`);
  note(`measured elapsed ${elapsedMs} ms (${(elapsedMs / 1000).toFixed(1)} s) — real wall time, no exclusions`);
  note(`summary ${path.join(evidenceRoot, "cells-summary.json")}`);
  note(`full run log ${logPath}`);
  await new Promise((resolve) => log.end(resolve));
  return exitCode;
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(USAGE);
    process.exitCode = EXIT.ok;
    return;
  }
  if (opts.unknown.length > 0) {
    process.stderr.write(`core-recording-cells: unknown option(s): ${opts.unknown.join(" ")}\n`);
    process.stderr.write("Run with --help for usage.\n");
    process.exitCode = EXIT.usage;
    return;
  }
  if (opts.membership) {
    process.exitCode = runMembership();
    return;
  }
  process.exitCode = await runFull(opts);
}

main().catch((err) => {
  process.stderr.write(`core-recording-cells crashed: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exitCode = EXIT.usage;
});
