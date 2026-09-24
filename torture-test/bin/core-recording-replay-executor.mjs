// core-recording-replay-executor.mjs — CORE-MOTOR: real isolated-motor
// executor + host-owned source→execution binding (US-003 execution portion).
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.3 (authorized torture-only CORE slice
// "CORE-MOTOR"). This module is the EXECUTION complement of the pure safety/
// adapter slice (./core-recording-replay-adapter.mjs — US-003 validation):
// it owns the REAL isolated-motor zero-token replay of a reviewed, fully
// validated replay plan through the REAL tamandua daemon/scheduler/step
// protocol and the FROZEN scripted pi/hermes runtimes
// (torture-test/scripted-runtimes). Everything here is torture-owned: no
// product source/tests/dependencies are imported or changed.
//
// ── Identity contract (the v3 admitted-run gap) ─────────────────────
// The immutable source record's run id (record.sourceIdentity.runId) is
// PROVENANCE: it is preserved byte-for-byte on the record, on the validated
// plan (plan.recordRunId, plan.recordPayloadSha256) and in this executor's
// binding record. It is NEVER rewritten, and the live run's DB uuid is
// NEVER faked/patched to equal it (runWorkflow creates a NEW uuid).
// validateReplayPlan (v3) keeps its admittedRunId===recordRunId requirement
// — that check stays authoritative at SOURCE level, where every reviewed
// action must bind to the single source run.
//
// The FRESH run is a DIFFERENT identity, owned by the host launch. This
// executor introduces the explicit host-owned EXECUTION BINDING
// (buildExecutionBinding): a versioned record that joins
//   source: { sourceRunId, recordPayloadSha256, runtime, workflowId }  and
//   execution: { freshRunId, harnessType, launchedAtUtc, workdir, ... }
// where freshRunId and the per-agent fresh keys come EXCLUSIVELY from the
// actual owned launch receipt (never invented, never the source id — a
// binding that would reuse the source run id is REFUSED:
// binding-equal-identity). Every scheduled claim/complete/fail of the live
// run is performed by the REAL runtimes against the REAL run (the work
// prompt the daemon builds carries the fresh run id, so the frozen runtime
// issues its step-CLI calls against the fresh run automatically); the
// executor never issues step-CLI calls itself (no alternative state machine,
// no manual DB lifecycle transitions) and never substitutes the preserved
// report bytes.
//
// Cross-run negatives are asserted mechanically by verifyExecutionEvidence:
// zero events/steps/journal rows anywhere bound to the source run id, and
// positive fresh-run receipts for every planned work invocation. Any
// adaptation (this gate uses explicitly synthetic recordings) is captured in
// its own versioned adaptation record; preserved public bytes are relayed
// verbatim from record observations — never string-replaced.
//
// ── Launch/binding race design-out ─────────────────────────────────
// The behaviors seed is fully materialized and handed to the daemon BEFORE
// the run is created, and the plan is fully validated (including agent-key
// presence for the corridor workflow) BEFORE any launch; a run whose fresh
// agent key has no planned behavior deterministically FAILS its step
// ("no scripted behavior for agent ..."), never fabricates an unrecorded
// success. The binding is constructed from the actual launch receipt after
// the fresh run id is known; verifyExecutionEvidence then proves the actual
// receipts match the plan (agent keys, per-agent work indices, step
// outcomes, byte-preserved output, zero tokens, zero idle spawns). A
// mismatch is a failed case, never a hidden PASS.
//
// ── Isolation & lifetime ────────────────────────────────────────────
// Every actual execution uses a unique mkdtemp-owned sandbox under an
// explicit retained evidence root: private HOME / TAMANDUA_STATE_DIR /
// TAMANDUA_DB_PATH / TMPDIR, a real random control port, TAMANDUA_TEST_GUARD=1
// and an EXPLICIT child env (never process.env / the live HOME). The frozen
// runtime binaries are reached through explicit absolute wrapper paths
// (TAMANDUA_PI_BINARY / TAMANDUA_HERMES_BINARY), and the launch-time harness
// probe is left ENABLED and answered by the frozen runtimes (they run the
// quoted `<launcher> skill-path` for real). Filesystem fixtures/evidence are
// RETAINED (this executor never removes the evidence sandbox: no recursive
// file removal, no prune, no scratch preclean); normal exact child shutdown
// (daemon SIGTERM on the exact spawned handle) is performed and positively
// evidenced. Cleanup-failure propagation is the caller's responsibility and
// is surfaced on the case report.
//
// ── Structured failure reports ──────────────────────────────────────
// A genuine case failure (daemon start timeout, launch timeout, poll
// timeout, execution-binding refusal, injected forced-failure fault) is
// recorded by the REAL catch path as an ok:false case report whose `error`
// carries the PRIMARY caught error verbatim (describeError(e) — never a
// second undeclared-variable error), then the daemon is still stopped on its
// exact handle and the control-listener release is evidenced. The
// gate's stage-2 forced-failure leg exercises this path at runtime with a
// test-only `fault: { stage: "launch" }` injection.
//
// The validated-plan replay slice stays pi/hermes (SUPPORTED_RUNTIMES in the
// adapter) and never labels plan replay as dsh coverage. CORE-CELLS US-003
// (original US-005 BRUN) adds the missing dsh LAUNCH PRIMITIVES to this module
// — materializeRuntimeWrapper("dsh") over the suite-owned plain-stdout frozen
// runtime torture-test/scripted-runtimes/runtime-dsh.mjs, runtimeBinaryEnvVar
// "dsh" → TAMANDUA_DSH_BINARY, the --dsh-as-harness launch flag and a sandbox
// DSH_HOME — so the BRUN corridor runner can drive real dsh daemon/scheduler
// corridors (first-dispatch launch-probe failure and probe-passing mid-run
// instant-fail) without relabeling pi. Provider/model calls are impossible by
// construction: every behavior is scripted with zero tokens.
//
// ── CORE-MOTOR-CLOSE hardening (root-reproduced gaps) ─────────────────
// A. COMPLETE attribution/cardinality: verifyExecutionEvidence now requires
//    EVERY work/result/event/journal row of an executed case to bind the
//    ACTUAL fresh run (never merely avoid the source uuid), exact per-action
//    work/result counts with no duplicate/unexplained extra row, unique index
//    binding, and journal step-row identity carried from the real DB rows
//    (steps.id) / native claim receipts (invocation stepId) instead of the
//    shared display step_id. collectReceipts DIAGNOSES malformed/truncated
//    event/journal lines (counts + samples surfaced, never silently dropped)
//    and never lets a missing run/census row masquerade as a zero.
// B. PRE-EFFECT validated-plan trust boundary: executeReplayCase calls the
//    pure validateExecutablePlan on the ACTUAL entry path BEFORE any sandbox
//    is created / workflow installed / daemon spawned; invalid/foreign/
//    malformed/unknown plans yield a refused ok:false report with zero
//    effects. A test-only `host` object injects/records the executor's own
//    OS-effect functions so the zero-effect refusal is measured.
// B-US001 (residual-boundary hardening): validateExecutablePlan additionally
//    validates the COMPLETE semantic payload consumed by materializeRuntimeSeed
//    and the executor BEFORE any effect — every claimed public text
//    (preservedOutputTexts of claim_complete / claim_fail / unclaimed_exit
//    actions) must be present and string-typed, and unclaimed exit-code/byte
//    shape is never invented (an exitCode is only meaningful on
//    replay.unclaimed_exit and must be an integer in 0..255). The two
//    root-reproduced gaps — a claim_complete whose preservedOutputTexts is
//    missing and one whose preserved text is a non-string — are refused here
//    (missing-preserved-output / preserved-text-not-string) with ZERO effect
//    calls, reusing the adapter's pure preservedPayloadSemanticErrors so the
//    executor and the seed can never disagree about an action's bytes.
// C. EVERY child is owned and awaited: stopExactChild recognizes
//    terminal-by-code/signal handles immediately (never re-signals), is
//    bounded (SIGKILL fallback + settle deadline; no indefinite wait) and
//    reports stopSignaled/stopError. The workflow-run launcher child is owned
//    through attachRunCliLifecycle (listeners installed before any action;
//    stdout Run: receipt distinct from process exit/close; spawn
//    error / exit-before-run / launch timeout handled with exact-handle
//    cleanup), reaped (natural-exit grace then exact SIGTERM), and its close
//    record is part of the case report; probePortClosed is tri-state so a
//    timeout/error is UNKNOWN, never a positive release. A case is never
//    success while any required child/listener shutdown is unknown or failed:
//    cleanup failures are surfaced separately from the primary error.
// C-refine (review round): DAEMON SPAWN-ERROR awareness — spawnIsolatedDaemon
//    records a child 'error' on its handle (`spawnError()`); executeReplayCase's
//    finally skips stopExactChild for a daemon that never spawned (no process,
//    no exit event will ever arrive): zero re-signal, no ~8s bounded-settle
//    stall, and NO spurious stopError/cleanup failure (mirror of the launcher's
//    spawnError short-circuit). Cleanup semantics: an empty per-run EVENTS
//    stream is now an explicit FAILURE (`events-non-empty`), never a vacuous
//    every() pass whose own message claims empty evidence cannot prove.
// D. Identity fixtures are retained: no actual removal anywhere in the gate
//    (no unlink/rmdir of evidence objects) — replacement refusals use exact
//    retained-sibling renames and independent fresh fixture scenarios.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPLAY_ADAPTER_VERSION,
  SUPPORTED_RUNTIMES,
  EXECUTOR_ACTION_TYPES,
  preservedPayloadSemanticErrors,
  materializeRuntimeSeed,
} from "./core-recording-replay-adapter.mjs";

export const EXECUTOR_VERSION = 1;
export const EXECUTION_BINDING_VERSION = 1;

// The single workflow corridor this execution slice replays through. It is a
// product workflow (installed into the private catalog from the checkout's
// bundled workflows), single agent `doer`, single step `execute` — the same
// corridor the product scripted suites use. Its qualified agent key is
// `<workflowId>_<agentId>` = "do-now_doer".
export const REPLAY_CORRIDOR_WORKFLOW = "do-now";
export const REPLAY_CORRIDOR_AGENT = "do-now_doer";
export const REPLAY_CORRIDOR_STEP = "execute";

// Workflow retry allowance consumed by a scripted claim_fail round before the
// same step is re-dispatched (do-now `execute` max_retries = 4). Retained as
// a named constant so evidence readers see it is by-design, not a flake.
export const CORRIDOR_STEP_MAX_RETRIES = 4;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

