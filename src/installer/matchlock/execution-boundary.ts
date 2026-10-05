/**
 * execution-boundary.ts — MTLK-ISO-SLICE2 US-004 daemon execution boundary.
 *
 * Admission (standard-image §4.4 / swap-default §4.4) proves only that the
 * SUBMITTING process resolved a qualified matchlock binary. The daemon
 * executes each round with its OWN resolution, so the same two gates must be
 * re-run by the executing process before it creates a VM:
 *
 *   1. R13 root gate (standard-image §4.4 / §2.5 / §2.6): re-check the
 *      executing process's EFFECTIVE uid. A root daemon (euid 0) with a run
 *      that does NOT record `rootUsageConsent === true` is force-failed with
 *      the typed `matchlock_root_usage_refused` BEFORE any Matchlock
 *      invocation; recorded consent (or an inherited/override consent baked
 *      into the persisted policy) lets it proceed. Only the HOST process
 *      identity is consulted — never a guest workload's uid — and a non-root
 *      submitter does not prove a non-root daemon.
 *
 *   2. Swap capability handshake (swap-default §4.4 / R8): run the SAME
 *      bounded `<resolved matchlock binary> run --help` probe against the
 *      same resolved executable path the round will launch, AFRESH for every
 *      round (no caching: the probe is a cheap local `run --help` and there is
 *      no cache that can go stale). A missing binary keeps the existing
 *      `matchlock_unavailable` classification; an unsupporting or
 *      inconclusive result force-fails typed `matchlock_swap_unsupported`.
 *      The probe runs for EVERY VM-creating round, including runs that disable
 *      swap (0 = off), because it is the operator's proxy that the qualified
 *      runtime build is the one in use.
 *
 * A refusal at either gate happens BEFORE any VM and before any Matchlock
 * invocation. The gate is fully injectable ({@link
 * MatchlockExecutionBoundarySeams}) so tests journal the probe argv / uid and
 * never spawn a real binary or run as root. This module stays import-cycle
 * free: it consumes the leaf swap probe, the leaf runner error and the
 * admission root-refusal text (admission itself never imports this module).
 */

import type { ExecutionIsolation } from "./policy.js";
import { MatchlockRunnerError } from "./runner-error.js";
import {
  MATCHLOCK_SWAP_FLAG,
  probeMatchlockSwapSupport,
  resolveMatchlockSwapBinaryPath,
  type MatchlockSwapSupport,
  type MatchlockSwapSupportProbe,
} from "./swap-support.js";
import { matchlockRootUsageRefusalText } from "./admission.js";

/** The run/job identity a refusal names (guest input is never consulted). */
export interface MatchlockExecutionBoundaryIdentity {
  runId: string;
  agentId: string;
  workflowId: string;
  jobId: string;
}

/**
 * Injectable seams for the daemon execution boundary. Production omits every
 * field: the gate then consults the real `process.geteuid()` and the real
 * US-001 swap probe against the resolved matchlock binary. Tests inject a
 * deterministic uid and/or a journaling supporting/refusing probe so they
 * never spawn a real binary or run as root.
 */
export interface MatchlockExecutionBoundarySeams {
  /**
   * R13: effective-uid seam for the EXECUTING (daemon) process. Production
   * defaults to `process.geteuid()`; a platform without it returns a non-root
   * sentinel so the gate never trips spuriously. Concerns the HOST process
   * identity only.
   */
  effectiveUid?: () => number;
  /**
   * Fresh per-round swap-capability probe seam. Production defaults to
   * {@link probeMatchlockSwapSupport} against {@link
   * MatchlockExecutionBoundarySeams.matchlockBinaryPath}.
   */
  swapSupportProbe?: MatchlockSwapSupportProbe;
  /**
   * Explicit resolved matchlock binary path the round will launch. Production
   * omits it: the gate resolves `TAMANDUA_MATCHLOCK_RPC_BIN` then the first
   * executable `matchlock` on `PATH`, exactly like the swap leaf.
   */
  matchlockBinaryPath?: string;
  /**
   * MTLK-ISO2-CORRECTIVE: the environment of the round's RPC child. The
   * binary is resolved and probed against THIS environment (default
   * `process.env`) so an RPC-specific `PATH` binds probe and child together.
   */
  env?: NodeJS.ProcessEnv;
}

