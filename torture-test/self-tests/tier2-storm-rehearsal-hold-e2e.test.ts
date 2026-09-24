// Tier-2 STORM-REHEARSAL-FIX5 US-005 — end-to-end: ONE real held run under a
// contained private daemon.
//
// This is the end-to-end half of requirement 1 (the in-process half is
// tier2-storm-rehearsal-hold-wiring). It proves the campaign-controlled
// mid-flight hold protocol against the REAL product pipeline, with ZERO model
// tokens:
//
//   * a private exec context (buildPrivateExecContext) under a fresh owned var
//     root inside torture-test/var gives the daemon and the launched product
//     client their own HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH roots (and
//     the client an owned TMPDIR);
//   * the campaign's scripted runtime is materialized (behaviors.json with the
//     hold-bearing do-now_doer behavior + a private scripted state dir);
//   * the per-campaign daemon env script (renderRehearsalDaemonEnvScript) pins
//     the private roots, three bind0-allocated listeners (NEVER production
//     3334/3338/3339) and the frozen scripted pi/Hermes identities;
//   * the REAL contained daemon is started through the sanctioned
//     bin/daemon-control wrapper (kind=scripted, TT_DC_ENV_SCRIPTED pointed at
//     the rendered script, forced plain-background launch);
//   * ONE workflow run (do-now) is launched through the real product CLI with
//     TAMANDUA_PI_BINARY = the materialized scripted pi runtime.
//
// The runtime claims the doer step and parks on the campaign hold; the test
// observes the REAL `<scriptedStateDir>/holds/run-<uuid>.confirmed` marker,
// writes `<...>.release`, and observes the run row reach a terminal completed
// state in the private product DB. The owned daemon is stopped and the owned
// temp root removed in finally blocks; no production port is ever bound by
// this test's daemon (the allocated ports are asserted non-production and the
// daemon-control provenance must name exactly them).
//
// This file spawns processes: run it ALONE (never concatenated with sibling
// tests in one `node --test` process), under
// `flock --exclusive /root/matchlock-work/vaivm-gate.lock`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const PRODUCTION_PORTS = [3334, 3338, 3339];
const WORKFLOW_ID = "do-now";
const AGENT_KEY = "do-now_doer";
const HOLD_TIMEOUT_MS = 60_000;
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

function isPortListening(port: number): boolean {
  const script = `const net=require('node:net');const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000);`;
  const res = spawnSync(process.execPath, ["-e", script], { timeout: 3000, encoding: "utf8" });
  return res.status === 0;
}

function readRunRow(dbPath: string, runId: string): { id: string; status: string } | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId) as
      | { id: string; status: string }
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

interface HeldRunHarness {
  ownedRoot: string;
  varRoot: string;
  campaignDir: string;
  execCtx: any;
  ports: { dashboard: number; mcp: number; control: number };
  scriptedStateDir: string;
  holdDir: string;
  behaviorsFile: string;
  daemonEnv: Record<string, string>;
}

async function buildHeldRunHarness(campaignId: string): Promise<HeldRunHarness> {
  const ownedRoot = fs.mkdtempSync(path.join(OWNED_VAR_ROOT, "rehearsal-hold-e2e-"));
  cleanupDirs.push(ownedRoot);
  const varRoot = path.join(ownedRoot, "exec");
  const campaignDir = path.join(ownedRoot, "campaign");
  fs.mkdirSync(campaignDir, { recursive: true });

  const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });

  // The product CLI resolves workflows from <TAMANDUA_STATE_DIR>/workflows;
  // seed the private installed catalog from the real bundled catalog.
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

  return {
    ownedRoot,
    varRoot,
    campaignDir,
    execCtx,
    ports,
    scriptedStateDir: scriptedRuntime.state_dir,
    holdDir: path.join(scriptedRuntime.state_dir, "holds"),
    behaviorsFile: scriptedRuntime.behaviors_file,
    daemonEnv: { TT_DC_ENV_SCRIPTED: envScript, TT_FORCE_NO_SYSTEMD: "1" },
  };
}

