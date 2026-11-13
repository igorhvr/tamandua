/**
 * NAT-EGRESS — shared unrestricted-outbound network-mode resolver.
 *
 * A Matchlock VM normally runs with egress interception ON: private
 * destinations are blocked and DNS is pinned through the guest resolver. The
 * opt-in outbound mode turns that machinery OFF (`intercept: false`,
 * `block_private_ips: false` on the create request) so the guest can reach any
 * destination the host can.
 *
 * The choice is made ONCE, when a run/session is CREATED:
 *
 *   flag   --matchlock-unrestricted-outbound-networking
 *   env    TAMANDUA_MATCHLOCK_UNRESTRICTED_NETWORKING=1
 *   default intercepted
 *
 * The four interactive commands, the workflow path and every harness branch
 * (pi / hermes / dsh) all resolve through {@link resolveMatchlockNetworkOutbound}
 * and validate through {@link assertMatchlockNetworkOutboundCompatible}, so the
 * spelling, precedence and refusal wording cannot drift between surfaces.
 *
 * DELIBERATELY A LEAF: Node-core types plus a TYPE-ONLY import of the shared
 * isolation-setting source union. No `node:child_process`, no `node:fs`, no
 * runtime matchlock imports — so it stays in the parallel test lane and can be
 * imported by the CLI parser, admission, policy and mount-plan layers without a
 * cycle. The allow-private / DNS-priority spellings are mirrored below rather
 * than imported for that reason, and the module's test pins them against the
 * canonical constants in `allow-private.ts` / `isolation-settings.ts`.
 */

import type { MatchlockIsolationSettingSource } from "./isolation-settings.js";

/** Opt-in flag: create the VM with unrestricted outbound networking. */
export const MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG =
  "--matchlock-unrestricted-outbound-networking";

/**
 * Env form of the opt-in. The ONLY enabling value is the literal `1` after
 * trimming. Absent/empty/whitespace leaves the default (intercepted); any other
 * non-empty value is a typed refusal, never a silent fallback.
 */
export const MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV =
  "TAMANDUA_MATCHLOCK_UNRESTRICTED_NETWORKING";

/**
 * Mirror of `MATCHLOCK_ALLOW_PRIVATE_ENV` in `allow-private.ts` (kept local so
 * this module has no runtime imports; the test pins equality).
 */
export const MATCHLOCK_OUTBOUND_ALLOW_PRIVATE_ENV = "TAMANDUA_MATCHLOCK_ALLOW_PRIVATE";

/**
 * Mirror of `MATCHLOCK_DNS_PRIORITY_ENV` in `isolation-settings.ts` (kept local
 * so this module has no runtime imports; the test pins equality).
 */
export const MATCHLOCK_OUTBOUND_DNS_PRIORITY_ENV = "TAMANDUA_MATCHLOCK_DNS_PRIORITY";

/** Typed code for a malformed `TAMANDUA_MATCHLOCK_UNRESTRICTED_NETWORKING` value. */
export const MATCHLOCK_NETWORK_OUTBOUND_INVALID_CODE =
  "matchlock_network_outbound_invalid" as const;

/** Typed code for the flag-vs-interception-settings conflict matrix. */
export const MATCHLOCK_NETWORK_OUTBOUND_CONFLICT_CODE =
  "matchlock_network_outbound_conflict" as const;

/**
 * Typed code for passing the outbound FLAG to a RESUME. The mode is chosen
 * when a run is created and persisted on its policy, so an explicit flag on a
 * later launch is a usage error rather than a silently ignored argument.
 */
export const MATCHLOCK_NETWORK_OUTBOUND_RESUME_REFUSED_CODE =
  "matchlock_network_outbound_fixed_at_admission" as const;

/** Resolved outbound mode plus how it was selected on this surface. */
export interface ResolvedMatchlockNetworkOutbound {
  /** True when interception is disabled for the VM. */
  unrestricted: boolean;
  /** `flag` | `env` | `default` — never inferred. */
  source: MatchlockIsolationSettingSource;
}

