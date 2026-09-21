/******************************************************************************
 * ⚠️  WARNING: SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-PI-EXEC US-003 — the actual fresh-VM synthetic WHOLE-PATH gate (gate B).
 *
 * This gate drives the REAL daemon → scheduler → Matchlock invocation runner →
 * FRESH Matchlock VM path end-to-end for BOTH supported --matchlock workflows
 * (do-now and do-review-do-verify), each reaching real run completion, with a
 * deterministic TEST-ONLY "synthetic pi" supplied by an explicitly test-only
 * derived fixture image (e2e-tests/matchlock-fixture/). NO provider
 * credentials and NO model calls anywhere in the gate.
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand only:
 *
 *   ./run-matchlock-synthetic-e2e-test
 *
 * which builds first, resolves the paired runtime binaries (unpinned)
 * (TAMANDUA_MATCHLOCK_RPC_BIN = the matchlock CLI resolved from PATH;
 * MATCHLOCK_GUEST_INIT / MATCHLOCK_GUEST_FUSED = optional guest-init
 * overrides), creates a NEW evidence
 * directory /root/matchlock-work/evidence/pi-exec-<UTC-Z timestamp>/ (outside
 * the repo; never pre-cleaned) and runs this file with the private isolated
 * HOME/STATE/DB rooted INSIDE that evidence directory.
 *
 * Per-run assertions (gate B acceptance):
 *   - the run reaches real status "completed";
 *   - the guest progress document persists at
 *     <state>/runs/<runId>/progress-resource/progress.txt;
 *   - typed step claims/completes flowed through the host broker into the real
 *     step DB;
 *   - the packed tamandua-test recorded an integer exit in [0,255] in the
 *     host-owned Matchlock suite SQLite store under the canonical namespace;
 *   - every probe/work invocation used a FRESH VM (distinct ids; no reuse);
 *   - zero host pi/harness spawn and no native fallback;
 *   - positive exact-owned VM teardown with a recorded cleanup ledger.
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB under the evidence dir, schema10
 * only there, TAMANDUA_TEST_GUARD auto-active under node:test, random control
 * port, never the live worker daemon.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanChildEnv, reservePortHandles } from "../tests/helpers/test-env.ts";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  inheritedProcessEnv,
  cliMustSucceed,
  spawnWorkflowRun,
  resolveFullRunId,
  releasePortReservations,
} from "./helpers/smoke-helpers.ts";
import { startIsolatedDaemon, stopIsolatedDaemon } from "./helpers/e2e-helpers.ts";
import { assertNoOwnedVms } from "./helpers/matchlock-gate-lifecycle.ts";
import {
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";
import type { ChildProcess } from "node:child_process";
import type { PortHandle } from "../tests/helpers/test-env.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

// ── environment: resolved (unpinned) paired runtime ────────────────────────────────────
// The runner script (run-matchlock-synthetic-e2e-test) resolves these (or leaves guest-init to
// matchlock) before launching this file; the test only requires any resolved
// paths to exist.
const MATCHLOCK_RPC_BIN =
  process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED = process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

// Deterministic TEST-ONLY fixture image tag (never igorhvr/bedlam-ubuntu).
const FIXTURE_IMAGE_TAG = "tamandua-synthetic-pi:gate-fixture";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "matchlock-fixture");
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-pi";

// Evidence root: the runner exports TAMANDUA_GATE_EVIDENCE_DIR (a NEW
// /root/matchlock-work/evidence/pi-exec-<UTC-Z timestamp>/ directory).
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";

// Observed-rounds evidence label (TESTER-HONESTY item 3): the runner passes the
// same label to scripts/observed-rounds-guard.mjs.
const GATE_LABEL = "synthetic";

const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 25 * 60_000;

// MTLK-UNPIN: the paired runtime is resolved (not pinned). The resolved CLI
// is always exported; the guest-init/fused vars are exported only when the
// driver resolved them, so an unset value lets matchlock resolve it itself.
function matchlockRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = { TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN };
  if (GUEST_INIT.length > 0) env.MATCHLOCK_GUEST_INIT = GUEST_INIT;
  if (GUEST_FUSED.length > 0) env.MATCHLOCK_GUEST_FUSED = GUEST_FUSED;
  return env;
}

function assertEnv(): void {
  assert.ok(EVIDENCE_DIR.length > 0, "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-synthetic-e2e-test)");
  assert.ok(MATCHLOCK_RPC_BIN.length > 0, "TAMANDUA_MATCHLOCK_RPC_BIN must be set (the gate driver resolves matchlock from PATH)");
  // Guest-init/fused are OPTIONAL (MTLK-UNPIN): when unset, matchlock resolves
  // them itself and the gate records whatever it observes.
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    if (p.length > 0) {
      assert.ok(fs.existsSync(p), `resolved runtime binary missing: ${p}`);
    }
  }
}

function gateEnv(homeDir: string, controlPort: number): Record<string, string> {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  return {
    ...inheritedProcessEnv(),
    HOME: homeDir,
    TAMANDUA_CONTROL_PORT: String(controlPort),
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: path.join(tamanduaDir, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDir, "worktrees"),
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_HARNESS_PROBE: "1",
    TAMANDUA_PI_BINARY: "/usr/bin/false",
    TAMANDUA_DSH_BINARY: "/usr/bin/false",
    ...matchlockRuntimeEnv(),
  };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Prepare a fresh small git repo (clean tracked tree) for one synthetic run. */
function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# Synthetic whole-path gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n.matchlock-synthetic-pi/\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Matchlock Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

/**
 * Positively dispose every VM this gate created. The runner's positive
 * controller close already removes the VM rows and state dirs at the end of
 * every invocation, so by cleanup time the exact-owned VM id list is normally
 * already empty — this function verifies that, and for any id STILL present
 * in the matchlock state DB or under $HOME/.matchlock/vms it performs an
 * EXACT-id `matchlock rm`. A failed/unknown close FAILS the gate and RETAINS
 * the state dir + DB rows for diagnostics — state is never erased to
 * manufacture clean evidence (ROOT review correction; the historical
 * fs.rmSync fallback is gone). Inventory is recorded strictly and every
 * outcome is written to the ledger even when a failure throws.
 */
