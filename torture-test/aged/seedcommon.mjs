// seedcommon.mjs — shared constants/hashing/journal helpers for the
// tt-storm-aged zero-token aged-state generator (torture-only, owned by the
// STORM-AGED run; NOT part of the native product).
//
// Every runtime artifact this generator produces lives under an owned seed
// root.  This module provides the low-level helpers (hashing, atomic
// exclusive-create writes, durable JSONL journal + phase receipts) with no
// side effects of their own.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const AGED_SCHEMA_VERSION = 1;

// Explicitly synthetic, NON-lifecycle, run-bound event name used for
// VOLUME-ONLY event records (see the storm-aged contract).  Never a step
// claim/completion, usage, merge, or success event.
export const VOLUME_EVENT_NAME = "aged.volume.seed";

// The reserved context key set is pinned from the native product mirror in
// the O12 oracle (torture-test/oracles/lib/o12.mjs O12_RESERVED_CONTEXT_KEYS)
// and the native set in src/installer/step-ops.ts RESERVED_CONTEXT_KEYS.
// The seed generator never emits agent output that would attempt to write a
// reserved key, and the host-owned reserved-key baseline sidecar records each
// seeded run's reserved values at creation time.
export const RESERVED_CONTEXT_KEYS = Object.freeze([
  "repo",
  "working_directory_for_harness",
  "task",
  "run_id",
  "workspace_mode",
  "worktree_path",
  "worktree_origin_repository",
  "worktree_origin_ref",
  "worktree_origin_sha",
  "original_branch",
  "merge_gate",
  "fail_missing",
  "test_cmd_raw",
  "test_cmd_review_required",
  "test_cmd_review_candidate",
  "test_cmd_review_established",
  "test_cmd_rewriter_step",
]);

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return sha256Hex(data);
}

export function sha256FileStream(filePath) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

export function utcNow() {
  return new Date().toISOString();
}

// Durable single-line JSON append.  Callers journal intentions BEFORE an
// effect and outcomes AFTER it (receipt discipline).
export function appendJsonl(filePath, record) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

// Exclusive-create write: never overwrite an existing receipt/sidecar.
// Returns { created: true } or { created: false, exists: true }.
export function writeExclusive(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const fd = fs.openSync(filePath, "wx");
    try {
      fs.writeFileSync(fd, content, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
    return { created: true };
  } catch (err) {
    if (err.code === "EEXIST") return { created: false, exists: true };
    throw err;
  }
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const out = [];
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Journal corruption is itself a finding; surface as a marker row.
      out.push({ _unparseable: line.slice(0, 200) });
    }
  }
  return out;
}

// Resolve + verify an owned root: realpath, dev/ino captured at allocation;
// rejects replaced/escaped/symlinked roots.
export function captureOwnership(rootPath) {
  const real = fs.realpathSync(rootPath);
  const st = fs.statSync(real);
  return {
    root: real,
    dev: st.dev,
    ino: st.ino,
  };
}

export function assertOwnedRoot(expected, actualPath, label) {
  const a = fs.realpathSync(actualPath);
  const st = fs.statSync(a);
  if (a !== expected.root) {
    throw new Error(`${label}: root path mismatch (expected ${expected.root}, got ${a})`);
  }
  if (st.dev !== expected.dev || st.ino !== expected.ino) {
    throw new Error(`${label}: root dev/ino changed (expected ${expected.dev}/${expected.ino}, got ${st.dev}/${st.ino})`);
  }
  return a;
}

// Ensure a child path stays inside an owned root and is not a symlink escape.
export function requireContained(ownedRootReal, candidatePath, label) {
  const resolved = path.resolve(candidatePath);
  const rel = path.relative(ownedRootReal, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label}: path escapes owned root: ${candidatePath}`);
  }
  return resolved;
}

export function gitExec(repoDir, args, opts = {}) {
  const res = spawnSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if (res.status !== 0) {
    const err = new Error(
      `git ${args.join(" ")} failed in ${repoDir}: ${(res.stderr || "").trim()}`,
    );
    err.status = res.status;
    err.stderr = res.stderr || "";
    err.stdout = res.stdout || "";
    throw err;
  }
  return res.stdout.trim();
}

export function gitTry(repoDir, args) {
  const res = spawnSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return res.status === 0 ? res.stdout.trim() : null;
}
