/**
 * G8 ADMISSION-INTEGRATION (US-005) — the SCHEDULED launch-gate adapter.
 *
 * A scheduled Hermes round is a launch: `runHermesInvocation` mounts the
 * caller's effective Hermes profile **read-write** into a fresh VM, exactly
 * like the interactive `tamandua matchlock hermes` surface. Stock Hermes may
 * open its stores in the write-ahead-log format, which the guest cannot safely
 * roll back on crash, so the SAME gate that protects the interactive surfaces
 * must protect every scheduled dispatch — and it must run BEFORE any VM is
 * created.
 *
 * This module is the PRODUCTION ADAPTER between a scheduler round
 * (`scheduler-matchlock.ts` `runMatchlockSchedulerRound`) and the one wiring
 * core (`launch-gate-wiring.ts`):
 *
 *   1. The scope is resolved from the round's PERSISTED policy only:
 *      `hermesSubmissionFromPolicy(policy)` -> `resolveHermesAdapterPlan` ->
 *      `admitHermesConfigMount`. That is the same chain (and the same
 *      admission) the production invocation runner will re-run at launch, so
 *      the gate evaluates the directory the guest will actually mount — never
 *      ambient daemon state, and never a re-derived profile.
 *   2. `profileHome` is the ADMITTED canonical host config directory
 *      (`hostConfigDir`, i.e. the realpath `admitHermesConfigMount` returned)
 *      and the mount plan is the identical-path RW plan for the approved
 *      guest `HERMES_HOME` (`{[guestConfigDir]: {host_path: hostConfigDir}}`).
 *      The wiring never rebuilds either.
 *   3. A refusal is the wiring's own receipted refusal. This module never
 *      creates, mounts or dispatches anything, and it never throws at its
 *      caller: every failure to even resolve the scope becomes an
 *      OPERATIONAL refusal recorded by the wiring (through the selection
 *      seam), so "the gate could not look" is never silently an allow.
 *   4. Only `policy.harness === "hermes"` is gated. A pi or dsh policy makes
 *      NO gate call at all (both adapters return `null`), so the native pi
 *      and dsh routes are byte-identical to before this story.
 *
 * TWO EVALUATION POINTS. The brief requires the gate at DISPATCH and AGAIN at
 * ATTEMPT, because a queued round can wait hours behind a workdir holder and a
 * stale dispatch-time verdict must not authorise a launch. The two evaluations
 * are the same core with different invocation identities
 * (`run:<runId>:round:<jobId>:dispatch` vs `...:attempt`) and different
 * receipt kinds, so the evidence says which evaluation authorised what.
 * US-005 wires the DISPATCH evaluation; US-006 supplies the attempt-time one
 * and populates `RunHermesInvocationOptions.launchGate` (the controller
 * backstop US-004 built) from its binding.
 *
 * REFUSAL IS TERMINAL FOR THE RUN, NOT FOR THE JOB. The incident this bead
 * exists for produced an eighteen-round retry loop. A refusal here must never
 * be able to reproduce it, so `recordScheduledLaunchGateRefusal` records the
 * refusal ONCE (a durable `run.matchlock_gate_refused` event plus the gate
 * receipt on disk) and then puts the run in the only blocked-equivalent state
 * this state machine actually has: `forceFailRun` sets `status = 'failed'`,
 * clears `scheduling_status` (so `reconcileOnce()` cannot re-admit it — an
 * `'error'` scheduling state WOULD be re-admitted) and tears the run's crons
 * down. Every later dispatch tick for that run returns at the scheduler's
 * existing `run_not_running` guard, before the peek, before the probe, before
 * any VM. The recorder re-checks the run's status before it emits, so a tick
 * that races the terminal transition cannot produce a second event.
 *
 * NO LEASE (unchanged from the wiring). Concurrent admissions may both pass;
 * the receipt states that limitation itself (`NO_LEASE_LIMITATION`).
 *
 * MODULE BOUNDARY. This adapter imports the Hermes submission/admission chain
 * (`hermes-invocation-runner.ts`), which is spawn-capable, so this module and
 * its test live in the SERIAL lane. The wiring core it drives stays
 * child_process-free.
 */

import fs from "node:fs";

