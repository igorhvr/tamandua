/**
 * signal-boundary.test.ts — KHYG US-003: real owned-fixture signal-boundary
 * regression suite (Linux Landlock + macOS Seatbelt).
 *
 * Proves the REAL per-execution signal boundary of the implemented
 * isolation on actual hosts, using ONLY fresh owned child fixtures and
 * harmless caught signals (SIGUSR2 first). Every protected execution is
 * launched through the shared US-002 launch mechanism
 * (launchHarnessExecution) against the real US-001 backend (the compiled
 * dist/native/landlock-helper on Linux, /usr/bin/sandbox-exec with the
 * bundled seatbelt-signal.sb profile on macOS). All PIDs used in signal
 * assertions come from freshly spawned owned fixtures — never broad PID
 * selectors, never real services, never sensitive process arguments.
 *
 * Coverage (mirrors the coordinator's manual evidence in
 * torture-test/var/review-logs/native-signal-probes.DHNQbp/linux-final-full.log
 * and mac-final-full.log):
 *   1. Positive controls: a protected execution CAN signal its own child
 *      (pid and process group) via Node process.kill, the real bash/sh/zsh
 *      built-in kill, and external /bin/kill, and the child actually
 *      receives the signal.
 *   2. Negatives: from inside a protected execution the same four
 *      mechanisms all REFUSE to signal an unrelated owned fixture and an
 *      independent fixture running under its own identical fresh policy
 *      (a same-policy sibling in a separate domain tree).
 *   3. Inheritance: an orphaned/reparented descendant of a protected
 *      execution retains its outbound signal restriction across exec.
 *   4. Nested domains: a protected execution may create a fresh nested
 *      native domain inside its own, and (as the ancestor) still signal it.
 *   5. The unprotected parent (this test process, standing in for the
 *      scheduling daemon) can cancel its protected child exactly as before.
 *   6. A denied outbound signal is successful enforcement: the suite
 *      observes protected-mode launches (never an unprotected replay or
 *      fallback) and the protected worker runs to completion with exit 0
 *      after its denials.
 *
 * Host handling: probeBackend() (artifact availability) decides whether a
 * backend is even a candidate; a bounded owned STARTUP probe then proves the
 * candidate can actually apply a fresh signal domain on THIS host (runtime
 * ABI >= 6 / Landlock enabled, sandbox-exec usable). Only when both succeed
 * do the real-backend tests run. A compiled-but-runtime-unusable helper or a
 * present-but-unusable sandbox-exec is an honest capability skip carrying the
 * helper's own diagnostic; unexpected probe/protocol failures fail RED (no
 * blanket skip of failed launches). On the rollout Linux host (Landlock ABI
 * 8) and on actual macOS hosts the backend is usable and the tests MUST
 * execute — a skip where the backend is usable is a failure signal, not a
 * pass.
 *
 * Optional host mechanisms (the real bash/sh/zsh built-in kill and the
 * external /bin/kill) are host-gated: the embedded driver declares each one
 * present/absent in an explicit record, only runs checks for mechanisms that
 * exist, and the suite gates its required checks on those declarations — an
 * absent shell on some host is reported honestly, never a blanket suite
 * failure, while every mechanism that IS present must genuinely pass.
 *
 * Spawn-capable: listed in tests/serial-files.txt. Isolated temp
 * HOME/state/db with guards on; cleanup is scoped to this test's own fresh
 * scratch only.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";

import { createTempHome, cleanChildEnv } from "../../tests/helpers/test-env.ts";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import {
  launchHarnessExecution,
  HARNESS_ISOLATION_EVENT,
  type HarnessLaunchOutcome,
} from "../../dist/installer/harness-launch.js";
import {
  HELPER_EXIT_SETUP_FAILURE,
  LANDLOCK_CONTROL_FD,
  LANDLOCK_MIN_ABI,
  probeBackend,
  type NativeSignalBackend,
  type SeatbeltBackend,
} from "../../dist/installer/native-signal-backend.js";
import { getRunEvents } from "../../dist/installer/events.js";

/**
 * The owned-fixture signal-boundary driver (KHYG US-003). Runs INSIDE one
 * protected per-execution native signal domain. Static text — embedded
 * verbatim, byte-for-byte validated on the rollout Linux host.
 */
