// Tier-2 NPF-2 US-003/US-004 — end-to-end: the scripted rehearsal's REAL
// suite-ledger evidence makes finalize_merge land on the FIRST attempt, and
// WITHOUT it the gate still refuses exactly as before.
//
// NPF-2 (STORM-REHEARSAL-FIX10) found that every scripted rehearsal merge run
// paid a spurious first-attempt refusal: the scripted tester only printed
// TESTED_TREE, so the product's finalize_merge ledger gate correctly refused
// the first landing ("no matching TSTX suite execution exists /
// LEDGER_EVIDENCE: missing") and rerouted the run to the tester. US-001 made
// the scripted test step execute the SAME shim-wrapped `{{input.TEST_CMD}}` the
// real tester runs (a real, shim-recorded green `suite_results` row for the
// exact tested tree); US-002 put `<repo>/bin` on the contained daemon PATH so
// the bare `tamandua-test` resolves. US-003 is the positive regression; US-004
// adds the negative half in the SAME file:
//
//   * P0 — positive preflight: the suiteEvidence runtime carries the merger
//     hold and the shim-backed tester evidence command.
//   * P1 — positive: one contained fdmw run lands finalize_merge on the FIRST
//     attempt with a real green ledger row keyed to the landed tree.
//   * P2a — negative preflight: the `suiteEvidence:false` runtime is the SAME
//     frozen behavior graph WITHOUT the evidence command.
//   * P2 — negative: one contained fdmw run is refused on the first
//     finalize_merge attempt (LEDGER_EVIDENCE: missing + a terminal
//     step.rerouted), records ZERO suite_results rows, and in the default gate
//     mode reaches completed only through the one-shot concession landing,
//     which annotates merge.landed_without_suite_evidence.
//
// The contained-daemon harness (buildSuiteLedgerHarness) is shared by both
// halves: a private exec context (buildPrivateExecContext) under a fresh owned
// var root inside torture-test/var gives the daemon and the launched product
// client their own HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH roots;
// provisionOwnedGitFixture builds the owned origin (non-bare, main checked
// out); seedCatalogFromBundled seeds the private catalog;
// materializeRehearsalScriptedRuntime materializes the frozen zero-token
// runtime for feature-dev-merge-worktree; the per-campaign daemon env script
// (renderRehearsalDaemonEnvScript) carries the US-002 pathExtra so the
// scripted tester's bash resolves the bare `tamandua-test` shim; the REAL
// contained daemon is started through bin/daemon-control (kind=scripted) and
// ONE feature-dev-merge-worktree run is launched through the real product CLI
// with TAMANDUA_PI_BINARY = the materialized scripted pi runtime.
//
// In P1 the standard merger hold's confirmed marker can ONLY appear if the
// ledger gate ACCEPTED the very first finalize_merge claim. In P2 the first
// claim is refused (a reroute event is recorded), the tester reruns with no
// evidence, and the confirmed marker then proves the CONCESSION attempt
// reached the merger. Diagnostics are retained under a unique owned directory
// under torture-test/var/results.
//
// This file spawns processes (git, a real contained daemon, the product CLI):
// run it ALONE (never concatenated with sibling tests in one `node --test`
// process), under `flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import { spawnCapture } from "../bin/tt-storm-shared.mjs";
import { buildPrivateExecContext } from "../bin/tt-storm-real.mjs";
import {
  allocRehearsalListenerPorts,
  materializeRehearsalScriptedRuntime,
  provisionOwnedGitFixture,
  readRehearsalWorkflowTexts,
  rehearsalDaemonPathExtra,
  renderRehearsalDaemonEnvScript,
  seedCatalogFromBundled,
} from "../bin/tt-storm-rehearsal.mjs";

