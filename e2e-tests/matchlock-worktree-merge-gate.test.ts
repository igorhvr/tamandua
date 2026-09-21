/******************************************************************************
 * ⚠️  SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-WORKFLOWS US-009 — the actual fresh-VM synthetic WHOLE-PATH gate for the
 * genuine bundled `feature-dev-merge-worktree` workflow.
 *
 * This gate drives the REAL isolated daemon → scheduler → Matchlock invocation
 * runner → FRESH Matchlock VM path end-to-end for the real bundled
 * feature-dev-merge-worktree workflow, using a deterministic TEST-ONLY
 * "synthetic pi" provided by an explicitly test-only derived fixture image
 * (e2e-tests/matchlock-fixture/). NO provider credentials and NO model calls.
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand:
 *
 *   ./run-matchlock-worktree-merge-e2e-test
 *
 * which builds first, resolves the paired runtime binaries (unpinned), creates a NEW
 * mkdtemp evidence directory (outside the repo; never pre-cleaned) and runs
 * this file with a private isolated HOME/STATE/DB/TMPDIR inside it.
 *
 * Real-VM acceptance (among others):
 *   - the genuine bundled feature-dev-merge-worktree run reaches real status
 *     "completed" through isolated daemon → fresh VMs;
 *   - the tester's packed tamandua-test records a REAL host-suite row under the
 *     canonical namespace for the exact tested tree + TEST_CMD, and the US-006
 *     finalizer ledger seam accepts it;
 *   - the guest merge-branch (US-007) performs a REAL final target advance on
 *     the tiny OWNED origin, with MERGED_TREE == the tested tree, including a
 *     real target_moved → rebase → retest loop;
 *   - every probe/work/retry invocation used a DISTINCT fresh VM id and every
 *     owned VM was positively closed (cleanup ledger); a failed disposal FAILS
 *     the gate and RETAINS state (never erased to look clean);
 *   - all fixtures/evidence are retained in the NEW mkdtemp evidence dir.
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB under the evidence dir, schema10
 * only there, TAMANDUA_TEST_GUARD auto-active under node:test, random control
 * port, never the live worker daemon. Never touches live branches.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanChildEnv, reservePortHandles, type PortHandle } from "../tests/helpers/test-env.ts";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
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
import { runMergeCore } from "../dist/installer/matchlock/merge-core.js";
import { runPlumbingMerge } from "../dist/installer/merge-branch.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

const WORKFLOW_ID = "feature-dev-merge-worktree";
const FIXTURE_IMAGE_TAG = "tamandua-synthetic-pi:worktree-merge-gate-fixture";
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-pi";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "matchlock-fixture");

// ── environment: resolved (unpinned) paired runtime ────────────────────────────────────
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT = process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED = process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";

// Observed-rounds honesty (TESTER-HONESTY item 3): the label shared by this
// driver and its runner's `scripts/observed-rounds-guard.mjs` invocation.
const GATE_LABEL = "worktree-merge";

const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 40 * 60_000;
const TEST_CMD_RAW = "node test.mjs";

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
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-worktree-merge-e2e-test)",
  );
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

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}

/** Create a tiny OWNED origin repo with a deterministic committed test script. */
function prepareOwnedOrigin(originDir: string, opts: { detach?: boolean } = {}): { originalBranch: string } {
  fs.mkdirSync(path.join(originDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(originDir, "README.md"), "# Tiny owned origin (Matchlock whole-path gate)\n", "utf-8");
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
  fs.writeFileSync(path.join(originDir, ".gitignore"), "*.log\n.matchlock-synthetic-pi/\n", "utf-8");
  git(["init", "-q", "-b", "main"], originDir);
  git(["config", "user.email", "gate@tamandua.test"], originDir);
  git(["config", "user.name", "Matchlock Gate"], originDir);
  git(["add", "-A"], originDir);
  git(["commit", "-q", "-m", "initial owned origin fixture"], originDir);
  if (opts.detach !== false) {
    // Detach the origin checkout so the run's target ref is not the checked-out
    // branch (the merger must never switch the origin checkout). The direct
    // (non-worktree) route launches the harness IN this checkout, so it must
    // stay ON the original branch so run creation can seed original_branch.
    git(["checkout", "-q", "--detach"], originDir);
  }
  return { originalBranch: "main" };
}

function extractKey(output: string | null | undefined, key: string): string {
  const m = String(output ?? "").match(new RegExp(`^${key}:\\s*(\\S+)`, "m"));
  return m ? m[1] : "";
}

// ── shared state ──────────────────────────────────────────────────────────
let homeDir = "";
let tamanduaDir = "";
let env: Record<string, string> = {};
let ledgerPath = "";
let assertionsLedgerPath = "";
let observedVmIds: string[] = [];

// ────────────────────────────────────────────────────────────────────────
// Injected failure controls (no real VM), run BEFORE the actual-VM path.
// ────────────────────────────────────────────────────────────────────────
describe(
  "matchlock worktree-merge gate cleanup/inventory INJECTED FAILURE CONTROLS (mock/no real VM)",
  { concurrency: 1 },
  () => {
    let ctrlRoot = "";

    before(() => {
      ctrlRoot = tamanduaTempDir("mtlk-worktree-merge-controls-");
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
        /state DB missing|state DB is MISSING/i,
      );
      assert.ok(fs.existsSync(ledger), "ledger written on failure");
    });

    it("a failed exact-id close retains state and records every outcome", () => {
      const home = fabricateVmHome(ctrlRoot, { db: "rows", dirs: true });
      const fakeRm = path.join(ctrlRoot, "rm-fail");
      makeFakeMatchlock(fakeRm, "fail");
      const ledger = path.join(ctrlRoot, "fail-ledger.txt");
      assert.throws(() => cleanupOwnedVms(home, ledger, ["vm-11223344"], { rpcBin: fakeRm }), /failed to close cleanly/);
      assert.ok(
        fs.existsSync(path.join(home, ".matchlock", "vms", "vm-11223344")),
        "state retained after failed close",
      );
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
  },
);

// ────────────────────────────────────────────────────────────────────────
// Merge preservation controls (no VM): the shared guest merge core must match
// the native runPlumbingMerge for no-op, conflicts and dirty-target parking on
// two identical owned fixtures. This pins criterion 4 mechanically before the
// whole-path VM run.
// ────────────────────────────────────────────────────────────────────────
const FIXED_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Tamandua Gate",
  GIT_AUTHOR_EMAIL: "gate@tamandua.test",
  GIT_COMMITTER_NAME: "Tamandua Gate",
  GIT_COMMITTER_EMAIL: "gate@tamandua.test",
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
  GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  GIT_CONFIG_NOSYSTEM: "1",
};
const FIXED_NOW = (): Date => new Date("2026-01-02T03:04:05.000Z");

function mergeControlGitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...FIXED_ENV,
  };
}

