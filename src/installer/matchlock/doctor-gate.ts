/**
 * Matchlock host-side launch-gate doctor checks (G7 DOCTOR-GATE).
 *
 * This module exposes the launch gate to `tamandua doctor` so an operator can
 * learn, BEFORE launching, that a Matchlock hermes launch would refuse. It is
 * REPORT-ONLY by construction: it observes the same read-only facts the launch
 * path observes (profile selection, mount plan, store inventory, header bytes,
 * effective config) and renders them as {@link DoctorCheckResult}s. It never
 * writes a receipt, never converts a store, never writes configuration, never
 * creates a VM and never opens a database driver.
 *
 * AGREEMENT BY CONSTRUCTION: the checks are derived from the SAME
 * resolve + observe + evaluate functions the launch path calls. There is no
 * second implementation of the policy here — a doctor verdict that disagreed
 * with the gate would be a wiring bug, not a second opinion.
 *
 * WORDING is deliberately launch-scoped: "would refuse a Matchlock hermes
 * launch" / "would allow a Matchlock hermes launch". The gate is not an
 * integrity checker, so no message, remedy or name describes a store as
 * unsafe, broken or corrupt.
 *
 * US-001 covers the two foundations: the runtime store contract seed (from the
 * G1 store-control discovery) and the effective `database.journal_mode`
 * resolution that models the stock Hermes writer exactly (spec section 2a).
 *
 * US-002 composes the OBSERVATION side of the same path the launch takes:
 * resolve the effective interactive Hermes profile with the SAME resolver the
 * interactive launch path calls, build the SAME identical-path mount plan the
 * interactive create config builds for the profile home, resolve the store set
 * with `resolveStoreSet`, then observe every store's header bytes with
 * `observeStore` and adapt them with `adaptStoreObservation`. Nothing here
 * re-implements a gate decision or a store rule: the doctor sees exactly what
 * the launch path would see, which is what makes the eventual verdict agree by
 * construction.
 *
 * US-003 maps the pure evaluator verdict onto launch-scoped doctor checks. The
 * mapper is a presentation layer only: it calls {@link evaluateGate} on the
 * observations and renders the SAME findings the launch path would act on, so
 * doctor and gate agree by construction rather than by a second opinion.
 *
 * US-005 appends an INFORMATIONAL holder listing (spec sections 5 and 8): who
 * currently has an evaluated store open, named by pid, start identity and a
 * SANITIZED command description. Holder detection is informational only — it is
 * never a refusal, never a reason code, and it never changes the summary status
 * or `hasFailures` (the spec explicitly supersedes the earlier G6 acceptance
 * text that wanted a failed probe to surface as a refusal). A failed or
 * unavailable probe is RECORDED as an incomplete observation and reported as a
 * single `info` check.
 *
 * DEFAULT HOLDER PROBE (G6 wiring). The default probe is the REAL detector:
 * {@link createStoreHolderProbe} stats every evaluated store for its filesystem
 * identity and hands it to G6's `detectStoreHolders` through
 * `createDefaultHolderProbeDeps()` (procfs on Linux, the bounded lsof probe on
 * darwin). The listing stays informational: a probe that cannot observe (an
 * unsupported platform, an unreadable descriptor directory, a store whose
 * identity cannot be read) is RECORDED as an incomplete observation and
 * rendered as ONE `info` check — never a refusal, never a reason code and never
 * a summary change. Tests keep injecting a probe through the unchanged seam.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// Type-only, so the doctor module (which owns process spawning) never enters
// this module's runtime dependency graph and cannot form an import cycle.
import type { DoctorCheckResult } from "../../doctor.js";

import {
  detectStoreHolders,
  type HolderProbeDeps,
  type HolderStore,
} from "./store-holder-detect.js";
import { createDefaultHolderProbeDeps } from "./store-holder-detect-runner.js";
import {
  evaluateGate,
  type EvaluatedStore,
  type Finding,
  type GateInput,
  type StoreConfigObservation,
} from "./launch-gate.js";
import {
  resolveInteractiveHermesSelection,
  type InteractiveHermesSelection,
} from "./interactive-hermes-selection.js";
import { observeStore } from "./store-header.js";
import { adaptStoreObservation } from "./store-observation-adapter.js";
import {
  StoreSetInputError,
  resolveStoreSet,
  type RuntimeStoreContract,
  type StoreContractEntry,
  type StoreMountPlan,
  type StoreSet,
} from "./store-set.js";

// ---------------------------------------------------------------------------
// Store inventory contract
// ---------------------------------------------------------------------------

/**
 * The runtime store contract this gate seeds from the G1 store-control
 * discovery (docs/gate/G1-STORE-CONTROL-DISCOVERY.md).
 *
 * Classification is DERIVED FROM OBSERVED RUNTIME BEHAVIOUR, not from a
 * filename list: `state.db` is the only store the selected runtime always
 * opens. The other three belong to features that may be enabled
 * (`verify-on-stop`, `kanban`, `projects`), so they are `optional-present`:
 * they need not exist, but if they do exist their journal state is still
 * checked. `complete: true` is the attestation that this named set is the
 * whole set the discovery observed — an unresolvable profile home or a
 * contract that does not claim completeness makes the inventory incomplete,
 * which is a refusal in its own right.
 *
 * `trigger` is advisory receipt text only; nothing parses it.
 */
