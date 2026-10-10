/**
 * MTLK-INTERACTIVE (US-002) — argument parser for the foreground interactive
 * Matchlock commands:
 *
 *   tamandua matchlock pi          [--working-directory-for-harness <dir>] [Matchlock options]
 *   tamandua matchlock pi-shell    [--working-directory-for-harness <dir>] [Matchlock options]
 *   tamandua matchlock hermes      [--working-directory-for-harness <dir>] [Matchlock options]
 *   tamandua matchlock hermes-shell[--working-directory-for-harness <dir>] [Matchlock options]
 *
 * This module is deliberately a THIN adapter over the shipped slice-1
 * primitives: image selection (`resolveMatchlockImageReference`), resource
 * resolution (`resolveMatchlockResourceLimits` / `parseSwapMB`) and
 * allow-private shape validation (`validateAllowPrivateEntry` /
 * `normalizeAllowPrivateEntries`) are reused verbatim, so the interactive path
 * cannot drift from the workflow path. It owns ONLY the interactive-specific
 * grammar: the four subcommands, the redundant bare `--matchlock`, the
 * `--working-directory-for-harness` resolution and the strict unknown-option
 * refusals.
 *
 * The subcommand itself supplies the isolation opt-in, so every parsed
 * invocation is a Matchlock run; there is no native fallback and bare
 * `--matchlock` is accepted only as a redundant no-op.
 *
 * Node-core only (`node:fs`, `node:path`) plus the pure Matchlock leaf modules
 * — no `node:child_process` — so it and its tests stay in the parallel lane.
 */

import fs from "node:fs";
import path from "node:path";

import {
  MATCHLOCK_ALLOW_PRIVATE_ENV,
  normalizeAllowPrivateEntries,
  validateAllowPrivateEntry,
} from "../installer/matchlock/allow-private.js";
import {
  parseSwapMB,
  resolveMatchlockResourceLimits,
  type MatchlockResourceHostProbe,
  type ResolvedMatchlockResourceLimits,
} from "../installer/matchlock/resource-limits.js";
import {
  resolveMatchlockImageReference,
  type MatchlockImageSource,
} from "../installer/matchlock/standard-image.js";
import {
  MATCHLOCK_NO_PRIVILEGED_FLAG,
  MATCHLOCK_PRIORITIZE_IPV4_FLAG,
  MATCHLOCK_PRIORITIZE_IPV6_FLAG,
  resolveMatchlockDnsPriority,
  resolveMatchlockPrivileged,
  type ResolvedMatchlockDnsPriority,
  type ResolvedMatchlockPrivileged,
} from "../installer/matchlock/isolation-settings.js";
import { MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG } from "../installer/matchlock/root-gate.js";

// Re-export the canonical R13 flag from the gate that owns the refusal naming
// it, so the parser and the gate can never drift on the spelling.
export { MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG };

/** The four interactive subcommands (order is the documented order). */
export const INTERACTIVE_SESSION_SUBCOMMANDS = [
  "pi",
  "pi-shell",
  "hermes",
  "hermes-shell",
] as const;

export type InteractiveSessionSubcommand = (typeof INTERACTIVE_SESSION_SUBCOMMANDS)[number];

/** Selected harness for a subcommand: the shell variants prepare the same guest. */
export type InteractiveSessionHarness = "pi" | "hermes";

const WORKING_DIRECTORY_FLAG = "--working-directory-for-harness";
const MATCHLOCK_ALLOW_PRIVATE_FLAG = "--matchlock-allow-private";
const MATCHLOCK_IMAGE_FLAG = "--matchlock-image";
const MATCHLOCK_NO_SWAP_FLAG = "--matchlock-no-swap";

/** Value-bearing singleton flags mapped to the field they populate. */
type InteractiveValueField =
  | "image"
  | "cpus"
  | "memory"
  | "disk"
  | "swap"
  | "workingDirectory";

