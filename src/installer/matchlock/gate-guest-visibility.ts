/**
 * Matchlock guest-visible effective-config evidence (G8 ADMISSION-INTEGRATION
 * US-010, bead tamandua-7p5.1.8).
 *
 * WHY A GUEST-SIDE READ
 *
 * The gate's `database.journal_mode` observation is taken from the HOST
 * (`doctor-gate.ts` `resolveEffectiveJournalMode`, provenance text
 * `host-observed: ...`). Qualification obligation 3 of the brief says plainly
 * that a host-side read does not establish what the guest's Hermes sees: the
 * effective config is the merge of the layers visible INSIDE that guest (the
 * mounted profile `config.yaml` plus whatever managed layer the guest image
 * provides), and the guest image is not the host. This module therefore runs a
 * bounded read-only probe INSIDE the still-owned VM, after boot and before the
 * harness starts, and records the result per store in the qualification record
 * with `perspective: "guest"`.
 *
 * EVIDENCE, NOT A DECISION
 *
 * Visibility NEVER changes a verdict and NEVER refuses a launch:
 *
 *  - the probe is issued only after the gate already allowed this invocation
 *    (the runner calls this module only when it holds this invocation's allow
 *    binding), so there is no verdict left to change;
 *  - a failed, timed-out, killed or unparseable probe records
 *    `provenance: "unmeasured"` with the journal mode left unset (the record
 *    renders the shared `unreadable` sentinel) — never a fabricated `delete`
 *    and never a fabricated `wal`;
 *  - a record-write failure is reported (typed + logged), not raised;
 *  - a host/guest disagreement sets the record's `discrepancy` flag and is
 *    logged once, so the disagreement is VISIBLE instead of being silently
 *    resolved in either direction.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not re-run the gate, does not re-observe store headers, does not
 * release or take a lease, and does not touch the receipt. The receipt keeps
 * the verdict it recorded; the qualification record is the sibling evidence file
 * that says which artifacts and which guest-visible config that verdict belongs
 * to.
 *
 * MODULE BOUNDARY. Node core + the qualification record module only: no child
 * process (the guest exec is an injected seam — the caller owns the controller),
 * no database driver, no evaluation, no exit-code owner. It stays in the
 * PARALLEL test lane (it is not listed in `tests/serial-files.txt`).
 */

import fs from "node:fs";
import path from "node:path";

import type { GuestConfigProbeLine, GuestJournalMode } from "./gate-config-probe.js";
import type { LaunchGateBinding, LaunchGateDecision } from "./launch-gate-wiring.js";
import {
  GATE_RECEIPT_UNREADABLE,
  captureQualificationRecord,
  resolveQualificationRecordPath,
  writeQualificationRecord,
  type QualificationCaptureInputs,
  type QualificationGuestVisibility,
  type QualificationRecord,
  type QualificationWriteResult,
} from "./gate-qualification.js";

/** Default positive budget (ms) for the in-guest config probe. */
export const GUEST_CONFIG_PROBE_TIMEOUT_DEFAULT_MS = 30_000;

/** Upper bound on a bounded diagnostic detail this module emits. */
const MAX_DETAIL_CHARS = 300;

/** One `exec`-shaped request the probe issues (the caller owns quoting). */
export interface GuestConfigProbeExecRequest {
  /** Full argv of the guest command, unquoted (the seam quotes it). */
  argv: string[];
  /** Positive budget (ms) for this one exec. */
  timeoutMs: number;
}

/** One exec outcome. `exitCode: null` means the exec itself failed. */
export interface GuestConfigProbeExecResult {
  exitCode: number | null;
  /** Captured stdout (bounded by the seam). */
  stdout: string;
  /** Bounded operational failure text (never config contents). */
  failure?: string;
}

/** The narrow guest-exec seam this module needs (the controller satisfies it). */
export interface GuestConfigProbeExecSeam {
  exec(request: GuestConfigProbeExecRequest): Promise<GuestConfigProbeExecResult>;
}

/**
 * One store's guest-visible effective config.
 *
 * `journalMode`/`readable` are `null` when nothing was measured; the
 * qualification record renders that as the `unreadable` sentinel, so
 * "not measured" and "measured as X" stay distinguishable to a reader.
 */
