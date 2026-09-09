// SGBD 9.1.2 — bounded unreleased scenario startup/cleanup regression
// (focused, tier0). Beads tamandua-6sy.9.1.2.
//
// Actual failure fixed: on the Mac, /bin/ps is denied (EPERM) inside the
// native signal sandbox, so run-scripted-scenario could not read the leader
// starttime/pgid; it CORRECTLY refused to release or signal an unproven
// group, but stop_unreleased_command then waited unconditionally on the
// session-leader wrapper whose detached bash leader looped forever for a
// release marker that could never be created — hours of orphaned waiting,
// no scenario execution, no diagnostics.
//
// What this file proves, and how (E2Ihak evidence layout — kind host /
// kind source / kind case — under torture-test/var/review-logs/<fresh-id>/):
//   1. Decision level (extracted ACTUAL committed leader pre-release block,
//      run with real temp markers and a no-op anchor/guard, NO live process
//      identity reads): the scenario command runs ONLY when the release
//      marker appears; an explicit ABORT marker exits 125 and a missed
//      deadline self-expiration exits 124 — in both cases with ZERO scenario
//      execution (sentinel marker absent) and actionable stderr.
//   2. Real owned-child level (the REAL harness copy + real bash + the real
//      node session-leader wrapper + a real detached session leader + the
//      real disowned anchor): a ps-denial fixture forces the portable ps arm
//      and denies it, exactly like the Mac sandbox denies ps, and asserts
//      the harness finishes within a bounded outer deadline with ZERO
//      scenario execution, an empty invocation-dir residue and a completed
//      daemon-stop cleanup. Leak control is the OWNED bounded
//      self-expiration under test — the abort marker + the leader's
//      self-expiration cap terminate the unreleased session leader and its
//      disowned in-group anchor, and the owned spawnSync/spawn children are
//      reaped by their retained handles — plus a read-only, explicitly
//      supported/unknown leak observation (below; never signals). A small
//      TT_SCENARIO_UNRELEASED_TIMEOUT_S arm proves the leader's
//      self-expiration bounds the teardown even faster, and a WORKING-ps
//      control arm proves the same fixture releases and runs the scenario
//      when identity IS readable (no vacuous denial arm).
//   3. Review-hardening level (SGBD 9.1.2 review pass — the do-again round):
//      (a) the parent proof loop's persistent-identity-unreadability
//      tripwire (a bounded wall-clock grace after the leader publishes
//      readiness) shortens the default ps-denial teardown from the full
//      500-iteration loop (~20 s) to a few seconds — pinned structurally and
//      by the recorded real elapsed time of the denial arms; (b) the
//      disowned anchor treats the abort marker's invocation-dir
//      disappearance as an abort, so an anchor descheduled past the harness
//      cleanup's rm -rf cannot poll out its remaining cap — pinned
//      structurally AND by deterministic real-anchor arms below (dir torn
//      down mid-wait -> prompt exit, plus an abort-present control).
//   4. Recording-only safety level (SGBD-OWN correction — this round): the
//      self-test performs NO process discovery-and-kill. The pre-fix
//      helpers that full-scanned /proc/<pid>/cmdline for the fixture token
//      and signalled every selected pid are REMOVED (a unique substring is
//      NOT ownership, and no process discovered via argv/substring, name,
//      historical PID or unproved group may ever be signalled by this test).
//      The only real signal this file may send is a bounded kill on its OWN
//      retained spawn child handle, and each such kill site is guarded on the
//      child still being live (exitCode === null && signalCode === null), so a
//      child already exited/reaped is never signalled. The remaining process
//      surface is (a) a READ-ONLY, explicitly supported/unknown leak
//      observation used for evidence and a labelled Linux-only bounded
//      self-expiration assertion (never a signal, never a universal zero-leak
//      claim; its clean "none" disposition is returned only over a supported
//      scan whose every listed pid was fully read — unreadable pids yield the
//      explicit "partial-unknown" disposition, a labelled skip never a clean
//      pass) and (b) the deterministic synthetic selection gate in
//      tier0-scenario-unreleased-bounds-safety-gate.test.ts, which exercises
//      the actual committed observation/verdict helpers inside a mocked
//      selection environment with ZERO real signals and ZERO real process
//      queries (unrelated observer that merely mentions the path, changed /
//      missing / reused PID evidence, procfs unavailable).
//
// /proc references below are MACP3 US-003-marked linux-only prose, the
// structural pins on the committed harness's own guarded /proc identity
// arms, or the read-only leak observation (explicit supported/unknown;
// degrades to "unsupported" on a /proc-less host; never signals); no
// product process-identity function is changed.
//
// Honesty note (Linux host): this host HAS /proc, so the denial fixture
// NEUTRALIZES the /proc arm in a COPY of the harness to force the portable
// ps arm — the same situation a Darwin host has natively (no /proc at all)
// — and then denies ps with a PATH shim (exit 1, like the Mac EPERM). This
// fixture does NOT claim to be native Darwin; the unpatched committed
// harness keeps its real Linux /proc semantics (pinned structurally below),
// and real Mac validation is coordinator-owned.
//
// No real providers, control ports, or default-port binds; the fixture daemon
// is a recording stub. Self-contained; auto-discovered by self-tests/run.sh's
// fast tier0 glob; leaves git status clean (evidence under gitignored var/).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const libDir = path.join(ttRoot, "scenarios", "lib");
const harness = path.join(libDir, "run-scripted-scenario");
const anchor = path.join(libDir, "scenario-group-anchor.sh");
const wrapper = path.join(libDir, "session-leader-spawn.mjs");
const REVIEW_ROOT = path.join(ttRoot, "var", "review-logs");
const BASH = "/bin/bash";

const sha256 = (x: string): string =>
  crypto.createHash("sha256").update(x).digest("hex");