function mcGit(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: mergeControlGitEnv(),
  });
  return { stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), status: r.status ?? -1 };
}

function mcGitMust(cwd: string, args: string[]): string {
  const r = mcGit(cwd, args);
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

const mcRunner = (cwd: string, args: string[]) => mcGit(cwd, args);

interface MergeControlFixture {
  repo: string;
  initial: string;
}

function createMergeControlFixture(): MergeControlFixture {
  const repo = tamanduaTempDir("tamandua-mc-control-");
  mcGitMust(repo, ["init", "--initial-branch=main"]);
  mcGitMust(repo, ["config", "user.email", "gate@tamandua.test"]);
  mcGitMust(repo, ["config", "user.name", "Tamandua Gate"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf-8");
  mcGitMust(repo, ["add", "base.txt"]);
  mcGitMust(repo, ["commit", "-m", "base"]);
  return { repo, initial: mcGitMust(repo, ["rev-parse", "HEAD"]) };
}

function featureBranch(fixture: MergeControlFixture, branch: string, file: string, content: string, mutateBase = false): void {
  mcGitMust(fixture.repo, ["switch", "-c", branch]);
  if (mutateBase) fs.writeFileSync(path.join(fixture.repo, "base.txt"), content, "utf-8");
  else fs.writeFileSync(path.join(fixture.repo, file), content, "utf-8");
  mcGitMust(fixture.repo, ["add", "-A"]);
  mcGitMust(fixture.repo, ["commit", "-m", `feat ${branch}`]);
  mcGitMust(fixture.repo, ["switch", "main"]);
}

function assertMergeParity(
  label: string,
  prepare: (fixture: MergeControlFixture) => void,
  paramsFor: (fixture: MergeControlFixture) => { branch: string; into: string; expectTip: string },
  assertOutcome?: (result: { status: string; exitCode: number }, label: string) => void,
): void {
  const native = createMergeControlFixture();
  prepare(native);
  const core = createMergeControlFixture();
  prepare(core);
  assert.equal(native.initial, core.initial, `${label}: deterministic fixtures share initial tip`);
  const np = { origin: native.repo, message: "gate control\n", ...paramsFor(native) };
  const cp = { origin: core.repo, message: "gate control\n", ...paramsFor(core) };
  const nativeEvents: unknown[] = [];
  const coreEvents: unknown[] = [];
  const nativeResult = runPlumbingMerge(np, {
    runGit: mcRunner,
    emitEvent: (e) => nativeEvents.push(e),
    now: FIXED_NOW,
  });
  const coreResult = runMergeCore(cp, {
    runGit: mcRunner,
    emitEvent: (e) => coreEvents.push(e),
    now: FIXED_NOW,
  });
  assert.equal(coreResult.status, nativeResult.status, `${label}: status parity`);
  assert.equal(coreResult.exitCode, nativeResult.exitCode, `${label}: exit-code parity`);
  assert.equal(coreEvents.length, nativeEvents.length, `${label}: event-count parity`);
  assertOutcome?.(coreResult, label);
}

describe("matchlock worktree-merge gate preservation controls (no VM)", { concurrency: 1 }, () => {
  it("guest merge core == native for no-op, conflicts and dirty-target parking", () => {
    // no-op: branch == target => NOOP landed exit 0, no ref change.
    assertMergeParity(
      "no-op",
      () => {},
      (fixture) => {
        const tip = mcGitMust(fixture.repo, ["rev-parse", "refs/heads/main"]);
        return { branch: "main", into: "main", expectTip: tip };
      },
      (result, label) => {
        assert.equal(result.status, "landed", `${label}: no-op is a landed noop`);
        assert.equal(result.exitCode, 0, `${label}: no-op exit 0`);
      },
    );

    // conflicts: divergent edits to the same tracked file => conflict exit 3.
    assertMergeParity(
      "conflicts",
      (fixture) => {
        featureBranch(fixture, "feature", "base.txt", "feature\n", true);
        mcGitMust(fixture.repo, ["commit", "--allow-empty", "-m", "noop"]);
        fs.writeFileSync(path.join(fixture.repo, "base.txt"), "other\n", "utf-8");
        mcGitMust(fixture.repo, ["add", "base.txt"]);
        mcGitMust(fixture.repo, ["commit", "-m", "target other"]);
      },
      (fixture) => {
        const tip = mcGitMust(fixture.repo, ["rev-parse", "refs/heads/main"]);
        return { branch: "feature", into: "main", expectTip: tip };
      },
      (result, label) => {
        assert.equal(result.status, "conflicts", `${label}: divergent edits conflict`);
        assert.equal(result.exitCode, 3, `${label}: conflicts exit 3`);
      },
    );

    // dirty-target: a clean FF landing parks the dirty origin checkout.
    assertMergeParity(
      "dirty-target",
      (fixture) => {
        featureBranch(fixture, "feature", "feature.txt", "feature\n");
        // Leave uncommitted tracked content in the origin checkout.
        fs.writeFileSync(path.join(fixture.repo, "base.txt"), "base\nlocal dirty\n", "utf-8");
      },
      (fixture) => {
        const tip = mcGitMust(fixture.repo, ["rev-parse", "refs/heads/main"]);
        return { branch: "feature", into: "main", expectTip: tip };
      },
      (result, label) => {
        assert.equal(result.status, "landed", `${label}: dirty target still lands the ref`);
        assert.equal(result.exitCode, 0, `${label}: dirty-target exit 0`);
      },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// The real-VM whole-path gates.
//
// US-009 qualified the feature-dev-merge-worktree worktree route. US-010
// qualifies the bug-fix-merge-worktree worktree route AND the
// capability-equivalent DIRECT merge route (bug-fix-merge, launched from INSIDE
// the owned origin checkout so run creation seeds original_branch). Every
// scenario gets its own tiny owned origin, its own daemon/control port and its
// own positive exact-owned VM cleanup; all scenarios share one imported
// fixture image and one retained evidence directory.
// ────────────────────────────────────────────────────────────────────────

type WorkspaceMode = "worktree" | "direct";

interface WholePathScenario {
  workflowId: string;
  workspaceMode: WorkspaceMode;
  originDir: string;
  originalBranch: string;
  /** Minimum distinct fresh VMs expected for this workflow's role count. */
  minVms: number;
  label: string;
}

/**
 * Drive ONE genuine bundled merge workflow through the isolated daemon →
 * scheduler → Matchlock runner → fresh-VM path and assert the real acceptance
 * surface (run completion, all steps done, tested/merged tree attestation, real
 * owned-origin target advance, real host-suite evidence row under the canonical
 * namespace, target-moved/rebase/retest loop, distinct fresh VM per invocation,
 * positive cleanup ledger).
 */
async function runWholePathScenario(scenario: WholePathScenario): Promise<void> {
  let daemon: ChildProcess | null = null;
  let portHandles: PortHandle[] = [];
  let controlPort = 0;
  try {
    portHandles = await reservePortHandles(1);
    controlPort = portHandles[0].port;
    fs.writeFileSync(path.join(tamanduaDir, "port"), String(controlPort), "utf-8");
    const scenarioEnv = gateEnv(homeDir, controlPort);
    // Release the reservation so the isolated daemon can bind its own control
    // port (the reservation only guarantees the port was free at allocation).
    await releasePortReservations({ portHandles });
    portHandles = [];

    daemon = await startIsolatedDaemon(homeDir, controlPort, scenarioEnv);
    let runId = "";
    try {
      const runArgs = [
        "workflow", "run", scenario.workflowId,
        `Synthetic whole-path gate (${scenario.label}): implement the tiny owned fixture story and land it through the scoped guest merge path.`,
        "--matchlock", FIXTURE_IMAGE_TAG,
      ];
      if (scenario.workspaceMode === "worktree") {
        runArgs.push(
          "--worktree-origin-repository", scenario.originDir,
          "--worktree-origin-ref", scenario.originalBranch,
        );
      }
      const prefix = await spawnWorkflowRun(
        runArgs,
        scenarioEnv,
        60_000,
        scenario.workspaceMode === "direct" ? scenario.originDir : undefined,
      );
      runId = resolveFullRunId(prefix, tamanduaDir);
      const status = await pollTerminalWithNudge(runId, scenarioEnv, tamanduaDir);
      assert.equal(status, "completed", `${scenario.label}: run must complete; got ${status}`);
      await sleep(500);
      // The runner itself must have captured + removed every probe/work VM:
      // assert NO owned row/state dir remains while the daemon is still up so
      // its in-flight runner teardown can settle. This runs BEFORE any
      // gate-side `matchlock rm`.
      assertNoOwnedVms(homeDir, `${scenario.label}: post-run`, {
        pollTimeoutMs: 120_000,
        rpcBin: MATCHLOCK_RPC_BIN,
        ledgerPath: assertionsLedgerPath,
      });
    } finally {
      try {
        if (daemon) await stopIsolatedDaemon(daemon);
      } finally {
        daemon = null;
      }
    }

    // ── progress resource persisted ───────────────────────────────
    const progressFile = path.join(tamanduaDir, "runs", runId, "progress-resource", "progress.txt");
    assert.ok(fs.existsSync(progressFile), `${scenario.label}: guest progress document missing at ${progressFile}`);
    const progressText = fs.readFileSync(progressFile, "utf-8");
    assert.match(progressText, /stale-merge rc=/, `${scenario.label}: merger must record the real target-moved refusal`);
    assert.match(progressText, /rebased onto/, `${scenario.label}: merger must record the real in-worktree rebase`);

    // ── step DB: all steps done, tested tree + merged tree captured ─
    const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
    let testedTree = "";
    let mergedTree = "";
    let finalizeOutput = "";
    try {
      const rows = db
        .prepare("SELECT step_id, agent_id, status, output, retry_count FROM steps WHERE run_id = ? ORDER BY step_index, rowid")
        .all(runId) as Array<{
        step_id: string;
        agent_id: string;
        status: string;
        output: string | null;
        retry_count: number;
      }>;
      assert.ok(rows.length >= 6, `${scenario.label}: expected the full step set, got ${rows.length}`);
      for (const row of rows) {
        assert.equal(
          row.status,
          "done",
          `${scenario.label}: step ${row.step_id} (${row.agent_id}) not done (status=${row.status})`,
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
    assert.match(testedTree, /^[0-9a-f]{40,64}$/, `${scenario.label}: tester/verifier TESTED_TREE missing/invalid (${testedTree})`);
    assert.match(finalizeOutput, /^STATUS: landed$/m, `${scenario.label}: finalizer did not report a real landing:\n${finalizeOutput}`);
    assert.match(finalizeOutput, /^REBASED: false$/m, `${scenario.label}: final landing must not be a rebase retry`);
    assert.match(finalizeOutput, /^STATUS: done$/m, `${scenario.label}: finalizer must accept the landing`);
    assert.equal(mergedTree, testedTree, `${scenario.label}: MERGED_TREE must equal the tested tree`);

    // ── real target advance on the OWNED origin ───────────────────
    const targetTip = git(["rev-parse", `refs/heads/${scenario.originalBranch}`], scenario.originDir);
    const targetTree = git(["rev-parse", `refs/heads/${scenario.originalBranch}^{tree}`], scenario.originDir);
    assert.equal(targetTree, mergedTree, `${scenario.label}: origin target tree must equal the merged (tested) tree`);
    assert.notEqual(targetTip, "", `${scenario.label}: target ref must resolve after landing`);

    // ── real host-suite evidence row under the canonical namespace ─
    const expectedCmdHash = crypto.createHash("sha256").update(TEST_CMD_RAW).digest("hex");
    const suiteStore = path.join(tamanduaDir, "matchlock", "suite", "host-suite.db");
    assert.ok(fs.existsSync(suiteStore), `${scenario.label}: host suite store missing at ${suiteStore}`);
    const sdb = openE2eDatabase(suiteStore);
    try {
      const rows = sdb
        .prepare(
          "SELECT id, namespace_id, origin_repo, tree_hash, cmd_hash, exit_code, run_id, step_id, invocation_id FROM host_suite_results ORDER BY id",
        )
        .all() as Array<Record<string, unknown>>;
      const match = rows.find(
        (r) => String(r.tree_hash) === testedTree && String(r.cmd_hash) === expectedCmdHash,
      );
      assert.ok(
        match,
        `${scenario.label}: no host-suite row for tested tree ${testedTree} + cmd hash ${expectedCmdHash}; rows=${JSON.stringify(rows.map((r) => ({ t: r.tree_hash, c: r.cmd_hash, e: r.exit_code })))}`,
      );
      assert.equal(Number(match!.exit_code), 0, `${scenario.label}: host-suite evidence must record exit 0 for the tested tree`);
      assert.ok(String(match!.namespace_id).length > 0, `${scenario.label}: suite row must carry the canonical namespace id`);
      assert.ok(String(match!.invocation_id).length > 0, `${scenario.label}: suite row must carry the host-bound invocation id`);
      assert.equal(String(match!.run_id), runId, `${scenario.label}: suite row must be run-bound`);
      const ns = sdb
        .prepare(
          "SELECT namespace_id, image_content_id, guest_platform, helper_contract, compatibility_fingerprint FROM host_suite_namespace WHERE namespace_id = ?",
        )
        .get(String(match!.namespace_id)) as Record<string, unknown> | undefined;
      assert.ok(ns, `${scenario.label}: suite row namespace missing from the namespace table`);
      assert.equal(String(ns!.guest_platform), "linux/amd64", `${scenario.label}: canonical namespace platform`);
      assert.ok(String(ns!.image_content_id ?? "").startsWith("sha256:"), `${scenario.label}: namespace image content pin`);
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
    assert.ok((counts.get("run.completed") ?? 0) === 1, `${scenario.label}: exactly one run.completed`);
    // The real target-moved → rebase → retest loop: the merger's stale-tip
    // attempt is refused for the moved target, the run reroutes back to the
    // upstream producer, and a fresh merger invocation lands the rebased tree.
    // The production authorized path refuses the moved tip BEFORE any Git
    // (typed MERGE_TIP), so a merge.target_moved event is emitted only when the
    // tip moves between authorization and the guest core read; both shapes are
    // accepted as the real loop, but at least one must appear.
    const targetMovedSignal =
      (counts.get("merge.target_moved") ?? 0) >= 1 || (counts.get("step.rerouted") ?? 0) >= 1;
    assert.ok(
      targetMovedSignal,
      `${scenario.label}: expected a real target-moved loop (events: ${[...counts.entries()].map(([k, v]) => `${k}=${v}`).join(", ")})`,
    );
    assert.ok((counts.get("merge.landed") ?? 0) >= 1, `${scenario.label}: expected a real merge.landed event`);
    for (const bad of [
      "run.matchlock_dispatch_refused",
      "run.matchlock_invocation_infra_failed",
      "run.harness_probe_failed",
      "run.instant_fail_loop",
    ]) {
      assert.equal(counts.get(bad) ?? 0, 0, `${scenario.label}: unexpected ${bad} event`);
    }

    // ── distinct fresh VM per invocation + positive cleanup ───────
    // After US-004/US-005 the runner removes every VM after a positively
    // confirmed close, so the VM rows/state dirs are (correctly) GONE by now —
    // assertNoOwnedVms already proved that. The deterministic post-run proof
    // of a distinct fresh VM per invocation is the runner's retained evidence:
    // one directory per removed VM at
    // <state>/runs/<bareRunId>/matchlock/<vmId>/.
    const vmIds = readRunnerVmEvidenceIds(path.join(tamanduaDir, "runs"), runId);
    observedVmIds.push(...vmIds);
    const distinct = new Set(vmIds);
    assert.ok(
      distinct.size >= scenario.minVms,
      `${scenario.label}: expected >= ${scenario.minVms} distinct fresh VMs, got ${distinct.size}: ${[...distinct].join(",")}`,
    );
    assert.equal(vmIds.length, distinct.size, `${scenario.label}: VM ids must never repeat (fresh VM per invocation)`);

    const { ledger } = cleanupOwnedVms(homeDir, ledgerPath, vmIds, { rpcBin: MATCHLOCK_RPC_BIN });
    assert.ok(fs.existsSync(ledgerPath), `${scenario.label}: cleanup ledger must exist`);
    assert.ok(
      ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
      `${scenario.label}: cleanup ledger must record completion with no leftovers`,
    );
    assert.ok(
      ledger.some((l) => /already positively closed by the runner \(no row and no state dir\)/.test(l)),
      `${scenario.label}: cleanup must record the runner's positive close for every VM`,
    );

    console.log(
      `[matchlock-whole-path-gate] OK workflow=${scenario.workflowId} mode=${scenario.workspaceMode} run=${runId} testedTree=${testedTree} vms=${vmIds.length} distinct=${distinct.size}`,
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

describe(
  "matchlock whole-path gate: real bundled merge workflows in fresh VMs",
  { concurrency: 1 },
  () => {
    let fdOrigin = "";
    let bfOrigin = "";
    let directOrigin = "";

    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

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

      const kernelSrc = "/root/.cache/matchlock/kernels";
      assert.ok(fs.existsSync(kernelSrc), `kernel cache source missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), { recursive: true });

      // ── build + import the TEST-ONLY derived fixture image ──────────
      const dockerBuild = spawnSync(
        "/usr/bin/docker",
        ["build", "-f", FIXTURE_DOCKERFILE, "-t", FIXTURE_IMAGE_TAG, "."],
        { cwd: FIXTURE_DOCKER_DIR, encoding: "utf-8", env: inheritedProcessEnv(), maxBuffer: 64 * 1024 * 1024 },
      );
      assert.equal(
        dockerBuild.status,
        0,
        `docker build of the synthetic fixture failed (exit ${dockerBuild.status}):\n${(dockerBuild.stdout || "").slice(-4000)}\n${(dockerBuild.stderr || "").slice(-4000)}`,
      );
      const fixtureTar = path.join(EVIDENCE_DIR, "fixture-image.tar");
      const saveOutFd = fs.openSync(fixtureTar, "w");
      const dockerSave = spawnSync("/usr/bin/docker", ["save", FIXTURE_IMAGE_TAG], {
        stdio: ["ignore", saveOutFd, "pipe"],
        env: inheritedProcessEnv(),
      });
      fs.closeSync(saveOutFd);
      assert.equal(dockerSave.status, 0, `docker save of the synthetic fixture failed: ${dockerSave.stderr}`);
      const importEnv = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
      const saveInFd = fs.openSync(fixtureTar, "r");
      const imageImport = spawnSync(MATCHLOCK_RPC_BIN, ["image", "import", FIXTURE_IMAGE_TAG], {
        encoding: "utf-8",
        stdio: [saveInFd, "pipe", "pipe"],
        env: importEnv,
      });
      fs.closeSync(saveInFd);
      assert.equal(imageImport.status, 0, `matchlock image import failed: ${imageImport.stdout}\n${imageImport.stderr}`);
      const resolved = spawnSync(MATCHLOCK_RPC_BIN, ["image", "resolve", FIXTURE_IMAGE_TAG], {
        encoding: "utf-8",
        env: importEnv,
      });
      assert.equal(resolved.status, 0, `matchlock image resolve failed: ${resolved.stderr}`);
      const identity = JSON.parse(resolved.stdout.trim()) as { digest: string; config_digest: string };
      assert.ok(identity.digest.startsWith("sha256:") && identity.config_digest.startsWith("sha256:"));

      env = gateEnv(homeDir, 0);
      for (const workflowId of [
        "feature-dev-merge-worktree",
        "bug-fix-merge-worktree",
        "bug-fix-merge",
      ]) {
        cliMustSucceed(["workflow", "install", workflowId], env, `install ${workflowId}`);
      }

      const fixturesDir = path.join(EVIDENCE_DIR, "fixtures");
      fs.mkdirSync(fixturesDir, { recursive: true });
      fdOrigin = path.join(fixturesDir, "owned-origin-feature-dev");
      prepareOwnedOrigin(fdOrigin);
      bfOrigin = path.join(fixturesDir, "owned-origin-bug-fix");
      prepareOwnedOrigin(bfOrigin);
      // Direct route: the harness runs IN this checkout, so it stays on main.
      directOrigin = path.join(fixturesDir, "owned-origin-bug-fix-direct");
      prepareOwnedOrigin(directOrigin, { detach: false });

      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");
      assertionsLedgerPath = path.join(EVIDENCE_DIR, "vm-no-owned-assertions.txt");
    });

    after(async () => {
      const errors: string[] = [];
      if (homeDir && MATCHLOCK_RPC_BIN) {
        try {
          cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
        } catch {
          /* best-effort; each scenario owns its positive assertions */
        }
      }
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
      "feature-dev-merge-worktree (worktree) reaches real completion with a real target advance and target_moved retest",
      { timeout: 75 * 60_000 },
      async () => {
        await runWholePathScenario({
          workflowId: "feature-dev-merge-worktree",
          workspaceMode: "worktree",
          originDir: fdOrigin,
          originalBranch: "main",
          minVms: 8,
          label: "feature-dev-merge-worktree/worktree",
        });
      },
    );

    it(
      "bug-fix-merge-worktree (worktree) completes with real suite evidence, ledger acceptance and a real target advance",
      { timeout: 75 * 60_000 },
      async () => {
        await runWholePathScenario({
          workflowId: "bug-fix-merge-worktree",
          workspaceMode: "worktree",
          originDir: bfOrigin,
          originalBranch: "main",
          minVms: 7,
          label: "bug-fix-merge-worktree/worktree",
        });
      },
    );

    it(
      "bug-fix-merge (capability-equivalent DIRECT route) completes through the Matchlock path on an owned checkout",
      { timeout: 75 * 60_000 },
      async () => {
        await runWholePathScenario({
          workflowId: "bug-fix-merge",
          workspaceMode: "direct",
          originDir: directOrigin,
          originalBranch: "main",
          minVms: 7,
          label: "bug-fix-merge/direct",
        });
      },
    );
  },
);

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
