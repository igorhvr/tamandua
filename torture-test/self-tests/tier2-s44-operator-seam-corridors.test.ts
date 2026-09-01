// S44b (US-010) — OPERATOR-SEAM CELL CORRIDORS (zero tokens, contained
// scripted daemons/homes). HEAVY CAMPAIGN TEST — registered in run.sh
// HEAVY_CAMPAIGN_TESTS / verify-heavy-campaign-tests.test.sh /
// e2e-golden-integrity.test.ts, isolated with its own ceiling like
// tier2-s29-fired-trigger-corridor.
//
// The five operator-seam cells' premises name mid-run operator actions that
// no machinery performed (campaign-20260826T225744158Z left them vacuous or
// stalled; the S32-37 US-003 stall diagnosis — lifecycle-log proof of no
// daemon.start until sweep teardown). US-009 (S44a) built the first-class
// probe ops; US-010 (this file) proves each cell's WIRED action provably
// fires at its DECLARED TRIGGER against the contained 53xx scripted daemon
// and its evidence record lands in the attempt evidence:
//
//   * W4.10-kill-daemon / W4.48a-daemon-kill-mid-park — the typed
//     kill-daemon chaos SIGKILLs the contained daemon and the
//     restart_contained_daemon probe (armed on the SAME step trigger)
//     restarts it via daemon-control; the contained run RECOVERS and
//     completes after the restart (the kill-daemon-then-restart shape).
//   * W4.33a-daemon-restart-resume — restart_contained_daemon declared
//     during_hold fires INSIDE the pause_drain hold window
//     ([hold_started_at, hold_ended_at]); the paused run continues cleanly
//     after the restart and completes (O16 PASS).
//   * W4.33b-update-under-it-resume — update_contained_install declared
//     during_hold runs `tamandua update --force` against the CONTAINED
//     install inside the pause hold (argv + contained catalog stamp
//     before/after evidence); the resumed run completes (O16 PASS).
//   * W4.47-auth-expiry-copy — invalidate_credentials fires at launch
//     (contained home .pi/agent/auth.json replaced, backup created), the
//     do-now's first round fails with a diagnosable provider error (the
//     invalidated launch — a provider-error instant-fail, so no step event
//     is emitted), restore_credentials fires on event:step.running (the
//     retried round's dispatch — the relaunch; byte-identical restore) and
//     the retried round completes.
//
// Mechanics follow the E3.C US-011 tier1-scripted-probe-battery /
// tier2-s29-fired-trigger-corridor pattern: the CALIBRATED manifest rows are
// copied verbatim (only harness -> scripted-pi, execution_mode -> scripted,
// oracle set -> ["O16"], hold_seconds shortened, and the capabilities
// predicates dropped), the scripted runtimes drive full bfmw / do-now runs,
// and the assertions read the campaign's state.json / report.json +
// probe-evidence + chaos.log. Zero tokens.
//
// Confined to torture-test/ (state under gitignored var/). Zero tokens.
// NOTE: the shared scripted-daemon ports (5334/5338/5339) are contended
// across worktrees — a concurrent campaign in another worktree holding them
// makes daemon-control refuse with "no provenance record for scripted"
// (the documented US-009/US-010 contention class, not a corridor defect).
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
const workRoot = path.join(varRoot, "s44b-operator-seam-corridor");

const SCRIPTED_PORTS = [5334, 5338, 5339];
const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;

// The five operator-seam cells whose wired actions this corridor proves.
const CORRIDOR_CASES = [
  "W4.10-kill-daemon",
  "W4.48a-daemon-kill-mid-park",
  "W4.33a-daemon-restart-resume",
  "W4.33b-update-under-it-resume",
  "W4.47-auth-expiry-copy",
];

