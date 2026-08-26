// MACP7 US-006 — Red-then-green stale-state hygiene self-test (the guard
// that would have caught MACP7). Zero tokens.
//
// MACP7: stale contained scripted state leaks across campaign attempts. On
// the mac, the first campaign attempt was interrupted, leaving the contained
// scripted state (torture-test/var/home-scripted/.tamandua) with orphaned
// runs; the next attempt's restarted scripted daemon RECOVERED those stale
// runs (the reconciler re-admits any run with status='running'), reserving
// their harness workdir, and the freshly-registered W2 runs collided
// ("control-server: register-run failed ... harness workdir is already
// scheduled"). US-001..US-005 closed the leak (containment-verified
// reset-state, per-cell + per-campaign resets, loud registration-collision
// classification). THIS file is the mechanical guard that would have caught
// MACP7 before it reached the mac: it runs a W2 cell against a contained
// scripted state PRE-SEEDED with a synthetic stale incomplete run and proves
// (a) without the hygiene reset the cell FAILS with the registration-collision
// signature (RED arm), and (b) with the NORMAL harness the cell PASSES with
// the stale run neither resumed nor colliding (GREEN arm) — red-then-green
// proven in ONE run against the SAME synthetic fixture.
//
// ROOT-CAUSE NOTE (why linux proof batteries never tripped this): every
// linux W2 cell always ran to completion, leaving NO orphaned backlog in the
// contained scripted state — a restarted daemon had nothing to recover, so no
// registration ever collided. Only an INTERRUPTED campaign attempt (the mac's
// first attempt, killed mid-run) leaves stale status='running' runs for the
// next attempt's restarted daemon to recover. A stale-incomplete-run fixture
// is therefore REQUIRED to reproduce the class; a clean-state proof battery
// can never trip it.
//
// GRANULARITY DECISION (documented per the task): per-cell reset at scenario-
// harness entry (US-002) is the primary hygiene for the W2/tier1 local cells —
// this file's GREEN arm and campaign leg prove a pre-polluted state is
// rescued by that per-cell reset (the campaign's per-campaign reset, US-003,
// does NOT engage for tier1: it has no scripted WORKFLOW (non-local) cases,
// only the four 'local' W2 cells). The stale fixture here is SYNTHETIC
// (direct SQLite writes: a runs row status='running' scheduling_status='active'
// carrying working_directory_for_harness = the repo root, one steps row, and
// a run-scoped events jsonl) — history-independent, no real runs needed.
//
// Sections:
//   (a) fixture shape (hermetic): the synthetic stale fixture is a valid
//       stale incomplete run (status/scheduling/context/events);
//   (b) RED arm: run scenarios/w2.23a via the scenario harness against the
//       pre-seeded stale state with the hygiene reset BYPASSED (a
//       reset-bypass daemon-control shim through the TT_SCENARIO_TEST_MODE
//       seam) → the cell FAILS with the registration-collision signature
//       (SCRIPTED_RUN_REGISTRATION_FAILED / 'harness workdir is already
//       scheduled'), NOT a generic did-not-reach-terminal timeout;
//   (c) GREEN arm: the SAME fixture through the NORMAL harness → the cell
//       PASSES (exit 0, PASS evidence, terminal status, zero tokens); the
//       stale run id never appears in daemon pi-launched/work-round log
//       lines, the stale row is absent from the post-reset DB, and the fresh
//       run reaches terminal (never colliding);
//   (d) pre-polluted bare tier1 campaign leg: the SAME fixture pre-seeded,
//       then `tt-controller --manifest tier1.jsonl --scripted-only` → the
//       campaign is still GREEN with all four W2 cells PASS and zero tokens;
//   (e) fail-closed containment: a reset target outside torture-test/var is
//       refused (escape target untouched).
//
// Confined to torture-test/ (writes only under gitignored var/). This test
// drives the real scripted daemon on the fixed TT ports (5334/5338/5339), so
// it belongs to the heavy-campaign class and is EXCLUDED from self-tests/
// run.sh's bounded battery; it is executed individually by
// bin/verify-heavy-campaign-tests.test.sh (all three lists — run.sh
// HEAVY_CAMPAIGN_TESTS, the verify script, and e2e-golden-integrity's pinned
// list — stay in lock-step; e2e-golden-integrity AC5 pins it).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const controller = path.join(binDir, "tt-controller");
const daemonControl = path.join(binDir, "daemon-control");
const verifyEnv = path.join(binDir, "tt-verify-environment");
const hostProfilePath = path.join(varRoot, "w0", "host-profile.json");
const MANIFEST = path.join(ttRoot, "cases", "tier1.jsonl");
const harness = path.join(ttRoot, "scenarios", "lib", "run-scripted-scenario");
const envScript = path.join(ttRoot, "env", "tt-env-scripted.sh");
const cliJs = path.join(repoRoot, "dist", "cli", "cli.js");

