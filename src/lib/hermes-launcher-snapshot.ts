/**
 * Hermes launcher-chain resolution + snapshot/restore safety net.
 *
 * Markers: HCANARY-CONTAM | LAUNCHER-SNAPSHOT
 *
 * The real hermes e2e canary (`e2e-tests/workflows-hermes-canary-real.test.ts`)
 * runs the REAL source-installed hermes under an isolated temp HOME whose
 * `~/.hermes` is SYMLINKED to the operator's real `~/.hermes`. While the run is
 * live, hermes's profile-boot launcher publication can rewrite the REAL
 * source-install launchers with an interpreter path resolved through the TEMP
 * home. After the temp home is cleaned, the real launchers exec a deleted path
 * (`hermes --version` rc=126).
 *
 * The launcher layout varies by install method, so it must be derived from the
 * host itself — never hardcoded:
 *
 *   - On macOS the observed `~/.local/bin/hermes` is an EXEC SHIM (a tiny shell
 *     script `exec <realHome>/.hermes/hermes-agent/.hermes/bin/hermes "$@"`),
 *     NOT a symlink. `fs.realpath` does not follow an exec shim, so a resolver
 *     built on realpath alone silently misses the very files that get
 *     contaminated.
 *   - On linux the observed `~/.local/bin/hermes` is a plain bash launcher.
 *
 * Therefore this module resolves the chain by BOTH following symlinks AND
 * reading each chain file's `exec <absolute-path>` target(s), then enumerates
 * every regular `hermes*` file in the resulting deduped scan-dir set.
 *
 * Purity: node builtins only (`fs`, `path`). No `node:child_process` — the
 * caller supplies the entry path (the canary reads it from `command -v hermes`
 * or `TAMANDUA_HERMES_BINARY`). No new runtime dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of resolving the real `~/.hermes` root behind the temp home link. */
export interface RealHermesRootResult {
  /** Canonical absolute path of the real hermes root, or null when unresolved. */
  root: string | null;
  /** Number of symlink hops followed from `<tempHomeDir>/.hermes`. */
  hops: number;
  /** True when `root` is an absolute path. */
  absolute: boolean;
  /** True when the resolved root exists and is a directory. */
  exists: boolean;
  /** Recorded resolution notes / explicit no-op reasons (never throw). */
  reasons: string[];
}

/** How a directory entered the launcher scan set. */
export type LauncherScanDirSource =
  | "entry-dir"
  | "symlink-hop-dir"
  | "exec-target-dir"
  | "belt-and-braces";

/** A directory that is scanned for regular `hermes*` launcher files. */
export interface LauncherScanDir {
  /** Canonical absolute directory path. */
  path: string;
  /** True when the directory exists and is readable as a directory. */
  existed: boolean;
  /** Why the directory was added to the scan set. */
  source: LauncherScanDirSource;
}

/** A regular launcher file discovered in the scan set. */
export interface LauncherFileRef {
  /** Absolute canonical path to the launcher file. */
  path: string;
  /** The scan directory that yielded the file. */
  dir: string;
  /** Provenance of the scan directory. */
  source: LauncherScanDirSource;
}

/** Result of resolving the real launcher chain. Never throws. */
export interface LauncherChainResult {
  /** The caller-supplied entry path, echoed back (null when none supplied). */
  entryPath: string | null;
  /** The real hermes root used for the belt-and-braces scan (may be null). */
  realHermesRoot: string | null;
  /** Deduped, sorted directories scanned for launcher files. */
  scanDirs: LauncherScanDir[];
  /** Deduped, sorted regular `hermes*` files found in the scan set. */
  files: LauncherFileRef[];
  /** True when no launcher file matched (explicit no-op). */
  noop: boolean;
  /** Recorded provenance / explicit no-op reasons (never throw). */
  reasons: string[];
}

/** Options for {@link resolveLauncherChain}. */
export interface ResolveLauncherChainOptions {
  /**
   * Launcher entry path supplied by the caller (the canary reads
   * `command -v hermes`, falling back to `TAMANDUA_HERMES_BINARY`). Null /
   * empty is a recorded no-op, not an error.
   */
  entryPath?: string | null;
  /**
   * The real hermes root (see {@link resolveRealHermesRoot}) used only for the
   * belt-and-braces `<root>/hermes-agent/.hermes/bin` scan when that directory
   * exists.
   */
  realHermesRoot?: string | null;
}