export const LAUNCH_GATE_STORE_CONTRACT: RuntimeStoreContract = {
  complete: true,
  entries: [
    {
      relativePath: "state.db",
      classification: "required",
      trigger: "core session state; always opened by the selected runtime",
    },
    {
      relativePath: "verification_evidence.db",
      classification: "optional-present",
      trigger: "opened only when verify-on-stop is enabled",
    },
    {
      relativePath: "kanban.db",
      classification: "optional-present",
      trigger: "opened only when the kanban feature is enabled",
    },
    {
      relativePath: "projects.db",
      classification: "optional-present",
      trigger: "opened only when the projects feature is enabled",
    },
  ],
} as const satisfies RuntimeStoreContract;

/** The contract entries, typed for callers that want to inspect them. */
export const LAUNCH_GATE_STORE_ENTRIES: readonly StoreContractEntry[] =
  LAUNCH_GATE_STORE_CONTRACT.entries;

// ---------------------------------------------------------------------------
// Effective journal mode (spec section 2a)
// ---------------------------------------------------------------------------

/** Inputs to {@link resolveEffectiveJournalMode}. */
export interface EffectiveJournalModeOptions {
  /**
   * Explicit managed-scope directory.
   *
   * - `undefined` (default): resolve it the way the runtime environment does —
   *   `$HERMES_MANAGED_DIR` when set and an existing directory, else
   *   `/etc/hermes` when it exists, else none.
   * - `null`: NO managed layer. Tests use this for determinism.
   * - a string: exactly that directory is the managed scope.
   */
  managedDir?: string | null;
  /**
   * Environment used to resolve `$HERMES_MANAGED_DIR`. Defaults to
   * `process.env`. `HERMES_JOURNAL_MODE` is never read from it: the stock
   * writer does not consult that variable, so neither does the gate.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The managed scope the observation used, plus how it was chosen. */
interface ManagedScope {
  /** Absolute managed-scope directory, or null when there is no managed layer. */
  dir: string | null;
  /** Bounded provenance text: never file contents, never parser messages. */
  provenance: string;
}

/** How the managed-scope directory is spelled in the default (no override) case. */
const DEFAULT_MANAGED_DIR = "/etc/hermes";

/** The managed-scope environment variable the runtime honours. */
const MANAGED_DIR_ENV = "HERMES_MANAGED_DIR";

/**
 * The environment variable the stock writer IGNORES. Named only so the source
 * text and the tests can be explicit that it is not an input.
 */
const IGNORED_JOURNAL_MODE_ENV = "HERMES_JOURNAL_MODE";

/** One layer's `database.journal_mode` leaf. */
type JournalModeLeaf =
  /** The layer is absent, or has no `database.journal_mode` leaf at all. */
  | { kind: "absent" }
  /** The file exists but cannot be read or parsed as a config mapping. */
  | { kind: "unreadable"; detail: string }
  /**
   * The layer supplies a leaf. `mode` is the value the writer would honour:
   * only the exact strings `delete`/`wal` after trim+lowercase are recognised,
   * and every other value fails safe to `wal`.
   */
  | { kind: "leaf"; mode: "delete" | "wal" };

/** True for errno shapes that mean "this path does not exist". */
function isAbsentError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** True when `candidate` exists and is a directory. */
function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the managed-scope layer exactly as the runtime environment does.
 *
 * An explicit `opts.managedDir` wins; `null` disables the layer. Otherwise
 * `$HERMES_MANAGED_DIR` counts only when it is set AND points at an existing
 * directory, then `/etc/hermes` when it exists, else there is no managed layer.
 */
function resolveManagedScope(
  opts: EffectiveJournalModeOptions | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ManagedScope {
  if (opts !== undefined && opts.managedDir !== undefined) {
    if (opts.managedDir === null) {
      return { dir: null, provenance: "explicitly disabled for this observation" };
    }
    return { dir: opts.managedDir, provenance: "explicit managed scope" };
  }

  const fromEnv = env[MANAGED_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0 && isDirectory(fromEnv)) {
    return {
      dir: fromEnv,
      provenance: `${MANAGED_DIR_ENV} names an existing directory`,
    };
  }

  if (isDirectory(DEFAULT_MANAGED_DIR)) {
    return { dir: DEFAULT_MANAGED_DIR, provenance: "default managed scope" };
  }

  return { dir: null, provenance: "none present" };
}

/**
 * Read one config layer's `database.journal_mode` leaf.
 *
 * The reader mirrors the stock Hermes resolver exactly:
 *
 *  - a missing file, a missing `database` section or a missing
 *    `database.journal_mode` key is NOT a value: the layer contributes nothing
 *    and an earlier layer's value survives;
 *  - a non-string or unrecognised value resolves FAIL-SAFE to `wal` — it never
 *    resolves to `delete`;
 *  - only the exact strings `delete`/`wal` after trim+lowercase are accepted
 *    (so `" DELETE "` and `"Wal"` are recognised, `"truncate"` is not);
 *  - an unreadable file, malformed YAML or a non-mapping document is
 *    `unreadable` — never silently `wal`. Inability to inspect a config the
 *    writer reads is a refusal, not a pass.
 */
function readJournalModeLeaf(configPath: string): JournalModeLeaf {
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (isAbsentError(error)) return { kind: "absent" };
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
    return { kind: "unreadable", detail: `unreadable:${code}` };
  }

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch {
    return { kind: "unreadable", detail: "unparseable-yaml" };
  }

  // An empty document (empty file / only comments) carries no leaf.
  if (document === null || document === undefined) return { kind: "absent" };

  if (typeof document !== "object" || Array.isArray(document)) {
    return { kind: "unreadable", detail: "not-a-mapping" };
  }

  const database = (document as Record<string, unknown>)["database"];
  if (database === undefined || database === null) return { kind: "absent" };
  if (typeof database !== "object" || Array.isArray(database)) {
    // A malformed `database` container cannot carry a usable leaf; the merged
    // config would not request `delete`, so this fails safe to `wal`.
    return { kind: "leaf", mode: "wal" };
  }

  const raw = (database as Record<string, unknown>)["journal_mode"];
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (typeof raw !== "string") return { kind: "leaf", mode: "wal" };

  const mode = raw.trim().toLowerCase();
  return { kind: "leaf", mode: mode === "delete" ? "delete" : "wal" };
}

/** Render a bounded source string naming the layers and their perspective. */
function renderSource(
  userConfigPath: string,
  managed: ManagedScope,
  extra: string | null,
): string {
  const managedText =
    managed.dir === null
      ? `managed scope: none (${managed.provenance})`
      : `managed scope: ${path.join(managed.dir, "config.yaml")} (${managed.provenance}; managed layer wins per leaf)`;
  const suffix = extra === null ? "" : `; ${extra}`;
  return (
    `host-observed: user config ${userConfigPath}, then ${managedText}` +
    `; ${IGNORED_JOURNAL_MODE_ENV} is not consulted by the writer or this observation` +
    suffix
  );
}

/**
 * Resolve the effective `database.journal_mode` the selected runtime reads for
 * one profile home.
 *
 * This is a faithful model of stock Hermes' `resolve_journal_mode()` over the
 * merged config (spec section 2a), observed from the HOST:
 *
 * 1. start at `wal`;
 * 2. apply `<profileHome>/config.yaml` (`database.journal_mode`) when present;
 * 3. apply the managed-scope overlay LAST, so the managed value wins per leaf.
 *
 * `HERMES_JOURNAL_MODE` is NEVER consulted: the writer ignores it, and honouring
 * it here would fail in the dangerous direction (admitting a store the writer
 * treats as WAL).
 *
 * The result is a pure observation: `readFileSync` only, no database driver, no
 * write, no clock, no randomness. An unreadable or unparseable layer yields
 * `journalMode: "unreadable"` with `observed: false` rather than a guessed
 * `wal`.
 *
 * The `source` string carries explicit provenance — it always contains
 * `host-observed` and names the managed scope (or states that there is none) —
 * so a receipt or doctor line cannot present this host-side reading as a
 * guest-side fact.
 */
export function resolveEffectiveJournalMode(
  profileHome: string,
  opts?: EffectiveJournalModeOptions,
): StoreConfigObservation {
  const env = opts?.env ?? process.env;
  const managed = resolveManagedScope(opts, env);

  const userConfigPath = path.join(profileHome, "config.yaml");
  const managedConfigPath =
    managed.dir === null ? null : path.join(managed.dir, "config.yaml");

  const layers: Array<{ name: string; configPath: string }> = [
    { name: "user config", configPath: userConfigPath },
  ];
  if (managedConfigPath !== null) {
    layers.push({
      name: `managed scope (${managed.provenance})`,
      configPath: managedConfigPath,
    });
  }

  let journalMode: "delete" | "wal" = "wal";
  for (const layer of layers) {
    const leaf = readJournalModeLeaf(layer.configPath);
    if (leaf.kind === "unreadable") {
      return {
        journalMode: "unreadable",
        source: renderSource(
          userConfigPath,
          managed,
          `${layer.name} could not be read (${leaf.detail})`,
        ),
        observed: false,
      };
    }
    if (leaf.kind === "leaf") {
      journalMode = leaf.mode;
    }
  }

  return {
    journalMode,
    source: renderSource(userConfigPath, managed, null),
    observed: true,
  };
}

// ---------------------------------------------------------------------------
// Launch-gate observation composition (spec section 1, steps 1-4)
// ---------------------------------------------------------------------------

/** Longest bounded diagnostic reason this module will produce, in characters. */
export const LAUNCH_GATE_REASON_MAX_LENGTH = 400;

/** The stage of the observation path that could not produce an observation. */
export type LaunchGateFailureStage = "selection" | "store-set";

/**
 * Inputs to {@link resolveLaunchGateObservations} and (later) the check mapper.
 *
 * `homeDir` / `cwd` / `hermesHomeEnv` are the FROZEN-submission stand-ins a
 * doctor run can supply: the interactive launch path resolves its profile from
 * the exact `{ homeDir, HERMES_HOME snapshot, cwd }` triple captured at run
 * creation, so doctor takes the same triple as arguments rather than reading
 * ambient state behind the caller's back. `hermesHomeEnv: null` (the default)
 * means "unset", i.e. `~/.hermes` under `homeDir` — it never silently picks up
 * an unrelated `HERMES_HOME` from the doctor process environment.
 *
 * Callers may override `storeContract` and `mountPlan`; they default to the
 * runtime contract seed and the identical-path interactive mount plan. `env`
 * and `managedDir` are passed through to the effective journal-mode observation
 * so a caller (and a test) can pin the managed config scope deterministically.
 */
export interface RunLaunchGateChecksOptions {
  /** Home directory the frozen submission was captured from. */
  homeDir?: string;
  /** Working directory the frozen submission was captured from. */
  cwd?: string;
  /** Raw `HERMES_HOME` snapshot, or `null` when unset at submission. */
  hermesHomeEnv?: string | null;
  /** Environment for managed-scope resolution; `HERMES_JOURNAL_MODE` is never read. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Explicit managed-scope directory, or `null` for no managed layer. */
  managedDir?: string | null;
  /** Override the runtime store contract (defaults to the seed above). */
  storeContract?: RuntimeStoreContract;
  /** Override the mount plan (defaults to the identical-path interactive plan). */
  mountPlan?: StoreMountPlan;
  /**
   * Informational store-holder probe (spec sections 5 and 8).
   *
   * Defaults to {@link listOpenFileHolders}, the REAL G6-backed probe built by
   * {@link createStoreHolderProbe} (stat each evaluated store, then
   * `detectStoreHolders` with the default runner deps). A probe that cannot
   * observe is recorded as an incomplete observation. Tests inject a probe here;
   * nothing about the verdict depends on it.
   */
  holderProbe?: StoreHolderProbe;
}

// ---------------------------------------------------------------------------
// Informational store-holder listing (spec sections 5 and 8)
// ---------------------------------------------------------------------------

/**
 * One process observed holding an evaluated store open.
 *
 * `description` is expected to be a SANITIZED command description; the renderer
 * sanitizes again (defense in depth), because process arguments can carry API
 * keys or tokens and spec section 8 forbids dumping raw argv.
 */
export interface StoreHolderCandidate {
  /** Process id of the holder. */
  pid: number;
  /** Kernel start identity (pid + start time), so a recycled pid is not implied. */
  startIdentity: string;
  /** Bounded, sanitized description of the command the holder runs. */
  description: string;
  /** Store paths the probe observed this holder as having open. */
  heldPaths?: readonly string[];
}

/** One reason the holder observation is incomplete. Informational only. */
export interface StoreHolderProbeFailure {
  /** What could not be probed (e.g. a store path or a probe scope). */
  scope: string;
  /** Bounded, sanitized reason. */
  reason: string;
}

/** The result of one holder probe over the evaluated store paths. */
export interface StoreHolderProbeResult {
  /** False whenever any probe scope could not be observed. */
  observationComplete: boolean;
  /** Holders the probe did observe (possibly an empty list). */
  candidates: readonly StoreHolderCandidate[];
  /** Every probe scope that could not be observed. */
  failures: readonly StoreHolderProbeFailure[];
}

/**
 * The structural holder-probe seam.
 *
 * This is the shape G6's `detectStoreHolders` call site needs from a caller: the
 * evaluated stores go in, observed holders plus every probe failure come out.
 * Nothing here decides a verdict; holder detection has no reason code because
 * the gate is NOT an ownership control (spec section 5).
 */
export type StoreHolderProbe = (
  storePaths: readonly string[],
) => StoreHolderProbeResult;

/** Scope name used when the probe itself could not run. */
export const HOLDER_PROBE_SCOPE = "holder-probe";

/** Longest sanitized holder description this module renders, in characters. */
export const HOLDER_DESCRIPTION_MAX_LENGTH = 200;

/** Errno code of a thrown filesystem error, when it has one. */
function statErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : "unknown";
}

