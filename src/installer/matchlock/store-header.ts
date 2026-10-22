/**
 * Matchlock host-side store header reader (byte-only evidence).
 *
 * G3 STORE-HEADER-READER (bead tamandua-7p5.1.3). A host pre-flight gate must
 * decide whether a mapped Hermes store is safe to hand to a guest WITHOUT
 * opening that store through a database driver. This module supplies the
 * evidence for that decision from raw bytes and filesystem metadata only: one
 * `lstat` precheck (existence, entry type, size); a follow-up `stat` only when
 * the entry is a symlink, so a symlink resolving to a regular file stays
 * observable; then one non-blocking `open`, one `fstat` on the opened
 * descriptor and one bounded read of the first 100 bytes, closed in a
 * `finally` block. A second, independent `stat` classifies each sidecar.
 *
 * Regular-file-only rule. Only a regular file is ever read. A directory, FIFO,
 * AF_UNIX socket, character device, block device or any other non-regular path
 * is refused with `header-unreadable` before any read is attempted, and its
 * reported size comes from the `lstat` (or symlink-follow `stat`) precheck.
 * The precheck is not trusted on its own: a regular file is opened with
 * `O_RDONLY | O_NONBLOCK` (the non-blocking bit where the platform defines
 * it), the opened descriptor is re-checked with `fstatSync` and must still be
 * a regular file before the read, and the read plus the reported size come
 * from that descriptor. A path swapped between the precheck and the open is
 * therefore refused rather than read. The descriptor is closed in a `finally`
 * on every exit path, including every refusal and every error; a close failure
 * never throws.
 *
 * Scope honesty. The non-blocking open plus descriptor re-check fixes the
 * demonstrated local FIFO hang and the local check-to-open race. It does NOT
 * guarantee bounded execution against a stalled network filesystem; that case
 * is unproven and is not claimed here.
 *
 * Hard properties — these are the whole point of the module:
 *
 *  - No database driver is imported, and no database call is ever made: no
 *    pragma, integrity check, checkpoint, journal-mode read or driver open.
 *    Observation therefore cannot fail, block on, or mutate a store that a
 *    driver would reject or rewrite (corrupt body, torn header, held lock).
 *  - Reading takes no lock, so observation succeeds while a writer holds the
 *    file open.
 *  - No clock reads, no randomness, no environment reads. Identical
 *    filesystem state always produces a deeply equal observation.
 *  - Nothing is ever created, deleted, truncated, checkpointed or repaired —
 *    sidecars included. This module reports; the gate decides.
 *  - It never throws. Every filesystem error is classified into a finding.
 *
 * Header facts. Bytes 0..15 are the database file signature
 * ("SQLite format 3\0"). Bytes 18 and 19 are the file-format write version
 * and read version. A rollback-format header carries (1, 1); a
 * write-ahead-log header carries (2, 2); any other pair is `unknown`.
 *
 * WORDING RULE: the (1, 1) pair means "rollback-format". It covers every
 * rollback-journal flavour (including TRUNCATE and PERSIST), so it must never
 * be read as proof of one specific journal sub-mode. Anything that describes
 * this module, its findings or its tests says "rollback-format".
 *
 * Finding codes are deliberately separate and are never collapsed:
 * `store-missing` (ENOENT), `permission-denied` (EACCES/EPERM specifically),
 * `header-unreadable` (a non-regular store path, or any other open/read/fstat
 * error), `header-truncated` (fewer than 100 header bytes), `header-not-sqlite`
 * (16+ bytes that are not the signature) and `sidecar-unresolved` (any sidecar
 * holds bytes). Every applicable code is reported once, in
 * `STORE_REASON_CODE_ORDER`.
 *
 * Truncation trusts nothing: a header shorter than 100 bytes yields
 * `header-truncated`, `rawBytes1819 = null` and `headerFormat = "unknown"`,
 * because a torn header is not evidence of a format pair. A file shorter than
 * the 16-byte signature cannot match it, so it never also yields
 * `header-not-sqlite`.
 *
 * `canonicalPath` is the realpath of the store when it exists (so symlinked
 * parents resolve), and the absolute `path.resolve()` of the input otherwise.
 * The `path` field always echoes the caller's spelling verbatim. Sidecars are
 * observed next to the caller's spelling (`<path>-wal`, `<path>-shm`,
 * `<path>-journal`), exactly as the store's siblings are named on disk.
 *
 * An `unreadable` sidecar is reported structurally and produces no finding
 * code (only `presentNonEmpty` raises `sidecar-unresolved`); the gate can
 * still see the state and decide. A non-empty `-journal` counts as unresolved:
 * a healthy in-flight transaction can briefly leave one, and refusing during
 * that window is the approved conservative behaviour. No retry or settle logic
 * belongs here.
 */

