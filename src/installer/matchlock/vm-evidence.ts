/**
 * vm-evidence.ts — MATCHLOCK-OBS US-003 (bead tamandua-6sy.33.33).
 *
 * Bounded VM evidence capture + removal for ONE Matchlock VM. The product
 * calls `matchlock rpc close` (stops the VM, KEEPS the state row and
 * `~/.matchlock/vms/<id>/`) and never `rm`, so every round (probe + work)
 * leaves a stopped VM row and state dir behind. This module closes that gap:
 *
 *   1. copy the VM's retained `config.json` and every regular file under
 *      `logs/` into the run's evidence directory, then
 *   2. spawn `matchlock rm <vmId>` to remove the row + state dir.
 *
 * Design constraints (from the story):
 *  - This module OWNS the `node:child_process` spawn. The invocation runners
 *    (pi/dsh/hermes) import this module and keep NO direct child_process
 *    dependency.
 *  - `spawnSync` with an argv array — never a shell.
 *  - NEVER throw: an absent state dir, a missing CLI, a non-zero exit and a
 *    timeout all resolve to a {@link CaptureAndRemoveVmResult}. A genuine
 *    removal failure is reportable (`removed: false` + bounded
 *    `removalError`) and the caller logs it; it never silently disappears.
 *  - Copying is bounded (file count, per-file size, total byte budget) and
 *    per-file best-effort; it NEVER follows a symlink out of the VM dir.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import {
  MATCHLOCK_ERROR_TAIL_MAX_BYTES,
  boundMatchlockErrorText,
} from "./runner-error.js";

export type VmEvidenceLogLevel = "info" | "warn";

export interface CaptureAndRemoveVmOptions {
  /** Matchlock VM id to capture + remove. Required, non-empty, no path separators. */
  vmId: string;
  /**
   * The EFFECTIVE matchlock HOME the VM was created with (the value prefixed
   * to `.matchlock/vms/<vmId>` and exported as HOME to the rm child).
   */
  matchlockHome: string;
  /** Host directory the VM evidence is copied into (created recursively). */
  destinationDir: string;
  /** Matchlock CLI binary (e.g. "matchlock"). */
  cliBinaryPath: string;
  /** Optional argv prefix inserted BEFORE "rm" (default []). */
  cliArgsPrefix?: readonly string[];
  /** Extra env merged over process.env for the rm child; HOME is forced to matchlockHome. */
  env?: Record<string, string | undefined>;
  /** Positive wall-clock budget (ms) for the rm child (default 120000). */
  timeoutMs?: number;
  /** Optional structured log sink (info on success, warn on failure). */
  onLog?: (
    level: VmEvidenceLogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

export interface CaptureAndRemoveVmResult {
  /** The VM id this result describes. */
  vmId: string;
  /** True when nothing remains (removed, already absent, or reported already gone). */
  removed: boolean;
  /** Destination the evidence was copied into, or null when nothing was captured. */
  logsCopiedTo: string | null;
  /** Exit code of the rm child (null when no child ran or it was killed). */
  removalExitCode: number | null;
  /** Bounded removal failure description; absent on success/already-gone. */
  removalError?: string;
}

/** Default wall-clock budget for `matchlock rm` (ms). */
export const DEFAULT_VM_REMOVAL_TIMEOUT_MS = 120_000;
/** Maximum number of evidence files copied (bounded). */
export const MAX_VM_EVIDENCE_FILES = 512;
/** Maximum size of a single copied evidence file (bounded). */
export const MAX_VM_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
/** Total byte budget across all copied evidence files (bounded). */
export const MAX_VM_EVIDENCE_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Text an `rm` child may print when the VM is already gone. Matched
 * case-insensitively against the combined stdout+stderr of a NON-ZERO exit
 * only; a genuine failure (permission, transport) never matches.
 */
const ALREADY_GONE_RE =
  /(no such|not found|does not exist|doesn't exist|already (been )?(removed|gone)|unknown (vm|id)|no vm|no matching vm)/i;

function bound(text: string): string {
  return boundMatchlockErrorText(text, MATCHLOCK_ERROR_TAIL_MAX_BYTES);
}

/** lstat without following the final symlink; null when absent/unreadable. */
function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** True only for a REAL directory (a symlink to one is NOT accepted). */
function isRealDirectory(target: string): boolean {
  const stat = lstatOrNull(target);
  return stat !== null && stat.isDirectory();
}

/**
 * Copy `config.json` + every regular file under `logs/` from `vmDir` into
 * `destinationDir`, preserving the relative layout. Per-file best-effort;
 * symlinks (file or directory) are skipped so the walk can never escape the
 * VM dir. Returns `destinationDir` when the VM dir was a real directory (the
 * copy destination was prepared), else null.
 */
function copyVmEvidence(
  vmDir: string,
  destinationDir: string,
  onLog: CaptureAndRemoveVmOptions["onLog"],
): string | null {
  // Never follow a symlinked VM dir out of the state root.
  if (!isRealDirectory(vmDir)) return null;

  try {
    fs.mkdirSync(destinationDir, { recursive: true });
  } catch (err) {
    onLog?.("warn", "failed to create vm evidence destination", {
      destinationDir,
      error: bound(errMessage(err)),
    });
    return null;
  }

  let remainingFiles = MAX_VM_EVIDENCE_FILES;
  let remainingBytes = MAX_VM_EVIDENCE_TOTAL_BYTES;

  const copyOne = (srcPath: string, relative: string): void => {
    if (remainingFiles <= 0 || remainingBytes <= 0) return;
    const stat = lstatOrNull(srcPath);
    // Only regular files: a symlink (or dir/fifo/socket) is skipped, never
    // followed out of the VM dir.
    if (stat === null || !stat.isFile()) return;
    if (stat.size > MAX_VM_EVIDENCE_FILE_BYTES || stat.size > remainingBytes) return;
    const destPath = path.join(destinationDir, relative);
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      remainingFiles -= 1;
      remainingBytes -= stat.size;
    } catch {
      /* per-file best-effort: one unreadable file never aborts the capture */
    }
  };

  copyOne(path.join(vmDir, "config.json"), "config.json");

  const logsDir = path.join(vmDir, "logs");
  if (isRealDirectory(logsDir)) {
    const walk = (dir: string, relative: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRelative = path.join(relative, entry.name);
        const childPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(childPath, childRelative);
        } else if (entry.isFile()) {
          copyOne(childPath, childRelative);
        }
        // Symlinks (and anything else) are deliberately skipped.
      }
    };
    walk(logsDir, "logs");
  }

  return destinationDir;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/**
 * Capture a positively-closed VM's retained evidence and remove the VM.
 *
 * Ordering is guaranteed: every evidence file is copied BEFORE the `rm` child
 * is spawned. The child is spawned with `HOME=matchlockHome` (overriding any
 * HOME in `env`/`process.env`) and a bounded timeout.
 *
 * Resolution:
 *  - state dir already absent                -> `removed: true`, no spawn
 *  - `rm` exit 0                             -> `removed: true`
 *  - `rm` non-zero reporting already-gone    -> `removed: true`
 *  - `rm` non-zero / signal / spawn error    -> `removed: false` + bounded
 *    `removalError` (the copied evidence is retained)
 *
 * Never throws.
 */