/**
 * Build the REAL store-holder probe on top of G6's detector.
 *
 * The seam here is `(storePaths) => StoreHolderProbeResult`, while G6 wants the
 * filesystem IDENTITY of each store (`(dev, ino)` as DECIMAL STRINGS — a 64-bit
 * inode is lossy as a double), so each probe path is `statSync`ed with
 * `{ bigint: true }` and handed to `detectStoreHolders` together with the
 * injected `HolderProbeDeps`. G6 remains the authority for the identity match,
 * the sidecar rule, the redaction and the ordering; this factory only adapts
 * shapes (`holders` -> `candidates`, `probeFailures` -> `failures`).
 *
 * A store whose identity cannot be read is recorded as ONE
 * {@link StoreHolderProbeFailure} and never throws: inability to inspect is a
 * gap in the observation, never a silent "no holder" presented as complete.
 * The returned probe never throws for any probe outcome — that is what keeps a
 * holder listing informational and verdict-neutral (spec section 5).
 */
export function createStoreHolderProbe(
  depsFactory: () => HolderProbeDeps = () => createDefaultHolderProbeDeps(),
): StoreHolderProbe {
  return (storePaths) => {
    const stores: HolderStore[] = [];
    const failures: StoreHolderProbeFailure[] = [];

    for (const storePath of storePaths) {
      try {
        const stat = fs.statSync(storePath, { bigint: true });
        stores.push({
          canonicalPath: storePath,
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
        });
      } catch (error) {
        failures.push({
          scope: storePath,
          reason: `store identity could not be read (${statErrorCode(error)})`,
        });
      }
    }

    // `detectStoreHolders` never throws for a probe outcome: a throwing or
    // malformed deps probe becomes a recorded probeFailure with
    // `observationComplete: false`, which is exactly the incomplete-observation
    // shape this seam reports. With an empty store list it calls no deps probe
    // at all (that is a complete observation of no holders).
    const detection = detectStoreHolders(stores, depsFactory());

    return {
      observationComplete:
        detection.observationComplete && failures.length === 0,
      candidates: detection.holders.map((holder) => ({
        pid: holder.pid,
        startIdentity: holder.startIdentity,
        description: holder.commandDescription,
        heldPaths: holder.storePaths,
      })),
      failures: [
        ...failures,
        ...detection.probeFailures.map((failure) => ({
          scope: failure.scope,
          reason: failure.reason,
        })),
      ],
    };
  };
}