import { getDb } from "../../db.js";
import { nowIso } from "../../lib/instant.js";
import { logger } from "../../lib/logger.js";
import { getRunEvents, emitEvent, type TamanduaEvent } from "../events.js";
import type { EffectiveJournalModeOptions } from "./doctor-gate.js";
import { GATE_RECEIPT_UNREADABLE, parseReceipt } from "./gate-receipt.js";
import type { HermesConfigMountSpec } from "./hermes-invocation-runner.js";
import { admitHermesConfigMount } from "./hermes-invocation-runner.js";
import type { HermesAdapterPlan } from "./hermes-adapter.js";
import { resolveHermesAdapterPlan } from "./hermes-adapter.js";
import {
  evaluateAndRecordLaunchGate,
  type LaunchGateDecision,
  type LaunchGateInvocationKind,
  type LaunchGateInvocationScope,
  type LaunchGateRefusal,
  type LaunchGateResolvedProfile,
  type LaunchGateSelectionResolver,
  type LaunchGateWiringDeps,
} from "./launch-gate-wiring.js";
import type { ExecutionIsolation } from "./policy.js";
import { hermesSubmissionFromPolicy, type MatchlockSchedulerRound } from "./scheduler-matchlock.js";
import type { StoreMountPlan } from "./store-set.js";

// ---------------------------------------------------------------------------
// invocation identity
// ---------------------------------------------------------------------------

/** Which scheduled evaluation this is: the dispatch preflight or the attempt preflight. */
export type ScheduledLaunchGatePhase = "dispatch" | "attempt";

/** The wiring kind recorded for each phase. */
export function scheduledLaunchGateKind(phase: ScheduledLaunchGatePhase): LaunchGateInvocationKind {
  return phase === "attempt" ? "scheduled-attempt" : "scheduled-dispatch";
}

/**
 * Normalize a run id for embedding in an invocation id.
 *
 * A scheduler round may carry either the bare uuid or the `run-` prefixed
 * spelling. The invocation id must be STABLE for one run/round regardless of
 * which spelling reached this module (it is the receipt filename and the
 * backstop's binding key), so the prefix is stripped once, here.
 */
function bareRunId(runId: string): string {
  return typeof runId === "string" && runId.startsWith("run-") ? runId.slice("run-".length) : (runId ?? "");
}

/**
 * The invocation id binding one scheduled evaluation to its verdict:
 * `run:<runId>:round:<jobId>:<phase>`.
 *
 * The dispatch job id is stable across a daemon restart (it is
 * `buildJobId(workflowId, runId, agentId)`), so the id names the same
 * dispatch across restarts — a receipt written by a crashed daemon is still
 * THIS dispatch's evidence. A `workflow resume` re-registers the same job id,
 * so a resumed run re-evaluates into the same evidence slot: the newest
 * observation overwrites the previous refusal for that dispatch, which is
 * exactly the honest record ("what the gate said the last time this dispatch
 * was admitted").
 */
export function scheduledLaunchGateInvocationId(input: {
  runId: string;
  jobId: string;
  phase: ScheduledLaunchGatePhase;
}): string {
  const runId = bareRunId(input?.runId);
  const jobId = typeof input?.jobId === "string" ? input.jobId : "";
  const phase: ScheduledLaunchGatePhase = input?.phase === "attempt" ? "attempt" : "dispatch";
  return `run:${runId}:round:${jobId}:${phase}`;
}

/**
 * The identical-path-class mount plan for the approved guest `HERMES_HOME`:
 * guest destination -> the canonical host directory the runner will mount RW.
 *
 * This is the plan the controller is handed, so it is the plan the gate
 * evaluates (the wiring never re-derives one).
 */
export function scheduledLaunchGateMountPlan(
  hostConfigDir: string,
  guestConfigDir: string,
): StoreMountPlan {
  const host = typeof hostConfigDir === "string" ? hostConfigDir : "";
  const guest = typeof guestConfigDir === "string" ? guestConfigDir : "";
  if (host === "" || guest === "") return { mounts: {} };
  return { mounts: { [guest]: { host_path: host } } };
}

// ---------------------------------------------------------------------------
// deps
// ---------------------------------------------------------------------------

/**
 * Everything the scheduled adapter needs. The wiring seams are forwarded
 * unchanged; the fields below are scheduled-specific.
 */
