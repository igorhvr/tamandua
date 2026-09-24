// Tier-2 STORM-REHEARSAL-FIX7 US-007 (SF-15) — end-to-end: a LIVE held
// feature-dev-merge-worktree run lands while the checked-out merge TARGET is
// DIRTY, so the PRODUCT engages its park-first managed landing (or records a
// documented refusal) and the dirty bytes survive the landing.
//
// Attempt 7 (run #71) recorded SF-15 NOT OBSERVED: B-park dirtied the unrelated
// sibling `repos/park` clone while every worktree run merged into `repos/origin`,
// so the product's park-first landing path was never exercised. US-006 pointed
// the dirty-tree action at the owned non-bare origin checkout (main checked
// out); this is the real contained-daemon proof that dirtying THAT checkout
// under a live held run makes the product park (not clobber):
//
//   * a private exec context (buildPrivateExecContext) under a fresh owned var
//     root inside torture-test/var gives the daemon and the launched product
//     client their own HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH roots;
//   * provisionOwnedGitFixture builds the owned origin (non-bare, main checked
//     out) + colleague/park clones; seedCatalogFromBundled seeds the private
//     catalog; materializeRehearsalScriptedRuntime materializes the frozen
//     zero-token runtime for feature-dev-merge-worktree;
//   * the campaign-controlled merger checkpoint sits AFTER the merger captures
//     EXPECT_TIP and BEFORE it invokes the real `tamandua merge-branch`, so the
//     park action runs while the run is genuinely held (the merge has not yet
//     inspected the checkout);
//   * the engine's real dirty_tree_park argv (buildChaosArgv -> tt-chaos
//     dirty-tree --repo <origin>) appends a tracked-file sentinel AND writes an
//     untracked bait file into the owned origin checkout while the run is held;
//   * on release the product's merge-branch sees `inspectOwnerSafety.clean ===
//     false` and parks the target checkout on a backup branch instead of
//     refreshing it in place, emitting merge.landed with `checkoutRefresh:
//     parked:<backup>`, `parkedBranch` and `parkedReason: "local-changes"`;
//   * the test records the product's actual choice and asserts the dirty
//     tracked file + untracked bait are BYTE-IDENTICAL after the landing (no
//     clobber) and the run reaches terminal `completed` with no refusal
//     loop/wedge.
//
// The product behavior is observed from the real event stream + DB, never a
// canned verdict. This file spawns processes (git, tt-chaos, a real contained
// daemon, the product CLI): run it ALONE (never concatenated with sibling tests
// in one `node --test` process), under
// `flock --exclusive /root/matchlock-work/vaivm-gate.lock`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import { spawnCapture } from "../bin/tt-storm-shared.mjs";
import {
  buildPrivateExecContext,
  readProductMergeEvents,
} from "../bin/tt-storm-real.mjs";
import {
  allocRehearsalListenerPorts,
  FEATURE_BRANCH_COMMIT_COMMAND,
  materializeRehearsalScriptedRuntime,
  provisionOwnedGitFixture,
  readRehearsalWorkflowTexts,
  rehearsalDaemonPathExtra,
  renderRehearsalDaemonEnvScript,
  seedCatalogFromBundled,
} from "../bin/tt-storm-rehearsal.mjs";
import { applyBehaviorActions } from "../scripted-runtimes/runtime-shared.mjs";
import { buildChaosArgv } from "../bin/tt-storm-engine.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ttRoot = path.join(repoRoot, "torture-test");
const workflowsRoot = path.join(repoRoot, "workflows");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const DAEMON_CONTROL = path.join(ttRoot, "bin", "daemon-control");
const TT_CHAOS = path.join(ttRoot, "bin", "tt-chaos");
const SCRIPTED_PI = path.join(ttRoot, "scripted-runtimes", "bin", "scripted-pi");
const SCRIPTED_HERMES = path.join(ttRoot, "scripted-runtimes", "bin", "scripted-hermes");
// Every path the daemon-control containment guard admits must live under
// torture-test/var (the wrapper's fixed TT_ROOT), so the owned root lives there.
const OWNED_VAR_ROOT = path.join(ttRoot, "var");

const PRODUCTION_PORTS = [3334, 3338, 3339];
const WORKFLOW_ID = "feature-dev-merge-worktree";
const AGENT_KEY = `${WORKFLOW_ID}_merger`;
const HOLD_ID = "storm-midflight";
const HOLD_TIMEOUT_MS = 120_000;
// The product dispatches on a 15s fallback tick; the full merge-worktree
// pipeline (plan/setup/2x implement+verify/test/finalize) can take minutes.
const CHECKPOINT_TIMEOUT_MS = 420_000;
const PARK_LANDING_TIMEOUT_MS = 180_000;
const TERMINAL_TIMEOUT_MS = 240_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
const MERGE_TARGET_REF = "main";
const UNTRACKED_BAIT = "CHAOS_PARK_BAIT.txt";
// Diagnostics written BEFORE cleanup so a failed discovery is retained (the
// owned temp root itself is still removed in finally).
const DIAGNOSTICS_ROOT = path.join(OWNED_VAR_ROOT, "storm-rehearsal-fix7-diagnostics");

const cleanupDirs: string[] = [];

