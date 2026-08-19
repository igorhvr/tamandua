// US-004 (T2.1) — controller-side scripted-behaviors materialization wiring.
//
// The tier2-traceability contract (W4.40 row) promises the campaign materializes
// each arm's behaviors (TAMANDUA_SCRIPTED_BEHAVIORS, keyed <workflowId>_<agent>)
// from the scenario cell before the controller launch; merged main had NO such
// wiring — tt-controller only forwarded TAMANDUA_SCRIPTED_BEHAVIORS from its own
// process env (E3.C US-011) and never derived it from the case's scenario cell,
// so a clean-tree campaign's scripted agents had no canned behaviors to follow.
//
// This gate is the ZERO-TOKEN end-to-end proof that the controller-side
// materialization works on the REAL scripted daemon with the REAL scripted
// runtimes (TAMANDUA_PI_BINARY / TAMANDUA_HERMES_BINARY pinned via
// tt-env-scripted.sh):
//   1. Build a scripted WORKFLOW case manifest whose case carries
//      context.scenario_path pointing at a real tracked cell (w4.38 do-now:
//      single agent "doer", single step — fast) plus a CONTROL case WITHOUT a
//      scenario cell (AC4: unaffected, env var absent).
//   2. Start the 53xx scripted daemon WITHOUT any behaviors env — the ONLY
//      behaviors source must be the controller's materialization + daemon
//      restart (the daemon env is fixed at daemon start; daemon-control's
//      env_for_kind forwards TAMANDUA_SCRIPTED_BEHAVIORS/STATE from the CALLER
//      env into the daemon env at start/restart).
//   3. Run the controller on the manifest. It must:
//        - materialize the cell's behaviors.json rekeyed to <workflowId>_<agent>
//          (w4.38 -> "do-now_doer") under var/behaviors/<campaignId>/<caseId>.json,
//        - set TAMANDUA_SCRIPTED_BEHAVIORS (+ per-case work-index state dir) in
//          the launch childEnv and record attempt.scripted_behaviors evidence
//          (path + sha256, so the content is verifiable after the file is
//          removed with the campaign),
//        - restart the scripted daemon with the materialized env (so the daemon's
//          spawned workers actually read the materialized behaviors),
//        - launch the workflow; the scripted runtime follows the canned behavior,
//          so the run completes and the doer step's output matches the cell's
//          canned output (read from the contained DB steps table).
//   4. Assert: run completed, step output == cell's canned output, the materialized
//      file content (via recorded sha256) == the cell behaviors rekeyed to
//      <workflowId>_<agent>, the daemon restart evidence is recorded, the CONTROL
//      case has NO scripted_behaviors record (AC4), and
//      var/behaviors/<campaignId> is removed with the campaign (AC2).
//
// Confined to torture-test/ (state under gitignored var/). Zero tokens.
// HEAVY CAMPAIGN TEST — registered in the run.sh HEAVY_CAMPAIGN_TESTS /
// verify-heavy-campaign-tests.test.sh / e2e-golden-integrity lock-step lists.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { provisionWorkClone } from "../bin/tt-fixture-provision.mjs";

// Derive the repo root from THIS module's location (self-tests/ -> repo root),
// so the test is robust to the invoking cwd (run.sh cd's to the repo root, but
// a direct `node --test self-tests/<file>.ts` from torture-test/ must still
// work).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const controller = path.join(binDir, "tt-controller");
const daemonControl = path.join(binDir, "daemon-control");
const scriptedHome = path.join(varRoot, "home-scripted");
const scriptedStateDir = path.join(scriptedHome, ".tamandua");
const workRoot = path.join(varRoot, "us004-scripted-behaviors");

const SCRIPTED_PORTS = [5334, 5338, 5339];
const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;

// The w4.38 do-now cell: single agent "doer", single step. Its canned output
// is what the scripted runtime must emit — the AC3 "step output matches the
// cell's canned output" contract.
const CELL_DIR = "scenarios/w4.38";
const CELL_SCENARIO_ID = "w4.38-hostile-task-scripted";
const CELL_WORKFLOW = "do-now";
const CELL_CANNED_MARKER = "hostile task text treated as inert data";

