/**
 * Matchlock store-observation adapter (G4-B ADAPTER, bead tamandua-7p5.1.4).
 *
 * This module is the explicit boundary between the byte-level reader output
 * (`StoreObservation` from ./store-header.js) and the evaluator input
 * (`EvaluatedStore` from ./launch-gate.ts). It is pure transport: every field
 * is derived from the observation's own evidence and from the store-set
 * classification. It performs no filesystem access, starts nothing, reads no
 * clock, uses no randomness and reads no environment, so identical evidence
 * always adapts to a deeply equal result.
 *
 * PRESENCE IS THREE-STATE AND IS NEVER COLLAPSED.
 *
 *  - `present`          the store was observed and its bytes were read.
 *  - `confirmed-absent` the observation proved the path does not exist: the
 *                       reader reported `store-missing` (a definitive ENOENT).
 *  - `unresolved`       existence could not be determined. This is ignorance,
 *                       never absence.
 *
 * The mapping is deliberately asymmetric around permissions. An observation
 * that carries `permission-denied` can never become `confirmed-absent`: EACCES
 * or EPERM means "cannot look", not "gone". That holds both when the reader
 * could not `stat` the path at all (`exists === false`, e.g. an unlistable
 * parent directory) and when the entry was seen but its bytes could not be
 * opened (`exists === true` with `readable !== true`, e.g. a mode-000 store
 * file). In the latter case the path demonstrably exists, so reporting it as
 * absent would be a lie; the store is `unresolved` because compliance is
 * unproven.
 *
 * Every other non-ENOENT failure (ELOOP, EIO, a refused non-regular entry, an
 * unreadable header) is likewise `unresolved`.
 *
 * IDENTITY IS NEVER SYNTHESIZED. A path that was not observed present has no
 * inode, so its identity is `null`; a caller hint is never used to invent one.
 * A present store's identity carries its canonical path plus its device,
 * inode and filesystem type. `StoreObservation` carries none of those three,
 * so they arrive from the caller through {@link StoreAdapterContext} and are
 * passed through verbatim; an omitted field is `null` (unknown) rather than a
 * guessed value. The identity of an `unresolved` store is likewise `null`
 * even when the entry was seen: compliance is unproven, so no identity is
 * claimed.
 *
 * REALPATH-FALLBACK RESIDUAL. The reader sets `canonicalPath` to the realpath
 * when the target exists, and to the absolute `path.resolve()` of the caller's
 * spelling otherwise. The adapter must never present that fallback as a proven
 * canonical path, so {@link canonicalPathObserved} reports provenance
 * explicitly: it is true only when the reported canonical path differs from
 * `path.resolve(requestedPath)`, or when the caller's spelling already equals
 * that resolution AND the store exists (the realpath was observed and happened
 * to be unchanged). The residual: a relative or dot-dot spelling whose
 * resolution is exactly the value the fallback would report cannot be
 * distinguished from a realpath result by the observation alone. The flag is
 * therefore conservatively false and the identity keeps the caller's
 * spelling. That is honesty about ignorance, not a claim that the spelling
 * is canonical.
 *
 * CALLER-SUPPLIED FACTS. `StoreObservation` is byte-level reader output: it
 * does not carry the effective journal-mode `config`
 * (`journalMode`/`source`/`observed`) and it does not carry the filesystem
 * identity fields `dev`, `ino` or `fstype`. Those four facts are therefore
 * CALLER-SUPPLIED through {@link StoreAdapterContext} and are never inferred
 * from the path, the environment or a policy file. An omitted fact stays
 * `null` (unknown) rather than being guessed.
 *
 * CONFIG, HEADER AND SIDECARS. The caller's spelling is always preserved
 * verbatim as `requestedPath`. For a `present` store the header is copied
 * field-by-field from the observation (the reader is the only producer of
 * those bytes) and the effective journal-mode config is taken from the caller
 * (`context.config`), because `StoreObservation` observes bytes, not runtime
 * settings; a caller that supplies none produces `config: null`, which the
 * gate treats as absence of evidence, never compliance. Sidecars and
 * `findingCodesFromReader` are threaded through unchanged so the gate can
 * reason about the reader's own evidence.
 *
 * For a non-present store the config and header are `null` (there is no file
 * whose header could be read and no runtime config worth demanding), while
 * the observed sidecars and reader finding codes still survive adaptation:
 * orphaned sidecar evidence and the `permission-denied` refinement on an
 * unresolved store both live in those two fields, so dropping them would
 * erase evidence the reader actually gathered.
 *
 * `required` is exactly `classification === "required"`; `"optional-present"`
 * and `"inactive"` both map to `required: false`.
 */

import path from "node:path";

import type { StoreObservation } from "./store-header.js";
import type { StoreClassification } from "./store-set.js";
import type {
  EvaluatedStore,
  StoreConfigObservation,
  StoreHeaderObservation,
  StoreIdentityObservation,
  StoreSidecars,
} from "./launch-gate.js";

