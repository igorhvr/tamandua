import crypto from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  describeUnusableMatchlockPolicy,
  parseMatchlockPolicy,
  serializeMatchlockPolicy,
  withGrantedRootUsageConsent,
  type ExecutionIsolation,
  type ExecutionIsolationResourceLimits,
} from "./matchlock/policy.js";
import {
  resolveMatchlockResourceLimits,
  type MatchlockResourceHostProbe,
} from "./matchlock/resource-limits.js";
import {
  admitMatchlockRun,
  assertMatchlockSwapSupport,
  MatchlockAdmissionError,
  matchlockRootUsageRefusalText,
  MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG,
  type HermesAdmissionSubmission,
  type MatchlockAllowPrivateSupportProbe,
} from "./matchlock/admission.js";
import type { MatchlockSwapSupportProbe } from "./matchlock/swap-support.js";
import {
  resolveMatchlockDnsPriority,
  resolveMatchlockPrivileged,
} from "./matchlock/isolation-settings.js";
import {
  runMatchlockResumePreflight,
  type InheritedImageVerifier,
} from "./matchlock/resume-preflight.js";
import {
  ISOLATION_INTENT_RECORDED,
  PREPARING_SCHEDULING_STATUS,
  DRAINING_PAUSE_SCHEDULING_STATUS,
  NATIVE_SCHEDULING_STATUS,
  PAUSE_DRAIN_CONTEXT_KEY,
  initialRunIsolationState,
  isolationPreparingHeldText,
  readIsolationState,
} from "./matchlock/prep-state.js";
import type { DshSubmissionContext } from "./matchlock/dsh-adapter-contract.js";
import type { MatchlockImageSource } from "./matchlock/standard-image.js";
import {
  buildWorkflowWarnings,
  type WorkflowWarning,
} from "./matchlock/warnings.js";
import { getDb } from "../db.js";
import { SQL_NOW_ISO } from "../lib/instant.js";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir, resolvePiStateDir } from "./paths.js";
import {
  assertDaemonPrepStateCapability,
  ensureDaemonControlAvailable,
  isDaemonControlReachable,
  registerRunWithDaemon,
  nudgeWithDaemon,
} from "../server/control-client.js";
import { emitEvent } from "./events.js";
import { resetFailedHarnessProbeForResume } from "./harness-probe.js";
import { advancePipeline, resetFailedStoriesForResume, scheduleRunCronTeardown } from "./step-ops.js";
import {
  RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY,
  validateRunHarnessForScheduling,
} from "./run-harness.js";
import { createRunWorktree, type ManagedRunWorktree } from "./worktree-manager.js";
import {
  gitIdentityContextPatch,
  resolveGitIdentity,
  type ResolvedGitIdentity,
} from "./git-identity.js";
import {
  WORKDIR_COLLISION_POLICY_KEY,
  WORKDIR_REFUSAL_STATE,
  type WorkdirCollisionHolder,
  type WorkdirCollisionPolicy,
} from "./workdir-collision.js";
import type { HarnessType } from "./types.js";

export interface RunWorkflowParams {
  workflowId: string;
  taskTitle: string;
  notifyUrl?: string;
  /** Optional initial context for template resolution */
  context?: Record<string, string>;
  /** Working directory for the pi harness/tool execution environment */
  workingDirectoryForHarness?: string;
  /** Origin repository for worktree-based workflows */
  worktreeOriginRepository?: string;
  /** Origin ref for worktree-based workflows */
  worktreeOriginRef?: string;
  /** When true, work spawns prefer a <harness>-token-saver command from PATH over the plain harness binary (per invocation; falls back to the harness binary). */
  noHurrySaveTokensMode?: boolean;
  /** Harness binary to use for agent invocations (default "pi") */
  harnessType?: HarnessType;
  /**
   * WORKDIR-FLAGS: what to do when the harness working directory is already
   * held by a live direct run. Persisted into the run context for every
   * policy except the default `refuse`, so daemon admission can honor the
   * caller's explicit choice on this fresh launch. Resume/replacement runs
   * set the policy separately.
   */
  workdirCollisionPolicy?: WorkdirCollisionPolicy;
  /**
   * MTLK-PI US-001 / MTLK-HERMES-EXEC US-003 / MTLK-DSH-EXEC US-002: the
   * explicitly requested Matchlock image (--matchlock IMAGE). When present, a
   * typed execution-isolation policy is admitted and captured at run creation
   * and frozen on the run row; absent, no policy is written and the run uses
   * the native path. The policy's harness follows the selected harness: "pi"
   * (default / --pi-as-harness), "hermes" (--hermes-as-harness, whose
   * effective Hermes config selection is resolved from FROZEN submission
   * inputs at admission) or "dsh" (--dsh-as-harness, whose effective
   * DSH_HOME is resolved from FROZEN submission inputs at admission). The
   * integrated candidate admits all three.
   */
  matchlockImage?: string;
  /**
   * MTLK-ISO-SLICE1 SHARED-V3: the REAL provenance of the resolved
   * `matchlockImage` — "explicit" (`--matchlock-image [=]<image>`) or
   * "standard" (bare `--matchlock`, resolving to the built-in standard image
   * or TAMANDUA_MATCHLOCK_IMAGE). Threaded to admission so the persisted v3
   * policy's `requestedImageSource` is truthful instead of a placeholder.
   * Absent for a native run and for callers that predate the field.
   */
  matchlockImageSource?: MatchlockImageSource;
  /**
   * MTLK-ISO-SLICE1 SHARED-V3: true ONLY when the operator explicitly supplied
   * `--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs` to
   * THIS action. Threaded to admission so the persisted v3 policy's
   * `rootUsageConsent` records the per-action consent; false/absent otherwise.
   */
  matchlockRootUsageOverride?: boolean;
  /**
   * MTLK-DSH-EXEC US-002: the harness running inside the Matchlock VM when
   * --matchlock is present. "dsh" (with --dsh-as-harness) persists the frozen
   * submission context and resolved effective DSH_HOME; "pi" is the default.
   */
  matchlockHarness?: "pi" | "dsh";
  /**
   * MTLK-DSH-EXEC US-002: the FROZEN submission context (HOME/DSH_HOME/cwd of
   * the submitting command) for a harness "dsh" Matchlock run. Captured at run
   * creation from the submitting process — never re-discovered from the daemon
   * HOME/env at dispatch.
   */
  dshSubmission?: DshSubmissionContext;
  /**
   * MTLK-ADMIT: an INHERITED Matchlock policy (automatic rugpull replacement
   * of a previously admitted run). Not a CLI flag — internal run-creator
   * plumbing. The replacement retains the inherited image content+config pin,
   * selected configuration root/profile and original repository authority,
   * deriving ONLY the new host-created worktree's exact path/metadata. The
   * image is re-resolved and MUST match the inherited pin (a moved tag fails
   * closed instead of silently re-pinning or becoming native).
   */
  matchlockPolicy?: ExecutionIsolation;
  /**
   * MTLK-VM-SIZE US-003: CLI-resolved VM resource limits for a FRESH Matchlock
   * opt-in (flag > env > host-derived default, already validated/clamped by
   * the shared resolver). Ignored when `matchlockPolicy` (an inherited rugpull
   * policy) is present — the inherited limits always win. When absent and no
   * policy is inherited, the host-derived defaults are resolved here.
   */
  matchlockResourceLimits?: ExecutionIsolationResourceLimits;
  /**
   * MTLK-VM-SIZE US-003: injectable host capacity probe used ONLY when
   * `matchlockResourceLimits` is absent and no policy is inherited, so the
   * host-derived default is deterministic in tests. Production omits it.
   */
  matchlockResourceHostProbe?: MatchlockResourceHostProbe;
  /**
   * MTLK-ALLOW-PRIVATE: CLI-resolved per-run allow-private destination list
   * for a FRESH Matchlock opt-in (flag > TAMANDUA_MATCHLOCK_ALLOW_PRIVATE env,
   * already shape-validated at parse time). Admission persists the normalized
   * list as `networkAllowPrivate` on the run's policy so every round/retry/
   * resume of the run dispatches the SAME exceptions. Ignored when
   * `matchlockPolicy` (an inherited rugpull policy) is present — the persisted
   * policy list always wins and is never re-derived from the environment.
   */
  matchlockAllowPrivate?: string[];
  /**
   * MTLK-ALLOW-PRIVATE US-008: injectable allow-private support probe threaded
   * to admission so tests never need a real matchlock binary. Production omits
   * it and admission probes the resolved rpc binary itself.
   */
  matchlockAllowPrivateSupportProbe?: MatchlockAllowPrivateSupportProbe;
  /**
   * MTLK-ISO-SLICE2 US-003: injectable swap-capability support probe threaded to
   * admission so tests never need a real matchlock binary. Production omits it
   * and admission probes the resolved rpc binary itself. The probe runs for
   * every Matchlock admission (fresh opt-in or inherited-policy replacement),
   * including swap-disabled runs.
   */
  matchlockSwapSupportProbe?: MatchlockSwapSupportProbe;
  /**
   * ICEBOX Pillar B (privileged-by-default): true when the pure-boolean
   * `--matchlock-no-privileged` opt-out was supplied to THIS fresh launch.
   * Resolution happens ONCE here, at submission, from the run-composition
   * side's environment (opt-out flag > TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1 >
   * default ON); the resolved value + source are persisted on the run's
   * Matchlock policy and threaded to admission. A native run reads neither
   * the flag nor the environment, and a replacement (inherited
   * `matchlockPolicy`) never re-derives them — the persisted policy is
   * authoritative. The DNS preference (`TAMANDUA_MATCHLOCK_DNS_PRIORITY`)
   * is resolved on the same fresh-only path.
   */
  matchlockNoPrivileged?: boolean;
  /** When true, suppresses automatic replacement-run launch after a rugpull is detected */
  noRelaunchUponRugpull?: boolean;
  /**
   * TATR US-009: the run id of the run that spawned this child run (parent
   * linkage). Persisted into runs.parent_run_id and carried on the
   * run.started event so graph consumers can discover the parent. The
   * workflow CLI derives it from the TAMANDUA_RUN_ID env var the scheduler
   * sets for worker rounds; invocations launched outside a run (manual CLI
   * launches) leave it unset, and the run row then stores NULL.
   */
  parentRunId?: string;
}

