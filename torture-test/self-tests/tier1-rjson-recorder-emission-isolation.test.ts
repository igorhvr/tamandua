// RJSON US-002 (story US-002) — isolated emission-level regression for the
// tt-recorder JSONL framing, plus recorded evidence.
//
// Beads tamandua-0j7.4.2. US-001 (tier0-rjson-json-escape-red-green.test.ts)
// proved the repaired `_json_escape` round-trips purely. This story drives
// the REAL recorder emission path — `collect_sample` and the started
// recorder's output file (`generate_output_filename` + the statefile) — with
// a freshly allocated synthetic fixture and exactly owned child processes,
// proving that multiline command text and multiline cwd paths become valid,
// one-physical-line-per-record JSONL with exact expected fields end to end.
//
// ── Hermetic fixture + ownership model ──────────────────────────────
//   * The repo recorder is COPIED into a fresh mkdtemp fixture at
//     <fx>/torture-test/bin/tt-recorder so its computed TT_ROOT /
//     RECORDER_DIR land under <fx>/torture-test/var (the MACP5
//     tier1-tt-recorder-* pattern). The fixture root, every directory and
//     file inside it, and every spawned PID are created BY THIS INVOCATION;
//     cleanup removes only those exact paths/pids (no inherited cleanup
//     roots, no stale-PID signals, no broad/name-pattern kills, no deletion
//     of pre-existing state).
//   * Every owned child argv carries a fresh per-invocation launch token
//     (the fixture's mkdtemp suffix, never a fixed marker that recurs across
//     invocations), and the launch identity (ps cmdline + birth start) is
//     captured at spawn on the exact handle this invocation created. Every
//     cleanup signal revalidates the CURRENT identity against that captured
//     evidence first — a changed/stale/foreign/unreadable/reused pid refuses
//     the signal and preserves evidence (US-002 fixed ownership semantics).
//   * The fixture recorder is owned the same way (US-003): its launch
//     identity (ps cmdline + birth start) is captured at start for the exact
//     pid this invocation's `start` wrote to the fixture pidfile, with a
//     fresh per-invocation token riding the start-subprocess env and the
//     fixture-exact pidfile path. Every recorder cleanup decision (normal
//     stop pre-check, startup-error cleanup, finally leftover cleanup)
//     revalidates the CURRENT identity — pidfile content, liveness, cmdline
//     and birth start — before EACH signal (TERM, then again before the KILL
//     escalation); a stale/foreign/changed/unreadable/unproven recorder is
//     never signaled and its evidence is preserved. The recorder's own `stop`
//     subcommand stays byte-identical (its runtime semantics are out of
//     scope; this file only guards when it may be invoked and performs its
//     own guarded direct stop in the finally).
//   * Discovery boundary is the recorder's own (unchanged) scope: a process
//     is in scope when its procfs cwd symlink resolves under
//     */torture-test/var* or its argv contains the literal torture-test/var.
//     The owned children are placed with their cwd under the fixture's
//     torture-test/var (and their argv carries the fixture literal), so they
//     are the in-scope subjects; the test asserts on THEIR exact
//     pid/cwd/cmdline and never on host-global emptiness (other runs may
//     legitimately hold torture-test/var processes on this shared host).
//     No knobs are added and discovery scope is not changed.
//   * The test itself never scans the host wholesale, never binds or probes
//     production ports 3334/3338/3339, and never touches real ~/.tamandua
//     state. Every assertion is against the owned child's own record(s).
//
// ── Platform honesty ────────────────────────────────────────────────
//   The recorder's discovery and per-process reads are linux-only (MACP3
//   US-003-guarded; a procfs-less host yields an empty sample series). The
//   emission cases below therefore mark themselves not-applicable on a
//   procfs-less (non-linux, e.g. Darwin/macOS) platform with an explicit
//   message while still exiting 0; the portable pure-helper round trips
//   still execute on every host. No deferred Darwin execution is claimed as
//   passed here.
//
// ── Guard / hygiene ─────────────────────────────────────────────────
//   The test isolation guard stays ENABLED: children inherit the runner's
//   environment untouched (no TAMANDUA_TEST_GUARD=0, no NODE_TEST_CONTEXT
//   removal). Children are plain `bash` processes sourcing/copying the
//   recorder and reading procfs + fixture paths; they never import tamandua
//   modules, bind ports, or touch tamandua state, so nothing trips the
//   guard. `stdio` of the persistence children is capped/bounded and their
//   stderr is captured for failure evidence; every assertion retains useful
//   failure context (rc, captured stdout/stderr, exit codes).
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (no run.sh edit).
// Zero tokens; confined to torture-test/. Passes twice consecutively
// (idempotent — every run allocates a fresh fixture).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const repoRecorder = path.join(ttRoot, "bin", "tt-recorder");
const recorderText = fs.readFileSync(repoRecorder, "utf8");

assert.ok(fs.existsSync(repoRecorder), `cannot find the repo recorder at ${repoRecorder} — run from the repo root`);
assert.ok(/_json_escape\(\)/.test(recorderText), `${repoRecorder} must define _json_escape (interface pin)`);
assert.ok(/collect_sample\(\)/.test(recorderText), `${repoRecorder} must define collect_sample (interface pin)`);
assert.ok(/generate_output_filename\(\)/.test(recorderText), `${repoRecorder} must define generate_output_filename (interface pin)`);

