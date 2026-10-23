/**
 * Matchlock launch-gate receipt (schemaVersion 1, pure serialization half).
 *
 * G5 GATE-RECEIPT (bead tamandua-7p5.1.5). A gate decision is only durable if
 * it is written down. This module is the single place where one already-made
 * decision becomes a versioned, deterministic receipt that a dispatcher or an
 * operator can read after a refusal. It performs no observation, no policy
 * evaluation and no filesystem access of its own: the caller supplies a fully
 * populated plain object, including every instant as a string, and this module
 * emits one line of canonical JSON.
 *
 * WHY THIS SHAPE
 *
 *  - The receipt is written on BOTH paths, refusal and launch. A receipt that
 *    exists only on success proves nothing; the refusal case is the one an
 *    operator needs most.
 *  - Unmeasurable values are PRESENT and carry the literal `unreadable`. An
 *    omitted field would be indistinguishable from a field the writer forgot,
 *    so the serializer never drops a required key: an absent scalar becomes
 *    `unreadable` rather than disappearing.
 *  - Paths, versions, bytes and codes only. File contents, credentials, store
 *    data and row hashes are never part of the schema, and the serializer
 *    builds every object by whitelist instead of copying or spreading caller
 *    input, so extra caller properties can never reach the file.
 *  - Deterministic order and no ambient inputs. Key order is pinned by the
 *    literal construction below; there is no clock read, no randomness and no
 *    environment lookup. Identical observations serialize byte-identically.
 *    All timestamps are supplied strings, never read here.
 *  - The pre-flight receipt records the DECISION. It must not assert
 *    `launched`; only the launch path, after VM creation, may append that
 *    outcome. The serializer preserves the caller's explicit `action`, so a
 *    refusal writer can force `refused` and a launch writer can force
 *    `launched` without this pure half deciding anything.
 *  - Every observation keeps its PERSPECTIVE and PROVENANCE. Host metadata is
 *    not guest evidence: a guest transport that was not observed from inside
 *    the guest is recorded as `unmeasured`/`unknown`. There is deliberately no
 *    fstype field in the schema, so a host `statfs` value can never be
 *    presented as evidence of guest locking or shared-memory behaviour.
 *  - Holder detection is INFORMATIONAL. A failed probe is recorded as
 *    `observationComplete: false`; it is not a refusal and adds no finding.
 *  - The no-lease limitation is part of the receipt itself: there is no
 *    reservation or mutual exclusion, so concurrent admissions may both pass.
 *
 * MODULE BOUNDARY. This file writes exactly one file and does nothing else: no
 * decision logic and no observations of its own. The only ambient import is
 * `node:fs`, and only for the default write/rename/unlink seam; a caller can
 * inject all three, so a test can force a failure without permissions games.
 * The seam also means the write is part of the gate, not an afterthought: every
 * failure is a typed refusal result, never a thrown error a caller can swallow.
 * It imports no database driver and no child process module, and must stay in
 * the parallel test lane (it is not listed in tests/serial-files.txt).
 */

import fs from "node:fs";

/** The receipt schema this module emits. Bumped only for an incompatible shape. */
export const GATE_RECEIPT_SCHEMA_VERSION = 1;

/** Sentinel for a field that could not be measured. Never omit the field instead. */
export const GATE_RECEIPT_UNREADABLE = "unreadable";

/** Perspective of an observation that was not made at all. */
export const GATE_RECEIPT_UNMEASURED = "unmeasured";

/** Provenance of a value whose origin or correctness is not established. */
export const GATE_RECEIPT_UNKNOWN = "unknown";

/**
 * The no-lease limitation, stated inside every receipt. The gate is a
 * pre-flight check, not an ownership control.
 */
export const NO_LEASE_LIMITATION =
  "no-lease: concurrent admissions may both pass";

/** The `unreadable` sentinel as a type. */
export type Unreadable = typeof GATE_RECEIPT_UNREADABLE;

/**
 * Where an observation was made from. `unmeasured` means no observation was
 * made from any perspective and the value must not be inferred from another.
 */
export type ObservationPerspective =
  | "host"
  | "guest"
  | typeof GATE_RECEIPT_UNMEASURED;

