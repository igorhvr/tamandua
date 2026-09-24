// seedlib.mjs — the real-API lifecycle driver of the aged-state generator.
//
// Runs are created with the REAL product runWorkflow() (the current
// counterpart of spec createRun), driven through the REAL step-ops
// claimStep/completeStep/failStep, terminalized with the REAL status
// stopWorkflow/forceFailRun and the REAL control-server pause handler, and
// worktree workflows create REAL managed worktrees through the product
// worktree factory inside runWorkflow.  NO raw SQL seeds runs/steps/status or
// events, and NO copied alternative state machine.  Any intentionally
// synthetic step report is explicit seed-fixture data — never a claim about a
// real model (each synthesized output is labeled `seed-fixture`).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { utcNow, appendJsonl, RESERVED_CONTEXT_KEYS } from "./seedcommon.mjs";

// ── Product module loading (single cached handle set per process) ──────

const moduleCache = new Map();

export async function loadProduct(productDist) {
  const cached = moduleCache.get(productDist);
  if (cached) return cached;
  const url = (rel) => pathToFileURL(path.join(productDist, rel)).href;
  const mods = {
    run: await import(url("installer/run.js")),
    stepOps: await import(url("installer/step-ops.js")),
    status: await import(url("installer/status.js")),
    events: await import(url("installer/events.js")),
    db: await import(url("db.js")),
    wfSpec: await import(url("installer/workflow-spec.js")),
    paths: await import(url("installer/paths.js")),
    worktree: await import(url("installer/worktree-manager.js")),
    controlServer: await import(url("server/control-server.js")),
    controlClient: await import(url("server/control-client.js")),
  };
  // Force the DB singleton to bind to the private path now.
  mods.db.getDb();
  moduleCache.set(productDist, mods);
  return mods;
}

// Map workflow family to whether the driver can drive a GENUINE completed run
// through real claim/complete (no story loops, no verify_each parking, no
// finalize_merge, no conditional test_cmd_review, no merge machinery).
// Anything else is terminalized through real fail/stop (genuine dispositions)
// or left paused (real pause handler), which the spec explicitly allows for
// complex merge/PR/child shapes.
//
// STRUCTURAL LIMIT (reviewer issue, STORM-AGED-FULL round): quarantine-broken-
// tests is deliberately NOT listed here.  Its setup step template requires a
// `branch` context key (`git checkout -b {{branch}}`), and the seed's
// NON-worktree synthetic runs carry no `branch` key (direct-mode runWorkflow
// seeds original_branch/base_branch_sha only).  Native template validation
// therefore fails at the setup step and a non-worktree quarantine run can
// never genuinely complete through the linear driver — its completed-intent
// shapes only degrade to completed->failed.  A genuine completed quarantine
// run would require a branch/origin context (worktree-mode launch), which this
// corpus never drives.  Plan builders route quarantine completed-intent draws
// through dispositionFallback instead, so plan intent always matches an
// achievable disposition.
export const LINEAR_COMPLETABLE = new Set([
  "do-now",
  "do-review-do-verify",
  "bug-fix",
  "bug-fix-worktree",
]);

export function isWorktreeWorkflow(workflowSpec) {
  return workflowSpec.run?.workspace === "worktree";
}

export function scopedAgentId(workflowId, agentName) {
  return agentName.startsWith(`${workflowId}_`) ? agentName : `${workflowId}_${agentName}`;
}

// Synthesize a seed-fixture output for a step, self-checked against the real
// expects validator in the caller's correction loop.  The expects grammar is
// per-line: literal strings that must appear, or `regex:` patterns.  We
// derive candidate KEY lines from the expects text (uppercase tokens + the
// alternation groups) and pick vocabulary-aware values where the pattern
// constrains them; extra lines are harmless because validateExpects only
// checks presence.
const VALUE_VOCAB = {
  VERDICT: "HONEST",
  VERIFIED: "true",
  DISABLED: "0",
  VULNERABILITY_COUNT: "0",
  CRITICAL_COUNT: "0",
  HIGH_COUNT: "0",
  MEDIUM_COUNT: "0",
  SEVERITY: "medium",
  STATUS: "done",
  // BRANCH: use a branch that exists in the origin (main) so the product's
  // has_frontend_changes probe (`git diff main..<branch>`) resolves instead
  // of emitting fatal invalid-object noise against seed-fixture names.
  BRANCH: "main",
};
const VALUE_TOKENS = new Set([
  "HONEST", "DECEPTION", "ACCEPT", "REJECT", "DONE", "RETRY", "FAILED", "CANCELED",
  "TRUE", "FALSE", "CRITICAL", "HIGH", "MEDIUM", "LOW", "YES", "NO",
]);