/** Reader finding code for a definitive ENOENT. */
const STORE_MISSING = "store-missing";

/** Reader finding code for EACCES/EPERM: "cannot look", never "gone". */
const PERMISSION_DENIED = "permission-denied";

/**
 * Caller-supplied facts that `StoreObservation` does not carry.
 *
 * `dev`/`ino`/`fstype` form the filesystem identity of a present store; the
 * reader reports neither, so a caller that has them (from its own `stat`) may
 * pass them in. `config` is the per-profile effective journal-mode setting,
 * observed by the caller rather than by the byte-level reader. Every field is
 * optional and defaults to `null`, so an adapter call that supplies nothing
 * still produces a well-formed result.
 */
export interface StoreAdapterContext {
  config?: StoreConfigObservation | null;
  dev?: string | null;
  ino?: string | null;
  fstype?: string | null;
}

/** Presence derived from the observation's own evidence. */
type Presence = EvaluatedStore["presence"];

/** True when the reader recorded `code` among its findings. */
function hasFinding(observation: StoreObservation, code: string): boolean {
  return observation.findingCodes.includes(
    code as StoreObservation["findingCodes"][number],
  );
}

/**
 * Map one observation to the gate's three-state presence.
 *
 * `permission-denied` is checked before `store-missing` so a contradictory
 * observation can never be read as absence: "cannot look" always wins over
 * "gone".
 */
function derivePresence(observation: StoreObservation): Presence {
  const permissionDenied = hasFinding(observation, PERMISSION_DENIED);

  if (observation.exists) {
    // Seen, but unreadable: the path is not absent, compliance is unproven.
    if (permissionDenied && observation.readable !== true) return "unresolved";
    return "present";
  }

  if (permissionDenied) return "unresolved";
  if (hasFinding(observation, STORE_MISSING)) return "confirmed-absent";
  return "unresolved";
}

/**
 * Whether the observation's `canonicalPath` is a PROVEN canonical spelling.
 *
 * True only when the reader reported a canonical path that differs from
 * `path.resolve(requestedPath)`, or when the caller's spelling is already
 * absolute-and-unchanged by resolution and the store was observed present.
 * Any other combination is the reader's `path.resolve()` fallback: provenance
 * cannot be distinguished from a spelled path, so the answer is false. See the
 * module comment for the residual this leaves.
 */
export function canonicalPathObserved(
  observation: StoreObservation,
  requestedPath: string,
): boolean {
  const resolved = path.resolve(requestedPath);
  if (observation.canonicalPath !== resolved) return true;
  return requestedPath === resolved && observation.exists === true;
}

/**
 * Adapt one reader observation into the evaluator's store input.
 *
 * The two-argument call is the pinned API; `context` is an optional carrier
 * for caller-supplied identity/config facts and defaults to an empty object.
 * Classification is the only policy input: `"required"` maps to
 * `required: true`, every other classification to `required: false`.
 */
export function adaptStoreObservation(
  observation: StoreObservation,
  classification: StoreClassification,
  context: StoreAdapterContext = {},
): EvaluatedStore {
  const presence = derivePresence(observation);

  // A non-present path has no inode, so it has no identity at all. A present
  // store's canonical path is only claimed when provenance is proven; the
  // caller's spelling is kept otherwise. dev/ino/fstype are caller-supplied
  // and stay null when unknown; `launch-gate` declares dev/ino as strings
  // because it predates this transport, and never reads either field, so the
  // unknown value is carried as null at runtime through this one documented
  // assertion.
  const isPresent = presence === "present";

  const identity: StoreIdentityObservation | null = isPresent
    ? {
        canonicalPath: canonicalPathObserved(observation, observation.path)
          ? observation.canonicalPath
          : observation.path,
        dev: (context.dev ?? null) as string,
        ino: (context.ino ?? null) as string,
        fstype: context.fstype ?? null,
      }
    : null;

  // The reader is the only producer of the header bytes, so a present store's
  // header is a field-for-field copy of its observation. A non-present store
  // has no header to report: `null` is absence of evidence, distinct from a
  // header that was read and found non-compliant.
  const header: StoreHeaderObservation | null = isPresent
    ? {
        headerFormat: observation.headerFormat,
        rawBytes1819: observation.rawBytes1819,
        magicOk: observation.magicOk,
        readable: observation.readable,
        fileSize: observation.fileSize,
      }
    : null;

  return {
    // The caller's spelling, always verbatim.
    requestedPath: observation.path,
    presence,
    identity,
    required: classification === "required",
    // The runtime's effective journal-mode setting is caller knowledge, not a
    // reader observation. A missing config stays null (never a guessed
    // compliant value) and is only carried for a present store.
    config: isPresent ? (context.config ?? null) : null,
    header,
    // Sidecar and reader finding evidence is threaded through unchanged even
    // for a non-present store: orphaned sidecars and the permission-denied
    // refinement are exactly what the gate needs there.
    sidecars: observation.sidecars as StoreSidecars,
    findingCodesFromReader: observation.findingCodes,
  };
}