/**
 * Shape a caught value into the case-report `error` record WITHOUT ever
 * referencing an undeclared variable (the CORE-MOTOR refine regression that
 * caught this style of breakage): the primary error's message and stack are
 * preserved verbatim; non-Error throws degrade to their String form.
 */
export function describeError(e) {
  if (e instanceof Error) return { message: e.message, stack: e.stack };
  return { message: String(e), stack: undefined };
}

/** Deterministic stable string for a plain JSON-able value. */
function stableString(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableString(value[k])}`)
    .join(",")}}`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Real host adapters for the adapter module's injected realpath/objectIdentity
 * slots. realpath: node fs.realpathSync on the lexical path. objectIdentity:
 * lstat-backed {dev, ino} snapshot of the object at an ALREADY-RESOLVED real
 * path — strings alone are never filesystem object identity.
 */
export function createRealAdapters() {
  return {
    realpath(p) {
      return fs.realpathSync(p);
    },
    objectIdentity(realPath) {
      const st = fs.lstatSync(realPath);
      return { dev: st.dev, ino: st.ino };
    },
  };
}

/** Canonicalize the name a runtime binary env var takes for a runtime. */
export function runtimeBinaryEnvVar(runtime) {
  if (runtime === "pi") return "TAMANDUA_PI_BINARY";
  if (runtime === "hermes") return "TAMANDUA_HERMES_BINARY";
  if (runtime === "dsh") return "TAMANDUA_DSH_BINARY";
  throw new TypeError(`unsupported runtime ${JSON.stringify(runtime)}`);
}

/**
 * Expected terminal run status for a validated plan: the plan's work actions
 * run in order against the corridor's single step; the LAST work action that
 * asserts a terminal state decides the run. claim_complete → "completed";
 * claim_fail (final) → "failed"; a plan ending in unclaimed_exit/idle with no
 * completing action cannot self-complete → "failed" (an honest refusal).
 */
export function planExpectedFinalStatus(plan) {
  if (!isPlainObject(plan) || !Array.isArray(plan.actions)) {
    throw new TypeError("planExpectedFinalStatus requires a validated plan");
  }
  const work = plan.actions.filter((a) => a.type !== "replay.idle_dispatch");
  const last = work[work.length - 1];
  if (!last) return "completed"; // no work actions — nothing to drive
  if (last.type === "replay.claim_complete") return "completed";
  return "failed";
}

// ---------------------------------------------------------------------------
// Validated-plan trust boundary (pure; pre-effect)
// ---------------------------------------------------------------------------

/**
 * Enforce the EXPLICIT validated-plan trust boundary on the ACTUAL
 * executeReplayCase entry path. executeReplayCase must never create a sandbox,
 * install the corridor workflow or spawn a daemon before the plan it is about
 * to execute is proven to be a well-formed adapter-validated plan for THIS
 * executor: wrong adapter version, unsupported/foreign runtime, missing or
 * mismatched admitted-vs-record run identity, non-zero-token plan, an action
 * set that is not an array, an action of an unknown executor type, an action
 * bound to a foreign run, an out-of-corridor agent, a non-contiguous
 * per-agent work-invocation index set, duplicate action ids or a plan already
 * marked executed are all REFUSED before any effect.
 *
 * US-001 residual-boundary hardening: the COMPLETE semantic payload consumed
 * by materializeRuntimeSeed and by the executor is validated HERE, before any
 * effect — every claimed public text (preservedOutputTexts of
 * claim_complete / claim_fail / unclaimed_exit actions) must be present and
 * string-typed, and unclaimed exit-code/byte-shape fields must never be
 * silently invented (an exitCode is only meaningful on replay.unclaimed_exit
 * and must be an integer in 0..255; a non-string preserved text can never be
 * joined/filtered into invented bytes). Missing/invalid payload data is
 * refused on this entry path — never converted into bytes and never deferred
 * to a post-write validation.
 *
 * This is a structural re-validation of the validation PRODUCT (the plan) on
 * the executing side — the caller-side validateReplayPlan (adapter) remains
 * authoritative for source-record integrity; this function closes the gap that
 * allowed createSandbox/install/spawn to run before an invalid
 * runtime/agent/plan was checked.
 *
 * @param {unknown} plan
 * @returns {{ok:true, plan}|{ok:false, errors:Array<{code,path,message}>}}
 */
