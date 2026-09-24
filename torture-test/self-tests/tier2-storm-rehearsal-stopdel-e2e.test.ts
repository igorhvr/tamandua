// Tier-2 STORM-REHEARSAL-FIX5 US-006 — end-to-end: the DERIVED B-stopdel
// chaos phase fires against a REAL live target and yields relaunchOf lineage.
//
// This is the chaos half of requirement 1 and the SF-8 gate. It starts from
// the US-005 contained-private-daemon harness (a REAL product daemon under the
// owned temp root, the frozen scripted runtimes, zero model tokens) with one
// REAL held B5 do-now run, and then dispatches the REAL derived B-stopdel
// phase through the engine's canonical dispatchPhaseSchedule -> dispatchPhase-
// Action path with the real proc bundle:
//
//   * `tamandua workflow stop run-<B5>`   (real product control-plane verb)
//   * `tamandua workflow delete run-<B5>` (real product control-plane verb)
//   * `tamandua workflow run do-now ... --pi-as-harness` (real identical
//     relaunch through the scripted pi runtime)
//
// Assertions (acceptance criteria 1-6):
//   1. the phase's waitOutcome is marker_satisfied (NOT evidence_error, NOT
//      run_terminal) under the REAL realCtx wiring (SF-11 regression net);
//   2. the phase action outcome is ok (all three real sub-ops exit 0);
//   3. `<holdDir>/<b5RunId>.release` is written only AFTER the phase fires;
//   4. a B5-relaunch record with relaunchOf='B5' is registered and its run row
//      appears in the campaign DB (and the relaunch lineage is released too);
//   5. the original B5 run is recorded terminal/deleted;
//   6. no production port 3334/3338/3339 is ever bound.
//
// The product behavior is observed from the real DB + campaign state, never a
// canned verdict. The file spawns processes: run it ALONE (never concatenated
// with sibling tests in one `node --test` process), under
// `flock --exclusive /root/matchlock-work/vaivm-gate.lock`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { buildPrivateExecContext } from "../bin/tt-storm-real.mjs";
import {
  allocRehearsalListenerPorts,
  materializeRehearsalScriptedRuntime,
  readRehearsalWorkflowTexts,
  rehearsalDaemonPathExtra,
  renderRehearsalDaemonEnvScript,
  scriptedRoundBPhases,
  seedCatalogFromBundled,
} from "../bin/tt-storm-rehearsal.mjs";
import { dispatchPhaseSchedule } from "../bin/tt-storm-engine.mjs";
import { opRecorder, saveState } from "../bin/tt-storm-shared.mjs";
import { realCtx } from "../bin/tt-storm";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ttRoot = path.join(repoRoot, "torture-test");
const workflowsRoot = path.join(repoRoot, "workflows");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const DAEMON_CONTROL = path.join(ttRoot, "bin", "daemon-control");
const SCRIPTED_PI = path.join(ttRoot, "scripted-runtimes", "bin", "scripted-pi");
const SCRIPTED_HERMES = path.join(ttRoot, "scripted-runtimes", "bin", "scripted-hermes");
const OWNED_VAR_ROOT = path.join(ttRoot, "var");

const PRODUCTION_PORTS = [3334, 3338, 3339];
const WORKFLOW_ID = "do-now";
const AGENT_KEY = "do-now_doer";
const HOLD_ID = "storm-midflight";
const HOLD_TIMEOUT_MS = 90_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
// The derived schedule's own hold timeout (boundedHoldTimeoutMs floor is 300s),
// but every target here already holds, so the predicate must be satisfied on
// the FIRST probe; this bound only guards a regression into a long wait.
const PHASE_WAIT_TIMEOUT_MS = 15_000;

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

function isPortListening(port: number): boolean {
  const script = `const net=require('node:net');const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000);`;
  const res = spawnSync(process.execPath, ["-e", script], { timeout: 3000, encoding: "utf8" });
  return res.status === 0;
}

function readRunRow(dbPath: string, runId: string): { id: string; status: string; parent_run_id: string | null } | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT id, status, parent_run_id FROM runs WHERE id = ?").get(runId) as
      | { id: string; status: string; parent_run_id: string | null }
      | undefined;
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

function campaignRunRec(state: any, rosterId: string): any {
  return state?.rounds?.B?.runs?.[rosterId] ?? null;
}

function readState(campaignDir: string): any {
  return JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
}