const VALUE_FLAG_TO_FIELD: Record<string, InteractiveValueField> = {
  [MATCHLOCK_IMAGE_FLAG]: "image",
  "--matchlock-cpus": "cpus",
  "--matchlock-memory": "memory",
  "--matchlock-disk": "disk",
  "--matchlock-swap": "swap",
  [WORKING_DIRECTORY_FLAG]: "workingDirectory",
};

/**
 * Every option the interactive parser accepts. A next-token value that is one
 * of these is an option, never a flag value (missing-value guard).
 */
const KNOWN_FLAGS = new Set<string>([
  "--matchlock",
  MATCHLOCK_IMAGE_FLAG,
  "--matchlock-cpus",
  "--matchlock-memory",
  "--matchlock-disk",
  "--matchlock-swap",
  MATCHLOCK_NO_SWAP_FLAG,
  MATCHLOCK_ALLOW_PRIVATE_FLAG,
  MATCHLOCK_NO_PRIVILEGED_FLAG,
  MATCHLOCK_PRIORITIZE_IPV4_FLAG,
  MATCHLOCK_PRIORITIZE_IPV6_FLAG,
  MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG,
  WORKING_DIRECTORY_FLAG,
]);

/**
 * Typed usage error for the interactive subcommands. Plain `Error` subclass so
 * the CLI dispatcher can print it and exit non-zero like every other usage
 * error in the repo.
 */
export class InteractiveSessionArgError extends Error {
  readonly code = "interactive_session_arg_invalid";

  constructor(message: string) {
    super(message);
    this.name = "InteractiveSessionArgError";
  }
}

/** Resolved interactive invocation, aligned with `MatchlockAdmissionOptions`. */
export interface InteractiveSessionArgs {
  /** The subcommand as spelled by the operator. */
  subcommand: InteractiveSessionSubcommand;
  /** Selected harness (pi or hermes); shells share the harness guest. */
  harness: InteractiveSessionHarness;
  /** True for the `*-shell` variants (launch zsh instead of the harness). */
  shell: boolean;
  /** Absolute, existing working directory mounted read-write at this path. */
  workingDirectory: string;
  /** Effective image reference (explicit > env > standard), unmodified bare. */
  image: string;
  /** Provenance of {@link image}: "explicit" or "standard". */
  imageSource: MatchlockImageSource;
  /** Resolved/clamped VM limits plus per-field provenance. */
  resourceLimits: ResolvedMatchlockResourceLimits;
  /** True only when the exact root-usage override flag was supplied here. */
  rootUsageOverride: boolean;
  /** Normalized, shape-validated allow-private list (empty when none). */
  allowPrivate: string[];
  /**
   * ICEBOX Pillar B: the resolved whole-VM privilege setting + source
   * (opt-out flag > TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1 > default ON).
   */
  matchlockPrivileged: ResolvedMatchlockPrivileged;
  /**
   * ICEBOX DNS: the resolved guest-resolver address-family preference +
   * source (ipv6 flag > ipv4 flag > TAMANDUA_MATCHLOCK_DNS_PRIORITY > default
   * ipv4; both flags => ipv6, never an error).
   */
  matchlockDnsPriority: ResolvedMatchlockDnsPriority;
}

/** Injectable inputs for deterministic tests; production callers omit these. */
export interface ParseInteractiveSessionArgsOptions {
  /**
   * Invoking directory used as the default working directory and as the base
   * for resolving a relative `--working-directory-for-harness`. Defaults to
   * `process.cwd()`.
   */
  cwd?: string;
  /**
   * Environment snapshot for the image/resource/allow-private defaults.
   * Defaults to `process.env` (production).
   */
  env?: Record<string, string | undefined>;
  /** Host capacity probe override (deterministic tests). */
  hostProbe?: MatchlockResourceHostProbe;
}

