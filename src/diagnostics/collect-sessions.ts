/**
 * Harness session-path collector (DIAG-PRUNE US-007).
 *
 * Produces the session-store section of a diagnostics bundle: the resolved
 * ON-DISK PATHS of the pi/dsh/hermes session stores a run's harness rounds
 * would write into, plus the files found there (path + size). It is
 * deliberately a PATH collector:
 *
 *  - session CONTENTS are never read (no JSONL parsing, no SQLite open),
 *  - credentials are never copied (only `state.db` itself is stat'ed, never
 *    `auth.json`/`.env` or any other sibling), and
 *  - every unresolved or missing store is reported as `status: 'absent'`
 *    with its candidate path — the collector NEVER throws.
 *
 * The locations mirror the way token attribution resolves them (same
 * candidates, same precedence) without importing the readers:
 *
 *   pi      <PI_HOME|~/.pi>/agent/sessions/<projectKey(workdir)>/*.jsonl
 *   dsh     dshSessionProjectDir(resolveDshHome(env), workdir)
 *   hermes  <resolveHermesHome(env)>/state.db
 *
 * `projectKey` (dsh's escaped-cwd directory key) is reused from
 * `src/installer/dsh-usage.ts`; the pi session directory uses the same
 * escaping, so one key function is shared. `resolveDshHome` is reused as-is
 * and `resolveHermesHome` is exported from hermes-usage.ts for exactly this
 * purpose.
 *
 * Because dsh-usage.ts owns a `node:child_process` import (its zstd binary
 * fallback), any test that imports this module lands in the serial lane and
 * must be listed in `tests/serial-files.txt`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dshSessionProjectDir,
  projectKey,
  resolveDshHome,
} from "../installer/dsh-usage.js";
import { resolveHermesHome } from "../installer/hermes-usage.js";
import type {
  HarnessKind,
  SessionPathsCollection,
  SessionStoreEntry,
  SessionStoreFile,
  SourceStatus,
} from "./types.js";

/** Subdirectory of a pi home that holds per-project session stores. */
export const PI_SESSIONS_SUBDIR = path.join("agent", "sessions");

/** Upper bound on files listed for one harness store (bounded diagnostics). */
export const DEFAULT_MAX_SESSION_FILES = 2000;

/** Maximum directory depth walked while listing a session store. */
const MAX_SESSION_WALK_DEPTH = 3;

