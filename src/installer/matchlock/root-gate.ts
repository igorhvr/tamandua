/**
 * MTLK-INTERACTIVE (US-003) — the shared Matchlock root-usage gate (R13).
 *
 * Matchlock is documented to run unprivileged: `sudo` is for its one-time host
 * preparation only, never for running matchlock itself, and `tamandua matchlock
 * setup` exists precisely so matchlock never needs root later. Tamandua
 * therefore REFUSES to execute a Matchlock-backed session under a root process
 * (`euid 0`) unless the exact override flag was supplied to THIS invocation.
 *
 * Contract:
 *  - The gate is the FIRST Matchlock-related check. Callers must run it before
 *    any capability probe, image resolve, admission or VM create (US-004 asserts
 *    that ordering) so a refused root invocation touches nothing.
 *  - Consent is SESSION-SCOPED: only the flag supplied to this invocation
 *    counts. It is never inferred from `SUDO_UID`, an inherited environment,
 *    persisted policy or setup history, and a failed non-root launch is never
 *    silently retried as root.
 *  - With consent the invocation proceeds and the shared warning text is
 *    returned so the UX layer can surface it (`root_usage_override`).
 *  - The evaluator takes an INJECTED `euid` so uid-0 behavior is unit-tested
 *    without ever running as root.
 *
 * Node-core only and deliberately PURE (`process.geteuid` is the sole ambient
 * read, and only in the default path) — no `node:child_process`, no `node:fs`
 * — so it stays in the parallel lane.
 *
 * PROVISIONAL GAP GAP-01: at base `9f167705` the R13 gate is not shipped (only
 * the persisted `rootUsageConsent` field exists). This module is the interim
 * implementation recorded in INTEGRATION-NOTES.md; when the corrected iso line
 * ships the gate, delete it and import the shipped gate, keeping the typed code
 * `matchlock_root_usage_refused` and this call-site ordering unchanged.
 */

/**
 * The exact root-usage override flag (long, deliberate spelling). Canonical
 * here because the gate owns the refusal that names it; the interactive CLI
 * parser re-exports it so operators and parser stay on one spelling.
 */
export const MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG =
  "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs";

/** Typed refusal code for a root invocation without session consent. */
export const MATCHLOCK_ROOT_USAGE_REFUSED_CODE = "matchlock_root_usage_refused" as const;

/** Warning code for an authorized root invocation (shared warnings channel). */
export const MATCHLOCK_ROOT_USAGE_WARNING_CODE = "root_usage_override" as const;

/**
 * Shared warning text printed/emitted when root execution IS authorized. It
 * states that root execution is authorized, never that it occurred: a
 * non-root caller may also record consent.
 */
export const MATCHLOCK_ROOT_USAGE_WARNING =
  "Matchlock is documented to run unprivileged — sudo is for its one-time host " +
  "preparation only, never for running matchlock itself. Proceeding as root " +
  `because ${MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG} was supplied to this invocation.`;

/**
 * Shared refusal text. Names the override flag and the unprivileged-operation
 * rule; it never suggests that a non-root launch should be escalated.
 */
export const MATCHLOCK_ROOT_USAGE_REFUSAL_MESSAGE =
  "Refusing to execute a Matchlock session as root. Matchlock is documented to " +
  "run unprivileged — sudo is for its one-time host preparation only, never " +
  "for running matchlock itself — and `tamandua matchlock setup` exists " +
  "precisely so matchlock never needs root later. If you insist, re-run with:\n" +
  `  ${MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG}`;

/** Typed, actionable root-usage refusal carrying the shared code and flag. */
export class MatchlockRootUsageError extends Error {
  readonly code: typeof MATCHLOCK_ROOT_USAGE_REFUSED_CODE;
  readonly flag: string;

  constructor(message: string = MATCHLOCK_ROOT_USAGE_REFUSAL_MESSAGE) {
    super(message);
    this.name = "MatchlockRootUsageError";
    this.code = MATCHLOCK_ROOT_USAGE_REFUSED_CODE;
    this.flag = MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG;
  }
}

/** The two facts the gate evaluates: the effective uid and session consent. */
export interface MatchlockRootUsageInput {
  /** Effective uid of the invoking process (`0` is root). */
  euid: number;
  /** True ONLY when the exact override flag was supplied to this invocation. */
  rootUsageOverride: boolean;
}

/** Root execution is permitted; `warning` is present exactly for root+override. */
export interface MatchlockRootUsageAllowed {
  allowed: true;
  /** The shared warning text when consent authorized a root invocation. */
  warning?: string;
}

/** Root execution is refused; the caller must not touch Matchlock. */
export interface MatchlockRootUsageRefused {
  allowed: false;
  code: typeof MATCHLOCK_ROOT_USAGE_REFUSED_CODE;
  flag: string;
  message: string;
}

export type MatchlockRootUsageDecision =
  | MatchlockRootUsageAllowed
  | MatchlockRootUsageRefused;

/**
 * Pure evaluator. A non-root `euid` always proceeds without consent and without
 * a warning; root (`euid === 0`) proceeds with the shared warning only when the
 * override was supplied to this invocation, and otherwise is refused with the
 * typed code naming the override flag.
 */
export function evaluateMatchlockRootUsage(
  input: MatchlockRootUsageInput,
): MatchlockRootUsageDecision {
  // Non-root: the documented unprivileged path. Consent is irrelevant and does
  // not produce a warning (a non-root caller may still record consent).
  if (input.euid !== 0) return { allowed: true };

  if (input.rootUsageOverride === true) {
    return { allowed: true, warning: MATCHLOCK_ROOT_USAGE_WARNING };
  }

  return {
    allowed: false,
    code: MATCHLOCK_ROOT_USAGE_REFUSED_CODE,
    flag: MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG,
    message: MATCHLOCK_ROOT_USAGE_REFUSAL_MESSAGE,
  };
}

/**
 * Resolve the invoking process effective uid. POSIX-only; a platform whose
 * runtime cannot report an effective uid cannot evaluate the R13 precondition,
 * so it is refused rather than assumed non-root (never a permissive default).
 */
export function currentMatchlockEuid(): number {
  const geteuid = process.geteuid;
  if (typeof geteuid === "function") return geteuid.call(process);
  throw new MatchlockRootUsageError(
    `${MATCHLOCK_ROOT_USAGE_REFUSAL_MESSAGE}\n` +
      "(The effective uid could not be determined on this platform.)",
  );
}

/** Injectable inputs for {@link assertMatchlockRootUsageAllowed}. */
export interface AssertMatchlockRootUsageOptions {
  /** True ONLY when the exact override flag was supplied to this invocation. */
  rootUsageOverride?: boolean;
  /** Injected effective uid; defaults to {@link currentMatchlockEuid}. */
  euid?: number;
}

/**
 * The gate callers invoke first. Throws {@link MatchlockRootUsageError} (typed
 * code `matchlock_root_usage_refused`) when the effective uid is 0 without
 * session consent; otherwise returns the shared warning text (or `undefined`).
 */
export function assertMatchlockRootUsageAllowed(
  opts: AssertMatchlockRootUsageOptions = {},
): string | undefined {
  const euid = opts.euid ?? currentMatchlockEuid();
  const decision = evaluateMatchlockRootUsage({
    euid,
    rootUsageOverride: opts.rootUsageOverride === true,
  });
  if (!decision.allowed) throw new MatchlockRootUsageError(decision.message);
  return decision.warning;
}
