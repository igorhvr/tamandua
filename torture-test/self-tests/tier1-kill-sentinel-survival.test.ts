// E3.C.1 US-007 — Sentinel-parent regression proof.
//
// The E3.C incident: the developer's own kill-heavy test executions SIGKILLed
// the worker's harness process twice (empty_output/worker-lost at 12:10:38
// during the US-010 O4 mutation self-tests and 19:14:03 during the US-011
// scripted probe battery) — a kill reached the test's OWN ancestry. The fix
// (US-001..US-006) confined every kill to an explicit recorded pid/pgid list.
//
// This test supplies the mandated regression PROOF: it runs the two
// kill-heavy suites — the O4 mutation battery (oracles/self-test/run.sh) and
// the scripted probe battery (tier1-scripted-probe-battery.test.ts) — under
// bin/tt-kill-sentinel, a wrapper that places a marker sentinel process in
// the suite's ancestry (direct parent, same process group, same cwd). If any
// kill site in the suite still reached the suite's own ancestry, the sentinel
// would die (SIGKILL) and the wrapper would exit 70 with death detail. The
// sentinel IGNORES SIGTERM, so normal cleanup signals cannot false-positive.
//
// The probe-battery leg follows the heavy-battery isolation pattern
// (bin/verify-heavy-campaign-tests.test.sh): individual invocation, its own
// generous timeout, never inside the bounded run.sh battery — this test file
// is itself listed in HEAVY_CAMPAIGN_TESTS (lock-step across run.sh,
// verify-heavy-campaign-tests.test.sh, and e2e-golden-integrity.test.ts).
//
// Negative path: a SIGKILLed sentinel must fail the wrapper visibly (exit 70,
// "SENTINEL DIED" detail) — proving the assertion actually detects death.
//
// Confined to torture-test/. Zero tokens. State under ${TMPDIR:-/tmp} and the
// gitignored torture-test/var/.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const sentinelWrapper = path.join(ttRoot, "bin", "tt-kill-sentinel");

// Clean env for everything the sentinel wrapper spawns: strip NODE_TEST_CONTEXT
// (node:test auto-activates the isolation guard in every child) and disable
// the guard explicitly — the suites operate entirely inside torture-test/var
// and temp state, never the live ~/.tamandua.
function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.TAMANDUA_TEST_GUARD = "0";
  if (extra) Object.assign(env, extra);
  return env;
}

function readStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return after.length > 19 ? after[19] : null;
  } catch {
    return null;
  }
}

interface SentinelRun {
  status: number | null;
  stdout: string;
  stderr: string;
  pidfile: string;
  sentinelPid: number;
  suitePid: number;
}

// runUnderSentinel: run <cmd> under the sentinel wrapper. Returns the wrapper
// result plus the recorded sentinel/suite pids. The wrapper's own
// --suite-timeout (TT_KILL_SENTINEL_TIMEOUT_SEC) is the real deadline; the
// spawnSync timeout is only a last-resort cap far above it.
function runUnderSentinel(
  cmd: string[],
  opts: { timeoutSec?: number; env?: NodeJS.ProcessEnv } = {},
): SentinelRun {
  const pidfile = path.join(
    os.tmpdir(),
    `tt-kill-sentinel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`,
  );
  fs.rmSync(pidfile, { force: true });
  fs.rmSync(`${pidfile}.suite-pid`, { force: true });
  fs.rmSync(`${pidfile}.fifo`, { force: true });
  const timeoutSec = opts.timeoutSec ?? 1800;
  const args = [pidfile, "--suite-timeout", String(timeoutSec), "--", ...cmd];
  const res = spawnSync(sentinelWrapper, args, {
    cwd: repoRoot,
    env: opts.env ?? cleanEnv(),
    encoding: "utf8",
    timeout: timeoutSec * 1000 + 120_000,
    maxBuffer: 512 * 1024 * 1024,
  });
  let sentinelPid = 0;
  try {
    sentinelPid = Number.parseInt(fs.readFileSync(pidfile, "utf8").trim(), 10);
  } catch {
    /* sentinel never started */
  }
  let suitePid = 0;
  try {
    suitePid = Number.parseInt(fs.readFileSync(`${pidfile}.suite-pid`, "utf8").trim(), 10);
  } catch {
    /* suite pid not recorded */
  }
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
    pidfile,
    sentinelPid,
    suitePid,
  };
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return fs.existsSync(`/proc/${pid}`);
  } catch {
    return false;
  }
}