function runDaemonControl(h: HeldRunHarness, op: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(DAEMON_CONTROL, ["scripted", op], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...h.execCtx.child_env, ...h.daemonEnv, TT_DAEMON_PORT_WAIT_SECONDS: "10" },
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

describe("tier2-storm-rehearsal-hold-e2e (US-005)", () => {
  it("E0: the rendered private daemon env is contained and never production", async () => {
    const ownedRoot = fs.mkdtempSync(path.join(OWNED_VAR_ROOT, "rehearsal-hold-e2e-preflight-"));
    cleanupDirs.push(ownedRoot);
    const varRoot = path.join(ownedRoot, "exec");
    const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
    const ports = await allocRehearsalListenerPorts({});
    for (const port of [ports.dashboard, ports.mcp, ports.control]) {
      assert.ok(Number.isInteger(port) && port >= 1024, `allocated listener port must be a real port (got ${port})`);
      assert.equal(PRODUCTION_PORTS.includes(port), false, `allocated listener port ${port} must never be a production port`);
    }
    const text = renderRehearsalDaemonEnvScript({
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
      scriptedBehaviors: path.join(varRoot, "rehearsal", "scripted", "behaviors.json"),
      scriptedStateDir: path.join(execCtx.state_root, "scripted-state", "preflight"),
      maxActiveTimers: 8,
    });
    const vars: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) vars[m[1]] = m[2].replace(/^'|'$/g, "");
    }
    for (const key of ["HOME", "TAMANDUA_STATE_DIR", "TAMANDUA_DB_PATH", "TAMANDUA_SCRIPTED_STATE"]) {
      const value = vars[key];
      assert.ok(value, `${key} must be pinned by the rendered script`);
      assert.ok(
        value === ownedRoot || value.startsWith(ownedRoot + path.sep),
        `${key} ${value} must live under the owned root ${ownedRoot}`,
      );
    }
    assert.equal(vars.TAMANDUA_TEST_GUARD, "1");
    assert.equal(vars.TAMANDUA_PI_BINARY, SCRIPTED_PI);
    assert.equal(vars.TAMANDUA_HERMES_BINARY, SCRIPTED_HERMES);
    assert.equal(vars.TAMANDUA_MAX_ACTIVE_TIMERS, "8");
    assert.equal(vars.TAMANDUA_DASHBOARD_PORT, String(ports.dashboard));
    assert.equal(vars.TAMANDUA_MCP_PORT, String(ports.mcp));
    assert.equal(vars.TAMANDUA_CONTROL_PORT, String(ports.control));
  });

  it("E1: one real held run parks on a confirmed hold, releases, and completes under a contained private daemon", async () => {
    const campaignId = `hold-e2e-${process.pid}-${Date.now()}`;
    const h = await buildHeldRunHarness(campaignId);

    // The materialized behavior really carries the campaign-controlled hold on
    // the do-now doer (the hold-bearing behavior the daemon dispatches).
    const behaviors = JSON.parse(fs.readFileSync(h.behaviorsFile, "utf8"));
    assert.ok(behaviors.agents?.[AGENT_KEY], `behaviors must carry ${AGENT_KEY}`);
    assert.equal(behaviors.agents[AGENT_KEY].hold?.id, "storm-midflight");
    assert.equal(behaviors.agents[AGENT_KEY].hold?.timeoutMs, HOLD_TIMEOUT_MS);

    let daemonStarted = false;
    let runId: string | null = null;
    let bodyError: unknown = null;
    let stopResult: { status: number | null; stdout: string; stderr: string } | null = null;
    try {
      // ── start the REAL contained private daemon ─────────────────────
      const start = runDaemonControl(h, "start");
      assert.equal(
        start.status,
        0,
        `daemon-control scripted start must succeed:\n${start.stderr}\n${start.stdout}`,
      );
      daemonStarted = true;

      // The daemon CONTROL listener really is the private bind0 allocation.
      assert.ok(
        await waitFor("control port listening", () => (isPortListening(h.ports.control) ? true : null), {
          timeoutMs: 20_000,
        }),
        "the private control listener must accept connections",
      );

      // daemon-control's own provenance must name exactly the campaign ports
      // (never a production port).
      const provFile = path.join(OWNED_VAR_ROOT, "daemon-control", "scripted.json");
      const prov = JSON.parse(fs.readFileSync(provFile, "utf8"));
      assert.deepEqual(
        [...prov.ports].map(Number).sort((a: number, b: number) => a - b),
        [h.ports.dashboard, h.ports.mcp, h.ports.control].sort((a, b) => a - b),
        "the daemon-control provenance must name exactly the private allocated ports",
      );
      for (const port of prov.ports) {
        assert.equal(PRODUCTION_PORTS.includes(Number(port)), false, `daemon-control recorded a production port ${port}`);
      }
      assert.ok(
        String(prov.cwd).startsWith(h.execCtx.state_root) || String(prov.cwd).startsWith(h.execCtx.var_root),
        `the daemon cwd ${prov.cwd} must live under the private exec root`,
      );

      // ── launch ONE workflow run through the REAL product CLI ────────
      const launchEnv: NodeJS.ProcessEnv = {
        ...h.execCtx.child_env,
        TAMANDUA_CONTROL_PORT: String(h.ports.control),
        TAMANDUA_DASHBOARD_PORT: String(h.ports.dashboard),
        TAMANDUA_MCP_PORT: String(h.ports.mcp),
        TAMANDUA_PI_BINARY: SCRIPTED_PI,
      };
      const task = "STORM-REHEARSAL-FIX5 US-005 held-run E2E: hold, release, complete.";
      const launch = spawnSync(TAMANDUA_BIN, ["workflow", "run", WORKFLOW_ID, task], {
        cwd: h.execCtx.home_root,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        env: launchEnv,
      });
      assert.equal(
        launch.status,
        0,
        `product CLI workflow run must succeed:\n${launch.stderr}\n${launch.stdout}`,
      );

      // Resolve the real run id from the private product DB.
      runId = await waitFor("run row persisted", () => newestRunId(h.execCtx.db_path), { timeoutMs: 30_000 });
      assert.match(runId, /^[0-9a-f-]{36}$/, "the run row must carry a UUID id");

      // ── observe the REAL confirmed hold marker ──────────────────────
      const holdBase = path.join(h.holdDir, `run-${runId}`);
      const confirmedPath = `${holdBase}.confirmed`;
      await waitFor("run parked on confirmed hold", () => (fs.existsSync(confirmedPath) ? true : null), {
        timeoutMs: 60_000,
      });
      const confirmed = JSON.parse(fs.readFileSync(confirmedPath, "utf8"));
      assert.equal(confirmed.runId, `run-${runId}`, "the confirmed marker must name the real run id");
      assert.equal(confirmed.holdId, "storm-midflight");
      assert.equal(fs.existsSync(`${holdBase}.release`), false, "the release must not exist before the test writes it");
      // The parked run is genuinely mid-flight (non-terminal) when confirmed.
      assert.equal(readRunRow(h.execCtx.db_path, runId)?.status, "running", "the held run must be running while parked");

      // ── release the hold and observe completion ─────────────────────
      fs.writeFileSync(`${holdBase}.release`, "go\n", "utf8");
      const final = await waitFor(
        "run row terminal after release",
        () => {
          const row = readRunRow(h.execCtx.db_path, runId!);
          return row && TERMINAL_STATUSES.has(row.status) ? row : null;
        },
        { timeoutMs: 60_000 },
      );
      assert.equal(final.status, "completed", "the released run must reach the terminal completed state");
      // The one-shot release marker is retained (the engine owns it).
      assert.equal(fs.existsSync(`${holdBase}.release`), true, "the engine release marker must survive");
    } catch (err) {
      bodyError = err;
    } finally {
      // ── stop the owned daemon and remove the owned temp root ─────────
      if (daemonStarted) {
        stopResult = runDaemonControl(h, "stop");
      }
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
    // The owned daemon must have been stopped with positive evidence.
    assert.equal(
      stopResult?.status,
      0,
      `owned daemon stop must succeed:\n${stopResult?.stderr ?? ""}\n${stopResult?.stdout ?? ""}`,
    );

    // Every owned path remained under the private root and the allocated
    // ports were all non-production (also asserted above from provenance).
    for (const port of [h.ports.dashboard, h.ports.mcp, h.ports.control]) {
      assert.equal(PRODUCTION_PORTS.includes(port), false, `owned listener ${port} must never be a production port`);
    }
  });
});