/** Already-resolved inputs for {@link assertMatchlockNetworkOutboundCompatible}. */
export interface MatchlockNetworkOutboundCompatibilityInput {
  /**
   * The RESOLVED outbound selection this surface will actually use (see
   * {@link resolveMatchlockNetworkOutbound}). The conflict matrix is keyed on
   * this RESOLVED value, never on the input flag: an unrestricted mode is
   * refused with the same matrix whether it was selected by the flag or by a
   * non-empty `TAMANDUA_MATCHLOCK_UNRESTRICTED_NETWORKING=1`. A missing /
   * intercepted selection is a no-op.
   */
  resolved?: ResolvedMatchlockNetworkOutbound;
  /**
   * Allow-private entries supplied by the `--matchlock-allow-private` flag
   * (already shape-validated by the caller).
   */
  allowPrivateEntries?: readonly string[];
  /**
   * Raw `TAMANDUA_MATCHLOCK_ALLOW_PRIVATE` value, consulted only when no
   * allow-private flag entries were supplied. Empty/whitespace is not a
   * conflict.
   */
  allowPrivateEnvRaw?: string;
  /**
   * The DNS-priority flag names actually supplied (e.g.
   * `--matchlock-prioritize-ipv6-dns-resolution`). Any entry is a conflict.
   */
  dnsPriorityFlags?: readonly string[];
  /**
   * Raw `TAMANDUA_MATCHLOCK_DNS_PRIORITY` value, consulted only when no
   * DNS-priority flag was supplied. Empty/whitespace is not a conflict.
   */
  dnsPriorityEnvRaw?: string;
}

/**
 * Typed usage error for an invalid outbound-mode env value or one of the
 * flag-vs-interception-settings conflicts. The base code is the malformed-env
 * code; conflicts carry {@link MATCHLOCK_NETWORK_OUTBOUND_CONFLICT_CODE}. Every
 * message names the setting(s) involved verbatim so operators can fix it.
 */
export class MatchlockNetworkOutboundError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code: string = MATCHLOCK_NETWORK_OUTBOUND_INVALID_CODE,
  ) {
    super(message);
    this.name = "MatchlockNetworkOutboundError";
    this.code = code;
  }
}

/**
 * Render the "unrestricted side" of a conflict message from the RESOLVED
 * selection, so a refusal always names the channel the operator actually used:
 *
 *   source `flag`    -> `--matchlock-unrestricted-outbound-networking`
 *   source `env`     -> `a non-empty TAMANDUA_MATCHLOCK_UNRESTRICTED_NETWORKING=1`
 *   otherwise        -> a neutral phrase (only a hand-built selection can
 *                       reach this; the resolver never returns it)
 */
export function formatMatchlockNetworkOutboundSelectionLabel(
  resolved?: ResolvedMatchlockNetworkOutbound,
): string {
  switch (resolved?.source) {
    case "env":
      return `a non-empty ${MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV}=1`;
    case "flag":
      return MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG;
    default:
      return "unrestricted outbound networking";
  }
}

/** An env value counts as UNSET when absent, empty or whitespace-only. */
function isAbsentEnvValue(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === "";
}

function hasEntries(entries: readonly string[] | undefined): boolean {
  return (entries ?? []).some(
    (entry) => typeof entry === "string" && entry.trim() !== "",
  );
}

/**
 * Resolve the outbound network mode.
 *
 * Precedence: `--matchlock-unrestricted-outbound-networking` >
 * `TAMANDUA_MATCHLOCK_UNRESTRICTED_NETWORKING=1` > default intercepted. A
 * winning flag makes a malformed env value irrelevant — the env is validated
 * ONLY when it is actually consulted. An unparseable consulted value is a typed
 * {@link MatchlockNetworkOutboundError}, never a silent fallback.
 */
