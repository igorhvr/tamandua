/**
 * Scripted-dsh runtime — a deterministic stand-in for the `dsh` binary.
 *
 * The agent scheduler invokes this exactly like dsh:
 *   fake-dsh --profile headless "<work prompt>"
 *
 * Pinned to the dsh headless contract:
 *   - stdout: EXACTLY the final assistant text plus `\n`, written once at
 *     the end (plain text, no JSON, no streaming, no session trailer)
 *   - stderr: EMPTY on success (`dsh: <code>: <message>` only on failure)
 *   - exit code: 0 on completion, non-zero on failure
 *   - usage: never printed — recorded in the session log at
 *     $DSH_HOME/sessions/<escaped-cwd>/session-<uuid>/session.jsonl.zstd
 *
 * Token attribution: after each work round this runtime writes a fake
 * session.jsonl.zstd (a real zstd-compressed session log) under the temp
 * $DSH_HOME so the scheduler's session-file lookup (dsh-usage.ts →
 * lookupDshSessionTokens) can attribute per-round tokens end to end.
 *
 * Work protocol (shared with scripted-agent-runtime.mjs and
 * scripted-hermes-runtime.mjs):
 *   1. Parse workflow/agent/run IDs and the tamandua CLI path from the prompt
 *   2. Defensive `step peek` — NO_WORK here is a motor bug or race; journaled
 *      as "heartbeat" and answered with NO_WORK_AVAILABLE
 *   3. Run `step claim`, look up this agent's scripted behavior, apply file
 *      edits / shell commands in the harness workdir, then report via
 *      `step complete` / `step fail`
 *   4. Write the fake session log to $DSH_HOME/sessions/<escaped-cwd>/
 *      session-<uuid>/session.jsonl.zstd with configurable token counts
 *
 * Behaviors come from a JSON file (TAMANDUA_SCRIPTED_BEHAVIORS), keyed by the
 * short agent id. Same format as the pi/hermes runtimes.
 *
 * Chaos modes (behavior.mode): "work" (default), "hang", "hang-after-claim",
 * "die-before-claim", "die-after-claim", "no-status", "garbage".
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
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

// ── dsh argv parsing ────────────────────────────────────────────────
// argv: --profile headless "<prompt>" (with a possible `-- --` guard pair
// before the prompt when the task text starts with `-`).
// The prompt is the LAST argument (verbatim, may contain spaces).
// We don't validate the exact sequence — dsh adheres to this contract.
const prompt = process.argv[process.argv.length - 1] ?? "";

const behaviorsPath = process.env.TAMANDUA_SCRIPTED_BEHAVIORS ?? "";
const stateDir = process.env.TAMANDUA_SCRIPTED_STATE ?? "";

// ── State-dir logging (test diagnostics) ────────────────────────────

function logInvocation(entry) {
  sharedLogInvocation(stateDir, entry);
}

function fatal(note) {
  sharedFatal(stateDir, "scripted-dsh", note);
}

// ── dsh output emission (plain text, nothing on stderr) ─────────────
//
// Real dsh headless writes exactly the last assistant text message plus
// `\n` to stdout, once, at the end — plain text, no JSON, no session
// trailer, and NOTHING on stderr on success. The session id is never
// printed; token attribution happens via the session-file lookup, not via
// stdout parsing.

/**
 * Write the completed output to stdout. Exactly the final text plus a
 * trailing newline; stderr stays empty on success (dsh contract).
 */