// Shortened holds: the real manifest declares 600s holds; the corridor
// proves the SAME machinery with a shorter hold so the test stays fast.
// Timing constraints (measured against the contained scripted daemon):
//   * the W4.33a restart-during-hold restarts a LIVE (paused) daemon — the
//     daemon-control restart takes ~18s (graceful stop port poll +
//     escalation + start) and its stop phase KILLS the daemon ~18s into the
//     hold, taking any in-flight fixer round with it (worker_lost);
//   * W4.33a's pause_drain only flips the run to paused when a step
//     COMPLETES (finalizeDrainingPause runs on step-completion paths only —
//     NOT on worker_lost recovery), so the fixer round MUST complete BEFORE
//     the restart's stop kills the daemon (~18s into the hold). A short
//     fixer sleep (5s) makes the round finish at ~8s — the drain finalizes
//     to paused while the daemon is still alive, the restarted daemon
//     re-reads the paused state, and the resume at the hold end works.
//   * the fixer/marker windows stay wide enough for the 500ms probe/chaos
//     polls (a 5s round = ~10 polls).
const HOLD_SECONDS = 35;
// The fixer behavior sleeps SLOW_SLEEP_SECONDS so the calibrated
// step:fixer:running marker has a window to fire. SHORT (5s): the round must
// complete before the W4.33a restart's stop kills the daemon (~18s into the
// hold) so the drain finalizes to paused before the daemon dies; the W4.10
// kill-daemon cells recover via worker_lost re-dispatch regardless.
const SLOW_SLEEP_SECONDS = 5;

type CommandResult = { status: number | null; stdout: string; stderr: string };

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
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

function loadJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertPortsFree(): Promise<void> {
  return new Promise((resolve, reject) => {
    let remaining = SCRIPTED_PORTS.length;
    let failed = false;
    for (const port of SCRIPTED_PORTS) {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        failed = true;
        remaining -= 1;
        if (remaining === 0) reject(new Error(`port ${port} is still in use`));
      });
      socket.once("error", () => {
        remaining -= 1;
        if (remaining === 0) resolve();
      });
    }
    if (failed) reject(new Error("scripted ports still in use"));
  });
}

function gitSnapshot(): string {
  const res = run("git", ["status", "--porcelain"], process.env, 30_000);
  assert.equal(res.status, 0, `git status failed:\n${res.stdout}${res.stderr}`);
  return res.stdout;
}

// ── Copy-transform: tier2.jsonl -> scripted corridor manifest ──────────
// The CALIBRATED manifest rows are read verbatim; only the harness,
// execution mode, oracle set and hold length are adapted for the scripted
// fixture (the tier-1 battery's exact adaptation). The probe_sequence's
// `when` triggers are NOT touched — they carry the wired S44b declarations.
function transformRecord(record: any): any {
  const out = JSON.parse(JSON.stringify(record));
  out.harness = "scripted-pi";
  out.context = { ...(out.context ?? {}), execution_mode: "scripted" };
  if (Array.isArray(out.requires?.capabilities)) {
    out.requires = {
      ...(out.requires ?? {}),
      capabilities: out.requires.capabilities.filter((cap: string) => cap !== "hermes" && cap !== "pi"),
    };
    if (out.requires.capabilities.length === 0) delete out.requires.capabilities;
  }
  // Focused oracle set: O16 is the lifecycle probe-evidence oracle — it
  // evaluates ONLY sequences with lifecycle ops (pause/pause_drain/resume/
  // cancel/fail_force/restart_daemon), so the W4.33a/W4.33b pause+resume
  // cells keep ["O16"] (PASS). The kill/restart + credential cells
  // (W4.10/W4.48a/W4.47) have no lifecycle op — O16 would render
  // NOT_EVALUABLE, which the oracle runner REJECTS (exit 3: 'result must be
  // PASS, FAIL, or ERROR') — so those cells carry NO oracles and PASS from
  // the completed terminal status.
  const lifecycleProbeCells = new Set([
    "W4.33a-daemon-restart-resume",
    "W4.33b-update-under-it-resume",
  ]);
  out.oracles = lifecycleProbeCells.has(record.id) ? ["O16"] : [];
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
  assert.equal(records.length, CORRIDOR_CASES.length, "corridor manifest must contain all five operator-seam cells");
  fs.mkdirSync(workRoot, { recursive: true });
  const outPath = path.join(workRoot, "manifest.jsonl");
  fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return outPath;
}