export function resolveMatchlockNetworkOutbound(
  input: {
    /** True only when the exact outbound flag was supplied. */
    flag?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
): ResolvedMatchlockNetworkOutbound {
  if (input.flag === true) {
    return { unrestricted: true, source: "flag" };
  }
  const raw = input.env?.[MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV];
  if (isAbsentEnvValue(raw)) {
    return { unrestricted: false, source: "default" };
  }
  const value = (raw as string).trim();
  if (value === "1") {
    return { unrestricted: true, source: "env" };
  }
  throw new MatchlockNetworkOutboundError(
    `Invalid ${MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV} value ${JSON.stringify(value)}: ` +
      'expected exactly "1" to enable unrestricted outbound networking ' +
      `(leave it unset for the default intercepted networking).`,
  );
}

/**
 * Enforce the conflict matrix whenever the RESOLVED selection is unrestricted
 * (R4/R6/R7 — the matrix applies identically to the flag and the env form):
 *
 *  (a) allow-private entries (flag or effective list)  -> names the selection
 *      and `--matchlock-allow-private`;
 *  (b) non-empty `TAMANDUA_MATCHLOCK_ALLOW_PRIVATE`    -> names the selection
 *      and the env var;
 *  (c) any supplied DNS-priority flag                  -> names the selection
 *      and the supplied DNS flag;
 *  (d) non-empty `TAMANDUA_MATCHLOCK_DNS_PRIORITY`     -> names the selection
 *      and the env var.
 *
 * An empty/whitespace allow-private or DNS env value is NOT a conflict. The
 * flag still BEATS the env for precedence (resolution, not exemption): it does
 * not relax the matrix. The selection side is rendered by
 * {@link formatMatchlockNetworkOutboundSelectionLabel} so the flag/env wording
 * cannot drift, and unrestricted outbound's wire form omits the
 * interception-only allow_private/dns_priority fields. Pure: callers pass
 * already-resolved values, and no VM is involved.
 */
export function assertMatchlockNetworkOutboundCompatible(
  input: MatchlockNetworkOutboundCompatibilityInput,
): void {
  if (input.resolved?.unrestricted !== true) return;
  const selected = formatMatchlockNetworkOutboundSelectionLabel(input.resolved);

  if (hasEntries(input.allowPrivateEntries)) {
    throw new MatchlockNetworkOutboundError(
      `Cannot combine ${selected} with ` +
        `--matchlock-allow-private: unrestricted outbound networking disables ` +
        `egress interception, so private-destination exemptions have no ` +
        `meaning. Remove one of them.`,
      MATCHLOCK_NETWORK_OUTBOUND_CONFLICT_CODE,
    );
  }

  if (!isAbsentEnvValue(input.allowPrivateEnvRaw)) {
    throw new MatchlockNetworkOutboundError(
      `Cannot combine ${selected} with a non-empty ` +
        `${MATCHLOCK_OUTBOUND_ALLOW_PRIVATE_ENV}: unrestricted outbound ` +
        `networking disables egress interception, so private-destination ` +
        `exemptions have no meaning. Unset ${MATCHLOCK_OUTBOUND_ALLOW_PRIVATE_ENV} ` +
        `or drop ${MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG}.`,
      MATCHLOCK_NETWORK_OUTBOUND_CONFLICT_CODE,
    );
  }

  const dnsFlags = (input.dnsPriorityFlags ?? []).filter(
    (flag) => typeof flag === "string" && flag.trim() !== "",
  );
  if (dnsFlags.length > 0) {
    throw new MatchlockNetworkOutboundError(
      `Cannot combine ${selected} with ` +
        `${dnsFlags.join(", ")}: unrestricted outbound networking disables ` +
        `egress interception, so guest DNS priority is not in effect. Remove ` +
        `one of them.`,
      MATCHLOCK_NETWORK_OUTBOUND_CONFLICT_CODE,
    );
  }

  if (!isAbsentEnvValue(input.dnsPriorityEnvRaw)) {
    throw new MatchlockNetworkOutboundError(
      `Cannot combine ${selected} with a non-empty ` +
        `${MATCHLOCK_OUTBOUND_DNS_PRIORITY_ENV}: unrestricted outbound ` +
        `networking disables egress interception, so guest DNS priority is not ` +
        `in effect. Unset ${MATCHLOCK_OUTBOUND_DNS_PRIORITY_ENV} or drop ` +
        `${MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG}.`,
      MATCHLOCK_NETWORK_OUTBOUND_CONFLICT_CODE,
    );
  }
}

/**
 * True when an argument list explicitly carries the outbound opt-in, in either
 * the plain (`--flag`) or the (rejected) `--flag=value` spelling. Used by
 * surfaces that must REFUSE the flag instead of resolving it (a resume).
 */
export function hasMatchlockUnrestrictedOutboundFlag(
  args: readonly string[],
): boolean {
  return args.some(
    (arg) =>
      arg === MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG ||
      arg.startsWith(`${MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG}=`),
  );
}

/**
 * Usage refusal for an explicit outbound-mode flag on a RESUME.
 *
 * The network mode is fixed at admission and every later launch (queued
 * dispatch, retry, resume, daemon restart, replacement) composes from the
 * STORED policy. Passing the flag anyway must be a loud, typed refusal — never
 * a silent no-op that leaves the operator believing the mode changed.
 */
export function formatMatchlockNetworkOutboundResumeRefusal(): string {
  return (
    `Cannot pass ${MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG} to 'tamandua workflow resume': ` +
    "the network mode is fixed at admission and every later launch composes " +
    "from the run's stored Matchlock policy. Create a new run to change it."
  );
}

/**
 * Render the stable launch-summary segment for the resolved mode:
 *
 *   undefined / default / `unrestricted:false` -> ` network=intercepted(default)`
 *   `unrestricted:true, source:"flag"`         -> ` network=unrestricted-outbound(flag)`
 *   `unrestricted:true, source:"env"`          -> ` network=unrestricted-outbound(env)`
 *   `unrestricted:true, source:"default"`      -> ` network=unrestricted-outbound(default)`
 *
 * The leading space is part of the contract: callers append the segment to the
 * single `matchlock:` summary line without adding separators.
 */
export function formatMatchlockNetworkOutboundSummary(
  resolved?: ResolvedMatchlockNetworkOutbound,
): string {
  if (resolved?.unrestricted === true) {
    return ` network=unrestricted-outbound(${resolved.source})`;
  }
  return " network=intercepted(default)";
}
