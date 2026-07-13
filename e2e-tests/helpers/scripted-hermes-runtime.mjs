/**
 * Scripted-hermes runtime — a deterministic stand-in for the `hermes` binary.
 *
 * The agent scheduler invokes this exactly like hermes:
 *   fake-hermes chat --max-turns 8192 --yolo -Q -q "<work prompt>"
 *
 * Unlike the pi runtime which emits JSON events, this runtime emits PLAIN TEXT
 * stdout (the STATUS report text) with a trailing `session_id: <uuid>` line.
 * It also creates a fake $HERMES_HOME/state.db so the token-accounting path
 * (hermes-usage.ts → lookupHermesSessionTokens) can read token counts.
 *
 * Work protocol (shared with scripted-agent-runtime.mjs):
 *   1. Parse workflow/agent/run IDs and the tamandua CLI path from the prompt
 *   2. Defensive `step peek` — NO_WORK here is a motor bug or race; journaled
 *      as "heartbeat" and answered with NO_WORK_AVAILABLE
 *   3. Run `step claim`, look up this agent's scripted behavior, apply file
 *      edits / shell commands in the harness workdir, then report via
 *      `step complete` / `step fail`
 *   4. Write fake session row to $HERMES_HOME/state.db with configurable token
 *      counts so the scheduler can attribute per-round tokens
 *
 * Behaviors come from a JSON file (TAMANDUA_SCRIPTED_BEHAVIORS), keyed by the
 * short agent id. Same format as the pi runtime.
 *
 * Chaos modes (behavior.mode): "work" (default), "hang", "hang-after-claim",
 * "die-before-claim", "die-after-claim", "no-status", "garbage".
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  parsePrompt,
  createCli,
  peekStep,
  claimStep,
  completeStep,
  failStep,
  loadBehaviors,
  behaviorForInvocation as sharedBehaviorForInvocation,
  nextWorkIndex as sharedNextWorkIndex,
  parseInputVars,
  substitute as sharedSubstitute,
  logInvocation as sharedLogInvocation,
  fatal as sharedFatal,
  applyBehaviorActions,
} from "./scripted-agent-runtime-shared.mjs";

// ── Hermes argv parsing ────────────────────────────────────────────
// argv: chat --max-turns 8192 --yolo -Q -q "<prompt>"
// The prompt is the LAST argument (verbatim, may contain spaces).
// We don't validate the exact sequence — hermes adheres to this contract.
const prompt = process.argv[process.argv.length - 1] ?? "";

const behaviorsPath = process.env.TAMANDUA_SCRIPTED_BEHAVIORS ?? "";
const stateDir = process.env.TAMANDUA_SCRIPTED_STATE ?? "";

// ── State-dir logging (test diagnostics) ────────────────────────────

function logInvocation(entry) {
  sharedLogInvocation(stateDir, entry);
}

function fatal(note) {
  sharedFatal(stateDir, "scripted-hermes", note);
}

// ── Hermes output emission (plain text, no JSON) ────────────────────
//
// Unlike the pi runtime which emits pi-shaped JSON events
// (tool_execution_end, message_end), the hermes runtime emits PLAIN TEXT
// stdout — just the STATUS report. Token attribution happens via the
// session_id trailer + state.db row, not via inline JSON events.

/**
 * Write the completed output to stdout followed by a session_id trailer
 * on stderr. Real hermes prints the session_id trailer to stderr (verified
 * in hermes source: cli.py ~line 16064 uses file=sys.stderr).
 *
 * stdout ← STATUS report plain text
 * stderr ← session_id: <uuid>
 *
 * The harness adapter extracts sessionRef from stderr and strips
 * session_id lines from stdout for backward compat.
 */
function emitOutput(text, sessionId) {
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
  process.stderr.write(`session_id: ${sessionId}\n`);
}

// ── Fake state.db for token accounting ──────────────────────────────
//
// The scheduler calls lookupHermesSessionTokens(sessionRef, env) after each
// round. That function opens $HERMES_HOME/state.db read-only and reads
// input_tokens + output_tokens + cache_read_tokens + cache_write_tokens for
// the session row. We must write the row BEFORE exiting so it is available
// (HermesHarnessAdapter waits for the child to exit before reading the DB).

const SESSIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at REAL NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  estimated_cost_usd REAL
) STRICT
`;

/**
 * Create the fake state.db (if missing) and insert a session row with the
 * given token counts. Never throws — silently degrades on any failure so
 * the token-degradation scenario ($HERMES_HOME with no writeable dir) is
 * supported.
 */
function writeSessionRow(sessionId, tokens) {
  try {
    const hermesHome = process.env.HERMES_HOME;
    if (!hermesHome) {
      // No HERMES_HOME set — token attribution degrades (null).
      logInvocation({ phase: "token-db", note: "HERMES_HOME not set, skipping state.db write" });
      return;
    }

    fs.mkdirSync(hermesHome, { recursive: true });
    const dbPath = path.join(hermesHome, "state.db");

    const db = new DatabaseSync(dbPath);
    try {
      db.exec(SESSIONS_TABLE_SQL);

      // Distribute totalTokens across input/output for a realistic-looking row.
      // Default: input=100, output=11 → total=111 (matches DEFAULT_CONFIG.defaultTokens).
      const inputTokens = Math.max(0, tokens - 11);
      const outputTokens = tokens > 0 ? Math.min(tokens, 11) : 0;

      db.prepare(
        `INSERT INTO sessions
           (id, source, started_at, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0.0)`,
      ).run(sessionId, "scripted-hermes", Date.now() / 1000, inputTokens, outputTokens);

      logInvocation({ phase: "token-db", note: `wrote session ${sessionId} with totalTokens=${tokens}` });
    } finally {
      db.close();
    }
  } catch (err) {
    // Degrade gracefully — the token-accounting path will return null.
    logInvocation({
      phase: "token-db",
      note: `state.db write failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ── Parse the work prompt ───────────────────────────────────────────
//
// The header line is `... workflow "X", agent "Y", run "Z"` and the CLI
// path comes from the `step claim` command line. Same format as pi.

const parsed = parsePrompt(prompt);
if (!parsed) {
  fatal(`could not parse workflow/agent/run from prompt: ${prompt.slice(0, 200)}`);
}
const { workflowId, agentId, runId, cliPath, shortAgent } = parsed;

const cli = createCli(cliPath);

// ── Behaviors config ────────────────────────────────────────────────

const config = loadBehaviors(behaviorsPath);

function behaviorForInvocation(index) {
  return sharedBehaviorForInvocation(config, agentId, shortAgent, index);
}

function nextWorkIndex() {
  return sharedNextWorkIndex(stateDir, shortAgent);
}

// ── Placeholder substitution ────────────────────────────────────────
// {{cwd}} → harness workdir; {{input.KEY}} → "KEY: value" line from step input

function substitute(text, inputVars) {
  return sharedSubstitute(text, process.cwd(), inputVars);
}

// ── Main ────────────────────────────────────────────────────────────

const base = {
  workflowId,
  agentId,
  shortAgent,
  runId,
  cwd: process.cwd(),
  jobId: process.env.TAMANDUA_WORKER_JOB_ID ?? null,
};

// Phase 1: defensive peek (same as pi runtime).
const peek = peekStep(cli, agentId, runId);
const peekOut = `${peek.stdout}\n${peek.stderr}`;
if (peek.status !== 0) {
  logInvocation({ ...base, phase: "error", note: `step peek exited ${peek.status}: ${peekOut.slice(0, 500)}` });
  fatal(`step peek failed (exit ${peek.status})`);
}

if (peekOut.includes("NO_WORK")) {
  logInvocation({ ...base, phase: "heartbeat", note: "spawned without pending work" });
  const sessionId = crypto.randomUUID();
  // Heartbeat: no state.db write (zero-token round).
  emitOutput("NO_WORK_AVAILABLE", sessionId);
  process.exit(0);
}
if (!peekOut.includes("HAS_WORK")) {
  logInvocation({ ...base, phase: "error", note: `unrecognized peek output: ${peekOut.slice(0, 500)}` });
  fatal("unrecognized step peek output");
}

// Phase 2: work
const workIndex = nextWorkIndex();
const behavior = behaviorForInvocation(workIndex);
const mode = behavior?.mode ?? "work";
const tokens = behavior?.tokens ?? config.defaultTokens;
const work = { ...base, phase: "work", workIndex, mode };

if (behavior === undefined) {
  // Work arrived for an agent the test did not script: fail the run fast.
  const claim = claimStep(cli, agentId, runId);
  const claimed = claim.status === 0 ? JSON.parse(claim.stdout.trim()) : null;
  logInvocation({ ...work, note: "no scripted behavior for this agent", stepId: claimed?.stepId ?? null });
  const sessionId = crypto.randomUUID();
  writeSessionRow(sessionId, tokens);
  emitOutput(`STATUS: failed\nREASON: no scripted behavior for agent "${shortAgent}"`, sessionId);
  if (claimed?.stepId) {
    failStep(cli, claimed.stepId, `scripted-hermes: no behavior configured for agent "${shortAgent}"`);
  }
  process.exit(0);
}

if (mode === "hang") {
  logInvocation({ ...work, note: "hanging until killed" });
  setInterval(() => {}, 1 << 30);
} else if (mode === "die-before-claim") {
  logInvocation({ ...work, note: "exiting before claim" });
  process.exit(behavior.exitCode ?? 3);
} else if (mode === "garbage") {
  logInvocation({ ...work, note: "emitting garbage output" });
  const sessionId = crypto.randomUUID();
  writeSessionRow(sessionId, tokens);
  process.stdout.write("%%% not plain text — scripted garbage output %%%\ngarbage text\n");
  process.stderr.write(`session_id: ${sessionId}\n`);
  process.exit(0);
} else {
  runWorkRound();
}