// Derive the repo root from THIS module's location so the test is robust to
// the invoking cwd (TEST_CMD runs from the repo root; direct invocation from
// torture-test/ must still work).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ttRoot = path.join(repoRoot, "torture-test");
const workflowsRoot = path.join(repoRoot, "workflows");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const DAEMON_CONTROL = path.join(ttRoot, "bin", "daemon-control");
const SCRIPTED_PI = path.join(ttRoot, "scripted-runtimes", "bin", "scripted-pi");
const SCRIPTED_HERMES = path.join(ttRoot, "scripted-runtimes", "bin", "scripted-hermes");
// Every path the daemon-control containment guard admits must live under
// torture-test/var (the wrapper's fixed TT_ROOT), so the owned root lives there.
const OWNED_VAR_ROOT = path.join(ttRoot, "var");
// Diagnostics are RETAINED (never inside the removed owned root) so a
// discovery failure stays diagnosable.
const RESULTS_ROOT = path.join(OWNED_VAR_ROOT, "results");

const PRODUCTION_PORTS = [3334, 3338, 3339];
const WORKFLOW_ID = "feature-dev-merge-worktree";
const MERGER_AGENT_KEY = `${WORKFLOW_ID}_merger`;
const TESTER_AGENT_KEY = `${WORKFLOW_ID}_tester`;
const HOLD_ID = "storm-midflight";
const HOLD_TIMEOUT_MS = 120_000;
const MERGE_TARGET_REF = "main";
// The product dispatches on a 15s fallback tick; the full merge-worktree
// pipeline (plan/setup/2x implement+verify/test/finalize) takes minutes.
const CHECKPOINT_TIMEOUT_MS = 600_000;
const TERMINAL_TIMEOUT_MS = 300_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

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
  { timeoutMs = 60_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
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

function isPortListening(port: number): boolean {
  const script = `const net=require('node:net');const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000);`;
  const res = spawnSync(process.execPath, ["-e", script], { timeout: 3000, encoding: "utf8" });
  return res.status === 0;
}

// ── Product DB readers (private, read-only) ──────────────────────────────

interface RunRow {
  id: string;
  status: string;
  workflow_id: string;
  parent_run_id: string | null;
  context: string;
}

function openDb(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

function readRunRow(dbPath: string, bare: string): RunRow | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath);
    const row = db
      .prepare("SELECT id, status, workflow_id, parent_run_id, context FROM runs WHERE id = ?")
      .get(bare) as RunRow | undefined;
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
    db = openDb(dbPath);
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

interface StepRow {
  id: string;
  step_id: string;
  status: string;
  reroute_count: number;
  terminal_reroute_count: number;
  ledger_concession_count: number | null;
  output: string | null;
}

function readStep(dbPath: string, bare: string, stepId: string): StepRow | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath);
    const row = db
      .prepare(
        "SELECT id, step_id, status, reroute_count, terminal_reroute_count, ledger_concession_count, output FROM steps WHERE run_id = ? AND step_id = ? ORDER BY rowid LIMIT 1",
      )
      .get(bare, stepId) as StepRow | undefined;
    return row ?? null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

interface SuiteRow {
  id: number;
  exit_code: number;
  tree_hash: string;
  run_id: string | null;
  step_id: string | null;
  cmd_display: string;
  created_at: string;
}

