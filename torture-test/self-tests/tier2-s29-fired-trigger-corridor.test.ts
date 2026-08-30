// S29 (US-002) — zero-token SCRIPTED FIRED-TRIGGER CORRIDOR.
//
// The tier-2 attempt-2 campaign (campaign-20260826T225744158Z-4bf26d7f) left
// W4.10-restart-recovery, W4.33a-daemon-restart-resume and
// W4.33b-update-under-it-resume TEST_INFRA_FAIL 'probe-trigger-unreached':
// each probe armed on `step:developer:running` — a trigger that can NEVER
// fire on bug-fix-merge-worktree (bfmw), which has NO developer step/agent.
// US-002 calibrates the manifest to `step:fixer:running` (the bfmw coding
// step's agent role; the controller's probeStepMarkerSatisfied matches
// `step_id = ? OR agent_id LIKE %<role>%`, so `fixer` matches the
// bug-fix-merge-worktree_fixer row). THIS file is the zero-token PROOF that a
// probe armed on the CALIBRATED trigger genuinely FIRES against the 53xx
// scripted daemon driving a real bfmw run, and that the armed action
// EXECUTES with recorded probe evidence — the exact corridor the three cells
// will run in the next real campaign.
//
// How the proof works (all zero tokens, following the E3.C US-011
// tier1-scripted-probe-battery.test.ts pattern):
//   1. Build scripted manifest copies under gitignored var/: take
//      W4.33b-update-under-it-resume (pause + resume) and
//      W4.10-restart-recovery (two-run restart_daemon) from
//      cases/tier2.jsonl — the CALIBRATED manifest — and convert them to
//      harness scripted-pi with context.execution_mode 'scripted' and
//      SHORTENED hold_seconds (600 -> 5) so the corridor stays fast. The
//      probe_sequence (ops, when, expect) is KEPT as calibrated; only the
//      hold length is shortened (same adaptation the tier-1 battery makes).
//   2. Drive each through tt-controller against the 53xx scripted daemon
//      (daemon-control scripted start with TAMANDUA_PI_BINARY /
//      TAMANDUA_HERMES_BINARY -> the scripted runtimes via
//      tt-env-scripted.sh, plus TAMANDUA_SCRIPTED_BEHAVIORS -> a full-pipeline
//      bfmw behaviors file that drives triage -> investigate -> setup -> fix
//      -> verify -> merge to a real squash-merge landing). The fixer sleeps
//      SLOW_SLEEP_SECONDS so the `step:fixer:running` marker has a wide
//      window to fire; concurrent runs create per-worktree-unique bugfix
//      branches (the W3.22 battery's pattern) so two in-flight runs never
//      collide on a shared branch ref.
//   3. Assert per case: the probe actions EXECUTED with probe_evidence
//      present (W4.33b: pause armed on step:fixer:running -> run paused ->
//      resume -> run completes; W4.10-restart-recovery: the daemon restarted
//      once mid-flight via daemon-control and both concurrent runs recovered
//      within 2 dispatch intervals with the token flush preserved), O16
//      verdict emitted, zero tokens observed.
//   4. Hygiene: scripted daemon stopped, 53xx ports free, git tree clean.
//
// Confined to torture-test/ (state under gitignored var/). Zero tokens.
// HEAVY CAMPAIGN TEST — registered in the run.sh HEAVY_CAMPAIGN_TESTS /
// verify-heavy-campaign-tests.test.sh / e2e-golden-integrity lock-step lists.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const controller = path.join(binDir, "tt-controller");
const daemonControl = path.join(binDir, "daemon-control");
const tier2Manifest = path.join(ttRoot, "cases", "tier2.jsonl");
const scriptedHome = path.join(varRoot, "home-scripted");
const scriptedStateDir = path.join(scriptedHome, ".tamandua");
const workRoot = path.join(varRoot, "us002-s29-fired-trigger-corridor");

const SCRIPTED_PORTS = [5334, 5338, 5339];
const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;

// The two S29 calibration cells the corridor proves (as calibrated by US-002
// in cases/tier2.jsonl): the pause/resume lifecycle cell and the two-run
// restart_daemon cell. Both arm their probes on `step:fixer:running`.
const CORRIDOR_CASES = [
  "W4.33b-update-under-it-resume",
  "W4.10-restart-recovery",
];

