/**
 * scheduler-matchlock.ts — MTLK-PI-EXEC US-002 scheduler integration seam.
 *
 * This module is the NARROW seam the deterministic dispatch motor uses to run
 * ONE opted-in pi invocation (launch probe OR work round) through the
 * Matchlock invocation runner (US-001) instead of the native harness
 * adapters. It exists so:
 *
 *   - the scheduler never calls `getHarnessAdapter(...).findBinary` /
 *     `runRound`, never spawns a host pi/hermes/dsh and never computes a
 *     probe expected value with a host `<launcher> skill-path` child for an
 *     opted-in run;
 *   - scheduler tests run deterministically WITHOUT real VMs by installing a
 *     fake round runner (mirroring the TAMANDUA_PI_BINARY /
 *     TAMANDUA_HARNESS_PROBE conventions): `setMatchlockSchedulerRoundRunnerForTest`;
 *   - the production default is the REAL runner: a fresh per-invocation VM via
 *     `runMatchlockInvocation` with the persisted image pin, the versioned RO
 *     guest helper pack (built once per state dir, then reused), and the run's
 *     host progress resource (`/workspace/runs/<runId>/progress.txt`).
 *
 * Guest-path constants for the probe gate mirror the pack layout mounted RO
 * at `/workspace/runtime` (mount-plan MATCHLOCK_GUEST_RUNTIME_ROOT): the guest
 * CLI lives at `/workspace/runtime/bin/tamandua` and the launch probe's
 * expected `skill-path` answer is the readable guest skill file
 * `/workspace/runtime/skills/tamandua-agents/SKILL.md`.
 *
 * No native fallback and no real-VM work happens in this module's unit path:
 * the production runner is exercised by the isolated synthetic whole-path gate
 * (US-003), while the scheduler tests in this milestone use the injectable
 * seam (clearly labelled as a test seam).
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessRoundResult } from "../harness-adapter.js";
import { resolvePiStateDir } from "../paths.js";
import { HARNESS_PROBE_MARKER } from "../harness-probe.js";
import type { ExecutionIsolation } from "./policy.js";
import {
  runMatchlockInvocation,
  admittedRootsFromPolicy,
  MatchlockRunnerError,
  type MatchlockInvocationKind,
  type MatchlockInvocationSuite,
} from "./pi-invocation-runner.js";
import {
  runHermesInvocation,
  type HermesInvocationResult,
} from "./hermes-invocation-runner.js";
import {
  runDshSchedulerRound,
  type DshSchedulerRound,
} from "./scheduler-dsh.js";
import type { FrozenHermesSubmissionInput } from "./hermes-profile.js";
import { buildGuestPack } from "./guest-pack-builder.js";
import type { GuestSuiteNamespace } from "./guest-suite-contract.js";
import { matchlockWorkflowRequiresCapability } from "./capabilities.js";
import type { HostMergeContext } from "./host-merge-services.js";
import { createMergeServiceForContext } from "./merge-invocation-wiring.js";
import {
  resolveMatchlockHomeAlias,
  MatchlockHomeAliasError,
} from "./home-alias.js";

// ── guest-path constants (probe gate + guest work prompt) ────────────────

/**
 * Guest root of the RO helper pack mount (must equal mount-plan's
 * MATCHLOCK_GUEST_RUNTIME_ROOT = /workspace/runtime; pinned here so this
 * module stays a leaf and the probe/gate tests assert the equality).
 */
export const MATCHLOCK_GUEST_RUNTIME_ROOT = "/workspace/runtime";

/**
 * Guest bin root (must equal pi-invocation-runner GUEST_RUNTIME_BIN =
 * /workspace/runtime/bin; pinned here so this module NEVER dereferences a
 * pi-invocation-runner export at module top level — dereferencing a
 * cross-module const during cyclic ESM init would TDZ-crash whichever module
 * is loaded first). The pi contract exports this as MATCHLOCK_GUEST_BIN and
 * the dsh contract as MATCHLOCK_GUEST_BIN_DIR; keep BOTH spellings pointing
 * at the same host-attested pack layout so neither side's tests/imports drop.
 */