// ── helpers ────────────────────────────────────────────────────────────

interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a short-lived command via spawnSync with an explicit timeout. Env is
 *  inherited untouched (isolation guard ENABLED — no TAMANDUA_TEST_GUARD=0,
 *  no NODE_TEST_CONTEXT stripping: children are plain bash / ps / kill and
 *  never import tamandua modules or touch tamandua state). */
function run(
  cmd: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): CmdResult {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Synchronous bounded sleep (cleanup paths run outside async contexts). */
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  return run(["kill", "-0", String(pid)], { timeoutMs: 5_000 }).status === 0;
}

/** ps pgid of an owned pid (independent cross-check for the emitted pgid
 *  field). Empty when the pid is already gone. */
function psPgid(pid: number): string {
  return run(["ps", "-p", String(pid), "-o", "pgid="], { timeoutMs: 5_000 }).stdout.trim();
}

/** ps command line of an owned pid (identity evidence for cleanup, per the
 *  _pid_alive / _pid_cmdline conventions). */
function psCommand(pid: number): string {
  return run(["ps", "-p", String(pid), "-o", "command="], { timeoutMs: 5_000 }).stdout;
}

/** ps start time of an owned pid — the launch-time birth identity captured
 *  at spawn and revalidated before every cleanup signal (a reused pid gets a
 *  new start time). Empty when the pid is already gone or unreadable. */
function psStart(pid: number): string {
  return run(["ps", "-p", String(pid), "-o", "lstart="], { timeoutMs: 5_000 }).stdout;
}

/** Fresh hermetic fixture with the repo recorder copied to
 *  <root>/torture-test/bin/tt-recorder (its computed TT_ROOT therefore lands
 *  under <root>/torture-test/var). Returns the root, tool path, and the
 *  canonical var directory. */
function makeFixture(): { root: string; tool: string; varRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-recorder-rjson-"));
  const binDir = path.join(root, "torture-test", "bin");
  const varRoot = path.join(root, "torture-test", "var");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(varRoot, { recursive: true });
  const tool = path.join(binDir, "tt-recorder");
  fs.writeFileSync(tool, recorderText, { mode: 0o755 });
  return { root, tool, varRoot: fs.realpathSync(varRoot) };
}

/** The persistence script for owned children: bash stays alive as itself
 *  (no exec-replacement, no per-second fork storm beyond one `sleep 1`) and
 *  exits cleanly on SIGTERM/SIGINT so cleanup never needs a broad kill. */
const PERSIST_SCRIPT = "trap 'exit 0' TERM INT; while :; do sleep 1; done";

interface OwnedChild {
  pid: number;
  argv: string[]; // the exact exec argv (["bash","-c",PERSIST_SCRIPT, token, ...argvTail])
  stderr: string;
  // Launch identity evidence captured at spawn time for the handle this
  // invocation ACTUALLY created (ps cmdline + birth start, read right after
  // the child was first seen alive). Cleanup revalidates the CURRENT
  // identity against these before EVERY signal; "" means the evidence was
  // never captured (the child died before capture) — such a handle can never
  // authorize a signal.
  launchCmdline: string; // trimmed `ps -o command=` of the launched argv
  launchStart: string; // trimmed `ps -o lstart=` birth identity
}

/** Fresh per-invocation launch token for owned children: the fixture's
 *  mkdtemp suffix, unique to THIS invocation, so the child argv carries an
 *  exact binding to the fresh fixture that spawned it — never a fixed marker
 *  that recurs across invocations. */
function launchToken(fixtureRoot: string): string {
  return path.basename(fixtureRoot);
}

/** One synchronized identity read of an owned pid: liveness + ps command
 *  line + ps start time (birth identity). cmdline/start are "" when the pid
 *  is gone or the read raced (unreadable). */
function readChildIdentity(pid: number): { alive: boolean; cmdline: string; start: string } {
  if (!pidAlive(pid)) return { alive: false, cmdline: "", start: "" };
  return { alive: true, cmdline: psCommand(pid).trim(), start: psStart(pid).trim() };
}

/** ONE guarded identity decision for every test-owned child cleanup site:
 *  is the CURRENT process at owned.pid provably the exact process this
 *  invocation spawned (liveness + argv token/fixture cmdline + captured
 *  birth identity)? "owned" is the ONLY verdict that may receive a signal;
 *  dead / foreign / unreadable REFUSE the signal — the caller preserves
 *  evidence instead of risking an unrelated process. */
function currentChildVerdict(owned: OwnedChild): "owned" | "dead" | "foreign" | "unreadable" {
  const cur = readChildIdentity(owned.pid);
  if (!cur.alive) return "dead";
  if (cur.cmdline === "" || cur.start === "") return "unreadable";
  if (owned.launchCmdline === "" || owned.launchStart === "") return "foreign"; // never captured: cannot prove
  if (cur.cmdline === owned.launchCmdline && cur.start === owned.launchStart) return "owned";
  return "foreign";
}

/** Rich refusal context for an unverifiable signal target. Never signals:
 *  raises so a refusal is loud and the caller's finally cleanup cannot
 *  silently remove the refusal evidence. */
function refuseChildSignal(owned: OwnedChild, signal: "SIGTERM" | "SIGKILL", verdict: string): never {
  assert.fail(
    `refusing to deliver ${signal} to pid ${owned.pid}: current identity verdict ${JSON.stringify(verdict)} is not "owned" — ` +
      `launch evidence was cmdline=${JSON.stringify(owned.launchCmdline)} start=${JSON.stringify(owned.launchStart)}; ` +
      `a changed/stale/foreign/unreadable pid is never signaled (refusal evidence preserved)`,
  );
}