interface StopdelHarness {
  ownedRoot: string;
  varRoot: string;
  campaignId: string;
  campaignDir: string;
  execCtx: any;
  ports: { dashboard: number; mcp: number; control: number; controlUrl: string };
  scriptedStateDir: string;
  holdDir: string;
  behaviorsFile: string;
  daemonEnv: Record<string, string>;
  // SF-12 (fix-6): the B5 task file lives under an OWNED campaign tasks root
  // and is handed to the engine by absolute path (never a HOME-relative name).
  tasksRoot: string;
  taskFiles: Record<string, string>;
  // An owned, EMPTY dispatch cwd inside the contained exec context (a relative
  // --task-file could never accidentally resolve here). Never home_root.
  launchCwd: string;
}

async function buildStopdelHarness(): Promise<StopdelHarness> {
  const ownedRoot = fs.mkdtempSync(path.join(OWNED_VAR_ROOT, "rehearsal-stopdel-e2e-"));
  cleanupDirs.push(ownedRoot);
  const varRoot = path.join(ownedRoot, "exec");
  const campaignId = `stopdel-e2e-${process.pid}-${Date.now()}`;
  const campaignDir = path.join(ownedRoot, "campaign");
  fs.mkdirSync(campaignDir, { recursive: true });

  const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
  const installedRoot = path.join(execCtx.state_root, "workflows");
  seedCatalogFromBundled({ bundledRoot: workflowsRoot, installedRoot });

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

  // SF-12 (fix-6): provision the per-roster task files under an OWNED
  // campaign tasks root. The engine resolves the B-stopdel relaunch
  // (rosterId 'B5-relaunch', taskFileRosterId 'B5') to the absolute
  // tasksRoot/storm-b5-donow.task.md — NEVER a bare name resolved against the
  // private HOME (the previous mask: this test pre-created the file in
  // execCtx.home_root and ran the engine with cwd=home_root, hiding SF-12).
  const tasksRoot = path.join(execCtx.var_root, "tasks");
  fs.mkdirSync(tasksRoot, { recursive: true });
  const taskFiles: Record<string, string> = {};
  for (const rid of ["B1", "B2", "B3", "B4", "B5"]) {
    const runName = rid === "B5" ? "storm-b5-donow" : `storm-${rid.toLowerCase()}-fixture`;
    const file = path.join(tasksRoot, `${runName}.task.md`);
    fs.writeFileSync(file, `STORM-REHEARSAL-FIX6 US-001 ${rid} task file (owned tasks root).\n`);
    taskFiles[rid] = file;
  }

  const holdDir = path.join(scriptedRuntime.state_dir, "holds");
  fs.mkdirSync(holdDir, { recursive: true });

  // An owned, EMPTY dispatch cwd (must stay inside the contained exec context):
  // deliberately NOT home_root, and carrying no task files, so the old
  // HOME-relative `storm-b5-donow.task.md` fallback could never resolve here.
  const launchCwd = path.join(execCtx.var_root, "launch-cwd");
  fs.mkdirSync(launchCwd, { recursive: true });

  return {
    ownedRoot,
    varRoot,
    campaignId,
    campaignDir,
    execCtx,
    ports,
    scriptedStateDir: scriptedRuntime.state_dir,
    holdDir,
    behaviorsFile: scriptedRuntime.behaviors_file,
    daemonEnv: { TT_DC_ENV_SCRIPTED: envScript, TT_FORCE_NO_SYSTEMD: "1" },
    tasksRoot,
    taskFiles,
    launchCwd,
  };
}