export const MATCHLOCK_GUEST_BIN = `${MATCHLOCK_GUEST_RUNTIME_ROOT}/bin`;
export const MATCHLOCK_GUEST_BIN_DIR = MATCHLOCK_GUEST_BIN;

/**
 * Absolute guest CLI inside the RO helper pack. Every Matchlock work prompt
 * instructs the agent to report through THIS CLI (`/workspace/runtime/bin/
 * tamandua`), never the host `resolveTamanduaCli()` launcher.
 */
export const MATCHLOCK_GUEST_CLI = `${MATCHLOCK_GUEST_BIN}/tamandua`;

/**
 * The readable guest skill file the in-VM launch probe must produce:
 * `/workspace/runtime/skills/tamandua-agents/SKILL.md`. The guest CLI's
 * `skill-path` prints exactly this path (pack root joined with
 * skills/tamandua-agents/SKILL.md).
 */
export const MATCHLOCK_GUEST_SKILL_FILE = `${MATCHLOCK_GUEST_RUNTIME_ROOT}/skills/tamandua-agents/SKILL.md`;

/** The exact probe command a Matchlock launch probe asks the guest to run. */
export function buildMatchlockProbeCommand(): string {
  return `${MATCHLOCK_GUEST_CLI} skill-path`;
}

/**
 * Build the probe prompt for an opted-in run. Line 1 is the SAME stable
 * harness-probe marker as native; line 2 instructs the guest pi harness to
 * run the exact packed guest CLI command and reply with the PATH and nothing
 * else. NEVER embeds the host `resolveTamanduaCli()` launcher.
 */
export function buildMatchlockProbePrompt(): string {
  return `${HARNESS_PROBE_MARKER}\nRun the exact command "${buildMatchlockProbeCommand()}" and reply with the PATH and nothing else.`;
}

// ── round runner seam ─────────────────────────────────────────────────────

export interface MatchlockSchedulerIdentity {
  /** Run id (bare uuid or `run-` prefixed; normalized inside the runner). */
  runId: string;
  /** Full scoped agent id, e.g. `do-now_doer`. */
  agentId: string;
  /** Workflow id (capability admission axis). */
  workflowId: string;
  /** Scheduler dispatch job id (stable across rounds). */
  jobId: string;
}

/** One opted-in invocation the scheduler wants executed in a FRESH VM. */
export interface MatchlockSchedulerRound {
  /** Persisted version-2 ExecutionIsolation policy (carries the image pin). */
  policy: ExecutionIsolation;
  identity: MatchlockSchedulerIdentity;
  kind: MatchlockInvocationKind;
  /** Work/probe prompt text (guest-aware when built by the scheduler). */
  promptText: string;
  /** Absolute launch cwd (same spelling host/guest). */
  workingDirectoryForHarness: string;
  /** Positive wall-clock budget (ms) for the harness exec. */
  timeoutMs: number;
  /** Round cancellation signal (scheduler round abort). */
  signal?: AbortSignal;
  /** Guest harness argv (production default pi --print --mode json; test/synthetic override). */
  harnessArgv?: string[];
  /** The image's effective guest PATH base for the helper-pack prepend. */
  imagePath?: string;
  /** Extra guest env (test/synthetic seams). */
  guestEnvOverrides?: Record<string, string>;
  /** Explicit helper-pack host path (default: ensureGuestPackForState()). */
  helperPackHostPath?: string;
  /** Explicit host suite wiring (default absent: suite-absent invocation). */
  suite?: MatchlockInvocationSuite;
  /**
   * Extra env keys for the Matchlock CONTROL child (the `matchlock rpc`
   * process and whatever it forks). The scheduler REPLACES HOME with the
   * verified short alias (home-alias.ts) before dispatch, so a caller-supplied
   * value here can never keep a long/untrusted HOME. Every other key is
   * preserved. Never forwarded to the daemon, the harness round or the guest
   * create-config env (those keep the real HOME).
   */
  rpcEnv?: Record<string, string>;
  /**
   * US-008: host-attested merge context for an opted-in merge workflow's work
   * round. Built by the scheduler from immutable run scope (persisted policy
   * original root + the run's original branch + the run's finalize_merge step
   * id). When absent, the production runner refuses a workflow that requires
   * the `merge-branch` capability BEFORE any VM create.
   */
  merge?: HostMergeContext;
}