function cleanupOwnedVms(
  homeDir: string,
  ledgerPath: string,
  observedIds: string[],
  opts: { rpcBin?: string } = {},
): string[] {
  const ledger: string[] = [];
  const rpcBin = opts.rpcBin ?? MATCHLOCK_RPC_BIN;
  const clean = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
  const vmsDir = path.join(homeDir, ".matchlock", "vms");

  const flushLedger = (): void => {
    try {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.writeFileSync(ledgerPath, ledger.join("\n") + "\n", "utf-8");
    } catch (err) {
      // Never let a ledger-write failure mask the underlying cleanup failure;
      // surface it as part of the ledger tail on stderr.
      process.stderr.write(`cleanupOwnedVms: ledger write failed: ${String(err)}\n`);
    }
  };

  try {
    // STRICT inventory: a corrupt/unreadable DB or invalid rows throw here
    // (never silently treated as empty). Missing state is DISTINCT from empty.
    const inventory = readVmInventory(homeDir);
    const rowIds = inventory.rows.map((r) => r.id);
    const dirIds = inventory.dirIds;
    const rowIdSet = new Set(rowIds);
    const dirIdSet = new Set(dirIds);
    // The authority for "owned" is the observed (runner-returned) ids plus DB
    // rows; directory entries only corroborate exact owned names.
    const target = [...new Set([...rowIds, ...dirIds, ...observedIds])].sort();
    ledger.push(
      `${new Date().toISOString()} VM ids observed during the gate (${observedIds.length}): ${observedIds.length > 0 ? observedIds.join(",") : "(none)"}`,
    );
    ledger.push(
      `${new Date().toISOString()} VM ids still present at cleanup (dbPresent=${inventory.dbPresent}, rows=${rowIds.length}, dirs=${dirIds.length}): ${target.length > 0 ? target.join(",") : "(none — runner positively closed every owned VM)"}`,
    );

    for (const id of target) {
      const stateDir = path.join(vmsDir, id);
      if (!rowIdSet.has(id) && !dirIdSet.has(id)) {
        ledger.push(
          `${new Date().toISOString()} vm ${id} already positively closed by the runner (no row and no state dir)`,
        );
        continue;
      }
      const rm = spawnSync(rpcBin, ["rm", id], {
        encoding: "utf-8",
        env: clean,
        timeout: 120_000,
      });
      ledger.push(
        `${new Date().toISOString()} vm ${id} rm rc=${rm.status}${rm.signal ? ` signal=${rm.signal}` : ""} out=${(rm.stdout || rm.stderr || "").trim()}`,
      );
      // After rm, RE-READ the exact owned row/dir. A still-present row or dir
      // after a failed/unknown close FAILS the gate and retains the state for
      // diagnostics (no fs.rmSync fallback — never erase after failed
      // disposal).
      const after = readVmInventory(homeDir);
      const rowStill = after.rows.some((r) => r.id === id);
      const dirStill = fs.existsSync(stateDir);
      if (rm.status !== 0 || rowStill || dirStill) {
        ledger.push(
          `${new Date().toISOString()} vm ${id} NOT cleanly closed (rm rc=${rm.status}, rowStill=${rowStill}, dirStill=${dirStill}); state RETAINED for diagnostics`,
        );
        flushLedger();
        throw new Error(
          `vm ${id} failed to close cleanly (rm rc=${rm.status}${rm.signal ? ` signal=${rm.signal}` : ""}, rowStill=${rowStill}, dirStill=${dirStill}); state retained at ${stateDir} — see ${ledgerPath}`,
        );
      }
      ledger.push(`${new Date().toISOString()} vm ${id} positively closed (no row and no state dir)`);
    }

    // Final strict check: no owned rows/dirs may remain (empty ≠ absent; a
    // missing DB after VMs were observed is itself a failure).
    const finalInventory = readVmInventory(homeDir);
    if (finalInventory.rows.length > 0 || finalInventory.dirIds.length > 0) {
      ledger.push(
        `${new Date().toISOString()} LEFTOVER owned VM rows/dirs after cleanup: rows=${finalInventory.rows.map((r) => r.id).join(",")}, dirs=${finalInventory.dirIds.join(",")}`,
      );
      flushLedger();
      throw new Error(
        `leftover owned VM rows/dirs after cleanup: rows=${finalInventory.rows.map((r) => r.id).join(",")}, dirs=${finalInventory.dirIds.join(",")}`,
      );
    }
    if (!finalInventory.dbPresent && observedIds.length > 0) {
      ledger.push(
        `${new Date().toISOString()} matchlock state DB is MISSING after a gate that created VMs — failing (absent ≠ clean)`,
      );
      flushLedger();
      throw new Error("matchlock state DB missing after a gate that created VMs");
    }
    ledger.push(`${new Date().toISOString()} cleanup complete: no owned VM rows/state dirs remain`);
    flushLedger();
    return ledger;
  } catch (err) {
    // Record + flush the partial ledger BEFORE rethrowing so a cleanup
    // failure always leaves diagnostics in the evidence dir.
    flushLedger();
    throw err;
  }
}

/**
 * Scoped gate lifecycle evidence recorder (ROOT review): captures a child's
 * stdout/stderr tail and its real close code/signal so cleanup failure
 * evidence is retained even when a teardown throws.
 */
export function recordChildExitEvidence(
  child: ChildProcess,
  tag: string,
): { code: number | null; signal: string | null; stdoutTail: string; stderrTail: string } {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (c: Buffer) => {
    stdoutChunks.push(c);
    if (Buffer.concat(stdoutChunks).length > 128 * 1024) stdoutChunks.shift();
  });
  child.stderr?.on("data", (c: Buffer) => {
    stderrChunks.push(c);
    if (Buffer.concat(stderrChunks).length > 128 * 1024) stderrChunks.shift();
  });
  const code = child.exitCode;
  const signal = child.signalCode;
  const tail = (bufs: Buffer[]): string => {
    const all = Buffer.concat(bufs).toString("utf-8");
    return all.split("\n").slice(-80).join("\n").slice(-16_000);
  };
  const out = {
    tag,
    code,
    signal,
    stdoutTail: tail(stdoutChunks),
    stderrTail: tail(stderrChunks),
  };
  return out;
}

interface RunAssertionInput {
  label: string;
  runId: string;
  env: Record<string, string>;
  tamanduaDir: string;
  repoDir: string;
}

/**
 * Assert one completed synthetic matchlock run per gate-B acceptance:
 * progress resource persisted, real step DB rows, host suite store row under
 * the canonical namespace with integer exit, artifacts retained.
 */
