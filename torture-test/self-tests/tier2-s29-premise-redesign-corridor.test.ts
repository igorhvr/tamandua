// S29 (US-004) / S36 (US-007) — zero-token SCRIPTED PREMISE-REDESIGN
// CORRIDOR.
//
// The tier-2 attempt-2 campaign (campaign-20260826T225744158Z-4bf26d7f) left
// W4.33d-reroute-exhaustion-resume and W4.48b-pause-rugpull-window
// TEST_INFRA_FAIL 'probe-trigger-unreached': both probes armed on REAL product
// events (`event:run.failed`, `event:merge.target_moved`) that the run
// genuinely never emitted — the colleague target-move injection was untyped
// (`chaos: null`) and never executed (US-001 disposition: premise redesign).
//
// US-004 redesigns the corridor: a TYPED `move-branch` chaos block the
// controller actually executes (bin/tt-chaos move-branch with the
// persistent-move budget + run-terminal stand-down) makes the events
// genuinely reachable:
//   * W4.33d: the persistent target move re-routes finalize_merge at every
//     attempt until `max_reroutes: 8` is exhausted → the run permanently
//     fails (`event:run.failed` FIRES) → the probe `resume` fires → the chaos
//     loop stands down at run-terminal (the "operator removes the rejection
//     condition" protocol mechanized) → the resumed finalize lands on the
//     stable target → the SAME run id completes (O16 run_completes PASS).
//   * W4.48b: the target moves during finalize → the merger's expected-tip
//     check emits `event:merge.target_moved` while the run is still running →
//     the probe `pause` fires (hold) → `resume` → the run reroutes once and
//     completes. Characterization one-of-two: paused-no-relaunch (the landed
//     run suppresses the rugpull).
//
// US-007 (S36) tightens the W4.33d premise: the real rerun
// (campaign-20260830T085340743Z-cc2c9a15) showed the US-004 free-running
// cadence (moves every interval_s on a clock gated ONCE at the first marker)
// does NOT fail a REAL run — a 60s cadence vs a ~16-29s finalize window lands
// a move inside the window only when it straddles the next tick. The W4.33d
// corridor transform therefore runs the REDESIGNED per-attempt RE-ARM premise
// (`rearm: true, rearm_hold_s: 2`): each FRESH step:finalize_merge:running
// occurrence triggers the next move after a short post-marker hold, so EVERY
// finalize attempt observes a moved tip — the exact premise the real W4.33d
// cell will run in the next campaign (manifest `rearm: true,
// rearm_hold_s: 3`).
//
// THIS file is the zero-token PROOF that the redesigned triggers genuinely
// FIRE against the 53xx scripted daemon driving real bfmw runs, and that the
// armed probe actions (resume on event:run.failed; pause on
// event:merge.target_moved) EXECUTE with recorded probe evidence — the exact
// corridor the two cells will run in the next real campaign.
//
// How the proof works (all zero tokens, following the E3.C US-011
// tier1-scripted-probe-battery.test.ts / US-002 fired-trigger-corridor
// pattern):
//   1. Build scripted manifest copies under gitignored var/: take each cell
//      from cases/tier2.jsonl — the manifest with its typed move-branch
//      chaos block — and convert to harness scripted-pi with
//      context.execution_mode 'scripted', focused oracles ["O16"], SHORTENED
//      hold_seconds (600 -> 5) and a FAST persistent-move cadence
//      (interval_s -> 3, W4.33d additionally `rearm: true, rearm_hold_s: 2`)
//      so the corridor stays quick. The probe_sequence `when` triggers
//      (event:run.failed / event:merge.target_moved) are KEPT verbatim —
//      they are the very premise being proved reachable.
//   2. Drive each cell through tt-controller against the 53xx scripted daemon
//      (daemon-control scripted start with TAMANDUA_PI_BINARY /
//      TAMANDUA_HERMES_BINARY -> the scripted runtimes via
//      tt-env-scripted.sh, plus TAMANDUA_SCRIPTED_BEHAVIORS -> a full-pipeline
//      bfmw behaviors file). The MERGER is a behavior ARRAY:
//      W4.33d = [9 × retry (tip moved -> STATUS: retry -> reroute), done
//      (stable tip -> STATUS: done -> land)]; W4.48b = [retry, done]. Each
//      retry behavior captures the origin tip, sleeps a window the chaos
//      moves land in, runs the REAL `tamandua merge-branch` with the OLD tip
//      (includeCommandOutput carries the merge.target_moved evidence), then
//      replies STATUS: retry. The done behavior runs merge-branch with the
//      CURRENT (stable) tip and replies STATUS: done.
//   3. Assert per cell: the probe action FIRED on the redesigned trigger and
//      EXECUTED with recorded probe evidence (W4.33d: resume armed on
//      event:run.failed; W4.48b: pause armed on event:merge.target_moved),
//      the chaos operator executed (chaos_evidence: move-branch, completed,
//      and for W4.33d the rearm mode recorded), the run's OWN event stream
//      contains the premise events (step.rerouted x8 + run.failed +
//      run.completed for W4.33d; merge.target_moved + run.completed for
//      W4.48b), O16 PASS, zero tokens.
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
const workRoot = path.join(varRoot, "us004-s29-premise-redesign-corridor");