// ── Full-pipeline scripted behaviors (bfmw + do-now) ──────────────────
// bfmw: triage -> investigate -> setup -> fix -> verify -> finalize_merge to
// a REAL squash-merge landing on the scripted fixture (the s29 corridor
// shape; the merger physically lands via merge-branch so the origin target
// ref genuinely moves). The fixer sleeps SLOW_SLEEP_SECONDS so the
// step:fixer:running marker fires mid-round AND the fixer round survives the
// daemon death (survivor guard) and completes after the restart. do-now: the
// doer's FIRST invocation emits a 429 provider error (the invalidated
// round — the product recovers it as step.worker_lost) and the SECOND
// invocation succeeds (the restored round). Zero tokens.
function writeBehaviors(): string {
  const behaviorsPath = path.join(workRoot, "behaviors.json");
  const cli = path.join(repoRoot, "bin", "tamandua");
  const behaviors = {
    agents: {
      triager: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          "BRANCH: fix/s44-scripted-probe",
          "SEVERITY: high",
          "AFFECTED_AREA: src/value.txt",
          "REPRODUCTION: fixture carries the stale value",
          "PROBLEM_STATEMENT: exercise the S44b operator-seam corridor",
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
        commands: ["git checkout -b \"fix/s44-$(basename \"{{cwd}}\")\""],
        output: [
          "STATUS: done",
          "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
          "BUILD_CMD: npm run build",
          "TEST_CMD: npm test",
          "BASELINE: scripted baseline green",
        ].join("\n"),
      },
      fixer: {
        writes: [{ file: "probe-marker.txt", content: "s44b scripted probe marker\n" }],
        commands: [
          `sleep ${SLOW_SLEEP_SECONDS}`,
          "git add probe-marker.txt",
          "git commit -m 'fix: scripted s44b probe change'",
        ],
        output: [
          "STATUS: done",
          "CHANGES: scripted s44b probe change",
          "REGRESSION_TEST: scripted s44b corridor regression",
        ].join("\n"),
      },
      verifier: {
        output: [
          "STATUS: done",
          "VERIFIED: scripted s44b corridor verified",
          "TESTED_TREE: {{gitTree}}",
        ].join("\n"),
      },
      merger: {
        commands: [
          // Sleep FIRST so the finalize_merge step stays 'running' for a
          // wide window — the W4.48a kill-daemon chaos + restart probe arm
          // on step:finalize_merge:running, and an un-slept merger round
          // completes in ~300ms (merge-branch on the tiny fixture), which
          // the 500ms probe/chaos poll can miss entirely (the campaign
          // refusal: 'run already terminal (completed) before trigger').
          "sleep 12",
          "expected_tip=$(git -C \"{{input.WORKTREE_ORIGIN_REPOSITORY}}\" rev-parse \"refs/heads/{{input.ORIGINAL_BRANCH}}\") && "
            + `TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${cli}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" `
            + "--branch \"fix/s44-$(basename \"{{cwd}}\")\" --into \"{{input.ORIGINAL_BRANCH}}\" "
            + "--expect-tip \"$expected_tip\" --message \"fix: scripted s44b probe merge\"",
        ],
        includeCommandOutput: true,
        output: [
          "STATUS: done",
          "REBASED: false",
          "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
          "MERGED_TREE: {{input.TESTED_TREE}}",
        ].join("\n"),
      },
      // do-now: first invocation = the invalidated round (provider error);
      // second invocation = the restored round (success). The behavior
      // ARRAY is consumed per work invocation (last entry repeats).
      doer: [
        { provider_error: { shape: "429" } },
        {
          output: [
            "STATUS: done",
            "REPORT: scripted s44b do-now completed after the credential restore",
          ].join("\n"),
        },
      ],
    },
    heartbeatTokens: 0,
    defaultTokens: 0,
  };
  fs.writeFileSync(behaviorsPath, `${JSON.stringify(behaviors, null, 2)}\n`, "utf8");
  return behaviorsPath;
}