/**
 * How an observation was obtained. `measured` is a real observation from the
 * recorded perspective; `unmeasured`/`unknown` means the fact was not
 * established and must not be replaced by a heuristic.
 */
export type ObservationProvenance =
  | "measured"
  | typeof GATE_RECEIPT_UNMEASURED
  | typeof GATE_RECEIPT_UNKNOWN;

/** Header classification. `unreadable` is a state, never an omission. */
export type ReceiptHeaderFormat =
  | "rollback"
  | "wal"
  | "unknown"
  | Unreadable;

/** Effective journal mode the runtime reads. `unreadable` is never `wal`. */
export type ReceiptJournalMode = "delete" | "wal" | "other" | Unreadable;

/** State of one sidecar. `unreadable` is never degraded to `absent`. */
export type ReceiptSidecarValue =
  | "absent"
  | "presentEmpty"
  | "presentNonEmpty"
  | Unreadable;

/** The recorded decision. `allow` only when no findings were produced. */
export type ReceiptVerdict = "allow" | "refuse";

/** What actually happened. A pre-flight record must never assert `launched`. */
export type ReceiptAction = "refused" | "launched";

/** The invocation that requested a launch. Optional ids are omitted when absent. */
export interface ReceiptInvocation {
  kind: string | Unreadable;
  /** Present only when the invocation carries one; omitted otherwise. */
  runId?: string;
  /** Present only when the invocation carries one; omitted otherwise. */
  roundId?: string;
  profile: string | Unreadable;
  guestConfigDir: string | Unreadable;
}

/**
 * Sidecar state together with the observation's perspective and provenance.
 * The three states are kept separate and are never collapsed.
 */
export interface ReceiptSidecarState {
  wal: ReceiptSidecarValue;
  shm: ReceiptSidecarValue;
  journal: ReceiptSidecarValue;
  perspective: ObservationPerspective;
  provenance: ObservationProvenance;
}

/** One observed store, in the pinned schema order. */
export interface ReceiptStore {
  canonicalPath: string | Unreadable;
  dev: string | Unreadable;
  ino: string | Unreadable;
  size: number | Unreadable;
  headerBytes: [number, number] | Unreadable;
  headerFormat: ReceiptHeaderFormat;
  sidecarState: ReceiptSidecarState;
  configJournalMode: ReceiptJournalMode;
  /** Names the provenance of the effective config (which layer was read). */
  configSource: string | Unreadable;
  readable: boolean | Unreadable;
  findingCodes: string[];
}

/** One actionable remedy step. The command is optional. */
export interface ReceiptRemedyStep {
  description: string | Unreadable;
  command?: string;
}

/** One reason the gate refused, optionally scoped to a store. */
export interface ReceiptFinding {
  code: string | Unreadable;
  /** Omitted for set-scoped findings, never invented as a placeholder. */
  store?: string | null;
  detail: string | Unreadable;
  remedy: ReceiptRemedyStep[];
}

/**
 * One informational holder. The command text must already be sanitized by the
 * caller: raw process arguments can carry credentials and are never serialized.
 */
export interface ReceiptHolder {
  pid: number | Unreadable;
  startedAt: string | Unreadable;
  command: string | Unreadable;
}

/**
 * Holder detection is informational only. `observationComplete: false` is a
 * valid recorded state: a failed probe adds no finding and never refuses.
 */
export interface ReceiptHolderDetection {
  observationComplete: boolean;
  holders: ReceiptHolder[];
  perspective: ObservationPerspective;
  provenance: ObservationProvenance;
  limitation: typeof NO_LEASE_LIMITATION;
}

/** Host revisions that produced the observations. Unknown is `unreadable`. */
export interface ReceiptHost {
  hermesRevision: string | Unreadable;
  matchlockRevision: string | Unreadable;
  tamanduaRevision: string | Unreadable;
}

/**
 * A complete schemaVersion 1 gate receipt. Top-level key order is exactly the
 * declaration order below and is pinned by the serializer and its tests.
 */