type CommandResult = { status: number | null; stdout: string; stderr: string };

function run(file: string, args: string[], env = process.env, timeout = 600_000): CommandResult {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { status: null, stdout: String(result.stdout ?? ""), stderr: `${result.stderr ?? ""}\n[timed out after ${timeout}ms]` };
  }
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function runStreaming(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function gitSnapshot(): string {
  const result = run("git", ["status", "--porcelain", "--untracked-files=all"]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function assertPortsFree(): Promise<void> {
  for (const port of SCRIPTED_PORTS) {
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error) => reject(new Error(`scripted port ${port} is not free: ${error.message}`)));
      server.listen(port, "127.0.0.1", () => server.close((error) => (error ? reject(error) : resolve())));
    });
  }
}

// The controller is driven against the scripted daemon (zero tokens — the
// scripted runtimes are the harness binaries, pinned by tt-env-scripted.sh).
// The controller's own env deliberately carries NO TAMANDUA_SCRIPTED_BEHAVIORS:
// the ONLY behaviors source is the controller's cell materialization.
function batteryEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    TAMANDUA_TEST_GUARD: "0",
    PATH: `${path.join(repoRoot, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
}

// Two-case manifest: the cell case (scenario_path -> materialization) and a
// control case WITHOUT a scenario cell (AC4: unaffected).
function buildManifest(): string {
  const cellCase = {
    id: "US004-BEHAVIORS-CELL",
    wave: 4,
    workflow: CELL_WORKFLOW,
    fixture: "tt-ts",
    harness: "scripted-pi",
    task: "cases/tasks/tier2/W4.38-hostile-task-scripted.md",
    context: {
      execution_mode: "scripted",
      test_cmd: "npm test",
      scenario_id: CELL_SCENARIO_ID,
      scenario_path: CELL_DIR,
    },
    caps: { tokens: 0, wall_min: 10 },
    requires: {},
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: ["TIER2", "W4"],
    chaos: null,
    shed_ok: false,
    mandatory: true,
    class: "verification",
  };
  const controlCase = {
    id: "US004-BEHAVIORS-NOCELL",
    wave: 4,
    workflow: CELL_WORKFLOW,
    fixture: "tt-ts",
    harness: "scripted-pi",
    task: "cases/tasks/tier2/W4.38-hostile-task-scripted.md",
    context: { execution_mode: "scripted", test_cmd: "npm test" },
    caps: { tokens: 0, wall_min: 10 },
    requires: {},
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: ["TIER2", "W4"],
    chaos: null,
    shed_ok: false,
    mandatory: true,
    class: "verification",
  };
  fs.mkdirSync(workRoot, { recursive: true });
  const outPath = path.join(workRoot, "manifest.jsonl");
  fs.writeFileSync(outPath, `${JSON.stringify(cellCase)}\n${JSON.stringify(controlCase)}\n`, "utf8");
  return outPath;
}

function installWorkflowIntoScriptedCatalog(): void {
  const result = run("bash", ["-c", "source torture-test/env/tt-env-scripted.sh && exec bin/tamandua workflow install do-now"], batteryEnv(), 300_000);
  assert.equal(result.status, 0, `workflow install failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes("Installed workflow: do-now"),
    `workflow install did not report success:\n${result.stdout}`);
}

function provisionFixtures(): void {
  for (const caseId of ["US004-BEHAVIORS-CELL", "US004-BEHAVIORS-NOCELL"]) {
    fs.rmSync(path.join(varRoot, "fixtures", "work", caseId), { recursive: true, force: true });
    const provision = provisionWorkClone({ fixture: "tt-ts", caseId });
    assert.equal(provision.ok, true, `${caseId}: fixture provision failed: ${JSON.stringify(provision.reason ?? provision)}`);
  }
}