// The synthetic stale run id — FIXED so the RED and GREEN arms (and the
// campaign leg) exercise the SAME fixture (history-independent, deterministic).
const STALE_RUN_ID = "11111111-2222-4333-8444-555555555555";

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;
const SCRIPTED_PORTS = [5334, 5338, 5339];
const REAL_HARNESSES = new Set(["pi", "hermes", "dsh"]);
const W2_CELLS = [
  { id: "W2.21-admission", dir: "w2.21" },
  { id: "W2.23a-expects-regex", dir: "w2.23a" },
  { id: "W2.23b-retry-step", dir: "w2.23b" },
  { id: "W2.23c-missing-persona", dir: "w2.23c" },
];
// The registration-collision signature this test's RED arm must produce:
// the terminal-wait.mjs marker (US-004), the daemon's register-run failure
// log line, or the admitOrQueueRun "harness workdir is already scheduled"
// throw text (the fresh run's scheduling_error carries that verbatim).
const COLLISION_SIGNATURE =
  /SCRIPTED_RUN_REGISTRATION_FAILED|register-run failed|harness workdir is already scheduled/;

type CommandResult = { status: number | null; stdout: string; stderr: string };

// node:test marks descendant processes; the harness and campaigns drive the
// scripted daemon on the fixed TT ports under the gitignored TT home, so
// disable only the live-state guard and drop NODE_TEST_CONTEXT (mirrors
// tier1-w2-darwin-capable-proof.test.ts). /bin/false backstops guard against
// any accidental real model invocation (zero tokens always).
const campaignEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function run(file: string, args: string[], env = campaignEnv, timeout = 300_000, cwd = repoRoot): CommandResult {
  const result = spawnSync(file, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { status: null, stdout: String(result.stdout ?? ""), stderr: `${result.stderr ?? ""}\n[timed out after ${timeout}ms]` };
  }
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function runStreaming(file: string, args: string[], env = campaignEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function gitSnapshot(): string {
  const result = run("git", ["status", "--porcelain", "--untracked-files=all"], process.env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// Quiet-window port convention: the scripted daemon owns 5334/5338/5339; a
// stray one from a concurrent/interrupted run must not poison this proof.
async function assertPortsFree(): Promise<void> {
  for (const port of SCRIPTED_PORTS) {
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error) => reject(new Error(`scripted port ${port} is not free: ${error.message}`)));
      server.listen(port, "127.0.0.1", () => server.close((error) => (error ? reject(error) : resolve())));
    });
  }
}

function ensureHostProfile(): void {
  if (fs.existsSync(hostProfilePath)) return;
  const res = run(verifyEnv, ["--fast", "--json"]);
  assert.equal(res.status, 0, `tt-verify-environment --fast failed:\n${res.stderr}${res.stdout}`);
  assert.ok(fs.existsSync(hostProfilePath), "host-profile.json must be produced");
}

// The scenario command's PASS evidence payload is the LAST stdout line that
// parses as JSON and carries a `result` field (see tier1-w2-darwin-capable-
// proof.test.ts).
function parseEvidence(stdout: string): Record<string, any> {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  let found: Record<string, any> | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "result" in parsed) found = parsed;
    } catch {
      // not a JSON line — ignore
    }
  }
  assert.ok(found, `scenario command must emit a JSON PASS evidence payload; stdout was:\n${stdout}`);
  return found!;
}