/**
 * Result of one scheduler round through the runner seam: a
 * HarnessRoundResult-compatible object (so the scheduler's existing post-round
 * processing is reused unchanged) plus a `canceled` flag when the host
 * aborted the invocation.
 */
export type MatchlockSchedulerRoundResult = HarnessRoundResult & {
  canceled?: boolean;
};

/**
 * The runner seam function signature. Production default = the real US-001
 * runner; scheduler tests install a deterministic fake via
 * `setMatchlockSchedulerRoundRunnerForTest` so no real VM is ever created.
 */
export type MatchlockSchedulerRoundRunner = (
  round: MatchlockSchedulerRound,
) => Promise<MatchlockSchedulerRoundResult>;

let testRoundRunner: MatchlockSchedulerRoundRunner | null = null;

/**
 * NARROW injectable seam for scheduler tests (mirrors TAMANDUA_PI_BINARY /
 * TAMANDUA_HARNESS_PROBE). This replaces the pi/hermes production round runner
 * (`runProductionMatchlockRound`); a dsh policy is routed to the separate dsh
 * scheduler route, which owns its own
 * `setDshSchedulerRoundRunnerForTest` seam. Pass `null` to restore the
 * production runner. NEVER used outside tests.
 */
export function setMatchlockSchedulerRoundRunnerForTest(
  runner: MatchlockSchedulerRoundRunner | null,
): void {
  testRoundRunner = runner;
}

/**
 * Reconstruct the FROZEN Hermes submission input for a persisted
 * harness:"hermes" policy — the exact homeDir/cwd/HERMES_HOME snapshot
 * captured at run creation. A dispatch-time round resolves its Hermes
 * selection from ONLY this; the daemon HOME/env is never consulted.
 */
export function hermesSubmissionFromPolicy(policy: ExecutionIsolation): FrozenHermesSubmissionInput {
  if (policy.harness !== "hermes" || !policy.hermes) {
    throw new MatchlockRunnerError(
      "matchlock_policy_invalid",
      "A harness \"hermes\" round requires a persisted policy carrying the FROZEN Hermes submission inputs (homeDir/cwd/hermesHomeEnv); refusing to resolve the Hermes selection from ambient state.",
    );
  }
  return {
    homeDir: policy.hermes.homeDir,
    cwd: policy.hermes.cwd,
    env:
      policy.hermes.hermesHomeEnv !== null
        ? { HERMES_HOME: policy.hermes.hermesHomeEnv }
        : {},
  };
}

/**
 * The production invocation runner kind for a persisted policy harness: pi
 * policies dispatch through the pi invocation runner, hermes policies through
 * the Hermes invocation runner (US-002) and dsh policies through the dsh
 * scheduler route (US-003). Exported so deterministic tests can assert the
 * production routing decision without a VM. This is the SINGLE harness-keyed
 * routing axis: no caller needs a hard-coded pi/hermes/dsh branch.
 */
export type MatchlockProductionRunnerKind = "pi" | "hermes" | "dsh";

export function matchlockProductionRunnerKind(
  policy: ExecutionIsolation,
): MatchlockProductionRunnerKind {
  if (policy.harness === "hermes") return "hermes";
  if (policy.harness === "dsh") return "dsh";
  return "pi";
}

/**
 * Per-kind routing-observation seam: substitutes the production route runner
 * for ONE harness kind so a deterministic test can assert that
 * `runMatchlockSchedulerRound` dispatches each policy to exactly its own
 * runner (pi/hermes/dsh) without creating a VM. Cleared in the owning test's
 * `finally`/`afterEach`. NEVER used outside tests.
 */
const productionRouteRunners = new Map<
  MatchlockProductionRunnerKind,
  MatchlockSchedulerRoundRunner
>();

export function setMatchlockProductionRouteRunnerForTest(
  kind: MatchlockProductionRunnerKind,
  runner: MatchlockSchedulerRoundRunner | null,
): void {
  if (runner) productionRouteRunners.set(kind, runner);
  else productionRouteRunners.delete(kind);
}

