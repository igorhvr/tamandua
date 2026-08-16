#!/usr/bin/env node
// W4.40 stream-contract torture — shared runner for the four scripted-hermes
// arms (delayed-trailer / oversized-stdout / trailer-absent /
// malformed-trailer).
//
// Each arm is ONE scripted bfmw round against the contained scripted daemon
// launched with --hermes-as-harness (TAMANDUA_HERMES_BINARY -> scripted-hermes
// wrapper) and the arm's behaviors file materialized by run-scripted-scenario
// (TAMANDUA_SCRIPTED_BEHAVIORS keyed to the scenario-unique workflow copy).
//
// The corridor assertions are mechanical, zero-token:
//   (a) delayed-trailer: the hermes session trailer (stderr `session_id:` +
//       $HERMES_HOME/state.db row) arrives ~20s AFTER stdout closes but
//       BEFORE process exit — the adapter must keep reading stderr until the
//       process closes, never race the trailer at stdout-close. Evidence:
//       the run completes, a session row for the run's rounds EXISTS in
//       state.db, and the daemon log has NO "no session_id trailer — tokens
//       will read 0" warning (the ATTRIBUTION_SUSPECT-class diagnostic).
//   (b) oversized-stdout: a 50MB stdout round — no OOM/wedge, the round
//       completes with bounded memory. Evidence: run completes, the adapter's
//       truncation marker is visible in the step output, daemon stays up,
//       zero worker_lost.
//   (c) trailer-absent: attributed 0 with the ATTRIBUTION_SUSPECT-class
//       warning ("no session_id trailer — tokens will read 0") in the daemon
//       log, NO session row written, run outcome unaffected.
//   (d) malformed-trailer: the runtime emits `session_id: NOT-A-UUID` + a
//       bogus state.db row; the parse is logged, never a crash, never
//       silently-plausible garbage tokens. Evidence: run completes, tokens 0,
//       the malformed row EXISTS (id NOT-A-UUID), daemon stays up.
//
// Compact single-line JSON on stdout (tt-controller's parseLocalCommandSummary
// reads the local-case summary per-line). Zero tokens (runs.tokens_spent 0 +
// system tripwire 0).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function requiredValue(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0, `${name} must be set`);
  return value;
}
function requiredPath(name) {
  const value = requiredValue(name);
  assert.ok(path.isAbsolute(value), `${name} must be an absolute path`);
  return value;
}

const [scenarioArg] = process.argv.slice(2);
if (!scenarioArg) throw new Error("usage: run-stream-torture.mjs <scenario-directory>");
const scenarioDir = fs.realpathSync(scenarioArg);
const metadata = JSON.parse(fs.readFileSync(path.join(scenarioDir, "scenario.json"), "utf8"));

const repoRoot = requiredPath("TT_REPO_ROOT");
const invocationDir = requiredPath("TT_SCENARIO_STATE_DIR");
const scenarioId = requiredValue("TT_SCENARIO_ID");
const stateDir = requiredPath("TAMANDUA_STATE_DIR");
const workflowId = requiredValue("TT_SCENARIO_WORKFLOW_ID");
const hermesHome = process.env.HERMES_HOME
  ? path.resolve(process.env.HERMES_HOME)
  : path.join(stateDir, "..", ".hermes");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");
assert.equal(scenarioId, metadata.id, "scenario id mismatch");

const ARM = scenarioId.replace(/^w4\.40-/, ""); // delayed-trailer | oversized-stdout | trailer-absent | malformed-trailer
assert.ok(["delayed-trailer", "oversized-stdout", "trailer-absent", "malformed-trailer"].includes(ARM),
  `unknown W4.40 arm: ${ARM}`);

const cli = path.join(repoRoot, "bin", "tamandua");
const dbPath = path.join(stateDir, "tamandua.db");
const daemonLog = path.join(stateDir, "tamandua.log");
const hermesDbPath = path.join(hermesHome, "state.db");
const fixture = path.join(invocationDir, "fixture");

