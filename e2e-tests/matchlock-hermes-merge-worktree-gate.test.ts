/******************************************************************************
 * ⚠️  SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-ALL-WORKFLOWS US-009 — the fresh-VM synthetic WHOLE-PATH gate for the
 * genuine bundled `feature-dev-merge-worktree` workflow under the **hermes**
 * Matchlock route.
 *
 * It is the hermes sibling of e2e-tests/matchlock-worktree-merge-gate.test.ts
 * (pi) and e2e-tests/matchlock-dsh-merge-worktree-gate.test.ts (dsh). It drives
 * the REAL isolated daemon → scheduler → hermes Matchlock invocation runner →
 * FRESH VMs path end-to-end for the real bundled feature-dev-merge-worktree
 * workflow, using a deterministic TEST-ONLY "synthetic hermes" provided by an
 * explicitly test-only derived fixture image (e2e-tests/hermes-fixture/). NO
 * provider credentials and NO model calls.
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand UNDER THE SHARED GATE
 * LOCK:
 *
 *   flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock \
 *     ./run-matchlock-hermes-merge-worktree-e2e-test
 *
 * (the runner builds first, resolves the pinned/system matchlock pair, creates
 * a NEW mkdtemp evidence directory outside the repo with a private TMPDIR
 * inside it, and runs this file with all logs tee'd into that directory).
 *
 * Real-VM acceptance (among others):
 *   - the genuine bundled feature-dev-merge-worktree run reaches real status
 *     "completed" through isolated daemon → fresh hermes VMs;
 *   - the per-story verify loop ran: the merger's stale-tip attempt drove the
 *     real target_moved → rebase → retest reroute (or the production typed
 *     MERGE_TIP refusal + step.rerouted), and a second merger invocation landed;
 *   - the tester's packed tamandua-test recorded a REAL host-suite row under the
 *     canonical namespace for the exact tested tree + raw TEST_CMD, and the
 *     finalizer ledger seam accepted it;
 *   - the guest merger (scoped `merge-branch`) performed a REAL final target
 *     advance on the tiny OWNED origin, MERGED_TREE == the tested tree;
 *   - EVERY invocation across the many story/verify/retry rounds recovered its
 *     authoritative session (the stderr `session_id:` trailer, or the H2
 *     store-recovery fallback when a trailer is lost) and projected a REAL
 *     in-VM mapped-store usage total. The gate reconciles
 *     `runs.tokens_spent === Σ mapped-store session totals` EXACTLY: a borrowed
 *     session, a missed recovery, a duplicated projection or a fabricated zero
 *     cannot reconcile;
 *   - every probe/work/retry invocation used a DISTINCT fresh VM and every
 *     owned VM was positively closed/removed (strict exact-owned ledger).
 *
 * The H2 lost-trailer store-recovery fallback itself is covered exhaustively by
 * src/installer/matchlock/hermes-invocation-runner.test.ts (H2/US-007); this
 * gate proves the whole-path accounting is exact for every recovered round
 * regardless of which recovery source won.
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB under the evidence dir, schema10
 * only there, TAMANDUA_TEST_GUARD auto-active under node:test, random control
 * port, never the live worker daemon. Never touches live branches.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanChildEnv, reservePortHandles, type PortHandle } from "../tests/helpers/test-env.ts";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  inheritedProcessEnv,
  cliMustSucceed,
  spawnWorkflowRun,
  resolveFullRunId,
  releasePortReservations,
} from "./helpers/smoke-helpers.ts";
import { startIsolatedDaemon, stopIsolatedDaemon } from "./helpers/e2e-helpers.ts";
import {
  assertNoOwnedVms,
  cleanupOwnedVms,
  fabricateVmHome,
  makeFakeMatchlock,
  readRunnerVmEvidenceIds,
  readRunEvents,
  readVmInventory,
} from "./helpers/matchlock-gate-lifecycle.ts";
import {
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

const WORKFLOW_ID = "feature-dev-merge-worktree";
const FIXTURE_IMAGE_TAG = "tamandua-synthetic-hermes:gate-fixture";
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-hermes";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "hermes-fixture");

// Optional dev/test-speed content-addressed fixture image cache (see
// run-matchlock-hermes-merge-worktree-e2e-test). Never the clean acceptance
// path; images are content-addressed so the resolved digests are identical.
const FIXTURE_IMAGE_CACHE = process.env.TAMANDUA_GATE_FIXTURE_IMAGE_CACHE?.trim() || "";

// ── environment: paired runtime ───────────────────────────────────────────
// The runner script resolves the runtime (system pair by default; optional
// explicit overrides) and exports the three names. The test only requires them
// to be exported and present.
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT = process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED = process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";
// The observed-rounds evidence / guard label for this gate. The runner passes
// the SAME label to scripts/observed-rounds-guard.mjs.
const GATE_LABEL = "hermes-merge-worktree";

const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 60 * 60_000;
const TEST_CMD_RAW = "node test.mjs";

// The synthetic-hermes fixture's deterministic projected totals
// (input + output + cache_write; cache_read EXCLUDED): see fake-hermes.mjs.
const PROBE_TOKEN_TOTAL = 36;
const WORK_TOKEN_TOTAL = 155;

// Distinct fresh VMs expected: plan/setup/implement/test/verify/review + the
// merger's retry re-validation + the final landing, PLUS one launch probe.
// The minimum is deliberately conservative (>= the role count + probe).
const MIN_DISTINCT_VMS = 8;
// Mapped-store sessions whose in-VM usage projections must be present
// (probe + one per role invocation; the per-story verify loop adds more).
const MIN_OBSERVED_ROUNDS = 6;
// A completed run must have recovered exactly ONE launch-probe session.
const EXPECTED_PROBES = 1;

function assertEnv(): void {
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-hermes-merge-worktree-e2e-test)",
  );
  assert.ok(MATCHLOCK_RPC_BIN.length > 0, "TAMANDUA_MATCHLOCK_RPC_BIN must be set to the matchlock CLI");
  assert.ok(GUEST_INIT.length > 0, "MATCHLOCK_GUEST_INIT must be set to the guest-init");
  assert.ok(GUEST_FUSED.length > 0, "MATCHLOCK_GUEST_FUSED must be set to the guest-init (fused)");
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    assert.ok(fs.existsSync(p), `paired runtime binary missing: ${p}`);
  }
}

function gateEnv(homeDir: string, controlPort: number): Record<string, string> {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  const env: Record<string, string> = {
    ...inheritedProcessEnv(),
    HOME: homeDir,
    TAMANDUA_CONTROL_PORT: String(controlPort),
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: path.join(tamanduaDir, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDir, "worktrees"),
    TMPDIR: path.join(EVIDENCE_DIR, "tmp"),
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_HARNESS_PROBE: "1",
    TAMANDUA_PI_BINARY: "/usr/bin/false",
    TAMANDUA_DSH_BINARY: "/usr/bin/false",
    TAMANDUA_HERMES_BINARY: "/usr/bin/false",
    TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN,
    MATCHLOCK_GUEST_INIT: GUEST_INIT,
    MATCHLOCK_GUEST_FUSED: GUEST_FUSED,
  };
  // The hermes default effective home is <HOME>/.hermes (an explicit
  // HERMES_HOME would change the frozen submission root). Deleting it keeps
  // the whole-path run on the default root the gate provisions.
  delete env.HERMES_HOME;
  return env;
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}

/** Create a tiny OWNED origin repo with a deterministic committed test script. */
function prepareOwnedOrigin(originDir: string): { originalBranch: string } {
  fs.mkdirSync(path.join(originDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(originDir, "README.md"), "# Tiny owned origin (hermes whole-path gate)\n", "utf-8");
  fs.writeFileSync(
    path.join(originDir, "src", "math.mjs"),
    "export function add(a, b) { return a + b; }\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(originDir, "test.mjs"),
    'import { add } from "./src/math.mjs";\nif (add(2, 3) !== 5) { console.error("bad add"); process.exit(1); }\nconsole.log("owned fixture tests ok");\n',
    "utf-8",
  );
  fs.writeFileSync(path.join(originDir, ".gitignore"), "*.log\n.matchlock-synthetic-hermes/\n", "utf-8");
  git(["init", "-q", "-b", "main"], originDir);
  git(["config", "user.email", "gate@tamandua.test"], originDir);
  git(["config", "user.name", "Matchlock hermes Gate"], originDir);
  git(["add", "-A"], originDir);
  git(["commit", "-q", "-m", "initial owned origin fixture"], originDir);
  // Detach the origin checkout so the run's target ref is not the checked-out
  // branch (the merger must never switch the origin checkout).
  git(["checkout", "-q", "--detach"], originDir);
  return { originalBranch: "main" };
}

function extractKey(output: string | null | undefined, key: string): string {
  const m = String(output ?? "").match(new RegExp(`^${key}:\\s*(\\S+)`, "m"));
  return m ? m[1] : "";
}

// ── docker → matchlock image plumbing ─────────────────────────────────────

function dockerBuild(dockerfile: string, tag: string): void {
  const b = spawnSync("/usr/bin/docker", ["build", "-f", dockerfile, "-t", tag, "."], {
    cwd: FIXTURE_DOCKER_DIR,
    encoding: "utf-8",
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(
    b.status,
    0,
    `docker build ${dockerfile} failed (exit ${b.status}, signal ${b.signal}, error ${
      b.error ? b.error.message : "none"
    }):\n${(b.stdout || "").slice(-4000)}\n${(b.stderr || "").slice(-4000)}`,
  );
}

/** Stream `docker save <tag>` straight into `matchlock image import <tag>`. */
async function importImage(tag: string, homeDir: string): Promise<void> {
  const importEnv = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
  const save = spawn("/usr/bin/docker", ["save", tag], { stdio: ["ignore", "pipe", "pipe"] });
  const imp = spawn(MATCHLOCK_RPC_BIN, ["image", "import", tag], {
    stdio: ["pipe", "pipe", "pipe"],
    env: importEnv,
  });
  let saveErr = "";
  let impErr = "";
  save.stderr.on("data", (d) => (saveErr += d));
  imp.stderr.on("data", (d) => (impErr += d));
  save.stdout.pipe(imp.stdin);
  const saveCode = await new Promise<number | null>((res) => save.on("close", res));
  const impCode = await new Promise<number | null>((res) => imp.on("close", res));
  assert.equal(saveCode, 0, `docker save ${tag} failed: ${saveErr.slice(-2000)}`);
  assert.equal(impCode, 0, `matchlock image import ${tag} failed: ${impErr.slice(-2000)}`);
}

function resolveImage(tag: string, homeDir: string): { digest: string; config_digest: string } {
  const r = spawnSync(MATCHLOCK_RPC_BIN, ["image", "resolve", tag], {
    encoding: "utf-8",
    env: cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir }),
  });
  assert.equal(r.status, 0, `matchlock image resolve ${tag} failed: ${r.stderr}`);
  const identity = JSON.parse(r.stdout.trim()) as { digest: string; config_digest: string };
  assert.ok(
    identity.digest.startsWith("sha256:") && identity.config_digest.startsWith("sha256:"),
    `resolved identity for ${tag} incomplete: ${r.stdout.trim()}`,
  );
  return identity;
}

/**
 * Seed a fresh private matchlock image store from a content-addressed fixture
 * cache. The multi-GB positive blobs are HARDLINKED into the fresh home (same
 * inode — no extra disk; a copy fallback is used across filesystems), and the
 * small mutable metadata/tag files are COPIED so the fresh home owns its DB.
 */
function seedImageCache(srcCacheDir: string, targetHomeDir: string): void {
  const srcImages = path.join(srcCacheDir, "images");
  assert.ok(fs.existsSync(srcImages), `TAMANDUA_GATE_FIXTURE_IMAGE_CACHE has no images dir: ${srcImages}`);
  const dstImages = path.join(targetHomeDir, ".cache", "matchlock", "images");
  fs.mkdirSync(path.join(dstImages, "blobs"), { recursive: true });
  const linkOrCopy = (src: string, dst: string): void => {
    try {
      fs.linkSync(src, dst);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        fs.rmSync(dst, { force: true });
        fs.linkSync(src, dst);
        return;
      }
      fs.copyFileSync(src, dst); // cross-device / hardlink-unsupported fallback
    }
  };
  const blobsSrc = path.join(srcImages, "blobs");
  if (fs.existsSync(blobsSrc)) {
    for (const name of fs.readdirSync(blobsSrc)) {
      linkOrCopy(path.join(blobsSrc, name), path.join(dstImages, "blobs", name));
    }
  }
  for (const name of fs.readdirSync(srcImages)) {
    if (name === "blobs") continue;
    const src = path.join(srcImages, name);
    const dst = path.join(dstImages, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

/** Seed the private matchlock state's kernel cache (never mutates the source). */
function seedKernelCache(targetHome: string): void {
  const candidates = [
    process.env.TAMANDUA_GATE_KERNEL_CACHE ?? "",
    "/root/.cache/matchlock/kernels",
    "/home/kaladin/.cache/matchlock/kernels",
  ].filter((p) => p.length > 0);
  const src = candidates.find((p) => fs.existsSync(p));
  assert.ok(src, `kernel cache source missing; tried ${candidates.join(", ")}`);
  fs.cpSync(src, path.join(targetHome, ".cache", "matchlock", "kernels"), { recursive: true });
}

/** One mapped-store session row (the synthetic runner projects usage from it). */
interface HermesSessionRow {
  id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

/**
 * Read the mapped Hermes store's session rows on the host. The gate only ever
 * reads the store it created itself under its OWN evidence root (guarded by
 * realpath), never real/operator Hermes data — the runner projects usage
 * INSIDE the VM against the same mapped store.
 */
function readHermesStoreRows(storeDir: string): HermesSessionRow[] {
  const evRoot = fs.realpathSync(EVIDENCE_DIR);
  const real = fs.realpathSync(storeDir);
  if (real !== evRoot && !real.startsWith(evRoot + path.sep)) {
    throw new Error(`refusing to read a Hermes store outside the gate evidence root: ${storeDir}`);
  }
  const dbPath = path.join(storeDir, "state.db");
  if (!fs.existsSync(dbPath)) return [];
  const db = openE2eDatabase(dbPath);
  try {
    return db
      .prepare("SELECT id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions ORDER BY id")
      .all() as HermesSessionRow[];
  } finally {
    db.close();
  }
}

/** Per-row projected total (input + output + cache_write; cache_read EXCLUDED). */
function projectedTotal(row: HermesSessionRow): number {
  assert.ok(
    row.input_tokens !== null && row.output_tokens !== null && row.cache_write_tokens !== null,
    `NULL token column on mapped-store session ${row.id}`,
  );
  return Number(row.input_tokens) + Number(row.output_tokens) + Number(row.cache_write_tokens);
}

function readTokensSpent(tamanduaDir: string, runId: string): number {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as
      | { tokens_spent: number | null }
      | undefined;
    assert.ok(row, `run ${runId} missing from DB`);
    return Number(row.tokens_spent ?? 0);
  } finally {
    db.close();
  }
}

// ── shared state ──────────────────────────────────────────────────────────
let homeDir = "";
let tamanduaDir = "";
let originDir = "";
let originalBranch = "main";
let hermesHomeRoot = "";
let ledgerPath = "";
let assertionsLedgerPath = "";
let observedVmIds: string[] = [];

// ────────────────────────────────────────────────────────────────────────
// Injected failure controls (no real VM), run BEFORE the actual-VM path.
// These use the shared strict lifecycle helpers and prove that an inventory
// error / corrupt event ledger can never be certified as "clean".
// ────────────────────────────────────────────────────────────────────────
describe("matchlock hermes merge-worktree gate injected failure controls (mock/no real VM)", { concurrency: 1 }, () => {
  let ctrlRoot = "";

  before(() => {
    ctrlRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "mtlk-hermes-merge-controls-"));
  });

  after(() => {
    try {
      fs.rmSync(ctrlRoot, { recursive: true, force: true });
    } catch {
      /* owned scratch */
    }
  });

  it("a corrupt state DB throws from the strict inventory reader", () => {
    const home = fabricateVmHome(ctrlRoot, { db: "corrupt" });
    assert.throws(() => readVmInventory(home), /unreadable\/corrupt/);
  });

  it("absent state with observed VM ids fails cleanup and writes the ledger", () => {
    const home = fabricateVmHome(ctrlRoot, { db: "absent" });
    const ledger = path.join(ctrlRoot, "absent-ledger.txt");
    assert.throws(
      () => cleanupOwnedVms(home, ledger, ["vm-11223344"], { rpcBin: path.join(ctrlRoot, "no-rm") }),
      /state DB missing|state DB is MISSING|state DB missing after/i,
    );
    assert.ok(fs.existsSync(ledger), "ledger written on failure");
  });

  it("a failed exact-id close retains state and records every outcome", () => {
    const home = fabricateVmHome(ctrlRoot, { db: "rows", dirs: true });
    const fakeRm = path.join(ctrlRoot, "rm-fail");
    makeFakeMatchlock(fakeRm, "fail");
    const ledger = path.join(ctrlRoot, "fail-ledger.txt");
    assert.throws(
      () => cleanupOwnedVms(home, ledger, ["vm-11223344"], { rpcBin: fakeRm }),
      /failed to close cleanly/,
    );
    assert.ok(fs.existsSync(path.join(home, ".matchlock", "vms", "vm-11223344")), "state retained after failed close");
    assert.match(fs.readFileSync(ledger, "utf-8"), /NOT cleanly closed/);
  });

  it("a successful exact-id close leaves no owned rows/dirs", () => {
    const home = fabricateVmHome(ctrlRoot, { db: "rows", dirs: true });
    const fakeRm = path.join(ctrlRoot, "rm-ok");
    makeFakeMatchlock(fakeRm, "ok");
    const ledger = path.join(ctrlRoot, "ok-ledger.txt");
    cleanupOwnedVms(home, ledger, ["vm-11223344", "vm-55667788"], { rpcBin: fakeRm });
    assert.equal(readVmInventory(home).rows.length, 0);
  });

  it("readRunEvents treats corrupt event JSON as an error", () => {
    const home = fs.mkdtempSync(path.join(ctrlRoot, "events-"));
    const eventsDir = path.join(home, ".tamandua", "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(path.join(eventsDir, "corrupt.jsonl"), "not-json\n", "utf-8");
    assert.throws(() => readRunEvents(path.join(home, ".tamandua"), "corrupt"), /corrupt event JSON/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// The real-VM whole-path gate.
// ────────────────────────────────────────────────────────────────────────

async function runWholePathScenario(): Promise<void> {
  let daemon: ChildProcess | null = null;
  let portHandles: PortHandle[] = [];
  let controlPort = 0;
  let runId = "";
  try {
    portHandles = await reservePortHandles(1);
    controlPort = portHandles[0].port;
    fs.writeFileSync(path.join(tamanduaDir, "port"), String(controlPort), "utf-8");
    const scenarioEnv = gateEnv(homeDir, controlPort);
    await releasePortReservations({ portHandles });
    portHandles = [];

    daemon = await startIsolatedDaemon(homeDir, controlPort, scenarioEnv);
    try {
      const runArgs = [
        "workflow", "run", WORKFLOW_ID,
        "Synthetic whole-path hermes gate: implement the tiny owned fixture story and land it through the scoped guest merge path.",
        "--matchlock", FIXTURE_IMAGE_TAG,
        "--hermes-as-harness",
        "--worktree-origin-repository", originDir,
        "--worktree-origin-ref", originalBranch,
      ];
      const prefix = await spawnWorkflowRun(runArgs, scenarioEnv, 60_000);
      runId = resolveFullRunId(prefix, tamanduaDir);
      const status = await pollTerminalWithNudge(runId, scenarioEnv, tamanduaDir);
      assert.equal(status, "completed", `hermes: run must complete; got ${status}`);
      await sleep(500);
      assertNoOwnedVms(homeDir, "hermes merge whole-path post-run", {
        pollTimeoutMs: 120_000,
        rpcBin: MATCHLOCK_RPC_BIN,
        ledgerPath: assertionsLedgerPath,
      });
    } finally {
      if (daemon) {
        await stopIsolatedDaemon(daemon);
      }
      daemon = null;
    }

    // ── progress resource persisted ───────────────────────────────
    const progressFile = path.join(tamanduaDir, "runs", runId, "progress-resource", "progress.txt");
    assert.ok(fs.existsSync(progressFile), `hermes: guest progress document missing at ${progressFile}`);
    const progressText = fs.readFileSync(progressFile, "utf-8");
    assert.match(progressText, /stale-merge rc=/, "hermes: merger must record the real target-moved refusal");
    assert.match(progressText, /rebased onto/, "hermes: merger must record the real in-worktree rebase");

    // ── step DB: all steps done, tested tree + merged tree captured ─
    const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
    let testedTree = "";
    let mergedTree = "";
    let finalizeOutput = "";
    try {
      const rows = db
        .prepare(
          "SELECT step_id, agent_id, status, output, retry_count FROM steps WHERE run_id = ? ORDER BY step_index, rowid",
        )
        .all(runId) as Array<{
        step_id: string;
        agent_id: string;
        status: string;
        output: string | null;
        retry_count: number;
      }>;
      assert.ok(rows.length >= 6, `hermes: expected the full step set, got ${rows.length}`);
      for (const row of rows) {
        assert.equal(
          row.status,
          "done",
          `hermes: step ${row.step_id} (${row.agent_id}) not done (status=${row.status})`,
        );
      }
      for (const row of rows) {
        const tree = extractKey(row.output, "TESTED_TREE");
        if (tree) testedTree = tree;
        if (row.step_id === "finalize_merge") {
          finalizeOutput = row.output ?? "";
          mergedTree = extractKey(row.output, "MERGED_TREE") || mergedTree;
        }
      }
    } finally {
      db.close();
    }
    assert.match(testedTree, /^[0-9a-f]{40,64}$/, `hermes: tester/verifier TESTED_TREE missing/invalid (${testedTree})`);
    assert.match(finalizeOutput, /^STATUS: landed$/m, `hermes: finalizer did not report a real landing:\n${finalizeOutput}`);
    assert.match(finalizeOutput, /^REBASED: false$/m, "hermes: final landing must not be a rebase retry");
    assert.match(finalizeOutput, /^STATUS: done$/m, "hermes: finalizer must accept the landing");
    assert.equal(mergedTree, testedTree, "hermes: MERGED_TREE must equal the tested tree");

    // ── real target advance on the OWNED origin ───────────────────
    const targetTip = git(["rev-parse", `refs/heads/${originalBranch}`], originDir);
    const targetTree = git(["rev-parse", `refs/heads/${originalBranch}^{tree}`], originDir);
    assert.equal(targetTree, mergedTree, "hermes: origin target tree must equal the merged (tested) tree");
    assert.notEqual(targetTip, "", "hermes: target ref must resolve after landing");

    // ── real host-suite evidence row under the canonical namespace ─
    const expectedCmdHash = crypto.createHash("sha256").update(TEST_CMD_RAW).digest("hex");
    const suiteStore = path.join(tamanduaDir, "matchlock", "suite", "host-suite.db");
    assert.ok(fs.existsSync(suiteStore), `hermes: host suite store missing at ${suiteStore}`);
    const sdb = openE2eDatabase(suiteStore);
    try {
      const rows = sdb
        .prepare(
          "SELECT id, namespace_id, origin_repo, tree_hash, cmd_hash, exit_code, run_id, step_id, invocation_id FROM host_suite_results ORDER BY id",
        )
        .all() as Array<Record<string, unknown>>;
      const match = rows.find((r) => String(r.tree_hash) === testedTree && String(r.cmd_hash) === expectedCmdHash);
      assert.ok(
        match,
        `hermes: no host-suite row for tested tree ${testedTree} + cmd hash ${expectedCmdHash}; rows=${JSON.stringify(
          rows.map((r) => ({ t: r.tree_hash, c: r.cmd_hash, e: r.exit_code })),
        )}`,
      );
      assert.equal(Number(match!.exit_code), 0, "hermes: host-suite evidence must record exit 0 for the tested tree");
      assert.ok(String(match!.namespace_id).length > 0, "hermes: suite row must carry the canonical namespace id");
      assert.ok(String(match!.invocation_id).length > 0, "hermes: suite row must carry the host-bound invocation id");
      assert.equal(String(match!.run_id), runId, "hermes: suite row must be run-bound");
      const ns = sdb
        .prepare(
          "SELECT namespace_id, image_content_id, guest_platform, helper_contract, compatibility_fingerprint FROM host_suite_namespace WHERE namespace_id = ?",
        )
        .get(String(match!.namespace_id)) as Record<string, unknown> | undefined;
      assert.ok(ns, "hermes: suite row namespace missing from the namespace table");
      assert.equal(String(ns!.guest_platform), "linux/amd64", "hermes: canonical namespace platform");
      assert.ok(String(ns!.image_content_id ?? "").startsWith("sha256:"), "hermes: namespace image content pin");
    } finally {
      sdb.close();
    }

    // ── events: real target_moved retest loop + real landing ──────
    const events = readRunEvents(tamanduaDir, runId);
    const counts = new Map<string, number>();
    for (const e of events) {
      const name = String((e as { event?: unknown }).event ?? "");
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    assert.ok((counts.get("run.completed") ?? 0) === 1, "hermes: exactly one run.completed");
    const targetMovedSignal =
      (counts.get("merge.target_moved") ?? 0) >= 1 || (counts.get("step.rerouted") ?? 0) >= 1;
    assert.ok(
      targetMovedSignal,
      `hermes: expected a real per-story verify/target-moved loop (events: ${[...counts.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")})`,
    );
    assert.ok((counts.get("merge.landed") ?? 0) >= 1, "hermes: expected a real merge.landed event");
    for (const bad of [
      "run.matchlock_dispatch_refused",
      "run.matchlock_invocation_infra_failed",
      "run.harness_probe_failed",
      "run.instant_fail_loop",
    ]) {
      assert.equal(counts.get(bad) ?? 0, 0, `hermes: unexpected ${bad} event`);
    }

    // ── per-round mapped-store session recovery + usage projection ─
    // One authoritative session per invocation (probe + each role), recovered
    // by the runner from the stderr trailer (or the H2 store fallback when a
    // trailer is lost) and projected INSIDE the still-owned VM from the mapped
    // store. The exact ledger reconciliation below is the anti-borrow proof.
    const storeRows = readHermesStoreRows(hermesHomeRoot);
    assert.ok(
      storeRows.length >= MIN_OBSERVED_ROUNDS,
      `hermes: expected >= ${MIN_OBSERVED_ROUNDS} mapped store sessions across the roles, got ${storeRows.length}`,
    );
    const sessionIds = new Set<string>();
    let probeRows = 0;
    let workRows = 0;
    let storeTotal = 0;
    for (const row of storeRows) {
      const total = projectedTotal(row);
      assert.ok(total > 0, `hermes: session ${row.id} projected a non-positive total (${total})`);
      assert.ok(
        total === PROBE_TOKEN_TOTAL || total === WORK_TOKEN_TOTAL,
        `hermes: session ${row.id} has an unexpected projected total ${total} (expected probe ${PROBE_TOKEN_TOTAL} or work ${WORK_TOKEN_TOTAL})`,
      );
      assert.ok(!sessionIds.has(row.id), `hermes: duplicate mapped-store session id ${row.id}`);
      sessionIds.add(row.id);
      if (total === PROBE_TOKEN_TOTAL) probeRows += 1;
      else workRows += 1;
      storeTotal += total;
    }
    assert.equal(probeRows, EXPECTED_PROBES, `hermes: expected exactly ${EXPECTED_PROBES} probe session(s), got ${probeRows}`);
    assert.ok(workRows >= MIN_OBSERVED_ROUNDS - EXPECTED_PROBES, `hermes: expected >= ${MIN_OBSERVED_ROUNDS - EXPECTED_PROBES} work sessions, got ${workRows}`);

    // ── per-round token attribution landed EXACTLY ────────────────
    // runs.tokens_spent must equal Σ(projected mapped-store totals). A borrowed
    // session, a missed/failed recovery, a duplicated projection or a
    // fabricated zero cannot reconcile; every recovered round (trailer or the
    // H2 store fallback) must have landed its exact delta.
    const tokensSpent = readTokensSpent(tamanduaDir, runId);
    assert.equal(
      tokensSpent,
      storeTotal,
      `hermes: runs.tokens_spent (${tokensSpent}) must equal the Σ mapped-store projected totals (${storeTotal}) over ${storeRows.length} recovered session(s)`,
    );
    assert.ok(tokensSpent > 0, `hermes: runs.tokens_spent must be > 0 (got ${tokensSpent})`);

    // ── distinct fresh VM per invocation + positive cleanup ───────
    const vmIds = readRunnerVmEvidenceIds(path.join(tamanduaDir, "runs"), runId);
    observedVmIds.push(...vmIds);
    const distinct = new Set(vmIds);
    assert.ok(
      distinct.size >= MIN_DISTINCT_VMS,
      `hermes: expected >= ${MIN_DISTINCT_VMS} distinct fresh VMs, got ${distinct.size}: ${[...distinct].join(",")}`,
    );
    assert.equal(vmIds.length, distinct.size, "hermes: VM ids must never repeat (fresh VM per invocation)");

    const { ledger } = cleanupOwnedVms(homeDir, ledgerPath, vmIds, { rpcBin: MATCHLOCK_RPC_BIN });
    assert.ok(fs.existsSync(ledgerPath), "hermes: cleanup ledger must exist");
    assert.ok(
      ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
      "hermes: cleanup ledger must record completion with no leftovers",
    );
    assert.ok(
      ledger.some((l) => /already positively closed by the runner \(no row and no state dir\)/.test(l)),
      "hermes: cleanup must record the runner's positive close for every VM",
    );

    fs.writeFileSync(
      path.join(EVIDENCE_DIR, "whole-path-receipts.json"),
      JSON.stringify(
        {
          workflowId: WORKFLOW_ID,
          harness: "hermes",
          runId,
          testedTree,
          mergedTree,
          tokensSpent,
          storeTotal,
          observedRounds: storeRows.length,
          probeRows,
          workRows,
          freshVms: vmIds.length,
          distinctVms: distinct.size,
          vms: [...distinct].sort(),
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(
      `[matchlock-hermes-merge-worktree-gate] OK run=${runId} testedTree=${testedTree} rounds=${storeRows.length} probes=${probeRows} works=${workRows} vms=${vmIds.length} distinct=${distinct.size} tokens=${tokensSpent}`,
    );
  } finally {
    if (daemon) {
      try {
        await stopIsolatedDaemon(daemon);
      } catch {
        /* best-effort */
      }
      daemon = null;
    }
    await releasePortReservations({ portHandles }).catch(() => {});
    portHandles = [];
  }
}

// The real-VM scenario is opt-in: without the runner-provided environment a
// bare `node --test` of this file still runs the fast injected-failure controls
// above (green, no VM) while the real-VM describe is skipped.
const REAL_VM_GATE_ENABLED = EVIDENCE_DIR.length > 0 && MATCHLOCK_RPC_BIN.length > 0;
const realVmDescribe = REAL_VM_GATE_ENABLED ? describe : describe.skip;

realVmDescribe("matchlock hermes whole-path merge gate: real feature-dev-merge-worktree in fresh VMs", { concurrency: 1 }, () => {
  before(async () => {
    assertEnv();
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

    homeDir = path.join(EVIDENCE_DIR, "home");
    tamanduaDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(tamanduaDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".cache"), { recursive: true });
    fs.mkdirSync(path.join(EVIDENCE_DIR, "tmp"), { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".pi", "agent", "settings.json"),
      JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
      "utf-8",
    );
    fs.writeFileSync(path.join(tamanduaDir, "port"), "0", "utf-8");

    seedKernelCache(homeDir);

    // Default effective Hermes home root (<HOME>/.hermes) with a minimal config.
    hermesHomeRoot = path.join(homeDir, ".hermes");
    fs.mkdirSync(hermesHomeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(hermesHomeRoot, "config.yaml"),
      "terminal:\n  backend: local\n",
      "utf-8",
    );

    // ── build + import the TEST-ONLY derived fixture image ──────────
    // A content-addressed fixture cache (dev/test-speed seam) is HARDLINKED
    // into the fresh private home; otherwise the committed Dockerfile is
    // rebuilt + imported. Either way the resolved digest is content-pinned.
    if (FIXTURE_IMAGE_CACHE.length > 0) {
      seedImageCache(FIXTURE_IMAGE_CACHE, homeDir);
      const identity = resolveImage(FIXTURE_IMAGE_TAG, homeDir);
      assert.ok(identity.digest.startsWith("sha256:"));
    } else {
      dockerBuild(FIXTURE_DOCKERFILE, FIXTURE_IMAGE_TAG);
      await importImage(FIXTURE_IMAGE_TAG, homeDir);
      const identity = resolveImage(FIXTURE_IMAGE_TAG, homeDir);
      assert.ok(identity.digest.startsWith("sha256:"));
    }

    const env = gateEnv(homeDir, 0);
    cliMustSucceed(["workflow", "install", WORKFLOW_ID], env, `install ${WORKFLOW_ID}`);

    const fixturesDir = path.join(EVIDENCE_DIR, "fixtures");
    fs.mkdirSync(fixturesDir, { recursive: true });
    originDir = path.join(fixturesDir, "owned-origin-feature-dev");
    originalBranch = prepareOwnedOrigin(originDir).originalBranch;

    ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");
    assertionsLedgerPath = path.join(EVIDENCE_DIR, "vm-no-owned-assertions.txt");
  });

  after(async () => {
    if (homeDir && MATCHLOCK_RPC_BIN) {
      try {
        cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
      } catch {
        /* best-effort; the scenario owns its positive assertions */
      }
    }
    // ── observed-rounds honesty (TESTER-HONESTY item 3) ─────────────────
    // Record the distinct in-VM rounds this gate ACTUALLY observed and refuse
    // to certify a zero-round run (VM creation/probe failed before any round)
    // even if the node --test assertions above were bypassed.
    const errors: string[] = [];
    const observedRounds = new Set(observedVmIds).size;
    if (EVIDENCE_DIR.length > 0) {
      try {
        writeObservedRoundsEvidence(EVIDENCE_DIR, {
          gate: GATE_LABEL,
          observed_rounds: observedRounds,
          observed_vm_ids: observedVmIds,
          detail: `${GATE_LABEL}: ${observedRounds} distinct in-VM rounds observed`,
        });
      } catch (err) {
        errors.push(
          `observed-rounds evidence: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      assertObservedRoundsNonZero(GATE_LABEL, observedRounds, observedVmIds);
    } catch (err) {
      errors.push(`observed-rounds: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (errors.length > 0) {
      throw new Error(`gate after-hook cleanup failed:\n${errors.join("\n")}`);
    }
  });

  it(
    "feature-dev-merge-worktree (worktree) completes under the hermes Matchlock route with a real host landing, per-story verify loop and exact per-round usage projection",
    { timeout: 90 * 60_000 },
    async () => {
      await runWholePathScenario();
    },
  );
});

async function pollTerminalWithNudge(
  runIdArg: string,
  envArg: Record<string, string>,
  tamanduaDirArg: string,
): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runIdArg], {
      env: cleanChildEnv(envArg),
      encoding: "utf-8",
    });
    const out = result.stdout || result.stderr || "";
    const m = out.match(/^Status:\s+(\S+)/m);
    if (m) {
      lastStatus = m[1];
      if (["completed", "done", "failed", "canceled"].includes(lastStatus)) return lastStatus;
    }
    spawnSync(process.execPath, [cliPath, "nudge"], {
      env: cleanChildEnv(envArg),
      encoding: "utf-8",
    });
    await sleep(DEFAULT_POLL_MS);
  }
  let tail = "";
  try {
    const eventsPath = path.join(tamanduaDirArg, "events", `${runIdArg}.jsonl`);
    const lines = fs.readFileSync(eventsPath, "utf-8").trimEnd().split("\n");
    tail = lines.slice(-25).join("\n");
  } catch {
    /* ignore */
  }
  throw new Error(`timeout after ${RUN_TIMEOUT_MS}ms waiting for terminal status; last=${lastStatus || "(none)"}\n${tail}`);
}
