/**
 * progress-resource.ts — MTLK-PROGRESS.
 *
 * Host progress-resource/access layer for an OPTED-IN Matchlock run.
 *
 * The design (section 7.2 / section 5) requires the guest to see a persistent,
 * writable progress document at `/workspace/runs/<runId>/progress.txt` backed
 * by ONLY that run's canonical progress document, with append / rewrite /
 * atomic-replace semantics, and it forbids exposing the whole host run
 * directory, state root, DB/policy/events, sibling progress files or arbitrary
 * task files. It also forbids the naive "host canonical path → guest-writable
 * file" shortcut, because a guest can replace that file with a symlink / FIFO /
 * outside target and an ordinary host `readFileSync`/`writeFileSync`/
 * `copyFileSync` would follow it (HOST ESCAPE).
 *
 * This module implements the host side of the opt-in specific solution:
 *
 *   1. A deterministic, host-controlled per-run PROGRESS RESOURCE DIRECTORY:
 *      `<liveState>/runs/<runId>/progress-resource/` containing the single
 *      progress document `progress.txt`. The guest mount plan exports ONLY
 *      that directory at `/workspace/runs/<runId>` (persistent RW host_fs), so
 *      the guest's `/workspace/runs/<runId>/progress.txt` IS the host resource
 *      file and sibling host run state is never reachable. Because the mount is
 *      a directory, the guest's rename-over-file (atomic replace) simply
 *      replaces the directory entry on the host — the host re-opens the path on
 *      every access, so it always observes the committed content (no pinned
 *      inode).
 *
 *   2. A CONFINED HOST ACCESS LAYER used by host canonical readers/writers and
 *      by story-plan / archive operations when a run is opted in. Every access:
 *        - refuses symlink and special-file leaf entries (FIFO / socket /
 *          device) via O_NOFOLLOW | O_NONBLOCK open + fstat, so host IO can
 *          never be redirected by a guest-controlled link and can never hang on
 *          a FIFO;
 *        - verifies the resource directory itself is still a REAL directory
 *          (fresh per-op lstat, no-follow) before touching anything;
 *        - bounds content size on read AND write (oversized documents are
 *          refused, never partially trusted);
 *        - performs host writes as ATOMIC REPLACE: write an exclusive
 *          host-owned temp file inside the same resource dir, fsync, then
 *          rename over `progress.txt` (rename replaces the entry — even a
 *          symlink/FIFO entry — without following it);
 *        - serializes host story-plan writes with COMPARE-AND-COMMIT: the
 *          update reads the current committed content + an identity token,
 *          computes the merged document, and only commits if the identity is
 *          unchanged since the read; a changed identity means the guest (or
 *          another writer) committed in between, so the update retries with the
 *          fresh content (bounded). What this protects precisely: a guest
 *          commit observed between the initial read and the pre-commit
 *          identity re-check is never silently dropped — the retry re-reads it.
 *          The residual unsynchronized window (a guest commit landing between
 *          the final identity re-check and the host's rename-over) is
 *          last-writer-wins at the directory entry and is NOT claimed to be
 *          lossless. Live ARBITRARY simultaneous writers are NOT claimed —
 *          only serial host writers plus this compare-and-commit against
 *          intervening guest commits are qualified (see
 *          progress-resource-contract.json race_reasoning).
 *
 * No-flag native behavior is UNCHANGED: this module is opt-in only, and the
 * step-ops/native-step-services seams that consume it default to the existing
 * canonical path + legacy fallback when no progress resource is attached.
 *
 * This file never touches a guest-supplied path: the resource directory is
 * derived host-side from the run id + live state root, and every file name
 * opened is a host constant. No DB schema migration; host resource identity is
 * derived deterministically (no authoritative binding in guest-writable
 * context).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRunRoot } from "../paths.js";

/** Single progress document name inside the resource directory. */
export const PROGRESS_DOC_FILE_NAME = "progress.txt";
/** Host directory (per run) that is the dedicated progress resource. */
export const PROGRESS_RESOURCE_DIR_NAME = "progress-resource";
/** Guest path where every run's progress resource directory is mounted. */
export const PROGRESS_GUEST_RUNS_ROOT = "/workspace/runs";
/** Default maximum committed progress document size (bytes). */
export const DEFAULT_MAX_PROGRESS_DOC_BYTES = 4 * 1024 * 1024;
/** Bounded retry count for compare-and-commit host updates. */
export const PROGRESS_UPDATE_MAX_RETRIES = 8;

export class ProgressResourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProgressResourceError";
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_PREFIX = "run-";