/** Spawn one exactly owned persistence child whose cwd is `cwd` and whose
 *  argv is ["bash","-c",PERSIST_SCRIPT, token, ...argvTail] with a fresh
 *  per-invocation `token`. Retries with a short backoff on an abnormal
 *  immediate exit (capturing stderr) — exec denial on a shared host can be
 *  transient. A child that dies before identity capture is NEVER signaled (a
 *  stale pid must not be killed merely because our handle once contained
 *  it): its disposal routes through the SAME guarded decision
 *  (currentChildVerdict), the evidence is recorded and the spawn is retried. */
async function spawnOwnedChild(token: string, cwd: string, argvTail: string[]): Promise<OwnedChild> {
  // Full exec argv INCLUDING argv[0]; node's spawn() prepends `file` itself,
  // so pass argv.slice(1) — passing the whole argv would double-prepend
  // "bash" and make the child exec `/usr/bin/bash /usr/bin/bash -c ...`
  // ("cannot execute binary file", observed in the US-002 draft).
  const argv = ["bash", "-c", PERSIST_SCRIPT, token, ...argvTail];
  const attempts: string[] = []; // retained rejection evidence (recorded, never lost)
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => {
      err = (err + String(d)).slice(-4096);
    });
    await sleep(300);
    const pid = child.pid;
    if (typeof pid === "number" && pid > 0) {
      const identity = readChildIdentity(pid);
      if (identity.alive && identity.cmdline !== "" && identity.start !== "" && identity.cmdline.includes(token)) {
        // Alive with THIS launch's token and a readable birth identity:
        // capture the launch evidence on the exact handle we return.
        return { pid, argv, stderr: err, launchCmdline: identity.cmdline, launchStart: identity.start };
      }
      // Not provably this launch (immediate exit before identity capture,
      // unreadable evidence, or the pid reused within the settle window).
      // Route the disposal through the SAME guarded decision every cleanup
      // site uses; it never signals anything but a revalidated "owned" pid,
      // so this rejected child gets no signal. Record the verdict + stderr
      // and retry.
      const rejected: OwnedChild = { pid, argv, stderr: err, launchCmdline: "", launchStart: "" };
      const verdict = currentChildVerdict(rejected);
      attempts.push(
        `attempt ${attempt + 1}: rejected (guarded verdict=${verdict}, identity alive=${identity.alive} ` +
          `cmdline=${JSON.stringify(identity.cmdline)} start=${JSON.stringify(identity.start)}, stderr=${JSON.stringify(err)})`,
      );
    } else {
      attempts.push(`attempt ${attempt + 1}: spawn returned no pid (stderr=${JSON.stringify(err)})`);
    }
    lastErr = err;
    await sleep(400 * (attempt + 1));
  }
  assert.fail(
    `owned persistence child failed to stay alive after 5 attempts (cwd=${cwd}, argvTail=${JSON.stringify(argvTail)}): ` +
      `${JSON.stringify(lastErr)}; retained attempt evidence: ${JSON.stringify(attempts)}`,
  );
}

/** Stop an owned child under EXACT invocation ownership. The ONE guarded
 *  decision (currentChildVerdict) revalidates the CURRENT identity against
 *  the launch evidence captured at spawn BEFORE EACH signal: SIGTERM first
 *  (the trap exits cleanly within ~1 s), then — if the child survives —
 *  identity is revalidated AGAIN before the SIGKILL escalation. A pid whose
 *  identity changed or was lost between TERM and KILL (process gone, PID
 *  possibly reused) never receives a KILL; unknown/changed/stale/foreign/
 *  unreadable evidence REFUSES the signal with rich context and the refusal
 *  propagates so evidence is preserved (the caller's finally stops before
 *  any removal). Its transient `sleep 1` grandchildren self-terminate. */