export function synthesizeOutput({ workflowId, stepId, expects, agentId, seq, attempt = 0 }) {
  const raw = String(expects ?? "");
  const lines = ["STATUS: done"];
  const seenKeys = new Set(["STATUS"]);

  // Collect candidate keys from every expects line.
  const candidateKeys = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("regex:")) {
      const p = line.slice("regex:".length);
      // KEY: patterns (possibly inside an alternation group of KEY names).
      for (const m of p.matchAll(/\(([A-Z][A-Z_]+)\|([A-Z][A-Z_]+)\)\s*:/g)) {
        for (const alt of [m[1], m[2]]) {
          if (!seenKeys.has(alt)) { seenKeys.add(alt); candidateKeys.push(alt); }
        }
      }
      for (const m of p.matchAll(/(^|[^A-Z_])([A-Z][A-Z_]+)\s*:/g)) {
        const key = m[2];
        if (!VALUE_TOKENS.has(key) && !seenKeys.has(key)) {
          seenKeys.add(key);
          candidateKeys.push(key);
        }
      }
    } else {
      const m = /^\s*([A-Z][A-Z_]+)\s*:/.exec(line);
      if (m && !seenKeys.has(m[1])) {
        seenKeys.add(m[1]);
        candidateKeys.push(m[1]);
      }
    }
  }

  for (const key of candidateKeys) {
    const value = VALUE_VOCAB[key]
      ?? `seed-fixture:${workflowId}:${stepId}:${seq}${attempt > 0 ? `:attempt${attempt}` : ""}`;
    lines.push(`${key}: ${value}`);
  }
  if (candidateKeys.length === 0) {
    lines.push("CHANGES: seed-fixture synthetic change summary");
    lines.push("REPORT: seed-fixture report; not a claim about a real model.");
  }
  return lines.join("\n") + "\n";
}

export function outputPasses(validateExpects, output, expects) {
  try {
    const err = validateExpects(output, String(expects ?? ""));
    return err === null || err === undefined || err === "";
  } catch {
    return false;
  }
}

// ── Reserved-key baseline sidecar (host-owned, for O12 R4) ─────────────
//
// Complete typed capture: for EVERY reserved key of the native pin the record
// stores typed presence/absence captured from host code at run-creation time
// — `present` entries pin the exact string value host code wrote ("" is a
// legitimate distinct value), `absent` entries pin a host-captured known
// absence.  Presence-only capture cannot prove a key was originally absent,
// so no key is ever omitted from the record (O12 v2 complete-scope producer
// contract; the root counterexample was a partial baseline that still PASSed).
// Original expectations are NEVER reconstructed from a later final context.

export function recordReservedBaseline({ baselineFile, runId, context }) {
  const reserved = {};
  const ctx = context ?? {};
  for (const key of RESERVED_CONTEXT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ctx, key)) {
      reserved[key] = { presence: "present", value: ctx[key], provenance: "host" };
    } else {
      reserved[key] = { presence: "absent", provenance: "host" };
    }
  }
  const record = {
    run_id: runId,
    ts_utc: utcNow(),
    reserved_key_count: RESERVED_CONTEXT_KEYS.length,
    context_key_count: Object.keys(ctx).length,
    reserved,
  };
  appendJsonl(baselineFile, record);
  return record;
}

// ── Lifecycle server scaffolding (call once per seed phase process) ─────

export async function startBoundaries({ productDist, secret, homeDir, controlPort }) {
  const { NonDispatchingTransportServer, RealControlFacade } = await import("./transport.mjs");
  const receiptsDir = path.join(homeDir, "..", "receipts");
  const double = new NonDispatchingTransportServer({
    port: controlPort,
    secret,
    receiptDir: receiptsDir,
  });
  await double.start();
  const facade = new RealControlFacade({ port: 0, secret, productDist });
  const facadeServer = await facade.start();
  const facadePort = facadeServer.address().port;
  facade.port = facadePort; // bind the facade's own request port (was ephemeral 0)
  return { double, facade, facadePort };
}

export async function stopBoundaries({ double, facade }) {
  if (facade) await facade.close();
  if (double) await double.close();
}

// ── Run creation through the REAL product runWorkflow ──────────────────