/**
 * Project the shared scheduler round onto the dsh scheduler-route shape. The
 * dsh route keeps its own (harness-specific) round type, and the two shapes are
 * structurally compatible for the fields dsh owns; the pi/hermes-only seams
 * (`harnessArgv`, `imagePath`, `guestEnvOverrides`) are intentionally not
 * forwarded (dsh resolves its image PATH from the persisted policy). The
 * host-attested `merge` context IS forwarded (MTLK-ALL-WORKFLOWS US-002) so a
 * dsh merge workflow lands through the scoped host merge service exactly like
 * pi/hermes; the dsh production runner refuses a merge-capability work round
 * with no context before any VM.
 */
function toDshSchedulerRound(round: MatchlockSchedulerRound): DshSchedulerRound {
  return {
    policy: round.policy,
    identity: round.identity,
    kind: round.kind,
    promptText: round.promptText,
    workingDirectoryForHarness: round.workingDirectoryForHarness,
    timeoutMs: round.timeoutMs,
    ...(round.signal ? { signal: round.signal } : {}),
    ...(round.helperPackHostPath ? { helperPackHostPath: round.helperPackHostPath } : {}),
    ...(round.suite ? { suite: round.suite } : {}),
    ...(round.merge ? { merge: round.merge } : {}),
    ...(round.rpcEnv ? { rpcEnv: round.rpcEnv } : {}),
  };
}

/**
 * Resolver seam for the verified short-HOME alias. Production uses
 * {@link resolveMatchlockHomeAlias} (home-alias.ts); deterministic scheduler
 * tests install a fixed resolver so they never depend on the host HOME or
 * touch `/tmp`. NEVER used outside tests.
 */
export type MatchlockHomeAliasResolver = () => string;

let testHomeAliasResolver: MatchlockHomeAliasResolver | null = null;

export function setMatchlockHomeAliasResolverForTest(
  resolver: MatchlockHomeAliasResolver | null,
): void {
  testHomeAliasResolver = resolver;
}

/**
 * Build the env for the Matchlock CONTROL child of ONE scheduler round: the
 * caller's extra RPC env plus the VERIFIED short-HOME alias as HOME. Called
 * once per round; the alias is re-verified on every call (see home-alias.ts).
 *
 * Fail-closed: an untrustworthy alias surfaces as a typed
 * {@link MatchlockRunnerError} (code `matchlock_home_alias_untrusted`) BEFORE
 * any route/VM is entered, so the scheduler force-fails the run instead of
 * silently keeping a long HOME that Firecracker refuses mid-boot.
 */
export function buildMatchlockRoundRpcEnv(
  baseRpcEnv?: Record<string, string>,
): Record<string, string> {
  const resolveAlias = testHomeAliasResolver ?? resolveMatchlockHomeAlias;
  let aliasHome: string;
  try {
    aliasHome = resolveAlias();
  } catch (err) {
    if (err instanceof MatchlockHomeAliasError) {
      throw new MatchlockRunnerError(
        err.code,
        `Matchlock short-HOME alias unavailable (${err.reason}): ${err.message}`,
      );
    }
    throw err;
  }
  return { ...(baseRpcEnv ?? {}), HOME: aliasHome };
}

/**
 * Run ONE opted-in scheduler round (probe or work) through the SINGLE
 * harness-keyed production runner seam. Dispatch is decided ONLY by
 * `matchlockProductionRunnerKind(policy)`:
 *   - "pi" and "hermes" run through the Matchlock production round runner
 *     (which itself routes pi vs the Hermes invocation runner); the narrow
 *     `setMatchlockSchedulerRoundRunnerForTest` replacement seam keeps
 *     deterministic scheduler tests VM-free;
 *   - "dsh" runs through the dsh scheduler route (which owns its own
 *     `setDshSchedulerRoundRunnerForTest` seam and the DSH_HOME/headless
 *     profile behavior).
 *
 * Every round first resolves the verified short-HOME alias and threads it as
 * `rpcEnv.HOME` into the Matchlock control child (item 1a). The daemon, the
 * harness process and the guest create-config env keep the REAL HOME.
 *
 * Throws typed MatchlockRunnerError on infrastructure failures (the scheduler
 * force-fails the run on those); returns a HarnessRoundResult for normal guest
 * outcomes.
 */
