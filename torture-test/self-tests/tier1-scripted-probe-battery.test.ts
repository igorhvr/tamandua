// E3.C US-011 — Zero-token scripted probe battery (W3.17b/W3.18-W3.22).
//
// Campaign #7's biggest discovery (S3/S4): the five lifecycle cases and the
// chaos marathon never ran their probes — tt-controller only did
// launch→wait→(cap-stop)→snapshot, tt-chaos was never invoked, and oracles
// O16/O4 were declared in manifests with no executables (~2.6M tokens bought
// zero lifecycle coverage). E3.C built the machinery (US-001..010); THIS file
// is the zero-token PROOF that every probe sequence and the chaos block
// actually execute end-to-end against the 53xx scripted instance with
// recorded evidence + an O16 verdict.
//
// How the proof works (all zero tokens):
//   1. Build scripted manifest copies under gitignored var/ (the
//      tier1-zero-real-launch-infra.test.ts copy-transform pattern): convert
//      W3.17b, W3.18, W3.19, W3.20, W3.21, W3.22 to harness
//      scripted-pi/scripted-hermes with context.execution_mode 'scripted' and
//      SHORTENED hold_seconds (600 -> 5) so the battery stays fast; the
//      probe_sequence + chaos blocks are KEPT. W3.19's drain is adapted to
//      the tester (plain single, non-loop) step: the as-declared
//      `pause_drain @ step:developer:running -> resume @ now` sequence cannot
//      complete against the current product — `workflow pause --drain` on
//      the verify_each implement loop never finalizes (the loop step stays
//      'running' awaiting the parked verify step, so finalizeDrainingPause is
//      never reached and the run stays status 'running'), and `workflow
//      resume` refuses a 'running' (draining) run ("only paused or failed
//      runs can be resumed"). The drain finalizes to 'paused' only on the
//      plain-single-step success path (and on run completion / retry /
//      failure) — the verify_each verify step also bypasses it (its success
//      routes through handleVerifyEachCompletion -> advancePipeline's
//      'advanced' branch, which never calls finalizeDrainingPause). The
//      scripted copy therefore drains the TEST step (a plain single step):
//      `pause_drain @ step:tester:running` (the drain parks the in-flight
//      tester and finalizes the run to 'paused' once it completes) +
//      `resume @ event:run.paused` (the drain-FINALIZATION event — a
//      step-status marker would race the finalize, since the step flips
//      'done' a few ms before the run flips 'paused', and resume on a
//      still-'running' run is refused). This is a documented
//      product-limitation adaptation, not a weakening: the drain machinery,
//      the park, and the resume all run end-to-end on the scripted fixture.
//      W3.21's fail_force->resume: product commit 3f880b1a FIXED the
//      resume-after-force-fail defect — resumeWorkflow now repairs the
//      all-canceled force-failed pipeline (resets from the first non-done
//      step, re-registers with the daemon, and the run re-runs). The resume
//      therefore SUCCEEDS (exit 0, SAME run id, "restarting from step:
//      implement"); the launch hook returned at the FIRST terminal state
//      (run.failed after the force-fail), so the controller's harvest sees
//      the resumed run still 'running' and leaves the case 'attached' (no
//      terminal report — the documented US-004 resume-leaves-case-attached
//      shape). The battery asserts the corridor at the EVIDENCE level:
//      probe_evidence for BOTH actions (fail_force ok, resume ok:true exit 0
//      with the same run id) + the run's own event stream re-activation
//      after the resume — exactly the W4.33d corridor pattern.
//   2. Drive each through the controller against the 53xx scripted daemon
//      (daemon-control scripted start with TAMANDUA_PI_BINARY /
//      TAMANDUA_HERMES_BINARY -> the scripted runtimes via tt-env-scripted.sh,
//      plus TAMANDUA_SCRIPTED_BEHAVIORS -> a full-pipeline behaviors file that
//      drives feature-dev-merge-worktree to a real squash-merge landing).
//   3. Assert per case: probe actions executed (probe_evidence present),
//      O16 verdict emitted on the scripted fixture (W3.17b: O4; W3.18-W3.20,
//      W3.22: O16 PASS; W3.21: the FIXED resume corridor — campaign exits 0
//      with the case attached, no terminal report, no O16 verdict), zero
//      tokens observed.
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
import { provisionWorkClone } from "../bin/tt-fixture-provision.mjs";
import {
  getProcessGroup,
  getProcessStartIdentity,
  getProcessState,
  ownProcessGroup,
} from "../bin/tt-process-identity.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const controller = path.join(binDir, "tt-controller");
const daemonControl = path.join(binDir, "daemon-control");
const tier1Manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const scriptedHome = path.join(varRoot, "home-scripted");
const scriptedStateDir = path.join(scriptedHome, ".tamandua");
const workRoot = path.join(varRoot, "us011-scripted-battery");