function runWorkRound() {
  const claim = claimStep(cli, agentId, runId);
  if (claim.status !== 0) {
    logInvocation({ ...work, phase: "error", note: `step claim exited ${claim.status}: ${claim.stderr.slice(0, 500)}` });
    fatal(`step claim failed (exit ${claim.status})`);
  }
  const claimRaw = claim.stdout.trim();
  if (claimRaw.includes("NO_WORK")) {
    logInvocation({ ...base, phase: "heartbeat", note: "claim returned NO_WORK after HAS_WORK peek" });
    const sessionId = crypto.randomUUID();
    emitOutput("NO_WORK_AVAILABLE", sessionId);
    process.exit(0);
  }
  const claimed = JSON.parse(claimRaw);
  const stepId = claimed.stepId;
  const inputVars = parseInputVars(claimed.input ?? "");
  inputVars.RUN_ID = claimed.runId;

  // Log the work round NOW (before step complete may trigger daemon teardown).
  logInvocation({ ...work, stepId, note: "claimed" });

  if (mode === "hang-after-claim") {
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "hanging after claim until killed" });
    setInterval(() => {}, 1 << 30);
    return;
  }

  const failThisStep = (reason) => {
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: reason.slice(0, 500) });
    const sessionId = crypto.randomUUID();
    writeSessionRow(sessionId, tokens);
    emitOutput(`STATUS: failed\nREASON: ${reason.slice(0, 500)}`, sessionId);
    failStep(cli, stepId, reason.slice(0, 1000));
    process.exit(0);
  };

  let actionResult;
  try {
    actionResult = applyBehaviorActions(behavior, process.cwd(), inputVars);
  } catch (err) {
    return failThisStep(`scripted behavior error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (mode === "die-after-claim") {
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "dying after claim without reporting" });
    // Write state.db + session_id to stderr so the adapter can attribute
    // tokens even when the harness is killed after claiming the step.
    const sessionId = crypto.randomUUID();
    writeSessionRow(sessionId, tokens);
    process.stderr.write(`session_id: ${sessionId}\n`);
    process.exit(behavior.exitCode ?? 1);
  }

  const configuredOutput = substitute(behavior.output ?? "STATUS: done", inputVars);
  const outputText = behavior.includeCommandOutput && actionResult.commandOutput
    ? `${actionResult.commandOutput}\n${configuredOutput}`
    : configuredOutput;

  if (mode === "no-status") {
    // Did the work but never reported — the lost-step case.
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "no-status: exiting without step complete" });
    const sessionId = crypto.randomUUID();
    writeSessionRow(sessionId, tokens);
    emitOutput(outputText, sessionId);
    process.exit(0);
  }

  // Hermes output: plain text STATUS report + session_id trailer.
  // Token attribution: the scheduler reads the state.db row via sessionRef.
  const sessionId = crypto.randomUUID();
  writeSessionRow(sessionId, tokens);

  if (behavior.stepAction === "fail") {
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "scripted step fail" });
    emitOutput(outputText, sessionId);
    failStep(cli, stepId, behavior.failReason ?? "scripted failure");
    process.exit(0);
  }

  // reportBeforeEmit: step complete BEFORE emitting output (same semantics as pi).
  if (behavior.reportBeforeEmit) {
    logInvocation({ ...work, phase: "result", stepId, ok: true, note: "reporting step complete before emitting output" });
    const complete = completeStep(cli, stepId, outputText);
    if (complete.status !== 0) {
      logInvocation({
        ...work,
        phase: "result",
        stepId,
        ok: false,
        note: `step complete exited ${complete.status}: ${complete.stderr.slice(0, 300)}`,
      });
    }
    spawnSync("sleep", ["0.3"]);
    emitOutput(outputText, sessionId);
    // Support exitCode in reportBeforeEmit mode: real hermes may be killed
    // (exit 130) after step completion — the adapter still captures stderr
    // and token attribution survives (see US-002/US-003).
    process.exit(behavior.exitCode ?? 0);
  }

  // Default ordering: emit output THEN report (hermes writes before the
  // step-complete tool call finishes, mirroring the pi event ordering).
  emitOutput(outputText, sessionId);

  logInvocation({ ...work, phase: "result", stepId, ok: true, note: "reporting step complete" });
  const complete = completeStep(cli, stepId, outputText);
  if (complete.status !== 0) {
    logInvocation({
      ...work,
      phase: "result",
      stepId,
      ok: false,
      note: `step complete exited ${complete.status}: ${complete.stderr.slice(0, 300)}`,
    });
  }
  process.exit(0);
}
