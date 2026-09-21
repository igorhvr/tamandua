/**
 * scheduler-dsh.ts — MTLK-DSH-EXEC US-002 scheduler integration seam (dsh).
 *
 * This module is the NARROW seam the deterministic dispatch motor uses to run
 * ONE opted-in dsh invocation (launch probe OR work round) through the dsh
 * Matchlock invocation runner (US-002) instead of the native harness
 * adapters. It mirrors scheduler-matchlock.ts for the pi backend, so:
 *
 *   - the scheduler never calls `getHarnessAdapter(...).findBinary` /
 *     `runRound`, never spawns a host pi/hermes/dsh and never computes a
 *     probe expected value with a host `<launcher> skill-path` child for an
 *     opted-in dsh run;
 *   - scheduler tests run deterministically WITHOUT real VMs by installing a
 *     fake round runner (`setDshSchedulerRoundRunnerForTest` — the same
 *     labelled test-seam pattern the pi backend uses);
 *   - the production default is the REAL runner: one FRESH VM per invocation
 *     via `runDshInvocation` with the persisted image pin, the versioned RO
 *     guest helper pack, the host progress resource and (work rounds)
 *     host-owned suite wiring — the identical registry/broker/helper-pack/
 *     progress/host-suite seams pi uses.
 *
 * MTLK-ALL-WORKFLOWS US-002 adds the scoped host merge seam: a round may carry
 * a host-attested `merge` context which the production runner converts with
 * `createMergeServiceForContext` and forwards into `runDshInvocation` (→
 * `createHostBroker`), and a merge-capability work round with no context is
 * refused BEFORE any VM create — mirroring the pi/hermes runners.
 *
 * Guest-path constants for the probe gate mirror the pack layout mounted RO
 * at /workspace/runtime: the guest CLI lives at /workspace/runtime/bin/
 * tamandua and the launch probe's expected `skill-path` answer is the
 * readable guest skill file /workspace/runtime/skills/tamandua-agents/SKILL.md
 * (NEVER a host path).
 *
 * Usage attribution after a dsh round goes through the US-001 confined
 * bounded metadata read over the mounted (admitted) DSH_HOME with explicit
 * pre/post inventories — helpers live at the bottom of this module so the
 * scheduler wires them without importing the store internals.
 */

import { randomUUID } from "node:crypto";
import type { HarnessRoundResult } from "../harness-adapter.js";
import { HARNESS_PROBE_MARKER } from "../harness-probe.js";
import {
  runDshInvocation,
  MatchlockRunnerError,
  type MatchlockInvocationKind,
} from "./dsh-invocation-runner.js";
import {
  ensureGuestPackForState,
  buildMatchlockSuiteForRound,
  matchlockRoundScopeRefusal,
  MATCHLOCK_HOST_SUITE_STORE_REL,
  MATCHLOCK_GUEST_PLATFORM,
} from "./scheduler-matchlock.js";
import {
  snapshotDshSessions,
  resolveDshAttribution,
} from "./dsh-attribution.js";
import type {
  DshArtifactLimits,
  DshAttributionResult,
  DshSessionInventory,
} from "./dsh-adapter-contract.js";
import type { ExecutionIsolation } from "./policy.js";
import type { GuestSuiteNamespace } from "./guest-suite-contract.js";
import { matchlockWorkflowRequiresCapability } from "./capabilities.js";
import type { HostMergeContext } from "./host-merge-services.js";
import { createMergeServiceForContext } from "./merge-invocation-wiring.js";

// ── guest-path constants (probe gate + guest work prompt) ────────────────

/**
 * Guest root of the RO helper pack mount. Must equal the pi seam's constant
 * (both backends share /workspace/runtime); pinned here and asserted in tests.
 */
export const DSH_MATCHLOCK_GUEST_RUNTIME_ROOT = "/workspace/runtime";
/**
 * Absolute guest CLI inside the RO helper pack. dsh work prompts instruct the
 * guest dsh agent to report through THIS CLI, never the host launcher.
 */
