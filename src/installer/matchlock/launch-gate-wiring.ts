/**
 * Matchlock launch-gate WIRING (G8 ADMISSION-INTEGRATION US-001, bead
 * tamandua-7p5.1.8).
 *
 * ONE implementation, every caller. The observation modules (`store-set.ts`,
 * `store-header.ts`, `store-observation-adapter.ts`), the pure evaluator
 * (`launch-gate.ts`), the receipt serializer/writer (`gate-receipt.ts`) and the
 * exit-code allocation (`gate-exit-code.ts`) already exist and are consumed
 * here AS THEY ARE. This module only puts them in the one order a launch is
 * allowed to run in, and turns the result into either a BOUND allow decision or
 * a RECEIPTED refusal:
 *
 *   1. resolve the profile + selection (a resolver seam; the caller that
 *      already resolved a profile supplies it, so the wiring never re-resolves
 *      ambient state behind the caller's back);
 *   2. use the FINAL caller-supplied mount plan — the plan that will be handed
 *      to the controller, not a rebuilt one;
 *   3. resolve the store set; a `StoreSetInputError` is an operational refusal
 *      (the inventory could not be built at all);
 *   4. observe EVERY store (header + sidecars) and adapt it, carrying the one
 *      per-profile effective journal-mode observation. A store whose
 *      observation throws becomes an `unresolved` store, never a skipped one,
 *      so the failure is a finding instead of a gap;
 *   5. evaluate the aggregate: every store is evaluated even after a failure,
 *      and every finding is preserved (no short-circuit);
 *   6. revalidate membership + config BY IDENTITY — the PRODUCTION
 *      revalidation (`launch-gate-revalidate.ts`, US-002) is the default, and
 *      it re-resolves the current store set for the membership comparison. A
 *      changed store set, a replaced inode at the same path, or a config edited
 *      to wal refuses;
 *   7. only then does the caller create a VM, mount and run.
 *
 * REFUSAL SEMANTICS (the incident's lesson: an 18-round retry loop must never
 * be reproducible by a refusal):
 *
 *  - The receipt is written FIRST, before the refusal is returned, and the
 *    wiring never creates, mounts or dispatches anything.
 *  - The exit status comes from `exitCodeForGateOutcome` in
 *    `gate-exit-code.ts`; this module contains no numeric status literal, so a
 *    later surface cannot fork the allocation by copying a number.
 *  - A receipt that cannot be written is an OPERATIONAL refusal (the separate
 *    class, never one of the ten closed reason codes) and never an allow. The
 *    verdict's findings are still returned, so an operator sees both why the
 *    launch was refused and that the evidence could not be recorded.
 *  - Revalidation failure is likewise operational: it is not a store condition
 *    from the ten-code vocabulary, and inventing an eleventh code here would
 *    break the closed set the evaluator and the remedy renderer share.
 *
 * NO LEASE. Nothing here reserves, locks or excludes: concurrent admissions
 * may both pass. The receipt states that limitation itself
 * (`NO_LEASE_LIMITATION` in gate-receipt.ts); this module must never imply
 * otherwise.
 *
 * SCOPE. Native (non-Matchlock) runs do not call this module at all: it is
 * reached from the interactive hermes / hermes-shell plan and from the
 * scheduled dispatch/attempt path. A raw `matchlock run` with a hermes payload
 * is out of scope; the receipt records the invocation KIND it was asked about,
 * which is how that scoping stays visible in the evidence.
 *
 * MODULE BOUNDARY. `node:crypto` (the store-set key), `node:fs` (creating the
 * receipt directory) and `node:path` are the only ambient imports beyond the
 * gate modules. There is deliberately NO `node:child_process`: holder
 * detection is an injected probe, and its default reports
 * `observationComplete: false` instead of pretending a probe ran. That keeps
 * this module — and its test — in the PARALLEL test lane.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { nowIso } from "../../lib/instant.js";
import { resolveStateDir } from "../../lib/tamandua-config.js";
import {
  LAUNCH_GATE_STORE_CONTRACT,
  resolveEffectiveJournalMode,
  type EffectiveJournalModeOptions,
} from "./doctor-gate.js";
import {
  GATE_RECEIPT_SCHEMA_VERSION,
  GATE_RECEIPT_UNKNOWN,
  GATE_RECEIPT_UNMEASURED,
  GATE_RECEIPT_UNREADABLE,
  NO_LEASE_LIMITATION,
  writeLaunchReceipt,
  writeRefusalReceipt,
  type ReceiptFinding,
  type ReceiptHolderDetection,
  type ReceiptSidecarState,
  type ReceiptStore,
  type ReceiptWriteInput,
  type ReceiptWriteResult,
} from "./gate-receipt.js";
import { exitCodeForGateOutcome } from "./gate-exit-code.js";
import {
  captureLaunchGateSnapshot,
  revalidateLaunchGateSnapshot,
  type LaunchGateChange,
  type LaunchGateRevalidation,
  type LaunchGateSnapshot,
  type LaunchGateStoreIdentity,
} from "./launch-gate-revalidate.js";
import {
  evaluateGate,
  type EvaluatedStore,
  type Finding,
  type GateInput,
  type GateVerdict,
  type StoreConfigObservation,
} from "./launch-gate.js";
import {
  adaptStoreObservation,
  type StoreAdapterContext,
} from "./store-observation-adapter.js";
import { observeStore, type StoreObservation } from "./store-header.js";
import {
  detectStoreHolders,
  type HolderCandidate,
  type HolderDetection,
  type HolderStore,
} from "./store-holder-detect.js";
import {
  resolveStoreSet,
  StoreSetInputError,
  type ResolveStoreSetInput,
  type RuntimeStoreContract,
  type StoreClassification,
  type StoreIdentity,
  type StoreMountPlan,
  type StoreSet,
} from "./store-set.js";

// ---------------------------------------------------------------------------
// invocation scope
// ---------------------------------------------------------------------------

/**
 * Which caller is asking. The four kinds are distinct because a scheduled
 * attempt and a scheduled dispatch are different evaluations of the same round
 * (a queued round can wait hours, so its dispatch-time verdict is stale), and
 * because the interactive shell variant must be recognisable in the evidence
 * as its own surface.
 */