function readSuiteRows(dbPath: string): SuiteRow[] {
  if (!fs.existsSync(dbPath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath);
    return db
      .prepare(
        "SELECT id, exit_code, tree_hash, run_id, step_id, cmd_display, created_at FROM suite_results ORDER BY id",
      )
      .all() as SuiteRow[];
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function countRuns(dbPath: string): number {
  if (!fs.existsSync(dbPath)) return 0;
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath);
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM runs WHERE workflow_id = ?")
      .get(WORKFLOW_ID) as { c: number };
    return Number(row.c);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function childRunIds(dbPath: string, parentBare: string): string[] {
  if (!fs.existsSync(dbPath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath);
    return (
      db.prepare("SELECT id FROM runs WHERE parent_run_id = ?").all(parentBare) as Array<{ id: string }>
    ).map((r) => r.id);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

// ── Product event reader ────────────────────────────────────────────────

function readRunEvents(stateRoot: string, bare: string): any[] {
  const file = path.join(stateRoot, "events", `${bare}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const events: any[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // a malformed line must not hide the events around it
    }
  }
  return events;
}

// ── Diagnostics retention ───────────────────────────────────────────────
// Copy the failing run's DB rows + event stream + scripted invocations OUTSIDE
// the owned temp root (which the finally removes) so any discovery failure is
// diagnosable after the fact. Never inside the repo's committed tree (var/ is
// gitignored) and never deleted by this test.
function retainDiagnostics(h: SuiteLedgerHarness, label: string, bare: string | null): string {
  fs.mkdirSync(RESULTS_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = fs.mkdtempSync(path.join(RESULTS_ROOT, `suite-ledger-e2e-${stamp}-`));
  const snapshot: Record<string, unknown> = {
    label,
    observedAt: new Date().toISOString(),
    run: bare,
    workflowId: WORKFLOW_ID,
    dbPath: h.execCtx.db_path,
    stateRoot: h.execCtx.state_root,
    originRepo: h.originRepo,
    holdDir: h.holdDir,
  };
  try {
    snapshot.holdMarkers = fs.existsSync(h.holdDir) ? fs.readdirSync(h.holdDir) : [];
  } catch (err) {
    snapshot.holdError = (err as Error).message;
  }
  try {
    if (bare) {
      snapshot.runRow = readRunRow(h.execCtx.db_path, bare);
      snapshot.finalizeMergeStep = readStep(h.execCtx.db_path, bare, "finalize_merge");
      snapshot.testStep = readStep(h.execCtx.db_path, bare, "test");
      snapshot.runsCount = countRuns(h.execCtx.db_path);
    }
    snapshot.suiteResults = readSuiteRows(h.execCtx.db_path);
  } catch (err) {
    snapshot.dbError = (err as Error).message;
  }
  try {
    if (bare) {
      const events = readRunEvents(h.execCtx.state_root, bare);
      snapshot.eventCount = events.length;
      snapshot.lastEvents = events.slice(-40);
      const evFile = path.join(h.execCtx.state_root, "events", `${bare}.jsonl`);
      if (fs.existsSync(evFile)) fs.copyFileSync(evFile, path.join(dir, `${bare}.events.jsonl`));
    }
  } catch (err) {
    snapshot.eventError = (err as Error).message;
  }
  try {
    const invocations = path.join(h.scriptedStateDir, "invocations.jsonl");
    if (fs.existsSync(invocations)) fs.copyFileSync(invocations, path.join(dir, "invocations.jsonl"));
  } catch (err) {
    snapshot.invocationError = (err as Error).message;
  }
  try {
    if (fs.existsSync(h.execCtx.db_path)) fs.copyFileSync(h.execCtx.db_path, path.join(dir, "tamandua.db"));
  } catch (err) {
    snapshot.dbCopyError = (err as Error).message;
  }
  fs.writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return dir;
}

// ── Harness ─────────────────────────────────────────────────────────────

interface SuiteLedgerHarness {
  ownedRoot: string;
  varRoot: string;
  campaignDir: string;
  campaignId: string;
  execCtx: any;
  ports: { dashboard: number; mcp: number; control: number };
  scriptedStateDir: string;
  holdDir: string;
  behaviorsFile: string;
  daemonEnv: Record<string, string>;
  originRepo: string;
  mainHead: string;
  taskFile: string;
  suiteEvidence: boolean;
}

interface SuiteLedgerHarnessOptions {
  // US-004 (NPF-2 negative): false materializes the SAME frozen runtime
  // WITHOUT the shim-backed evidence command, so the scripted tester prints
  // TESTED_TREE only and the ledger gate is right to refuse the first
  // finalize_merge attempt.
  suiteEvidence?: boolean;
  label?: string;
}

async function buildSuiteLedgerHarness(
  campaignId: string,
  { suiteEvidence = true, label = "positive" }: SuiteLedgerHarnessOptions = {},
): Promise<SuiteLedgerHarness> {
  const ownedRoot = fs.mkdtempSync(path.join(OWNED_VAR_ROOT, "rehearsal-suite-ledger-e2e-"));
  cleanupDirs.push(ownedRoot);
  const varRoot = path.join(ownedRoot, "exec");
  const campaignDir = path.join(ownedRoot, "campaign");
  fs.mkdirSync(campaignDir, { recursive: true });

  const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });

  // The product CLI resolves workflows from <TAMANDUA_STATE_DIR>/workflows;
  // seed the private installed catalog from the real bundled catalog.
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
  // suiteEvidence defaults to true: the scripted tester runs the shim-wrapped
  // `{{input.TEST_CMD}}` and records a REAL green suite_results row.
  // suiteEvidence:false is the US-004 negative configuration: the tester
  // records no evidence and the gate must refuse the first attempt.
  const scriptedRuntime = materializeRehearsalScriptedRuntime({
    inputRoot: path.join(varRoot, "rehearsal"),
    stateRoot: execCtx.state_root,
    campaignId,
    workflowTexts,
    workflowIds: [WORKFLOW_ID],
    holdTimeoutMs: HOLD_TIMEOUT_MS,
    suiteEvidence,
  });

  const holdDir = path.join(scriptedRuntime.state_dir, "holds");
  fs.mkdirSync(holdDir, { recursive: true });

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

  const taskFile = path.join(ownedRoot, "suite-ledger.task.md");
  fs.writeFileSync(
    taskFile,
    `NPF-2 US-004 E2E (${label}): one feature-dev-merge-worktree run; suiteEvidence=${suiteEvidence}.\n`,
    "utf8",
  );

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
    mainHead: fixture.mainHead,
    taskFile,
    suiteEvidence,
  };
}

function runDaemonControl(h: SuiteLedgerHarness, op: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(DAEMON_CONTROL, ["scripted", op], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...h.execCtx.child_env, ...h.daemonEnv, TT_DAEMON_PORT_WAIT_SECONDS: "10" },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

describe("tier2-storm-rehearsal-suite-ledger-e2e (US-003/US-004 NPF-2)", () => {
  it("P0: the materialized fdmw runtime carries the merger hold and the shim-backed tester evidence command", async () => {
    const h = await buildSuiteLedgerHarness(`suite-ledger-preflight-${process.pid}-${Date.now()}`, {
      suiteEvidence: true,
      label: "positive-preflight",
    });
    try {
      const bytes = fs.readFileSync(h.behaviorsFile, "utf8");
      const doc = JSON.parse(bytes);

      const merger = doc.agents?.[MERGER_AGENT_KEY];
      assert.ok(merger, `behaviors must carry ${MERGER_AGENT_KEY}`);
      assert.equal(merger.hold?.id, HOLD_ID, "the first-attempt landing hold must be armed on the merger");
      assert.ok(Array.isArray(merger.commands) && merger.commands.length >= 1, "the merger must run the real merge command");
      assert.ok(
        merger.commands.some((c: string) => String(c).includes("tamandua merge-branch")),
        "the merger behavior must invoke the real product merge-branch",
      );

      const tester = doc.agents?.[TESTER_AGENT_KEY];
      assert.ok(tester, `behaviors must carry ${TESTER_AGENT_KEY}`);
      assert.ok(
        Array.isArray(tester.commands) && tester.commands.includes("{{input.TEST_CMD}}"),
        "the TESTED_TREE-producing agent must execute the shim-wrapped {{input.TEST_CMD}} (the only ledger writer)",
      );
      assert.equal(
        /suite_results/.test(bytes),
        false,
        "the behaviors file must never contain a direct ledger write — evidence can only come from the shim",
      );
      assert.equal(h.suiteEvidence, true, "the positive preflight must materialize the evidence-enabled runtime");
    } finally {
      fs.rmSync(h.ownedRoot, { recursive: true, force: true });
      const idx = cleanupDirs.indexOf(h.ownedRoot);
      if (idx >= 0) cleanupDirs.splice(idx, 1);
    }
  });

  it("P2a: the suiteEvidence:false runtime is the SAME behavior graph WITHOUT the evidence command", async () => {
    const h = await buildSuiteLedgerHarness(`suite-ledger-negative-preflight-${process.pid}-${Date.now()}`, {
      suiteEvidence: false,
      label: "negative-preflight",
    });
    try {
      assert.equal(h.suiteEvidence, false);
      const bytes = fs.readFileSync(h.behaviorsFile, "utf8");
      const doc = JSON.parse(bytes);

      // The negative configuration is the SAME contained fdmw behavior graph:
      // the merger still holds (so the concession attempt is observable) and
      // still runs the real product merge-branch.
      const merger = doc.agents?.[MERGER_AGENT_KEY];
      assert.ok(merger, `behaviors must carry ${MERGER_AGENT_KEY}`);
      assert.equal(merger.hold?.id, HOLD_ID, "the negative runtime must keep the campaign hold on the merger");
      assert.ok(
        Array.isArray(merger.commands) && merger.commands.some((c: string) => String(c).includes("tamandua merge-branch")),
        "the negative merger must still run the real product merge-branch",
      );

      // The tested-tree agent must NOT carry the evidence command, so no real
      // suite execution is recorded and no ledger row can exist.
      const tester = doc.agents?.[TESTER_AGENT_KEY];
      assert.ok(tester, `behaviors must carry ${TESTER_AGENT_KEY}`);
      assert.equal(
        Array.isArray(tester.commands) && tester.commands.includes("{{input.TEST_CMD}}"),
        false,
        "suiteEvidence:false must omit the shim-backed evidence command from the tested-tree agent",
      );
      assert.equal(
        /suite_results/.test(bytes),
        false,
        "the negative behaviors file must never contain a direct ledger write — no fabricated row is possible",
      );
      // No behavior anywhere may execute the shim-wrapped TEST_CMD.
      const allCommands = Object.values(doc.agents ?? {}).flatMap((behavior: any) =>
        (Array.isArray(behavior) ? behavior : [behavior]).flatMap((entry: any) => (Array.isArray(entry?.commands) ? entry.commands : [])),
      );
      assert.equal(
        allCommands.some((c: string) => String(c).includes("{{input.TEST_CMD}}")),
        false,
        "the negative runtime must omit the evidence command from every behavior entry",
      );
    } finally {
      fs.rmSync(h.ownedRoot, { recursive: true, force: true });
      const idx = cleanupDirs.indexOf(h.ownedRoot);
      if (idx >= 0) cleanupDirs.splice(idx, 1);
    }
  });

  it("P1: one contained fdmw run lands finalize_merge on the FIRST attempt with real LEDGER_EVIDENCE", async () => {
    const campaignId = `suite-ledger-e2e-${process.pid}-${Date.now()}`;
    const h = await buildSuiteLedgerHarness(campaignId, { suiteEvidence: true, label: "positive" });
    const sinceUtc = new Date().toISOString();

    let daemonStarted = false;
    let bare: string | null = null;
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

      // daemon-control's provenance must name exactly the campaign ports.
      const provFile = path.join(OWNED_VAR_ROOT, "daemon-control", "scripted.json");
      const prov = JSON.parse(fs.readFileSync(provFile, "utf8"));
      for (const port of prov.ports) {
        assert.equal(PRODUCTION_PORTS.includes(Number(port)), false, `daemon-control recorded a production port ${port}`);
      }

      // ── launch ONE real fdmw run through the REAL product CLI ───────
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

      bare = await waitFor("run row persisted", () => newestRunId(h.execCtx.db_path), { timeoutMs: 30_000 });
      assert.match(bare, /^[0-9a-f-]{36}$/, "the run row must carry a UUID id");
      const runId = `run-${bare}`;

      // ── the first-attempt landing proof ─────────────────────────────
      // The standard merger behavior parks on a campaign hold. A confirmed
      // marker can ONLY appear if the ledger gate accepted the FIRST
      // finalize_merge claim; a missing-evidence refusal reroutes to the
      // tester and the merger round never runs.
      const confirmedPath = path.join(h.holdDir, `${runId}.confirmed`);
      await waitFor("first-attempt finalize_merge merger hold confirmed", () => (fs.existsSync(confirmedPath) ? true : null), {
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      });
      const confirmed = JSON.parse(fs.readFileSync(confirmedPath, "utf8"));
      assert.equal(confirmed.runId, runId, "the hold marker must name the real run id");
      assert.equal(confirmed.holdId, HOLD_ID);
      const releasePath = path.join(h.holdDir, `${runId}.release`);
      assert.equal(fs.existsSync(releasePath), false, "the release must not exist before the test writes it");

      // While the FIRST finalize_merge attempt is held: it is running and has
      // never been rerouted.
      const heldFinalize = readStep(h.execCtx.db_path, bare, "finalize_merge");
      assert.ok(heldFinalize, "the finalize_merge step row must exist");
      assert.equal(heldFinalize.status, "running", "the first finalize_merge attempt must be running while held");
      assert.equal(heldFinalize.reroute_count, 0, "the first finalize_merge attempt must never have been rerouted");
      assert.equal(heldFinalize.terminal_reroute_count, 0);
      assert.equal(readRunRow(h.execCtx.db_path, bare)?.status, "running", "the held run must be running");

      // The tester already recorded REAL green evidence for the tested tree
      // BEFORE the merger claimed finalize_merge.
      const heldSuiteRows = readSuiteRows(h.execCtx.db_path);
      assert.ok(
        heldSuiteRows.some((row) => row.exit_code === 0),
        `the scripted tester must record real green suite evidence before finalize_merge claims (rows: ${JSON.stringify(heldSuiteRows)})`,
      );

      // ── release the FIRST attempt and observe completion ────────────
      fs.writeFileSync(releasePath, "go\n", "utf8");
      const final = await waitFor(
        "run row terminal after release",
        () => {
          const row = readRunRow(h.execCtx.db_path, bare!);
          return row && TERMINAL_STATUSES.has(row.status) ? row : null;
        },
        { timeoutMs: TERMINAL_TIMEOUT_MS },
      );
      assert.equal(final.status, "completed", "the first-attempt run must reach terminal completed");

      // ── exactly one contained fdmw run, no replacement/child ────────
      assert.equal(countRuns(h.execCtx.db_path), 1, "the self-test must launch exactly one fdmw run");
      assert.deepEqual(childRunIds(h.execCtx.db_path, bare), [], "a clean first-attempt landing must not spawn a child run");

      // ── finalize_merge done with reroute_count 0 (first attempt) ────
      const finalizeStep = readStep(h.execCtx.db_path, bare, "finalize_merge");
      assert.ok(finalizeStep, "the finalize_merge step row must exist");
      assert.equal(finalizeStep.status, "done", "finalize_merge must be done");
      assert.equal(finalizeStep.reroute_count, 0, "finalize_merge must land on the FIRST attempt (reroute_count 0)");
      assert.equal(finalizeStep.terminal_reroute_count, 0);

      // ── the landed tree and the matching green suite row ────────────
      const events = readRunEvents(h.execCtx.state_root, bare);
      const landed = events.filter((evt) => evt.event === "merge.landed" && String(evt.runId) === bare);
      assert.ok(landed.length >= 1, `the run stream must carry at least one merge.landed (events: ${events.length})`);
      const landedTree = String(landed[landed.length - 1].mergedTree ?? "");
      assert.match(landedTree, /^[0-9a-f]{40}$/, `the landing must attest a real merged tree (got ${JSON.stringify(landedTree)})`);

      const testStep = readStep(h.execCtx.db_path, bare, "test");
      const greenRows = readSuiteRows(h.execCtx.db_path).filter(
        (row) => row.exit_code === 0 && row.tree_hash === landedTree,
      );
      assert.ok(
        greenRows.length >= 1,
        `suite_results must hold a green row keyed to the landed tree ${landedTree} (rows: ${JSON.stringify(readSuiteRows(h.execCtx.db_path))})`,
      );
      assert.ok(
        greenRows.some(
          (row) =>
            row.run_id === bare &&
            // The product renders the shim wrapper's --step from either the
            // step's DB uuid or its step_id slug depending on the render path;
            // either attribution is this run's test step.
            (row.step_id === testStep?.id || row.step_id === testStep?.step_id),
        ),
        "the green evidence must be attributed to THIS run's test step (real shim execution, not a fabricated row)",
      );

      // ── no refusal/reroute, no concession landing ───────────────────
      assert.equal(
        events.filter((evt) => evt.event === "step.rerouted" && evt.stepId === "finalize_merge").length,
        0,
        "no finalize_merge step.rerouted event may be recorded",
      );
      assert.equal(
        events.filter((evt) => evt.event === "merge.landed_without_suite_evidence").length,
        0,
        "no merge.landed_without_suite_evidence event may be recorded when evidence is present",
      );

      process.stdout.write(
        `US-003 observed: run=${runId} finalize=done reroute=0 landedTree=${landedTree} greenRows=${greenRows.length} terminal=${final.status} since=${sinceUtc}\n`,
      );

      // Retain a success diagnostic snapshot (the run's DB rows + events)
      // BEFORE the finally removes the owned temp root.
      try {
        const dir = retainDiagnostics(h, "P1-success", bare);
        process.stdout.write(`US-003 diagnostics retained at ${dir}\n`);
      } catch {
        // success retention is best-effort and must not fail the test
      }
    } catch (err) {
      bodyError = err;
      try {
        const dir = retainDiagnostics(h, "P1-failure", bare);
        process.stdout.write(`US-003 diagnostics retained at ${dir}\n`);
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
  });

  it("P2: without the evidence step the first finalize_merge is refused and the concession landing is annotated", async () => {
    const campaignId = `suite-ledger-negative-e2e-${process.pid}-${Date.now()}`;
    const h = await buildSuiteLedgerHarness(campaignId, { suiteEvidence: false, label: "negative" });
    const sinceUtc = new Date().toISOString();

    let daemonStarted = false;
    let bare: string | null = null;
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

      // ── launch ONE real fdmw run through the REAL product CLI ───────
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

      bare = await waitFor("run row persisted", () => newestRunId(h.execCtx.db_path), { timeoutMs: 30_000 });
      assert.match(bare, /^[0-9a-f-]{36}$/, "the run row must carry a UUID id");
      const runId = `run-${bare}`;

      // ── the FIRST finalize_merge attempt is refused ─────────────────
      // Without the evidence step the gate must find no matching TSTX
      // execution and reroute the run back to the tester.
      const rerouteEvent = await waitFor(
        "first finalize_merge refusal (step.rerouted)",
        () => {
          const events = readRunEvents(h.execCtx.state_root, bare!);
          return events.find((evt) => evt.event === "step.rerouted" && evt.stepId === "finalize_merge") ?? null;
        },
        { timeoutMs: CHECKPOINT_TIMEOUT_MS },
      );
      const refusalDetail = String(rerouteEvent.detail ?? "");
      assert.match(
        refusalDetail,
        /Ledger gate refused finalize_merge: no matching TSTX suite execution exists/,
        "the refusal must name the missing matching TSTX execution",
      );
      assert.match(refusalDetail, /LEDGER_EVIDENCE: missing/, "the refusal must carry the LEDGER_EVIDENCE: missing marker");
      assert.equal(rerouteEvent.terminal, true, "the missing-evidence refusal must be a terminal-class reroute");
      assert.equal(rerouteEvent.rerouteMode, "terminal");

      assert.deepEqual(
        readSuiteRows(h.execCtx.db_path),
        [],
        "the suiteEvidence:false run must record ZERO suite_results rows (no fabricated evidence)",
      );

      const afterRefusal = readStep(h.execCtx.db_path, bare, "finalize_merge");
      assert.ok(afterRefusal, "the finalize_merge step row must exist");
      assert.equal(afterRefusal.status, "waiting", "the refused finalize_merge must be re-waiting for the tester rerun");
      assert.equal(afterRefusal.reroute_count, 1, "exactly one reroute must be recorded on the first refusal");
      assert.equal(afterRefusal.terminal_reroute_count, 1, "the missing-evidence refusal is a terminal-class reroute");
      assert.equal(
        afterRefusal.ledger_concession_count,
        1,
        "the one-shot default-gate concession must be consumed by the first refusal",
      );
      assert.equal(readRunRow(h.execCtx.db_path, bare)?.status, "running", "the refused run must keep running");
      assert.equal(countRuns(h.execCtx.db_path), 1, "the negative self-test must launch exactly one fdmw run");

      // ── the CONCESSION attempt reaches the merger and holds ─────────
      // The hold marker can only be written by a real merger round, which
      // the gate admits only after the one-shot concession is consumed.
      const confirmedPath = path.join(h.holdDir, `${runId}.confirmed`);
      await waitFor("concession finalize_merge merger hold confirmed", () => (fs.existsSync(confirmedPath) ? true : null), {
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      });
      const confirmed = JSON.parse(fs.readFileSync(confirmedPath, "utf8"));
      assert.equal(confirmed.runId, runId, "the hold marker must name the real run id");
      assert.equal(confirmed.holdId, HOLD_ID);

      const heldFinalize = readStep(h.execCtx.db_path, bare, "finalize_merge");
      assert.ok(heldFinalize, "the finalize_merge step row must exist while held");
      assert.equal(heldFinalize.status, "running", "the concession finalize_merge attempt must be running while held");
      assert.equal(heldFinalize.reroute_count, 1, "the concession attempt must not add a second reroute");
      assert.equal(heldFinalize.terminal_reroute_count, 1);
      assert.deepEqual(
        readSuiteRows(h.execCtx.db_path),
        [],
        "the tester rerun must not fabricate ledger evidence",
      );

      // ── release the CONCESSION attempt and observe completion ───────
      const releasePath = path.join(h.holdDir, `${runId}.release`);
      fs.writeFileSync(releasePath, "go\n", "utf8");
      const final = await waitFor(
        "run row terminal after concession release",
        () => {
          const row = readRunRow(h.execCtx.db_path, bare!);
          return row && TERMINAL_STATUSES.has(row.status) ? row : null;
        },
        { timeoutMs: TERMINAL_TIMEOUT_MS },
      );
      assert.equal(final.status, "completed", "the default gate must concede so the run still reaches completed");

      // ── exactly one refusal, one concession annotation ──────────────
      const events = readRunEvents(h.execCtx.state_root, bare);
      const finalizeReroutes = events.filter(
        (evt) => evt.event === "step.rerouted" && evt.stepId === "finalize_merge",
      );
      assert.equal(finalizeReroutes.length, 1, "exactly one finalize_merge refusal must be recorded");
      assert.match(String(finalizeReroutes[0].detail ?? ""), /LEDGER_EVIDENCE: missing/);

      const conceded = events.filter((evt) => evt.event === "merge.landed_without_suite_evidence");
      assert.equal(
        conceded.length,
        1,
        "the concession landing must emit exactly one merge.landed_without_suite_evidence",
      );
      assert.equal(conceded[0].runId, bare);
      assert.equal(conceded[0].stepId, "finalize_merge");
      assert.equal(conceded[0].gateMode, "default", "the contained rehearsal run must use the default gate mode");
      assert.equal(
        events.filter((evt) => evt.event === "merge.landed_over_red_suite").length,
        0,
        "a missing ledger row is not red evidence; no red annotation may be recorded",
      );

      const finalizeStep = readStep(h.execCtx.db_path, bare, "finalize_merge");
      assert.ok(finalizeStep, "the finalize_merge step row must exist");
      assert.equal(finalizeStep.status, "done", "finalize_merge must be done after the concession landing");
      assert.equal(finalizeStep.reroute_count, 1, "the concession landing is the SECOND attempt (reroute_count 1)");
      assert.equal(finalizeStep.terminal_reroute_count, 1);

      assert.deepEqual(
        readSuiteRows(h.execCtx.db_path),
        [],
        "the negative run must record ZERO suite_results rows end to end (no fabricated evidence)",
      );
      assert.equal(countRuns(h.execCtx.db_path), 1, "the self-test must launch exactly one fdmw run");
      assert.deepEqual(childRunIds(h.execCtx.db_path, bare), [], "the negative run must not spawn a child run");

      process.stdout.write(
        `US-004 observed: run=${runId} finalize=done reroute=1 concession=${finalizeStep.ledger_concession_count} suiteRows=0 gateMode=default terminal=${final.status} since=${sinceUtc}\n`,
      );

      try {
        const dir = retainDiagnostics(h, "P2-success", bare);
        process.stdout.write(`US-004 diagnostics retained at ${dir}\n`);
      } catch {
        // success retention is best-effort and must not fail the test
      }
    } catch (err) {
      bodyError = err;
      try {
        const dir = retainDiagnostics(h, "P2-failure", bare);
        process.stdout.write(`US-004 diagnostics retained at ${dir}\n`);
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
  });
});
