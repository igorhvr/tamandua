import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const launcher = path.join(repoRoot, "run-torture-test");
const controller = path.join(ttRoot, "bin", "tt-controller");
const daemonControl = path.join(ttRoot, "bin", "daemon-control");
const manifest = path.join(ttRoot, "cases", "tier0.jsonl");
const scenarioReadme = path.join(ttRoot, "scenarios", "README.md");
const preflightHooks = ["run-w0.1", "run-w0.2"].map((name) =>
  path.join(ttRoot, "cases", "hooks", name));
const realCaseIds = ["T0.real-pi-bfmw-tt-ts", "T0.real-hermes-do-now"];

// FIX10 US-006: the operator's real ~/.gitconfig must be byte-identical
// before and after the double-gate, and every gate's retained report must
// carry the HYGIENE CANARY section with gitconfig UNCHANGED.
const operatorHome = os.homedir();
const realGitconfig = path.join(operatorHome, ".gitconfig");

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
const blockedRealEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  // node:test marks descendants as tests; these scenarios intentionally use
  // the dedicated TT home and ports, so disable only the live-state guard.
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scenarioOwnedProcesses(): string[] {
  const matches: string[] = [];
  // /proc introspection below is linux-only (MACP3 US-003). Darwin branch:
  // Darwin has no procfs, so return an empty match list (nothing to clean up)
  // instead of throwing on readdirSync("/proc"). Linux behavior unchanged.
  if (process.platform !== "linux") return matches;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const command = fs.readFileSync(path.join("/proc", entry, "cmdline"), "utf8").replaceAll("\0", " ");
      if (command.includes(`${ttRoot}/scenarios/`)
          || command.includes(`${varRoot}/scenarios/`)
          || (command.includes(`${varRoot}/home-scripted`) && /tamandua|scripted-(?:pi|hermes)/.test(command))) {
        matches.push(`${entry}: ${command}`);
      }
    } catch {
      // The process exited or is not inspectable between readdir and read (
      // linux-only; on a /proc-less host the early Darwin return above already
      // handled it — MACP3 US-003).
    }
  }
  return matches;
}

function scenarioMetadata(): Array<{ id: string; workflow_base: string }> {
  const metadata: Array<{ id: string; workflow_base: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      if (entry.isFile() && entry.name === "scenario.json") {
        metadata.push(JSON.parse(fs.readFileSync(candidate, "utf8")));
      }
    }
  };
  visit(path.join(ttRoot, "scenarios"));
  return metadata;
}

function assertTransientStateRemoved(campaignDir: string): void {
  assert.equal(fs.existsSync(path.join(campaignDir, ".controller.lock")), false, "campaign lock leaked");
  const scenariosRoot = path.join(varRoot, "scenarios");
  const scenarioResidue = fs.existsSync(scenariosRoot) ? fs.readdirSync(scenariosRoot) : [];
  assert.deepEqual(scenarioResidue, [], `scenario invocation/lock/counter residue: ${scenarioResidue.join(", ")}`);

  const workflowsRoot = path.join(varRoot, "home-scripted", ".tamandua", "workflows");
  const workflows = fs.existsSync(workflowsRoot) ? fs.readdirSync(workflowsRoot) : [];
  const leakedCopies = scenarioMetadata().flatMap(({ id, workflow_base }) =>
    workflows.filter((entry) => entry.startsWith(`${workflow_base}-${id}-`)));
  assert.deepEqual(leakedCopies, [], `scenario workflow copies leaked: ${leakedCopies.join(", ")}`);
}