export interface GateReceipt {
  schemaVersion: typeof GATE_RECEIPT_SCHEMA_VERSION;
  invocation: ReceiptInvocation;
  storeSetKey: string | Unreadable;
  inventoryComplete: boolean;
  stores: ReceiptStore[];
  discoveredUnexpected: string[];
  holderDetection: ReceiptHolderDetection;
  verdict: ReceiptVerdict;
  findings: ReceiptFinding[];
  host: ReceiptHost;
  action: ReceiptAction;
  observationStartedAt: string | Unreadable;
  observationFinishedAt: string | Unreadable;
  receiptWrittenAt: string | Unreadable;
}

// ---------------------------------------------------------------------------
// whitelist value helpers
//
// Every helper either returns a caller-supplied value of an allowed shape or
// the fail-safe sentinel for that field. Nothing is spread or copied wholesale
// from caller input, so unknown properties cannot ride along.
// ---------------------------------------------------------------------------

function textValue(value: string | Unreadable | undefined): string | Unreadable {
  return typeof value === "string" ? value : GATE_RECEIPT_UNREADABLE;
}

function numberValue(
  value: number | Unreadable | undefined,
): number | Unreadable {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : GATE_RECEIPT_UNREADABLE;
}

function booleanValue(
  value: boolean | Unreadable | undefined,
): boolean | Unreadable {
  return typeof value === "boolean" ? value : GATE_RECEIPT_UNREADABLE;
}

function headerBytesValue(
  value: [number, number] | Unreadable | undefined,
): [number, number] | Unreadable {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    return [value[0], value[1]];
  }
  return GATE_RECEIPT_UNREADABLE;
}

function headerFormatValue(
  value: ReceiptHeaderFormat | undefined,
): ReceiptHeaderFormat {
  switch (value) {
    case "rollback":
    case "wal":
    case "unknown":
    case GATE_RECEIPT_UNREADABLE:
      return value;
    default:
      return GATE_RECEIPT_UNREADABLE;
  }
}

function journalModeValue(
  value: ReceiptJournalMode | undefined,
): ReceiptJournalMode {
  switch (value) {
    case "delete":
    case "wal":
    case "other":
    case GATE_RECEIPT_UNREADABLE:
      return value;
    default:
      return GATE_RECEIPT_UNREADABLE;
  }
}

function sidecarValue(
  value: ReceiptSidecarValue | undefined,
): ReceiptSidecarValue {
  switch (value) {
    case "absent":
    case "presentEmpty":
    case "presentNonEmpty":
    case GATE_RECEIPT_UNREADABLE:
      return value;
    default:
      return GATE_RECEIPT_UNREADABLE;
  }
}

function perspectiveValue(
  value: ObservationPerspective | undefined,
): ObservationPerspective {
  switch (value) {
    case "host":
    case "guest":
    case GATE_RECEIPT_UNMEASURED:
      return value;
    default:
      return GATE_RECEIPT_UNMEASURED;
  }
}

function provenanceValue(
  value: ObservationProvenance | undefined,
): ObservationProvenance {
  switch (value) {
    case "measured":
    case GATE_RECEIPT_UNMEASURED:
    case GATE_RECEIPT_UNKNOWN:
      return value;
    default:
      return GATE_RECEIPT_UNKNOWN;
  }
}