/**
 * The default holder probe: the real G6-backed detector.
 *
 * It stats each evaluated store and delegates the process enumeration and match
 * to `detectStoreHolders` with `createDefaultHolderProbeDeps()`. A probe that
 * cannot observe (unsupported platform, unreadable descriptors, unreadable
 * store identity) is recorded as an incomplete observation and rendered as ONE
 * `info` check; it is never a refusal (spec section 5). The probe only reads
 * process and file metadata — it opens no database driver, takes no lock and
 * signals nothing — so the doctor's report-only guarantee is unaffected.
 */
export const listOpenFileHolders: StoreHolderProbe = createStoreHolderProbe();

/**
 * Sanitize a command description for display (spec section 8).
 *
 * Process arguments can carry credentials, so anything credential-shaped is
 * redacted, whitespace is collapsed, and pattern-kill advice is never echoed
 * (the gate must not emit `pkill`/pattern-kill text). The result is bounded so
 * one line cannot dump a whole command line.
 */
export function sanitizeHolderDescription(description: string): string {
  let text = description.replace(/\s+/g, " ").trim();
  text = text
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, "sk-<redacted>")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer <redacted>")
    .replace(
      /\b(token|key|secret|password|authorization|apikey|api_key)(\s*[=:]\s*)[^\s&;,]+/gi,
      "$1$2<redacted>",
    );
  // Never echo pattern-kill advice from a probe description.
  text = text.replace(/\b(pkill|killall)\b[^|]*/gi, "<pattern-kill removed>");
  if (text.length > HOLDER_DESCRIPTION_MAX_LENGTH) {
    text = `${text.slice(0, HOLDER_DESCRIPTION_MAX_LENGTH - 1)}\u2026`;
  }
  return text;
}

