/**
 * ICEBOX — shared isolation-setting resolvers: the whole-VM privilege axis
 * (privileged-by-default) and the guest-resolver address-family preference
 * (`dns_priority`).
 *
 * Each setting has ONE resolution chain per surface, resolved ONCE at
 * submission and carried as a VALUE + its SOURCE (`"flag" | "env" |
 * "default"`) into the run policy; the create-params composer
 * (`composeCreateParams` in mount-plan.ts) emits the resolved value
 * explicitly on the wire (top-level `privileged`; `network.dns_priority`).
 *
 * Chains (documented in the command help, formatted like the swap
 * precedence line):
 *
 *   privileged    --matchlock-no-privileged > TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1
 *                 > default ON
 *   dns-priority  --matchlock-prioritize-ipv6-dns-resolution >
 *                 --matchlock-prioritize-ipv4-dns-resolution >
 *                 TAMANDUA_MATCHLOCK_DNS_PRIORITY > default ipv4
 *
 * Both-DNS-flags rule: the NON-DEFAULT flag wins — `ipv6` beats `ipv4` — in
 * EITHER argument order, so passing both DNS flags is never an error (this is
 * the one deliberate difference from the house swap pair, where passing
 * `--matchlock-no-swap` and `--matchlock-swap` together IS an error; the
 * shared part is the resolution shape: flag > env > default).
 *
 * This module is a LEAF (no imports): the CLI parsers, the admission layer,
 * run creation and the policy schema all import it without a dependency
 * cycle.
 */

/** Opt-out flag: create the VM WITHOUT the default whole-VM privilege. */
export const MATCHLOCK_NO_PRIVILEGED_FLAG = "--matchlock-no-privileged";

/**
 * Env opt-out for the whole-VM privilege. The ONLY enabling value is the
 * literal `1` (after trimming); any other value (including `0`, `true`,
 * empty) is NOT an opt-out. The env can only turn privilege OFF, never ON,
 * so the default-ON contract cannot be defeated by an arbitrary string.
 */
export const MATCHLOCK_NO_PRIVILEGED_ENV = "TAMANDUA_MATCHLOCK_NO_PRIVILEGED";

/**
 * Env form of the address-family preference: EXACTLY `ipv4` or `ipv6`
 * (whitespace-trimmed). Any other non-empty value is a typed refusal —
 * never a silent fallback. Deliberately strict tokens (no case folding):
 * the wire contract is `dns_priority: "ipv4" | "ipv6"` and the env mirrors
 * it.
 */
export const MATCHLOCK_DNS_PRIORITY_ENV = "TAMANDUA_MATCHLOCK_DNS_PRIORITY";

/** Tamandua-surface flag naming the IPv4 preference (the fork default). */
export const MATCHLOCK_PRIORITIZE_IPV4_FLAG =
  "--matchlock-prioritize-ipv4-dns-resolution";

/** Tamandua-surface flag naming the IPv6 preference (explicit opt-in). */
export const MATCHLOCK_PRIORITIZE_IPV6_FLAG =
  "--matchlock-prioritize-ipv6-dns-resolution";

/** Resolved address-family preference for the guest resolver. */
export type MatchlockDnsPriority = "ipv4" | "ipv6";

/** How a resolved setting was chosen on the composing surface. */
export type MatchlockIsolationSettingSource = "flag" | "env" | "default";

/**
 * Typed usage error for an invalid isolation-setting value (an unparseable
 * `TAMANDUA_MATCHLOCK_DNS_PRIORITY`). Carries the setting name so every
 * surface can name the exact env var in its refusal.
 */
export class MatchlockIsolationSettingError extends Error {
  readonly code = "matchlock_isolation_setting_invalid";

  constructor(
    readonly setting: string,
    message: string,
  ) {
    super(message);
    this.name = "MatchlockIsolationSettingError";
  }
}