/** Copy string entries only; a non-string caller value is not inspected. */
function stringArray(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Placeholder for a credential-shaped segment. Not itself a value. */
const REDACTED = "[redacted]";

/**
 * Redact credential-shaped text from human-readable receipt fields.
 *
 * The receipt may name a process or describe a remedy, but process arguments
 * and error messages can carry credentials. The schema therefore never stores
 * a raw argv array, and every free-text field the caller supplies for a holder
 * or a finding is scrubbed here: `sk-` keys, `Bearer` credentials, and
 * `token=`/`key=` assignments are replaced before they can reach the file.
 *
 * The function is deterministic and idempotent, so it does not disturb the
 * byte-identical serialization guarantee or a parse/serialize round-trip.
 */
function redactText(value: string): string {
  return value
    .replace(/(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]+/gi, `$1${REDACTED}`)
    .replace(/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(token|key)=("[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1=${REDACTED}`);
}

function redactSensitiveText(
  value: string | Unreadable | undefined,
): string | Unreadable {
  return typeof value === "string"
    ? redactText(value)
    : GATE_RECEIPT_UNREADABLE;
}

// ---------------------------------------------------------------------------
// serializer
// ---------------------------------------------------------------------------

function serializeInvocation(
  invocation: ReceiptInvocation | undefined,
): ReceiptInvocation {
  const source = invocation ?? ({} as ReceiptInvocation);
  // Optional ids are emitted only when actually supplied, so a receipt with
  // no run/round ids round-trips without them. Spread order preserves the
  // pinned key order of the object literal.
  return {
    kind: textValue(source.kind),
    ...(typeof source.runId === "string" ? { runId: source.runId } : {}),
    ...(typeof source.roundId === "string" ? { roundId: source.roundId } : {}),
    profile: textValue(source.profile),
    guestConfigDir: textValue(source.guestConfigDir),
  };
}

function serializeSidecarState(
  state: ReceiptSidecarState | undefined,
): ReceiptSidecarState {
  const source = state ?? ({} as ReceiptSidecarState);
  return {
    wal: sidecarValue(source.wal),
    shm: sidecarValue(source.shm),
    journal: sidecarValue(source.journal),
    perspective: perspectiveValue(source.perspective),
    provenance: provenanceValue(source.provenance),
  };
}

function serializeStore(store: ReceiptStore): ReceiptStore {
  return {
    canonicalPath: textValue(store.canonicalPath),
    dev: textValue(store.dev),
    ino: textValue(store.ino),
    size: numberValue(store.size),
    headerBytes: headerBytesValue(store.headerBytes),
    headerFormat: headerFormatValue(store.headerFormat),
    sidecarState: serializeSidecarState(store.sidecarState),
    configJournalMode: journalModeValue(store.configJournalMode),
    configSource: textValue(store.configSource),
    readable: booleanValue(store.readable),
    findingCodes: stringArray(store.findingCodes),
  };
}

function serializeRemedy(remedy: ReceiptRemedyStep[] | undefined): ReceiptRemedyStep[] {
  if (!Array.isArray(remedy)) {
    return [];
  }
  return remedy.map((step) => {
    const out: ReceiptRemedyStep = {
      description: redactSensitiveText(step.description),
    };
    if (typeof step.command === "string") {
      out.command = redactText(step.command);
    }
    return out;
  });
}

function serializeFinding(finding: ReceiptFinding): ReceiptFinding {
  return {
    code: textValue(finding.code),
    ...(typeof finding.store === "string" ? { store: finding.store } : {}),
    // An error message can echo a credential the caller supplied; scrub it
    // rather than copying the detail verbatim.
    detail: redactSensitiveText(finding.detail),
    remedy: serializeRemedy(finding.remedy),
  };
}

function serializeHolder(holder: ReceiptHolder): ReceiptHolder {
  return {
    pid: numberValue(holder.pid),
    startedAt: textValue(holder.startedAt),
    // Only a sanitized description is ever serialized; the schema has no
    // field for raw argv, which can carry tokens.
    command: redactSensitiveText(holder.command),
  };
}

function serializeHolderDetection(
  detection: ReceiptHolderDetection | undefined,
): ReceiptHolderDetection {
  const source = detection ?? ({} as ReceiptHolderDetection);
  return {
    observationComplete: source.observationComplete === true,
    holders: Array.isArray(source.holders)
      ? source.holders.map(serializeHolder)
      : [],
    perspective: perspectiveValue(source.perspective),
    provenance: provenanceValue(source.provenance),
    limitation: NO_LEASE_LIMITATION,
  };
}

function serializeHost(host: ReceiptHost | undefined): ReceiptHost {
  const source = host ?? ({} as ReceiptHost);
  return {
    hermesRevision: textValue(source.hermesRevision),
    matchlockRevision: textValue(source.matchlockRevision),
    tamanduaRevision: textValue(source.tamanduaRevision),
  };
}

/**
 * Serialize a complete receipt into one line of minified JSON with the pinned
 * schemaVersion 1 key order.
 *
 * The output contains no trailing newline: a writer appends exactly one. This
 * function is pure — identical input always yields byte-identical output.
 */
export function serializeReceipt(receipt: GateReceipt): string {
  const out: GateReceipt = {
    schemaVersion: GATE_RECEIPT_SCHEMA_VERSION,
    invocation: serializeInvocation(receipt.invocation),
    storeSetKey: textValue(receipt.storeSetKey),
    inventoryComplete: receipt.inventoryComplete === true,
    stores: Array.isArray(receipt.stores)
      ? receipt.stores.map(serializeStore)
      : [],
    discoveredUnexpected: stringArray(receipt.discoveredUnexpected),
    holderDetection: serializeHolderDetection(receipt.holderDetection),
    verdict: receipt.verdict === "allow" ? "allow" : "refuse",
    findings: Array.isArray(receipt.findings)
      ? receipt.findings.map(serializeFinding)
      : [],
    host: serializeHost(receipt.host),
    action: receipt.action === "launched" ? "launched" : "refused",
    observationStartedAt: textValue(receipt.observationStartedAt),
    observationFinishedAt: textValue(receipt.observationFinishedAt),
    receiptWrittenAt: textValue(receipt.receiptWrittenAt),
  };

  const serialized = JSON.stringify(out);
  if (typeof serialized !== "string") {
    // Unreachable for an object with no cycles or bigint values; kept so the
    // signature is honest under strict typing.
    throw new TypeError("gate receipt could not be serialized");
  }
  return serialized;
}

/**
 * Parse a serialized receipt. Only the versioned envelope is validated here;
 * the writer is the component that must never throw, not the reader. A text
 * that is not a JSON object carrying a supported schemaVersion is rejected so
 * an operator never mistakes an unrelated file for a gate receipt.
 */
export function parseReceipt(text: string): GateReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TypeError("gate receipt is not valid JSON", { cause: error });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("gate receipt must be a JSON object");
  }

  const envelope = parsed as { schemaVersion?: unknown };
  if (envelope.schemaVersion !== GATE_RECEIPT_SCHEMA_VERSION) {
    throw new TypeError(
      `unsupported gate receipt schemaVersion: ${String(envelope.schemaVersion)}`,
    );
  }

  return parsed as GateReceipt;
}

// ---------------------------------------------------------------------------
// atomic writer (the only I/O this module performs)
//
// The receipt is written on BOTH paths, refusal and launch, and the write is
// part of the gate: if it fails, the launch must refuse. A thrown error is easy
// for a caller to swallow, so every failure mode below is reported as the same
// typed result instead. The refusal and launch entry points are separate so a
// pre-flight record can never assert `launched`.
// ---------------------------------------------------------------------------

/** The outcome of attempting to write one receipt. Never a thrown error. */
export type ReceiptWriteResult =
  | { ok: true; path: string }
  | {
      ok: false;
      code: "receipt-write-failed";
      path: string;
      detail: string;
    };

/**
 * A receipt as supplied to a writer. The writer decides `action`, so a caller
 * does not have to guess it (and cannot sneak `launched` into a refusal).
 */
export type ReceiptWriteInput = Omit<GateReceipt, "action"> & {
  action?: ReceiptAction;
};

/**
 * Input to the launch writer. `vmCreated` must be exactly `true`, which is only
 * true after the VM creation succeeded; otherwise nothing is written.
 */
export type LaunchReceiptInput = ReceiptWriteInput & {
  vmCreated?: boolean;
};

/**
 * Injection seam for the single file write. All three operations default to
 * `node:fs`; a test injects a throwing implementation instead of playing with
 * permissions. The module catches every throw from them.
 */
export interface ReceiptWriteOptions {
  path: string;
  writeFile?: (path: string, data: string) => void;
  rename?: (from: string, to: string) => void;
  unlink?: (path: string) => void;
}

interface ResolvedWriteSeam {
  path: string;
  writeFile: (path: string, data: string) => void;
  rename: (from: string, to: string) => void;
  unlink: (path: string) => void;
}

/** Sibling temporary path used for the atomic write, then renamed into place. */
const TEMPORARY_SUFFIX = ".tmp";

function defaultWriteFile(filePath: string, data: string): void {
  fs.writeFileSync(filePath, data, { encoding: "utf8", mode: 0o600 });
}

function defaultRename(from: string, to: string): void {
  fs.renameSync(from, to);
}

function defaultUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best effort: an absent temporary file needs no cleanup.
  }
}