// ── Contained tamandua wrapper (the W4.33b update target) ─────────────
// update_contained_install resolves the `tamandua` binary from the contained
// PATH and REQUIRES it to resolve strictly inside torture-test/var (an
// uncontained binary — the operator's live checkout — is refused). The
// corridor plants a wrapper at var/<workRoot-dir>/contained-bin/tamandua
// that (a) simulates `tamandua update --force` against the CONTAINED
// catalog stamp (the observed effect) and (b) passthroughs EVERYTHING else
// to the REAL bin/tamandua (so the workflow-run launch, daemon internals,
// merge-branch, daemon-control's own tamandua invocations keep working).
function writeContainedTamanduaWrapper(): string {
  const containedBin = path.join(workRoot, "contained-bin");
  fs.mkdirSync(containedBin, { recursive: true });
  const wrapper = path.join(containedBin, "tamandua");
  const realCli = path.join(repoRoot, "bin", "tamandua");
  fs.writeFileSync(wrapper, [
    "#!/usr/bin/env bash",
    "# S44b corridor contained-tamandua wrapper: simulate `update --force`",
    "# against the CONTAINED catalog stamp; passthrough everything else to",
    "# the real tamandua (the launch/daemon/merge paths must keep working).",
    "set -u",
    `REAL_TAMANDUA=${JSON.stringify(realCli)}`,
    'if [ "${1:-}" = "update" ] && [ "${2:-}" = "--force" ]; then',
    '  STAMP="${TAMANDUA_STATE_DIR:-$HOME/.tamandua}/workflows/.catalog-version.json"',
    '  mkdir -p "$(dirname "$STAMP")"',
    '  printf \'{"version":"s44b-corridor-updated","sourcePath":"%s","installedAt":"%s"}\\n\' "$PWD" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$STAMP"',
    "  exit 0",
    "fi",
    'exec "$REAL_TAMANDUA" "$@"',
    "",
  ].join("\n"), { mode: 0o755 });
  return containedBin;
}

// Seed the CONTAINED home's pi credential copy (the W4.47 target). The
// invalidate/restore actions operate on $HOME/.pi/agent/auth.json under the
// contained home — never the real ~/.pi. A STALE invalidate backup from a
// previous corridor run (auth.json.tt-invalidated) is removed first — a
// pending backup makes the next invalidate fail closed
// (prior-invalidate-pending), which is exactly the stale-state trap the
// corridor must not inherit.
function seedContainedAuth(): void {
  const authDir = path.join(scriptedHome, ".pi", "agent");
  fs.mkdirSync(authDir, { recursive: true });
  const authFile = path.join(authDir, "auth.json");
  fs.rmSync(`${authFile}.tt-invalidated`, { force: true });
  fs.writeFileSync(authFile, JSON.stringify({ deepseek: { type: "api_key", key: "s44b-contained-original-key" } }, null, 2) + "\n", { mode: 0o600 });
}

