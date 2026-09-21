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

/** Resolved Matchlock VM resource limits. */
export interface MatchlockResourceLimits {
  cpus: number;
  memoryMB: number;
  diskSizeMB: number;
}

/** Where a single resolved field's value came from. */
export type MatchlockResourceLimitSource = "flag" | "env" | "default";

/** Resolved limits plus the per-field provenance. */
export interface ResolvedMatchlockResourceLimits extends MatchlockResourceLimits {
  sources: {
    cpus: MatchlockResourceLimitSource;
    memoryMB: MatchlockResourceLimitSource;
    diskSizeMB: MatchlockResourceLimitSource;
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

  return {
    cpus,
    memoryMB,
    diskSizeMB,
    sources: {
      cpus: cpusSource,
      memoryMB: memorySource,
      diskSizeMB: diskSource,
    },
  };
}

/**
 * Canonical launch/status line for resolved limits:
 * `matchlock: <image> cpus=<n> memory=<MB>MB disk=<MB>MB`.
 */
export function formatMatchlockResourceSummary(image: string, limits: MatchlockResourceLimits): string {
  return `matchlock: ${image} cpus=${limits.cpus} memory=${limits.memoryMB}MB disk=${limits.diskSizeMB}MB`;
}