// Shortened holds: the real manifest declares 600s (10m) holds; the scripted
// corridor proves the SAME machinery with a few-second hold so the test stays
// fast. The fixer behavior sleeps SLOW_SLEEP_SECONDS so the calibrated marker
// (step:fixer:running) has a wide window to fire against the real scripted
// daemon.
const HOLD_SECONDS = 5;
const SLOW_SLEEP_SECONDS = 25;

type CommandResult = { status: number | null; stdout: string; stderr: string };

// node:test marks descendant processes; the corridor drives the scripted
// daemon on the fixed TT ports under the gitignored TT home, so disable only
// the live-state guard and drop NODE_TEST_CONTEXT (mirrors
// tier1-repeatability / tier1-scripted-probe-battery). PATH is prepended with
// the repo bin so 'tamandua' (launch hooks + the merger's merge-branch)
// resolves to THIS checkout's binary.
function corridorEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    TAMANDUA_TEST_GUARD: "0",
    PATH: `${path.join(repoRoot, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
}

function run(file: string, args: string[], env = process.env, timeout = 1200_000): CommandResult {
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

// ── Copy-transform: tier2.jsonl -> scripted corridor manifest ──────────
// The CALIBRATED manifest is read verbatim; only the harness, execution
// mode, oracle set and hold length are adapted for the scripted fixture (the
// tier-1 battery's exact adaptation). The probe_sequence's `when` triggers
// are NOT touched — they carry the US-002-calibrated `step:fixer:running`.
function transformRecord(record: any): any {
  const out = JSON.parse(JSON.stringify(record));
  out.harness = "scripted-pi";
  out.context = { ...(out.context ?? {}), execution_mode: "scripted" };
  // Real-host capability predicates are irrelevant to the scripted runtimes
  // (they would gate the cases NOT_RUN on a --fast host profile).
  if (Array.isArray(out.requires?.capabilities)) {
    out.requires = {
      ...(out.requires ?? {}),
      capabilities: out.requires.capabilities.filter((cap: string) => cap !== "hermes" && cap !== "pi"),
    };
    if (out.requires.capabilities.length === 0) delete out.requires.capabilities;
  }
  // Focused oracle set: O16 is the lifecycle probe-evidence oracle (PASS on
  // the probe-sequence cases) — same focused set the tier-1 battery uses.
  out.oracles = ["O16"];
  // Shorten hold-capable probe actions (pause / pause_drain).
  for (const group of out.probe_sequence ?? []) {
    for (const action of group.actions ?? []) {
      if (typeof action.hold_seconds === "number") action.hold_seconds = HOLD_SECONDS;
    }
  }
  return out;
}

function buildScriptedManifest(): string {
  const records: any[] = [];
  for (const line of fs.readFileSync(tier2Manifest, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line) as any;
    if (!CORRIDOR_CASES.includes(record.id)) continue;
    records.push(transformRecord(record));
  }
  assert.equal(records.length, CORRIDOR_CASES.length, "corridor manifest must contain both S29 calibration cells");
  // The calibrated trigger must be present in the corridor copies — this is
  // the very defect being proved fixed (step:developer:running would never
  // fire on bfmw). Only the arming `step:` markers are calibrated; a `now`
  // trigger (the fire-immediately resume marker) must stay untouched.
  for (const record of records) {
    for (const group of record.probe_sequence ?? []) {
      for (const action of group.actions ?? []) {
        assert.notEqual(action.when, "step:developer:running",
          `${record.id}: corridor probe must not carry the wrong-vocabulary trigger`);
        if (typeof action.when === "string" && action.when.startsWith("step:")) {
          assert.equal(action.when, "step:fixer:running",
            `${record.id}: corridor probe must carry the US-002-calibrated trigger step:fixer:running`);
        }
      }
    }
  }
  fs.mkdirSync(workRoot, { recursive: true });
  const outPath = path.join(workRoot, "manifest.jsonl");
  fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return outPath;
}

// ── Full-pipeline scripted behaviors (bug-fix-merge-worktree) ──────────
// Drives triage -> investigate -> setup -> fix -> verify -> finalize_merge
// to a REAL squash-merge landing on the scripted fixture. The fixer sleeps
// SLOW_SLEEP_SECONDS so the calibrated step:fixer:running marker fires
// mid-round. Concurrent runs (W4.10-restart-recovery's two runs) create
// per-worktree-UNIQUE bugfix branches (the W3.22 battery's pattern: the
// branch name embeds `basename "{{cwd}}"`, which differs per worktree) so
// two in-flight runs never collide on a shared branch ref in the common
// origin. Zero tokens.
function writeBehaviors(): string {
  const behaviorsPath = path.join(workRoot, "behaviors.json");
  const cli = path.join(repoRoot, "bin", "tamandua");
  const behaviors = {
    agents: {
      triager: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          "BRANCH: fix/s29-scripted-probe",
          "SEVERITY: high",
          "AFFECTED_AREA: src/value.txt",
          "REPRODUCTION: fixture carries the stale value",
          "PROBLEM_STATEMENT: exercise the calibrated S29 probe corridor",
        ].join("\n"),
      },
      investigator: {
        output: [
          "STATUS: done",
          "ROOT_CAUSE: fixture value is stale",
          "FIX_APPROACH: replace the stale value with the fixed value",
        ].join("\n"),
      },
      setup: {
        // The bfmw harness pre-seeds ORIGINAL_BRANCH (the worktree starts
        // detached). Create a per-worktree-unique bugfix branch so concurrent
        // runs in the same origin never collide on a branch ref.
        commands: ["git checkout -b \"fix/s29-$(basename \"{{cwd}}\")\""],
        output: [
          "STATUS: done",
          "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
          "BUILD_CMD: npm run build",
          "TEST_CMD: npm test",
          "BASELINE: scripted baseline green",
        ].join("\n"),
      },
      fixer: {
        writes: [{ file: "probe-marker.txt", content: "s29 scripted probe marker\n" }],
        commands: [
          `sleep ${SLOW_SLEEP_SECONDS}`,
          "git add probe-marker.txt",
          "git commit -m 'fix: scripted s29 probe change'",
        ],
        output: [
          "STATUS: done",
          "CHANGES: scripted s29 probe change",
          "REGRESSION_TEST: scripted s29 corridor regression",
        ].join("\n"),
      },
      verifier: {
        output: [
          "STATUS: done",
          "VERIFIED: scripted s29 corridor verified",
          "TESTED_TREE: {{gitTree}}",
        ].join("\n"),
      },
      merger: {
        commands: [
          "expected_tip=$(git -C \"{{input.WORKTREE_ORIGIN_REPOSITORY}}\" rev-parse \"refs/heads/{{input.ORIGINAL_BRANCH}}\") && "
            + `TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${cli}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" `
            + "--branch \"fix/s29-$(basename \"{{cwd}}\")\" --into \"{{input.ORIGINAL_BRANCH}}\" "
            + "--expect-tip \"$expected_tip\" --message \"fix: scripted s29 probe merge\"",
        ],
        includeCommandOutput: true,
        output: [
          "STATUS: done",
          "REBASED: false",
          "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
          "MERGED_TREE: {{input.TESTED_TREE}}",
        ].join("\n"),
      },
    },
    heartbeatTokens: 0,
    defaultTokens: 0,
  };
  fs.writeFileSync(behaviorsPath, `${JSON.stringify(behaviors, null, 2)}\n`, "utf8");
  return behaviorsPath;
}

