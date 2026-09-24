/**
 * Matchlock-backed round diagnostics collector (DIAG-PRUNE US-008).
 *
 * Produces the Matchlock section of a diagnostics bundle for a run that may
 * have been dispatched through the Matchlock execution backend:
 *
 *  - the run's persisted `runs.matchlock_policy` JSON, parsed and passed
 *    through {@link redactSecrets} (mount-plan/policy facts only; no raw
 *    credential value survives);
 *  - the per-VM evidence directories under
 *    `<state>/runs/<bareRunId>/matchlock/<vmId>/` with every retained file
 *    (config, console/serial logs) and its size;
 *  - the runner error records (`orphans.json` and any other `*.json` record
 *    written directly in the run's `matchlock/` directory), parsed, redacted
 *    and bounded.
 *
 * Contract:
 *
 *  1. READ-ONLY. Nothing is created, mutated or deleted and no daemon is
 *     contacted.
 *  2. A NULL/empty/malformed policy, a missing `matchlock/` directory, a
 *     malformed record and an unreadable file are all REPORTS, never thrown
 *     exceptions. A native run (NULL policy, no Matchlock dir) is
 *     `status: 'absent'`.
 *  3. Secrets never leak: every parsed object is redacted before it is
 *     returned, and only paths/sizes/metadata are copied for the rest.
 *  4. Bounded: the record file size, record count and evidence file count are
 *     capped; a cap hit is reported, never silently dropped.
 *
 * The module is Node-core only plus the project's Node-core-only
 * `paths.ts`/`redact.ts`/`vm-orphans.ts` leaves, so its test stays in the
 * parallel lane (no `node:child_process`).
 */
import fs from "node:fs";
import path from "node:path";

import {
  VM_ORPHAN_MATCHLOCK_DIR_NAME,
  VM_ORPHAN_STORE_FILE_NAME,
} from "../installer/matchlock/vm-orphans.js";
import { isPathInside, resolveRunEvidenceDir } from "./paths.js";
import { redactSecrets } from "./redact.js";
import type {
  EvidenceFileEntry,
  MatchlockCollection,
  MatchlockErrorRecord,
  MatchlockVmEvidence,
  SourceStatus,
} from "./types.js";

/** Maximum accepted size of the persisted policy JSON (bounded). */
export const MAX_MATCHLOCK_POLICY_BYTES = 4 * 1024 * 1024;
/** Maximum accepted size of one runner error-record JSON file (bounded). */
export const MAX_MATCHLOCK_RECORD_BYTES = 4 * 1024 * 1024;
/** Maximum number of runner error records retained (bounded). */
export const MAX_MATCHLOCK_ERROR_RECORDS = 64;
/** Maximum number of VM evidence files listed (bounded). */
export const MAX_MATCHLOCK_EVIDENCE_FILES = 2000;
/** Maximum directory depth walked inside one VM evidence directory. */
export const MAX_MATCHLOCK_WALK_DEPTH = 6;

