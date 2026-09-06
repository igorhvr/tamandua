/**
 * signal-isolation-compat.test.ts — KHYG US-004 focused compatibility and
 * packaging tests for the automatic per-execution native signal isolation.
 *
 * The KHYG feature must be invisible to harness executions: protected
 * launches (fixture-shaped AND the real native backend when one is usable
 * on this host) must behave identically to the unprotected baseline for
 * argv boundaries, stdin/stdout/stderr forwarding, normal file access, and
 * reachability of an outside random-port network fixture. When the backend
 * is unavailable or fails before release, the safe fallback must still run
 * the harness normally while durably recording mode=unprotected-fallback
 * (reason + run identity + UTC) WITHOUT leaking prompts or secrets. The
 * native artifact / Seatbelt profile resolver must anchor to the
 * module/install root, never process.cwd().
 *
 * Suites:
 *  - launch compatibility vs unprotected baseline (fixture backend — always
 *    runs, host-independent): argv boundaries (very long prompts, leading
 *    dashes, embedded spaces/newlines) and stdin/stdout/stderr forwarding.
 *  - real-backend compatibility (gated on a bounded actual STARTUP probe —
 *    see probeRealStartup): argv/stdio parity, normal file access,
 *    cross-directory hardlink/rename, and outbound reachability of an
 *    outside random-port network fixture. Known host unavailability may
 *    skip; unexpected protocol/exec/signal failures stay red. On the
 *    rollout hosts the real tests MUST execute.
 *  - backend-unavailable fallback (test-only hook) — harness runs normally,
 *    warning visible + durable mode record, and neither the record nor the
 *    state log contains a canary secret that was part of the launch argv.
 *  - artifact/install resolution — module-root-relative, cwd-independent,
 *    and honest install-relocation: a copy of the real built module loaded
 *    from an install-shaped layout resolves through its DEFAULT resolver
 *    (present/absent/authoritative-marker).
 *
 * Spawn-capable (real launches + fixture helpers): listed in
 * tests/serial-files.txt.
 */
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTempHome } from "../../tests/helpers/test-env.ts";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import {
  launchHarnessExecution,
  HARNESS_ISOLATION_EVENT,
  type HarnessLaunchOutcome,
} from "../../dist/installer/harness-launch.js";
import {
  probeBackend,
  nativeArtifactsDir,
  LANDLOCK_HELPER_BASENAME,
  SEATBELT_PROFILE_BASENAME,
  UNAVAILABLE_MARKER_BASENAME,
  type NativeSignalBackend,
} from "../../dist/installer/native-signal-backend.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { formatLogsTailLine } from "../../dist/installer/logs-tail-format.js";

// ── Test-isolation state env ───────────────────────────────────────
// Launches emit logger lines and (with identity) run.harness_isolation
// events; both resolve TAMANDUA_STATE_DIR at write time. Isolate every
// test with a temp HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH.
let savedHome: string | undefined;
let savedStateDir: string | undefined;
let savedDbPath: string | undefined;
let isolationRoot: string | null = null;

function saveEnv(): void {
  savedHome = process.env.HOME;
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  savedDbPath = process.env.TAMANDUA_DB_PATH;
}

function isolateEnv(): string {
  const env = createTempHome("tamandua-test-compat-state-");
  isolationRoot = env.root;
  process.env.HOME = env.homeDir;
  process.env.TAMANDUA_STATE_DIR = env.tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(env.tamanduaDir, "tamandua.db");
  assertStatePathIsolation(process.env.TAMANDUA_STATE_DIR, "signal-isolation-compat test state");
  assertStatePathIsolation(process.env.TAMANDUA_DB_PATH, "signal-isolation-compat test database");
  return env.tamanduaDir;
}

function restoreEnv(): void {
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
}

beforeEach(() => {
  saveEnv();
  isolateEnv();
});

afterEach(() => {
  restoreEnv();
});

// ── Scratch / fixture helpers ──────────────────────────────────────

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function writeNodeDriver(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf8");
  return p;
}

/**
 * A fixture "landlock helper" standing in for dist/native/landlock-helper:
 * validates --control-fd/-- argv, reports READY mode=landlock on fd 3,
 * waits for the parent release, then execs the harness exactly once.
 */
function writeGoodHelper(dir: string): string {
  const p = path.join(dir, LANDLOCK_HELPER_BASENAME);
  writeExecutable(
    p,
    "#!/bin/sh\n" +
      '[ "$1" = "--control-fd" ] && [ "$3" = "--" ] || exit 124\n' +
      "shift 3\n" +
      'printf \'READY mode=landlock abi=8 pid=%s\\n\' "$$" >&3 || exit 125\n' +
      "IFS= read -r __rel <&3 || exit 125\n" +
      '[ "$__rel" = "GO" ] || exit 125\n' +
      "exec 3>&-\n" +
      'exec "$@"\n',
  );
  return p;
}

const CHILD_WATCHDOG_MS = 30_000;

/**
 * Drain a launched child to completion; optionally feed stdin first. Bounded:
 * a watchdog group-SIGKILLs ONLY a still-live owned handle (an exited leader
 * whose pipes are still held is never signaled), so a misbehaving fixture can
 * never strand a test. `wallMs` overrides the watchdog bound (defaults to
 * CHILD_WATCHDOG_MS) for faster-failing focused probes.
 */