/** Bound an arbitrary probe failure reason to one sanitized, short line. */
function boundedHolderReason(reason: string): string {
  const text = sanitizeHolderDescription(reason);
  if (text.length === 0) return "no reason was recorded";
  return text;
}

/** The canonical paths of the stores that were actually observed as present. */
function presentStorePaths(storeSet: StoreSet | null): string[] {
  if (storeSet === null) return [];
  const paths: string[] = [];
  for (const identity of storeSet.stores) {
    if (identity.resolution !== "resolved") continue;
    const storePath = identity.canonicalPath ?? identity.pathAliases[0];
    if (typeof storePath !== "string" || storePath.length === 0) continue;
    if (!paths.includes(storePath)) paths.push(storePath);
  }
  return paths.sort();
}

/** A normalized holder observation, plus whether it is complete. */
interface NormalizedHolderObservation {
  observationComplete: boolean;
  candidates: StoreHolderCandidate[];
  failures: StoreHolderProbeFailure[];
}

/**
 * Run the holder probe (if there is anything to probe) and normalize its result.
 *
 * A throwing probe, or a result that is not shaped like one, becomes an
 * INCOMPLETE observation with a bounded recorded reason. It never throws out of
 * the doctor check and never becomes a refusal.
 */
function observeStoreHolders(
  storePaths: readonly string[],
  probe: StoreHolderProbe | undefined,
): NormalizedHolderObservation {
  if (storePaths.length === 0) {
    return { observationComplete: true, candidates: [], failures: [] };
  }

  let result: StoreHolderProbeResult;
  try {
    result = (probe ?? listOpenFileHolders)(storePaths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      observationComplete: false,
      candidates: [],
      failures: [
        { scope: HOLDER_PROBE_SCOPE, reason: boundedHolderReason(message) },
      ],
    };
  }

  if (
    result === null ||
    typeof result !== "object" ||
    !Array.isArray(result.candidates) ||
    !Array.isArray(result.failures)
  ) {
    return {
      observationComplete: false,
      candidates: [],
      failures: [
        {
          scope: HOLDER_PROBE_SCOPE,
          reason: "the holder probe returned an unusable result",
        },
      ],
    };
  }

  const candidates: StoreHolderCandidate[] = [];
  for (const candidate of result.candidates) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      typeof candidate.pid !== "number" ||
      !Number.isFinite(candidate.pid) ||
      typeof candidate.description !== "string"
    ) {
      continue;
    }
    candidates.push({
      pid: candidate.pid,
      startIdentity:
        typeof candidate.startIdentity === "string" && candidate.startIdentity.length > 0
          ? candidate.startIdentity
          : "unknown",
      description: candidate.description,
      heldPaths: Array.isArray(candidate.heldPaths)
        ? (candidate.heldPaths as readonly unknown[]).filter(
            (value): value is string => typeof value === "string",
          )
        : undefined,
    });
  }

  const failures: StoreHolderProbeFailure[] = [];
  for (const failure of result.failures) {
    if (failure === null || typeof failure !== "object") continue;
    const scope = typeof failure.scope === "string" ? failure.scope : HOLDER_PROBE_SCOPE;
    const reason = typeof failure.reason === "string" ? failure.reason : "";
    failures.push({ scope: sanitizeHolderDescription(scope), reason: boundedHolderReason(reason) });
  }

  const observationComplete = result.observationComplete === true && failures.length === 0;
  if (!observationComplete && failures.length === 0) {
    failures.push({
      scope: HOLDER_PROBE_SCOPE,
      reason: "the holder observation was reported incomplete without a recorded reason",
    });
  }

  return { observationComplete, candidates, failures };
}

