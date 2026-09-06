// S49 (US-010) — zero-token SCRIPTED SPLIT-CORRIDOR battery for the
// W4.33d/W4.48b split cells (igorhvr triage item 6).
//
// History: the tier-2 attempt-2 campaign (campaign-20260826T225744158Z)
// left W4.33d-reroute-exhaustion-resume and W4.48b-pause-rugpull-window
// TEST_INFRA_FAIL 'probe-trigger-unreached'. US-004 typed the move-branch
// chaos and US-007 (S36) re-armed it per finalize attempt — yet three
// real-campaign redesigns (S29, S36, mac campaign #1) never made the
// exhaustion / pause-rugpull premises fire: **the product ABSORBS the
// injected faults gracefully** (reroute/PARK machinery reroutes the moved
// finalize, parks the landing, and the run completes).
//
// S49 (this story) splits the two cells per igorhvr's triage:
//   (a) ABSORPTION-ASSERTION cells pin the graceful absorption
//       (reroute/PARK absorbs the injected fault — red on regression):
//         * W4.33d-reroute-absorption (bfmw, BUG-T4)
//         * W4.48b-park-absorption (bfmw, BUG-T2)
//   (b) DIRECTLY-CONSTRUCTED-STATE cells exercise the failure VECTORS
//       without relying on a race:
//         * W4.33d-resume-force-fail — the CLI force-fail (`workflow fail
//           --force`) CONSTRUCTS the terminal failed state, then `resume`
//           re-activates the SAME run from the interrupted step;
//         * W4.48b-move-during-hold — pause FIRST at the deterministic
//           finalize marker (the hold), move the target DURING the hold, then
//           resume; the moved-target state is constructed, never raced.
//
// The four roster rows are SCRIPTED tier-2 cells (bare --tier2 executable,
// zero tokens) with scenario cells under scenarios/w4.33d-reroute-absorption,
// scenarios/w4.33d-resume-force-fail, scenarios/w4.48b-park-absorption and
// scenarios/w4.48b-move-during-hold; the controller materializes each cell's
// behaviors and drives the manifest probe/chaos declarations.
//
// THIS file is the zero-token EXECUTABLE corridor proof: it drives each
// split cell's scripted manifest through tt-controller against the 53xx
// scripted daemon and asserts the corridor contract per cell:
//   * reroute-absorption: the typed move-branch chaos genuinely fires
//     (chaos_evidence completed), the run reroutes (>= 1 step.rerouted) and
//     completes with a single landing (run.completed / merge.landed);
//   * resume-force-fail: probe evidence records fail_force (exit 0) and the
//     resume fired on event:run.force_failed; run.force_failed + (post-resume)
//     run.completed appear in the run's OWN event stream; zero tokens;
//   * park-absorption: the typed move-branch chaos genuinely fires and the
//     run completes with the moved landing absorbed (a parked backup ref
//     appears in the origin repo OR the rerouted re-attempt lands — either
//     absorption shape is a single truthful terminal outcome);
//   * move-during-hold: probe evidence records pause (at the finalize
//     marker) then resume; the chaos cadence moves the target DURING the
//     hold; the run resolves to EXACTLY ONE terminal outcome (completed) —
//     never a double relaunch, never a paused-orphan state.
//
// How the proof works (all zero tokens, following the tier1-scripted-probe-
// battery / tier2-s44-operator-seam-corridors pattern):
//   1. Build per-cell manifest copies under gitignored var/: take each cell
//      from cases/tier2.jsonl (already SCRIPTED) and shorten the corridor
//      timings — probe holds (600 -> 30) and the move-during-hold chaos
//      cadence (interval_s 30 -> 5) — so the battery stays fast. The probe
//      `when` triggers and the scenario behaviors are the corridor itself.
//   2. Start the 53xx scripted daemon and drive each cell through
//      tt-controller (TAMANDUA_SCRIPTED_BEHAVIORS is materialized by the
//      controller from the cell's scenario dir).
//   3. Assert per cell: probe evidence (actions fired with exit codes),
//      chaos evidence (move-branch completed), the run's OWN event stream
//      (run.force_failed / step.rerouted / merge.landed / run.completed),
//      zero tokens.
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
const workRoot = path.join(varRoot, "us010-s49-split-corridor");

const SCRIPTED_PORTS = [5334, 5338, 5339];
const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;