export function validateExecutablePlan(plan) {
  const errors = [];
  const err = (code, path, message) => errors.push({ code, path, message });

  if (!isPlainObject(plan)) {
    err("plan-shape", "$", "a validated replay plan object is required");
    return { ok: false, errors };
  }
  if (plan.adapterVersion !== REPLAY_ADAPTER_VERSION) {
    err("plan-format", "$.adapterVersion", `an adapter-validated plan (adapterVersion ${REPLAY_ADAPTER_VERSION}) is required, got ${JSON.stringify(plan.adapterVersion)}`);
  }
  if (!SUPPORTED_RUNTIMES.includes(plan.runtime)) {
    err("runtime-unsupported", "$.runtime", `runtime ${JSON.stringify(plan.runtime)} is not a supported replay runtime (${SUPPORTED_RUNTIMES.join("|")})`);
  }
  if (plan.zeroToken !== true) {
    err("plan-format", "$.zeroToken", "the executor only drives zero-token plans (every seeded behavior is scripted)");
  }
  if (!isNonEmptyString(plan.recordRunId)) {
    err("missing-attribution", "$.recordRunId", "recordRunId must be a non-empty string");
  }
  if (!isNonEmptyString(plan.admittedRunId)) {
    err("missing-attribution", "$.admittedRunId", "admittedRunId must be a non-empty string");
  } else if (isNonEmptyString(plan.recordRunId) && plan.admittedRunId !== plan.recordRunId) {
    err("identity-mismatch", "$.admittedRunId", `admitted run ${plan.admittedRunId} does not match the record run ${plan.recordRunId}; a foreign/unknown run identity is refused before any effect`);
  }
  if (!isNonEmptyString(plan.recordPayloadSha256)) {
    err("plan-format", "$.recordPayloadSha256", "recordPayloadSha256 must be a non-empty string");
  }
  if (isPlainObject(plan.execution) && plan.execution.executed === true) {
    err("plan-format", "$.execution.executed", "a plan already marked executed is not an executable validation product (refused before any effect)");
  }
  if (!Array.isArray(plan.actions)) {
    err("plan-format", "$.actions", "actions must be an array");
    return { ok: false, errors };
  }
  if (plan.actions.length === 0) {
    err("plan-format", "$.actions", "actions must not be empty (nothing to execute)");
  }

  // Per-action trust checks + per-agent work-invocation contiguity.
  const byAgent = new Map(); // agentId -> [roundIndex, ...] for work actions
  const seenIds = new Set();
  for (const [idx, action] of plan.actions.entries()) {
    const at = `$.actions[${idx}]`;
    if (!isPlainObject(action)) {
      err("plan-format", at, "each action must be an object");
      continue;
    }
    if (!isNonEmptyString(action.id)) {
      err("plan-format", `${at}.id`, "action id must be a non-empty string");
    } else if (seenIds.has(action.id)) {
      err("plan-format", `${at}.id`, `duplicate action id ${JSON.stringify(action.id)}`);
    } else {
      seenIds.add(action.id);
    }
    if (!EXECUTOR_ACTION_TYPES.includes(action.type)) {
      err("unknown-type", `${at}.type`, `action type ${JSON.stringify(action.type)} is outside the closed executor vocabulary (${EXECUTOR_ACTION_TYPES.join("|")})`);
    }
    if (isNonEmptyString(plan.recordRunId) && action.runId !== plan.recordRunId) {
      err("mixed-run", `${at}.runId`, `action ${action.id} binds run ${JSON.stringify(action.runId)} but the plan's record run is ${plan.recordRunId}; every scheduled action must bind the admitted source run`);
    }
    if (!isNonEmptyString(action.agentId)) {
      err("plan-format", `${at}.agentId`, "action agentId must be a non-empty string");
    } else if (action.type !== "replay.idle_dispatch" && action.agentId !== REPLAY_CORRIDOR_AGENT) {
      err(
        "binding-agent-mismatch",
        `${at}.agentId`,
        `plan work action ${action.id} binds agent ${JSON.stringify(action.agentId)} but the ${REPLAY_CORRIDOR_WORKFLOW} corridor produces only ${JSON.stringify(REPLAY_CORRIDOR_AGENT)}`,
      );
    }
    if (action.type !== "replay.idle_dispatch") {
      if (!Number.isInteger(action.roundIndex) || action.roundIndex < 0) {
        err("plan-format", `${at}.roundIndex`, `work action roundIndex must be a non-negative integer, got ${JSON.stringify(action.roundIndex)}`);
      } else {
        const list = byAgent.get(action.agentId) ?? [];
        list.push(action.roundIndex);
        byAgent.set(action.agentId, list);
      }
    }

    // ── US-001: COMPLETE semantic payload before any effect. The preserved
    //    public texts this action claims (and the executor/seed would turn
    //    into step complete/fail bytes or die-before-claim stdout) must be
    //    present and string-typed — missing/invalid data is REFUSED here,
    //    never joined/filtered into invented bytes later.
    for (const se of preservedPayloadSemanticErrors(action)) {
      err(se.code, `${at}.${se.path.replace(/^\$\./, "")}`, se.message);
    }

    // ── US-001: unclaimed exit-code/byte shape is never invented at
    //    execution time: an exitCode is only meaningful on
    //    replay.unclaimed_exit and must be an integer in 0..255 (the
    //    observable process-exit status range) — mirror of the adapter's
    //    invalid-exit-code rule so a hostile hand-built plan cannot carry a
    //    fractional/oversized/foreign exit shape onto a claim action.
    if (action.exitCode !== undefined && action.exitCode !== null) {
      if (action.type !== "replay.unclaimed_exit") {
        err(
          "invalid-exit-code",
          `${at}.exitCode`,
          `exitCode is only meaningful for replay.unclaimed_exit actions; ${JSON.stringify(action.type)} actions complete/fail via the step CLI or spawn nothing and never exit with a preserved code`,
        );
      } else if (!Number.isInteger(action.exitCode) || action.exitCode < 0 || action.exitCode > 255) {
        err(
          "invalid-exit-code",
          `${at}.exitCode`,
          `replay.unclaimed_exit exitCode must be an integer in 0..255 (the observable process-exit status range), got ${JSON.stringify(action.exitCode)}`,
        );
      }
    }
  }
  for (const [agentId, indices] of byAgent.entries()) {
    const sorted = [...indices].sort((a, b) => a - b);
    if (JSON.stringify(sorted) !== JSON.stringify([...Array(sorted.length).keys()])) {
      err(
        "noncontiguous-round-indices",
        `$.actions.agent=${agentId}`,
        `work-invocation indices for agent ${agentId} must be exactly contiguous 0..n-1, got ${JSON.stringify(indices)} — sparse rounds would invent unrecorded successes`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan };
}

// ---------------------------------------------------------------------------
// Execution binding (pure)
// ---------------------------------------------------------------------------

/**
 * Build the versioned host-owned execution binding joining an immutable
 * source record/plan to the FRESH run created by the actual owned launch.
 *
 * @param {object} options.plan          validated plan (adapter
 *   validateReplayPlan ok result) — the immutable source-bound validation
 *   product (never mutated).
 * @param {object} options.launchReceipt { freshRunId, workflowId,
 *   workdir, launchedAtUtc, harnessType } — ids from the ACTUAL owned launch;
 *   harnessType is "pi" | "hermes" as reported by the run's probe event.
 * @returns {{ok:true, binding}|{ok:false, errors:Array}}
 *
 * Refusals (all before any effect):
 *  - binding-shape / binding-missing-run: receipt without a freshRunId etc.
 *  - binding-equal-identity: freshRunId === source run id — the historical
 *    uuid can never be (re)used as the live run id (no DB patch, no
 *    pretending a historical uuid is the new live run).
 *  - binding-plan-format / binding-runtime-mismatch.
 *  - binding-agent-mismatch: a plan work action whose agentId is not an
 *    allowed corridor agent (deterministic pre-launch refusal: the executor
 *    will not launch a run whose agent keys could diverge from the plan).
 */
export function buildExecutionBinding({ plan, launchReceipt } = {}) {
  const errors = [];
  const err = (code, path, message) => errors.push({ code, path, message });

  if (!isPlainObject(plan) || plan.adapterVersion !== REPLAY_ADAPTER_VERSION) {
    err("binding-plan-format", "$.plan", "an adapter-validated plan (adapterVersion 3) is required");
  } else if (!isPlainObject(launchReceipt)) {
    err("binding-shape", "$.launchReceipt", "launchReceipt must be an object { freshRunId, workflowId, workdir, launchedAtUtc, harnessType }");
  } else {
    const { freshRunId, workflowId, workdir, launchedAtUtc, harnessType } = launchReceipt;
    const sourceRunId = plan.recordRunId;
    if (!isNonEmptyString(freshRunId)) {
      err("binding-missing-run", "$.launchReceipt.freshRunId", "the fresh run id must come from the actual owned launch receipt");
    } else if (freshRunId === sourceRunId) {
      err(
        "binding-equal-identity",
        "$.launchReceipt.freshRunId",
        `fresh run ${freshRunId} equals the immutable source run id ${sourceRunId}; the historical uuid is provenance and can never be reused as the live run id — the executor refuses to pretend a historical uuid is the new live run (runWorkflow creates a fresh uuid)`,
      );
    }
    if (!isNonEmptyString(workflowId)) err("binding-shape", "$.launchReceipt.workflowId", "workflowId is required");
    if (!isNonEmptyString(workdir)) err("binding-shape", "$.launchReceipt.workdir", "workdir is required");
    if (!isNonEmptyString(launchedAtUtc)) err("binding-shape", "$.launchReceipt.launchedAtUtc", "launchedAtUtc (UTC ISO) is required");
    if (!SUPPORTED_RUNTIMES.includes(harnessType)) {
      err("binding-runtime-mismatch", "$.launchReceipt.harnessType", `harnessType ${JSON.stringify(harnessType)} is not a supported replay runtime (${SUPPORTED_RUNTIMES.join("|")})`);
    } else if (plan.runtime !== harnessType) {
      err(
        "binding-runtime-mismatch",
        "$.launchReceipt.harnessType",
        `plan runtime is ${plan.runtime} but the launched run's harness is ${harnessType}; a run driven under the wrong harness would mislabel pi/hermes replay`,
      );
    }
    if (plan.zeroToken !== true) {
      err("binding-plan-format", "$.plan.zeroToken", "the executor only drives zero-token plans (every seeded behavior is scripted)");
    }
    // Pre-launch agent-key determinism: this slice replays the do-now corridor
    // whose single qualified agent key is fixed. Any plan work action for an
    // agent this corridor cannot produce is refused BEFORE launch.
    if (Array.isArray(plan.actions)) {
      for (const action of plan.actions) {
        if (action.type === "replay.idle_dispatch") continue;
        if (action.agentId !== REPLAY_CORRIDOR_AGENT) {
          err(
            "binding-agent-mismatch",
            `$.plan.actions.${action.id}.agentId`,
            `plan work action ${action.id} binds agent ${JSON.stringify(action.agentId)} but the ${REPLAY_CORRIDOR_WORKFLOW} corridor produces only ${JSON.stringify(REPLAY_CORRIDOR_AGENT)}; the executor refuses to launch a run whose fresh agent keys cannot match the plan`,
          );
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Per-action fresh binding: the work-invocation index of the fresh run
  // equals the plan's (contiguous, v3-validated) per-agent roundIndex, because
  // the corridor's single agent consumes exactly one canned behavior per work
  // invocation and the probe/heartbeat never consume an index.
  const actionBindings = (plan.actions ?? []).map((action) => {
    const base = {
      actionId: action.id,
      type: action.type,
      agentId: action.agentId,
      runId: launchReceipt.freshRunId,
      roundIndex: action.roundIndex,
    };
    if (action.type === "replay.idle_dispatch") {
      return Object.freeze({ ...base, kind: "idle-observed" });
    }
    return Object.freeze({
      ...base,
      kind: "work",
      workIndex: action.roundIndex,
      expectedMode: action.type === "replay.unclaimed_exit" ? "die-before-claim" : "work",
    });
  });

  const binding = deepFreeze({
    bindingVersion: EXECUTION_BINDING_VERSION,
    executorVersion: EXECUTOR_VERSION,
    adapterVersion: plan.adapterVersion,
    runtime: plan.runtime,
    source: Object.freeze({
      sourceRunId: plan.recordRunId,
      recordPayloadSha256: plan.recordPayloadSha256,
    }),
    execution: Object.freeze({
      freshRunId: launchReceipt.freshRunId,
      workflowId: launchReceipt.workflowId,
      workdir: launchReceipt.workdir,
      launchedAtUtc: launchReceipt.launchedAtUtc,
      harnessType: launchReceipt.harnessType,
      corridorAgent: REPLAY_CORRIDOR_AGENT,
      corridorStep: REPLAY_CORRIDOR_STEP,
      executed: false, // flipped to true on the case report once the run is terminal
    }),
    actionBindings: Object.freeze(actionBindings),
  });
  return { ok: true, binding };
}

// ---------------------------------------------------------------------------
// verifyExecutionEvidence (pure)
// ---------------------------------------------------------------------------

/**
 * Verify the mechanical receipts of one actual fresh run against a binding.
 *
 * @param {object} options.binding   binding from buildExecutionBinding.
 * @param {object} options.receipts {
 *   runStatus, probes: { ok: number, failed: number, harness: string },
 *   tokens: { runs: number, system: number },
 *   steps: [{ step_id, agent_id, status, retry_count, output }],
 *   events: [{ event, runId, harness?, stepId?, ... }],
 *   invocations: [{ phase, workIndex, mode, ok?, note?, stepId?, runId?, agentId? }],
 *   workcounts: { [agentId]: number },
 * }
 * @returns {{ok:true, checks:Array}|{ok:false, checks:Array, errors:Array}}
 */
export function verifyExecutionEvidence({ binding, receipts } = {}) {
  const checks = [];
  const errors = [];
  const check = (name, pass, message) => checks.push({ name, pass: Boolean(pass), message });

  if (!isPlainObject(binding) || binding.bindingVersion !== EXECUTION_BINDING_VERSION) {
    return { ok: false, checks, errors: [{ code: "evidence-shape", message: "binding required" }] };
  }
  if (!isPlainObject(receipts)) {
    return { ok: false, checks, errors: [{ code: "evidence-shape", message: "receipts required" }] };
  }
  const freshRunId = binding.execution.freshRunId;
  const sourceRunId = binding.source.sourceRunId;

  /** Normalize a run id (strip a leading `run-` prefix) for comparison. */
  const norm = (id) => (typeof id === "string" ? id.replace(/^run-/, "") : null);
  /** Normalize a step-row id (strip a leading `step-` prefix). */
  const normStep = (id) => (typeof id === "string" ? id.replace(/^step-/, "") : null);
  const normFresh = norm(freshRunId);
  const normSource = norm(sourceRunId);
  const boundToFresh = (id) => norm(id) === normFresh;
  const boundToSource = (id) => norm(id) === normSource;

  // -- 0. Receipt shape / evidence completeness. Malformed or truncated
  //    event/journal input must be DIAGNOSED and refused, never silently
  //    dropped; a missing run row is not a zero-proof.
  const steps = Array.isArray(receipts.steps) ? receipts.steps : [];
  const events = Array.isArray(receipts.events) ? receipts.events : [];
  const invocations = Array.isArray(receipts.invocations) ? receipts.invocations : [];
  check("receipts-shape", Array.isArray(receipts.steps) && Array.isArray(receipts.events) && Array.isArray(receipts.invocations),
    "receipts must carry steps/events/invocations arrays");
  const diag = isPlainObject(receipts.collectDiagnostics) ? receipts.collectDiagnostics : null;
  const malformedEvents = Array.isArray(diag?.malformedEventLines) ? diag.malformedEventLines : [];
  const malformedInvocations = Array.isArray(diag?.malformedInvocationLines) ? diag.malformedInvocationLines : [];
  check("evidence-malformed-none", diag === null || (malformedEvents.length === 0 && malformedInvocations.length === 0),
    diag === null
      ? "collectDiagnostics absent on legacy receipts — treated as undiagnosed input, positive evidence still required below"
      : `malformed/truncated journal or event input must fail the case (events: ${malformedEvents.length}, invocations: ${malformedInvocations.length})`);
  check("evidence-run-row-found", diag === null || diag.runsRowFound === true,
    diag === null ? "runsRowFound absent on legacy receipts" : "the fresh run's DB row must be found — a missing run row can never prove zero tokens or a terminal status");
  const workcounts = isPlainObject(receipts.workcounts) ? receipts.workcounts : {};

  // -- 1. COMPLETE cross-run negatives AND fresh-run attribution: the
  //    immutable source run id must appear NOWHERE, and no event/step/journal
  //    row may bind ANY other (foreign) run — every applicable record must
  //    belong to the actual fresh run.
  const allBoundIds = [
    ...events.map((e) => norm(e.runId)),
    ...steps.map((s) => norm(s.run_id)),
    ...invocations.map((i) => norm(i.runId)),
  ].filter((r) => r !== null);
  check(
    "cross-run-negative",
    !allBoundIds.some((r) => r === normSource),
    `no receipt may bind to the immutable source run id ${sourceRunId}`,
  );
  const foreignBound = allBoundIds.filter((r) => r !== normFresh && r !== normSource);
  check(
    "no-foreign-identities",
    foreignBound.length === 0,
    `every event/step/journal receipt must bind the actual fresh run ${freshRunId}; foreign identities: ${[...new Set(foreignBound)].join(", ") || "(none)"}`,
  );

  // -- 2. Positive fresh-run receipts exist for the actual run.
  const freshSeen =
    steps.some((s) => boundToFresh(s.run_id)) && invocations.some((i) => boundToFresh(i.runId));
  check("fresh-run-receipts", freshSeen, `steps+journal must carry the fresh run id ${freshRunId}`);

  // -- 2b. Event rows. Two EXPLICIT checks so an empty event stream is a
  //    hard failure (an executed case's terminal/probe evidence lives in the
  //    per-run event file; zero events can never prove it), never a vacuous
  //    every() pass whose own failure message claims the opposite.
  const foreignEvents = events.filter((e) => !boundToFresh(e.runId));
  check("events-non-empty", events.length > 0,
    events.length === 0
      ? "no events observed — terminal/probe evidence cannot be proven from an empty event stream"
      : `event stream present (${events.length} rows)`);
  check("events-bound-to-fresh-run", events.length > 0 && foreignEvents.length === 0,
    events.length === 0
      ? "no events observed — an empty event stream cannot prove every event binds the fresh run"
      : `every event must bind the fresh run ${freshRunId} (got ${foreignEvents.length} foreign/unbound event(s))`);

  // -- 3. Terminal status.
  const expectedFinal = receipts.expectedFinalStatus ?? "completed";
  check("terminal-status", receipts.runStatus === expectedFinal,
    `run status ${JSON.stringify(receipts.runStatus)} expected ${expectedFinal}`);

  // -- 4. Probe: exactly one ok, harness matches, never failed.
  check("probe-ok-once", (receipts.probes?.ok ?? 0) === 1, `exactly one run.harness_probe_ok expected, got ${receipts.probes?.ok ?? 0}`);
  check("probe-never-failed", (receipts.probes?.failed ?? 0) === 0, `run.harness_probe_failed must be zero, got ${receipts.probes?.failed ?? 0}`);
  check("probe-harness", receipts.probes?.harness === binding.execution.harnessType,
    `probe harness ${JSON.stringify(receipts.probes?.harness)} must equal ${binding.execution.harnessType}`);

  // -- 5. Zero token ledger: explicit zeros from a FOUND run row; a null row
  //    (missing evidence) already fails evidence-run-row-found and here.
  check("run-tokens-zero", receipts.tokens?.runs === 0, `runs.tokens_spent must be 0, got ${receipts.tokens?.runs}`);
  check("system-tokens-zero", receipts.tokens?.system === 0, `tamandua_stats.system_tokens_spent must be 0, got ${receipts.tokens?.system}`);

  // -- 6. Zero idle (heartbeat) spawns: the deterministic motor must never
  //    spawn a harness without pending work (MOTOR N2 tripwire).
  const heartbeats = invocations.filter((i) => i.phase === "heartbeat");
  check("zero-heartbeat-spawns", heartbeats.length === 0,
    `zero heartbeat (idle) harness spawns expected, got ${heartbeats.length}`);

  // -- 6b. The launch-time harness probe is a separate round: it must never
  //    be journaled as an invocation (probe ≠ work; never consumes an index).
  const probeJournaled = invocations.filter((i) => /probe/i.test(String(i.note ?? "")));
  check("probe-not-journaled", probeJournaled.length === 0,
    `the harness probe must never be journaled as an invocation (got ${probeJournaled.length} entries)`);

  // -- 7. ACTUAL step-row identity: journal work/result stepId values are
  //    native claim receipts; when the fresh run's DB step rows carry their
  //    real `id`, every claimed work/result journal row must bind one of those
  //    actual row ids (never an unrelated display id and never a foreign
  //    step-row uuid).
  const freshStepRows = steps.filter((s) => boundToFresh(s.run_id));
  const freshCorridorStepRows = freshStepRows.filter((s) => s.step_id === REPLAY_CORRIDOR_STEP);
  const stepRowPool = freshCorridorStepRows.length > 0 ? freshCorridorStepRows : freshStepRows;
  const actualStepRowIds = new Set(stepRowPool.map((s) => normStep(s.id)).filter((v) => v !== null));
  const stepsCarryRowIds = stepRowPool.some((s) => isNonEmptyString(s.id));
  check("step-row-identity-evidenced", !stepsCarryRowIds || actualStepRowIds.size > 0,
    "when the fresh run's DB step rows carry row ids they must be present for binding (steps.id)");

  // -- 7a. Work invocation evidence per planned work action: EXACTLY one
  //    fresh-run work journal at the planned index/agent, correct mode,
  //    correct ok semantics for the result, and the journal step-row identity
  //    must equal the actual fresh-run step row.
  const workInvocationOk = (action) => {
    const freshInvs = invocations.filter(
      (i) => i.phase === "work" && boundToFresh(i.runId) && i.workIndex === action.roundIndex && i.agentId === action.agentId,
    );
    if (freshInvs.length !== 1) return `action ${action.id}: expected exactly one FRESH-run work journal at index ${action.roundIndex}, got ${freshInvs.length}`;
    const entry = freshInvs[0];
    if (entry.mode !== (action.type === "replay.unclaimed_exit" ? "die-before-claim" : "work")) {
      return `action ${action.id}: work mode ${JSON.stringify(entry.mode)}`;
    }
    if (action.type === "replay.unclaimed_exit") {
      // die-before-claim never claims: no result line, no step binding.
      const results = invocations.filter((i) => i.phase === "result" && boundToFresh(i.runId) && i.workIndex === action.roundIndex);
      if (results.length !== 0) return `action ${action.id}: unclaimed exit must not produce a result line`;
      if (entry.stepId !== undefined && entry.stepId !== null) {
        return `action ${action.id}: a die-before-claim round must never carry a claimed step row id`;
      }
      return null;
    }
    // claim actions: exactly one FRESH-run result line with matching ok.
    const results = invocations.filter(
      (i) => i.phase === "result" && boundToFresh(i.runId) && i.workIndex === action.roundIndex && i.agentId === action.agentId,
    );
    if (results.length !== 1) return `action ${action.id}: expected exactly one FRESH-run result journal at index ${action.roundIndex}, got ${results.length}`;
    const result = results[0];
    if (action.type === "replay.claim_complete" && result.ok !== true) return `action ${action.id}: claim_complete result must be ok`;
    if (action.type === "replay.claim_fail" && result.ok !== false) return `action ${action.id}: claim_fail result must be ok:false`;
    // The result's step-row identity must equal the identity of the step it
    // actually claimed (the work journal row for the same index) — a
    // completion bound to an unrelated step-row uuid is refused.
    if (normStep(entry.stepId) !== normStep(result.stepId)) {
      return `action ${action.id}: result step row ${JSON.stringify(result.stepId)} does not match the claimed work step row ${JSON.stringify(entry.stepId)}`;
    }
    if (actualStepRowIds.size > 0 && !actualStepRowIds.has(normStep(result.stepId))) {
      return `action ${action.id}: result step row ${JSON.stringify(result.stepId)} is not an actual step row of the fresh run (rows: ${[...actualStepRowIds].join(", ") || "(none)"})`;
    }
    return null;
  };
  const plannedWorkActions = (binding.actionBindings ?? []).filter((a) => a.kind === "work");
  for (const action of plannedWorkActions) {
    if (action.type === "replay.idle_dispatch") continue;
    const problem = workInvocationOk(action);
    check(`work-evidence-${action.actionId}`, problem === null, problem ?? `action ${action.actionId} journal matches`);
  }

  // -- 7b. COMPLETE work/result cardinality: the fresh-run journal must
  //    contain EXACTLY the planned work rows and EXACTLY one result per claim
  //    action — no duplicate, no unexplained extra result, no work/result row
  //    at an index/agent the plan never scheduled, and every work/result row
  //    must bind the fresh run.
  const plannedWorkKeys = new Map(); // `${agentId}:${workIndex}` -> action
  const plannedClaimKeys = new Map(); // `${agentId}:${workIndex}` -> action
  for (const action of plannedWorkActions) {
    const key = `${action.agentId}:${action.workIndex}`;
    plannedWorkKeys.set(key, action);
    if (action.type === "replay.claim_complete" || action.type === "replay.claim_fail") plannedClaimKeys.set(key, action);
  }
  const freshWorkRows = invocations.filter((i) => i.phase === "work" && boundToFresh(i.runId));
  const freshResultRows = invocations.filter((i) => i.phase === "result" && boundToFresh(i.runId));
  check(
    "work-cardinality",
    freshWorkRows.length === plannedWorkActions.length,
    `fresh-run work rows must equal planned work invocations exactly (${plannedWorkActions.length}), got ${freshWorkRows.length}`,
  );
  check(
    "result-cardinality",
    freshResultRows.length === plannedClaimKeys.size,
    `fresh-run result rows must equal planned claim actions exactly (${plannedClaimKeys.size}), got ${freshResultRows.length}`,
  );
  const extraWork = freshWorkRows.filter((i) => !plannedWorkKeys.has(`${i.agentId}:${i.workIndex}`));
  const extraResults = freshResultRows.filter((i) => !plannedClaimKeys.has(`${i.agentId}:${i.workIndex}`));
  check("no-unexplained-extra-work", extraWork.length === 0,
    `no fresh-run work row may sit at an unplanned index/agent (got ${extraWork.length})`);
  check("no-unexplained-extra-result", extraResults.length === 0,
    `no fresh-run result row may be a duplicate or sit at an unplanned index/agent (got ${extraResults.length})`);
  // No work/result row may bind a foreign run or lack the fresh-run
  // attribution entirely (all fresh-bound rows are already checked above via
  // no-foreign-identities; this pins the phase-specific requirement).
  const foreignWorkResult = invocations.filter(
    (i) => (i.phase === "work" || i.phase === "result") && !boundToFresh(i.runId),
  );
  check("work-result-fresh-bound", foreignWorkResult.length === 0,
    `every work/result journal row must belong to the actual fresh run (got ${foreignWorkResult.length} foreign/attribution-less)`);

  // -- 8. Step-level outcome: the corridor's single step ends done/failed as
  //    the final planned work action dictates, and its stored output is the
  //    byte-preserved claim_complete text when the run completed. The step row
  //    is the ACTUAL fresh-run corridor step row (real row identity).
  const step = stepRowPool.find((s) => s.step_id === REPLAY_CORRIDOR_STEP) ?? stepRowPool[0];
  const finalWork = [...(binding.actionBindings ?? [])].reverse().find((a) => a.kind === "work");
  if (finalWork && finalWork.type === "replay.claim_complete") {
    check("step-done", step?.status === "done", `step must be done, got ${JSON.stringify(step?.status)}`);
    const expectedOutput = receipts.expectedFinalOutput;
    if (typeof expectedOutput === "string") {
      check("step-output-bytes", step?.output === expectedOutput,
        `step stored output must equal the preserved report bytes (got ${JSON.stringify((step?.output ?? "").slice(0, 80))})`);
    }
    const failCount = (binding.actionBindings ?? []).filter((a) => a.type === "replay.claim_fail").length;
    if (failCount > 0) {
      check("step-retry-count", Number(step?.retry_count ?? 0) >= failCount,
        `step retry_count ${step?.retry_count} must reflect ${failCount} scripted fail(s)`);
    }
  } else if (finalWork && finalWork.type === "replay.claim_fail") {
    check("step-failed", step?.status === "failed", `step must be failed, got ${JSON.stringify(step?.status)}`);
  }

  // -- 9. Workcount equals the number of planned work actions (probe and
  //    idle rounds never advance it). Missing census evidence is not zero.
  const plannedWork = plannedWorkActions.length;
  const wc = workcounts[REPLAY_CORRIDOR_AGENT];
  const censusPresent = workcounts[REPLAY_CORRIDOR_AGENT] !== undefined || plannedWork === 0;
  check("workcount-census-present", censusPresent,
    `agent workcount census file must exist for a run with ${plannedWork} planned work invocation(s) — missing census evidence cannot default to zero`);
  check("workcount", Number(wc ?? 0) === plannedWork,
    `agent workcount must equal planned work invocations (${plannedWork}), got ${wc}`);

  if (errors.length > 0) return { ok: false, checks, errors };
  const failed = checks.filter((c) => !c.pass);
  return failed.length === 0 ? { ok: true, checks } : { ok: false, checks, errors };
}

// ---------------------------------------------------------------------------
// Real-host I/O helpers (execution side)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bind a real random port on 127.0.0.1 and return it (then release). */
export function reserveRandomPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Tri-state positive listener-release probe: after the daemon child exits,
 * nothing may be listening on its control port any more.
 *
 * Returns { state, detail } where state is:
 *  - "released"  — a connect was actively REFUSED (ECONNREFUSED): positive
 *    evidence the listener is gone.
 *  - "accepting" — a connect succeeded: something still accepts on the port.
 *  - "unknown"   — the observation timed out or failed with an unrelated
 *    error: this is UNKNOWN, never a positive release.
 */
export function probePortClosed(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      resolve({ state: "accepting", detail: "connection accepted" });
    });
    sock.on("error", (e) => {
      const code = e?.code ?? null;
      if (code === "ECONNREFUSED") resolve({ state: "released", detail: "ECONNREFUSED" });
      else resolve({ state: "unknown", detail: `${code ?? String(e)}` });
    });
    sock.setTimeout(700, () => {
      sock.destroy();
      resolve({ state: "unknown", detail: "observation timed out (neither refused nor accepted)" });
    });
  });
}

/** Run a command synchronously; throws with a bounded transcript on failure. */
export function runCliSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}

function cliPathFor(repoRoot) {
  return path.join(repoRoot, "dist", "cli", "cli.js");
}

function daemonScriptFor(repoRoot) {
  return path.join(repoRoot, "dist", "server", "daemon.js");
}

/**
 * Explicit child env for one isolated execution: private HOME + state dirs +
 * a real random control port, TAMANDUA_TEST_GUARD=1, and NOTHING ambient
 * except a minimal PATH/TMPDIR baseline. Never falls back to process.env or
 * the live HOME.
 */
export function buildIsolatedEnv({ homeDir, controlPort, tmpdir }) {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  const env = {
    HOME: homeDir,
    TAMANDUA_CONTROL_PORT: String(controlPort),
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: path.join(tamanduaDir, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDir, "worktrees"),
    TAMANDUA_TEST_GUARD: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: tmpdir,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TZ: process.env.TZ ?? "UTC",
    SHELL: "/bin/sh",
    USER: process.env.USER ?? "nobody",
    LOGNAME: process.env.LOGNAME ?? "nobody",
  };
  return env;
}

/**
 * Create one retained isolated sandbox under an evidence root. Nothing is
 * ever removed by this executor (evidence retention); the caller records the
 * returned root. Captures the real filesystem object identity of the sandbox
 * root at ALLOCATION time ({dev, ino} via lstat after realpath).
 */
export function createSandbox(evidenceRoot, label) {
  const root = fs.mkdtempSync(path.join(evidenceRoot, `${label}-`));
  const realRoot = fs.realpathSync(root);
  const st = fs.lstatSync(realRoot);
  const homeDir = path.join(root, "home");
  const tamanduaDir = path.join(homeDir, ".tamandua");
  const workdir = path.join(root, "workdir");
  const stateDir = path.join(root, "scripted-state");
  const binDir = path.join(root, "bin");
  const hermesHome = path.join(root, "hermes-home");
  const dshHome = path.join(root, "dsh-home");
  fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".pi", "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
    "utf-8",
  );
  return Object.freeze({
    root,
    homeDir,
    tamanduaDir,
    workdir,
    stateDir,
    binDir,
    hermesHome,
    dshHome,
    dbPath: path.join(tamanduaDir, "tamandua.db"),
    // Trusted object identity captured at allocation on the HOST-RESOLVED
    // real path (canonical aliases stay legitimate).
    admissionIdentity: Object.freeze({ root: Object.freeze({ dev: st.dev, ino: st.ino }) }),
  });
}

