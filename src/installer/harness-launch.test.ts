/**
 * harness-launch.test.ts — KHYG US-002 focused tests for the shared
 * per-execution launch mechanism (src/installer/harness-launch.ts).
 *
 * Coverage:
 *  - REAL execution counters: exactly one harness execution per launch for
 *    success, missing-readiness, partial-frame, setup-timeout and
 *    lost-acknowledgment cases — never a duplicate, never a replay.
 *  - Each launch creates its own fresh launcher instance (distinct pids /
 *    helper starts); the test parent (stand-in for the scheduling daemon)
 *    is never sandboxed and can cancel its protected child.
 *  - A setup child that never receives release never executes the harness:
 *    cancellation during setup → zero executions, clean failure, no
 *    fallback replay.
 *  - Pre-release setup failure / unavailable backend → exactly ONE
 *    unprotected fallback run in a fresh process with a prominent durable
 *    mode=unprotected-fallback record (reason + run identity + UTC);
 *    post-release harness failure (incl. helper-like exit codes) NEVER
 *    triggers an unprotected replay.
 *  - Mode records (run.harness_isolation) for protected and fallback
 *    launches with run/execution identity + UTC.
 *  - Adapter-level integration for pi/hermes/dsh AND a probe-shaped round
 *    against the REAL native backend once the REAL helper proves it can
 *    establish its domain on THIS host (an honest capability skip on a known
 *    ABI-floor refusal; an unexpected probe failure stays RED) — asserting
 *    exactly one execution and preserved PGID identity
 *    (TAMANDUA_WORKER_PGID === pid === pgid).
 *
 * Spawns child processes → registered in tests/serial-files.txt.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanChildEnv, createTempHome } from "../../tests/helpers/test-env.ts";
import { spawn, type ChildProcess } from "node:child_process";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import {
  launchHarnessExecution,
  __resetFallbackDedupForTests,
  HARNESS_ISOLATION_EVENT,
  type HarnessLaunchOutcome,
} from "../../dist/installer/harness-launch.js";
import {
  HELPER_EXIT_SETUP_FAILURE,
  LANDLOCK_CONTROL_FD,
  LANDLOCK_MIN_ABI,
  probeBackend,
} from "../../dist/installer/native-signal-backend.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { formatLogsTailLine } from "../../dist/installer/logs-tail-format.js";
import { getHarnessAdapter } from "../../dist/installer/harness-adapter.js";
import { monotonicNow } from "../../dist/lib/instant.js";

// ── Test-isolation state env ───────────────────────────────────────
// Launches emit logger lines and (with identity) run.harness_isolation
// events; both resolve TAMANDUA_STATE_DIR at write time. Isolate every
// test with a temp HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH.
let savedHome: string | undefined;
let savedStateDir: string | undefined;
let savedDbPath: string | undefined;
let isolationRoot: string | null = null;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  savedDbPath = process.env.TAMANDUA_DB_PATH;
  const env = createTempHome("tamandua-test-harness-launch-state-");
  isolationRoot = env.root;
  process.env.HOME = env.homeDir;
  process.env.TAMANDUA_STATE_DIR = env.tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(env.tamanduaDir, "tamandua.db");
  assertStatePathIsolation(process.env.TAMANDUA_STATE_DIR, "harness-launch test state");
  assertStatePathIsolation(process.env.TAMANDUA_DB_PATH, "harness-launch test database");
  // The per-run fallback dedup is process-scoped module state; reset it so no
  // test's runIds leak into another test's WARN/event counts.
  __resetFallbackDedupForTests();
});

afterEach(() => {
  if (isolationRoot) {
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

// ── Scratch / fixture helpers ──────────────────────────────────────

/** Read the execution counter (number of appended lines), 0 when absent. */
function readCounter(file: string): number {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.split("\n").filter((l) => l.trim() === "x").length;
  } catch {
    return 0;
  }
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
}

/**
 * A fixture harness that appends one `x` line to `counterFile` per
 * execution, optionally writes TAMANDUA_WORKER_PGID/TAMANDUA_WORKER_PID/$$
 * forensics, prints a marker to stdout, and exits `exitCode`.
 */
function makeCounterHarness(
  dir: string,
  counterFile: string,
  opts?: { exitCode?: number; pgidForensicsFile?: string; stdout?: string },
): string {
  const p = path.join(dir, "counter-harness");
  const forensics =
    opts?.pgidForensicsFile !== undefined
      ? `printf 'pgid=%s wpid=%s pid=%s\\n' "$TAMANDUA_WORKER_PGID" "$TAMANDUA_WORKER_PID" "$$" > "${opts.pgidForensicsFile}"\n`
      : "";
  const stdout = opts?.stdout ?? "HARNESS_OUT\n";
  writeExecutable(
    p,
    `#!/bin/sh\nprintf 'x\\n' >> "${counterFile}"\n${forensics}printf '%b' '${stdout}'\nexit ${opts?.exitCode ?? 0}\n`,
  );
  return p;
}

/**
 * A fixture "landlock helper" standing in for dist/native/landlock-helper.
 * Installed as `<dir>/landlock-helper` so probeBackend({ platform: 'linux',
 * artifactDir: dir }) selects the landlock backend. Behaviors:
 *  - "good": READY mode=landlock, wait for the release, then exec the
 *    harness argv.
 *  - "exit-125": exits 125 before any READY (settled pre-release setup failure).
 *  - "partial-frame": writes a truncated READY frame then exits 125.
 *  - "hang": never reports readiness (sleeps) — setup wall must settle it.
 *  - "ready-then-exit-125": reports READY, waits for release, then exits 125
 *    WITHOUT exec'ing the harness (helper-like exit AFTER release).
 *  - "ready-then-close": reports READY then closes the control channel
 *    without waiting (peer reset around the release boundary).
 * Every behavior appends one `x` to helperCounterFile when provided so
 * tests can count how many times a launcher instance was spawned.
 *
 * The fd-3 release wait defaults to the RUNTIME line protocol (a "GO" line —
 * harness-launch.ts releases with "GO\n" and the launch-mechanism tests below
 * exercise exactly that handshake). Pass releaseProtocol "byte" to mirror the
 * REAL C helper instead (native/landlock-helper.c read(1)): ANY single byte
 * releases the helper and EOF before a release byte is a setup failure. Only
 * the probeRealLandlockDomain fixture cases use "byte", so those synthetic
 * helpers simulate the real helper's one-byte release semantics (including
 * the residual-unread-payload behavior on a multi-byte release) rather than
 * the runtime's line handshake.
 */
function makeFakeHelper(
  dir: string,
  behavior:
    | "good"
    | "exit-125"
    | "partial-frame"
    | "hang"
    | "ready-then-exit-125"
    | "ready-then-close",
  helperCounterFile?: string,
  releaseProtocol: "line" | "byte" = "line",
): string {
  const p = path.join(dir, "landlock-helper");
  const count = helperCounterFile ? `printf 'x\\n' >> "${helperCounterFile}"\n` : "";
  // Release wait on fd 3. "line" (default) matches the runtime handshake
  // ("GO\n" written by harness-launch.ts; the shell fixtures line-read it).
  // "byte" emulates the REAL C helper's read(1): consume exactly one byte
  // with dd (bs=1 count=1) and treat an empty read as EOF-before-release
  // (setup failure). The release byte is the fixed non-newline "G", so a
  // non-empty capture is the EOF discriminator.
  const releaseWait =
    releaseProtocol === "byte"
      ? `__rel="$(dd bs=1 count=1 2>/dev/null <&3)" || exit 125\n` +
        `[ -n "$__rel" ] || exit 125\n`
      : `IFS= read -r __rel <&3 || exit 125\n` +
        `[ "$__rel" = "GO" ] || exit 125\n`;
  let body: string;
  switch (behavior) {
    case "good":
      body =
        `[ "$1" = "--control-fd" ] && [ "$3" = "--" ] || exit 124\n` +
        `shift 3\n` +
        `printf 'READY mode=landlock abi=8 pid=%s\\n' "$$" >&3 || exit 125\n` +
        releaseWait +
        `exec 3>&-\n` +
        `exec "$@"\n`;
      break;
    case "exit-125":
      body = `exit 125\n`;
      break;
    case "partial-frame":
      body = `printf 'READY mode=land' >&3 || exit 125\n` + `exit 125\n`;
      break;
    case "hang":
      body = `sleep 60\n`;
      break;
    case "ready-then-exit-125":
      body =
        `printf 'READY mode=landlock abi=8 pid=%s\\n' "$$" >&3 || exit 125\n` +
        releaseWait +
        `exit 125\n`;
      break;
    case "ready-then-close":
      body =
        `printf 'READY mode=landlock abi=8 pid=%s\\n' "$$" >&3 || exit 125\n` +
        `exec 3>&-\n` +
        `sleep 0.3\n` +
        `exit 125\n`;
      break;
  }
  writeExecutable(p, `#!/bin/sh\n${count}${body}`);
  return p;
}