/** Env for spawned snippets: strip NODE_TEST_CONTEXT (node:test auto-
 *  activates the isolation guard in every child) and disable the guard —
 *  these children touch temp dirs and real processes only, never tamandua
 *  state or production ports. */
function cleanEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.TAMANDUA_TEST_GUARD = "0";
  if (extra) Object.assign(env, extra);
  return env;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

/** spawnSync wrapper with an outer deadline: timedOut=true when the deadline
 *  fired (the child was killed) — the bounded-interval proof needs a NON-null
 *  status. */
function runBounded(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): RunResult {
  const start = Date.now();
  const res = spawnSync(file, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - start;
  const timedOut = res.error !== undefined && (res.error as { code?: string }).code === "ETIMEDOUT";
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
    timedOut,
    elapsedMs,
  };
}

const created: string[] = [];

// ── fixture builder (recording stubs; no real daemon, no real ports) ────
function makeFixture(commandBody: string, extraEnv: NodeJS.ProcessEnv): {
  root: string;
  scenario: string;
  stateRoot: string;
  daemonCalls: string;
  env: NodeJS.ProcessEnv;
} {
  const root = path.join(varRoot, `scenario-unreleased-test-${crypto.randomUUID()}`);
  const scenario = path.join(root, "scenario");
  const tools = path.join(root, "tools");
  const stateDir = path.join(root, "home-scripted", ".tamandua");
  const stateRoot = path.join(root, "scenario-state");
  const daemonCalls = path.join(root, "daemon-calls.log");
  fs.mkdirSync(scenario, { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  created.push(root);

  fs.writeFileSync(path.join(scenario, "scenario.json"), JSON.stringify({
    schema_version: 1,
    id: "self-test",
    workflow_base: "do-now",
    behaviors: "behaviors.json",
    command: "run.sh",
    expected_outcome: "completed",
    oracles: ["O1", "O3z", "O11"],
  }, null, 2));
  fs.writeFileSync(path.join(scenario, "behaviors.json"), JSON.stringify({
    agents: { doer: { output: "STATUS: done\nREPORT: unreleased-bounds self-test", tokens: 0 } },
    heartbeatTokens: 0,
    defaultTokens: 0,
  }, null, 2));
  fs.writeFileSync(
    path.join(scenario, "run.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
# Zero-executed-command sentinel: any execution of the scenario command
# (released OR buggy) writes this marker; the denial arms assert it ABSENT.
[ "\${TT_SCENARIO_COMMAND_GROUP_PROVEN:-}" = 1 ] || exit 98
printf '%s\\n' executed >"\${TT_TEST_EXECUTED_MARKER:?}"
${commandBody}
`,
    { mode: 0o755 },
  );

  const envScript = path.join(tools, "tt-env-scripted.sh");
  fs.writeFileSync(
    envScript,
    `#!/usr/bin/env bash
export TT_REPO_ROOT='${repoRoot}'
export TT_ROOT='${root}'
export TT_SCRIPTED_HOME='${root}/home-scripted'
export HOME="$TT_SCRIPTED_HOME"
export TAMANDUA_STATE_DIR='${stateDir}'
export TAMANDUA_CONTROL_PORT=5339
export TAMANDUA_MCP_PORT=5338
export TAMANDUA_DASHBOARD_PORT=5334
export PATH='${process.env.PATH ?? "/usr/bin:/bin"}'
printf '%s\\n' \\
  'TT_REPO_ROOT=${repoRoot}' \\
  'TT_ROOT=${root}' \\
  'TT_SCRIPTED_HOME=${root}/home-scripted' \\
  'HOME=${root}/home-scripted' \\
  'TAMANDUA_STATE_DIR=${stateDir}' \\
  'TAMANDUA_CONTROL_PORT=5339' \\
  'TAMANDUA_MCP_PORT=5338' \\
  'TAMANDUA_DASHBOARD_PORT=5334' \\
  'PATH=${process.env.PATH ?? "/usr/bin:/bin"}'
`,
    { mode: 0o755 },
  );

  const daemon = path.join(tools, "daemon-control");
  fs.writeFileSync(
    daemon,
    `#!/usr/bin/env bash
set -eu
[ "$1" = scripted ] || { echo 'non-scripted daemon kind' >&2; exit 91; }
printf '%s|%s|%s|%s\\n' "$1" "$2" "\${TAMANDUA_SCRIPTED_BEHAVIORS:-}" "$HOME" >>"${daemonCalls}"
case "$2" in
  start|restart|stop) exit 0 ;;
  status) echo 'STATUS: RUNNING'; exit 0 ;;
  reset-state)
    rm -rf -- '${stateDir}'
    mkdir -p '${stateDir}'
    echo 'STATUS: RESET_STATE_OK'
    exit 0 ;;
  *) exit 92 ;;
esac
`,
    { mode: 0o755 },
  );

  const installer = path.join(tools, "install-scenario-workflows");
  fs.writeFileSync(
    installer,
    `#!/usr/bin/env bash
set -euo pipefail
base="$1"; invocation="$2"
dst="$TAMANDUA_STATE_DIR/workflows/$base-$invocation"
mkdir -p "$dst"
printf 'id: %s-%s\\nagents:\\n  - id: doer\\n' "$base" "$invocation" >"$dst/workflow.yml"
printf '{"%s-%s_doer":{}}\\n' "$base" "$invocation"
`,
    { mode: 0o755 },
  );

  const cli = path.join(tools, "tamandua");
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = 'workflow install' ] && [ "$3" = '--all' ]; then
  # Catalog install stub: the harness only requires exit 0 + the log; the
  # scenario workflow copy is created by the installer stub below.
  mkdir -p "$TAMANDUA_STATE_DIR/workflows"
  : >"$TAMANDUA_STATE_DIR/workflows/.catalog-ok"
  exit 0
fi
exit 93
`,
    { mode: 0o755 },
  );

  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    TT_SCENARIO_TEST_MODE: "1",
    TT_SCENARIO_DAEMON_CONTROL: daemon,
    TT_SCENARIO_INSTALLER: installer,
    TT_SCENARIO_ENV: envScript,
    TT_SCENARIO_CLI: cli,
    TT_SCENARIO_VAR_ROOT: stateRoot,
    ...extraEnv,
  };
  return { root, scenario, stateRoot, daemonCalls, env };
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function assertNoStateResidue(stateRoot: string): void {
  if (!fs.existsSync(stateRoot)) return;
  const residue = fs.readdirSync(stateRoot, { recursive: true });
  assert.deepEqual(residue, [], `scenario state residue: ${residue.join(", ")}`);
}