// ---------------------------------------------------------------------------
// Snapshot / restore / verify types (implemented in US-002)
// ---------------------------------------------------------------------------

/** A single snapshotted launcher file. */
export interface LauncherSnapshotEntry {
  /** Absolute path to the launcher file at snapshot time. */
  path: string;
  /** Exact pre-run bytes. */
  bytes: Buffer;
  /** Lowercase hex sha256 of `bytes`. */
  sha256: string;
  /** File mode at snapshot time (preserve on restore). */
  mode: number;
}

/** The pre-run snapshot of the resolved launcher set. */
export interface LauncherSnapshot {
  entries: LauncherSnapshotEntry[];
  /** True when nothing was snapshotted (explicit no-op). */
  noop: boolean;
  reasons: string[];
}

/** Result of restoring launchers to a snapshot. */
export interface LauncherRestoreResult {
  /** Files whose bytes were rewritten from the snapshot. */
  restored: string[];
  /** Files already byte-identical to the snapshot (never rewritten). */
  unchanged: string[];
  /** Files that could not be restored. */
  failed: string[];
}

/** Per-file verification outcome. */
export interface LauncherVerifyEntry {
  path: string;
  identical: boolean;
  expectedSha256: string;
  actualSha256: string | null;
}

/** Result of verifying launchers against a snapshot. */
export interface LauncherVerifyResult {
  entries: LauncherVerifyEntry[];
  /** True when every snapshotted file is byte-identical. */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SymlinkWalk {
  /** Final path reached by following symlinks (may not exist). */
  target: string;
  /** Every path considered, starting at the entry (symlinks and terminal). */
  visited: string[];
  /** Non-fatal resolution problem, if any. */
  error?: string;
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Follow a symlink chain transitively, recording every path visited.
 * Never throws; a missing/broken link is reported via `error`.
 */
function followSymlinks(start: string, maxHops = 40): SymlinkWalk {
  const visited: string[] = [];
  const seen = new Set<string>();
  let current = start;

  for (;;) {
    let resolvedCurrent: string;
    try {
      resolvedCurrent = path.resolve(current);
    } catch {
      resolvedCurrent = current;
    }
    if (seen.has(resolvedCurrent)) {
      return { target: current, visited, error: "symlink cycle detected" };
    }
    seen.add(resolvedCurrent);
    visited.push(current);

    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      return { target: current, visited, error: `lstat ${current}: ${errCode(err)}` };
    }
    if (!st.isSymbolicLink()) {
      return { target: current, visited };
    }
    if (visited.length > maxHops) {
      return { target: current, visited, error: `symlink chain exceeds ${maxHops} hops` };
    }
    let link: string;
    try {
      link = fs.readlinkSync(current);
    } catch (err) {
      return { target: current, visited, error: `readlink ${current}: ${errCode(err)}` };
    }
    current = path.isAbsolute(link)
      ? link
      : path.resolve(path.dirname(current), link);
  }
}

/** Dedupe/canonicalize a directory or file path; falls back to path.resolve. */
function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when a basename matches the launcher glob `hermes*`. */
function isLauncherBasename(name: string): boolean {
  return name.startsWith("hermes");
}

/**
 * Extract every absolute path following an `exec` token in a shim's text.
 * The observed macOS shim is a two-line shell script:
 *
 *     #!/bin/sh
 *     exec /real/home/.hermes/hermes-agent/.hermes/bin/hermes "$@"
 *
 * Quotes are stripped; `env` prefixes and `KEY=value` assignments are skipped
 * so that `exec env FOO=bar /abs/hermes` still yields `/abs/hermes`. A
 * non-absolute first command token (e.g. a bare interpreter or `$VAR`) yields
 * nothing, because it cannot be resolved without the runtime environment.
 */
function extractExecTargets(text: string): string[] {
  const targets: string[] = [];
  const re = /^[ \t]*exec[ \t]+(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const tokens = match[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (const raw of tokens) {
      const tok = raw.replace(/^["']|["']$/g, "");
      if (path.isAbsolute(tok)) {
        targets.push(tok);
        break;
      }
      if (tok === "env" || tok.includes("=")) continue;
      break;
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// resolveRealHermesRoot
// ---------------------------------------------------------------------------

/**
 * Resolve the real hermes root from `<tempHomeDir>/.hermes`.
 *
 * Follows the symlink target transitively and canonicalizes with realpath, so
 * the returned path is the real `~/.hermes` even when the temp home lives on a
 * symlinked `/tmp`. Returns `absolute`/`exists` flags and never throws: a
 * missing link is an explicit no-op result.
 */
export function resolveRealHermesRoot(tempHomeDir: string): RealHermesRootResult {
  const reasons: string[] = [];
  try {
    if (!tempHomeDir || typeof tempHomeDir !== "string") {
      reasons.push("no-op: no temp home directory supplied");
      return { root: null, hops: 0, absolute: false, exists: false, reasons };
    }

    const linkPath = path.join(tempHomeDir, ".hermes");
    try {
      fs.lstatSync(linkPath);
    } catch (err) {
      reasons.push(`no-op: ${linkPath} does not exist (${errCode(err)})`);
      return { root: null, hops: 0, absolute: false, exists: false, reasons };
    }

    const walk = followSymlinks(linkPath);
    if (walk.error) {
      reasons.push(`warning: symlink walk from ${linkPath}: ${walk.error}`);
    }
    const hops = walk.visited.length - 1;
    const root = canonicalize(walk.target);
    const absolute = path.isAbsolute(root);

    let exists = false;
    try {
      exists = fs.statSync(root).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      reasons.push(`no-op: resolved hermes root ${root} is not an existing directory`);
    } else {
      reasons.push(`resolved hermes root ${root} (${hops} symlink hop(s))`);
    }
    return { root, hops, absolute, exists, reasons };
  } catch (err) {
    reasons.push(`unexpected resolveRealHermesRoot error: ${errMessage(err)}`);
    return { root: null, hops: 0, absolute: false, exists: false, reasons };
  }
}

// ---------------------------------------------------------------------------
// resolveLauncherChain
// ---------------------------------------------------------------------------

/**
 * Resolve the real hermes launcher chain from a caller-supplied entry path.
 *
 * - Follows symlinks transitively and adds the entry dir plus every hop dir to
 *   the scan set.
 * - Reads each chain file and adds EVERY `exec <absolute-path>` target's dir to
 *   the scan set; only targets whose basename matches `hermes*` are recursed
 *   into (interpreter targets such as python are ignored).
 * - Adds belt-and-braces `<realHermesRoot>/hermes-agent/.hermes/bin` to the
 *   scan set; it is enumerated only when it exists (a missing dir is an
 *   explicit `existed:false` no-op record).
 * - Enumerates regular `hermes*` files only (never directories) and returns an
 *   explicit no-op with reasons when nothing matches.
 *
 * Never throws.
 */
export function resolveLauncherChain(
  opts: ResolveLauncherChainOptions = {},
): LauncherChainResult {
  const reasons: string[] = [];
  const scanDirs = new Map<string, LauncherScanDir>();
  const files = new Map<string, LauncherFileRef>();
  const entryPath =
    typeof opts?.entryPath === "string" && opts.entryPath.length > 0
      ? opts.entryPath
      : null;
  const realHermesRoot =
    typeof opts?.realHermesRoot === "string" && opts.realHermesRoot.length > 0
      ? opts.realHermesRoot
      : null;

  const addScanDir = (
    dir: string | null | undefined,
    source: LauncherScanDirSource,
  ): void => {
    if (!dir) return;
    let key: string;
    try {
      key = canonicalize(dir);
    } catch {
      return;
    }
    if (scanDirs.has(key)) return;
    let existed = false;
    try {
      existed = fs.statSync(key).isDirectory();
    } catch {
      existed = false;
    }
    scanDirs.set(key, { path: key, existed, source });
  };

  try {
    if (entryPath) {
      addScanDir(path.dirname(entryPath), "entry-dir");

      const walk = followSymlinks(entryPath);
      if (walk.error) {
        reasons.push(`warning: entry chain walk from ${entryPath}: ${walk.error}`);
      }
      for (const hop of walk.visited) {
        addScanDir(path.dirname(hop), "symlink-hop-dir");
      }

      // Read the resolved chain files and recurse through hermes* exec targets.
      const queue: string[] = [walk.target];
      const processed = new Set<string>();
      while (queue.length > 0) {
        const chainFile = queue.shift() as string;
        const fileKey = canonicalize(chainFile);
        if (processed.has(fileKey)) continue;
        processed.add(fileKey);

        let st: fs.Stats;
        try {
          st = fs.statSync(chainFile);
        } catch (err) {
          reasons.push(`no-op: chain file ${chainFile} missing (${errCode(err)})`);
          continue;
        }
        if (!st.isFile()) continue;

        let text: string;
        try {
          text = fs.readFileSync(chainFile, "utf-8");
        } catch (err) {
          reasons.push(
            `warning: could not read chain file ${chainFile} (${errCode(err)})`,
          );
          continue;
        }

        for (const target of extractExecTargets(text)) {
          addScanDir(path.dirname(target), "exec-target-dir");
          let targetSt: fs.Stats;
          try {
            targetSt = fs.statSync(target);
          } catch {
            continue; // missing exec target: dir recorded, nothing to follow
          }
          if (!targetSt.isFile()) continue;
          // Ignore interpreter targets (python, etc.) — only launchers recurse.
          if (!isLauncherBasename(path.basename(target))) continue;
          queue.push(target);
        }
      }
    } else {
      reasons.push(
        "no-op: no launcher entry path supplied (command -v hermes returned nothing)",
      );
    }

    // Belt-and-braces: the known generated source-launcher directory, only when
    // it actually exists. Never hardcode the macOS layout.
    if (realHermesRoot) {
      const beltAndBraces = path.join(
        realHermesRoot,
        "hermes-agent",
        ".hermes",
        "bin",
      );
      let bbExists = false;
      try {
        bbExists = fs.statSync(beltAndBraces).isDirectory();
      } catch {
        bbExists = false;
      }
      // The record is always returned so a missing dir is an explicit
      // `existed:false` no-op; enumeration skips non-existent dirs.
      addScanDir(beltAndBraces, "belt-and-braces");
      if (!bbExists) {
        reasons.push(
          `no-op: belt-and-braces dir ${beltAndBraces} does not exist`,
        );
      }
    } else {
      reasons.push(
        "no-op: no real hermes root supplied; belt-and-braces scan skipped",
      );
    }

    // Enumerate regular hermes* files from every existing scan dir.
    for (const dir of scanDirs.values()) {
      if (!dir.existed) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir.path, { withFileTypes: true });
      } catch (err) {
        reasons.push(`warning: could not read dir ${dir.path} (${errCode(err)})`);
        continue;
      }
      for (const entry of entries) {
        if (!isLauncherBasename(entry.name)) continue;
        const full = path.join(dir.path, entry.name);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        // Regular files only — never directories (statSync follows symlinks,
        // so a symlink to a regular launcher is still included).
        if (!st.isFile()) continue;
        // Record the CANONICAL path: when the same file is reachable through a
        // symlink alias, restore must rewrite the real file (a snapshot keyed
        // on the alias could not repair a replaced target).
        const key = canonicalize(full);
        if (files.has(key)) continue;
        files.set(key, { path: key, dir: dir.path, source: dir.source });
      }
    }
  } catch (err) {
    reasons.push(`unexpected resolveLauncherChain error: ${errMessage(err)}`);
  }

  const scanDirList = [...scanDirs.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const fileList = [...files.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const noop = fileList.length === 0;
  if (noop) {
    reasons.push(
      "no-op: no launcher files matched the resolved scan directories",
    );
  }

  return {
    entryPath,
    realHermesRoot,
    scanDirs: scanDirList,
    files: fileList,
    noop,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Snapshot / restore / verify
// ---------------------------------------------------------------------------

/** Lowercase hex sha256 of a byte buffer. */
function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Capture `{ path, bytes, sha256, mode }` for every resolved regular launcher
 * file. Read-only: this never writes to the filesystem.
 *
 * A chain with zero resolved files (or only non-regular entries) is an explicit
 * no-op snapshot — an empty entry set plus recorded reasons — never a throw.
 */
export function snapshotLaunchers(chain: LauncherChainResult): LauncherSnapshot {
  const reasons: string[] = [];
  const entries: LauncherSnapshotEntry[] = [];
  try {
    if (chain?.reasons?.length) reasons.push(...chain.reasons);

    if (!chain || chain.files.length === 0) {
      reasons.push("no-op: no launcher files resolved to snapshot");
      return { entries, noop: true, reasons };
    }

    for (const file of chain.files) {
      try {
        const st = fs.statSync(file.path);
        if (!st.isFile()) {
          reasons.push(`no-op: ${file.path} is not a regular file`);
          continue;
        }
        const bytes = fs.readFileSync(file.path);
        entries.push({
          path: file.path,
          bytes,
          sha256: sha256Hex(bytes),
          mode: st.mode,
        });
      } catch (err) {
        reasons.push(
          `warning: could not snapshot launcher ${file.path} (${errCode(err)})`,
        );
      }
    }
  } catch (err) {
    reasons.push(`unexpected snapshotLaunchers error: ${errMessage(err)}`);
  }

  const noop = entries.length === 0;
  if (noop) {
    reasons.push("no-op: no launcher files could be snapshotted");
  }
  return { entries, noop, reasons };
}

/**
 * Restore the snapshotted launcher files.
 *
 * Only files whose current bytes differ from the snapshot are rewritten; files
 * that are already byte-identical are left strictly untouched (no write, no
 * `chmod`, mtime preserved). Rewritten files have their recorded permission
 * bits (`mode & 0o7777`) reapplied.
 *
 * If any needed write fails, a single Error naming every failing path is
 * thrown — a caller must never treat failed restoration as success.
 */
export function restoreLaunchers(
  snapshot: LauncherSnapshot,
): LauncherRestoreResult {
  const restored: string[] = [];
  const unchanged: string[] = [];
  const failed: string[] = [];
  const failures: string[] = [];

  for (const entry of snapshot?.entries ?? []) {
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(entry.path);
    } catch {
      // Missing / unreadable => must restore from the snapshot.
      current = null;
    }

    if (current !== null && current.equals(entry.bytes)) {
      unchanged.push(entry.path);
      continue;
    }

    try {
      fs.writeFileSync(entry.path, entry.bytes, { mode: entry.mode & 0o7777 });
      // `mode` on writeFileSync only applies when creating; existing files keep
      // their old mode, so reapply the recorded permissions explicitly.
      fs.chmodSync(entry.path, entry.mode & 0o7777);
      restored.push(entry.path);
    } catch (err) {
      failed.push(entry.path);
      failures.push(`${entry.path} (${errMessage(err)})`);
    }
  }

  if (failed.length > 0) {
    throw new Error(
      `restoreLaunchers could not restore ${failed.length} launcher file(s): ` +
        failures.join("; "),
    );
  }
  return { restored, unchanged, failed };
}

/**
 * Read-only per-file byte-identity verification against the snapshot.
 *
 * Recomputes the current bytes/sha256 of each snapshotted path and reports
 * whether it matches. A missing file is reported as not identical with a null
 * actual hash. Never writes.
 */
export function verifyLaunchers(snapshot: LauncherSnapshot): LauncherVerifyResult {
  const entries: LauncherVerifyEntry[] = [];
  for (const entry of snapshot?.entries ?? []) {
    let actualBytes: Buffer | null = null;
    try {
      actualBytes = fs.readFileSync(entry.path);
    } catch {
      actualBytes = null;
    }
    const actualSha256 = actualBytes === null ? null : sha256Hex(actualBytes);
    entries.push({
      path: entry.path,
      identical: actualSha256 === entry.sha256,
      expectedSha256: entry.sha256,
      actualSha256,
    });
  }
  const ok = entries.every((e) => e.identical);
  return { entries, ok };
}