const DRIVER_JS = String.raw`// KHYG US-003 signal-boundary fixture driver (final shape, later embedded in
// the .test.ts as static text). Runs INSIDE a protected per-execution native
// signal domain (landlock helper or sandbox-exec bridge via the shared launch
// mechanism). Every signal target is a fresh owned child fixture; harmless
// SIGUSR2 (caught by the target) is used first. Emits one JSON object per
// line on stdout: {"kind":"ready"|"received"|"check"|"summary", ...}.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const NODE = process.execPath;
const SELF = process.argv[1];

function emit(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function validPid(v) { return Number.isSafeInteger(v) && v > 1; }

// Carry-buffer line assembly: stdout pipe chunks are not guaranteed to be
// whole JSON lines, so a record split across chunks must not be dropped
// (a dropped record would surface as a false required-check failure).
function makeLineSplitter(onLine) {
  let carry = "";
  return (d) => {
    carry += d.toString("utf8");
    for (;;) {
      const nl = carry.indexOf("\n");
      if (nl < 0) break;
      const t = carry.slice(0, nl).trim();
      carry = carry.slice(nl + 1);
      if (t !== "") onLine(t);
    }
  };
}

// Optional host mechanisms (shells / external kill). Each mode declares them
// present/absent up front as explicit records; checks only run for mechanisms
// that exist, and the suite gates its required checks on the declarations.
const OPTIONAL_MECHANISMS = ["/bin/bash", "/bin/sh", "/bin/zsh", "/bin/kill"];
function emitMechanisms(names) {
  for (const m of names) emit({ kind: "mechanism", name: m, present: fs.existsSync(m) });
}

function spawnTarget(driverPath) {
  const child = spawn(NODE, [driverPath, "target"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  const errs = [];
  child.stdout.on("data", makeLineSplitter((l) => lines.push(l)));
  child.stderr.on("data", (d) => errs.push(d.toString("utf8")));
  const closed = new Promise((res) => child.on("close", (code, signal) => res({ code, signal })));
  return { child, lines, errs, closed };
}

async function waitReady(c, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (c.lines.some((l) => l.includes('"kind":"ready"'))) return;
    if (c.child.exitCode !== null || c.child.signalCode !== null) {
      throw new Error("fixture exited before ready: pid=" + c.child.pid +
        " code=" + c.child.exitCode + " signal=" + c.child.signalCode + " stderr=" + c.errs.join(""));
    }
    if (Date.now() > deadline) throw new Error("fixture never ready: pid=" + c.child.pid + " lines=" + JSON.stringify(c.lines));
    await sleep(15);
  }
}

async function waitClosed(c, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (c.child.exitCode !== null || c.child.signalCode !== null) return c.closed;
    await sleep(15);
  }
  return null;
}

function signalAttempt(pid, group = false) {
  try { process.kill(group ? -pid : pid, "SIGUSR2"); return { allowed: true }; }
  catch (e) { return { allowed: false, code: e.code }; }
}

function quitTarget(c) { try { c.child.stdin.end(); } catch (e) { /* ignore */ } }

async function spawnNestedProtected(kind, a, b) {
  // Fresh native signal domain INSIDE the current (already restricted) domain,
  // using the product backend pieces (helper binary / sandbox-exec + profile).
  let argv;
  if (kind === "landlock") {
    argv = [a, "--control-fd", "3", "--", NODE, SELF, "target"];
  } else if (kind === "seatbelt") {
    const bridge =
      'export TAMANDUA_WORKER_PGID="$$"; ' +
      'printf "READY mode=seatbelt\\n" >&3 || exit 125; ' +
      "IFS= read -r __rel <&3 || exit 125; " +
      '[ "$__rel" = "GO" ] || exit 125; ' +
      'exec 3>&-; exec "$0" "$@"';
    argv = [a, "-p", b, "/bin/sh", "-c", bridge, NODE, SELF, "target"];
  } else {
    throw new Error("unknown nested kind: " + kind);
  }
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const ctl = child.stdio[3];
  const lines = [];
  const errs = [];
  child.stdout.on("data", makeLineSplitter((l) => lines.push(l)));
  child.stderr.on("data", (d) => errs.push(d.toString("utf8")));
  const closed = new Promise((res) => child.on("close", (code, signal) => res({ code, signal })));
  let ctlBuf = "";
  const readyLine = await new Promise((resolve) => {
    const onData = (d) => {
      ctlBuf += d.toString("utf8");
      const nl = ctlBuf.indexOf("\n");
      if (nl >= 0) resolve(ctlBuf.slice(0, nl).trim());
    };
    if (ctl) ctl.on("data", onData);
    child.on("close", () => resolve(null));
    setTimeout(() => resolve(null), 8000).unref();
  });
  if (readyLine === null || readyLine.indexOf("READY mode=") !== 0) {
    try { process.kill(-child.pid, "SIGKILL"); } catch (e) { /* ignore */ }
    throw new Error("nested domain never READY: " + readyLine + " errs=" + errs.join(""));
  }
  if (ctl) ctl.write("GO\n", () => { try { if (ctl) ctl.destroy(); } catch (e) { /* ignore */ } });
  return { child, lines, errs, closed, readyLine };
}

// ── mode: target ──
async function runTarget() {
  process.on("SIGUSR2", () => emit({ kind: "received", sig: "SIGUSR2", pid: process.pid }));
  process.stdin.on("data", () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));
  emit({ kind: "ready", pid: process.pid });
  setTimeout(() => process.exit(91), 30000);
}

// ── mode: pos — positive controls: own child + own process group ──
async function runPos() {
  let failures = 0;
  const check = (name, ok, detail) => { emit({ kind: "check", name, ok, detail }); if (!ok) failures++; };
  emitMechanisms(OPTIONAL_MECHANISMS);
  const own = spawnTarget(SELF);
  await waitReady(own);
  try {
    for (const group of [false, true]) {
      const r = signalAttempt(own.child.pid, group);
      check("node-own-child-" + (group ? "group" : "pid"), r.allowed === true, r);
    }
    for (const shell of ["/bin/bash", "/bin/sh", "/bin/zsh"]) {
      if (!fs.existsSync(shell)) continue; // absent: declared by the mechanism records above
      const r = spawnSync(shell, ["-c", 'kill -USR2 "$1"', "owned-fixture-probe", String(own.child.pid)],
        { encoding: "utf8", timeout: 5000 });
      check(shell + "-builtin-own-child", r.status === 0, { status: r.status, stderr: r.stderr });
    }
    if (fs.existsSync("/bin/kill")) {
      const r = spawnSync("/bin/kill", ["-USR2", String(own.child.pid)], { encoding: "utf8", timeout: 5000 });
      check("external-kill-own-child", r.status === 0, { status: r.status, stderr: r.stderr });
    }
    // Own child actually observed the allowed signals (bounded poll).
    let received = false;
    for (let i = 0; i < 200 && !received && own.child.exitCode === null; i++) {
      received = own.lines.some((l) => l.includes('"kind":"received"'));
      if (!received) await sleep(10);
    }
    check("own-child-actually-received-signal", received, { pid: own.child.pid, lines: own.lines });
  } finally {
    quitTarget(own);
    await waitClosed(own);
  }
  emit({ kind: "summary", failures });
  process.exitCode = failures ? 1 : 0;
}

// ── mode: neg — negatives: unrelated fixture + independent same-policy sibling ──
async function runNeg(outsidePid, siblingPid) {
  let failures = 0;
  const check = (name, ok, detail) => { emit({ kind: "check", name, ok, detail }); if (!ok) failures++; };
  emitMechanisms(OPTIONAL_MECHANISMS);
  for (const [label, pid] of [["outside", outsidePid], ["independent-sibling", siblingPid]]) {
    if (!validPid(pid)) { check("pid-valid-" + label, false, { pid }); continue; }
    for (const group of [false, true]) {
      const r = signalAttempt(pid, group);
      check("node-" + label + "-" + (group ? "group" : "pid"),
        r.allowed === false && r.code === "EPERM", r);
    }
    for (const shell of ["/bin/bash", "/bin/sh", "/bin/zsh"]) {
      if (!fs.existsSync(shell)) continue; // absent: declared by the mechanism records above
      const r = spawnSync(shell, ["-c", 'kill -USR2 "$1"', "owned-fixture-probe", String(pid)],
        { encoding: "utf8", timeout: 5000 });
      check(shell + "-builtin-" + label, r.status !== 0 && r.status !== null, { status: r.status, stderr: r.stderr });
    }
    if (fs.existsSync("/bin/kill")) {
      const r = spawnSync("/bin/kill", ["-USR2", String(pid)], { encoding: "utf8", timeout: 5000 });
      check("external-kill-" + label, r.status !== 0 && r.status !== null, { status: r.status, stderr: r.stderr });
    }
  }
  emit({ kind: "summary", failures });
  process.exitCode = failures ? 1 : 0;
}

// ── mode: nested — a fresh domain inside a domain; ancestor can signal it ──
async function runNested(kind, a, b) {
  let failures = 0;
  const check = (name, ok, detail) => { emit({ kind: "check", name, ok, detail }); if (!ok) failures++; };
  const nested = await spawnNestedProtected(kind, a, b);
  await waitReady(nested);
  const sig = signalAttempt(nested.child.pid);
  check("ancestor-can-signal-nested-domain", sig.allowed === true, { pid: nested.child.pid, ...sig });
  let received = false;
  for (let i = 0; i < 200 && !received && nested.child.exitCode === null; i++) {
    received = nested.lines.some((l) => l.includes('"kind":"received"'));
    if (!received) await sleep(10);
  }
  check("nested-domain-actually-received-signal", received, { pid: nested.child.pid, lines: nested.lines });
  quitTarget(nested);
  await waitClosed(nested);
  emit({ kind: "summary", failures });
  process.exitCode = failures ? 1 : 0;
}

// ── mode: orphan-parent / orphan-child — reparented descendant restriction ──
async function runOrphanParent(outsidePid) {
  const c = spawn(NODE, [SELF, "orphan-child", String(outsidePid), String(process.pid)], {
    detached: true, stdio: ["ignore", "inherit", "inherit"],
  });
  c.unref();
  process.exit(0);
}

async function runOrphanChild(outsidePid, originalParentPid) {
  let failures = 0;
  const check = (name, ok, detail) => { emit({ kind: "check", name, ok, detail }); if (!ok) failures++; };
  for (let i = 0; i < 200 && process.ppid === originalParentPid; i++) await sleep(10);
  const r = signalAttempt(outsidePid);
  check("reparented-descendant-still-refuses-outside",
    process.ppid !== originalParentPid && r.code === "EPERM",
    { originalParent: originalParentPid, currentParent: process.ppid, ...r });
  emit({ kind: "summary", failures });
  process.exitCode = failures ? 1 : 0;
}

// ── mode: orphan — run the reparent dance from inside a protected execution ──
async function runOrphan(outsidePid) {
  let failures = 0;
  const check = (name, ok, detail) => { emit({ kind: "check", name, ok, detail }); if (!ok) failures++; };
  if (!validPid(outsidePid)) { check("pid-valid-outside", false, { pid: outsidePid }); emit({ kind: "summary", failures }); process.exitCode = 1; return; }
  const op = spawn(NODE, [SELF, "orphan-parent", String(outsidePid)], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const opLines = [];
  op.stdout.on("data", makeLineSplitter((l) => opLines.push(l)));
  const opClosed = await new Promise((res) => op.on("close", (code, signal) => res({ code, signal })));
  check("reparenting-probe-completed", opClosed.code === 0, opClosed);
  const childCheck = opLines.find((l) => l.includes('"reparented-descendant-still-refuses-outside"'));
  check("reparented-descendant-refused-outside", childCheck !== undefined && childCheck.includes('"ok":true'), opLines);
  emit({ kind: "summary", failures });
  process.exitCode = failures ? 1 : 0;
}

// ── mode: deny — denied outbound signals are enforcement, not a failure ──
async function runDeny(outsidePid) {
  let failures = 0;
  const check = (name, ok, detail) => { emit({ kind: "check", name, ok, detail }); if (!ok) failures++; };
  emitMechanisms(["/bin/bash"]); // the only optional mechanism this mode uses
  if (!validPid(outsidePid)) { check("pid-valid-outside", false, { pid: outsidePid }); }
  const r1 = signalAttempt(outsidePid);
  check("deny-node-outside-pid", r1.allowed === false && r1.code === "EPERM", r1);
  const r2 = signalAttempt(outsidePid, true);
  check("deny-node-outside-group", r2.allowed === false && r2.code === "EPERM", r2);
  if (fs.existsSync("/bin/bash")) {
    const r3 = spawnSync("/bin/bash", ["-c", 'kill -USR2 "$1"', "owned-fixture-probe", String(outsidePid)],
      { encoding: "utf8", timeout: 5000 });
    check("deny-bash-outside", r3.status !== 0 && r3.status !== null, { status: r3.status, stderr: r3.stderr });
  }
  emit({ kind: "summary", failures });
  process.exitCode = failures ? 1 : 0;
}

const mode = process.argv[2];
if (mode === "target") await runTarget();
else if (mode === "pos") await runPos();
else if (mode === "neg") await runNeg(Number(process.argv[3]), Number(process.argv[4]));
else if (mode === "nested") await runNested(process.argv[3], process.argv[4], process.argv[5]);
else if (mode === "orphan-parent") await runOrphanParent(Number(process.argv[3]));
else if (mode === "orphan-child") await runOrphanChild(Number(process.argv[3]), Number(process.argv[4]));
else if (mode === "orphan") await runOrphan(Number(process.argv[3]));
else if (mode === "deny") await runDeny(Number(process.argv[3]));
else throw new Error("unknown mode " + mode);
`;

