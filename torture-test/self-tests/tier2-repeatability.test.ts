// US-016 — Final zero-token Tier-2 proof: repeatability GREEN x2, dry-run
// argv, tier1 no-regression.
//
// This is the campaign-side half of the Tier-2 acceptance battery (the
// traceability/exclusion + canary half lives in
// tier2-traceability-completeness.test.ts). It proves the WHOLE
// cases/tier2.jsonl roster with ZERO tokens and pins the --tier2 ladder
// rung's bare contract:
//
//   AC1 (repeatability): bare `./run-torture-test --tier2` exits 0 GREEN
//     TWICE with IDENTICAL per-case outcomes. With a synthesized host
//     profile that satisfies every real-case predicate (all toolchains +
//     pi/hermes/dsh harness presence + node_min 22) MINUS node-sqlite, the
//     45 real cases are NOT_RUN(pending-real) (execution-selection policy,
//     applied before predicates) and the 25 scripted cells gate honestly as
//     NOT_RUN(predicate) with evidence naming the missing capability — the
//     "every scripted case PASS or NOT_RUN(predicate)" contract, exercised
//     on the honest-gating arm. tokens_observed is 0 per case and per
//     campaign; the operator-identity hygiene canary is UNCHANGED; the
//     scripted daemon stays STOPPED and the 533x/433x ports stay free.
//
//   AC2 (dry-run argv): TT_DRY_RUN_REAL_LAUNCH over cases/tier2.jsonl with
//     the same satisfying profile records the exact launch argv for all 45
//     real cases — including the FIRST real W4 case
//     (W4.01-missing-evidence-reroute, pi) with --pi-as-harness and one
//     dsh-lane case (W4.dsh-do-now) with --dsh-as-harness — and marks each
//     PASS without ever spawning a model-backed run (zero tokens by
//     construction). The scripted cells stay NOT_RUN(predicate).
//
//   AC3 (no-regression): one bare `./run-torture-test --tier1` invocation
//     exits 0 GREEN (zero tokens) under the same synthesized profile — the
//     tier1 ladder rung is untouched by the tier2 authoring.
//
// Walled off: TT_DRY_RUN_REAL_LAUNCH is only consulted by executeWorkflowCase
// for execution_mode 'real'; normal campaigns (env unset) are unaffected.
//
// Heavy-campaign self-test: drives full controller campaigns (though each is
// fast here because every case is NOT_RUN), so it is excluded from run.sh and
// executed individually by bin/verify-heavy-campaign-tests.test.sh (the
// tier1-repeatability pattern). It rewrites the SHARED
// var/w0/host-profile.json and MUST be run one-file-per-invocation.
//
// Confined entirely to torture-test/ (state under gitignored var/). Zero
// tokens. The live daemon (33xx) is never touched.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const launcher = path.join(repoRoot, "run-torture-test");
const controller = path.join(binDir, "tt-controller");
const daemonControl = path.join(binDir, "daemon-control");
const hostProfilePath = path.join(varRoot, "w0", "host-profile.json");
const tier2Manifest = path.join(ttRoot, "cases", "tier2.jsonl");
const tier1Manifest = path.join(ttRoot, "cases", "tier1.jsonl");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;
const SCRIPTED_PORTS = [5334, 5338, 5339];
// The contained REAL daemon family (43xx) must stay free in every arm of this
// proof (bare tier2 never starts it; the dry run never requires it).
const CONTAINED_REAL_PORTS = [4334, 4338, 4339];

// The FIRST real W4 case in manifest order and one dsh-lane case — the two
// argv records AC2 pins. W4.01 is the manifest's first row; W4.dsh-do-now is
// the dsh lane's do-now variant (harness dsh → --dsh-as-harness).
const FIRST_REAL_W4 = "W4.01-missing-evidence-reroute";
const DSH_LANE_CASE = "W4.dsh-do-now";

// The roster's real-case population: 45 real (pi/hermes/dsh) + 25 scripted
// cells. Pinned here so a manifest edit that changes the population fails
// loudly instead of silently weakening the proof.
const EXPECTED_TOTAL_CASES = 70;
const EXPECTED_REAL_CASES = 45;
const EXPECTED_SCRIPTED_CASES = 25;