export const DSH_MATCHLOCK_GUEST_CLI = `${DSH_MATCHLOCK_GUEST_RUNTIME_ROOT}/bin/tamandua`;
/**
 * The readable guest skill file the in-VM launch probe must produce.
 */
export const DSH_MATCHLOCK_GUEST_SKILL_FILE = `${DSH_MATCHLOCK_GUEST_RUNTIME_ROOT}/skills/tamandua-agents/SKILL.md`;

/** The exact probe command a dsh Matchlock launch probe asks the guest to run. */
export function buildDshProbeCommand(): string {
  return `${DSH_MATCHLOCK_GUEST_CLI} skill-path`;
}

/**
 * Build the probe prompt for an opted-in dsh run. Line 1 is the SAME stable
 * harness-probe marker as native/pi; line 2 instructs the guest dsh to run
 * the exact packed guest CLI command and reply with the PATH and nothing
 * else. NEVER embeds the host `resolveTamanduaCli()` launcher.
 */
export function buildDshProbePrompt(): string {
  return `${HARNESS_PROBE_MARKER}\nRun the exact command "${buildDshProbeCommand()}" and reply with the PATH and nothing else.`;
}

// ── round runner seam ─────────────────────────────────────────────────────

export interface DshSchedulerIdentity {
  /** Run id (bare uuid or `run-` prefixed; normalized inside the runner). */
  runId: string;
  /** Full scoped agent id, e.g. `do-now_doer`. */
  agentId: string;
  /** Workflow id (capability admission axis). */
  workflowId: string;
  /** Scheduler dispatch job id (stable across rounds). */
  jobId: string;
}

/** One opted-in dsh invocation the scheduler wants executed in a FRESH VM. */
export interface DshSchedulerRound {
  /** Persisted version-2 ExecutionIsolation policy (harness "dsh"). */
  policy: ExecutionIsolation;
  identity: DshSchedulerIdentity;
  kind: MatchlockInvocationKind;
  /** Work/probe prompt text (guest-aware when built by the scheduler). */
  promptText: string;
  /** Absolute launch cwd (same spelling host/guest). */
  workingDirectoryForHarness: string;
  /** Positive wall-clock budget (ms) for the harness exec. */
  timeoutMs: number;
  /** Round cancellation signal (scheduler round abort). */
  signal?: AbortSignal;
  /** Explicit helper-pack host path (default: ensureGuestPackForState()). */
  helperPackHostPath?: string;
  /** Explicit host suite wiring (default absent: suite-absent invocation). */
  suite?: MatchlockInvocationSuite;
  /**
   * MTLK-ALL-WORKFLOWS US-002: host-attested merge context for an opted-in
   * merge workflow's work round, built by the scheduler from immutable run
   * scope (persisted policy original root + the run's original branch + the
   * run's finalize_merge step id). When absent, the production runner refuses
   * a workflow that requires the `merge-branch` capability BEFORE any VM
   * create; when supplied, it is converted with `createMergeServiceForContext`
   * and forwarded into `runDshInvocation` → `runMatchlockInvocation` →
   * `createHostBroker` exactly like the pi/hermes paths.
   */
  merge?: HostMergeContext;
  /**
   * Env for the Matchlock CONTROL child (the `matchlock rpc` process). The
   * shared scheduler seam replaces HOME with the verified short-HOME alias
   * (item 1a) before this round is built; every other key is preserved and
   * nothing here reaches the daemon/harness/guest env.
   */
  rpcEnv?: Record<string, string>;
}

/** Result of one dsh scheduler round through the runner seam. */
export type DshSchedulerRoundResult = HarnessRoundResult & {
  canceled?: boolean;
};

/**
 * The runner seam function signature. Production default = the real dsh
 * invocation runner; scheduler tests install a deterministic fake via
 * `setDshSchedulerRoundRunnerForTest` so no real VM is ever created.
 */
export type DshSchedulerRoundRunner = (
  round: DshSchedulerRound,
) => Promise<DshSchedulerRoundResult>;

let testRoundRunner: DshSchedulerRoundRunner | null = null;

/**
 * NARROW injectable seam for scheduler tests (mirrors
 * setMatchlockSchedulerRoundRunnerForTest). Pass `null` to restore the
 * production runner. NEVER used outside tests.
 */
