import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, it } from "node:test";

// US-007 — Proof test: bare --tier1 remains GREEN twice.
//
// Regression proof that the contract/resolver + fail-closed changes (US-001..006)
// did NOT disturb the bare (no --include-real) `./run-torture-test --tier1`
// path, which the launcher maps to tt-controller --scripted-only. Bare mode
// must remain a zero-token GREEN: every real Tier-1 case is reported
// pending-real (NOT predicate-blocked, NOT infra-failed), and two consecutive
// invocations are each GREEN exit 0.
//
// Confined entirely to torture-test/ (state under var/, gitignored). Zero tokens.

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const launcher = path.join(repoRoot, "run-torture-test");
const controller = path.join(ttRoot, "bin", "tt-controller");
const daemonControl = path.join(ttRoot, "bin", "daemon-control");
const manifest = path.join(ttRoot, "cases", "tier1.jsonl");

// node:test marks descendants as tests; these scenarios intentionally use the
// dedicated TT home and ports, so disable only the live-state guard. Harness
// binaries are injected by tt-env-scripted.sh at spawn time; the /bin/false
// backstops below guard against any leak of a real model invocation.
const blockedRealEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

type CommandResult = { status: number | null; stdout: string; stderr: string };

function run(file: string, args: string[], env = blockedRealEnv): CommandResult {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function runStreaming(file: string, args: string[], env = blockedRealEnv): Promise<CommandResult> {
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

function gitSnapshot(): string {
  const result = run("git", ["status", "--porcelain", "--untracked-files=all"], process.env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function assertPortsFree(): Promise<void> {
  for (const port of [5334, 5338, 5339]) {
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error) => reject(new Error(`scripted port ${port} is not free: ${error.message}`)));
      server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
    });
  }
}

// Tier-1 real case ids are those whose manifest record declares real (model-backed)
// execution. They must be reported pending-real in bare mode.
function realCaseIds(): string[] {
  const ids: string[] = [];
  for (const line of fs.readFileSync(manifest, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.context?.execution_mode === "real") ids.push(record.id);
  }
  return ids;
}

const realIds = realCaseIds();

async function assertBareTier1Run(runNumber: number): Promise<void> {
  const before = gitSnapshot();
  const result = await runStreaming(launcher, ["--tier1"]);
  assert.equal(result.status, 0, `Tier-1 bare run ${runNumber} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  const campaignMatch = /^Campaign: (campaign-[A-Za-z0-9._-]+)$/m.exec(result.stdout);
  assert.ok(campaignMatch, `Tier-1 bare run ${runNumber} did not print a campaign ID:\n${result.stdout}`);
  const campaignDir = path.join(resultsRoot, campaignMatch[1]);
  const reportPath = path.join(campaignDir, "report.json");
  const statePath = path.join(campaignDir, "state.json");
  for (const retained of [reportPath, path.join(campaignDir, "report.txt"), statePath]) {
    assert.ok(fs.existsSync(retained), `missing retained result ${retained}`);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

  // AC1: bare run is GREEN exit 0 with zero tokens.
  assert.equal(report.verdict, "GREEN");
  assert.equal(report.exit_code, 0);
  assert.equal(report.spend.tokens_observed, 0);
  assert.equal(state.spend.tokens_observed, 0);

  // AC2: every real tier1 case is reported pending-real — never predicate-blocked
  // (NOT_RUN(predicate)) and never an infra failure — in BOTH runs.
  const pendingRealIds = new Set(report.pending_real.map((item: any) => item.id));
  for (const id of realIds) {
    const row = report.rows.find((item: any) => item.id === id);
    const caseState = state.cases.find((item: any) => item.id === id);
    assert.ok(row, `run ${runNumber}: report missing real case ${id}`);
    assert.equal(row.outcome, "NOT_RUN", `run ${runNumber}: ${id} outcome=${row.outcome} (expected NOT_RUN pending-real)`);
    assert.equal(row.reason?.category, "pending-real",
      `run ${runNumber}: ${id} must be pending-real, got ${row.reason?.category}`);
    assert.ok(pendingRealIds.has(id), `run ${runNumber}: ${id} not listed in pending_real`);
    assert.deepEqual(caseState?.attempts, [], `run ${runNumber}: ${id} unexpectedly launched an attempt`);
    assert.equal(row.tokens_observed, 0, `run ${runNumber}: ${id} spent tokens`);
  }
  // No real case may be NOT_RUN(predicate) or NOT_RUN(daemon-control-unavailable).
  assert.equal(report.not_run.filter((item: any) => item.id !== undefined && realIds.includes(item.id)).length, 0,
    `run ${runNumber}: real cases wrongly categorized as NOT_RUN(predicate)/infra`);

  // Scripted cases must still launch (PASS) and must not be pending-real.
  for (const row of report.rows) {
    if (!realIds.includes(row.id)) {
      assert.equal(row.outcome, "PASS", `run ${runNumber}: scripted ${row.id} did not PASS: ${row.outcome}`);
    }
  }

  // Hygiene: the scripted daemon must be cleanly stopped and ports free.
  const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
  assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
  assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m);
  await assertPortsFree();
  assert.equal(gitSnapshot(), before, `Tier-1 bare run ${runNumber} changed git status`);
}

// Each bare tier1 run executes four full scripted scenarios (~2-3min wall each).
describe("Tier-1 bare proof test (US-007)", () => {
  it("runs bare --tier1 GREEN twice with real cases pending-real and zero tokens",
    { timeout: 90 * 60 * 1000 }, async () => {
      const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
      assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
      await assertPortsFree();
      fs.rmSync(path.join(varRoot, "scenarios"), { recursive: true, force: true });
      fs.rmSync(path.join(varRoot, "home-scripted"), { recursive: true, force: true });

      assert.ok(realIds.length > 0, "tier1.jsonl must contain real cases");
      const validation = run(controller, ["--manifest", manifest, "--validate-only"]);
      assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
      assert.match(validation.stdout, /Validated 28 case\(s\)/);

      // Sequential: both bare runs drive the same scripted daemon ports, so they
      // must not overlap.
      await assertBareTier1Run(1);
      await assertBareTier1Run(2);
    });
});