// The exact materialization the controller must produce: read the cell's
// behaviors.json, rekey every agent to <workflowId>_<agent>, and write the
// materialized object the same way (JSON.stringify(x, null, 2) + "\n").
function expectedMaterialized(): { content: string; sha256: string } {
  const cellDir = path.join(ttRoot, CELL_DIR);
  const scenario = JSON.parse(fs.readFileSync(path.join(cellDir, "scenario.json"), "utf8"));
  assert.equal(scenario.id, CELL_SCENARIO_ID);
  const template = JSON.parse(fs.readFileSync(path.join(cellDir, scenario.behaviors), "utf8"));
  const agents: Record<string, unknown> = {};
  for (const [agentId, entry] of Object.entries(template.agents)) {
    agents[`${CELL_WORKFLOW}_${agentId}`] = entry;
  }
  const materialized = { ...template, agents };
  const content = `${JSON.stringify(materialized, null, 2)}\n`;
  return { content, sha256: createHash("sha256").update(content).digest("hex") };
}

// Read the run's step output from the contained scripted daemon DB — the
// scripted runtime stores the canned output in steps.output on `step complete`.
// The product's steps.run_id is the RAW UUID (no "run-" prefix); the
// controller's attempt.run_id carries the display prefix, so strip it.
function stepOutputForRun(runId: string, stepId: string): string {
  const dbPath = path.join(scriptedStateDir, "tamandua.db");
  assert.ok(fs.existsSync(dbPath), `contained scripted DB missing: ${dbPath}`);
  const rawRunId = runId.replace(/^run-/, "");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT output FROM steps WHERE run_id = ? AND step_id = ?").get(rawRunId, stepId) as
      | { output: string | null }
      | undefined;
    return row?.output ?? "";
  } finally {
    db.close();
  }
}

