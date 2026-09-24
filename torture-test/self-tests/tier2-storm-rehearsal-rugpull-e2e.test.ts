// Tier-2 STORM-REHEARSAL-FIX8 US-005 (SF-14) — end-to-end: a LIVE held
// feature-dev-merge-worktree run observes the owned origin's main move — from a
// target that has ALREADY been advanced by an earlier landed merge, the real
// campaign shape — and the PRODUCT itself emits merge.target_moved
// (relaunch-upon-rugpull).
//
// Attempt 7 (run #71) recorded SF-14 NOT EXERCISED: `mass_rugpull` advanced
// only the colleague clone's local main, so the owned origin's refs/heads/main
// never moved under a live run and the product never emitted merge.target_moved.
// Attempt 8 (run #73) then proved the deployed shape is DIVERGENT: origin/main
// had already been advanced by earlier merges while the colleague clone still
// sat on the fixture seed, so the fix7 fast-forward push exited non_fast_forward.
// This is the real contained-daemon proof that the fix8 rebase+true-fast-forward
// wiring (US-004) plus the product's own target_moved + relaunch now works in
// that exact shape:
//
//   * a private exec context (buildPrivateExecContext) under a fresh owned var
//     root inside torture-test/var gives the daemon and the launched product
//     client their own HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH roots;
//   * provisionOwnedGitFixture builds the owned origin (non-bare, main checked
//     out) + colleague clone; seedCatalogFromBundled seeds the private catalog;
//     materializeRehearsalScriptedRuntime materializes the frozen zero-token
//     runtime for feature-dev-merge-worktree;
//   * BEFORE the held run, an earlier landed merge (a true --no-ff merge
//     commit) advances the owned origin/main, so the colleague clone's main is
//     provably NOT a descendant of the current origin tip;
//   * the campaign-controlled merger checkpoint sits AFTER the merger captures
//     EXPECT_TIP (now the earlier-advanced tip) and BEFORE it invokes the real
//     `tamandua merge-branch`, so the rugpull push during the checkpoint leaves
//     the merger's expect-tip stale — a genuine atomic compare-and-swap failure
//     the product reports itself;
//   * the engine's real mass_rugpull argv (buildChaosArgv -> tt-chaos
//     colleague-commit --push-origin <origin> --ref main) fetches the CURRENT
//     owned origin tip, REBASES the colleague commit onto it, and pushes the
//     result as a TRUE fast-forward while the run is genuinely held (the
//     structured fired outcome records rebased:true + originBefore/originAfter);
//   * the test observes the product's own merge.target_moved event for that run
//     in <stateRoot>/events with expectedTip === the earlier-advanced tip and
//     actualTip === the moved tip, and waits for the run to reach terminal.
//
// The product behavior is observed from the real event stream + DB, never a
// canned verdict. This file spawns processes (git, tt-chaos, a real contained
// daemon, the product CLI): run it ALONE (never concatenated with sibling tests
// in one `node --test` process), under
// `flock --exclusive /root/matchlock-work/vaivm-gate.lock`.
//
// US-003 (STORM-REHEARSAL-FIX9, SF-14-REMAINING-2): the contained daemon, the
// launched product client and the mass_rugpull tt-chaos operator all run with a
// HERMETIC, IDENTITY-FREE git env (GIT_CONFIG_GLOBAL=/dev/null,
// GIT_CONFIG_NOSYSTEM=1, a private HOME with no .gitconfig, and an exact
// tt-chaos env that inherits nothing wholesale from the test process). Before
// this fix the E2E passed only because the operator inherited the host's global
// `~/.gitconfig` identity — the exact ambient-identity hole run #74 missed. The
// rebase+push now succeeds solely because tt-chaos injects the fixture-scoped
// identity into every git write (US-001).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  materializeRehearsalScriptedRuntime,
  provisionOwnedGitFixture,
  readRehearsalWorkflowTexts,
  rehearsalDaemonPathExtra,
  renderRehearsalDaemonEnvScript,
  seedCatalogFromBundled,
} from "../bin/tt-storm-rehearsal.mjs";
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
const TARGET_MOVED_TIMEOUT_MS = 180_000;
const TERMINAL_TIMEOUT_MS = 240_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
const MERGE_TARGET_REF = "main";
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