const SUBCOMMAND_REGISTRY: Record<
  InteractiveSessionSubcommand,
  { harness: InteractiveSessionHarness; shell: boolean }
> = {
  pi: { harness: "pi", shell: false },
  "pi-shell": { harness: "pi", shell: true },
  hermes: { harness: "hermes", shell: false },
  "hermes-shell": { harness: "hermes", shell: true },
};

function isInteractiveSessionSubcommand(v: string): v is InteractiveSessionSubcommand {
  return Object.prototype.hasOwnProperty.call(SUBCOMMAND_REGISTRY, v);
}

function missingValue(flag: string): InteractiveSessionArgError {
  return new InteractiveSessionArgError(`Missing value for ${flag}. Use ${flag} <value>.`);
}

function nextTokenIsKnownFlag(value: string): boolean {
  return value.startsWith("--") && KNOWN_FLAGS.has(value.split("=")[0]);
}

/**
 * Resolve `--working-directory-for-harness` (or the default) to an absolute,
 * existing directory. A relative argument is resolved against `cwd`; a
 * relative argument that escapes `cwd` (e.g. `..`) is refused. Absolute
 * arguments are accepted as-is (still required to exist and be a directory).
 */
function resolveInteractiveWorkingDirectory(raw: string | undefined, cwd: string): string {
  const base = path.resolve(cwd);
  if (raw === undefined) return base;

  const supplied = raw.trim();
  if (supplied === "") throw missingValue(WORKING_DIRECTORY_FLAG);

  const absolute = path.isAbsolute(supplied);
  const resolved = path.resolve(base, supplied);

  if (!absolute) {
    const relative = path.relative(base, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new InteractiveSessionArgError(
        `${WORKING_DIRECTORY_FLAG} must not escape the invoking directory: ${JSON.stringify(supplied)}.`,
      );
    }
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new InteractiveSessionArgError(
        `${WORKING_DIRECTORY_FLAG} does not exist: ${JSON.stringify(supplied)}.`,
      );
    }
    throw err;
  }
  if (!stats.isDirectory()) {
    throw new InteractiveSessionArgError(
      `${WORKING_DIRECTORY_FLAG} must be a directory: ${JSON.stringify(supplied)}.`,
    );
  }
  return resolved;
}

/**
 * Validate + normalize a raw allow-private list with the shared shape rules.
 * Every invalid entry is refused with the shared reason, which names the
 * offending value; blanks and duplicates are dropped by the shared normalizer.
 */
function resolveInteractiveAllowPrivate(entries: readonly string[], source: string): string[] {
  const normalized = normalizeAllowPrivateEntries(entries);
  for (const entry of normalized) {
    const result = validateAllowPrivateEntry(entry);
    if (!result.ok) {
      throw new InteractiveSessionArgError(`${source}: ${result.reason}`);
    }
  }
  return normalized;
}

/**
 * Parse the argv slice for one interactive subcommand. `args` excludes the
 * subcommand word itself. Throws {@link InteractiveSessionArgError} on any
 * usage error and propagates `MatchlockResourceLimitError` for an invalid
 * resource value (both are non-zero exits at the CLI boundary).
 */