function resolveWriteSeam(
  options: ReceiptWriteOptions | undefined,
): ResolvedWriteSeam {
  const source = options ?? ({} as ReceiptWriteOptions);
  return {
    path: typeof source.path === "string" ? source.path : "",
    writeFile:
      typeof source.writeFile === "function"
        ? source.writeFile
        : defaultWriteFile,
    rename: typeof source.rename === "function" ? source.rename : defaultRename,
    unlink: typeof source.unlink === "function" ? source.unlink : defaultUnlink,
  };
}

function writeFailure(receiptPath: string, detail: string): ReceiptWriteResult {
  return {
    ok: false,
    code: "receipt-write-failed",
    path: receiptPath,
    detail,
  };
}

function errorDetail(error: unknown): string {
  try {
    if (
      error instanceof Error &&
      typeof error.message === "string" &&
      error.message.length > 0
    ) {
      return `receipt write failed: ${error.message}`;
    }
    const text = String(error);
    return text.length > 0 ? `receipt write failed: ${text}` : "receipt write failed";
  } catch {
    return "receipt write failed";
  }
}

/** Remove the temporary file, never letting cleanup itself escape. */
function cleanupTemporary(
  unlink: (path: string) => void,
  temporaryPath: string,
): void {
  try {
    unlink(temporaryPath);
  } catch {
    // Cleanup is best effort; the typed failure is still returned.
  }
}