// SF-14 (US-003): an env is identity-free when git can resolve NO author/
// committer from it: no GIT_AUTHOR_*/GIT_COMMITTER_*, no EMAIL fallback, and
// both global+system config disabled. A git write run under it can only succeed
// because the caller (tt-chaos, US-001) supplies the fixture identity itself.
function assertIdentityFreeGitEnv(env: Record<string, string | undefined>, label: string): void {
  for (const key of Object.keys(env)) {
    assert.ok(!/^GIT_AUTHOR_|^GIT_COMMITTER_/.test(key), `${label} must not carry an identity var: ${key}`);
  }
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null", `${label} must disable the global git config`);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1", `${label} must disable the system git config`);
  assert.ok(!("EMAIL" in env), `${label} must not carry the EMAIL identity fallback`);
}

// The exact, identity-free env handed to the mass_rugpull tt-chaos operator.
// It inherits NOTHING wholesale from the test process (the pre-US-003 helper
// merged process.env, so an ambient host global identity silently made the
// fixture-shaped E2E pass). tt-chaos supplies the fixture git identity itself.
function buildMassRugpullEnv(h: RugpullHarness): Record<string, string> {
  return {
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: h.execCtx.home_root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    TT_ROOT: OWNED_VAR_ROOT,
    TT_HOME: h.execCtx.state_root,
    TAMANDUA_STATE_DIR: h.execCtx.state_root,
    TAMANDUA_DB_PATH: h.execCtx.db_path,
    TAMANDUA_TEST_GUARD: "1",
  };
}