import fs from "node:fs";
import path from "node:path";

/** Length in bytes of the database file signature. */
const SQLITE_MAGIC_LENGTH = 16;

/** The 16-byte database file signature, as raw bytes. */
const SQLITE_MAGIC = Buffer.from("SQLite format 3\u0000", "latin1");

/** A real database header is 100 bytes; the version pair lives inside it. */
const DATABASE_HEADER_SIZE = 100;

/** 0-based offsets of the file-format write version and read version bytes. */
const WRITE_VERSION_OFFSET = 18;
const READ_VERSION_OFFSET = 19;

/**
 * Canonical order of finding codes. `StoreObservation.findingCodes` is always a
 * subsequence of this array (deduped), so identical filesystem state always
 * yields a deeply equal observation.
 */
export const STORE_REASON_CODE_ORDER = [
  "store-missing",
  "permission-denied",
  "header-unreadable",
  "header-truncated",
  "header-not-sqlite",
  "sidecar-unresolved",
] as const;

/** One classified reason the gate may refuse a launch on. */
export type StoreReasonCode = (typeof STORE_REASON_CODE_ORDER)[number];

/**
 * `rollback` = rollback-format header (version pair 1/1);
 * `wal` = write-ahead-log header (version pair 2/2);
 * `unknown` = any other pair, or a pair that could not be observed.
 */
export type StoreHeaderFormat = "rollback" | "wal" | "unknown";

/** Classification of one sidecar path. `unreadable` is never `absent`. */
export type SidecarState =
  | "absent"
  | "presentEmpty"
  | "presentNonEmpty"
  | "unreadable";

/** The three sidecars a store may carry, observed independently. */
export interface StoreSidecarStates {
  wal: SidecarState;
  shm: SidecarState;
  journal: SidecarState;
}

/** Byte-only observation of one mapped store. Pure data; safe to deep-compare. */
export interface StoreObservation {
  /** The caller's path, verbatim. */
  path: string;
  /** Realpath when the store exists, else the absolute resolved input path. */
  canonicalPath: string;
  /** Whether a `stat` on the store path succeeded. */
  exists: boolean;
  /** Whether the header bytes were read successfully (a 0-byte file is readable). */
  readable: boolean;
  /** Whether bytes 0..15 are exactly the database file signature. */
  magicOk: boolean;
  /** Rollback-format, write-ahead-log, or unknown (including unobservable). */
  headerFormat: StoreHeaderFormat;
  /** Bytes at offsets 18 and 19, or null when the header is not trustworthy. */
  rawBytes1819: [number, number] | null;
  /** Size from `stat`, or null when the store could not be stat'ed. */
  fileSize: number | null;
  /** Sidecar states, each observed independently of the store's own state. */
  sidecars: StoreSidecarStates;
  /** Every applicable finding, deduped, in `STORE_REASON_CODE_ORDER`. */
  findingCodes: StoreReasonCode[];
}

/** Extract a filesystem error code without ever throwing. */
function errorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** True for the two permission error codes; both mean "cannot look", not "gone". */
function isPermissionError(code: string | null): boolean {
  return code === "EACCES" || code === "EPERM";
}

/**
 * Classify one sidecar path by `stat` only: `absent` on ENOENT,
 * `presentEmpty` at size 0, `presentNonEmpty` above zero, `unreadable` for any
 * other stat error. Never creates, deletes or repairs anything.
 */
function observeSidecar(sidecarPath: string): SidecarState {
  try {
    const stats = fs.statSync(sidecarPath);
    return stats.size === 0 ? "presentEmpty" : "presentNonEmpty";
  } catch (err) {
    return errorCode(err) === "ENOENT" ? "absent" : "unreadable";
  }
}

/** Classify the observed (write version, read version) pair. */
function classifyHeaderPair(write: number, read: number): StoreHeaderFormat {
  if (write === 1 && read === 1) return "rollback";
  if (write === 2 && read === 2) return "wal";
  return "unknown";
}

/**
 * Observe one mapped store as bytes. Never throws and never opens the store
 * with a database driver; see the module comment for the full contract.
 */