// ── read-only leak observation (MACP3 US-003 linux-only; SGBD-OWN) ─────
// SGBD-OWN correction: the pre-fix helpers performed a full /proc cmdline
// substring search and then SIGNALLED each selected numeric pid with NO
// ownership/birth validation (root probe sha 4ebd95b5…: a synthetic
// unrelated readonly observer whose argv merely mentioned the fixture
// directory was selected and a SIGTERM recorded). A unique substring is NOT
// ownership, so that process-discovery-and-kill behavior is REMOVED
// entirely: this self-test never signals a process discovered via
// argv/fixture substring, name, historical PID or unproved group, and its
// only real signal surface is the bounded kill on its OWN retained spawn
// child handle in the anchor describe below, each site guarded on the child
// still being live (exitCode === null && signalCode === null) so a child
// already exited/reaped is never signalled. What
// remains is READ-ONLY:
//   * observeFixtureHolders() — a linux-only /proc cmdline substring
//     OBSERVATION used only as evidence and for a labelled bounded
//     self-expiration assertion. It never signals. On a procfs-less host it
//     reports { supported:false } — an explicit "unknown observation",
//     which is NEVER reinterpreted as clean. Pids whose cmdline cannot be
//     read are counted (unreadable), never treated as matches and never
//     treated as clean.
//   * leakVerdict() — the pure disposition of an observation (never
//     signals): "none" is a CLEAN claim returned only for a supported
//     observation whose every listed pid was fully read (unreadable === 0)
//     and matched nothing; a supported observation with unreadable pids and
//     no match is "partial-unknown" — no-holder over partially-unknown
//     evidence, a labelled inconclusive disposition never a clean pass; a
//     substring match alone is "observed-unowned" — never ownership, never
//     a signal; the observation is retained as evidence for review.
// The procfs access is injectable (the `proc` argument), so the recording-
// only safety gate (tier0-scenario-unreleased-bounds-safety-gate.test.ts)
// runs these ACTUAL committed functions inside a mocked selection
// environment with ZERO real signals and ZERO real process queries
// (unrelated observer mentions path / changed / missing / reused PID
// evidence / procfs unavailable). The SGBD_OBSERVER markers below delimit
// the extracted contract — keep them stable.
interface ProcfsLike {
  /** Numeric pid directory names under the procfs mount, or null when the
   *  mount is unavailable (procfs-less host). null is "unsupported", never
   *  an empty observation. */
  listPids(): string[] | null;
  /** Raw cmdline text for a pid, or null when it cannot be read (process
   *  vanished mid-scan / unreadable). null is never treated as a match. */
  readCmdline(pid: string): string | null;
}

function realProcfs(): ProcfsLike {
  return {
    listPids(): string[] | null {
      let entries: string[];
      try {
        entries = fs.readdirSync("/proc");
      } catch {
        return null; // procfs-less host: observation unsupported
      }
      return entries.filter((e) => /^\d+$/.test(e));
    },
    readCmdline(pid: string): string | null {
      try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      } catch {
        return null; // vanished or unreadable mid-scan
      }
    },
  };
}

interface LeakObservation {
  /** true only when the procfs observation was available and read. */
  supported: boolean;
  /** Live pids whose cmdline contains the fixture token (substring match —
   *  evidence only, never ownership). */
  matched: number[];
  /** Listed pids whose cmdline could not be read (missing/unreadable
   *  evidence — recorded, never interpreted as clean; any unreadable pid
   *  makes a clean "none" claim impossible, yielding "partial-unknown"). */
  unreadable: number;
}

/** Disposition of a leak observation (see leakVerdict). "none" is the ONLY
 *  clean claim and is returned exclusively over a supported observation whose
 *  every listed pid was fully read (unreadable === 0) and matched nothing —
 *  never over partially-unknown evidence. */
type LeakVerdict = "unsupported" | "none" | "partial-unknown" | "observed-unowned";

// SGBD_OBSERVER_START
function observeFixtureHolders(token: string, proc: ProcfsLike): LeakObservation {
  const pids = proc.listPids();
  if (pids === null) return { supported: false, matched: [], unreadable: 0 };
  const matched: number[] = [];
  let unreadable = 0;
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    const cmd = proc.readCmdline(entry);
    if (cmd === null) {
      unreadable += 1; // vanished mid-scan / unreadable — unknown, not clean
      continue;
    }
    if (cmd.includes(token)) matched.push(Number(entry));
  }
  return { supported: true, matched, unreadable };
}

/** Pure disposition of a leak observation (never signals). "none" is a CLEAN
 *  claim: it is returned only when the supported scan matched nothing AND
 *  every listed pid was fully read (unreadable === 0). A supported scan with
 *  unreadable pids and no match is "partial-unknown" — never clean. */