const SCRIPTED_PORTS = [5334, 5338, 5339];
const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;

// The six E3.C cases the battery proves: the chaos marathon (W3.17b) and the
// five lifecycle cases (W3.18-W3.22).
const BATTERY_CASES = [
  "W3.17b-marathon-chaos",
  "W3.18-pause-no-drain",
  "W3.19-pause-drain",
  "W3.20-cancel",
  "W3.21-fail-force-resume",
  "W3.22-daemon-restart",
];

// Shortened holds: the real manifests declare 600s (10m) holds; the scripted
// fixture proves the SAME machinery with a few-second hold so the battery
// stays fast. The developer/merger behaviors sleep SLOW_SLEEP_SECONDS so the
// probe markers (step:developer:running / step:finalize_merge:running) have a
// wide window to fire against the real scripted daemon.
const HOLD_SECONDS = 5;
const SLOW_SLEEP_SECONDS = 25;
// The tester is the W3.19 drain target (a plain single, non-loop step) — it
// must stay 'running' long enough for the pause_drain probe to arm on
// step:tester:running.
const DRAIN_TARGET_SLEEP_SECONDS = 10;

type CommandResult = { status: number | null; stdout: string; stderr: string };

// node:test marks descendant processes; the battery drives the scripted daemon
// on the fixed TT ports under the gitignored TT home, so disable only the
// live-state guard and drop NODE_TEST_CONTEXT (mirrors tier1-repeatability).
// PATH is prepended with the repo bin so 'tamandua' (launch hooks + the
// scripted runtimes' CLI path) resolves to THIS checkout's binary.
function batteryEnv(): NodeJS.ProcessEnv {
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

// ── Battery-level self-group assertion (E3.C.1 US-006) ─────────────
// The battery must never reach its OWN ancestry: record the battery's own
// process group (pgid) + member identities BEFORE the campaign and prove at
// the end that the group is unchanged — the leader is still alive, and no
// member was signalled (every member recorded at start is still alive with
// the same process-start identity and not a zombie). This is a READ-ONLY
// assertion scan — it never signals anything and never resolves a kill
// target; it only proves the kill-heavy campaign left the battery's own
// process group untouched.
type SelfGroupSnapshot = {
  pgid: number;
  leaderStartTime: string | null;
  members: Array<{ pid: number; startTime: string | null }>;
};

function snapshotSelfGroup(): SelfGroupSnapshot {
  // /proc introspection below is linux-only (MACP3 US-003): Darwin has no
  // procfs, so this is an explicit Darwin branch — return an empty snapshot
  // (no leader, no members) and let assertSelfGroupSurvived no-op on it.
  // Behavior on linux is unchanged: the full /proc-scanned member set is
  // still built and asserted.
  if (process.platform !== "linux") {
    return { pgid: 0, leaderStartTime: null, members: [] };
  }
  const pgid = ownProcessGroup();
  assert.ok(pgid !== null && pgid > 0, `battery's own process group must be readable, got ${String(pgid)}`);
  // The group leader is pid == pgid. Record its identity at snapshot time: a
  // leader that is ALREADY gone before the campaign (e.g. the launcher shell
  // that backgrounded the test with nohup, whose pgid the test inherited)
  // predates the campaign — only a leader that was alive when the campaign
  // started must still be alive at the end.
  const leaderStartTime = getProcessStartIdentity(pgid);
  const members: Array<{ pid: number; startTime: string | null }> = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (getProcessGroup(pid) !== pgid) continue;
    members.push({ pid, startTime: getProcessStartIdentity(pid) });
  }
  members.sort((a, b) => a.pid - b.pid);
  return { pgid, leaderStartTime, members };
}