// ── Scripted-home + daemon lifecycle (containment-guarded) ─────────────

function installWorkflowIntoScriptedCatalog(): void {
  const result = run("bash", ["-c", "source torture-test/env/tt-env-scripted.sh && exec bin/tamandua workflow install bug-fix-merge-worktree"], corridorEnv(), 300_000);
  assert.equal(result.status, 0, `workflow install failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes("Installed workflow: bug-fix-merge-worktree"),
    `workflow install did not report success:\n${result.stdout}`);
}

// ── Per-case assertions ────────────────────────────────────────────────

function assertOracleVerdict(caseState: any, expectedResult: string): void {
  const oracles = caseState.oracle_results ?? [];
  const o16 = oracles.find((item: any) => item.oracle_id === "O16");
  assert.ok(o16, `${caseState.id}: O16 oracle result must be present`);
  assert.equal(o16.status, "VALID", `${caseState.id}: O16 must run (VALID), got ${o16.status}`);
  assert.equal(o16.response.result, expectedResult,
    `${caseState.id}: O16 verdict must be ${expectedResult}, got ${o16.response.result}: ${JSON.stringify(o16.response.findings ?? [])}`);
}

function assertCaseEvidence(state: any, report: any, caseId: string, checker: (cs: any) => void): void {
  const cs = state.cases.find((c: any) => c.id === caseId);
  assert.ok(cs, `${caseId}: must appear in campaign state`);
  checker(cs);
  assert.equal(cs.spend?.tokens_observed ?? 0, 0, `${caseId}: case spend must be zero`);
  assert.equal(report.spend.tokens_observed, 0, "campaign report spend must be zero");
}

describe("S29 (US-002) — zero-token fired-trigger corridor on the calibrated trigger", () => {
  it("a probe armed on step:fixer:running FIRES against the 53xx scripted bfmw daemon and executes pause / restart_daemon with recorded probe evidence, zero tokens",
    { timeout: 60 * 60 * 1000 }, async () => {
      // Hygiene: no lingering scripted daemon, ports free, tree clean.
      const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
      assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
      await assertPortsFree();
      const before = gitSnapshot();

      // Build the scripted manifest copy + behaviors under gitignored var/.
      const manifestPath = buildScriptedManifest();
      const behaviorsPath = writeBehaviors();

      // Fresh scripted home: wipe the contained state so the current product
      // binary recreates the DB schema (a stale schema from an older binary
      // breaks `workflow run`).
      fs.rmSync(scriptedStateDir, { recursive: true, force: true });
      fs.mkdirSync(scriptedStateDir, { recursive: true });
      // Contained git identity for the scripted worktrees (the operator's
      // global ~/.gitconfig must NEVER be used — HOME is the scripted home).
      fs.writeFileSync(path.join(scriptedHome, ".gitconfig"),
        "[user]\n\tname = TT S29 Corridor\n\temail = tt-s29@tamandua.invalid\n[commit]\n\tgpgsign = false\n", "utf8");
      installWorkflowIntoScriptedCatalog();

      // Start the 53xx scripted daemon with the behaviors + state env (the
      // daemon forwards TAMANDUA_SCRIPTED_BEHAVIORS/STATE to every spawned
      // scripted runtime; the controller also forwards them through
      // loadSpawnEnvironment for the daemon-control restart path).
      const behaviorsEnv: NodeJS.ProcessEnv = {
        ...corridorEnv(),
        TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
        TAMANDUA_SCRIPTED_STATE: path.join(workRoot, "scripted-state"),
      };
      fs.rmSync(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, { recursive: true, force: true });
      fs.mkdirSync(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, { recursive: true });
      const start = run(daemonControl, ["scripted", "start"], behaviorsEnv, 120_000);
      assert.equal(start.status, 0, `scripted daemon start failed:\n${start.stdout}\n${start.stderr}`);

      let campaignId: string | null = null;
      try {
        // Drive the controller against the scripted daemon (zero tokens —
        // the scripted runtimes are the harness binaries; tt-env-scripted.sh
        // pins them).
        const result = await runStreaming(controller, ["--manifest", manifestPath], behaviorsEnv);
        const m = CAMPAIGN_LINE.exec(result.stdout);
        campaignId = m === null ? null : m[1];
        assert.ok(campaignId, `campaign did not print an ID:\n${result.stdout}\n${result.stderr}`);
        // Both cells must PASS — the calibrated trigger fired and the probe
        // actions executed with evidence (GREEN campaign).
        assert.equal(result.status, 0, `fired-trigger corridor campaign must be GREEN:\n${result.stdout}\n${result.stderr}`);

        const campaignDir = path.join(resultsRoot, campaignId);
        const report = loadJson(path.join(campaignDir, "report.json"));
        const state = loadJson(path.join(campaignDir, "state.json"));
        assert.equal(report.verdict, "GREEN", `corridor campaign verdict must be GREEN: ${report.verdict}`);
        assert.equal(report.exit_code, 0);

        // ── W4.33b-update-under-it-resume: pause armed on the CALIBRATED
        //    step:fixer:running -> run paused (hold) -> resume -> run
        //    completes. The probe action EXECUTED with evidence. ──
        assertCaseEvidence(state, report, "W4.33b-update-under-it-resume", (cs) => {
          assert.equal(cs.outcome, "PASS", `W4.33b: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          assert.equal(attempt.terminal_status, "completed");
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W4.33b: probe_evidence must be present");
          assert.equal(pe.sequence_outcome, "completed");
          assert.equal(pe.actions.length, 2);
          assert.equal(pe.actions[0].op, "pause");
          assert.equal(pe.actions[0].trigger, "step:fixer:running",
            "W4.33b: the pause must arm on the CALIBRATED trigger (US-002) — the campaign's step:developer:running never fired");
          assert.equal(pe.actions[0].ok, true, `W4.33b: pause must succeed: ${JSON.stringify(pe.actions[0].failure ?? null)}`);
          assert.equal(pe.actions[0].hold_seconds, HOLD_SECONDS);
          assert.equal(pe.actions[0].effect?.status_after?.status, "paused");
          assert.equal(pe.actions[1].op, "resume");
          assert.equal(pe.actions[1].ok, true, `W4.33b: resume must succeed: ${JSON.stringify(pe.actions[1].failure ?? null)}`);
          assert.equal(pe.actions[1].effect?.status_after?.status, "running");
          assertOracleVerdict(cs, "PASS");
        });

        // ── W4.10-restart-recovery: TWO concurrent runs; the restart_daemon
        //    probe armed on the CALIBRATED step:fixer:running fires ONCE
        //    mid-flight via daemon-control scripted restart; both runs
        //    recover within 2 dispatch intervals with the token flush
        //    preserved and complete. ──
        assertCaseEvidence(state, report, "W4.10-restart-recovery", (cs) => {
          assert.equal(cs.outcome, "PASS", `W4.10: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W4.10: probe_evidence must be present");
          assert.ok(Array.isArray(pe.runs) && pe.runs.length === 2, "W4.10: two run groups must be recorded");
          for (const runRecord of pe.runs) {
            assert.equal(runRecord.terminal_status, "completed", `W4.10 run ${runRecord.run_ordinal}: must complete after recovery`);
            assert.ok(runRecord.recovery, `W4.10 run ${runRecord.run_ordinal}: recovery observation must be recorded`);
            assert.equal(runRecord.recovery.recovered, true, `W4.10 run ${runRecord.run_ordinal}: must recover`);
            assert.equal(runRecord.recovery.recovery_within_dispatch_intervals, true,
              `W4.10 run ${runRecord.run_ordinal}: recovery must be within the dispatch-interval window`);
            assert.equal(runRecord.recovery.token_flush_preserved, true,
              `W4.10 run ${runRecord.run_ordinal}: token flush must be preserved`);
            const restartAction = runRecord.actions.find((a: any) => a.op === "restart_daemon");
            assert.ok(restartAction, `W4.10 run ${runRecord.run_ordinal}: restart_daemon action must be recorded`);
            assert.equal(restartAction.trigger, "step:fixer:running",
              "W4.10: the restart must arm on the CALIBRATED trigger (US-002) — the campaign's step:developer:running never fired");
          }
          assert.ok(Array.isArray(pe.daemon_restarts) && pe.daemon_restarts.length === 1,
            "W4.10: exactly one daemon restart must be executed");
          assert.equal(pe.daemon_restarts[0].op, "restart_daemon");
          assert.equal(pe.daemon_restarts[0].trigger, "step:fixer:running");
          assert.equal(pe.daemon_restarts[0].kind, "scripted", "W4.10: restart must target the 53xx scripted daemon");
          assert.equal(pe.daemon_restarts[0].exit_code, 0, "W4.10: daemon-control scripted restart must exit 0");
          assert.equal(pe.daemon_restarts[0].recovery.length, 2, "W4.10: per-run recovery observations must ride the restart record");
          assertOracleVerdict(cs, "PASS");
        });

        // ── Zero tokens: campaign-wide + every case, and the scripted
        //    runtime journal shows zero-token invocations. ──
        assert.equal(state.spend.tokens_observed, 0, "state spend must be zero");
        const invocationLog = path.join(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, "invocations.jsonl");
        assert.ok(fs.existsSync(invocationLog), "scripted runtime journal must exist (proves the scripted runtimes executed the runs)");
        const invocationText = fs.readFileSync(invocationLog, "utf8");
        assert.ok(invocationText.split(/\r?\n/).length > 5, "scripted journal must show many work rounds");
        for (const line of invocationText.split(/\r?\n/)) {
          if (line.trim() === "") continue;
          const entry = JSON.parse(line);
          if (typeof entry.totalTokens === "number") {
            assert.equal(entry.totalTokens, 0, "scripted runtime journal must show zero tokens per invocation");
          }
          if (typeof entry.tokens === "number") {
            assert.equal(entry.tokens, 0, "scripted runtime journal must show zero tokens per invocation");
          }
        }

        // ── Hygiene: scripted daemon stops cleanly, ports free, tree clean. ──
        const stop = run(daemonControl, ["scripted", "stop"], process.env);
        assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
        const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
        assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
        assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m,
          "scripted daemon must be cleanly stopped after the corridor");
        await assertPortsFree();
        assert.equal(gitSnapshot(), before, "fired-trigger corridor changed git status");
      } finally {
        run(daemonControl, ["scripted", "stop"], process.env);
        if (campaignId !== null) {
          fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
        }
        fs.rmSync(workRoot, { recursive: true, force: true });
      }
    });
});