function leakVerdict(obs: LeakObservation): LeakVerdict {
  if (!obs.supported) return "unsupported";
  if (obs.matched.length > 0) return "observed-unowned";
  if (obs.unreadable > 0) return "partial-unknown";
  return "none";
}
// SGBD_OBSERVER_END

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded read-only settle (never signals, never a synchronous busy loop):
 *  re-observe until no live process holds the unique fixture token — the
 *  owned bounded self-expiration (abort marker + cap + dir teardown)
 *  completing — up to a short grace. Returns every observation taken plus
 *  the final disposition: "none" (clean) only over a fully-read supported
 *  scan (unreadable === 0); "partial-unknown" when unreadable pids remain;
 *  "unsupported" on a procfs-less host — both of the latter are explicit,
 *  never reinterpreted as clean. */
async function settleLeakObservation(
  token: string,
  proc: ProcfsLike,
  graceMs = 4000,
): Promise<{ scans: LeakObservation[]; verdict: LeakVerdict }> {
  const scans: LeakObservation[] = [];
  const deadline = Date.now() + graceMs;
  let obs: LeakObservation = { supported: true, matched: [], unreadable: 0 };
  do {
    obs = observeFixtureHolders(token, proc);
    scans.push(obs);
    if (!obs.supported || obs.matched.length === 0) break;
    await sleep(100);
  } while (Date.now() < deadline);
  return { scans, verdict: leakVerdict(obs) };
}

// ── evidence retention (fresh dir per run; never deleted) ───────────────
let evidenceDir = "";
let runLogPath = "";
let evidenceLines: string[] = [];
let sourceSha = "";
let leaderProgramSha = "";
let anchorSha = "";