// ── Synthetic stale-run fixture ──────────────────────────────────────────
//
// The MACP7 shape, history-independent: a previous campaign attempt left an
// incomplete run in the contained scripted state. Direct SQLite writes into
// var/home-scripted/.tamandua/tamandua.db (the schema is created by the REAL
// product CLI under the scripted env — `workflow runs --json` runs migrate()
// — never hand-rolled DDL), plus a run-scoped events jsonl.
//
//   runs:  status='running', scheduling_status='active', context carrying
//          working_directory_for_harness = the repo root (the workdir the
//          W2 cells' fresh runs will also request → the collision), tokens 0.
//   steps: one do-now step (agent do-now_doer) so requiredTimersForRun > 0 —
//          the reconciler admits the stale run and reserves its workdir.
//   events: <stateDir>/events/<staleId>.jsonl — the run-scoped events file.
//
// Returns the scripted state dir (var/home-scripted/.tamandua).
function seedStaleFixture(): string {
  const envOut = run("bash", [envScript, "print"], process.env);
  assert.equal(envOut.status, 0, envOut.stderr);
  const scriptedEnv: NodeJS.ProcessEnv = { ...campaignEnv };
  for (const line of envOut.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq > 0) scriptedEnv[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const stateDir = String(scriptedEnv.TAMANDUA_STATE_DIR);
  const dbPath = path.join(stateDir, "tamandua.db");
  assert.ok(stateDir.startsWith(path.join(varRoot, "home-scripted")),
    `fixture state dir must be the contained scripted state: ${stateDir}`);

  // 1. Known-clean base THROUGH the sanctioned containment choke-point
  //    (never ad-hoc rm): tolerant stop, then the real reset-state.
  run(daemonControl, ["scripted", "stop"], process.env);
  const reset = run(daemonControl, ["scripted", "reset-state"], process.env);
  assert.equal(reset.status, 0, `fixture reset-state failed:\n${reset.stdout}\n${reset.stderr}`);

  // 2. Create the full product schema under the scripted env (runs migrate()).
  const schema = run(process.execPath, [cliJs, "workflow", "runs", "--json"], scriptedEnv);
  assert.equal(schema.status, 0, `schema creation failed:\n${schema.stdout}\n${schema.stderr}`);
  assert.ok(fs.existsSync(dbPath), `schema DB must exist: ${dbPath}`);

  // 3. Insert the stale run + steps rows (direct SQLite writes).
  const db = new DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();
    const context = JSON.stringify({
      task: "stale run from a previous campaign attempt (synthetic fixture)",
      workspace_mode: "direct",
      no_hurry_save_tokens_mode: "false",
      harness_type: "pi",
      no_relaunch_upon_rugpull: "false",
      repo: repoRoot,
      working_directory_for_harness: repoRoot,
    });
    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                         scheduling_status, scheduling_requested_at, created_at, updated_at)
       VALUES (?, 1, 'do-now', ?, 'running', ?, 0, 'active', ?, ?, ?)`,
    ).run(STALE_RUN_ID, "stale run from a previous campaign attempt (synthetic fixture)", context, now, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
                          status, retry_count, max_retries, type, loop_config, created_at, updated_at)
       VALUES (?, ?, 'execute', 'do-now_doer', 0, ?, 'STATUS: done', 'running', 0, 4, 'single', NULL, ?, ?)`,
    ).run(createHash("sha256").update(STALE_RUN_ID).digest("hex").slice(0, 32), STALE_RUN_ID,
      "execute the stale task", now, now);
  } finally {
    db.close();
  }

  // 4. Run-scoped events jsonl (the run bookkeeping artifact the daemon would
  //    have written for the stale run).
  const eventsDir = path.join(stateDir, "events");
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.writeFileSync(
    path.join(eventsDir, `${STALE_RUN_ID}.jsonl`),
    `{"ts":"${new Date().toISOString()}","event":"run.started","runId":"${STALE_RUN_ID}","workflowId":"do-now","detail":"stale run from a previous campaign attempt (synthetic fixture)"}\n`,
    "utf8",
  );

  return stateDir;
}