export function runMatchlockSchedulerRound(
  round: MatchlockSchedulerRound,
): Promise<MatchlockSchedulerRoundResult> {
  const kind = matchlockProductionRunnerKind(round.policy);
  const rpcEnv = buildMatchlockRoundRpcEnv(round.rpcEnv);
  const roundWithAliasHome: MatchlockSchedulerRound = { ...round, rpcEnv };
  const routeOverride = productionRouteRunners.get(kind);
  if (routeOverride) {
    return routeOverride(roundWithAliasHome);
  }
  if (kind === "dsh") {
    return runDshSchedulerRound(toDshSchedulerRound(roundWithAliasHome));
  }
  return (testRoundRunner ?? runProductionMatchlockRound)(roundWithAliasHome);
}

// ── guest helper pack (host path for the RO /workspace/runtime mount) ────

/** Per-process memo so one state dir builds its versioned pack at most once. */
const packBuilds = new Map<string, Promise<string>>();

/**
 * Resolve the host path of the versioned RO guest helper pack for this state
 * dir, building it once from the compiled checkout `dist` when absent.
 *
 * The pack is deterministic for a given build (`<state>/matchlock/
 * guest-packs/<buildVersion>`): every probe/work invocation of every run in
 * that state dir mounts the SAME read-only pack (RO `host_fs` at
 * /workspace/runtime), so the guest bridge/CLI build identity is stable.
 * A partially written pack is never observed: the build goes to a fresh
 * sibling directory and is atomically renamed into place; a concurrent
 * winner's pack is reused (never deleted).
 */
export async function ensureGuestPackForState(opts?: {
  stateRoot?: string;
  distRoot?: string;
  buildVersion?: string;
}): Promise<string> {
  const distRoot = opts?.distRoot ?? defaultDistRoot();
  const stateRoot = opts?.stateRoot ?? resolvePiStateDir();
  const buildVersion = opts?.buildVersion ?? readDistVersion(distRoot);
  const targetDir = path.join(stateRoot, "matchlock", "guest-packs", buildVersion);

  if (fs.existsSync(path.join(targetDir, "manifest.json"))) {
    return targetDir;
  }

  const existing = packBuilds.get(targetDir);
  if (existing) return existing;

  const build = (async (): Promise<string> => {
    const parent = path.dirname(targetDir);
    fs.mkdirSync(parent, { recursive: true });
    const staging = path.join(
      parent,
      `.guest-pack.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      buildGuestPack({ targetDir: staging, distRoot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to build the versioned Matchlock guest helper pack for state dir ${stateRoot}: ${message} ` +
          "Run npm run build in the tamandua checkout first.",
      );
    }
    try {
      fs.renameSync(staging, targetDir);
    } catch {
      // A concurrent process won the race: reuse its pack (never delete).
      if (!fs.existsSync(path.join(targetDir, "manifest.json"))) {
        throw new Error(
          `Failed to publish the Matchlock guest helper pack at ${targetDir}: ` +
            "the destination appeared without a valid manifest.json.",
        );
      }
    }
    return targetDir;
  })();

  packBuilds.set(targetDir, build);
  void build.then(
    () => packBuilds.delete(targetDir),
    () => packBuilds.delete(targetDir),
  );
  return build;
}

/** <dist>/installer/matchlock → <dist> (mirrors guest-pack-builder default). */
function defaultDistRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readDistVersion(distRoot: string): string {
  try {
    const content = fs.readFileSync(path.join(distRoot, "version"), "utf-8").trim();
    return content || "unknown";
  } catch {
    return "unknown";
  }
}

// ── production runner (real VM; exercised by the synthetic gate, US-003) ─

/** Host platform label for the attested suite namespace (this build is linux/amd64-validated). */
export const MATCHLOCK_GUEST_PLATFORM = "linux/amd64";

