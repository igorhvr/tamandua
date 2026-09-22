/**
 * home-alias-owner.ts — host-side owner identity + kernel-proven liveness for
 * the keyed Matchlock short-HOME alias (US-002).
 *
 * `home-alias.ts` is a Node-core-only leaf that must not import a
 * process-spawning module (so it can sit inside the guest-pack walk closure).
 * This host module owns that import: it turns the kernel start-identity helper
 * (`src/lib/process-start-identity.ts`) into the `owner` predicate that
 * `describeMatchlockHomeAlias` consumes, and exposes the production
 * owner-aware resolver the scheduler will use (US-003).
 *
 * LIVENESS
 * --------
 * The recorded sidecar identity is `v2:<pid>:<epochMs>` (kernel-derived, TZ
 * independent). `compareProcessStartIdentities` returns:
 *   - `same`      -> the recorded daemon is still that exact process (refuse)
 *   - `different` -> the pid was reused by a different process (stale, take over)
 *   - `unknown`   -> one side is unreadable/malformed (fail closed)
 *
 * A genuinely ABSENT pid cannot yield `different` from the pure comparison
 * (the kernel read returns null), yet a dead owner must be reclaimable. The
 * classifier therefore uses the start identity as the authoritative signal and
 * only when it is unreadable consults pid existence (`kill(pid, 0)`): an absent
 * pid is stale (`different`), an unreadable-but-present pid is `unknown`.
 * This is deliberate: it takes over truly dead owners without ever treating a
 * live-but-unreadable one as stale.
 */
import {
  compareProcessStartIdentities,
  getProcessStartIdentity,
  parseProcessStartIdentity,
  type ProcessStartIdentityComparison,
} from "../../lib/process-start-identity.js";
import {
  MatchlockHomeAliasError,
  describeMatchlockHomeAlias,
  type MatchlockHomeAliasDeps,
  type MatchlockHomeAliasOwnerDeps,
  type MatchlockHomeAliasOwnerLiveness,
  type MatchlockHomeAliasOwnerRecord,
  type MatchlockHomeAliasResolution,
} from "./home-alias.js";

/** Kernel-proven identity of a live process. */
export interface MatchlockHomeAliasDaemonIdentity {
  pid: number;
  /** Canonical `v2:<pid>:<epochMs>` kernel start identity. */
  startIdentity: string;
}

/** Injectable kernel probes (tests; production uses the real helpers). */
export interface MatchlockAliasOwnerProbeDeps {
  getProcessStartIdentity?: (pid: number) => string | null;
  compareProcessStartIdentities?: (
    expected: string | null | undefined,
    actual: string | null | undefined,
  ) => ProcessStartIdentityComparison;
  /** Whether a pid currently exists (tie-breaker when the identity read is null). */
  processExists?: (pid: number) => boolean;
}

/** Default pid-existence probe: signal 0 never delivers a signal. */
export function defaultProcessExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kernel-proven identity of `pid` (default: this daemon). Refuses with a typed
 * `alias_owner_unreadable` when no comparable v2 identity can be read, so an
 * unsupported/unreadable host never writes an unverifiable ownership claim.
 */
export function daemonOwnerIdentity(
  pid: number = process.pid,
  deps: MatchlockAliasOwnerProbeDeps = {},
): MatchlockHomeAliasDaemonIdentity {
  const readIdentity = deps.getProcessStartIdentity ?? getProcessStartIdentity;
  const startIdentity = readIdentity(pid);
  if (startIdentity === null || parseProcessStartIdentity(startIdentity) === null) {
    throw new MatchlockHomeAliasError(
      "alias_owner_unreadable",
      `cannot read a kernel start identity for pid ${pid}; refusing to claim the Matchlock short-HOME alias`,
    );
  }
  return { pid, startIdentity };
}

/**
 * Classify a recorded alias owner (see module header for the exact rules).
 * Never throws: `unknown` is the fail-closed answer when liveness cannot be
 * proven.
 */
export function classifyMatchlockAliasOwner(
  owner: MatchlockHomeAliasOwnerRecord,
  deps: MatchlockAliasOwnerProbeDeps = {},
): MatchlockHomeAliasOwnerLiveness {
  const readIdentity = deps.getProcessStartIdentity ?? getProcessStartIdentity;
  const compare = deps.compareProcessStartIdentities ?? compareProcessStartIdentities;
  const exists = deps.processExists ?? defaultProcessExists;

  const comparison = compare(owner.startIdentity, readIdentity(owner.pid));
  if (comparison !== "unknown") return comparison;
  // The start identity was unreadable: absent pid -> stale; otherwise fail closed.
  return exists(owner.pid) ? "unknown" : "different";
}

/**
 * Boolean form of the liveness predicate: true only when the kernel start
 * identity proves the recorded owner is still the SAME live process (`same`).
 * A stale/reused pid (`different`) or an unprovable/unreadable owner
 * (`unknown`) is NOT live — callers that must fail closed on `unknown` use
 * {@link classifyMatchlockAliasOwner} instead.
 */
export function ownerIsLive(
  owner: MatchlockHomeAliasOwnerRecord,
  deps: MatchlockAliasOwnerProbeDeps = {},
): boolean {
  return classifyMatchlockAliasOwner(owner, deps) === "same";
}

/** Deps for the owner-aware resolver (host-only overrides for tests). */
export interface MatchlockOwnerResolverDeps extends MatchlockHomeAliasDeps {
  /** Explicit daemon pid (default: this process). */
  ownerPid?: number;
  /**
   * Explicit daemon kernel start identity. When set, no identity is read;
   * `null` forces the typed refusal (tests).
   */
  ownerStartIdentity?: string | null;
  /** Injectable kernel probes for the owner liveness predicate (tests). */
  ownerProbe?: MatchlockAliasOwnerProbeDeps;
}

/**
 * Production owner-aware resolution: read this daemon's kernel identity, build
 * the `owner` deps and run the full keyed/ownership protocol in
 * {@link describeMatchlockHomeAlias}. A missing kernel identity refuses
 * (`alias_owner_unreadable`) before any alias effect.
 */
export function describeMatchlockHomeAliasWithOwner(
  deps: MatchlockOwnerResolverDeps = {},
): MatchlockHomeAliasResolution {
  const ownerPid = deps.ownerPid ?? process.pid;
  const readIdentity = deps.ownerProbe?.getProcessStartIdentity ?? getProcessStartIdentity;
  const startIdentity =
    deps.ownerStartIdentity !== undefined ? deps.ownerStartIdentity : readIdentity(ownerPid);
  if (startIdentity === null || parseProcessStartIdentity(startIdentity) === null) {
    throw new MatchlockHomeAliasError(
      "alias_owner_unreadable",
      `cannot read a kernel start identity for pid ${ownerPid}; refusing to claim or inspect the Matchlock short-HOME alias`,
    );
  }
  const owner: MatchlockHomeAliasOwnerDeps = {
    pid: ownerPid,
    startIdentity,
    classifyOwner: (record) => classifyMatchlockAliasOwner(record, deps.ownerProbe),
  };
  const { ownerPid: _ownerPid, ownerStartIdentity: _ownerStartIdentity, ownerProbe: _ownerProbe, ...aliasDeps } = deps;
  return describeMatchlockHomeAlias({ ...aliasDeps, owner });
}

/** HOME value the Matchlock control process must run with (owner-aware). */
export function resolveMatchlockHomeAliasWithOwner(deps: MatchlockOwnerResolverDeps = {}): string {
  return describeMatchlockHomeAliasWithOwner(deps).home;
}