export interface RunWorkflowResult {
  runId: string;
  runNumber: number;
  workflowId: string;
  taskTitle: string;
  status: string;
  stepCount: number;
  workingDirectoryForHarness: string;
  /** Set when the run row was created but the daemon control plane didn't become reachable in time. */
  daemonWarning?: string;
  /**
   * US-003: set when the daemon admitted the run as 'waiting' because another
   * live run already holds the harness working directory. "Workdir busy" is a
   * retriable admission condition, NOT a launch failure: the run stays
   * registered (status 'running') and the reconciler admits it once the holder
   * releases the directory. Carries the holding run's id.
   */
  queuedBehindRunId?: string;
  /**
   * US-003: the daemon admission state that queuedBehindRunId corresponds to
   * ('waiting' for a busy harness workdir). Undefined for an ordinary launch.
   */
  schedulingState?: string;
  /** Warnings collected during run creation (e.g. base capture failures degrading rugpull detection). */
  captureWarnings?: string[];
  /**
   * WORKDIR-FLAGS US-004: set when the daemon REFUSED the launch because the
   * harness working directory is already held by a live run and the run's
   * collision policy is the default `refuse`. This is a typed, non-throwing
   * outcome: the run row is left `failed`/`error` and the CLI renders
   * `message` (which already names the holder and the three ways out) to
   * stderr and exits WORKDIR_REFUSAL_EXIT_CODE.
   */
  workdirRefused?: {
    message: string;
    heldByRunId?: string;
    holder?: WorkdirCollisionHolder;
    workingDirectoryForHarness: string;
  };
  /**
   * MTLK-VM-SIZE US-003: the resource limits persisted in the run's Matchlock
   * policy (undefined for a native run). Exposed so the CLI can echo the
   * admitted VM size in the launch output.
   */
  matchlockResourceLimits?: ExecutionIsolationResourceLimits;
  /**
   * SHARED-V3 (MTLK-ISO-SLICE2 US-011): the immutable image pin read from the
   * persisted (possibly inherited) Matchlock policy after admission succeeds.
   * Undefined for a native run. The CLI prints it as its own line with the
   * distinct `matchlock pinned:` prefix, so it never collides with the single
   * `matchlock:` launch line.
   */
  matchlockPin?: {
    digest: string;
    configDigest: string;
  };
  /**
   * SHARED-V3 (MTLK-ISO-SLICE2 US-012): the effective image provenance read
   * from the admitted (possibly inherited) Matchlock policy. Undefined for a
   * native run. The CLI folds it into `workflow run --json`'s
   * `matchlockResources.imageSource`, so the post-admission JSON reports the
   * ADMITTED provenance rather than only the launch-resolved one.
   */
  matchlockImageSource?: MatchlockImageSource;
  /**
   * MTLK-ISO-SLICE2 US-013 (R13): the ADMITTED policy's `rootUsageConsent`,
   * surfaced so `workflow run --json` can re-derive the shared
   * `root_usage_override` warning. Undefined for a native run.
   */
  matchlockRootUsageConsent?: boolean;
}

/**
 * Resolve the host-derived built-in Matchlock VM resource limits
 * (MTLK-VM-SIZE US-003). The optional probe keeps the default deterministic
 * in tests; production omits it and probes the real host.
 */
function resolveDefaultMatchlockResourceLimits(
  hostProbe?: MatchlockResourceHostProbe,
): ExecutionIsolationResourceLimits {
  const resolved = resolveMatchlockResourceLimits(hostProbe ? { hostProbe } : {});
  return {
    cpus: resolved.cpus,
    memoryMB: resolved.memoryMB,
    diskSizeMB: resolved.diskSizeMB,
    // SHARED-V3: fresh writes always carry the effective swap size.
    swapMB: resolved.swapMB,
  };
}

/**
 * MTLK-ADMIT-MARKER (tamandua-crf): thrown when the fresh-launch admission
 * write cannot own the run row it just inserted (zero rows updated: the row
 * was deleted or the policy/marker columns moved under a concurrent writer).
 * The generic launch-failure handler is deliberately SKIPPED for this error —
 * a lost ownership guard must preserve the newer state, never clobber it with
 * the stale launch view.
 */
class MatchlockAdmissionStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchlockAdmissionStateConflictError";
  }
}

function failPersistedRunLaunch(params: {
  runId: string;
  workflowId: string;
  error: unknown;
}): void {
  const db = getDb();
  const message = params.error instanceof Error
    ? params.error.message
    : String(params.error);

  // Do not let secondary bookkeeping errors mask the original launch error.
  // MTLK-ADMIT-MARKER (tamandua-crf): the failure write is CONDITIONAL on the
  // row still being OWNED by the launch. A concurrent operator pause/drain/
  // cancel that landed while the launch was failing owns the row NOW — this
  // handler must not reset its status or overwrite the new state with the
  // stale launch view (the run.failed event below is still emitted for
  // observability). `status = 'running'` alone does NOT discriminate an
  // operator drain (it keeps the run running while it drains); the
  // operator-attribution key `paused_by` (written by handlePauseRun) is the
  // application's actual discriminator, exactly as the admission release uses
  // it.
  //
  // The context edit is a `json_set` of `launch_error` on the CURRENT durable
  // context, never a rewrite from the stale in-memory launch copy: serializing
  // the launch view would resurrect a `pause_drain` marker the admission
  // release already cleared, and would erase every context key written after
  // the seed.
  // The run.failed event is emitted ONLY when the guarded write above actually
  // moved the row: when a concurrent writer (operator pause/drain/cancel) owns
  // the run NOW, the run did not transition to failed and a run.failed event
  // would misreport the durable state (tamandua-crf review).
  let failureRecorded = false;
  try {
    const result = db.prepare(
      `UPDATE runs
       SET status = 'failed', context = json_set(context, '$.launch_error', ?),
           scheduling_status = NULL,
           scheduling_requested_at = NULL, scheduling_error = ?,
           updated_at = ${SQL_NOW_ISO}
       WHERE id = ? AND status = 'running'
         AND json_extract(context, '$.paused_by') IS NULL`,
    ).run(message, message, params.runId);
    failureRecorded = Number(result.changes) === 1;
  } catch {
    // Best effort only; the caller rethrows the original setup failure.
  }

  if (!failureRecorded) return;

  try {
    emitEvent({
      ts: new Date().toISOString(),
      event: "run.failed",
      runId: params.runId,
      workflowId: params.workflowId,
      detail: `Launch setup failed: ${message}`,
    });
  } catch {
    // Best effort only; the caller rethrows the original setup failure.
  }
}

/**
 * BCAP (US-001): is the harness working directory inside a git work tree?
 *
 * Base capture is only applicable to git repositories. A non-git working
 * directory (e.g. a just-do-it dispatcher dir or any plain directory) must be
 * classified ONCE as "not applicable" instead of letting each rev-parse probe
 * fail and emit its own error-class event/warning.
 */
export function isGitRepositoryForHarness(workingDirectory: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workingDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

/**
 * Parse the daemon's `holder` object off a 409 refusal body. Tolerant of a
 * missing/partial object (a stale or older daemon) so the CLI still gets a
 * usable typed result instead of crashing; returns undefined when there is no
 * usable holder identity at all.
 */
function parseWorkdirCollisionHolder(raw: unknown): WorkdirCollisionHolder | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId.length === 0) return undefined;
  return {
    runId: record.runId,
    runNumber: typeof record.runNumber === "number" ? record.runNumber : null,
    workflowId: typeof record.workflowId === "string" ? record.workflowId : "unknown",
    status: typeof record.status === "string" ? record.status : "unknown",
    since: typeof record.since === "string" ? record.since : "unknown",
  };
}

/**
 * WORKDIR-FLAGS US-004: bookkeeping for a launch the daemon refused because the
 * harness working directory is held. Mirrors `failPersistedRunLaunch` (context
 * `launch_error`, a truthful `run.failed` event) but keeps the distinct
 * `scheduling_status = 'error'` marker the daemon set, and NEVER reports the
 * refusal as a generic registration failure. Best-effort: the caller returns
 * the typed refusal even if this bookkeeping cannot be written.
 */
function failRefusedRunLaunch(params: {
  runId: string;
  workflowId: string;
  message: string;
}): void {
  const db = getDb();

  // MTLK-ADMIT-MARKER (tamandua-crf): the context edit is a `json_set` of
  // `launch_error` on the CURRENT durable context — the launch-time in-memory
  // copy is never serialized back (it would resurrect a `pause_drain` marker
  // the admission release already cleared and erase concurrent context
  // updates written while the refusal resolved).
  //
  // Ownership-constrained like `failPersistedRunLaunch`: a concurrent operator
  // pause/drain/cancel that landed while the refusal resolved owns the row NOW
  // (a drain keeps `status='running'` but records `paused_by`, which this
  // WHERE also discriminates), so the refusal bookkeeping must not overwrite
  // the newer state. The run.failed event is emitted only when the guarded
  // write actually moved the row.
  let refusalRecorded = false;
  try {
    const result = db.prepare(
      `UPDATE runs
       SET status = 'failed', context = json_set(context, '$.launch_error', ?),
           scheduling_status = 'error',
           scheduling_requested_at = NULL, scheduling_error = ?,
           updated_at = ${SQL_NOW_ISO}
       WHERE id = ? AND status = 'running'
         AND json_extract(context, '$.paused_by') IS NULL`,
    ).run(params.message, params.message, params.runId);
    refusalRecorded = Number(result.changes) === 1;
  } catch {
    // Best effort only; the caller still returns the typed refusal.
  }

  if (!refusalRecorded) return;

  try {
    emitEvent({
      ts: new Date().toISOString(),
      event: "run.failed",
      runId: params.runId,
      workflowId: params.workflowId,
      detail: `Workdir collision refused: ${params.message}`,
    });
  } catch {
    // Best effort only; the caller still returns the typed refusal.
  }
}

/**
 * Start a new workflow run.
 *
 * 1. Loads the workflow spec
 * 2. Creates a run record in the DB
 * 3. Creates step records for each step
 * 4. Registers the run with the daemon, which schedules dispatch jobs
 * 5. Emits a run.started event
 */