export interface ScheduledLaunchGateDeps extends LaunchGateWiringDeps {
  /**
   * The FROZEN Hermes submission inputs. Default: the round's persisted
   * policy (`hermesSubmissionFromPolicy`). A caller that already resolved them
   * passes the same triple the runner will use.
   */
  submission?: ReturnType<typeof hermesSubmissionFromPolicy>;
  /** Adapter-plan seam (tests). Default `resolveHermesAdapterPlan`. */
  resolveAdapterPlan?: (submission: ReturnType<typeof hermesSubmissionFromPolicy>) => HermesAdapterPlan;
  /** Config-mount admission seam (tests). Default `admitHermesConfigMount`. */
  admitConfigMount?: (plan: HermesAdapterPlan) => HermesConfigMountSpec;
  /** Effective journal-mode observation options (managed scope, env). */
  configOptions?: EffectiveJournalModeOptions;
}

/** One scheduled evaluation. `null` means "this policy is not gated". */
export type ScheduledLaunchGateEvaluator = (
  round: MatchlockSchedulerRound,
  deps?: ScheduledLaunchGateDeps,
) => LaunchGateDecision | null;

// ---------------------------------------------------------------------------
// scope resolution
// ---------------------------------------------------------------------------

/** The wiring scope plus the selection resolver that answers for it. */
interface ResolvedScheduledScope {
  scope: LaunchGateInvocationScope;
  selection: LaunchGateSelectionResolver;
}

/** Bound an error to one line so a refusal never carries a stack dump. */
function describeError(error: unknown): string {
  try {
    const text =
      error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
    return text === "" ? "unknown failure" : text.replace(/\s+/g, " ").trim();
  } catch {
    return "unknown failure";
  }
}

/**
 * Resolve the gate scope for one scheduled round from the round's PERSISTED
 * policy.
 *
 * Resolution failures are NOT thrown: the returned selection resolver throws
 * the original error inside the wiring's own try/catch, which turns it into a
 * recorded OPERATIONAL refusal (receipt written first, the ten reason codes
 * untouched). That keeps one refusal path for every failure shape — a policy
 * with no frozen submission block, a selectable-but-unmountable profile, a
 * refused mount source — instead of a second, receiptless refusal class here.
 */
function resolveScheduledGateScope(
  round: MatchlockSchedulerRound,
  phase: ScheduledLaunchGatePhase,
  deps: ScheduledLaunchGateDeps,
): ResolvedScheduledScope {
  const identity = round?.identity ?? { runId: "", jobId: "", agentId: "", workflowId: "" };
  const invocationId = scheduledLaunchGateInvocationId({
    runId: identity.runId,
    jobId: identity.jobId,
    phase,
  });
  const kind = scheduledLaunchGateKind(phase);

  let resolved: LaunchGateResolvedProfile | null = null;
  let mountPlan: StoreMountPlan = { mounts: {} };
  let profileHome = "";
  /** Best-effort home from the adapter plan, used only when admission fails. */
  let planHome = "";
  let failure: unknown = null;

  try {
    const policy: ExecutionIsolation = round.policy;
    const submission = deps.submission ?? hermesSubmissionFromPolicy(policy);
    const plan = (deps.resolveAdapterPlan ?? resolveHermesAdapterPlan)(submission);
    planHome =
      typeof plan?.capturedIdentity?.hostEffectiveDir === "string"
        ? plan.capturedIdentity.hostEffectiveDir
        : "";
    // The SAME admission the production runner performs before it derives the
    // create policy: a broad/lexical-only/symlinked source is refused here, so
    // the gate can never vouch for a directory the runner would refuse to
    // mount (and never mount one the gate did not observe).
    const mount = (deps.admitConfigMount ?? admitHermesConfigMount)(plan);
    profileHome = mount.hostConfigDir;
    mountPlan = scheduledLaunchGateMountPlan(mount.hostConfigDir, mount.guestConfigDir);
    resolved = {
      profile:
        typeof plan.profile.profile === "string" && plan.profile.profile !== ""
          ? plan.profile.profile
          : GATE_RECEIPT_UNREADABLE,
      profileHome: mount.hostConfigDir,
      guestConfigDir: mount.guestConfigDir,
    };
  } catch (error) {
    failure = error;
    // A refusal receipt that names the directory it refused is far more
    // actionable than one whose profile home is `unreadable` — but it must be
    // the PLAN's effective directory, never the operator's HOME (which is not
    // a profile home and would point an operator at the wrong file).
    profileHome = planHome;
  }

  const scope: LaunchGateInvocationScope = {
    kind,
    invocationId,
    runId: typeof identity.runId === "string" ? identity.runId : "",
    roundId: typeof identity.jobId === "string" ? identity.jobId : "",
    profileHome,
    mountPlan,
    ...(deps.configOptions !== undefined ? { configOptions: deps.configOptions } : {}),
  };

  const selection: LaunchGateSelectionResolver =
    resolved !== null
      ? () => resolved as LaunchGateResolvedProfile
      : () => {
          throw failure instanceof Error
            ? failure
            : new Error(`the Hermes selection could not be resolved: ${describeError(failure)}`);
        };

  return { scope, selection };
}