export async function createRunThroughRealApi({ mods, workflowId, taskTitle, harnessDir, originRepository, originRef }) {
  const workflowDir = mods.paths.resolveWorkflowDir(workflowId);
  const spec = await mods.wfSpec.loadWorkflowSpec(workflowDir);
  const isWorktree = spec.run?.workspace === "worktree";

  const params = { workflowId, taskTitle, noRelaunchUponRugpull: true };
  if (isWorktree) {
    params.worktreeOriginRepository = originRepository;
    if (originRef) params.worktreeOriginRef = originRef;
  } else {
    params.workingDirectoryForHarness = harnessDir;
  }

  const result = await mods.run.runWorkflow(params);

  const row = mods.db
    .getDb()
    .prepare(
      "SELECT id, run_number, workflow_id, status, context, created_at, updated_at, scheduling_status FROM runs WHERE id = ?",
    )
    .get(result.runId);
  const context = JSON.parse(row.context);
  return { result, spec, row, context, isWorktree };
}

// Walk a linear (loop-free, merge-free) run to completion through REAL
// claimStep/completeStep.  Each step is claimed with its scoped agent id, an
// output is synthesized, self-checked with the real validateExpects, then
// completed.  advancePipeline (inside completeStep) moves the run forward and
// finally emits run.completed through the real product path.
export function driveLinearRunToCompletion({ mods, runId, workflowId, seq, journal, maxSteps = 200 }) {
  const stepOps = mods.stepOps;
  const db = mods.db.getDb();
  const scope = [];
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > maxSteps) {
      throw new Error(`driveLinearRunToCompletion: guard exceeded ${maxSteps} for run ${runId}`);
    }
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId);
    if (!run || run.status !== "running") break;

    const pending = db.prepare(
      "SELECT id, step_id, agent_id, expects, step_index FROM steps WHERE run_id = ? AND status = 'pending' ORDER BY step_index ASC LIMIT 1",
    ).get(runId);
    if (!pending) {
      const waiting = db.prepare("SELECT COUNT(*) AS c FROM steps WHERE run_id = ? AND status = 'waiting'").get(runId);
      if (waiting.c === 0) break;
      throw new Error(
        `driveLinearRunToCompletion: pipeline stalled for run ${runId} (no pending step, ${waiting.c} waiting)`,
      );
    }

    const claim = stepOps.claimStep(pending.agent_id, runId);
    if (!claim.found || claim.stepId !== pending.id) {
      throw new Error(
        `driveLinearRunToCompletion: claimStep did not return pending step ${pending.step_id} for agent ${pending.agent_id}`,
      );
    }

    const expects = pending.expects ?? "";
    let output = synthesizeOutput({
      workflowId,
      stepId: pending.step_id,
      expects,
      agentId: pending.agent_id,
      seq: `${seq}-${pending.step_id}`,
    });
    let attempts = 0;
    while (!outputPasses(stepOps.validateExpects, output, expects)) {
      attempts += 1;
      if (attempts > 6) {
        throw new Error(
          `driveLinearRunToCompletion: cannot synthesize passing output for ${workflowId}/${pending.step_id}; expects=${JSON.stringify(expects)}`,
        );
      }
      output = synthesizeOutput({
        workflowId,
        stepId: pending.step_id,
        expects,
        agentId: pending.agent_id,
        seq: `${seq}-${pending.step_id}`,
        attempt: attempts,
      });
    }

    const result = stepOps.completeStep(pending.id, output);
    scope.push({ stepId: pending.step_id, agentId: pending.agent_id, completeStatus: result.status });
    journal({ runId, step: pending.step_id, claim: "ok", complete: result.status });
    if (result.status === "blocked" || result.status === "failed") {
      throw new Error(
        `driveLinearRunToCompletion: step ${pending.step_id} ${result.status}: ${result.detail ?? ""}`,
      );
    }
    if (result.status === "retrying" || result.status === "rerouted") {
      throw new Error(
        `driveLinearRunToCompletion: step ${pending.step_id} ${result.status}: ${result.detail ?? ""}`,
      );
    }
  }

  const finalRun = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId);
  if (!finalRun || finalRun.status !== "completed") {
    throw new Error(`driveLinearRunToCompletion: run ${runId} finished ${finalRun?.status}, expected completed`);
  }
  return { scope, finalStatus: finalRun.status };
}

// Real cancel: product stopWorkflow (requires run status running/paused).
export async function cancelRunViaRealStop({ mods, runId, source = "aged-seed-fixture" }) {
  return mods.status.stopWorkflow(runId, { source });
}

// Real force-fail: product forceFailRun with an explicit reason.  Guarded:
// refuses when a live worker exists unless force=true (we hold no live pids).
export async function failRunViaRealForceFail({ mods, runId, reason, force = false }) {
  return mods.status.forceFailRun(runId, reason, force);
}