// Post-run hygiene assertions shared by the heavy arms: the scripted daemon
// must be stopped (the harness/campaign stops it), ports free, git tree
// untouched.
async function assertQuietWindow(label: string, before: string): Promise<void> {
  const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
  assert.equal(daemonStatus.status, 0, `${label}: daemon-control status failed:\n${daemonStatus.stderr}`);
  assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m, `${label}: scripted daemon must be stopped`);
  await assertPortsFree();
  assert.equal(gitSnapshot(), before, `${label} changed git status`);
}

// The RED arm's reset-bypass daemon-control shim: through the harness's
// TT_SCENARIO_TEST_MODE seam, `reset-state` is a NO-OP (the stale fixture
// survives into the daemon start) while every other operation delegates to
// the real daemon-control — so the REAL scripted daemon starts against the
// stale DB and the reconciler recovers the stale run. The shim's `start`
// additionally waits for the stale run's admission (workdir reserved) so the
// cell's fresh registration DETERMINISTICALLY collides instead of racing the
// reconciler's first tick. Returns the shim path (a temp executable).
function writeResetBypassShim(stateDir: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "us006-red-shim-"));
  const shim = path.join(dir, "daemon-control");
  fs.writeFileSync(shim, `#!/usr/bin/env bash
# RED-arm reset-bypass shim (tier1-macp7-scripted-state-hygiene US-006):
# reset-state is a NO-OP (the pre-seeded stale fixture must survive into the
# daemon start); every other operation delegates to the real daemon-control.
REAL_DC="${daemonControl}"
STALE_ID="${STALE_RUN_ID}"
LOG_FILE="${stateDir}/tamandua.log"
if [ "\${1:-}" = "scripted" ] && [ "\${2:-}" = "reset-state" ]; then
  echo "reset-state BYPASSED (US-006 RED arm)" >&2
  exit 0
fi
if [ "\${1:-}" = "scripted" ] && [ "\${2:-}" = "start" ]; then
  "\$REAL_DC" scripted start || exit \$?
  # Wait until the stale run is ADMITTED (its workdir reserved) so the cell's
  # fresh registration deterministically collides.
  for i in \$(seq 1 90); do
    if [ -f "\$LOG_FILE" ] && grep "register-run admitted" "\$LOG_FILE" | grep -q "\$STALE_ID"; then
      exit 0
    fi
    sleep 1
  done
  echo "US-006 RED arm: stale run \$STALE_ID was not admitted within 90s" >&2
  exit 1
fi
exec "\$REAL_DC" "\$@"
`, "utf8");
  fs.chmodSync(shim, 0o755);
  return shim;
}