export type LaunchGateInvocationKind =
  | "interactive-hermes"
  | "interactive-hermes-shell"
  | "scheduled-dispatch"
  | "scheduled-attempt";

/** Every kind the wiring accepts; anything else is refused operationally. */
const INVOCATION_KINDS: readonly LaunchGateInvocationKind[] = [
  "interactive-hermes",
  "interactive-hermes-shell",
  "scheduled-dispatch",
  "scheduled-attempt",
];

/**
 * One launch attempt, as the caller sees it.
 *
 * `profileHome` and `mountPlan` are the caller's FINAL values: the wiring never
 * re-derives the mount plan, because the plan it evaluates must be the plan the
 * controller will use. `configOptions` pins the effective journal-mode
 * observation (tests pass `managedDir: null` for determinism); `storeContract`
 * defaults to the attested runtime contract seed.
 */
export interface LaunchGateInvocationScope {
  kind: LaunchGateInvocationKind;
  /** Binds the verdict to THIS invocation (run/round/attempt, never a path). */
  invocationId: string;
  runId?: string;
  roundId?: string;
  /** Effective host profile home the runtime will read. */
  profileHome: string;
  /** The FINAL mount plan that will be handed to the controller. */
  mountPlan: StoreMountPlan;
  /** Effective journal-mode observation options (managed scope, env). */
  configOptions?: EffectiveJournalModeOptions;
  /** Runtime store contract; defaults to `LAUNCH_GATE_STORE_CONTRACT`. */
  storeContract?: RuntimeStoreContract;
}

/** The resolved profile identity recorded in the receipt. */
export interface LaunchGateResolvedProfile {
  /** Profile id (`default` or a named profile), or the unreadable sentinel. */
  profile: string;
  /** Effective host profile home the store inventory is resolved against. */
  profileHome: string;
  /** Guest-visible config directory, when the caller knows it. */
  guestConfigDir: string | null;
}

/**
 * Resolve the profile + selection for one scope. The default keeps the
 * caller's already-resolved `profileHome` and records the profile id as
 * unreadable: this module must not invent a profile it did not resolve.
 */
export type LaunchGateSelectionResolver = (
  scope: LaunchGateInvocationScope,
) => LaunchGateResolvedProfile;

// ---------------------------------------------------------------------------
// binding, snapshot and revalidation
// ---------------------------------------------------------------------------

/**
 * One store's filesystem identity, as bound by the gate.
 *
 * A confirmed-absent store has no inode and therefore cannot appear here: its
 * later appearance is caught by revalidation as a membership change. The shape
 * lives with the revalidation module, so the wiring signature, the snapshot and
 * the production implementation cannot drift apart.
 */
export type LaunchGateBoundStore = LaunchGateStoreIdentity;

/**
 * What revalidation is asked to prove unchanged: the identities and the config.
 * Declared in (and re-exported from) the revalidation module.
 */
export type { LaunchGateChange, LaunchGateRevalidation, LaunchGateSnapshot };

/**
 * The revalidation seam. Its PRODUCTION implementation is
 * `revalidateLaunchGateSnapshot` (US-002), wired in below as the default; an
 * injected seam replaces it for tests and for callers that need to control the
 * observe-to-create window.
 */
export type LaunchGateRevalidate = (
  snapshot: LaunchGateSnapshot,
) => LaunchGateRevalidation;

/** What an allowed launch is bound to. `receiptPath` is where the launch receipt goes. */
export interface LaunchGateBinding {
  invocationId: string;
  kind: LaunchGateInvocationKind;
  storeSetKey: string;
  receiptPath: string;
  /** UTC ISO-Z instant the decision was made. */
  decidedAt: string;
  stores: LaunchGateBoundStore[];
  configJournalMode: StoreConfigObservation["journalMode"];
  configSource: string;
}

/**
 * A refusal, already recorded (or, for an operational receipt failure,
 * explicitly not recorded).
 *
 * `kind` distinguishes the two classes: `verdict` is a gate decision from the
 * closed ten-code vocabulary, `operational` is a failure of the gate machinery
 * itself (a store set that could not be built, a revalidation that could not
 * run, a receipt that could not be written). Both map to the same process
 * status through `exitCodeForGateOutcome`.
 */
export interface LaunchGateRefusal {
  kind: "verdict" | "operational";
  detail: string;
  receiptPath: string;
  receiptWritten: boolean;
  exitCode: number;
  /** Null for an operational refusal that never reached a verdict. */
  verdict: GateVerdict | null;
  findings: Finding[];
}

/**
 * The gate's answer.
 *
 * The allow variant also carries the receipt input captured BEFORE any VM
 * exists. Nothing is written on the allow path — the launch receipt may only be
 * recorded after `vmCreated` (see {@link writeLaunchGateLaunchReceipt}) — so
 * the caller that creates the VM must carry this alongside the binding.
 */
export type LaunchGateDecision =
  | { action: "allow"; binding: LaunchGateBinding; receiptInput: ReceiptWriteInput }
  | { action: "refuse"; refusal: LaunchGateRefusal };

/** The typed error a caller rethrows so a surface can map it to the exit code. */
export class LaunchGateRefusalError extends Error {
  readonly refusal: LaunchGateRefusal;
  readonly exitCode: number;