// ── helpers ──────────────────────────────────────────────────────────

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function git(args, cwd) {
  const result = runSync("git", args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
}

function dbRead(query, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

function dbGet(query, params = []) {
  const rows = dbRead(query, params);
  return rows.length > 0 ? rows[0] : undefined;
}

function hermesSessionCount() {
  if (!fs.existsSync(hermesDbPath)) return 0;
  try {
    const db = new DatabaseSync(hermesDbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS c FROM sessions").get();
      return Number(row.c);
    } finally {
      db.close();
    }
  } catch {
    return 0; // table may not exist yet
  }
}

function daemonLogText(snapshotSize = 0) {
  if (!fs.existsSync(daemonLog)) return "";
  const st = fs.statSync(daemonLog);
  if (st.size <= snapshotSize) return "";
  const fd = fs.openSync(daemonLog, "r");
  try {
    const buf = Buffer.alloc(st.size - snapshotSize);
    fs.readSync(fd, buf, 0, buf.length, snapshotSize);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function runEventsText(runId) {
  const eventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return "";
  return fs.readFileSync(eventsPath, "utf8");
}

function deleteRun(runId) {
  const res = runSync(cli, ["workflow", "delete", `run-${runId}`, "--force"], { timeout: 60_000 });
  assert.equal(res.status, 0, `workflow delete run-${runId} failed:\n${res.stdout}\n${res.stderr}`);
  const del = new DatabaseSync(dbPath);
  try {
    del.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
    del.prepare("DELETE FROM run_worktrees WHERE run_id = ?").run(runId);
    del.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  } finally {
    del.close();
  }
}

// ── fixture (scratch origin whose `npm test` passes; the verifier runs it) ──
fs.mkdirSync(fixture, { recursive: true });
git(["init", "-b", "main"], fixture);
git(["config", "user.email", "w4.40@tamandua.local"], fixture);
git(["config", "user.name", "W4.40 Stream Torture"], fixture);
fs.writeFileSync(path.join(fixture, "package.json"),
  `${JSON.stringify({ name: "w4-40-fixture", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } })}\n`);
fs.writeFileSync(path.join(fixture, "value.txt"), "old\n");
fs.writeFileSync(path.join(fixture, ".gitignore"), ".env\nnode_modules/\n*.key\n*.pem\n");
git(["add", "."], fixture);
git(["commit", "-q", "-m", "baseline"], fixture);

const taskText = `W4.40 ${ARM}: fix the seeded defect in the fixture (stream-contract torture round).`;
const preSessionCount = hermesSessionCount();
const preLogSize = fs.existsSync(daemonLog) ? fs.statSync(daemonLog).size : 0;
const preRunCount = dbRead("SELECT COUNT(*) AS c FROM runs")[0].c;

const launch = runSync(cli, [
  "workflow", "run", workflowId, taskText,
  "--worktree-origin-repository", fixture,
  "--worktree-origin-ref", "main",
  "--hermes-as-harness",
  "--context", "test_cmd=npm test",
  "--wait", "--timeout", "5m", "--json",
], { timeout: 360_000, cwd: fixture });
const launchText = `${launch.stdout}\n${launch.stderr}`;
const runMatch = launchText.match(/^Run:\s+run-([0-9a-f-]+)$/m);
assert.ok(runMatch, `workflow launch did not publish a run id\n${launchText}`);
const runId = runMatch[1];

const runRow = dbGet("SELECT status, tokens_spent FROM runs WHERE id = ?", [runId]);
assert.ok(runRow, `run ${runId} row missing after launch`);
const finalize = dbGet("SELECT status FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'", [runId]);
const system = dbGet("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1");
const appendedLog = daemonLogText(preLogSize);
const runEvents = runEventsText(runId);
const workerLostCount = (runEvents.match(/"event":\s*"step\.worker_lost"/g) ?? []).length;

// Every arm: the run completes (or fails diagnosably per arm), zero tokens.
assert.equal(runRow.tokens_spent, 0, "scripted run tokens must be 0");
assert.equal(system?.system_tokens_spent ?? 0, 0, "system token tripwire must stay 0");
assert.equal(runRow.status, "completed", `run must complete for arm ${ARM} (got ${runRow.status})`);
assert.equal(finalize?.status, "done", "finalize_merge must land the scripted fix");

const noTrailerWarning = /hermes round completed with no session_id trailer/.test(appendedLog);
const postSessionCount = hermesSessionCount();

if (ARM === "delayed-trailer") {
  // The trailer arrives ~20s AFTER stdout closes but BEFORE process exit —
  // the adapter must keep reading until close. No ATTRIBUTION_SUSPECT-class
  // warning may fire, and a session row for the run's rounds must exist.
  assert.equal(noTrailerWarning, false,
    "delayed trailer must NOT trigger the no-session_id-trailer warning (the reader must not race the trailer)");
  assert.ok(postSessionCount > preSessionCount,
    "delayed trailer must eventually persist a session row (tokens still attributed)");
} else if (ARM === "oversized-stdout") {
  // 50MB stdout round: no OOM/wedge — the adapter's head+tail windowing keeps
  // memory bounded and the round completes. The scripted runtime reports the
  // step via its own `step complete` with the CLEAN configured output, so the
  // bounded-memory evidence lives in the ADAPTER's capture: the daemon log
  // must show the round's output was truncated (`hermes round output
  // truncated` with the head/tail windows) — never an OOM/wedge, never a
  // harness kill.
  assert.equal(workerLostCount, 0, "oversized stdout must not wedge the harness (zero worker_lost)");
  assert.match(appendedLog, /hermes round output truncated/,
    "the adapter's bounded-memory truncation must be visible in the daemon log (head+tail windows)");
  assert.match(appendedLog, /"stdoutTruncated":true/,
    "the daemon log must record stdoutTruncated:true for the oversized round");
} else if (ARM === "trailer-absent") {
  // Attributed 0 with the ATTRIBUTION_SUSPECT-class warning; run outcome
  // unaffected; NO session row written.
  assert.equal(noTrailerWarning, true,
    "absent trailer MUST surface the no-session_id-trailer warning (ATTRIBUTION_SUSPECT class)");
  assert.equal(postSessionCount, preSessionCount,
    "absent trailer must write no session row");
} else if (ARM === "malformed-trailer") {
  // Parse failure logged, never a crash, never silently-plausible garbage
  // tokens: the bogus row exists, tokens read 0, daemon stays up.
  let malformedRow = null;
  if (fs.existsSync(hermesDbPath)) {
    const db = new DatabaseSync(hermesDbPath, { readOnly: true });
    try {
      malformedRow = db.prepare("SELECT id, input_tokens, output_tokens FROM sessions WHERE id = ?").get("NOT-A-UUID");
    } finally {
      db.close();
    }
  }
  assert.ok(malformedRow, "malformed trailer must persist its bogus session row (id NOT-A-UUID)");
  assert.equal(Number(malformedRow.input_tokens) + Number(malformedRow.output_tokens), 0,
    "malformed session row must carry zero tokens (never silently-plausible garbage)");
}

deleteRun(runId);

process.stdout.write(`${JSON.stringify({
  scenario_id: metadata.id,
  workflow_id: workflowId,
  run_id: `run-${runId}`,
  arm: ARM,
  run_status: runRow.status,
  tokens_spent: runRow.tokens_spent,
  system_tokens_spent: system?.system_tokens_spent ?? 0,
  session_rows: postSessionCount - preSessionCount,
  no_trailer_warning: noTrailerWarning,
  stdout_truncated: /"stdoutTruncated":true/.test(appendedLog),
  result: "PASS",
})}\n`);