// Synthesized host profile: satisfies EVERY real-case predicate in
// tier2.jsonl (node/python3/go/rust/cargo/java+maven toolchains present,
// pi/hermes/dsh harness presence, node_min 22) MINUS node-sqlite
// (sqliteAvailable: false on the single runtime) so the 25 scripted cells
// gate honestly as NOT_RUN(predicate) — the zero-token, deterministic,
// idempotent proof shape (the tt-tier1-proof pattern). containment
// systemd-user-scope + platform linux match the scripted cells' predicates
// (node-sqlite is the one deliberately-omitted capability).
const SYNTHETIC_PROFILE = {
  platform: { os: "linux", label: "linux" },
  containment: { systemdUserScope: true, procfs: true },
  toolchains: {
    node: { present: true, buildPassed: true, testPassed: true },
    python3: { present: true, buildPassed: true, testPassed: true },
    go: { present: true, buildPassed: true, testPassed: true },
    "rust/cargo": { present: true, buildPassed: true, testPassed: true },
    "java+maven": { present: true, buildPassed: true, testPassed: true },
  },
  nodeRuntimes: [
    { version: "v24.0.0", major: 24, minor: 0, patch: 0, sqliteAvailable: false },
  ],
  capabilities: {},
  harness: {
    pi: { present: true, authenticated: true },
    hermes: { present: true, authenticated: true },
    dsh: { present: true, authenticated: true },
  },
};

type CommandResult = { status: number | null; stdout: string; stderr: string };

// node:test marks descendant processes; the campaigns drive the contained TT
// home/ports (never the operator ~/.tamandua), so disable only the live-state
// guard and drop NODE_TEST_CONTEXT (the tier1-repeatability pattern). The
// /bin/false backstops guard against ANY accidental real model invocation.
const blockedRealEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/bin/false",
};

function run(file: string, args: string[], env = blockedRealEnv, timeout = 300_000): CommandResult {
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

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadManifest(manifestPath: string): any[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function gitSnapshot(): string {
  const result = run("git", ["status", "--porcelain", "--untracked-files=all"], process.env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function assertPortsFree(ports: number[]): Promise<void> {
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error) => reject(new Error(`port ${port} is not free: ${error.message}`)));
      server.listen(port, "127.0.0.1", () => server.close((error) => (error ? reject(error) : resolve())));
    });
  }
}

async function listenerSnapshot(ports: number[]): Promise<Set<number>> {
  const listening = new Set<number>();
  for (const port of ports) {
    const held = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(true));
      probe.listen(port, "127.0.0.1", () => {
        probe.close((error) => {
          if (error) resolve(true);
          resolve(false);
        });
      });
    });
    if (held) listening.add(port);
  }
  return listening;
}

// ── host-profile backup/restore (the profile is SHARED across self-tests) ──
let profileBackup: Buffer | null = null;
let profileExisted = false;

function backupHostProfile(): void {
  profileExisted = fs.existsSync(hostProfilePath);
  profileBackup = profileExisted ? fs.readFileSync(hostProfilePath) : null;
  fs.mkdirSync(path.dirname(hostProfilePath), { recursive: true });
  fs.writeFileSync(hostProfilePath, `${JSON.stringify(SYNTHETIC_PROFILE, null, 2)}\n`);
}

function restoreHostProfile(): void {
  if (profileExisted && profileBackup !== null) {
    fs.writeFileSync(hostProfilePath, profileBackup);
  } else {
    fs.rmSync(hostProfilePath, { force: true });
  }
}

// Per-case outcome key that must be IDENTICAL across the two bare runs:
// outcome + reason category + tokens. Timestamps/attempt internals are
// excluded (they legitimately differ between runs).
function outcomeKey(state: any): string {
  return JSON.stringify(
    state.cases.map((c: any) => ({
      id: c.id,
      outcome: c.outcome,
      reason: c.reason?.category ?? null,
      tokens: c.spend?.tokens_observed ?? 0,
    })),
  );
}

// Load the manifest once (both describes share it).
const tier2Records = loadManifest(tier2Manifest);
const realIds = new Set(
  tier2Records.filter((r) => r.context?.execution_mode === "real").map((r) => r.id),
);
const scriptedIds = new Set(
  tier2Records.filter((r) => r.context?.execution_mode === "scripted").map((r) => r.id),
);