export function observeStore(storePath: string): StoreObservation {
  const findings = new Set<StoreReasonCode>();

  let exists = false;
  let fileSize: number | null = null;
  let regularFilePrecheck = false;

  // lstat precheck: existence, entry type and size without following the final
  // symlink, so a symlink that resolves to a regular file stays observable.
  // A failed precheck is classified here and no read is attempted.
  let precheck: fs.Stats | null = null;
  try {
    precheck = fs.lstatSync(storePath);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") {
      findings.add("store-missing");
    } else if (isPermissionError(code)) {
      findings.add("permission-denied");
    } else {
      findings.add("header-unreadable");
    }
  }

  // Classify the resolved path. A symlink is followed once for type
  // classification only; a broken symlink or loop keeps the historical
  // follow-stat behaviour (exists=false, fileSize=null).
  if (precheck !== null) {
    if (precheck.isSymbolicLink()) {
      try {
        const target = fs.statSync(storePath);
        exists = true;
        fileSize = target.size;
        if (target.isFile()) {
          regularFilePrecheck = true;
        } else {
          // Resolves to a directory, FIFO, socket, device or other non-regular
          // entry: refuse before any open or read.
          findings.add("header-unreadable");
        }
      } catch (err) {
        const code = errorCode(err);
        exists = false;
        fileSize = null;
        if (code === "ENOENT") {
          findings.add("store-missing");
        } else if (isPermissionError(code)) {
          findings.add("permission-denied");
        } else {
          // ELOOP (symlink loop), EIO and friends.
          findings.add("header-unreadable");
        }
      }
    } else if (precheck.isFile()) {
      exists = true;
      fileSize = precheck.size;
      regularFilePrecheck = true;
    } else {
      // Directory, FIFO, AF_UNIX socket, character/block device: a bounded
      // refusal that never opens the path for reading.
      exists = true;
      fileSize = precheck.size;
      findings.add("header-unreadable");
    }
  }

  let readable = false;
  let magicOk = false;
  let headerFormat: StoreHeaderFormat = "unknown";
  let rawBytes1819: [number, number] | null = null;

  // Only a regular file is opened, and it is opened non-blockingly where the
  // platform supports it so a path swapped to a FIFO between the precheck and
  // the open cannot wedge the caller. The opened descriptor is re-validated
  // before the one bounded read. Reading requires no lock, so this succeeds
  // while a writer holds the file open. The descriptor is always closed.
  if (regularFilePrecheck) {
    let fd: number | null = null;
    try {
      const openFlags =
        fs.constants.O_RDONLY |
        (typeof fs.constants.O_NONBLOCK === "number"
          ? fs.constants.O_NONBLOCK
          : 0);
      fd = fs.openSync(storePath, openFlags);

      // Descriptor-derived facts only from here on: re-check the opened type,
      // then take the size from fstat rather than the earlier pathname entry.
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) {
        exists = true;
        fileSize = opened.size;
        findings.add("header-unreadable");
      } else {
        exists = true;
        fileSize = opened.size;
        const header = Buffer.alloc(DATABASE_HEADER_SIZE);
        const bytesRead = fs.readSync(fd, header, 0, DATABASE_HEADER_SIZE, 0);
        readable = true;

        if (bytesRead >= SQLITE_MAGIC_LENGTH) {
          magicOk = header.subarray(0, SQLITE_MAGIC_LENGTH).equals(SQLITE_MAGIC);
          if (!magicOk) findings.add("header-not-sqlite");
        }

        if (bytesRead < DATABASE_HEADER_SIZE) {
          findings.add("header-truncated");
        } else {
          const write = header[WRITE_VERSION_OFFSET];
          const read = header[READ_VERSION_OFFSET];
          rawBytes1819 = [write, read];
          headerFormat = classifyHeaderPair(write, read);
        }
      }
    } catch (err) {
      const code = errorCode(err);
      if (code === "ENOENT") {
        // Vanished between the precheck and the open: report it as missing
        // rather than as an unreadable store, and drop facts we can no longer
        // stand behind.
        exists = false;
        fileSize = null;
        readable = false;
        magicOk = false;
        findings.add("store-missing");
      } else if (isPermissionError(code)) {
        findings.add("permission-denied");
      } else {
        // EISDIR (a directory that replaced the path), EIO and friends.
        findings.add("header-unreadable");
      }
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // A close failure cannot invalidate bytes already read.
        }
      }
    }
  }

  // Sidecars are observed independently of the store's own state so an orphan
  // non-empty sidecar next to a missing store is still visible.
  const sidecars: StoreSidecarStates = {
    wal: observeSidecar(`${storePath}-wal`),
    shm: observeSidecar(`${storePath}-shm`),
    journal: observeSidecar(`${storePath}-journal`),
  };
  if (
    sidecars.wal === "presentNonEmpty" ||
    sidecars.shm === "presentNonEmpty" ||
    sidecars.journal === "presentNonEmpty"
  ) {
    findings.add("sidecar-unresolved");
  }

  let canonicalPath: string;
  try {
    canonicalPath = exists ? fs.realpathSync(storePath) : path.resolve(storePath);
  } catch {
    canonicalPath = path.resolve(storePath);
  }

  return {
    path: storePath,
    canonicalPath,
    exists,
    readable,
    magicOk,
    headerFormat,
    rawBytes1819,
    fileSize,
    sidecars,
    findingCodes: STORE_REASON_CODE_ORDER.filter((code) => findings.has(code)),
  };
}