export async function runWorkflow(
  params: RunWorkflowParams,
): Promise<RunWorkflowResult> {
  const {
    workflowId,
    taskTitle,
    notifyUrl,
    context = {},
    workingDirectoryForHarness: requestedWorkingDirectoryForHarness,
    worktreeOriginRepository,
    worktreeOriginRef,
    noHurrySaveTokensMode,
    harnessType,
    matchlockImage,
    matchlockImageSource,
    matchlockRootUsageOverride,
    matchlockHarness,
    dshSubmission,
    matchlockPolicy,
    matchlockResourceLimits,
    matchlockResourceHostProbe,
    matchlockAllowPrivate,
    matchlockAllowPrivateSupportProbe,
    matchlockSwapSupportProbe,
    matchlockNoPrivileged,
    noRelaunchUponRugpull,
    parentRunId,
    workdirCollisionPolicy,
  } = params;

  // ICEBOX (tamandua-5rr.3 E2): resolve the isolation settings (whole-VM
  // privilege + guest-resolver address-family preference) ONCE at submission,
  // synchronously and BEFORE any await, from the COMPOSING side's
  // environment — frozen for the whole run. Rules:
  //   - a FRESH Matchlock opt-in resolves flag > env > default (privileged:
  //     `--matchlock-no-privileged` > TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1 >
  //     default ON; DNS: TAMANDUA_MATCHLOCK_DNS_PRIORITY > default ipv4 — a
  //     workflow run has no DNS CLI flag by design);
  //   - a NATIVE run reads neither the flag nor the environment;
  //   - a REPLACEMENT (inherited `matchlockPolicy`) NEVER re-derives them —
  //     the persisted policy is authoritative (INHERITANCE RULE), so even a
  //     malformed DNS env value cannot fail an inherited launch.
  const isFreshMatchlockOptIn = Boolean(matchlockImage) && !matchlockPolicy;
  const isolationSettings = isFreshMatchlockOptIn
    ? {
        matchlockPrivileged: resolveMatchlockPrivileged({
          noPrivilegedFlag: matchlockNoPrivileged === true,
          env: process.env,
        }),
        matchlockDnsPriority: resolveMatchlockDnsPriority({ env: process.env }),
      }
    : undefined;

  // MTLK-HERMES-EXEC US-003: FROZEN Hermes submission inputs captured AT RUN
  // CREATION (the run creator's HOME / HERMES_HOME env snapshot / cwd). A
  // hermes Matchlock opt-in resolves its effective config selection from ONLY
  // these — never the daemon HOME or later ambient state. For pi runs (and
  // runs that inherit an existing policy via `matchlockPolicy`) this capture
  // is unused; pi behavior stays byte-identical.
  const hermesSubmission: HermesAdmissionSubmission = {
    homeDir: process.env.HOME?.trim() || os.homedir(),
    cwd: process.cwd(),
    hermesHomeEnv: process.env.HERMES_HOME ?? null,
  };

  // Load the workflow spec from the installed workflow directory
  const workflowDir = resolveWorkflowDir(workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);

  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  let runNumber: number;
  let runPersisted = false;
  // GIDN US-002: the ONE identity every git operation of this run uses,
  // resolved as soon as the harness working directory is final (direct mode:
  // workingDirectoryForHarness; worktree mode: managedWorktree.worktreePath).
  // Assigned on every reachable path through the workspace-mode branch below
  // (the invalid-mode branch throws).
  let gitIdentity: ResolvedGitIdentity;
  // MTLK-VM-SIZE US-003: the limits persisted in the run's Matchlock policy,
  // surfaced on RunWorkflowResult for the CLI launch line.
  let persistedMatchlockResourceLimits: ExecutionIsolationResourceLimits | undefined;
  // MTLK-ISO-SLICE2 US-011: the admitted immutable image pin read from the
  // persisted (possibly inherited) policy, surfaced for the `matchlock pinned:`
  // line the CLI prints after admission succeeds.
  let persistedMatchlockPin: { digest: string; configDigest: string } | undefined;
  // MTLK-ISO-SLICE2 US-012: the admitted image provenance, read from the SAME
  // persisted policy and surfaced for `workflow run --json`.
  let persistedMatchlockImageSource: MatchlockImageSource | undefined;
  // MTLK-ISO-SLICE2 US-013: the admitted policy's root-usage consent bit,
  // surfaced so `workflow run --json` can re-derive the shared
  // `root_usage_override` warning.
  let persistedMatchlockRootUsageConsent: boolean | undefined;

  const workspaceMode = workflow.run?.workspace ?? "direct";
  const warnings: string[] = [];

  // ── MTLK-ISO-SLICE2 US-005 (PREP-STATE) ────────────────────────────────
  // The isolation INTENT is host-controlled: it derives ONLY from the run's
  // own opt-in (a `--matchlock` image or an inherited replacement policy),
  // never from `context`/`--context` or step output. An opted-in run is
  // inserted with the intent marker AND the initial non-schedulable hold
  // (`scheduling_status = 'preparing'`) in the SAME first INSERT; a native run
  // keeps the exact pre-PREP-STATE shape. The hold is what makes the
  // invariant structural across an interrupted admission (spec C §10 item 7).
  const isMatchlockOptIn = Boolean(matchlockImage || matchlockPolicy);
  const initialIsolation = initialRunIsolationState(isMatchlockOptIn, now);

  let workingDirectoryForHarness: string;
  // BCAP (US-001): whether the resolved harness working directory is a git
  // repository (computed once in direct mode). False for worktree mode; the
  // worktree-mode capture path uses worktree_origin_sha and is unaffected.
  let harnessDirIsGitRepo = false;

  // Seed the run context with the task description so step input templates can
  // reference {{task}} from the very first step. Without this, the planner step
  // (which always references {{task}}) fails immediately on claim with a missing
  // template key error, aborting the whole run.
  const seededContext: Record<string, string> = {
    task: taskTitle,
    ...context,
    workspace_mode: workspaceMode,
    no_hurry_save_tokens_mode: String(noHurrySaveTokensMode ?? false),
    harness_type: harnessType ?? "pi",
    no_relaunch_upon_rugpull: String(noRelaunchUponRugpull ?? false),
  };

  // WORKDIR-FLAGS: persist an explicit non-default collision policy so daemon
  // admission can honor it. `refuse` (the default) is intentionally NOT
  // written, so an unflagged launch keeps the persisted context unchanged.
  // Fresh launches only — resume/replacement set the policy separately.
  if (workdirCollisionPolicy && workdirCollisionPolicy !== "refuse") {
    seededContext[WORKDIR_COLLISION_POLICY_KEY] = workdirCollisionPolicy;
  }

  // MTLK-ISO2-MEND (Family D, D-MARKER): the host-controlled, legacy-honored
  // pause_drain hold is seeded ATOMICALLY with the first INSERT. It is applied
  // LAST so it wins over any operator `--context` value.
  Object.assign(seededContext, initialIsolation.contextSeed);

  // MTLK-ISO2-CORRECTIVE (Finding D, D-enforce): an OPTED-IN run would insert
  // an isolation-intent row that a pre-PREP-STATE daemon could treat as
  // natively schedulable. Before the FIRST intent-bearing INSERT, require any
  // REACHABLE control plane to advertise the PREP-STATE capability; a native
  // run, and a launch with no daemon running at all, are unaffected. The
  // register/nudge/resume paths re-check the peer they actually talk to.
  if (isMatchlockOptIn && (await isDaemonControlReachable(500))) {
    await assertDaemonPrepStateCapability();
  }

  try {
  if (workspaceMode === "direct") {
    if (worktreeOriginRepository) {
      throw new Error(
        "--worktree-origin-repository is only valid for workflows with run.workspace: worktree",
      );
    }
    if (worktreeOriginRef) {
      throw new Error(
        "--worktree-origin-ref is only valid for workflows with run.workspace: worktree",
      );
    }

    workingDirectoryForHarness = path.resolve(
      requestedWorkingDirectoryForHarness ?? process.cwd(),
    );

    // For just-do-it workflows, the dispatcher runs from a neutral
    // workspace under Tamandua state so it doesn't occupy the user's
    // target repository as its harness directory. The target repo path
    // is preserved in context for child workflow launch.
    if (workflowId === "just-do-it") {
      const targetRepo = workingDirectoryForHarness;
      const stateDir = resolvePiStateDir();
      const dispatcherDir = path.join(
        stateDir,
        "just-do-it-workspaces",
        runId,
      );
      await fs.mkdir(dispatcherDir, { recursive: true });
      workingDirectoryForHarness = dispatcherDir;
      seededContext.target_working_directory_for_harness = targetRepo;
      seededContext.repo = targetRepo;
    } else {
      seededContext.repo = workingDirectoryForHarness;
    }

    seededContext[RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY] =
      workingDirectoryForHarness;

    // GIDN US-002: resolve the run's ONE commit identity now that the harness
    // working directory is final, and persist it into the run context so later
    // dispatch rounds and product-owned git operations recover the exact
    // identity chosen at launch (src/installer/git-identity.ts).
    gitIdentity = resolveGitIdentity({
      repoDir: workingDirectoryForHarness,
      env: process.env,
    });
    Object.assign(seededContext, gitIdentityContextPatch(gitIdentity));

    // BCAP (US-001): determine git-repository applicability ONCE for the
    // resolved harness working directory. A non-git directory is a
    // "not applicable" case for base capture: classify it with a single
    // skipped event instead of letting each rev-parse probe fail and emit
    // separate error-class events/warnings.
    harnessDirIsGitRepo = isGitRepositoryForHarness(workingDirectoryForHarness);

    if (!harnessDirIsGitRepo) {
      // Not a git repository — base capture does not apply. Emit EXACTLY ONE
      // skipped event (never run.base_capture_failed) and leave the captured
      // values empty without any rugpull-degradation warning.
      seededContext.original_branch = "";
      seededContext.base_branch_sha = "";
      seededContext.tested_tree = "";
      emitEvent({
        ts: new Date().toISOString(),
        event: "run.base_capture_skipped",
        runId,
        workflowId,
        reason: "not_a_git_repository",
        detail: `Base capture skipped: ${workingDirectoryForHarness} is not a git repository (reason: not_a_git_repository)`,
      });
    } else {
      // Capture original branch for rugpull detection in direct mode — records
      // the base branch name at run creation so downstream detection can compare
      // its current tip against the recorded base_branch_sha instead of depending
      // on whatever HEAD happens to be after a final-merge failure.
      try {
        const branchName = execFileSync(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          {
            cwd: workingDirectoryForHarness,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ).trim();
        // HEAD is not a branch name (detached HEAD), so fall back to empty.
        seededContext.original_branch =
          branchName !== "HEAD" ? branchName : "";
      } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString("utf-8")?.trim() ?? "";
        emitEvent({
          ts: new Date().toISOString(),
          event: "run.base_capture_failed",
          runId,
          workflowId,
          detail: `original_branch: git rev-parse --abbrev-ref HEAD — ${stderr || "git command failed"}`,
        });
        warnings.push(
          `Unable to capture original branch at launch — rugpull detection degraded for this run (git error: ${stderr || "unknown"})`,
        );
        seededContext.original_branch = "";
      }

      // Store base branch SHA for rugpull detection in direct mode.
      try {
        seededContext.base_branch_sha = execFileSync(
          "git",
          ["rev-parse", "HEAD"],
          { cwd: workingDirectoryForHarness, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
      } catch {
        seededContext.base_branch_sha = "";
      }

      // Store tree hash of the base commit for self-merge detection — resolved at
      // run creation time so rugpull detection can compare the current tip's tree
      // against the tree that was tested (prevents relaunch when own merge landed).
      if (seededContext.base_branch_sha) {
        try {
          seededContext.tested_tree = execFileSync(
            "git",
            ["rev-parse", `${seededContext.base_branch_sha}^{tree}`],
            {
              cwd: workingDirectoryForHarness,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            },
          ).trim();
        } catch {
          seededContext.tested_tree = "";
        }
      } else {
        seededContext.tested_tree = "";
      }
    }

    let workingDirectoryStats;
    try {
      workingDirectoryStats = await fs.stat(workingDirectoryForHarness);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        throw new Error(
          `working-directory-for-harness does not exist: ${workingDirectoryForHarness}`,
        );
      }
      throw err;
    }

    if (!workingDirectoryStats.isDirectory()) {
      throw new Error(
        `working-directory-for-harness must be a directory: ${workingDirectoryForHarness}`,
      );
    }

    const contextJson = JSON.stringify(seededContext);

    // Insert the run record. New runs start with
    // scheduling_status='pending_register' so the daemon control plane
    // (and/or reconciler) can admit them. An OPTED-IN Matchlock run instead
    // starts HELD (scheduling_status='preparing') with its isolation intent
    // recorded in the SAME statement — admission flips it to
    // 'pending_register' only after it persists the validated policy
    // (MTLK-ISO-SLICE2 PREP-STATE, spec C §10 item 7).
    // run_number is allocated atomically via subquery to prevent duplicate
    // numbers under concurrent launches.
    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                         scheduling_status, scheduling_requested_at, isolation_intent,
                         notify_url, parent_run_id, created_at, updated_at)
       VALUES (?, (SELECT COALESCE(MAX(run_number), 0) + 1 FROM runs), ?, ?, 'running', ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      workflowId,
      taskTitle,
      contextJson,
      initialIsolation.schedulingStatus,
      initialIsolation.schedulingRequestedAt,
      initialIsolation.isolationIntent,
      notifyUrl ?? null,
      parentRunId ?? null,
      now,
      now,
    );
    runPersisted = true;

    // Read back the atomically allocated run_number.
    const runRow = db.prepare("SELECT run_number FROM runs WHERE id = ?").get(runId) as { run_number: number };
    runNumber = runRow.run_number;

    // Emit run id to stderr synchronously BEFORE any blocking spawnSync (worktree add).
    // Agents that wrap the launch with a timeout need to see the run id so they
    // know a run was created even if the process is killed mid-worktree-add.
    writeSync(2, `run #${runNumber} (${runId.slice(0, 8)}) created; preparing workspace...\n`);
  } else if (workspaceMode === "worktree") {
    if (requestedWorkingDirectoryForHarness) {
      throw new Error(
        "--working-directory-for-harness is not valid for workflows with run.workspace: worktree. Use --worktree-origin-repository and --worktree-origin-ref instead.",
      );
    }

    const originRepo = worktreeOriginRepository ?? process.cwd();

    // Stash origin fields into context early (before INSERT) so the initial
    // run row captures them. The INSERT uses an atomic subquery to allocate
    // run_number, which we then read back and pass to createRunWorktree.
    seededContext.worktree_origin_repository = path.resolve(originRepo);
    if (worktreeOriginRef) {
      seededContext.worktree_origin_ref = worktreeOriginRef;
    }

    // INSERT the run row first — the atomic subquery allocates run_number.
    // Worktree-specific context fields (worktree_path, repo, worktree_origin_sha,
    // original_branch, base_branch_sha) are populated after the worktree is created
    // and the context row is updated.
    const initialContextJson = JSON.stringify(seededContext);

    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                         scheduling_status, scheduling_requested_at, isolation_intent,
                         notify_url, parent_run_id, created_at, updated_at)
       VALUES (?, (SELECT COALESCE(MAX(run_number), 0) + 1 FROM runs), ?, ?, 'running', ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      workflowId,
      taskTitle,
      initialContextJson,
      initialIsolation.schedulingStatus,
      initialIsolation.schedulingRequestedAt,
      initialIsolation.isolationIntent,
      notifyUrl ?? null,
      parentRunId ?? null,
      now,
      now,
    );
    runPersisted = true;

    // Read back the atomically allocated run_number.
    const runRow = db.prepare("SELECT run_number FROM runs WHERE id = ?").get(runId) as { run_number: number };
    runNumber = runRow.run_number;

    // Emit run id to stderr synchronously BEFORE the blocking createRunWorktree
    // (which calls spawnSync for git worktree add). Agents that wrap the launch
    // with a timeout need to see the run id even if the process is killed mid-add.
    writeSync(2, `run #${runNumber} (${runId.slice(0, 8)}) created; preparing workspace...\n`);

    // Now create the managed worktree using the allocated run_number.
    let managedWorktree: ManagedRunWorktree;
    try {
      managedWorktree = createRunWorktree({
        runId,
        runNumber,
        workflowId,
        worktreeOriginRepository: originRepo,
        worktreeOriginRef,
      });
    } catch (err) {
      // createRunWorktree already marks the run_worktrees row as error internally.
      // Fail the run start before registering with the daemon.
      throw new Error(
        `Failed to create managed worktree for run: ${(err as Error).message}`,
      );
    }

    workingDirectoryForHarness = managedWorktree.worktreePath;
    seededContext[RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY] =
      managedWorktree.worktreePath;
    seededContext.repo = managedWorktree.worktreePath;
    seededContext.worktree_path = managedWorktree.worktreePath;
    seededContext.worktree_origin_repository =
      managedWorktree.worktreeOriginRepository;
    seededContext.worktree_origin_ref = managedWorktree.worktreeOriginRef;
    seededContext.worktree_origin_sha = managedWorktree.worktreeOriginSha;
    seededContext.original_branch = worktreeOriginRef ?? managedWorktree.originalBranch ?? "";
    seededContext.base_branch_sha = managedWorktree.worktreeOriginSha;

    // Store tree hash of the base commit for self-merge detection — resolved at
    // run creation time so rugpull detection can compare the current tip's tree
    // against the tree that was tested (prevents relaunch when own merge landed).
    try {
      seededContext.tested_tree = execFileSync(
        "git",
        ["rev-parse", `${seededContext.worktree_origin_sha}^{tree}`],
        {
          cwd: seededContext.worktree_origin_repository,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    } catch {
      seededContext.tested_tree = "";
    }

    // GIDN US-002: resolve the run's ONE commit identity once the managed
    // worktree path is final. The worktree shares the origin repository's
    // `.git` common dir, so `git config --local` reads the same local config;
    // the identity must be in the context BEFORE the follow-up UPDATE below.
    gitIdentity = resolveGitIdentity({
      repoDir: workingDirectoryForHarness,
      env: process.env,
    });
    Object.assign(seededContext, gitIdentityContextPatch(gitIdentity));

    // Update the run's context with the now-available worktree-specific fields.
    // MTLK-ADMIT-MARKER (tamandua-crf): merge ONLY the fields this launch owns
    // into the CURRENT durable context with `json_patch` — rewriting the whole
    // context from the launch-time copy could erase a concurrent operator
    // pause/drain attribution (`paused_by`), which the guarded admission
    // release below examines before releasing the hold.
    const worktreeContextPatch = JSON.stringify({
      [RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY]: seededContext[RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY],
      repo: seededContext.repo,
      worktree_path: seededContext.worktree_path,
      worktree_origin_repository: seededContext.worktree_origin_repository,
      worktree_origin_ref: seededContext.worktree_origin_ref,
      worktree_origin_sha: seededContext.worktree_origin_sha,
      original_branch: seededContext.original_branch,
      base_branch_sha: seededContext.base_branch_sha,
      tested_tree: seededContext.tested_tree,
      ...gitIdentityContextPatch(gitIdentity),
    });
    db.prepare("UPDATE runs SET context = json_patch(context, ?) WHERE id = ?").run(worktreeContextPatch, runId);
  } else {
    throw new Error(
      `Invalid run.workspace value: "${workspaceMode}". Expected "direct" or "worktree".`,
    );
  }

  // MTLK-ADMIT: production Matchlock admission for opted-in runs. When the
  // operator passed `--matchlock IMAGE` (or an automatic rugpull replacement
  // inherits an existing policy via `matchlockPolicy`), the run is ADMITTED
  // here — after the workspace/worktree exists but BEFORE any step is
  // inserted, the pipeline advanced, or the run is registered/nudged for
  // dispatch — so dispatch can never observe runnable work before the pinned
  // policy is persisted:
  //   - the selected configuration root/profile (pi, or the FROZEN-submission-
  //     resolved Hermes selection when the run opted into
  //     --hermes-as-harness --matchlock) and the exact work/original-repository/
  //     Git scope are captured at submission;
  //   - the immutable image content+config identity is resolved over a
  //     bounded OWNED RPC (resolve only — NO create) and persisted with the
  //     policy (version 2). A replacement verifies the freshly resolved
  //     identity against the INHERITED pin (a moved tag fails closed);
  //   - a resolve/admission/persistence failure throws here, the run row is
  //     marked failed/refused by failPersistedRunLaunch, and NO native work
  //     is produced (partial owned fixtures, e.g. a created worktree, are
  //     retained with diagnostics — no broad cleanup).
  // A missing host configuration root is a hard refusal; only the host
  // harness EXECUTABLE may be absent (the image supplies it). Absent
  // `--matchlock`
  // (and no inherited policy) writes no policy and yields zero Matchlock
  // actions.
  if (matchlockImage || matchlockPolicy) {
    const image = (matchlockPolicy?.requestedImage ?? matchlockImage)?.trim();
    if (!image) {
      throw new Error(
        "Matchlock run requires a requested image; inherited policy or --matchlock is empty.",
      );
    }
    // MTLK-VM-SIZE US-003: resolve the effective VM resource limits for a
    // FRESH opt-in — explicit CLI limits win, else the host-derived defaults.
    // An inherited policy's limits are resolved by admission and always win
    // (a rugpull replacement keeps the failed run's admitted VM size).
    const resourceLimitsForAdmission: ExecutionIsolationResourceLimits | undefined =
      matchlockResourceLimits ??
      (matchlockPolicy?.resourceLimits
        ? undefined
        : resolveDefaultMatchlockResourceLimits(matchlockResourceHostProbe));
    // Harness union (MTLK-PI-EXEC + MTLK-HERMES-EXEC + MTLK-DSH-EXEC): a
    // replacement retains its inherited harness; a fresh run uses the
    // explicitly selected harness (pi default, hermes/dsh opt-in), never
    // falling back to a native path.
    const effectiveHarness: "pi" | "hermes" | "dsh" =
      matchlockPolicy?.harness ??
      (harnessType === "hermes"
        ? "hermes"
        : harnessType === "dsh" || matchlockHarness === "dsh"
          ? "dsh"
          : "pi");
    // MTLK-ALLOW-PRIVATE: the CLI-resolved allow-private list is supplied for
    // a FRESH opt-in ONLY. A replacement (inherited `matchlockPolicy`) retains
    // the persisted policy's list — admission resolves inherited > supplied so
    // the list is never re-derived from the daemon environment here.
    const allowPrivateForAdmission: string[] | undefined =
      !matchlockPolicy && matchlockAllowPrivate && matchlockAllowPrivate.length > 0
        ? [...matchlockAllowPrivate]
        : undefined;
    const admission = await admitMatchlockRun({
      requestedImage: image,
      // SHARED-V3 provenance + R13 consent for a FRESH opt-in. An inherited
      // policy (matchlockPolicy) carries its own persisted values and admission
      // preserves them VERBATIM — these fresh inputs are never consulted for a
      // replacement.
      ...(!matchlockPolicy
        ? { imageSource: matchlockImageSource, rootUsageConsent: matchlockRootUsageOverride === true }
        : {}),
      harness: effectiveHarness,
      // ICEBOX isolation settings: a FRESH opt-in threads the
      // submission-resolved pair (value + source) so admission persists it;
      // a replacement omits both and admission preserves the inherited
      // values VERBATIM.
      ...(isolationSettings
        ? {
            matchlockPrivileged: isolationSettings.matchlockPrivileged,
            matchlockDnsPriority: isolationSettings.matchlockDnsPriority,
          }
        : {}),
      // FROZEN submission inputs for a FRESH hermes/dsh opt-in. A replacement
      // (inheritedPolicy) carries its own frozen inputs on the inherited
      // policy and never re-captures ambient state.
      ...(effectiveHarness === "hermes" && !matchlockPolicy
        ? { submission: hermesSubmission }
        : {}),
      ...(effectiveHarness === "dsh" && !matchlockPolicy && dshSubmission
        ? { submission: dshSubmission }
        : {}),
      workspaceMode,
      workingDirectory: workingDirectoryForHarness,
      worktreeOriginRepository:
        workspaceMode === "worktree"
          ? (seededContext.worktree_origin_repository ?? undefined)
          : undefined,
      inheritedPolicy: matchlockPolicy,
      resourceLimits: resourceLimitsForAdmission,
      ...(allowPrivateForAdmission ? { allowPrivate: allowPrivateForAdmission } : {}),
      ...(matchlockAllowPrivateSupportProbe
        ? { allowPrivateSupportProbe: matchlockAllowPrivateSupportProbe }
        : {}),
      ...(matchlockSwapSupportProbe
        ? { swapSupportProbe: matchlockSwapSupportProbe }
        : {}),
    });
    persistedMatchlockResourceLimits = { ...admission.policy.resourceLimits };
    // MTLK-ISO-SLICE2 US-012: the admitted provenance is read from the SAME
    // policy that is persisted below, so `workflow run --json` reports the
    // admitted value (a v2 inheritance normalizes to "explicit").
    persistedMatchlockImageSource = admission.policy.requestedImageSource;
    persistedMatchlockRootUsageConsent = admission.policy.rootUsageConsent === true;
    // MTLK-ISO-SLICE2 US-011: read the admitted immutable image pin from the
    // SAME policy that is persisted below (an inherited replacement preserves
    // the failed run's pin). Both digests are required on a current (v3)
    // record; a legacy fixture without them simply omits the pin line.
    if (
      admission.policy.resolvedImageDigest &&
      admission.policy.resolvedImageConfigDigest
    ) {
      persistedMatchlockPin = {
        digest: admission.policy.resolvedImageDigest,
        configDigest: admission.policy.resolvedImageConfigDigest,
      };
    }
    // MTLK-ISO-SLICE2 PREP-STATE + MTLK-ADMIT-MARKER (tamandua-crf): publish
    // the pinned policy AND release the host-seeded preparation hold in ONE
    // guarded SQLite UPDATE — a single statement is atomic (no transaction
    // spans the resolve RPC above), so there is no "policy persisted but still
    // held" intermediate state for a crash or a concurrent reader to trip on;
    // the release matches native-run parity (a fresh native run is registrable
    // from its INSERT onward). The SET drops ONLY the host-seeded `pause_drain`
    // context key via json_remove — every other key survives untouched — and
    // the WHERE pins the exact fresh-launch ownership shape:
    //   - the row this process inserted must still be running, intent-only
    //     (policy NULL) and intent-recorded — a terminal/deleted/replaced row
    //     cannot take the policy;
    //   - the hold must still be a HOST-seeded representation (the legacy
    //     `draining_pause` D-MARKER seed, or the typed `preparing` re-hold);
    //     an operator pause/drain mid-window records `paused_by` (and a
    //     non-drain pause moves `status` off 'running'), so the WHERE fails
    //     and the whole write is refused — the operator's state and
    //     attribution survive VERBATIM instead of being clobbered.
    const admissionWrite = db
      .prepare(
        `UPDATE runs SET matchlock_policy = ?,
               scheduling_status = ?,
               scheduling_requested_at = ?,
               scheduling_error = NULL,
               context = json_remove(context, '$.${PAUSE_DRAIN_CONTEXT_KEY}'),
               updated_at = ${SQL_NOW_ISO}
         WHERE id = ? AND isolation_intent = ? AND matchlock_policy IS NULL AND status = 'running'
           AND scheduling_status IN (?, ?)
           AND json_extract(context, '$.${PAUSE_DRAIN_CONTEXT_KEY}') = 'true'
           AND json_extract(context, '$.paused_by') IS NULL`,
      )
      .run(
        serializeMatchlockPolicy(admission.policy),
        NATIVE_SCHEDULING_STATUS,
        new Date().toISOString(),
        runId,
        ISOLATION_INTENT_RECORDED,
        DRAINING_PAUSE_SCHEDULING_STATUS,
        PREPARING_SCHEDULING_STATUS,
      );
    // Fail closed on a lost ownership guard: zero rows means another writer
    // (operator pause/drain/cancel, a competing admission, or a deleted row)
    // owns the row NOW. Proceeding would hand the caller a "launched" run
    // whose durable state does not match its admission. The typed conflict
    // error is NOT routed through the generic launch-failure handler (see the
    // catch below): the concurrent writer's state must survive verbatim.
    if (Number(admissionWrite.changes) !== 1) {
      throw new MatchlockAdmissionStateConflictError(
        "Matchlock admission could not persist the pinned policy: the run row changed concurrently during admission " +
          "(refusing to treat an unpersisted admission as a runnable launch).",
      );
    }
    // tamandua-crf: the durable row no longer carries the host-seeded marker;
    // drop it from the in-memory launch context too, so later bookkeeping that
    // serializes this object cannot restore it.
    delete seededContext[PAUSE_DRAIN_CONTEXT_KEY];
  }

  // WAVE-A TCMD (US-004): a launch-declared `--context test_cmd=` establishes
  // the TEST_CMD contract at launch with source 'launch'. It wins over any
  // step-emitted marker: a later step re-emitting the identical value is not a
  // rewrite, and a differing value triggers test_cmd.rewrite_detected in
  // completeStep (step-ops.ts) — never a silent replacement.
  const launchTestCmd = seededContext.test_cmd ?? seededContext.test_cmd_raw;
  if (typeof launchTestCmd === "string" && launchTestCmd.trim() !== "") {
    db.prepare(
      "UPDATE runs SET test_cmd_established = ?, test_cmd_source = 'launch' WHERE id = ?",
    ).run(launchTestCmd, runId);
  }

  // Store base branch SHA for rugpull detection — captured at run creation time
  // so downstream detection can compare against current tip after failure.
  if (workspaceMode === "worktree") {
    seededContext.base_branch_sha = seededContext.worktree_origin_sha;
  } else if (harnessDirIsGitRepo) {
    try {
      seededContext.base_branch_sha = execFileSync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: workingDirectoryForHarness, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString("utf-8")?.trim() ?? "";
      emitEvent({
        ts: new Date().toISOString(),
        event: "run.base_capture_failed",
        runId,
        workflowId,
        detail: `base_branch_sha: git rev-parse HEAD — ${stderr || "git command failed"}`,
      });
      warnings.push(
        `Unable to capture base branch SHA at launch — rugpull detection degraded for this run (git error: ${stderr || "unknown"})`,
      );
      seededContext.base_branch_sha = "";
    }
  }
  // BCAP (US-001): a non-git harness working directory was already classified
  // with a single run.base_capture_skipped event above; base_branch_sha stays
  // empty with no further events or warnings.

  // Insert step records for each workflow step
  const insertStep = db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, conditional_condition, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?, ?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const stepDbId = crypto.randomUUID();
    const maxRetries = step.max_retries ?? 4;
    const stepType = step.type ?? "single";
    const loopConfig = step.loop ? JSON.stringify(step.loop) : null;
    const conditionalCondition =
      step.type === "conditional" ? (step.condition ?? null) : null;
    const scopedAgentId = step.agent.startsWith(`${workflow.id}_`)
      ? step.agent
      : `${workflow.id}_${step.agent}`;

    insertStep.run(
      stepDbId,
      runId,
      step.id,
      scopedAgentId,
      i,
      step.input,
      step.expects,
      maxRetries,
      stepType,
      loopConfig,
      conditionalCondition,
      now,
      now,
    );
  }

  // Emit run.started event
  emitEvent({
    ts: now,
    event: "run.started",
    runId,
    workflowId,
    ...(parentRunId ? { parentRunId } : {}),
    // GIDN US-002: record the identity every git operation of this run uses,
    // together with the source it was resolved from (the resolver always
    // returns an identity, so this field is always populated).
    gitIdentity: {
      name: gitIdentity.name,
      email: gitIdentity.email,
      source: gitIdentity.source,
    },
    detail: `Run #${runNumber}: ${taskTitle}`,
  });

  // Promote the first step from 'waiting' to 'pending' so an agent can claim it.
  // Without this kickoff, claimStep (which only matches 'pending') would never find
  // the first step and the run would loop forever on peek=HAS_WORK / claim=NO_WORK.
  advancePipeline(runId);
  } catch (err) {
    // MTLK-ADMIT-MARKER (tamandua-crf): a state-ownership conflict means a
    // concurrent writer (operator pause/cancel, or another admission) owns the
    // row NOW — the generic failure handler must not overwrite that state with
    // the stale launch view (it would resurrect the seeded marker and reset
    // status). Every OTHER launch failure keeps the historical failure
    // bookkeeping (launch_error recorded, run failed).
    if (runPersisted && !(err instanceof MatchlockAdmissionStateConflictError)) {
      failPersistedRunLaunch({
        runId,
        workflowId,
        error: err,
      });
    }
    throw err;
  }

  // Once the run row exists and the pipeline is advanced, the run is live.
  // Subsequent daemon operations may fail transiently (DBLK event-loop
  // starvation under fleet load) but must NEVER be reported as a launch
  // failure — the run is already in the DB and the reconciler sweep will
  // admit it. Capture probe timeouts as warnings; genuine registration
  // failures (non-2xx, daemon rejected the run) remain fatal.
  let daemonWarning: string | undefined;
  // US-003: set when the daemon parks the run as 'waiting' behind another
  // live run that holds the harness working directory. This is a success
  // outcome (2xx), never a launch failure.
  let queuedBehindRunId: string | undefined;
  let schedulingState: string | undefined;

  try {
    await ensureDaemonControlAvailable();
  } catch (err) {
    // Any failure to reach the daemon control plane after the run row
    // is already persisted MUST NOT be reported as a launch failure.
    // This covers probe timeouts, daemon start failures, and any other
    // transient daemon-side issue. The reconciler sweep will admit the
    // run once the daemon recovers.
    daemonWarning = (err as Error).message;
  }

  if (daemonWarning === undefined) {
    // Control plane is reachable — register the run and kick first dispatch.
    const registration = await registerRunWithDaemon(runId, 5000);
    if (!registration || registration.status < 200 || registration.status >= 300) {
      const message =
        typeof registration?.body.error === "string"
          ? registration.body.error
          : "daemon registration failed";

      // WORKDIR-FLAGS US-004: a 409 `{state:"refused"}` is a typed, terminal
      // outcome, not a generic registration failure. The daemon has already
      // recorded the refusal; fail the persisted run (status 'failed',
      // scheduling_status 'error') and hand the CLI the actionable message +
      // holder so it can exit with the dedicated refusal code. Every other
      // non-2xx response keeps the historical throwing path below.
      if (
        registration &&
        registration.status === 409 &&
        registration.body.state === WORKDIR_REFUSAL_STATE
      ) {
        const refusalMessage =
          typeof registration.body.message === "string"
            ? registration.body.message
            : message;
        failRefusedRunLaunch({
          runId,
          workflowId,
          message: refusalMessage,
        });

        const heldByRunId =
          typeof registration.body.heldByRunId === "string" &&
          registration.body.heldByRunId.length > 0
            ? registration.body.heldByRunId
            : undefined;
        const holder = parseWorkdirCollisionHolder(registration.body.holder);
        const refusedDir =
          typeof registration.body.workingDirectoryForHarness === "string"
            ? registration.body.workingDirectoryForHarness
            : workingDirectoryForHarness;

        return {
          runId,
          runNumber,
          workflowId,
          taskTitle,
          status: "failed",
          stepCount: workflow.steps.length,
          workingDirectoryForHarness,
          workdirRefused: {
            message: refusalMessage,
            ...(heldByRunId ? { heldByRunId } : {}),
            ...(holder ? { holder } : {}),
            workingDirectoryForHarness: refusedDir,
          },
        };
      }

      db.prepare(
        `UPDATE runs SET status = 'failed', scheduling_status = NULL, scheduling_error = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
      ).run(message, runId);
      emitEvent({
        ts: new Date().toISOString(),
        event: "run.failed",
        runId,
        workflowId,
        detail: `Registration failed: ${message}`,
      });
      scheduleRunCronTeardown(runId);
      throw new Error(`Failed to register run with daemon: ${message}`);
    }

    // US-003: a 2xx `waiting` admission means the harness working directory is
    // held by another live run. Treat it as success (the run row stays
    // 'running' with scheduling_status='waiting'); surface the holder and the
    // admission state so the CLI can explain the queue position. The
    // reconciler admits the run when the holder releases the directory.
    if (registration.body.state === "waiting") {
      schedulingState = "waiting";
      if (
        typeof registration.body.heldByRunId === "string" &&
        registration.body.heldByRunId.length > 0
      ) {
        queuedBehindRunId = registration.body.heldByRunId;
      }
    }

    // Kick the first dispatch immediately — the first step is already
    // 'pending', so without a nudge the run would idle until the fallback
    // dispatch sweep. Fire-and-forget: the sweep is the safety net.
    nudgeWithDaemon().catch(() => {});
  }
  // Note: when daemonWarning is set, we intentionally skip registration
  // and nudge. The run row already exists with scheduling_status=
  // 'pending_register', and the daemon's reconciler sweep will admit it
  // when the control plane recovers.

  return {
    runId,
    runNumber,
    workflowId,
    taskTitle,
    status: "running",
    stepCount: workflow.steps.length,
    workingDirectoryForHarness,
    daemonWarning,
    queuedBehindRunId,
    schedulingState,
    captureWarnings: warnings.length > 0 ? warnings : undefined,
    matchlockResourceLimits: persistedMatchlockResourceLimits,
    matchlockPin: persistedMatchlockPin,
    matchlockImageSource: persistedMatchlockImageSource,
    matchlockRootUsageConsent: persistedMatchlockRootUsageConsent,
  };
}

export interface ResumeResult {
  status: "not_found" | "resumed" | "refused" | "preparing";
  runId?: string;
  workflowId?: string;
  stepId?: string;
  /** YSE US-002: number of FAILED stories re-queued to pending on this resume (0/absent when none). */
  resetCount?: number;
  /**
   * WORKDIR-FLAGS US-005: set when the daemon parked the resumed run as
   * 'waiting' because another live run holds its harness working directory
   * (the explicit queue policy). The run is registered and the reconciler
   * admits it once the holder releases the directory.
   */
  queuedBehindRunId?: string;
  /** The daemon admission state that queuedBehindRunId corresponds to ('waiting'). */
  schedulingState?: string;
  /**
   * MTLK-ISO-SLICE2 US-008 (PREP-STATE): set when the target carries the
   * isolation intent but no pinned Matchlock policy yet. The failed-run resume
   * is routed to preparation recovery (held): it is never admitted natively,
   * never resolves a native harness and never records root consent. `message`
   * names the held/preparing state and the retry/recreate remedy.
   */
  preparingHeld?: {
    message: string;
  };
  /**
   * MTLK-ISO-SLICE2 US-010 (R13): a typed Matchlock refusal on the failed-run
   * resume path — a truly-native run given the override, a non-NULL unusable
   * policy (STATUS-UNUSABLE), the root-usage gate, or the swap-capability
   * handshake. `code` is the typed vocabulary; `message` is the operator-facing
   * refusal. A refusal always preserves the run's prior state.
   */
  matchlockRefused?: {
    code: string;
    message: string;
  };
  /**
   * WORKDIR-FLAGS US-005: set when the daemon REFUSED the resume because the
   * harness working directory is held by a live run and the collision policy
   * is the default `refuse`. Typed, non-throwing: the CLI renders `message`
   * (which already names the holder and the three ways out) to stderr and
   * exits WORKDIR_REFUSAL_EXIT_CODE.
   */
  workdirRefused?: {
    message: string;
    heldByRunId?: string;
    holder?: WorkdirCollisionHolder;
    workingDirectoryForHarness: string;
  };
  /**
   * MTLK-ISO-SLICE2 US-013 (R13): the shared advisory warnings channel. An
   * array of `{ code, message }` entries, present ONLY when non-empty. A
   * `consent_granted_on_resume` entry means THIS resume granted root consent;
   * inherited consent surfaces `root_usage_override`. Advisory only — it never
   * changes the resume outcome, status or exit code.
   */
  warnings?: WorkflowWarning[];
}

/**
 * MTLK-ISO-SLICE2 US-010: options for the failed-run `resumeWorkflow` form.
 * Mirrors the executable order of spec C §4.4: the root-usage override is
 * honored only for a run with a non-NULL persisted policy; the swap-capability
 * handshake seam is injectable so tests journal the probe and never spawn a
 * real binary.
 */
export interface ResumeWorkflowOptions {
  /** WORKDIR-FLAGS US-005: the collision policy to apply on this resume. */
  workdirCollisionPolicy?: WorkdirCollisionPolicy;
  /**
   * R13: true ONLY when the operator explicitly supplied
   * `--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs` to
   * THIS resume. Grants root consent on a non-NULL usable policy; refused for a
   * truly native run. Absent/false never manufactures consent.
   */
  matchlockRootUsageOverride?: boolean;
  /**
   * US-001 probe seam: re-run the swap-capability handshake for a Matchlock run
   * before re-registering. Production omits it and probes the resolved
   * matchlock binary itself.
   */
  matchlockSwapSupportProbe?: MatchlockSwapSupportProbe;
  /**
   * MTLK-ISO2-CORRECTIVE (Family B1): inherited-image resolve + re-verify seam.
   * Production omits it and re-resolves/verifies the persisted pin over an
   * owned RPC before any state write; tests inject a moved/absent/supporting
   * verifier so no real binary or VM is used.
   */
  matchlockInheritedImageVerifier?: InheritedImageVerifier;
  /**
   * MTLK-ISO2-CORRECTIVE (Family A): the ONE absolute matchlock binary path
   * for this resume's transport. Tests pin a fake driver; production lets the
   * preflight resolve it.
   */
  rpcBinaryPath?: string;
  /** MTLK-ISO2-CORRECTIVE (Family A): explicit rpc args (tests). */
  rpcArgs?: string[];
  /**
   * R13 seam: effective-uid of the process performing THIS resume. Production
   * omits it (the real `process.geteuid()` is consulted); tests inject a
   * deterministic value. Host process identity only.
   */
  effectiveUid?: () => number;
}

/** Default effective-uid probe for the resume root gate (non-root sentinel). */
function defaultResumeEffectiveUid(): number {
  return typeof process.geteuid === "function" ? process.geteuid() : -1;
}

/**
 * MTLK-ISO2-CORRECTIVE: test-only default for the failed-run resume
 * inherited-image verifier. Production leaves this null (the real owned-RPC
 * resolve/re-verify runs); tests set a deterministic verifier so no real
 * binary or VM is used.
 */
let resumeInheritedImageVerifierForTest: InheritedImageVerifier | null = null;

/** @internal test hook: pin (or clear) the failed-run image verifier. */
export function _setResumeInheritedImageVerifierForTest(
  verifier: InheritedImageVerifier | null,
): void {
  resumeInheritedImageVerifierForTest = verifier;
}

/** One step/story row's tracked fields (prior or post image). */
interface ResumeRowSnapshot {
  id: string;
  status: string;
  retry_count: number;
  output: string | null;
  resume_reset_count?: number;
}


export async function resumeWorkflow(
  runId: string,
  opts?: ResumeWorkflowOptions,
): Promise<ResumeResult> {
  const db = getDb();
  const run = db.prepare(
    "SELECT id, workflow_id, status, context, isolation_intent, matchlock_policy, scheduling_status, scheduling_requested_at, scheduling_error, harness_probe_status, harness_probe_at FROM runs WHERE id = ? AND status = 'failed'",
  ).get(runId) as {
    id: string;
    workflow_id: string;
    status: string;
    context: string;
    matchlock_policy: string | null;
    isolation_intent: string | null;
    scheduling_status: string | null;
    scheduling_requested_at: string | null;
    scheduling_error: string | null;
    harness_probe_status: string | null;
    harness_probe_at: string | null;
  } | undefined;

  if (!run) return { status: "not_found" };

  // ── MTLK-ISO-SLICE2 US-008 (PREP-STATE) held guard ───────────────
  // An intent-only row (isolation intent recorded, no pinned policy yet) is
  // mid-preparation, NOT native. Route it to preparation recovery: keep it in
  // the non-schedulable `preparing` hold, resolve no native harness, register
  // no native scheduling and record no root consent. The shared classification
  // is explicit non-NULL-ness, so a non-NULL (even empty-string) policy always
  // wins and follows the normal path below. Remedy: retry preparation or
  // recreate the run (spec C §4.4 / §10 item 7).
  if (readIsolationState(run) === "preparing") {
    const heldMessage = isolationPreparingHeldText();
    try {
      // Conditional: a concurrent admission that persisted the policy must
      // never be clobbered back into the hold.
      db.prepare(
        `UPDATE runs SET scheduling_status = ?, scheduling_error = NULL, updated_at = ${SQL_NOW_ISO}
         WHERE id = ? AND isolation_intent = ? AND matchlock_policy IS NULL`,
      ).run(PREPARING_SCHEDULING_STATUS, run.id, ISOLATION_INTENT_RECORDED);
    } catch {
      // Best effort only; the typed held result is returned regardless.
    }
    return {
      status: "preparing",
      runId: run.id,
      workflowId: run.workflow_id,
      schedulingState: PREPARING_SCHEDULING_STATUS,
      preparingHeld: { message: heldMessage },
    };
  }

  // ── MTLK-ISO-SLICE2 US-010 (R13): failed-run resume consent ordering ─────
  // Spec C §4.4. The failed-run resume form of the executable order:
  //   (1) load and structurally validate the persisted policy (no matchlock
  //       interaction yet);
  //   (2) determine effective root permission — valid inherited consent OR the
  //       explicit override supplied to THIS action;
  //   (3) run the permitted checks (the swap-capability handshake and the
  //       harness/policy validation below);
  //   (4) commit the consent change + scheduling transition in ONE short
  //       synchronous DB section (no transaction spans RPC/subprocess work).
  // Every refusal returns BEFORE any state write, so a refused resume leaves
  // the run's prior (failed) state untouched.
  const isolationState = readIsolationState(run);
  const rootUsageOverride = opts?.matchlockRootUsageOverride === true;

  if (isolationState === "unusable") {
    // STATUS-UNUSABLE refusal BEFORE consent is consulted: the override never
    // rescues a malformed/legacy record. No state write.
    const { code, reason } = describeUnusableMatchlockPolicy(run.matchlock_policy);
    return {
      status: "refused",
      runId: run.id,
      workflowId: run.workflow_id,
      matchlockRefused: {
        code,
        message:
          `Cannot resume run: matchlock: ISOLATION POLICY UNUSABLE (${code}): ${reason}. ` +
          "The run's state was left unchanged; recreate the run with --matchlock " +
          "(or provision this host with `tamandua matchlock setup`).",
      },
    };
  }

  if (rootUsageOverride && isolationState === "native") {
    // A truly native run (no intent, no policy) has nothing for the override
    // to consent to: passing it is refused and names that fact (spec C §4.4).
    return {
      status: "refused",
      runId: run.id,
      workflowId: run.workflow_id,
      matchlockRefused: {
        code: "matchlock_root_usage_override_not_applicable",
        message:
          `Cannot resume run: ${MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG} applies only to Matchlock runs, ` +
          "but this run carries no isolation intent and no persisted Matchlock policy (a truly native run). " +
          "The run's state was left unchanged.",
      },
    };
  }

  let grantConsent = false;
  let inheritedRootConsent = false;
  // MTLK-ISO2-CORRECTIVE (Family B1): BOTH resume forms share ONE ordered
  // preflight — effective root permission, then the swap-capability handshake
  // AND the inherited-image resolve/re-verify, ALL before any state write.
  if (isolationState === "isolated") {
    const matchlockPolicy = parseMatchlockPolicy(run.matchlock_policy as string);
    inheritedRootConsent = matchlockPolicy.rootUsageConsent === true;

    const preflight = await runMatchlockResumePreflight({
      policy: matchlockPolicy,
      effectiveUid: opts?.effectiveUid ?? defaultResumeEffectiveUid,
      inheritedRootConsent,
      rootUsageOverride,
      ...(opts?.matchlockSwapSupportProbe
        ? { swapSupportProbe: opts.matchlockSwapSupportProbe }
        : {}),
      ...((opts?.matchlockInheritedImageVerifier ?? resumeInheritedImageVerifierForTest)
        ? {
            verifyInheritedImage:
              opts?.matchlockInheritedImageVerifier ??
              (resumeInheritedImageVerifierForTest as InheritedImageVerifier),
          }
        : {}),
      ...(opts?.rpcBinaryPath ? { rpcBinaryPath: opts.rpcBinaryPath } : {}),
      ...(opts?.rpcArgs ? { rpcArgs: opts.rpcArgs } : {}),
    });
    if (!preflight.ok) {
      return {
        status: "refused",
        runId: run.id,
        workflowId: run.workflow_id,
        matchlockRefused: { code: preflight.code, message: preflight.message },
      };
    }
    grantConsent = preflight.grantConsent;
  }

  await ensureDaemonControlAvailable();
  // MTLK-ISO2-CORRECTIVE (Finding D): never resume an intent-recorded run
  // against a daemon that cannot honor the PREP-STATE hold.
  if (isolationState === "isolated") {
    try {
      await assertDaemonPrepStateCapability();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "refused",
        runId: run.id,
        workflowId: run.workflow_id,
        matchlockRefused: { code: "matchlock_daemon_prep_state_unsupported", message },
      };
    }
  }
  const harnessValidation = await validateRunHarnessForScheduling(run.id, run.context, {
    matchlockPolicy: run.matchlock_policy,
  });

  // MTLK-ISO2-MEND (Family A/B): capture the before image, then ship the
  // consent bytes, the scheduling transition AND the collision-policy context
  // edit through ONE expected-state compare-and-swap commit. A conflict writes
  // NOTHING, so a pre-commit cancellation can never have already lost a
  // preexisting context key. Only a Matchlock (non-native) resume needs the
  // write-set; the native behavior is unchanged.
  const priorSteps = db
    .prepare("SELECT id, status, retry_count, output FROM steps WHERE run_id = ?")
    .all(run.id) as unknown as ResumeRowSnapshot[];
  const priorStories = db
    .prepare(
      "SELECT id, status, retry_count, output, resume_reset_count FROM stories WHERE run_id = ?",
    )
    .all(run.id) as unknown as ResumeRowSnapshot[];

  // WORKDIR-FLAGS US-005: resume/replacement runs apply the same collision rule
  // as a fresh launch. The default (`refuse`) CLEARS any persisted policy so a
  // resume that would collide is refused; an explicit queue/allow choice is
  // persisted into the run context. The context edit rides the SAME guarded
  // commit as the status/policy transition below.
  const collisionPolicy = opts?.workdirCollisionPolicy ?? "refuse";
  const priorContext = run.context ?? "";
  let resumeContextObj: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(priorContext) as unknown;
    if (parsed && typeof parsed === "object") {
      resumeContextObj = parsed as Record<string, unknown>;
    }
  } catch {
    resumeContextObj = {};
  }
  if (collisionPolicy === "refuse") {
    delete resumeContextObj[WORKDIR_COLLISION_POLICY_KEY];
  } else {
    resumeContextObj[WORKDIR_COLLISION_POLICY_KEY] = collisionPolicy;
  }
  const postContext = JSON.stringify(resumeContextObj);

  // MTLK-ISO2-TRANSITION-CAS (Family A): the exact BEFORE values and the exact
  // AFTER values of every durable write this request owns. A late registration
  // refusal resolves each of its OWN columns individually — there is no
  // post-commit compensator.
  const resumeNow = new Date().toISOString();
  const grantedPolicy =
    grantConsent && run.matchlock_policy !== null && run.matchlock_policy !== undefined
      ? withGrantedRootUsageConsent(run.matchlock_policy)
      : run.matchlock_policy;
  const ownFailedWrite =
    isolationState !== "native"
      ? {
          prior: {
            status: run.status,
            schedulingStatus: run.scheduling_status,
            schedulingRequestedAt: run.scheduling_requested_at,
            schedulingError: run.scheduling_error,
            policy: run.matchlock_policy,
            probeStatus: run.harness_probe_status,
            probeAt: run.harness_probe_at,
            context: priorContext,
          },
          after: {
            status: "running",
            schedulingStatus: "pending_register" as string | null,
            schedulingRequestedAt: resumeNow as string | null,
            schedulingError: null as string | null,
            policy: grantedPolicy,
            probeStatus: run.harness_probe_status,
            probeAt: run.harness_probe_at,
            context: postContext,
          },
        }
      : null;

  // The step the resumed run restarts from (surfaced to the CLI) and the
  // failed-story reset count are computed INSIDE the one CAS transaction so a
  // step/story write fault rolls the whole transition back.
  let restartStepId: string | undefined;
  let storyReset: { resetCount: number } = { resetCount: 0 };

  try {
    db.exec("BEGIN IMMEDIATE");
    const guard = db
      .prepare(
        "SELECT id FROM runs WHERE id = ? AND status = 'failed' AND scheduling_status IS ? AND matchlock_policy IS ? AND context IS ?",
      )
      .get(run.id, run.scheduling_status, run.matchlock_policy, priorContext);
    if (!guard) {
      db.exec("ROLLBACK");
      return {
        status: "refused",
        runId: run.id,
        workflowId: run.workflow_id,
        matchlockRefused: {
          code: "matchlock_run_state_changed",
          message:
            "Cannot resume run: the run's state changed concurrently (cancellation, pause/drain or a competing resume); retry the resume.",
        },
      };
    }
    if (grantConsent && run.matchlock_policy !== null && run.matchlock_policy !== undefined) {
      db.prepare(
        `UPDATE runs SET matchlock_policy = ?, status = 'running', scheduling_status = 'pending_register', scheduling_requested_at = ?, scheduling_error = NULL, context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
      ).run(grantedPolicy, resumeNow, postContext, run.id);
    } else {
      db.prepare(
        `UPDATE runs SET status = 'running', scheduling_status = 'pending_register', scheduling_requested_at = ?, scheduling_error = NULL, context = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
      ).run(resumeNow, postContext, run.id);
    }

    // RPRB (6sy.37): an explicit resume must re-probe a run whose launch-time
    // harness probe recorded a definitive 'failed' outcome — the operator has
    // presumably repaired the harness since. The conditional helper clears ONLY
    // 'failed' (with its timestamp). Inside the same transaction so a later
    // fault rolls it back.
    resetFailedHarnessProbeForResume(run.id);

    // Find the first failed step and reset it + subsequent steps.
    const failedStep = db.prepare(
      "SELECT id, step_id, step_index FROM steps WHERE run_id = ? AND status = 'failed' ORDER BY step_index ASC LIMIT 1",
    ).get(run.id) as { id: string; step_id: string; step_index: number } | undefined;

    restartStepId = failedStep?.step_id;

    if (failedStep) {
      // Reset this step and all subsequent steps back to waiting
      db.prepare(
        `UPDATE steps SET status = 'waiting', retry_count = 0, output = NULL, updated_at = ${SQL_NOW_ISO} WHERE run_id = ? AND step_index >= ?`,
      ).run(run.id, failedStep.step_index);
    } else {
      // Force-failed shape: forceFailRun leaves the run 'failed' with ALL
      // non-done steps 'canceled' — there is no 'failed' step to restart
      // from. Repair the interrupted pipeline by resetting from the first
      // non-'done' step onward so the canceled work returns to 'waiting'
      // and the dispatch motor can reclaim it. (Without this repair,
      // advancePipeline below would see an "empty" pipeline of canceled
      // steps and spuriously complete the run.)
      const firstNonDone = db.prepare(
        "SELECT step_id, step_index FROM steps WHERE run_id = ? AND status != 'done' ORDER BY step_index ASC LIMIT 1",
      ).get(run.id) as { step_id: string; step_index: number } | undefined;
      if (firstNonDone) {
        db.prepare(
          `UPDATE steps SET status = 'waiting', retry_count = 0, output = NULL, updated_at = ${SQL_NOW_ISO} WHERE run_id = ? AND step_index >= ?`,
        ).run(run.id, firstNonDone.step_index);
        restartStepId = firstNonDone.step_id;
      }
    }

    // YSE US-002: re-queue every FAILED story of a loop-over-stories run as
    // PENDING with a fresh verification retry budget. Runs without a
    // loop-over-stories step or without failed stories are unaffected.
    storyReset = resetFailedStoriesForResume(run.id);

    // Advance the pipeline ONLY when there is work to advance. An
    // interrupted/empty pipeline must never be completed during resume.
    const pendingWork = db.prepare(
      "SELECT id FROM steps WHERE run_id = ? AND status = 'waiting' LIMIT 1",
    ).get(run.id) as { id: string } | undefined;
    if (pendingWork) {
      // Promote the next eligible waiting step to 'pending' so the dispatch motor can claim it.
      advancePipeline(run.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* best effort */
    }
    // A fault inside the transition (e.g. a step-write trigger) must surface to
    // the caller: the whole transaction is rolled back, so no half-transition
    // survives. Do NOT swallow it into a typed refusal.
    throw err;
  }

  // MTLK-ISO2-TRANSITION-CAS (Family A): capture the AFTER images (run + steps
  // + stories) of THIS request's transition. A late registration refusal
  // resolves exactly its own columns; nothing is a whole-row restore.
  let ownAfterSteps: ResumeRowSnapshot[] = [];
  let ownAfterStories: ResumeRowSnapshot[] = [];
  if (ownFailedWrite) {
    const postRunRow = db
      .prepare(
        `SELECT status, scheduling_status, scheduling_requested_at, scheduling_error,
                matchlock_policy, harness_probe_status, harness_probe_at, context
         FROM runs WHERE id = ?`,
      )
      .get(run.id) as
      | {
          status: string;
          scheduling_status: string | null;
          scheduling_requested_at: string | null;
          scheduling_error: string | null;
          matchlock_policy: string | null;
          harness_probe_status: string | null;
          harness_probe_at: string | null;
          context: string;
        }
      | undefined;
    if (postRunRow) {
      ownFailedWrite.after = {
        status: postRunRow.status,
        schedulingStatus: postRunRow.scheduling_status,
        schedulingRequestedAt: postRunRow.scheduling_requested_at,
        schedulingError: postRunRow.scheduling_error,
        policy: postRunRow.matchlock_policy,
        probeStatus: postRunRow.harness_probe_status,
        probeAt: postRunRow.harness_probe_at,
        context: postRunRow.context,
      };
    }
    ownAfterSteps = db
      .prepare("SELECT id, status, retry_count, output FROM steps WHERE run_id = ?")
      .all(run.id) as unknown as ResumeRowSnapshot[];
    ownAfterStories = db
      .prepare(
        "SELECT id, status, retry_count, output, resume_reset_count FROM stories WHERE run_id = ?",
      )
      .all(run.id) as unknown as ResumeRowSnapshot[];
  }

  // Per-key context inverse: only keys THIS request moved are reverted, and only
  // while the current value still equals what this request wrote.
  const inverseFailedContext = (
    priorStr: string,
    postStr: string,
    currentStr: string,
  ): string => {
    if (currentStr === postStr) return priorStr;
    const has = (o: Record<string, unknown>, k: string): boolean =>
      Object.prototype.hasOwnProperty.call(o, k);
    const eq = (a: unknown, b: unknown): boolean =>
      a === undefined ? b === undefined : b !== undefined && a === b;
    let prior: Record<string, unknown> = {};
    let post: Record<string, unknown> = {};
    let current: Record<string, unknown> = {};
    try {
      prior = (JSON.parse(priorStr) ?? {}) as Record<string, unknown>;
    } catch {
      prior = {};
    }
    try {
      post = (JSON.parse(postStr) ?? {}) as Record<string, unknown>;
    } catch {
      return currentStr;
    }
    try {
      current = (JSON.parse(currentStr) ?? {}) as Record<string, unknown>;
    } catch {
      return currentStr;
    }
    if (typeof prior !== "object" || prior === null) prior = {};
    if (typeof post !== "object" || post === null) return currentStr;
    if (typeof current !== "object" || current === null) current = {};
    const out: Record<string, unknown> = { ...current };
    const keys = new Set([...Object.keys(prior), ...Object.keys(post)]);
    for (const key of keys) {
      const p = has(prior, key) ? prior[key] : undefined;
      const q = has(post, key) ? post[key] : undefined;
      if (eq(p, q)) continue; // this request did not move the key
      const c = has(current, key) ? current[key] : undefined;
      if (!eq(c, q)) continue; // a competing writer moved it; that value wins
      if (has(prior, key)) out[key] = prior[key];
      else delete out[key];
    }
    return JSON.stringify(out);
  };

  // Resolve this request's OWN durable writes after a late registration
  // refusal. Inline and narrow (the AST-extraction instrument resolves no new
  // module-level helper). MTLK-ISO2-SUPERSEDED-RESUME: the ownership pivot is
  // this request's own IMMUTABLE MINTED TOKEN, compared inside the resolution
  // transaction BEFORE any write — a competing committed successor (distinct
  // token) is left entirely untouched. Only a token-owned row is resolved: a
  // competing terminal (completed/canceled) wins; otherwise each owned column
  // returns to its prior value. A step/story row whose ownership pivot
  // (`status`) no longer equals this request's after image is foreign and is
  // left byte-exactly alone.
  const resolveFailedResumeWrites = (): void => {
    if (!ownFailedWrite) return;
    try {
      db.exec("BEGIN IMMEDIATE");
      const cur = db
        .prepare(
          `SELECT status, scheduling_status, scheduling_requested_at, scheduling_error,
                  matchlock_policy, harness_probe_status, harness_probe_at, context
           FROM runs WHERE id = ?`,
        )
        .get(run.id) as
        | {
            status: string;
            scheduling_status: string | null;
            scheduling_requested_at: string | null;
            scheduling_error: string | null;
            matchlock_policy: string | null;
            harness_probe_status: string | null;
            harness_probe_at: string | null;
            context: string;
          }
        | undefined;
      // MTLK-ISO2-SUPERSEDED-RESUME (ownership pivot): ownership is the
      // REQUEST'S OWN IMMUTABLE MINTED TOKEN, compared inside this short
      // transaction and BEFORE any field is changed. A competing committed
      // successor holds a DISTINCT non-null token, so it is not this request's
      // row: skip ALL owned-column writes (run AND step/story loops) and close
      // the transaction cleanly. The after-image is NOT a safe pivot — it is
      // re-read after awaited work and may already be contaminated by the
      // successor. A missing row has nothing to resolve. A same-token terminal
      // (completed/canceled) is handled below by `competingTerminal`.
      if (!cur || cur.scheduling_requested_at !== resumeNow) {
        db.exec("COMMIT");
        return;
      }
      const competingTerminal =
        cur.status === "completed" || cur.status === "canceled";
      db.prepare(
        `UPDATE runs
         SET status = ?, scheduling_status = ?, scheduling_requested_at = ?,
             scheduling_error = ?, matchlock_policy = ?, context = ?,
             harness_probe_status = ?, harness_probe_at = ?
         WHERE id = ?`,
      ).run(
        competingTerminal ? cur.status : ownFailedWrite.prior.status,
        competingTerminal ? cur.scheduling_status : ownFailedWrite.prior.schedulingStatus,
        competingTerminal
          ? cur.scheduling_requested_at
          : ownFailedWrite.prior.schedulingRequestedAt,
        competingTerminal ? cur.scheduling_error : ownFailedWrite.prior.schedulingError,
        cur.matchlock_policy === ownFailedWrite.after.policy
          ? ownFailedWrite.prior.policy
          : cur.matchlock_policy,
        inverseFailedContext(
          ownFailedWrite.prior.context,
          ownFailedWrite.after.context,
          cur.context ?? "",
        ),
        cur.harness_probe_status === ownFailedWrite.after.probeStatus
          ? ownFailedWrite.prior.probeStatus
          : cur.harness_probe_status,
        cur.harness_probe_at === ownFailedWrite.after.probeAt
          ? ownFailedWrite.prior.probeAt
          : cur.harness_probe_at,
        run.id,
      );
      const step = db.prepare(
        "UPDATE steps SET status = ?, retry_count = ?, output = ? WHERE id = ? AND run_id = ?",
      );
      for (const before of priorSteps) {
        const after = ownAfterSteps.find((s) => s.id === before.id);
        if (!after) continue;
        const current = db
          .prepare("SELECT status, retry_count, output FROM steps WHERE id = ? AND run_id = ?")
          .get(before.id, run.id) as
          | { status: string; retry_count: number; output: string | null }
          | undefined;
        if (!current || current.status !== after.status) continue; // foreign row
        const nextStatus = before.status === after.status ? current.status : before.status;
        const nextRetry =
          before.retry_count === after.retry_count
            ? current.retry_count
            : current.retry_count === after.retry_count
              ? before.retry_count
              : current.retry_count;
        const nextOutput =
          before.output === after.output
            ? current.output
            : current.output === after.output
              ? before.output
              : current.output;
        step.run(nextStatus, nextRetry, nextOutput, before.id, run.id);
      }
      const story = db.prepare(
        "UPDATE stories SET status = ?, retry_count = ?, output = ?, resume_reset_count = ? WHERE id = ? AND run_id = ?",
      );
      for (const before of priorStories) {
        const after = ownAfterStories.find((s) => s.id === before.id);
        if (!after) continue;
        const current = db
          .prepare(
            "SELECT status, retry_count, output, resume_reset_count FROM stories WHERE id = ? AND run_id = ?",
          )
          .get(before.id, run.id) as
          | {
              status: string;
              retry_count: number;
              output: string | null;
              resume_reset_count: number;
            }
          | undefined;
        if (!current || current.status !== after.status) continue; // foreign row
        const nextStatus = before.status === after.status ? current.status : before.status;
        const nextRetry =
          before.retry_count === after.retry_count
            ? current.retry_count
            : current.retry_count === after.retry_count
              ? before.retry_count
              : current.retry_count;
        const nextOutput =
          before.output === after.output
            ? current.output
            : current.output === after.output
              ? before.output
              : current.output;
        const nextReset =
          (before.resume_reset_count ?? 0) === (after.resume_reset_count ?? 0)
            ? current.resume_reset_count
            : current.resume_reset_count === (after.resume_reset_count ?? 0)
              ? (before.resume_reset_count ?? 0)
              : current.resume_reset_count;
        story.run(nextStatus, nextRetry, nextOutput, nextReset, before.id, run.id);
      }
      db.exec("COMMIT");
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* best effort */
      }
    }
  };

  const registration = await registerRunWithDaemon(run.id, 5000);
  if (!registration || registration.status < 200 || registration.status >= 300) {
    const message =
      typeof registration?.body.error === "string"
        ? registration.body.error
        : "daemon registration failed";

    // WORKDIR-FLAGS US-005: a resume/replacement run applies the same rule as a
    // fresh launch. A 409 `{state:"refused"}` is a typed outcome: restore the
    // run's terminal (failed) shape with the refusal recorded, but do NOT emit
    // a second run.failed — the run's truthful terminal event was already
    // emitted when it originally failed. Every other non-2xx keeps the
    // historical throwing path below.
    if (
      registration &&
      registration.status === 409 &&
      registration.body.state === WORKDIR_REFUSAL_STATE
    ) {
      const refusalMessage =
        typeof registration.body.message === "string"
          ? registration.body.message
          : message;
      if (ownFailedWrite) {
        // MTLK-ISO2-TRANSITION-CAS (Family A): resolve this request's OWN
        // writes per column — a competing terminal/foreign writer wins.
        resolveFailedResumeWrites();
      } else {
        try {
          db.prepare(
            `UPDATE runs
             SET status = 'failed', scheduling_status = 'error',
                 scheduling_requested_at = NULL, scheduling_error = ?,
                 updated_at = ${SQL_NOW_ISO}
             WHERE id = ?`,
          ).run(refusalMessage, run.id);
        } catch {
          // Best effort only; the typed refusal is returned regardless.
        }
      }

      const heldByRunId =
        typeof registration.body.heldByRunId === "string" &&
        registration.body.heldByRunId.length > 0
          ? registration.body.heldByRunId
          : undefined;
      const holder = parseWorkdirCollisionHolder(registration.body.holder);
      const refusedDir =
        typeof registration.body.workingDirectoryForHarness === "string"
          ? registration.body.workingDirectoryForHarness
          : harnessValidation.workingDirectoryForHarness;

      return {
        status: "refused",
        runId: run.id,
        workflowId: run.workflow_id,
        workdirRefused: {
          message: refusalMessage,
          ...(heldByRunId ? { heldByRunId } : {}),
          ...(holder ? { holder } : {}),
          workingDirectoryForHarness: refusedDir,
        },
      };
    }

    if (ownFailedWrite) {
      // MTLK-ISO2-TRANSITION-CAS (Family A): every non-2xx registration
      // refusal on a Matchlock resume resolves this request's own columns.
      resolveFailedResumeWrites();
    } else {
      db.prepare(
        `UPDATE runs SET status = 'failed', scheduling_status = NULL, scheduling_error = ?, updated_at = ${SQL_NOW_ISO} WHERE id = ?`,
      ).run(message, run.id);
    }
    // Retriable teardown: the daemon is still draining the run's in-flight
    // workers (e.g. an immediate resume right after force-fail). The run's
    // truthful terminal event (run.force_failed / run.failed) was already
    // emitted — do NOT emit a second run.failed for a resume that never
    // took effect. Everything else keeps the historical behavior.
    const retriableTeardown =
      registration?.status === 503 && /teardown in progress/i.test(message);
    if (!retriableTeardown) {
      emitEvent({
        ts: new Date().toISOString(),
        event: "run.failed",
        runId: run.id,
        workflowId: run.workflow_id,
        detail: `Resume registration failed: ${message}`,
      });
    }
    scheduleRunCronTeardown(run.id);
    throw new Error(`Failed to register resumed run with daemon: ${message}`);
  }

  // US-005: a 2xx `waiting` admission means the explicit queue policy parked
  // the resume behind a live holder. Surface it so the CLI can explain the
  // queue position; the reconciler admits the run when the holder releases.
  let queuedBehindRunId: string | undefined;
  let schedulingState: string | undefined;
  if (registration.body.state === "waiting") {
    schedulingState = "waiting";
    if (
      typeof registration.body.heldByRunId === "string" &&
      registration.body.heldByRunId.length > 0
    ) {
      queuedBehindRunId = registration.body.heldByRunId;
    }
  }

  // Same as runWorkflow: dispatch the re-pended step now, not on the sweep.
  nudgeWithDaemon().catch(() => {});

  // MTLK-ISO-SLICE2 US-013: the shared advisory warning for a consented resume
  // (advisory only — it never changes the outcome above).
  const resumeWarnings = buildWorkflowWarnings({
    consentGrantedOnResume: grantConsent,
    rootUsageConsent: inheritedRootConsent,
  });

  return {
    status: "resumed",
    runId: run.id,
    workflowId: run.workflow_id,
    stepId: restartStepId,
    resetCount: storyReset.resetCount,
    queuedBehindRunId,
    schedulingState,
    ...(resumeWarnings.length > 0 ? { warnings: resumeWarnings } : {}),
  };
}
