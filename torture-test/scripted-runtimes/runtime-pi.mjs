/**
 * Scripted-agent runtime — a deterministic stand-in for the `pi` binary.
 *
 * The agent scheduler invokes this exactly like pi:
 *   fake-pi --print --mode json --no-session "<work prompt>"
 *
 * Unlike the static canned fake-pi used by unit tests, this runtime actually
 * executes the work protocol that the prompt describes:
 *
 *   1. Parse workflow/agent/run IDs and the tamandua CLI path from the prompt
 *   2. Defensive `step peek` — the dispatch motor only spawns a harness when
 *      a pending step exists, so NO_WORK here is a motor bug or a rare race;
 *      it is journaled as phase "heartbeat" (the N2 tripwire) and answered
 *      with NO_WORK_AVAILABLE
 *   3. Run `step claim`, look up this agent's scripted behavior, apply file
 *      edits / shell commands in the harness workdir, then report via
 *      `step complete` / `step fail`
 *   4. Emit pi-shaped JSON events (tool_execution_end with {stepId, runId}
 *      for token attribution, message_end with usage.totalTokens)
 *
 * Behaviors come from a JSON file (TAMANDUA_SCRIPTED_BEHAVIORS), keyed by the
 * short agent id (the part after "<workflowId>_"). Each agent maps to one
 * behavior or an array consumed per work invocation (last entry repeats), so
 * tests can script "fail once, then succeed" sequences.
 *
 * Every invocation appends a JSON line to TAMANDUA_SCRIPTED_STATE/invocations.jsonl
 * so tests can assert exactly how many rounds ran, which agents did work, and
 * what each round observed.
 *
 * Chaos modes (behavior.mode): "work" (default), "hang", "hang-after-claim",
 * "die-before-claim", "die-after-claim", "no-status", "garbage".
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
} from "./runtime-shared.mjs";

const prompt = process.argv[process.argv.length - 1] ?? "";
const behaviorsPath = process.env.TAMANDUA_SCRIPTED_BEHAVIORS ?? "";
const stateDir = process.env.TAMANDUA_SCRIPTED_STATE ?? "";

// ── State-dir logging (test diagnostics) ────────────────────────────

function logInvocation(entry) {
  sharedLogInvocation(stateDir, entry);
}

function fatal(note) {
  sharedFatal(stateDir, "scripted-agent", note);
}

// ── pi-shaped JSON event emission ───────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function stripIdPrefix(id) {
  return id.replace(/^(run-|step-)/, "");
}

function emitToolAttribution(stepId, runId) {
  emit({
    type: "tool_execution_end",
    toolName: "bash",
    result: { content: [{ type: "text", text: JSON.stringify({
      stepId: stripIdPrefix(stepId),
      runId: stripIdPrefix(runId)
    }) }] },
    isError: false,
  });
}

function emitMessageEnd(text, totalTokens) {
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "scripted",
      provider: "scripted",
      model: "scripted-agent",
      usage: {
        input: Math.max(0, totalTokens - 1),
        output: totalTokens > 0 ? 1 : 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
      responseId: crypto.randomUUID(),
    },
  });
}

// ═══════════════════════════════════════════════════════════════════
// KNOB-REGION-BEGIN — US-004 fault injection knobs
// ═══════════════════════════════════════════════════════════════════

/**
 * Emit a malformed message_end event — unparseable JSON.
 * The output has a missing closing brace so JSON.parse will throw.
 */
function emitMalformedMessageEnd(text, totalTokens) {
  // Intentionally malformed: missing closing braces and truncated fields.
  // This is a process-pipe-level injection — not valid JSON to stdout.
  process.stdout.write(
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":${JSON.stringify(text)}}],"usage":{"totalTokens":${totalTokens}}\n`
  );
}

/**
 * Emit N MB of harmless padding (comment lines) to stdout.
 * Each line is a JSON comment marker so parsers ignoring non-JSON lines can skip them.
 */