/** Strip a run- prefix when present (mirrors lib/id-prefix without importing it). */
function bareRunId(runId: string): string {
  return runId.startsWith(RUN_PREFIX) ? runId.slice(RUN_PREFIX.length) : runId;
}

/**
 * Validate and normalize a run id for use in a host/guest progress path.
 * Accepts a bare uuid or a `run-` prefixed uuid; refuses anything with path
 * separators, dot segments, or non-uuid content so a malicious runId can never
 * escape the progress resource directory.
 */
export function assertSafeRunId(runId: string): string {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 64) {
    throw new ProgressResourceError("invalid_run_id", `Refusing malformed run id: ${JSON.stringify(runId)}`);
  }
  const bare = bareRunId(runId);
  if (!UUID_RE.test(bare) || bare !== bare.replace(/[/\\]/g, "")) {
    throw new ProgressResourceError(
      "invalid_run_id",
      `Refusing progress resource for non-uuid run id: ${JSON.stringify(runId)}`,
    );
  }
  return bare;
}

/** Deterministic host progress resource directory for a run (host-owned). */
export function progressResourceHostDirForRun(runId: string, opts?: { runRoot?: string }): string {
  const bare = assertSafeRunId(runId);
  const runRoot = opts?.runRoot ?? resolveRunRoot();
  return path.join(runRoot, bare, PROGRESS_RESOURCE_DIR_NAME);
}

/** Guest directory where the host progress resource dir is mounted. */
export function progressGuestDirForRun(runId: string): string {
  const bare = assertSafeRunId(runId);
  return path.join(PROGRESS_GUEST_RUNS_ROOT, bare);
}

/** Guest-visible progress document path for a run. */
export function progressGuestFileForRun(runId: string): string {
  return path.join(progressGuestDirForRun(runId), PROGRESS_DOC_FILE_NAME);
}

/** Host progress document path inside the resource directory. */
export function progressHostFile(hostDir: string): string {
  return path.join(hostDir, PROGRESS_DOC_FILE_NAME);
}

/** Options accepted by the confined access layer. */
export interface ProgressAccessOptions {
  /** Maximum committed document size in bytes (default 4 MiB). */
  maxBytes?: number;
  /** Clock for compare-and-commit identity tokens (tests inject). */
  now?: () => number;
  /**
   * Guest-visible absolute progress file path for this resource
   * (e.g. /workspace/runs/<runId>/progress.txt). When supplied, the access
   * object satisfies the step-ops `RunProgressAccessLike` seam so a Matchlock
   * host integration can render the guest pointer and keep host story-plan /
   * archive IO on the SAME document.
   */
  guestFile?: string;
}

/** Identity token captured when reading the committed document. */
export interface ProgressDocIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function isRegular(st: fs.Stats): boolean {
  return (st.mode & fs.constants.S_IFMT) === fs.constants.S_IFREG;
}

/**
 * Confined host access to ONE run's progress document. Constructed by the
 * host from the deterministic resource directory; the guest never supplies
 * paths to it. All IO is no-follow and refuses special files; content is
 * bounded; host writes are atomic replace inside the resource directory.
 */
export class ProgressResourceAccess {
  readonly hostDir: string;
  readonly docName = PROGRESS_DOC_FILE_NAME;
  readonly maxBytes: number;
  private readonly nowFn: () => number;
  private readonly guestFileValue?: string;

  constructor(hostDir: string, opts?: ProgressAccessOptions) {
    this.hostDir = hostDir;
    this.maxBytes = opts?.maxBytes ?? DEFAULT_MAX_PROGRESS_DOC_BYTES;
    this.nowFn = opts?.now ?? Date.now;
    this.guestFileValue = opts?.guestFile;
  }

  /** Guest-visible progress file path ('' when not bound to a run). */
  get guestFile(): string {
    return this.guestFileValue ?? "";
  }

  /** Host path of the committed document (canonical for this resource). */
  get hostFile(): string {
    return progressHostFile(this.hostDir);
  }

  // ── directory identity ──────────────────────────────────────────────