function assertRunEvidence(input: RunAssertionInput): void {
  const { label, runId, env, tamanduaDir, repoDir } = input;

  // Progress document persisted at host <state>/runs/<runId>/progress-resource/progress.txt
  const progressFile = path.join(
    tamanduaDir, "runs", runId, "progress-resource", "progress.txt",
  );
  assert.ok(
    fs.existsSync(progressFile),
    `${label}: guest progress document missing at ${progressFile}`,
  );
  const progressText = fs.readFileSync(progressFile, "utf-8");
  assert.ok(progressText.trim().length > 0, `${label}: progress document is empty`);

  // Typed claims/completes in the real step DB (all steps done, output stored).
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const rows = db
      .prepare(
        "SELECT step_id, agent_id, status, output FROM steps WHERE run_id = ? ORDER BY step_index",
      )
      .all(runId) as Array<{ step_id: string; agent_id: string; status: string; output: string | null }>;
    assert.ok(rows.length >= 1, `${label}: no steps found in step DB`);
    for (const row of rows) {
      assert.equal(
        row.status,
        "done",
        `${label}: step ${row.step_id} (${row.agent_id}) not done (status=${row.status})`,
      );
      assert.ok(
        row.output && /STATUS:\s*done/i.test(row.output),
        `${label}: step ${row.step_id} has no STATUS: done output`,
      );
    }
  } finally {
    db.close();
  }

  // Host-owned Matchlock suite store: the packed tamandua-test recorded a real
  // integer-exit row under the canonical namespace (the namespace table
  // carries the attested image/platform/helper/fingerprint identity axis).
  const suiteStore = path.join(tamanduaDir, "matchlock", "suite", "host-suite.db");
  assert.ok(fs.existsSync(suiteStore), `${label}: host suite store missing at ${suiteStore}`);
  const sdb = openE2eDatabase(suiteStore);
  try {
    const resultCols = (sdb.prepare("PRAGMA table_info(host_suite_results)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const required of [
      "exit_code", "namespace_id", "origin_repo", "tree_hash", "cmd_hash",
      "cmd_display", "run_id", "step_id", "created_at", "invocation_id",
    ]) {
      assert.ok(resultCols.includes(required), `${label}: host_suite_results missing column ${required}`);
    }
    const nsCols = (sdb.prepare("PRAGMA table_info(host_suite_namespace)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const required of [
      "namespace_id", "image_content_id", "guest_platform", "helper_contract", "compatibility_fingerprint",
    ]) {
      assert.ok(nsCols.includes(required), `${label}: host_suite_namespace missing column ${required}`);
    }

    const rows = sdb
      .prepare(
        "SELECT id, namespace_id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, run_id, step_id, invocation_id, agent_id, job_id FROM host_suite_results ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 1, `${label}: no host suite result rows recorded`);
    // STRICT run binding (ROOT review): a NULL/foreign run suite row must NOT
    // satisfy this run merely because it carries some valid exit integer — the
    // row must be bound to THIS run id (never a nullable/foreign row).
    const runRows = rows.filter((r) => String(r.run_id ?? "") === runId);
    assert.ok(runRows.length >= 1, `${label}: no suite result row EXACTLY bound to run ${runId} (rows=${rows.map((r) => String(r.run_id)).join(",")})`);
    const rec = runRows[0];
    assert.ok(
      String(rec.invocation_id ?? "").length > 0,
      `${label}: suite row must carry a host-bound invocation id`,
    );
    assert.ok(
      String(rec.agent_id ?? "").length > 0,
      `${label}: suite row must carry the bound agent id`,
    );
    assert.ok(
      String(rec.job_id ?? "").length > 0,
      `${label}: suite row must carry the bound job id`,
    );
    // origin_repo must be the exact fixture repo realpath for THIS run.
    assert.equal(
      String(rec.origin_repo ?? ""),
      repoDir,
      `${label}: suite origin_repo must equal the admitted fixture repo`,
    );
    assert.ok(/^[0-9a-f]{40}$/.test(String(rec.tree_hash ?? "")), `${label}: suite tree_hash must be 40-hex`);
    assert.equal(
      typeof rec.exit_code,
      "number",
      `${label}: suite exit_code must be an integer`,
    );
    assert.ok(
      Number.isInteger(rec.exit_code) && (rec.exit_code as number) >= 0 && (rec.exit_code as number) <= 255,
      `${label}: suite exit_code must be an integer in [0,255] (got ${rec.exit_code})`,
    );
    assert.ok(String(rec.cmd_hash ?? "").length > 0, `${label}: suite row missing cmd_hash`);
    const ns = sdb
      .prepare("SELECT namespace_id, image_content_id, guest_platform, helper_contract, compatibility_fingerprint FROM host_suite_namespace WHERE namespace_id = ?")
      .get(String(rec.namespace_id)) as Record<string, unknown> | undefined;
    assert.ok(ns, `${label}: suite row namespace ${rec.namespace_id} missing from namespace table`);
    assert.ok(String(ns.image_content_id ?? "").startsWith("sha256:"), `${label}: suite namespace image_content_id unexpected: ${ns.image_content_id}`);
    assert.equal(String(ns.guest_platform ?? ""), "linux/amd64", `${label}: suite guest_platform mismatch`);
    assert.ok(String(ns.helper_contract ?? "").startsWith("guest-helper-"), `${label}: suite helper_contract unexpected: ${ns.helper_contract}`);
    assert.ok(String(ns.compatibility_fingerprint ?? "").length > 0, `${label}: suite namespace missing compatibility_fingerprint`);
  } finally {
    sdb.close();
  }

  // Intended SYNTHETIC usage totals must land on the run (per-run token
  // accounting): do-now = 1 work round x 111; do-review-do-verify = 4 work
  // rounds x 111 = 444 (probe rounds carry 0). This pins the scheduler's
  // existing accounting contract on the actual whole path — not zero, not
  // fabricated.
  const runDb = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const runRow = runDb
      .prepare("SELECT tokens_spent FROM runs WHERE id = ?")
      .get(runId) as { tokens_spent: number } | undefined;
    assert.ok(runRow, `${label}: run row missing tokens_spent`);
    const expectedTokens = label === "do-now" ? 111 : 444;
    assert.equal(
      runRow.tokens_spent,
      expectedTokens,
      `${label}: expected synthetic usage total ${expectedTokens}, got ${runRow.tokens_spent}`,
    );
  } finally {
    runDb.close();
  }

  // Harmless owned fixture action artifact retained on the host (marker file
  // under the mounted working dir).
  const markerDir = path.join(repoDir, ".matchlock-synthetic-pi");
  assert.ok(fs.existsSync(markerDir), `${label}: synthetic marker dir missing in repo ${repoDir}`);
  const markers = fs.readdirSync(markerDir).filter((f) => f.endsWith(".marker"));
  assert.ok(markers.length >= 1, `${label}: no synthetic marker files retained`);
}