  constructor(refusal: LaunchGateRefusal) {
    super(refusal.detail);
    this.name = "LaunchGateRefusalError";
    this.refusal = refusal;
    this.exitCode = refusal.exitCode;
  }
}

// ---------------------------------------------------------------------------
// injection seams
// ---------------------------------------------------------------------------

/** Host revisions recorded in the receipt. Unknown is the unreadable sentinel. */
export interface LaunchGateHostRevisions {
  hermesRevision: string;
  matchlockRevision: string;
  tamanduaRevision: string;
}

/**
 * The holder probe seam: `listOpenFileHolders(paths)` returns the candidate
 * holders. The production probe (which spawns `lsof`) lives in
 * store-holder-detect-runner.ts and is supplied by a caller that may spawn; the
 * wiring itself never imports it.
 */
export type LaunchGateHolderProbe = (storePaths: string[]) => HolderCandidate[];

/** Injectable seams. Every field has a documented default except `revalidate`. */
export interface LaunchGateWiringDeps {
  /** Resolve the profile + selection; default keeps the caller's profile home. */
  selection?: LaunchGateSelectionResolver;
  /** Store-set resolver; default `resolveStoreSet`. */
  resolveStoreSet?: (input: ResolveStoreSetInput) => StoreSet;
  /** Byte-level store reader; default `observeStore`. */
  observeStore?: (storePath: string) => StoreObservation;
  /** Observation -> evaluator input adapter; default `adaptStoreObservation`. */
  adaptStoreObservation?: (
    observation: StoreObservation,
    classification: StoreClassification,
    context?: StoreAdapterContext,
  ) => EvaluatedStore;
  /** Effective journal-mode observation; default `resolveEffectiveJournalMode`. */
  resolveEffectiveJournalMode?: (
    profileHome: string,
    options?: EffectiveJournalModeOptions,
  ) => StoreConfigObservation;
  /** The pure evaluator; default `evaluateGate`. */
  evaluateGate?: (input: GateInput) => GateVerdict;
  /**
   * Revalidation seam. Default: the PRODUCTION revalidation
   * (`revalidateLaunchGateSnapshot`, US-002) over the observed identities, a
   * fresh store-set resolution for the current membership, and the effective
   * journal mode re-read. Injected by tests and by a caller that must control
   * the observe-to-create window itself.
   */
  revalidate?: LaunchGateRevalidate;
  /** Informational holder probe; default records an INCOMPLETE observation. */
  holderProbe?: LaunchGateHolderProbe;
  /** Receipt writers; default the gate-receipt writers. */
  writeRefusalReceipt?: typeof writeRefusalReceipt;
  writeLaunchReceipt?: typeof writeLaunchReceipt;
  /** Receipt directory creator; default `fs.mkdirSync(recursive, 0700)`. */
  ensureReceiptDirectory?: (directory: string) => void;
  /** Stored-instant clock; default `nowIso` (UTC ISO-Z). */
  now?: () => string;
  /** State dir the receipt path is resolved under; default `resolveStateDir()`. */
  stateDir?: string;
  /** Host revisions; unmeasured values stay unreadable. */
  hostRevisions?: Partial<LaunchGateHostRevisions>;
}

// ---------------------------------------------------------------------------
// pure helpers: store-set key and receipt path
// ---------------------------------------------------------------------------

/** Compare two strings as UTF-8 bytes, never by locale. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * The store-set key: `sha256:` over the UTF-8 byte-sorted
 * `canonicalPath|dev|ino` lines.
 *
 * IDENTITY, NOT SPELLING. Because each line carries the inode, a store swapped
 * for a copy at the same path produces a different key, which is exactly what
 * the controller backstop compares. The input also carries the invocation
 * kind so a key is always computed from a complete scope record, but the kind
 * is deliberately NOT part of the preimage: the key answers "which stores", and
 * the invocation identity (id + kind) is bound separately in the receipt.
 *
 * Pure and order-insensitive: the caller's store order cannot change the key.
 */