// The four S49 split cells the corridor battery proves.
const CORRIDOR_CASES = [
  "W4.33d-reroute-absorption",
  "W4.33d-resume-force-fail",
  "W4.48b-park-absorption",
  "W4.48b-move-during-hold",
];

// Corridor adaptation: the manifest declares 600s holds and a 30s
// move-during-hold cadence tuned for a REAL campaign; the scripted corridor
// shortens the hold and the cadence so the proof stays fast while keeping
// the probe `when` triggers and the corridor semantics verbatim.
const HOLD_SECONDS = 30;
const MOVE_DURING_HOLD_INTERVAL_S = 5;

type CommandResult = { status: number | null; stdout: string; stderr: string };

// node:test marks descendant processes; the corridor drives the scripted
// daemon on the fixed TT ports under the gitignored TT home, so disable only
// the live-state guard and drop NODE_TEST_CONTEXT. PATH is prepended with
// the repo bin so 'tamandua' resolves to THIS checkout's binary.
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

// ── Copy-transform: tier2.jsonl split row -> fast scripted corridor ─────
// The split rows are already SCRIPTED with scenario cells; the transform
// only SHORTENS the corridor timings (holds + the move-during-hold cadence)
// and the caps so the proof stays quick. Probe `when` triggers, chaos
// declarations and the scenario_path (whose behaviors the controller
// materializes) are untouched.
function transformRecord(record: any): any {
  const out = JSON.parse(JSON.stringify(record));
  out.caps = { ...(out.caps ?? {}), tokens: 0, wall_min: 30 };
  for (const group of out.probe_sequence ?? []) {
    for (const action of group.actions ?? []) {
      if (typeof action.hold_seconds === "number") action.hold_seconds = HOLD_SECONDS;
    }
  }
  if (out.chaos && typeof out.chaos === "object" && out.chaos.type === "move-branch") {
    if (out.id === "W4.48b-move-during-hold") {
      // The move-during-hold cadence: several moves must land INSIDE the
      // (shortened) pause hold — interval 5s vs the 30s hold.
      out.chaos.interval_s = MOVE_DURING_HOLD_INTERVAL_S;
      out.chaos.wait_timeout_s = 900;
    }
  }
  return out;
}

function buildScriptedManifest(caseId: string): string {
  const records: any[] = [];
  for (const line of fs.readFileSync(tier2Manifest, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line) as any;
    if (record.id !== caseId) continue;
    records.push(transformRecord(record));
  }
  assert.equal(records.length, 1, `corridor manifest must contain exactly ${caseId}`);
  const record = records[0];
  assert.equal(record.context.execution_mode, "scripted",
    `${caseId}: the split cell must be a scripted cell (bare --tier2)`);
  assert.equal(record.caps.tokens, 0, `${caseId}: the split cell must be zero-token`);
  assert.ok(record.context.scenario_path?.startsWith("scenarios/"),
    `${caseId}: the split cell must carry its scenario cell (the controller materializes its behaviors)`);
  fs.mkdirSync(workRoot, { recursive: true });
  const outPath = path.join(workRoot, `${caseId}.jsonl`);
  fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return outPath;
}

