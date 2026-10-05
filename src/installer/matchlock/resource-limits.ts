/**
 * Matchlock VM resource-limit resolver (MTLK-VM-SIZE).
 *
 * One dependency-light, host-owned resolver shared by the CLI (flag/env
 * parsing at launch) and run admission (host-derived built-in defaults) so
 * that parsing, clamping and defaults cannot drift between the two.
 *
 * Precedence per field is `flag` > `env` > `default`. EVERY supplied value
 * (flag and env alike) is clamped by the standing caps:
 *   - cpus   <= 16 ALWAYS (project rule) and <= the host's online CPUs
 *   - memory <= 75% of host MemTotal
 *   - disk   finite positive only
 * The host-derived defaults are:
 *   - cpus   = min(8, host online CPUs)
 *   - memory = min(16384 MB, 50% of host MemTotal)
 *   - disk   = 20480 MB
 *
 * MTLK-SWAP adds one field with deliberately different semantics: `swapMB`
 * (0 = swap off) is `--matchlock-no-swap` > `--matchlock-swap` > env
 * (`TAMANDUA_MATCHLOCK_SWAP_MB`, a size or `off`) > the built-in 8192 MB, with
 * no host-derived clamp (swap is a sparse disk file, not reserved RAM).
 *
 * Node-core only (`node:os`) — deliberately NO `node:child_process`, so this
 * module and its tests stay in the parallel lane.
 */

import os from "node:os";

/** Standing project cap: never more than 16 vCPUs for a Matchlock VM. */
export const MATCHLOCK_MAX_CPUS = 16;
/** Built-in default cpus cap (a many-core host still gets 8 by default). */
export const MATCHLOCK_DEFAULT_CPUS_CAP = 8;
/** Built-in default memory cap in MB (16 GiB). */
export const MATCHLOCK_DEFAULT_MEMORY_CAP_MB = 16384;
/** Built-in default disk size in MB (20 GiB). */
export const MATCHLOCK_DEFAULT_DISK_MB = 20480;
/** Built-in default swap size in MB (8 GiB) for every Matchlock VM. */
export const MATCHLOCK_DEFAULT_SWAP_MB = 8192;
/**
 * Hard maximum swap size in MB (64 GiB), mirroring matchlock's own `maxSwapMB`
 * cap so an oversized value is rejected at launch, never at VM-create time.
 */
export const MATCHLOCK_MAX_SWAP_MB = 65536;
/** Fraction of host MemTotal used for the default memory allowance. */
export const MATCHLOCK_DEFAULT_MEMORY_HOST_FRACTION = 0.5;
/** Maximum fraction of host MemTotal an explicit/env memory value may claim. */
export const MATCHLOCK_MAX_MEMORY_HOST_FRACTION = 0.75;

/** Operator env var supplying cpus when `--matchlock-cpus` is absent. */
export const MATCHLOCK_CPUS_ENV = "TAMANDUA_MATCHLOCK_CPUS";
/** Operator env var supplying memory (MB, or `<n>g`) when the flag is absent. */
export const MATCHLOCK_MEMORY_ENV = "TAMANDUA_MATCHLOCK_MEMORY_MB";
/** Operator env var supplying disk (MB, or `<n>g`) when the flag is absent. */
export const MATCHLOCK_DISK_ENV = "TAMANDUA_MATCHLOCK_DISK_MB";
/**
 * Operator env var supplying swap when `--matchlock-swap` is absent: a size
 * (MB or `<n>g`) or the literal `off` (case-insensitive) to disable swap.
 */
export const MATCHLOCK_SWAP_ENV = "TAMANDUA_MATCHLOCK_SWAP_MB";

/** Resolved Matchlock VM resource limits. */
export interface MatchlockResourceLimits {
  cpus: number;
  memoryMB: number;
  diskSizeMB: number;
  /** Guest swap size in MB; `0` means swap is disabled for the run. */
  swapMB: number;
}

/** Where a single resolved field's value came from. */
export type MatchlockResourceLimitSource = "flag" | "env" | "default";

/** Resolved limits plus the per-field provenance. */
export interface ResolvedMatchlockResourceLimits extends MatchlockResourceLimits {
  sources: {
    cpus: MatchlockResourceLimitSource;
    memoryMB: MatchlockResourceLimitSource;
    diskSizeMB: MatchlockResourceLimitSource;
    swapMB: MatchlockResourceLimitSource;
  };
}