/** Render one holder's informational message. */
function renderHolderMessage(
  holder: StoreHolderCandidate,
  probedPaths: readonly string[],
): string {
  const declared = (holder.heldPaths ?? []).filter((value) => probedPaths.includes(value));
  const held = declared.length > 0 ? declared : probedPaths;
  return (
    `holder pid ${holder.pid}; start identity ${sanitizeHolderDescription(holder.startIdentity)}; ` +
    `command: ${sanitizeHolderDescription(holder.description)}; ` +
    `holds ${held.map((value) => sanitizeHolderDescription(value)).join(", ")}`
  );
}

/** Render the ONE informational check that records an incomplete observation. */
function renderHolderIncompleteCheck(
  failures: readonly StoreHolderProbeFailure[],
): DoctorCheckResult {
  return {
    name: LAUNCH_GATE_HOLDER_OBSERVATION_CHECK_NAME,
    status: "info",
    message:
      "store holder observation was incomplete, so any holders listed here are " +
      `partial: ${failures.map((failure) => `${failure.scope}: ${failure.reason}`).join(" | ")}`,
  };
}

/**
 * The assembled observation the check mapper consumes. `candidate: false`
 * means the profile is not a hermes-under-Matchlock launch at all, so nothing
 * was evaluated; `failureStage` names the step that could not produce an
 * observation (a store-set input failure still leaves `candidate: true`).
 */
export interface LaunchGateObservations {
  /** True only when the profile resolved to an interactive Hermes selection. */
  candidate: boolean;
  /** Bounded diagnostic when the path could not be observed; null on success. */
  reason: string | null;
  /** The stage that produced `reason`; null when nothing failed. */
  failureStage: LaunchGateFailureStage | null;
  /** The resolved selection (the SAME resolver the launch path calls). */
  selection: InteractiveHermesSelection | null;
  /** The mount plan the runtime would use for the profile home. */
  mountPlan: StoreMountPlan | null;
  /** The resolved inventory, including its doubts. */
  storeSet: StoreSet | null;
  /** The evaluator input; null when the observation path could not finish. */
  gateInput: GateInput | null;
  /** The single per-profile effective journal-mode observation. */
  config: StoreConfigObservation | null;
}

/**
 * The interactive Hermes store mount plan for one effective profile home.
 *
 * This is the rule `buildInteractiveSessionCreateConfig` applies (the config
 * directory is mounted RW at its IDENTICAL absolute host path, never relocated
 * to the workflow guest configuration root), reduced to the only part the store
 * inventory needs: guest destination `hostEffectiveDir` sourced from the same
 * absolute `hostEffectiveDir`. Keeping it as data — never a relocation, never
 * a substitution — is what lets `resolveStoreSet` prove the plan covers the
 * profile home it observes.
 */
export function interactiveStoreMountPlan(
  hostEffectiveDir: string,
): StoreMountPlan {
  return {
    mounts: {
      [hostEffectiveDir]: { host_path: hostEffectiveDir },
    },
  };
}

/** Bound a diagnostic: one line, whitespace collapsed, never the whole message. */
function boundedFailure(
  stage: LaunchGateFailureStage,
  error: unknown,
): string {
  const code =
    typeof (error as { code?: unknown } | null)?.code === "string"
      ? ((error as { code: string }).code)
      : "unknown";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const text = `${stage}: ${code}: ${rawMessage.replace(/\s+/g, " ").trim()}`;
  if (text.length <= LAUNCH_GATE_REASON_MAX_LENGTH) return text;
  return `${text.slice(0, LAUNCH_GATE_REASON_MAX_LENGTH - 1)}\u2026`;
}

/** An observation result that stopped before evaluating anything. */
function emptyObservations(
  candidate: boolean,
  reason: string,
  failureStage: LaunchGateFailureStage,
  selection: InteractiveHermesSelection | null,
  mountPlan: StoreMountPlan | null,
  config: StoreConfigObservation | null,
): LaunchGateObservations {
  return {
    candidate,
    reason,
    failureStage,
    selection,
    mountPlan,
    storeSet: null,
    gateInput: null,
    config,
  };
}