export function launchGateStoreSetKey(input: {
  kind: LaunchGateInvocationKind;
  stores: readonly LaunchGateBoundStore[];
}): string {
  const stores = Array.isArray(input?.stores) ? input.stores : [];
  const lines = stores
    .map(
      (store) =>
        `${store?.canonicalPath ?? ""}|${store?.dev ?? ""}|${store?.ino ?? ""}`,
    )
    .sort(byteCompare);
  const digest = crypto
    .createHash("sha256")
    .update(lines.join("\n"), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

/** Characters a receipt filename may keep verbatim. */
const SAFE_INVOCATION_ID = /[^A-Za-z0-9._-]/g;

/** Bound on the readable part of a receipt filename. */
const MAX_INVOCATION_ID_LENGTH = 96;

/**
 * A filename-safe spelling of an invocation id.
 *
 * An invocation id is caller data and may contain separators, `..` or a
 * credential-shaped segment, so it never becomes a path verbatim. When the
 * safe spelling differs from the id (or is empty/dot-like/truncated) a short
 * digest of the ORIGINAL id is appended, so two distinct ids that sanitize to
 * the same text can never share a receipt file — a receipt attributed to the
 * wrong invocation would defeat the whole binding.
 */
function sanitizeInvocationId(invocationId: string): string {
  const replaced = invocationId.replace(SAFE_INVOCATION_ID, "_");
  const truncated = replaced.slice(0, MAX_INVOCATION_ID_LENGTH);
  const needsDigest =
    replaced !== invocationId ||
    truncated !== replaced ||
    truncated === "" ||
    truncated === "." ||
    truncated === "..";
  if (!needsDigest) return truncated;
  const digest = crypto
    .createHash("sha256")
    .update(invocationId, "utf8")
    .digest("hex")
    .slice(0, 16);
  const base = truncated === "" ? "invocation" : truncated;
  return `${base}-${digest}`;
}

/**
 * The receipt path for one invocation:
 * `<stateDir>/matchlock/gate/<sanitized invocationId>.json`.
 *
 * One path per invocation, so a refusal and a later launch receipt for the same
 * invocation can never be confused with another invocation's evidence.
 */
export function resolveLaunchGateReceiptPath(input: {
  stateDir: string;
  invocationId: string;
}): string {
  const stateDir = isNonEmptyString(input?.stateDir)
    ? input.stateDir
    : resolveStateDir();
  const invocationId = typeof input?.invocationId === "string" ? input.invocationId : "";
  return path.join(
    stateDir,
    "matchlock",
    "gate",
    `${sanitizeInvocationId(invocationId)}.json`,
  );
}

/** Bound a diagnostic to one line and a fixed length. */
const MAX_DETAIL_LENGTH = 400;

function bounded(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_DETAIL_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_DETAIL_LENGTH - 1)}\u2026`;
}

/** Describe a thrown value without ever throwing again. */
function describeError(error: unknown): string {
  try {
    if (error instanceof Error && isNonEmptyString(error.message)) {
      return error.message;
    }
    const text = String(error);
    return text === "" ? "unknown failure" : text;
  } catch {
    return "unknown failure";
  }
}

/** Collapse and bound one `store: reason` note. */
function describeObservationFailure(storePath: string, error: unknown): string {
  return `${storePath}: ${describeError(error)}`;
}

/** Default receipt directory creator: private, recursive, idempotent. */
function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// receipt mapping (pure)
// ---------------------------------------------------------------------------

/** One evaluated store plus the evidence needed to serialize it. */
interface ObservedStoreRecord {
  store: EvaluatedStore;
  /** True when the observation itself failed; nothing was measured. */
  observationFailed: boolean;
}

/**
 * Map the verdict's findings for one store into the receipt's code list.
 * Order follows the verdict, duplicates are dropped.
 */
function findingCodesFor(
  findings: readonly Finding[],
  requestedPath: string,
): string[] {
  const codes: string[] = [];
  for (const finding of findings) {
    if (finding.store !== requestedPath) continue;
    if (!codes.includes(finding.code)) codes.push(finding.code);
  }
  return codes;
}

/**
 * Map one evaluated store into the receipt's pinned store shape.
 *
 * UNMEASURABLE IS PRESENT. A field that was not observed is the `unreadable`
 * sentinel, never an omitted key, and a failed observation keeps
 * `unmeasured`/`unobserved` provenance so the receipt cannot present a
 * synthesized value as evidence.
 */
function toReceiptStore(record: ObservedStoreRecord, findings: readonly Finding[]): ReceiptStore {
  const { store, observationFailed } = record;
  const identity = store.identity;
  const header = store.header;
  const sidecars = store.sidecars;
  const config = store.config;

  const sidecarState: ReceiptSidecarState = {
    wal: sidecars?.wal ?? GATE_RECEIPT_UNREADABLE,
    shm: sidecars?.shm ?? GATE_RECEIPT_UNREADABLE,
    journal: sidecars?.journal ?? GATE_RECEIPT_UNREADABLE,
    // Every observation in this module is made from the host; nothing here can
    // establish what a guest sees.
    perspective: "host",
    provenance: observationFailed
      ? GATE_RECEIPT_UNMEASURED
      : sidecars === null
        ? GATE_RECEIPT_UNKNOWN
        : "measured",
  };

  return {
    canonicalPath:
      identity !== null && isNonEmptyString(identity.canonicalPath)
        ? identity.canonicalPath
        : GATE_RECEIPT_UNREADABLE,
    dev:
      identity !== null && isNonEmptyString(identity.dev)
        ? identity.dev
        : GATE_RECEIPT_UNREADABLE,
    ino:
      identity !== null && isNonEmptyString(identity.ino)
        ? identity.ino
        : GATE_RECEIPT_UNREADABLE,
    size: header?.fileSize ?? GATE_RECEIPT_UNREADABLE,
    headerBytes: header?.rawBytes1819 ?? GATE_RECEIPT_UNREADABLE,
    headerFormat: header?.headerFormat ?? GATE_RECEIPT_UNREADABLE,
    sidecarState,
    configJournalMode: config?.journalMode ?? GATE_RECEIPT_UNREADABLE,
    configSource:
      config !== null && isNonEmptyString(config.source)
        ? config.source
        : GATE_RECEIPT_UNREADABLE,
    readable: observationFailed
      ? GATE_RECEIPT_UNREADABLE
      : header !== null && typeof header.readable === "boolean"
        ? header.readable
        : false,
    findingCodes: findingCodesFor(findings, store.requestedPath),
  };
}

/** Map one verdict finding into the receipt's pinned finding shape. */
function toReceiptFinding(finding: Finding): ReceiptFinding {
  return {
    code: finding.code,
    ...(isNonEmptyString(finding.store) ? { store: finding.store } : {}),
    detail: finding.detail,
    remedy: (Array.isArray(finding.remedy) ? finding.remedy : []).map((step) => ({
      description: step.description,
      ...(isNonEmptyString(step.command) ? { command: step.command } : {}),
    })),
  };
}

/** Holder detection as the receipt records it (informational, never a verdict). */
function toReceiptHolderDetection(
  detection: HolderDetection,
  probeSupplied: boolean,
): ReceiptHolderDetection {
  const observationComplete = detection?.observationComplete === true;
  return {
    observationComplete,
    holders: (Array.isArray(detection?.holders) ? detection.holders : []).map((holder) => ({
      pid: holder.pid,
      startedAt: holder.startIdentity,
      command: holder.commandDescription,
    })),
    // A probe that was never supplied made no observation at all; one that ran
    // (complete or not) was made from the host, and only a complete run is
    // `measured`.
    perspective: probeSupplied ? "host" : GATE_RECEIPT_UNMEASURED,
    provenance: !probeSupplied
      ? GATE_RECEIPT_UNMEASURED
      : observationComplete
        ? "measured"
        : GATE_RECEIPT_UNKNOWN,
    limitation: NO_LEASE_LIMITATION,
  };
}

/** The copyable parameter set for one receipt. */
interface ReceiptInputParams {
  scope: LaunchGateInvocationScope;
  profile: string;
  guestConfigDir: string;
  storeSetKey: string;
  inventoryComplete: boolean;
  stores: ReceiptStore[];
  discoveredUnexpected: string[];
  holderDetection: ReceiptHolderDetection;
  verdict: "allow" | "refuse";
  findings: readonly Finding[];
  host: LaunchGateHostRevisions;
  observationStartedAt: string;
  observationFinishedAt: string;
  receiptWrittenAt: string;
}

/** Build the receipt input. The writer forces `action`; this never guesses it. */
function buildReceiptInput(params: ReceiptInputParams): ReceiptWriteInput {
  return {
    schemaVersion: GATE_RECEIPT_SCHEMA_VERSION,
    invocation: {
      kind: params.scope.kind,
      ...(isNonEmptyString(params.scope.runId) ? { runId: params.scope.runId } : {}),
      ...(isNonEmptyString(params.scope.roundId) ? { roundId: params.scope.roundId } : {}),
      profile: params.profile,
      guestConfigDir: params.guestConfigDir,
    },
    storeSetKey: params.storeSetKey,
    inventoryComplete: params.inventoryComplete,
    stores: params.stores,
    discoveredUnexpected: params.discoveredUnexpected,
    holderDetection: params.holderDetection,
    verdict: params.verdict,
    findings: params.findings.map(toReceiptFinding),
    host: params.host,
    observationStartedAt: params.observationStartedAt,
    observationFinishedAt: params.observationFinishedAt,
    receiptWrittenAt: params.receiptWrittenAt,
  };
}

// ---------------------------------------------------------------------------
// observation helpers
// ---------------------------------------------------------------------------

/**
 * The store record for a store whose observation threw.
 *
 * PRESENCE IS `unresolved`, NEVER `confirmed-absent`: nothing was proven about
 * the path, and "could not look" must never read as "gone". The evaluator then
 * emits `path-unresolved` for it and still evaluates every other store, so one
 * bad observation cannot hide another store's findings.
 */
function unresolvedRecord(requestedPath: string, classification: StoreClassification): ObservedStoreRecord {
  return {
    observationFailed: true,
    store: {
      requestedPath,
      presence: "unresolved",
      identity: null,
      required: classification === "required",
      config: null,
      header: null,
      sidecars: null,
      findingCodesFromReader: [],
    },
  };
}

/** The default selection resolver: the caller already resolved the home. */
const defaultSelectionResolver: LaunchGateSelectionResolver = (scope) => ({
  profile: GATE_RECEIPT_UNREADABLE,
  profileHome: scope.profileHome,
  guestConfigDir: null,
});

/**
 * Canonical paths a fresh store-set resolution reports as PRESENT.
 *
 * Revalidation compares membership both ways, so it needs the CURRENT set, not
 * only the snapshot's: a store that appeared after the observation is a change
 * too. Only `resolved` identities have a canonical spelling; an absent or
 * unresolved entry was never mounted, and its later appearance is precisely the
 * "appeared" direction this list feeds.
 */
function resolvedStorePaths(storeSet: StoreSet): string[] {
  const paths: string[] = [];
  for (const identity of Array.isArray(storeSet?.stores) ? storeSet.stores : []) {
    if (identity?.resolution !== "resolved") continue;
    if (!isNonEmptyString(identity.canonicalPath)) continue;
    paths.push(identity.canonicalPath);
  }
  return paths;
}

/** The default holder probe: no probe ran, and the receipt says exactly that. */
const NO_HOLDER_PROBE_REASON =
  "no holder probe was supplied; holder observation was not attempted";

/**
 * Normalize the effective config observation.
 *
 * A seam that returns a malformed value is a store the gate cannot be asked
 * about: the config becomes `unreadable`/unobserved, which the evaluator
 * already refuses (`not-delete-config`). It is never upgraded to a compliant
 * value.
 */
function normalizeConfig(raw: unknown): StoreConfigObservation {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const journalMode = source.journalMode;
  return {
    journalMode:
      journalMode === "delete" || journalMode === "wal" || journalMode === "other"
        ? journalMode
        : "unreadable",
    source: isNonEmptyString(source.source) ? source.source : GATE_RECEIPT_UNREADABLE,
    observed: source.observed === true,
  };
}

/** Format the refusal detail for a verdict, naming codes, stores and failures. */
function formatVerdictDetail(
  verdict: GateVerdict,
  observationFailures: readonly string[],
): string {
  const codes: string[] = [];
  for (const finding of verdict.findings) {
    if (!codes.includes(finding.code)) codes.push(finding.code);
  }
  const stores: string[] = [];
  for (const finding of verdict.findings) {
    if (isNonEmptyString(finding.store) && !stores.includes(finding.store)) {
      stores.push(finding.store);
    }
  }
  const parts = [
    `launch gate refused: ${verdict.findings.length} finding(s) [${codes.join(", ")}]`,
  ];
  if (stores.length > 0) parts.push(`stores: ${stores.join(", ")}`);
  if (observationFailures.length > 0) {
    parts.push(`store observation failed for: ${observationFailures.join("; ")}`);
  }
  return bounded(parts.join("; "));
}

/** Format the refusal detail for a failed revalidation. */
function formatRevalidationDetail(changes: readonly LaunchGateChange[]): string {
  if (changes.length === 0) {
    return bounded(
      "launch gate refused: revalidation could not prove the observed store set and config were unchanged before the launch",
    );
  }
  const rendered = changes.slice(0, 8).map((change) => {
    const code = isNonEmptyString(change?.code) ? change.code : "changed";
    const storePath = isNonEmptyString(change?.storePath)
      ? change.storePath
      : "(unknown store)";
    const field = isNonEmptyString(change?.field) ? ` (${change.field})` : "";
    const hasBeforeAfter =
      isNonEmptyString(change?.before) || isNonEmptyString(change?.after);
    const transition = hasBeforeAfter
      ? `: ${isNonEmptyString(change?.before) ? change.before : "unknown"} -> ${
          isNonEmptyString(change?.after) ? change.after : "unknown"
        }`
      : "";
    return `${code} at ${storePath}${field}${transition}`;
  });
  return bounded(`launch gate refused: revalidation changed ${rendered.join("; ")}`);
}

// ---------------------------------------------------------------------------
// the one evaluator
// ---------------------------------------------------------------------------

/**
 * Run the gate for one invocation and record the outcome.
 *
 * Sync by design: every seam it calls (store enumeration, byte observation,
 * receipt write) is synchronous, and an async gate would let a caller interleave
 * work between the revalidation and the VM create — the very window this
 * module exists to close.
 *
 * Returns a bound allow decision, or a refusal that is ALREADY RECORDED (or,
 * when the receipt could not be written, explicitly recorded as unwritten).
 * There is no third outcome: a refusal never returns an allow-shaped value, and
 * an allow never returns without a store-set key and a receipt path.
 */
export function evaluateAndRecordLaunchGate(
  scope: LaunchGateInvocationScope,
  deps: LaunchGateWiringDeps = {},
): LaunchGateDecision {
  // A caller that passes no scope at all still gets a recorded refusal rather
  // than a thrown TypeError: the gate never fails by throwing at its caller.
  const safeScope: LaunchGateInvocationScope =
    typeof scope === "object" && scope !== null
      ? scope
      : ({} as LaunchGateInvocationScope);

  const now = deps.now ?? nowIso;
  const observationStartedAt = now();
  const receiptPath = resolveLaunchGateReceiptPath({
    stateDir: isNonEmptyString(deps.stateDir) ? deps.stateDir : resolveStateDir(),
    invocationId: safeScope.invocationId,
  });
  const host: LaunchGateHostRevisions = {
    hermesRevision: deps.hostRevisions?.hermesRevision ?? GATE_RECEIPT_UNREADABLE,
    matchlockRevision: deps.hostRevisions?.matchlockRevision ?? GATE_RECEIPT_UNREADABLE,
    tamanduaRevision: deps.hostRevisions?.tamanduaRevision ?? GATE_RECEIPT_UNREADABLE,
  };

  // Receipt fields are filled in as the observation advances, so a refusal at
  // any stage records everything learned up to that point.
  let profile = GATE_RECEIPT_UNREADABLE;
  let guestConfigDir = GATE_RECEIPT_UNREADABLE;
  let storeSetKey = GATE_RECEIPT_UNREADABLE;
  let inventoryComplete = false;
  let receiptStores: ReceiptStore[] = [];
  let discoveredUnexpected: string[] = [];
  let holderDetection = toReceiptHolderDetection(
    { observationComplete: false, holders: [], probeFailures: [] },
    false,
  );

  /** Write the refusal receipt FIRST, then return the refusal. */
  const refuse = (
    kind: "verdict" | "operational",
    detail: string,
    verdict: GateVerdict | null,
    findings: readonly Finding[],
  ): LaunchGateDecision => {
    const observationFinishedAt = now();
    const input = buildReceiptInput({
      scope: safeScope,
      profile,
      guestConfigDir,
      storeSetKey,
      inventoryComplete,
      stores: receiptStores,
      discoveredUnexpected,
      holderDetection,
      verdict: "refuse",
      findings,
      host,
      observationStartedAt,
      observationFinishedAt,
      receiptWrittenAt: now(),
    });

    let receiptWritten = false;
    let writeFailure = "";
    try {
      (deps.ensureReceiptDirectory ?? ensureDirectory)(path.dirname(receiptPath));
      const writer = deps.writeRefusalReceipt ?? writeRefusalReceipt;
      const result = writer(input, { path: receiptPath });
      receiptWritten = result?.ok === true;
      if (!receiptWritten) {
        writeFailure = result?.ok === false ? result.detail : "the receipt writer returned no outcome";
      }
    } catch (error) {
      writeFailure = describeError(error);
    }

    // A receipt that could not be recorded is an OPERATIONAL refusal: the gate
    // machinery failed, which is never one of the ten reason codes and never an
    // allow. The verdict's findings are preserved so the operator still learns
    // why the launch was refused.
    const effectiveKind = receiptWritten ? kind : "operational";
    const effectiveDetail = receiptWritten
      ? detail
      : bounded(
          `${detail}; the refusal receipt could not be written at ${receiptPath}: ${writeFailure}`,
        );
    const effectiveFindings = [...findings];
    const exitCode = exitCodeForGateOutcome(
      effectiveKind === "verdict"
        ? { action: "refuse", findings: effectiveFindings }
        : { action: "operational-refusal", detail: effectiveDetail },
    );

    return {
      action: "refuse",
      refusal: {
        kind: effectiveKind,
        detail: effectiveDetail,
        receiptPath,
        receiptWritten,
        exitCode,
        verdict,
        findings: effectiveFindings,
      },
    };
  };

  // --- 0. the scope itself -------------------------------------------------
  if (!isNonEmptyString(safeScope.invocationId)) {
    return refuse(
      "operational",
      "the launch scope carries no invocation id, so a gate verdict could not be bound to an invocation",
      null,
      [],
    );
  }
  if (!INVOCATION_KINDS.includes(safeScope.kind)) {
    return refuse(
      "operational",
      `the launch scope names an unknown invocation kind (${String(safeScope.kind)}); a verdict could not be recorded for it`,
      null,
      [],
    );
  }

  // --- 1. profile + selection ---------------------------------------------
  let resolved: LaunchGateResolvedProfile;
  try {
    resolved = (deps.selection ?? defaultSelectionResolver)(scope);
  } catch (error) {
    return refuse(
      "operational",
      `the profile/selection could not be resolved: ${describeError(error)}`,
      null,
      [],
    );
  }
  if (isNonEmptyString(resolved?.profile)) profile = resolved.profile;
  if (isNonEmptyString(resolved?.guestConfigDir)) guestConfigDir = resolved.guestConfigDir;
  const profileHome = resolved?.profileHome;
  if (!isNonEmptyString(profileHome) || !path.isAbsolute(profileHome)) {
    return refuse(
      "operational",
      "the profile/selection did not resolve to an absolute profile home, so no store could be observed",
      null,
      [],
    );
  }

  // --- 2/3. final mount plan + store set -----------------------------------
  // The mount plan is used exactly as supplied: it is the plan the controller
  // will be handed, so re-deriving one here would evaluate a different launch.
  let storeSet: StoreSet;
  try {
    storeSet = (deps.resolveStoreSet ?? resolveStoreSet)({
      profileHome,
      mountPlan: safeScope.mountPlan,
      storeContract: safeScope.storeContract ?? LAUNCH_GATE_STORE_CONTRACT,
    });
  } catch (error) {
    const code = error instanceof StoreSetInputError ? error.code : "store-set-failed";
    return refuse(
      "operational",
      `the store set could not be resolved (${code}): ${describeError(error)}`,
      null,
      [],
    );
  }

  // --- 4. observe EVERY store ---------------------------------------------
  let config: StoreConfigObservation;
  try {
    config = normalizeConfig(
      (deps.resolveEffectiveJournalMode ?? resolveEffectiveJournalMode)(
        profileHome,
        safeScope.configOptions,
      ),
    );
  } catch (error) {
    // The effective config is a required observation: without it no store can
    // be shown to request the delete journal mode, so this is an operational
    // refusal rather than a guessed compliant value.
    return refuse(
      "operational",
      `the effective journal-mode configuration could not be observed: ${describeError(error)}`,
      null,
      [],
    );
  }

  const records: ObservedStoreRecord[] = [];
  const observationFailures: string[] = [];
  const identities: readonly StoreIdentity[] = Array.isArray(storeSet?.stores)
    ? storeSet.stores
    : [];
  for (const identity of identities) {
    const requestedPath = identity?.canonicalPath ?? identity?.pathAliases?.[0] ?? "";
    const classification: StoreClassification = identity?.classification ?? "optional-present";
    try {
      const observation = (deps.observeStore ?? observeStore)(requestedPath);
      records.push({
        observationFailed: false,
        store: (deps.adaptStoreObservation ?? adaptStoreObservation)(
          observation,
          classification,
          {
            config,
            dev: identity?.dev ?? null,
            ino: identity?.ino ?? null,
            fstype: identity?.fstype ?? null,
          },
        ),
      });
    } catch (error) {
      observationFailures.push(describeObservationFailure(requestedPath, error));
      records.push(unresolvedRecord(requestedPath, classification));
    }
  }

  // --- 4b. informational holder detection ---------------------------------
  const holderStores: HolderStore[] = [];
  for (const record of records) {
    const identity = record.store.identity;
    if (
      identity === null ||
      !isNonEmptyString(identity.canonicalPath) ||
      !isNonEmptyString(identity.dev) ||
      !isNonEmptyString(identity.ino)
    ) {
      continue;
    }
    holderStores.push({
      canonicalPath: identity.canonicalPath,
      dev: identity.dev,
      ino: identity.ino,
    });
  }
  const probeSupplied = typeof deps.holderProbe === "function";
  let detection: HolderDetection;
  if (probeSupplied) {
    try {
      detection = detectStoreHolders(holderStores, {
        listOpenFileHolders: deps.holderProbe as LaunchGateHolderProbe,
      });
    } catch (error) {
      detection = {
        observationComplete: false,
        holders: [],
        probeFailures: [{ scope: "holder-probe", reason: describeError(error) }],
      };
    }
  } else {
    detection = {
      observationComplete: false,
      holders: [],
      probeFailures: [{ scope: "holder-probe", reason: NO_HOLDER_PROBE_REASON }],
    };
  }
  holderDetection = toReceiptHolderDetection(detection, probeSupplied);

  // --- 5. evaluate the aggregate ------------------------------------------
  const gateInput: GateInput = {
    inventoryComplete: storeSet?.inventoryComplete === true,
    incompleteReasons: Array.isArray(storeSet?.incompleteReasons)
      ? storeSet.incompleteReasons
      : [],
    stores: records.map((record) => record.store),
  };

  let verdict: GateVerdict;
  try {
    verdict = (deps.evaluateGate ?? evaluateGate)(gateInput);
  } catch (error) {
    return refuse(
      "operational",
      `the gate evaluator failed: ${describeError(error)}`,
      null,
      [],
    );
  }
  if (
    typeof verdict !== "object" ||
    verdict === null ||
    (verdict.action !== "allow" && verdict.action !== "refuse") ||
    !Array.isArray(verdict.findings)
  ) {
    return refuse(
      "operational",
      "the gate evaluator returned no usable verdict",
      null,
      [],
    );
  }

  // Receipt stores are computed BEFORE the identity binding, so even a binding
  // failure records every observation that was actually made.
  receiptStores = records.map((record) => toReceiptStore(record, verdict.findings));
  discoveredUnexpected = (Array.isArray(storeSet?.discoveredUnexpected)
    ? storeSet.discoveredUnexpected
    : []
  ).map((identity) => identity?.canonicalPath ?? identity?.pathAliases?.[0] ?? "");

  // Identity binding: an allow must be bound to concrete (path, dev, ino)
  // identities, so a present store with an unestablished identity fails closed
  // instead of silently dropping out of the key.
  const boundStores: LaunchGateBoundStore[] = [];
  for (const record of records) {
    const identity = record.store.identity;
    if (identity === null) continue;
    if (
      !isNonEmptyString(identity.canonicalPath) ||
      !isNonEmptyString(identity.dev) ||
      !isNonEmptyString(identity.ino)
    ) {
      return refuse(
        "operational",
        `the filesystem identity of store ${record.store.requestedPath} could not be established, so the launch could not be bound to it`,
        verdict,
        verdict.findings,
      );
    }
    boundStores.push({
      canonicalPath: identity.canonicalPath,
      dev: identity.dev,
      ino: identity.ino,
    });
  }

  storeSetKey = launchGateStoreSetKey({ kind: safeScope.kind, stores: boundStores });
  inventoryComplete = gateInput.inventoryComplete;

  if (verdict.action === "refuse") {
    return refuse(
      "verdict",
      formatVerdictDetail(verdict, observationFailures),
      verdict,
      verdict.findings,
    );
  }

  // --- 6. revalidate membership + config by identity ----------------------
  // A refusal above needs no revalidation: nothing will be created. An allow
  // always does, and the PRODUCTION revalidation is the default (US-002), so a
  // caller that injects nothing still gets the real identity re-stat and the
  // real config re-read. An injected seam replaces it for tests and for a
  // caller that must control the observe-to-create window itself.
  const revalidate: LaunchGateRevalidate =
    typeof deps.revalidate === "function"
      ? deps.revalidate
      : (snapshot) =>
          revalidateLaunchGateSnapshot(snapshot, {
            profileHome,
            configOptions: safeScope.configOptions,
            resolveEffectiveJournalMode: (home, options) =>
              (deps.resolveEffectiveJournalMode ?? resolveEffectiveJournalMode)(home, options),
            // Membership must be comparable BOTH ways: a store that appeared
            // after the observation is a change too. A fresh resolution of the
            // same inputs (profile home + final mount plan + store contract)
            // gives the current set without re-reading any store header.
            currentStorePaths: () =>
              resolvedStorePaths(
                (deps.resolveStoreSet ?? resolveStoreSet)({
                  profileHome,
                  mountPlan: safeScope.mountPlan,
                  storeContract: safeScope.storeContract ?? LAUNCH_GATE_STORE_CONTRACT,
                }),
              ),
          });

  let revalidation: LaunchGateRevalidation;
  try {
    revalidation = revalidate(captureLaunchGateSnapshot(boundStores, config));
  } catch (error) {
    return refuse(
      "operational",
      `revalidation could not run: ${describeError(error)}`,
      verdict,
      verdict.findings,
    );
  }
  if (revalidation?.unchanged !== true) {
    const changes = Array.isArray(revalidation?.changes) ? revalidation.changes : [];
    return refuse("operational", formatRevalidationDetail(changes), verdict, []);
  }

  // --- 7. allow ------------------------------------------------------------
  const decidedAt = now();
  const binding: LaunchGateBinding = {
    invocationId: safeScope.invocationId,
    kind: safeScope.kind,
    storeSetKey,
    receiptPath,
    decidedAt,
    stores: boundStores,
    configJournalMode: config.journalMode,
    configSource: config.source,
  };

  const receiptInput = buildReceiptInput({
    scope: safeScope,
    profile,
    guestConfigDir,
    storeSetKey,
    inventoryComplete,
    stores: receiptStores,
    discoveredUnexpected,
    holderDetection,
    verdict: "allow",
    findings: [],
    host,
    observationStartedAt,
    observationFinishedAt: decidedAt,
    receiptWrittenAt: decidedAt,
  });

  return { action: "allow", binding, receiptInput };
}

/**
 * Write the LAUNCH receipt for an allowed decision, after the VM exists.
 *
 * This is the only way this module ever writes an `action: "launched"` record,
 * and it refuses before any I/O unless `vmCreated === true`: a pre-create call
 * must never be able to assert that a launch happened. The receipt path is the
 * binding's, so the launch record lands where the refusal record would have.
 */
export function writeLaunchGateLaunchReceipt(
  decision: LaunchGateDecision,
  vmCreated: boolean,
  deps: LaunchGateWiringDeps = {},
): ReceiptWriteResult {
  if (decision?.action !== "allow") {
    return {
      ok: false,
      code: "receipt-write-failed",
      path: "",
      detail: "no launch receipt is written for a refusal",
    };
  }
  const receiptPath = decision.binding.receiptPath;
  if (vmCreated !== true) {
    return {
      ok: false,
      code: "receipt-write-failed",
      path: receiptPath,
      detail: "launch receipt requires vmCreated: true; no receipt written",
    };
  }
  try {
    (deps.ensureReceiptDirectory ?? ensureDirectory)(path.dirname(receiptPath));
  } catch (error) {
    return {
      ok: false,
      code: "receipt-write-failed",
      path: receiptPath,
      detail: describeError(error),
    };
  }
  const now = deps.now ?? nowIso;
  const writer = deps.writeLaunchReceipt ?? writeLaunchReceipt;
  return writer(
    { ...decision.receiptInput, vmCreated: true, receiptWrittenAt: now() },
    { path: receiptPath },
  );
}