/**
 * Host capacity probe. Injectable so defaults and clamps are deterministic in
 * tests; production uses {@link defaultMatchlockResourceHostProbe}.
 */
export interface MatchlockResourceHostProbe {
  /** Number of online logical CPUs. */
  onlineCpus(): number;
  /** Total host memory in whole MB (MiB). */
  totalMemoryMB(): number;
}

/** Production host probe over `node:os`. */
export const defaultMatchlockResourceHostProbe: MatchlockResourceHostProbe = {
  onlineCpus: () => os.cpus().length,
  totalMemoryMB: () => Math.floor(os.totalmem() / 1048576),
};

/** Parameters for {@link resolveMatchlockResourceLimits}. */
export interface ResolveMatchlockResourceLimitsParams {
  /** Explicit `--matchlock-cpus` value (raw string or number), if any. */
  cpus?: string | number;
  /** Explicit `--matchlock-memory` value (`MB` or `<n>g`), if any. */
  memoryMB?: string | number;
  /** Explicit `--matchlock-disk` value (`MB` or `<n>g`), if any. */
  diskSizeMB?: string | number;
  /** Explicit `--matchlock-swap` value (`MB` or `<n>g`), if any. */
  swapMB?: string | number;
  /** `--matchlock-no-swap`: disable swap, beating any size (flag or env). */
  noSwap?: boolean;
  /**
   * Environment snapshot consulted per field after an explicit flag. Callers
   * that want the ambient process environment pass `process.env`; the default
   * `{}` keeps the resolver pure.
   */
  env?: Record<string, string | undefined>;
  /** Host probe override (deterministic tests). */
  hostProbe?: MatchlockResourceHostProbe;
}

/** Typed, actionable resource-limit error. */
export class MatchlockResourceLimitError extends Error {
  readonly code = "matchlock_resource_limit_invalid";
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "MatchlockResourceLimitError";
    this.field = field;
  }
}

/** Parse a plain positive integer (no sign, no fraction, no exponent). */
function parsePositiveInteger(raw: string | number, flag: string): number {
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new MatchlockResourceLimitError(
      flag,
      `Invalid Matchlock ${flag} value ${JSON.stringify(String(raw))}: expected a positive integer.`,
    );
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MatchlockResourceLimitError(
      flag,
      `Invalid Matchlock ${flag} value ${JSON.stringify(String(raw))}: expected a positive integer.`,
    );
  }
  return value;
}

/**
 * Parse a memory/disk size: a plain positive integer (MB) or `<n>g`/`<n>G`
 * (gibibytes, multiplied by 1024). Fractions, signs, zero and non-numeric
 * values are rejected.
 */
function parseSizeMB(raw: string | number, flag: string): number {
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  const giga = /^(\d+)[gG]$/.exec(text);
  if (giga) {
    const gigabytes = Number(giga[1]);
    if (!Number.isSafeInteger(gigabytes) || gigabytes <= 0) {
      throw new MatchlockResourceLimitError(
        flag,
        `Invalid Matchlock ${flag} value ${JSON.stringify(String(raw))}: expected a positive size in MB or '<n>g'.`,
      );
    }
    return gigabytes * 1024;
  }
  return parsePositiveInteger(text, flag);
}

/**
 * Parse a swap size (MTLK-SWAP): the {@link parseSizeMB} grammar (a whole
 * positive integer in MB or `<n>g`/`<n>G`), POSITIVE ONLY, and no larger than
 * {@link MATCHLOCK_MAX_SWAP_MB} (matchlock's own cap). `0` is deliberately not
 * a valid spelling — it is rejected with a message pointing at the real off
 * switch (`--matchlock-no-swap`, or `TAMANDUA_MATCHLOCK_SWAP_MB=off` when the
 * value came from the env var named by `flag`). Negatives, fractions and
 * non-numerics are typed errors too.
 */