// ── (a) fixture shape — hermetic, no daemon ──────────────────────────────
it("US-006 (a): the synthetic stale fixture is a valid stale incomplete run (status/scheduling/context/events)", () => {
  const before = gitSnapshot();
  try {
    const stateDir = seedStaleFixture();
    const dbPath = path.join(stateDir, "tamandua.db");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let staleRow: any;
    let stepRows: any[] = [];
    let freshCount: number;
    try {
      staleRow = db.prepare(
        "SELECT id, status, scheduling_status, context, tokens_spent FROM runs WHERE id = ?",
      ).get(STALE_RUN_ID);
      stepRows = db.prepare("SELECT run_id, agent_id FROM steps WHERE run_id = ?").all(STALE_RUN_ID) as any[];
      freshCount = (db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c;
    } finally {
      db.close();
    }
    assert.ok(staleRow, "the stale run row must exist");
    assert.equal(staleRow.status, "running", "stale run must look incomplete (status='running')");
    assert.equal(staleRow.scheduling_status, "active", "stale run must be scheduling-active");
    assert.equal(staleRow.tokens_spent, 0, "stale run must have spent zero tokens");
    const ctx = JSON.parse(staleRow.context);
    assert.equal(ctx.working_directory_for_harness, repoRoot,
      "stale run context must carry the harness workdir = the repo root (the collision key)");
    assert.equal(ctx.workspace_mode, "direct");
    assert.equal(ctx.harness_type, "pi");
    assert.ok(stepRows.length >= 1 && stepRows[0].run_id === STALE_RUN_ID,
      "stale run must carry at least one steps row (requiredTimersForRun > 0)");
    assert.equal(freshCount, 1, "fixture DB must contain ONLY the synthetic stale run");
    assert.ok(fs.existsSync(path.join(stateDir, "events", `${STALE_RUN_ID}.jsonl`)),
      "stale run must carry a run-scoped events jsonl");
  } finally {
    assert.equal(gitSnapshot(), before, "(a) changed git status");
  }
});

// ── (e) fail-closed containment — hermetic, no daemon ────────────────────
it("US-006 (e): a reset target outside torture-test/var is refused (fail closed, escape target untouched)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "us006-reset-"));
  try {
    const escapeDir = path.join(tmp, "escape-target");
    fs.mkdirSync(path.join(escapeDir, ".tamandua"), { recursive: true });
    fs.writeFileSync(path.join(escapeDir, ".tamandua", "sentinel.txt"), "escape sentinel\n");
    // Fake escaping scripted env (TT_DC_ENV_SCRIPTED seam): TAMANDUA_STATE_DIR
    // escapes torture-test/var — the REAL guard_kind_containment choke-point
    // must refuse before any destructive work.
    const fakeEnv = path.join(tmp, "fake-env-scripted.sh");
    fs.writeFileSync(fakeEnv, `#!/usr/bin/env bash
if [ "\${1:-}" = "print" ]; then
  printf 'TT_REPO_ROOT=%s\\n' '${tmp}'
  printf 'TT_ROOT=%s\\n' '${tmp}/torture-test/var'
  printf 'HOME=%s\\n' '${tmp}/escape-home'
  printf 'TAMANDUA_STATE_DIR=%s\\n' '${escapeDir}/.tamandua'
  printf 'TAMANDUA_CONTROL_PORT=5339\\n'
  printf 'TAMANDUA_MCP_PORT=5338\\n'
  printf 'TAMANDUA_DASHBOARD_PORT=5334\\n'
  printf 'PATH=%s\\n' "$PATH"
fi
`, "utf8");
    fs.chmodSync(fakeEnv, 0o755);

    const res = run(daemonControl, ["scripted", "reset-state"],
      { ...process.env, TT_DC_ENV_SCRIPTED: fakeEnv });
    assert.notEqual(res.status, 0, `escaping reset-state must be refused:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /escapes torture-test\/var|production guard tripped/,
      `refusal must name the containment escape:\n${res.stderr}`);
    assert.equal(fs.readFileSync(path.join(escapeDir, ".tamandua", "sentinel.txt"), "utf8"),
      "escape sentinel\n", "the escape-path target must be untouched by the refused reset");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── (b) RED arm ──────────────────────────────────────────────────────────
it("US-006 (b): RED — w2.23a against the pre-seeded stale state WITH the hygiene reset bypassed FAILS with the registration-collision signature", { timeout: 30 * 60 * 1000 }, async () => {
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();
  const before = gitSnapshot();
  ensureHostProfile();

  // Pre-seed the stale fixture, then run the harness with a reset-bypass
  // daemon-control shim (TT_SCENARIO_TEST_MODE seam) so the stale state
  // survives into the real daemon start.
  const stateDir = seedStaleFixture();
  const shim = writeResetBypassShim(stateDir);
  const redEnv: NodeJS.ProcessEnv = {
    ...campaignEnv,
    TT_SCENARIO_TEST_MODE: "1",
    TT_SCENARIO_DAEMON_CONTROL: shim,
  };

  let result: CommandResult;
  try {
    result = run(harness, ["scenarios/w2.23a"], redEnv, 15 * 60 * 1000, ttRoot);
  } finally {
    fs.rmSync(path.dirname(shim), { recursive: true, force: true });
  }

  // The cell must FAIL (never a green pass) with the registration-collision
  // signature — NOT a generic did-not-reach-terminal timeout burned minutes
  // later (the register-run failure class surfaces immediately).
  assert.notEqual(result.status, 0,
    `RED arm: cell must FAIL against the stale fixture (reset bypassed):\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout + result.stderr, COLLISION_SIGNATURE,
    `RED arm: failure must carry the registration-collision signature:\n${result.stdout}\n${result.stderr}`);
  // And the failure must be LOUD/IMMEDIATE: the fresh run is never a terminal
  // run, so the cell must NOT have spent the full terminal-wait budget.
  assert.ok(!/did not reach terminal state within/.test(result.stderr),
    `RED arm: must fail via the collision, not a generic timeout:\n${result.stderr}`);

  await assertQuietWindow("RED arm", before);
});

// ── (c) GREEN arm ────────────────────────────────────────────────────────
it("US-006 (c): GREEN — the SAME fixture through the NORMAL harness PASSES; the stale run is neither resumed nor colliding", { timeout: 30 * 60 * 1000 }, async () => {
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();
  const before = gitSnapshot();
  ensureHostProfile();

  // Same fixture, NORMAL harness: the per-cell reset (US-002) wipes the stale
  // state at harness entry, so the daemon starts clean and the cell passes.
  const stateDir = seedStaleFixture();

  const result = run(harness, ["scenarios/w2.23a"], campaignEnv, 15 * 60 * 1000, ttRoot);
  assert.equal(result.status, 0, `GREEN arm: cell must PASS through the normal harness:\n${result.stdout}\n${result.stderr}`);

  const evidence = parseEvidence(result.stdout);
  assert.equal(evidence.result, "PASS", `GREEN arm: cell evidence must be PASS — ${JSON.stringify(evidence)}`);
  assert.equal(evidence.tokens_spent, 0, "GREEN arm: cell evidence must record zero tokens spent");
  assert.equal(evidence.system_tokens_spent, 0, "GREEN arm: cell evidence must record the zero system-token tripwire");
  assert.ok(typeof evidence.terminal_status === "string" && evidence.terminal_status.length > 0,
    "GREEN arm: cell evidence must record a terminal status (the fresh run reached terminal)");

  // GREEN assertions: the stale run is neither resumed nor colliding.
  const logPath = path.join(stateDir, "tamandua.log");
  const daemonLog = fs.readFileSync(logPath, "utf8");
  const staleInLogLines = daemonLog.split(/\r?\n/).filter((line) => line.includes(STALE_RUN_ID));
  assert.equal(staleInLogLines.length, 0,
    `GREEN arm: the stale run id must never appear in the daemon log (it was reset before the daemon started):\n${staleInLogLines.join("\n")}`);
  assert.ok(!daemonLog.split(/\r?\n/).some((line) =>
    line.includes(STALE_RUN_ID) && /pi launched|Work round/.test(line)),
    "GREEN arm: no daemon pi-launched / work-round log line may reference the stale run id");

  const db = new DatabaseSync(path.join(stateDir, "tamandua.db"), { readOnly: true });
  let staleRow: any;
  try {
    staleRow = db.prepare("SELECT id FROM runs WHERE id = ?").get(STALE_RUN_ID);
  } finally {
    db.close();
  }
  assert.equal(staleRow, undefined, "GREEN arm: the stale row must be absent from the post-reset DB");

  // T2.2 US-005: the per-cell reset -> full-catalog install must leave the
  // FULL bundled catalog in the scripted home, so a subsequent
  // controller-launched workflow case (e.g. W4.39-a's
  // bug-fix-merge-worktree) resolves after this scenario-harness cell.
  const afterWorkflows = path.join(stateDir, "workflows");
  for (const wf of ["do-now", "bug-fix-merge-worktree"]) {
    assert.ok(fs.existsSync(path.join(afterWorkflows, wf, "workflow.yml")),
      `GREEN arm: the full catalog must remain installed after the cell (missing ${wf}/workflow.yml)`);
  }

  await assertQuietWindow("GREEN arm", before);
});

// ── (d) pre-polluted bare tier1 campaign leg ─────────────────────────────
it("US-006 (d): pre-polluted bare tier1 campaign — pre-seeded stale fixture, tt-controller --scripted-only stays GREEN with all four W2 cells PASS", { timeout: 90 * 60 * 1000 }, async () => {
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();
  const before = gitSnapshot();
  const originalHash = sha256(MANIFEST);
  ensureHostProfile();

  // The campaign starts with the contained scripted state PRE-POLLUTED by
  // the same synthetic stale fixture. tier1 has only 'local' scripted cells
  // (no scripted WORKFLOW cases), so the per-campaign reset (US-003) does
  // NOT engage — the per-cell reset (US-002) is what must rescue it.
  const stateDir = seedStaleFixture();

  let result!: CommandResult;
  let campaignId: string | null = null;
  try {
    result = await runStreaming(controller, ["--manifest", MANIFEST, "--scripted-only"], campaignEnv);
    const m = CAMPAIGN_LINE.exec(result.stdout);
    campaignId = m === null ? null : m[1];
    assert.ok(campaignId, `pre-polluted bare tier1 campaign did not print a campaign ID:\n${result.stdout}\n${result.stderr}`);
    const campaignDir = path.join(resultsRoot, campaignId);
    const state = loadJson(path.join(campaignDir, "state.json"));
    const report = loadJson(path.join(campaignDir, "report.json"));

    assert.equal(state.options.execution_selection, "scripted-only", "campaign must run bare");

    const realCases = state.cases.filter((c: any) => REAL_HARNESSES.has(String(c.harness)));
    const scriptedCases = state.cases.filter((c: any) => !REAL_HARNESSES.has(String(c.harness)));
    assert.equal(realCases.length, 24, "bare tier1 must contain 24 pending-real pi/hermes cells");
    assert.equal(scriptedCases.length, 4, "bare tier1 must contain 4 scripted local cells");

    // All four W2 cells EXECUTE and PASS — never NOT_RUN, never colliding.
    for (const cell of W2_CELLS) {
      const cs = scriptedCases.find((c: any) => c.id === cell.id);
      assert.ok(cs, `state must contain ${cell.id}`);
      assert.equal(cs.outcome, "PASS", `${cell.id} must PASS against the pre-polluted state — ${JSON.stringify(cs.reason ?? {})}`);
      assert.ok(Array.isArray(cs.attempts) && cs.attempts.length > 0,
        `${cell.id} must have executed (attempts > 0) — never NOT_RUN(predicate)`);
      assert.equal(cs.spend?.tokens_observed ?? 0, 0, `${cell.id} must spend zero tokens`);
    }
    for (const cs of realCases) {
      assert.equal(cs.outcome, "NOT_RUN", `${cs.id} must remain pending-real in bare mode`);
      assert.equal(cs.reason?.category, "pending-real", `${cs.id} pending-real category required`);
    }

    // Campaign-level: GREEN exit 0, vacuity silent, zero tokens, manifest
    // untouched — the pre-polluted campaign is STILL green.
    assert.equal(result.status, 0, `pre-polluted bare tier1 must exit 0 (GREEN):\n${result.stdout}\n${result.stderr}`);
    assert.equal(report.verdict, "GREEN", `report must be GREEN:\n${result.stdout}\n${result.stderr}`);
    assert.equal(report.exit_code, 0, "report must carry exit code 0");
    assert.equal(report.vacuity.triggered, false, "vacuity guard must be silent (4 cells executed)");
    assert.equal(report.spend.tokens_observed, 0, "campaign must be zero-token");
    assert.equal(sha256(MANIFEST), originalHash, "original tier1.jsonl must be untouched");

    // The stale fixture was consumed by the per-cell resets: no scheduler
    // work for the stale id anywhere in the final daemon log, and no stale
    // row in the final DB.
    const logPath = path.join(stateDir, "tamandua.log");
    if (fs.existsSync(logPath)) {
      const daemonLog = fs.readFileSync(logPath, "utf8");
      assert.ok(!daemonLog.split(/\r?\n/).some((line) =>
        line.includes(STALE_RUN_ID) && /pi launched|Work round/.test(line)),
        "campaign: no daemon pi-launched / work-round log line may reference the stale run id");
    }
    const db = new DatabaseSync(path.join(stateDir, "tamandua.db"), { readOnly: true });
    let staleRow: any;
    try {
      staleRow = db.prepare("SELECT id FROM runs WHERE id = ?").get(STALE_RUN_ID);
    } finally {
      db.close();
    }
    assert.equal(staleRow, undefined, "campaign: the stale row must be absent from the post-campaign DB");
  } finally {
    if (campaignId !== null) {
      fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
  }

  await assertQuietWindow("pre-polluted campaign", before);
});