function writeEvidence(): void {
  fs.mkdirSync(REVIEW_ROOT, { recursive: true });
  const id = crypto.randomBytes(6).toString("hex");
  evidenceDir = path.join(REVIEW_ROOT, `sgbd-9-1-2-unreleased-bounds-${id}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const bashVersion = execFileSync(BASH, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
  const workingTreeStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const pin = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  evidenceLines.unshift(
    JSON.stringify({
      kind: "host",
      platform: process.platform,
      node: process.version,
      bash: bashVersion,
      pin,
      working_tree_status: workingTreeStatus,
      execution:
        "SGBD 9.1.2 focused tier0 gate: extracted-leader-block decision matrix + " +
        "real owned-child ps-denial/self-expiration regressions with bounded outer " +
        "deadlines and a zero-executed-command sentinel; Linux /proc semantics retained " +
        "in the committed harness (the denial copy neutralizes the /proc arm to force the " +
        "portable ps arm — NOT a claim of native Darwin)",
    }),
    JSON.stringify({
      kind: "source",
      pin,
      file: "torture-test/scenarios/lib/run-scripted-scenario",
      sha256: sourceSha,
      leader_pre_release_block_sha256: leaderProgramSha,
      anchor_sha256: anchorSha,
    }),
  );
  fs.writeFileSync(path.join(evidenceDir, "evidence.jsonl"), evidenceLines.join("\n") + "\n");
  runLogPath = path.join(evidenceDir, "run.log");
  fs.writeFileSync(runLogPath, `command: ${process.argv.join(" ")}\ncwd: ${process.cwd()}\npin: ${pin}\nevidence: ${evidenceDir}\n`);
  process.once("exit", (code) => {
    try {
      fs.appendFileSync(runLogPath, `node_test_real_exit: ${code}\n`);
    } catch {
      // best-effort at process exit
    }
  });
}

function recordCase(c: Record<string, unknown>): void {
  evidenceLines.push(JSON.stringify({ kind: "case", ...c }));
}

// ── decision-level helpers ──────────────────────────────────────────────

/** Extract the ACTUAL committed leader pre-release bash program (the text of
 *  the `bash -c '<program>'` session-leader child) from the harness. */
function extractLeaderProgram(source: string): string {
  const marker = `"$BASH_BIN" -c '`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "harness must launch the leader via bash -c");
  const progStart = start + marker.length;
  const endMarker = `' scripted-scenario-command `;
  const end = source.indexOf(endMarker, progStart);
  assert.ok(end >= 0, "leader program terminator not found");
  return source.slice(progStart, end);
}

function makeShim(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

// ── describe: structural pins ────────────────────────────────────────────
describe("SGBD 9.1.2 — bounded unreleased startup/cleanup (structural)", () => {
  it("the committed harness carries the bounded abort/cap leader wait and the abort marker plumbing", () => {
    const source = fs.readFileSync(harness, "utf8");
    const anchorSource = fs.readFileSync(anchor, "utf8");
    // The unbounded historical wait is GONE from the leader pre-release block.
    assert.doesNotMatch(source, /while \[ ! -f "\$release_file" \]; do sleep 0\.01; done/,
      "the unbounded release-marker wait must be removed");
    // The bounded replacement watches release OR abort and has an expiry cap.
    assert.match(source, /while \[ ! -e "\$release_file" \] && \[ ! -e "\$abort_file" \]/,
      "the leader wait must watch the release AND the abort marker");
    assert.match(source, /TT_SCENARIO_UNRELEASED_TIMEOUT_S/, "the cap must be env-configurable");
    assert.match(source, /COMMAND_ABORT_FILE/, "the harness must define/plumb the abort marker");
    assert.match(source, /exit 125/, "explicit abort must exit 125 without running the scenario");
    assert.match(source, /exit 124/, "self-expiration must exit 124 without running the scenario");
    assert.match(source, /"\$COMMAND_ANCHOR_PID_FILE" "\$COMMAND_ABORT_FILE"/,
      "the abort file must be passed to the leader and forwarded to the anchor");
    // The anchor watches the abort marker and shares the cap.
    assert.match(anchorSource, /abort_file="\$\{3:-\}"/, "the anchor must accept the abort file");
    assert.match(anchorSource, /TT_SCENARIO_UNRELEASED_TIMEOUT_S/, "the anchor must share the cap env");
    // SGBD 9.1.2 review hardening (a): the parent proof loop carries the
    // persistent-identity-unreadability tripwire — a bounded wall-clock
    // grace that starts only once the leader publishes its ready file.
    assert.match(source, /_ready_first_seen_s=/, "the proof loop must track first readiness for the unreadability grace");
    assert.match(source, /_unreadable_grace_s=5/, "the unreadability grace must be a bounded constant");
    assert.match(source, /\[ -n "\$_ready_first_seen_s" \] && \[ -z "\$COMMAND_STARTTIME" \]/,
      "the trip must require readiness seen AND identity still unreadable");
    // SGBD 9.1.2 review hardening (b): the anchor treats the abort marker's
    // invocation-dir disappearance as an abort (pre-release the dir must
    // exist, so its removal means the harness tore the cell down).
    assert.match(anchorSource, /_abort_dir=/, "the anchor must track the abort marker dir");
    assert.match(anchorSource, /\[ ! -d "\$_abort_dir" \]/, "the anchor must treat marker-dir disappearance as abort");
    // Linux /proc identity semantics are retained in the committed harness.
    assert.match(source, /\[ -r "\/proc\/\$pid\/stat" \]/, "the /proc identity arm must remain in the harness");
  });

  it("stop_unreleased_command publishes the abort marker only before release (structural)", () => {
    const source = fs.readFileSync(harness, "utf8");
    assert.match(source, /\[ ! -e "\$COMMAND_RELEASE_FILE" \]/, "abort publish must be gated on release absence");
    assert.match(source, /: >"\$COMMAND_ABORT_FILE"/, "the abort marker publish must not touch the release marker");
  });
});

// ── describe: extracted-leader decision matrix (recording, real temp
//    files, NO live identity reads — only real bash + temp markers) ──────
describe("SGBD 9.1.2 — extracted leader pre-release block decisions", () => {
  let source = "";
  let program = "";
  let guardFile = "";
  let fakeAnchor = "";
  let commandShim = "";
  let fixtureTmp = "";

  before(() => {
    source = fs.readFileSync(harness, "utf8");
    sourceSha = sha256(source);
    anchorSha = sha256(fs.readFileSync(anchor, "utf8"));
    program = extractLeaderProgram(source);
    leaderProgramSha = sha256(program);
    fixtureTmp = fs.mkdtempSync(path.join(os.tmpdir(), "sgbd-leader-"));
    // NOT in the shared `created` list: the top-level afterEach runs after
    // EVERY it() and would delete this describe's shared dir mid-describe.
    // A describe-local after() removes it once all decision tests are done.
    // No-op containment guard (this block's source is not under test here).
    guardFile = path.join(fixtureTmp, "guard.sh");
    fs.writeFileSync(guardFile, "# SGBD test no-op containment guard\n");
    fakeAnchor = makeShim(fixtureTmp, "fake-anchor.sh",
      'printf "%s\\n" "$$" >"$1" 2>/dev/null\nsleep 0.05\nexit 0');
    commandShim = path.join(fixtureTmp, "scenario-command.sh");
  });

  function runLeader(
    env: NodeJS.ProcessEnv,
    opts: { preRelease?: boolean; preAbort?: boolean; timeoutS?: string },
    timeoutMs: number,
  ): RunResult {
    const ready = path.join(fixtureTmp, `ready-${crypto.randomUUID()}`);
    const release = path.join(fixtureTmp, `release-${crypto.randomUUID()}`);
    const abort = path.join(fixtureTmp, `abort-${crypto.randomUUID()}`);
    const anchorPid = path.join(fixtureTmp, `anchor-pid-${crypto.randomUUID()}`);
    const execMarker = path.join(fixtureTmp, `exec-${crypto.randomUUID()}`);
    fs.writeFileSync(commandShim, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' ran >"${execMarker}"\nexit 0\n`, { mode: 0o755 });
    if (opts.preRelease) fs.writeFileSync(release, "released\n");
    if (opts.preAbort) fs.writeFileSync(abort, "aborted\n");
    const leaderEnv = cleanEnv({
      TT_SCENARIO_CONTAINMENT_GUARD: guardFile,
      BASH_BIN: BASH,
      TT_SCENARIO_ANCHOR: fakeAnchor,
      ...(opts.timeoutS ? { TT_SCENARIO_UNRELEASED_TIMEOUT_S: opts.timeoutS } : {}),
      ...env,
    });
    const result = runBounded(
      BASH,
      ["--noprofile", "--norc", "-c", program, "scripted-scenario-command", ready, release, commandShim, anchorPid, abort],
      leaderEnv,
      timeoutMs,
    );
    return {
      ...result,
      // Tag the case result with the exec marker state for the caller.
      stdout: `${result.stdout}__EXEC_MARKER_EXISTS__${fs.existsSync(execMarker)}`,
    };
  }

  it("release marker -> the scenario command runs (exit 0, sentinel present)", () => {
    const result = runLeader({}, { preRelease: true }, 8000);
    assert.equal(result.status, 0, `expected exit 0 on release\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /__EXEC_MARKER_EXISTS__true/, "the scenario command must run when released");
    recordCase({
      scenario: "leader_release_runs_command",
      exit: result.status,
      executed: true,
      stderr: result.stderr.trim(),
    });
  });

  it("abort marker -> exit 125, scenario code NEVER runs (zero-execution sentinel)", () => {
    const result = runLeader({}, { preAbort: true }, 8000);
    assert.equal(result.status, 125, `expected abort exit 125\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /__EXEC_MARKER_EXISTS__false/, "abort must NEVER execute the scenario command");
    assert.match(result.stderr, /aborted by the harness/, "the abort must be actionable on stderr");
    recordCase({
      scenario: "leader_abort_no_execution",
      exit: result.status,
      executed: false,
      stderr: result.stderr.trim(),
    });
  });

  it("self-expiration (tiny cap, no markers) -> exit 124, scenario code NEVER runs", () => {
    const result = runLeader({}, { timeoutS: "1" }, 10000);
    assert.equal(result.status, 124, `expected expiry exit 124\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /__EXEC_MARKER_EXISTS__false/, "expiry must NEVER execute the scenario command");
    assert.match(result.stderr, /pre-release wait expired/, "the expiry must be actionable on stderr");
    assert.ok(result.elapsedMs < 9000, `expiry must be bounded (elapsed ${result.elapsedMs} ms)`);
    recordCase({
      scenario: "leader_expiry_no_execution",
      exit: result.status,
      executed: false,
      elapsed_ms: result.elapsedMs,
      stderr: result.stderr.trim(),
    });
  });

  after(() => {
    if (fixtureTmp) fs.rmSync(fixtureTmp, { recursive: true, force: true });
  });
});

// ── describe: real owned-child regressions ───────────────────────────────
describe("SGBD 9.1.2 — real owned-child missing-identity regressions", () => {
  /** Copy the committed harness, point LIB_DIR at the real scenarios/lib,
   *  and (denial arms only) neutralize BOTH /proc identity guards so the
   *  portable ps arm is the one consulted — a Darwin host has no /proc at
   *  all, so this forces the same code path; the real /proc semantics stay
   *  in the committed harness (structural pin above). */
  function patchedHarness(root: string, neutralizeProc: boolean): string {
    const source = fs.readFileSync(harness, "utf8");
    const libLine = 'LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"';
    assert.ok(source.includes(libLine));
    let copy = source.replace(libLine, `LIB_DIR="${libDir}"`);
    if (neutralizeProc) {
      const procGuard = '[ -r "/proc/$pid/stat" ]';
      const occurrences = copy.split(procGuard).length - 1;
      assert.equal(occurrences, 2, `expected exactly two /proc identity guards, found ${occurrences}`);
      copy = copy.split(procGuard).join("false");
      assert.ok(copy.includes("if false; then"), "the denial copy must disable both /proc identity arms");
    }
    const p = path.join(root, `run-scripted-scenario-${neutralizeProc ? "denied" : "control"}`);
    fs.writeFileSync(p, copy, { mode: 0o755 });
    return p;
  }

  async function runDenialCase(opts: { timeoutS?: string; deny: boolean; tag: string; outerMs: number }): Promise<void> {
    const root = path.join(varRoot, `scenario-unreleased-run-${crypto.randomUUID()}`);
    fs.mkdirSync(root, { recursive: true });
    created.push(root);
    const marker = path.join(root, "executed.marker");
    const shimDir = path.join(root, "ps-shim");
    fs.mkdirSync(shimDir, { recursive: true });
    if (opts.deny) {
      // ps DENIAL fixture (Mac native-sandbox EPERM simulation): ps exits 1
      // and prints nothing, so process_starttime/process_group yield EMPTY —
      // identity unknown, exactly like the Mac denial. NOT native Darwin.
      makeShim(shimDir, "ps", 'echo "ps: operation not permitted (SGBD fixture)" >&2\nexit 1');
    } else {
      // WORKING ps control: honest Linux /proc semantics served through the
      // ps interface — pgid = stat field 3, a stable per-pid lstart token =
      // stat field 22 (the same fields the harness's own /proc arm reads).
      makeShim(shimDir, "ps", `#!/bin/sh
want_lstart=0
pid=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-p" ]; then pid="$a"; fi
  if [ "$a" = "lstart=" ]; then want_lstart=1; fi
  prev="$a"
done
[ -n "$pid" ] || exit 1
[ -r "/proc/$pid/stat" ] || exit 1
stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || exit 1
rest="\${stat##*) }"
set -- $rest
if [ "$want_lstart" = "1" ]; then
  printf 'ps-lstart-%s\\n' "\${20:-}"
else
  printf '%s\\n' "\${3:-}"
fi
`);
    }
    const fixture = makeFixture("exit 0", {
      PATH: `${shimDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TT_TEST_EXECUTED_MARKER: marker,
      ...(opts.timeoutS ? { TT_SCENARIO_UNRELEASED_TIMEOUT_S: opts.timeoutS } : {}),
    });
    const harnessCopy = patchedHarness(fixture.root, opts.deny);
    const result = runBounded(harnessCopy, [fixture.scenario], fixture.env, opts.outerMs);
    const executed = fs.existsSync(marker);
    const residue = fs.existsSync(fixture.stateRoot)
      ? fs.readdirSync(fixture.stateRoot, { recursive: true })
      : [];
    const daemonOps = fs.existsSync(fixture.daemonCalls)
      ? fs.readFileSync(fixture.daemonCalls, "utf8").trim().split("\n").map((l) => l.split("|")[1])
      : [];

    // SGBD-OWN: NO process discovery-and-kill here. The owned harness child
    // was reaped by runBounded (spawnSync); the bounded self-expiration
    // under test terminates the unreleased leader and its disowned anchor.
    // Take a bounded READ-ONLY leak observation (explicit supported/unknown;
    // never signals) so a genuinely lingering holder trips a labelled
    // assertion with the evidence retained instead of being killed.
    const leak = await settleLeakObservation(fixture.root, realProcfs());

    const base: Record<string, unknown> = {
      scenario: opts.tag,
      deny: opts.deny,
      timeout_s: opts.timeoutS ?? "default(20)",
      real_harness_exit: result.status,
      timed_out: result.timedOut,
      elapsed_ms: result.elapsedMs,
      executed_command_sentinel: executed,
      state_residue: residue,
      daemon_stop_recorded: daemonOps.includes("stop"),
      process_signals_sent_by_test: 0,
      leak_observation: {
        verdict: leak.verdict,
        scans: leak.scans.map((s) => ({ supported: s.supported, matched: s.matched, unreadable: s.unreadable })),
        note:
          "read-only observation only; a cmdline substring match is NOT ownership and no observed pid was ever signalled (SGBD-OWN)",
      },
      stderr_tail: result.stderr.slice(-2000),
      stdout_tail: result.stdout.slice(-2000),
    };

    // Fail-closed labelling BEFORE the case is recorded: a tripped assertion
    // below must still leave a durable case row (verdict and scans included)
    // in evidence.jsonl, so recordCase runs now — never after the assertions.
    // "unsupported" (procfs-less host) and "partial-unknown" (a supported
    // scan with unreadable pids that matched nothing) are labelled skips: no
    // clean no-holder claim is ever made over unavailable or partially-unknown
    // evidence (a clean "none" requires every listed pid fully read,
    // unreadable === 0).
    const leakObs = base.leak_observation as Record<string, unknown>;
    if (leak.verdict === "unsupported") {
      leakObs.skip_reason =
        "procfs observation unavailable on this host; bounded completion / zero-execution assertions above carry the proof (no clean claim made)";
    } else if (leak.verdict === "partial-unknown") {
      leakObs.skip_reason =
        "observation includes unreadable cmdlines (unknown pids), so no clean no-holder claim is possible; labelled inconclusive — bounded completion / zero-execution assertions above carry the proof (never a clean pass)";
    }
    recordCase(base);

    if (opts.deny) {
      // The DENIAL arms: bounded, zero execution, no residue, cleanup ran.
      assert.equal(result.timedOut, false, `${opts.tag}: harness must finish before the outer deadline\n${result.stderr}`);
      assert.notEqual(result.status, null, `${opts.tag}: harness must not hang (outer deadline fired)`);
      assert.notEqual(result.status, 0, `${opts.tag}: a refused pre-release proof must fail the harness`);
      assert.equal(executed, false, `${opts.tag}: scenario command must NEVER execute under ps denial`);
      assert.deepEqual(residue, [], `${opts.tag}: no invocation residue after bounded teardown`);
      assert.ok(daemonOps.includes("stop"), `${opts.tag}: cleanup must run the recorded daemon stop`);
      // Leak control is the OWNED bounded self-expiration: the harness
      // exited on its own within the cap (asserted above). The read-only
      // observation is a labelled Linux-only regression trip over CLEANLY-READ
      // evidence only: a genuine leaked child of THIS test is same-uid and
      // therefore readable, so it can never hide behind unreadable pids — it
      // surfaces as "observed-unowned" and trips the assert below with the
      // observed pids retained as evidence (never signalled). "unsupported"
      // and "partial-unknown" were labelled skip_reason above — never a clean
      // pass — and "none" is a clean pass that by construction rests on a
      // fully-read supported scan (unreadable === 0 by definition of "none").
      if (leak.verdict !== "unsupported" && leak.verdict !== "partial-unknown") {
        assert.equal(
          leak.verdict,
          "none",
          `${opts.tag}: a live process still holds the fixture token after the bounded grace (self-expiration regression): scans ${JSON.stringify(
            leak.scans.map((s) => ({ matched: s.matched, unreadable: s.unreadable })),
          )} — retained as evidence, NO signal sent (SGBD-OWN)`,
        );
      }
      assert.match(
        result.stderr,
        /could not prove the scenario command process group before release|could not determine the scenario command leader pid|pre-release wait expired|aborted by the harness/,
        `${opts.tag}: the failure must be actionable\n${result.stderr}`,
      );
      assert.ok(result.elapsedMs < opts.outerMs, `${opts.tag}: bounded interval (elapsed ${result.elapsedMs} ms)`);
    } else {
      // The CONTROL arm: identity readable -> release -> scenario RUNS.
      assert.equal(result.timedOut, false, `${opts.tag}: control arm must finish\n${result.stderr}`);
      assert.equal(result.status, 0, `${opts.tag}: control harness must succeed\n${result.stdout}\n${result.stderr}`);
      assert.equal(executed, true, `${opts.tag}: control arm must execute the scenario command`);
      assert.deepEqual(residue, [], `${opts.tag}: control arm leaves no residue`);
      // Same labelled leak trip as the denial arm: clean "none" only over a
      // fully-read supported scan; "unsupported"/"partial-unknown" were
      // labelled skip_reason above; "observed-unowned" fails with its scans
      // retained.
      if (leak.verdict !== "unsupported" && leak.verdict !== "partial-unknown") {
        assert.equal(
          leak.verdict,
          "none",
          `${opts.tag}: a live process still holds the fixture token after the bounded grace: scans ${JSON.stringify(
            leak.scans.map((s) => ({ matched: s.matched, unreadable: s.unreadable })),
          )} — retained as evidence, NO signal sent (SGBD-OWN)`,
        );
      }
    }
  }

  it("ps-denial (default cap): bounded failure, zero execution, no indefinite wait, no lingering holder", async () => {
    // Review hardening (a): the parent proof loop now carries the
    // persistent-unreadability tripwire — once the leader publishes
    // readiness, ~5 s of still-unreadable identity hands the teardown to
    // stop_unreleased_command (abort marker) instead of burning the full
    // 500-iteration loop (~20 s+ under a denying ps on this host). The
    // outer deadline stays generous for slower hosts; the evidence records
    // the real elapsed time. The fix under test is that the harness EXITS
    // on its own (timedOut false, non-null status) instead of waiting
    // forever, with zero execution and no lingering holder of the fixture
    // paths (bounded self-expiration; read-only labelled observation — the
    // test sends no signals and performs no process discovery-and-kill).
    await runDenialCase({ deny: true, tag: "denial_default_cap", outerMs: 120000 });
  });

  it("ps-denial with a tiny self-expiration cap bounds the teardown even sooner", async () => {
    await runDenialCase({ deny: true, timeoutS: "2", tag: "denial_tiny_cap", outerMs: 20000 });
  });

  it("control: same patched fixture with WORKING ps identity releases and runs the scenario", async () => {
    await runDenialCase({ deny: false, tag: "control_working_ps", outerMs: 30000 });
  });
});

// ── describe: review-hardening (b) — the disowned anchor's abort-tail ────
// Real scenario-group-anchor.sh + real bash + real temp markers. NO live
// identity reads and no signals: the anchor is a plain bash process that
// polls marker files, so these arms are recording-style and deterministic.
// Default TT_SCENARIO_UNRELEASED_TIMEOUT_S = 20 (cap 20 s): an anchor that
// fails to observe either the abort marker or its dir's disappearance would
// sit for the whole cap, which the outer assert (well under the cap) would
// fail — so the arms are non-vacuous.
describe("SGBD 9.1.2 review (b) — disowned anchor closes the abort-dir tail", () => {
  /** Spawn the REAL anchor over temp markers; optionally tear the marker dir
   *  down mid-wait (the harness cleanup pattern) or pre-publish the abort
   *  marker (control). Resolves with the exit code and elapsed time; kills
   *  the anchor if it does not exit on its own within outerMs. */
  function runAnchor(opts: { removeDir: boolean; preAbort: boolean }, outerMs: number): Promise<{
    code: number | null;
    elapsedMs: number;
  }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sgbd-anchor-"));
    const pidFile = path.join(dir, "anchor.pid");
    const releaseFile = path.join(dir, "release");
    const abortFile = path.join(dir, "abort");
    const start = Date.now();
    if (opts.preAbort) fs.writeFileSync(abortFile, "aborted\n");
    const child = spawn(BASH, [anchor, pidFile, releaseFile, abortFile], {
      env: cleanEnv(),
      stdio: "ignore",
    });
    // Attach the exit listener IMMEDIATELY: a pre-published abort marker makes
    // the anchor exit in a few ms — before the pid-file poll below could even
    // run — so the exit event must never be attached late (a late .once()
    // would miss the event and hang until the outer timer fires).
    // Every signal this function sends is a bounded kill on this OWNED
    // retained spawn handle, guarded on the child still being live — a child
    // already exited/reaped (exitCode/signalCode non-null) is never
    // signalled. After exit the handle is closed and child.kill would be a
    // no-op anyway, but the guard makes "never after exit/reap" structural,
    // not incidental.
    const exitRace = new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        resolve(null);
      }, outerMs);
      child.once("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    return (async () => {
      try {
        // Wait (bounded) for the anchor to publish its pid so a dir teardown
        // below always happens AFTER the anchor is mid-wait.
        const pidDeadline = Date.now() + 5000;
        while (!fs.existsSync(pidFile) && Date.now() < pidDeadline && child.exitCode === null) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (opts.removeDir) {
          if (!fs.existsSync(pidFile)) {
            // The anchor never published its pid within the grace. Signal it
            // ONLY while it is provably still live (exitCode and signalCode
            // both null — the only state a kill may target); the wait loop can
            // exit on child.exitCode !== null when the anchor exited/reaped
            // without publishing its pid, and an exited/reaped child is never
            // signalled — return its real exit code instead.
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
            const code = await exitRace;
            return { code, elapsedMs: Date.now() - start };
          }
          // Exactly the harness cleanup pattern: the invocation dir (markers
          // and all) is rm -rf'd the instant the harness wait returns.
          fs.rmSync(dir, { recursive: true, force: true });
        }
        const code = await exitRace;
        return { code, elapsedMs: Date.now() - start };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })();
  }

  it("marker dir torn down mid-wait -> the anchor exits promptly, not at its cap", async () => {
    // Default cap is 20 s; without review hardening (b) a dir-teardown
    // descheduled anchor would poll the FULL cap, so asserting an exit well
    // under the cap proves the dir-disappearance abort arm works.
    const r = await runAnchor({ removeDir: true, preAbort: false }, 15000);
    assert.equal(r.code, 0, `anchor must exit 0 on abort-dir disappearance (code=${r.code})`);
    assert.ok(r.elapsedMs < 12000, `anchor must exit far below its 20 s cap (elapsed ${r.elapsedMs} ms)`);
    recordCase({
      scenario: "anchor_abort_dir_removed_exits_promptly",
      exit: r.code,
      elapsed_ms: r.elapsedMs,
    });
  });

  it("control: the abort marker present -> the same anchor exits promptly", async () => {
    const r = await runAnchor({ removeDir: false, preAbort: true }, 15000);
    assert.equal(r.code, 0, `anchor must exit 0 on the abort marker (code=${r.code})`);
    assert.ok(r.elapsedMs < 12000, `abort-marker exit must be prompt (elapsed ${r.elapsedMs} ms)`);
    recordCase({
      scenario: "anchor_abort_marker_exits_promptly",
      exit: r.code,
      elapsed_ms: r.elapsedMs,
    });
  });
});

// Evidence is retained by design (gitignored var tree); only os.tmpdir/var
// fixtures are removed (afterEach above). The suite must leave git clean.
// The single writeEvidence() flush happens in the LAST describe's before()
// (node:test runs describes sequentially), after every recording it() above.
describe("SGBD 9.1.2 — evidence retention", () => {
  before(() => {
    writeEvidence();
  });

  it("retains fresh evidence under torture-test/var/review-logs and leaves the tree clean", () => {
    assert.ok(evidenceDir.startsWith(REVIEW_ROOT + path.sep), `evidence escaped review-logs: ${evidenceDir}`);
    assert.ok(fs.existsSync(path.join(evidenceDir, "evidence.jsonl")), "evidence.jsonl must exist");
    assert.ok(fs.existsSync(runLogPath), "run.log must exist");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim();
    assert.equal(status, "", `gate left the working tree dirty:\n${status}`);
  });
});