/** Drain a launched child to completion (attach AFTER the launch resolves). */
function runChildToCompletion(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** Filter a run's event stream for run.harness_isolation records. */
function isolationRecords(runId: string): Array<Record<string, unknown>> {
  return getRunEvents(runId).filter(
    (e) => e.event === HARNESS_ISOLATION_EVENT,
  ) as unknown as Array<Record<string, unknown>>;
}

/**
 * Path to the isolated state log (TAMANDUA_STATE_DIR is set per test in
 * beforeEach). Reading the file directly avoids importing logger, which the
 * test-isolation guard forbids here. Mirrors signal-isolation-compat.test.ts.
 */
function isolationLogPath(): string {
  return path.join(process.env.TAMANDUA_STATE_DIR!, "tamandua.log");
}

function launchFixture(opts: {
  fixtureDir: string;
  command: string[];
  behavior?: "good" | "exit-125" | "partial-frame" | "hang" | "ready-then-exit-125" | "ready-then-close";
  helperCounterFile?: string;
  setupWallMs?: number;
  wallDeadlineMs?: number;
  forceFallbackReason?: string | null;
  runId?: string;
  env?: Record<string, string | undefined>;
}): Promise<HarnessLaunchOutcome> {
  makeFakeHelper(opts.fixtureDir, opts.behavior ?? "good", opts.helperCounterFile);
  return launchHarnessExecution({
    harness: "test",
    command: opts.command,
    cwd: opts.fixtureDir,
    env: opts.env,
    identity: opts.runId !== undefined ? { runId: opts.runId } : undefined,
    wallDeadlineMs: opts.wallDeadlineMs,
    seams: {
      probe: { platform: "linux", artifactDir: opts.fixtureDir },
      setupWallMs: opts.setupWallMs,
      forceFallbackReason: opts.forceFallbackReason,
    },
  });
}

// ── Real landlock host-capability gate ─────────────────────────────
// probeBackend() only proves the compiled helper ARTIFACT exists — never
// that this kernel lets it establish its SIGNAL-scope domain. The strict
// protected-mode adapter cases below must therefore watch the REAL helper
// apply its domain to a short-lived owned child with a private control
// channel and a harmless target (/usr/bin/true) BEFORE they may assume
// mode=landlock. This mirrors the detectCapability pattern in
// landlock-helper.test.ts and never confines the test parent.
//
// Classification contract (known-unavailability vs genuine failure):
//  - READY + release + controlled /usr/bin/true exit 0 -> "supported".
//  - exit 125 pre-READY with stage=abi-below-minimum (the helper's own ABI
//    gate diagnostic: SIGNAL scope below the floor or unavailable at boot)
//    -> "known-unsupported": the protected real-backend cases skip.
//  - anything else — spawn/protocol failures, signal deaths, malformed or
//    missing READY, a post-READY target failure, a READY below the ABI
//    floor, or a control-channel error during the handshake — THROWS: a
//    genuine regression that must stay RED. There is no blanket
//    catch-and-skip.

const CAPABILITY_READY_RE = /^READY mode=landlock abi=(\d+) pid=(\d+)$/;
/** Watchdog: never let a misbehaving probe child strand a process. */
const CAPABILITY_WATCHDOG_MS = 25_000;
/** How long the probe waits for the helper's READY record before giving up. */
const CAPABILITY_READY_TIMEOUT_MS = 15_000;

type LandlockHostCapability =
  | { state: "supported"; realAbi: number }
  | { state: "known-unsupported"; reason: string };

/**
 * Verify that the REAL landlock helper can establish its domain on THIS
 * host: spawn it as a short-lived owned child (detached group, private
 * bidirectional control channel on fd 3) pointed at the harmless /usr/bin/true
 * target, require a valid READY, release exactly once with a single byte
 * (the helper's read(1) contract), and require the controlled target to
 * exit 0. The test parent is never confined.
 *
 * Returns "supported" (with the READY abi) when the domain works, or
 * "known-unsupported" when the helper itself refuses with its documented ABI
 * diagnostic (exit 125 + stage=abi-below-minimum before READY). ANY other
 * outcome — spawn/protocol failure, signal death, a malformed or missing
 * READY frame, a post-READY target failure, a READY below the SIGNAL-scope
 * ABI floor, or a control-channel error during the handshake — throws so
 * callers fail RED instead of silently skipping.
 */
async function probeRealLandlockDomain(helperPath: string): Promise<LandlockHostCapability> {
  const child = spawn(
    helperPath,
    ["--control-fd", String(LANDLOCK_CONTROL_FD), "--", "/usr/bin/true"],
    {
      env: cleanChildEnv({}),
      stdio: ["pipe", "pipe", "pipe", "pipe"], // fd 3 = private control channel
      detached: true,
    },
  );
  const control = child.stdio[LANDLOCK_CONTROL_FD] as
    | (NodeJS.ReadWriteStream & { destroy?: () => void })
    | undefined;

  let stdoutBuf = "";
  let stderrBuf = "";
  let controlBuf = "";
  child.stdout?.on("data", (d: Buffer) => (stdoutBuf += d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => (stderrBuf += d.toString("utf8")));
  control?.on("data", (d: Buffer) => (controlBuf += d.toString("utf8")));

  // A control-channel error (e.g. EPIPE on the release write racing the
  // child's exit) must never surface as an uncaught 'error' and crash the
  // whole runner: record it here, settle readiness early below, and treat a
  // control error on an otherwise-"supported" outcome as unexpected (RED).
  let controlError: Error | undefined;
  control?.on("error", (err: Error) => {
    controlError = err;
  });

  // Settles with the child's exit info on close; a spawn-level failure
  // settles via error so the probe never hangs on a child that never started.
  let resolveExit!: (r: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => (resolveExit = resolve),
  );
  child.on("close", (code, signal) => {
    resolveExit({ code, signal: (signal ?? null) as NodeJS.Signals | null });
    try {
      control?.destroy?.();
    } catch {
      /* best effort */
    }
  });
  child.on("error", () => resolveExit({ code: null, signal: null }));

  const watchdog = setTimeout(() => {
    // Never signal a historical PID: only a STILL-LIVE owned child may be
    // group-SIGKILLed. A child that already settled resolves exited below.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best effort */
        }
      }
    }
  }, CAPABILITY_WATCHDOG_MS);
  watchdog.unref();
  void exited.finally(() => clearTimeout(watchdog));

  // Resolve with the parsed READY record, or null when the child exits (or
  // errors) before reporting readiness, or when the readiness bound elapses.
  const ready = new Promise<{ abi: number; pid: number; line: string } | null>(
    (resolve) => {
      const timer = setTimeout(() => resolve(null), CAPABILITY_READY_TIMEOUT_MS);
      const finish = (v: { abi: number; pid: number; line: string } | null): void => {
        clearTimeout(timer);
        resolve(v);
      };
      const check = (): void => {
        const nl = controlBuf.indexOf("\n");
        if (nl >= 0) {
          const line = controlBuf.slice(0, nl).trim();
          const m = CAPABILITY_READY_RE.exec(line);
          if (m) {
            finish({ abi: Number(m[1]), pid: Number(m[2]), line });
            return;
          }
        }
        if (child.exitCode !== null || child.signalCode !== null) finish(null);
      };
      control?.on("data", check);
      // A pre-READY control-channel error means no READY can ever arrive on
      // this channel: fail readiness fast instead of waiting out the bound.
      control?.on("error", () => finish(null));
      child.on("close", check);
      child.on("error", () => finish(null));
      check();
    },
  );

  const readyRec = await ready;
  if (readyRec !== null) {
    // Release exactly once with a SINGLE byte and no trailing payload — the
    // real helper's contract (native/landlock-helper.c read(1)): it consumes
    // one byte, closes the control channel and execs the target. Bytes left
    // unread in the channel when the peer closes trip the parent control
    // stream (read ECONNRESET), and the gate below must keep such an anomaly
    // RED — so the probe itself must never create that residual. The former
    // "GO\n" release did: real ABI-8 hosts reported READY and a clean
    // /usr/bin/true exit 0 yet still failed the gate with ECONNRESET from the
    // unread "O\n". Write exactly one byte ("G") so no payload remains.
    control?.write("G"); // exactly one release byte -> helper execs /usr/bin/true
  } else if (child.exitCode === null && child.signalCode === null) {
    // The helper never reported READY and is still live: kill its group
    // rather than let it strand. An already-settled child is never signalled.
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* best effort */
      }
    }
  }
  const close = await exited;

  if (readyRec === null) {
    // Known unavailability is ONLY the helper's own ABI diagnostic: exit 125
    // pre-READY with stage=abi-below-minimum. Everything else is a genuine
    // regression and must stay RED, never a blanket catch-and-skip.
    if (
      close.code === HELPER_EXIT_SETUP_FAILURE &&
      /stage=abi-below-minimum/.test(stderrBuf)
    ) {
      const detail = stderrBuf.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
      return {
        state: "known-unsupported",
        reason: `landlock ABI below ${LANDLOCK_MIN_ABI} / SIGNAL scope unavailable on this kernel (${detail})`,
      };
    }
    throw new Error(
      `landlock host-capability probe failed unexpectedly: code=${close.code} signal=${close.signal} stderr=${JSON.stringify(stderrBuf.slice(-400))}`,
    );
  }
  if (close.code !== 0) {
    throw new Error(
      `landlock host-capability probe: READY domain (abi=${readyRec.abi}) established but the controlled /usr/bin/true target failed: code=${close.code} signal=${close.signal} stderr=${JSON.stringify(stderrBuf.slice(-400))}`,
    );
  }
  if (readyRec.abi < LANDLOCK_MIN_ABI) {
    // The real helper cannot reach READY below the SIGNAL-scope floor; a
    // READY under it is a helper/protocol anomaly — never "supported".
    throw new Error(
      `landlock host-capability probe: helper reported READY with abi=${readyRec.abi} below the SIGNAL-scope floor ${LANDLOCK_MIN_ABI} (protocol anomaly)`,
    );
  }
  if (controlError !== undefined) {
    // A control-channel error on an otherwise-"supported" outcome means the
    // release / controlled execution was never confirmed — never green.
    throw new Error(
      `landlock host-capability probe: control channel error during the READY/release handshake: ${controlError.message} (code=${close.code} signal=${close.signal})`,
    );
  }
  return { state: "supported", realAbi: readyRec.abi };
}