const SCRIPTED_PORTS = [5334, 5338, 5339];
const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;

// The two US-004 premise-redesign cells the corridor proves. Each runs its
// own campaign (a per-case behaviors file — the merger retry counts differ).
const CORRIDOR_CASES = [
  "W4.33d-reroute-exhaustion-resume",
  "W4.48b-pause-rugpull-window",
];

// Corridor adaptation: the real manifest declares 600s holds and a
// persistent-move cadence tuned for a REAL run's minute-scale finalize
// window; the scripted corridor shortens the hold and the move interval so
// the proof stays fast while keeping the probe `when` triggers verbatim.
const HOLD_SECONDS = 5;
const MOVE_INTERVAL_S = 3;
// US-007 (S36): the W4.33d arm runs the REDESIGNED per-attempt re-arm
// premise — each fresh step:finalize_merge:running occurrence triggers the
// next move after a short post-marker hold (the scripted analogue of the
// real manifest's rearm: true / rearm_hold_s: 3). The hold is 2s so the
// scripted merger's tip capture (t=0) precedes the move (~t=2.5) which
// precedes the retry behavior's merge-branch check (t=5).
const W4_33D_REARM = true;
const W4_33D_REARM_HOLD_S = 2;
// W4.33d needs enough moves to span 9 finalize attempts (~3-4 min at the
// scripted cadence); the run-terminal stand-down stops the loop at run.failed.
const W4_33D_REPEAT = 100;
const W4_48B_REPEAT = 8;

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
// The US-004 manifest is read verbatim (including its typed move-branch chaos
// block); only the harness, execution mode, oracle set, hold length and the
// move-branch cadence are adapted for the scripted fixture. The probe
// `when` triggers (event:run.failed / event:merge.target_moved) are NOT
// touched — they are the premise being proved reachable.
function transformRecord(record: any): any {
  const out = JSON.parse(JSON.stringify(record));
  out.harness = "scripted-pi";
  out.context = { ...(out.context ?? {}), execution_mode: "scripted" };
  // S29-premise isolation (US-004): the corridor proves the TARGET-MOVE
  // premise. bfmw's finalize_merge carries a LEDGER GATE (green-gate) that
  // refuses when no TSTX suite execution matches (the scripted agents never
  // run the real suite) — that refusal is the W4.17-b story, NOT this one.
  // merge_gate: off isolates the S29 premise so the finalize reaches the
  // merger and the target moves genuinely drive the reroutes.
  out.context.merge_gate = "off";
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
  // Adapt the typed move-branch chaos block to the fast scripted cadence.
  if (out.chaos && typeof out.chaos === "object" && out.chaos.type === "move-branch") {
    out.chaos.repeat = record.id === "W4.33d-reroute-exhaustion-resume" ? W4_33D_REPEAT : W4_48B_REPEAT;
    out.chaos.interval_s = MOVE_INTERVAL_S;
    out.chaos.wait_timeout_s = 900;
    // US-007 (S36): the W4.33d arm runs the REDESIGNED per-attempt re-arm
    // premise (each fresh step:finalize_merge:running occurrence triggers
    // the next move after the rearm_hold_s hold — interval_s becomes a
    // minimum-spacing floor). W4.48b keeps the free-running cadence (its
    // premise is a single target move landing in the pause window).
    if (record.id === "W4.33d-reroute-exhaustion-resume") {
      out.chaos.rearm = W4_33D_REARM;
      out.chaos.rearm_hold_s = W4_33D_REARM_HOLD_S;
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
  // The redesigned corridor MUST carry the typed move-branch chaos block and
  // the probe must still arm on the premise event (never weakened). The ref
  // is the case's TARGET REF — for seeded tt-ts cells that is the seeded
  // branch the merger merges into (refs/heads/seed/BUG-*), NOT main.
  assert.ok(record.chaos && record.chaos.type === "move-branch",
    `${caseId}: the redesigned corridor must carry the typed move-branch chaos block`);
  assert.equal(record.chaos.target, "origin_target_ref");
  assert.equal(record.chaos.trigger, "step:finalize_merge:running");
  const expectedRef = caseId === "W4.33d-reroute-exhaustion-resume"
    ? "refs/heads/seed/BUG-T4"
    : "refs/heads/seed/BUG-T2";
  assert.equal(record.chaos.ref, expectedRef,
    `${caseId}: the move-branch ref must be the case's target ref (${expectedRef})`);
  // US-007 (S36): the W4.33d corridor must run the REDESIGNED per-attempt
  // re-arm premise (each fresh step:finalize_merge:running occurrence
  // triggers the next move after the rearm_hold_s hold) — the free-running
  // cadence is exactly what failed the real rerun.
  if (caseId === "W4.33d-reroute-exhaustion-resume") {
    assert.equal(record.chaos.rearm, true,
      "W4.33d: the redesigned corridor must carry the per-attempt re-arm mode (rearm: true)");
    assert.ok(Number.isInteger(record.chaos.rearm_hold_s) && (record.chaos.rearm_hold_s as number) > 0,
      "W4.33d: the re-arm premise must declare a positive rearm_hold_s (post-marker hold)");
  }
  const expectedWhen = caseId === "W4.33d-reroute-exhaustion-resume"
    ? "event:run.failed"
    : "event:merge.target_moved";
  const group = record.probe_sequence[0];
  assert.equal(group.actions[0].when, expectedWhen,
    `${caseId}: the probe must still arm on ${expectedWhen} (the premise event)`);
  fs.mkdirSync(workRoot, { recursive: true });
  const outPath = path.join(workRoot, `${caseId}.jsonl`);
  fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return outPath;
}

// ── Full-pipeline scripted behaviors (bug-fix-merge-worktree) ──────────
// Drives triage -> investigate -> setup -> fix -> verify -> finalize_merge.
// The MERGER is a behavior ARRAY so the reroute-exhaustion / pause corridor
// is deterministic:
//   * retry behaviors: capture the origin tip, sleep a window the chaos
//     moves land in, run the REAL `tamandua merge-branch` with the OLD tip
//     (includeCommandOutput carries its target_moved output as evidence),
//     then reply STATUS: retry (the finalize step's on_fail retry_step
//     reroutes to verify).
//   * the done behavior: run merge-branch with the CURRENT (stable) tip and
//     reply STATUS: done — the resumed / post-pause finalize lands.
// Zero tokens.
function writeBehaviors(caseId: string): string {
  const behaviorsPath = path.join(workRoot, `behaviors-${caseId}.json`);
  const cli = path.join(repoRoot, "bin", "tamandua");
  const retryBehavior = {
    // `|| true`: merge-branch exits 2 on target_moved; the includeCommandOutput
    // is deliberately OFF so the verdict parse sees ONLY the clean
    // STATUS: retry reply (a prepended merge-branch output would carry its own
    // STATUS: landed line and break the retry-verdict routing). The
    // `sleep 5` between the tip capture and merge-branch is the DETERMINISTIC
    // window: the chaos op moves the target every interval_s (3s), so a move
    // lands between the capture and the check and merge.target_moved genuinely
    // fires (without the sleep the capture-to-check window is ~100ms — a race
    // the 500ms chaos poll can lose).
    commands: [
      "expected_tip=$(git -C \"{{input.WORKTREE_ORIGIN_REPOSITORY}}\" rev-parse \"refs/heads/{{input.ORIGINAL_BRANCH}}\") && "
        + "sleep 5 && "
        + `TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${cli}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" `
        + "--branch \"fix/s29-$(basename \"{{cwd}}\")\" --into \"{{input.ORIGINAL_BRANCH}}\" "
        + "--expect-tip \"$expected_tip\" --message \"fix: scripted s29 retry merge\" || true",
    ],
    output: [
      "STATUS: retry",
      "REBASED: false",
      "RETRY_STEP: verify",
    ].join("\n"),
  };
  const doneBehavior = {
    commands: [
      "expected_tip=$(git -C \"{{input.WORKTREE_ORIGIN_REPOSITORY}}\" rev-parse \"refs/heads/{{input.ORIGINAL_BRANCH}}\") && "
        + `TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${cli}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" `
        + "--branch \"fix/s29-$(basename \"{{cwd}}\")\" --into \"{{input.ORIGINAL_BRANCH}}\" "
        + "--expect-tip \"$expected_tip\" --message \"fix: scripted s29 resume merge\"",
    ],
    includeCommandOutput: true,
    output: [
      "STATUS: done",
      "REBASED: false",
      "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
      "MERGED_TREE: {{input.TESTED_TREE}}",
    ].join("\n"),
  };
  // W4.33d: 9 retry attempts exhaust max_reroutes: 8 (attempt 9's failure is
  // the budget-exhausting one) -> run.failed; the RESUME re-runs the failed
  // finalize (attempt 10) against the stable target -> done. W4.48b: one
  // retry (the target_moved that arms the pause) then the post-pause attempt
  // lands -> done.
  const mergerBehaviors = caseId === "W4.33d-reroute-exhaustion-resume"
    ? [...Array(9).fill(retryBehavior), doneBehavior]
    : [retryBehavior, doneBehavior];
  const behaviors = {
    agents: {
      triager: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          "BRANCH: fix/s29-scripted-premise",
          "SEVERITY: high",
          "AFFECTED_AREA: src/value.txt",
          "REPRODUCTION: fixture carries the stale value",
          "PROBLEM_STATEMENT: exercise the S29 premise-redesign corridor",
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
        writes: [{ file: "probe-marker.txt", content: "s29 premise redesign marker\n" }],
        commands: [
          "git add probe-marker.txt",
          "git commit -m 'fix: scripted s29 premise redesign change'",
        ],
        output: [
          "STATUS: done",
          "CHANGES: scripted s29 premise redesign change",
          "REGRESSION_TEST: scripted s29 premise redesign regression",
        ].join("\n"),
      },
      verifier: {
        output: [
          "STATUS: done",
          "VERIFIED: scripted s29 premise redesign verified",
          "TESTED_TREE: {{gitTree}}",
        ].join("\n"),
      },
      merger: mergerBehaviors,
    },
    heartbeatTokens: 0,
    defaultTokens: 0,
  };
  fs.writeFileSync(behaviorsPath, `${JSON.stringify(behaviors, null, 2)}\n`, "utf8");
  return behaviorsPath;
}

function installWorkflowIntoScriptedCatalog(): void {
  const result = run("bash", ["-c", "source torture-test/env/tt-env-scripted.sh && exec bin/tamandua workflow install bug-fix-merge-worktree"], corridorEnv(), 300_000);
  assert.equal(result.status, 0, `workflow install failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes("Installed workflow: bug-fix-merge-worktree"),
    `workflow install did not report success:\n${result.stdout}`);
}

// Read the run's OWN event stream from the contained scripted home (both
// run-id spellings), newest-last — the S29 premise events must appear there.
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

function assertOracleVerdict(caseState: any, expectedResult: string): void {
  const oracles = caseState.oracle_results ?? [];
  const o16 = oracles.find((item: any) => item.oracle_id === "O16");
  assert.ok(o16, `${caseState.id}: O16 oracle result must be present`);
  assert.equal(o16.status, "VALID", `${caseState.id}: O16 must run (VALID), got ${o16.status}`);
  assert.equal(o16.response.result, expectedResult,
    `${caseState.id}: O16 verdict must be ${expectedResult}, got ${o16.response.result}: ${JSON.stringify(o16.response.findings ?? [])}`);
}

async function runCorridorCase(caseId: string): Promise<void> {
  // Hygiene: no lingering scripted daemon, ports free, tree clean.
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();
  const before = gitSnapshot();

  const manifestPath = buildScriptedManifest(caseId);
  const behaviorsPath = writeBehaviors(caseId);

  // Fresh scripted home: wipe the contained state so the current product
  // binary recreates the DB schema.
  fs.rmSync(scriptedStateDir, { recursive: true, force: true });
  fs.mkdirSync(scriptedStateDir, { recursive: true });
  fs.writeFileSync(path.join(scriptedHome, ".gitconfig"),
    "[user]\n\tname = TT S29 Premise Corridor\n\temail = tt-s29-premise@tamandua.invalid\n[commit]\n\tgpgsign = false\n", "utf8");
  installWorkflowIntoScriptedCatalog();

  const behaviorsEnv: NodeJS.ProcessEnv = {
    ...corridorEnv(),
    TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
    TAMANDUA_SCRIPTED_STATE: path.join(workRoot, `scripted-state-${caseId}`),
  };
  fs.rmSync(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, { recursive: true, force: true });
  fs.mkdirSync(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, { recursive: true });
  const start = run(daemonControl, ["scripted", "start"], behaviorsEnv, 120_000);
  assert.equal(start.status, 0, `scripted daemon start failed:\n${start.stdout}\n${start.stderr}`);

  let campaignId: string | null = null;
  const isW433d = caseId === "W4.33d-reroute-exhaustion-resume";
  try {
    const result = await runStreaming(controller, ["--manifest", manifestPath], behaviorsEnv);
    const m = CAMPAIGN_LINE.exec(result.stdout);
    campaignId = m === null ? null : m[1];
    assert.ok(campaignId, `campaign did not print an ID:\n${result.stdout}\n${result.stderr}`);

    const campaignDir = path.join(resultsRoot, campaignId);
    if (isW433d) {
      // W4.33d: the premise is resume-after-PERMANENT-FAILURE. The launch
      // hook (`workflow run --wait`) returns at the FIRST terminal state
      // (run.failed); the probe's resume then re-activates the SAME run, so
      // the controller's harvest sees the resumed run still 'running' and
      // leaves the case 'attached' (no terminal report — the campaign-resume
      // completion machinery cannot complete an oracle snapshot started by a
      // PREVIOUS controller process: the snapshot transaction is
      // process-scoped by design). The corridor's PROOF is the EVIDENCE: the
      // typed move-branch chaos made event:run.failed genuinely fire, the
      // resume probe FIRED on it and EXECUTED (exit 0), and the resumed run
      // completes (the O16 resume-completes condition). Assert that evidence
      // directly from the campaign state + the run's own event stream, with
      // the daemon kept up while the resumed run finishes.
      assert.equal(result.status, 0, `W4.33d controller must exit 0 (case attached, no report):\n${result.stdout}\n${result.stderr}`);
      const state = loadJson(path.join(campaignDir, "state.json"));
      const cs = state.cases.find((c: any) => c.id === caseId);
      assert.ok(cs, "W4.33d: must appear in campaign state");
      assert.equal(cs.spend?.tokens_observed ?? 0, 0, "W4.33d: case spend must be zero");
      const attempt = cs.attempts[0];

      // The typed move-branch chaos operator genuinely executed.
      const ce = attempt.chaos_evidence;
      assert.ok(ce, "W4.33d: chaos_evidence must be present (the typed move-branch injection ran)");
      assert.equal(ce.injection_type, "move-branch", "W4.33d: injection must be move-branch");
      assert.equal(ce.ref, "refs/heads/seed/BUG-T4",
        "W4.33d: move-branch must target the case's target ref (seed/BUG-T4 — the branch the merger merges into)");
      assert.equal(ce.target, "origin_target_ref", "W4.33d: move-branch target class must be origin_target_ref");
      assert.equal(ce.status, "completed", `W4.33d: chaos operator must complete: ${JSON.stringify(ce.failure ?? null)}`);
      // US-007 (S36): the chaos_evidence must record the per-attempt re-arm
      // mode (the redesigned premise the real cell will run).
      assert.equal(ce.rearm, true,
        `W4.33d: chaos_evidence must record the rearm mode (the redesigned premise): ${JSON.stringify(ce)}`);
      assert.equal(ce.rearm_hold_s, W4_33D_REARM_HOLD_S,
        "W4.33d: chaos_evidence must record the rearm_hold_s (the post-marker hold)");

      // The resume probe FIRED on event:run.failed and EXECUTED.
      const pe = attempt.probe_evidence;
      assert.ok(pe, "W4.33d: probe_evidence must be present");
      assert.equal(pe.sequence_outcome, "completed");
      assert.equal(pe.actions.length, 1);
      assert.equal(pe.actions[0].op, "resume");
      assert.equal(pe.actions[0].trigger, "event:run.failed",
        "W4.33d: the resume must arm on event:run.failed (the premise event US-004 makes reachable)");
      assert.equal(pe.actions[0].ok, true, `W4.33d: resume must succeed: ${JSON.stringify(pe.actions[0].failure ?? null)}`);
      assert.equal(pe.actions[0].exit_code, 0, "W4.33d: the resume CLI must exit 0");
      assert.equal(pe.actions[0].effect?.status_after?.status, "running",
        `W4.33d: resume must re-activate the run: ${JSON.stringify(pe.actions[0].effect ?? null)}`);

      // The run's OWN event stream: genuine target-move reroutes
      // (merge.target_moved + step.rerouted >= 8) -> run.failed.
      const runId = attempt.run_id;
      const eventNames = readRunEvents(runId).map((e) => e.event);
      assert.ok(eventNames.includes("merge.target_moved"),
        `W4.33d: merge.target_moved must genuinely fire (the colleague target move): ${eventNames.join(",")}`);
      assert.ok(eventNames.includes("run.failed"),
        `W4.33d: event:run.failed must genuinely fire in the run stream: ${eventNames.join(",")}`);
      const reroutes = eventNames.filter((n) => n === "step.rerouted").length;
      assert.ok(reroutes >= 8,
        `W4.33d: reroute exhaustion needs >= 8 step.rerouted, got ${reroutes}: ${eventNames.join(",")}`);

      // The resumed run (SAME id) completes — the O16 resume-completes
      // condition. The run's OWN event stream is the durable evidence: the
      // resumed finalize (done behavior, stable target) lands and emits
      // run.completed. Poll the stream (append-only) — the run's post-resume
      // lifecycle may take a few minutes (the resumed run re-executes its
      // pipeline against the still-persistently-moving budget before the
      // finalize lands), so the poll is generous.
      const completed = await waitForRunEvent(runId, "run.completed", 600_000);
      assert.equal(completed, true, "W4.33d: the resumed run must complete (run.completed in its event stream)");
    } else {
      // W4.48b: the pause+resume never takes the run through a terminal state
      // (the pause is non-terminal, the retry reroutes), so the launch hook
      // returns at the FINAL completion and the campaign classifies cleanly.
      assert.equal(result.status, 0, `premise-redesign corridor campaign must be GREEN:\n${result.stdout}\n${result.stderr}`);
      const report = loadJson(path.join(campaignDir, "report.json"));
      const state = loadJson(path.join(campaignDir, "state.json"));
      assert.equal(report.verdict, "GREEN", `corridor campaign verdict must be GREEN: ${report.verdict}`);
      assert.equal(report.exit_code, 0);

      const cs = state.cases.find((c: any) => c.id === caseId);
      assert.ok(cs, "W4.48b: must appear in campaign state");
      assert.equal(cs.outcome, "PASS", `W4.48b: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
      assert.equal(cs.spend?.tokens_observed ?? 0, 0, "W4.48b: case spend must be zero");
      assert.equal(report.spend.tokens_observed, 0, "campaign report spend must be zero");

      const attempt = cs.attempts[0];
      assert.equal(attempt.terminal_status, "completed", "W4.48b: run must complete");

      const ce = attempt.chaos_evidence;
      assert.ok(ce, "W4.48b: chaos_evidence must be present (the typed move-branch injection ran)");
      assert.equal(ce.injection_type, "move-branch", "W4.48b: injection must be move-branch");
      assert.equal(ce.ref, "refs/heads/seed/BUG-T2",
        "W4.48b: move-branch must target the case's target ref (seed/BUG-T2 — the branch the merger merges into)");
      assert.equal(ce.target, "origin_target_ref", "W4.48b: move-branch target class must be origin_target_ref");
      assert.equal(ce.status, "completed", `W4.48b: chaos operator must complete: ${JSON.stringify(ce.failure ?? null)}`);

      const pe = attempt.probe_evidence;
      assert.ok(pe, "W4.48b: probe_evidence must be present");
      assert.equal(pe.sequence_outcome, "completed");
      assert.equal(pe.actions.length, 2);
      assert.equal(pe.actions[0].op, "pause");
      assert.equal(pe.actions[0].trigger, "event:merge.target_moved",
        "W4.48b: the pause must arm on event:merge.target_moved (the premise event US-004 makes reachable)");
      assert.equal(pe.actions[0].ok, true, `W4.48b: pause must succeed: ${JSON.stringify(pe.actions[0].failure ?? null)}`);
      assert.equal(pe.actions[0].hold_seconds, HOLD_SECONDS);
      assert.equal(pe.actions[0].effect?.status_after?.status, "paused",
        `W4.48b: the run must be paused: ${JSON.stringify(pe.actions[0].effect ?? null)}`);
      assert.equal(pe.actions[1].op, "resume");
      assert.equal(pe.actions[1].ok, true, `W4.48b: resume must succeed: ${JSON.stringify(pe.actions[1].failure ?? null)}`);
      const eventNames = readRunEvents(attempt.run_id).map((e) => e.event);
      assert.ok(eventNames.includes("merge.target_moved"),
        `W4.48b: event:merge.target_moved must genuinely fire in the run stream: ${eventNames.join(",")}`);
      assert.ok(eventNames.includes("run.completed"),
        `W4.48b: the run must complete: ${eventNames.join(",")}`);
      assertOracleVerdict(cs, "PASS");
    }

    // ── Zero tokens: the scripted runtime journal shows zero-token
    //    invocations. ──
    const invocationLog = path.join(behaviorsEnv.TAMANDUA_SCRIPTED_STATE as string, "invocations.jsonl");
    assert.ok(fs.existsSync(invocationLog), "scripted runtime journal must exist (proves the scripted runtimes executed the runs)");
    for (const line of fs.readFileSync(invocationLog, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line);
      if (typeof entry.totalTokens === "number") assert.equal(entry.totalTokens, 0, "journal must show zero tokens");
      if (typeof entry.tokens === "number") assert.equal(entry.tokens, 0, "journal must show zero tokens");
    }

    // ── Hygiene: scripted daemon stops cleanly, ports free, tree clean. ──
    const stop = run(daemonControl, ["scripted", "stop"], process.env);
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
    const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
    assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
    assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m,
      "scripted daemon must be cleanly stopped after the corridor");
    await assertPortsFree();
    assert.equal(gitSnapshot(), before, "premise-redesign corridor changed git status");
  } finally {
    run(daemonControl, ["scripted", "stop"], process.env);
    if (campaignId !== null) {
      fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
  }
}

// Poll the run's OWN event stream (append-only, durable) until an event of
// the given name appears — the resumed run's completion after the probe's
// resume. Zero tokens.
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

describe("S29 (US-004) / S36 (US-007) — zero-token premise-redesign corridor on the typed move-branch injection", () => {
  it("W4.33d: the RE-ARMED move-branch chaos (each fresh step:finalize_merge:running occurrence triggers the next move) makes event:run.failed genuinely fire (reroute exhaustion); resume armed on it fires and the resumed run completes",
    { timeout: 90 * 60 * 1000 }, async () => {
      await runCorridorCase("W4.33d-reroute-exhaustion-resume");
    });

  it("W4.48b: the typed move-branch chaos makes event:merge.target_moved genuinely fire while the run is running; pause armed on it fires and executes with recorded evidence",
    { timeout: 90 * 60 * 1000 }, async () => {
      await runCorridorCase("W4.48b-pause-rugpull-window");
    });
});