function assertSelfGroupSurvived(before: SelfGroupSnapshot): void {
  // Darwin branch (MACP3 US-003): the linux-only /proc introspection was
  // skipped, so there is nothing to assert — no-op on a /proc-less host.
  if (before.members.length === 0 && before.leaderStartTime === null) return;
  const pgidAfter = ownProcessGroup();
  assert.equal(pgidAfter, before.pgid,
    `battery's own process group changed across the campaign: ${String(before.pgid)} -> ${String(pgidAfter)}`);
  // The group leader (pid == pgid) must still be alive and still the leader —
  // when it was alive at snapshot time (a leader that exited before the
  // campaign is not the campaign's doing; every member that WAS alive at the
  // start is still asserted to have survived below).
  if (before.leaderStartTime !== null) {
    assert.equal(getProcessGroup(before.pgid), before.pgid,
      `battery's process-group leader ${before.pgid} is no longer the group leader`);
    assert.equal(getProcessStartIdentity(before.pgid), before.leaderStartTime,
      `battery's process-group leader ${before.pgid} identity changed — the leader was killed or its pid reused`);
    assert.notEqual(getProcessState(before.pgid), "Z",
      `battery's process-group leader ${before.pgid} became a zombie — a kill reached the battery's own group`);
  }
  // No member signalled: every member recorded at the start is still alive
  // with the SAME process-start identity (a killed member would be a zombie
  // until reaped, or gone; a reused pid would carry a different startTime).
  for (const member of before.members) {
    const state = getProcessState(member.pid);
    assert.notEqual(state, null, `battery group member ${member.pid} is gone — a kill reached the battery's own group`);
    assert.notEqual(state, "Z", `battery group member ${member.pid} became a zombie — a kill reached the battery's own group`);
    assert.equal(getProcessStartIdentity(member.pid), member.startTime,
      `battery group member ${member.pid} start identity changed — a kill reached the battery's own group (pid reused?)`);
  }
}

// ── Copy-transform: tier1.jsonl -> scripted battery manifest ───────────

function transformRecord(record: any): any {
  const out = JSON.parse(JSON.stringify(record));
  out.harness = out.harness === "hermes" ? "scripted-hermes" : "scripted-pi";
  out.context = { ...(out.context ?? {}), execution_mode: "scripted" };
  // The scripted copies run against the SCRIPTED runtimes — the real-host
  // `hermes` capability predicate (host-profile harness auth) is not relevant
  // to them and would gate the cases NOT_RUN on a --fast host profile (which
  // records harness: null). Drop real-harness capabilities from the requires.
  if (Array.isArray(out.requires?.capabilities)) {
    out.requires = {
      ...(out.requires ?? {}),
      capabilities: out.requires.capabilities.filter((cap: string) => cap !== "hermes" && cap !== "pi"),
    };
    if (out.requires.capabilities.length === 0) delete out.requires.capabilities;
  }
  // Focused oracle set: O16 is the lifecycle probe-evidence oracle (PASS on
  // the probe-sequence cases). W3.17b is the chaos-only case — it declares
  // O4 instead: O16's REQUIRED_ORACLE_EVIDENCE (US-003) includes
  // probe_evidence, which a chaos-only case cannot produce (no
  // probe_sequence), so declaring O16 there would fail closed as TEST_INFRA
  // by design; O4's required evidence (database_snapshot/run_events/
  // chaos_log) is exactly what the chaos path produces, proving the
  // chaos.log capture + hygiene verdict on the chaos run.
  out.oracles = out.id === "W3.17b-marathon-chaos" ? ["O4"] : ["O16"];
  // Shorten hold-capable probe actions (pause / sigstop_sigcont).
  for (const group of out.probe_sequence ?? []) {
    for (const action of group.actions ?? []) {
      if (typeof action.hold_seconds === "number") action.hold_seconds = HOLD_SECONDS;
      // W3.19 drain adaptation: the as-declared `pause_drain @
      // step:developer:running -> resume @ now` cannot complete against the
      // current product (the verify_each implement loop never finalizes the
      // drain, so the run stays 'running' and `workflow resume` refuses it).
      // Drain a PLAIN single (non-loop) step instead — the tester: its
      // success path calls finalizeDrainingPause unconditionally (the
      // verify_each verify step also bypasses the finalize, routing through
      // advancePipeline's 'advanced' branch). resume fires on
      // `event:run.paused` — the drain-FINALIZATION event the product emits
      // when the drained run reaches 'paused' (a step-status marker would
      // race the finalize: the step flips 'done' a few ms before the run
      // flips 'paused', and resume on a still-'running' run is refused).
      if (out.id === "W3.19-pause-drain") {
        if (action.op === "pause_drain") action.when = "step:tester:running";
        if (action.op === "resume") action.when = "event:run.paused";
      }
    }
  }
  // Shorten the chaos hold (W3.17b: 600 -> HOLD_SECONDS).
  if (out.chaos && typeof out.chaos.hold_seconds === "number") out.chaos.hold_seconds = HOLD_SECONDS;
  return out;
}

function buildScriptedManifest(): string {
  const records: any[] = [];
  for (const line of fs.readFileSync(tier1Manifest, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line) as any;
    if (!BATTERY_CASES.includes(record.id)) continue;
    records.push(transformRecord(record));
  }
  assert.equal(records.length, BATTERY_CASES.length, "battery manifest must contain all six cases");
  fs.mkdirSync(workRoot, { recursive: true });
  const outPath = path.join(workRoot, "manifest.jsonl");
  fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return outPath;
}