/** Materialize an executable wrapper that runs a frozen runtime via node. */
export function materializeRuntimeWrapper(sandbox, repoRoot, runtime) {
  const runtimeFile =
    runtime === "pi"
      ? path.join(repoRoot, "torture-test", "scripted-runtimes", "runtime-pi.mjs")
      : runtime === "dsh"
        ? path.join(repoRoot, "torture-test", "scripted-runtimes", "runtime-dsh.mjs")
        : path.join(repoRoot, "torture-test", "scripted-runtimes", "runtime-hermes.mjs");
  const binName = runtime === "pi" ? "scripted-pi" : runtime === "dsh" ? "scripted-dsh" : "scripted-hermes";
  const binPath = path.join(sandbox.binDir, binName);
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${runtimeFile}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

/** Write the behaviors file (from a validated plan) into the sandbox. */
export function materializeBehaviorsFile(sandbox, plan) {
  const seed = materializeRuntimeSeed(plan);
  const behaviorsPath = path.join(sandbox.root, "behaviors.json");
  fs.writeFileSync(
    behaviorsPath,
    JSON.stringify(seed.behaviorsConfig, null, 2),
    "utf-8",
  );
  return { behaviorsPath, seed };
}

/**
 * Open the isolated tamandua DB (node:sqlite) with a busy timeout. Async so
 * node:sqlite is only imported on the actual execution path — pure unit
 * regressions never load it.
 */
export async function openSandboxDbAsync(sandbox) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sandbox.dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** Install the corridor workflow into the isolated catalog. */
export function installCorridorWorkflow({ repoRoot, env }) {
  const r = runCliSync(process.execPath, [cliPathFor(repoRoot), "workflow", "install", REPLAY_CORRIDOR_WORKFLOW], { env });
  if (r.status !== 0) {
    throw new Error(`workflow install ${REPLAY_CORRIDOR_WORKFLOW} failed (${r.status}): ${(r.stderr ?? "").slice(0, 1000)}`);
  }
  return r.stdout ?? "";
}

/**
 * Spawn the isolated daemon on the exact child handle. Resolves when the
 * control plane prints its ready line. The caller owns the child handle.
 *
 * CORE-MOTOR-CLOSE refine: spawn-error awareness. When the child emits
 * 'error' (the process was NEVER spawned — e.g. ENOENT on the daemon script),
 * the returned handle records the message on `spawnError()` and `ready`
 * rejects with it. The caller's daemon-stop path must then recognize that no
 * process exists and never signal or wait for an exit that can never arrive
 * (mirror of attachRunCliLifecycle's spawnError short-circuit).
 */
export function spawnIsolatedDaemon({ repoRoot, env }) {
  const child = spawn(
    "node",
    ["--disable-warning=ExperimentalWarning", daemonScriptFor(repoRoot)],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let transcript = "";
  let resolved = false;
  let spawnError = null;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error(`daemon start timeout; transcript tail:\n${transcript.slice(-2000)}`));
    }, 20000);
    child.stdout.on("data", (c) => {
      transcript += c.toString();
      if (!resolved && transcript.includes("Tamandua control plane listening")) {
        resolved = true;
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (c) => {
      transcript += c.toString();
    });
    child.on("exit", (code, signal) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`daemon exited before ready (code ${code}, signal ${signal}); transcript:\n${transcript.slice(-2000)}`));
      }
    });
    child.on("error", (e) => {
      // Spawn failure: the child never started — no exit/close will ever
      // arrive and there is no process to signal. Record it for the caller.
      spawnError = e instanceof Error ? e.message : String(e);
      if (!resolved) {
        clearTimeout(timeout);
        reject(e);
      }
    });
  });
  return { child, ready, transcript: () => transcript, spawnError: () => spawnError };
}