function runChildToCompletion(
  child: ChildProcess,
  stdin?: Buffer,
  wallMs?: number,
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const watchdog = setTimeout(() => {
      if (settled) return;
      // Kill ONLY a still-live owned group (an exited leader whose pipes are
      // still held is never signaled — no historical-PID kills).
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
      // The watchdog must settle the promise itself ON the bound: if the
      // leader already exited while an owned pipe is still held open (e.g.
      // by an un-killable descendant in a different group), the 'close'
      // event never fires and the promised bound would not exist. Settle
      // here and release only the pipes this collector owns.
      if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          if (stream === null || stream === undefined) continue;
          try {
            (stream as { destroy?: () => void }).destroy?.();
          } catch {
            /* best effort */
          }
        }
        reject(
          new Error(
            `child did not exit within ${wallMs ?? CHILD_WATCHDOG_MS}ms (exitCode=${child.exitCode} signalCode=${child.signalCode})`,
          ),
        );
      }
    }, wallMs ?? CHILD_WATCHDOG_MS);
    watchdog.unref?.();
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin?.on("error", () => {
        /* peer gone — close handler settles */
      });
      child.stdin?.end(stdin);
    }
  });
}

interface RunResult {
  outcome: HarnessLaunchOutcome;
  done: { code: number | null; signal: string | null; stdout: string; stderr: string };
}

/** Scalar launch diagnostic for assertion messages (never the live child). */
function outcomeDiag(outcome: HarnessLaunchOutcome): string {
  return `status=${outcome.status} mode=${outcome.mode ?? "n/a"} reason=${outcome.reason ?? ""} timedOut=${outcome.timedOut === true}`;
}

/**
 * Run `command` once through the shared launch mechanism.
 *  - protected: seams.probe points at `fixtureDir` (fake landlock helper) —
 *    host-independent protected-shaped launch, or the real backend when
 *    probe is not overridden.
 *  - unprotected baseline: forceFallbackReason (the pre-isolation spawn
 *    shape).
 */
async function runLaunch(opts: {
  command: string[];
  cwd: string;
  protectedFixtureDir?: string;
  fallbackReason?: string;
  runId?: string;
  stdin?: Buffer;
}): Promise<RunResult> {
  const outcome = await launchHarnessExecution({
    harness: "test",
    command: opts.command,
    cwd: opts.cwd,
    identity: opts.runId !== undefined ? { runId: opts.runId } : undefined,
    seams:
      opts.fallbackReason !== undefined
        ? { forceFallbackReason: opts.fallbackReason }
        : opts.protectedFixtureDir !== undefined
          ? { probe: { platform: "linux", artifactDir: opts.protectedFixtureDir } }
          : undefined,
  });
  assert.equal(outcome.status, "launched", `launch must succeed (${outcomeDiag(outcome)})`);
  const done = await runChildToCompletion(outcome.child, opts.stdin);
  return { outcome, done };
}

/** Filter a run's event stream for run.harness_isolation records. */
function isolationRecords(runId: string): Array<Record<string, unknown>> {
  return getRunEvents(runId).filter(
    (e) => e.event === HARNESS_ISOLATION_EVENT,
  ) as unknown as Array<Record<string, unknown>>;
}

// ── Embedded node driver for harness-side behavior ─────────────────
// Modes:
//   argv <outFile>          write JSON of the argv delivered after the driver
//   stdio                   echo stdin -> stdout, fixed marker -> stderr
//   fileops <resultsFile>   write/read + cross-directory hardlink/rename
//   net <host> <port> <tok> connect, round-trip a token
const COMPAT_DRIVER = String.raw`
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const [mode, ...rest] = process.argv.slice(2);

if (mode === "argv") {
  // argv layout: [node, driver, "argv", outFile, ...deliveredArgs]
  fs.writeFileSync(rest[0], JSON.stringify(rest.slice(1)));
  process.exit(0);
}

if (mode === "stdio") {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    process.stdout.write(Buffer.concat(chunks));
    process.stdout.write("\nSTDOUT_END\n");
    process.stderr.write("STDERR_MARKER\n");
    process.exit(0);
  });
}

if (mode === "fileops") {
  try {
    const cwd = process.cwd();
    const a = path.join(cwd, "a.txt");
    fs.writeFileSync(a, "file-content\n");
    fs.mkdirSync(path.join(cwd, "subA"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "subB"), { recursive: true });
    // Cross-directory hardlink then rename (same filesystem, two dirs).
    fs.linkSync(a, path.join(cwd, "subA", "hard.txt"));
    fs.renameSync(path.join(cwd, "subA", "hard.txt"), path.join(cwd, "subB", "renamed.txt"));
    const readBack = fs.readFileSync(path.join(cwd, "subB", "renamed.txt"), "utf8");
    fs.writeFileSync(rest[0], JSON.stringify({ ok: readBack === "file-content\n" }));
  } catch (err) {
    fs.writeFileSync(rest[0], JSON.stringify({ ok: false, error: String(err) }));
  }
  process.exit(0);
}

if (mode === "net") {
  const [host, portStr, token] = rest;
  const sock = net.connect(Number(portStr), host, () => {
    sock.write(token);
  });
  const timer = setTimeout(() => {
    process.stdout.write("NET_TIMEOUT\n");
    process.exit(1);
  }, 5000);
  sock.on("data", (d) => {
    clearTimeout(timer);
    process.stdout.write("NET:" + d.toString("utf8") + "\n");
    sock.end();
  });
  sock.on("end", () => process.exit(0));
  sock.on("error", (err) => {
    clearTimeout(timer);
    process.stdout.write("NET_ERROR:" + String(err) + "\n");
    process.exit(1);
  });
}
`;