function assertOracleEvidence(campaignDir: string, state: any): void {
  for (const caseState of state.cases.filter((item: any) => item.outcome === "PASS")) {
    assert.ok(caseState.attempts.length > 0, `${caseState.id} passed without an attempt`);
    for (const attempt of caseState.attempts) {
      assert.equal(attempt.oracle_evidence?.status, "COMPLETE", `${caseState.id} oracle snapshot incomplete`);
      const ledger = path.join(campaignDir, attempt.oracle_evidence.ledger_path);
      assert.ok(fs.existsSync(ledger), `${caseState.id} snapshot ledger is missing`);
    }
    assert.ok(caseState.oracle_results.length > 0, `${caseState.id} has no oracle verdicts`);
    for (const oracle of caseState.oracle_results) {
      assert.equal(oracle.executable, `oracles/${oracle.oracle_id}`,
        `${caseState.id}/${oracle.oracle_id} did not invoke the declared oracle executable`);
      assert.deepEqual(oracle.argv?.slice(0, 3),
        [`oracles/${oracle.oracle_id}`, "--contract-version", "1"],
        `${caseState.id}/${oracle.oracle_id} did not retain contract argv evidence`);
      assert.ok(typeof oracle.context === "string" && fs.existsSync(path.join(campaignDir, oracle.context)),
        `${caseState.id}/${oracle.oracle_id} did not retain its invocation context`);
      assert.ok(typeof oracle.stdout === "string" && fs.existsSync(path.join(campaignDir, oracle.stdout)),
        `${caseState.id}/${oracle.oracle_id} did not retain executable stdout`);
      assert.equal(oracle.status, "VALID", `${caseState.id}/${oracle.oracle_id} was not valid`);
      assert.equal(oracle.response?.result, "PASS", `${caseState.id}/${oracle.oracle_id} did not pass`);
      const oracleEvidenceDir = path.dirname(path.join(campaignDir, oracle.context));
      for (const evidence of oracle.response?.evidence ?? []) {
        const evidenceFile = path.join(oracleEvidenceDir, evidence.path);
        assert.ok(fs.existsSync(evidenceFile), `${caseState.id}/${oracle.oracle_id} evidence is missing: ${evidence.path}`);
      }
      if (oracle.oracle_id === "O3z") {
        const tokenEvidence = (oracle.response?.evidence ?? []).find((item: any) => item.path.endsWith("o3z-token-gate.json"));
        assert.ok(tokenEvidence, `${caseState.id}/O3z token evidence is missing`);
        const tokenGate = JSON.parse(fs.readFileSync(path.join(oracleEvidenceDir, tokenEvidence.path), "utf8"));
        assert.deepEqual(tokenGate.system_tokens, { before: 0, after: 0, terminal_database: 0 });
        assert.equal(tokenGate.checks?.baseline_present, true, `${caseState.id}/O3z baseline was not captured`);
        assert.equal(tokenGate.checks?.terminal_ledger_present, true, `${caseState.id}/O3z terminal token ledger was not captured`);
        assert.equal(tokenGate.checks?.system_counter_present, true, `${caseState.id}/O3z system-token counter was missing`);
        assert.ok(tokenGate.runs.every((item: any) => item.tokens_spent === 0), `${caseState.id}/O3z observed run tokens`);
      }
    }
  }
}

async function assertCampaign(runNumber: number): Promise<string> {
  const before = gitSnapshot();
  const result = await runStreaming(launcher, ["--tier0"]);
  assert.equal(result.status, 0, `Tier-0 run ${runNumber} failed:\n${result.stdout}\n${result.stderr}`);
  const campaignMatch = /^Campaign: (campaign-[A-Za-z0-9._-]+)$/m.exec(result.stdout);
  assert.ok(campaignMatch, `Tier-0 run ${runNumber} did not print a campaign ID:\n${result.stdout}`);
  const campaignDir = path.join(resultsRoot, campaignMatch[1]);
  const reportPath = path.join(campaignDir, "report.json");
  const textPath = path.join(campaignDir, "report.txt");
  const statePath = path.join(campaignDir, "state.json");
  for (const retained of [reportPath, textPath, statePath]) assert.ok(fs.existsSync(retained), `missing retained result ${retained}`);

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(report.verdict, "GREEN");
  assert.equal(report.exit_code, 0);
  assert.equal(report.spend.tokens_observed, 0);
  assert.equal(state.spend.tokens_observed, 0);
  assert.ok(report.rows.filter((row: any) => row.outcome === "PASS").every((row: any) => row.tokens_observed === 0));
  assert.ok(state.discovered_runs.every((item: any) => item.tokens_observed === 0));
  assert.deepEqual(report.pending_real.map((item: any) => item.id).sort(), [...realCaseIds].sort());
  assert.deepEqual(report.not_run, []);
  for (const id of realCaseIds) {
    const row = report.rows.find((item: any) => item.id === id);
    const caseState = state.cases.find((item: any) => item.id === id);
    assert.equal(row?.outcome, "NOT_RUN");
    assert.equal(row?.reason?.category, "pending-real");
    assert.deepEqual(caseState?.attempts, [], `${id} unexpectedly launched`);
  }
  for (const row of report.rows.filter((item: any) => !realCaseIds.includes(item.id))) {
    assert.equal(row.outcome, "PASS", `${row.id} was not a launched scripted PASS`);
  }
  assertOracleEvidence(campaignDir, state);

  const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
  assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
  assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m);
  const provenancePath = path.join(varRoot, "daemon-control", "scripted.json");
  if (fs.existsSync(provenancePath)) {
    const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
    assert.equal(processIsAlive(provenance.pid), false, `provenanced scripted PID ${provenance.pid} survived`);
  }
  await assertPortsFree();
  assert.deepEqual(scenarioOwnedProcesses(), [], "scenario-owned process survived teardown");
  assertTransientStateRemoved(campaignDir);
  assert.equal(gitSnapshot(), before, `Tier-0 run ${runNumber} changed git status`);
  // FIX10 US-006: the retained report must prove the hygiene canary armed
  // and verified the REAL operator identity files unchanged (no silent
  // contamination like the 2026-08-05 ~/.gitconfig breach).
  assert.ok(Array.isArray(report.hygiene_canary?.files), `Tier-0 run ${runNumber} report lacks hygiene_canary`);
  const canaryGitconfig = report.hygiene_canary.files.find((entry: any) => entry.name === "gitconfig");
  assert.equal(canaryGitconfig?.status, "UNCHANGED", `Tier-0 run ${runNumber}: canary gitconfig must be UNCHANGED`);
  assert.equal(canaryGitconfig?.before, canaryGitconfig?.after,
    `Tier-0 run ${runNumber}: canary gitconfig before/after hashes must match`);
  assert.deepEqual(report.hygiene_canary.diffs, [], `Tier-0 run ${runNumber}: canary reported hygiene diffs`);
  const text = fs.readFileSync(textPath, "utf8");
  assert.match(text, /HYGIENE CANARY/, `Tier-0 run ${runNumber}: report.txt must render the HYGIENE CANARY section`);
  assert.match(text, /- gitconfig: UNCHANGED/, `Tier-0 run ${runNumber}: report.txt must show gitconfig UNCHANGED`);
  return campaignDir;
}