function emitOutput(text) {
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

// ── Fake session.jsonl.zstd for token accounting ────────────────────
//
// The scheduler calls lookupDshSessionTokens(spawnedAtMs, workdir) after
// each round. That function scans $DSH_HOME/sessions/<escaped-cwd>/ for
// session dirs created since the round started and decompresses the
// newest session.jsonl.zstd. We must write the file BEFORE exiting so it
// is available (the dsh adapter waits for the child to exit before the
// lookup runs).

/**
 * Encode a cwd as dsh's per-project session directory key. Replicates
 * dsh's `projectKey` exactly (session-persistence-jsonl format.ts): `/`,
 * `\`, and `:` collapse to `-` (runs collapse to one); safe
 * `[A-Za-z0-9._-]` UTF-16 units stay literal; every other unit becomes
 * `~XXXX`; a leading separator run is stripped (or replaced by `root`);
 * the result is wrapped in `--…--` and bounded at 251 chars. Kept in
 * lockstep with src/installer/dsh-usage.ts `projectKey()`.
 */
function projectKeyOf(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

/**
 * Compress a buffer to a zstd stream. Prefers node:zlib `zstdCompressSync`
 * (Node >= 23.8, feature-detected through the namespace object so this
 * file loads on Node 22); falls back to spawning the `zstd` binary.
 * Throws when neither is available — callers degrade gracefully.
 */
function compressZstd(buffer) {
  const nodeZstd =
    typeof zlib.zstdCompressSync === "function"
      ? zlib.zstdCompressSync
      : undefined;
  if (nodeZstd) return nodeZstd(buffer);

  const r = spawnSync("zstd", ["-q", "-c"], {
    input: buffer,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status === 0 && r.stdout.length > 0) return r.stdout;
  throw new Error("no zstd compression available (node:zlib or zstd binary)");
}

/**
 * Write the fake session log under
 * $DSH_HOME/sessions/<escaped-cwd>/session-<sessionId>/session.jsonl.zstd
 * with usage chunks totaling the given token count. The log is a real
 * zstd-compressed session.jsonl: a `session` header line followed by two
 * `assistant/chunk` usage records (input on the first, output on the
 * second, cacheReadTokens sprinkled on both so cache-read exclusion is
 * exercised end to end). Never throws — silently degrades on any failure
 * so the token-degradation scenario (no/write-protected DSH_HOME) is
 * supported.
 */
function writeSessionLog(sessionId, tokens) {
  try {
    const dshHome = process.env.DSH_HOME;
    if (!dshHome) {
      // No DSH_HOME set — token attribution degrades (null).
      logInvocation({ phase: "session-file", note: "DSH_HOME not set, skipping session log write" });
      return;
    }

    // Distribute totalTokens across input/output, matching the scripted
    // hermes convention: input = tokens - 11, output = min(tokens, 11)
    // → total = input + output = tokens. cacheReadTokens are extra and
    // MUST be excluded by the reader.
    const inputTokens = Math.max(0, tokens - 11);
    const outputTokens = tokens > 0 ? Math.min(tokens, 11) : 0;

    const header = JSON.stringify({
      type: "session",
      version: 1,
      id: sessionId,
      createdAt: Date.now(),
      delegationDepth: 0,
    });
    const now = Date.now();
    const chunk = (seq, input, output, cacheRead) =>
      JSON.stringify({
        type: "assistant/chunk",
        seq,
        time: now,
        data: {
          turn: 0,
          step: seq,
          chunk: {
            type: "usage",
            usage: {
              inputTokens: input,
              outputTokens: output,
              cacheReadTokens: cacheRead,
            },
          },
        },
      });
    const lines = [
      header,
      chunk(0, inputTokens, 0, 5),
      chunk(1, 0, outputTokens, 3),
    ].join("\n") + "\n";

    const sessionDir = path.join(
      dshHome,
      "sessions",
      projectKeyOf(process.cwd()),
      `session-${sessionId}`,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session.jsonl.zstd"),
      compressZstd(Buffer.from(lines, "utf-8")),
    );

    logInvocation({
      phase: "session-file",
      note: `wrote session-${sessionId} with totalTokens=${tokens}`,
    });
  } catch (err) {
    // Degrade gracefully — the token-accounting path will return null.
    logInvocation({
      phase: "session-file",
      note: `session log write failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ── Parse the work prompt ───────────────────────────────────────────
//
// The header line is `... workflow "X", agent "Y", run "Z"` and the CLI
// path comes from the `step claim` command line. Same format as pi/hermes.

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

// Phase 1: defensive peek (same as the pi/hermes runtimes).
const peek = peekStep(cli, agentId, runId);
const peekOut = `${peek.stdout}\n${peek.stderr}`;
if (peek.status !== 0) {
  logInvocation({ ...base, phase: "error", note: `step peek exited ${peek.status}: ${peekOut.slice(0, 500)}` });
  fatal(`step peek failed (exit ${peek.status})`);
}

if (peekOut.includes("NO_WORK")) {
  logInvocation({ ...base, phase: "heartbeat", note: "spawned without pending work" });
  // Heartbeat: no session-file write (zero-token round).
  emitOutput("NO_WORK_AVAILABLE");
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
  writeSessionLog(sessionId, tokens);
  emitOutput(`STATUS: failed\nREASON: no scripted behavior for agent "${shortAgent}"`);
  if (claimed?.stepId) {
    failStep(cli, claimed.stepId, `scripted-dsh: no behavior configured for agent "${shortAgent}"`);
  }
  process.exit(0);
}

if (mode === "hang") {
  logInvocation({ ...work, note: "hanging until killed" });
  setInterval(() => {}, 1 << 30);
} else if (mode === "die-before-claim") {
  logInvocation({ ...work, note: "exiting before claim" });
  process.exit(behavior.exitCode ?? 1);
} else if (mode === "garbage") {
  logInvocation({ ...work, note: "emitting garbage output" });
  const sessionId = crypto.randomUUID();
  writeSessionLog(sessionId, tokens);
  process.stdout.write("%%% not plain text — scripted garbage output %%%\ngarbage text\n");
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
    emitOutput("NO_WORK_AVAILABLE");
    process.exit(0);
  }
  const claimed = JSON.parse(claimRaw);
  const stepId = claimed.stepId;
  const inputVars = parseInputVars(claimed.input ?? "");
  inputVars.RUN_ID = claimed.runId.replace(/^run-/, "");

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
    writeSessionLog(sessionId, tokens);
    emitOutput(`STATUS: failed\nREASON: ${reason.slice(0, 500)}`);
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
    // Write the session log BEFORE dying so the scheduler's post-round
    // lookup can still attribute tokens (dsh flushes sessions before
    // exit; a killed worker leaves the file behind the same way).
    const sessionId = crypto.randomUUID();
    writeSessionLog(sessionId, tokens);
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
    writeSessionLog(sessionId, tokens);
    emitOutput(outputText);
    process.exit(0);
  }

  // dsh output: exactly the final assistant text on stdout, nothing on
  // stderr. Token attribution: the scheduler reads the session file via
  // the escaped-cwd scan.
  const sessionId = crypto.randomUUID();
  writeSessionLog(sessionId, tokens);

  if (behavior.stepAction === "fail") {
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "scripted step fail" });
    emitOutput(outputText);
    failStep(cli, stepId, behavior.failReason ?? "scripted failure");
    process.exit(0);
  }

  // reportBeforeEmit: step complete BEFORE emitting output (same semantics
  // as the pi/hermes runtimes).
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
    emitOutput(outputText);
    // Support exitCode in reportBeforeEmit mode: a killed dsh worker may
    // exit non-zero after step completion — the scheduler still reads the
    // session file for token attribution.
    process.exit(behavior.exitCode ?? 0);
  }

  // Default ordering: emit output THEN report (dsh writes the final
  // message before the step-complete tool call finishes, mirroring the
  // pi/hermes ordering).
  emitOutput(outputText);

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
