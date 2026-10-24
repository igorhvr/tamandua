/**
 * Matchlock launch-gate QUALIFICATION record (G8 ADMISSION-INTEGRATION US-009,
 * bead tamandua-7p5.1.8).
 *
 * WHY A SECOND EVIDENCE FILE
 *
 * A gate receipt proves WHAT the gate decided. It cannot prove WHICH artifacts
 * produced that decision, and the qualification work proved the distinction is
 * not academic: the stock-Hermes delete-mode evidence originally came from a
 * DOCKER artifact (`sha256:d15b7b37.../linux-amd64`) while Matchlock resolves
 * this repository to `sha256:9140629c...`. Two different identifiers are not
 * proof of equivalence. A record that names "the repository image" without the
 * digest, or "the candidate checkout" without the dist root, is exactly the
 * ambiguity that let the two be conflated. This module therefore writes a
 * SIBLING record next to every gate receipt that binds the decision to the
 * artifacts that actually executed:
 *
 *  - the Tamandua commit / tree / dist version stamp of the EXECUTED dist;
 *  - the sha256 of the matchlock and guest-init binaries that ran;
 *  - the selected image reference plus its content and config digests;
 *  - the profile home, the guest HERMES home and the config layers read;
 *  - the candidate dist root and the resolved absolute binary paths the runner
 *    used (a checkout that merely exists is not evidence);
 *  - the run/attempt ids the decision belongs to;
 *  - the per-store guest-visible config, when one was measured from INSIDE the
 *    guest (a host-side read never establishes what the guest's Hermes sees, so
 *    an entry is only ever recorded with `perspective: "guest"`), plus the
 *    record's `discrepancy` flag when a MEASURED guest value disagrees with the
 *    host-observed one — the disagreement is recorded, the verdict is not
 *    rewritten (US-010 owns the guest measurement and the flag).
 *
 * THE RULES THIS MODULE ENFORCES
 *
 *  1. UNMEASURABLE IS PRESENT, NEVER ABSENT, NEVER FABRICATED. A value that
 *     could not be read is the shared `unreadable` sentinel
 *     ({@link GATE_RECEIPT_UNREADABLE}, imported from the receipt module so the
 *     two evidence files cannot disagree about the spelling). A field is never
 *     omitted and never guessed: "not recorded" and "recorded as X" stay
 *     distinguishable to a reader.
 *  2. WHITELIST CONSTRUCTION ONLY. Both the capture and the serializer build
 *     fresh object literals from named fields. Nothing is spread or copied
 *     wholesale from caller input, so an extra property — a raw argv array, a
 *     config body, a credential — cannot ride along into the file. The schema
 *     has no field for file contents and no field for raw argv, and the
 *     free-text fields it does have are scrubbed before serialization.
 *  3. THE EXECUTED ARTIFACT BEATS THE CLAIMED ONE. When the executed
 *     `dist/version` stamp carries a git commit, that commit is what the record
 *     names — a caller-supplied value that disagreed with the artifact it ran
 *     is not written as the executed identity. The tree cannot be proven from
 *     the stamp, so it is caller-supplied or `unreadable`; it is never derived.
 *  4. NO THROW. Every injected seam (digest reader, stamp reader, source
 *     identity, filesystem writer) is wrapped, and every failure is a typed
 *     result. A qualification record that cannot be written is reported as a
 *     failure the caller must treat as one; it is never an exception a caller
 *     can swallow, and never a silent success.
 *  5. DETERMINISTIC BYTES. Key order is pinned by the literal construction
 *     below; there is no clock read, no randomness and no environment lookup in
 *     the serializer, so identical inputs serialize byte-identically. All
 *     instants (if a caller later adds one) are supplied strings. The two list
 *     fields that are SETS (config sources, executed binary paths) are deduped
 *     and byte-sorted; the ordered per-store list keeps its order.
 *  6. THE LIMITATIONS ARE IN THE RECORD. There is no lease: concurrent
 *     admissions may both pass, so the record states that rather than implying
 *     exclusion. A raw `matchlock run` carrying a hermes payload is explicitly
 *     OUT OF SCOPE — it never passes through the wired callers, and the record
 *     says so instead of implying coverage. The gated invocation kinds are
 *     listed so a reader can see which four surfaces the record covers.
 *
 * MODULE BOUNDARY. Pure serialization plus an injected filesystem seam: no
 * child process (the `matchlock --version` probe and the sha256 of the file
 * bytes are supplied by the caller or read with `node:fs`/`node:crypto` only),
 * no database driver, no observation and no evaluation. It performs no gate
 * decision, so it imports no exit-code owner: a qualification record is
 * evidence about a decision, never a status. It stays in the PARALLEL test
 * lane (it is not listed in `tests/serial-files.txt`).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getBuildVersion } from "../../lib/version.js";
import {
  GATE_RECEIPT_UNREADABLE,
  NO_LEASE_LIMITATION,
  type Unreadable,
} from "./gate-receipt.js";
import type { PinnedImageIdentity } from "./image.js";
import type {
  LaunchGateDecision,
  LaunchGateInvocationKind,
} from "./launch-gate-wiring.js";

/**
 * Re-exported so a caller that holds only a qualification record can compare
 * against the same sentinel the gate receipt uses.
 */
