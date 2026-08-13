// Tier-0 integration gate (US-006): zero-token dry-run/argv-recording hook
// for the real-launch path.
//
// E2.2 root cause: the real-launch path could never be integration-tested on
// a host without spending real tokens, so `--include-real` reachability was
// unproven. This file pins the controller's test-only hook
// TT_DRY_RUN_REAL_LAUNCH: when set, the controller RECORDS the exact launch
// argv it would hand to `tamandua` for each real (pi/hermes) case and marks
// the case PASS without ever spawning the model-backed tamandua run (zero
// tokens by construction). When unset, the controller takes the normal real
// launch path exactly as before and writes nothing.
//
// The recorded argv is the authoritative reachability proof for US-008: it
// includes the workflow, --task-file (task path), the --*{pi,hermes}-as-harness
// harness flag, the fixture repository path, and the scheduler args (--wait
// --json).
//
// Zero-token: the hook short-circuits before any tamandua / pi / hermes model
// launch; the unset control points the `tamandua` executable at a throwaway
// PATH stub that records its argv and exits 0 — no model is ever invoked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const controller = path.join(binDir, "tt-controller");
const varRoot = path.join(ttRoot, "var");
const fixturesRoot = path.join(varRoot, "fixtures", "work");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;

const REAL_CASE_IDS = ["W1.L1-python", "W3.03-bfmw-hermes-ts"];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runTt(script: string, args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: { ...process.env, HOME: os.homedir(), ...extraEnv },
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Build a zero-token manifest under var/ carrying TWO tier1 REAL cases
// VERBATIM (W1.L1-python: pi; W3.03-bfmw-hermes-ts: hermes). These go through
// executeWorkflowCase (the real-launch path). Returns the manifest path.
function buildRealManifest(): string {
  const tier1Path = path.join(ttRoot, "cases", "tier1.jsonl");
  const tier1: any[] = fs
    .readFileSync(tier1Path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const wanted = new Set(REAL_CASE_IDS);
  const records = tier1.filter((c) => wanted.has(c.id));
  assert.deepEqual(
    records.map((c) => c.id).sort(),
    [...REAL_CASE_IDS].sort(),
    "tier1.jsonl must contain the US-006 real proof cases",
  );
  const name = `US006-${Date.now()}-${process.pid}.jsonl`;
  const manifestPath = path.join(varRoot, name);
  fs.writeFileSync(manifestPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return manifestPath;
}

// Ensure a minimal valid git repository exists at the fixture path so the
// controller's non-dry-run launch path (beginCaseOracleSnapshot -> the oracle
// evidence snapshot) can read a real git dir. Idempotent; writes live under
// gitignored var/.
function ensureFixtureRepo(caseId: string, fixture: string): void {
  const repo = path.join(fixturesRoot, caseId, fixture);
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
  const hasCommit = (() => {
    try {
      const r = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8" });
      return r.status === 0;
    } catch {
      return false;
    }
  })();
  if (hasCommit) return;
  const init = spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
  assert.equal(init.status, 0, `git init failed for ${repo}: ${init.stderr}`);
  spawnSync("git", ["-C", repo, "config", "user.email", "torture@tetradactyla.org"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.name", "torture-test"], { encoding: "utf8" });
  fs.writeFileSync(path.join(repo, "README.md"), "# US-006 fixture\n");
  spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
  const commit = spawnSync("git", ["-C", repo, "commit", "-qm", "us006 fixture"], { encoding: "utf8" });
  assert.equal(commit.status, 0, `git commit failed for ${repo}: ${commit.stderr}`);
}

describe("Zero-token dry-run/argv-recording hook for the real-launch path (US-006)", () => {
  it("with TT_DRY_RUN_REAL_LAUNCH set, records full launch argv and completes PASS with zero tokens", () => {
    const manifestPath = buildRealManifest();
    const rel = path.relative(ttRoot, manifestPath);
    const outPath = path.join(varRoot, `us006-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });

    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(controller, ["--manifest", rel], { TT_DRY_RUN_REAL_LAUNCH: outPath });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);

    // AC1: exits 0 (no model/token spend; no real tamandua invoked).
    assert.equal(res.status, 0, `dry-run campaign must exit 0:\n${res.stdout}${res.stderr}`);

    // AC2: the full launch argv (workflow, harness, fixture, task, scheduler
    // args) is persisted to the requested file.
    assert.ok(fs.existsSync(outPath), `argv-recording file was not written: ${outPath}`);
    const lines = fs
      .readFileSync(outPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const byId = new Map(lines.map((r) => [r.case_id, r]));
    assert.equal(byId.size, REAL_CASE_IDS.length, "one argv record per real case");

    const python = byId.get("W1.L1-python");
    assert.ok(python, "W1.L1-python argv must be recorded");
    assert.equal(python.harness, "pi");
    assert.equal(python.workflow, "do-now");
    assert.equal(python.executable, "tamandua");
    assert.ok(Array.isArray(python.argv) && python.argv.includes("do-now"),
      "argv must include the workflow");
    const taskIdx = python.argv.indexOf("--task-file");
    assert.ok(taskIdx >= 0, "argv must include --task-file");
    assert.equal(python.argv[taskIdx + 1], "cases/tasks/tier1/W1.L1-python.md",
      "argv must include the task path");
    assert.ok(python.argv.includes("--pi-as-harness"),
      "argv must include the scheduler's pi harness flag");
    const wdIdx = python.argv.indexOf("--working-directory-for-harness");
    assert.ok(wdIdx >= 0, "argv must include the fixture path flag for a non-worktree workflow");
    assert.match(python.argv[wdIdx + 1], /tt-python$/, "argv fixture path must name the fixture");
    assert.ok(python.argv.includes("--wait") && python.argv.includes("--json"),
      "argv must include the scheduler args --wait --json");

    const hermes = byId.get("W3.03-bfmw-hermes-ts");
    assert.ok(hermes, "W3.03 hermes argv must be recorded");
    assert.equal(hermes.harness, "hermes");
    assert.ok(hermes.argv.includes("--hermes-as-harness"),
      "argv must include the scheduler's hermes harness flag");
    const hTaskIdx = hermes.argv.indexOf("--task-file");
    assert.ok(hTaskIdx >= 0);
    assert.equal(hermes.argv[hTaskIdx + 1], "cases/tasks/tier1/W3.03-bfmw-hermes-ts.md");
    const woIdx = hermes.argv.indexOf("--worktree-origin-repository");
    assert.ok(woIdx >= 0, "worktree workflow argv must include --worktree-origin-repository");
    assert.match(hermes.argv[woIdx + 1], /tt-ts$/, "hermes fixture path must name the fixture");

    // Zero-token: every real case is PASS with >=1 attempt (recorded), and the
    // spend ledger is 0 (no model invocation).
    const state = loadJson(path.join(varRoot, "results", campaignId, "state.json"));
    for (const caseState of state.cases) {
      assert.equal(caseState.outcome, "PASS", `${caseState.id}: dry-run case must be PASS`);
      assert.ok(caseState.attempts.length >= 1, `${caseState.id}: must have a recorded attempt`);
      const dry = caseState.attempts.find((a: any) => a.dry_run_launch === true);
      assert.ok(dry, `${caseState.id}: attempt must carry the dry_run_launch marker`);
      assert.ok(Array.isArray(dry.dry_run_argv) && dry.dry_run_argv.includes("workflow"),
        `${caseState.id}: attempt must persist the recorded argv`);
    }
    assert.equal(state.spend.tokens_observed, 0, "dry-run must spend zero tokens");

    fs.rmSync(path.join(varRoot, "results", campaignId), { recursive: true, force: true });
    fs.rmSync(outPath, { force: true });
  });

  it("without TT_DRY_RUN_REAL_LAUNCH the real-launch path is unchanged and writes no dry-run file", () => {
    const manifestPath = buildRealManifest();
    const rel = path.relative(ttRoot, manifestPath);

    // Throwaway PATH stub for `tamandua`: records that it was launched. The
    // controller resolves the bare `tamandua` executable via PATH (shell:
    // false), so this proves the NORMAL real-launch (spawn tamandua) path runs
    // when the hook is unset — NOT the dry-run short-circuit.
    const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "us006-stub-"));
    const marker = path.join(stubBin, "stub-invoked.log");
    const stub = path.join(stubBin, "tamandua");
    fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "STUB-LAUNCHED: $*" >> "${marker}"\nexit 0\n`);
    fs.chmodSync(stub, 0o755);

    // The non-dry-run path reads the fixture git repos; seed minimal repos.
    ensureFixtureRepo("W1.L1-python", "tt-python");
    ensureFixtureRepo("W3.03-bfmw-hermes-ts", "tt-ts");

    const dryOut = path.join(varRoot, `us006-control-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(dryOut, { force: true });

    let res!: RunResult;
    let campaignId: string | null = null;
    // Capture the stub log BEFORE cleanup (the finally removes the stub dir).
    let markerContent = "";
    try {
      // TT_CONTROLLER_PREFLIGHT_DISABLED=1 is the controller's documented
      // escape hatch for unit-style regression tests that simulate real
      // launches with a stub `tamandua` (used identically by
      // tt-controller.test.sh / tt-controller-infra-classify.test.sh). The
      // preflight (home-provision → catalog → daemon-up) would otherwise
      // resolve `tamandua` to THIS stub and abort at tt-daemon-down — it is
      // exercised separately by tt-controller-preflight.test.sh and
      // tt-controller-idempotence.test.sh. The real-launch path under test
      // (spawn tamandua per case) is unchanged by the hatch.
      res = runTt(controller, ["--manifest", rel], {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
      });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      if (fs.existsSync(marker)) markerContent = fs.readFileSync(marker, "utf8");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);

    // AC3: without the hook, the real-launch path still spawns tamandua (the
    // stub received the launch) exactly as before.
    const launches = markerContent.split(/\r?\n/).filter((line) => line.length > 0);
    assert.equal(launches.length, REAL_CASE_IDS.length,
      `unset hook must NOT short-circuit the real launch; tamandua must be spawned for both cases (got: ${JSON.stringify(launches)})`);
    assert.match(launches[0], /workflow run do-now/, "stub launch argv must name the workflow");
    assert.match(launches[0], /--pi-as-harness/, "stub launch argv must carry the pi harness flag");
    assert.match(launches[1], /--hermes-as-harness/, "stub launch argv must carry the hermes harness flag");

    // The dry-run recorder must be totally inactive when the env var is unset:
    // no argv file, and no dry_run_launch marker on any attempt.
    assert.ok(!fs.existsSync(dryOut),
      "no dry-run argv file may be written when TT_DRY_RUN_REAL_LAUNCH is unset");
    const state = loadJson(path.join(varRoot, "results", campaignId, "state.json"));
    for (const caseState of state.cases) {
      assert.ok(caseState.attempts.length >= 1, `${caseState.id}: real launch must record an attempt`);
      assert.equal(
        caseState.attempts.some((a: any) => a.dry_run_launch === true),
        false,
        `${caseState.id}: unset hook must not emit the dry_run_launch marker`,
      );
    }

    fs.rmSync(path.join(varRoot, "results", campaignId), { recursive: true, force: true });
  });
});