/**
 * Stop the EXACT child handle this executor spawned and AWAIT its exit.
 *
 * Behavior contract (CORE-MOTOR-CLOSE):
 *  - Terminal handles are recognized IMMEDIATELY: a child whose exitCode or
 *    signalCode is already set (including an already-terminal-by-signal
 *    handle: exitCode null + signalCode set) is reported as-is — it is never
 *    re-signaled and no exit event is awaited (there will be none).
 *  - Live handles: the exit listener is installed BEFORE the first signal.
 *    An optional natural-exit grace (naturalGraceMs, used for the workflow-run
 *    launcher whose CLI returns right after printing `Run:`) polls the handle
 *    state first so a self-exiting child is observed without any signal.
 *  - Otherwise SIGTERM is sent to the exact handle exactly once; if no exit
 *    arrives within sigkillAfterMs a SIGKILL fallback is sent; if the handle
 *    still has not exited by settleAfterSigkillMs the record resolves with a
 *    stopError (cleanup failure) — the promise is TOTAL, never indefinite.
 *
 * Returns a record { code, signal, exitObserved, stopSignaled, stopError }.
 * Never stops any other process (no PIDfile/name/substring/stale-PID
 * targeting). Cleanup failures are surfaced as fields, never thrown away.
 */
export async function stopExactChild(
  child,
  { naturalGraceMs = 0, sigkillAfterMs = 5000, settleAfterSigkillMs = 3000 } = {},
) {
  const record = { code: null, signal: null, exitObserved: false, stopSignaled: false, stopError: null };
  if (!child || typeof child.kill !== "function" || typeof child.once !== "function") {
    record.stopError = "no exact child handle to stop";
    return record;
  }
  // Terminal-by-code or terminal-by-signal: recognize immediately, never
  // re-signal, never wait for a second exit event.
  if (child.exitCode !== null || child.signalCode !== null) {
    record.code = child.exitCode;
    record.signal = child.signalCode ?? null;
    record.exitObserved = true;
    return record;
  }
  const onExit = (code, signal) => {
    record.exitObserved = true;
    record.code = code;
    record.signal = signal;
  };
  child.once("exit", onExit);
  try {
    if (naturalGraceMs > 0 && !record.exitObserved) {
      const graceStart = Date.now();
      while (!record.exitObserved && Date.now() - graceStart < naturalGraceMs) {
        await sleep(25);
        if (child.exitCode !== null || child.signalCode !== null) {
          record.exitObserved = true;
          record.code = child.exitCode;
          record.signal = child.signalCode ?? null;
        }
      }
    }
    if (!record.exitObserved) {
      const sigkillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, sigkillAfterMs);
      sigkillTimer.unref?.();
      try {
        child.kill("SIGTERM");
        record.stopSignaled = true;
      } catch (e) {
        // ESRCH etc: if the handle is terminal now, report that; otherwise the
        // signal could not be delivered and the exit is unknown.
        if (child.exitCode !== null || child.signalCode !== null) {
          record.exitObserved = true;
          record.code = child.exitCode;
          record.signal = child.signalCode ?? null;
        } else {
          record.stopError = `SIGTERM delivery failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const deadline = Date.now() + sigkillAfterMs + settleAfterSigkillMs;
      while (!record.exitObserved && Date.now() < deadline) {
        await sleep(50);
        if (child.exitCode !== null || child.signalCode !== null) {
          record.exitObserved = true;
          record.code = child.exitCode;
          record.signal = child.signalCode ?? null;
        }
      }
      clearTimeout(sigkillTimer);
      if (!record.exitObserved && !record.stopError) {
        record.stopError = "child did not exit after SIGTERM/SIGKILL within the bounded settle window";
      }
    }
  } finally {
    child.removeListener?.("exit", onExit);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Workflow-run launcher ownership (CORE-MOTOR-CLOSE requirement C)
// ---------------------------------------------------------------------------

const RUN_PREFIX_RE = /^Run:\s+(?:run-)?([0-9a-f]{8,})/im;

/**
 * Own ONE child's run-cli launch lifecycle with all listeners installed
 * BEFORE any outcome can settle. Pure with respect to process creation: the
 * caller supplies the child handle (a real spawn in launchWorkflowRun, or an
 * injected recording handle in the focused regressions) so spawn errors,
 * premature exit and launch timeouts are exercised against the real code path
 * without OS signals.
 *
 * Returns:
 *   child   the owned handle
 *   ready   Promise<{ prefix, stdout, stderr }> — resolves ONCE the `Run:`
 *           protocol line is observed on stdout (the run is registered; the
 *           CLI has finished its launch work). Rejects on spawn error, on
 *           process exit BEFORE the line (exit is NOT conflated with stdout
 *           receipt), or on launch timeout. While ready is pending the caller
 *           must still stop() the child on rejection — ownership is explicit.
 *   closed  Promise<closeRecord> — resolves when the child exits/closes or a
 *           spawn error occurs (never rejects, never indefinite: bounded by
 *           the stop/settle windows once stop() is called).
 *   stop()  Exact-handle termination used AFTER the launch outcome: waits up
 *           to naturalExitGraceMs for the CLI to exit on its own (it returns
 *           right after `Run:`), then stops it exactly (SIGTERM → SIGKILL
 *           fallback) and AWAITS the exit. Resolves the close record; a
 *           cleanup failure is a field, never a throw.
 *   stdout()/stderr() accumulated byte text (never a preview).
 */
export function attachRunCliLifecycle({
  child,
  readyTimeoutMs = 30000,
  naturalExitGraceMs = 2500,
  sigkillAfterMs = 5000,
  settleAfterSigkillMs = 2500,
} = {}) {
  let stdoutBuf = "";
  let stderrBuf = "";
  let readySettled = false;
  let resolveReady = null;
  let rejectReady = null;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveClosed = null;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const record = { code: null, signal: null, exitObserved: false, spawnError: null, stopError: null, stopSignaled: false };

  const readyReject = (error) => {
    if (!readySettled) {
      readySettled = true;
      clearTimeout(readyTimer);
      rejectReady(error);
    }
  };
  const readyResolve = (info) => {
    if (!readySettled) {
      readySettled = true;
      clearTimeout(readyTimer);
      resolveReady(info);
    }
  };
  const settleClosed = () => {
    if (resolveClosed) {
      const rec = resolveClosed;
      resolveClosed = null;
      rec({ ...record });
    }
  };

  const readyTimer = setTimeout(() => {
    readyReject(new Error(`workflow run launch timeout (${readyTimeoutMs} ms); stdout:\n${stdoutBuf.slice(-1500)}`));
  }, readyTimeoutMs);
  readyTimer.unref?.();

  // ── listeners installed synchronously, BEFORE any action/outcome ──
  child.stdout.on("data", (c) => {
    stdoutBuf += c.toString();
    const m = RUN_PREFIX_RE.exec(stdoutBuf);
    if (m) readyResolve({ prefix: m[1], stdout: stdoutBuf, stderr: stderrBuf });
  });
  child.stderr.on("data", (c) => {
    stderrBuf += c.toString();
  });
  child.on("error", (e) => {
    // Spawn failure: no process was created — no exit will ever arrive.
    record.spawnError = e instanceof Error ? e.message : String(e);
    settleClosed();
    readyReject(e instanceof Error ? e : new Error(String(e)));
  });
  child.on("exit", (code, signal) => {
    // Process exit is DISTINCT from stdout receipt: only settle ready when
    // the protocol line was seen; otherwise this is a premature exit.
    record.exitObserved = true;
    record.code = code;
    record.signal = signal;
    settleClosed();
    readyReject(
      new Error(`workflow run exited before printing Run: (code ${code}, signal ${signal}); stdout:\n${stdoutBuf.slice(-1500)}`),
    );
  });
  child.on("close", (code, signal) => {
    record.code = code ?? record.code;
    record.signal = signal ?? record.signal;
    settleClosed();
  });

  const stop = () => {
    if (record.spawnError) {
      // The process never started: there is no child to terminate; the spawn
      // error is the (primary) failure and shutdown is trivially complete.
      return Promise.resolve({ ...record, exitObserved: false, stopError: null });
    }
    return stopExactChild(child, { naturalGraceMs: naturalExitGraceMs, sigkillAfterMs, settleAfterSigkillMs });
  };

  return {
    child,
    ready,
    closed,
    stop,
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    record,
  };
}

/**
 * Launch `workflow run` for the corridor workflow and OWN the child through
 * attachRunCliLifecycle. Returns the owned handle { child, ready, closed,
 * stop, stdout, stderr } — the caller awaits `ready`, then MUST `stop()` the
 * handle (natural-exit grace then exact SIGTERM) and await its exit before the
 * case may be considered cleanly shut down. No unowned child is ever left
 * behind: a ready rejection still leaves the handle stoppable by the caller.
 *
 * US-002 (TCMD cells): the optional `context` map ({ key: value, ... }) is
 * forwarded as repeated `--context <key>=<value>` launch flags so a replay
 * can ESTABLISH the run's TEST_CMD contract at launch (source 'launch', per
 * src/installer/run.ts WAVE-A TCMD US-004). This is the only way the do-now
 * corridor can reproduce a launch-declared command (the historical TCMD
 * specimens each declared a launch command that differed from the command
 * whose marker/ledger reached the landing). Pure argv shaping; no new
 * dependency and no product change.
 */
export function launchWorkflowRun({ repoRoot, env, taskText, workdir, hermes, dsh, readyTimeoutMs = 30000, context }) {
  const args = [
    "workflow", "run", REPLAY_CORRIDOR_WORKFLOW, taskText,
    "--working-directory-for-harness", workdir,
  ];
  if (hermes) args.push("--hermes-as-harness");
  // US-003 (BRUN dsh corridors): launch through the plain-stdout dsh harness
  // path (`--dsh-as-harness`), never a pi relabel.
  if (dsh) args.push("--dsh-as-harness");
  if (context && typeof context === "object") {
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === "string" && value.length > 0) {
        args.push("--context", `${key}=${value}`);
      }
    }
  }
  const child = spawn(process.execPath, [cliPathFor(repoRoot), ...args], { env });
  return attachRunCliLifecycle({ child, readyTimeoutMs });
}

/** Resolve the full run id from the isolated DB by prefix. */
export async function resolveFullRunId(sandbox, prefix) {
  const db = await openSandboxDbAsync(sandbox);
  try {
    for (let i = 0; i < 40; i += 1) {
      const row = db.prepare("SELECT id FROM runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1").get(`${prefix}%`);
      if (row) return row.id;
      await sleep(150);
    }
    throw new Error(`no run found for prefix ${prefix}`);
  } finally {
    db.close();
  }
}

/** Current run status via `workflow status`. */
export function workflowStatus({ repoRoot, env, runId }) {
  const r = runCliSync(process.execPath, [cliPathFor(repoRoot), "workflow", "status", runId], { env });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = text.match(/^Status:\s+(\S+)/m);
  return m ? m[1] : "unknown";
}

/**
 * Parse one newline-delimited JSON receipt stream WITHOUT ever silently
 * dropping a malformed/truncated line: every unparseable line is diagnosed
 * (count + 1-indexed line number + parse error + raw snippet, bounded) and
 * reported on the returned object as `malformed`. Callers decide how to treat
 * it; this executor's verification refuses malformed evidence.
 */
function parseJsonlDiagnosed(records, filePath) {
  const lines = records.split(/\r?\n/);
  const parsed = [];
  const malformed = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch (e) {
      malformed.push({
        lineNumber: i + 1,
        error: e instanceof Error ? e.message : String(e),
        snippet: line.slice(0, 200),
        file: filePath,
      });
    }
  }
  return { parsed, malformed };
}

/** Mechanical receipts from one run's isolated DB/events/journal. */
export async function collectReceipts(sandbox, runId, extra = {}) {
  const db = await openSandboxDbAsync(sandbox);
  let runsRow = null;
  let steps = [];
  let stats = null;
  try {
    runsRow =
      db.prepare("SELECT id, status, harness_probe_status, tokens_spent FROM runs WHERE id = ?").get(runId) ?? null;
    // `id` is the ACTUAL step-row identity in the fresh run's DB; journal
    // stepId values (native claim receipts) must bind these ids, never an
    // unrelated display step_id.
    steps = db
      .prepare(
        "SELECT id, step_id, agent_id, status, retry_count, output, run_id FROM steps WHERE run_id = ? ORDER BY step_index",
      )
      .all(runId);
    stats = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get() ?? { system_tokens_spent: null };
  } finally {
    db.close();
  }
  const eventsPath = path.join(sandbox.tamanduaDir, "events", `${runId}.jsonl`);
  const eventsFilePresent = fs.existsSync(eventsPath);
  const eventsParsed = eventsFilePresent
    ? parseJsonlDiagnosed(fs.readFileSync(eventsPath, "utf-8"), eventsPath)
    : { parsed: [], malformed: [] };
  const invPath = path.join(sandbox.stateDir, "invocations.jsonl");
  const invocationsFilePresent = fs.existsSync(invPath);
  const invParsed = invocationsFilePresent
    ? parseJsonlDiagnosed(fs.readFileSync(invPath, "utf-8"), invPath)
    : { parsed: [], malformed: [] };
  const workcounts = {};
  const wcPath = path.join(sandbox.stateDir, `${REPLAY_CORRIDOR_AGENT}.workcount`);
  const workcountFilePresent = fs.existsSync(wcPath);
  if (workcountFilePresent) {
    workcounts[REPLAY_CORRIDOR_AGENT] = parseInt(fs.readFileSync(wcPath, "utf-8").trim(), 10) || 0;
  }

  const events = eventsParsed.parsed;
  const invocations = invParsed.parsed;
  const probeEvents = events.filter((e) => e.event === "run.harness_probe_ok" || e.event === "run.harness_probe_failed");
  const runsRowFound = runsRow !== null;
  // Missing token/output/census evidence is never silently defaulted to
  // zero: the collector reports presence explicitly so verification can fail
  // closed when the underlying row/file is absent.
  return {
    runStatus: runsRow?.status ?? null,
    harnessProbeStatus: runsRow?.harness_probe_status ?? null,
    runsRowFound,
    probes: {
      ok: events.filter((e) => e.event === "run.harness_probe_ok").length,
      failed: events.filter((e) => e.event === "run.harness_probe_failed").length,
      harness: probeEvents[0]?.harness ?? null,
    },
    tokens: {
      runs: runsRowFound ? runsRow.tokens_spent : null,
      system: stats?.system_tokens_spent ?? null,
      tokenUpdateEvents: events.filter((e) => e.event === "run.tokens.updated").length,
    },
    steps,
    events,
    invocations,
    workcounts,
    collectDiagnostics: {
      runsRowFound,
      eventsFilePresent,
      invocationsFilePresent,
      workcountFilePresent,
      malformedEventLines: eventsParsed.malformed,
      malformedInvocationLines: invParsed.malformed,
    },
    ...extra,
  };
}

const TERMINAL = new Set(["completed", "done", "failed", "canceled"]);

/**
 * Poll the run to a terminal status with nudges (like the product scripted
 * suites' pollForRunCompletionWithNudge). Returns the final status.
 */
export async function pollRunToTerminal({ repoRoot, env, runId, timeoutMs = 150000, nudgeMs = 900 }) {
  const started = Date.now();
  let status = "unknown";
  while (Date.now() - started < timeoutMs) {
    status = workflowStatus({ repoRoot, env, runId });
    if (TERMINAL.has(status)) return status;
    runCliSync(process.execPath, [cliPathFor(repoRoot), "nudge"], { env });
    await sleep(nudgeMs);
  }
  throw new Error(`run ${runId} did not reach a terminal status within ${timeoutMs} ms (last: ${status})`);
}

// ---------------------------------------------------------------------------
// executeReplayCase — one full isolated real-motor replay case
// ---------------------------------------------------------------------------

/**
 * Execute ONE validated replay plan as a REAL isolated motor run through the
 * corridor workflow (do-now) on the frozen runtime for `plan.runtime`.
 *
 * CORE-MOTOR-CLOSE entry-path contract:
 *  - The plan is re-validated on THIS entry path by validateExecutablePlan
 *    BEFORE any effect: createSandbox / workflow install / daemon spawn never
 *    run for an invalid/foreign/malformed/unknown plan — such a plan returns a
 *    refused ok:false report (executed:false, sandbox:null) with zero effect
 *    calls. The explicit validated-plan trust boundary is enforced here, not
 *    only by caller-side validation.
 *  - Every child (isolated daemon AND the workflow-run launcher) is owned by
 *    its exact handle and awaited; cleanup failures are surfaced separately
 *    from the primary error, and a case is never success while any required
 *    child/listener shutdown is unknown or failed.
 *  - The optional `host` object injects/records the executor's own OS-effect
 *    functions (createSandbox, reserveRandomPort, materializeBehaviorsFile,
 *    materializeRuntimeWrapper, installCorridorWorkflow, spawnIsolatedDaemon,
 *    launchWorkflowRun, resolveFullRunId, pollRunToTerminal, collectReceipts,
 *    stopExactChild, probePortClosed) for the focused regressions that prove
 *    zero effect calls on refusal. It is a test-only seam over the executor's
 *    own named functions — no general shell/eval and no new native
 *    abstraction. Defaults are the real implementations.
 *
 * @param {object} opts
 * @param {object} opts.plan          adapter-validated plan (source-bound).
 * @param {string} opts.repoRoot      absolute checkout root (dist built).
 * @param {string} opts.evidenceRoot  retained evidence directory (created).
 * @param {string} opts.taskText      synthetic task text for the run.
 * @param {string} opts.caseId        short case id used in labels.
 * @param {Function} [opts.onTerminal] optional async (ctx) => any hook invoked
 *   AFTER the run reaches terminal status and the settle window, while the
 *   daemon is still alive and the sandbox env is available. ctx =
 *   { repoRoot, env, runId, sandbox }. Its return value is recorded on the
 *   case report as `postTerminal` (used for post-terminal idle observations).
 * @param {Function} [opts.onDaemonReady] optional async (ctx) => any hook
 *   invoked right AFTER the daemon reports ready and BEFORE the workflow run
 *   is created, while the daemon is up with NO pending run (the pre-run idle
 *   window). ctx = { repoRoot, env, runId: null, sandbox }. Its return value
 *   is recorded on the case report as `preRunIdle` (used to evidence that an
 *   idle daemon with no run spawns zero harness work on real nudges).
 * @param {object} [opts.fault] TEST-ONLY deterministic fault injection for
 *   the forced-failure regression: { stage: "launch", message } makes the
 *   launch step fail with Error(message) right after the daemon is ready and
 *   before any run is created, so the executor's REAL error-recording path
 *   (catch → ok:false case report carrying the primary error → exact child
 *   shutdown → control-port release evidence) is exercised at runtime. Never
 *   set outside the forced-failure regression; the executor performs real
 *   daemon spawn/ready/stop around the injected failure.
 * @param {object} [opts.host] TEST-ONLY injectable/recording OS-effect seam
 *   (see above); every provided function replaces the executor default.
 * @param {object} [opts.launchContext] OPTIONAL { key: value } launch-context
 *   map forwarded to `workflow run` as repeated `--context key=value` flags
 *   (US-002 TCMD cells: launch-declared `test_cmd` establishment). Pure argv
 *   shaping; validated nowhere else because it never changes the plan's
 *   authority/identity contract (the fresh run id still comes exclusively
 *   from the actual launch receipt).
 * @returns {Promise<object>} case report (see shape below).
 */
export async function executeReplayCase({
  plan,
  repoRoot,
  evidenceRoot,
  taskText,
  caseId,
  onTerminal,
  onDaemonReady,
  fault,
  host,
  launchContext,
}) {
  const startedAtUtc = new Date().toISOString();
  const fx = (name, fallback) => (isPlainObject(host) && typeof host[name] === "function" ? host[name] : fallback);

  // ── B. Pre-effect validated-plan trust boundary on the ACTUAL entry path:
  //    nothing below (sandbox creation, workflow install, runtime wrapper,
  //    daemon spawn, run launch) may run for a plan that fails these checks.
  const planCheck = validateExecutablePlan(plan);
  if (!planCheck.ok) {
    const summary = planCheck.errors.map((e) => `${e.code}@${e.path}`).join(", ");
    return {
      ok: false,
      caseId,
      runtime: isPlainObject(plan) ? (plan.runtime ?? null) : null,
      executed: false,
      refused: true,
      refusalErrors: planCheck.errors,
      error: describeError(new Error(`executeReplayCase refused before any effect (validated-plan boundary): ${summary}`)),
      freshRunId: null,
      sandbox: null,
      daemonStop: null,
      launchStop: null,
      binding: null,
      receipts: null,
      postTerminal: null,
      preRunIdle: null,
      launchReceipt: null,
    };
  }
  const runtime = plan.runtime;

  let sandbox = null;
  let env = null;
  let behaviorsPath = null;
  let daemon = null;
  let launch = null;
  let launchStop = null;
  let daemonExit = null;
  let receipts = null;
  let binding = null;
  let freshRunId = null;
  let runCliStdout = "";
  let preRunIdle = null;
  let postTerminal = null;
  let result = null;
  let primaryError = null;

  try {
    sandbox = fx("createSandbox", createSandbox)(evidenceRoot, `sandbox-${caseId}`);
    env = buildIsolatedEnv({
      homeDir: sandbox.homeDir,
      controlPort: await fx("reserveRandomPort", reserveRandomPort)(),
      tmpdir: sandbox.root,
    });

    ({ behaviorsPath } = fx("materializeBehaviorsFile", materializeBehaviorsFile)(sandbox, plan));
    const wrapper = fx("materializeRuntimeWrapper", materializeRuntimeWrapper)(sandbox, repoRoot, runtime);

    fx("installCorridorWorkflow", installCorridorWorkflow)({ repoRoot, env });

    const daemonEnv = {
      ...env,
      [runtimeBinaryEnvVar(runtime)]: wrapper,
      TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
      TAMANDUA_SCRIPTED_STATE: sandbox.stateDir,
      TAMANDUA_HARNESS_PROBE: "1",
    };
    if (runtime === "hermes") {
      daemonEnv.HERMES_HOME = sandbox.hermesHome;
      daemonEnv.TAMANDUA_PI_BINARY = "/usr/bin/false"; // accidental pi spawns fail loudly
    }

    daemon = fx("spawnIsolatedDaemon", spawnIsolatedDaemon)({ repoRoot, env: daemonEnv });
    await daemon.ready;

    // Pre-run idle observation window: the daemon is up and NO run has been
    // created yet. Real nudges during this window must spawn zero harness
    // work (the deterministic motor's idle property) — the caller's
    // onDaemonReady hook measures it while the daemon is genuinely idle.
    preRunIdle =
      typeof onDaemonReady === "function"
        ? await onDaemonReady({ repoRoot, env, runId: null, sandbox })
        : null;

    // TEST-ONLY forced-failure injection (forced-failure regression): the
    // launch step fails with the injected primary error right after the
    // daemon is ready and before any run is created. Everything downstream —
    // the catch path that must record an ok:false report carrying THIS error
    // (never a ReferenceError), the exact child shutdown, and the control-port
    // release probe — is the real executor code.
    if (fault && fault.stage === "launch") {
      throw new Error(fault.message ?? "injected launch failure (forced-failure regression)");
    }

    // ── C. Own the workflow-run launcher child: listeners are installed
    //    inside launchWorkflowRun BEFORE any outcome settles; `ready`
    //    resolves on the stdout `Run:` receipt (never conflated with process
    //    exit), then `stop()` reaps the child (natural-exit grace then exact
    //    SIGTERM) and AWAITS its exit before the case may proceed.
    launch = fx("launchWorkflowRun", launchWorkflowRun)({
      repoRoot,
      env,
      taskText,
      workdir: sandbox.workdir,
      hermes: runtime === "hermes",
      context: launchContext,
    });
    const runInfo = await launch.ready;
    runCliStdout = runInfo.stdout;
    freshRunId = await fx("resolveFullRunId", resolveFullRunId)(sandbox, runInfo.prefix);
    launchStop = await launch.stop();
    if (launchStop.stopError) {
      throw new Error(`workflow-run launcher cleanup failure: ${launchStop.stopError} (primary case work cannot be trusted with an unowned child)`);
    }

    const runStatus = await fx("pollRunToTerminal", pollRunToTerminal)({ repoRoot, env, runId: freshRunId });
    // Settle window: the final round's usage attribution can land just after
    // the terminal event; drain it so zero-token assertions are not racy.
    await sleep(1500);

    postTerminal =
      typeof onTerminal === "function"
        ? await onTerminal({ repoRoot, env, runId: freshRunId, sandbox })
        : null;

    const launchReceipt = {
      freshRunId,
      workflowId: REPLAY_CORRIDOR_WORKFLOW,
      workdir: sandbox.workdir,
      launchedAtUtc: startedAtUtc,
      harnessType: runtime,
    };
    const bindRes = buildExecutionBinding({ plan, launchReceipt });
    if (!bindRes.ok) {
      throw new Error(`execution binding refused: ${JSON.stringify(bindRes.errors)}`);
    }
    binding = bindRes.binding;

    // The final completing action's preserved text is what the step must
    // store byte-for-byte (single-outputRef plans; joined when several).
    const finalComplete = [...plan.actions].reverse().find((a) => a.type === "replay.claim_complete");
    const expectedFinalOutput =
      finalComplete && Array.isArray(finalComplete.preservedOutputTexts)
        ? finalComplete.preservedOutputTexts.map((o) => o.text).join("\n")
        : null;

    receipts = await fx("collectReceipts", collectReceipts)(sandbox, freshRunId, {
      expectedFinalStatus: planExpectedFinalStatus(plan),
      expectedFinalOutput,
      runCliStdout,
    });

    result = {
      ok: true,
      caseId,
      runtime,
      executed: true,
      binding: {
        ...binding,
        execution: { ...binding.execution, executed: true },
      },
      freshRunId,
      runStatus: receipts.runStatus,
      sandbox: sandbox.root,
      artifacts: {
        dbPath: sandbox.dbPath,
        eventsPath: path.join(sandbox.tamanduaDir, "events", `${freshRunId}.jsonl`),
        invocationsPath: path.join(sandbox.stateDir, "invocations.jsonl"),
        behaviorsPath,
        stateDir: sandbox.stateDir,
      },
      receipts,
      launchReceipt,
      launchStop,
      postTerminal,
      preRunIdle,
    };
  } catch (e) {
    primaryError = e;
    result = {
      ok: false,
      caseId,
      runtime,
      executed: true,
      error: describeError(e),
      freshRunId,
      sandbox: sandbox ? sandbox.root : null,
      binding,
      receipts,
      launchStop,
      postTerminal,
      preRunIdle,
      launchReceipt: freshRunId
        ? { freshRunId, workflowId: REPLAY_CORRIDOR_WORKFLOW, workdir: sandbox.workdir, launchedAtUtc: startedAtUtc, harnessType: runtime }
        : null,
    };
  } finally {
    // Exact daemon shutdown on its OWN handle, awaited (never a PIDfile/name/
    // substring/stale-PID target, never another run's daemon).
    if (daemon) {
      try {
        // CORE-MOTOR-CLOSE refine: daemon spawn-error awareness. If the child
        // emitted 'error' the process NEVER spawned — no exit/close will ever
        // arrive and there is nothing to signal. Mirror attachRunCliLifecycle's
        // spawnError short-circuit: record the spawn error (exitObserved
        // false, NO stopError) instead of SIGTERM-ing a nonexistent process
        // and stalling the full bounded settle window.
        const daemonSpawnError = typeof daemon.spawnError === "function" ? daemon.spawnError() : null;
        if (daemonSpawnError) {
          daemonExit = { code: null, signal: null, exitObserved: false, stopSignaled: false, stopError: null, spawnError: daemonSpawnError };
        } else {
          daemonExit = await fx("stopExactChild", stopExactChild)(daemon.child);
        }
      } catch (e) {
        daemonExit = { code: null, signal: null, exitObserved: false, stopSignaled: false, stopError: e instanceof Error ? e.message : String(e) };
      }
    }
    // Exact launcher shutdown whenever a launcher was created but not yet
    // reaped (its `ready` rejected — spawn error / premature exit / launch
    // timeout — or an exception raced ahead of stop()).
    if (launch && !launchStop) {
      try {
        launchStop = await launch.stop();
      } catch (e) {
        launchStop = { code: null, signal: null, exitObserved: false, stopSignaled: false, stopError: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  // ── Cleanup / shutdown evidence ──────────────────────────────────────
  // Only children that were actually CREATED are required to be cleanly
  // shut down; a refused/early-failed case with no daemon/launcher has no
  // child to own. Every created child must be positively closed.
  const daemonNeverSpawned = Boolean(daemonExit && daemonExit.spawnError);
  const controlPort = env ? Number(env.TAMANDUA_CONTROL_PORT) : NaN;
  const portProbe =
    daemon && !daemonNeverSpawned && Number.isInteger(controlPort) && controlPort > 0
      ? await fx("probePortClosed", probePortClosed)(controlPort)
      : {
          state: daemonNeverSpawned
            ? "not-applicable"
            : daemon
              ? "unknown"
              : "unknown",
          detail: daemonNeverSpawned
            ? `daemon never spawned (${daemonExit.spawnError}) — no process or control listener ever existed`
            : daemon
              ? "no control port observed"
              : "no daemon was created",
        };
  const portReleased = portProbe.state === "released";
  const daemonStop = daemonExit ?? { code: null, signal: null, exitObserved: false, stopSignaled: false, stopError: null };
  const cleanupFailures = [];
  if (daemon) {
    if (daemonNeverSpawned) {
      // A daemon that never spawned created no process and no control
      // listener: there is nothing to shut down and nothing to release. The
      // primary spawn error already fails the case; it is NOT a cleanup
      // failure (mirror of the launcher spawnError path).
    } else {
      if (!daemonStop.exitObserved || daemonStop.stopError) {
        cleanupFailures.push(
          `daemon shutdown not positively observed (exitObserved=${daemonStop.exitObserved}, code=${daemonStop.code}, stopError=${daemonStop.stopError ?? "none"})`,
        );
      }
      if (!portReleased) {
        cleanupFailures.push(`control listener release not positively evidenced (${portProbe.state}: ${portProbe.detail})`);
      }
    }
  }
  if (launch && launchStop) {
    if (launchStop.stopError) {
      cleanupFailures.push(`workflow-run launcher cleanup failure: ${launchStop.stopError}`);
    } else if (launchStop.exitObserved !== true && !launchStop.spawnError) {
      cleanupFailures.push("workflow-run launcher shutdown not positively observed (no exit, no spawn error)");
    }
  }
  const cleanup = { clean: cleanupFailures.length === 0, failures: cleanupFailures };
  result.daemonStop = { ...daemonStop, controlPortState: portProbe.state, controlPortReleased: portReleased, controlPortDetail: portProbe.detail };
  result.launchStop = launchStop ?? null;
  result.cleanup = cleanup;
  // A case is NEVER success while any required child/listener shutdown is
  // unknown or failed: surface the cleanup failure separately from the
  // primary error and flip ok:false.
  if (result.executed && result.ok === true && !cleanup.clean) {
    result.ok = false;
    result.cleanupError = cleanup.failures.join("; ");
  }
  return result;
}

// Executor marker for CLI diagnostics only (never exported as the protocol).
export const __executor = { EXECUTOR_VERSION };