export function setDshSchedulerRoundRunnerForTest(
  runner: DshSchedulerRoundRunner | null,
): void {
  testRoundRunner = runner;
}

/** Resolve the runner that executes one opted-in dsh scheduler round. */
function currentRoundRunner(): DshSchedulerRoundRunner {
  return testRoundRunner ?? runProductionDshRound;
}

/**
 * Run ONE opted-in dsh scheduler round (probe or work) through the runner
 * seam. Throws typed MatchlockRunnerError on infrastructure failures (the
 * scheduler force-fails the run on those); returns a HarnessRoundResult for
 * normal guest outcomes.
 */
export function runDshSchedulerRound(
  round: DshSchedulerRound,
): Promise<DshSchedulerRoundResult> {
  return currentRoundRunner()(round);
}

// ── guest helper pack (host path for the RO /workspace/runtime mount) ────

/** Host suite wiring type (mirror the pi seam's invocation suite). */
export interface MatchlockInvocationSuite {
  /** Explicit host-owned Matchlock suite SQLite store path. */
  storePath: string;
  /** Host-admitted canonical environment namespace. */
  namespace: GuestSuiteNamespace;
  /** Canonical realpaths of admitted origin/work repository roots. */
  admittedRoots: readonly string[];
}

/**
 * Build the DEFAULT host suite wiring for one opted-in dsh WORK round. dsh
 * work rounds are suite-capable by default exactly like pi: host-owned suite
 * store at `<state>/matchlock/suite/host-suite.db`, canonical namespace from
 * the persisted pin + pack helper-contract identity, admitted roots from the
 * policy. Probe invocations stay suite-absent.
 */
export async function buildDshSuiteForRound(
  policy: ExecutionIsolation,
  opts?: { stateRoot?: string; helperPackHostPath?: string },
): Promise<MatchlockInvocationSuite> {
  return buildMatchlockSuiteForRound(policy, opts);
}

/**
 * Production default dsh round runner: one FRESH invocation in a FRESH VM
 * through the dsh invocation runner (which reuses the shared registry/
 * broker/helper-pack/progress/suite lifecycle of pi). Work rounds are
 * suite-capable by default; probe rounds stay suite-absent.
 *
 * MTLK-ALL-WORKFLOWS US-002: mirrors the pi preflight from
 * `runProductionMatchlockRound` — refuse BEFORE any VM create when the round
 * is outside the persisted exact worktree scope, or when a work round's
 * workflow requires the `merge-branch` capability but no host merge context
 * was supplied. A supplied merge context is converted with
 * `createMergeServiceForContext` and forwarded to the runner/broker.
 */