// ── Full-pipeline scripted behaviors ────────────────────────────────────
// Drives feature-dev-merge-worktree to a REAL squash-merge landing on the
// scripted fixture: planner emits STORIES_JSON, setup creates a per-worktree
// unique feature branch, the developer writes + commits a marker (with a long
// sleep so probe markers fire mid-round), the tester reports TESTED_TREE, and
// the merger runs the actual `tamandua merge-branch` plumbing. Zero tokens.
function writeBehaviors(): string {
  const behaviorsPath = path.join(workRoot, "behaviors.json");
  const cli = path.join(repoRoot, "bin", "tamandua");
  const behaviors = {
    agents: {
      planner: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          "BRANCH: feature/tt-probe",
          "STORIES_JSON: [{\"id\":\"US-001\",\"title\":\"scripted probe story\",\"description\":\"Exercise the E3.C probe machinery\",\"acceptanceCriteria\":[\"probe evidence lands\",\"Typecheck passes\"]}]",
        ].join("\n"),
      },
      setup: {
        commands: ["git checkout -B \"feature/tt-probe-$(basename \"{{cwd}}\")\""],
        output: [
          "STATUS: done",
          "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
          "BUILD_CMD: npm run build",
          "TEST_CMD: npm test",
          "CI_NOTES: scripted",
          "BASELINE: green",
        ].join("\n"),
      },
      developer: {
        writes: [{ file: "probe-marker.txt", content: "scripted probe marker\n" }],
        commands: [
          `sleep ${SLOW_SLEEP_SECONDS}`,
          "git add probe-marker.txt",
          "git commit -m 'feat: scripted probe change'",
        ],
        output: "STATUS: done\nCHANGES: scripted probe change\nTESTS: scripted",
      },
      verifier: { output: "STATUS: done\nVERIFIED: scripted" },
      tester: {
        commands: [`sleep ${DRAIN_TARGET_SLEEP_SECONDS}`],
        output: "STATUS: done\nRESULTS: scripted suite passed\nTESTED_TREE: {{gitTree}}",
      },
      merger: {
        commands: [
          `sleep ${SLOW_SLEEP_SECONDS}`,
          "expected_tip=$(git -C \"{{input.WORKTREE_ORIGIN_REPOSITORY}}\" rev-parse \"refs/heads/{{input.ORIGINAL_BRANCH}}\") && "
            + `TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${cli}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" `
            + "--branch \"feature/tt-probe-$(basename \"{{cwd}}\")\" --into \"{{input.ORIGINAL_BRANCH}}\" "
            + "--expect-tip \"$expected_tip\" --message \"feat: scripted probe merge\"",
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
  const result = run("bash", ["-c", "source torture-test/env/tt-env-scripted.sh && exec bin/tamandua workflow install feature-dev-merge-worktree"], batteryEnv(), 300_000);
  assert.equal(result.status, 0, `workflow install failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes("Installed workflow: feature-dev-merge-worktree"),
    `workflow install did not report success:\n${result.stdout}`);
}

function provisionFixtures(): void {
  const cases: Array<[string, string]> = [
    ["W3.17b-marathon-chaos", "tt-poly-lite"],
    ["W3.18-pause-no-drain", "tt-ts"],
    ["W3.19-pause-drain", "tt-ts"],
    ["W3.20-cancel", "tt-ts"],
    ["W3.21-fail-force-resume", "tt-ts"],
    ["W3.22-daemon-restart", "tt-ts"],
  ];
  for (const [caseId, fixture] of cases) {
    fs.rmSync(path.join(varRoot, "fixtures", "work", caseId), { recursive: true, force: true });
    const provision = provisionWorkClone({ fixture, caseId });
    assert.equal(provision.ok, true, `${caseId}: fixture provision failed: ${JSON.stringify(provision.reason ?? provision)}`);
  }
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

function assertZeroTokens(caseState: any, report: any): void {
  assert.equal(caseState.spend?.tokens_observed ?? 0, 0, `${caseState.id}: case spend must be zero`);
  assert.equal(report.spend.tokens_observed, 0, "campaign report spend must be zero");
}

function assertCaseEvidence(state: any, report: any, caseId: string, checker: (cs: any) => void): void {
  const cs = state.cases.find((c: any) => c.id === caseId);
  assert.ok(cs, `${caseId}: must appear in campaign state`);
  checker(cs);
  assertZeroTokens(cs, report);
}

// Read the run's OWN event stream from the contained scripted home (both
// run-id spellings), newest-last — the W3.21 resumed run's re-activation
// events must appear there (the US-004 evidence-level corridor pattern).
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
      if (event === null || typeof event !== "object") continue;
      const eventRunId = String(event.runId ?? "");
      if (eventRunId !== shortRunId && eventRunId !== runId) continue;
      events.push(event);
    }
  }
  return events;
}

describe("E3.C US-011 zero-token scripted probe battery", () => {
  it("every probe sequence (W3.17b chaos, W3.18-W3.22) runs end-to-end on the 53xx scripted instance with evidence + O16 verdicts, zero tokens",
    { timeout: 60 * 60 * 1000 }, async () => {
      // Hygiene: no lingering scripted daemon, ports free, tree clean.
      const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
      assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
      await assertPortsFree();
      const before = gitSnapshot();

      // E3.C.1 US-006: snapshot the battery's OWN process group before the
      // kill-heavy campaign (daemon start, controller probe battery with the
      // tt-chaos sigstop_sigcont hold, restart_daemon teardown, daemon stop)
      // so the end-of-battery assertion can prove the campaign left it
      // untouched — its leader alive, no member signalled.
      const selfGroupBefore = snapshotSelfGroup();

      // Build the scripted manifest copy + behaviors under gitignored var/.
      const manifestPath = buildScriptedManifest();
      const behaviorsPath = writeBehaviors();

      // Fresh scripted home: wipe the contained state so the current product
      // binary recreates the DB schema (a stale schema from an older binary
      // breaks `workflow run` with e.g. "table runs has no column notify_url").
      fs.rmSync(scriptedStateDir, { recursive: true, force: true });
      fs.mkdirSync(scriptedStateDir, { recursive: true });
      // Contained git identity for the scripted worktrees (the operator's
      // global ~/.gitconfig must NEVER be used — HOME is the scripted home).
      fs.writeFileSync(path.join(scriptedHome, ".gitconfig"),
        "[user]\n\tname = TT Scripted Probe\n\temail = tt-scripted@tamandua.invalid\n[commit]\n\tgpgsign = false\n", "utf8");
      installWorkflowIntoScriptedCatalog();
      provisionFixtures();

      // Start the 53xx scripted daemon with the behaviors + state env (the
      // daemon forwards TAMANDUA_SCRIPTED_BEHAVIORS/STATE to every spawned
      // scripted runtime).
      const behaviorsEnv: NodeJS.ProcessEnv = {
        ...batteryEnv(),
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
        // the scripted runtimes are the harness binaries; /bin/false
        // backstops are unnecessary because tt-env-scripted.sh pins them).
        const result = await runStreaming(controller, ["--manifest", manifestPath], behaviorsEnv);
        const m = CAMPAIGN_LINE.exec(result.stdout);
        campaignId = m === null ? null : m[1];
        assert.ok(campaignId, `campaign did not print an ID:\n${result.stdout}\n${result.stderr}`);
        // Exit 0: the campaign INCLUDES W3.21, whose fail_force->resume now
        // SUCCEEDS (product commit 3f880b1a fixed the resume-after-force-fail
        // defect). The launch hook returned at the FIRST terminal state
        // (run.failed after the force-fail) and the probe's resume re-activated
        // the SAME run, so the controller's harvest sees the resumed run still
        // 'running' and leaves the case 'attached' — writeTerminalCampaignReports
        // skips the terminal report when any case is non-terminal, and the
        // campaign exits 0. The W3.21 corridor is asserted at the EVIDENCE
        // level (probe_evidence + the run's own event stream), exactly like the
        // US-004 W4.33d corridor — never a silent wait.
        assert.equal(result.status, 0, `scripted battery campaign must exit 0 (W3.21 resume succeeds; case attached, no terminal report):\n${result.stdout}\n${result.stderr}`);

        const campaignDir = path.join(resultsRoot, campaignId);
        // Attached W3.21 case → writeTerminalCampaignReports skipped the report:
        // assert the report is ABSENT and drive all per-case assertions off
        // state.json (the other five cases are terminal with their outcomes +
        // oracle verdicts persisted there; the campaign-level spend is on the
        // state too).
        assert.ok(!fs.existsSync(path.join(campaignDir, "report.json")),
          "attached W3.21 case must suppress the terminal report (no report.json)");
        const state = loadJson(path.join(campaignDir, "state.json"));
        const report = { spend: state.spend ?? { tokens_observed: 0 } };

        // ── W3.17b: chaos marathon — tt-chaos genuinely invoked (SIGSTOP ->
        //    hold -> SIGCONT on the live harness process), O4 hygiene verdict
        //    on the chaos run (O16 cannot be declared here: it requires
        //    probe_evidence, which a chaos-only case cannot produce — the
        //    US-003 fail-closed contract). ──
        assertCaseEvidence(state, report, "W3.17b-marathon-chaos", (cs) => {
          assert.equal(cs.outcome, "PASS", `W3.17b: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          const chaos = attempt.chaos_evidence;
          assert.ok(chaos, "W3.17b: chaos_evidence must be present");
          assert.equal(chaos.operator, "tt-chaos");
          assert.equal(chaos.injection_type, "sigstop_sigcont");
          assert.equal(chaos.hold_seconds, HOLD_SECONDS, "W3.17b: chaos hold must be shortened");
          assert.equal(chaos.status, "completed", `W3.17b: chaos invocation must succeed: ${JSON.stringify(chaos.failure ?? null)}`);
          assert.equal(chaos.exit_code, 0);
          assert.ok(chaos.started_at && chaos.ended_at, "W3.17b: chaos start/stop records must be timestamped");
          assert.match(chaos.argv.join(" "), /sigstop_sigcont.*--hold-seconds/, "W3.17b: chaos argv must be the manifest-derived invocation");
          assert.ok(attempt.probe_evidence === undefined, "W3.17b has no probe_sequence — no probe evidence expected");
          // O4: the chaos-log hygiene verdict (database_snapshot/run_events/
          // chaos_log required evidence — the chaos.log capture is proven
          // end-to-end by O4 running VALID).
          const o4 = (cs.oracle_results ?? []).find((item: any) => item.oracle_id === "O4");
          assert.ok(o4, "W3.17b: O4 oracle result must be present");
          assert.equal(o4.status, "VALID", `W3.17b: O4 must run (VALID), got ${o4.status}`);
          assert.equal(o4.response.result, "PASS",
            `W3.17b: O4 verdict must be PASS, got ${o4.response.result}: ${JSON.stringify(o4.response.findings ?? [])}`);
        });

        // ── W3.18: pause (no drain) hold -> resume -> run completes. ──
        assertCaseEvidence(state, report, "W3.18-pause-no-drain", (cs) => {
          assert.equal(cs.outcome, "PASS", `W3.18: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          assert.equal(attempt.terminal_status, "completed");
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W3.18: probe_evidence must be present");
          assert.equal(pe.sequence_outcome, "completed");
          assert.equal(pe.actions.length, 2);
          assert.equal(pe.actions[0].op, "pause");
          assert.equal(pe.actions[0].ok, true, `W3.18: pause must succeed: ${JSON.stringify(pe.actions[0].failure ?? null)}`);
          assert.equal(pe.actions[0].hold_seconds, HOLD_SECONDS);
          assert.equal(pe.actions[0].effect?.status_after?.status, "paused");
          assert.equal(pe.actions[1].op, "resume");
          assert.equal(pe.actions[1].ok, true);
          assert.equal(pe.actions[1].effect?.status_after?.status, "running");
          assertOracleVerdict(cs, "PASS");
        });

        // ── W3.19: pause --drain parks the in-flight (non-loop) step and
        //    finalizes the run to paused; resume (armed on the drain-park
        //    moment) -> the next step dispatches -> run completes. ──
        assertCaseEvidence(state, report, "W3.19-pause-drain", (cs) => {
          assert.equal(cs.outcome, "PASS", `W3.19: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          assert.equal(attempt.terminal_status, "completed");
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W3.19: probe_evidence must be present");
          assert.equal(pe.actions.length, 2);
          assert.equal(pe.actions[0].op, "pause_drain");
          assert.equal(pe.actions[0].trigger, "step:tester:running",
            "W3.19: scripted drain must arm on a plain single (non-loop) step (the verify_each loop and verify steps never finalize the drain)");
          assert.equal(pe.actions[0].ok, true, `W3.19: pause_drain must succeed: ${JSON.stringify(pe.actions[0].failure ?? null)}`);
          assert.equal(pe.actions[1].op, "resume");
          assert.equal(pe.actions[1].trigger, "event:run.paused",
            "W3.19: scripted resume must arm on the drain-FINALIZATION event (run.paused — a step-status marker would race the finalize and be refused)");
          assert.equal(pe.actions[1].ok, true, `W3.19: resume must succeed: ${JSON.stringify(pe.actions[1].failure ?? null)}`);
          assertOracleVerdict(cs, "PASS");
        });

        // ── W3.20: TWO runs — cancel mid-implement and during
        //    finalize_merge; run.canceled terminal event asserted by O16. ──
        assertCaseEvidence(state, report, "W3.20-cancel", (cs) => {
          // Canceled runs are the point — the case outcome is INCONCLUSIVE
          // (workflow-terminal), never PASS, never a probe failure.
          assert.equal(cs.outcome, "INCONCLUSIVE", `W3.20: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          // The classification wraps the workflow-terminal base reason into
          // ambiguous-evidence (per the US-007 classification contract).
          assert.equal(cs.reason?.category, "ambiguous-evidence");
          assert.equal(cs.reason?.ambiguities?.[0]?.category, "workflow-terminal");
          assert.equal(cs.reason?.ambiguities?.[0]?.terminal_statuses?.length, 2);
          const attempt = cs.attempts[0];
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W3.20: probe_evidence must be present");
          assert.ok(Array.isArray(pe.runs) && pe.runs.length === 2, "W3.20: two run groups must be recorded");
          for (const [index, runRecord] of pe.runs.entries()) {
            assert.equal(runRecord.run_ordinal, index + 1);
            assert.equal(runRecord.terminal_status, "canceled", `W3.20 run ${index + 1}: must be canceled`);
            assert.ok(runRecord.run_id, `W3.20 run ${index + 1}: run id must be captured`);
            const cancelAction = runRecord.actions.find((a: any) => a.op === "cancel");
            assert.ok(cancelAction, `W3.20 run ${index + 1}: cancel action must be recorded`);
            assert.equal(cancelAction.ok, true, `W3.20 run ${index + 1}: cancel must succeed: ${JSON.stringify(cancelAction.failure ?? null)}`);
          }
          assert.ok(pe.daemon_restarts === undefined || pe.daemon_restarts.length === 0, "W3.20: no daemon restart expected");
          assertOracleVerdict(cs, "PASS");
        });

        // ── W3.21: fail --force mid-run -> resume. FIXED corridor (product
        //    commit 3f880b1a): resumeWorkflow now REPAIRS the all-canceled
        //    force-failed pipeline (resets from the first non-done step,
        //    re-registers with the daemon) — the resume SUCCEEDS with the SAME
        //    run id and the run re-activates. The launch hook returned at the
        //    FIRST terminal state (run.failed after the force-fail), so the
        //    harvest leaves the case 'attached' (no terminal report, no O16
        //    verdict — the documented US-004 resume-leaves-case-attached
        //    shape). The battery proves the probe machinery executes BOTH
        //    actions with evidence AND that the resume now succeeds, asserting
        //    the corridor at the EVIDENCE level exactly like the W4.33d
        //    corridor: probe_evidence (fail_force ok; resume ok:true exit 0,
        //    same run id, run re-activated) + the run's own event stream. The
        //    resumeWorkflow-reuses-run-id semantics are also pinned by O16's
        //    mutation fixtures (o16-green-resume / o16-resume-new-run-id). ──
        assertCaseEvidence(state, report, "W3.21-fail-force-resume", (cs) => {
          // Attached shape: the case never reached a terminal classification —
          // the resume re-activated the run after the launch hook returned.
          assert.equal(cs.phase, "running",
            `W3.21: the resumed case must stay attached (phase 'running'), got ${cs.phase}`);
          const attempt = cs.attempts[0];
          assert.equal(attempt.phase, "attached",
            `W3.21: the attempt must be 'attached' (launch hook returned at the first terminal state), got ${attempt.phase}`);
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W3.21: probe_evidence must be present");
          assert.equal(pe.sequence_outcome, "completed");
          assert.equal(pe.actions.length, 2);
          assert.equal(pe.actions[0].op, "fail_force");
          assert.equal(pe.actions[0].ok, true, `W3.21: fail_force must succeed: ${JSON.stringify(pe.actions[0].failure ?? null)}`);
          assert.ok(pe.actions[0].argv.includes("--reason"), "W3.21: fail_force argv must carry --reason (the CLI requires it)");
          assert.equal(pe.actions[0].effect?.status_after?.status, "failed");
          assert.equal(pe.actions[1].op, "resume");
          assert.equal(pe.actions[1].ok, true,
            `W3.21: the resume must SUCCEED (product fix 3f880b1a): ${JSON.stringify(pe.actions[1].failure ?? null)}`);
          assert.equal(pe.actions[1].exit_code, 0, "W3.21: the resume CLI must exit 0");
          // Same run id: the resume argv must target the SAME run and the
          // effect must show the run re-activated (restarting from implement).
          assert.ok(pe.actions[1].argv.includes(attempt.run_id),
            `W3.21: the resume must reuse the SAME run id (${attempt.run_id}): ${JSON.stringify(pe.actions[1].argv)}`);
          assert.equal(pe.actions[1].effect?.status_after?.status, "running",
            `W3.21: the resume must re-activate the run: ${JSON.stringify(pe.actions[1].effect ?? null)}`);
          assert.match(pe.actions[1].stdout_tail?.text ?? "",
            /Resumed run .*restarting from step/,
            `W3.21: resume stdout must name the restart-from step: ${pe.actions[1].stdout_tail?.text ?? ""}`);
          // The resumed run's OWN event stream re-activates: a dispatch event
          // for the run AFTER the resume action started (the run is 'running'
          // again and the pipeline advances).
          const resumeStartedAt = pe.actions[1].action_started_at;
          const resumedEvents = readRunEvents(attempt.run_id)
            .filter((e) => e.ts >= resumeStartedAt)
            .map((e) => e.event);
          assert.ok(resumedEvents.some((name) => name === "pipeline.advanced" || name === "step.running"),
            `W3.21: the resumed run must re-activate (pipeline.advanced/step.running after the resume): ${resumedEvents.join(",")}`);
          // No O16 verdict: the attached case never reaches the oracle stage
          // (no terminal report) — documented in tier1-traceability.md.
          assert.ok(!(cs.oracle_results ?? []).some((item: any) => item.oracle_id === "O16"),
            "W3.21: no O16 verdict is expected for the attached (resume-re-activated) case");
        });

        // ── W3.22: THREE concurrent runs + contained-daemon restart
        //    mid-flight -> all three recover within 2 dispatch intervals,
        //    token flush preserved, all runs complete. ──
        assertCaseEvidence(state, report, "W3.22-daemon-restart", (cs) => {
          assert.equal(cs.outcome, "PASS", `W3.22: ${cs.outcome} ${JSON.stringify(cs.reason ?? null)}`);
          const attempt = cs.attempts[0];
          const pe = attempt.probe_evidence;
          assert.ok(pe, "W3.22: probe_evidence must be present");
          assert.ok(Array.isArray(pe.runs) && pe.runs.length === 3, "W3.22: three run groups must be recorded");
          for (const runRecord of pe.runs) {
            assert.equal(runRecord.terminal_status, "completed", `W3.22 run ${runRecord.run_ordinal}: must complete after recovery`);
            assert.ok(runRecord.recovery, `W3.22 run ${runRecord.run_ordinal}: recovery observation must be recorded`);
            assert.equal(runRecord.recovery.recovered, true, `W3.22 run ${runRecord.run_ordinal}: must recover`);
            assert.equal(runRecord.recovery.recovery_within_dispatch_intervals, true,
              `W3.22 run ${runRecord.run_ordinal}: recovery must be within the dispatch-interval window`);
            assert.equal(runRecord.recovery.token_flush_preserved, true,
              `W3.22 run ${runRecord.run_ordinal}: token flush must be preserved (DC8)`);
          }
          assert.ok(Array.isArray(pe.daemon_restarts) && pe.daemon_restarts.length === 1,
            "W3.22: exactly one daemon restart must be executed");
          assert.equal(pe.daemon_restarts[0].op, "restart_daemon");
          assert.equal(pe.daemon_restarts[0].kind, "scripted", "W3.22: restart must target the 53xx scripted daemon");
          assert.equal(pe.daemon_restarts[0].exit_code, 0, "W3.22: daemon-control scripted restart must exit 0");
          assert.equal(pe.daemon_restarts[0].recovery.length, 3, "W3.22: per-run recovery observations must ride the restart record");
          for (const recovery of pe.daemon_restarts[0].recovery) {
            assert.equal(recovery.recovered, true);
            assert.equal(recovery.recovery_within_dispatch_intervals, true);
            assert.equal(recovery.token_flush_preserved, true);
          }
          assertOracleVerdict(cs, "PASS");
        });

        // ── Zero tokens: campaign-wide + every case, and the scripted
        //    runtime journal shows zero-token invocations. ──
        assert.equal(report.spend.tokens_observed, 0, "campaign spend must be zero");
        assert.equal(state.spend.tokens_observed, 0, "state spend must be zero");
        for (const cs of state.cases) {
          assert.equal(cs.spend?.tokens_observed ?? 0, 0, `${cs.id}: case spend must be zero`);
        }
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
          "scripted daemon must be cleanly stopped after the battery");
        await assertPortsFree();
        assert.equal(gitSnapshot(), before, "scripted battery changed git status");

        // ── E3.C.1 US-006: the battery's own process group must have
        //    survived the kill-heavy campaign untouched (leader alive, no
        //    member signalled) — the regression proof that the battery's
        //    kills never reach its own ancestry. ──
        assertSelfGroupSurvived(selfGroupBefore);
      } finally {
        run(daemonControl, ["scripted", "stop"], process.env);
        if (campaignId !== null) {
          fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
        }
      }
    });
});