export function captureAndRemoveVm(
  opts: CaptureAndRemoveVmOptions,
): CaptureAndRemoveVmResult {
  const vmId = typeof opts.vmId === "string" ? opts.vmId : "";
  const result: CaptureAndRemoveVmResult = {
    vmId,
    removed: false,
    logsCopiedTo: null,
    removalExitCode: null,
  };

  try {
    if (vmId.length === 0 || vmId === "." || vmId === ".." || /[/\\]/.test(vmId)) {
      return { ...result, removalError: bound(`invalid vm id: ${JSON.stringify(vmId)}`) };
    }
    if (!opts.matchlockHome || !opts.destinationDir || !opts.cliBinaryPath) {
      return {
        ...result,
        removalError: "matchlockHome, destinationDir and cliBinaryPath are required",
      };
    }

    const vmDir = path.join(opts.matchlockHome, ".matchlock", "vms", vmId);
    if (!fs.existsSync(vmDir)) {
      opts.onLog?.("info", "matchlock vm state dir already absent; nothing to capture or remove", {
        vmId,
      });
      return { ...result, removed: true };
    }

    const logsCopiedTo = copyVmEvidence(vmDir, opts.destinationDir, opts.onLog);
    result.logsCopiedTo = logsCopiedTo;

    const argsPrefix = Array.isArray(opts.cliArgsPrefix) ? [...opts.cliArgsPrefix] : [];
    const argv = [...argsPrefix, "rm", vmId];
    const timeoutMs =
      typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_VM_REMOVAL_TIMEOUT_MS;
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env ?? {}),
      HOME: opts.matchlockHome,
    };

    let spawned: SpawnSyncReturns<string>;
    try {
      spawned = spawnSync(opts.cliBinaryPath, argv, {
        encoding: "utf-8",
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (err) {
      const removalError = bound(`matchlock rm spawn failed: ${errMessage(err)}`);
      opts.onLog?.("warn", "matchlock vm removal failed", { vmId, removalError });
      return { ...result, removalError };
    }

    const exitCode = typeof spawned.status === "number" ? spawned.status : null;
    result.removalExitCode = exitCode;

    if (spawned.error) {
      const removalError = bound(`matchlock rm failed: ${errMessage(spawned.error)}`);
      opts.onLog?.("warn", "matchlock vm removal failed", { vmId, removalExitCode: exitCode, removalError });
      return { ...result, removed: false, removalError };
    }

    if (spawned.status === 0) {
      opts.onLog?.("info", "matchlock vm removed after evidence capture", {
        vmId,
        logsCopiedTo,
      });
      return { ...result, removed: true };
    }

    const combined = `${spawned.stdout ?? ""}\n${spawned.stderr ?? ""}`;
    if (ALREADY_GONE_RE.test(combined)) {
      opts.onLog?.("info", "matchlock vm already gone at removal time", {
        vmId,
        removalExitCode: exitCode,
      });
      return { ...result, removed: true };
    }

    const stderrTail = (spawned.stderr ?? "").trim();
    const signalNote =
      spawned.status === null && spawned.signal ? ` terminated by signal ${spawned.signal}` : "";
    const removalError = bound(
      `matchlock rm exited ${exitCode ?? "null"}${signalNote}` +
        (stderrTail ? `: ${stderrTail}` : ""),
    );
    opts.onLog?.("warn", "matchlock vm removal failed", {
      vmId,
      removalExitCode: exitCode,
      removalError,
    });
    return { ...result, removed: false, removalError };
  } catch (err) {
    // Defense-in-depth: this function NEVER throws.
    const removalError = bound(`matchlock vm capture/removal failed: ${errMessage(err)}`);
    opts.onLog?.("warn", "matchlock vm removal failed", { vmId, removalError });
    return { ...result, removalError };
  }
}