/**
 * The evaluation core shared by both scheduled phases.
 *
 * Returns `null` — no gate call, no receipt, no observation — for every policy
 * whose harness is not `hermes`. That is the whole pi/dsh differential: their
 * rounds never enter this function's body beyond the harness comparison.
 */
function evaluateScheduledGate(
  round: MatchlockSchedulerRound,
  phase: ScheduledLaunchGatePhase,
  deps: ScheduledLaunchGateDeps,
): LaunchGateDecision | null {
  if (round?.policy?.harness !== "hermes") return null;
  const { scope, selection } = resolveScheduledGateScope(round, phase, deps ?? {});
  return evaluateAndRecordLaunchGate(scope, {
    ...(deps ?? {}),
    // The caller's wiring seams are forwarded, but the SELECTION belongs to
    // this adapter: it is the only party that resolved the admitted mount.
    selection,
  });
}

/**
 * The DISPATCH-time evaluation: run before the round is handed to any route,
 * so a refusal precedes every VM create. Wired by US-005 in
 * `runMatchlockSchedulerRound`.
 */
export const evaluateScheduledDispatchGate: ScheduledLaunchGateEvaluator = (round, deps = {}) =>
  evaluateScheduledGate(round, "dispatch", deps);

/**
 * The ATTEMPT-time evaluation: the same core, evaluated again immediately
 * before the invocation is attempted (a queued round can wait hours, so its
 * dispatch-time verdict is stale). Wired by US-006, which also populates the
 * controller backstop's `RunHermesInvocationOptions.launchGate` with the
 * binding this returns.
 */
export const evaluateScheduledAttemptGate: ScheduledLaunchGateEvaluator = (round, deps = {}) =>
  evaluateScheduledGate(round, "attempt", deps);

// ---------------------------------------------------------------------------
// refusal recording (event + terminal, blocked-equivalent state)
// ---------------------------------------------------------------------------

/** Result of recording one refusal. */
export interface ScheduledGateRefusalRecord {
  /** True when this call emitted the `run.matchlock_gate_refused` event. */
  recorded: boolean;
  /** Why nothing was recorded when `recorded` is false. */
  reason: string;
  /** True when the run was put into its terminal blocked-equivalent state. */
  forced: boolean;
  /** The run status this call observed before acting. */
  runStatus: string | null;
}

/** A run row as the recorder needs it. */
export interface ScheduledGateRunRow {
  status: string;
  scheduling_status: string | null;
}