describe("E3.C.1 US-007 — sentinel-parent regression proof", () => {
  it("AC1a: sentinel survives the O4 mutation battery (oracles/self-test/run.sh)", function () {
    // run.sh is internally bounded (suite watchdog ~300s + two rounds); give
    // the wrapper a generous ceiling.
    this.timeout = 1_500_000;
    const run = runUnderSentinel(
      ["bash", path.join(ttRoot, "oracles", "self-test", "run.sh")],
      { timeoutSec: 1200 },
    );
    try {
      // The wrapper exits with the suite's rc when the sentinel survived.
      assert.equal(run.status, 0, `O4 battery under sentinel must pass:\nstdout: ${run.stdout.slice(-4000)}\nstderr: ${run.stderr.slice(-2000)}`);
      assert.match(run.stdout + run.stderr, /SENTINEL SURVIVED/,
        "wrapper must report sentinel survival after the O4 battery");
      assert.ok(run.sentinelPid > 0, "sentinel pid must be recorded in the pidfile");
    } finally {
      fs.rmSync(run.pidfile, { force: true });
      fs.rmSync(`${run.pidfile}.suite-pid`, { force: true });
      fs.rmSync(`${run.pidfile}.fifo`, { force: true });
    }
  });

  it("AC1b: sentinel survives the probe-battery self-test (tier1-scripted-probe-battery.test.ts)", function () {
    // Heavy-battery isolation pattern: individual invocation, own generous
    // timeout (the battery itself took ~14 min in US-006).
    this.timeout = 2_700_000;
    const run = runUnderSentinel(
      [process.execPath, "--test", path.join(ttRoot, "self-tests", "tier1-scripted-probe-battery.test.ts")],
      { timeoutSec: 2400 },
    );
    try {
      assert.equal(run.status, 0, `probe battery under sentinel must pass:\nstdout: ${run.stdout.slice(-8000)}\nstderr: ${run.stderr.slice(-2000)}`);
      assert.match(run.stdout + run.stderr, /SENTINEL SURVIVED/,
        "wrapper must report sentinel survival after the probe battery");
      assert.ok(run.sentinelPid > 0, "sentinel pid must be recorded in the pidfile");
    } finally {
      fs.rmSync(run.pidfile, { force: true });
      fs.rmSync(`${run.pidfile}.suite-pid`, { force: true });
      fs.rmSync(`${run.pidfile}.fifo`, { force: true });
    }
  });

  it("AC2: the wrapper cleans up its sentinel and suite after a normal run", function () {
    this.timeout = 120_000;
    const run = runUnderSentinel(["sh", "-c", "exit 0"], { timeoutSec: 60 });
    try {
      assert.equal(run.status, 0, `trivial suite must pass: ${run.stderr}`);
      assert.ok(run.sentinelPid > 0, "sentinel pid must be recorded");
      assert.ok(!pidAlive(run.sentinelPid), `sentinel ${run.sentinelPid} must be cleaned up after the wrapper exits`);
    } finally {
      fs.rmSync(run.pidfile, { force: true });
      fs.rmSync(`${run.pidfile}.suite-pid`, { force: true });
      fs.rmSync(`${run.pidfile}.fifo`, { force: true });
    }
  });

  it("AC3 (negative path): a SIGKILLed sentinel fails the wrapper visibly", async function () {
    this.timeout = 120_000;
    const pidfile = path.join(
      os.tmpdir(),
      `tt-kill-sentinel-neg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`,
    );
    fs.rmSync(pidfile, { force: true });
    fs.rmSync(`${pidfile}.suite-pid`, { force: true });
  fs.rmSync(`${pidfile}.fifo`, { force: true });

    // Suite long enough to kill the sentinel mid-run, short enough to clean up.
    // A direct `sleep` (exec, no fork) so the recorded suite pid IS the
    // process holding the stdio pipes — killing it closes them promptly.
    const child = spawn(
      sentinelWrapper,
      [pidfile, "--suite-timeout", "120", "--", "sleep", "60"],
      { cwd: repoRoot, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });

    // Wait for the sentinel pidfile.
    let sentinelPid = 0;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        sentinelPid = Number.parseInt(fs.readFileSync(pidfile, "utf8").trim(), 10);
        if (sentinelPid > 0) break;
      } catch {
        /* not yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(sentinelPid > 0, `sentinel pidfile must appear within 15s (pidfile: ${pidfile})`);

    // SIGKILL the sentinel — a kill reaching the ancestry would do exactly this.
    try {
      process.kill(sentinelPid, "SIGKILL");
    } catch (error) {
      assert.fail(`cannot SIGKILL sentinel ${sentinelPid}: ${String(error)}`);
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    try {
      // A killed sentinel must fail the wrapper visibly: exit 70 + death detail.
      assert.equal(exitCode, 70, `wrapper must exit 70 when the sentinel dies\nstdout: ${stdout}\nstderr: ${stderr}`);
      assert.match(stdout + stderr, /SENTINEL DIED/,
        "wrapper must report SENTINEL DIED with detail");
      // The orphaned suite (child of the dead sentinel) must be cleaned up by
      // the wrapper via its recorded pid.
      let suitePid = 0;
      try {
        suitePid = Number.parseInt(fs.readFileSync(`${pidfile}.suite-pid`, "utf8").trim(), 10);
      } catch {
        /* suite pid may not have been recorded before the kill */
      }
      if (suitePid > 0) {
        // Give the wrapper's cleanup a moment to reap, then assert gone.
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.ok(!pidAlive(suitePid), `orphaned suite ${suitePid} must be cleaned up by the wrapper`);
      }
    } finally {
      // Belt-and-suspenders: never leak the suite if the wrapper was killed
      // before cleanup ran.
      try {
        const suitePid = Number.parseInt(fs.readFileSync(`${pidfile}.suite-pid`, "utf8").trim(), 10);
        if (suitePid > 0 && pidAlive(suitePid)) process.kill(suitePid, "SIGKILL");
      } catch {
        /* nothing recorded */
      }
      fs.rmSync(pidfile, { force: true });
      fs.rmSync(`${pidfile}.suite-pid`, { force: true });
  fs.rmSync(`${pidfile}.fifo`, { force: true });
    }
  });
});