/**
 * Serialize and write one receipt atomically. The destination only ever
 * appears through a rename of a fully written sibling, so a reader never sees
 * a partial record. On any failure the temporary file is removed (best effort)
 * and the typed failure is returned; nothing is thrown.
 */
function writeReceipt(
  input: ReceiptWriteInput,
  seam: ResolvedWriteSeam,
  action: ReceiptAction,
): ReceiptWriteResult {
  const receiptPath = seam.path;
  if (receiptPath === "") {
    return writeFailure(receiptPath, "receipt path is required");
  }

  const temporaryPath = receiptPath + TEMPORARY_SUFFIX;
  try {
    // `serializeReceipt` whitelists every field, so `vmCreated` and any other
    // caller extra never reach the file. The forced action wins over input.
    const decided = { ...input, action } as GateReceipt;
    const data = serializeReceipt(decided) + "\n";
    seam.writeFile(temporaryPath, data);
    seam.rename(temporaryPath, receiptPath);
    return { ok: true, path: receiptPath };
  } catch (error) {
    cleanupTemporary(seam.unlink, temporaryPath);
    return writeFailure(receiptPath, errorDetail(error));
  }
}

/**
 * Write a refusal receipt. `action` is forced to `refused`, so a pre-flight
 * call can never record `launched` even if the caller supplied that value.
 */
export function writeRefusalReceipt(
  input: ReceiptWriteInput,
  options: ReceiptWriteOptions,
): ReceiptWriteResult {
  let receiptPath = "";
  try {
    const seam = resolveWriteSeam(options);
    receiptPath = seam.path;
    return writeReceipt(input, seam, "refused");
  } catch (error) {
    return writeFailure(receiptPath, errorDetail(error));
  }
}

/**
 * Write a launch receipt. The launch outcome may only be recorded after the VM
 * exists: without `vmCreated: true` this returns a typed non-success result and
 * writes nothing at all.
 */
export function writeLaunchReceipt(
  input: LaunchReceiptInput,
  options: ReceiptWriteOptions,
): ReceiptWriteResult {
  let receiptPath = "";
  try {
    const seam = resolveWriteSeam(options);
    receiptPath = seam.path;
    const vmCreated =
      (input as LaunchReceiptInput | null | undefined)?.vmCreated === true;
    if (!vmCreated) {
      return writeFailure(
        receiptPath,
        "launch receipt requires vmCreated: true; no receipt written",
      );
    }
    return writeReceipt(input, seam, "launched");
  } catch (error) {
    return writeFailure(receiptPath, errorDetail(error));
  }
}