export { GATE_RECEIPT_UNREADABLE };
export type { Unreadable };

/** The record schema this module emits. Bumped only for an incompatible shape. */
export const GATE_QUALIFICATION_SCHEMA_VERSION = 1 as const;

/**
 * Identifies the sidecar so an operator (or a future reader) can never mistake
 * it for a gate receipt. The receipt and the qualification record sit in the
 * same directory on purpose: the decision and its artifact binding travel
 * together.
 */
export const GATE_QUALIFICATION_RECORD_KIND =
  "matchlock-gate-qualification" as const;

/**
 * The invocation kinds the wired callers gate, in the wiring's declaration
 * order. Every one of them can produce a receipt, and therefore a qualification
 * record.
 */
export const GATE_QUALIFICATION_GATED_KINDS: readonly LaunchGateInvocationKind[] =
  [
    "interactive-hermes",
    "interactive-hermes-shell",
    "scheduled-dispatch",
    "scheduled-attempt",
  ];

/**
 * Explicitly NOT covered. A raw `matchlock run` handing Matchlock a hermes
 * payload never passes through a wired caller, so no gate verdict — and no
 * qualification record — is produced for it. The record says so rather than
 * letting a reader infer coverage that does not exist.
 */
export const GATE_QUALIFICATION_OUT_OF_SCOPE: readonly string[] = [
  "raw matchlock run with a hermes payload",
];

/** The no-lease limitation, stated with the receipt's own sentence. */
export const GATE_QUALIFICATION_LEASE = NO_LEASE_LIMITATION;

/**
 * What the record binds to for the invocation. `runId`/`roundId` are emitted
 * only when the invocation actually carried one (an interactive invocation has
 * neither, and inventing an empty string would misrepresent it).
 */
export interface QualificationInvocation {
  invocationId: string | Unreadable;
  kind: string | Unreadable;
  runId?: string;
  roundId?: string;
}

/** Which receipt this record describes, and the verdict it recorded. */
export interface QualificationReceiptRef {
  path: string | Unreadable;
  storeSetKey: string | Unreadable;
  verdict: "allow" | "refuse" | Unreadable;
}

/** The Tamandua side of the binding: the source identity of the executed dist. */
export interface QualificationTamandua {
  /** Commit of the executed dist, from its own stamp. `unreadable` otherwise. */
  commit: string | Unreadable;
  /** Work-tree identity. Cannot be proven from the dist, never derived. */
  tree: string | Unreadable;
  /** Contents of the executed `dist/version` (scripts/inject-version.js). */
  distVersionStamp: string | Unreadable;
}

/** The Matchlock CLI artifact that actually ran. */
export interface QualificationMatchlock {
  path: string | Unreadable;
  /** Bare lowercase hex sha256 of that file's bytes. */
  sha256: string | Unreadable;
  /** Reported version line, scrubbed. */
  version: string | Unreadable;
}

/** The guest-init artifact that actually ran. */
export interface QualificationGuestInit {
  path: string | Unreadable;
  sha256: string | Unreadable;
}

/**
 * The selected image the guest booted. The digest is kept in its conventional
 * `sha256:` form (unlike a binary digest, which is recorded bare) so it can be
 * compared with what Matchlock and the registry report.
 */
export interface QualificationImage {
  reference: string | Unreadable;
  digest: string | Unreadable;
  configDigest: string | Unreadable;
}

/** The profile the gate read, and the config layers that fed the verdict. */
export interface QualificationProfiles {
  hostEffectiveDir: string | Unreadable;
  guestHermesHome: string | Unreadable;
  /** Set: deduped and byte-sorted config layer sources. */
  configSources: string[];
}