async function runProductionDshRound(
  round: DshSchedulerRound,
): Promise<DshSchedulerRoundResult> {
  // MTLK-ALL-WORKFLOWS US-002: exact-path worktree/cwd invariant — never run
  // the dsh harness outside the persisted policy's admitted working directory,
  // and never with a work mount whose guest path is relocated from the host
  // path. Refuse BEFORE any VM create (typed infra failure the scheduler
  // force-fails).
  const scopeRefusal = matchlockRoundScopeRefusal(round.policy, round.workingDirectoryForHarness);
  if (scopeRefusal) {
    throw new MatchlockRunnerError("matchlock_worktree_scope_mismatch", scopeRefusal);
  }
  // MTLK-ALL-WORKFLOWS US-002: a workflow whose later roles require the scoped
  // merge op must have a host-attested merge context. Without it the broker
  // would refuse merge.authorize UNSUPPORTED mid-run, so refuse BEFORE any VM
  // create.
  if (
    matchlockWorkflowRequiresCapability(round.identity.workflowId, "merge-branch") &&
    round.kind === "work" &&
    !round.merge
  ) {
    throw new MatchlockRunnerError(
      "matchlock_workflow_unsupported",
      `workflow "${round.identity.workflowId}" requires the merge-branch capability, but no host merge context ` +
        `(original repository root + original branch + finalize_merge step) could be built for run ${round.identity.runId}; ` +
        `refusing before any VM create.`,
    );
  }
  const invocationId = randomUUID();
  const helperPackHostPath =
    round.helperPackHostPath ?? (await ensureGuestPackForState());
  const suite =
    round.suite ??
    (round.kind === "work"
      ? await buildDshSuiteForRound(round.policy, { helperPackHostPath })
      : undefined);
  return runDshInvocation({
    policy: round.policy,
    identity: {
      runId: round.identity.runId,
      agentId: round.identity.agentId,
      workflowId: round.identity.workflowId,
      jobId: round.identity.jobId,
      invocationId,
    },
    kind: round.kind,
    promptText: round.promptText,
    workingDirectoryForHarness: round.workingDirectoryForHarness,
    timeoutMs: round.timeoutMs,
    signal: round.signal,
    progressResource: { runId: round.identity.runId },
    ...(suite ? { suite } : {}),
    // MTLK-ALL-WORKFLOWS US-002: the host merge service is constructed OUTSIDE
    // the invocation runner (merge-invocation-wiring.ts owns the only
    // child_process import) and forwarded verbatim; it reaches
    // createHostBroker through runDshInvocation's opts spread.
    ...(round.merge ? { merge: createMergeServiceForContext(round.merge) } : {}),
    helperPackHostPath,
    // Item 1a: the matchlock CONTROL child runs with the verified short-HOME
    // alias; DSH_HOME (guest) and the harness keep the real config env.
    ...(round.rpcEnv ? { rpcEnv: round.rpcEnv } : {}),
    // Bounded production stage budgets for cold real-VM invocation (same
    // bounds as the pi seam).
    createTimeoutMs: 240_000,
    readyTimeoutMs: 30_000,
    handshakeTimeoutMs: 90_000,
    serviceTimeoutMs: 180_000,
    closeTimeoutSeconds: 60,
  });
}

// ── dsh store attribution wiring (US-001 confined bounded read) ─────────

/**
 * Host-side PRE/POST session inventory of the mounted (admitted) DSH_HOME
 * under the exact workdir, using the US-001 confined bounded metadata read.
 * The store root is `policy.configurationRoot` — the frozen effective host
 * DSH_HOME persisted at submission — so the scheduler never re-discovers a
 * store from daemon HOME/env. Reads refuse symlinked leaf/ancestor
 * components, outside-store paths and non-regular leaves BEFORE any open, and
 * enforce explicit byte/frame limits; a guest-mutated/unreadable store
 * therefore surfaces as an honest `refused`/`unavailable` outcome, never a
 * trusted partial or a fabricated zero.
 */
export function snapshotDshRoundStore(
  policy: ExecutionIsolation,
  workdir: string,
  limits?: Partial<DshArtifactLimits>,
): DshSessionInventory {
  return snapshotDshSessions({
    dshHome: policy.configurationRoot,
    workdir,
    ...(limits ? { limits } : {}),
  });
}

/**
 * Attribute a dsh round from its pre/post store inventories. The result is
 * metadata-only (no prompts/assistant bodies/secrets): integer single-count
 * totals from clean decodes (the data.stream usage mirror is excluded by the
 * US-001 reader), and `ambiguous`/`unavailable`/`incomplete` reported
 * honestly — never a fabricated zero and never a borrowed session.
 */
export function attributeDshRoundStore(
  policy: ExecutionIsolation,
  workdir: string,
  pre: DshSessionInventory,
  post: DshSessionInventory,
  limits?: Partial<DshArtifactLimits>,
  excludeSessionNames?: ReadonlySet<string>,
): DshAttributionResult {
  return resolveDshAttribution({
    dshHome: policy.configurationRoot,
    workdir,
    pre,
    post,
    ...(excludeSessionNames ? { excludeSessionNames } : {}),
    ...(limits ? { limits } : {}),
  });
}

// Re-export the typed infra error so the scheduler can force-fail typed
// infrastructure failures distinctly from normal failed guest rounds.
export { MatchlockRunnerError };
// Re-export host suite store rel + platform for parity/documentation tests.
export { MATCHLOCK_HOST_SUITE_STORE_REL, MATCHLOCK_GUEST_PLATFORM };