function stopOwnedChild(owned: OwnedChild): void {
  const beforeTerm = currentChildVerdict(owned);
  if (beforeTerm === "dead") return; // already gone — nothing to do
  if (beforeTerm !== "owned") refuseChildSignal(owned, "SIGTERM", beforeTerm);
  try {
    process.kill(owned.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 30 && pidAlive(owned.pid); i++) {
    sleepSync(100);
  }
  const beforeKill = currentChildVerdict(owned);
  if (beforeKill === "dead") return; // TERM worked — clean exit, no KILL
  if (beforeKill !== "owned") refuseChildSignal(owned, "SIGKILL", beforeKill);
  try {
    process.kill(owned.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

// ── fixture-recorder ownership (US-003) ──────────────────────────────
// The fixture recorder is started by this invocation through its own copied
// `start` subcommand (recorder runtime semantics unchanged — out of scope).
// The pidfile it writes is mutable and the generic tt-recorder name is
// shared across invocations, so every test-owned recorder cleanup decision
// binds the recorder to THIS invocation's exact fresh fixture + launch: the
// launch identity (ps cmdline + birth start) is captured at start on the
// exact pid this invocation's `start` wrote to the fixture pidfile, and the
// CURRENT identity (pidfile content + liveness + cmdline + birth start) is
// revalidated before EVERY signal — TERM and the KILL escalation alike. The
// recorder's own `stop` subcommand stays byte-identical; the test guards the
// decision to invoke it (normal stop pre-check) and performs its own guarded
// direct stop in the finally leftover cleanup.

/** A fixture recorder THIS invocation STARTED, carrying the launch identity
 *  evidence captured at start (ps cmdline + birth start). Cleanup revalidates
 *  the CURRENT identity against this captured evidence before every signal. */
interface OwnedRecorder {
  pid: number; // the pid this invocation's `start` wrote to the fixture pidfile
  varRoot: string; // the fixture-exact recorder var root (owned path)
  token: string; // per-invocation launch token (the fixture's mkdtemp suffix)
  launchCmdline: string; // trimmed `ps -o command=` read at start
  launchStart: string; // trimmed `ps -o lstart=` birth identity read at start
}

type RecorderVerdict = "owned" | "dead" | "foreign" | "unreadable";

/** Exact pidfile path of the fixture recorder (this invocation's own path —
 *  the pidfile the `start` subcommand writes under the fresh fixture var). */
function recorderPidfilePath(varRoot: string): string {
  return path.join(varRoot, "recorder", "tt-recorder.pid");
}

/** Trimmed content of the fixture recorder pidfile; null when absent. */
function readRecorderPidfile(varRoot: string): string | null {
  const pidfile = recorderPidfilePath(varRoot);
  if (!fs.existsSync(pidfile)) return null;
  return fs.readFileSync(pidfile, "utf8").trim();
}

/** ONE guarded identity decision for every test-owned recorder cleanup site
 *  (normal-stop pre-check, startup-error cleanup and finally leftover
 *  cleanup): is the CURRENT process named by the fixture pidfile provably the
 *  recorder THIS invocation started? Requires the pidfile (at the exact
 *  fixture path) to hold a numeric pid, the handle (when captured) to still
 *  match that pid, and the live pid's ps cmdline + birth start to still
 *  exactly equal the launch evidence captured at start. "owned" is the ONLY
 *  verdict that may receive a signal; dead / foreign / unreadable REFUSE it
 *  (evidence preserved). A missing pidfile and a dead captured pid are
 *  "dead"; a non-numeric pidfile is "unreadable"; a pidfile naming a live pid
 *  this invocation never captured (startup failure) or any changed/reused/
 *  stale/foreign pid is "foreign". */
function currentRecorderVerdict(rec: OwnedRecorder | null, varRoot: string): RecorderVerdict {
  const content = readRecorderPidfile(varRoot);
  if (content === null) return "dead"; // no pidfile: no recorder running under this fixture
  if (!/^[0-9]+$/.test(content)) return "unreadable"; // non-numeric pidfile content
  const pid = Number(content);
  if (rec === null) {
    // Startup failure / never captured: without captured launch evidence no
    // pid is provably this invocation's recorder. A DEAD pid is the crashed
    // start's stale pidfile (nothing live to signal -> dead); a LIVE pid is
    // unproven and is never signaled (foreign).
    return pidAlive(pid) ? "foreign" : "dead";
  }
  if (rec.pid !== pid) return "foreign"; // stale/foreign pidfile: no longer names the captured pid
  const cur = readChildIdentity(pid);
  if (!cur.alive) return "dead"; // recorder exited (crashed): stale pidfile naming our pid
  if (cur.cmdline === "" || cur.start === "") return "unreadable"; // identity read raced/unreadable
  if (rec.launchCmdline === "" || rec.launchStart === "") return "foreign"; // evidence never captured
  if (cur.cmdline === rec.launchCmdline && cur.start === rec.launchStart) return "owned";
  return "foreign"; // pid reused or cmdline/start changed since the capture
}

/** Rich refusal context for an unverifiable recorder signal target. Never
 *  signals: raises so a refusal is loud and a caller's finally stops before
 *  removing the refusal evidence. */
function refuseRecorderSignal(
  rec: OwnedRecorder | null,
  varRoot: string,
  signal: "SIGTERM" | "SIGKILL",
  verdict: string,
  reason: string,
): never {
  assert.fail(
    `refusing to deliver ${signal} for the fixture recorder at ${recorderPidfilePath(varRoot)}: current identity verdict ${JSON.stringify(verdict)} is not "owned" — ` +
      `reason: ${reason}; captured launch evidence was cmdline=${JSON.stringify(rec === null ? "" : rec.launchCmdline)} ` +
      `start=${JSON.stringify(rec === null ? "" : rec.launchStart)}; a changed/stale/foreign/unreadable/unproven recorder ` +
      `is never signaled (refusal evidence preserved)`,
  );
}

/** Normal-stop pre-check: the recorder's own `stop` subcommand signals the
 *  pidfile pid itself, so the CURRENT identity must still prove THIS
 *  invocation's recorder before the stop may run. "owned" (and "dead" — no
 *  live target; the recorder's own stale-pidfile handling just removes the
 *  file) proceed; a stale/foreign pidfile or changed/unreadable identity
 *  REFUSES with evidence preserved — a guarded finally cannot be bypassed
 *  through an unguarded normal stop. */
function assertRecorderStopProceeds(rec: OwnedRecorder | null, varRoot: string): void {
  const verdict = currentRecorderVerdict(rec, varRoot);
  if (verdict === "owned" || verdict === "dead") return;
  refuseRecorderSignal(rec, varRoot, "SIGTERM", verdict, "normal recorder stop pre-check");
}

/** Stop the fixture recorder under EXACT invocation ownership (the finally
 *  leftover cleanup — a stop that raced/failed above, or a failed start's
 *  leftover pidfile). The ONE guarded decision (currentRecorderVerdict)
 *  revalidates the CURRENT identity — pidfile content, liveness, ps cmdline
 *  + birth start against the launch evidence captured at start — BEFORE EACH
 *  signal: SIGTERM first, then — if the recorder survives — identity is
 *  revalidated AGAIN before the SIGKILL escalation. A pid whose identity
 *  changed or was lost between TERM and KILL (process gone, PID possibly
 *  reused) never receives a KILL; unknown/changed/stale/foreign/unreadable
 *  evidence REFUSES the signal (evidence preserved — this finally stops
 *  before the fixture rm). With no captured identity (rec === null, e.g. a
 *  crashed start) nothing can ever be "owned", so no signal is issued. */
function stopOwnedRecorder(rec: OwnedRecorder | null, varRoot: string): void {
  const beforeTerm = currentRecorderVerdict(rec, varRoot);
  if (beforeTerm === "dead") return; // nothing live under this fixture — nothing to do
  if (beforeTerm !== "owned") refuseRecorderSignal(rec, varRoot, "SIGTERM", beforeTerm, "recorder stop");
  if (rec === null) return; // unreachable: "owned" requires a captured handle
  try {
    process.kill(rec.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 50 && pidAlive(rec.pid); i++) {
    sleepSync(100);
  }
  const beforeKill = currentRecorderVerdict(rec, varRoot);
  if (beforeKill === "dead") return; // TERM worked — clean exit, no KILL
  if (beforeKill !== "owned") refuseRecorderSignal(rec, varRoot, "SIGKILL", beforeKill, "recorder stop KILL escalation");
  try {
    process.kill(rec.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Capture the invocation-owned recorder handle right after `start` returns:
 *  the exact fixture pidfile already names the started recorder pid, so bind
 *  launch identity evidence (ps cmdline + birth start) read at start to THIS
 *  invocation's fixture + launch token and retain it on the handle — a
 *  mutable pidfile plus a generic tt-recorder name alone never authorize a
 *  later signal. A recorder that cannot be proven alive with THIS fixture's
 *  token and a readable birth identity within a short window is a startup
 *  failure: assert.fail with the retained attempt evidence and NO handle is
 *  returned (cleanup then never signals an unproven pid). */
function captureRecorderIdentity(varRoot: string, token: string, pid: number): OwnedRecorder {
  const attempts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const id = readChildIdentity(pid);
    if (id.alive && id.cmdline !== "" && id.start !== "" && id.cmdline.includes(token)) {
      return { pid, varRoot, token, launchCmdline: id.cmdline, launchStart: id.start };
    }
    attempts.push(
      `attempt ${i + 1}: identity alive=${id.alive} cmdline=${JSON.stringify(id.cmdline)} start=${JSON.stringify(id.start)}`,
    );
    sleepSync(100);
  }
  assert.fail(
    `startup failure: could not capture this invocation's recorder identity (pid=${pid}, fixture=${varRoot}): ` +
      `${JSON.stringify(attempts)} — an unproven recorder is never signaled`,
  );
}

/** Parse every physical line of a JSONL payload; asserts each line is
 *  parseable and returns the records. Fails with the offending raw line. */
function parseEveryLine(label: string, payload: string): Array<{ raw: string; rec: any }> {
  const lines = payload.split("\n");
  // Exactly one trailing empty line is the record terminator; anything else
  // means an embedded raw line break split a record (the US-001 defect).
  const nonEmpty = lines.filter((l) => l.length > 0);
  assert.ok(nonEmpty.length > 0, `${label}: expected at least one emitted record, got empty output`);
  const out: Array<{ raw: string; rec: any }> = [];
  for (const raw of nonEmpty) {
    assert.ok(
      !/[\x00-\x09\x0b-\x1f]/.test(raw),
      `${label}: raw line contains an unescaped C0 control byte (one-physical-line violation): ${JSON.stringify(raw)}`,
    );
    let rec: any;
    try {
      rec = JSON.parse(raw);
    } catch (err) {
      assert.fail(`${label}: a physical line is not valid JSON: ${JSON.stringify(raw)} — ${String(err)}`);
    }
    out.push({ raw, rec });
  }
  return out;
}

/** Tolerant parse of a LIVE samples file while the recorder is still
 *  appending: an empty payload ("file created, first flush not yet done") or
 *  a trailing line without its terminator (mid-append) is NOT an emitted
 *  record yet, so it is skipped instead of failing the poll. Every COMPLETE
 *  line must still parse — a genuinely corrupt complete line fails loudly.
 *  The strict every-record parse (parseEveryLine) runs only after the
 *  recorder is stopped and the file is stable. */
function parseCompleteLines(payload: string): Array<{ raw: string; rec: any }> {
  if (payload === "") return [];
  const out: Array<{ raw: string; rec: any }> = [];
  const lines = payload.split("\n");
  // Drop the trailing element: it is either the empty terminator (payload
  // ends with '\n') or a partial in-flight line (payload does not end with
  // '\n'). Everything before it is a complete, terminated record.
  for (const raw of lines.slice(0, -1)) {
    if (raw === "") continue;
    out.push({ raw, rec: JSON.parse(raw) });
  }
  return out;
}

/** Exact expected fields for an owned child's record. `db` optionally
 *  asserts the daemon db fields (db_path/db_size_bytes/wal_size_bytes). */
function assertOwnedRecord(
  label: string,
  entry: { raw: string; rec: any },
  owned: OwnedChild,
  expectedCwd: string,
  opts: { pgid?: string; db?: { dbPath: string; dbSize: number; walSize: number } } = {},
): void {
  const { rec, raw } = entry;
  assert.ok(typeof rec === "object" && rec !== null, `${label}: record must be an object`);
  assert.equal(rec.pid, owned.pid, `${label}: pid mismatch`);
  assert.equal(rec.ppid, process.pid, `${label}: ppid must be the owning test process`);
  assert.match(String(rec.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `${label}: ts must be UTC ISO-8601`);
  assert.ok(Number.isInteger(rec.rss_kb) && rec.rss_kb >= 0, `${label}: rss_kb must be a non-negative integer`);
  assert.ok(Number.isInteger(rec.open_fds) && rec.open_fds >= 0, `${label}: open_fds must be a non-negative integer`);
  assert.equal(rec.cwd, expectedCwd, `${label}: cwd must round-trip exactly (escaped, never a raw break)`);
  // cmdline = the exact exec argv NUL-joined with single spaces; the kernel
  // cmdline ends in a NUL that the recorder's tr turns into one trailing
  // space.
  assert.equal(rec.cmdline, owned.argv.join(" ") + " ", `${label}: cmdline must round-trip exactly`);
  if (opts.pgid !== undefined) {
    assert.equal(rec.pgid, Number(opts.pgid), `${label}: pgid must match the independently-read ps pgid`);
  }
  if (opts.db) {
    assert.equal(rec.db_path, opts.db.dbPath, `${label}: db_path must be the daemon db under the fixture`);
    assert.equal(rec.db_size_bytes, opts.db.dbSize, `${label}: db_size_bytes must be the exact file size`);
    assert.equal(rec.wal_size_bytes, opts.db.walSize, `${label}: wal_size_bytes must be 0 for an absent -wal file`);
  } else {
    assert.ok(!("db_path" in rec), `${label}: non-daemon record must not carry db fields`);
    assert.ok(!("db_size_bytes" in rec), `${label}: non-daemon record must not carry db_size_bytes`);
    assert.ok(!("wal_size_bytes" in rec), `${label}: non-daemon record must not carry wal_size_bytes`);
  }
  // Canonical framing pin: the raw emitted line must be byte-identical to
  // the canonical JSON serialization of the parsed record — the emitter
  // writes no structural whitespace and no lossy/raw control bytes (a raw LF
  // or CR or '?' replacement would break this equality or the parse above).
  assert.equal(raw, JSON.stringify(rec), `${label}: raw line must be the canonical JSON of the parsed record`);
}

/** Source the fixture recorder in a fresh bash and run `collect_sample`,
 *  returning its stdout JSONL (rc/stderr included for evidence). */
function collectSampleOnce(tool: string, cwd: string): CmdResult {
  return run(
    ["bash", "-c", 'source "$1" >/dev/null; collect_sample', "rjson-emit-driver", tool],
    { cwd, timeoutMs: 30_000 },
  );
}

// ── the guard ──────────────────────────────────────────────────────────

describe("RJSON US-002 — isolated emission-level recorder JSONL framing regression", () => {
  it("portable: the FIXTURE recorder's pure _json_escape round-trips on every host", () => {
    // Pure-helper round trips execute on every platform (linux and Darwin),
    // through the same copied tool the emission cases drive, pinning that the
    // fixture copy behaves like the fixed repo helper (no drift).
    const fixture = makeFixture();
    try {
      const cases: Array<{ name: string; input: string }> = [
        { name: "empty", input: "" },
        { name: "plain", input: "plain text 123!@#" },
        { name: "quotes + backslash", input: 'say "hi" \\ there' },
        { name: "leading/embedded/trailing LF", input: "\nfirst\nsecond\n" },
        { name: "CRLF + tab + controls", input: "a\r\nb\tc\x01\x1f end" },
        { name: "unicode", input: "café — 日本語 ☃ 🚀" },
        { name: "multiline framing", input: "line1 \"q\" \\ here\nline2\ttabbed\r\n" },
      ];
      for (const c of cases) {
        const res = run(
          ["bash", "-c", 'source "$1" >/dev/null; _json_escape "$2"', "rjson-portable", fixture.tool, c.input],
          { cwd: fixture.root, timeoutMs: 20_000 },
        );
        assert.equal(res.status, 0, `${c.name}: _json_escape exited ${res.status}; stderr: ${JSON.stringify(res.stderr)}`);
        assert.ok(
          !res.stdout.includes("\n") && !res.stdout.includes("\r"),
          `${c.name}: escaped output contains a physical line-break byte: ${JSON.stringify(res.stdout)}`,
        );
        let parsed: unknown;
        try {
          parsed = JSON.parse('"' + res.stdout + '"');
        } catch (err) {
          assert.fail(`${c.name}: JSON.parse rejected escaped content ${JSON.stringify(res.stdout)}: ${String(err)}`);
        }
        assert.equal(parsed, c.input, `${c.name}: JSON.parse round trip mismatch through the fixture copy`);
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  const emissionSkip =
    os.platform() === "linux"
      ? false
      : "not-applicable on this procfs-less platform (non-linux, e.g. Darwin/macOS): the recorder's " +
        "process discovery and per-process reads are linux-only and yield an empty sample series here; " +
        "the portable pure-helper round trips above still executed on this host. No Darwin emission " +
        "execution is claimed as passed.";

  it("collect_sample emits one parseable JSONL line per owned child with exact fields", { skip: emissionSkip }, async () => {
    const fixture = makeFixture();
    // Per-invocation launch token bound to this exact fresh fixture.
    const fxToken = launchToken(fixture.root);
    const children: OwnedChild[] = [];
    try {
      // Multiline command text in the argv (child A), a multiline fixture
      // path in the cwd (child B), and the daemon-db arm (child C).
      const childACwd = path.join(fixture.varRoot, "childA");
      fs.mkdirSync(childACwd, { recursive: true });
      const childBDir = path.join(fixture.varRoot, "dirA\u000adirB");
      fs.mkdirSync(childBDir, { recursive: true });
      const childCCwd = path.join(fixture.varRoot, "home-scripted");
      const childCDbDir = path.join(childCCwd, ".tamandua");
      fs.mkdirSync(childCDbDir, { recursive: true });
      const dbPath = path.join(childCDbDir, "tamandua.db");
      const dbBody = "synthetic tamandua.db for the RJSON US-002 db-arm assertion";
      fs.writeFileSync(dbPath, dbBody);

      const a = await spawnOwnedChild(fxToken, childACwd, [
        "rjson-argv0-A",
        "line1\nline2\ttabbed torture-test/var in-scope marker",
      ]);
      children.push(a);
      const b = await spawnOwnedChild(fxToken, childBDir, ["rjson-argv0-B", "plain-arg-B"]);
      children.push(b);
      const c = await spawnOwnedChild(fxToken, childCCwd, ["rjson-argv0-C", "daemon-child torture-test/var"]);
      children.push(c);

      // Independent pgid cross-check BEFORE any child is stopped.
      const pgids = new Map<number, string>();
      for (const ch of children) {
        const pgid = psPgid(ch.pid);
        assert.ok(/^[0-9]+$/.test(pgid), `ps pgid for owned pid ${ch.pid} must be numeric, got ${JSON.stringify(pgid)}`);
        pgids.set(ch.pid, pgid);
      }

      // A short settle lets every child's exec'd argv/cwd be fully visible.
      await sleep(400);

      const out = collectSampleOnce(fixture.tool, fixture.root);
      assert.equal(out.status, 0, `collect_sample exited ${out.status}; stderr: ${JSON.stringify(out.stderr)}`);
      const entries = parseEveryLine("collect_sample", out.stdout);

      // Expected canonical cwd per child; child C additionally exercises the
      // daemon-db arm (db fields only for a detected daemon under the
      // fixture's home-scripted dir with a real tamandua.db present).
      const expectations: Array<{ ch: OwnedChild; cwd: string; db?: { dbPath: string; dbSize: number; walSize: number } }> = [
        { ch: a, cwd: fs.realpathSync(childACwd) },
        { ch: b, cwd: fs.realpathSync(childBDir) },
        {
          ch: c,
          cwd: fs.realpathSync(childCCwd),
          db: {
            dbPath: path.join(fs.realpathSync(fixture.varRoot), "home-scripted", ".tamandua", "tamandua.db"),
            dbSize: fs.statSync(dbPath).size,
            walSize: 0,
          },
        },
      ];

      for (const exp of expectations) {
        const matches = entries.filter((e) => e.rec.pid === exp.ch.pid);
        assert.equal(matches.length, 1, `expected exactly one record for owned pid ${exp.ch.pid}, got ${matches.length}`);
        assertOwnedRecord(`owned child pid=${exp.ch.pid}`, matches[0], exp.ch, exp.cwd, {
          pgid: pgids.get(exp.ch.pid),
          ...(exp.db ? { db: exp.db } : {}),
        });
      }
    } finally {
      for (const ch of children) stopOwnedChild(ch);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("a started recorder frames multiline command text into its samples file (output-file path)", { skip: emissionSkip }, async () => {
    const fixture = makeFixture();
    // Per-invocation launch token bound to this exact fresh fixture.
    const fxToken = launchToken(fixture.root);
    const children: OwnedChild[] = [];
    // Invocation-owned recorder handle: null until THIS invocation's `start`
    // succeeded AND the launch identity was captured (a failed start leaves it
    // null — nothing is then provably owned, so cleanup never signals).
    let recorder: OwnedRecorder | null = null;
    try {
      const childCwd = path.join(fixture.varRoot, "childF");
      fs.mkdirSync(childCwd, { recursive: true });
      const f = await spawnOwnedChild(fxToken, childCwd, [
        "rjson-argv0-F",
        "multi\nline cmd torture-test/var out-file marker",
      ]);
      children.push(f);
      await sleep(300);
      const pgid = psPgid(f.pid);
      assert.ok(/^[0-9]+$/.test(pgid), `ps pgid for owned pid ${f.pid} must be numeric`);

      // Start the fixture recorder at the minimum interval and let it run for
      // a few real sample rounds. The fresh per-invocation launch token rides
      // the start-subprocess env into the detached recorder (the recorder
      // runtime ignores it — it is identity evidence for this invocation only).
      const start = run(["bash", fixture.tool, "start", "--interval", "1"], {
        cwd: fixture.root,
        env: { ...process.env, RJSON_RECORDER_LAUNCH_TOKEN: fxToken },
        timeoutMs: 20_000,
      });
      assert.equal(start.status, 0, `start failed (rc=${start.status}): ${start.stderr}`);
      const pidfile = recorderPidfilePath(fixture.varRoot);
      assert.ok(fs.existsSync(pidfile), `pidfile must exist at ${pidfile}`);
      const recPid = fs.readFileSync(pidfile, "utf8").trim();
      assert.match(recPid, /^[0-9]+$/, `pidfile must hold a numeric pid, got ${JSON.stringify(recPid)}`);
      // Invocation-owned recorder handle: launch identity evidence (ps cmdline
      // + birth start) captured at start for the EXACT pid this invocation's
      // `start` wrote to the fixture pidfile, bound to this fixture+token —
      // never a bare re-read of the mutable pidfile or a generic name match.
      recorder = captureRecorderIdentity(fixture.varRoot, fxToken, Number(recPid));

      // The statefile records the startedAt + output file (generate_output_filename).
      const statefile = path.join(fixture.varRoot, "recorder", "current-state");
      let samplesPath: string | null = null;
      let payload = "";
      let seenOwned = false;
      for (let i = 0; i < 60 && !seenOwned; i++) {
        await sleep(250);
        if (fs.existsSync(statefile)) {
          const m = fs.readFileSync(statefile, "utf8").match(/^file=(.+)$/m);
          if (m) samplesPath = m[1].trim();
        }
        if (samplesPath && fs.existsSync(samplesPath)) {
          // Tolerant poll parse: the live file can be momentarily empty or
          // hold a partial trailing line mid-append; only complete records
          // count toward "seen". The strict every-record parse below runs
          // after the recorder is stopped and the file is stable.
          payload = fs.readFileSync(samplesPath, "utf8");
          seenOwned = parseCompleteLines(payload).some((e) => e.rec.pid === f.pid);
        }
      }
      assert.ok(seenOwned, `the owned child pid ${f.pid} must appear in the samples file within ~15 s`);
      assert.ok(samplesPath, "statefile must record the output file");
      assert.ok(
        /samples-\d{4}-\d{2}-\d{2}T\d{6}Z\.jsonl$/.test(samplesPath),
        `output file must follow samples-<startedAt>.jsonl, got ${samplesPath}`,
      );

      // Evidence-based stop of the exact recorder pid BEFORE the strict
      // every-record parse, so the samples file is stable (no mid-append
      // partial line can race the read). The recorder's own `stop` subcommand
      // signals the pidfile pid itself, so the CURRENT identity must still
      // prove THIS invocation's recorder before it may run — the ONE guarded
      // decision (assertRecorderStopProceeds); a stale/foreign pidfile or a
      // changed/unreadable identity REFUSES with evidence preserved. The
      // subcommand's internal stop semantics are the recorder's own
      // (unchanged, out of scope).
      assertRecorderStopProceeds(recorder, fixture.varRoot);
      const stop = run(["bash", fixture.tool, "stop"], { cwd: fixture.root, timeoutMs: 30_000 });
      assert.equal(stop.status, 0, `stop failed (rc=${stop.status}): ${stop.stderr}`);
      assert.match(stop.stdout, /tt-recorder stopped/, `stop must report stopped. stdout: ${stop.stdout}`);
      assert.ok(!pidAlive(Number(recPid)), `recorder pid ${recPid} must be dead after stop`);
      assert.ok(!fs.existsSync(pidfile), "stop must remove the pidfile");

      // Parse EVERY emitted record from the real output file: one physical
      // line per record, every line parseable, and the owned child's records
      // carry the exact expected fields with the multiline cmdline escaped.
      payload = fs.readFileSync(samplesPath, "utf8");
      // Every collect_sample record ends in '\n'; a stop that lands exactly
      // mid-append can leave ONE unterminated trailing fragment, which is not
      // a complete emitted record — drop that single fragment before the
      // strict every-record parse (never drop a terminated line).
      if (payload.length > 0 && !payload.endsWith("\n")) {
        const nl = payload.lastIndexOf("\n");
        payload = nl >= 0 ? payload.slice(0, nl + 1) : "";
      }
      const entries = parseEveryLine("samples file", payload);
      const ownedEntries = entries.filter((e) => e.rec.pid === f.pid);
      assert.ok(ownedEntries.length >= 1, `expected at least one record for owned pid ${f.pid}`);
      const expectedCwd = fs.realpathSync(childCwd);
      for (const entry of ownedEntries) {
        assertOwnedRecord(`owned pid ${f.pid} in samples file`, entry, f, expectedCwd, { pgid });
      }
    } finally {
      for (const ch of children) stopOwnedChild(ch);
      // Invocation-owned recorder cleanup (a stop that raced/failed above, or
      // a failed start's leftover pidfile): the ONE guarded decision inside
      // stopOwnedRecorder revalidates the CURRENT identity — pidfile content,
      // liveness, ps cmdline + birth start vs the launch evidence captured at
      // start — BEFORE EACH signal (TERM, then again before the KILL
      // escalation). A stale/foreign/changed/unreadable pidfile or identity,
      // or a recorder this invocation never captured (startup failure), never
      // receives a signal; the refusal stops this block BEFORE the fixture rm
      // so the refusal evidence survives.
      stopOwnedRecorder(recorder, fixture.varRoot);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
