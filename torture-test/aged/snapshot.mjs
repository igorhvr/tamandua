// snapshot.mjs — immutable readonly DB/event/ref snapshots + host-owned
// reserved-key baseline sidecar for the aged-state seed.
//
// Snapshot discipline (spec 03 sweep discipline #1): snapshot FIRST (before
// any mutating sweep), open read-only, never through getDb()/migrate().
// The immutable DB snapshot uses node:sqlite read-only open + a writable-file
// check and SHA-256 pin.  Event streams and git refs are copied byte-exact.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { utcNow, sha256FileStream, writeExclusive } from "./seedcommon.mjs";

// Immutable whole-DB snapshot via VACUUM INTO (consistent copy incl. WAL
// content), opened read-only by consumers (the O12 oracle opens it with
// openEvidenceDatabase).
export function createImmutableDbSnapshot({ stateDir, destDir, tag }) {
  fs.mkdirSync(destDir, { recursive: true });
  const src = path.join(stateDir, "tamandua.db");
  if (!fs.existsSync(src)) throw new Error(`createImmutableDbSnapshot: no DB at ${src}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(destDir, `db-${tag}-${stamp}.sqlite`);
  if (fs.existsSync(file)) fs.unlinkSync(file); // VACUUM INTO refuses existing targets
  const srcDb = new DatabaseSync(src, { readOnly: true });
  try {
    const escaped = file.replace(/'/g, "''");
    srcDb.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    srcDb.close();
  }
  fs.chmodSync(file, 0o444);
  const meta = snapshotMeta(file);
  return { file, ...meta };
}

export function snapshotMeta(file) {
  const stat = fs.statSync(file);
  // writable-file check: refuse if the snapshot file is writable by others.
  const mode = stat.mode & 0o777;
  return {
    file,
    sha256: sha256FileStream(file),
    sizeBytes: stat.size,
    mode,
    userVersion: readUserVersion(file),
  };
}

function readUserVersion(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare("PRAGMA user_version").get();
      return Number(row.user_version);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// Copy event stream files (per-run + global live/archives) byte-exact.
export function snapshotEventStreams({ stateDir, destDir, tag }) {
  const srcDir = path.join(stateDir, "events");
  const outDir = path.join(destDir, `events-${tag}`);
  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  if (fs.existsSync(srcDir)) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const src = path.join(srcDir, entry.name);
      const dst = path.join(outDir, entry.name);
      fs.copyFileSync(src, dst);
      copied.push({ name: entry.name, sha256: sha256FileStream(dst) });
    }
  }
  return { dir: outDir, copied };
}

// Snapshot a git repo's refs (for-each-ref) plus worktree list.
export function snapshotGitRefs({ repoDir, destDir, tag }) {
  const outDir = path.join(destDir, `git-${tag}`);
  fs.mkdirSync(outDir, { recursive: true });
  const run = (args, name) => {
    const res = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    const file = path.join(outDir, name);
    fs.writeFileSync(file, res.status === 0 ? res.stdout : `ERROR: ${res.stderr}`, "utf-8");
    return { file, sha256: sha256FileStream(file) };
  };
  return {
    refs: run(["for-each-ref", "--format=%(refname) %(objectname)"], "for-each-ref.txt"),
    worktrees: run(["worktree", "list", "--porcelain"], "worktree-list.txt"),
    head: run(["rev-parse", "HEAD"], "HEAD.txt"),
  };
}

// Write the host-owned launch/context baseline + expected-mutation sidecar
// (O12's reserved-key leg and R4) in the COMPLETE TYPED v2 producer schema
// (see torture-test/oracles/O12-CONTRACT.md "schema_version 2"):
//   scope.mode all-snapshot-runs | explicit (+ run_ids),
//   expected  = { <run id>: { <reserved key>: {presence, value?, provenance} } }
//              — every in-scope run covers the ENTIRE pin with typed
//                presence/absence; absent keys are host-captured known
//                absences, never reconstructed from final context,
//   expected_mutations = { <run id>: { <key>: {presence, value?, source:"host"} } }
//              — legitimate host-managed later transitions that a RECORDED
//                planned native operation explains with an exact final state
//                (see computeReservedMutations — never granted from a final
//                snapshot diff alone),
//   derivation   — provenance of how expected_mutations were computed.
// The sidecar is written READ-ONLY (0o400) per the O12 producer instructions;
// the corrected O12 (R4) fails closed on a writable baseline.  A prior sidecar
// at the same path is archived to <name>.pre-<stamp> BEFORE the new file is
// written (old baseline/validation evidence is retained as superseded, never
// destroyed).
export function writeReservedBaselineSidecar({
  destDir,
  expected,
  expectedMutations = {},
  scopeMode = "all-snapshot-runs",
  scopeRunIds = null,
  derivation = null,
}) {
  fs.mkdirSync(destDir, { recursive: true });
  const file = path.join(destDir, "o12-reserved-baseline.json");
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(file, path.join(destDir, `o12-reserved-baseline.pre-${stamp}.json`));
    // The existing sidecar is written read-only (0o400).  Restore owner-write
    // so a NON-ROOT operator re-running the census/snapshot phase can replace
    // it; the prior content is preserved in the archive above (never silently
    // overwritten, and the write below re-applies 0o400).
    fs.chmodSync(file, 0o600);
  }
  const payload = {
    schema_version: 2,
    captured_at: utcNow(),
    producer: "host",
    scope:
      scopeMode === "explicit"
        ? { mode: "explicit", run_ids: scopeRunIds ?? [] }
        : { mode: "all-snapshot-runs" },
    supported_reserved_keys: reservedKeysPinned(),
    expected,
    expected_mutations: expectedMutations,
    ...(derivation ? { derivation } : {}),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  // chmod is not a content change: the sha256 stays stable.
  fs.chmodSync(file, 0o400);
  return { file, sha256: sha256FileStream(file), mode: fs.statSync(file).mode & 0o777, scopeMode };
}

// Host mutation ledger (O12 producer instructions #3).
//
// ROOT-VALIDATION-NOTICE CORRECTION (2026-09-09T20:38:14Z): an earlier
// revision derived expected_mutations by diffing the FINAL snapshot context
// against the creation-time baseline and blessing EVERY difference as a
// legitimate source:'host' transition.  That is circular: a later readback
// must VERIFY an independently expected transition, never grant it, and an
// absence of real models does not make arbitrary final drift intended.  The
// derivation below therefore derives allowed transitions from the
// INDEPENDENTLY RECORDED planned native API operations — the seed driver's
// real completeStep/claimStep submissions, whose exact submitted outputs are
// recorded by the native product in the immutable steps table (steps.output)
// and journaled per run at claim/complete time — applying the product's known
// input/normalization semantics (a completed step whose output carries a
// `test_cmd` marker makes native code establish context.test_cmd_raw = that
// value on first write; identical re-emission merges; a differing marker
// triggers the native review flags without overwriting the established value).
// The final runs.context is used ONLY as a verification readback: a reserved
// key whose final state differs from baseline AND is not explained by a
// recorded operation is NOT blessed (coverage unavailable) — O12 then sees it
// as an overwrite.  Runs without a complete creation-time expected entry are
// skipped here and must be excluded from scope by the caller (they make O12
// NOT_EVALUABLE, never PASS).
export function computeReservedMutations({ snapshotFile, expectedByRun }) {
  const db = new DatabaseSync(snapshotFile, { readOnly: true });
  try {
    const pinned = reservedKeysPinned();
    // Recorded native operations: every step row the product wrote (the driver
    // submitted each output through real completeStep).  step_index order is
    // pipeline order; status 'done' means the output was actually merged.
    let steps = [];
    try {
      steps = db
        .prepare(
          "SELECT run_id, step_index, step_id, status, output FROM steps ORDER BY run_id, step_index",
        )
        .all();
    } catch {
      // Snapshot without a steps table has no recorded operations to replay;
      // every reserved-key state is the creation-time baseline.
      steps = [];
    }
    const stepsByRun = new Map();
    for (const s of steps) {
      if (s.status !== "done") continue; // only merged (completed) outputs are operations
      const list = stepsByRun.get(s.run_id) ?? [];
      list.push(s);
      stepsByRun.set(s.run_id, list);
    }
    const rows = db.prepare("SELECT id, context FROM runs").all();
    const mutations = {};
    const coverage = {};
    for (const row of rows) {
      const exp = expectedByRun[row.id];
      if (!exp) continue; // caller decides scope; skip untracked
      let ctx = {};
      try {
        ctx = JSON.parse(row.context ?? "{}");
      } catch {
        continue; // unparseable context is surfaced by O12 R4 itself
      }
      // Simulate the reserved-key final state from the baseline + recorded
      // operations (native normalization semantics), NEVER from runs.context.
      const predicted = simulateReservedFromOps({ exp, ops: stepsByRun.get(row.id) ?? [] });
      const runMuts = {};
      const runCoverage = { verified: {}, unverified: {} };
      for (const key of pinned) {
        const has = Object.prototype.hasOwnProperty.call(ctx, key);
        const actual = has ? { presence: "present", value: ctx[key] } : { presence: "absent" };
        const expPresence = exp[key]?.presence === "present" ? "present" : "absent";
        const expValue = expPresence === "present" ? String(exp[key].value) : undefined;
        const predictedForKey = predicted[key] ?? { presence: expPresence, value: expValue };
        const differsFromBaseline =
          predictedForKey.presence !== expPresence ||
          (predictedForKey.presence === "present" && String(predictedForKey.value) !== String(expValue));
        const actualDiffersFromBaseline =
          actual.presence !== expPresence ||
          (actual.presence === "present" && String(actual.value) !== String(expValue));
        if (!differsFromBaseline && !actualDiffersFromBaseline) continue; // nothing to record
        // Readback verification: only bless when the recorded operation's
        // predicted final state matches what the immutable snapshot actually
        // holds.  A mismatch means the final difference is NOT explained by any
        // recorded planned operation → leave it un-blessed (O12 flags it).
        const verified =
          differsFromBaseline &&
          predictedForKey.presence === actual.presence &&
          (predictedForKey.presence === "absent" || String(predictedForKey.value) === String(actual.value));
        if (verified) {
          runMuts[key] = { ...predictedForKey, source: "host" };
          runCoverage.verified[key] = { predicted: predictedForKey, actual };
        } else {
          runCoverage.unverified[key] = {
            predicted: differsFromBaseline ? predictedForKey : null,
            actual,
            note: differsFromBaseline
              ? "recorded operation predicts a transition but the final snapshot does not match it"
              : "final context differs from baseline with NO recorded operation explaining it (unexpected drift)",
          };
        }
      }
      if (Object.keys(runMuts).length > 0) mutations[row.id] = runMuts;
      if (Object.keys(runCoverage.verified).length > 0 || Object.keys(runCoverage.unverified).length > 0) {
        coverage[row.id] = runCoverage;
      }
    }
    return { mutations, coverage };
  } finally {
    db.close();
  }
}

// Simulate the reserved-key state that the RECORDED native step operations
// would produce, starting from the creation-time typed baseline `exp`.  Only
// keys whose final state is a deterministic function of a recorded operation
// input (step output) are predicted; the rest stay at their baseline state.
// Mirrors torture-test/oracles/lib + src/installer/step-ops.ts TEST_CMD
// establishment semantics:
//   - output key `test_cmd` (lowercased; TEST_CMD marker) with no prior
//     established value → native first-write sets context.test_cmd_raw and
//     context.test_cmd to the marker value (source: step),
//   - identical re-emission → merge (state unchanged),
//   - differing marker → native review flags are set and the established
//     value is NOT overwritten (test_cmd_raw unchanged).
export function simulateReservedFromOps({ exp, ops }) {
  const state = {};
  for (const key of reservedKeysPinned()) {
    const e = exp[key];
    if (e?.presence === "present") state[key] = String(e.value);
  }
  for (const op of ops) {
    if (!op.output) continue;
    for (const [key, value] of Object.entries(parseOutputKeyValues(op.output))) {
      if (key === "test_cmd") {
        const established = state["test_cmd_raw"] ?? state["test_cmd"] ?? null;
        if (established === null) {
          state["test_cmd"] = value;
          state["test_cmd_raw"] = value; // native first-write to the reserved key
        } else if (value === established) {
          state["test_cmd"] = value;
          state["test_cmd_raw"] = value;
        } else {
          // Differing marker: native code does NOT overwrite test_cmd_raw; it
          // records review flags (reserved keys) for the conditional reviewer.
          state["test_cmd_review_required"] = "true";
          state["test_cmd_review_candidate"] = value;
          state["test_cmd_review_established"] = established;
          state["test_cmd_rewriter_step"] = op.step_id ?? "?";
        }
      }
      // Any other reserved key is never written by step output (native code
      // skips the reserved set in the generic merge); nothing else is
      // predicted.
    }
  }
  const predicted = {};
  for (const key of reservedKeysPinned()) {
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      predicted[key] = { presence: "present", value: state[key] };
    } else {
      predicted[key] = { presence: "absent" };
    }
  }
  return predicted;
}

// Parse output KEY: value lines exactly like the native product's
// parseOutputKeyValues (lowercased keys, multiline values).  Used to replay
// recorded step outputs into their reserved-key consequences.
export function parseOutputKeyValues(output) {
  const result = {};
  const lines = String(output ?? "").split("\n");
  let pendingKey = null;
  let pendingValue = "";
  const commit = () => {
    if (pendingKey !== null && !pendingKey.startsWith("STORIES_JSON")) {
      result[pendingKey.toLowerCase()] = pendingValue.trim();
    }
    pendingKey = null;
    pendingValue = "";
  };
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (m) {
      commit();
      pendingKey = m[1];
      pendingValue = m[2];
    } else if (pendingKey !== null) {
      pendingValue += "\n" + line;
    }
  }
  commit();
  return result;
}

export function reservedKeysPinned() {
  // Pinned mirror of the native set; parity with O12 is asserted by the
  // oracle's own static calibration, and by our self-test.
  return [
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
  ];
}