/** Injectable seams for the recorder (tests supply every one of them). */
export interface ScheduledGateRefusalDeps {
  /** Run-row reader. Default: the live DB. */
  readRun?: (runId: string) => ScheduledGateRunRow | undefined;
  /** Event emitter. Default: `emitEvent`. */
  emit?: (event: TamanduaEvent) => void;
  /** Run event reader (dedupe). Default: `getRunEvents`. */
  readEvents?: (runId: string) => TamanduaEvent[];
  /**
   * Force-fail seam. Default: the real `forceFailRun(runId, reason, true)`
   * (loaded lazily: `status.ts` imports the scheduler, and the scheduler
   * imports this seam, so a static import would close an ESM cycle).
   */
  forceFail?: (runId: string, reason: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Receipt reader (store-set key / finding codes). Default: read + parse. */
  readReceipt?: (receiptPath: string) => Record<string, unknown> | null;
  /** Stored-instant clock. Default `nowIso`. */
  now?: () => string;
  /** Log seam. Default the file logger. */
  log?: (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
}

/** The only statuses a dispatch may still run in. */
const DISPATCHABLE_RUN_STATUSES: readonly string[] = ["running", "paused"];

/** Production run-row reader. */
function readLiveRunRow(runId: string): ScheduledGateRunRow | undefined {
  try {
    const row = getDb()
      .prepare("SELECT status, scheduling_status FROM runs WHERE id = ?")
      .get(runId) as ScheduledGateRunRow | undefined;
    return row ?? undefined;
  } catch {
    // A DB that cannot be read is not evidence that the run is gone; the
    // caller treats `undefined` as "cannot bind the refusal to a run" and
    // still refuses the launch.
    return undefined;
  }
}

/** Production force-fail seam (lazy, cycle-free). */
async function forceFailLive(runId: string, reason: string): Promise<{ ok: boolean; reason?: string }> {
  const { forceFailRun } = await import("../status.js");
  return forceFailRun(runId, reason, true);
}

/** Production receipt reader: parse the recorded refusal, never guess it. */
function readReceiptLive(receiptPath: string): Record<string, unknown> | null {
  try {
    const receipt = parseReceipt(fs.readFileSync(receiptPath, "utf8"));
    return receipt as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Finding codes from a recorded receipt, or from the refusal when unwritten. */
function findingCodesOf(
  refusal: LaunchGateRefusal,
  receipt: Record<string, unknown> | null,
): string[] {
  const fromReceipt = Array.isArray(receipt?.findings) ? (receipt?.findings as unknown[]) : null;
  if (fromReceipt !== null) {
    const codes: string[] = [];
    for (const entry of fromReceipt) {
      const code = (entry as { code?: unknown })?.code;
      if (typeof code === "string" && code !== "" && !codes.includes(code)) codes.push(code);
    }
    return codes;
  }
  const codes: string[] = [];
  for (const finding of Array.isArray(refusal?.findings) ? refusal.findings : []) {
    if (typeof finding?.code === "string" && !codes.includes(finding.code)) codes.push(finding.code);
  }
  return codes;
}

/** The operator-facing reason force-failed onto the run. */
export function scheduledGateRefusalReason(
  round: MatchlockSchedulerRound,
  refusal: LaunchGateRefusal,
  invocationId: string,
): string {
  const detail =
    typeof refusal?.detail === "string" && refusal.detail !== ""
      ? refusal.detail
      : "no refusal detail was recorded";
  const receipt =
    typeof refusal?.receiptPath === "string" && refusal.receiptPath !== ""
      ? ` (receipt: ${refusal.receiptPath}${refusal.receiptWritten === true ? "" : ", NOT WRITTEN"})`
      : "";
  return (
    `Matchlock launch gate refused ${invocationId} for run ${bareRunId(round?.identity?.runId ?? "")}: ` +
    `${detail}${receipt}. No VM was created and no step was dispatched.`
  );
}

/**
 * Record ONE dispatch-time (or attempt-time) refusal and put the run in its
 * terminal blocked-equivalent state.
 *
 * The order is deliberate:
 *
 *   1. Re-read the run. A run that is already terminal (or missing) has
 *      already been blocked — nothing is emitted and nothing is forced, so a
 *      dispatch tick that races the terminal transition (or a second tick
 *      after it) can never produce a second event or a second round.
 *   2. Dedupe on the durable event stream: an earlier tick that recorded this
 *      same invocation id already left `run.matchlock_gate_refused` behind
 *      (e.g. it recorded the event and then crashed before the force-fail), so
 *      the event is not written twice.
 *   3. Emit the one event with the receipt's own store-set key and finding
 *      codes — the event can never disagree with the receipt.
 *   4. Force-fail the run: `status='failed'`, `scheduling_status=NULL` and the
 *      run's crons torn down. This is the concrete blocked-equivalent that
 *      exists; `scheduling_status='error'` is deliberately NOT used because
 *      `reconcileOnce()` re-admits it.
 *
 * FAIL-CLOSED CORNER. If the run row cannot be read at all (a state DB that is
 * unavailable), nothing durable can be recorded and nothing can be forced — but
 * the CALLER still refuses the launch, because the refusal decision and the
 * recorder are independent: no VM is created in that corner either. The honest
 * outcome is a logged refusal, not a fabricated event or a guessed run state.
 */
export async function recordScheduledLaunchGateRefusal(
  round: MatchlockSchedulerRound,
  refusal: LaunchGateRefusal,
  options: { phase?: ScheduledLaunchGatePhase } & ScheduledGateRefusalDeps = {},
): Promise<ScheduledGateRefusalRecord> {
  const phase: ScheduledLaunchGatePhase = options.phase === "attempt" ? "attempt" : "dispatch";
  const identity = round?.identity ?? { runId: "", jobId: "", agentId: "", workflowId: "" };
  const runId = typeof identity.runId === "string" ? identity.runId : "";
  const invocationId = scheduledLaunchGateInvocationId({
    runId,
    jobId: identity.jobId,
    phase,
  });
  const log = options.log ?? ((level, message, meta) => logger[level](message, meta));
  const now = options.now ?? nowIso;

  const run = (options.readRun ?? readLiveRunRow)(runId);
  if (!run) {
    log("warn", "Launch-gate refusal could not be bound to a run row — nothing recorded", {
      runId,
      invocationId,
      reason: "run_missing",
    });
    return { recorded: false, reason: "run-missing", forced: false, runStatus: null };
  }
  if (!DISPATCHABLE_RUN_STATUSES.includes(run.status)) {
    log("info", "Launch-gate refusal already terminal — no further round, no second record", {
      runId,
      invocationId,
      runStatus: run.status,
      reason: "run_not_running",
    });
    return { recorded: false, reason: "run-not-running", forced: false, runStatus: run.status };
  }

  const alreadyRecorded = (options.readEvents ?? ((id: string) => getRunEvents(id)))(runId).some(
    (event) =>
      event?.event === "run.matchlock_gate_refused" &&
      (event as { invocationId?: unknown }).invocationId === invocationId,
  );

  let recorded = false;
  if (!alreadyRecorded) {
    const receiptPath =
      typeof refusal?.receiptPath === "string" ? refusal.receiptPath : GATE_RECEIPT_UNREADABLE;
    const receipt =
      refusal?.receiptWritten === true
        ? (options.readReceipt ?? readReceiptLive)(receiptPath)
        : null;
    const storeSetKey =
      typeof receipt?.storeSetKey === "string" && receipt.storeSetKey !== ""
        ? receipt.storeSetKey
        : GATE_RECEIPT_UNREADABLE;
    const findingCodes = findingCodesOf(refusal, receipt);
    try {
      (options.emit ?? emitEvent)({
        ts: now(),
        event: "run.matchlock_gate_refused",
        runId,
        workflowId: typeof identity.workflowId === "string" ? identity.workflowId : "",
        harness: "hermes",
        invocationId,
        storeSetKey,
        receiptPath,
        findingCodes,
        exitCode: typeof refusal?.exitCode === "number" ? refusal.exitCode : undefined,
        reason:
          refusal?.kind === "verdict"
            ? "matchlock_launch_gate_refused"
            : "matchlock_launch_gate_operational_refusal",
        detail: scheduledGateRefusalReason(round, refusal, invocationId),
      });
      recorded = true;
    } catch (error) {
      // The event stream is the durable re-dispatch evidence. If it cannot be
      // written the refusal STILL blocks the run (step 4) and the gate receipt
      // remains the on-disk evidence; log loudly rather than pretend.
      log("error", "Launch-gate refusal event could not be recorded", {
        runId,
        invocationId,
        error: describeError(error),
      });
    }
  }

  const reason = scheduledGateRefusalReason(round, refusal, invocationId);
  let forced = false;
  try {
    const result = await (options.forceFail ?? forceFailLive)(runId, reason);
    forced = result?.ok === true;
    if (!forced) {
      log("warn", "Launch-gate refusal force-fail was refused", {
        runId,
        invocationId,
        reason: result?.reason ?? "no reason returned",
      });
    }
  } catch (error) {
    // Already-terminal, or the terminal transition failed. The durable event +
    // receipt still exist; the next dispatch tick re-reads the run row.
    log("error", "Launch-gate refusal force-fail failed", {
      runId,
      invocationId,
      error: describeError(error),
    });
  }

  // State the observed facts only: `forced` records whether the terminal
  // transition actually landed, so the line never claims a force-fail that the
  // run row did not take (an already-terminal run, or a failed transition).
  log(
    "warn",
    forced
      ? "Matchlock launch gate refused a scheduled dispatch — run force-failed"
      : "Matchlock launch gate refused a scheduled dispatch — run terminal transition NOT confirmed",
    {
      runId,
      invocationId,
      receiptPath: refusal?.receiptPath ?? "",
      exitCode: refusal?.exitCode,
      findingCodes: findingCodesOf(refusal, null),
      recorded,
      forced,
    },
  );

  return {
    recorded,
    reason: recorded ? "recorded" : alreadyRecorded ? "already-recorded" : "event-write-failed",
    forced,
    runStatus: run.status,
  };
}