/** Resolved whole-VM privilege setting + its resolution source. */
export interface ResolvedMatchlockPrivileged {
  privileged: boolean;
  source: MatchlockIsolationSettingSource;
}

/** Resolved address-family preference + its resolution source. */
export interface ResolvedMatchlockDnsPriority {
  priority: MatchlockDnsPriority;
  source: MatchlockIsolationSettingSource;
}

/** An env value counts as UNSET when absent, empty or whitespace-only. */
function isAbsentEnvValue(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === "";
}

/** Structural guard: a persisted resolution source is one of the three channels. */
export function isMatchlockIsolationSettingSource(
  v: unknown,
): v is MatchlockIsolationSettingSource {
  return v === "flag" || v === "env" || v === "default";
}

/** Structural guard: a persisted address-family value is `ipv4` or `ipv6`. */
export function isMatchlockDnsPriorityValue(
  v: unknown,
): v is MatchlockDnsPriority {
  return v === "ipv4" || v === "ipv6";
}

/**
 * Resolve the whole-VM privilege setting.
 *
 * Precedence: `--matchlock-no-privileged` (opt-out flag) >
 * `TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1` (env opt-out) > default ON. The flag
 * wins over the env in both directions (an opt-out env under an opt-out flag
 * resolves to source `"flag"`); the env is an opt-out ONLY for the literal
 * value `1` after trimming. There is deliberately no env value that turns
 * privilege ON — the default is already ON.
 */
export function resolveMatchlockPrivileged(input: {
  /** True only when the exact `--matchlock-no-privileged` flag was supplied. */
  noPrivilegedFlag?: boolean;
  env?: Record<string, string | undefined>;
}): ResolvedMatchlockPrivileged {
  if (input.noPrivilegedFlag === true) {
    return { privileged: false, source: "flag" };
  }
  if (input.env?.[MATCHLOCK_NO_PRIVILEGED_ENV]?.trim() === "1") {
    return { privileged: false, source: "env" };
  }
  return { privileged: true, source: "default" };
}

/**
 * Resolve the address-family preference (ICEBOX DNS).
 *
 * Precedence: `--matchlock-prioritize-ipv6-dns-resolution` >
 * `--matchlock-prioritize-ipv4-dns-resolution` > `TAMANDUA_MATCHLOCK_DNS_PRIORITY`
 * > default `ipv4`. The IPv6 flag wins even when the IPv4 flag is also
 * supplied (in either argument order). A winning FLAG makes a malformed env
 * value irrelevant — the env is validated ONLY when it is actually consulted
 * (no flag present). An unparseable consulted value is a typed
 * {@link MatchlockIsolationSettingError}, never a silent fallback.
 */
export function resolveMatchlockDnsPriority(input: {
  /** True only when the exact IPv4-priority flag was supplied. */
  ipv4Flag?: boolean;
  /** True only when the exact IPv6-priority flag was supplied. */
  ipv6Flag?: boolean;
  env?: Record<string, string | undefined>;
}): ResolvedMatchlockDnsPriority {
  // Both-flags rule: the NON-DEFAULT flag (ipv6) wins, in either order, and
  // passing both is never an error.
  if (input.ipv6Flag === true) return { priority: "ipv6", source: "flag" };
  if (input.ipv4Flag === true) return { priority: "ipv4", source: "flag" };
  const raw = input.env?.[MATCHLOCK_DNS_PRIORITY_ENV];
  if (!isAbsentEnvValue(raw)) {
    const value = (raw as string).trim();
    if (value === "ipv4" || value === "ipv6") {
      return { priority: value, source: "env" };
    }
    throw new MatchlockIsolationSettingError(
      MATCHLOCK_DNS_PRIORITY_ENV,
      `Invalid ${MATCHLOCK_DNS_PRIORITY_ENV} value ${JSON.stringify(value)}: expected exactly "ipv4" or "ipv6".`,
    );
  }
  return { priority: "ipv4", source: "default" };
}