/**
 * The candidate that executed — not a checkout that merely exists. `distRoot`
 * is the executed `dist/` directory; `executedBinaryPaths` are the resolved
 * absolute paths the runner used (a set, deduped and byte-sorted).
 */
export interface QualificationCandidate {
  distRoot: string | Unreadable;
  executedBinaryPaths: string[];
}

/**
 * One store's guest-visible effective config. The perspective is ALWAYS
 * `guest`: a host-side read of the same file does not establish what the
 * guest's Hermes sees, so this record never presents one as the other.
 * `provenance: "unmeasured"` is a valid, recorded state and never `delete`.
 */
export interface QualificationGuestVisibility {
  storePath: string | Unreadable;
  journalMode: string | Unreadable;
  source: string | Unreadable;
  readable: boolean | Unreadable;
  perspective: "guest";
  provenance: "measured" | "unmeasured" | "unknown";
}

/** What the record covers, and what it explicitly does not. */
export interface QualificationScope {
  gatedKinds: string[];
  outOfScope: string[];
  lease: string;
}

/**
 * A complete qualification record. Top-level key order is exactly the
 * declaration order below and is pinned by the serializer and its tests.
 */
export interface QualificationRecord {
  schemaVersion: typeof GATE_QUALIFICATION_SCHEMA_VERSION;
  recordKind: typeof GATE_QUALIFICATION_RECORD_KIND;
  invocation: QualificationInvocation;
  receipt: QualificationReceiptRef;
  tamandua: QualificationTamandua;
  matchlock: QualificationMatchlock;
  guestInit: QualificationGuestInit;
  image: QualificationImage;
  profiles: QualificationProfiles;
  candidate: QualificationCandidate;
  guestVisibility: QualificationGuestVisibility[];
  /**
   * G8 US-010: TRUE when a MEASURED guest-visible journal mode disagrees with
   * the host-observed one. It is evidence of a disagreement, never a second
   * decision: the receipt keeps the verdict it recorded, and an unknown,
   * unreadable or unmeasured value can never set this flag (nothing was
   * compared). Always present, so a reader can tell "compared and agreed"
   * (`false`) from "not compared" only by the per-store provenance.
   */
  discrepancy: boolean;
  scope: QualificationScope;
}

// ---------------------------------------------------------------------------
// capture inputs
//
// Every field is optional: a caller that knows less records less, and the
// missing values stay `unreadable`. The block below is caller-visible data
// only — the seams that measure it live in the deps interface.
// ---------------------------------------------------------------------------

/** Caller-supplied invocation identity for the record. */
export interface QualificationInvocationInput {
  invocationId?: string;
  kind?: string;
  runId?: string;
  roundId?: string;
}

/** Caller-supplied receipt identity (the binding wins where it carries one). */
export interface QualificationReceiptInput {
  path?: string;
  storeSetKey?: string;
}

/** Caller-supplied Matchlock artifact facts. */
export interface QualificationMatchlockInput {
  path?: string;
  version?: string;
  /** Pre-computed digest (e.g. from the gate driver's observed-runtime file). */
  sha256?: string;
}

/** Caller-supplied guest-init artifact facts. */
export interface QualificationGuestInitInput {
  path?: string;
  sha256?: string;
}

/**
 * Caller-supplied image facts. An admission `PinnedImageIdentity` can be handed
 * over as-is; explicit `digest`/`configDigest` fields win when both are given.
 */
export interface QualificationImageInput {
  reference?: string;
  digest?: string;
  configDigest?: string;
  pinnedIdentity?: PinnedImageIdentity | null;
}

/** Caller-supplied profile and config-layer facts. */
export interface QualificationProfilesInput {
  hostEffectiveDir?: string;
  guestHermesHome?: string;
  configSources?: string[];
}

/** Caller-supplied candidate facts. */
export interface QualificationCandidateInput {
  distRoot?: string;
  executedBinaryPaths?: string[];
}

/** One caller-supplied guest-visible observation, before whitelisting. */
export interface QualificationGuestVisibilityInput {
  storePath?: string;
  journalMode?: string;
  source?: string;
  readable?: boolean;
  provenance?: string;
}

/** Everything a caller can state about the artifacts behind one decision. */
export interface QualificationCaptureInputs {
  invocation?: QualificationInvocationInput;
  receipt?: QualificationReceiptInput;
  tamandua?: Partial<QualificationTamandua>;
  matchlock?: QualificationMatchlockInput;
  guestInit?: QualificationGuestInitInput;
  image?: QualificationImageInput;
  profiles?: QualificationProfilesInput;
  candidate?: QualificationCandidateInput;
  guestVisibility?: QualificationGuestVisibilityInput[];
}