/**
 * Resolve the profile, mount plan, store set and per-store byte observations the
 * launch gate evaluates — the observation half of the launch path, without any
 * decision, write or VM.
 *
 * Ordering matters and is fail-closed:
 *
 * 1. the effective interactive Hermes selection is resolved through the SAME
 *    `resolveInteractiveHermesSelection` the interactive launch path calls. A
 *    refusal is NOT a gate verdict: it means there is no hermes-under-Matchlock
 *    launch to evaluate, so it returns `candidate: false` with a bounded reason
 *    and performs NO store observation at all;
 * 2. the mount plan is the identical-path interactive plan (unless supplied);
 * 3. the store set is resolved through `resolveStoreSet`; a
 *    {@link StoreSetInputError} becomes a bounded failure (`candidate` stays
 *    true — the profile IS a candidate, the inventory just could not be built);
 * 4. every store identity is observed with `observeStore` (raw bytes only) and
 *    adapted with `adaptStoreObservation`, carrying the single per-profile
 *    effective journal-mode observation and the store's own identity fields.
 *
 * No database driver is opened, no receipt is written, no config is converted
 * and no VM is created.
 */
export function resolveLaunchGateObservations(
  opts: RunLaunchGateChecksOptions = {},
): LaunchGateObservations {
  const homeDir = opts.homeDir ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();

  let selection: InteractiveHermesSelection;
  try {
    selection = resolveInteractiveHermesSelection({
      homeDir,
      cwd,
      hermesHomeEnv: opts.hermesHomeEnv ?? null,
    });
  } catch (error) {
    return emptyObservations(
      false,
      boundedFailure("selection", error),
      "selection",
      null,
      null,
      null,
    );
  }

  const mountPlan =
    opts.mountPlan ?? interactiveStoreMountPlan(selection.hostEffectiveDir);

  const journalModeOptions: EffectiveJournalModeOptions = {};
  if (opts.env !== undefined) journalModeOptions.env = opts.env;
  if (opts.managedDir !== undefined) journalModeOptions.managedDir = opts.managedDir;
  const config = resolveEffectiveJournalMode(
    selection.hostEffectiveDir,
    journalModeOptions,
  );

  let storeSet: StoreSet;
  try {
    storeSet = resolveStoreSet({
      profileHome: selection.hostEffectiveDir,
      mountPlan,
      storeContract: opts.storeContract ?? LAUNCH_GATE_STORE_CONTRACT,
    });
  } catch (error) {
    const stage: LaunchGateFailureStage = "store-set";
    return emptyObservations(
      true,
      boundedFailure(stage, error),
      stage,
      selection,
      mountPlan,
      config,
    );
  }

  const stores: EvaluatedStore[] = storeSet.stores.map((identity) => {
    const requestedPath = identity.canonicalPath ?? identity.pathAliases[0];
    return adaptStoreObservation(
      observeStore(requestedPath),
      identity.classification,
      {
        config,
        dev: identity.dev,
        ino: identity.ino,
        fstype: identity.fstype,
      },
    );
  });

  return {
    candidate: true,
    reason: null,
    failureStage: null,
    selection,
    mountPlan,
    storeSet,
    gateInput: {
      inventoryComplete: storeSet.inventoryComplete,
      incompleteReasons: storeSet.incompleteReasons,
      stores,
    },
    config,
  };
}

// ---------------------------------------------------------------------------
// Doctor check mapping (spec section 9)
// ---------------------------------------------------------------------------

/** Name of the summary check, and of the not-a-candidate informational one. */
export const LAUNCH_GATE_SUMMARY_CHECK_NAME = "Matchlock hermes launch gate";

/** Name of the one check that carries set-scoped findings (e.g. inventory). */
export const LAUNCH_GATE_STORE_SET_CHECK_NAME =
  "Matchlock hermes launch gate (store set)";

/** Base name of the informational check listing one store holder. */
export const LAUNCH_GATE_HOLDER_CHECK_NAME =
  "Matchlock hermes launch gate (store holder)";

/** Name of the one check that records an incomplete holder observation. */
export const LAUNCH_GATE_HOLDER_OBSERVATION_CHECK_NAME =
  "Matchlock hermes launch gate (store holders)";

/**
 * Render one finding in the launch-scoped message shape every failing check
 * uses: `would refuse a Matchlock hermes launch (code: <code>): <detail>`.
 *
 * The wording is deliberately launch-scoped (spec section 9): a refusal is a
 * statement about a future launch, never a claim that a store is unsafe, broken
 * or corrupt. The gate is not an integrity checker.
 */
function renderFindingMessage(finding: Finding): string {
  return `would refuse a Matchlock hermes launch (code: ${finding.code}): ${finding.detail}`;
}

/**
 * Render the remedy steps the EVALUATOR produced, verbatim.
 *
 * Nothing is invented here: each step contributes its description, and its
 * `Run: <command>` line only when the evaluator attached a command to that
 * step. A finding without commands still yields its descriptions.
 */
function renderRemedy(findings: readonly Finding[]): string | undefined {
  const parts: string[] = [];
  for (const finding of findings) {
    for (const remedyStep of finding.remedy) {
      parts.push(remedyStep.description);
      if (remedyStep.command !== undefined) {
        parts.push(`Run: ${remedyStep.command}`);
      }
    }
  }
  return parts.length === 0 ? undefined : parts.join(" | ");
}