function writeCompatDriver(dir: string): string {
  return writeNodeDriver(dir, "compat-driver.mjs", COMPAT_DRIVER);
}

/** Start an outside (unprotected test-parent) random-port echo server. */
function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.on("data", (d) => sock.write(d));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to bind echo server"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

// ── Host capability (bounded actual STARTUP probe, not artifact-only) ──
const artifactBackend: NativeSignalBackend = probeBackend();
const realKind: "landlock" | "seatbelt" | null =
  artifactBackend.kind === "landlock" || artifactBackend.kind === "seatbelt"
    ? artifactBackend.kind
    : null;

interface StartupVerdict {
  kind: "landlock" | "seatbelt" | null;
  /** Non-empty when kind === null: honest known-unavailable skip reason. */
  skipReason: string;
}

const KNOWN_UNAVAILABLE_RE = /abi-below-minimum|Landlock unavailable|landlock-helper-not-built|sandbox-exec-missing|seatbelt-profile-missing|unsupported-platform|below required minimum/i;

// ── macOS present-but-unusable seatbelt two-tier rule ──────────────
// sandbox-exec may be PRESENT (executable) yet unusable on this host (e.g.
// the OS/policy refuses to apply ANY profile). That is NOT an artifact-level
// KNOWN_UNAVAILABLE reason (sandbox-exec exists, profile asset exists) — it
// surfaces at startup as an unexpected unprotected fallback. Before calling
// that RED, prove host inability the same way signal-boundary.test.ts does:
//   Tier 1: a bounded trivial known-good profile. A NORMAL nonzero exit there
//           means a present-but-unusable sandbox-exec (honest skip).
//   Tier 2: a signal death on the trivial profile, or failure of the REAL
//           profile after the trivial profile succeeded, is RED — never a
//           blanket regex skip of arbitrary real-profile failures.
const SEATBELT_TRIVIAL_PROFILE = "(version 1) (allow default)";
const SEATBELT_PROBE_WALL_MS = 10_000;

interface SeatbeltProbeOutcome {
  code: number | null;
  signal: string | null;
  stderr: string;
}