/** Default effective-uid probe: POSIX `geteuid`, non-root sentinel otherwise. */
function defaultEffectiveUid(): number {
  return typeof process.geteuid === "function" ? process.geteuid() : -1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The spec C §2.6 explanation plus the daemon-boundary remedies (recreate or
 * resume with the override, or run the daemon as an unprivileged user). The
 * base text is shared with admission so the two surfaces cannot drift.
 */
export function matchlockRootUsageDaemonRefusalText(): string {
  return (
    `${matchlockRootUsageRefusalText()}\n` +
    "This refusal came from the daemon execution boundary: recreate or resume the run with the override, " +
    "or run the daemon as an unprivileged user. No Matchlock invocation was made and no VM was created."
  );
}

function swapUnsupportedText(
  binaryPath: string,
  runId: string,
  detail: string | undefined,
): string {
  const reason = detail ? ` Reason: ${detail}.` : "";
  return (
    `Refusing Matchlock round for run ${runId}: the matchlock binary at ${binaryPath} does not support ${MATCHLOCK_SWAP_FLAG}.${reason} ` +
    `The qualified runtime is required even when swap is disabled; provision it with \`tamandua matchlock setup\` ` +
    `or upgrade matchlock to a build that lists ${MATCHLOCK_SWAP_FLAG} (verify with \`matchlock run --help\`). ` +
    "No Matchlock invocation was made and no VM was created."
  );
}

function swapMissingText(
  binaryPath: string,
  runId: string,
  detail: string | undefined,
): string {
  const reason = detail ? ` ${detail}` : "";
  return (
    `Matchlock rpc CLI is unavailable at the daemon execution boundary for run ${runId} (resolved binary: ${binaryPath}).${reason} ` +
    "Refusing to start the round without the qualified Matchlock runtime; no Matchlock invocation was made, no VM was created and no native fallback occurred."
  );
}

/**
 * Test-only module-level seam, used where the scheduler constructs the round
 * internally (so a per-round seam cannot be threaded). Per-round seams always
 * win over this. Pass `null` to restore production defaults.
 */
let testSeams: MatchlockExecutionBoundarySeams | null = null;

export function setMatchlockExecutionBoundarySeamsForTest(
  seams: MatchlockExecutionBoundarySeams | null,
): void {
  testSeams = seams;
}

/** Resolve the effective seam set: per-round wins over the module test seam. */
function resolveSeams(seams: MatchlockExecutionBoundarySeams): MatchlockExecutionBoundarySeams {
  if (!testSeams) return seams;
  return {
    ...testSeams,
    ...seams,
  };
}

/**
 * Re-verify the daemon execution boundary for ONE VM-creating round:
 *
 *   1. the EXECUTING process's effective uid (R13 root gate); then
 *   2. a FRESH swap-capability probe against the resolved matchlock binary.
 *
 * Throws a typed {@link MatchlockRunnerError} (`matchlock_root_usage_refused`,
 * `matchlock_swap_unsupported` or `matchlock_unavailable`) BEFORE any Matchlock
 * invocation. Never caches the probe: every call performs a new probe. On
 * success returns the ONE resolved absolute matchlock binary path the round
 * MUST launch through the RPC transport (MTLK-ISO2-CORRECTIVE probe==child
 * binding).
 */
export async function assertMatchlockExecutionBoundary(
  policy: ExecutionIsolation,
  identity: MatchlockExecutionBoundaryIdentity,
  seams: MatchlockExecutionBoundarySeams = {},
): Promise<string> {
  const effective = resolveSeams(seams);
  const effectiveUid = effective.effectiveUid ?? defaultEffectiveUid;
  // R13: only the HOST process identity. Recorded consent (baked into the
  // persisted policy at admission, inherited by resume/replacement) is the
  // ONLY thing that lets a root daemon proceed.
  if (effectiveUid() === 0 && policy.rootUsageConsent !== true) {
    throw new MatchlockRunnerError(
      "matchlock_root_usage_refused",
      matchlockRootUsageDaemonRefusalText(),
    );
  }

  const env = effective.env ?? process.env;
  const binaryPath =
    effective.matchlockBinaryPath?.trim() || resolveMatchlockSwapBinaryPath(env);
  const probe =
    effective.swapSupportProbe ??
    ((binary: string) => probeMatchlockSwapSupport({ binaryPath: binary, env }));

  let support: MatchlockSwapSupport;
  try {
    support = await probe(binaryPath);
  } catch (err) {
    // An inconclusive/thrown probe is fail-closed with the swap vocabulary.
    throw new MatchlockRunnerError(
      "matchlock_swap_unsupported",
      swapUnsupportedText(binaryPath, identity.runId, `probe failed: ${errorMessage(err)}`),
    );
  }

  if (support.supported) return binaryPath;
  if (support.reasonCode === "missing_binary") {
    throw new MatchlockRunnerError(
      "matchlock_unavailable",
      swapMissingText(binaryPath, identity.runId, support.reason),
    );
  }
  throw new MatchlockRunnerError(
    "matchlock_swap_unsupported",
    swapUnsupportedText(binaryPath, identity.runId, support.reason),
  );
}