/**
 * Map the Matchlock hermes launch-gate verdict onto launch-scoped doctor checks
 * (spec section 9).
 *
 * Agreement by construction: the result is derived ONLY from
 * {@link resolveLaunchGateObservations} (the launch path's own resolve +
 * observe functions) and {@link evaluateGate} (the launch path's own pure
 * evaluator). There is no independent policy here; a doctor verdict that
 * disagreed with the gate would be a wiring bug.
 *
 * Report-only: this function observes the same read-only metadata and raw
 * bytes the launch path observes. It writes no receipt, performs no conversion,
 * writes no config, opens no database driver and creates no VM.
 *
 * Shape:
 *
 *  - not a hermes-under-Matchlock candidate: exactly ONE `info` check stating
 *    that nothing was evaluated, with the bounded reason;
 *  - candidate: ONE summary check first (`pass` = would allow, `fail` = would
 *    refuse), then ONE `fail` check per store that produced a finding (named by
 *    the canonical path, or the requested spelling when unresolved), and ONE
 *    `fail` check for the set-scoped findings (e.g. `inventory-incomplete`).
 *
 * A would-refuse is `fail`, so the doctor's existing exit-code path
 * (`formatDoctorOutput` -> `hasFailures`) trips without any change.
 */
export function runLaunchGateChecks(
  opts: RunLaunchGateChecksOptions = {},
): DoctorCheckResult[] {
  const observations = resolveLaunchGateObservations(opts);

  if (!observations.candidate) {
    const reason =
      observations.reason === null ? "no reason was recorded" : observations.reason;
    return [
      {
        name: LAUNCH_GATE_SUMMARY_CHECK_NAME,
        status: "info",
        message:
          "not a hermes-under-Matchlock launch candidate, so the launch gate " +
          `was not evaluated (${reason})`,
      },
    ];
  }

  if (observations.gateInput === null) {
    // The profile IS a candidate but the inventory could not be built. That is
    // a fail-closed observation failure, never a silent pass: the launch path
    // cannot reach a decision either. It is reported as a launch-scoped
    // inability to evaluate, not as an invented reason code.
    const reason =
      observations.reason === null ? "no reason was recorded" : observations.reason;
    return [
      {
        name: LAUNCH_GATE_SUMMARY_CHECK_NAME,
        status: "fail",
        message:
          "could not evaluate a Matchlock hermes launch because the store set " +
          `could not be resolved (${reason})`,
      },
    ];
  }

  const verdict = evaluateGate(observations.gateInput);
  const checks: DoctorCheckResult[] = [];

  if (verdict.action === "allow") {
    checks.push({
      name: LAUNCH_GATE_SUMMARY_CHECK_NAME,
      status: "pass",
      message:
        "would allow a Matchlock hermes launch: the effective config requests " +
        "the delete journal mode and every evaluated store is rollback-format" +
        ` (${observations.gateInput.stores.length} store(s) evaluated)`,
    });
  } else {
    checks.push({
      name: LAUNCH_GATE_SUMMARY_CHECK_NAME,
      status: "fail",
      message:
        "would refuse a Matchlock hermes launch: the launch gate produced " +
        `${verdict.findings.length} finding(s) across ` +
        `${observations.gateInput.stores.length} evaluated store(s)`,
    });
  }

  // Set-scoped findings carry no store path. They describe the store SET (an
  // incomplete inventory), so they belong in ONE aggregate check rather than a
  // check named after a store that is not the subject of the finding.
  const setScoped = verdict.findings.filter(
    (finding) => finding.store === undefined || finding.store === null,
  );
  if (setScoped.length > 0) {
    const remedy = renderRemedy(setScoped);
    checks.push({
      name: LAUNCH_GATE_STORE_SET_CHECK_NAME,
      status: "fail",
      message: setScoped.map(renderFindingMessage).join(" | "),
      ...(remedy === undefined ? {} : { remedy }),
    });
  }

  for (const finding of verdict.findings) {
    if (finding.store === undefined || finding.store === null) continue;
    const remedy = renderRemedy([finding]);
    checks.push({
      name: finding.store,
      status: "fail",
      message: renderFindingMessage(finding),
      ...(remedy === undefined ? {} : { remedy }),
    });
  }

  // INFORMATIONAL holder listing (spec sections 5 and 8). It is appended AFTER
  // the summary and the store checks and is deliberately verdict-neutral: an
  // observed holder, a failed probe and an unavailable probe are all `info`, and
  // none of them can change the summary status, the reason codes or
  // `hasFailures`. Ownership is not a refusal reason in this gate.
  const probePaths = presentStorePaths(observations.storeSet);
  const holders = observeStoreHolders(probePaths, opts.holderProbe);
  for (const holder of holders.candidates) {
    checks.push({
      name: `${LAUNCH_GATE_HOLDER_CHECK_NAME} pid ${holder.pid}`,
      status: "info",
      message: renderHolderMessage(holder, probePaths),
    });
  }
  if (!holders.observationComplete) {
    checks.push(renderHolderIncompleteCheck(holders.failures));
  }

  return checks;
}