// US-005 (SF-14): the REAL campaign shape has origin/main ALREADY advanced by
// an earlier landed merge before the held merge-worktree run starts. Landing
// that earlier merge here (a true --no-ff merge commit, so origin tip is a
// descendant of the fixture seed) makes the colleague clone's main provably NOT
// a descendant of the current origin/main; the mass_rugpull push therefore can
// only succeed as a rebase + TRUE fast-forward, never the fix7 fast-forward
// assumption.
function advanceOwnedOriginMain(h: RugpullHarness): string {
  const env = {
    GIT_AUTHOR_NAME: "storm-rehearsal earlier-merge",
    GIT_AUTHOR_EMAIL: "storm-rehearsal-earlier-merge@tetradactyla.org",
    GIT_COMMITTER_NAME: "storm-rehearsal earlier-merge",
    GIT_COMMITTER_EMAIL: "storm-rehearsal-earlier-merge@tetradactyla.org",
  };
  const rel = "docs/earlier-landed-merge.md";
  const branch = "earlier-landed-merge";

  assert.equal(git(h.originRepo, ["checkout", "-b", branch], env).status, 0, "advanced-origin: create the earlier merge branch");
  fs.mkdirSync(path.dirname(path.join(h.originRepo, rel)), { recursive: true });
  fs.writeFileSync(
    path.join(h.originRepo, rel),
    "earlier landed merge: origin/main advanced before the held rugpull run\n",
    "utf8",
  );
  assert.equal(git(h.originRepo, ["add", "--", rel], env).status, 0, "advanced-origin: stage the earlier change");
  assert.equal(
    git(h.originRepo, ["commit", "-q", "-m", "rehearsal: earlier landed merge advances origin/main"], env).status,
    0,
    "advanced-origin: commit the earlier change",
  );
  assert.equal(git(h.originRepo, ["checkout", MERGE_TARGET_REF], env).status, 0, "advanced-origin: return to main");
  assert.equal(
    git(h.originRepo, ["merge", "--no-ff", "-q", "-m", `rehearsal: land ${branch} into ${MERGE_TARGET_REF}`, branch], env).status,
    0,
    "advanced-origin: land the earlier merge into main",
  );
  return revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`);
}

// The fired colleague-commit structured outcomes for THIS run (the chaos log is
// under the fixed TT_ROOT = torture-test/var, so scope by the unique run id).
function chaosFiredForRun(runFullId: string): any[] {
  const logPath = path.join(OWNED_VAR_ROOT, "chaos", "chaos.log");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .filter((e) => e.action === "colleague-commit" && e.runId === runFullId && e.outcome === "fired");
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

// Read the PRODUCT's own per-run event stream (<stateRoot>/events/<bare>.jsonl).
function readRunEvents(stateRoot: string, bare: string): any[] {
  const evFile = path.join(stateRoot, "events", `${bare}.jsonl`);
  if (!fs.existsSync(evFile)) return [];
  return fs
    .readFileSync(evFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

// Retain the failing run's DB rows + event tail OUTSIDE the owned temp root
// (which the finally removes) so a discovery failure is diagnosable.
function dumpDiagnostics(h: RugpullHarness, label: string, bare: string | null): string {
  fs.mkdirSync(DIAGNOSTICS_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DIAGNOSTICS_ROOT, "rugpull-e2e-"));
  const snapshot: Record<string, unknown> = {
    label,
    observedAt: new Date().toISOString(),
    run: bare,
    dbPath: h.execCtx.db_path,
    holdDir: h.holdDir,
    holdMarkers: fs.existsSync(h.holdDir) ? fs.readdirSync(h.holdDir) : [],
  };
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
// A rugpull push during that window leaves EXPECT_TIP stale, so the product's
// atomic compare-and-swap fails and IT emits merge.target_moved.
function renderRugpullMergerCommand(holdDir: string): string {
  return [
    `set -u`,
    `EXPECT_TIP="$(git -C '{{input.WORKTREE_ORIGIN_REPOSITORY}}' rev-parse 'refs/heads/{{input.ORIGINAL_BRANCH}}')"`,
    `RUN_ID='{{input.RUN_ID}}'`,
    `HOLD_DIR=${JSON.stringify(holdDir)}`,
    `mkdir -p "$HOLD_DIR"`,
    `printf '{"runId":"run-%s","holdId":"${HOLD_ID}","expectTip":"%s"}\\n' "$RUN_ID" "$EXPECT_TIP" > "$HOLD_DIR/run-$RUN_ID.confirmed"`,
    `i=0`,
    `while [ ! -f "$HOLD_DIR/run-$RUN_ID.release" ]; do i=$((i+1)); [ "$i" -lt 2400 ] || { echo "storm-rugpull-e2e: merger checkpoint not released within bound" >&2; exit 4; }; sleep 0.05; done`,
    `MESSAGE_FILE="$(mktemp)"`,
    `printf 'fix: scripted rehearsal merge\\n\\nCo-Authored-By: Tamandua <tamandua@tetradactyla.org>\\n' > "$MESSAGE_FILE"`,
    `tamandua merge-branch --origin '{{input.WORKTREE_ORIGIN_REPOSITORY}}' --branch '{{input.BRANCH}}' --into '{{input.ORIGINAL_BRANCH}}' --expect-tip "$EXPECT_TIP" --message "$(cat "$MESSAGE_FILE")"`,
    `MERGE_EXIT=$?`,
    `rm -f "$MESSAGE_FILE"`,
    `exit $MERGE_EXIT`,
  ].join("\n");
}

// Replace the materialized merger behavior with the checkpoint command and
// remove the built-in pre-command hold (the checkpoint itself IS the hold; it
// must sit after the expect-tip capture, which the built-in hold does not).
function installRugpullMergerCheckpoint(behaviorsFile: string, holdDir: string): void {
  const doc = JSON.parse(fs.readFileSync(behaviorsFile, "utf8"));
  const merger = doc?.agents?.[AGENT_KEY];
  assert.ok(merger, `materialized behaviors must carry ${AGENT_KEY}`);
  delete merger.hold;
  merger.includeCommandOutput = true;
  merger.commands = [renderRugpullMergerCommand(holdDir)];
  fs.writeFileSync(behaviorsFile, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

interface RugpullHarness {
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

async function buildRugpullHarness(campaignId: string): Promise<RugpullHarness> {
  const ownedRoot = fs.mkdtempSync(path.join(OWNED_VAR_ROOT, "rehearsal-rugpull-e2e-"));
  cleanupDirs.push(ownedRoot);
  const varRoot = path.join(ownedRoot, "exec");
  const campaignDir = path.join(ownedRoot, "campaign");
  fs.mkdirSync(campaignDir, { recursive: true });

  const execCtx = buildPrivateExecContext({
    varRoot,
    binaries: { tamandua: TAMANDUA_BIN },
    // SF-14 (US-003): the contained daemon/worker/product env must carry NO
    // git identity and must not let git resolve an ambient global config. The
    // only identity a git WRITE can see is the fixture-scoped one tt-chaos
    // injects into the write's own child env (US-001).
    extraEnv: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

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
  installRugpullMergerCheckpoint(scriptedRuntime.behaviors_file, holdDir);

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
    gitHermetic: true,
  });
  fs.writeFileSync(envScript, content, { mode: 0o600 });

  const taskFile = path.join(ownedRoot, "storm-rugpull.task.md");
  fs.writeFileSync(
    taskFile,
    "STORM-REHEARSAL-FIX8 US-005 SF-14 E2E: an already-advanced origin/main moves under a held merge-worktree run and the product emits merge.target_moved.\n",
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

function runDaemonControl(h: RugpullHarness, op: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(DAEMON_CONTROL, ["scripted", op], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...h.execCtx.child_env, ...h.daemonEnv, TT_DAEMON_PORT_WAIT_SECONDS: "10" },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

// Run the engine's REAL mass_rugpull operator argv (tt-chaos colleague-commit
// --push-origin <origin> --ref main) inside the contained TT_ROOT, with an
// EXACT identity-free env (SF-14 US-003): the operator's success must come from
// its own fixture identity (US-001), never from an inherited host identity.
function runMassRugpull(h: RugpullHarness, argv: string[], env: Record<string, string> = buildMassRugpullEnv(h)) {
  const res = spawnSync(TT_CHAOS, argv.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env,
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function massRugpullArgv(h: RugpullHarness, runFullId: string): string[] {
  const ctx = {
    varRoot: h.execCtx.var_root,
    opts: {
      fixtureIdentity: {
        colleagueRepo: h.colleagueRepo,
        cc1File: h.cc1File,
        cc2File: h.cc1File,
        parkRepo: h.parkRepo,
        originRepo: h.originRepo,
        seedRef: "seed/storm",
      },
      originRepo: h.originRepo,
    },
  };
  const built = buildChaosArgv(
    ctx as any,
    { plan: { fixtureIdentity: ctx.opts.fixtureIdentity } } as any,
    { kind: "mass_rugpull", targets: ["B1", "B2", "B3", "B4"] } as any,
    runFullId,
  );
  assert.equal(built.ok, true, `mass_rugpull must build a real operator argv: ${(built as any).reason}`);
  return built.argv as string[];
}

describe("tier2-storm-rehearsal-rugpull-e2e (US-005 SF-14)", () => {
  it("E0: the campaign merger checkpoint is armed after the expect-tip capture and the push argv targets the owned origin", async () => {
    const h = await buildRugpullHarness(`rugpull-e2e-preflight-${process.pid}-${Date.now()}`);
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
      assert.ok(cmd.includes(`--expect-tip "$EXPECT_TIP"`), "the product must receive the captured (pre-rugpull) expect tip");
      assert.ok(cmd.indexOf("EXPECT_TIP=") < cmd.indexOf("HOLD_DIR="), "the checkpoint marker is written AFTER the expect-tip capture");
      assert.ok(cmd.trim().split("\n").length >= 8, "the checkpoint command must carry the real hold-blocking body");
      assert.ok(cmd.includes(`${HOLD_ID}`), "the hold marker must name the campaign hold id");

      const argv = massRugpullArgv(h, "run-00000000-0000-4000-8000-000000000000");
      assert.equal(argv[0], "tt-chaos");
      assert.equal(argv[1], "colleague-commit");
      assert.equal(argv[argv.indexOf("--repo") + 1], h.colleagueRepo);
      assert.equal(argv[argv.indexOf("--file") + 1], h.cc1File);
      assert.equal(argv[argv.indexOf("--push-origin") + 1], h.originRepo, "the rugpull must push to the owned origin");
      assert.equal(argv[argv.indexOf("--ref") + 1], MERGE_TARGET_REF);
      assert.ok(h.originRepo.startsWith(`${OWNED_VAR_ROOT}${path.sep}`), "the origin is campaign-contained");

      // ── SF-14 (US-003): the contained env is identity-free ──────────
      // The private exec child env (daemon-control, the product CLI, the
      // launched run) carries no identity and disables global/system config.
      assertIdentityFreeGitEnv(h.execCtx.child_env as Record<string, string>, "private exec child env");
      // The mass_rugpull tt-chaos env is built EXACTLY (no process.env merge):
      // identity-free, so the push can only succeed via tt-chaos's own fixture
      // identity (US-001).
      assertIdentityFreeGitEnv(buildMassRugpullEnv(h), "mass_rugpull tt-chaos env");
      // The private HOME has no .gitconfig: even the local-config identity
      // source is absent (the real campaign fixture shape).
      assert.equal(
        fs.existsSync(path.join(h.execCtx.home_root, ".gitconfig")),
        false,
        "the private HOME must not carry a .gitconfig",
      );
      // The rendered daemon env script also disables global/system config and
      // carries no identity var.
      const scriptText = fs.readFileSync(String(h.daemonEnv.TT_DC_ENV_SCRIPTED), "utf8");
      assert.match(scriptText, /^export GIT_CONFIG_GLOBAL=\/dev\/null$/m, "daemon env must disable the global git config");
      assert.match(scriptText, /^export GIT_CONFIG_NOSYSTEM=1$/m, "daemon env must disable the system git config");
      assert.ok(!/GIT_AUTHOR_|GIT_COMMITTER_|^export EMAIL=/m.test(scriptText), "daemon env must not carry an identity");
      const printLine = scriptText.split("\n").find((l) => l.trim().startsWith("for v in"));
      assert.ok(printLine?.includes("GIT_CONFIG_GLOBAL"), "the daemon print contract must forward GIT_CONFIG_GLOBAL");
    } finally {
      fs.rmSync(h.ownedRoot, { recursive: true, force: true });
      const idx = cleanupDirs.indexOf(h.ownedRoot);
      if (idx >= 0) cleanupDirs.splice(idx, 1);
    }
  });

  it("E1: one real held merge-worktree run observes the ALREADY-ADVANCED owned origin main move and the product emits merge.target_moved", async () => {
    const campaignId = `rugpull-e2e-${process.pid}-${Date.now()}`;
    const h = await buildRugpullHarness(campaignId);
    const sinceUtc = new Date().toISOString();

    let daemonStarted = false;
    let runId: string | null = null;
    let bareRunId: string | null = null;
    let advancedTip: string | null = null;
    let bodyError: unknown = null;
    let stopResult: { status: number | null; stdout: string; stderr: string } | null = null;
    let observedTargetMoved = 0;
    let observedLanded = 0;
    let finalStatus: string | null = null;
    let childIds: string[] = [];
    try {
      // ── the REAL campaign shape: advance origin/main BEFORE the held run ──
      // An earlier merge already landed on the target, so the colleague clone's
      // main is provably NOT a descendant of the current origin/main. This is
      // what forces the mass_rugpull push through the rebase + true
      // fast-forward path instead of the fix7 fast-forward assumption, and it
      // means the held merger captures the ADVANCED tip as its expect tip.
      advancedTip = advanceOwnedOriginMain(h);
      assert.notEqual(advancedTip, h.mainHead, "the earlier landed merge must move origin/main off the fixture seed");
      assert.equal(
        git(h.originRepo, ["merge-base", "--is-ancestor", h.mainHead, advancedTip]).status,
        0,
        "the fixture seed must be an ancestor of the earlier-advanced origin tip",
      );
      const colleagueSeedHead = revParse(h.colleagueRepo, "HEAD");
      assert.notEqual(
        git(h.colleagueRepo, ["merge-base", "--is-ancestor", advancedTip, colleagueSeedHead]).status,
        0,
        "the colleague main must NOT be a descendant of the advanced origin/main at the moment of the rugpull",
      );
      process.stdout.write(
        `US-005 advanced-origin: seed=${h.mainHead} advanced=${advancedTip} colleagueSeed=${colleagueSeedHead} colleagueIsDescendantOfAdvanced=false\n`,
      );

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
      assert.equal(
        confirmed.expectTip,
        advancedTip,
        "the held merger must have captured the EARLIER-ADVANCED origin tip as its expect tip (real campaign shape)",
      );
      assert.equal(fs.existsSync(path.join(h.holdDir, `${runId}.release`)), false, "the release must not exist before the test writes it");
      assert.equal(readRunRow(h.execCtx.db_path, bare)?.status, "running", "the held run must be running while parked");

      // ── while genuinely held, run the engine's mass_rugpull argv ────
      const beforeTip = revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`);
      assert.equal(beforeTip, advancedTip, "origin main must be at the earlier-advanced tip before the rugpull");
      const argv = massRugpullArgv(h, runId);
      const pushEnv = buildMassRugpullEnv(h);
      assertIdentityFreeGitEnv(pushEnv, "mass_rugpull tt-chaos env (E1)");
      const push = runMassRugpull(h, argv, pushEnv);
      assert.equal(push.status, 0, `mass_rugpull push must succeed:\n${push.stderr}\n${push.stdout}`);
      const colleagueHead = revParse(h.colleagueRepo, "HEAD");
      const afterTip = revParse(h.originRepo, `refs/heads/${MERGE_TARGET_REF}`);
      assert.notEqual(afterTip, beforeTip, "origin refs/heads/main must actually have moved while the run is held");
      assert.equal(afterTip, colleagueHead, "origin main must equal the rebased colleague HEAD (real fast-forward push)");
      assert.equal(git(h.originRepo, ["merge-base", "--is-ancestor", beforeTip, colleagueHead]).status, 0,
        "the previous (advanced) origin tip must be an ancestor of the pushed commit (TRUE fast-forward)");

      // The operator structured outcome proves the push really took the
      // rebase path (not the fix7 fast-forward assumption) and recorded the
      // advanced tip as originBefore.
      const fired = chaosFiredForRun(runId);
      assert.equal(fired.length, 1, "exactly one fired colleague-commit outcome for this run");
      assert.equal(fired[0].rebased, true, "the mass_rugpull push must have rebased the colleague clone onto the advanced origin");
      assert.equal(fired[0].pushRef, MERGE_TARGET_REF);
      assert.equal(fired[0].originBefore, beforeTip, "the fired outcome must record the earlier-advanced origin tip");
      assert.equal(fired[0].originAfter, afterTip, "the fired outcome must record the moved origin tip");
      assert.match(String(fired[0].preRebaseHead), /^[0-9a-f]{40}$/, "the fired outcome must record the pre-rebase colleague head");
      assert.notEqual(fired[0].preRebaseHead, colleagueHead, "the rebase must rewrite the colleague commit id");

      // ── release the hold; the merger now merges with a STALE expect tip ─
      fs.writeFileSync(path.join(h.holdDir, `${runId}.release`), "go\n", "utf8");

      // ── observe the PRODUCT's own merge.target_moved event ──────────
      const read = await waitFor("product merge.target_moved observed", () => {
        const r = readProductMergeEvents({ stateRoot: h.execCtx.state_root, runIds: [bare], sinceUtc });
        assert.equal(r.ok, true, `product merge-event channel must be readable: ${r.error}`);
        return r.targetMoved.length > 0 ? r : null;
      }, { timeoutMs: TARGET_MOVED_TIMEOUT_MS });
      observedTargetMoved = read.targetMoved.length;
      assert.ok(observedTargetMoved >= 1, "the product itself must emit merge.target_moved (relaunch-upon-rugpull)");
      const evt = read.targetMoved[0];
      assert.equal(evt.event, "merge.target_moved");
      assert.equal(String(evt.runId), bare, "the target_moved event must belong to this run");
      assert.equal(
        evt.expectedTip,
        advancedTip,
        "the product must report the EARLIER-ADVANCED tip it captured before the rugpull",
      );
      assert.equal(evt.expectedTip, confirmed.expectTip, "the product must report the stale expect tip it captured");
      assert.equal(evt.actualTip, afterTip, "the product must report the rugpull-moved tip");
      assert.equal(evt.target, `refs/heads/${MERGE_TARGET_REF}`);

      // ── the run reaches terminal (completed) or a first-class child ──
      // The held run is no longer running: the stock on_fail retry_step: test
      // reroutes the target_moved failure and the run completes after
      // re-merging, or a first-class replacement/child run carries the lineage.
      // Never silently tolerated as an unobserved wedge.
      const outcome = await waitFor("run terminal or first-class child", () => {
        const row = readRunRow(h.execCtx.db_path, bare);
        if (row && TERMINAL_STATUSES.has(row.status)) {
          return { status: row.status, children: [] as string[] };
        }
        const kids = childRuns(h.execCtx.db_path, bare);
        if (kids.length > 0) return { status: row?.status ?? "running", children: kids };
        return null;
      }, { timeoutMs: TERMINAL_TIMEOUT_MS });
      finalStatus = outcome.status;
      childIds = outcome.children;
      assert.ok(
        TERMINAL_STATUSES.has(outcome.status) || childIds.length > 0,
        "the rugpulled run must reach terminal status or spawn a first-class replacement/child run",
      );
      process.stdout.write(
        `US-005 observed: run=${runId} target_moved=${observedTargetMoved} terminal=${finalStatus} children=[${childIds.join(",")}]\n`,
      );

      const finalRead = readProductMergeEvents({ stateRoot: h.execCtx.state_root, runIds: [bare], sinceUtc });
      observedLanded = finalRead.landed.length;

      // ── the PRODUCT's own rugpull recovery is recorded ──────────────
      // The stale-expect-tip failure must be recovered by the product itself:
      // either the stock finalize_merge.on_fail reroute (a step.rerouted event
      // for finalize_merge) or a first-class replacement/child run row. A run
      // that merely reached terminal without either would be an unobserved
      // wedge, not recovery.
      const rerouted = readRunEvents(h.execCtx.state_root, bare).filter(
        (e) => e.event === "step.rerouted" && e.stepId === "finalize_merge",
      );
      assert.ok(
        rerouted.length > 0 || childIds.length > 0,
        `the product must record its rugpull recovery: a finalize_merge step.rerouted event or a replacement run row (got ${rerouted.length} reroute event(s), children=[${childIds.join(",")}])`,
      );
    } catch (err) {
      bodyError = err;
      try {
        const dir = dumpDiagnostics(h, "E1-failure", bareRunId);
        process.stdout.write(`US-005 diagnostics retained at ${dir}\n`);
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
    // Record the observed product outcome honestly (target_moved count + landing).
    assert.ok(finalStatus !== null, "the run must have reached an observed terminal state");
    // The run recovered: it reached a terminal status (the product rerouted the
    // target_moved finalize_merge failure and completed after re-merging) or a
    // child run carries the lineage. Never silently tolerated as an unobserved
    // wedge.
    assert.ok(
      TERMINAL_STATUSES.has(finalStatus) || childIds.length > 0,
      `the rugpulled run must complete/fail terminally or hand off to a child (got ${finalStatus}, children=[${childIds.join(",")}])`,
    );
    process.stdout.write(
      `US-005 summary: advanced=${advancedTip} target_moved=${observedTargetMoved} landed=${observedLanded} status=${finalStatus} rebased=true\n`,
    );
  });
});