// ---------------------------------------------------------------------------
// deps seams
//
// A seam is how the record is MEASURED without this module ever spawning a
// process. Each has a documented default; each call is wrapped so a throwing
// seam degrades to `unreadable` instead of aborting the record.
// ---------------------------------------------------------------------------

/** Measurement seams for capture. */
export interface QualificationCaptureDeps {
  /**
   * sha256 (hex) of one file's bytes; `null` when it cannot be read. The
   * default streams the file in bounded chunks with `node:fs`/`node:crypto`.
   */
  sha256File?: (filePath: string) => string | null;
  /**
   * Contents of the EXECUTED dist's version stamp. Default reads
   * `dist/version` through `getBuildVersion()` (the same file
   * scripts/inject-version.js writes).
   */
  readDistVersionStamp?: () => string | null;
  /**
   * Commit + work-tree of the source that produced the executed dist. There is
   * no way to derive a tree from the dist itself, and this module never spawns
   * git, so the default is `null` (both stay `unreadable`). A caller that has
   * the source identity injects it.
   */
  resolveTamanduaSourceIdentity?: () => {
    commit?: string;
    tree?: string;
  } | null;
}

/**
 * The write outcome. A failure is typed, never thrown, so a caller that must
 * treat an unwritten qualification record as a launch problem can do so.
 */
export type QualificationWriteResult =
  | { ok: true; path: string }
  | {
      ok: false;
      code: "qualification-write-failed";
      path: string;
      detail: string;
    };

/** Injection seam for the single atomic write and its directory creation. */
export interface QualificationWriteDeps {
  /** Explicit destination (tests); default derived from `record.receipt.path`. */
  path?: string;
  mkdir?: (directory: string) => void;
  writeFile?: (filePath: string, data: string) => void;
  rename?: (from: string, to: string) => void;
  unlink?: (filePath: string) => void;
}

// ---------------------------------------------------------------------------
// value helpers
//
// Every helper either returns a caller-supplied value of an allowed shape or
// the fail-safe sentinel for that field. Nothing is spread or copied wholesale
// from caller input, so unknown properties cannot ride along.
// ---------------------------------------------------------------------------

/** Placeholder for a credential-shaped segment. Not itself a value. */
const REDACTED = "[redacted]";

/**
 * Redact credential-shaped text from record fields.
 *
 * Paths and version lines are evidence, but they can carry credentials (a
 * `token=` query in a path, a copied command line). The schema stores no raw
 * argv and no file contents; this scrubbing is the second line of defence for
 * the free text it does store. The function is deterministic and idempotent, so
 * it does not disturb the byte-identical serialization guarantee.
 */