export interface CollectSessionPathsOptions {
  /**
   * Working directory of the harness round. Drives the escaped-cwd project
   * directory for the pi and dsh stores (the same key used by token
   * attribution). An empty value is reported as an absent pi/dsh store, never
   * thrown.
   */
  workdir: string;
  /**
   * Environment used to resolve the harness homes. `PI_HOME`, `DSH_HOME` and
   * `HERMES_HOME` are honoured; when a key is absent the corresponding
   * resolver falls back to `process.env`, then the user's home (exactly as
   * token attribution does). Errors are never thrown — an unresolvable home
   * becomes an absent entry.
   */
  homes?: NodeJS.ProcessEnv;
  /** Cap on files listed per store (default {@link DEFAULT_MAX_SESSION_FILES}). */
  maxFiles?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the pi home directory. Honours an explicit `PI_HOME` (then the
 * ambient variable) and defaults to `<home>/.pi`; it never appends the
 * `/agent` config root, so the caller can spell `<piHome>/agent/sessions`.
 *
 * Exported so the bundle orchestrator and tests can assert the candidate
 * path without recomputing it.
 */
export function resolvePiHome(env?: NodeJS.ProcessEnv): string {
  const override = env?.PI_HOME ?? process.env.PI_HOME;
  if (typeof override === "string" && override.trim().length > 0) {
    return override;
  }
  return path.join(os.homedir(), ".pi");
}

/**
 * The per-workdir pi sessions directory (`<piHome>/agent/sessions/<key>`).
 * Throws only for an empty cwd (via `projectKey`), which callers guard.
 */
export function piSessionProjectDir(piHome: string, workdir: string): string {
  return path.join(piHome, PI_SESSIONS_SUBDIR, projectKey(workdir));
}

function normalizeMaxFiles(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SESSION_FILES;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_SESSION_FILES;
  return Math.floor(value);
}

/**
 * Recursively list regular files under `root` with their byte sizes. Symlinks
 * are only followed when their target resolves, and a visited-realpath set
 * prevents cycles. Every failure is swallowed (the store listing is
 * best-effort); `filter` optionally restricts the basenames returned.
 */
function listSessionFiles(
  root: string,
  maxFiles: number,
  filter?: (name: string) => boolean,
): SessionStoreFile[] {
  const files: SessionStoreFile[] = [];
  const visited = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (files.length >= maxFiles) return;
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (files.length >= maxFiles) return;
      const full = path.join(dir, dirent.name);
      let isFile = dirent.isFile();
      let isDir = dirent.isDirectory();

      if (dirent.isSymbolicLink()) {
        try {
          const stat = fs.statSync(full);
          isFile = stat.isFile();
          isDir = stat.isDirectory();
        } catch {
          continue;
        }
      }

      if (isFile) {
        if (filter && !filter(dirent.name)) continue;
        let sizeBytes = 0;
        try {
          sizeBytes = fs.statSync(full).size;
        } catch {
          continue;
        }
        files.push({ path: full, sizeBytes });
      } else if (isDir && depth < MAX_SESSION_WALK_DEPTH) {
        walk(full, depth + 1);
      }
    }
  };

  walk(root, 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** Whether `target` exists and is a directory (never throws). */
function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Build an absent entry for a harness, carrying the candidate path/reason. */
function absentEntry(
  harness: HarnessKind,
  storeDir: string | null,
  candidatePaths: string[],
  reason: string,
): SessionStoreEntry {
  return {
    harness,
    status: "absent",
    storeDir,
    candidatePaths,
    files: [],
    absenceReason: reason,
  };
}

function collectPi(
  workdir: string,
  homes: NodeJS.ProcessEnv | undefined,
  maxFiles: number,
): SessionStoreEntry {
  let storeDir: string;
  try {
    storeDir = piSessionProjectDir(resolvePiHome(homes), workdir);
  } catch (error) {
    return absentEntry("pi", null, [], `pi session key: ${errorMessage(error)}`);
  }
  if (!isDirectory(storeDir)) {
    return absentEntry(
      "pi",
      storeDir,
      [storeDir],
      `pi session store not found: ${storeDir}`,
    );
  }
  const files = listSessionFiles(storeDir, maxFiles, (name) =>
    name.endsWith(".jsonl"),
  );
  return {
    harness: "pi",
    status: files.length > 0 ? "present" : "empty",
    storeDir,
    candidatePaths: [storeDir],
    files,
  };
}

function collectDsh(
  workdir: string,
  homes: NodeJS.ProcessEnv | undefined,
  maxFiles: number,
): SessionStoreEntry {
  let storeDir: string;
  try {
    storeDir = dshSessionProjectDir(resolveDshHome(homes), workdir);
  } catch (error) {
    return absentEntry("dsh", null, [], `dsh session key: ${errorMessage(error)}`);
  }
  if (!isDirectory(storeDir)) {
    return absentEntry(
      "dsh",
      storeDir,
      [storeDir],
      `dsh session store not found: ${storeDir}`,
    );
  }
  // dsh keeps one subdirectory per session holding the v3 log; list the
  // regular files found beneath the project directory.
  const files = listSessionFiles(storeDir, maxFiles);
  return {
    harness: "dsh",
    status: files.length > 0 ? "present" : "empty",
    storeDir,
    candidatePaths: [storeDir],
    files,
  };
}

function collectHermes(
  homes: NodeJS.ProcessEnv | undefined,
): SessionStoreEntry {
  let dbPath: string;
  try {
    dbPath = path.join(resolveHermesHome(homes), "state.db");
  } catch (error) {
    return absentEntry("hermes", null, [], `hermes home: ${errorMessage(error)}`);
  }
  const storeDir = path.dirname(dbPath);

  let sizeBytes: number | null = null;
  try {
    const stat = fs.statSync(dbPath);
    if (stat.isFile()) sizeBytes = stat.size;
  } catch {
    sizeBytes = null;
  }

  if (sizeBytes === null) {
    return absentEntry(
      "hermes",
      storeDir,
      [dbPath],
      `hermes session store not found: ${dbPath}`,
    );
  }

  // The hermes store is a single SQLite file; it is never opened here.
  return {
    harness: "hermes",
    status: "present",
    storeDir,
    candidatePaths: [dbPath],
    files: [{ path: dbPath, sizeBytes }],
  };
}

/**
 * Collect the resolved session-store paths for a workdir across every harness.
 *
 * Read-only (stat/list only, no session content is read) and total: a missing
 * store, an unresolvable home, or an empty workdir is reported as an
 * `'absent'` entry with its candidate path, never thrown. The top-level
 * `status` is `'present'` when any store resolved, `'empty'` when a store root
 * exists but holds no session files, and `'absent'` when none resolved.
 *
 * @param options - target workdir, optional home env and file cap.
 * @returns per-harness store entries; `entries` is always all three harnesses.
 */
export function collectSessionPaths(
  options: CollectSessionPathsOptions,
): SessionPathsCollection {
  const workdir = typeof options.workdir === "string" ? options.workdir : "";
  const maxFiles = normalizeMaxFiles(options.maxFiles);

  const entries: SessionStoreEntry[] = [
    collectPi(workdir, options.homes, maxFiles),
    collectDsh(workdir, options.homes, maxFiles),
    collectHermes(options.homes),
  ];

  const status: SourceStatus = entries.some((entry) => entry.status === "present")
    ? "present"
    : entries.some((entry) => entry.status === "empty")
      ? "empty"
      : "absent";

  return { status, workdir, entries };
}