/**
 * Live VM receipts watcher (ROOT review item 4): while a workflow run is
 * active, sample the owned VM inventory every ~400ms and journal every
 * distinct vm id (first/last seen) into a receipts file under the evidence
 * dir. This proves a FRESH VM per probe/work invocation (distinct ids, never
 * reused) and gives per-invocation closure evidence that is later confirmed
 * by the exact cleanup ledger — not merely a final batch read.
 */
export interface VmReceiptsJournal {
  path: string;
  firstSeen: Map<string, string>;
  lastSeen: Map<string, string>;
  samples: number;
}

export function startVmReceiptsJournal(evidenceDir: string, label: string): VmReceiptsJournal {
  return {
    path: path.join(evidenceDir, `vm-receipts-${label}.jsonl`),
    firstSeen: new Map(),
    lastSeen: new Map(),
    samples: 0,
  };
}

export function sampleVmReceipts(journal: VmReceiptsJournal, homeDir: string): void {
  journal.samples += 1;
  const ts = new Date().toISOString();
  const lines: string[] = [];
  // Absent/corrupt inventory THROWS (never silently empty) so the watcher
  // cannot fabricate clean per-invocation receipts.
  const inv = readVmInventory(homeDir);
  for (const row of inv.rows) {
    if (!journal.firstSeen.has(row.id)) journal.firstSeen.set(row.id, ts);
    journal.lastSeen.set(row.id, ts);
    lines.push(`${ts} row ${row.id} status=${row.status}`);
  }
  for (const dirId of inv.dirIds) {
    if (!journal.firstSeen.has(dirId)) journal.firstSeen.set(dirId, ts);
    journal.lastSeen.set(dirId, ts);
    lines.push(`${ts} dir ${dirId}`);
  }
  if (lines.length > 0) {
    fs.appendFileSync(journal.path, lines.join("\n") + "\n", "utf-8");
  }
}

export function finishVmReceiptsJournal(journal: VmReceiptsJournal): { distinct: number; ids: string[] } {
  const ids = [...new Set([...journal.firstSeen.keys()])].sort();
  const out = [`# vm receipts (${ids.length} distinct, ${journal.samples} samples)`, ...ids.map((id) => `${id} first=${journal.firstSeen.get(id)} last=${journal.lastSeen.get(id) ?? "(never removed during run)"}`)].join("\n") + "\n";
  fs.appendFileSync(journal.path, out, "utf-8");
  return { distinct: ids.length, ids };
}

// ── shared state ──────────────────────────────────────────────────────────
let homeDir = "";
let tamanduaDir = "";
let env: Record<string, string> = {};
let daemon: ChildProcess | null = null;
let controlPort = 0;
let portHandles: PortHandle[] = [];
let fixturesRoot = "";
let wdNow = "";
let wdReview = "";
let runNowId = "";
let runReviewId = "";
let ledgerPath = "";
let assertionLedgerPath = "";
let observedVmIds: string[] = [];
let cleanupCompleted = false;