/** Run one bounded trivial sandbox-exec profile application; fresh owned child. */
async function runSeatbeltProbeCommand(
  sandboxExec: string,
  profileText: string,
): Promise<SeatbeltProbeOutcome> {
  const child = spawn(
    sandboxExec,
    ["-p", profileText, "/bin/sh", "-c", "exit 0"],
    // detached: true — the shared collector's watchdog group-signals the
    // owned child at -child.pid, which assumes the child leads its own
    // process group (see runChildToCompletion). Without it, the trivial
    // probe child shares the test's group and the watchdog cannot bound it.
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const done = await runChildToCompletion(child, undefined, SEATBELT_PROBE_WALL_MS);
  return { code: done.code, signal: done.signal, stderr: done.stderr };
}

function summarizeSeatbeltStderr(text: string): string {
  const tail = text.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
  return tail === "" ? "no diagnostic output from sandbox-exec" : tail;
}

/**
 * Decide whether an unexpected seatbelt startup fallback is a present-but-
 * unusable sandbox-exec (honest skip) or a genuine product/profile failure
 * (throws RED). Uses the same two-tier rule already proved in US-003.
 */
async function probeSeatbeltPresentButUnusable(
  sandboxExec: string,
  fallbackDiag: string,
): Promise<StartupVerdict> {
  const trivial = await runSeatbeltProbeCommand(sandboxExec, SEATBELT_TRIVIAL_PROFILE);
  if (trivial.signal !== null) {
    // A sandbox-exec that dies by a signal is NOT proof of host
    // unavailability — unexpected, so it fails RED.
    throw new Error(
      `real startup probe: sandbox-exec died by ${trivial.signal} on a trivial known-good profile; stderr: ${summarizeSeatbeltStderr(trivial.stderr)}`,
    );
  }
  if (trivial.code !== 0) {
    // Normal nonzero on the trivial known-good profile => the sandbox-exec
    // machinery itself is unusable on this host -> honest capability skip.
    return {
      kind: null,
      skipReason: `sandbox-exec present but unusable at startup (trivial profile exit ${trivial.code}): ${summarizeSeatbeltStderr(trivial.stderr)}; launch: ${fallbackDiag}`,
    };
  }
  // The trivial profile applied fine, so the REAL profile (or the launch
  // integration) failing is a genuine regression -> RED.
  throw new Error(
    `real startup probe: trivial seatbelt profile applied but the shipped profile launch fell back (${fallbackDiag})`,
  );
}

/**
 * Bounded actual startup probe: run the REAL backend (no fixture override)
 * once with a trivial harness. A launched protected outcome proves the
 * domain applies on this host. A fallback whose reason names a documented
 * platform-unavailable combination (ABI below minimum, Landlock disabled,
 * missing/unusable backend artifact) is an honest skip. macOS sandbox-exec
 * that is PRESENT but unusable is classified with the two-tier rule above
 * (bounded trivial-profile probe), never by broadening the regex. Anything
 * else — an unexpected fallback, an abort, or a non-zero trivial target —
 * throws RED: a genuine helper/backend regression must never blanket-skip
 * the real-backend compatibility tests.
 */
async function probeRealStartup(): Promise<StartupVerdict> {
  if (realKind === null) {
    return {
      kind: null,
      skipReason: `no native backend (${artifactBackend.kind === "unavailable" ? artifactBackend.reason : ""})`,
    };
  }
  // The probe runs from a suite-level before() hook, i.e. BEFORE the file's
  // beforeEach isolates the env — so isolate it here (and restore) so the
  // probe's own launches never touch the live state dir.
  saveEnv();
  isolateEnv();
  const root = tamanduaTempDir("tamandua-compat-startup-");
  try {
    const outcome = await launchHarnessExecution({
      harness: "test",
      command: [process.execPath, "-e", "0"],
      cwd: root,
    });
    if (outcome.status === "launched" && outcome.mode === realKind) {
      // Protected launch succeeded; the trivial harness must also exit clean.
      const done = await runChildToCompletion(outcome.child);
      if (done.code !== 0) {
        throw new Error(
          `real startup probe: protected trivial harness exited ${done.code}/${done.signal}`,
        );
      }
      return { kind: realKind, skipReason: "" };
    }
    if (outcome.status === "launched" && outcome.mode === "unprotected-fallback") {
      // Settle the freshly launched fallback child through the SAME bounded
      // collector before classifying the reason or removing the fixture/state
      // dirs below: an un-joined fallback harness could still be running
      // against directories the finally block is about to delete.
      const done = await runChildToCompletion(outcome.child);
      const reason = outcome.reason ?? "";
      if (KNOWN_UNAVAILABLE_RE.test(reason)) {
        return { kind: null, skipReason: `backend present but unusable at startup: ${reason}` };
      }
      if (realKind === "seatbelt" && artifactBackend.kind === "seatbelt") {
        // macOS sandbox-exec may be PRESENT (executable, profile asset in
        // place) yet unusable on THIS host — a runtime failure the
        // artifact-level KNOWN_UNAVAILABLE_RE cannot name. Preserve the same
        // two-tier rule already proved in signal-boundary.test.ts: a bounded
        // trivial known-good profile that exits NORMALLY nonzero is a known
        // host inability (honest skip); a signal death, or failure of the
        // REAL profile after the trivial profile succeeded, is RED — never a
        // blanket regex skip of arbitrary real-profile failures.
        // await before returning: probeRealStartup's try/finally restores
        // the fixture env and removes the scratch root AFTER this async
        // probe settles, so the trivial-profile child is fully joined before
        // that cleanup runs.
        return await probeSeatbeltPresentButUnusable(
          artifactBackend.sandboxExec,
          `${outcomeDiag(outcome)}; fallback child exit ${done.code}/${done.signal}`,
        );
      }
      throw new Error(
        `real startup probe: unexpected fallback (${outcomeDiag(outcome)}); fallback child exit ${done.code}/${done.signal}`,
      );
    }
    throw new Error(`real startup probe: unexpected outcome (${outcomeDiag(outcome)})`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    restoreEnv();
  }
}

// ── argv boundary vectors ──────────────────────────────────────────
function trickyArgs(): string[] {
  return [
    "",
    "simple",
    "two words",
    "-leading-dash",
    "--flag=value",
    "-n",
    "line1\nline2\nline3",
    "tab\there",
    "quote ' and \" double",
    "héllo wörld ✓",
    "  padded  ",
    "x".repeat(40_000), // very long single prompt argument
  ];
}

// ── US-004 tests ───────────────────────────────────────────────────

describe("KHYG US-004 launch compatibility vs unprotected baseline (fixture backend)", () => {
  it("argv boundaries are preserved exactly (very long, leading dashes, spaces/newlines)", async () => {
    const root = tamanduaTempDir("tamandua-compat-argv-");
    try {
      writeGoodHelper(root);
      const driver = writeCompatDriver(root);
      const outFileProtected = path.join(root, "argv-protected.json");
      const outFileBaseline = path.join(root, "argv-baseline.json");
      const args = trickyArgs();

      const protectedRun = await runLaunch({
        command: [process.execPath, driver, "argv", outFileProtected, ...args],
        cwd: root,
        protectedFixtureDir: root,
      });
      assert.equal(protectedRun.outcome.mode, "landlock", "fixture launch is a protected landlock shape");
      assert.equal(protectedRun.done.code, 0, `protected argv harness exit: ${JSON.stringify(protectedRun.done)}`);
      assert.equal(protectedRun.done.stderr, "", "protected argv harness stderr must be empty");

      const baselineRun = await runLaunch({
        command: [process.execPath, driver, "argv", outFileBaseline, ...args],
        cwd: root,
        fallbackReason: "us004-unprotected-baseline",
      });
      assert.equal(baselineRun.outcome.mode, "unprotected-fallback");
      assert.equal(baselineRun.done.code, 0, `baseline argv harness exit: ${JSON.stringify(baselineRun.done)}`);

      const protectedSeen = JSON.parse(fs.readFileSync(outFileProtected, "utf8")) as string[];
      const baselineSeen = JSON.parse(fs.readFileSync(outFileBaseline, "utf8")) as string[];
      assert.deepEqual(protectedSeen, args, "protected launch must deliver every argv element verbatim");
      assert.deepEqual(baselineSeen, args, "baseline launch must deliver every argv element verbatim");
      assert.deepEqual(protectedSeen, baselineSeen, "protected and baseline must see identical argv");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stdin/stdout/stderr forwarding is identical to the unprotected baseline", async () => {
    const root = tamanduaTempDir("tamandua-compat-stdio-");
    try {
      writeGoodHelper(root);
      const driver = writeCompatDriver(root);
      const payload = Buffer.from("feed me\nmore lines\nand some ünïcode ✓\n");

      const protectedRun = await runLaunch({
        command: [process.execPath, driver, "stdio"],
        cwd: root,
        protectedFixtureDir: root,
        stdin: payload,
      });
      assert.equal(protectedRun.outcome.mode, "landlock");
      assert.equal(protectedRun.done.code, 0);

      const baselineRun = await runLaunch({
        command: [process.execPath, driver, "stdio"],
        cwd: root,
        fallbackReason: "us004-unprotected-baseline",
        stdin: payload,
      });
      assert.equal(baselineRun.outcome.mode, "unprotected-fallback");
      assert.equal(baselineRun.done.code, 0);

      assert.equal(protectedRun.done.stdout, baselineRun.done.stdout, "stdout must match baseline");
      assert.equal(protectedRun.done.stderr, baselineRun.done.stderr, "stderr must match baseline");
      assert.ok(protectedRun.done.stdout.includes("feed me"), "protected stdout must carry fed stdin");
      assert.ok(protectedRun.done.stdout.endsWith("STDOUT_END\n"));
      assert.equal(protectedRun.done.stderr, "STDERR_MARKER\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("KHYG US-004 real-backend compatibility (bounded startup probe)", () => {
  let verdict: StartupVerdict = { kind: null, skipReason: "startup probe not yet run" };

  before(async () => {
    verdict = await probeRealStartup();
  });

  function requireUsable(t: { skip: (reason: string) => void }): boolean {
    if (verdict.kind === null) {
      t.skip(`honest capability skip: ${verdict.skipReason}`);
      return false;
    }
    return true;
  }

  it("records the real host capability honestly (usable backend runs, known-unavailable skips)", (t) => {
    if (verdict.kind === null) {
      console.log(`signal-isolation-compat (US-004): real-backend capability skip: ${verdict.skipReason}`);
      assert.ok(verdict.skipReason.length > 0);
      return;
    }
    assert.equal(verdict.kind, realKind);
  });

  it("real protected launch preserves argv boundaries vs the unprotected baseline", async (t) => {
    if (!requireUsable(t)) return;
    const root = tamanduaTempDir("tamandua-compat-realargv-");
    try {
      const driver = writeCompatDriver(root);
      const outFileProtected = path.join(root, "argv-protected.json");
      const outFileBaseline = path.join(root, "argv-baseline.json");
      const args = trickyArgs();

      const protectedRun = await runLaunch({
        command: [process.execPath, driver, "argv", outFileProtected, ...args],
        cwd: root,
      });
      assert.equal(protectedRun.outcome.mode, realKind, "real launch must be protected — never a fallback");
      assert.equal(protectedRun.done.code, 0);

      const baselineRun = await runLaunch({
        command: [process.execPath, driver, "argv", outFileBaseline, ...args],
        cwd: root,
        fallbackReason: "us004-unprotected-baseline",
      });
      assert.equal(baselineRun.outcome.mode, "unprotected-fallback");
      assert.equal(baselineRun.done.code, 0);

      const protectedSeen = JSON.parse(fs.readFileSync(outFileProtected, "utf8")) as string[];
      const baselineSeen = JSON.parse(fs.readFileSync(outFileBaseline, "utf8")) as string[];
      assert.deepEqual(protectedSeen, args);
      assert.deepEqual(protectedSeen, baselineSeen);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("real protected launch stdin/stdout/stderr forwarding matches the unprotected baseline", async (t) => {
    if (!requireUsable(t)) return;
    const root = tamanduaTempDir("tamandua-compat-realstdio-");
    try {
      const driver = writeCompatDriver(root);
      const payload = Buffer.from("real-backend stdin payload\nsecond line ✓\n");

      const protectedRun = await runLaunch({
        command: [process.execPath, driver, "stdio"],
        cwd: root,
        stdin: payload,
      });
      assert.equal(protectedRun.outcome.mode, realKind, "real launch must be protected — never a fallback");
      assert.equal(protectedRun.done.code, 0);

      const baselineRun = await runLaunch({
        command: [process.execPath, driver, "stdio"],
        cwd: root,
        fallbackReason: "us004-unprotected-baseline",
        stdin: payload,
      });
      assert.equal(baselineRun.outcome.mode, "unprotected-fallback");
      assert.equal(baselineRun.done.code, 0);

      assert.equal(protectedRun.done.stdout, baselineRun.done.stdout, "real-protected stdout must match baseline");
      assert.equal(protectedRun.done.stderr, baselineRun.done.stderr, "real-protected stderr must match baseline");
      assert.ok(protectedRun.done.stdout.includes("real-backend stdin payload"));
      assert.ok(protectedRun.done.stdout.endsWith("STDOUT_END\n"));
      assert.equal(protectedRun.done.stderr, "STDERR_MARKER\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("normal file access incl. cross-directory hardlink/rename works under real protection (matches baseline)", async (t) => {
    if (!requireUsable(t)) return;
    const root = tamanduaTempDir("tamandua-compat-realfile-");
    try {
      const driver = writeCompatDriver(root);
      // Each arm gets its OWN fresh owned subdirectory so the comparison is
      // exact: no leftover hardlink/rename destination from the first arm can
      // influence the second.
      const workProtected = path.join(root, "work-protected");
      const workBaseline = path.join(root, "work-baseline");
      fs.mkdirSync(workProtected, { recursive: true });
      fs.mkdirSync(workBaseline, { recursive: true });
      const resProtected = path.join(root, "fileops-protected.json");
      const resBaseline = path.join(root, "fileops-baseline.json");

      const protectedRun = await runLaunch({
        command: [process.execPath, driver, "fileops", resProtected],
        cwd: workProtected,
      });
      assert.equal(protectedRun.outcome.mode, realKind);
      assert.equal(protectedRun.done.code, 0);

      const baselineRun = await runLaunch({
        command: [process.execPath, driver, "fileops", resBaseline],
        cwd: workBaseline,
        fallbackReason: "us004-unprotected-baseline",
      });
      assert.equal(baselineRun.outcome.mode, "unprotected-fallback");
      assert.equal(baselineRun.done.code, 0);

      const protectedResult = JSON.parse(fs.readFileSync(resProtected, "utf8")) as { ok: boolean };
      const baselineResult = JSON.parse(fs.readFileSync(resBaseline, "utf8")) as { ok: boolean };
      assert.deepEqual(protectedResult, baselineResult, "file ops must behave identically under protection");
      assert.equal(protectedResult.ok, true, `cross-directory link/rename must succeed under protection: ${JSON.stringify(protectedResult)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an outside random-port network fixture stays reachable from a protected launch (matches baseline)", async (t) => {
    if (!requireUsable(t)) return;
    const root = tamanduaTempDir("tamandua-compat-realnet-");
    const server = await startEchoServer();
    try {
      const driver = writeCompatDriver(root);
      const tokenProtected = "PROTECTED-TOKEN";
      const tokenBaseline = "BASELINE-TOKEN";

      const protectedRun = await runLaunch({
        command: [process.execPath, driver, "net", "127.0.0.1", String(server.port), tokenProtected],
        cwd: root,
      });
      assert.equal(protectedRun.outcome.mode, realKind);
      assert.equal(protectedRun.done.code, 0, `protected net exit: ${JSON.stringify(protectedRun.done)}`);
      assert.ok(
        protectedRun.done.stdout.includes(`NET:${tokenProtected}`),
        `outside fixture must echo the protected token: ${protectedRun.done.stdout}`,
      );

      const baselineRun = await runLaunch({
        command: [process.execPath, driver, "net", "127.0.0.1", String(server.port), tokenBaseline],
        cwd: root,
        fallbackReason: "us004-unprotected-baseline",
      });
      assert.equal(baselineRun.outcome.mode, "unprotected-fallback");
      assert.equal(baselineRun.done.code, 0, `baseline net exit: ${JSON.stringify(baselineRun.done)}`);
      assert.ok(baselineRun.done.stdout.includes(`NET:${tokenBaseline}`));
    } finally {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("KHYG US-004 backend-unavailable fallback (test-only hook)", () => {
  it("forced-unavailable backend still runs the harness and durably records mode/reason/identity/UTC without leaking secrets", async () => {
    const root = tamanduaTempDir("tamandua-compat-fallback-");
    try {
      // Backend unavailable via the test-only probe seam: an empty artifact
      // dir yields the real landlock-helper-not-built reason (not a forced
      // short-circuit), so the launch must fall back exactly once.
      const emptyArtifactDir = path.join(root, "empty-native");
      fs.mkdirSync(emptyArtifactDir, { recursive: true });
      const secret = "KHYG-CANARY-SECRET-9876";
      const outFile = path.join(root, "harness-output.txt");
      const harness = writeNodeDriver(
        root,
        "fallback-harness.mjs",
        `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(outFile)}, "harness-ran");\n`,
      );

      const outcome = await launchHarnessExecution({
        harness: "test",
        command: [process.execPath, harness, secret],
        cwd: root,
        identity: { runId: "run-us004-fallback", agentId: "us004", stepId: "signal-isolation-compat" },
        seams: { probe: { platform: "linux", artifactDir: emptyArtifactDir } },
      });
      assert.equal(outcome.status, "launched", `fallback launch (${outcomeDiag(outcome)})`);
      if (outcome.status !== "launched") return;
      assert.equal(outcome.mode, "unprotected-fallback", "no backend => fallback mode");
      assert.equal(outcome.reason, "landlock-helper-not-built");
      const done = await runChildToCompletion(outcome.child);
      assert.equal(done.code, 0, `fallback harness must run normally: ${JSON.stringify(done)}`);
      assert.equal(fs.readFileSync(outFile, "utf8"), "harness-ran", "harness work must happen under fallback");

      // Durable mode record: mode/reason/identity + UTC, no secrets/prompts.
      const records = isolationRecords("run-us004-fallback");
      assert.equal(records.length, 1, "exactly one isolation record for the fallback launch");
      const rec = records[0];
      assert.equal(rec.mode, "unprotected-fallback");
      assert.equal(rec.reason, "landlock-helper-not-built");
      assert.equal(rec.runId, "run-us004-fallback");
      assert.equal(rec.agentId, "us004");
      assert.ok(typeof rec.ts === "string" && (rec.ts as string).length > 0, "record carries UTC ts");
      const recordJson = JSON.stringify(rec);
      assert.ok(!recordJson.includes(secret), "durable record must not leak the argv secret");
      const rendered = formatLogsTailLine(rec as Parameters<typeof formatLogsTailLine>[0]);
      assert.match(rendered, /unprotected/, `rendered fallback record must say 'unprotected': ${rendered}`);
      assert.ok(!rendered.includes(secret), "rendered line must not include the secret");

      // The visible/durable warn line in the isolated state log must carry
      // the reason but not the secret or the prompt text.
      const logFile = path.join(process.env.TAMANDUA_STATE_DIR!, "tamandua.log");
      const logContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      assert.match(logContent, /harness signal isolation unavailable/, "fallback warning must be durably logged");
      assert.match(logContent, /landlock-helper-not-built/, "logged warning must carry the reason");
      assert.ok(!logContent.includes(secret), "logged warning must not include the secret");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("KHYG US-004 artifact/install resolution (module-root, cwd-independent)", () => {
  it("nativeArtifactsDir is module/install-root relative and never process.cwd()", () => {
    const foreignCwd = tamanduaTempDir("tamandua-compat-foreigncwd-");
    const originalCwd = process.cwd();
    const beforeDir = nativeArtifactsDir();
    try {
      assert.ok(path.isAbsolute(beforeDir));
      // The compiled module lives under <dist>/installer, so the artifact
      // dir is <dist>/native — anchored to the module, not the caller cwd.
      assert.equal(path.basename(beforeDir), "native");
      process.chdir(foreignCwd);
      assert.equal(nativeArtifactsDir(), beforeDir, "foreign cwd must not change artifact resolution");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(foreignCwd, { recursive: true, force: true });
    }
  });

  it("honest install relocation: the real built module loaded from an install-shaped copy resolves via its DEFAULT resolver", async () => {
    // Mirrors scripts/install.sh: build into dist, then run from the
    // checkout/install root. We copy the REAL built module into a fresh
    // install-shaped tree (<installRoot>/dist/installer + <installRoot>/dist/
    // native) and exercise its DEFAULT resolver — never passing an explicit
    // artifactDir, so the resolution really is anchored to the copy's own
    // module/install root.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const builtModule = path.join(repoRoot, "dist", "installer", "native-signal-backend.js");
    assert.ok(fs.existsSync(builtModule), "the built module must exist (npm run build runs first)");

    const installRoot = tamanduaTempDir("tamandua-compat-reloc-");
    const installerDir = path.join(installRoot, "dist", "installer");
    const nativeDir = path.join(installRoot, "dist", "native");
    fs.mkdirSync(installerDir, { recursive: true });
    fs.mkdirSync(nativeDir, { recursive: true });
    // The module has only Node builtin imports, so a standalone copy loads.
    fs.copyFileSync(builtModule, path.join(installerDir, "native-signal-backend.mjs"));
    const relocated = (await import(pathToFileURL(path.join(installerDir, "native-signal-backend.mjs")).href)) as typeof import("../../dist/installer/native-signal-backend.js");
    try {
      const originalCwd = process.cwd();
      const foreignCwd = tamanduaTempDir("tamandua-compat-reloc-foreign-");
      try {
        process.chdir(foreignCwd);
        // DEFAULT resolver, from a foreign cwd: must point at the copy's own
        // dist/native, never the original repo and never the caller cwd.
        assert.equal(relocated.nativeArtifactsDir(), nativeDir);
        assert.equal(relocated.defaultHelperPath(), path.join(nativeDir, LANDLOCK_HELPER_BASENAME));
        assert.equal(relocated.defaultProfilePath(), path.join(nativeDir, SEATBELT_PROFILE_BASENAME));

        // Present: an executable helper in the relocated install shape is
        // selected through the copy's DEFAULT artifact dir.
        writeExecutable(path.join(nativeDir, LANDLOCK_HELPER_BASENAME), "#!/bin/sh\n");
        const present = relocated.probeBackend({ platform: "linux" });
        assert.equal(present.kind, "landlock");
        if (present.kind === "landlock") {
          assert.equal(present.helperPath, path.join(nativeDir, LANDLOCK_HELPER_BASENAME));
        }

        // Absent: explicit unavailable with a machine-readable reason.
        fs.rmSync(path.join(nativeDir, LANDLOCK_HELPER_BASENAME));
        const absent = relocated.probeBackend({ platform: "linux" });
        assert.equal(absent.kind, "unavailable");
        if (absent.kind === "unavailable") {
          assert.equal(absent.reason, "landlock-helper-not-built");
        }

        // Authoritative marker beats a stale executable (no stale reuse).
        writeExecutable(path.join(nativeDir, LANDLOCK_HELPER_BASENAME), "#!/bin/sh\n");
        fs.writeFileSync(
          path.join(nativeDir, UNAVAILABLE_MARKER_BASENAME),
          JSON.stringify({ backend: "unavailable", reason: "compile-failed" }),
        );
        const stale = relocated.probeBackend({ platform: "linux" });
        assert.equal(stale.kind, "unavailable");
        if (stale.kind === "unavailable") {
          assert.equal(stale.reason, "compile-failed", "marker reason must win over the stale executable");
        }
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(foreignCwd, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(installRoot, { recursive: true, force: true });
    }
  });

  it("seatbelt profile asset resolves in a relocated install shape through the DEFAULT resolver", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const builtModule = path.join(repoRoot, "dist", "installer", "native-signal-backend.js");
    assert.ok(fs.existsSync(builtModule));

    const installRoot = tamanduaTempDir("tamandua-compat-relocsb-");
    const installerDir = path.join(installRoot, "dist", "installer");
    const nativeDir = path.join(installRoot, "dist", "native");
    fs.mkdirSync(installerDir, { recursive: true });
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.copyFileSync(builtModule, path.join(installerDir, "native-signal-backend.mjs"));
    const relocated = (await import(pathToFileURL(path.join(installerDir, "native-signal-backend.mjs")).href)) as typeof import("../../dist/installer/native-signal-backend.js");
    try {
      fs.writeFileSync(path.join(nativeDir, SEATBELT_PROFILE_BASENAME), "(version 1) (allow default) (deny signal) (allow signal (target same-sandbox))\n");
      // Use an executable fixture sandbox-exec path so probing is hermetic.
      // The PROFILE path must resolve through the copy's DEFAULT artifact dir
      // (no explicit artifactDir): the module copy's own nativeArtifactsDir()
      // is the relocated <installRoot>/dist/native.
      const sandboxExec = path.join(nativeDir, "sandbox-exec");
      writeExecutable(sandboxExec, "#!/bin/sh\n");
      const seatbelt = relocated.probeBackend({ platform: "darwin", sandboxExecPath: sandboxExec });
      assert.equal(seatbelt.kind, "seatbelt", "profile asset in install dir must resolve seatbelt");
      if (seatbelt.kind === "seatbelt") {
        assert.equal(seatbelt.profilePath, path.join(nativeDir, SEATBELT_PROFILE_BASENAME));
      }

      // Missing profile asset -> explicit unavailable reason, not a crash.
      fs.rmSync(path.join(nativeDir, SEATBELT_PROFILE_BASENAME));
      const missing = relocated.probeBackend({ platform: "darwin", sandboxExecPath: sandboxExec });
      assert.equal(missing.kind, "unavailable");
      if (missing.kind === "unavailable") {
        assert.equal(missing.reason, "seatbelt-profile-missing");
      }
    } finally {
      fs.rmSync(installRoot, { recursive: true, force: true });
    }
  });
});

describe("KHYG US-004 seatbelt present-but-unusable two-tier rule (host-independent fixture)", () => {
  // macOS sandbox-exec can be PRESENT (executable, profile asset present)
  // yet unusable on a specific host — a runtime failure no artifact-level
  // KNOWN_UNAVAILABLE reason can name. The startup probe must preserve the
  // two-tier rule proved in signal-boundary.test.ts instead of broadening
  // the regex to blanket-skip arbitrary real-profile failures:
  //   Tier 1: bounded trivial known-good profile -> normal nonzero = known
  //           host inability (honest skip).
  //   Tier 2: signal death on the trivial profile, or failure of the REAL
  //           profile after the trivial profile succeeded, is RED.
  // These tests use fixture "sandbox-exec" shell scripts, so they run on
  // ANY host (the rollout Linux host included) and pin the classification.

  function fixtureSandboxExec(root: string, body: string): string {
    const p = path.join(root, "sandbox-exec");
    writeExecutable(p, `#!/bin/sh\n${body}`);
    return p;
  }

  it("trivial-profile normal nonzero => present-but-unusable honest skip", async () => {
    const root = tamanduaTempDir("tamandua-compat-sb-unusable-");
    try {
      const sandboxExec = fixtureSandboxExec(
        root,
        `printf 'sandbox-exec: cannot apply profile on this host\\n' >&2\nexit 1\n`,
      );
      const verdict = await probeSeatbeltPresentButUnusable(sandboxExec, "synthetic launch fallback");
      assert.equal(verdict.kind, null);
      assert.match(verdict.skipReason, /present but unusable/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("trivial-profile signal death is RED, never a blanket skip", async () => {
    const root = tamanduaTempDir("tamandua-compat-sb-signal-");
    try {
      const sandboxExec = fixtureSandboxExec(root, `kill -TERM $$\n`);
      await assert.rejects(
        () => probeSeatbeltPresentButUnusable(sandboxExec, "synthetic launch fallback"),
        /died by SIGTERM/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("trivial profile succeeds but the REAL profile launch fell back => RED", async () => {
    const root = tamanduaTempDir("tamandua-compat-sb-usable-");
    try {
      // A sandbox-exec that can apply a trivial profile (exits 0) but whose
      // real-profile launch still fell back is a genuine product/profile
      // failure — the probe must NOT skip it.
      const sandboxExec = fixtureSandboxExec(
        root,
        `[ "$1" = "-p" ] || exit 1\nshift 2\nexec "$@"\n`,
      );
      await assert.rejects(
        () => probeSeatbeltPresentButUnusable(sandboxExec, "synthetic launch fallback"),
        /trivial seatbelt profile applied but the shipped profile launch fell back/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