export function parseSwapMB(raw: string | number, flag: string): number {
  const offSwitch = flag === MATCHLOCK_SWAP_ENV ? `${MATCHLOCK_SWAP_ENV}=off` : "--matchlock-no-swap";
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  if (text === "0") {
    throw new MatchlockResourceLimitError(
      flag,
      `Invalid Matchlock ${flag} value ${JSON.stringify(String(raw))}: 0 does not disable swap; use ${offSwitch}.`,
    );
  }
  let value: number;
  const giga = /^(\d+)[gG]$/.exec(text);
  if (giga) {
    const gigabytes = Number(giga[1]);
    if (!Number.isSafeInteger(gigabytes) || gigabytes <= 0) {
      throw new MatchlockResourceLimitError(
        flag,
        `Invalid Matchlock ${flag} value ${JSON.stringify(String(raw))}: expected a positive size in MB or '<n>g'.`,
      );
    }
    value = gigabytes * 1024;
  } else {
    value = parsePositiveInteger(text, flag);
  }
  if (value > MATCHLOCK_MAX_SWAP_MB) {
    throw new MatchlockResourceLimitError(
      flag,
      `Invalid Matchlock ${flag} value ${JSON.stringify(String(raw))}: exceeds matchlock's maximum swap of ${MATCHLOCK_MAX_SWAP_MB} MB.`,
    );
  }
  return value;
}

/** A field is absent when it is undefined/null or whitespace-only. */
function isAbsent(raw: string | number | undefined | null): boolean {
  if (raw === undefined || raw === null) return true;
  return typeof raw === "string" && raw.trim() === "";
}

/**
 * Resolve the effective Matchlock VM resource limits. Precedence per field is
 * explicit value > env > host-derived default; every value is parsed and
 * clamped.
 */
export function resolveMatchlockResourceLimits(
  params: ResolveMatchlockResourceLimitsParams = {},
): ResolvedMatchlockResourceLimits {
  const env = params.env ?? {};
  const probe = params.hostProbe ?? defaultMatchlockResourceHostProbe;
  const hostCpus = probe.onlineCpus();
  const hostMemMB = probe.totalMemoryMB();
  if (!Number.isFinite(hostCpus) || hostCpus < 1) {
    throw new MatchlockResourceLimitError(
      "host",
      `Invalid Matchlock host probe: onlineCpus must be >= 1 (got ${String(hostCpus)}).`,
    );
  }
  if (!Number.isFinite(hostMemMB) || hostMemMB < 1) {
    throw new MatchlockResourceLimitError(
      "host",
      `Invalid Matchlock host probe: totalMemoryMB must be >= 1 (got ${String(hostMemMB)}).`,
    );
  }
  const maxMemoryMB = Math.floor(hostMemMB * MATCHLOCK_MAX_MEMORY_HOST_FRACTION);

  // cpus: explicit > env > min(8, host).
  let cpus: number;
  let cpusSource: MatchlockResourceLimitSource;
  if (!isAbsent(params.cpus)) {
    cpus = parsePositiveInteger(params.cpus as string | number, "--matchlock-cpus");
    cpusSource = "flag";
  } else if (!isAbsent(env[MATCHLOCK_CPUS_ENV])) {
    cpus = parsePositiveInteger(env[MATCHLOCK_CPUS_ENV] as string, "TAMANDUA_MATCHLOCK_CPUS");
    cpusSource = "env";
  } else {
    cpus = Math.min(MATCHLOCK_DEFAULT_CPUS_CAP, hostCpus);
    cpusSource = "default";
  }
  cpus = Math.min(cpus, MATCHLOCK_MAX_CPUS, hostCpus);

  // memory: explicit > env > min(16384, 50% host).
  let memoryMB: number;
  let memorySource: MatchlockResourceLimitSource;
  if (!isAbsent(params.memoryMB)) {
    memoryMB = parseSizeMB(params.memoryMB as string | number, "--matchlock-memory");
    memorySource = "flag";
  } else if (!isAbsent(env[MATCHLOCK_MEMORY_ENV])) {
    memoryMB = parseSizeMB(env[MATCHLOCK_MEMORY_ENV] as string, "TAMANDUA_MATCHLOCK_MEMORY_MB");
    memorySource = "env";
  } else {
    memoryMB = Math.min(MATCHLOCK_DEFAULT_MEMORY_CAP_MB, Math.floor(hostMemMB * MATCHLOCK_DEFAULT_MEMORY_HOST_FRACTION));
    memorySource = "default";
  }
  memoryMB = Math.min(memoryMB, maxMemoryMB);

  // disk: explicit > env > 20480 (no upper cap beyond finite positive).
  let diskSizeMB: number;
  let diskSource: MatchlockResourceLimitSource;
  if (!isAbsent(params.diskSizeMB)) {
    diskSizeMB = parseSizeMB(params.diskSizeMB as string | number, "--matchlock-disk");
    diskSource = "flag";
  } else if (!isAbsent(env[MATCHLOCK_DISK_ENV])) {
    diskSizeMB = parseSizeMB(env[MATCHLOCK_DISK_ENV] as string, "TAMANDUA_MATCHLOCK_DISK_MB");
    diskSource = "env";
  } else {
    diskSizeMB = MATCHLOCK_DEFAULT_DISK_MB;
    diskSource = "default";
  }

  // swap: --matchlock-no-swap > explicit flag > env (`off` or size) > 8192.
  // There is deliberately NO host-derived clamp: swap is a sparse disk file,
  // not reserved RAM, so the memory host-fractions do not apply.
  let swapMB: number;
  let swapSource: MatchlockResourceLimitSource;
  if (params.noSwap === true) {
    swapMB = 0;
    swapSource = "flag";
  } else if (!isAbsent(params.swapMB)) {
    swapMB = parseSwapMB(params.swapMB as string | number, "--matchlock-swap");
    swapSource = "flag";
  } else if (!isAbsent(env[MATCHLOCK_SWAP_ENV])) {
    const rawSwapEnv = env[MATCHLOCK_SWAP_ENV] as string;
    swapMB = rawSwapEnv.trim().toLowerCase() === "off"
      ? 0
      : parseSwapMB(rawSwapEnv, MATCHLOCK_SWAP_ENV);
    swapSource = "env";
  } else {
    swapMB = MATCHLOCK_DEFAULT_SWAP_MB;
    swapSource = "default";
  }

  return {
    cpus,
    memoryMB,
    diskSizeMB,
    swapMB,
    sources: {
      cpus: cpusSource,
      memoryMB: memorySource,
      diskSizeMB: diskSource,
      swapMB: swapSource,
    },
  };
}