describe("US-016 Tier-2 zero-token proof", () => {
  it("AC1: bare --tier2 exits 0 GREEN twice with identical per-case outcomes and zero tokens",
    { timeout: 30 * 60 * 1000 }, async () => {
      assert.equal(tier2Records.length, EXPECTED_TOTAL_CASES, "tier2.jsonl must keep 70 cases");
      assert.equal(realIds.size, EXPECTED_REAL_CASES, "tier2.jsonl must keep 45 real cases");
      assert.equal(scriptedIds.size, EXPECTED_SCRIPTED_CASES, "tier2.jsonl must keep 25 scripted cells");
      assert.equal(realIds.size + scriptedIds.size, tier2Records.length,
        "every tier2 case must be exactly one of real/scripted");

      const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
      assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
      await assertPortsFree(SCRIPTED_PORTS);
      const realListenersBefore = await listenerSnapshot(CONTAINED_REAL_PORTS);
      for (const port of CONTAINED_REAL_PORTS) {
        assert.ok(!realListenersBefore.has(port),
          `contained real-daemon port ${port} must be free before the bare tier2 gate`);
      }
      const before = gitSnapshot();

      backupHostProfile();
      const campaignDirs: string[] = [];
      try {
        const validation = run(controller, ["--manifest", tier2Manifest, "--validate-only"]);
        assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
        assert.match(validation.stdout, /Validated 70 case\(s\)/);

        const outcomes: string[] = [];
        for (let runNumber = 1; runNumber <= 2; runNumber += 1) {
          const result = await runStreaming(launcher, ["--tier2"]);
          assert.equal(result.status, 0,
            `bare --tier2 run ${runNumber} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
          const campaignMatch = CAMPAIGN_LINE.exec(result.stdout);
          assert.ok(campaignMatch,
            `bare --tier2 run ${runNumber} did not print a campaign ID:\n${result.stdout}`);
          const campaignDir = path.join(resultsRoot, campaignMatch[1]);
          campaignDirs.push(campaignDir);
          const reportPath = path.join(campaignDir, "report.json");
          const statePath = path.join(campaignDir, "state.json");
          for (const retained of [reportPath, path.join(campaignDir, "report.txt"), statePath]) {
            assert.ok(fs.existsSync(retained), `run ${runNumber}: missing retained result ${retained}`);
          }
          const report = loadJson(reportPath);
          const state = loadJson(statePath);
          outcomes.push(outcomeKey(state));

          // Bare --tier2 is GREEN exit 0 with zero tokens (campaign + state).
          assert.equal(report.verdict, "GREEN", `run ${runNumber}: verdict=${report.verdict}`);
          assert.equal(report.exit_code, 0, `run ${runNumber}: exit_code=${report.exit_code}`);
          assert.equal(report.spend.tokens_observed, 0, `run ${runNumber}: report tokens`);
          assert.equal(state.spend.tokens_observed, 0, `run ${runNumber}: state tokens`);

          // Every real case: NOT_RUN pending-real (never predicate-blocked,
          // never infra), listed in pending_real, zero attempts, zero tokens.
          const pendingRealIds = new Set(report.pending_real.map((item: any) => item.id));
          assert.equal(report.pending_real.length, EXPECTED_REAL_CASES,
            `run ${runNumber}: pending_real must list all ${EXPECTED_REAL_CASES} real cases`);
          for (const id of realIds) {
            const row = report.rows.find((item: any) => item.id === id);
            const caseState = state.cases.find((item: any) => item.id === id);
            assert.ok(row, `run ${runNumber}: report missing real case ${id}`);
            assert.equal(row.outcome, "NOT_RUN", `run ${runNumber}: ${id} outcome=${row.outcome}`);
            assert.equal(row.reason?.category, "pending-real",
              `run ${runNumber}: ${id} must be pending-real, got ${row.reason?.category}`);
            assert.ok(pendingRealIds.has(id), `run ${runNumber}: ${id} not listed in pending_real`);
            assert.equal(row.tokens_observed, 0, `run ${runNumber}: ${id} spent tokens`);
            assert.deepEqual(caseState?.attempts, [], `run ${runNumber}: ${id} unexpectedly launched an attempt`);
          }
          // No real case may be NOT_RUN(predicate) or NOT_RUN(daemon-control-unavailable).
          assert.equal(
            report.not_run.filter((item: any) => realIds.has(item.id)).length, 0,
            `run ${runNumber}: real cases wrongly categorized as NOT_RUN(predicate)/infra`);

          // Every scripted cell: PASS (it ran) or honest NOT_RUN(predicate)
          // (it gated). Under the minus-node-sqlite profile the observed arm
          // is NOT_RUN(predicate) with evidence — never an infra failure,
          // never a silent skip, and never pending-real.
          for (const id of scriptedIds) {
            const row = report.rows.find((item: any) => item.id === id);
            const caseState = state.cases.find((item: any) => item.id === id);
            assert.ok(row, `run ${runNumber}: report missing scripted case ${id}`);
            assert.ok(
              row.outcome === "PASS" ||
              (row.outcome === "NOT_RUN" && row.reason?.category === "predicate"),
              `run ${runNumber}: scripted ${id} unexpected outcome ${row.outcome}/${row.reason?.category} ` +
              `(must be PASS or honest NOT_RUN(predicate))`);
            assert.equal(row.tokens_observed, 0, `run ${runNumber}: scripted ${id} spent tokens`);
            assert.deepEqual(caseState?.attempts ?? [], [],
              `run ${runNumber}: scripted ${id} must not have launched under the gating profile`);
          }
          for (const row of report.rows) {
            assert.equal(row.tokens_observed, 0, `run ${runNumber}: ${row.id} spent tokens`);
          }

          // Operator-identity hygiene canary UNCHANGED (AC4 campaign half).
          const canary = report.hygiene_canary;
          assert.ok(canary, `run ${runNumber}: report missing hygiene_canary`);
          assert.equal(canary.home, os.userInfo().homedir,
            `run ${runNumber}: hygiene canary must inspect the real operator home`);
          const watched = (canary.files ?? []) as Array<{ name: string; status: string }>;
          assert.ok(watched.some((f) => f.name === "gitconfig"), "gitconfig not watched");
          assert.ok(watched.some((f) => f.name === "ssh_config"), "ssh_config not watched");
          for (const file of watched) {
            assert.ok(["UNCHANGED", "ABSENT"].includes(file.status),
              `run ${runNumber}: ${file.name} hygiene status=${file.status}`);
          }
          assert.deepEqual(canary.diffs ?? [], [], `run ${runNumber}: hygiene canary recorded diffs`);

          // The bare gate never starts the contained REAL daemon (43xx) nor
          // touches the live 33xx listeners.
          assert.deepEqual(await listenerSnapshot(CONTAINED_REAL_PORTS), realListenersBefore,
            `run ${runNumber}: bare gate changed the 43xx listener set`);
        }

        // Idempotency: the two bare runs report IDENTICAL per-case outcomes.
        assert.equal(outcomes[0], outcomes[1],
          "bare --tier2 runs must produce identical per-case outcomes");

        // Hygiene: scripted daemon cleanly stopped, scripted ports free, tree
        // unchanged.
        const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
        assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
        assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m);
        await assertPortsFree(SCRIPTED_PORTS);
        assert.equal(gitSnapshot(), before, "bare --tier2 proof changed git status");
      } finally {
        restoreHostProfile();
        for (const dir of campaignDirs) fs.rmSync(dir, { recursive: true, force: true });
      }
    });

  it("AC2: TT_DRY_RUN_REAL_LAUNCH over cases/tier2.jsonl records argv for the first real W4 case and a dsh-lane case, zero tokens",
    { timeout: 30 * 60 * 1000 }, () => {
      // The controller resolves the manifest against its cwd, so the dry-run
      // runs with cwd = ttRoot and the manifest path relative to it (the
      // tier0-dry-run-argv-recording pattern).
      const outPath = path.join(varRoot, `us016-dryrun-${Date.now()}-${process.pid}.jsonl`);
      fs.rmSync(outPath, { force: true });

      backupHostProfile();
      let res: CommandResult | null = null;
      let campaignId: string | null = null;
      let campaignDir: string | null = null;
      try {
        const spawned = spawnSync(process.execPath, [controller, "--manifest", "cases/tier2.jsonl"], {
          cwd: ttRoot,
          env: { ...blockedRealEnv, TT_DRY_RUN_REAL_LAUNCH: outPath },
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: 20 * 60_000,
        });
        res = {
          status: spawned.status,
          stdout: String(spawned.stdout ?? ""),
          stderr: String(spawned.stderr ?? ""),
        };
        const campaignMatch = CAMPAIGN_LINE.exec(res.stdout);
        campaignId = campaignMatch === null ? null : campaignMatch[1];
        if (campaignId !== null) campaignDir = path.join(resultsRoot, campaignId);
      } finally {
        restoreHostProfile();
      }

      assert.ok(campaignId, `dry-run campaign must exist:\n${res?.stdout}\n${res?.stderr}`);
      assert.equal(res?.status, 0, `dry-run campaign must exit 0:\n${res?.stdout}\n${res?.stderr}`);

      // AC2: argv records for EVERY real case — including the FIRST real W4
      // case (--pi-as-harness) and one dsh-lane case (--dsh-as-harness).
      assert.ok(fs.existsSync(outPath), `argv-recording file was not written: ${outPath}`);
      const records = fs
        .readFileSync(outPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      const byId = new Map(records.map((r) => [r.case_id, r]));
      assert.equal(byId.size, EXPECTED_REAL_CASES,
        `one argv record per real case (${EXPECTED_REAL_CASES}), got ${byId.size}`);

      const w401 = byId.get(FIRST_REAL_W4);
      assert.ok(w401, `${FIRST_REAL_W4} argv must be recorded`);
      assert.equal(w401.harness, "pi");
      assert.equal(w401.workflow, "bug-fix-merge-worktree");
      assert.equal(w401.executable, "tamandua");
      assert.ok(Array.isArray(w401.argv) && w401.argv.includes("bug-fix-merge-worktree"),
        "argv must include the workflow");
      const taskIdx = w401.argv.indexOf("--task-file");
      assert.ok(taskIdx >= 0, "argv must include --task-file");
      assert.equal(w401.argv[taskIdx + 1], "cases/tasks/tier2/W4.01-missing-evidence-reroute.md",
        "argv must include the task path");
      const testCmdIdx = w401.argv.indexOf("--context");
      assert.ok(testCmdIdx >= 0 && w401.argv[testCmdIdx + 1] === "test_cmd=npm test",
        "argv must pass the manifest test_cmd through as --context test_cmd=npm test");
      assert.ok(w401.argv.includes("--pi-as-harness"),
        "argv must include the scheduler's pi harness flag");
      const woIdx = w401.argv.indexOf("--worktree-origin-repository");
      assert.ok(woIdx >= 0, "worktree workflow argv must include --worktree-origin-repository");
      assert.match(w401.argv[woIdx + 1], /\/tt-ts$/, "argv fixture path must name the fixture");
      assert.ok(w401.argv.includes("--wait") && w401.argv.includes("--json"),
        "argv must include the scheduler args --wait --json");
      assert.equal(w401.work_clone?.existed, true, "dry-run argv record must lstat the provisioned clone");

      const dsh = byId.get(DSH_LANE_CASE);
      assert.ok(dsh, `${DSH_LANE_CASE} argv must be recorded`);
      assert.equal(dsh.harness, "dsh");
      assert.equal(dsh.workflow, "do-now");
      assert.ok(Array.isArray(dsh.argv) && dsh.argv.includes("do-now"), "argv must include the workflow");
      assert.ok(dsh.argv.includes("--dsh-as-harness"),
        "argv must include the scheduler's dsh harness flag (never a silent pi/hermes substitution)");
      assert.ok(!dsh.argv.includes("--pi-as-harness") && !dsh.argv.includes("--hermes-as-harness"),
        "dsh argv must not carry a pi/hermes harness flag");
      const wdIdx = dsh.argv.indexOf("--working-directory-for-harness");
      assert.ok(wdIdx >= 0, "non-worktree workflow argv must include --working-directory-for-harness");
      assert.match(dsh.argv[wdIdx + 1], /\/tt-ts$/, "dsh fixture path must name the fixture");
      assert.ok(dsh.argv.includes("--wait") && dsh.argv.includes("--json"),
        "dsh argv must include --wait --json");

      // Zero tokens: every real case PASS via the dry-run marker, scripted
      // cells honestly NOT_RUN(predicate), per-case + campaign tokens 0.
      assert.ok(campaignDir !== null && fs.existsSync(path.join(campaignDir, "state.json")),
        `campaign state missing: ${campaignDir}`);
      const state = loadJson(path.join(campaignDir, "state.json"));
      assert.equal(state.spend.tokens_observed, 0, "dry-run campaign must spend zero tokens");
      for (const caseState of state.cases) {
        if (realIds.has(caseState.id)) {
          assert.equal(caseState.outcome, "PASS", `${caseState.id}: dry-run case must be PASS`);
          assert.ok(caseState.attempts.length >= 1, `${caseState.id}: must have a recorded attempt`);
          const dry = caseState.attempts.find((a: any) => a.dry_run_launch === true);
          assert.ok(dry, `${caseState.id}: attempt must carry the dry_run_launch marker`);
          assert.ok(Array.isArray(dry.dry_run_argv) && dry.dry_run_argv.includes("workflow"),
            `${caseState.id}: attempt must persist the recorded argv`);
        } else {
          assert.equal(caseState.outcome, "NOT_RUN", `${caseState.id}: scripted must gate NOT_RUN`);
          assert.equal(caseState.reason?.category, "predicate",
            `${caseState.id}: scripted must gate NOT_RUN(predicate), got ${caseState.reason?.category}`);
        }
        assert.equal(caseState.spend?.tokens_observed ?? 0, 0,
          `${caseState.id}: per-case tokens must be 0`);
      }

      fs.rmSync(outPath, { force: true });
      if (campaignDir !== null) fs.rmSync(campaignDir, { recursive: true, force: true });
    });

  it("AC3: bare --tier1 still exits 0 GREEN (no regression), zero tokens",
    { timeout: 30 * 60 * 1000 }, async () => {
      backupHostProfile();
      let campaignDir: string | null = null;
      try {
        const result = await runStreaming(launcher, ["--tier1"]);
        assert.equal(result.status, 0,
          `bare --tier1 no-regression failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
        const campaignMatch = CAMPAIGN_LINE.exec(result.stdout);
        assert.ok(campaignMatch, `bare --tier1 did not print a campaign ID:\n${result.stdout}`);
        campaignDir = path.join(resultsRoot, campaignMatch[1]);
        const report = loadJson(path.join(campaignDir, "report.json"));
        const state = loadJson(path.join(campaignDir, "state.json"));
        assert.equal(report.verdict, "GREEN", `tier1 verdict=${report.verdict}`);
        assert.equal(report.exit_code, 0, `tier1 exit_code=${report.exit_code}`);
        assert.equal(report.spend.tokens_observed, 0, "tier1 campaign must spend zero tokens");
        assert.equal(state.spend.tokens_observed, 0, "tier1 state must spend zero tokens");
        // The tier1 bare contract under the synthesized profile: real cases
        // pending-real, scripted cells honestly NOT_RUN(predicate) — the same
        // shape as the tier2 proof (the tier1 full-scripted-PASS arm is
        // proven by tier1-repeatability with the real host profile).
        const tier1 = loadManifest(tier1Manifest);
        const t1Real = tier1.filter((r) => r.context?.execution_mode === "real");
        const t1Scripted = tier1.filter((r) => r.context?.execution_mode === "scripted");
        assert.ok(t1Real.length > 0 && t1Scripted.length > 0, "tier1 manifest must have real + scripted cases");
        for (const id of t1Real.map((r) => r.id)) {
          const row = report.rows.find((item: any) => item.id === id);
          assert.ok(row, `tier1 report missing real case ${id}`);
          assert.equal(row.reason?.category, "pending-real",
            `tier1 ${id} must be pending-real, got ${row.reason?.category}`);
          assert.equal(row.tokens_observed, 0, `tier1 ${id} spent tokens`);
        }
        for (const id of t1Scripted.map((r) => r.id)) {
          const row = report.rows.find((item: any) => item.id === id);
          assert.ok(row, `tier1 report missing scripted case ${id}`);
          assert.ok(row.outcome === "PASS" ||
            (row.outcome === "NOT_RUN" && row.reason?.category === "predicate"),
            `tier1 scripted ${id} unexpected outcome ${row.outcome}/${row.reason?.category}`);
          assert.equal(row.tokens_observed, 0, `tier1 scripted ${id} spent tokens`);
        }
        const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
        assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
        assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m);
        await assertPortsFree(SCRIPTED_PORTS);
      } finally {
        restoreHostProfile();
        if (campaignDir !== null) fs.rmSync(campaignDir, { recursive: true, force: true });
      }
    });

  it("AC4: bin/tt-hygiene-canary.mjs is byte-identical to the merge-base version", () => {
    const canary = path.join(binDir, "tt-hygiene-canary.mjs");
    const base = (() => {
      const main = run("git", ["merge-base", "HEAD", "main"], process.env);
      if (main.status === 0 && main.stdout.trim()) return main.stdout.trim();
      const origin = run("git", ["merge-base", "HEAD", "origin/main"], process.env);
      if (origin.status === 0 && origin.stdout.trim()) return origin.stdout.trim();
      throw new Error(`cannot resolve branch base: ${main.stderr || "main and origin/main both unavailable"}`);
    })();
    const result = run("git", ["show", `${base}:torture-test/bin/tt-hygiene-canary.mjs`], process.env);
    assert.equal(result.status, 0, `cannot read base canary: ${result.stderr}`);
    const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
    assert.equal(sha(fs.readFileSync(canary)), sha(Buffer.from(result.stdout, "utf8")),
      "tt-hygiene-canary.mjs drifted from the merge-base version — the canary must remain untouched");
  });
});