export function parseInteractiveSessionArgs(
  subcommand: string,
  args: readonly string[],
  options: ParseInteractiveSessionArgsOptions = {},
): InteractiveSessionArgs {
  if (!isInteractiveSessionSubcommand(subcommand)) {
    throw new InteractiveSessionArgError(
      `Unknown matchlock subcommand ${JSON.stringify(subcommand)}. ` +
        `Expected one of: ${INTERACTIVE_SESSION_SUBCOMMANDS.join(", ")}.`,
    );
  }
  const selection = SUBCOMMAND_REGISTRY[subcommand];

  const env = options.env ?? process.env;
  const rawValues: Partial<Record<InteractiveValueField, string>> = {};
  const allowPrivateEntries: string[] = [];
  let allowPrivateSupplied = false;
  let noSwapSeen = false;
  let rootUsageOverride = false;
  // ICEBOX isolation settings: three pure booleans (never consume a
  // following token), resolved AFTER the loop so the two DNS flags are
  // order-independent (ipv6 wins when both are supplied).
  let noPrivilegedSeen = false;
  let ipv4PrioritySeen = false;
  let ipv6PrioritySeen = false;

  const assignValue = (field: InteractiveValueField, flag: string, rawValue: string): void => {
    if (rawValues[field] !== undefined) {
      throw new InteractiveSessionArgError(
        `Duplicate ${flag}. Specify ${flag} at most once.`,
      );
    }
    const value = rawValue.trim();
    if (value === "") throw missingValue(flag);
    if (nextTokenIsKnownFlag(value)) {
      throw new InteractiveSessionArgError(
        `Missing value for ${flag}. The next token ${JSON.stringify(value)} is an option, not a value.`,
      );
    }
    if (field === "swap") {
      if (noSwapSeen) {
        throw new InteractiveSessionArgError(
          `Cannot specify both ${flag} and ${MATCHLOCK_NO_SWAP_FLAG}. Choose one swap policy.`,
        );
      }
      // Parse-time rejection of `0`, over-cap, negative, fractional and
      // non-numeric sizes via the shared swap parser.
      parseSwapMB(value, flag);
    }
    rawValues[field] = value;
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    // The subcommand already opts into isolation; bare --matchlock is redundant.
    if (token === "--matchlock") continue;

    // A value-bearing --matchlock (equals form) is a hard error naming the
    // real image flag; never silently ignore the value.
    if (token.startsWith("--matchlock=")) {
      throw new InteractiveSessionArgError(
        "--matchlock takes no value. Use --matchlock-image <image> to name an image.",
      );
    }

    // Repeatable allow-private (space and equals forms).
    if (token === MATCHLOCK_ALLOW_PRIVATE_FLAG) {
      const value = args[i + 1];
      if (value === undefined || value.trim() === "" || nextTokenIsKnownFlag(value)) {
        throw missingValue(MATCHLOCK_ALLOW_PRIVATE_FLAG);
      }
      allowPrivateEntries.push(value.trim());
      allowPrivateSupplied = true;
      i++;
      continue;
    }
    if (token.startsWith(`${MATCHLOCK_ALLOW_PRIVATE_FLAG}=`)) {
      const value = token.slice(MATCHLOCK_ALLOW_PRIVATE_FLAG.length + 1).trim();
      if (value === "" || nextTokenIsKnownFlag(value)) {
        throw missingValue(MATCHLOCK_ALLOW_PRIVATE_FLAG);
      }
      allowPrivateEntries.push(value);
      allowPrivateSupplied = true;
      continue;
    }

    // Singleton value flags (space form).
    const field = VALUE_FLAG_TO_FIELD[token];
    if (field !== undefined) {
      const value = args[i + 1];
      if (value === undefined) throw missingValue(token);
      assignValue(field, token, value);
      i++;
      continue;
    }

    // Singleton value flags (equals form).
    const equalsFlag = Object.keys(VALUE_FLAG_TO_FIELD).find((flag) =>
      token.startsWith(`${flag}=`),
    );
    if (equalsFlag !== undefined) {
      assignValue(
        VALUE_FLAG_TO_FIELD[equalsFlag],
        equalsFlag,
        token.slice(equalsFlag.length + 1),
      );
      continue;
    }

    // Pure boolean swap-off switch; mutually exclusive with --matchlock-swap.
    if (token === MATCHLOCK_NO_SWAP_FLAG) {
      if (rawValues.swap !== undefined) {
        throw new InteractiveSessionArgError(
          `Cannot specify both ${MATCHLOCK_NO_SWAP_FLAG} and --matchlock-swap. Choose one swap policy.`,
        );
      }
      noSwapSeen = true;
      continue;
    }

    // The deliberate long root-usage override (a pure boolean).
    if (token === MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG) {
      rootUsageOverride = true;
      continue;
    }

    // ICEBOX Pillar B: the pure-boolean whole-VM privilege opt-out.
    if (token === MATCHLOCK_NO_PRIVILEGED_FLAG) {
      noPrivilegedSeen = true;
      continue;
    }

    // ICEBOX DNS: the two pure-boolean address-family preference flags.
    // Either may appear; when BOTH appear ipv6 wins (resolved after the
    // loop), so supplying both is never an error.
    if (token === MATCHLOCK_PRIORITIZE_IPV4_FLAG) {
      ipv4PrioritySeen = true;
      continue;
    }
    if (token === MATCHLOCK_PRIORITIZE_IPV6_FLAG) {
      ipv6PrioritySeen = true;
      continue;
    }

    if (token.startsWith("--")) {
      throw new InteractiveSessionArgError(
        `Unknown option ${JSON.stringify(token)} for tamandua matchlock ${subcommand}. ` +
          "Rejecting unknown options rather than forwarding arbitrary runtime flags.",
      );
    }
    if (token.length > 1 && token[0] === "-") {
      throw new InteractiveSessionArgError(
        `Unknown option ${JSON.stringify(token)} for tamandua matchlock ${subcommand}.`,
      );
    }

    throw new InteractiveSessionArgError(
      `Unexpected argument ${JSON.stringify(token)} for tamandua matchlock ${subcommand}.`,
    );
  }

  const image = resolveMatchlockImageReference({
    requested: true,
    explicitImage: rawValues.image,
    env,
  });
  if (image === undefined) {
    // Unreachable: `requested: true` always resolves a reference.
    throw new InteractiveSessionArgError("Failed to resolve the Matchlock image reference.");
  }

  const resourceLimits = resolveMatchlockResourceLimits({
    cpus: rawValues.cpus,
    memoryMB: rawValues.memory,
    diskSizeMB: rawValues.disk,
    swapMB: rawValues.swap,
    noSwap: noSwapSeen,
    env,
    hostProbe: options.hostProbe,
  });

  // CLI allow-private entries replace the env default list; the env default is
  // consulted only when no flag was supplied.
  const allowPrivate = allowPrivateSupplied
    ? resolveInteractiveAllowPrivate(allowPrivateEntries, MATCHLOCK_ALLOW_PRIVATE_FLAG)
    : resolveInteractiveAllowPrivate(
        env[MATCHLOCK_ALLOW_PRIVATE_ENV]?.split(",") ?? [],
        MATCHLOCK_ALLOW_PRIVATE_ENV,
      );

  // ICEBOX isolation settings, resolved ONCE here under the house
  // precedence. Both resolutions are pure: privileged is
  // flag > env(=1) > default ON; the DNS preference is ipv6 flag > ipv4 flag
  // > env > default ipv4. A malformed TAMANDUA_MATCHLOCK_DNS_PRIORITY is a
  // typed MatchlockIsolationSettingError — thrown ONLY when the env is
  // actually consulted (a winning flag is never defeated by the env).
  const matchlockPrivileged = resolveMatchlockPrivileged({
    noPrivilegedFlag: noPrivilegedSeen,
    env,
  });
  const matchlockDnsPriority = resolveMatchlockDnsPriority({
    ipv4Flag: ipv4PrioritySeen,
    ipv6Flag: ipv6PrioritySeen,
    env,
  });

  return {
    subcommand,
    harness: selection.harness,
    shell: selection.shell,
    workingDirectory: resolveInteractiveWorkingDirectory(rawValues.workingDirectory, options.cwd ?? process.cwd()),
    image: image.image,
    imageSource: image.source,
    resourceLimits,
    rootUsageOverride,
    allowPrivate,
    matchlockPrivileged,
    matchlockDnsPriority,
  };
}