export interface GuestConfigObservation {
  /** Store path as spelled to the guest (or the host path when unmappable). */
  storePath: string;
  journalMode: GuestJournalMode | null;
  source: string;
  readable: boolean | null;
  /** Always guest: a host read is never presented as guest evidence. */
  perspective: "guest";
  provenance: "measured" | "unmeasured";
  /** Bounded diagnostic detail; never config bodies or raw probe output. */
  detail?: string;
}

/** Probe options. All paths here are GUEST paths. */
export interface GuestConfigProbeOptions {
  /** Guest-visible store paths the observation is attributed to. */
  stores: readonly string[];
  /** Guest HERMES_HOME (the mounted effective profile directory). */
  guestHermesHome: string;
  /** Guest path of the packed probe helper. */
  helperGuestPath: string;
  /** Guest argv prefix for the helper (default `["node"]`). */
  helperArgv?: readonly string[];
  /** Positive probe budget (ms). */
  timeoutMs?: number;
  /**
   * Managed-layer override forwarded to the guest. Omit it in production: the
   * guest resolves its own managed layer (env, then `/etc/hermes`), which is
   * exactly the guest-visible fact being measured. `null` disables the layer
   * (deterministic fixtures).
   */
  managedDir?: string | null;
}

function bounded(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}...` : flat;
}

function unmeasured(storePath: string, detail: string): GuestConfigObservation {
  return {
    storePath,
    journalMode: null,
    source: `guest-unmeasured: ${bounded(detail)}`,
    readable: null,
    perspective: "guest",
    provenance: "unmeasured",
    detail: bounded(detail),
  };
}

/** The request JSON the helper parses from its last argv element. */
export function buildGuestConfigProbeRequestJson(
  opts: Pick<GuestConfigProbeOptions, "stores" | "guestHermesHome" | "managedDir">,
): string {
  const request: Record<string, unknown> = {
    hermesHome: opts.guestHermesHome,
    stores: [...opts.stores],
  };
  // Only an EXPLICIT override is forwarded: the production guest resolves its
  // own managed layer, which is the guest-visible fact under measurement.
  if (opts.managedDir !== undefined) request.managedDir = opts.managedDir;
  return JSON.stringify(request);
}

/** The full argv the probe issues through the exec seam. */
export function buildGuestConfigProbeArgv(opts: GuestConfigProbeOptions): string[] {
  return [
    ...(opts.helperArgv ?? ["node"]),
    opts.helperGuestPath,
    "--",
    buildGuestConfigProbeRequestJson(opts),
  ];
}

/** True when a parsed line carries the exact documented probe shape. */
function isProbeLine(value: unknown): value is GuestConfigProbeLine {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const line = value as Partial<GuestConfigProbeLine>;
  if (typeof line.store !== "string" || line.store.trim() === "") return false;
  if (line.journalMode !== "delete" && line.journalMode !== "wal" && line.journalMode !== "unreadable") {
    return false;
  }
  if (typeof line.source !== "string") return false;
  return typeof line.readable === "boolean";
}

/**
 * Measure the guest-visible effective `database.journal_mode` for every
 * requested store with ONE bounded guest exec.
 *
 * Total and non-throwing: an exec failure, a non-zero exit, a timeout surfaced
 * as a rejection, or unparseable output yields `provenance: "unmeasured"` for
 * every store — never a fabricated mode and never an exception a caller could
 * turn into a launch refusal.
 */
export async function probeGuestVisibleConfig(
  seam: GuestConfigProbeExecSeam | null | undefined,
  opts: GuestConfigProbeOptions,
): Promise<GuestConfigObservation[]> {
  const stores: string[] = [];
  for (const entry of Array.isArray(opts?.stores) ? opts.stores : []) {
    if (typeof entry === "string" && entry.trim() !== "") stores.push(entry.trim());
  }
  if (stores.length === 0) return [];

  if (seam === null || seam === undefined || typeof seam.exec !== "function") {
    return stores.map((store) =>
      unmeasured(store, "no guest exec seam was supplied; guest visibility was not measured"),
    );
  }

  let result: GuestConfigProbeExecResult;
  try {
    result = await seam.exec({
      argv: buildGuestConfigProbeArgv(opts),
      timeoutMs:
        typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
          ? opts.timeoutMs
          : GUEST_CONFIG_PROBE_TIMEOUT_DEFAULT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return stores.map((store) => unmeasured(store, `guest probe exec failed: ${message}`));
  }

  if (result === null || typeof result !== "object") {
    return stores.map((store) => unmeasured(store, "guest probe returned no result"));
  }
  if (result.exitCode === null) {
    return stores.map((store) =>
      unmeasured(store, `guest probe did not complete: ${result.failure ?? "no exit status"}`),
    );
  }
  if (result.exitCode !== 0) {
    return stores.map((store) =>
      unmeasured(store, `guest probe exited ${result.exitCode}${result.failure ? `: ${result.failure}` : ""}`),
    );
  }

  // Last line wins for a repeated store spelling, so a helper that emitted twice
  // cannot make the observation depend on output order beyond its own repeat.
  const byStore = new Map<string, GuestConfigProbeLine>();
  let sawAnyLine = false;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    sawAnyLine = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isProbeLine(parsed)) continue;
    byStore.set(parsed.store.trim(), parsed);
  }

  return stores.map((store) => {
    const line = byStore.get(store);
    if (line !== undefined) {
      return {
        storePath: store,
        journalMode: line.journalMode,
        source: line.source,
        readable: line.readable,
        perspective: "guest" as const,
        provenance: "measured" as const,
      };
    }
    return unmeasured(
      store,
      sawAnyLine
        ? "no parseable guest probe line was emitted for this store"
        : "guest probe produced no output",
    );
  });
}

/** One store mapped from its host spelling to its guest-visible spelling. */
export interface GuestStorePath {
  hostStorePath: string;
  /** Guest-visible spelling, or null when the store is outside the mount. */
  guestStorePath: string | null;
}

/**
 * Translate the gate's HOST store identities into the paths the same files have
 * inside the guest, through the caller's whole-directory mount (the Hermes
 * config dir is mounted at an identical-content guest HERMES_HOME).
 *
 * A store outside the mounted directory has NO guest spelling: it is returned
 * with `guestStorePath: null` so the caller records an honest
 * `provenance: "unmeasured"` entry instead of guessing a path.
 */
export function translateGuestStorePaths(
  stores: readonly { canonicalPath: string }[] | null | undefined,
  hostConfigDir: string,
  guestConfigDir: string,
): GuestStorePath[] {
  if (!Array.isArray(stores)) return [];
  const hostRoot =
    typeof hostConfigDir === "string" && hostConfigDir.trim() !== ""
      ? path.resolve(hostConfigDir.trim())
      : "";
  const guestRoot =
    typeof guestConfigDir === "string" && guestConfigDir.trim() !== ""
      ? path.posix.resolve(guestConfigDir.trim())
      : "";

  const mapped: GuestStorePath[] = [];
  for (const store of stores) {
    const hostStorePath =
      store !== null && typeof store === "object" && typeof store.canonicalPath === "string"
        ? store.canonicalPath.trim()
        : "";
    if (hostStorePath === "" || hostRoot === "" || guestRoot === "") {
      mapped.push({ hostStorePath, guestStorePath: null });
      continue;
    }
    const relative = path.relative(hostRoot, path.resolve(hostStorePath));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      mapped.push({ hostStorePath, guestStorePath: null });
      continue;
    }
    mapped.push({
      hostStorePath,
      guestStorePath: path.posix.join(guestRoot, ...relative.split(/[\\/]+/).filter((p) => p !== "")),
    });
  }
  return mapped;
}

/** Normalized comparison form of a journal mode (`null` when unusable). */
function comparableMode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalised = value.trim().toLowerCase();
  if (normalised === "" || normalised === "unreadable") return null;
  return normalised;
}

/**
 * The record's `discrepancy` flag: TRUE only when a MEASURED guest observation
 * names a real mode that differs from a real host-observed mode. An unknown,
 * unreadable or unmeasured value can never create a disagreement (nothing was
 * compared), so the flag cannot be fabricated by missing evidence.
 */
export function computeGuestVisibilityDiscrepancy(
  observations: readonly GuestConfigObservation[] | null | undefined,
  hostJournalMode: unknown,
): boolean {
  const host = comparableMode(hostJournalMode);
  if (host === null) return false;
  if (!Array.isArray(observations)) return false;
  for (const observation of observations) {
    if (observation === null || typeof observation !== "object") continue;
    if (observation.provenance !== "measured") continue;
    const guest = comparableMode(observation.journalMode);
    if (guest === null) continue;
    if (guest !== host) return true;
  }
  return false;
}

/** Whitelist one observation into the record's guest-visibility entry. */
function toRecordEntry(observation: GuestConfigObservation): QualificationGuestVisibility {
  const measured = observation.provenance === "measured";
  return {
    storePath: observation.storePath,
    // A mode is written ONLY from a measured observation; otherwise the shared
    // sentinel — never a fabricated `delete` and never a fabricated `wal`.
    journalMode: measured && observation.journalMode !== null
      ? observation.journalMode
      : GATE_RECEIPT_UNREADABLE,
    source: observation.source,
    readable: measured && typeof observation.readable === "boolean"
      ? observation.readable
      : GATE_RECEIPT_UNREADABLE,
    perspective: "guest",
    provenance: measured ? "measured" : "unmeasured",
  };
}

/**
 * Attach guest-visible observations to a qualification record.
 *
 * Returns a NEW record (the input is never mutated) whose `guestVisibility`
 * list is the observations in order — when no observation was produced, the
 * record's existing entries and flag are kept as they were, because nothing was
 * measured in this pass. `discrepancy` is recomputed from the observations and
 * the host-observed mode; the gate verdict and every other field are untouched,
 * so a disagreement is recorded without ever rewriting the decision.
 */
export function attachGuestVisibility(
  record: QualificationRecord | null | undefined,
  observations: readonly GuestConfigObservation[] | null | undefined,
  opts?: { hostJournalMode?: string | null },
): QualificationRecord | null {
  if (record === null || record === undefined || typeof record !== "object") return null;

  const measured = Array.isArray(observations) ? observations : [];
  if (measured.length === 0) {
    return {
      ...record,
      guestVisibility: Array.isArray(record.guestVisibility) ? record.guestVisibility : [],
      discrepancy: record.discrepancy === true,
    };
  }

  return {
    ...record,
    guestVisibility: measured.map((observation) => toRecordEntry(observation)),
    discrepancy: computeGuestVisibilityDiscrepancy(measured, opts?.hostJournalMode),
  };
}

/**
 * Read a qualification record from disk, or `null` when it is absent or does
 * not carry the expected record kind. Never throws: an unreadable or foreign
 * JSON file is simply not a base record.
 */
export function readQualificationRecord(filePath: string): QualificationRecord | null {
  if (typeof filePath !== "string" || filePath.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as QualificationRecord;
    if (record.recordKind !== "matchlock-gate-qualification") return null;
    return record;
  } catch {
    return null;
  }
}

/** Bounded logging seam (the default writes one line to stderr). */
export type GuestVisibilityLog = (
  level: "info" | "warn",
  message: string,
  fields?: Record<string, unknown>,
) => void;

function defaultLog(level: "info" | "warn", message: string, fields?: Record<string, unknown>): void {
  try {
    const suffix =
      fields === undefined || Object.keys(fields).length === 0
        ? ""
        : ` ${JSON.stringify(fields, Object.keys(fields).sort())}`;
    process.stderr.write(`[matchlock guest-visibility] ${level}: ${bounded(message)}${bounded(suffix)}\n`);
  } catch {
    // Logging must never affect the round.
  }
}

/** Options for the after-boot capture the hermes runner performs. */
export interface GuestVisibilityCaptureOptions {
  /** THIS invocation's gate ALLOW binding (never fabricated by the caller). */
  binding: LaunchGateBinding;
  /** Canonical host config dir (the whole-dir mount source). */
  hostConfigDir: string;
  /** Guest HERMES_HOME the same directory is mounted at. */
  guestConfigDir: string;
  /** Guest path of the packed probe helper. */
  helperGuestPath: string;
  helperArgv?: readonly string[];
  timeoutMs?: number;
  /** Bare run id for the record's invocation block. */
  runId?: string;
  /** Dispatch round / job id for the record's invocation block. */
  roundId?: string;
  /** Extra caller-measured qualification inputs (artifacts, image, profiles). */
  qualification?: QualificationCaptureInputs | null;
  /** Explicit base record; wins over any record already on disk. */
  baseRecord?: QualificationRecord | null;
}

/** Injection seams for the after-boot capture (all optional). */
export interface GuestVisibilityCaptureDeps {
  /** Guest exec seam. Absent ⇒ every observation is `unmeasured`. */
  exec?: GuestConfigProbeExecSeam | null;
  /** Record writer (default: the qualification module's atomic writer). */
  writeRecord?: (record: QualificationRecord) => QualificationWriteResult;
  /** Base-record reader (default: {@link readQualificationRecord}). */
  readRecord?: (filePath: string) => QualificationRecord | null;
  /** Capture seam (default: `captureQualificationRecord`). */
  capture?: (
    decision: LaunchGateDecision,
    inputs: QualificationCaptureInputs,
  ) => QualificationRecord;
  /** Log sink (default: one bounded stderr line per event). */
  log?: GuestVisibilityLog;
}

/** Outcome of the after-boot capture. Never a launch decision. */
export interface GuestVisibilityCaptureResult {
  observations: GuestConfigObservation[];
  record: QualificationRecord | null;
  recordPath: string | null;
  written: boolean;
  discrepancy: boolean;
  /** Bounded detail when the record could not be written; absent on success. */
  writeFailure?: string;
  /** Bounded detail when the whole capture degraded; absent on success. */
  captureFailure?: string;
}

function runSafely<T>(measure: () => T): T | null {
  try {
    return measure();
  } catch {
    return null;
  }
}

/**
 * Measure guest visibility after boot and attach it to this invocation's
 * qualification record.
 *
 * TOTAL BY CONSTRUCTION: every step is bounded and wrapped, so a probe failure,
 * a missing seam, an unreadable base record or a failed record write degrades to
 * a recorded diagnostic and a result — never an exception, and never a change to
 * the gate's verdict (the record's own verdict field is carried through
 * untouched; this function has no path that could refuse a launch).
 */
export async function recordGuestVisibilityAfterBoot(
  opts: GuestVisibilityCaptureOptions,
  deps?: GuestVisibilityCaptureDeps | null,
): Promise<GuestVisibilityCaptureResult> {
  const seamDeps = deps ?? {};
  const log = typeof seamDeps.log === "function" ? seamDeps.log : defaultLog;

  const empty = (detail: string): GuestVisibilityCaptureResult => {
    log("warn", `guest-visible config was not recorded: ${detail}`, {
      invocationId: opts?.binding?.invocationId,
    });
    return {
      observations: [],
      record: null,
      recordPath: null,
      written: false,
      discrepancy: false,
      captureFailure: bounded(detail),
    };
  };

  if (opts === null || opts === undefined || typeof opts.binding !== "object" || opts.binding === null) {
    return empty("no launch-gate binding was supplied for this invocation");
  }

  const binding = opts.binding;
  const storeMappings = translateGuestStorePaths(binding.stores, opts.hostConfigDir, opts.guestConfigDir);

  // Only stores with a real guest spelling can be probed; the rest are recorded
  // as honest unmeasured entries rather than guessed paths.
  const guestStores: string[] = [];
  for (const mapping of storeMappings) {
    if (mapping.guestStorePath !== null) guestStores.push(mapping.guestStorePath);
  }

  let probed: GuestConfigObservation[] = [];
  if (guestStores.length > 0) {
    try {
      probed = await probeGuestVisibleConfig(seamDeps.exec ?? null, {
        stores: guestStores,
        guestHermesHome: opts.guestConfigDir,
        helperGuestPath: opts.helperGuestPath,
        helperArgv: opts.helperArgv,
        timeoutMs: opts.timeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      probed = guestStores.map((store) => unmeasured(store, `guest probe failed: ${message}`));
    }
  }

  // Re-merge in the gate's store order so an unmappable store keeps a visible
  // (unmeasured) entry next to its mapped siblings.
  const probedByPath = new Map(probed.map((observation) => [observation.storePath, observation]));
  const observations: GuestConfigObservation[] = storeMappings.map((mapping) => {
    if (mapping.guestStorePath === null) {
      return unmeasured(
        mapping.hostStorePath,
        "store is outside the guest-visible config mount; its guest config was not measured",
      );
    }
    const observation = probedByPath.get(mapping.guestStorePath);
    return (
      observation ??
      unmeasured(mapping.guestStorePath, "store was not observed by the guest probe")
    );
  });

  const receiptPath = typeof binding.receiptPath === "string" ? binding.receiptPath : "";
  const recordPath = resolveQualificationRecordPath(receiptPath);

  let base: QualificationRecord | null = opts.baseRecord ?? null;
  if (base === null && recordPath !== "") {
    const readRecord =
      typeof seamDeps.readRecord === "function" ? seamDeps.readRecord : readQualificationRecord;
    base = runSafely(() => readRecord(recordPath));
  }
  if (base === null) {
    const extra = opts.qualification ?? {};
    const inputs: QualificationCaptureInputs = {
      ...extra,
      invocation: {
        ...extra.invocation,
        invocationId: binding.invocationId,
        kind: binding.kind,
        ...(opts.runId === undefined ? {} : { runId: opts.runId }),
        ...(opts.roundId === undefined ? {} : { roundId: opts.roundId }),
      },
      receipt: {
        ...extra.receipt,
        path: receiptPath,
        storeSetKey: binding.storeSetKey,
      },
      profiles: {
        hostEffectiveDir: opts.hostConfigDir,
        guestHermesHome: opts.guestConfigDir,
        configSources:
          typeof opts.hostConfigDir === "string" && opts.hostConfigDir !== ""
            ? [path.join(opts.hostConfigDir, "config.yaml")]
            : [],
        ...extra.profiles,
      },
    };
    const capture =
      typeof seamDeps.capture === "function" ? seamDeps.capture : captureQualificationRecord;
    const captured = runSafely(() =>
      capture({ action: "allow", binding } as LaunchGateDecision, inputs),
    );
    if (captured === null) {
      return empty("the qualification record could not be captured");
    }
    base = captured;
  }

  const attached = attachGuestVisibility(base, observations, {
    hostJournalMode: binding.configJournalMode,
  });
  if (attached === null) {
    return empty("the qualification record could not be updated with guest visibility");
  }

  let written = false;
  let writeFailure: string | undefined;
  try {
    const writeRecord =
      typeof seamDeps.writeRecord === "function" ? seamDeps.writeRecord : writeQualificationRecord;
    const outcome = writeRecord(attached);
    written = outcome.ok === true;
    if (!outcome.ok) writeFailure = bounded(outcome.detail);
  } catch (error) {
    writeFailure = bounded(error instanceof Error ? error.message : String(error));
  }
  if (writeFailure !== undefined) {
    // Evidence that cannot be persisted is reported, never a launch refusal.
    log("warn", `guest visibility record could not be written: ${writeFailure}`, {
      invocationId: binding.invocationId,
      recordPath,
    });
  }

  if (attached.discrepancy) {
    const host = typeof binding.configJournalMode === "string" ? binding.configJournalMode : "unreadable";
    for (const observation of observations) {
      if (observation.provenance !== "measured") continue;
      const guest = comparableMode(observation.journalMode);
      if (guest === null) continue;
      if (guest === comparableMode(host)) continue;
      log(
        "warn",
        `guest-visible database.journal_mode (${guest}) differs from the host observation (${host}) for store ${observation.storePath}; the gate verdict is unchanged and the discrepancy is recorded`,
        { invocationId: binding.invocationId, storePath: observation.storePath },
      );
    }
  }

  return {
    observations,
    record: attached,
    recordPath: recordPath === "" ? null : recordPath,
    written,
    discrepancy: attached.discrepancy === true,
    ...(writeFailure === undefined ? {} : { writeFailure }),
  };
}