export interface CollectMatchlockOptions {
  /** Effective tamandua state dir (contains the `runs/` evidence root). */
  stateDir: string;
  /** Run id as stored/displayed; a `run-` prefix is tolerated and stripped. */
  runId?: string;
  /** Bare run id, when the caller already has it. */
  bareRunId?: string;
  /** Raw `runs.matchlock_policy` value (NULL for a native run). */
  policyJson?: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Realpath, or null when the path cannot be resolved (never throws). */
function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** True only for a real directory (never throws). */
function isRealDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

interface PolicyResult {
  status: SourceStatus;
  policy: unknown;
  reason?: string;
}

/**
 * Parse the persisted policy and redact it. NULL/empty/malformed/oversized
 * policies are `status: 'absent'` with a reason — never a thrown exception.
 */
function parsePolicy(policyJson: string | null | undefined): PolicyResult {
  if (policyJson === null || policyJson === undefined || policyJson.trim() === "") {
    return {
      status: "absent",
      policy: null,
      reason: "no matchlock policy (native run)",
    };
  }
  if (Buffer.byteLength(policyJson, "utf8") > MAX_MATCHLOCK_POLICY_BYTES) {
    return {
      status: "absent",
      policy: null,
      reason: `matchlock policy exceeds ${MAX_MATCHLOCK_POLICY_BYTES} bytes`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(policyJson);
  } catch (error) {
    return {
      status: "absent",
      policy: null,
      reason: `malformed matchlock policy: ${errorMessage(error)}`,
    };
  }
  if (parsed === null) {
    return {
      status: "absent",
      policy: null,
      reason: "matchlock policy is null",
    };
  }
  return { status: "present", policy: redactSecrets(parsed) };
}

/**
 * Recursively list regular files under `root` with paths relative to `root`.
 * Symlinks are traversed only when their resolved target stays inside `root`
 * (realpath comparison); a visited-realpath set prevents cycles. Every failure
 * is swallowed (the listing is best-effort) and `maxFiles` bounds the result.
 */
function listEvidenceFiles(root: string, maxFiles: number): EvidenceFileEntry[] {
  const files: EvidenceFileEntry[] = [];
  const visited = new Set<string>();
  const rootReal = realpathOrNull(root);

  const walk = (dir: string, relative: string, depth: number): void => {
    if (files.length >= maxFiles) return;
    const realDir = realpathOrNull(dir);
    if (realDir === null) return;
    if (rootReal !== null && realDir !== rootReal && !isPathInside(rootReal, realDir)) {
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
      const childRelative = relative ? path.join(relative, dirent.name) : dirent.name;
      let isFile = dirent.isFile();
      let isDir = dirent.isDirectory();

      if (dirent.isSymbolicLink()) {
        const real = realpathOrNull(full);
        if (real === null) continue;
        if (rootReal !== null && real !== rootReal && !isPathInside(rootReal, real)) {
          continue;
        }
        try {
          const stat = fs.statSync(full);
          isFile = stat.isFile();
          isDir = stat.isDirectory();
        } catch {
          continue;
        }
      }

      if (isFile) {
        let sizeBytes = 0;
        try {
          sizeBytes = fs.statSync(full).size;
        } catch {
          continue;
        }
        files.push({ path: childRelative, sizeBytes });
      } else if (isDir && depth < MAX_MATCHLOCK_WALK_DEPTH) {
        walk(full, childRelative, depth + 1);
      }
      // Other node kinds (fifo/socket/device) are not evidence files.
    }
  };

  walk(root, "", 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** Enumerate the real per-VM evidence directories under `matchlockDir`. */
function listVmDirs(matchlockDir: string): { vmId: string; dir: string }[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(matchlockDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const matchlockReal = realpathOrNull(matchlockDir);
  const dirs: { vmId: string; dir: string }[] = [];
  for (const dirent of dirents) {
    const full = path.join(matchlockDir, dirent.name);
    let isDir = dirent.isDirectory();
    if (dirent.isSymbolicLink()) {
      const real = realpathOrNull(full);
      if (real === null) continue;
      if (
        matchlockReal !== null &&
        real !== matchlockReal &&
        !isPathInside(matchlockReal, real)
      ) {
        continue;
      }
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir) continue;
    dirs.push({ vmId: dirent.name, dir: full });
  }
  dirs.sort((a, b) => (a.vmId < b.vmId ? -1 : a.vmId > b.vmId ? 1 : 0));
  return dirs;
}

/**
 * Read, parse and redact ONE runner error record. A missing/non-regular/
 * oversized/unreadable/malformed file is reported as `status: 'absent'` with
 * an `error`, never thrown.
 */
function readErrorRecord(file: string): MatchlockErrorRecord {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    return { path: file, status: "absent", error: errorMessage(error) };
  }
  if (!stat.isFile()) {
    return { path: file, status: "absent", error: "not a regular file" };
  }
  if (stat.size > MAX_MATCHLOCK_RECORD_BYTES) {
    return {
      path: file,
      status: "absent",
      error: `record exceeds ${MAX_MATCHLOCK_RECORD_BYTES} bytes`,
    };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { path: file, status: "absent", error: errorMessage(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      path: file,
      status: "absent",
      error: `malformed JSON: ${errorMessage(error)}`,
    };
  }
  return { path: file, status: "present", record: redactSecrets(parsed) };
}

/**
 * Collect the Matchlock section for one run.
 *
 * The top-level `status` is `'present'` when the run carries a valid policy or
 * any Matchlock evidence (VM dirs, runner records) exists, else `'absent'`.
 * `policyStatus` independently reports the policy record so a native run is
 * explicit. Never throws.
 */
export function collectMatchlock(
  options: CollectMatchlockOptions,
): MatchlockCollection {
  const stateDir = options.stateDir ?? "";
  const rawId = (options.bareRunId ?? options.runId ?? "").trim();
  const bare = rawId.startsWith("run-") ? rawId.slice(4) : rawId;

  const policy = parsePolicy(options.policyJson);

  let evidenceRoot: string;
  try {
    evidenceRoot = resolveRunEvidenceDir(stateDir, bare);
  } catch {
    // An empty/odd run id must not make the collector throw.
    evidenceRoot = path.join(stateDir, "runs", bare);
  }
  const matchlockDir = path.join(evidenceRoot, VM_ORPHAN_MATCHLOCK_DIR_NAME);

  const reasons: string[] = [];
  if (policy.reason) reasons.push(policy.reason);

  let vms: MatchlockVmEvidence[] = [];
  const consoleLogs: EvidenceFileEntry[] = [];
  if (isRealDirectory(matchlockDir)) {
    for (const { vmId, dir } of listVmDirs(matchlockDir)) {
      const logs = listEvidenceFiles(dir, MAX_MATCHLOCK_EVIDENCE_FILES);
      const totalBytes = logs.reduce((sum, entry) => sum + entry.sizeBytes, 0);
      vms.push({
        vmId,
        dir,
        status: logs.length > 0 ? "present" : "empty",
        logs,
        totalBytes,
      });
      for (const entry of logs) {
        consoleLogs.push({
          path: path.join(vmId, entry.path),
          sizeBytes: entry.sizeBytes,
        });
      }
    }
  } else {
    reasons.push(`matchlock evidence directory not found: ${matchlockDir}`);
  }

  const errorRecords: MatchlockErrorRecord[] = [];
  let errorRecordFiles: string[] = [];
  try {
    errorRecordFiles = fs
      .readdirSync(matchlockDir, { withFileTypes: true })
      // Every `*.json` entry is considered, including a directory/symlink of
      // that name: a non-regular record is REPORTED (not silently skipped).
      .filter((dirent) => dirent.name.toLowerCase().endsWith(".json"))
      .map((dirent) => path.join(matchlockDir, dirent.name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    errorRecordFiles = [];
  }
  // `orphans.json` must always be represented first when present, then the
  // remaining records, so the store is easy to find in the bundle.
  errorRecordFiles.sort((a, b) => {
    const aOrphan = path.basename(a) === VM_ORPHAN_STORE_FILE_NAME ? 0 : 1;
    const bOrphan = path.basename(b) === VM_ORPHAN_STORE_FILE_NAME ? 0 : 1;
    if (aOrphan !== bOrphan) return aOrphan - bOrphan;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  let recordsTruncated = false;
  for (const file of errorRecordFiles) {
    if (errorRecords.length >= MAX_MATCHLOCK_ERROR_RECORDS) {
      recordsTruncated = true;
      break;
    }
    errorRecords.push(readErrorRecord(file));
  }
  if (recordsTruncated) {
    reasons.push(
      `runner error records capped at ${MAX_MATCHLOCK_ERROR_RECORDS}`,
    );
  }

  const hasEvidence =
    policy.status === "present" ||
    vms.length > 0 ||
    errorRecords.some((record) => record.status === "present");
  const status: SourceStatus = hasEvidence ? "present" : "absent";

  return {
    status,
    ...(reasons.length > 0 ? { absenceReason: reasons.join("; ") } : {}),
    policy: policy.policy,
    policyStatus: policy.status,
    vms,
    consoleLogs,
    errorRecords,
  };
}