describe("Tier-0 repeatability acceptance", () => {
  it("documents zero-token default, pending-real records, validation, and explicit real opt-in", () => {
    const documentation = fs.readFileSync(scenarioReadme, "utf8");
    assert.match(documentation, /## Tier-0 operator contract/);
    assert.match(documentation, /run-torture-test --tier0.*zero tokens/s);
    assert.match(documentation, /exactly two.*pending-real/s);
    assert.match(documentation, /tt-controller --manifest.*tier0\.jsonl --validate-only/s);
    assert.match(documentation, /--tier0 --include-real.*spends real tokens/s);
    for (const hook of preflightHooks) {
      const content = fs.readFileSync(hook, "utf8");
      assert.doesNotMatch(content, /(?:export|env) HOME=/,
        `${path.basename(hook)} must retain the contained scripted HOME`);
      assert.doesNotMatch(content, /TAMANDUA_(?:PI|HERMES)_BINARY/,
        `${path.basename(hook)} must retain the deterministic harness backstops`);
      assert.match(content, /unset[\s\S]*TAMANDUA_STATE_DIR[\s\S]*TAMANDUA_CONTROL_PORT/,
        `${path.basename(hook)} must let its test suite allocate isolated state and ports`);
      if (path.basename(hook) === "run-w0.1") {
        assert.match(content, /\.pi\/agent[\s\S]*defaultProvider[\s\S]*stub[\s\S]*settings\.json/,
          "run-w0.1 must seed a contained zero-token pi config for nested workflow-install tests");
        assert.match(content, /GIT_CONFIG_GLOBAL[\s\S]*user\.name[\s\S]*user\.email/,
          "run-w0.1 must seed contained Git identity for nested fixture commits");
      }
    }
  });

  it("invokes the declared executable for a local scripted oracle", () => {
    fs.mkdirSync(varRoot, { recursive: true });
    const record = fs.readFileSync(manifest, "utf8").split(/\r?\n/).find((line) => line.includes('"id":"W0.0-fast"'));
    assert.ok(record, "W0.0-fast manifest record is missing");
    const focusedManifest = path.join(varRoot, `tier0-local-oracle-${process.pid}.jsonl`);
    fs.writeFileSync(focusedManifest, `${record}\n`, { flag: "wx" });
    try {
      const result = run(controller, ["--manifest", focusedManifest, "--scripted-only"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const campaignMatch = /^Campaign: (campaign-[A-Za-z0-9._-]+)$/m.exec(result.stdout);
      assert.ok(campaignMatch, `focused controller run omitted campaign ID:\n${result.stdout}`);
      const campaignDir = path.join(resultsRoot, campaignMatch[1]);
      const state = JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
      assertOracleEvidence(campaignDir, state);
    } finally {
      fs.rmSync(focusedManifest, { force: true });
    }
  });

  // One gate is capped at three hours. This acceptance deliberately executes
  // two independent gates, so its own ceiling must cover both tier budgets.
  it("runs the default Tier-0 gate green twice with retained evidence and clean teardown", { timeout: 6 * 60 * 60 * 1000 }, async () => {
    const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
    assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
    await assertPortsFree();
    fs.rmSync(path.join(varRoot, "scenarios"), { recursive: true, force: true });
    fs.rmSync(path.join(varRoot, "home-scripted"), { recursive: true, force: true });

    const validation = run(controller, ["--manifest", manifest, "--validate-only"]);
    assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
    assert.match(validation.stdout, /Validated 35 case\(s\)/);
    const gitconfigBefore = sha256(realGitconfig);
    const campaigns = [await assertCampaign(1), await assertCampaign(2)];
    assert.notEqual(campaigns[0], campaigns[1], "repeat executions must retain distinct campaign evidence");
    assert.equal(sha256(realGitconfig), gitconfigBefore,
      "the real ~/.gitconfig sha256 must be byte-identical after both Tier-0 gates");
  });
});