// ────────────────────────────────────────────────────────────────────────
// Injected failure controls (ROOT review item 2): deterministic, NO real VM
// and NO foreign path/process — these exercise the strict inventory reader and
// the exact-owned cleanup path against fabricated homes + a FAKE matchlock rm
// script, proving that corrupt/absent inventory and failed/unknown closes
// FAIL LOUDLY and RETAIN state (they never fabricate clean evidence). They
// run BEFORE the actual-VM operation.
// ────────────────────────────────────────────────────────────────────────
function makeFakeMatchlock(binPath: string, behavior: "ok" | "fail" | "hang"): void {
  // A deterministic stand-in for `matchlock rm <id>` used ONLY by the
  // injected controls (no real runtime, no real VM). "ok" EMULATES the real
  // rm: it deletes the exact vms row + state dir under $HOME so the strict
  // inventory reader observes a genuine positive close. "fail"/"hang" leave
  // state in place so the gate must fail and retain diagnostics.
  const nodeProbe =
    behavior === "ok"
      ? `const fs=require("node:fs");const path=require("node:path");
const Sqlite=require("node:sqlite").DatabaseSync;
const id=process.argv[3];const home=process.env.HOME;
try{const db=new Sqlite(path.join(home,".matchlock","state.db"));db.exec("DELETE FROM vms WHERE id = '" + id + "'");db.close();}catch(e){}
try{fs.rmSync(path.join(home,".matchlock","vms",id),{recursive:true,force:true});}catch(e){}
console.log("removed "+id);process.exit(0);`
      : behavior === "fail"
        ? `process.stderr.write("rm failed (injected)\n");process.exit(2);`
        : `setTimeout(()=>process.exit(0), 30000);`;
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env node\n${nodeProbe}\n`,
    { mode: 0o755 },
  );
}

function fabricateVmHome(root: string, opts: { db?: "absent" | "empty" | "rows" | "corrupt"; dirs?: boolean }): string {
  // A UNIQUE home per fabrication: each injected control builds its own
  // scratch state so no two tests can corrupt/leak into each other's DB.
  const homeDir = fs.mkdtempSync(path.join(root, "home-"));
  const matchlockDir = path.join(homeDir, ".matchlock");
  fs.mkdirSync(path.join(matchlockDir, "vms"), { recursive: true });
  if (opts.db && opts.db !== "absent") {
    const dbPath = path.join(matchlockDir, "state.db");
    if (opts.db === "corrupt") {
      fs.writeFileSync(dbPath, "this is not a sqlite db", "utf-8");
    } else {
      const db = openE2eDatabase(dbPath);
      try {
        db.exec("CREATE TABLE vms (id TEXT PRIMARY KEY, status TEXT, created_at TEXT)");
        if (opts.db === "rows") {
          const now = new Date().toISOString();
          db.prepare("INSERT INTO vms (id, status, created_at) VALUES (?, 'running', ?)").run("vm-11223344", now);
          db.prepare("INSERT INTO vms (id, status, created_at) VALUES (?, 'stopped', ?)").run("vm-55667788", now);
        }
      } finally {
        db.close();
      }
    }
  }
  if (opts.dirs) {
    for (const id of ["vm-11223344", "vm-55667788"]) {
      fs.mkdirSync(path.join(matchlockDir, "vms", id), { recursive: true });
    }
  }
  return homeDir;
}

describe(
  "matchlock gate cleanup/inventory INJECTED FAILURE CONTROLS (mock/no real VM)",
  { concurrency: 1 },
  () => {
    let ctrlRoot = "";

    before(() => {
      ctrlRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "mtlk-gate-controls-"));
    });

    after(() => {
      try {
        fs.rmSync(ctrlRoot, { recursive: true, force: true });
      } catch {
        /* owned scratch */
      }
    });

    it("a CORRUPT state DB throws from the strict inventory reader (never empty/clean)", () => {
      const homeDir = fabricateVmHome(ctrlRoot, { db: "corrupt" });
      assert.throws(
        () => readVmInventory(homeDir),
        /unreadable\/corrupt/,
        "corrupt matchlock state DB must throw, not read as empty",
      );
    });

    it("an ABSENT state DB is DISTINCT from a successfully queried empty state", () => {
      const absentHome = fabricateVmHome(ctrlRoot, { db: "absent" });
      const emptyHome = fabricateVmHome(ctrlRoot, { db: "empty" });
      const absent = readVmInventory(absentHome);
      const empty = readVmInventory(emptyHome);
      assert.equal(absent.dbPresent, false, "absent DB is reported absent");
      assert.equal(absent.rows.length, 0);
      assert.equal(empty.dbPresent, true, "empty DB is reported present");
      assert.equal(empty.rows.length, 0);
      // absent ≠ empty: cleanup with an absent DB and observed ids MUST fail.
      const ledgerPath = path.join(ctrlRoot, "absent-ledger.txt");
      assert.throws(
        () => cleanupOwnedVms(absentHome, ledgerPath, ["vm-11223344"], {
          rpcBin: path.join(ctrlRoot, "matchlock-ok"),
        }),
        /state DB is MISSING|absent ≠ clean|state DB missing/,
        "an absent DB with observed VM ids must fail the cleanup (absent is not clean)",
      );
      assert.ok(fs.existsSync(ledgerPath), "ledger is written even when cleanup fails");
    });

    it("a FAILED exact-id close throws, retains state and records every outcome", () => {
      const homeDir = fabricateVmHome(ctrlRoot, { db: "rows", dirs: true });
      const fakeRm = path.join(ctrlRoot, "matchlock-fail");
      makeFakeMatchlock(fakeRm, "fail");
      const ledgerPath = path.join(ctrlRoot, "fail-ledger.txt");
      assert.throws(
        () => cleanupOwnedVms(homeDir, ledgerPath, ["vm-11223344"], { rpcBin: fakeRm }),
        /failed to close cleanly/,
        "a failed rm must fail the gate",
      );
      // State is RETAINED after the failed disposal (never erased to look
      // clean) and the ledger records the failure.
      const stateDir = path.join(homeDir, ".matchlock", "vms", "vm-11223344");
      assert.ok(fs.existsSync(stateDir), "state dir retained after a failed close");
      const ledgerText = fs.readFileSync(ledgerPath, "utf-8");
      assert.match(ledgerText, /vm-11223344/, "ledger records the exact owned id");
      assert.match(ledgerText, /NOT cleanly closed/, "ledger records the failed close");
    });

    it("an UNKNOWN vm id (no row, no dir) is not fabricated into inventory or cleanup targets", () => {
      const homeDir = fabricateVmHome(ctrlRoot, { db: "empty" });
      const fakeRm = path.join(ctrlRoot, "matchlock-ok");
      makeFakeMatchlock(fakeRm, "ok");
      const ledgerPath = path.join(ctrlRoot, "unknown-ledger.txt");
      const ledger = cleanupOwnedVms(homeDir, ledgerPath, ["vm-deadbeef"], { rpcBin: fakeRm });
      assert.ok(
        ledger.some((l) => /vm-deadbeef already positively closed by the runner \(no row and no state dir\)/.test(l)),
        "an id with no row/dir is recorded as already-closed, never fabricated",
      );
      assert.ok(fs.existsSync(ledgerPath));
    });

    it("a SUCCESSFUL exact-id close leaves a clean ledger (rows + dirs gone)", () => {
      const homeDir = fabricateVmHome(ctrlRoot, { db: "rows", dirs: true });
      const fakeRm = path.join(ctrlRoot, "matchlock-ok");
      makeFakeMatchlock(fakeRm, "ok");
      const ledgerPath = path.join(ctrlRoot, "ok-ledger.txt");
      const ledger = cleanupOwnedVms(homeDir, ledgerPath, ["vm-11223344", "vm-55667788"], { rpcBin: fakeRm });
      assert.ok(ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)));
    });

    it("readRunEvents treats CORRUPT event JSON as an ERROR (never silent {})", () => {
      const eventsDir = path.join(ctrlRoot, "home2", ".tamandua", "events");
      fs.mkdirSync(eventsDir, { recursive: true });
      const eventsFile = path.join(eventsDir, "corrupt.jsonl");
      fs.writeFileSync(eventsFile, '{"event":"ok"}\nnot-json\n', "utf-8");
      assert.throws(
        () => readRunEvents(path.join(ctrlRoot, "home2", ".tamandua"), "corrupt"),
        /corrupt event JSON/,
      );
    });
  },
);

describe(
  "matchlock synthetic whole-path gate (gate B): do-now + do-review-do-verify in fresh VMs",
  { concurrency: 1 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      // Fresh private HOME rooted inside the evidence dir (schema10 only
      // there; never the live worker daemon / live ~/.tamandua).
      homeDir = path.join(EVIDENCE_DIR, "home");
      tamanduaDir = path.join(homeDir, ".tamandua");
      fs.mkdirSync(tamanduaDir, { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".cache"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "agent", "settings.json"),
        JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
        "utf-8",
      );
      fs.writeFileSync(path.join(tamanduaDir, "port"), "0", "utf-8");

      // Kernel cache for the fresh matchlock state (the candidate runtime
      // resolves kernels under $HOME/.cache/matchlock). Copy the qualified
      // kernel tree — never mutate the operator's cache.
      const kernelSrc = "/root/.cache/matchlock/kernels";
      assert.ok(fs.existsSync(kernelSrc), `kernel cache source missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), {
        recursive: true,
      });

      // ── build + import the TEST-ONLY derived fixture image ──────────
      const dockerBuild = spawnSync(
        "/usr/bin/docker", ["build", "-f", FIXTURE_DOCKERFILE, "-t", FIXTURE_IMAGE_TAG, "."],
        {
          cwd: FIXTURE_DOCKER_DIR,
          encoding: "utf-8",
          env: inheritedProcessEnv(),
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      assert.equal(
        dockerBuild.status,
        0,
        `docker build of the synthetic fixture failed (exit ${dockerBuild.status}, signal ${dockerBuild.signal}, error ${
          dockerBuild.error ? dockerBuild.error.message : "none"
        }):\n${(dockerBuild.stdout || "").slice(-4000)}\n${(dockerBuild.stderr || "").slice(-4000)}`,
      );
      // docker save → fixture tar on disk (spawnSync stdout buffering would
      // corrupt a multi-hundred-MB tar; stream to a file via an fd instead).
      const fixtureTar = path.join(EVIDENCE_DIR, "fixture-image.tar");
      const saveOutFd = fs.openSync(fixtureTar, "w");
      const dockerSave = spawnSync("/usr/bin/docker", ["save", FIXTURE_IMAGE_TAG], {
        stdio: ["ignore", saveOutFd, "pipe"],
        env: inheritedProcessEnv(),
      });
      fs.closeSync(saveOutFd);
      assert.equal(
        dockerSave.status,
        0,
        `docker save of the synthetic fixture failed: ${dockerSave.stderr}`,
      );
      const importEnv = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
      const saveInFd = fs.openSync(fixtureTar, "r");
      const imageImport = spawnSync(MATCHLOCK_RPC_BIN, ["image", "import", FIXTURE_IMAGE_TAG], {
        encoding: "utf-8",
        stdio: [saveInFd, "pipe", "pipe"],
        env: importEnv,
      });
      fs.closeSync(saveInFd);
      assert.equal(
        imageImport.status,
        0,
        `matchlock image import failed: ${imageImport.stdout}\n${imageImport.stderr}`,
      );
      // Resolve must succeed (pinned identity available for admission).
      const resolved = spawnSync(MATCHLOCK_RPC_BIN, ["image", "resolve", FIXTURE_IMAGE_TAG], {
        encoding: "utf-8",
        env: importEnv,
      });
      assert.equal(resolved.status, 0, `matchlock image resolve failed: ${resolved.stderr}`);
      const identity = JSON.parse(resolved.stdout.trim()) as { digest: string; config_digest: string };
      assert.ok(
        identity.digest.startsWith("sha256:") && identity.config_digest.startsWith("sha256:"),
        "resolved fixture identity incomplete",
      );

      portHandles = await reservePortHandles(1);
      controlPort = portHandles[0].port;
      fs.writeFileSync(path.join(tamanduaDir, "port"), String(controlPort), "utf-8");
      env = gateEnv(homeDir, controlPort);

      cliMustSucceed(["workflow", "install", "do-now"], env, "install do-now workflow");
      cliMustSucceed(["workflow", "install", "do-review-do-verify"], env, "install do-review-do-verify workflow");

      // Fresh git fixture working directories (harmless owned fixture action
      // targets; host evidence retained under the evidence dir).
      fixturesRoot = path.join(EVIDENCE_DIR, "fixtures");
      wdNow = prepareFixtureRepo(path.join(fixturesRoot, "wd-now"));
      wdReview = prepareFixtureRepo(path.join(fixturesRoot, "wd-review"));
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");
      assertionLedgerPath = path.join(EVIDENCE_DIR, "vm-no-owned-assertions.txt");
    });

    after(async () => {
      // Emergency teardown that NEVER swallows cleanup failure: if the test
      // body never ran its authoritative cleanup (early failure), this hook
      // performs the exact-id VM disposal and PROPAGATES any failure (the
      // wrapper must fail on cleanup errors — never a silent best-effort).
      const errors: string[] = [];
      if (daemon) {
        try {
          const closeOutcome = await stopIsolatedDaemonScoped(daemon);
          recordChildExitEvidence(daemon, "gate-daemon");
          if (closeOutcome.signal === "SIGKILL-timeout") errors.push("daemon did not close within the scoped bound");
        } catch (err) {
          errors.push(`daemon stop: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          daemon = null;
        }
      }
      if (homeDir && !cleanupCompleted) {
        try {
          cleanupOwnedVms(homeDir, ledgerPath, observedVmIds);
        } catch (err) {
          errors.push(`emergency VM cleanup: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await releasePortReservations({ portHandles }).catch(() => {});
      portHandles = [];
      // ── observed-rounds honesty (TESTER-HONESTY item 3) ─────────────
      // Record the distinct in-VM rounds this gate ACTUALLY observed and
      // refuse to certify a zero-round run (VM creation/probe failed before
      // any round) even if the node --test assertions above were bypassed.
      const observedRounds = new Set(observedVmIds).size;
      if (EVIDENCE_DIR.length > 0) {
        writeObservedRoundsEvidence(EVIDENCE_DIR, {
          gate: GATE_LABEL,
          observed_rounds: observedRounds,
          observed_vm_ids: observedVmIds,
          detail: `${GATE_LABEL}: ${observedRounds} distinct in-VM rounds observed`,
        });
      }
      try {
        assertObservedRoundsNonZero(GATE_LABEL, observedRounds, observedVmIds);
      } catch (err) {
        errors.push(`observed-rounds: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (errors.length > 0) {
        throw new Error(`gate after-hook failure:\n${errors.join("\n")}`);
      }
    });

    it(
      "do-now + do-review-do-verify both reach real completion through isolated daemon → fresh VMs",
      { timeout: 60 * 60_000 },
      async () => {
        let totalVmCount = 0;
        let distinctVmCount = 0;
        // ── Start the isolated real daemon ─────────────────────────
        await releasePortReservations({ portHandles });
        portHandles = [];
        daemon = await startIsolatedDaemon(homeDir, controlPort, gateEnv(homeDir, controlPort));

        // Live per-invocation VM receipts: sample the owned inventory while
        // the runs execute (probe/work VMs appear as rows/dirs and are later
        // positively closed). Distinct ids prove a FRESH VM per invocation;
        // the final cleanup ledger proves positive per-invocation closure —
        // not a single end-state batch read.
        const receipts = startVmReceiptsJournal(EVIDENCE_DIR, "whole-path");
        let samplerTimer: NodeJS.Timeout | null = null;
        const startSampler = (): void => {
          if (samplerTimer) return;
          samplerTimer = setInterval(() => {
            try {
              sampleVmReceipts(receipts, homeDir);
            } catch (err) {
              process.stderr.write(`[matchlock-synthetic-gate] VM receipt sampler failed: ${String(err)}\n`);
            }
          }, 250);
        };
        const stopSampler = (): void => {
          if (samplerTimer) {
            clearInterval(samplerTimer);
            samplerTimer = null;
          }
        };
        try {
          startSampler();
          // ── Run 1: do-now with --matchlock ────────────────────────
          const nowPrefix = await spawnWorkflowRun(
            [
              "workflow", "run", "do-now",
              "Synthetic whole-path gate (gate B): execute the harmless owned fixture action and report.",
              "--working-directory-for-harness", wdNow,
              "--matchlock", FIXTURE_IMAGE_TAG,
            ],
            env,
            60_000,
          );
          runNowId = resolveFullRunId(nowPrefix, tamanduaDir);
          const nowStatus = await pollTerminalWithNudge(runNowId, env, tamanduaDir, "do-now");
          assert.equal(nowStatus, "completed", `do-now run must complete; got ${nowStatus}`);
          await sleep(500);
          assertRunEvidence({
            label: "do-now",
            runId: runNowId,
            env,
            tamanduaDir,
            repoDir: wdNow,
          });
          // The runner must have captured + removed every probe/work VM for
          // this run itself — asserted BEFORE any gate-side `matchlock rm`.
          assertNoOwnedVms(homeDir, "do-now: post-run", {
            pollTimeoutMs: 120_000,
            rpcBin: MATCHLOCK_RPC_BIN,
            ledgerPath: assertionLedgerPath,
          });

          // ── Run 2: do-review-do-verify with --matchlock ───────────
          const reviewPrefix = await spawnWorkflowRun(
            [
              "workflow", "run", "do-review-do-verify",
              "Synthetic whole-path gate (gate B): execute the harmless owned fixture action, review it, refine it and verify it.",
              "--working-directory-for-harness", wdReview,
              "--matchlock", FIXTURE_IMAGE_TAG,
            ],
            env,
            60_000,
          );
          runReviewId = resolveFullRunId(reviewPrefix, tamanduaDir);
          const reviewStatus = await pollTerminalWithNudge(runReviewId, env, tamanduaDir, "do-review-do-verify");
          assert.equal(reviewStatus, "completed", `do-review-do-verify run must complete; got ${reviewStatus}`);
          await sleep(500);
          assertRunEvidence({
            label: "do-review-do-verify",
            runId: runReviewId,
            env,
            tamanduaDir,
            repoDir: wdReview,
          });
          // Same strict post-run proof for the second workflow: no owned VM
          // row/state dir may remain before the gate's defensive cleanup.
          assertNoOwnedVms(homeDir, "do-review-do-verify: post-run", {
            pollTimeoutMs: 120_000,
            rpcBin: MATCHLOCK_RPC_BIN,
            ledgerPath: assertionLedgerPath,
          });

          // ── Whole-path / no-fallback assertions ────────────────────
          for (const [label, runId] of [["do-now", runNowId], ["do-review-do-verify", runReviewId]]) {
            const events = readRunEvents(tamanduaDir, runId);
            const byType = new Map<string, number>();
            for (const e of events) byType.set(e.event, (byType.get(e.event) ?? 0) + 1);
            assert.ok(
              (byType.get("run.completed") ?? 0) === 1,
              `${label}: expected exactly one run.completed event (events: ${[...byType.entries()].map(([k, v]) => `${k}=${v}`).join(", ")})`,
            );
            // The in-VM launch probe recorded exactly one pass per run and a
            // passed run is never re-probed.
            assert.ok(
              (byType.get("run.harness_probe_ok") ?? 0) === 1,
              `${label}: expected exactly one run.harness_probe_ok (got ${byType.get("run.harness_probe_ok") ?? 0})`,
            );
            // No refusal / infra / native-fallback signals on the supported path.
            for (const bad of [
              "run.matchlock_dispatch_refused",
              "run.matchlock_invocation_infra_failed",
              "run.harness_probe_failed",
              "run.instant_fail_loop",
            ]) {
              assert.equal(byType.get(bad) ?? 0, 0, `${label}: unexpected ${bad} event`);
            }
          }

          // Every probe/work invocation used a FRESH VM: do-now = 1 probe + 1
          // work; do-review-do-verify = 1 probe + 4 work rounds → 7 distinct.
          stopSampler();
          const receiptsResult = finishVmReceiptsJournal(receipts);
          observedVmIds = receiptsResult.ids;
          const distinct = new Set(observedVmIds);
          totalVmCount = observedVmIds.length;
          distinctVmCount = distinct.size;
          assert.ok(
            distinctVmCount >= 7,
            `expected >= 7 distinct fresh VMs (2 probes + 5 work rounds), got ${distinctVmCount}: ${[...distinct].join(",")}`,
          );
          assert.equal(
            totalVmCount,
            distinctVmCount,
            "VM ids must never repeat (fresh VM per probe/work invocation)",
          );
          assert.ok(
            fs.existsSync(receipts.path),
            `VM receipts journal missing at ${receipts.path}`,
          );
          const receiptsText = fs.readFileSync(receipts.path, "utf-8");
          assert.ok(receipts.samples >= 2, `VM receipts journal must contain multiple samples (got ${receipts.samples})`);
          for (const id of observedVmIds) {
            assert.ok(
              new RegExp(`^${id} first=`, "m").test(receiptsText),
              `receipts journal must record first-seen for ${id}`,
            );
          }
        } finally {
          // ── Stop the daemon (scoped, observing real child close) ──
          if (daemon) {
            try {
              const closeOutcome = await stopIsolatedDaemonScoped(daemon);
              recordChildExitEvidence(daemon, "gate-daemon");
              assert.ok(
                closeOutcome.signal !== "SIGKILL-timeout",
                `gate daemon did not close within the scoped bound (code=${closeOutcome.code}, signal=${closeOutcome.signal})`,
              );
            } finally {
              daemon = null;
            }
          }
        }

        // Authoritative exact-owned VM teardown + ledger (cleanup failure
        // propagates and fails the gate — never ignored; never erases state
        // after a failed disposal).
        const ledger = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds);
        cleanupCompleted = true;
        assert.ok(fs.existsSync(ledgerPath), `vm cleanup ledger missing at ${ledgerPath}`);
        assert.ok(
          ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
          "cleanup ledger must record completion with no leftovers",
        );
        console.log(
          `[matchlock-synthetic-gate] OK do-now=${runNowId} do-review-do-verify=${runReviewId} vms=${totalVmCount} distinct=${distinctVmCount}`,
        );
      },
    );
  },
);

async function pollTerminalWithNudge(
  runId: string,
  env: Record<string, string>,
  tamanduaDir: string,
  label: string,
): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });
    const out = result.stdout || result.stderr || "";
    const m = out.match(/^Status:\s+(\S+)/m);
    if (m) {
      lastStatus = m[1];
      if (["completed", "done", "failed", "canceled"].includes(lastStatus)) {
        return lastStatus;
      }
    }
    // Nudge the isolated daemon so dispatch advances at second scale.
    spawnSync(process.execPath, [cliPath, "nudge"], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });
    await sleep(DEFAULT_POLL_MS);
  }
  const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
  let tail = "";
  try {
    const lines = fs.readFileSync(eventsPath, "utf-8").trimEnd().split("\n");
    tail = lines.slice(-20).join("\n");
  } catch {
    /* ignore */
  }
  throw new Error(
    `[${label}] timeout after ${RUN_TIMEOUT_MS}ms waiting for terminal status; last=${lastStatus || "(none)"}\n${tail}`,
  );
}

function readRunEvents(tamanduaDir: string, runId: string): Array<Record<string, unknown>> {
  const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  const events: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(eventsPath, "utf-8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // ROOT review: corrupt event JSON is an ERROR, never silently {} — a
      // corrupt events ledger must fail the gate loudly.
      throw new Error(`corrupt event JSON in ${eventsPath}: ${line.slice(0, 200)}`);
    }
  }
  return events;
}

export interface VmRow {
  id: string;
  status: string;
}

export interface VmInventory {
  /** True when the matchlock state DB file EXISTS (queried successfully). */
  dbPresent: boolean;
  /** Rows in the `vms` table (only well-formed vm-<8hex> ids; invalid rows THROW). */
  rows: VmRow[];
  /** State dirs under $HOME/.matchlock/vms that carry an OWNED vm-<8hex> name. */
  dirIds: string[];
}

const VM_ID_RE = /^vm-[0-9a-f]{8}$/;

/**
 * Read the actual owned VM inventory STRICTLY (ROOT review correction):
 *
 *  - a state.db that is ABSENT is a DISTINCT state from one that was queried
 *    and found empty — callers decide whether absence is expected;
 *  - a state.db that exists but cannot be opened/queried (corrupt/unreadable)
 *    THROWS — it is never silently treated as empty/clean;
 *  - an invalid `vms` row (missing/non-matching id) THROWS — inventory is not
 *    fabricated from arbitrary names;
 *  - the directory listing is only corroboration for exact OWNED vm-* names,
 *    never an independent inventory source.
 */
export function readVmInventory(homeDir: string): VmInventory {
  const stateDb = path.join(homeDir, ".matchlock", "state.db");
  const dbExists = fs.existsSync(stateDb);
  let rows: VmRow[] = [];
  if (dbExists) {
    const db = openE2eDatabase(stateDb);
    try {
      const raw = db.prepare("SELECT id, status FROM vms ORDER BY created_at").all() as Array<{ id: string; status: string }>;
      for (const r of raw) {
        if (typeof r.id !== "string" || !VM_ID_RE.test(r.id)) {
          throw new Error(`corrupt matchlock VM inventory: invalid vms row id ${JSON.stringify(r.id)}`);
        }
        rows.push({ id: r.id, status: String(r.status ?? "") });
      }
    } catch (err) {
      if (err instanceof Error && /corrupt matchlock VM inventory/.test(err.message)) throw err;
      throw new Error(`matchlock state DB is unreadable/corrupt at ${stateDb}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      db.close();
    }
  }
  const vmsDir = path.join(homeDir, ".matchlock", "vms");
  let dirIds: string[] = [];
  if (fs.existsSync(vmsDir)) {
    dirIds = fs
      .readdirSync(vmsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && VM_ID_RE.test(e.name))
      .map((e) => e.name);
  }
  return { dbPresent: dbExists, rows, dirIds };
}

/** Convenience: strict VM id list (throws on corrupt/absent-when-expected). */
export function readVmIds(homeDir: string, opts: { allowAbsent?: boolean } = {}): string[] {
  const inv = readVmInventory(homeDir);
  if (!inv.dbPresent && !opts.allowAbsent) {
    throw new Error(`matchlock state DB is MISSING at ${path.join(homeDir, ".matchlock", "state.db")} while owned VMs were expected; refusing to treat absent state as clean`);
  }
  return inv.rows.map((r) => r.id);
}

/**
 * Record every inventory + cleanup outcome in the ledger, and WRITE the
 * ledger even when a failure throws (so a failed close leaves diagnostics).
 */
export function writeLedger(ledgerPath: string, ledger: string[]): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, ledger.join("\n") + "\n", "utf-8");
}

/**
 * Scoped daemon stop that OBSERVES the child's real close (ROOT review): sends
 * SIGTERM to the exact owned child, waits for the 'close' event (not merely a
 * sent signal), records the close code/signal, and throws when the daemon does
 * not close within the bound. NEVER sweeps or touches foreign processes.
 */
export async function stopIsolatedDaemonScoped(
  child: ChildProcess,
  opts: { termGraceMs?: number; killGraceMs?: number } = {},
): Promise<{ code: number | null; signal: string | null }> {
  const termGraceMs = opts.termGraceMs ?? 8_000;
  const killGraceMs = opts.killGraceMs ?? 6_000;
  if (!child || !child.pid) return { code: child?.exitCode ?? null, signal: child?.signalCode ?? null };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal: (signal as string) ?? null }));
    timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, termGraceMs);
  });
  try {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const outcome = await Promise.race([
      closed,
      new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        setTimeout(() => resolve({ code: null, signal: "SIGKILL-timeout" }), termGraceMs + killGraceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.signal === "SIGKILL-timeout") {
      throw new Error("isolated daemon did not close after SIGTERM + SIGKILL within the scoped bound");
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