// Real fail through step-ops failStep exhaustion: claims the first pending
// step, fails it repeatedly through the REAL product failStep, re-claiming
// between retries exactly like a real agent would, and asserts the REAL
// retry_count progression so the run fails through the genuine run.failed
// ("Step retries exhausted") path once the retry budget is exhausted.
//
// failStep is ASYNC and its exhaustion branch performs the run-terminalizing
// writes AFTER an internal await — a caller that fires failStep without
// awaiting races the terminal state (observed in the pilot: run 11's 5th
// un-awaited failStep left the driver seeing status 'running' and forced the
// force-fail fallback even though the product later emitted the genuine
// run.failed).  Every failStep here is awaited; the retry budget is asserted
// to strictly increase; only a linear single-step budget exhaustion returns
// cleanly (reroute/blocked outcomes raise so the caller's genuine fallback
// terminalizes the run through a real product function).
export async function failRunViaStepExhaustion({ mods, runId, journal }) {
  const stepOps = mods.stepOps;
  const db = mods.db.getDb();
  const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId);
  if (!run || run.status !== "running") {
    throw new Error(`failRunViaStepExhaustion: run ${runId} not running (${run?.status})`);
  }
  const attempts = [];
  let finalStatus = null;
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 80) {
      throw new Error(`failRunViaStepExhaustion: guard exceeded 80 fail attempts for run ${runId}`);
    }
    const runNow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId);
    if (!runNow || runNow.status !== "running") {
      finalStatus = runNow?.status ?? null;
      break;
    }
    const pending = db.prepare(
      "SELECT id, step_id, agent_id, retry_count, max_retries FROM steps WHERE run_id = ? AND status = 'pending' ORDER BY step_index ASC LIMIT 1",
    ).get(runId);
    if (!pending) {
      throw new Error(`failRunViaStepExhaustion: run ${runId} running but has no pending step`);
    }
    // Claim through the REAL claimStep (step pending → running) like a real
    // worker would, then fail it through the REAL failStep.  retry_count read
    // here (pre-fail) is the progression base for this attempt.
    const retryBefore = pending.retry_count ?? 0;
    const claim = stepOps.claimStep(pending.agent_id, runId);
    if (!claim.found || claim.stepId !== pending.id) {
      throw new Error(
        `failRunViaStepExhaustion: claimStep did not return pending step ${pending.step_id} (found=${claim.found}, stepId=${claim.stepId})`,
      );
    }
    const res = await stepOps.failStep(claim.stepId, "seed-fixture: deliberate step failure to exhaust retry budget");
    const stepAfter = db.prepare("SELECT status, retry_count, max_retries FROM steps WHERE id = ?").get(pending.id);
    const retryCount = stepAfter?.retry_count ?? null;
    const runAfter = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId);
    const rec = {
      step: pending.step_id,
      attempt: attempts.length + 1,
      failStatus: res?.status ?? null,
      retry_count: retryCount,
      max_retries: stepAfter?.max_retries ?? null,
      runStatus: runAfter?.status ?? null,
    };
    attempts.push(rec);
    journal({ runId, step: pending.step_id, failAttempt: rec.attempt, failStatus: rec.failStatus, retry_count: rec.retry_count, runStatus: rec.runStatus });
    // Assert the REAL retry budget strictly progressed (each awaited failStep
    // that re-pends must have bumped retry_count exactly once).
    if (res?.status === "retrying") {
      if (!(retryCount === retryBefore + 1)) {
        throw new Error(
          `failRunViaStepExhaustion: retry_count did not progress (expected ${retryBefore + 1}, got ${retryCount}) for step ${pending.step_id}`,
        );
      }
      continue; // re-claim on the next iteration
    }
    if (res?.status === "failed") {
      // Budget exhausted → the real failStep already terminalized the run.
      finalStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)?.status ?? null;
      break;
    }
    // rerouted / blocked / unknown → this workflow does not fail linearly on
    // exhaustion; raise so the caller's REAL force-fail fallback terminalizes
    // it (never a fake transition).
    throw new Error(
      `failRunViaStepExhaustion: step ${pending.step_id} ${res?.status ?? "no-status"} after ${rec.attempt} fail(s) — not a linear budget exhaustion (run ${runId})`,
    );
  }
  if (finalStatus !== "failed") {
    throw new Error(`failRunViaStepExhaustion: run ${runId} finished ${finalStatus}, expected failed`);
  }
  return { finalStatus, exhaustedVia: "failStep-budget", attempts };
}