function emitOversizedStdout(megabytes) {
  const targetBytes = megabytes * 1024 * 1024;
  // Use ~1KB lines to avoid excessive line counts while keeping memory bounded.
  const line = "# padding " + "x".repeat(1000 - 10) + "\n";
  let written = 0;
  while (written < targetBytes) {
    fs.writeSync(1, line); // fd 1 = stdout, synchronous to avoid pipe buffer loss
    written += Buffer.byteLength(line, "utf-8");
  }
}

/**
 * Emit a provider-error shape and exit. These replace the entire normal
 * workflow output — no step claim, no step complete.
 *
 * Shapes:
 *   "429" — rate-limit error JSON with per-minute quota message
 *   "529" — server overloaded error JSON
 *   "mid-stream-drop" — partial valid JSON then truncated mid-object
 */
function handleProviderError(providerError, tokens) {
  const shape = providerError.shape ?? "429";

  if (shape === "mid-stream-drop") {
    // Emit a partial valid JSON line then truncate mid-object.
    // Simulates a provider connection that drops partway through a response.
    process.stdout.write(
      '{"type":"tool_execution_end","toolName":"bash","result":{"content":[{"type":"text","text":"s'
    );
    process.exit(providerError.exitCode ?? 2);
  }

  if (shape === "429") {
    emit({
      type: "error",
      level: "warn",
      message: "Rate limit exceeded. Try again in 60 seconds.",
      provider: "scripted",
      code: 429,
    });
    process.exit(providerError.exitCode ?? 2);
  }

  if (shape === "529") {
    emit({
      type: "error",
      level: "error",
      message: "Server overloaded. Please retry.",
      provider: "scripted",
      code: 529,
    });
    process.exit(providerError.exitCode ?? 2);
  }

  // Unknown shape — log and exit with error
  logInvocation({
    workflowId,
    agentId,
    runId,
    phase: "error",
    note: `unknown provider_error shape: ${shape}`,
  });
  process.exit(2);
}

// ── Knob-aware message-end scheduling ─────────────────────────────
//
// Fault knobs that affect message_end emission are applied through
// scheduleMessageEnd + maybeExit. When delayed_trailer_ms is set the
// exit is deferred until the timeout fires; maybeExit prevents an
// immediate process.exit from racing the scheduled emit.

let _exitPending = false;

function scheduleMessageEnd(text, totalTokens, behavior) {
  if (behavior.omit_trailer) {
    return;
  }

  if (behavior.malformed_trailer) {
    emitMalformedMessageEnd(text, totalTokens);
    return;
  }

  if ((behavior.delayed_trailer_ms ?? 0) > 0) {
    _exitPending = true;
    setTimeout(() => {
      emitMessageEnd(text, totalTokens);
      process.exit(0);
    }, behavior.delayed_trailer_ms);
    return;
  }

  emitMessageEnd(text, totalTokens);
}

function maybeExit(code = 0) {
  if (_exitPending) return; // a delayed message_end + exit will fire
  process.exit(code);
}

// ═══════════════════════════════════════════════════════════════════
// KNOB-REGION-END
// ═══════════════════════════════════════════════════════════════════

// ── Parse the work prompt (this pins the prompt protocol) ───────────
//
// The header line is `... workflow "X", agent "Y", run "Z"` and the CLI
// path comes from the `step claim` command line. The work prompt has no
// peek phase — the dispatch motor peeks in-process before spawning us.

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
  return sharedNextWorkIndex(stateDir, agentId);
}

// ── Placeholder substitution ────────────────────────────────────────
// {{cwd}} → harness workdir; {{input.KEY}} → "KEY: value" line from step input

function substitute(text, inputVars) {
  return sharedSubstitute(text, process.cwd(), inputVars);
}

// ── Main ────────────────────────────────────────────────────────────