// ── Test-isolation state env ───────────────────────────────────────
let savedHome: string | undefined;
let savedStateDir: string | undefined;
let savedDbPath: string | undefined;
let isolationRoot: string | null = null;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  savedDbPath = process.env.TAMANDUA_DB_PATH;
  const env = createTempHome("tamandua-test-signal-boundary-state-");
  isolationRoot = env.root;
  process.env.HOME = env.homeDir;
  process.env.TAMANDUA_STATE_DIR = env.tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(env.tamanduaDir, "tamandua.db");
  assertStatePathIsolation(process.env.TAMANDUA_STATE_DIR, "signal-boundary test state");
  assertStatePathIsolation(process.env.TAMANDUA_DB_PATH, "signal-boundary test database");
});

afterEach(() => {
  if (isolationRoot !== null) {
    try {
      fs.rmSync(isolationRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    isolationRoot = null;
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = savedStateDir;
  if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
  else process.env.TAMANDUA_DB_PATH = savedDbPath;
});

// ── Host capability ────────────────────────────────────────────────
// probeBackend() selects a backend from ARTIFACTS only (helper binary /
// sandbox-exec + seatbelt profile). A compiled-but-runtime-unusable helper
// (kernel ABI < 6 at runtime, Landlock disabled at boot) or a present-but-
// unusable sandbox-exec would otherwise enter every native test below and
// fail the protected-mode assertion instead of an honest capability skip.
// A bounded owned STARTUP probe (probeStartupCapability, run once in
// before()) therefore proves the candidate can actually apply a fresh
// signal domain on THIS host; only its verdict decides skip vs run.
// Unexpected probe/helper/protocol failures still fail RED — never a
// blanket skip of failed launches.
const artifactBackend: NativeSignalBackend = probeBackend();
let protectedKind: "landlock" | "seatbelt" | null = null;
let capabilitySkipReason = "startup capability probe not yet run";

interface StartupCapability {
  kind: "landlock" | "seatbelt" | null;
  /** Human/machine-readable reason when kind === null (never empty). */
  skipReason: string;
}

// ── Bounded owned startup capability probe ─────────────────────────
// Each probe is a FRESH owned child fixture (never a broad PID selector,
// never a live service). It only decides usable/unusable; the enforcement
// behavior tests below do the real signal work.
const STARTUP_PROBE_WALL_MS = 10_000;
const STARTUP_PROBE_STDERR_MAX = 3000;

interface StartupProbeRun {
  child: ChildProcess;
  control: ((NodeJS.ReadWriteStream & { destroy?: () => void }) | null) | null;
  /** Non-null when the spawn itself failed (ENOENT & co). */
  spawnError: () => string | null;
  stderrText: () => string;
  closed: Promise<{ code: number | null; signal: string | null }>;
}

function killProbeGroup(run: StartupProbeRun): void {
  const c = run.child;
  if (c.exitCode !== null || c.signalCode !== null) return; // already gone
  try {
    if (c.pid !== undefined) process.kill(-c.pid, "SIGKILL");
  } catch {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function spawnStartupProbe(
  argv: string[],
  opts: { withControl: boolean; env?: NodeJS.ProcessEnv },
): StartupProbeRun {
  const stdio = opts.withControl
    ? (["pipe", "pipe", "pipe", "pipe"] as const)
    : (["pipe", "pipe", "pipe"] as const);
  const child = spawn(argv[0], argv.slice(1), {
    // env omitted -> the child inherits the ambient environment (the probe
    // never reads host state); an explicit env is built by cleanChildEnv so
    // the test file never spreads/forward the live process.env object.
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    stdio,
    detached: true,
  });
  const control = opts.withControl
    ? ((child.stdio[3] as NodeJS.ReadWriteStream & { destroy?: () => void }) ?? null)
    : null;
  let stderrBuf = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderrBuf = (stderrBuf + d.toString("utf8")).slice(-STARTUP_PROBE_STDERR_MAX);
  });
  let spawnErrorMessage: string | null = null;
  child.on("error", (err: Error) => {
    spawnErrorMessage = err.message;
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const finish = (): void => {
      resolve({ code: child.exitCode, signal: child.signalCode as string | null });
    };
    child.on("close", finish);
    child.on("error", finish); // a failed spawn may never emit 'close'
  });
  const run: StartupProbeRun = {
    child,
    control,
    spawnError: () => spawnErrorMessage,
    stderrText: () => stderrBuf,
    closed,
  };
  const watchdog = setTimeout(() => killProbeGroup(run), STARTUP_PROBE_WALL_MS + 5000);
  watchdog.unref();
  closed.finally(() => clearTimeout(watchdog)).catch(() => undefined);
  return run;
}

type ControlReadyResult =
  | { state: "ready"; line: string }
  | { state: "exited"; code: number | null; signal: string | null }
  | { state: "wall" };

/** Wait for the helper's READY frame on the private control channel (bounded). */
function waitForControlReady(run: StartupProbeRun, wallMs: number): Promise<ControlReadyResult> {
  const control = run.control;
  return new Promise<ControlReadyResult>((resolve) => {
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => finish({ state: "wall" }), wallMs);
    timer.unref?.();
    function finish(v: ControlReadyResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      control?.removeListener("data", onData);
      run.child.removeListener("close", onClose);
      run.child.removeListener("error", onError);
      resolve(v);
    }
    function onData(d: Buffer): void {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish({ state: "ready", line: buf.slice(0, nl).trim() });
    }
    function onClose(code: number | null, signal: NodeJS.Signals | null): void {
      finish({ state: "exited", code, signal: signal as string | null });
    }
    function onError(): void {
      // A failed spawn may never emit 'close'; the caller distinguishes via
      // run.spawnError().
      finish({ state: "exited", code: null, signal: null });
    }
    if (control !== null) control.on("data", onData);
    run.child.on("close", onClose);
    run.child.on("error", onError);
  });
}

function summarizeProbeStderr(text: string): string {
  const lines = text
    .trim()
    .split("\n")
    .filter((l) => l !== "");
  const tail = lines.slice(-2).join(" ").slice(0, 300);
  return tail === "" ? "no diagnostic output from the backend" : tail;
}

/**
 * Probe one Linux startup: the REAL landlock helper (fresh owned child) must
 * apply a fresh SIGNAL-scope domain and report READY, then run a trivial
 * target after release. Exit 125 before READY is the helper's documented
 * pre-exec setup-failure code, but ONLY the ABI gate's diagnostic
 * (stage=abi-below-minimum: ABI < 6 at runtime, Landlock disabled at boot)
 * is KNOWN platform unavailability -> honest skip with the helper's own
 * diagnostic. Any other 125 (control-channel or unexplained setup
 * diagnostic), a bad exit, signal death, malformed READY, or a missing READY
 * within the wall is UNEXPECTED and throws (the suite fails red — never a
 * blanket skip of failed launches).
 */
async function probeLandlockStartup(
  helperPath: string,
  opts?: { forceAbi?: string },
): Promise<StartupCapability> {
  const forced = opts?.forceAbi;
  const env =
    forced !== undefined
      ? cleanChildEnv({ TAMANDUA_LANDLOCK_HELPER_TEST_FORCE_ABI: forced })
      : undefined;
  const run = spawnStartupProbe(
    [helperPath, "--control-fd", String(LANDLOCK_CONTROL_FD), "--", "/bin/sh", "-c", "exit 0"],
    { withControl: true, env },
  );
  try {
    const outcome = await waitForControlReady(run, STARTUP_PROBE_WALL_MS);
    if (outcome.state === "ready") {
      const m = /^READY mode=landlock abi=(\d+)/.exec(outcome.line);
      if (m === null) {
        throw new Error(
          `landlock startup probe: malformed READY '${outcome.line}' (unexpected protocol failure); stderr: ${run.stderrText()}`,
        );
      }
      if (Number(m[1]) < LANDLOCK_MIN_ABI) {
        // Only reachable via the test-only ABI override env — defensive.
        return {
          kind: null,
          skipReason: `landlock helper present but runtime ABI ${m[1]} is below the required minimum ${LANDLOCK_MIN_ABI}`,
        };
      }
      // READY is only written AFTER the ABI gate and restrict_self succeeded,
      // so it proves a fresh SIGNAL-scope domain is usable on this kernel.
      run.control?.write("GO", () => {
        try {
          run.control?.destroy();
        } catch {
          /* best effort */
        }
      });
      const done = await run.closed;
      if (done.code !== 0) {
        throw new Error(
          `landlock startup probe: trivial protected target failed after release (code=${done.code} signal=${done.signal}); stderr: ${run.stderrText()}`,
        );
      }
      return { kind: "landlock", skipReason: "" };
    }
    if (outcome.state === "wall") {
      killProbeGroup(run);
      throw new Error(
        `landlock startup probe: helper never reported READY within ${STARTUP_PROBE_WALL_MS}ms; stderr: ${run.stderrText()}`,
      );
    }
    // The helper exited before READY.
    const spawnMsg = run.spawnError();
    if (spawnMsg !== null) {
      throw new Error(`landlock startup probe: helper spawn failed (${spawnMsg})`);
    }
    if (outcome.code === HELPER_EXIT_SETUP_FAILURE) {
      // The helper's documented pre-exec setup-failure code (exit 125, target
      // never ran) covers BOTH known platform unavailability AND helper or
      // protocol bugs. Only the ABI gate's diagnostic (stage=abi-below-
      // minimum: runtime ABI < 6, or Landlock unavailable/disabled on this
      // kernel) is a KNOWN platform-unavailable combination that justifies an
      // honest capability skip. Any other 125 — a control-channel or
      // unexplained setup diagnostic — fails RED: it must never silently skip
      // the whole boundary suite.
      const stderrText = run.stderrText();
      if (/stage=abi-below-minimum/.test(stderrText)) {
        return {
          kind: null,
          skipReason: `landlock helper present but unusable at startup (exit 125): ${summarizeProbeStderr(stderrText)}`,
        };
      }
      throw new Error(
        `landlock startup probe: helper exited 125 pre-READY with an unexpected setup diagnostic; stderr: ${summarizeProbeStderr(stderrText)}`,
      );
    }
    throw new Error(
      `landlock startup probe: unexpected pre-READY exit code=${outcome.code} signal=${outcome.signal}; stderr: ${run.stderrText()}`,
    );
  } finally {
    killProbeGroup(run);
  }
}

interface SeatbeltProbeResult {
  code: number | null;
  signal: string | null;
  stderr: string;
}

/** Run one trivial /bin/sh -c exit 0 under a seatbelt profile, bounded. */
async function runSeatbeltProbeCommand(
  sandboxExec: string,
  profileText: string,
): Promise<SeatbeltProbeResult> {
  const run = spawnStartupProbe([sandboxExec, "-p", profileText, "/bin/sh", "-c", "exit 0"], {
    withControl: false,
  });
  let wallFired = false;
  const timer = setTimeout(() => {
    wallFired = true;
    killProbeGroup(run);
  }, STARTUP_PROBE_WALL_MS);
  timer.unref?.();
  try {
    const done = await run.closed;
    if (wallFired) {
      throw new Error(
        `seatbelt startup probe: sandbox-exec did not exit within ${STARTUP_PROBE_WALL_MS}ms; stderr: ${run.stderrText()}`,
      );
    }
    const spawnMsg = run.spawnError();
    if (spawnMsg !== null) {
      throw new Error(`seatbelt startup probe: sandbox-exec spawn failed (${spawnMsg})`);
    }
    return { code: done.code, signal: done.signal, stderr: run.stderrText() };
  } finally {
    clearTimeout(timer);
    killProbeGroup(run);
  }
}

/**
 * Probe macOS startup: sandbox-exec must actually apply a profile and run a
 * command. Tier 1 uses a trivial known-good profile — a non-zero outcome
 * there means a present-but-unusable sandbox-exec (honest skip). Tier 2 uses
 * the real shipped signal profile — since the machinery was just proven, a
 * rejection there is a product/asset bug and throws red.
 */
async function probeSeatbeltStartup(backend: SeatbeltBackend): Promise<StartupCapability> {
  const profileText = fs.readFileSync(backend.profilePath, "utf8").trim();
  const trivial = await runSeatbeltProbeCommand(backend.sandboxExec, "(version 1) (allow default)");
  if (trivial.signal !== null) {
    // A sandbox-exec that dies by a signal is NOT proof of host
    // unavailability — unexpected, so it fails RED, never a blanket skip.
    throw new Error(
      `seatbelt startup probe: sandbox-exec died by ${trivial.signal} on a trivial known-good profile; stderr: ${trivial.stderr}`,
    );
  }
  if (trivial.code !== 0) {
    const detail = summarizeProbeStderr(trivial.stderr);
    return { kind: null, skipReason: `sandbox-exec present but unusable at startup: ${detail}` };
  }
  const real = await runSeatbeltProbeCommand(backend.sandboxExec, profileText);
  if (real.code !== 0 || real.signal !== null) {
    throw new Error(
      `seatbelt startup probe: shipped signal profile rejected (code=${real.code} signal=${real.signal}); stderr: ${real.stderr}`,
    );
  }
  return { kind: "seatbelt", skipReason: "" };
}

/** Decide whether the real-backend tests RUN or skip on this host. */
async function probeStartupCapability(backend: NativeSignalBackend): Promise<StartupCapability> {
  if (backend.kind === "unavailable") {
    return { kind: null, skipReason: `no native backend (${backend.reason})` };
  }
  if (backend.kind === "landlock") {
    return probeLandlockStartup(backend.helperPath);
  }
  return probeSeatbeltStartup(backend);
}

// ── Fixture handles / helpers ──────────────────────────────────────

const WATCHDOG_MS = 45_000;

interface Handle {
  child: ChildProcess;
  lines: string[];
  errs: string[];
  label: string;
  closed: Promise<{ code: number | null; signal: string | null }>;
}

/**
 * Carry-buffer stdout line assembly: pipe chunks are not guaranteed to be
 * whole JSON lines, so a record split across chunks must not be dropped (a
 * dropped record would surface as a false required-check failure).
 */
function makeLineCollector(onLine: (line: string) => void): (d: Buffer) => void {
  let carry = "";
  return (d: Buffer) => {
    carry += d.toString("utf8");
    for (;;) {
      const nl = carry.indexOf("\n");
      if (nl === -1) break;
      const t = carry.slice(0, nl).trim();
      carry = carry.slice(nl + 1);
      if (t !== "") onLine(t);
    }
  };
}

function collect(child: ChildProcess, label: string): Handle {
  const lines: string[] = [];
  const errs: string[] = [];
  child.stdout?.on("data", makeLineCollector((l) => lines.push(l)));
  child.stderr?.on("data", (d: Buffer) => errs.push(d.toString("utf8")));
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("close", (code, signal) =>
      resolve({ code, signal: signal as string | null }),
    );
  });
  // Watchdog: never strand a misbehaving fixture. Only kill a handle that is
  // still live — an exited leader whose pipes are still held open (e.g. by an
  // orphaned descendant) must not be signaled.
  const watchdog = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, WATCHDOG_MS);
  watchdog.unref();
  closed
    .finally(() => clearTimeout(watchdog))
    .catch(() => undefined);
  return { child, lines, errs, label, closed };
}