function redactText(value: string): string {
  return value
    .replace(/(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]+/gi, `$1${REDACTED}`)
    .replace(/\bBearer\s+[^"\s',;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(token|key)=("[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1=${REDACTED}`);
}

/** Trimmed non-empty text, or `null`. Used where scrubbing must not apply (hashing). */
function trimmedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Scrubbed, non-empty text for serialization; otherwise `unreadable`. */
function textValue(value: unknown): string | Unreadable {
  const raw = trimmedText(value);
  return raw === null ? GATE_RECEIPT_UNREADABLE : redactText(raw);
}

/** Scrubbed optional text: absent stays absent (used for optional ids). */
function optionalText(value: unknown): string | undefined {
  const raw = trimmedText(value);
  return raw === null ? undefined : redactText(raw);
}

/** Boolean, or `unreadable`. Never coerced. */
function booleanValue(value: unknown): boolean | Unreadable {
  return typeof value === "boolean" ? value : GATE_RECEIPT_UNREADABLE;
}

/** The receipt verdict, closed over the two real values plus `unreadable`. */
function verdictValue(decision: LaunchGateDecision | null | undefined): QualificationReceiptRef["verdict"] {
  if (decision === null || decision === undefined) return GATE_RECEIPT_UNREADABLE;
  return decision.action === "allow" ? "allow" : "refuse";
}

/** A bare lowercase hex sha256, or `null` when the value is not one. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256Value(value: unknown): string | null {
  const raw = trimmedText(value);
  if (raw === null) return null;
  const bare = raw.replace(/^sha256:/i, "").toLowerCase();
  return SHA256_HEX.test(bare) ? bare : null;
}

/**
 * The git commit embedded in a build stamp, or `null`.
 *
 * scripts/inject-version.js writes `YYYYMMDDTHHMMSSZ_<40-char-sha1>` from the
 * source tree it built, so the stamp is the ONE artifact-side proof of the
 * commit that executed. A fallback `package.json` version has no commit, and
 * this returns null rather than inventing one.
 */
const DIST_VERSION_STAMP = /^\d{8}T\d{6}Z_([0-9a-f]{40})$/;

export function distVersionStampCommit(stamp: string): string | null {
  const raw = trimmedText(stamp);
  if (raw === null) return null;
  const match = DIST_VERSION_STAMP.exec(raw);
  return match === null ? null : match[1];
}

/** Compare two strings as UTF-8 bytes, never by locale. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** A SET of strings: non-empty strings only, deduped, byte-sorted, scrubbed. */
function textSet(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned: string[] = [];
  for (const entry of value) {
    const raw = trimmedText(entry);
    if (raw !== null) cleaned.push(redactText(raw));
  }
  return [...new Set(cleaned)].sort(byteCompare);
}

/** Map the provenance union, defaulting to the honest `unknown`. */
function provenanceValue(
  value: unknown,
): QualificationGuestVisibility["provenance"] {
  switch (value) {
    case "measured":
    case "unmeasured":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

/** Whitelist one guest-visibility entry. Non-object entries are dropped. */
function serializeGuestVisibilityEntry(
  entry: QualificationGuestVisibilityInput | QualificationGuestVisibility | undefined,
): QualificationGuestVisibility | null {
  if (entry === null || typeof entry !== "object") return null;
  return {
    storePath: textValue(entry.storePath),
    journalMode: textValue(entry.journalMode),
    source: textValue(entry.source),
    readable: booleanValue(entry.readable),
    // Perspective is never caller-controlled: a host read is not guest
    // evidence, so only a guest observation can be recorded here.
    perspective: "guest",
    provenance: provenanceValue(entry.provenance),
  };
}

// ---------------------------------------------------------------------------
// measurement defaults
// ---------------------------------------------------------------------------

const SHA256_CHUNK_BYTES = 64 * 1024;

/**
 * Default digest reader: stream the file's bytes through sha256 in bounded
 * chunks. Any failure (missing, unreadable, a directory) is `null`, which the
 * record renders as `unreadable` — never as an empty or zero digest.
 */
function defaultSha256File(filePath: string): string | null {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(filePath, "r");
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.alloc(SHA256_CHUNK_BYTES);
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best effort: the digest result (or null) is the answer either way.
      }
    }
  }
}

/** Default dist stamp reader: the executed `dist/version`, `unknown` -> null. */
function defaultDistVersionStamp(): string | null {
  try {
    const stamp = getBuildVersion();
    return stamp === "unknown" ? null : stamp;
  } catch {
    return null;
  }
}

/**
 * The executed `dist/` directory, derived from this module's own location
 * (`dist/installer/matchlock/gate-qualification.js` -> `dist/`). This is a
 * measured value, not a guess: it is where the code that produced the record
 * is running from.
 */
function resolveExecutedDistRoot(): string | null {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  } catch {
    return null;
  }
}

/** Run one measurement seam, converting any throw into "not measured". */
function safely<T>(measure: () => T): T | null {
  try {
    return measure();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/** Map the pinned admission identity into the record's image block. */
function imageDigest(
  explicit: string | undefined,
  pinned: string | undefined,
): string | Unreadable {
  const value = trimmedText(explicit) ?? trimmedText(pinned);
  return value === null ? GATE_RECEIPT_UNREADABLE : redactText(value);
}

/**
 * Build the qualification record for ONE gate decision.
 *
 * Total and non-throwing: every absent value becomes `unreadable`, every
 * throwing seam becomes `unreadable`, and an absent decision produces a record
 * that says so instead of failing. The record binds to the DECISION where the
 * decision carries identity (an allow binding's invocation id, kind, store-set
 * key and receipt path win over caller-supplied values), because evidence must
 * describe the decision that was recorded, not a caller's restatement of it.
 */
export function captureQualificationRecord(
  decision: LaunchGateDecision | null | undefined,
  inputs?: QualificationCaptureInputs | null,
  deps?: QualificationCaptureDeps | null,
): QualificationRecord {
  const source: QualificationCaptureInputs =
    inputs !== null && typeof inputs === "object" ? inputs : {};

  const binding =
    decision !== null && decision !== undefined && decision.action === "allow"
      ? decision.binding
      : null;
  const refusal =
    decision !== null && decision !== undefined && decision.action === "refuse"
      ? decision.refusal
      : null;

  // --- dist stamp and source identity (measured first: the commit comes from
  // the executed artifact, not from the caller) ---
  const readStamp =
    typeof deps?.readDistVersionStamp === "function"
      ? deps.readDistVersionStamp
      : defaultDistVersionStamp;
  const stampText = textValue(safely(() => readStamp()));
  const stampCommit =
    stampText === GATE_RECEIPT_UNREADABLE ? null : distVersionStampCommit(stampText);

  const resolveIdentity =
    typeof deps?.resolveTamanduaSourceIdentity === "function"
      ? deps.resolveTamanduaSourceIdentity
      : null;
  const identity = resolveIdentity === null ? null : safely(() => resolveIdentity());
  const identityCommit =
    identity !== null && typeof identity === "object"
      ? trimmedText(identity.commit)
      : null;
  const identityTree =
    identity !== null && typeof identity === "object"
      ? trimmedText(identity.tree)
      : null;

  // The executed stamp wins over a caller's claim; a claim is used only when
  // the artifact itself carries no commit (a non-git build).
  const suppliedCommit = trimmedText(source.tamandua?.commit);
  const suppliedTree = trimmedText(source.tamandua?.tree);
  const commit = textValue(stampCommit ?? suppliedCommit ?? identityCommit);
  const tree = textValue(suppliedTree ?? identityTree);

  // --- binary digests ---
  const sha256File =
    typeof deps?.sha256File === "function" ? deps.sha256File : defaultSha256File;

  // Hash the REAL path, never the scrubbed spelling: redaction is a
  // serialization concern and must not change what was measured.
  const matchlockPathRaw = trimmedText(source.matchlock?.path);
  const matchlockSha =
    sha256Value(source.matchlock?.sha256) ??
    (matchlockPathRaw === null
      ? null
      : sha256Value(safely(() => sha256File(matchlockPathRaw))));

  const guestInitPathRaw = trimmedText(source.guestInit?.path);
  const guestInitSha =
    sha256Value(source.guestInit?.sha256) ??
    (guestInitPathRaw === null
      ? null
      : sha256Value(safely(() => sha256File(guestInitPathRaw))));

  // --- image ---
  const pinnedIdentity = source.image?.pinnedIdentity ?? null;

  // --- candidate ---
  const distRoot =
    trimmedText(source.candidate?.distRoot) ?? resolveExecutedDistRoot();

  const runId = optionalText(source.invocation?.runId);
  const roundId = optionalText(source.invocation?.roundId);
  const visibility: QualificationGuestVisibility[] = [];
  if (Array.isArray(source.guestVisibility)) {
    for (const entry of source.guestVisibility) {
      const serialized = serializeGuestVisibilityEntry(entry);
      if (serialized !== null) visibility.push(serialized);
    }
  }

  return {
    schemaVersion: GATE_QUALIFICATION_SCHEMA_VERSION,
    recordKind: GATE_QUALIFICATION_RECORD_KIND,
    invocation: {
      invocationId: textValue(
        binding?.invocationId ?? source.invocation?.invocationId,
      ),
      kind: textValue(binding?.kind ?? source.invocation?.kind),
      ...(runId === undefined ? {} : { runId }),
      ...(roundId === undefined ? {} : { roundId }),
    },
    receipt: {
      path: textValue(binding?.receiptPath ?? refusal?.receiptPath ?? source.receipt?.path),
      storeSetKey: textValue(binding?.storeSetKey ?? source.receipt?.storeSetKey),
      verdict: verdictValue(decision),
    },
    tamandua: {
      commit,
      tree,
      distVersionStamp: stampText,
    },
    matchlock: {
      path: textValue(matchlockPathRaw),
      sha256: matchlockSha ?? GATE_RECEIPT_UNREADABLE,
      version: textValue(source.matchlock?.version),
    },
    guestInit: {
      path: textValue(guestInitPathRaw),
      sha256: guestInitSha ?? GATE_RECEIPT_UNREADABLE,
    },
    image: {
      reference: textValue(source.image?.reference),
      digest: imageDigest(source.image?.digest, pinnedIdentity?.digest),
      configDigest: imageDigest(
        source.image?.configDigest,
        pinnedIdentity?.config_digest,
      ),
    },
    profiles: {
      hostEffectiveDir: textValue(source.profiles?.hostEffectiveDir),
      guestHermesHome: textValue(source.profiles?.guestHermesHome),
      configSources: textSet(source.profiles?.configSources),
    },
    candidate: {
      distRoot: textValue(distRoot),
      executedBinaryPaths: textSet(source.candidate?.executedBinaryPaths),
    },
    guestVisibility: visibility,
    // No guest-side measurement happens in capture: the runner attaches the
    // guest observation later (US-010) through `attachGuestVisibility`, which
    // is the only writer of this flag.
    discrepancy: false,
    scope: {
      gatedKinds: [...GATE_QUALIFICATION_GATED_KINDS],
      outOfScope: [...GATE_QUALIFICATION_OUT_OF_SCOPE],
      lease: GATE_QUALIFICATION_LEASE,
    },
  };
}

// ---------------------------------------------------------------------------
// serializer (whitelist)
// ---------------------------------------------------------------------------

/**
 * Serialize a record into deterministic, human-readable JSON with the pinned
 * key order.
 *
 * The output contains no trailing newline: the writer appends exactly one. The
 * function rebuilds every object from named fields, so a caller-constructed
 * record carrying extra properties cannot leak them into the file. It is pure:
 * identical input always yields byte-identical output.
 */
export function serializeQualificationRecord(
  record: QualificationRecord | null | undefined,
): string {
  const source = (
    record !== null && typeof record === "object" ? record : {}
  ) as QualificationRecord;

  const invocation = source.invocation ?? ({} as QualificationInvocation);
  const receipt = source.receipt ?? ({} as QualificationReceiptRef);
  const tamandua = source.tamandua ?? ({} as QualificationTamandua);
  const matchlock = source.matchlock ?? ({} as QualificationMatchlock);
  const guestInit = source.guestInit ?? ({} as QualificationGuestInit);
  const image = source.image ?? ({} as QualificationImage);
  const profiles = source.profiles ?? ({} as QualificationProfiles);
  const candidate = source.candidate ?? ({} as QualificationCandidate);
  const runId = optionalText(invocation.runId);
  const roundId = optionalText(invocation.roundId);

  const out: QualificationRecord = {
    schemaVersion: GATE_QUALIFICATION_SCHEMA_VERSION,
    recordKind: GATE_QUALIFICATION_RECORD_KIND,
    invocation: {
      invocationId: textValue(invocation.invocationId),
      kind: textValue(invocation.kind),
      ...(runId === undefined ? {} : { runId }),
      ...(roundId === undefined ? {} : { roundId }),
    },
    receipt: {
      path: textValue(receipt.path),
      storeSetKey: textValue(receipt.storeSetKey),
      verdict:
        receipt.verdict === "allow" || receipt.verdict === "refuse"
          ? receipt.verdict
          : GATE_RECEIPT_UNREADABLE,
    },
    tamandua: {
      commit: textValue(tamandua.commit),
      tree: textValue(tamandua.tree),
      distVersionStamp: textValue(tamandua.distVersionStamp),
    },
    matchlock: {
      path: textValue(matchlock.path),
      sha256: sha256Value(matchlock.sha256) ?? GATE_RECEIPT_UNREADABLE,
      version: textValue(matchlock.version),
    },
    guestInit: {
      path: textValue(guestInit.path),
      sha256: sha256Value(guestInit.sha256) ?? GATE_RECEIPT_UNREADABLE,
    },
    image: {
      reference: textValue(image.reference),
      digest: textValue(image.digest),
      configDigest: textValue(image.configDigest),
    },
    profiles: {
      hostEffectiveDir: textValue(profiles.hostEffectiveDir),
      guestHermesHome: textValue(profiles.guestHermesHome),
      configSources: textSet(profiles.configSources),
    },
    candidate: {
      distRoot: textValue(candidate.distRoot),
      executedBinaryPaths: textSet(candidate.executedBinaryPaths),
    },
    guestVisibility: Array.isArray(source.guestVisibility)
      ? source.guestVisibility
          .map((entry) => serializeGuestVisibilityEntry(entry))
          .filter((entry): entry is QualificationGuestVisibility => entry !== null)
      : [],
    // Strictly boolean: a truthy string or a 1 can never claim a disagreement.
    discrepancy: source.discrepancy === true,
    // Scope is a property of the design, not of the call: the serializer emits
    // the canonical constants so a hand-edited record cannot claim that a
    // different set of kinds was gated (or that a lease existed).
    scope: {
      gatedKinds: [...GATE_QUALIFICATION_GATED_KINDS],
      outOfScope: [...GATE_QUALIFICATION_OUT_OF_SCOPE],
      lease: GATE_QUALIFICATION_LEASE,
    },
  };

  return JSON.stringify(out, null, 2);
}

// ---------------------------------------------------------------------------
// atomic writer (the only I/O this module performs)
//
// A qualification record that cannot be written is a failure the caller must
// see: the sibling receipt would then claim a decision with no artifact
// binding, which is precisely the ambiguity this record exists to remove. The
// write is therefore atomic (temp file + rename in the same directory, mode
// 0600) and every failure mode is the same typed result — nothing is thrown.
// ---------------------------------------------------------------------------

/** Upper bound on a write-failure detail so a stack-sized message never lands. */
const MAX_DETAIL_CHARS = 512;

/**
 * The record path for one receipt: `.json` replaced by `.qualification.json`
 * in the same directory, so the two evidence files can never be confused and a
 * reader holding one always knows where the other is.
 *
 * The `unreadable` sentinel is NOT a path: a record whose receipt path could
 * not be measured has nowhere to go, and returning "" makes the writer report
 * a typed failure instead of creating `unreadable.qualification.json` in the
 * caller's working directory.
 */
export function resolveQualificationRecordPath(receiptPath: string): string {
  const resolved = trimmedText(receiptPath);
  if (resolved === null || resolved === GATE_RECEIPT_UNREADABLE) return "";
  const directory = path.dirname(resolved);
  const base = path.basename(resolved);
  const stem = base.endsWith(".json") ? base.slice(0, -".json".length) : base;
  return path.join(directory, `${stem}.qualification.json`);
}

interface ResolvedWriteSeam {
  path: string;
  mkdir: (directory: string) => void;
  writeFile: (filePath: string, data: string) => void;
  rename: (from: string, to: string) => void;
  unlink: (filePath: string) => void;
}

function defaultMkdir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

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
  deps: QualificationWriteDeps | null | undefined,
): ResolvedWriteSeam {
  const source =
    deps !== null && deps !== undefined && typeof deps === "object" ? deps : {};
  return {
    path: trimmedText(source.path) ?? "",
    mkdir: typeof source.mkdir === "function" ? source.mkdir : defaultMkdir,
    writeFile:
      typeof source.writeFile === "function" ? source.writeFile : defaultWriteFile,
    rename: typeof source.rename === "function" ? source.rename : defaultRename,
    unlink: typeof source.unlink === "function" ? source.unlink : defaultUnlink,
  };
}

function writeFailure(
  target: string,
  detail: string,
): QualificationWriteResult {
  const bounded = detail.replace(/\s+/g, " ").trim();
  return {
    ok: false,
    code: "qualification-write-failed",
    path: target,
    detail:
      bounded.length > MAX_DETAIL_CHARS
        ? `${bounded.slice(0, MAX_DETAIL_CHARS)}...`
        : bounded,
  };
}

function describeError(error: unknown): string {
  try {
    if (
      error instanceof Error &&
      typeof error.message === "string" &&
      error.message.length > 0
    ) {
      return `qualification write failed: ${error.message}`;
    }
    const text = String(error);
    return text.length > 0
      ? `qualification write failed: ${text}`
      : "qualification write failed";
  } catch {
    return "qualification write failed";
  }
}

/**
 * Write one qualification record atomically next to its receipt.
 *
 * The destination is `deps.path` when supplied (tests) and otherwise the
 * record's own receipt path with `.qualification.json` in place of `.json`. A
 * record whose receipt path is `unreadable` has nowhere to go and is reported
 * as a typed failure rather than being written under a fabricated name.
 */
export function writeQualificationRecord(
  record: QualificationRecord | null | undefined,
  deps?: QualificationWriteDeps | null,
): QualificationWriteResult {
  let target = "";
  let temporary = "";
  let unlink: (filePath: string) => void = defaultUnlink;
  try {
    const seam = resolveWriteSeam(deps);
    unlink = seam.unlink;
    target = seam.path !== "" ? seam.path : resolveQualificationRecordPath(
      (record?.receipt?.path as string | undefined) ?? "",
    );
    if (target === "") {
      return writeFailure(
        "",
        "no receipt path was supplied; the qualification record has nowhere to go",
      );
    }

    const data = `${serializeQualificationRecord(record)}\n`;
    temporary = `${target}.tmp-${process.pid}`;
    seam.mkdir(path.dirname(target));
    seam.writeFile(temporary, data);
    seam.rename(temporary, target);
    return { ok: true, path: target };
  } catch (error) {
    try {
      if (temporary !== "") unlink(temporary);
    } catch {
      // Cleanup is best effort; the typed failure is still the answer.
    }
    return writeFailure(target, describeError(error));
  }
}