after(() => {
  for (const dir of cleanupDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // diagnostics-only cleanup
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  fn: () => T | null | undefined,
  { timeoutMs = 60_000, intervalMs = 200 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = fn();
      if (value !== null && value !== undefined) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}: timed out after ${timeoutMs}ms${lastError ? ` (last error: ${(lastError as Error).message})` : ""}`,
      );
    }
    await sleep(intervalMs);
  }
}

function makeRealGitAdapter() {
  return {
    run: async (cwd: string, args: string[], { env = {} }: { env?: Record<string, string> } = {}) =>
      spawnCapture(["git", ...args], {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...env },
        mergeParentEnv: false,
        timeoutMs: 120_000,
      }),
  };
}

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function revParse(repo: string, ref: string): string {
  const res = git(repo, ["rev-parse", ref]);
  assert.equal(res.status, 0, `rev-parse ${ref} in ${repo}: ${res.stderr}`);
  return res.stdout.trim();
}

function currentBranch(repo: string): string {
  const res = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(res.status, 0, `rev-parse --abbrev-ref HEAD in ${repo}: ${res.stderr}`);
  return res.stdout.trim();
}

function porcelain(repo: string): string[] {
  const res = git(repo, ["status", "--porcelain"]);
  assert.equal(res.status, 0, `status in ${repo}: ${res.stderr}`);
  return res.stdout.split(/\r?\n/).filter((l) => l.length > 0);
}

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function readRunRow(
  dbPath: string,
  runId: string,
): { id: string; status: string; parent_run_id: string | null } | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT id, status, parent_run_id FROM runs WHERE id = ?")
      .get(runId) as { id: string; status: string; parent_run_id: string | null } | undefined;
    return row ?? null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function newestRunId(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT id FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(WORKFLOW_ID) as { id: string } | undefined;
    return row?.id ?? null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function childRuns(dbPath: string, parentBare: string): string[] {
  if (!fs.existsSync(dbPath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT id FROM runs WHERE parent_run_id = ?")
      .all(parentBare) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

// Retain the failing run's DB rows + event tail OUTSIDE the owned temp root
// (which the finally removes) so a discovery failure is diagnosable.
function dumpDiagnostics(h: ParkHarness, label: string, bare: string | null): string {
  fs.mkdirSync(DIAGNOSTICS_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DIAGNOSTICS_ROOT, "park-e2e-"));
  const snapshot: Record<string, unknown> = {
    label,
    observedAt: new Date().toISOString(),
    run: bare,
    dbPath: h.execCtx.db_path,
    holdDir: h.holdDir,
    holdMarkers: fs.existsSync(h.holdDir) ? fs.readdirSync(h.holdDir) : [],
    originRepo: h.originRepo,
  };
  try {
    snapshot.originPorcelain = porcelain(h.originRepo);
    snapshot.originHeadRef = git(h.originRepo, ["symbolic-ref", "HEAD"]).stdout.trim();
    snapshot.originMain = revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`);
  } catch (err) {
    snapshot.gitError = (err as Error).message;
  }
  try {
    if (bare && fs.existsSync(h.execCtx.db_path)) {
      const db = new DatabaseSync(h.execCtx.db_path, { readOnly: true });
      snapshot.runRow = db.prepare("SELECT * FROM runs WHERE id = ?").get(bare);
      snapshot.steps = db.prepare("SELECT step_id, status, reroute_count FROM steps WHERE run_id = ? ORDER BY rowid").all(bare);
      db.close();
    }
  } catch (err) {
    snapshot.dbError = (err as Error).message;
  }
  try {
    if (bare) {
      const evFile = path.join(h.execCtx.state_root, "events", `${bare}.jsonl`);
      if (fs.existsSync(evFile)) {
        const lines = fs.readFileSync(evFile, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
        snapshot.eventCount = lines.length;
        snapshot.lastEvents = lines.slice(-40).map((l) => JSON.parse(l));
        fs.copyFileSync(evFile, path.join(dir, `${bare}.jsonl`));
      }
    }
  } catch (err) {
    snapshot.eventError = (err as Error).message;
  }
  fs.writeFileSync(path.join(dir, "diagnostics.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return dir;
}

function isPortListening(port: number): boolean {
  const script = `const net=require('node:net');const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000);`;
  const res = spawnSync(process.execPath, ["-e", script], { timeout: 3000, encoding: "utf8" });
  return res.status === 0;
}

// The campaign-controlled merger checkpoint. It captures EXPECT_TIP, writes the
// standard merger-hold marker (`<holdDir>/run-<uuid>.confirmed`), then blocks on
// `<holdDir>/run-<uuid>.release` BEFORE invoking the real product merge command.
// A park action during that window leaves the origin working tree dirty, so the
// product's owner-safety check refuses the in-place refresh and parks instead.
function renderParkMergerCommand(holdDir: string): string {
  return [
    `set -u`,
    `EXPECT_TIP="$(git -C '{{input.WORKTREE_ORIGIN_REPOSITORY}}' rev-parse 'refs/heads/{{input.ORIGINAL_BRANCH}}')"`,
    `RUN_ID='{{input.RUN_ID}}'`,
    `HOLD_DIR=${JSON.stringify(holdDir)}`,
    `mkdir -p "$HOLD_DIR"`,
    `printf '{"runId":"run-%s","holdId":"${HOLD_ID}","expectTip":"%s"}\\n' "$RUN_ID" "$EXPECT_TIP" > "$HOLD_DIR/run-$RUN_ID.confirmed"`,
    `i=0`,
    `while [ ! -f "$HOLD_DIR/run-$RUN_ID.release" ]; do i=$((i+1)); [ "$i" -lt 2400 ] || { echo "storm-park-e2e: merger checkpoint not released within bound" >&2; exit 4; }; sleep 0.05; done`,
    `MESSAGE_FILE="$(mktemp)"`,
    `printf 'fix: scripted rehearsal park merge\\n\\nCo-Authored-By: Tamandua <tamandua@tetradactyla.org>\\n' > "$MESSAGE_FILE"`,
    `tamandua merge-branch --origin '{{input.WORKTREE_ORIGIN_REPOSITORY}}' --branch '{{input.BRANCH}}' --into '{{input.ORIGINAL_BRANCH}}' --expect-tip "$EXPECT_TIP" --message "$(cat "$MESSAGE_FILE")"`,
    `MERGE_EXIT=$?`,
    `rm -f "$MESSAGE_FILE"`,
    `exit $MERGE_EXIT`,
  ].join("\n");
}

// Replace the materialized merger behavior with the checkpoint command and
// remove the built-in pre-command hold (the checkpoint itself IS the hold; it
// must sit after the expect-tip capture, which the built-in hold does not).
function installParkMergerCheckpoint(behaviorsFile: string, holdDir: string): void {
  const doc = JSON.parse(fs.readFileSync(behaviorsFile, "utf8"));
  const merger = doc?.agents?.[AGENT_KEY];
  assert.ok(merger, `materialized behaviors must carry ${AGENT_KEY}`);
  delete merger.hold;
  merger.includeCommandOutput = true;
  merger.commands = [renderParkMergerCommand(holdDir)];
  fs.writeFileSync(behaviorsFile, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

interface ParkHarness {
  ownedRoot: string;
  varRoot: string;
  campaignDir: string;
  campaignId: string;
  execCtx: any;
  ports: { dashboard: number; mcp: number; control: number; controlUrl: string };
  scriptedStateDir: string;
  holdDir: string;
  behaviorsFile: string;
  daemonEnv: Record<string, string>;
  originRepo: string;
  colleagueRepo: string;
  parkRepo: string;
  cc1File: string;
  mainHead: string;
  taskFile: string;
  launchCwd: string;
}

async function buildParkHarness(campaignId: string): Promise<ParkHarness> {
  const ownedRoot = fs.mkdtempSync(path.join(OWNED_VAR_ROOT, "rehearsal-park-e2e-"));
  cleanupDirs.push(ownedRoot);
  const varRoot = path.join(ownedRoot, "exec");
  const campaignDir = path.join(ownedRoot, "campaign");
  fs.mkdirSync(campaignDir, { recursive: true });

  const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });

  // The product CLI resolves workflows from <TAMANDUA_STATE_DIR>/workflows; seed
  // the private installed catalog from the real bundled catalog.
  const installedRoot = path.join(execCtx.state_root, "workflows");
  seedCatalogFromBundled({ bundledRoot: workflowsRoot, installedRoot });

  // The owned fixture: origin (non-bare, main checked out) + colleague/park.
  const reposRoot = path.join(execCtx.var_root, "repos");
  fs.mkdirSync(reposRoot, { recursive: true });
  const fixture = await provisionOwnedGitFixture({
    fs: REAL_FS,
    git: makeRealGitAdapter(),
    reposRoot,
    env: { HOME: ownedRoot },
  });

  const workflowTexts = readRehearsalWorkflowTexts({
    roots: [workflowsRoot],
    workflowIds: [WORKFLOW_ID],
  });
  const scriptedRuntime = materializeRehearsalScriptedRuntime({
    inputRoot: path.join(varRoot, "rehearsal"),
    stateRoot: execCtx.state_root,
    campaignId,
    workflowTexts,
    workflowIds: [WORKFLOW_ID],
    holdTimeoutMs: HOLD_TIMEOUT_MS,
  });

  const holdDir = path.join(scriptedRuntime.state_dir, "holds");
  fs.mkdirSync(holdDir, { recursive: true });
  installParkMergerCheckpoint(scriptedRuntime.behaviors_file, holdDir);

  const ports = await allocRehearsalListenerPorts({});
  for (const port of [ports.dashboard, ports.mcp, ports.control]) {
    assert.equal(PRODUCTION_PORTS.includes(port), false, `allocated listener port ${port} must never be a production port`);
  }

  const envScript = path.join(campaignDir, "daemon.env.sh");
  const content = renderRehearsalDaemonEnvScript({
    home: execCtx.home_root,
    stateDir: execCtx.state_root,
    dbPath: execCtx.db_path,
    tmpDir: execCtx.tmp_root,
    ports,
    piBinary: SCRIPTED_PI,
    hermesBinary: SCRIPTED_HERMES,
    nodeBinDir: path.dirname(process.execPath),
    pathExtra: rehearsalDaemonPathExtra(repoRoot),
    repoRoot,
    ttRoot: OWNED_VAR_ROOT,
    scriptedBehaviors: scriptedRuntime.behaviors_file,
    scriptedStateDir: scriptedRuntime.state_dir,
    maxActiveTimers: 8,
  });
  fs.writeFileSync(envScript, content, { mode: 0o600 });

  const taskFile = path.join(ownedRoot, "storm-park.task.md");
  fs.writeFileSync(
    taskFile,
    "STORM-REHEARSAL-FIX7 US-007 SF-15 E2E: a held merge-worktree run lands with the target checkout dirty (park-first landing).\n",
    "utf8",
  );

  const launchCwd = path.join(execCtx.var_root, "launch-cwd");
  fs.mkdirSync(launchCwd, { recursive: true });

  return {
    ownedRoot,
    varRoot,
    campaignDir,
    campaignId,
    execCtx,
    ports,
    scriptedStateDir: scriptedRuntime.state_dir,
    holdDir,
    behaviorsFile: scriptedRuntime.behaviors_file,
    daemonEnv: { TT_DC_ENV_SCRIPTED: envScript, TT_FORCE_NO_SYSTEMD: "1" },
    originRepo: fixture.originRepo,
    colleagueRepo: fixture.colleagueRepo,
    parkRepo: fixture.parkRepo,
    cc1File: fixture.files.cc1,
    mainHead: fixture.mainHead,
    taskFile,
    launchCwd,
  };
}

function runDaemonControl(h: ParkHarness, op: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(DAEMON_CONTROL, ["scripted", op], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...h.execCtx.child_env, ...h.daemonEnv, TT_DAEMON_PORT_WAIT_SECONDS: "10" },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

// Run the engine's REAL dirty_tree_park operator argv (tt-chaos dirty-tree
// --repo <owned origin>) inside the contained TT_ROOT.
function runPark(h: ParkHarness, argv: string[]) {
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT") continue;
    if (v !== undefined) inherited[k] = v;
  }
  const res = spawnSync(TT_CHAOS, argv.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...inherited,
      TT_ROOT: OWNED_VAR_ROOT,
      TT_HOME: h.execCtx.state_root,
      TAMANDUA_STATE_DIR: h.execCtx.state_root,
      TAMANDUA_DB_PATH: h.execCtx.db_path,
      TAMANDUA_TEST_GUARD: "1",
    },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function parkArgv(h: ParkHarness, runFullId: string): string[] {
  const ctx = {
    varRoot: h.execCtx.var_root,
    opts: {
      fixtureIdentity: {
        colleagueRepo: h.colleagueRepo,
        cc1File: h.cc1File,
        cc2File: h.cc1File,
        parkRepo: h.originRepo,
        originRepo: h.originRepo,
        seedRef: "seed/storm",
      },
      originRepo: h.originRepo,
    },
  };
  const built = buildChaosArgv(
    ctx as any,
    { plan: { fixtureIdentity: ctx.opts.fixtureIdentity } } as any,
    { kind: "dirty_tree_park", targets: ["B1", "B2", "B3", "B4"] } as any,
    runFullId,
  );
  assert.equal(built.ok, true, `dirty_tree_park must build a real operator argv: ${(built as any).reason}`);
  return built.argv as string[];
}

// ── US-004 (SF-15): run-scoped seeded merge branches ─────────────────
// Run the REAL product merge-branch CLI exactly as the merger step does and
// return the child result. `expectTip` is read from the origin at call time,
// mirroring the merger's capture-then-land sequence.
function runProductMerge(
  h: ParkHarness,
  runId: string,
  branch: string,
): { status: number | null; stdout: string; stderr: string; expectTip: string } {
  const expectTip = revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`);
  const res = spawnSync(
    TAMANDUA_BIN,
    [
      "merge-branch",
      "--origin", h.originRepo,
      "--branch", branch,
      "--into", MERGE_TARGET_REF,
      "--expect-tip", expectTip,
      "--run-id", runId,
      "--message", "fix: scripted rehearsal merge\n\nCo-Authored-By: Tamandua <tamandua@tetradactyla.org>",
    ],
    {
      cwd: h.execCtx.home_root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: h.execCtx.child_env,
    },
  );
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? ""), expectTip };
}

// Seed one roster run's merge branch exactly as the scripted work round does:
// a detached linked worktree at the current target, then the REAL
// FEATURE_BRANCH_COMMIT_COMMAND rendered with the run-scoped BRANCH. Returns
// the branch and target trees so the caller can pin the strict-ahead property.
function seedRunBranch(
  h: ParkHarness,
  runId: string,
  branch: string,
): { branchTree: string; targetTree: string } {
  const wt = fs.mkdtempSync(path.join(h.execCtx.var_root, "seed-wt-"));
  const add = git(h.originRepo, ["worktree", "add", "--detach", wt, MERGE_TARGET_REF]);
  assert.equal(add.status, 0, `worktree add for ${runId}: ${add.stderr}`);
  try {
    applyBehaviorActions({ commands: [FEATURE_BRANCH_COMMIT_COMMAND] }, wt, {
      BRANCH: branch,
      WORKTREE_ORIGIN_REPOSITORY: h.originRepo,
      ORIGINAL_BRANCH: MERGE_TARGET_REF,
      RUN_ID: runId,
    });
  } finally {
    const rm = git(h.originRepo, ["worktree", "remove", "--force", wt]);
    assert.equal(rm.status, 0, `worktree remove for ${runId}: ${rm.stderr}`);
    fs.rmSync(wt, { recursive: true, force: true });
  }
  return {
    branchTree: revParse(h.originRepo, `refs/heads/${branch}^{tree}`),
    targetTree: revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}^{tree}`),
  };
}

// The product's own choice, classified from the real event stream:
//   parked  -> merge.landed with checkoutRefresh parked:<branch>
//   refused -> a documented refusal (park/dirty/refusal detail)
//   refreshed -> in-place refresh (only legitimate when the checkout was clean)
function classifyParkChoice(read: { landed: any[]; parkLanding: any[] }): {
  mode: "parked" | "refreshed" | "refused";
  event: any;
} {
  for (const evt of read.landed) {
    const refresh = String(evt?.checkoutRefresh ?? "");
    if (refresh.startsWith("parked:") || evt?.parkedBranch || evt?.parkedReason) {
      return { mode: "parked", event: evt };
    }
  }
  for (const evt of read.landed) {
    const refresh = String(evt?.checkoutRefresh ?? "");
    if (refresh === "refreshed" || refresh === "already-coherent") {
      return { mode: "refreshed", event: evt };
    }
  }
  return { mode: "refused", event: read.parkLanding[0] ?? null };
}

describe("tier2-storm-rehearsal-park-e2e (US-007 SF-15)", () => {
  it("P0: the campaign merger checkpoint is armed after the expect-tip capture and the park argv targets the owned origin checkout", async () => {
    const h = await buildParkHarness(`park-e2e-preflight-${process.pid}-${Date.now()}`);
    try {
      const doc = JSON.parse(fs.readFileSync(h.behaviorsFile, "utf8"));
      const merger = doc.agents[AGENT_KEY];
      assert.ok(merger, `behaviors must carry ${AGENT_KEY}`);
      assert.equal(merger.hold, undefined, "the built-in pre-command hold must be replaced by the after-capture checkpoint");
      assert.equal(merger.includeCommandOutput, true);
      assert.equal(merger.commands.length, 1);
      const cmd = merger.commands[0];
      assert.ok(cmd.includes("EXPECT_TIP="), "the checkpoint must capture EXPECT_TIP");
      assert.ok(cmd.includes("tamandua merge-branch"), "the checkpoint must run the real product merge command");
      assert.ok(cmd.includes(`--expect-tip "$EXPECT_TIP"`), "the product must receive the captured (pre-park) expect tip");
      assert.ok(cmd.indexOf("EXPECT_TIP=") < cmd.indexOf("HOLD_DIR="), "the checkpoint marker is written AFTER the expect-tip capture");
      assert.ok(cmd.trim().split("\n").length >= 8, "the checkpoint command must carry the real hold-blocking body");
      assert.ok(cmd.includes(`${HOLD_ID}`), "the hold marker must name the campaign hold id");

      const argv = parkArgv(h, "run-00000000-0000-4000-8000-000000000000");
      assert.equal(argv[0], "tt-chaos");
      assert.equal(argv[1], "dirty-tree");
      assert.equal(argv[argv.indexOf("--repo") + 1], h.originRepo, "the park must dirty the owned origin checkout");
      assert.notEqual(argv[argv.indexOf("--repo") + 1], h.parkRepo, "the unrelated repos/park clone must never be the park target");
      assert.ok(h.originRepo.startsWith(`${OWNED_VAR_ROOT}${path.sep}`), "the origin is campaign-contained");
      // The origin is the live merge target: non-bare with main checked out.
      assert.equal(currentBranch(h.originRepo), MERGE_TARGET_REF, "the origin has the merge target branch checked out");
      assert.equal(porcelain(h.originRepo).length, 0, "the origin starts clean");
    } finally {
      fs.rmSync(h.ownedRoot, { recursive: true, force: true });
      const idx = cleanupDirs.indexOf(h.ownedRoot);
      if (idx >= 0) cleanupDirs.splice(idx, 1);
    }
  });

  it("P1: one real held merge-worktree run lands with the target checkout dirty and the product PARKS (dirty bytes preserved)", async () => {
    const campaignId = `park-e2e-${process.pid}-${Date.now()}`;
    const h = await buildParkHarness(campaignId);
    const sinceUtc = new Date().toISOString();

    let daemonStarted = false;
    let runId: string | null = null;
    let bareRunId: string | null = null;
    let bodyError: unknown = null;
    let stopResult: { status: number | null; stdout: string; stderr: string } | null = null;
    let chosenMode: "parked" | "refreshed" | "refused" | null = null;
    let finalStatus: string | null = null;
    let childIds: string[] = [];
    // Dirty-state capture (asserted byte-identical after the landing).
    let dirtyTrackedRel: string | null = null;
    let dirtyTrackedBytesBefore: Buffer | null = null;
    let dirtyTrackedShaBefore: string | null = null;
    let dirtyBaitBytesBefore: Buffer | null = null;
    try {
      // ── start the REAL contained private daemon ─────────────────────
      const start = runDaemonControl(h, "start");
      assert.equal(start.status, 0, `daemon-control scripted start must succeed:\n${start.stderr}\n${start.stdout}`);
      daemonStarted = true;
      assert.ok(
        await waitFor("control port listening", () => (isPortListening(h.ports.control) ? true : null), {
          timeoutMs: 20_000,
        }),
        "the private control listener must accept connections",
      );

      // daemon-control's provenance must name exactly the campaign ports.
      const provFile = path.join(OWNED_VAR_ROOT, "daemon-control", "scripted.json");
      const prov = JSON.parse(fs.readFileSync(provFile, "utf8"));
      for (const port of prov.ports) {
        assert.equal(PRODUCTION_PORTS.includes(Number(port)), false, `daemon-control recorded a production port ${port}`);
      }

      // ── launch ONE real worktree run through the REAL product CLI ───
      const launchEnv: NodeJS.ProcessEnv = {
        ...h.execCtx.child_env,
        TAMANDUA_CONTROL_PORT: String(h.ports.control),
        TAMANDUA_DASHBOARD_PORT: String(h.ports.dashboard),
        TAMANDUA_MCP_PORT: String(h.ports.mcp),
        TAMANDUA_PI_BINARY: SCRIPTED_PI,
      };
      const launch = spawnSync(
        TAMANDUA_BIN,
        [
          "workflow", "run", WORKFLOW_ID,
          "--task-file", h.taskFile,
          "--worktree-origin-repository", h.originRepo,
          "--worktree-origin-ref", MERGE_TARGET_REF,
          "--pi-as-harness",
        ],
        {
          cwd: h.execCtx.home_root,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024,
          env: launchEnv,
        },
      );
      assert.equal(launch.status, 0, `product CLI workflow run must succeed:\n${launch.stderr}\n${launch.stdout}`);

      const bare = await waitFor("run row persisted", () => newestRunId(h.execCtx.db_path), { timeoutMs: 30_000 });
      bareRunId = bare;
      runId = `run-${bare}`;

      // ── wait for the REAL merger checkpoint hold ────────────────────
      const confirmedPath = path.join(h.holdDir, `${runId}.confirmed`);
      await waitFor("merger checkpoint confirmed", () => (fs.existsSync(confirmedPath) ? true : null), {
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      });
      const confirmed = JSON.parse(fs.readFileSync(confirmedPath, "utf8"));
      assert.equal(confirmed.runId, runId, "the checkpoint marker must name the real run id");
      assert.equal(confirmed.holdId, HOLD_ID);
      assert.match(String(confirmed.expectTip), /^[0-9a-f]{40}$/, "the checkpoint must record the captured expect tip");
      assert.equal(confirmed.expectTip, h.mainHead, "the checkpoint captures the fixture main tip");
      assert.equal(fs.existsSync(path.join(h.holdDir, `${runId}.release`)), false, "the release must not exist before the test writes it");
      assert.equal(readRunRow(h.execCtx.db_path, bare)?.status, "running", "the held run must be running while parked");

      // ── while genuinely held, dirty the live merge target's checkout ─
      assert.equal(currentBranch(h.originRepo), MERGE_TARGET_REF, "the origin merge target is checked out");
      assert.equal(porcelain(h.originRepo).length, 0, "the origin is clean before the park action");
      const beforeTip = revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`);
      assert.equal(beforeTip, h.mainHead, "origin main must be at the fixture head before the park");

      const argv = parkArgv(h, runId);
      const park = runPark(h, argv);
      assert.equal(park.status, 0, `dirty_tree_park must fire:\n${park.stderr}\n${park.stdout}`);

      // Dirtying a working tree is not a ref mutation.
      assert.equal(revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`), beforeTip,
        "dirty-tree must leave refs/heads/main unchanged");

      // Capture the exact dirty state the landing must preserve.
      const statusLines = porcelain(h.originRepo);
      const modifiedLines = statusLines.filter((l) => l.startsWith(" M") || l[1] === "M");
      const untrackedLines = statusLines.filter((l) => l.startsWith("??"));
      assert.ok(modifiedLines.length >= 1, `a tracked file must be modified: ${JSON.stringify(statusLines)}`);
      assert.ok(untrackedLines.some((l) => l.includes(UNTRACKED_BAIT)), `the untracked bait must exist: ${JSON.stringify(statusLines)}`);
      dirtyTrackedRel = modifiedLines[0].slice(3);
      const dirtyTrackedPath = path.join(h.originRepo, dirtyTrackedRel);
      dirtyTrackedBytesBefore = fs.readFileSync(dirtyTrackedPath);
      dirtyTrackedShaBefore = sha256File(dirtyTrackedPath);
      assert.match(dirtyTrackedBytesBefore.toString("utf8"), /CHAOS DIRTY/, "the modified tracked file carries the park sentinel");
      dirtyBaitBytesBefore = fs.readFileSync(path.join(h.originRepo, UNTRACKED_BAIT));
      assert.match(dirtyBaitBytesBefore.toString("utf8"), /CHAOS PARK BAIT \(untracked\)/, "the untracked bait carries its sentinel");

      // ── release the hold; the merger now lands on a DIRTY target ────
      fs.writeFileSync(path.join(h.holdDir, `${runId}.release`), "go\n", "utf8");

      // ── observe the PRODUCT's own park-first landing evidence ───────
      const read = await waitFor("product park landing observed", () => {
        const r = readProductMergeEvents({ stateRoot: h.execCtx.state_root, runIds: [bare], sinceUtc });
        assert.equal(r.ok, true, `product merge-event channel must be readable: ${r.error}`);
        return r.parkLanding.length > 0 ? r : null;
      }, { timeoutMs: PARK_LANDING_TIMEOUT_MS });
      assert.ok(read.parkLanding.length >= 1, "the product must engage the park-first landing (or record a documented refusal)");

      const choice = classifyParkChoice(read);
      chosenMode = choice.mode;
      assert.ok(
        chosenMode === "parked" || chosenMode === "refused",
        `a dirty target must be parked or refused, never refreshed in place (got ${chosenMode})`,
      );

      // The product's real choice, recorded honestly.
      if (chosenMode === "parked") {
        const evt = choice.event;
        assert.equal(String(evt.runId), bare, "the parked landing must belong to this run");
        assert.ok(String(evt.checkoutRefresh).startsWith("parked:"), `checkoutRefresh must name the parked backup: ${evt.checkoutRefresh}`);
        assert.ok(evt.parkedBranch, "the parked landing must name the backup branch");
        assert.equal(evt.parkedReason, "local-changes", "a dirty tracked checkout must park with reason local-changes");
        assert.equal(evt.target, `refs/heads/${MERGE_TARGET_REF}`);
        // The merge still landed: origin main advanced to the merged commit.
        assert.equal(revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`), String(evt.mergedCommit),
          "origin main must advance to the parked landing's merged commit");
      }

      // ── the dirty bytes survived the landing (no clobber) ───────────
      const dirtyTrackedAbs = path.join(h.originRepo, dirtyTrackedRel!);
      assert.equal(fs.existsSync(dirtyTrackedAbs), true, "the dirtied tracked file must still exist");
      const afterBytes = fs.readFileSync(dirtyTrackedAbs);
      assert.ok(dirtyTrackedBytesBefore!.equals(afterBytes), "the dirty tracked file must be BYTE-IDENTICAL after the landing");
      assert.equal(sha256File(dirtyTrackedAbs), dirtyTrackedShaBefore, "the dirty tracked file sha must be unchanged");
      const baitAbs = path.join(h.originRepo, UNTRACKED_BAIT);
      assert.equal(fs.existsSync(baitAbs), true, "the untracked bait must still exist");
      assert.ok(dirtyBaitBytesBefore!.equals(fs.readFileSync(baitAbs)), "the untracked bait must be BYTE-IDENTICAL after the landing");

      // ── the run reaches terminal (completed) with no refusal loop ───
      const outcome = await waitFor("run terminal or first-class child", () => {
        const row = readRunRow(h.execCtx.db_path, bare);
        if (row && TERMINAL_STATUSES.has(row.status)) return { row, children: [] as string[] };
        const kids = childRuns(h.execCtx.db_path, bare);
        if (kids.length > 0) return { row: row ?? { id: bare, status: "running", parent_run_id: null }, children: kids };
        return null;
      }, { timeoutMs: TERMINAL_TIMEOUT_MS });
      finalStatus = outcome.row.status;
      childIds = outcome.children;
      assert.equal(finalStatus, "completed",
        `the parked run must complete with no refusal loop/wedge (got ${finalStatus}, children=[${childIds.join(",")}])`);
      assert.deepEqual(childIds, [], "a clean park landing must not spawn a replacement/child run");
      process.stdout.write(
        `US-007 observed: run=${runId} park_mode=${chosenMode} tracked=${dirtyTrackedRel} terminal=${finalStatus}\n`,
      );

      const finalRead = readProductMergeEvents({ stateRoot: h.execCtx.state_root, runIds: [bare], sinceUtc });
      process.stdout.write(`US-007 summary: park_mode=${chosenMode} landed=${finalRead.landed.length} terminal=${finalStatus}\n`);
    } catch (err) {
      bodyError = err;
      try {
        const dir = dumpDiagnostics(h, "P1-failure", bareRunId);
        process.stdout.write(`US-007 diagnostics retained at ${dir}\n`);
      } catch {
        // diagnostics must never mask the primary failure
      }
    } finally {
      if (daemonStarted) stopResult = runDaemonControl(h, "stop");
      fs.rmSync(h.ownedRoot, { recursive: true, force: true });
      const idx = cleanupDirs.indexOf(h.ownedRoot);
      if (idx >= 0) cleanupDirs.splice(idx, 1);
    }
    if (bodyError !== null) {
      const suffix =
        stopResult !== null && stopResult.status !== 0
          ? `\n(also: owned daemon stop failed: ${stopResult.stderr})`
          : "";
      throw new Error(`${(bodyError as Error).message}${suffix}`);
    }
    assert.equal(
      stopResult?.status,
      0,
      `owned daemon stop must succeed:\n${stopResult?.stderr ?? ""}\n${stopResult?.stdout ?? ""}`,
    );
    assert.ok(chosenMode !== null, "the product park choice must have been observed");
    assert.equal(finalStatus, "completed", "the parked run must reach terminal completed");
  });

  // ── US-004 (SF-15): the retained no-op shape is red; real seeded branches
  // land 4/4 non-noop against the dirtied owned origin checkout. This is the
  // contained integration proof the attempt-9 campaign lacked: it drives the
  // REAL FEATURE_BRANCH_COMMIT_COMMAND (four run-scoped branches seeded from
  // the same target, as concurrent B1..B4 work rounds do) and the REAL product
  // `tamandua merge-branch`, and classifies the product's own merge.landed
  // events. Before US-004 the branch name was shared, so after B1's squash
  // merge every later branch tree equalled the target tree and every landing
  // came back noop:true / "already-coherent".
  it("P2: B1..B4 seeded branches are strictly ahead and land 4/4 non-noop; the shared-branch no-op shape is red", async () => {
    const campaignId = `park-nonnoop-${process.pid}-${Date.now()}`;
    const h = await buildParkHarness(campaignId);
    const sinceUtc = new Date().toISOString();
    try {
      const runs = [
        { roster: "B1", id: "11111111-1111-4111-8111-111111111111" },
        { roster: "B2", id: "22222222-2222-4222-8222-222222222222" },
        { roster: "B3", id: "33333333-3333-4333-8333-333333333333" },
        { roster: "B4", id: "44444444-4444-4444-8444-444444444444" },
      ].map((r) => ({ ...r, branch: `storm-scripted-fixture-${r.id}` }));

      // Phase 1: seed all four branches from the SAME target tip first (the
      // concurrent-work-round shape), and pin the strict-ahead property.
      const targetBefore = revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`);
      for (const r of runs) {
        const { branchTree, targetTree } = seedRunBranch(h, r.id, r.branch);
        assert.notEqual(
          branchTree,
          targetTree,
          `${r.roster} merge branch tree must differ from the target tree before finalize_merge`,
        );
      }
      assert.equal(
        revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`),
        targetBefore,
        "seeding branches must not move the target",
      );

      // Phase 2: the retained attempt-9 shape -- a branch whose tip tree equals
      // the target tree -- must produce a noop / already-coherent landing and
      // advance nothing. This is the shape the gate must reject.
      const NOOP_RUN = "55555555-5555-4555-8555-555555555555";
      const noopBranch = "storm-scripted-fixture-shared-noop";
      const branchAt = git(h.originRepo, ["branch", noopBranch, MERGE_TARGET_REF]);
      assert.equal(branchAt.status, 0, `create noop branch: ${branchAt.stderr}`);
      const noopMerge = runProductMerge(h, NOOP_RUN, noopBranch);
      assert.equal(noopMerge.status, 0, `noop merge-branch must exit 0: ${noopMerge.stderr}`);
      const noopRead = readProductMergeEvents({ stateRoot: h.execCtx.state_root, runIds: [NOOP_RUN], sinceUtc });
      assert.equal(noopRead.landed.length, 1, "the noop branch produces exactly one merge.landed");
      assert.equal(noopRead.landed[0].noop, true, "the retained shared-branch shape is a noop:true landing");
      assert.equal(noopRead.landed[0].checkoutRefresh, "already-coherent", "noop landing is already-coherent");
      assert.equal(
        revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`),
        targetBefore,
        "a no-op landing must not advance the target",
      );

      // Phase 3: dirty the live owned origin checkout exactly as B-park does,
      // then land every seeded branch through the real product. The park-first
      // managed landing must engage on the dirty checkout. The tt-chaos guard
      // needs a non-terminal run row in the private TT DB (P1's daemon created
      // one); P2 is daemon-free, so seed the minimal row the guard reads. The
      // live product schema-13 `runs` table carries NOT NULL columns without
      // defaults (workflow_id/task/created_at/updated_at), so build the insert
      // from the table's own PRAGMA and satisfy every required column instead
      // of assuming the two-column minimal shape.
      const ttDb = new DatabaseSync(h.execCtx.db_path);
      try {
        ttDb.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT)");
        const ttColumns = ttDb
          .prepare("PRAGMA table_info(runs)")
          .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
        const nowUtc = new Date().toISOString();
        const ttValues: Record<string, string> = {
          id: runs[0].id,
          status: "running",
          workflow_id: WORKFLOW_ID,
          task: "storm-rehearsal-park-nonnoop",
          created_at: nowUtc,
          updated_at: nowUtc,
        };
        for (const col of ttColumns) {
          if (ttValues[col.name] === undefined && col.notnull === 1 && col.dflt_value === null) {
            ttValues[col.name] = nowUtc;
          }
        }
        const ttInsertCols = ttColumns
          .map((col) => col.name)
          .filter((name) => ttValues[name] !== undefined);
        ttDb
          .prepare(
            `INSERT OR REPLACE INTO runs (${ttInsertCols.join(", ")}) VALUES (${ttInsertCols.map(() => "?").join(", ")})`,
          )
          .run(...ttInsertCols.map((name) => ttValues[name]));
      } finally {
        ttDb.close();
      }
      const dirty = runPark(h, parkArgv(h, `run-${runs[0].id}`));
      assert.equal(dirty.status, 0, `dirty_tree_park must fire:\n${dirty.stderr}\n${dirty.stdout}`);
      assert.equal(revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`), targetBefore, "dirty-tree is not a ref mutation");
      const statusLines = porcelain(h.originRepo);
      const modifiedLines = statusLines.filter((l) => l[1] === "M" || l.startsWith(" M"));
      assert.ok(modifiedLines.length >= 1, `a tracked file must be dirty: ${JSON.stringify(statusLines)}`);
      const dirtyTrackedRel = modifiedLines[0].slice(3);
      const dirtyTrackedPath = path.join(h.originRepo, dirtyTrackedRel);
      const dirtyTrackedBytes = fs.readFileSync(dirtyTrackedPath);
      const dirtyBaitPath = path.join(h.originRepo, UNTRACKED_BAIT);
      const dirtyBaitBytes = fs.readFileSync(dirtyBaitPath);

      for (const r of runs) {
        // Strictly ahead at finalize_merge time: the merge branch tree must
        // still differ from the CURRENT target tree immediately before landing.
        assert.notEqual(
          revParse(h.originRepo, `refs/heads/${r.branch}^{tree}`),
          revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}^{tree}`),
          `${r.roster} branch must be strictly ahead of the current target immediately before landing`,
        );
        const landed = runProductMerge(h, r.id, r.branch);
        assert.equal(
          landed.status,
          0,
          `${r.roster} (${r.branch}) must land non-noop: exit ${landed.status}\n${landed.stderr}\n${landed.stdout}`,
        );
      }

      const read = readProductMergeEvents({ stateRoot: h.execCtx.state_root, runIds: runs.map((r) => r.id), sinceUtc });
      assert.equal(read.ok, true, `product events must be readable: ${read.error}`);
      assert.equal(read.landed.length, 4, `B1..B4 must each emit one merge.landed (got ${read.landed.length})`);
      for (const evt of read.landed) {
        assert.equal(evt.noop, false, `merge.landed for ${evt.runId} must be noop:false`);
        assert.equal(evt.target, `refs/heads/${MERGE_TARGET_REF}`);
      }
      // The park-first managed landing really ran on the dirty checkout.
      const parked = read.landed.filter(
        (e) => String(e.checkoutRefresh).startsWith("parked:") && e.parkedReason === "local-changes",
      );
      assert.equal(parked.length, 1, "exactly the first dirty-checkout landing must park with reason local-changes");

      // Every B run's real content is on the target: the per-run file exists.
      for (const r of runs) {
        const file = `.storm-rehearsal/${r.branch}.txt`;
        const show = git(h.originRepo, ["cat-file", "-e", `refs/heads/${MERGE_TARGET_REF}:${file}`]);
        assert.equal(show.status, 0, `${r.roster} content ${file} must be merged into the target: ${show.stderr}`);
      }
      assert.notEqual(
        revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`),
        targetBefore,
        "the four non-noop landings must advance the target",
      );

      // No clobber: the dirty tracked file and untracked bait survive byte-identical.
      assert.equal(fs.existsSync(dirtyTrackedPath), true, "the dirty tracked file must still exist");
      assert.ok(dirtyTrackedBytes.equals(fs.readFileSync(dirtyTrackedPath)), "the dirty tracked file must be byte-identical");
      assert.equal(fs.existsSync(dirtyBaitPath), true, "the untracked bait must still exist");
      assert.ok(dirtyBaitBytes.equals(fs.readFileSync(dirtyBaitPath)), "the untracked bait must be byte-identical");

      process.stdout.write(
        `US-004 observed: nonnoop=${read.landed.length}/4 parked=${parked.length} target=${MERGE_TARGET_REF}\n`,
      );
    } finally {
      fs.rmSync(h.ownedRoot, { recursive: true, force: true });
      const idx = cleanupDirs.indexOf(h.ownedRoot);
      if (idx >= 0) cleanupDirs.splice(idx, 1);
    }
  });
});