async function waitForLine(h: Handle, predicate: (line: string) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (h.lines.some(predicate)) return;
    if (h.child.exitCode !== null || h.child.signalCode !== null) {
      throw new Error(
        `${h.label} exited before the expected line: code=${h.child.exitCode} signal=${h.child.signalCode} lines=${JSON.stringify(h.lines)} stderr=${h.errs.join("")}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`${h.label} never produced the expected line: ${JSON.stringify(h.lines)}`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function stopHandle(h: Handle): Promise<void> {
  const c = h.child;
  if (c.exitCode !== null || c.signalCode !== null) return; // already gone
  try {
    if (c.pid !== undefined) process.kill(-c.pid, "SIGTERM");
  } catch {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await Promise.race([h.closed, new Promise((r) => setTimeout(r, 1200))]);
  if (c.exitCode === null && c.signalCode === null) {
    try {
      if (c.pid !== undefined) process.kill(-c.pid, "SIGKILL");
    } catch {
      try {
        c.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await Promise.race([h.closed, new Promise((r) => setTimeout(r, 800))]);
  }
}

/** Write the embedded driver into `dir` and return its absolute path. */
function writeDriver(dir: string): string {
  const p = path.join(dir, "signal-boundary-driver.mjs");
  fs.writeFileSync(p, DRIVER_JS, "utf8");
  return p;
}

async function launchProtected(opts: {
  driver: string;
  argv: string[];
  runId: string;
  cwd: string;
}): Promise<{ outcome: HarnessLaunchOutcome; handle: Handle }> {
  const outcome = await launchHarnessExecution({
    harness: "test",
    command: [process.execPath, opts.driver, ...opts.argv],
    cwd: opts.cwd,
    identity: { runId: opts.runId, agentId: "us003", stepId: "signal-boundary" },
  });
  if (outcome.status !== "launched") {
    throw new Error(`protected launch failed: ${JSON.stringify(outcome)}`);
  }
  return { outcome, handle: collect(outcome.child, `protected(${opts.argv[0]})`) };
}

/** Plain (unprotected) target fixture spawned by the test process. */
function spawnOutsideTarget(driver: string, label: string): Handle {
  const child = spawn(process.execPath, [driver, "target"], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return collect(child, label);
}

function parseWorkerOutput(lines: string[]): {
  checks: Map<string, boolean>;
  mechanisms: Map<string, boolean>;
  summaryFailures: number | null;
} {
  const checks = new Map<string, boolean>();
  const mechanisms = new Map<string, boolean>();
  let summaryFailures: number | null = null;
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as {
        kind?: string;
        name?: string;
        ok?: boolean;
        present?: boolean;
        failures?: number;
      };
      if (o.kind === "check" && typeof o.name === "string") {
        checks.set(o.name, o.ok === true);
      } else if (
        o.kind === "mechanism" &&
        typeof o.name === "string" &&
        typeof o.present === "boolean"
      ) {
        // The driver declares each optional host mechanism present/absent in
        // an explicit record so the suite can gate its required checks on
        // reality instead of assuming every shell exists on the host.
        mechanisms.set(o.name, o.present);
      } else if (o.kind === "summary" && typeof o.failures === "number") {
        summaryFailures = o.failures;
      }
    } catch {
      // non-JSON diagnostics from the worker (stderr would carry failures);
      // ignore here — the exit code and required-name assertions still bite.
    }
  }
  return { checks, mechanisms, summaryFailures };
}

function isolationRecords(runId: string): Array<Record<string, unknown>> {
  return getRunEvents(runId).filter((e) => e.event === HARNESS_ISOLATION_EVENT) as unknown as Array<
    Record<string, unknown>
  >;
}

/** Backend config tokens for the driver's nested-domain mode. */
function nestedTokens(): string[] {
  if (artifactBackend.kind === "landlock") return ["landlock", artifactBackend.helperPath];
  if (artifactBackend.kind === "seatbelt")
    return ["seatbelt", artifactBackend.sandboxExec, readProfileText()];
  throw new Error("nested tokens require a real backend");
}

function readProfileText(): string {
  if (artifactBackend.kind !== "seatbelt") return "";
  return fs.readFileSync(artifactBackend.profilePath, "utf8").trim();
}

/** Check names required only when an optional host mechanism is present. */
interface MechanismGatedChecks {
  /** Optional mechanism the driver declares present/absent (e.g. "/bin/zsh"). */
  mechanism: string;
  /** Check names the driver emits ONLY when the mechanism is present. */
  checkNames: string[];
}

async function assertProtectedWorkerPassed(opts: {
  outcome: HarnessLaunchOutcome;
  handle: Handle;
  runId: string;
  requiredChecks: string[];
  /** Optional-mechanism gating (see MechanismGatedChecks). */
  mechanismGating?: MechanismGatedChecks[];
  extraMessage?: string;
}): Promise<void> {
  const { outcome, handle, runId, mechanismGating } = opts;
  assert.equal(outcome.status, "launched");
  if (outcome.status !== "launched") return;
  assert.equal(outcome.mode, protectedKind, "launch must be protected — never a fallback");
  assert.notEqual(outcome.mode, "unprotected-fallback");
  const done = await handle.closed;
  assert.equal(done.code, 0, `worker must exit 0; stderr: ${handle.errs.join("")}`);
  const { checks, mechanisms, summaryFailures } = parseWorkerOutput(handle.lines);
  assert.equal(summaryFailures, 0, `worker reported failures: ${JSON.stringify(handle.lines)}`);
  const required = new Set(opts.requiredChecks);
  for (const g of mechanismGating ?? []) {
    // The driver must declare every optional mechanism this suite cares about
    // — present OR absent — so an absent mechanism is an explicit record,
    // never a silently skipped check.
    assert.ok(
      mechanisms.has(g.mechanism),
      `driver must declare optional mechanism '${g.mechanism}' present/absent (${opts.extraMessage ?? "lines"}): ${JSON.stringify(handle.lines)}`,
    );
    const present = mechanisms.get(g.mechanism) === true;
    for (const name of g.checkNames) {
      if (present) {
        required.add(name);
      } else {
        // Absent mechanism: the driver must NOT have emitted (silently run)
        // the mechanism's checks — the absent-mechanism record governs.
        assert.equal(
          checks.has(name),
          false,
          `check '${name}' must not be emitted when '${g.mechanism}' is absent: ${JSON.stringify(handle.lines)}`,
        );
      }
    }
  }
  for (const name of required) {
    assert.equal(
      checks.get(name),
      true,
      `required check '${name}' must pass (${opts.extraMessage ?? "lines"}): ${JSON.stringify(handle.lines)}`,
    );
  }
  // Every reported check must pass (a hidden failure is a red flag even if
  // the required subset passes).
  for (const [name, ok] of checks) {
    assert.equal(ok, true, `worker check '${name}' failed: ${JSON.stringify(handle.lines)}`);
  }
  const records = isolationRecords(runId);
  assert.ok(records.length >= 1, "protected launch must carry an isolation-mode record");
  for (const r of records) {
    assert.equal(r.mode, protectedKind, "every isolation record must be the protected mode");
    assert.notEqual(r.mode, "unprotected-fallback");
  }
}

describe("KHYG US-003 native signal boundary (real owned fixtures)", () => {
  before(async () => {
    // Bound the real-backend tests by a live owned STARTUP probe: artifact
    // presence alone (probeBackend) does not prove the helper/sandbox-exec
    // can apply a fresh domain on THIS host. Known runtime unavailability
    // (e.g. ABI < 6, Landlock disabled, sandbox-exec unusable) becomes an
    // honest capability skip; unexpected probe failures throw here and fail
    // the suite RED.
    const cap = await probeStartupCapability(artifactBackend);
    protectedKind = cap.kind;
    capabilitySkipReason = cap.skipReason;
  });

  it("records the host capability honestly (usable backend -> suite runs; absent/unusable -> honest skip)", () => {
    if (protectedKind === null) {
      // Honest capability-skip bookkeeping on hosts without a usable backend.
      console.log(
        `signal-boundary (US-003): capability skip on this host: ${capabilitySkipReason}`,
      );
      assert.ok(capabilitySkipReason.length > 0, "a skipped host must carry an explicit reason");
      return;
    }
    console.log(`signal-boundary (US-003): real backend usable on this host: ${protectedKind}`);
    assert.ok(protectedKind === "landlock" || protectedKind === "seatbelt");
  });

  it("startup probe classifies a runtime-unusable helper as an honest skip (forced ABI < 6)", { timeout: 30000 }, async (t) => {
    if (artifactBackend.kind !== "landlock") {
      return t.skip("requires the compiled landlock helper artifact on linux");
    }
    // Drive the REAL helper with its test-only ABI override: the probe must
    // report known-unavailable (kind null + explicit reason) rather than
    // letting the suite enter native tests that could never be protected.
    const cap = await probeLandlockStartup(artifactBackend.helperPath, { forceAbi: "3" });
    assert.equal(cap.kind, null, "forced ABI below the minimum must classify as known-unavailable");
    assert.ok(cap.skipReason.length > 0, "the skip reason must explain the unavailability");
    assert.match(
      cap.skipReason,
      /abi-below-minimum|below required minimum|unusable/,
      `skip reason should surface the helper's own diagnostic: ${cap.skipReason}`,
    );
  });

  it("startup probe fails RED on unexpected helper/protocol failures (never a blanket skip)", { timeout: 30000 }, async () => {
    // Owned fixture shims stand in for a misbehaving helper: the probe must
    // throw (suite fails red) for a control-protocol 125 diagnostic and for
    // death by signal before READY — neither is known platform unavailability.
    const scratch = tamanduaTempDir("tamandua-sb-probered-");
    try {
      const setupFailShim = path.join(scratch, "helper-setup-fail.sh");
      fs.writeFileSync(
        setupFailShim,
        "#!/bin/sh\n" +
          'echo "tamandua-landlock-helper: pre-exec setup failure stage=control-poll detail=control fd failed errno=0 (none)" >&2\n' +
          "exit 125\n",
        { mode: 0o755 },
      );
      const signalDeathShim = path.join(scratch, "helper-signal-death.sh");
      fs.writeFileSync(signalDeathShim, "#!/bin/sh\nexec kill -9 $$\n", { mode: 0o755 });
      await assert.rejects(
        probeLandlockStartup(setupFailShim),
        /unexpected setup diagnostic/,
        "an exit-125 control-protocol diagnostic must fail red, never skip",
      );
      await assert.rejects(
        probeLandlockStartup(signalDeathShim),
        /unexpected pre-READY exit code=null signal=SIGKILL/,
        "a helper that dies by signal before READY must fail red, never skip",
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("POSITIVE control: a protected execution signals its own child and its own process group", { timeout: 60000 }, async (t) => {
    if (protectedKind === null) return t.skip(capabilitySkipReason);
    const scratch = tamanduaTempDir("tamandua-sb-pos-");
    try {
      const driver = writeDriver(scratch);
      const { outcome, handle } = await launchProtected({
        driver,
        argv: ["pos"],
        runId: "run-khyg-us003-pos",
        cwd: scratch,
      });
      await assertProtectedWorkerPassed({
        outcome,
        handle,
        runId: "run-khyg-us003-pos",
        requiredChecks: [
          "node-own-child-pid",
          "node-own-child-group",
          "own-child-actually-received-signal",
        ],
        mechanismGating: [
          { mechanism: "/bin/bash", checkNames: ["/bin/bash-builtin-own-child"] },
          { mechanism: "/bin/sh", checkNames: ["/bin/sh-builtin-own-child"] },
          { mechanism: "/bin/zsh", checkNames: ["/bin/zsh-builtin-own-child"] },
          { mechanism: "/bin/kill", checkNames: ["external-kill-own-child"] },
        ],
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("NEGATIVE: a protected execution cannot signal an unrelated fixture or a same-policy sibling", { timeout: 90000 }, async (t) => {
    if (protectedKind === null) return t.skip(capabilitySkipReason);
    const scratch = tamanduaTempDir("tamandua-sb-neg-");
    const handles: Handle[] = [];
    try {
      const driver = writeDriver(scratch);
      const runId = "run-khyg-us003-neg";
      // Unrelated owned fixture (unprotected child of this test process).
      const outside = spawnOutsideTarget(driver, "outside");
      handles.push(outside);
      await waitForLine(outside, (l) => l.includes('"kind":"ready"'), 10000);
      // Independent same-policy sibling: its OWN fresh protected domain.
      const sib = await launchProtected({ driver, argv: ["target"], runId, cwd: scratch });
      handles.push(sib.handle);
      await waitForLine(sib.handle, (l) => l.includes('"kind":"ready"'), 15000);

      const worker = await launchProtected({
        driver,
        argv: ["neg", String(outside.child.pid), String(sib.outcome.pid)],
        runId,
        cwd: scratch,
      });
      handles.push(worker.handle);
      await assertProtectedWorkerPassed({
        outcome: worker.outcome,
        handle: worker.handle,
        runId,
        requiredChecks: [
          "node-outside-pid",
          "node-outside-group",
          "node-independent-sibling-pid",
          "node-independent-sibling-group",
        ],
        mechanismGating: [
          {
            mechanism: "/bin/bash",
            checkNames: ["/bin/bash-builtin-outside", "/bin/bash-builtin-independent-sibling"],
          },
          {
            mechanism: "/bin/sh",
            checkNames: ["/bin/sh-builtin-outside", "/bin/sh-builtin-independent-sibling"],
          },
          {
            mechanism: "/bin/zsh",
            checkNames: ["/bin/zsh-builtin-outside", "/bin/zsh-builtin-independent-sibling"],
          },
          {
            mechanism: "/bin/kill",
            checkNames: ["external-kill-outside", "external-kill-independent-sibling"],
          },
        ],
      });
      // Enforcement really happened: neither target received any signal.
      assert.equal(
        outside.lines.some((l) => l.includes('"kind":"received"')),
        false,
        `unrelated fixture must not receive signals: ${JSON.stringify(outside.lines)}`,
      );
      assert.equal(
        sib.handle.lines.some((l) => l.includes('"kind":"received"')),
        false,
        `same-policy sibling must not receive signals: ${JSON.stringify(sib.handle.lines)}`,
      );
      // Two protected launches in this test (sibling + worker): exactly two records.
      const records = isolationRecords(runId);
      assert.equal(records.length, 2, `expected 2 isolation records, got ${records.length}`);
    } finally {
      for (const h of handles) await stopHandle(h);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("INHERITANCE: an orphaned/reparented descendant keeps the outbound restriction", { timeout: 60000 }, async (t) => {
    if (protectedKind === null) return t.skip(capabilitySkipReason);
    const scratch = tamanduaTempDir("tamandua-sb-orphan-");
    const handles: Handle[] = [];
    try {
      const driver = writeDriver(scratch);
      const runId = "run-khyg-us003-orphan";
      const outside = spawnOutsideTarget(driver, "outside");
      handles.push(outside);
      await waitForLine(outside, (l) => l.includes('"kind":"ready"'), 10000);
      const worker = await launchProtected({
        driver,
        argv: ["orphan", String(outside.child.pid)],
        runId,
        cwd: scratch,
      });
      handles.push(worker.handle);
      await assertProtectedWorkerPassed({
        outcome: worker.outcome,
        handle: worker.handle,
        runId,
        requiredChecks: [
          "reparenting-probe-completed",
          "reparented-descendant-refused-outside",
        ],
      });
      assert.equal(
        outside.lines.some((l) => l.includes('"kind":"received"')),
        false,
        `reparented descendant must not reach the unrelated fixture: ${JSON.stringify(outside.lines)}`,
      );
    } finally {
      for (const h of handles) await stopHandle(h);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("NESTED: a fresh native domain created inside a protected execution works (ancestor may signal it)", { timeout: 60000 }, async (t) => {
    if (protectedKind === null) return t.skip(capabilitySkipReason);
    const scratch = tamanduaTempDir("tamandua-sb-nested-");
    try {
      const driver = writeDriver(scratch);
      const runId = "run-khyg-us003-nested";
      const { outcome, handle } = await launchProtected({
        driver,
        argv: ["nested", ...nestedTokens()],
        runId,
        cwd: scratch,
      });
      await assertProtectedWorkerPassed({
        outcome,
        handle,
        runId,
        requiredChecks: [
          "ancestor-can-signal-nested-domain",
          "nested-domain-actually-received-signal",
        ],
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("ENFORCEMENT: denied outbound signals are success — protected mode, no fallback, no replay", { timeout: 60000 }, async (t) => {
    if (protectedKind === null) return t.skip(capabilitySkipReason);
    const scratch = tamanduaTempDir("tamandua-sb-deny-");
    const handles: Handle[] = [];
    try {
      const driver = writeDriver(scratch);
      const runId = "run-khyg-us003-deny";
      const outside = spawnOutsideTarget(driver, "outside");
      handles.push(outside);
      await waitForLine(outside, (l) => l.includes('"kind":"ready"'), 10000);
      const worker = await launchProtected({
        driver,
        argv: ["deny", String(outside.child.pid)],
        runId,
        cwd: scratch,
      });
      handles.push(worker.handle);
      await assertProtectedWorkerPassed({
        outcome: worker.outcome,
        handle: worker.handle,
        runId,
        requiredChecks: ["deny-node-outside-pid", "deny-node-outside-group"],
        mechanismGating: [{ mechanism: "/bin/bash", checkNames: ["deny-bash-outside"] }],
      });
      // Exactly one isolation record: the protected launch. A denied signal
      // must never produce an unprotected-fallback record or a replay.
      const records = isolationRecords(runId);
      assert.equal(records.length, 1, `no replay: exactly 1 isolation record, got ${records.length}`);
      assert.equal(records[0].mode, protectedKind);
      assert.equal(
        outside.lines.some((l) => l.includes('"kind":"received"')),
        false,
        `denied signal must not reach the target: ${JSON.stringify(outside.lines)}`,
      );
    } finally {
      for (const h of handles) await stopHandle(h);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("the unprotected parent (test process) can cancel its protected child as before", { timeout: 60000 }, async (t) => {
    if (protectedKind === null) return t.skip(capabilitySkipReason);
    const scratch = tamanduaTempDir("tamandua-sb-cancel-");
    const handles: Handle[] = [];
    try {
      const driver = writeDriver(scratch);
      const runId = "run-khyg-us003-cancel";
      const victim = await launchProtected({ driver, argv: ["target"], runId, cwd: scratch });
      handles.push(victim.handle);
      await waitForLine(victim.handle, (l) => l.includes('"kind":"ready"'), 15000);
      const closed = victim.handle.closed;
      // Group SIGTERM, exactly like the scheduler cancels an in-flight round.
      assert.ok(victim.outcome.pgid > 0, "launched child must lead its own process group");
      process.kill(-victim.outcome.pgid, "SIGTERM");
      const done = await closed;
      assert.equal(done.code, null, "cancelled protected child must die by the signal");
      assert.equal(done.signal, "SIGTERM", "the parent's cancellation reaches the protected child");
      const records = isolationRecords(runId);
      assert.equal(records.length, 1);
      assert.equal(records[0].mode, protectedKind);
    } finally {
      for (const h of handles) await stopHandle(h);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