  /**
   * Fresh per-op verification that the resource directory is still a REAL
   * directory (no symlink, no file). This is a fresh no-follow lstat on every
   * access — never a cached one-time realpath — and it refuses before any
   * leaf IO, so a replaced/relinked resource dir fails closed.
   */
  private assertRealResourceDir(): void {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(this.hostDir);
    } catch {
      throw new ProgressResourceError(
        "resource_dir_unavailable",
        `Progress resource directory is not present: ${this.hostDir}`,
      );
    }
    if (!st.isDirectory()) {
      throw new ProgressResourceError(
        "resource_dir_unavailable",
        `Progress resource path is not a real directory: ${this.hostDir}`,
      );
    }
  }

  /** Ensure the resource directory exists (host-owned, no-follow mkdir). */
  ensureDir(): void {
    fs.mkdirSync(this.hostDir, { recursive: true });
    this.assertRealResourceDir();
  }

  // ── confined read ───────────────────────────────────────────────────

  /**
   * Read the committed document content. Returns null when the document does
   * not exist yet (attach/restart with no prior content). Refuses symlink /
   * FIFO / socket / device leaf entries and oversized documents. Never falls
   * back to legacy/workspace files: after an opted-in refusal there is no
   * silent fallback.
   */
  readText(): string | null {
    this.assertRealResourceDir();
    const file = this.hostFile;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      return null; // absent document → empty/initial state, not an error
    }
    if (st.isSymbolicLink() || !isRegular(st)) {
      throw new ProgressResourceError(
        "progress_special_file",
        `Progress document ${file} is not a regular file (symlink/special); refusing to read it.`,
      );
    }
    if (st.size > this.maxBytes) {
      throw new ProgressResourceError(
        "progress_doc_too_large",
        `Progress document ${file} is ${st.size} bytes (limit ${this.maxBytes}); refusing to read it.`,
      );
    }
    // O_NOFOLLOW defeats a symlink swapped in between lstat and open;
    // O_NONBLOCK prevents hanging on a FIFO; fstat re-verifies the fd target.
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch {
      throw new ProgressResourceError(
        "progress_special_file",
        `Progress document ${file} could not be opened no-follow; refusing to read it.`,
      );
    }
    try {
      const fst = fs.fstatSync(fd);
      if (!isRegular(fst)) {
        throw new ProgressResourceError(
          "progress_special_file",
          `Progress document ${file} is not a regular file at open time; refusing to read it.`,
        );
      }
      if (fst.size > this.maxBytes) {
        throw new ProgressResourceError(
          "progress_doc_too_large",
          `Progress document ${file} is ${fst.size} bytes (limit ${this.maxBytes}); refusing to read it.`,
        );
      }
      const buf = Buffer.alloc(fst.size || 0);
      if (fst.size > 0) {
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        if (bytesRead !== buf.length) {
          throw new ProgressResourceError(
            "progress_read_incomplete",
            `Progress document ${file} read only ${bytesRead}/${buf.length} bytes.`,
          );
        }
      }
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Identity token of the CURRENT committed doc entry (null when absent). */
  private currentIdentity(): ProgressDocIdentity | null {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(this.hostFile);
    } catch {
      return null;
    }
    if (st.isSymbolicLink() || !isRegular(st)) return null;
    return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
  }

  // ── confined write (atomic replace) ─────────────────────────────────

  /**
   * Atomically replace the committed document with `content`.
   *
   * The temp file is written into a HOST-ONLY sibling staging directory
   * (`<resourceParent>/.progress-tmp/`), NOT inside the guest-visible resource
   * directory: the guest-visible dir then holds only `progress.txt` (plus
   * whatever the guest itself created), so no host temp artifact can leak into
   * the exported scope. Staging on the same filesystem keeps the final
   * rename-over atomic. The temp is created with O_EXCL|O_NOFOLLOW, fsynced,
   * then renamed over `progress.txt` — rename replaces whatever entry exists
   * (including a guest-planted symlink/FIFO) WITHOUT following it. Bounds
   * content length first.
   */
  commitText(content: string): void {
    this.assertRealResourceDir();
    if (typeof content !== "string") {
      throw new ProgressResourceError("progress_content_invalid", "Progress content must be a string.");
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxBytes) {
      throw new ProgressResourceError(
        "progress_doc_too_large",
        `Progress content is ${bytes} bytes (limit ${this.maxBytes}); refusing to commit it.`,
      );
    }
    // Host-only sibling staging dir (never mounted / exported).
    const stagingDir = path.join(path.dirname(this.hostDir), ".progress-tmp");
    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      const st = fs.lstatSync(stagingDir);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        throw new Error("staging path is not a real directory");
      }
    } catch (err) {
      throw new ProgressResourceError(
        "progress_write_failed",
        `Could not prepare progress staging dir ${stagingDir}: ${(err as Error).message}`,
      );
    }
    const temp = path.join(
      stagingDir,
      `.progress.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
    );
    let fd: number;
    try {
      fd = fs.openSync(
        temp,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new ProgressResourceError(
        "progress_write_failed",
        `Could not create progress temp file in ${stagingDir}; refusing to commit.`,
      );
    }
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } catch (err) {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(temp);
      } catch {
        /* best effort */
      }
      throw new ProgressResourceError(
        "progress_write_failed",
        `Progress temp write failed: ${(err as Error).message}`,
      );
    }
    fs.closeSync(fd);
    try {
      fs.renameSync(temp, this.hostFile);
    } catch (err) {
      try {
        fs.unlinkSync(temp);
      } catch {
        /* best effort */
      }
      throw new ProgressResourceError(
        "progress_write_failed",
        `Atomic replace of progress document failed: ${(err as Error).message}`,
      );
    }
  }

  // ── compare-and-commit host updates ─────────────────────────────────

  /**
   * Read-modify-commit host update with COMPARE-AND-COMMIT discipline.
   *
   * `merge` receives the current committed content (null when absent) and must
   * return the next committed content. The layer re-checks the document
   * identity after `merge` and only commits when it is unchanged since the
   * read; a changed identity means the guest (or another host writer)
   * committed concurrently, so the update re-reads and retries with the fresh
   * content (bounded by PROGRESS_UPDATE_MAX_RETRIES). A guest commit OBSERVED
   * between the initial read and the pre-commit re-check is therefore never
   * silently dropped. The residual unsynchronized window — a guest commit
   * landing after the final identity re-check but before the host's
   * rename-over — is last-writer-wins at the directory entry; live ARBITRARY
   * simultaneous host+guest writers are NOT claimed (see the contract's
   * race_reasoning).
   */
  updateText(merge: (current: string | null) => string): string {
    this.assertRealResourceDir();
    for (let attempt = 0; attempt < PROGRESS_UPDATE_MAX_RETRIES; attempt++) {
      const before = this.currentIdentity();
      const current = this.readText();
      const next = merge(current);
      if (typeof next !== "string") {
        throw new ProgressResourceError("progress_content_invalid", "Progress merge must return a string.");
      }
      const after = this.currentIdentity();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        continue; // committed by someone else between read and commit → retry fresh
      }
      this.commitText(next);
      return next;
    }
    throw new ProgressResourceError(
      "progress_update_contended",
      `Progress document in ${this.hostDir} kept changing during compare-and-commit; giving up after ${PROGRESS_UPDATE_MAX_RETRIES} attempts.`,
    );
  }

  // ── archive ─────────────────────────────────────────────────────────

  /**
   * Archive the committed document into a HOST-owned archive directory and
   * then remove the resource document (mirrors native archiveRunProgress:
   * copy then unlink). Read is confined; the archive destination is host-owned.
   * Returns the archived text ("" when nothing was archived).
   */
  archiveTo(archiveDir: string): string {
    this.assertRealResourceDir();
    const text = this.readText();
    if (text === null) return "";
    fs.mkdirSync(archiveDir, { recursive: true });
    const dest = path.join(archiveDir, PROGRESS_DOC_FILE_NAME);
    fs.writeFileSync(dest, text, "utf8");
    // Remove the resource document only after the archive copy succeeded.
    // unlink removes the directory entry itself — never follows a symlink.
    try {
      fs.unlinkSync(this.hostFile);
    } catch {
      // If the document disappeared (guest replaced it) after our read, the
      // committed content is already archived; treat the resource as cleared.
    }
    return text;
  }

  /** True when the resource directory exists as a real directory. */
  get exists(): boolean {
    try {
      const st = fs.lstatSync(this.hostDir);
      return st.isDirectory();
    } catch {
      return false;
    }
  }
}

/**
 * A run-scoped opt-in progress resource binding: the host progress resource
 * directory for a run + the guest-visible file path + the confined access
 * layer. Satisfies the step-ops `RunProgressAccessLike` seam structurally
 * (step-ops never imports this module).
 */
export interface RunProgressResource {
  readonly runId: string;
  /** Host progress-only directory (host-attested; derived from run id + state root). */
  readonly hostDir: string;
  /** Guest-visible absolute progress file path. */
  readonly guestFile: string;
  /** Confined host access to the progress document. */
  readonly access: ProgressResourceAccess;
}

/**
 * Attach the host progress resource for a run: derives the deterministic host
 * resource dir, ensures it exists, and returns a confined accessor bound to
 * the run's guest file. Host-attested: the caller (controller/runner) decides
 * to opt in; the guest never supplies the directory or guest path.
 */
export function attachRunProgressResource(
  runId: string,
  opts?: ProgressAccessOptions & { runRoot?: string },
): RunProgressResource {
  const bare = assertSafeRunId(runId);
  const hostDir = progressResourceHostDirForRun(runId, { runRoot: opts?.runRoot });
  const access = new ProgressResourceAccess(hostDir, {
    maxBytes: opts?.maxBytes,
    now: opts?.now,
    guestFile: progressGuestFileForRun(bare),
  });
  access.ensureDir();
  return {
    runId: bare,
    hostDir,
    guestFile: access.guestFile,
    access,
  };
}