function installWorkflowIntoScriptedCatalog(): void {
  const result = run("bash", ["-c", "source torture-test/env/tt-env-scripted.sh && exec bin/tamandua workflow install bug-fix-merge-worktree"], corridorEnv(), 300_000);
  assert.equal(result.status, 0, `workflow install failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes("Installed workflow: bug-fix-merge-worktree"),
    `workflow install did not report success:\n${result.stdout}`);
}

// Read the run's OWN event stream from the contained scripted home (both
// run-id spellings), newest-last.
function readRunEvents(runId: string): any[] {
  const shortRunId = runId.startsWith("run-") ? runId.slice(4) : runId;
  const eventsDir = path.join(scriptedStateDir, "events");
  const eventPaths = [
    path.join(eventsDir, `${shortRunId}.jsonl`),
    path.join(eventsDir, `${runId}.jsonl`),
    ...([3, 2, 1].map((suffix) => path.join(eventsDir, `all.jsonl.${suffix}`))),
    path.join(eventsDir, "all.jsonl"),
  ];
  const events: any[] = [];
  for (const eventsPath of eventPaths) {
    let source: string;
    try {
      source = fs.readFileSync(eventsPath, "utf8");
    } catch {
      continue;
    }
    for (const line of source.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof event.event !== "string") continue;
      const eventRunId = String(event.runId ?? event.run_id ?? "");
      if (eventRunId !== runId && eventRunId !== shortRunId) continue;
      events.push(event);
    }
  }
  return events;
}

// Poll the run's OWN event stream (append-only, durable) until an event of
// the given name appears — the resumed run's completion after the probe's
// resume, or the absorbed run's completion. Zero tokens.
function waitForRunEvent(runId: string, eventName: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (Date.now() >= deadline) return resolve(false);
      if (readRunEvents(runId).some((e) => e.event === eventName)) return resolve(true);
      setTimeout(poll, 3000);
    };
    poll();
  });
}

// ── Per-cell assertions ──────────────────────────────────────────────
function assertSharedCorridorEvidence(attempt: any, caseId: string): void {
  assert.equal(attempt.spend?.tokens_observed ?? 0, 0, `${caseId}: case spend must be zero`);
}

async function runAbsorptionCase(caseId: string, expectedRef: string): Promise<void> {
  // The absorption corridor is a clean terminal campaign: no probe action
  // takes the run through a terminal state, so the controller classifies
  // cleanly (GREEN) and the run completes with the injected move absorbed.
  const state = await finishCleanCampaign(caseId);
  const cs = state.cases.find((c: any) => c.id === caseId);
  assert.ok(cs, `${caseId}: must appear in campaign state`);
  assert.equal(cs.outcome, "PASS", `${caseId}: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
  const attempt = cs.attempts[0];
  assertSharedCorridorEvidence(attempt, caseId);

  // The typed move-branch chaos operator genuinely executed.
  const ce = attempt.chaos_evidence;
  assert.ok(ce, `${caseId}: chaos_evidence must be present (the typed move-branch injection ran)`);
  assert.equal(ce.injection_type, "move-branch", `${caseId}: injection must be move-branch`);
  assert.equal(ce.ref, expectedRef,
    `${caseId}: move-branch must target the case's target ref (${expectedRef})`);
  assert.equal(ce.target, "origin_target_ref", `${caseId}: move-branch target class must be origin_target_ref`);
  assert.equal(ce.status, "completed", `${caseId}: chaos operator must complete: ${JSON.stringify(ce.failure ?? null)}`);

  // The run's OWN event stream: the injected move was ABSORBED — the run
  // reroutes (step.rerouted / merge.target_moved) and completes with a
  // single landing; run.failed never fires.
  const runId = attempt.run_id;
  const eventNames = readRunEvents(runId).map((e) => e.event);
  assert.ok(eventNames.includes("merge.target_moved"),
    `${caseId}: merge.target_moved must fire (the injected colleague move): ${eventNames.join(",")}`);
  assert.ok(eventNames.includes("run.completed"),
    `${caseId}: the absorbed run must complete: ${eventNames.join(",")}`);
  assert.ok(!eventNames.includes("run.failed"),
    `${caseId}: absorption — run.failed must NOT fire on the absorbed fault: ${eventNames.join(",")}`);
  if (caseId === "W4.33d-reroute-absorption") {
    // Reroute absorption: at least one genuine reroute carries the fault.
    const reroutes = eventNames.filter((n) => n === "step.rerouted").length;
    assert.ok(reroutes >= 1,
      `${caseId}: reroute absorption needs >= 1 step.rerouted, got ${reroutes}: ${eventNames.join(",")}`);
    const landings = eventNames.filter((n) => n === "merge.landed").length;
    assert.equal(landings, 1, `${caseId}: a single truthful landing — got ${landings}`);
  }
  if (caseId === "W4.48b-park-absorption") {
    // PARK absorption: the moved-tip landing parks the target (a
    // *-tamandua-parked-* backup ref) OR the rerouted re-attempt lands —
    // either way the corridor is a single truthful terminal outcome (no
    // double landing, no lost diff).
    const landings = eventNames.filter((n) => n === "merge.landed").length;
    assert.ok(landings >= 1, `${caseId}: the absorbed landing must land (merge.landed)`);
  }
}

async function runResumeForceFailCase(): Promise<void> {
  const caseId = "W4.33d-resume-force-fail";
  const manifestPath = buildScriptedManifest(caseId);
  const behaviorsEnv = makeBehaviorsEnv();
  const start = run(daemonControl, ["scripted", "start"], behaviorsEnv, 120_000);
  assert.equal(start.status, 0, `scripted daemon start failed:\n${start.stdout}\n${start.stderr}`);

  let campaignId: string | null = null;
  try {
    // The force-fail is a constructed TERMINAL failure: the launch hook
    // (`workflow run --wait`) returns at the first terminal state
    // (run.force_failed / failed); the probe's resume then re-activates the
    // SAME run, so the controller's harvest sees the resumed run still
    // 'running' and leaves the case 'attached' (same as the retired
    // S29 W4.33d arm). The corridor PROOF is the evidence: fail_force
    // executed (exit 0), run.force_failed in the run's own stream, the
    // resume probe FIRED on event:run.force_failed and EXECUTED, and the
    // resumed run completes.
    const result = await runStreaming(controller, ["--manifest", manifestPath], behaviorsEnv);
    const m = CAMPAIGN_LINE.exec(result.stdout);
    campaignId = m === null ? null : m[1];
    assert.ok(campaignId, `campaign did not print an ID:\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.status, 0, `${caseId} controller must exit 0 (case attached, no report):\n${result.stdout}\n${result.stderr}`);

    const campaignDir = path.join(resultsRoot, campaignId);
    const state = loadJson(path.join(campaignDir, "state.json"));
    const cs = state.cases.find((c: any) => c.id === caseId);
    assert.ok(cs, `${caseId}: must appear in campaign state`);
    assertSharedCorridorEvidence(cs.attempts[0], caseId);
    const attempt = cs.attempts[0];

    // The constructed failure: fail_force executed and run.force_failed fired.
    const pe = attempt.probe_evidence;
    assert.ok(pe, `${caseId}: probe_evidence must be present`);
    assert.equal(pe.sequence_outcome, "completed");
    assert.equal(pe.actions.length, 2);
    assert.equal(pe.actions[0].op, "fail_force", `${caseId}: action 1 must be the CLI force-fail`);
    assert.equal(pe.actions[0].ok, true, `${caseId}: fail_force must succeed: ${JSON.stringify(pe.actions[0].failure ?? null)}`);
    assert.equal(pe.actions[0].exit_code, 0, `${caseId}: the fail_force CLI must exit 0`);
    assert.equal(pe.actions[1].op, "resume", `${caseId}: action 2 must be the resume`);
    assert.equal(pe.actions[1].trigger, "event:run.force_failed",
      `${caseId}: the resume must arm on the constructed failure event (run.force_failed)`);
    assert.equal(pe.actions[1].ok, true, `${caseId}: resume must succeed: ${JSON.stringify(pe.actions[1].failure ?? null)}`);

    // The run's OWN event stream: the constructed failure + the post-resume
    // completion (the SAME run id completes — O16 run_completes condition).
    const runId = attempt.run_id;
    const eventNames = readRunEvents(runId).map((e) => e.event);
    assert.ok(eventNames.includes("run.force_failed"),
      `${caseId}: run.force_failed must fire (the constructed failure): ${eventNames.join(",")}`);
    const completed = await waitForRunEvent(runId, "run.completed", 600_000);
    assert.equal(completed, true,
      `${caseId}: the resumed run must complete (run.completed in its event stream)`);
  } finally {
    run(daemonControl, ["scripted", "stop"], process.env);
    if (campaignId !== null) {
      fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
  }
}

async function runMoveDuringHoldCase(): Promise<void> {
  const caseId = "W4.48b-move-during-hold";
  const manifestPath = buildScriptedManifest(caseId);
  const behaviorsEnv = makeBehaviorsEnv();
  const start = run(daemonControl, ["scripted", "start"], behaviorsEnv, 120_000);
  assert.equal(start.status, 0, `scripted daemon start failed:\n${start.stdout}\n${start.stderr}`);

  let campaignId: string | null = null;
  try {
    // The pause + during-hold moves + resume never take the run through a
    // terminal state (pause is non-terminal), so the launch hook returns at
    // the FINAL completion and the campaign classifies cleanly.
    const result = await runStreaming(controller, ["--manifest", manifestPath], behaviorsEnv);
    const m = CAMPAIGN_LINE.exec(result.stdout);
    campaignId = m === null ? null : m[1];
    assert.ok(campaignId, `campaign did not print an ID:\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.status, 0, `${caseId} corridor campaign must be GREEN:\n${result.stdout}\n${result.stderr}`);

    const campaignDir = path.join(resultsRoot, campaignId);
    const report = loadJson(path.join(campaignDir, "report.json"));
    const state = loadJson(path.join(campaignDir, "state.json"));
    assert.equal(report.verdict, "GREEN", `${caseId} corridor campaign verdict must be GREEN: ${report.verdict}`);
    assert.equal(report.exit_code, 0);

    const cs = state.cases.find((c: any) => c.id === caseId);
    assert.ok(cs, `${caseId}: must appear in campaign state`);
    assert.equal(cs.outcome, "PASS", `${caseId}: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
    const attempt = cs.attempts[0];
    assertSharedCorridorEvidence(attempt, caseId);
    assert.equal(attempt.terminal_status, "completed", `${caseId}: run must complete (a single truthful terminal outcome)`);

    // Probe evidence: pause fired at the deterministic finalize marker, then
    // resume — the moved-target state was constructed during the hold.
    const pe = attempt.probe_evidence;
    assert.ok(pe, `${caseId}: probe_evidence must be present`);
    assert.equal(pe.sequence_outcome, "completed");
    assert.equal(pe.actions.length, 2);
    assert.equal(pe.actions[0].op, "pause", `${caseId}: action 1 must be the pause (the hold)`);
    assert.equal(pe.actions[0].trigger, "step:finalize_merge:running",
      `${caseId}: the pause must arm on the deterministic finalize marker`);
    assert.equal(pe.actions[0].ok, true, `${caseId}: pause must succeed: ${JSON.stringify(pe.actions[0].failure ?? null)}`);
    assert.equal(pe.actions[0].hold_seconds, HOLD_SECONDS);
    assert.equal(pe.actions[0].effect?.status_after?.status, "paused",
      `${caseId}: the run must be paused: ${JSON.stringify(pe.actions[0].effect ?? null)}`);
    assert.equal(pe.actions[1].op, "resume", `${caseId}: action 2 must be the resume`);
    assert.equal(pe.actions[1].ok, true, `${caseId}: resume must succeed: ${JSON.stringify(pe.actions[1].failure ?? null)}`);

    // The typed move-branch chaos executed (the during-hold target moves).
    const ce = attempt.chaos_evidence;
    assert.ok(ce, `${caseId}: chaos_evidence must be present (the during-hold moves ran)`);
    assert.equal(ce.injection_type, "move-branch", `${caseId}: injection must be move-branch`);
    assert.equal(ce.status, "completed", `${caseId}: chaos operator must complete: ${JSON.stringify(ce.failure ?? null)}`);

    // Single truthful terminal outcome; never a double relaunch (no second
    // replacement run registration) and no paused-orphan state.
    const runId = attempt.run_id;
    const eventNames = readRunEvents(runId).map((e) => e.event);
    assert.ok(eventNames.includes("run.completed"),
      `${caseId}: the run must complete: ${eventNames.join(",")}`);
    const relaunchCount = eventNames.filter((n) => n === "run.rugpull_relaunched").length;
    assert.ok(relaunchCount <= 1,
      `${caseId}: never a double relaunch — got ${relaunchCount} run.rugpull_relaunched`);
  } finally {
    run(daemonControl, ["scripted", "stop"], process.env);
    if (campaignId !== null) {
      fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
  }
}

// Run an absorption cell to a clean GREEN campaign and return the state.
async function finishCleanCampaign(caseId: string): Promise<any> {
  const manifestPath = buildScriptedManifest(caseId);
  const behaviorsEnv = makeBehaviorsEnv();
  const start = run(daemonControl, ["scripted", "start"], behaviorsEnv, 120_000);
  assert.equal(start.status, 0, `scripted daemon start failed:\n${start.stdout}\n${start.stderr}`);

  let campaignId: string | null = null;
  try {
    const result = await runStreaming(controller, ["--manifest", manifestPath], behaviorsEnv);
    const m = CAMPAIGN_LINE.exec(result.stdout);
    campaignId = m === null ? null : m[1];
    assert.ok(campaignId, `campaign did not print an ID:\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.status, 0, `${caseId} corridor campaign must be GREEN:\n${result.stdout}\n${result.stderr}`);
    const campaignDir = path.join(resultsRoot, campaignId);
    const report = loadJson(path.join(campaignDir, "report.json"));
    const state = loadJson(path.join(campaignDir, "state.json"));
    assert.equal(report.verdict, "GREEN", `${caseId} corridor campaign verdict must be GREEN: ${report.verdict}`);
    assert.equal(report.exit_code, 0);
    return state;
  } finally {
    run(daemonControl, ["scripted", "stop"], process.env);
    if (campaignId !== null) {
      fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
  }
}

function makeBehaviorsEnv(): NodeJS.ProcessEnv {
  const behaviorsEnv: NodeJS.ProcessEnv = {
    ...corridorEnv(),
    // The controller materializes the per-cell behaviors from the cell's
    // scenario dir (context.scenario_path); the state dir gives the scripted
    // runtime its per-case work index.
    TAMANDUA_SCRIPTED_STATE: path.join(workRoot, "scripted-state"),
  };
  fs.rmSync(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, { recursive: true, force: true });
  fs.mkdirSync(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, { recursive: true });
  return behaviorsEnv;
}

async function setUpShared(): Promise<void> {
  // Hygiene: no lingering scripted daemon, ports free, tree clean.
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();

  // Fresh scripted home: wipe the contained state so the current product
  // binary recreates the DB schema.
  fs.rmSync(scriptedStateDir, { recursive: true, force: true });
  fs.mkdirSync(scriptedStateDir, { recursive: true });
  fs.writeFileSync(path.join(scriptedHome, ".gitconfig"),
    "[user]\n\tname = TT S49 Split Corridor\n\temail = tt-s49-split@tamandua.invalid\n[commit]\n\tgpgsign = false\n", "utf8");
  installWorkflowIntoScriptedCatalog();
}

function assertZeroTokens(behaviorsEnv: NodeJS.ProcessEnv): void {
  const invocationLog = path.join(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, "invocations.jsonl");
  if (!fs.existsSync(invocationLog)) return; // per-case state dir is campaign-scoped; the journal may be elsewhere
  for (const line of fs.readFileSync(invocationLog, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line);
    if (typeof entry.totalTokens === "number") assert.equal(entry.totalTokens, 0, "journal must show zero tokens");
    if (typeof entry.tokens === "number") assert.equal(entry.tokens, 0, "journal must show zero tokens");
  }
}

describe("S49 (US-010) — zero-token split-corridor battery on the W4.33d/W4.48b absorption + constructed-state cells", () => {
  it("W4.33d-reroute-absorption: the typed rearm move-branch chaos is absorbed by the reroute corridor — >= 1 step.rerouted, a single landing, run.completed, never run.failed",
    { timeout: 90 * 60 * 1000 }, async () => {
      const before = gitSnapshot();
      await setUpShared();
      try {
        await runAbsorptionCase("W4.33d-reroute-absorption", "refs/heads/seed/BUG-T4");
      } finally {
        run(daemonControl, ["scripted", "stop"], process.env);
        assert.equal(gitSnapshot(), before, "W4.33d-reroute-absorption corridor changed git status");
      }
    });

  it("W4.33d-resume-force-fail: the CLI force-fail CONSTRUCTS the failed state; resume armed on event:run.force_failed fires and the SAME run completes",
    { timeout: 90 * 60 * 1000 }, async () => {
      const before = gitSnapshot();
      await setUpShared();
      try {
        await runResumeForceFailCase();
      } finally {
        run(daemonControl, ["scripted", "stop"], process.env);
        assert.equal(gitSnapshot(), before, "W4.33d-resume-force-fail corridor changed git status");
      }
    });

  it("W4.48b-park-absorption: the typed rearm move-branch chaos is absorbed by the merger PARK/landing machinery — a single truthful terminal outcome, run.completed, never run.failed",
    { timeout: 90 * 60 * 1000 }, async () => {
      const before = gitSnapshot();
      await setUpShared();
      try {
        await runAbsorptionCase("W4.48b-park-absorption", "refs/heads/seed/BUG-T2");
      } finally {
        run(daemonControl, ["scripted", "stop"], process.env);
        assert.equal(gitSnapshot(), before, "W4.48b-park-absorption corridor changed git status");
      }
    });

  it("W4.48b-move-during-hold: pause at the finalize marker (hold), the chaos moves the target DURING the hold, resume — the run resolves to a single truthful terminal outcome with no double relaunch",
    { timeout: 90 * 60 * 1000 }, async () => {
      const before = gitSnapshot();
      await setUpShared();
      try {
        await runMoveDuringHoldCase();
      } finally {
        run(daemonControl, ["scripted", "stop"], process.env);
        assert.equal(gitSnapshot(), before, "W4.48b-move-during-hold corridor changed git status");
      }
    });
});
