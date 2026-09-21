/******************************************************************************
 * ⚠️  SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-ALL-WORKFLOWS US-008 — the fresh-VM synthetic WHOLE-PATH gate for the
 * genuine bundled `feature-dev-merge-worktree` workflow under the **dsh**
 * Matchlock route.
 *
 * It is the dsh sibling of e2e-tests/matchlock-worktree-merge-gate.test.ts
 * (the pi whole-path merge gate). It drives the REAL isolated daemon →
 * scheduler → dsh Matchlock invocation runner → FRESH VMs path end-to-end for
 * the real bundled feature-dev-merge-worktree workflow, using a deterministic
 * TEST-ONLY "synthetic dsh" provided by an explicitly test-only derived fixture
 * image (e2e-tests/dsh-fixture/). NO provider credentials and NO model calls.
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand UNDER THE SHARED GATE
 * LOCK:
 *
 *   flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock \
 *     ./run-matchlock-dsh-merge-worktree-e2e-test
 *
 * (the runner builds first, resolves the pinned/system matchlock pair, creates
 * a NEW mkdtemp evidence directory outside the repo with a private TMPDIR
 * inside it, and runs this file with all logs tee'd into that directory).
 *
 * Real-VM acceptance (among others):
 *   - the genuine bundled feature-dev-merge-worktree run reaches real status
 *     "completed" through isolated daemon → fresh dsh VMs;
 *   - the per-story verify loop ran: the merger's stale-tip attempt drove the
 *     real target_moved → rebase → retest reroute (or the production typed
 *     MERGE_TIP refusal + step.rerouted), and a second merger invocation landed;
 *   - the tester's packed tamandua-test recorded a REAL host-suite row under the
 *     canonical namespace for the exact tested tree + raw TEST_CMD, and the
 *     finalizer ledger seam accepted it;
 *   - the guest merger (scoped `merge-branch`) performed a REAL final target
 *     advance on the tiny OWNED origin, MERGED_TREE == the tested tree;
 *   - dsh's private per-run profiles overlay held across the many dsh rounds on
 *     the same RW mounts: the private overlay root was observed live (carrying
 *     the install-derived `profiles/node_modules` farm), it was removed after
 *     the confirmed close, and the HOST `<DSH_HOME>/profiles` tree stayed
 *     byte-identical (no guest boot-sibling writer lock leaked to the host);
 *   - every probe/work/retry invocation used a DISTINCT fresh VM and every
 *     owned VM was positively closed/removed (strict exact-owned ledger);
 *   - per-round token attribution landed (`runs.tokens_spent > 0`).
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
import {
  DshOverlayObserver,
  prepareComposedDshHome,
  snapshotDshProfilesInvariance,
} from "./helpers/matchlock-dsh-gate-fixtures.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

const WORKFLOW_ID = "feature-dev-merge-worktree";
const FIXTURE_IMAGE_TAG = "tamandua-synthetic-dsh:gate-fixture";
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-dsh";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "dsh-fixture");

// ── environment: paired runtime ───────────────────────────────────────────
// The runner script resolves the runtime (system pair by default; optional
// explicit overrides) and validates/export the three names. The test only
// requires them to be exported and present.
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT = process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED = process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";
// The observed-rounds evidence / guard label for this gate. The runner passes
// the SAME label to scripts/observed-rounds-guard.mjs.
const GATE_LABEL = "dsh-merge-worktree";

const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 60 * 60_000;
const TEST_CMD_RAW = "node test.mjs";

// Distinct fresh VMs expected: plan/setup/implement/test/verify/review + the
// merger's retry re-validation + the final landing, PLUS one launch probe per
// work round. The minimum is deliberately conservative (>= the role count).
const MIN_DISTINCT_VMS = 8;
// Work rounds whose session artifacts must be present in the mapped DSH store
// (one per role invocation; probes add more).
const MIN_OBSERVED_ROUNDS = 6;

function assertEnv(): void {
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-dsh-merge-worktree-e2e-test)",
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
    TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN,
    MATCHLOCK_GUEST_INIT: GUEST_INIT,
    MATCHLOCK_GUEST_FUSED: GUEST_FUSED,
  };
  // dsh's default effective home is <HOME>/.dsh (an explicit DSH_HOME would
  // change the config root). The composed fixture pre-creates <HOME>/.dsh.
  delete env.DSH_HOME;
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
  fs.writeFileSync(path.join(originDir, "README.md"), "# Tiny owned origin (dsh whole-path gate)\n", "utf-8");
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
  fs.writeFileSync(path.join(originDir, ".gitignore"), "*.log\n.matchlock-synthetic-dsh/\n", "utf-8");
  git(["init", "-q", "-b", "main"], originDir);
  git(["config", "user.email", "gate@tamandua.test"], originDir);
  git(["config", "user.name", "Matchlock dsh Gate"], originDir);
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

/** Count the mapped-store session directories (one per dsh invocation). */
function countSessionDirs(sessionsRoot: string): number {
  if (!fs.existsSync(sessionsRoot)) return 0;
  let count = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith("session-")) count += 1;
      else walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(sessionsRoot, 0);
  return count;
}