// ── Shared launch mechanism: fixture-backed (host-independent) ─────

describe("shared harness launch mechanism (fixture helpers)", () => {
  it("runs the harness exactly once through a READY/release helper and preserves PGID identity", async () => {
    const root = tamanduaTempDir("tamandua-launch-success-");
    try {
      const counter = path.join(root, "harness-executions");
      const helperCount = path.join(root, "helper-starts");
      const forensics = path.join(root, "pgid.txt");
      const harness = makeCounterHarness(root, counter, { pgidForensicsFile: forensics });
      const spawnPids: number[] = [];
      const spawnPgids: number[] = [];

      const outcome = await launchFixture({
        fixtureDir: root,
        behavior: "good",
        helperCounterFile: helperCount,
        command: [harness, "arg-a", "arg b"],
        runId: "run-launch-success-1",
      });
      assert.equal(outcome.status, "launched", "a good helper must yield a launched outcome");
      if (outcome.status !== "launched") return;
      assert.equal(outcome.mode, "landlock", "fixture probe is the landlock backend");
      assert.ok(outcome.pid !== undefined, "launched outcome carries a pid");
      spawnPids.push(outcome.pid!);
      spawnPgids.push(outcome.pgid);

      const done = await runChildToCompletion(outcome.child);
      assert.equal(done.code, 0, `harness must exit 0, got ${done.code}/${done.signal}`);
      assert.equal(readCounter(counter), 1, "exactly ONE harness execution");
      assert.equal(readCounter(helperCount), 1, "exactly ONE helper (launcher) instance");
      assert.ok(done.stdout.includes("HARNESS_OUT"), "harness stdout must flow through");

      // PGID identity preserved across the helper -> /bin/sh -> harness exec
      // chain: TAMANDUA_WORKER_PGID === TAMANDUA_WORKER_PID === $$ ===
      // pid === pgid. CPID2: the wrapper exports the worker pid so
      // `step claim` records the harness pid, not the daemon pid.
      const pgidLine = fs.readFileSync(forensics, "utf8").trim();
      const m = /^pgid=(\d+) wpid=(\d+) pid=(\d+)$/.exec(pgidLine);
      assert.ok(m, `unexpected forensics: ${pgidLine}`);
      assert.equal(m![1], String(outcome.pid), "TAMANDUA_WORKER_PGID must equal the launcher pid");
      assert.equal(m![2], String(outcome.pid), "TAMANDUA_WORKER_PID must equal the launcher pid");
      assert.equal(m![3], String(outcome.pid), "harness pid must equal the launcher pid (exec preserved)");
      assert.equal(outcome.pgid, outcome.pid, "detached child must lead its own process group");

      // Durable mode record for the protected launch: mode + run identity + ts.
      const records = isolationRecords("run-launch-success-1");
      assert.equal(records.length, 1, "one isolation record per launch");
      assert.equal(records[0].mode, "landlock");
      assert.equal(records[0].runId, "run-launch-success-1");
      assert.ok(typeof records[0].ts === "string" && (records[0].ts as string).length > 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("two sequential launches produce distinct launcher instances/domains", async () => {
    const root = tamanduaTempDir("tamandua-launch-two-");
    try {
      const counter = path.join(root, "harness-executions");
      const helperCount = path.join(root, "helper-starts");
      const harness = makeCounterHarness(root, counter);
      const pids: number[] = [];
      const pgids: number[] = [];

      for (let i = 0; i < 2; i++) {
        const outcome = await launchFixture({
          fixtureDir: root,
          behavior: "good",
          helperCounterFile: helperCount,
          command: [harness],
        });
        assert.equal(outcome.status, "launched");
        if (outcome.status !== "launched") return;
        pids.push(outcome.pid!);
        pgids.push(outcome.pgid);
        const done = await runChildToCompletion(outcome.child);
        assert.equal(done.code, 0);
      }
      assert.equal(readCounter(counter), 2, "one harness execution per launch");
      assert.equal(readCounter(helperCount), 2, "each launch spawns its OWN fresh helper");
      assert.notEqual(pids[0], pids[1], "two launches must produce distinct launcher instances");
      assert.notEqual(pgids[0], pgids[1], "two launches must produce distinct process groups");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("missing readiness (helper exits pre-READY) falls back exactly once to an unprotected run", async () => {
    const root = tamanduaTempDir("tamandua-launch-missing-");
    try {
      const counter = path.join(root, "harness-executions");
      const helperCount = path.join(root, "helper-starts");
      const harness = makeCounterHarness(root, counter);
      const outcome = await launchFixture({
        fixtureDir: root,
        behavior: "exit-125",
        helperCounterFile: helperCount,
        command: [harness],
        runId: "run-launch-missing-1",
      });
      assert.equal(outcome.status, "launched", "settled setup failure must fall back, not abort");
      if (outcome.status !== "launched") return;
      assert.equal(outcome.mode, "unprotected-fallback");
      assert.match(outcome.reason ?? "", /native setup failed before release/);
      const done = await runChildToCompletion(outcome.child);
      assert.equal(done.code, 0);
      assert.equal(readCounter(helperCount), 1, "the helper was never retried");
      assert.equal(readCounter(counter), 1, "exactly ONE (unprotected) harness execution — no duplicates");

      const records = isolationRecords("run-launch-missing-1");
      assert.equal(records.length, 1, "the fallback carries its own durable mode record");
      assert.equal(records[0].mode, "unprotected-fallback");
      assert.match(String(records[0].reason ?? ""), /exit 125/);
      assert.equal(records[0].runId, "run-launch-missing-1");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a partial READY frame never authorizes release; settled helper exit falls back exactly once", async () => {
    const root = tamanduaTempDir("tamandua-launch-partial-");
    try {
      const counter = path.join(root, "harness-executions");
      const helperCount = path.join(root, "helper-starts");
      const harness = makeCounterHarness(root, counter);
      const outcome = await launchFixture({
        fixtureDir: root,
        behavior: "partial-frame",
        helperCounterFile: helperCount,
        command: [harness],
      });
      assert.equal(outcome.status, "launched");
      if (outcome.status !== "launched") return;
      assert.equal(outcome.mode, "unprotected-fallback", "partial frame must not authorize a protected release");
      const done = await runChildToCompletion(outcome.child);
      assert.equal(done.code, 0);
      assert.equal(readCounter(helperCount), 1);
      assert.equal(readCounter(counter), 1, "exactly ONE harness execution (the fallback), never two");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a helper that never reports readiness is killed at the setup wall and falls back exactly once", async () => {
    const root = tamanduaTempDir("tamandua-launch-wall-");
    try {
      const counter = path.join(root, "harness-executions");
      const helperCount = path.join(root, "helper-starts");
      const harness = makeCounterHarness(root, counter);
      const outcome = await launchFixture({
        fixtureDir: root,
        behavior: "hang",
        helperCounterFile: helperCount,
        command: [harness],
        setupWallMs: 600,
      });
      assert.equal(outcome.status, "launched");
      if (outcome.status !== "launched") return;
      assert.equal(outcome.mode, "unprotected-fallback");
      assert.match(outcome.reason ?? "", /did not report readiness/);
      const done = await runChildToCompletion(outcome.child);
      assert.equal(done.code, 0);
      assert.equal(readCounter(helperCount), 1, "the hung helper was killed, never retried");
      assert.equal(readCounter(counter), 1, "exactly ONE harness execution after the settled setup failure");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancellation during setup kills the setup child without release and without starting the harness", async () => {
    const root = tamanduaTempDir("tamandua-launch-cancel-");
    try {
      const counter = path.join(root, "harness-executions");
      const harness = makeCounterHarness(root, counter);
      makeFakeHelper(root, "hang");
      let setupPid: number | undefined;
      let setupPgid = 0;
      let spawnHandles = 0;

      // The setup child never reports readiness; 200ms in, the caller (the
      // test parent standing in for the scheduling daemon) cancels by
      // killing the setup child's process group — before release is sent.
      const outcome = await new Promise<HarnessLaunchOutcome>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (setupPgid !== 0) {
            try {
              process.kill(-setupPgid, "SIGTERM");
            } catch {
              /* already gone */
            }
          }
        }, 200);
        launchHarnessExecution({
          harness: "test",
          command: [harness],
          cwd: root,
          seams: { probe: { platform: "linux", artifactDir: root }, setupWallMs: 30_000 },
          onSpawn: ({ pid, pgid }) => {
            spawnHandles++;
            setupPid = pid;
            setupPgid = pgid;
          },
        })
          .then((o) => {
            clearTimeout(timer);
            resolve(o);
          })
          .catch(reject);
      });

      assert.equal(outcome.status, "aborted", "external kill during setup must abort the launch");
      if (outcome.status !== "aborted") return;
      assert.match(outcome.reason, /SIGTERM/);
      assert.equal(outcome.signal, "SIGTERM");
      assert.equal(readCounter(counter), 0, "the harness must never start");
      // Exactly ONE launcher instance was spawned (counted via the launch's
      // own onSpawn handles — not the helper's journal, whose first line may
      // lose the race with an early cancellation on slow hosts).
      assert.equal(spawnHandles, 1, "the setup child was spawned exactly once");
      assert.ok(setupPid !== undefined, "onSpawn must publish the setup child during setup");
      // The setup child was killed (never released), so its pid is gone.
      assert.throws(() => process.kill(setupPid!, 0), /ESRCH/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a helper-like exit code AFTER release is a normal failure — never an unprotected replay", async () => {
    const root = tamanduaTempDir("tamandua-launch-lostack-");
    try {
      const counter = path.join(root, "harness-executions");
      const helperCount = path.join(root, "helper-starts");
      const harness = makeCounterHarness(root, counter);
      const outcome = await launchFixture({
        fixtureDir: root,
        behavior: "ready-then-exit-125",
        helperCounterFile: helperCount,
        command: [harness],
        runId: "run-launch-lostack-1",
      });
      // Release was sent (READY received): the launch succeeded as a
      // PROTECTED launch. The helper then exits 125 without exec'ing — the
      // round outcome is the helper-like code treated as a normal failure.
      assert.equal(outcome.status, "launched");
      if (outcome.status !== "launched") return;
      assert.equal(outcome.mode, "landlock", "READY authorized the protected release");
      const done = await runChildToCompletion(outcome.child);
      assert.equal(done.code, 125, "post-release exit code belongs to the (helper) process");
      assert.equal(readCounter(helperCount), 1, "no second launcher attempt");
      assert.equal(readCounter(counter), 0, "the harness never executed");
      // No unprotected replay: the only isolation record is the protected one.
      const records = isolationRecords("run-launch-lostack-1");
      assert.equal(records.length, 1, "no fallback record may exist after release");
      assert.equal(records[0].mode, "landlock");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("READY followed by control-channel close never crashes the parent and never replays", async () => {
    const root = tamanduaTempDir("tamandua-launch-channel-");
    try {
      const counter = path.join(root, "harness-executions");
      const helperCount = path.join(root, "helper-starts");
      const harness = makeCounterHarness(root, counter);
      const outcome = await launchFixture({
        fixtureDir: root,
        behavior: "ready-then-close",
        helperCounterFile: helperCount,
        command: [harness],
        runId: "run-launch-channel-1",
      });
      // READY authorized the release; the peer then reset the channel. The
      // calling process must survive (no unhandled stream error) with a
      // bounded, non-replayed outcome.
      assert.equal(outcome.status, "launched");
      if (outcome.status !== "launched") return;
      const done = await runChildToCompletion(outcome.child);
      assert.equal(done.code, 125, "the helper exits 125 after closing the channel");
      assert.equal(readCounter(helperCount), 1, "no second launcher attempt");
      assert.equal(readCounter(counter), 0, "no unprotected replay — the harness never ran");
      const records = isolationRecords("run-launch-channel-1");
      assert.equal(records.length, 1, "only the protected mode record exists");
      assert.equal(records[0].mode, "landlock");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("explicit cancellation wins the setup-wall race — zero starts even when the wall timer fires first", async () => {
    const root = tamanduaTempDir("tamandua-launch-cancelrace-");
    try {
      const counter = path.join(root, "harness-executions");
      const harness = makeCounterHarness(root, counter);
      makeFakeHelper(root, "hang");
      let setupPid: number | undefined;
      let spawnHandles = 0;

      // The setup wall (300ms) and an external SIGTERM cancellation (sent at
      // 180ms) both come due while the event loop is deliberately blocked, so
      // the wall timer can fire before the SIGTERM close event is processed —
      // exactly the coordinator's cancel-race repro. Cancellation intent must
      // win: ZERO harness starts and NO unprotected fallback.
      const outcome = await new Promise<HarnessLaunchOutcome>((resolve, reject) => {
        launchHarnessExecution({
          harness: "test",
          command: [harness],
          cwd: root,
          seams: { probe: { platform: "linux", artifactDir: root }, setupWallMs: 300 },
          onSpawn: ({ pid }) => {
            spawnHandles++;
            setupPid = pid;
            // Cancel just before the setup deadline, then block the event
            // loop past it so the wall timer races the pending close event.
            setTimeout(() => {
              try {
                process.kill(setupPid!, "SIGTERM");
              } catch {
                /* already gone */
              }
              const until = Date.now() + 250;
              while (Date.now() < until) {
                /* bounded synchronous race fixture */
              }
            }, 180);
          },
        })
          .then(resolve)
          .catch(reject);
      });

      assert.equal(outcome.status, "aborted", "cancellation must abort the launch, never fall back");
      if (outcome.status !== "aborted") return;
      assert.match(outcome.reason, /SIGTERM|cancelled/);
      assert.equal(readCounter(counter), 0, "the harness must never start");
      assert.equal(spawnHandles, 1, "the setup child was spawned exactly once");
      assert.equal(outcome.timedOut, undefined, "a cancellation is not a round timeout");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an explicit AbortSignal cancellation vetoes release and fallback even when the setup wall SIGKILL lands first", async () => {
    const root = tamanduaTempDir("tamandua-launch-signalcancel-");
    try {
      const counter = path.join(root, "harness-executions");
      const harness = makeCounterHarness(root, counter);
      makeFakeHelper(root, "hang");
      const controller = new AbortController();
      let setupPid: number | undefined;
      let spawnHandles = 0;

      // The scheduler's cancel path marks the tracked child killed (abort)
      // while the setup child is still pending: the wall timer (150ms) may
      // even deliver its SIGKILL before the close event settles — signalCode
      // alone cannot tell the cancel, but the retained AbortSignal intent
      // must veto any fresh fallback.
      const outcome = await new Promise<HarnessLaunchOutcome>((resolve, reject) => {
        launchHarnessExecution({
          harness: "test",
          command: [harness],
          cwd: root,
          seams: { probe: { platform: "linux", artifactDir: root }, setupWallMs: 150 },
          signal: controller.signal,
          onSpawn: ({ pid }) => {
            spawnHandles++;
            setupPid = pid;
            // Cancel at ~120ms, then block the event loop past the 150ms
            // setup wall so the wall SIGKILL races the pending close event.
            setTimeout(() => {
              controller.abort();
              const until = Date.now() + 300;
              while (Date.now() < until) {
                /* bounded synchronous race fixture */
              }
            }, 120);
          },
        })
          .then(resolve)
          .catch(reject);
      });

      assert.equal(outcome.status, "aborted", "explicit cancellation must abort, never fall back");
      if (outcome.status !== "aborted") return;
      assert.match(outcome.reason, /cancelled/);
      assert.equal(outcome.timedOut, undefined);
      assert.equal(readCounter(counter), 0, "the harness must never start");
      assert.equal(spawnHandles, 1, "the setup child was spawned exactly once");
      assert.ok(setupPid !== undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an exhausted overall wall budget never begins fresh harness work (no fallback after deadline)", async () => {
    const root = tamanduaTempDir("tamandua-launch-deadline-");
    try {
      const counter = path.join(root, "harness-executions");
      const harness = makeCounterHarness(root, counter);
      makeFakeHelper(root, "hang");
      // US-003: wallDeadlineMs is on the MONOTONIC clock (the adapters pass
      // monotonicNow()-based deadlines), so the test budget must use the same
      // base — never Date.now().
      const started = monotonicNow();
      // Count REAL OS spawns via the launch's own onSpawn handles — not the
      // helper's journal, whose first line can lose the race with an early
      // overall-budget SIGKILL on slow hosts (same fix as the cancellation
      // and adapter-wall tests).
      let spawnHandles = 0;
      const outcome = await new Promise<HarnessLaunchOutcome>((resolve, reject) => {
        launchHarnessExecution({
          harness: "test",
          command: [harness],
          cwd: root,
          seams: {
            probe: { platform: "linux", artifactDir: root },
            setupWallMs: 20_000,
          },
          wallDeadlineMs: started + 250,
          onSpawn: () => {
            spawnHandles++;
          },
        })
          .then(resolve)
          .catch(reject);
      });
      const elapsed = monotonicNow() - started;
      assert.equal(outcome.status, "aborted", "the overall budget must abort the launch");
      if (outcome.status !== "aborted") return;
      assert.equal(outcome.timedOut, true, "budget exhaustion is a timed-out abort");
      assert.equal(readCounter(counter), 0, "zero harness executions after the budget expired");
      assert.equal(spawnHandles, 1, "the setup child was spawned exactly once and killed");
      assert.ok(elapsed < 2000, `launch must settle near the 250ms budget, took ${elapsed}ms`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("US-003: a monotonic wall budget is honored despite a backward wall-clock jump", async () => {
    const root = tamanduaTempDir("tamandua-launch-monotonic-wall-");
    try {
      const counter = path.join(root, "harness-executions");
      makeFakeHelper(root, "hang"); // never reports READY: the budget must fire
      const harness = makeCounterHarness(root, counter);
      const realDateNow = Date.now;
      let spawnHandles = 0;
      const started = monotonicNow();
      // Backward wall jump for the whole launch. The launch's deadline is
      // monotonic (the adapters pass monotonicNow()-based budgets), so the
      // setup child must still be spawned once and killed at ~250ms. Mixing
      // an epoch clock into the comparison would either treat the budget as
      // already expired (zero spawns) or never expire it (20s setup wall).
      Date.now = () => realDateNow() - 24 * 60 * 60 * 1000;
      try {
        const outcome = await launchHarnessExecution({
          harness: "test",
          command: [harness],
          cwd: root,
          seams: { probe: { platform: "linux", artifactDir: root }, setupWallMs: 20_000 },
          wallDeadlineMs: started + 250,
          onSpawn: () => {
            spawnHandles++;
          },
        });
        const elapsed = monotonicNow() - started;
        assert.equal(outcome.status, "aborted", "the monotonic overall budget must abort the launch");
        if (outcome.status !== "aborted") return;
        assert.equal(outcome.timedOut, true, "budget exhaustion is a timed-out abort");
        assert.equal(readCounter(counter), 0, "zero harness executions after the budget expired");
        assert.equal(spawnHandles, 1, "the setup child was spawned exactly once and killed");
        assert.ok(
          elapsed < 2000,
          `the monotonic budget must fire near 250ms despite the wall jump, took ${elapsed}ms`,
        );
      } finally {
        Date.now = realDateNow;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an already-expired wall budget aborts a forced-fallback launch with zero starts and no fallback", async () => {
    const root = tamanduaTempDir("tamandua-launch-expired-forced-");
    try {
      const counter = path.join(root, "harness-executions");
      const harness = makeCounterHarness(root, counter);
      // wallDeadlineMs is in the past BEFORE the launch begins: the entry
      // guard must abort (timedOut) instead of starting the unprotected
      // harness the forced-fallback seam would otherwise spawn. An identity
      // is passed so a (wrong) fallback would be durably visible.
      const outcome = await launchHarnessExecution({
        harness: "test",
        command: [harness],
        cwd: root,
        identity: { runId: "run-launch-expired-forced-1" },
        seams: { forceFallbackReason: "forced-by-test" },
        wallDeadlineMs: monotonicNow() - 100,
      });
      assert.equal(outcome.status, "aborted", "an expired deadline must abort the launch");
      if (outcome.status !== "aborted") return;
      assert.equal(outcome.timedOut, true, "expired budget is a timed-out abort");
      assert.equal(outcome.mode, undefined, "no fallback mode may be reported");
      assert.equal(readCounter(counter), 0, "zero harness executions when the budget already expired");
      const records = isolationRecords("run-launch-expired-forced-1");
      assert.equal(records.length, 0, "no fallback mode record may exist for an expired launch");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an already-expired wall budget aborts an unavailable-backend launch with zero starts and no fallback", async () => {
    const root = tamanduaTempDir("tamandua-launch-expired-unavail-");
    try {
      const counter = path.join(root, "harness-executions");
      const harness = makeCounterHarness(root, counter);
      // Backend unavailable (empty artifact dir) AND the overall budget
      // already expired: the entry guard must abort (timedOut) rather than
      // run the unprotected fallback the unavailable backend would trigger.
      const emptyArtifact = path.join(root, "empty-native");
      fs.mkdirSync(emptyArtifact, { recursive: true });
      const outcome = await launchHarnessExecution({
        harness: "test",
        command: [harness],
        cwd: root,
        identity: { runId: "run-launch-expired-unavail-1" },
        seams: { probe: { platform: "linux", artifactDir: emptyArtifact } },
        wallDeadlineMs: monotonicNow() - 100,
      });
      assert.equal(outcome.status, "aborted", "an expired deadline must abort the launch");
      if (outcome.status !== "aborted") return;
      assert.equal(outcome.timedOut, true, "expired budget is a timed-out abort");
      assert.equal(outcome.mode, undefined, "no fallback mode may be reported");
      assert.equal(readCounter(counter), 0, "zero harness executions when the budget already expired");
      const records = isolationRecords("run-launch-expired-unavail-1");
      assert.equal(records.length, 0, "no fallback mode record may exist for an expired launch");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an already-expired wall budget aborts a profile-read-error fallback route with zero starts", async () => {
    const root = tamanduaTempDir("tamandua-launch-expired-profile-");
    try {
      const counter = path.join(root, "harness-executions");
      const harness = makeCounterHarness(root, counter);
      // The seatbelt profile asset is a DIRECTORY: buildProtectedLaunchArgv
      // throws while reading it, which routes through the SAME unprotected
      // fallback helper as the forced/unavailable branches. An already-past
      // wallDeadlineMs must abort timed out at that shared boundary too —
      // zero starts, no fallback.
      fs.mkdirSync(path.join(root, "seatbelt-signal.sb"));
      const outcome = await launchHarnessExecution({
        harness: "test",
        command: [harness],
        cwd: root,
        identity: { runId: "run-launch-expired-profile-1" },
        seams: {
          probe: {
            platform: "darwin",
            artifactDir: root,
            sandboxExecPath: "/usr/bin/false",
          },
        },
        wallDeadlineMs: monotonicNow() - 100,
      });
      assert.equal(outcome.status, "aborted", "an expired deadline must abort the launch");
      if (outcome.status !== "aborted") return;
      assert.equal(outcome.timedOut, true, "expired budget is a timed-out abort");
      assert.equal(outcome.mode, undefined, "no fallback mode may be reported");
      assert.equal(readCounter(counter), 0, "zero harness executions when the budget already expired");
      const records = isolationRecords("run-launch-expired-profile-1");
      assert.equal(records.length, 0, "no fallback mode record may exist for an expired launch");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an unreadable seatbelt profile asset is a safe single fallback, never a crash", async () => {
    const root = tamanduaTempDir("tamandua-launch-profile-");
    try {
      const counter = path.join(root, "harness-executions");
      const harness = makeCounterHarness(root, counter);
      // profile asset is a DIRECTORY (mis-shaped install): reading it throws.
      fs.mkdirSync(path.join(root, "seatbelt-signal.sb"));
      const outcome = await launchHarnessExecution({
        harness: "test",
        command: [harness],
        cwd: root,
        seams: {
          probe: {
            platform: "darwin",
            artifactDir: root,
            sandboxExecPath: "/usr/bin/false",
          },
        },
      });
      assert.equal(outcome.status, "launched", "unreadable profile must fall back, not crash");
      if (outcome.status !== "launched") return;
      assert.equal(outcome.mode, "unprotected-fallback");
      const done = await runChildToCompletion(outcome.child);
      assert.equal(done.code, 0);
      assert.equal(readCounter(counter), 1, "exactly ONE unprotected execution after the fallback");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("forced fallback runs the harness exactly once unprotected with a durable record", async () => {
    const root = tamanduaTempDir("tamandua-launch-forced-");
    try {
      const counter = path.join(root, "harness-executions");
      const helperCount = path.join(root, "helper-starts");
      const harness = makeCounterHarness(root, counter);
      const outcome = await launchFixture({
        fixtureDir: root,
        behavior: "good",
        helperCounterFile: helperCount,
        command: [harness],
        forceFallbackReason: "forced-by-test",
        runId: "run-launch-forced-1",
      });
      assert.equal(outcome.status, "launched");
      if (outcome.status !== "launched") return;
      assert.equal(outcome.mode, "unprotected-fallback");
      assert.equal(outcome.reason, "forced-by-test");
      const done = await runChildToCompletion(outcome.child);
      assert.equal(done.code, 0);
      assert.equal(readCounter(helperCount), 0, "no native helper is spawned on the fallback path");
      assert.equal(readCounter(counter), 1, "exactly ONE unprotected execution");

      const records = isolationRecords("run-launch-forced-1");
      assert.equal(records.length, 1);
      assert.equal(records[0].mode, "unprotected-fallback");
      assert.equal(records[0].reason, "forced-by-test");
      assert.equal(records[0].runId, "run-launch-forced-1");
      assert.ok(typeof records[0].ts === "string" && (records[0].ts as string).length > 0);
      // The fallback warning must be VISIBLE through the run-event renderer
      // (logs-tail reads `detail`, not mode/reason) — not just durable JSON.
      const rendered = formatLogsTailLine(
        records[0] as Parameters<typeof formatLogsTailLine>[0],
      );
      assert.match(rendered, /unprotected/, `rendered fallback record must say 'unprotected': ${rendered}`);
      assert.match(String(records[0].detail ?? ""), /reason=forced-by-test/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("N >= 3 fallback launches under one runId emit exactly one isolation record and one WARN", async () => {
    const root = tamanduaTempDir("tamandua-launch-dedup-");
    const savedDebug = process.env.TAMANDUA_DEBUG;
    process.env.TAMANDUA_DEBUG = "1"; // make debug-level later-round logs observable
    try {
      const counter = path.join(root, "harness-executions");
      const harness = makeCounterHarness(root, counter);
      for (let i = 0; i < 3; i++) {
        const outcome = await launchFixture({
          fixtureDir: root,
          behavior: "good",
          command: [harness],
          forceFallbackReason: "forced-by-test",
          runId: "run-launch-dedup-1",
        });
        assert.equal(outcome.status, "launched");
        if (outcome.status !== "launched") return;
        assert.equal(outcome.mode, "unprotected-fallback");
        const done = await runChildToCompletion(outcome.child);
        assert.equal(done.code, 0);
      }
      assert.equal(
        readCounter(counter),
        3,
        "every fallback round must still EXECUTE the harness (dedup is logging only)",
      );

      // exactly ONE run.harness_isolation record for the run...
      const records = isolationRecords("run-launch-dedup-1");
      assert.equal(records.length, 1, "exactly one fallback event for the run");
      assert.equal(records[0].mode, "unprotected-fallback");
      assert.equal(records[0].runId, "run-launch-dedup-1");

      // ...and exactly ONE WARN line; later rounds are debug-only.
      const logLines = fs.readFileSync(isolationLogPath(), "utf8").split("\n");
      const warnLines = logLines.filter(
        (l) => l.includes("WARN") && l.includes("harness signal isolation unavailable"),
      );
      assert.equal(warnLines.length, 1, "exactly one fallback WARN for the run");
      const debugLines = logLines.filter(
        (l) => l.includes("DEBUG") && l.includes("already recorded for this run"),
      );
      assert.equal(debugLines.length, 2, "the 2 later fallback rounds log at debug");
    } finally {
      if (savedDebug === undefined) delete process.env.TAMANDUA_DEBUG;
      else process.env.TAMANDUA_DEBUG = savedDebug;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("two distinct runIds each get their own single unprotected-fallback record (not global-once)", async () => {
    const root = tamanduaTempDir("tamandua-launch-dedup-two-");
    try {
      const counter = path.join(root, "harness-executions");
      const harness = makeCounterHarness(root, counter);
      for (const runId of ["run-launch-dedup-a", "run-launch-dedup-b"]) {
        for (let i = 0; i < 2; i++) {
          const outcome = await launchFixture({
            fixtureDir: root,
            behavior: "good",
            command: [harness],
            forceFallbackReason: "forced-by-test",
            runId,
          });
          assert.equal(outcome.status, "launched");
          if (outcome.status !== "launched") return;
          assert.equal(outcome.mode, "unprotected-fallback");
          const done = await runChildToCompletion(outcome.child);
          assert.equal(done.code, 0);
        }
      }
      assert.equal(readCounter(counter), 4, "every fallback round still executes the harness");

      const a = isolationRecords("run-launch-dedup-a");
      const b = isolationRecords("run-launch-dedup-b");
      assert.equal(a.length, 1, "run A has its own single fallback event");
      assert.equal(b.length, 1, "run B has its own single fallback event");
      assert.equal(a[0].runId, "run-launch-dedup-a");
      assert.equal(b[0].runId, "run-launch-dedup-b");

      const warnLines = fs
        .readFileSync(isolationLogPath(), "utf8")
        .split("\n")
        .filter((l) => l.includes("WARN") && l.includes("harness signal isolation unavailable"));
      assert.equal(warnLines.length, 2, "each run gets exactly one fallback WARN");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("protected landlock executions still emit one isolation record PER execution (dedup never applies)", async () => {
    const root = tamanduaTempDir("tamandua-launch-protected-multi-");
    try {
      const counter = path.join(root, "harness-executions");
      const helperCount = path.join(root, "helper-starts");
      const harness = makeCounterHarness(root, counter);
      for (let i = 0; i < 3; i++) {
        const outcome = await launchFixture({
          fixtureDir: root,
          behavior: "good",
          helperCounterFile: helperCount,
          command: [harness],
          runId: "run-launch-protected-multi-1",
        });
        assert.equal(outcome.status, "launched");
        if (outcome.status !== "launched") return;
        assert.equal(outcome.mode, "landlock");
        const done = await runChildToCompletion(outcome.child);
        assert.equal(done.code, 0);
      }
      const records = isolationRecords("run-launch-protected-multi-1");
      assert.equal(records.length, 3, "protected records are one-per-execution, undeduped");
      assert.deepEqual(
        records.map((r) => r.mode),
        ["landlock", "landlock", "landlock"],
      );
      const warnLines = fs
        .readFileSync(isolationLogPath(), "utf8")
        .split("\n")
        .filter((l) => l.includes("WARN") && l.includes("harness signal isolation unavailable"));
      assert.equal(warnLines.length, 0, "protected launches never warn");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an overall-armed setup timer aborts timed out and NEVER falls back (retained armed cause)", async () => {
    // Regression for the timer-cause defect the US-005 full gate caught
    // (harness-launch.ts setup timer): the timer was armed for
    // min(overall deadline, setup wall) but the callback DECIDED which
    // deadline fired by re-reading the clock. Clock vs timer skew can
    // deliver the overall-budget timer marginally BEFORE the clock crosses
    // that deadline, and the old code then mislabeled the kill as a
    // readiness-wall expiry -> settleFallback -> an unprotected fallback ran
    // AFTER the round's overall budget expired. The fix retains the ARMED
    // cause: an overall-armed fire always aborts timed out with zero starts.
    //
    // US-003: both deadlines are monotonic now, so the test arms a short
    // overall budget (50ms) well below the 20s readiness wall — the setup
    // timer is armed FOR THE OVERALL BUDGET and fires first. The retained
    // armed cause must abort timedOut with zero starts and no fallback.
    const root = tamanduaTempDir("tamandua-launch-timercause-");
    try {
      const counter = path.join(root, "harness-executions");
      makeFakeHelper(root, "hang"); // never reports READY
      const harness = makeCounterHarness(root, counter);
      const spawnHandles: Array<{ pid: number; pgid: number }> = [];
      const outcomePromise = launchHarnessExecution({
        harness: "test",
        command: [harness],
        cwd: root,
        identity: { runId: "run-timercause-1" },
        seams: { probe: { platform: "linux", artifactDir: root }, setupWallMs: 20_000 },
        wallDeadlineMs: monotonicNow() + 50,
        onSpawn: (h) => spawnHandles.push(h),
      });
      const outcome = await outcomePromise;
      assert.equal(outcome.status, "aborted", `overall-budget fire must abort (${outcome.reason ?? ""})`);
      if (outcome.status !== "aborted") return;
      assert.equal(outcome.timedOut, true, "overall-budget exhaustion is a timed-out round");
      assert.equal(outcome.mode, undefined, "no fallback mode may be reported for the abort");
      assert.equal(readCounter(counter), 0, "zero harness executions after the overall budget expired");
      assert.equal(spawnHandles.length, 1, "only the setup child was spawned — never an unprotected fallback");
      const records = isolationRecords("run-timercause-1");
      assert.equal(records.length, 0, "no unprotected-fallback record may exist for an overall-budget abort");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Adapter + launch-time probe round integration (real backend) ───

describe("adapter launches through the shared mechanism (real backend)", () => {
  // Host capability gate: these tests exercise the REAL native backend.
  // probeBackend() proves only that the compiled helper ARTIFACT exists.
  // Before the strict protected-mode cases may assume mode=landlock, the
  // REAL helper must prove it can establish its domain on THIS host (see
  // probeRealLandlockDomain): a known ABI-floor refusal skips those cases
  // with an informative reason, an unexpected probe failure FAILS them (RED),
  // and hosts without a backend skip as before. The Mac seatbelt branch is
  // not Linux-gated and keeps its full protected coverage.
  const realBackend = probeBackend();
  const protectedKind =
    realBackend.kind === "landlock" || realBackend.kind === "seatbelt" ? realBackend.kind : null;

  // Shared real-helper domain probe, cached: the real helper is spawned at
  // most once per suite and every strict protected-mode case awaits the same
  // outcome. An unexpected probe failure rejects the shared promise, which
  // FAILS each awaiting strict case (RED) — never a silent skip.
  let landlockCapabilityPromise: Promise<LandlockHostCapability> | null = null;
  function realLandlockCapability(): Promise<LandlockHostCapability> {
    if (realBackend.kind !== "landlock") {
      return Promise.reject(
        new Error("real landlock capability requested without a landlock backend"),
      );
    }
    if (landlockCapabilityPromise === null) {
      landlockCapabilityPromise = probeRealLandlockDomain(realBackend.helperPath);
      // Keep the shared probe from ever surfacing as an unhandled rejection;
      // each strict case awaits it and re-raises on unexpected failure.
      void landlockCapabilityPromise.catch(() => undefined);
    }
    return landlockCapabilityPromise;
  }

  /**
   * Decide whether a STRICT protected-mode real-backend case may run on this
   * host. Returns a skip reason when it cannot (t.skip with an informative
   * capability reason) or null when the case must execute with its full
   * protected-mode assertions. An unexpected probe failure rejects here — the
   * calling test fails RED instead of skipping.
   */
  async function protectedModeSkipReason(): Promise<string | null> {
    if (realBackend.kind === "seatbelt") return null; // real protected Mac branch: run
    if (realBackend.kind !== "landlock") {
      return `no native backend on this host (${realBackend.kind}: ${realBackend.kind === "unavailable" ? realBackend.reason : ""})`;
    }
    const cap = await realLandlockCapability();
    if (cap.state === "known-unsupported") {
      return `real landlock helper cannot establish its SIGNAL-scope domain on this host: ${cap.reason}`;
    }
    return null; // supported — strict protected-mode assertions run
  }

  it("pi runRound executes exactly once with launchMode reporting the real backend", async (t) => {
    const skip = await protectedModeSkipReason();
    if (skip !== null) {
      t.skip(skip);
      return;
    }
    const root = tamanduaTempDir("tamandua-launch-adapter-pi-");
    try {
      const counter = path.join(root, "harness-executions");
      const fakePi = path.join(root, "pi");
      writeExecutable(fakePi, `#!/bin/sh\nprintf 'x\\n' >> "${counter}"\nprintf 'hello-from-launch\\n'\n`);
      const saved = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;
      try {
        const adapter = getHarnessAdapter("pi");
        const spawns: Array<{ pid: number; pgid: number }> = [];
        const result = await adapter.runRound("test prompt", {
          timeout: 20,
          workdir: root,
          execution: { runId: "run-adapter-pi-1", agentId: "dev", roundId: "job-1" },
          onSpawn: (h) => spawns.push(h),
        });
        assert.equal(result.output, "hello-from-launch");
        assert.equal(result.exitCode, 0);
        assert.equal(result.launchMode, protectedKind, "the real backend must be reported");
        assert.notEqual(result.launchMode, "unprotected-fallback");
        assert.equal(readCounter(counter), 1, "exactly ONE pi harness execution");
        assert.equal(spawns.length, 1, "onSpawn fired once with the live harness pid");

        const records = isolationRecords("run-adapter-pi-1");
        assert.equal(records.length, 1, "mode record emitted for the protected pi launch");
        assert.equal(records[0].mode, protectedKind);
        assert.equal(records[0].runId, "run-adapter-pi-1");
        assert.equal(records[0].agentId, "dev");
        assert.equal(records[0].roundId, "job-1");
      } finally {
        if (saved === undefined) delete process.env.TAMANDUA_PI_BINARY;
        else process.env.TAMANDUA_PI_BINARY = saved;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pi runRound: harness exiting 125 after release is a normal failure — no fallback", async (t) => {
    const skip = await protectedModeSkipReason();
    if (skip !== null) {
      t.skip(skip);
      return;
    }
    const root = tamanduaTempDir("tamandua-launch-adapter-pi125-");
    try {
      const counter = path.join(root, "harness-executions");
      const fakePi = path.join(root, "pi");
      writeExecutable(fakePi, `#!/bin/sh\nprintf 'x\\n' >> "${counter}"\nexit 125\n`);
      const saved = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;
      try {
        const adapter = getHarnessAdapter("pi");
        const result = await adapter.runRound("prompt", {
          timeout: 20,
          workdir: root,
          execution: { runId: "run-adapter-pi125-1" },
        });
        // Post-release helper-like exit code: NORMAL harness failure.
        assert.equal(result.exitCode, 125);
        assert.equal(result.launchMode, protectedKind, "protected launch — never fell back");
        assert.equal(readCounter(counter), 1, "exactly ONE harness execution");
        const records = isolationRecords("run-adapter-pi125-1");
        assert.equal(records.length, 1);
        assert.equal(records[0].mode, protectedKind, "no unprotected-fallback record after release");
      } finally {
        if (saved === undefined) delete process.env.TAMANDUA_PI_BINARY;
        else process.env.TAMANDUA_PI_BINARY = saved;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("hermes runRound executes exactly once through the shared mechanism", async (t) => {
    const skip = await protectedModeSkipReason();
    if (skip !== null) {
      t.skip(skip);
      return;
    }
    const root = tamanduaTempDir("tamandua-launch-adapter-hermes-");
    try {
      const counter = path.join(root, "harness-executions");
      const fakeHermes = path.join(root, "hermes-mock");
      writeExecutable(fakeHermes, `#!/bin/sh\nprintf 'x\\n' >> "${counter}"\nprintf 'hermes output here\\n'\n`);
      const adapter = getHarnessAdapter("hermes");
      const result = await adapter.runRound("do work", {
        workdir: root,
        timeout: 20,
        binaryPath: fakeHermes,
      });
      assert.ok(result.output.includes("hermes output here"), "hermes stdout must flow through");
      assert.equal(result.exitCode, 0);
      assert.equal(result.launchMode, protectedKind);
      assert.equal(readCounter(counter), 1, "exactly ONE hermes harness execution");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("dsh runRound executes exactly once through the shared mechanism", async (t) => {
    const skip = await protectedModeSkipReason();
    if (skip !== null) {
      t.skip(skip);
      return;
    }
    const root = tamanduaTempDir("tamandua-launch-adapter-dsh-");
    try {
      const counter = path.join(root, "harness-executions");
      const fakeDsh = path.join(root, "dsh-mock");
      writeExecutable(fakeDsh, `#!/bin/sh\nprintf 'x\\n' >> "${counter}"\nprintf 'STATUS: done\\n'\n`);
      const adapter = getHarnessAdapter("dsh");
      const result = await adapter.runRound("do work", {
        workdir: root,
        timeout: 20,
        binaryPath: fakeDsh,
      });
      assert.ok(result.output.includes("STATUS: done"), "dsh stdout must pass through verbatim");
      assert.equal(result.exitCode, 0);
      assert.equal(result.launchMode, protectedKind);
      assert.equal(readCounter(counter), 1, "exactly ONE dsh harness execution");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a launch-time-probe-shaped round executes exactly once per launch", async (t) => {
    const skip = await protectedModeSkipReason();
    if (skip !== null) {
      t.skip(skip);
      return;
    }
    const root = tamanduaTempDir("tamandua-launch-adapter-probe-");
    try {
      const counter = path.join(root, "harness-executions");
      const expectedPath = path.join(root, "skills", "answer.txt");
      const fakePi = path.join(root, "pi");
      // Probe-shaped harness: answers with the PATH the daemon computed.
      writeExecutable(
        fakePi,
        `#!/bin/sh\nprintf 'x\\n' >> "${counter}"\nprintf '${expectedPath}\\n'\n`,
      );
      const saved = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;
      try {
        const adapter = getHarnessAdapter("pi");
        const prompt =
          "TAMANDUA_HARNESS_PROBE: skill-path\nRun the exact command \"/usr/bin/tamandua skill-path\" and reply with the PATH and nothing else.";
        const result = await adapter.runRound(prompt, {
          timeout: 20,
          workdir: root,
          execution: { runId: "run-adapter-probe-1" },
        });
        assert.equal(result.output, expectedPath);
        assert.equal(result.launchMode, protectedKind);
        assert.equal(readCounter(counter), 1, "the probe round must execute the harness exactly once");
        const records = isolationRecords("run-adapter-probe-1");
        assert.equal(records.length, 1, "probe launch carries its isolation-mode record too");
        assert.equal(records[0].mode, protectedKind);
      } finally {
        if (saved === undefined) delete process.env.TAMANDUA_PI_BINARY;
        else process.env.TAMANDUA_PI_BINARY = saved;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("adapter forced-fallback runs once unprotected and records mode=unprotected-fallback", async () => {
    const root = tamanduaTempDir("tamandua-launch-adapter-forced-");
    try {
      const counter = path.join(root, "harness-executions");
      const fakePi = path.join(root, "pi");
      writeExecutable(fakePi, `#!/bin/sh\nprintf 'x\\n' >> "${counter}"\nprintf 'ok-unprotected\\n'\n`);
      const saved = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;
      try {
        const adapter = getHarnessAdapter("pi");
        const result = await adapter.runRound("prompt", {
          timeout: 20,
          workdir: root,
          execution: { runId: "run-adapter-forced-1" },
          launch: { forceFallbackReason: "forced-by-test" },
        });
        assert.equal(result.output, "ok-unprotected");
        assert.equal(result.launchMode, "unprotected-fallback");
        assert.equal(result.launchReason, "forced-by-test");
        assert.equal(readCounter(counter), 1, "exactly ONE unprotected execution");

        const records = isolationRecords("run-adapter-forced-1");
        assert.equal(records.length, 1);
        assert.equal(records[0].mode, "unprotected-fallback");
        assert.equal(records[0].reason, "forced-by-test");
        assert.equal(records[0].runId, "run-adapter-forced-1");
      } finally {
        if (saved === undefined) delete process.env.TAMANDUA_PI_BINARY;
        else process.env.TAMANDUA_PI_BINARY = saved;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the adapter overall wall budget covers native setup — zero harness starts after it expires", async () => {
    // Host-independent: a fixture helper that never reports readiness plus a
    // tiny adapter timeout exercises the budget gate without a real backend.
    const root = tamanduaTempDir("tamandua-launch-adapter-budget-");
    try {
      const counter = path.join(root, "harness-executions");
      makeFakeHelper(root, "hang");
      const fakeDsh = path.join(root, "dsh-mock");
      writeExecutable(fakeDsh, `#!/bin/sh\nprintf 'x\\n' >> "${counter}"\nsleep 60\n`);
      const started = Date.now();
      const adapter = getHarnessAdapter("dsh");
      // Count REAL OS spawns via the launch's own onSpawn handles — not the
      // helper's journal, whose first line can lose the race with the short
      // overall budget on slow hosts (Mac observed zero journal entries for
      // a setup child that WAS spawned and then killed at the ~50ms wall).
      const spawnHandles: Array<{ pid: number; pgid: number }> = [];
      const result = await adapter.runRound("do work", {
        workdir: root,
        timeout: 0.05, // 50ms overall wall
        binaryPath: fakeDsh,
        launch: { probe: { platform: "linux", artifactDir: root }, setupWallMs: 20_000 },
        onSpawn: (h) => spawnHandles.push(h),
      });
      const elapsed = Date.now() - started;
      assert.equal(result.timedOut, true, "budget exhaustion during setup is a timed-out round");
      assert.equal(readCounter(counter), 0, "zero harness executions after the overall budget");
      assert.equal(spawnHandles.length, 1, "the setup child was spawned exactly once and killed");
      assert.ok(elapsed < 2000, `must settle near the 50ms budget, took ${elapsed}ms`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the real cancellation path (abort signal + group SIGTERM) during a pending setup failure never starts the harness", async () => {
    // Models the scheduler teardown path with a PENDING setup failure: the
    // round's AbortSignal is aborted and the setup child's group is
    // SIGTERM'd while the native setup is still pending — the adapter must
    // resolve a cancelled round with ZERO harness starts and NO fallback.
    const root = tamanduaTempDir("tamandua-launch-adapter-cancelpending-");
    try {
      const counter = path.join(root, "harness-executions");
      makeFakeHelper(root, "hang");
      const fakeDsh = path.join(root, "dsh-mock");
      writeExecutable(fakeDsh, `#!/bin/sh\nprintf 'x\\n' >> "${counter}"\nsleep 60\n`);
      const controller = new AbortController();
      let setupPgid = 0;

      const resultPromise = (async () => {
        const adapter = getHarnessAdapter("dsh");
        return adapter.runRound("do work", {
          workdir: root,
          timeout: 30,
          binaryPath: fakeDsh,
          launch: { probe: { platform: "linux", artifactDir: root }, setupWallMs: 20_000 },
          signal: controller.signal,
          onSpawn: ({ pgid }) => {
            setupPgid = pgid;
            // Abort AND signal the group, exactly like removeRunCrons does
            // when it cancels an in-flight round during native setup.
            setTimeout(() => {
              controller.abort();
              try {
                process.kill(-pgid, "SIGTERM");
              } catch {
                /* already gone */
              }
            }, 150);
          },
        });
      })();

      const result = await resultPromise;
      assert.ok(setupPgid !== 0, "onSpawn must fire during setup");
      assert.equal(readCounter(counter), 0, "zero harness starts after the cancellation");
      assert.equal(result.output, "");
      assert.equal(result.launchMode, undefined, "no fallback mode may be reported for a cancelled launch");
      assert.equal(result.timedOut, undefined, "a cancellation is not a timeout");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the scheduling daemon (test parent) is never sandboxed and can cancel its protected child", async (t) => {
    if (!protectedKind) {
      t.skip(`no native backend on this host (${realBackend.kind})`);
      return;
    }
    const root = tamanduaTempDir("tamandua-launch-adapter-cancel-");
    try {
      const fakePi = path.join(root, "pi");
      writeExecutable(fakePi, "#!/bin/sh\nsleep 30\n");
      const saved = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;
      try {
        const adapter = getHarnessAdapter("pi");
        let childPgid = 0;
        const resultPromise = adapter.runRound("prompt", {
          timeout: 60,
          workdir: root,
          onSpawn: ({ pid, pgid }) => {
            childPgid = pgid;
            // The unprotected parent (this test) signals its protected child.
            setTimeout(() => {
              try {
                process.kill(-pgid, "SIGTERM");
              } catch {
                /* best effort */
              }
            }, 250);
          },
        });
        const result = await resultPromise;
        assert.ok(childPgid !== 0, "onSpawn must fire");
        assert.equal(result.signal, "SIGTERM", "the parent's cancellation reaches the protected child");
        assert.equal(result.exitCode, null);
      } finally {
        if (saved === undefined) delete process.env.TAMANDUA_PI_BINARY;
        else process.env.TAMANDUA_PI_BINARY = saved;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Real landlock host-capability gate: fixture-backed coverage ────
// Synthetic (provider-free) classification coverage for the gate the strict
// protected-mode cases use. Each fixture stands in for the real helper
// binary and is exercised through the SAME probeRealLandlockDomain the suite
// gate runs, covering supported / known-unsupported / unexpected-failure.

describe("real landlock host-capability gate (fixture helpers)", () => {
  // The "good" / "ready-then-exit-125" fixtures below stand in for the REAL
  // helper binary, so they use the byte release protocol (read exactly one
  // byte, like native/landlock-helper.c read(1)) — NOT the runtime's "GO"
  // line protocol. Only these fixtures wait for a release, which is why only
  // they select "byte".
  it("reports supported when the helper establishes its domain and the controlled target exits 0", async () => {
    const root = tamanduaTempDir("tamandua-cap-supported-");
    try {
      const helper = makeFakeHelper(root, "good", undefined, "byte"); // real-helper one-byte release
      const cap = await probeRealLandlockDomain(helper);
      assert.equal(cap.state, "supported");
      if (cap.state === "supported") {
        assert.equal(cap.realAbi, 8, "READY abi is parsed from the control frame");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports known-unsupported for the helper's own ABI-floor diagnostic (exit 125 + stage=abi-below-minimum)", async () => {
    const root = tamanduaTempDir("tamandua-cap-abi-");
    try {
      const helper = path.join(root, "landlock-helper");
      // Mimic the real helper's pre-READY ABI gate diagnostic verbatim.
      writeExecutable(
        helper,
        `#!/bin/sh\n` +
          `printf 'tamandua-landlock-helper: pre-exec setup failure stage=abi-below-minimum detail=landlock kernel ABI 4 below required minimum 6 (SYS_landlock_create_ruleset returned 4) errno=0 (none)\\n' >&2\n` +
          `exit 125\n`,
      );
      const cap = await probeRealLandlockDomain(helper);
      assert.equal(cap.state, "known-unsupported");
      if (cap.state === "known-unsupported") {
        assert.match(cap.reason, /below required minimum|SIGNAL scope unavailable/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws (never skips) when the helper exits pre-READY without the known ABI-floor diagnostic", async () => {
    const root = tamanduaTempDir("tamandua-cap-exit125-");
    try {
      const helper = makeFakeHelper(root, "exit-125");
      await assert.rejects(
        () => probeRealLandlockDomain(helper),
        /probe failed unexpectedly/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when only a malformed READY frame arrives (never treated as a domain)", async () => {
    const root = tamanduaTempDir("tamandua-cap-partial-");
    try {
      const helper = makeFakeHelper(root, "partial-frame");
      await assert.rejects(
        () => probeRealLandlockDomain(helper),
        /probe failed unexpectedly/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the domain is established but the controlled target then fails", async () => {
    const root = tamanduaTempDir("tamandua-cap-targetfail-");
    try {
      const helper = makeFakeHelper(root, "ready-then-exit-125", undefined, "byte"); // real-helper one-byte release
      await assert.rejects(
        () => probeRealLandlockDomain(helper),
        /controlled .* target failed/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the helper reports READY below the SIGNAL-scope ABI floor (protocol anomaly)", async () => {
    const root = tamanduaTempDir("tamandua-cap-lowabi-");
    try {
      const helper = path.join(root, "landlock-helper");
      // Reports READY with abi=3 (below the floor) then waits for the real
      // helper's one-byte release (byte protocol, not the runtime "GO" line).
      writeExecutable(
        helper,
        `#!/bin/sh\n` +
          `[ "$1" = "--control-fd" ] && [ "$3" = "--" ] || exit 124\n` +
          `shift 3\n` +
          `printf 'READY mode=landlock abi=3 pid=%s\\n' "$$" >&3 || exit 125\n` +
          `__rel="$(dd bs=1 count=1 2>/dev/null <&3)" || exit 125\n` +
          `[ -n "$__rel" ] || exit 125\n` +
          `exec 3>&-\n` +
          `exec "$@"\n`,
      );
      await assert.rejects(
        () => probeRealLandlockDomain(helper),
        /below the SIGNAL-scope floor/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