const base = { workflowId, agentId, shortAgent, runId, cwd: process.cwd(), jobId: process.env.TAMANDUA_WORKER_JOB_ID ?? null };

// Phase 1: defensive peek. The dispatch motor decides HAS_WORK in-process
// before ever spawning this runtime, so NO_WORK here means a motor bug or a
// (rare) race with another round. Journal it as "heartbeat" — the scripted
// e2e asserts this count is ZERO under the deterministic motor (N2).
const peek = peekStep(cli, agentId, runId);
const peekOut = `${peek.stdout}\n${peek.stderr}`;
if (peek.status !== 0) {
  logInvocation({ ...base, phase: "error", note: `step peek exited ${peek.status}: ${peekOut.slice(0, 500)}` });
  fatal(`step peek failed (exit ${peek.status})`);
}

if (peekOut.includes("NO_WORK")) {
  logInvocation({ ...base, phase: "heartbeat", note: "spawned without pending work" });
  emitMessageEnd("NO_WORK_AVAILABLE", config.heartbeatTokens);
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
  // Work arrived for an agent the test did not script: fail the run fast and
  // loudly instead of letting the e2e test time out.
  const claim = claimStep(cli, agentId, runId);
  const claimed = claim.status === 0 ? JSON.parse(claim.stdout.trim()) : null;
  logInvocation({ ...work, note: "no scripted behavior for this agent", stepId: claimed?.stepId ?? null });
  emitMessageEnd(`STATUS: failed\nREASON: no scripted behavior for agent "${shortAgent}"`, tokens);
  if (claimed?.stepId) {
    failStep(cli, claimed.stepId, `scripted-agent: no behavior configured for agent "${shortAgent}"`);
  }
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════
// KNOB-REGION-BEGIN — US-004 provider_error priority check
// ═══════════════════════════════════════════════════════════════════

// ── Fault injection knob: provider_error takes priority over everything ──
// Emits the error shape INSTEAD of the normal workflow — no step peek,
// no step claim, no step complete. The process exits with the error shape.
if (behavior?.provider_error) {
  logInvocation({ ...work, note: `provider_error shape=${behavior.provider_error.shape ?? "unknown"}` });
  handleProviderError(behavior.provider_error, tokens);
  // handleProviderError calls process.exit — unreachable past here
}

// ═══════════════════════════════════════════════════════════════════
// KNOB-REGION-END
// ═══════════════════════════════════════════════════════════════════

if (mode === "hang") {
  logInvocation({ ...work, note: "hanging until killed" });
  setInterval(() => {}, 1 << 30); // hold the event loop; scheduler timeout kills us
} else if (mode === "die-before-claim") {
  logInvocation({ ...work, note: "exiting before claim" });
  process.exit(behavior.exitCode ?? 3);
} else if (mode === "garbage") {
  logInvocation({ ...work, note: "emitting garbage output" });
  process.stdout.write("%%% not json — scripted garbage output %%%\n{truncated\n");
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
    // Raced with another round; reply exactly as the work prompt instructs.
    logInvocation({ ...base, phase: "heartbeat", note: "claim returned NO_WORK after HAS_WORK peek" });
    emitMessageEnd("NO_WORK_AVAILABLE", config.heartbeatTokens);
    process.exit(0);
  }
  const claimed = JSON.parse(claimRaw);
  const stepId = claimed.stepId;
  const inputVars = parseInputVars(claimed.input ?? "");
  inputVars.RUN_ID = stripIdPrefix(claimed.runId);

  // Log the work round NOW: once the final `step complete` of a run lands,
  // the daemon tears down crons and SIGTERMs this process group, so any
  // bookkeeping after that call may never happen.
  logInvocation({ ...work, stepId, note: "claimed" });

  if (mode === "hang-after-claim") {
    // Step is now 'running' with this round's WorkerOwnership recorded —
    // hold the event loop so tests can crash the daemon mid-work.
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "hanging after claim until killed" });
    setInterval(() => {}, 1 << 30);
    return;
  }

  const failThisStep = (reason) => {
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: reason.slice(0, 500) });
    emitToolAttribution(stepId, runId);
    emitMessageEnd(`STATUS: failed\nREASON: ${reason.slice(0, 500)}`, tokens);
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
    process.exit(behavior.exitCode ?? 1);
  }

  const configuredOutput = substitute(behavior.output ?? "STATUS: done", inputVars);
  const outputText = behavior.includeCommandOutput && actionResult.commandOutput
    ? `${actionResult.commandOutput}\n${configuredOutput}`
    : configuredOutput;

  // ═══════════════════════════════════════════════════════════════
  // KNOB-REGION-BEGIN — US-004 runWorkRound knob modifications
  // ═══════════════════════════════════════════════════════════════

  // ── Oversized stdout padding (before any normal events) ──────────
  if ((behavior.oversized_stdout_mb ?? 0) > 0) {
    emitOversizedStdout(behavior.oversized_stdout_mb);
  }

  // ── Determine whether the message-end path uses knobs ────────────
  const hasKnobs =
    behavior.omit_trailer ||
    behavior.malformed_trailer ||
    (behavior.delayed_trailer_ms ?? 0) > 0;

  if (mode === "no-status") {
    // Did the work (maybe) but never reported — the lost-step case.
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "no-status: exiting without step complete" });
    scheduleMessageEnd(outputText, tokens, behavior);
    maybeExit(0);
    return;
  }

  if (behavior.reportBeforeEmit) {
    // Real pi event ordering: the tool call that runs `step complete`
    // happens BEFORE the final assistant message carrying token usage.
    // Completing the run's final step triggers scheduling teardown, so this
    // models the window where an immediate kill would lose the usage event
    // (guarded by HARNESS_TEARDOWN_GRACE_MS in the scheduler).
    emitToolAttribution(stepId, runId);
    logInvocation({ ...work, phase: "result", stepId, ok: true, note: "reporting step complete before emitting usage" });
    const complete = completeStep(cli, stepId, outputText);
    if (complete.status !== 0) {
      logInvocation({ ...work, phase: "result", stepId, ok: false, note: `step complete exited ${complete.status}: ${complete.stderr.slice(0, 300)}` });
    }
    spawnSync("sleep", ["0.3"]);
    scheduleMessageEnd(outputText, tokens, behavior);
    maybeExit(0);
    return;
  }

  // Default ordering: flush all pi-shaped events BEFORE reporting, so even
  // an immediate post-completion kill cannot lose them.
  //
  // When knobs are active that reorder message_end (delayed_trailer_ms),
  // the step completion is issued first so the delay sits between the
  // step-complete round-trip and the message_end event.
  if (hasKnobs) {
    // Knob path: step complete first, then emit message_end with delay.
    emitToolAttribution(stepId, runId);

    if (behavior.stepAction === "fail") {
      logInvocation({ ...work, phase: "result", stepId, ok: false, note: "scripted step fail" });
      failStep(cli, stepId, behavior.failReason ?? "scripted failure");
      scheduleMessageEnd(outputText, tokens, behavior);
      maybeExit(0);
      return;
    }

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
    scheduleMessageEnd(outputText, tokens, behavior);
    maybeExit(0);
    return;
  }

  // Baseline path (no knobs): identical to pre-knob behavior —
  // message_end emitted BEFORE step complete, preserving the original
  // output contract byte-for-byte.

  // ═══════════════════════════════════════════════════════════════
  // KNOB-REGION-END — US-004 runWorkRound knob modifications
  // ═══════════════════════════════════════════════════════════════
  emitToolAttribution(stepId, runId);
  emitMessageEnd(outputText, tokens);

  if (behavior.stepAction === "fail") {
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "scripted step fail" });
    failStep(cli, stepId, behavior.failReason ?? "scripted failure");
    process.exit(0);
  }

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