function installWorkflowIntoScriptedCatalog(workflowId: string): void {
  const result = run("bash", ["-c", `source torture-test/env/tt-env-scripted.sh && exec bin/tamandua workflow install ${workflowId}`], corridorEnv(), 300_000);
  assert.equal(result.status, 0, `workflow install ${workflowId} failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes(`Installed workflow: ${workflowId}`),
    `workflow install ${workflowId} did not report success:\n${result.stdout}`);
}

// ── Per-case assertions ────────────────────────────────────────────────

function caseState(state: Record<string, any>, caseId: string): Record<string, any> {
  const cs = state.cases.find((c: any) => c.id === caseId);
  assert.ok(cs, `${caseId}: must appear in campaign state`);
  return cs;
}

function assertZeroTokens(state: Record<string, any>, report: Record<string, any>): void {
  assert.equal(state.spend.tokens_observed, 0, "state spend must be zero");
  assert.equal(report.spend.tokens_observed, 0, "campaign report spend must be zero");
}

function assertChaosFired(attempt: Record<string, any>, caseId: string): void {
  const chaos = attempt.chaos_evidence;
  assert.ok(chaos, `${caseId}: chaos_evidence must be present (the kill must fire)`);
  assert.equal(chaos.status, "completed", `${caseId}: chaos evidence must be completed: ${JSON.stringify(chaos)}`);
  assert.equal(chaos.injection_type, "kill-daemon", `${caseId}: the injection must be kill-daemon`);
  assert.equal(chaos.target, "daemon_process", `${caseId}: the kill target must be the daemon process`);
  assert.equal(chaos.exit_code, 0, `${caseId}: tt-chaos must exit 0: ${JSON.stringify(chaos.failure ?? null)}`);
}

function assertRestartAction(action: Record<string, any>, expectedTrigger: string, caseId: string): void {
  assert.equal(action.op, "restart_contained_daemon", `${caseId}: the action must be restart_contained_daemon`);
  assert.equal(action.trigger, expectedTrigger, `${caseId}: the restart must arm on the declared trigger ${expectedTrigger}`);
  assert.equal(action.kind, "scripted", `${caseId}: the restart must target the 53xx scripted daemon (kind scripted)`);
  assert.equal(action.exit_code, 0, `${caseId}: daemon-control scripted restart must exit 0: ${JSON.stringify(action.failure ?? null)}`);
  assert.ok(action.provenance, `${caseId}: the restart must record daemon provenance`);
  assert.ok(action.path_invariant && action.path_invariant.ok === true,
    `${caseId}: the adapters-bin PATH invariant must be re-asserted: ${JSON.stringify(action.path_invariant)}`);
  assert.ok(action.effect, `${caseId}: the restart must record an observed effect`);
}

describe("S44b (US-010) — operator-seam cell corridors against the contained scripted daemon", () => {
  it("the wired operator-seam actions provably fire at their declared triggers and the contained runs recover (kill-daemon-then-restart, act-during-hold, invalidate/restore), zero tokens",
    { timeout: 90 * 60 * 1000 }, async () => {
      // Hygiene: no lingering scripted daemon, ports free, tree clean.
      const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
      assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
      await assertPortsFree();
      const before = gitSnapshot();

      // Build the scripted manifest copy + behaviors + contained wrapper +
      // contained credential copy under gitignored var/.
      const manifestPath = buildScriptedManifest();
      const behaviorsPath = writeBehaviors();
      const containedBin = writeContainedTamanduaWrapper();
      seedContainedAuth();

      // Fresh scripted home: wipe the contained state so the current product
      // binary recreates the DB schema.
      fs.rmSync(scriptedStateDir, { recursive: true, force: true });
      fs.mkdirSync(scriptedStateDir, { recursive: true });
      fs.writeFileSync(path.join(scriptedHome, ".gitconfig"),
        "[user]\n\tname = TT S44b Corridor\n\temail = tt-s44b@tamandua.invalid\n[commit]\n\tgpgsign = false\n", "utf8");
      installWorkflowIntoScriptedCatalog("bug-fix-merge-worktree");
      installWorkflowIntoScriptedCatalog("do-now");

      // The contained tamandua wrapper must be FIRST on the contained PATH
      // so update_contained_install resolves it (inside var) while every
      // other tamandua invocation passthroughs to the real binary.
      const behaviorsEnv: NodeJS.ProcessEnv = {
        ...corridorEnv(),
        PATH: `${containedBin}:${corridorEnv().PATH}`,
        TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
        TAMANDUA_SCRIPTED_STATE: path.join(workRoot, "scripted-state"),
      };
      fs.rmSync(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, { recursive: true, force: true });
      fs.mkdirSync(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, { recursive: true });
      const start = run(daemonControl, ["scripted", "start"], behaviorsEnv, 120_000);
      assert.equal(start.status, 0, `scripted daemon start failed:\n${start.stdout}\n${start.stderr}`);

      let campaignId: string | null = null;
      try {
        const result = await runStreaming(controller, ["--manifest", manifestPath], behaviorsEnv);
        const m = CAMPAIGN_LINE.exec(result.stdout);
        campaignId = m === null ? null : m[1];
        assert.ok(campaignId, `campaign did not print an ID:\n${result.stdout}\n${result.stderr}`);
        // All five cells must PASS — the wired actions fired and the runs
        // recovered (GREEN campaign).
        assert.equal(result.status, 0, `operator-seam corridor campaign must be GREEN:\n${result.stdout}\n${result.stderr}`);

        const campaignDir = path.join(resultsRoot, campaignId);
        const report = loadJson(path.join(campaignDir, "report.json"));
        const state = loadJson(path.join(campaignDir, "state.json"));
        assert.equal(report.verdict, "GREEN", `corridor campaign verdict must be GREEN: ${report.verdict}`);
        assert.equal(report.exit_code, 0);
        assertZeroTokens(state, report);

        // ── W4.10-kill-daemon: kill-daemon chaos fires at step:fixer:running,
        //    restart_contained_daemon (same trigger) restarts the contained
        //    daemon, and the run RECOVERS and completes. ──
        {
          const cs = caseState(state, "W4.10-kill-daemon");
          assert.equal(cs.outcome, "PASS", `W4.10: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          assert.equal(attempt.terminal_status, "completed", "W4.10: the run must complete after the restart");
          assertChaosFired(attempt, "W4.10");
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W4.10: probe_evidence must be present");
          assert.equal(pe.sequence_outcome, "completed");
          assert.equal(pe.actions.length, 1);
          assertRestartAction(pe.actions[0], "step:fixer:running", "W4.10");
        }

        // ── W4.48a-daemon-kill-mid-park: kill at step:finalize_merge:running,
        //    restart on the same trigger, PARK crash-safety run completes. ──
        {
          const cs = caseState(state, "W4.48a-daemon-kill-mid-park");
          assert.equal(cs.outcome, "PASS", `W4.48a: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          assert.equal(attempt.terminal_status, "completed", "W4.48a: the run must complete after the restart");
          assertChaosFired(attempt, "W4.48a");
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W4.48a: probe_evidence must be present");
          assert.equal(pe.sequence_outcome, "completed");
          assert.equal(pe.actions.length, 1);
          assertRestartAction(pe.actions[0], "step:finalize_merge:running", "W4.48a");
        }

        // ── W4.33a-daemon-restart-resume: restart_contained_daemon declared
        //    during_hold fires INSIDE the pause_drain hold window; the paused
        //    run continues cleanly after the restart and completes (O16). ──
        {
          const cs = caseState(state, "W4.33a-daemon-restart-resume");
          assert.equal(cs.outcome, "PASS", `W4.33a: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          assert.equal(attempt.terminal_status, "completed", "W4.33a: the run must complete");
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W4.33a: probe_evidence must be present");
          assert.equal(pe.sequence_outcome, "completed");
          assert.equal(pe.actions.length, 3, "W4.33a: pause_drain -> restart_contained_daemon(during_hold) -> resume");
          const [pause, restart, resume] = pe.actions;
          assert.equal(pause.op, "pause_drain");
          assert.equal(pause.hold_seconds, HOLD_SECONDS);
          assert.ok(pause.hold_started_at && pause.hold_ended_at, "W4.33a: the holder must carry a COMPLETED hold record");
          assert.equal(restart.op, "restart_contained_daemon");
          assert.equal(restart.during_hold, true, "W4.33a: the restart must declare during_hold");
          assertRestartAction(restart, "now", "W4.33a");
          const holdStart = new Date(pause.hold_started_at).valueOf();
          const holdEnd = new Date(pause.hold_ended_at).valueOf();
          const restartStart = new Date(restart.action_started_at).valueOf();
          assert.ok(restartStart >= holdStart && restartStart <= holdEnd,
            `W4.33a: the restart must fire DURING the pause hold: restart ${restartStart} outside [${holdStart}, ${holdEnd}]`);
          assert.equal(resume.op, "resume");
          assert.ok(new Date(resume.action_started_at).valueOf() >= holdEnd,
            "W4.33a: the resume must fire after the hold ends");
          assertOracleVerdict(cs, "PASS");
        }

        // ── W4.33b-update-under-it-resume: update_contained_install declared
        //    during_hold runs `tamandua update --force` against the CONTAINED
        //    install inside the pause hold (argv + catalog stamp before/after
        //    evidence); the resumed run completes (O16). ──
        {
          const cs = caseState(state, "W4.33b-update-under-it-resume");
          assert.equal(cs.outcome, "PASS", `W4.33b: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          assert.equal(attempt.terminal_status, "completed", "W4.33b: the run must complete");
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W4.33b: probe_evidence must be present");
          assert.equal(pe.sequence_outcome, "completed");
          assert.equal(pe.actions.length, 3, "W4.33b: pause -> update_contained_install(during_hold) -> resume");
          const [pause, update, resume] = pe.actions;
          assert.equal(pause.op, "pause");
          assert.equal(pause.hold_seconds, HOLD_SECONDS);
          assert.ok(pause.hold_started_at && pause.hold_ended_at, "W4.33b: the holder must carry a COMPLETED hold record");
          assert.equal(update.op, "update_contained_install");
          assert.equal(update.during_hold, true, "W4.33b: the update must declare during_hold");
          assert.equal(update.exit_code, 0, `W4.33b: the contained update must exit 0: ${JSON.stringify(update.failure ?? null)}`);
          assert.deepEqual(update.argv, ["tamandua", "update", "--force"], "W4.33b: the update must invoke ['tamandua','update','--force']");
          assert.ok(update.binary_path && update.binary_path.startsWith(varRoot),
            `W4.33b: the update binary must resolve inside torture-test/var (contained): ${update.binary_path}`);
          assert.ok(update.catalog_version_before && update.catalog_version_after,
            "W4.33b: the contained catalog stamp must be recorded before/after");
          assert.notDeepEqual(update.catalog_version_before, update.catalog_version_after,
            "W4.33b: the contained catalog stamp must CHANGE (the update's observed effect)");
          const holdStart = new Date(pause.hold_started_at).valueOf();
          const holdEnd = new Date(pause.hold_ended_at).valueOf();
          const updateStart = new Date(update.action_started_at).valueOf();
          assert.ok(updateStart >= holdStart && updateStart <= holdEnd,
            `W4.33b: the update must fire DURING the pause hold: update ${updateStart} outside [${holdStart}, ${holdEnd}]`);
          assert.equal(resume.op, "resume");
          assertOracleVerdict(cs, "PASS");
        }

        // ── W4.47-auth-expiry-copy: invalidate_credentials fires at launch
        //    (contained auth.json replaced + backup), the do-now's first
        //    round fails with a diagnosable provider error (the scripted
        //    runtime's provider_error shape — the invalidated launch),
        //    restore_credentials fires on event:step.running (the retried
        //    round's dispatch — the relaunch; byte-identical restore) and the
        //    retried round completes. ──
        {
          const cs = caseState(state, "W4.47-auth-expiry-copy");
          assert.equal(cs.outcome, "PASS", `W4.47: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          assert.equal(attempt.terminal_status, "completed", "W4.47: the restored run must complete");
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W4.47: probe_evidence must be present");
          assert.equal(pe.sequence_outcome, "completed");
          assert.equal(pe.actions.length, 2, "W4.47: invalidate_credentials -> restore_credentials");
          const [invalidate, restore] = pe.actions;
          const authFile = path.join(scriptedHome, ".pi", "agent", "auth.json");
          assert.equal(invalidate.op, "invalidate_credentials");
          assert.equal(invalidate.trigger, "now");
          assert.equal(invalidate.target_path, authFile, "W4.47: the invalidate must target the CONTAINED auth.json");
          assert.equal(invalidate.backup_path, `${authFile}.tt-invalidated`);
          assert.ok(invalidate.target_sha256_before && invalidate.target_sha256_after,
            "W4.47: the invalidate must record sha256 before/after");
          assert.notEqual(invalidate.target_sha256_before, invalidate.target_sha256_after,
            "W4.47: the invalidate must change the contained auth.json bytes");
          assert.equal(invalidate.effect?.backup_created, true);
          assert.equal(restore.op, "restore_credentials");
          assert.equal(restore.trigger, "event:step.running",
            "W4.47: the restore must arm on event:step.running (the retried round's dispatch — the relaunch)");
          assert.equal(restore.effect?.restored, true);
          assert.equal(restore.effect?.backup_removed, true);
          assert.equal(restore.target_sha256_after, invalidate.target_sha256_before,
            "W4.47: the restore must return the auth.json to its pre-invalidate bytes (byte-identical)");
          assert.equal(fs.existsSync(`${authFile}.tt-invalidated`), false,
            "W4.47: the invalidate backup must be consumed by the restore");
          const finalBytes = fs.readFileSync(authFile, "utf8");
          assert.ok(finalBytes.includes("s44b-contained-original-key"),
            "W4.47: the contained auth.json must hold the original credential after the restore");

          // The invalidated round's diagnosable provider/auth error (the
          // "invalidated launch fails with a diagnosable auth error"
          // premise): the scripted runtime's invocation journal records the
          // provider_error shape for the doer. (The provider-error round is
          // an instant-fail — it exits before claiming, so the run's event
          // stream carries NO step.worker_lost; the retry is silent.)
          const invocationLog = path.join(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, "invocations.jsonl");
          assert.ok(fs.existsSync(invocationLog), "W4.47: the scripted runtime journal must exist");
          const invocationText = fs.readFileSync(invocationLog, "utf8");
          const providerErrors = invocationText.split(/\r?\n/).filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line))
            .filter((entry) => String(entry.note ?? "").includes("provider_error shape=429"));
          assert.ok(providerErrors.length >= 1,
            "W4.47: the scripted runtime journal must record the invalidated round's diagnosable provider error (provider_error shape=429)");
          const doerRounds = invocationText.split(/\r?\n/).filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line))
            .filter((entry) => String(entry.agentId ?? "").endsWith("_doer"));
          assert.ok(doerRounds.length >= 2,
            "W4.47: the doer must be invoked at least twice (the invalidated round + the restored round)");
        }

        // ── Zero tokens: campaign-wide + the scripted runtime journal. ──
        const invocationLog = path.join(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, "invocations.jsonl");
        assert.ok(fs.existsSync(invocationLog), "scripted runtime journal must exist (proves the scripted runtimes executed the runs)");
        const invocationText = fs.readFileSync(invocationLog, "utf8");
        assert.ok(invocationText.split(/\r?\n/).length > 10, "scripted journal must show many work rounds");
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
        assert.equal(gitSnapshot(), before, "operator-seam corridor changed git status");
      } finally {
        run(daemonControl, ["scripted", "stop"], process.env);
        if (campaignId !== null) {
          // Best-effort teardown: the controller's own teardown prunes
          // PASSed clones; nothing further to do here.
        }
      }
    });
});

function assertOracleVerdict(caseStateItem: Record<string, any>, expectedResult: string): void {
  const oracles = caseStateItem.oracle_results ?? [];
  const o16 = oracles.find((item: any) => item.oracle_id === "O16");
  assert.ok(o16, `${caseStateItem.id}: O16 oracle result must be present`);
  assert.equal(o16.status, "VALID", `${caseStateItem.id}: O16 must run (VALID), got ${o16.status}`);
  assert.equal(o16.response.result, expectedResult,
    `${caseStateItem.id}: O16 verdict must be ${expectedResult}, got ${o16.response.result}: ${JSON.stringify(o16.response.findings ?? [])}`);
}