/**
 * The limits + optional display provenance the shared Matchlock summary line
 * carries. `swapMB`/`imageSource` are optional so a caller that predates the
 * slice-2 output contract (e.g. the `workflow status` renderer before its own
 * story) keeps its previous line; the launch path always supplies both.
 */
export type MatchlockResourceSummaryLimits = Pick<
  MatchlockResourceLimits,
  "cpus" | "memoryMB" | "diskSizeMB"
> & {
  /** Guest swap size in MB; `0` renders `swap=off`. Omitted → no swap segment. */
  swapMB?: number;
  /** Effective image provenance; `"standard"` renders ` (standard image)`. */
  imageSource?: "explicit" | "standard";
};

/**
 * Canonical launch/status line for resolved limits (SHARED-V3 §4.6):
 * `matchlock: <image>[ (standard image)] cpus=<n> memory=<MB>MB disk=<MB>MB
 *  swap=<n>MB|off[ allow-private=<entry,...>]`.
 *
 * `(standard image)` is emitted only for `imageSource === "standard"`.
 * `swapMB` renders as `swap=<n>MB` for a positive size and `swap=off` for 0.
 * Byte-identity: only a caller that omits `swapMB`/`imageSource` (the
 * not-yet-migrated status renderer) keeps the old narrower line; an opted-in
 * launch always carries both, and a NATIVE run emits no `matchlock:` line at
 * all.
 *
 * MTLK-ALLOW-PRIVATE (US-006): when the run admitted a non-empty allow-private
 * destination list, the resolved entries are appended as
 * ` allow-private=<comma-separated entries>`. An absent or empty list appends
 * nothing.
 */
export function formatMatchlockResourceSummary(
  image: string,
  limits: MatchlockResourceSummaryLimits,
  allowPrivate?: readonly string[],
): string {
  const standardSuffix = limits.imageSource === "standard" ? " (standard image)" : "";
  const swapSegment =
    limits.swapMB === undefined
      ? ""
      : ` swap=${limits.swapMB > 0 ? `${limits.swapMB}MB` : "off"}`;
  let summary = `matchlock: ${image}${standardSuffix} cpus=${limits.cpus} memory=${limits.memoryMB}MB disk=${limits.diskSizeMB}MB${swapSegment}`;
  if (allowPrivate && allowPrivate.length > 0) {
    summary += ` allow-private=${allowPrivate.join(",")}`;
  }
  return summary;
}