function runDaemonControl(h: StopdelHarness, op: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(DAEMON_CONTROL, ["scripted", op], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...h.execCtx.child_env, ...h.daemonEnv, TT_DAEMON_PORT_WAIT_SECONDS: "10" },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function writeHoldMarker(holdDir: string, runId: string, suffix: string, payload?: unknown): void {
  fs.mkdirSync(holdDir, { recursive: true });
  fs.writeFileSync(
    path.join(holdDir, `${runId}${suffix}`),
    `${JSON.stringify(payload ?? { runId, holdId: HOLD_ID, ts: new Date().toISOString() })}\n`,
    "utf8",
  );
}

describe("tier2-storm-rehearsal-stopdel-e2e (US-006)", () => {
  it("E1: derived B-stopdel fires on a live B5, releases after fire, and yields relaunchOf lineage", async () => {
    const h = await buildStopdelHarness();

    // ── US-004 AC1: the SF-12 home_root mask is GONE ──────────────────────
    // The old test pre-created `<home_root>/storm-b5-donow.task.md` and ran
    // the engine with cwd=home_root, so the old relative fallback resolved and
    // masked SF-12. Pin that the mask can never return: no B5 task file under
    // the private HOME, an engine dispatch cwd inside the owned exec context
    // (never home_root, and empty of the bare name), and the B5 task file
    // provisioned under an ABSOLUTE owned campaign tasks root.
    assert.notEqual(h.launchCwd, h.execCtx.home_root, "the engine dispatch cwd must never be home_root");
    assert.ok(
      h.launchCwd.startsWith(`${h.execCtx.var_root}${path.sep}`),
      `the engine dispatch cwd must be an owned path under ${h.execCtx.var_root}, got ${h.launchCwd}`,
    );
    assert.equal(
      fs.existsSync(path.join(h.execCtx.home_root, "storm-b5-donow.task.md")),
      false,
      "the test must not pre-create a HOME-relative B5 task file (the removed SF-12 mask)",
    );
    assert.equal(
      fs.existsSync(path.join(h.launchCwd, "storm-b5-donow.task.md")),
      false,
      "the old relative fallback name must not resolve in the engine dispatch cwd",
    );
    assert.ok(path.isAbsolute(h.tasksRoot), `the campaign tasks root must be absolute, got ${h.tasksRoot}`);
    assert.ok(
      h.tasksRoot.startsWith(`${h.execCtx.var_root}${path.sep}`),
      `the campaign tasks root must be owned (under ${h.execCtx.var_root}), got ${h.tasksRoot}`,
    );
    assert.equal(
      h.taskFiles["B5-relaunch"],
      undefined,
      "B5-relaunch must not be a taskFiles key: resolution must go through taskFileRosterId=B5",
    );
    assert.equal(
      h.taskFiles.B5,
      path.join(h.tasksRoot, "storm-b5-donow.task.md"),
      "the B5 release task file must be provisioned under the owned tasks root",
    );
    assert.equal(fs.existsSync(h.taskFiles.B5), true, "the B5 task file must exist under the tasks root");

    // The materialized behavior carries the campaign hold on the do-now doer.
    const behaviors = JSON.parse(fs.readFileSync(h.behaviorsFile, "utf8"));
    assert.ok(behaviors.agents?.[AGENT_KEY], `behaviors must carry ${AGENT_KEY}`);
    assert.equal(behaviors.agents[AGENT_KEY].hold?.id, HOLD_ID);

    // ── synthetic live-held B1..B4 (real hold markers, no real runs) ──────
    // The B-stopdel predicate waits on B1..B4 (`other-four-mid-flight`). They
    // are live-held targets with REAL confirmed hold markers; the campaign DB
    // has no row for them (they are never launched here), which keeps
    // resolveRosterTerminal non-terminal — exactly the "live target" state the
    // derived schedule needs. This is probe input, never a verdict: the
    // predicate still resolves each target's marker from disk.
    const syntheticRuns: Record<string, string> = {};
    for (const rid of ["B1", "B2", "B3", "B4"]) {
      syntheticRuns[rid] = `run-${crypto.randomUUID()}`;
      writeHoldMarker(h.holdDir, syntheticRuns[rid], ".confirmed");
    }

    let daemonStarted = false;
    let bodyError: unknown = null;
    let stopResult: { status: number | null; stdout: string; stderr: string } | null = null;
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
      const provFile = path.join(OWNED_VAR_ROOT, "daemon-control", "scripted.json");
      const prov = JSON.parse(fs.readFileSync(provFile, "utf8"));
      for (const port of prov.ports) {
        assert.equal(PRODUCTION_PORTS.includes(Number(port)), false, `daemon-control recorded a production port ${port}`);
      }

      // ── launch the REAL B5 do-now run and wait for it to park ───────
      const launchEnv: NodeJS.ProcessEnv = {
        ...h.execCtx.child_env,
        TAMANDUA_CONTROL_PORT: String(h.ports.control),
        TAMANDUA_DASHBOARD_PORT: String(h.ports.dashboard),
        TAMANDUA_MCP_PORT: String(h.ports.mcp),
        TAMANDUA_PI_BINARY: SCRIPTED_PI,
      };
      const task = "STORM-REHEARSAL-FIX5 US-006 B5 stop/delete/relaunch E2E.";
      // US-004: the PRIMARY B5 product launch may run in the private HOME
      // (the contained, safe cwd). Critically, it writes NO task file there:
      // the engine's own dispatch cwd is h.launchCwd (an owned EMPTY dir), so
      // the relaunch cannot rely on a HOME-relative task file. The B5 task
      // file lives absolutely under h.tasksRoot.
      const launch = spawnSync(TAMANDUA_BIN, ["workflow", "run", WORKFLOW_ID, task], {
        cwd: h.execCtx.home_root,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        env: launchEnv,
      });
      assert.equal(launch.status, 0, `product CLI workflow run must succeed:\n${launch.stderr}\n${launch.stdout}`);
      const b5RunId = await waitFor("B5 run row persisted", () => {
        const id = newestRunId(h.execCtx.db_path);
        return id ? `run-${id}` : null;
      }, { timeoutMs: 30_000 });
      assert.match(b5RunId, /^run-[0-9a-f-]{36}$/, "the B5 run id must be a public run-<uuid>");
      const b5Bare = b5RunId.slice(4);

      // B5 is genuinely parked on the campaign hold AND running.
      await waitFor("B5 parked on confirmed hold", () => (fs.existsSync(path.join(h.holdDir, `${b5RunId}.confirmed`)) ? true : null), {
        timeoutMs: 60_000,
      });
      await waitFor("B5 run row running", () => {
        const row = readRunRow(h.execCtx.db_path, b5Bare);
        return row && row.status === "running" ? row : null;
      }, { timeoutMs: 30_000 });
      assert.equal(fs.existsSync(path.join(h.holdDir, `${b5RunId}.release`)), false, "B5 must not be released before the phase fires");

      // ── build the campaign state + the real exact CLI ctx ───────────
      const derivedBStopdel = scriptedRoundBPhases({ phaseStepMs: 1, startOffsetMs: 0 }).find(
        (p: any) => p.id === "B-stopdel",
      );
      assert.ok(derivedBStopdel, "the derived schedule must carry B-stopdel");
      assert.equal(derivedBStopdel.action.kind, "stop_delete_relaunch");
      assert.equal(derivedBStopdel.action.target, "B5");
      assert.equal(derivedBStopdel.waitFor.kind, "hold");
      assert.deepEqual(derivedBStopdel.waitFor.targets, ["B1", "B2", "B3", "B4"]);
      assert.deepEqual(derivedBStopdel.release_targets, ["B5"]);

      const state: any = {
        schema_version: 1,
        campaign_id: h.campaignId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        mode: "run-B",
        source: { commit: null, tree: null, tree_dirty: false },
        fixture: { name: "tiny-owned-infrastructure-fixture", basis: "SCRIPTED_REHEARSAL" },
        daemon_ports: {
          dashboard: h.ports.dashboard,
          mcp: h.ports.mcp,
          control: h.ports.control,
          controlUrl: h.ports.controlUrl,
        },
        rehearsal: {
          hold_schedule: { hold_id: HOLD_ID, hold_timeout_ms: HOLD_TIMEOUT_MS },
          scripted_runtime: { state_dir: h.scriptedStateDir, behaviors_file: h.behaviorsFile },
        },
        plan: { roundBPhases: [derivedBStopdel] },
        rounds: {
          A: { status: "round_done", runs: {} },
          B: {
            status: "running",
            phases: {},
            runs: {
              ...Object.fromEntries(
                Object.entries(syntheticRuns).map(([rid, runId]) => [
                  rid,
                  {
                    rosterId: rid,
                    run: `storm-${rid.toLowerCase()}-fixture`,
                    workflow: "bug-fix-merge-worktree",
                    harness: "pi",
                    status: "registered",
                    runId,
                    children: [],
                    relaunchOf: null,
                  },
                ]),
              ),
              B5: {
                rosterId: "B5",
                run: "storm-b5-donow",
                workflow: WORKFLOW_ID,
                harness: "pi",
                status: "registered",
                runId: b5RunId,
                children: [],
                relaunchOf: null,
              },
            },
          },
        },
      };
      saveState({ fs: fs, campaignDir: h.campaignDir, state });
      const ops = opRecorder({ fs, campaignDir: h.campaignDir });

      const ctx = realCtx({
        bopts: {
          dbPath: h.execCtx.db_path,
          holdDir: h.holdDir,
          phaseWaitTimeoutMs: PHASE_WAIT_TIMEOUT_MS,
          // SF-12 (fix-6): NO home_root mask. The engine resolves every launch
          // task file from the owned tasks root (absolute), and the dispatch
          // cwd is an owned, EMPTY dir inside the contained exec context — a
          // relative --task-file could never accidentally resolve here.
          launchCwd: h.launchCwd,
          taskFiles: h.taskFiles,
          taskFileRoot: h.tasksRoot,
          launchEnv: { ...launchEnvFor(h.ports, SCRIPTED_PI) },
          controlUrl: h.ports.controlUrl,
          daemonKind: "scripted",
          daemonEnv: h.daemonEnv,
          daemonProvenanceDir: path.join(OWNED_VAR_ROOT, "daemon-control"),
        },
        execCtx: h.execCtx,
        campaignDir: h.campaignDir,
      });

      // ── dispatch the REAL derived B-stopdel schedule ────────────────
      await dispatchPhaseSchedule(ctx, state, ops, h.campaignDir, ctx.clock.nowMs());

      const bstopdel = state.rounds.B.phases["B-stopdel"];
      assert.ok(bstopdel, "B-stopdel must be recorded");
      // Criterion 2: marker_satisfied under the REAL wiring (SF-11).
      assert.equal(
        bstopdel.waitOutcome?.outcome,
        "marker_satisfied",
        `B-stopdel waitOutcome must be marker_satisfied, got ${JSON.stringify(bstopdel.waitOutcome)}`,
      );
      assert.equal(bstopdel.waitOutcome?.satisfied, true);
      // Criterion 3: the phase genuinely fired ok. On failure, retain the
      // recorded sub-ops under the campaign dir so the failure is diagnosable
      // from the test output (never a canned verdict).
      if (bstopdel.status !== "fired") {
        const diag = ops
          .readAll()
          .filter((e: any) => e.id === "B-stopdel" || e.kind === "phase.fired" || e.kind === "phase.action_failed");
        process.stdout.write(`B-stopdel diagnostic: ${JSON.stringify({ phase: bstopdel, diag }, null, 2)}\n`);
      }
      assert.equal(bstopdel.status, "fired", `B-stopdel must fire, got ${bstopdel.status}`);
      assert.ok(bstopdel.firedAt, "a fired phase must carry firedAt");

      // Criterion 1 (SF-12): the relaunch argv resolves its task file to an
      // ABSOLUTE path under the owned campaign tasks root — never the bare
      // `storm-b5-donow.task.md` the old resolver emitted, which the product
      // ENOENTed against the private HOME cwd. The relaunch is spawned with
      // cwd = h.launchCwd (an owned EMPTY dir), so a relative name could not
      // resolve even accidentally; the absolute path is the contract.
      const relaunchIntent = ops
        .readAll()
        .find((e: any) => e.kind === "phase.relaunch.intent" && e.id === "B-stopdel");
      assert.ok(relaunchIntent, "the relaunch intent argv must be recorded before dispatch");
      const relaunchTaskFile = relaunchIntent.argv[relaunchIntent.argv.indexOf("--task-file") + 1];
      assert.equal(
        path.resolve(relaunchTaskFile),
        path.resolve(h.taskFiles.B5),
        "the relaunch names the SAME absolute B5 task file as the primary launch",
      );
      assert.ok(path.isAbsolute(relaunchTaskFile), `the relaunch --task-file must be absolute, got ${relaunchTaskFile}`);
      assert.ok(relaunchTaskFile.startsWith(`${h.tasksRoot}${path.sep}`), "the relaunch --task-file must live under the owned tasks root");
      assert.equal(
        relaunchTaskFile.startsWith(`${h.execCtx.home_root}${path.sep}`),
        false,
        `the relaunch --task-file must not be a HOME-relative path, got ${relaunchTaskFile}`,
      );
      assert.notEqual(relaunchTaskFile, "storm-b5-donow.task.md", "the relaunch must never emit a bare relative task file");

      // Criterion 4: the B5 release is written AFTER the phase fired.
      const b5ReleasePath = path.join(h.holdDir, `${b5RunId}.release`);
      assert.equal(fs.existsSync(b5ReleasePath), true, "the engine must release B5 after B-stopdel fires");
      const opsEntries = ops.readAll();
      const firedIdx = opsEntries.findIndex((e: any) => e.kind === "phase.fired" && e.id === "B-stopdel");
      const releasedIdx = opsEntries.findIndex((e: any) => e.kind === "hold.released_for_phase" && e.id === "B-stopdel");
      assert.ok(firedIdx >= 0, "phase.fired for B-stopdel must be recorded");
      assert.ok(releasedIdx > firedIdx, "hold.released_for_phase must be recorded AFTER phase.fired (release-after-fire)");

      // Criterion 5: the original B5 run is recorded terminal/deleted.
      const b5Rec = campaignRunRec(readState(h.campaignDir), "B5");
      assert.equal(b5Rec?.status, "terminal", "B5 must be recorded terminal after stop+delete");
      assert.equal(b5Rec?.terminalStatus, "deleted", "B5 terminalStatus must be deleted");

      // Criterion 4 (lineage): a B5-relaunch record with relaunchOf='B5' and a
      // real run row in the campaign DB; its hold was released (lineage).
      const after = readState(h.campaignDir);
      const relaunchRec = campaignRunRec(after, "B5-relaunch");
      assert.ok(relaunchRec, "a B5-relaunch record must be registered");
      assert.equal(relaunchRec.relaunchOf, "B5", "the relaunch record must name B5 as relaunchOf");
      assert.match(relaunchRec.runId, /^run-[0-9a-f-]{36}$/, "the relaunch must carry a real run-<uuid>");
      const relaunchBare = relaunchRec.runId.slice(4);
      const relaunchRow = await waitFor("relaunch run row in campaign DB", () => {
        const row = readRunRow(h.execCtx.db_path, relaunchBare);
        return row ? row : null;
      }, { timeoutMs: 30_000 });
      assert.equal(relaunchRow.id, relaunchBare, "the relaunched run row must be the registered run id");
      // The lineage release: releaseHoldsForRoster releases both the original
      // B5 run and the record whose relaunchOf names B5.
      assert.equal(
        fs.existsSync(path.join(h.holdDir, `${relaunchRec.runId}.release`)),
        true,
        "the relaunch lineage run must be released with B5",
      );

      // ── observe the REAL product recovery (never a canned verdict) ───
      // The relaunch is a real do-now run under the real daemon. The scripted
      // runtime completes it; the release above is engine-owned. Wait a bounded
      // time for the run row to reach terminal.
      let recovered = false;
      try {
        const final = await waitFor("relaunched run terminal", () => {
          const row = readRunRow(h.execCtx.db_path, relaunchBare);
          return row && TERMINAL_STATUSES.has(row.status) ? row : null;
        }, { timeoutMs: 90_000 });
        recovered = final.status === "completed";
      } catch (err) {
        recovered = false;
      }
      if (!recovered) {
        // Honest NATIVE finding: the product did not complete the real
        // relaunch. Capture the campaign DB rows + events under the campaign
        // dir; never edit src/.
        const nativeDir = path.join(h.campaignDir, "native-findings");
        fs.mkdirSync(nativeDir, { recursive: true });
        const row = readRunRow(h.execCtx.db_path, relaunchBare);
        fs.writeFileSync(
          path.join(nativeDir, "stopdel-relaunch-did-not-complete.json"),
          `${JSON.stringify(
            {
              kind: "NATIVE-FINDING",
              story: "US-006",
              observed_at: new Date().toISOString(),
              b5_run: b5RunId,
              relaunch_run: relaunchRec.runId,
              relaunch_row: row,
              relaunch_record: relaunchRec,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      }
      // The test's acceptance criteria do not require the relaunched run to
      // complete; the lineage + release are the contract. Record the observed
      // product outcome in the output either way.
      process.stdout.write(
        `US-006 observed relaunch recovery: ${recovered ? "completed" : "not-completed"} (run ${relaunchRec.runId})\n`,
      );
    } catch (err) {
      bodyError = err;
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
  });
});

// The launch env for the real relaunch sub-op: the private control plane +
// the scripted harness pin. Protected keys (HOME/STATE/DB/TMPDIR/guard) come
// from the exec context and must NOT be restated here (makeRealProc refuses a
// per-call override of a protected key).
function launchEnvFor(ports: { dashboard: number; mcp: number; control: number }, piBinary: string): Record<string, string> {
  return {
    TAMANDUA_CONTROL_PORT: String(ports.control),
    TAMANDUA_DASHBOARD_PORT: String(ports.dashboard),
    TAMANDUA_MCP_PORT: String(ports.mcp),
    TAMANDUA_PI_BINARY: piBinary,
  };
}