/** Relative store path (under the state root) of the host-owned Matchlock suite DB. */
export const MATCHLOCK_HOST_SUITE_STORE_REL = path.join("matchlock", "suite", "host-suite.db");

/** Deterministic sha256-based nonsecret compatibility fingerprint. */
function suiteFingerprint(policy: ExecutionIsolation, helperContract: string): string {
  return createHash("sha256")
    .update(`${policy.resolvedImageConfigDigest ?? policy.resolvedImageDigest ?? ""}|${helperContract}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Build the DEFAULT host suite wiring for one opted-in WORK round.
 *
 * This is the US-003 production wiring that makes a scheduler-dispatched work
 * invocation suite-capable (functional requirement 6): the host-owned
 * Matchlock evidence store lives at a DETERMINISTIC path under the same state
 * root the versioned RO guest pack is built into
 * (`<state>/matchlock/suite/host-suite.db`), the admitted environment
 * namespace is derived from the persisted immutable image pin + the pack's
 * own helper-contract identity (never guest data), and the admitted roots are
 * the policy's canonical work/original-repository roots. Probe invocations
 * are intentionally suite-absent (they hold no step lease and never run
 * tamandua-test).
 */
export async function buildMatchlockSuiteForRound(
  policy: ExecutionIsolation,
  opts?: { stateRoot?: string; helperPackHostPath?: string },
): Promise<MatchlockInvocationSuite> {
  const stateRoot = opts?.stateRoot ?? resolvePiStateDir();
  const helperPackHostPath =
    opts?.helperPackHostPath ?? (await ensureGuestPackForState({ stateRoot }));
  let helperContract = "";
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(helperPackHostPath, "manifest.json"), "utf-8"),
    ) as { helperProtocolVersion?: unknown; tamanduaBuildVersion?: unknown };
    helperContract =
      typeof manifest.helperProtocolVersion === "string" && manifest.helperProtocolVersion.trim() !== ""
        ? manifest.helperProtocolVersion
        : typeof manifest.tamanduaBuildVersion === "string"
          ? manifest.tamanduaBuildVersion
          : "unknown";
  } catch {
    helperContract = "unknown";
  }
  if (!policy.resolvedImageDigest || !policy.resolvedImageConfigDigest) {
    throw new Error(
      `Cannot build the Matchlock host suite wiring: the persisted policy for image ${JSON.stringify(
        policy.requestedImage,
      )} carries no immutable image content/config pin (legacy/unpinned record).`,
    );
  }
  const namespace: GuestSuiteNamespace = {
    imageContentId: policy.resolvedImageDigest,
    guestPlatform: MATCHLOCK_GUEST_PLATFORM,
    helperContract: `guest-helper-${helperContract}`,
    compatibilityFingerprint: suiteFingerprint(policy, helperContract),
  };
  const storePath = path.join(stateRoot, MATCHLOCK_HOST_SUITE_STORE_REL);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  return {
    storePath,
    namespace,
    admittedRoots: admittedRootsFromPolicy(policy),
  };
}

/**
 * US-008: build the host merge context for ONE opted-in merge workflow round
 * from immutable run scope:
 *   - `originalRepositoryRoot` comes ONLY from the persisted policy (never
 *     re-derived from guest/context data);
 *   - `originalBranch` comes from the run's captured context
 *     (`original_branch`), the value the setup/finalize steps use;
 *   - `finalizeMergeStepId` is the run's own finalize_merge step row id;
 *   - the admitted roots + image digest are the policy's canonical values.
 *
 * Returns `undefined` when the run does not carry the origin/branch authority
 * a merge requires — the production runner then refuses a merge-capability
 * workflow BEFORE any VM create rather than admitting a workflow it cannot
 * actually serve.
 */
export function buildMatchlockMergeContext(params: {
  policy: ExecutionIsolation;
  runId: string;
  runContext: Record<string, string>;
  finalizeMergeStepId?: string;
}): HostMergeContext | undefined {
  const originalRepositoryRoot = params.policy.originalRepositoryRoot;
  const originalBranch = (params.runContext.original_branch ?? "").trim();
  const finalizeMergeStepId = params.finalizeMergeStepId?.trim();
  if (!originalRepositoryRoot || !originalBranch || !finalizeMergeStepId) return undefined;
  const bare = params.runId.startsWith("run-") ? params.runId.slice(4) : params.runId;
  return {
    runId: bare,
    originalRepositoryRoot,
    originalBranch,
    finalizeMergeStepId,
    admittedRoots: admittedRootsFromPolicy(params.policy),
    ...(params.policy.resolvedImageDigest
      ? { imageDigest: params.policy.resolvedImageDigest }
      : {}),
  };
}

/**
 * US-008: the exact-path worktree/cwd invariant for one opted-in round. The
 * harness must run in the persisted policy's working directory, and that
 * directory must be mounted RW at its identical absolute host/guest path
 * (a work mount, or the admitted original repository root). Returns a refusal
 * message, or null when exact.
 */
export function matchlockRoundScopeRefusal(
  policy: ExecutionIsolation,
  workingDirectoryForHarness: string,
): string | null {
  const cwd = path.resolve(workingDirectoryForHarness);
  const policyWd = path.resolve(policy.workingDirectory);
  if (cwd !== policyWd) {
    return (
      `harness working directory ${workingDirectoryForHarness} does not match the persisted Matchlock ` +
      `policy working directory ${policy.workingDirectory}; refusing to run the harness outside the admitted exact path.`
    );
  }
  const exactWorkMount = policy.workMounts.some(
    (m) => m.hostPath === policy.workingDirectory && m.guestPath === policy.workingDirectory,
  );
  const exactOriginal =
    policy.originalRepositoryRoot !== null &&
    path.resolve(policy.originalRepositoryRoot) === policyWd;
  if (!exactWorkMount && !exactOriginal) {
    return (
      `persisted Matchlock policy working directory ${policy.workingDirectory} is not mounted at its exact ` +
      `host/guest path (work mounts: ${policy.workMounts.map((m) => m.hostPath).join(", ") || "none"}); ` +
      `refusing a relocated/symlink-only working directory.`
    );
  }
  for (const m of policy.workMounts) {
    if (m.hostPath !== m.guestPath) {
      return `work mount host ${m.hostPath} differs from guest ${m.guestPath}; exact-path mounts are required.`;
    }
  }
  return null;
}

/**
 * Production default round runner: one FRESH invocation in a FRESH VM through
 * the US-001 pi invocation runner (harness:"pi" policies) or the US-002
 * Hermes invocation runner (harness:"hermes" policies) with the persisted
 * image pin, the versioned RO guest pack, and the run's host progress
 * resource. Work rounds are SUITE-CAPABLE by default (the US-003 wiring
 * above): the packed guest `tamandua-test` therefore records real integer-exit
 * evidence rows in the host-owned Matchlock suite store under the canonical
 * namespace. Probe rounds stay suite-absent (no step lease, no
 * tamandua-test). Host suite wiring supplied explicitly by the caller is
 * honored verbatim.
 */
async function runProductionMatchlockRound(
  round: MatchlockSchedulerRound,
): Promise<MatchlockSchedulerRoundResult> {
  // US-008: exact-path worktree/cwd invariant — never run the harness outside
  // the persisted policy's admitted working directory, and never with a
  // work mount whose guest path is relocated from the host path. Refuse
  // BEFORE any VM create (typed infra failure the scheduler force-fails).
  const scopeRefusal = matchlockRoundScopeRefusal(round.policy, round.workingDirectoryForHarness);
  if (scopeRefusal) {
    throw new MatchlockRunnerError("matchlock_worktree_scope_mismatch", scopeRefusal);
  }
  // US-008: a workflow whose later roles require the scoped merge op must have
  // a host-attested merge context. Without it the broker would refuse
  // merge.authorize UNSUPPORTED mid-run, so refuse BEFORE any VM create.
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
    round.suite ?? (round.kind === "work" ? await buildMatchlockSuiteForRound(round.policy, { helperPackHostPath }) : undefined);

  switch (matchlockProductionRunnerKind(round.policy)) {
    case "hermes":
      return runProductionHermesRound(round, invocationId, helperPackHostPath, suite);
    case "dsh":
      // Defensive exhaustiveness: `runMatchlockSchedulerRound` already routes
      // a dsh policy to the dsh scheduler route before this pi/hermes
      // production runner. Keep the harness axis total so a future direct
      // caller can never fall through to a pi invocation for a dsh policy.
      return runDshSchedulerRound(toDshSchedulerRound(round));
    case "pi":
      break;
  }

  return runMatchlockInvocation({
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
    // Real host progress-resource wiring: guest /workspace/runs/<runId> is
    // the ONLY host run-state export (deterministic from the live state root).
    progressResource: { runId: round.identity.runId },
    ...(suite ? { suite } : {}),
    ...(round.merge ? { merge: createMergeServiceForContext(round.merge) } : {}),
    helperPackHostPath,
    // Item 1a: the matchlock CONTROL child runs with the verified short-HOME
    // alias; the guest create-config env and the harness keep the real HOME.
    ...(round.rpcEnv ? { rpcEnv: round.rpcEnv } : {}),
    // Bounded production stage budgets for cold real-VM invocation: a first
    // create/boot may legitimately exceed the generic 60s RPC deadline and a
    // cold guest bridge HELLO can exceed the default handshake window.
    createTimeoutMs: 240_000,
    readyTimeoutMs: 30_000,
    handshakeTimeoutMs: 90_000,
    serviceTimeoutMs: 180_000,
    closeTimeoutSeconds: 60,
    ...(round.harnessArgv ? { harnessArgv: round.harnessArgv } : {}),
    ...(round.imagePath ? { imagePath: round.imagePath } : {}),
    ...(round.guestEnvOverrides ? { guestEnvOverrides: round.guestEnvOverrides } : {}),
  });
}

/**
 * Production hermes round: one FRESH Hermes invocation in a FRESH VM through
 * the US-002 runner with the persisted image pin + FROZEN submission inputs
 * (policy.hermes), the versioned RO guest pack, mapped host progress-resource
 * and (for work rounds) host-suite wiring. Plain-text final message + session
 * id + in-VM token projection are returned in the HermesInvocationResult.
 * MTLK-ALL-WORKFLOWS US-001: a supplied host merge context is converted with
 * createMergeServiceForContext and forwarded into the runner exactly like the
 * pi path, so a hermes merge workflow can land through the scoped host merge
 * service. Absence keeps merge ops UNSUPPORTED (the caller preflight above
 * refuses a merge-capability work round with no context BEFORE any VM).
 */
async function runProductionHermesRound(
  round: MatchlockSchedulerRound,
  invocationId: string,
  helperPackHostPath: string,
  suite: MatchlockInvocationSuite | undefined,
): Promise<HermesInvocationResult> {
  return runHermesInvocation({
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
    ...(round.merge ? { merge: createMergeServiceForContext(round.merge) } : {}),
    helperPackHostPath,
    // Item 1a: the matchlock CONTROL child runs with the verified short-HOME
    // alias; the FROZEN submission/homeDir and the guest harness keep the
    // real HOME.
    ...(round.rpcEnv ? { rpcEnv: round.rpcEnv } : {}),
    // FROZEN submission inputs (homeDir + HERMES_HOME snapshot + cwd
    // captured at run creation) — never daemon HOME/ambient state.
    submission: hermesSubmissionFromPolicy(round.policy),
    // Bounded production stage budgets (mirror the pi runner).
    createTimeoutMs: 240_000,
    readyTimeoutMs: 30_000,
    handshakeTimeoutMs: 90_000,
    serviceTimeoutMs: 180_000,
    closeTimeoutSeconds: 60,
    // NOTE: round.harnessArgv is a pi guest-argv test seam (pi --print --mode
    // json). Hermes launch argv comes from the guarded adapter (buildHermes-
    // GuestLaunch); guest-image hermes naming is a synthetic-gate concern.
    ...(round.imagePath ? { imagePath: round.imagePath } : {}),
    ...(round.guestEnvOverrides ? { guestEnvOverrides: round.guestEnvOverrides } : {}),
  });
}

// Re-export the typed infra error so the scheduler can force-fail typed
// infrastructure failures distinctly from normal failed guest rounds.
export { MatchlockRunnerError };