describe("US-004 controller-side scripted-behaviors materialization wiring", () => {
  it("materializes cell behaviors, sets TAMANDUA_SCRIPTED_BEHAVIORS in the launch env, and the scripted step output matches the cell's canned output (zero tokens)",
    { timeout: 60 * 60 * 1000 }, async () => {
      // Hygiene: no lingering scripted daemon, ports free, tree clean.
      const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
      assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
      await assertPortsFree();
      const before = gitSnapshot();

      const manifestPath = buildManifest();
      const expected = expectedMaterialized();

      // Fresh scripted home: wipe the contained state so the current product
      // binary recreates the DB schema.
      fs.rmSync(scriptedStateDir, { recursive: true, force: true });
      fs.mkdirSync(scriptedStateDir, { recursive: true });
      fs.writeFileSync(path.join(scriptedHome, ".gitconfig"),
        "[user]\n\tname = TT Scripted Behaviors\n\temail = tt-scripted@tamandua.invalid\n[commit]\n\tgpgsign = false\n", "utf8");
      installWorkflowIntoScriptedCatalog();
      provisionFixtures();

      // Start the 53xx scripted daemon WITHOUT any behaviors env. The ONLY way
      // the scripted runtimes get behaviors is the controller's materialization
      // + daemon restart (daemon-control env_for_kind forwards the two keys
      // from the CALLER env into the daemon env at start/restart).
      const plainEnv = batteryEnv();
      const start = run(daemonControl, ["scripted", "start"], plainEnv, 120_000);
      assert.equal(start.status, 0, `scripted daemon start failed:\n${start.stdout}\n${start.stderr}`);

      let campaignId: string | null = null;
      try {
        const result = await runStreaming(controller, ["--manifest", manifestPath], plainEnv);
        const m = CAMPAIGN_LINE.exec(result.stdout);
        campaignId = m === null ? null : m[1];
        assert.ok(campaignId, `campaign did not print an ID:\n${result.stdout}\n${result.stderr}`);
        // Both cases must run to completion (PASS) — the cell case via the
        // materialized behaviors, the no-cell control case unaffected.
        assert.equal(result.status, 0, `campaign must be GREEN:\n${result.stdout}\n${result.stderr}`);

        const campaignDir = path.join(resultsRoot, campaignId);
        const report = loadJson(path.join(campaignDir, "report.json"));
        const state = loadJson(path.join(campaignDir, "state.json"));
        assert.equal(report.verdict, "GREEN", `campaign verdict must be GREEN: ${report.verdict}`);
        assert.equal(report.exit_code, 0);

        const cell = state.cases.find((c: any) => c.id === "US004-BEHAVIORS-CELL");
        assert.ok(cell, "cell case must appear in campaign state");
        assert.equal(cell.outcome, "PASS", `cell case must PASS: ${JSON.stringify(cell.reason ?? null)}`);
        assert.equal(cell.spend?.tokens_observed ?? 0, 0, "cell case spend must be zero");
        const attempt = cell.attempts[0];
        assert.equal(attempt.execution_mode, "scripted");

        // ── AC1/AC3: the controller materialized behaviors from the cell and
        //    the scripted step's agent output matches the cell's canned output. ──
        const sb = attempt.scripted_behaviors;
        assert.ok(sb, `attempt must record scripted_behaviors evidence: ${JSON.stringify(attempt)}`);
        assert.equal(sb.workflow_id, CELL_WORKFLOW);
        assert.equal(sb.scenario_path, CELL_DIR);
        assert.match(sb.path, /^\.\.\/\.\.\/behaviors\/[^/]+\/US004-BEHAVIORS-CELL\.json$/,
          `materialized path must live under the campaign behaviors scratch: ${sb.path}`);
        assert.equal(sb.sha256, expected.sha256,
          "materialized file sha256 must match the cell behaviors rekeyed to <workflowId>_<agent>");
        // The launch env var is set to the materialized file (the recorded
        // var_path IS the value of TAMANDUA_SCRIPTED_BEHAVIORS in childEnv).
        assert.match(sb.var_path, /^var\/behaviors\/[^/]+\/US004-BEHAVIORS-CELL\.json$/,
          `var_path must be the contained materialized behaviors path: ${sb.var_path}`);
        // The daemon must have been restarted with the materialized env.
        assert.ok(sb.daemon_restart, "attempt must record the scripted daemon restart");
        assert.equal(sb.daemon_restart.exit_code, 0,
          `daemon restart with the materialized env must succeed: ${JSON.stringify(sb.daemon_restart)}`);

        // The run completed and the doer step output matches the cell's canned
        // output (the materialized behaviors reached the daemon's workers).
        assert.ok(attempt.run_id, "run id must be recorded");
        const stepOutput = stepOutputForRun(attempt.run_id, "execute");
        assert.ok(stepOutput.includes(CELL_CANNED_MARKER),
          `doer step output must contain the cell's canned marker:\n${stepOutput}`);
        assert.ok(stepOutput.includes("STATUS: done"), `doer step output must be an honest completion:\n${stepOutput}`);

        // ── AC4: cases without a scenario cell are unaffected. ──
        const noCell = state.cases.find((c: any) => c.id === "US004-BEHAVIORS-NOCELL");
        assert.ok(noCell, "no-cell control case must appear in campaign state");
        assert.equal(noCell.outcome, "PASS", `no-cell control case must PASS: ${JSON.stringify(noCell.reason ?? null)}`);
        assert.equal(noCell.attempts[0].scripted_behaviors, undefined,
          "no-cell case must have NO scripted_behaviors record (TAMANDUA_SCRIPTED_BEHAVIORS absent)");

        // ── AC2: the materialized behaviors scratch is removed with the
        //    campaign (the per-case files are transient launch wiring). ──
        const behaviorsRoot = path.join(varRoot, "behaviors", campaignId);
        assert.ok(!fs.existsSync(behaviorsRoot),
          `campaign behaviors scratch must be removed with the campaign: ${behaviorsRoot}`);
      } finally {
        run(daemonControl, ["scripted", "stop"], process.env);
        if (campaignId !== null) {
          fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
        }
        fs.rmSync(workRoot, { recursive: true, force: true });
      }

      // Hygiene: ports free, tree clean.
      await assertPortsFree();
      assert.equal(gitSnapshot(), before, "US-004 behaviors test changed git status");
    });
});