/** Wait (bounded) until a path no longer exists. */
async function waitForRemoval(target: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(target)) return true;
    await sleep(200);
  }
  return !fs.existsSync(target);
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

let overlayHelpersMemo:
  | { root: (runId: string, liveStateRoot: string) => string }
  | undefined;
async function overlayRootForRun(runId: string): Promise<string> {
  if (!overlayHelpersMemo) {
    const mod = await import(`${repoRoot}/dist/installer/matchlock/dsh-profile-overlay.js`);
    overlayHelpersMemo = { root: (r, live) => mod.dshProfileOverlayRoot(r, live) as string };
  }
  return overlayHelpersMemo.root(runId, tamanduaDir);
}

// ── shared state ──────────────────────────────────────────────────────────
let homeDir = "";
let tamanduaDir = "";
let originDir = "";
let originalBranch = "main";
let dshHome = "";
let ledgerPath = "";
let assertionsLedgerPath = "";
let observedVmIds: string[] = [];
/** Last run id the whole-path scenario resolved, for failure-path evidence. */
let lastRunId = "";

// ────────────────────────────────────────────────────────────────────────
// Injected failure controls (no real VM), run BEFORE the actual-VM path.
// These use the shared strict lifecycle helpers and prove that an inventory
// error / corrupt event ledger can never be certified as "clean".
// ────────────────────────────────────────────────────────────────────────
describe("matchlock dsh merge-worktree gate injected failure controls (mock/no real VM)", { concurrency: 1 }, () => {
  let ctrlRoot = "";

  before(() => {
    ctrlRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "mtlk-dsh-merge-controls-"));
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
  const hostProfilesBefore = snapshotDshProfilesInvariance(dshHome);
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
        "Synthetic whole-path dsh gate: implement the tiny owned fixture story and land it through the scoped guest merge path.",
        "--matchlock", FIXTURE_IMAGE_TAG,
        "--dsh-as-harness",
        "--worktree-origin-repository", originDir,
        "--worktree-origin-ref", originalBranch,
      ];
      const prefix = await spawnWorkflowRun(runArgs, scenarioEnv, 60_000);
      runId = resolveFullRunId(prefix, tamanduaDir);
      lastRunId = runId;
      const overlayRoot = await overlayRootForRun(runId);
      const overlay = new DshOverlayObserver(overlayRoot, { intervalMs: 50 }).start();
      let status = "";
      try {
        status = await pollTerminalWithNudge(runId, scenarioEnv, tamanduaDir);
      } finally {
        // Always stop the observer (a timeout still retains the observation).
        const obs = overlay.stop();
        if (status === "completed") {
          assert.equal(obs.rootSeen, true, "dsh: the private per-run profiles overlay root must be observed while live");
          assert.ok(
            obs.dirs.includes(path.join("profiles", "node_modules")),
            `dsh: the private install-derived farm dir must exist in the overlay (${obs.dirs.join(", ")})`,
          );
          assert.ok(
            await waitForRemoval(overlayRoot, 60_000),
            `dsh: the private per-run overlay root must be removed after the confirmed close (${overlayRoot})`,
          );
        }
      }
      assert.equal(status, "completed", `dsh: run must complete; got ${status}`);
      await sleep(500);
      assertNoOwnedVms(homeDir, "dsh merge whole-path post-run", {
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

    // ── host profiles invariant across every dsh round ─────────────
    const hostProfilesAfter = snapshotDshProfilesInvariance(dshHome);
    assert.deepEqual(
      hostProfilesAfter,
      hostProfilesBefore,
      "dsh: the HOST <DSH_HOME>/profiles tree must stay byte-identical (guest install farm/boot lock must stay in the private overlay)",
    );

    // ── progress resource persisted ───────────────────────────────
    const progressFile = path.join(tamanduaDir, "runs", runId, "progress-resource", "progress.txt");
    assert.ok(fs.existsSync(progressFile), `dsh: guest progress document missing at ${progressFile}`);
    const progressText = fs.readFileSync(progressFile, "utf-8");
    assert.match(progressText, /stale-merge rc=/, "dsh: merger must record the real target-moved refusal");
    assert.match(progressText, /rebased onto/, "dsh: merger must record the real in-worktree rebase");

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
      assert.ok(rows.length >= 6, `dsh: expected the full step set, got ${rows.length}`);
      for (const row of rows) {
        assert.equal(
          row.status,
          "done",
          `dsh: step ${row.step_id} (${row.agent_id}) not done (status=${row.status})`,
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
    assert.match(testedTree, /^[0-9a-f]{40,64}$/, `dsh: tester/verifier TESTED_TREE missing/invalid (${testedTree})`);
    assert.match(finalizeOutput, /^STATUS: landed$/m, `dsh: finalizer did not report a real landing:\n${finalizeOutput}`);
    assert.match(finalizeOutput, /^REBASED: false$/m, "dsh: final landing must not be a rebase retry");
    assert.match(finalizeOutput, /^STATUS: done$/m, "dsh: finalizer must accept the landing");
    assert.equal(mergedTree, testedTree, "dsh: MERGED_TREE must equal the tested tree");

    // ── real target advance on the OWNED origin ───────────────────
    const targetTip = git(["rev-parse", `refs/heads/${originalBranch}`], originDir);
    const targetTree = git(["rev-parse", `refs/heads/${originalBranch}^{tree}`], originDir);
    assert.equal(targetTree, mergedTree, "dsh: origin target tree must equal the merged (tested) tree");
    assert.notEqual(targetTip, "", "dsh: target ref must resolve after landing");

    // ── real host-suite evidence row under the canonical namespace ─
    const expectedCmdHash = crypto.createHash("sha256").update(TEST_CMD_RAW).digest("hex");
    const suiteStore = path.join(tamanduaDir, "matchlock", "suite", "host-suite.db");
    assert.ok(fs.existsSync(suiteStore), `dsh: host suite store missing at ${suiteStore}`);
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
        `dsh: no host-suite row for tested tree ${testedTree} + cmd hash ${expectedCmdHash}; rows=${JSON.stringify(
          rows.map((r) => ({ t: r.tree_hash, c: r.cmd_hash, e: r.exit_code })),
        )}`,
      );
      assert.equal(Number(match!.exit_code), 0, "dsh: host-suite evidence must record exit 0 for the tested tree");
      assert.ok(String(match!.namespace_id).length > 0, "dsh: suite row must carry the canonical namespace id");
      assert.ok(String(match!.invocation_id).length > 0, "dsh: suite row must carry the host-bound invocation id");
      assert.equal(String(match!.run_id), runId, "dsh: suite row must be run-bound");
      const ns = sdb
        .prepare(
          "SELECT namespace_id, image_content_id, guest_platform, helper_contract, compatibility_fingerprint FROM host_suite_namespace WHERE namespace_id = ?",
        )
        .get(String(match!.namespace_id)) as Record<string, unknown> | undefined;
      assert.ok(ns, "dsh: suite row namespace missing from the namespace table");
      assert.equal(String(ns!.guest_platform), "linux/amd64", "dsh: canonical namespace platform");
      assert.ok(String(ns!.image_content_id ?? "").startsWith("sha256:"), "dsh: namespace image content pin");
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
    assert.ok((counts.get("run.completed") ?? 0) === 1, "dsh: exactly one run.completed");
    const targetMovedSignal =
      (counts.get("merge.target_moved") ?? 0) >= 1 || (counts.get("step.rerouted") ?? 0) >= 1;
    assert.ok(
      targetMovedSignal,
      `dsh: expected a real per-story verify/target-moved loop (events: ${[...counts.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")})`,
    );
    assert.ok((counts.get("merge.landed") ?? 0) >= 1, "dsh: expected a real merge.landed event");
    for (const bad of [
      "run.matchlock_dispatch_refused",
      "run.matchlock_invocation_infra_failed",
      "run.harness_probe_failed",
      "run.instant_fail_loop",
    ]) {
      assert.equal(counts.get(bad) ?? 0, 0, `dsh: unexpected ${bad} event`);
    }

    // ── per-round token attribution landed ────────────────────────
    const tokensSpent = readTokensSpent(tamanduaDir, runId);
    assert.ok(tokensSpent > 0, `dsh: runs.tokens_spent must be > 0 (got ${tokensSpent})`);

    // ── observed rounds / mapped session store ────────────────────
    const observedRounds = countSessionDirs(path.join(dshHome, "sessions"));
    assert.ok(
      observedRounds >= MIN_OBSERVED_ROUNDS,
      `dsh: expected >= ${MIN_OBSERVED_ROUNDS} mapped dsh session rounds across the roles, got ${observedRounds}`,
    );

    // ── distinct fresh VM per invocation + positive cleanup ───────
    const vmIds = readRunnerVmEvidenceIds(path.join(tamanduaDir, "runs"), runId);
    observedVmIds.push(...vmIds);
    const distinct = new Set(vmIds);
    assert.ok(
      distinct.size >= MIN_DISTINCT_VMS,
      `dsh: expected >= ${MIN_DISTINCT_VMS} distinct fresh VMs, got ${distinct.size}: ${[...distinct].join(",")}`,
    );
    assert.equal(vmIds.length, distinct.size, "dsh: VM ids must never repeat (fresh VM per invocation)");

    const { ledger } = cleanupOwnedVms(homeDir, ledgerPath, vmIds, { rpcBin: MATCHLOCK_RPC_BIN });
    assert.ok(fs.existsSync(ledgerPath), "dsh: cleanup ledger must exist");
    assert.ok(
      ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
      "dsh: cleanup ledger must record completion with no leftovers",
    );
    assert.ok(
      ledger.some((l) => /already positively closed by the runner \(no row and no state dir\)/.test(l)),
      "dsh: cleanup must record the runner's positive close for every VM",
    );

    fs.writeFileSync(
      path.join(EVIDENCE_DIR, "whole-path-receipts.json"),
      JSON.stringify(
        {
          workflowId: WORKFLOW_ID,
          harness: "dsh",
          runId,
          testedTree,
          mergedTree,
          tokensSpent,
          observedRounds,
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
      `[matchlock-dsh-merge-worktree-gate] OK run=${runId} testedTree=${testedTree} rounds=${observedRounds} vms=${vmIds.length} distinct=${distinct.size} tokens=${tokensSpent}`,
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

realVmDescribe("matchlock dsh whole-path merge gate: real feature-dev-merge-worktree in fresh VMs", { concurrency: 1 }, () => {
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

    // Composed dsh config root at the DEFAULT effective home (<HOME>/.dsh).
    dshHome = path.join(homeDir, ".dsh");
    prepareComposedDshHome(dshHome);

    // ── build + import the TEST-ONLY derived fixture image ──────────
    dockerBuild(FIXTURE_DOCKERFILE, FIXTURE_IMAGE_TAG);
    await importImage(FIXTURE_IMAGE_TAG, homeDir);
    const identity = resolveImage(FIXTURE_IMAGE_TAG, homeDir);
    assert.ok(identity.digest.startsWith("sha256:"));

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
    // When the whole-path scenario aborted before its success-path collection,
    // recover the runner's retained per-VM evidence straight from the run's
    // matchlock dirs so the evidence reflects the in-VM rounds that really ran.
    // The gate stays RED either way; this only keeps the round count truthful.
    if (observedVmIds.length === 0 && lastRunId && tamanduaDir) {
      try {
        observedVmIds.push(
          ...readRunnerVmEvidenceIds(path.join(tamanduaDir, "runs"), lastRunId),
        );
      } catch {
        /* best-effort evidence recovery; the strict guard below still applies */
      }
    }
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
    "feature-dev-merge-worktree (worktree) completes under the dsh Matchlock route with a real host landing, per-story verify loop and private profiles overlay",
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
