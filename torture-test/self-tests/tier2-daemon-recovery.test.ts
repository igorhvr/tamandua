// US-008 (T2.1) — W4.24-serial-lane-concurrent daemon-down recovery.
//
// Campaign evidence (operator run on merged main,
// campaign-20260816T235948135Z): W4.24 exits 1 at
// run-serial-lane-concurrent.mjs:260 (completedRunId `strictEqual 2 vs 0`)
// with stderr `run ... is 'running' but the daemon is down — it may be
// stalled`; the scenario asserted a run id completed but it had not.
// Diagnosis from the state-dir lifecycle log + the systemd user journal:
// the cell's contained scripted daemon (PID 55431) was SIGTERM'd at
// 00:04:45Z, ONE second after a CONCURRENT campaign in another worktree
// (862-c9ab2422) ran `daemon-control scripted start`. daemon-control starts
// the scripted daemon inside a FIXED per-user systemd scope unit name
// `tamandua-tt-scripted`, and cmd_start's clean-slate step
// (`systemctl --user stop tamandua-tt-scripted.scope`) SIGTERMs WHATEVER
// daemon currently owns that scope — including a sibling worktree's live
// daemon. The TT run stalled (pending 1, running 0) and `workflow run --wait
// --timeout 6m` timed out (exit 2) because the cell had no recovery
// orchestration: it assumed the contained daemon stays up for the whole
// corridor.
//
// Fix (confined to torture-test/, zero tokens, no product change, no
// assertion weakened): the cell now watches the contained scripted daemon
// while the TT runs are in flight (the same pid-file + signal-0 check the
// product's wait uses) and, on a DOWN window, restarts the daemon via
// daemon-control (scenarios/lib/scripted-daemon-recovery.mjs). The product's
// reconciler re-admits `running` runs and requeues dead-worker steps on its
// first tick after daemon start, so the stalled runs RESUME and reach
// completed — the run-recovery path the completedRunId assertion depends on.
// Every down window + restart is recorded in the single-line summary
// (`daemon_recovery`).
//
// This test pins (zero tokens, no real daemon — hermetic temp state):
//  - the runner's recovery wiring shape (AC4: the corridor and its
//    assertions are untouched; the watchdog + recovery evidence are added),
//  - the lib module's contracts (pid-file liveness check, daemon-control
//    invocation env, bounded recovery),
//  - the recovery MECHANICS hermetically: a fake daemon-control double +
//    scratch state dir prove isDaemonUp/recoverScriptedDaemon/
//    watchScriptedDaemonLiveness detect a DOWN window, restart, and close the
//    window when the daemon is up again — and that an exhausted recovery
//    bound records the window honestly without looping forever.
// The end-to-end corridor (AC1/AC2: run-scripted-scenario W4.24 from a clean
// var with a daemon-down window mid-run -> exit 0, summary records the
// recovery + the completed run ids) is driven in the US-010 re-proof.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

// Derive the repo root from THIS module's location so the test is robust to
// the invoking cwd (run.sh cd's to the repo root; direct invocation from
// torture-test/ must still work).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ttRoot = path.join(repoRoot, "torture-test");
const runnerPath = path.join(ttRoot, "scenarios", "w4.24", "serial-lane-concurrent", "run-serial-lane-concurrent.mjs");
const libPath = path.join(ttRoot, "scenarios", "lib", "scripted-daemon-recovery.mjs");

function readSource(rel: string): string {
  return fs.readFileSync(path.join(ttRoot, rel), "utf8");
}

describe("tier2 daemon-down recovery (US-008)", () => {
  it("the W4.24 runner wires the daemon-liveness watchdog without touching the corridor assertions (AC4)", () => {
    const source = readSource("scenarios/w4.24/serial-lane-concurrent/run-serial-lane-concurrent.mjs");
    // The watchdog comes from the shared lib module.
    assert.match(source,
      /import \{ watchScriptedDaemonLiveness \} from "\.\.\/\.\.\/lib\/scripted-daemon-recovery\.mjs";/,
      "the runner must import the shared recovery watchdog");
    // The watch starts while the two TT runs are in flight (before the waits)
    // and exits once both are terminal.
    assert.match(source, /const daemonRecoveryWatch = watchScriptedDaemonLiveness\(\{/,
      "the runner must start the watchdog");
    assert.match(source, /isWorkInFlight: \(\) => t1\.status === null \|\| t2\.status === null/,
      "the watchdog must run while either TT run is still in flight");
    assert.match(source, /const daemonRecovery = await daemonRecoveryWatch;/,
      "the runner must collect the recovery evidence after the runs settle");
    // The recovery honesty pin: every recorded DOWN window must close before
    // the runs can be complete.
    assert.match(source, /every daemon-down window must recover before the runs complete/,
      "the runner must pin that every down window recovered");
    // The single-line summary records the recovery evidence (AC2).
    assert.match(source, /daemon_recovery: \{/,
      "the summary must record daemon_recovery");
    assert.match(source, /runs_completed_after_recovery/,
      "the summary must record runs_completed_after_recovery");
    assert.match(source, /worker_lost_counts/,
      "the summary must record the per-run worker_lost_counts across a daemon-down window");
    // The corridor assertions are UNCHANGED: the runs must complete
    // (exit 0 + status completed) — nothing weakened.
    assert.match(source, /assert\.equal\(handle\.status, 0,/,
      "completedRunId must still assert the wait CLI exit 0");
    assert.match(source, /assert\.equal\(record\.status, "completed",/,
      "completedRunId must still assert the run status completed");
    // The worker_lost_count check is conditional on a daemon-down window:
    // without one the strict 0 holds (the no-cross-talk contract); across a
    // window the loss IS the recovery mechanism (the dead daemon's claimed
    // step is recovered by the product's dead-worker sweep on restart), so
    // the count is recorded as evidence instead of failing the corridor.
    assert.match(source,
      /if \(daemonRecovery\.downWindows\.length === 0\) \{\s*assert\.equal\(rows\[0\]\.worker_lost_count, 0,/s,
      "without a daemon-down window the strict worker_lost_count === 0 assertion must hold unchanged");
    assert.match(source,
      /worker_lost_count must be a non-negative integer/,
      "across a daemon-down window the worker_lost_count must be validated as a non-negative integer, never silently dropped");
  });

  it("the lib module pins the pid-file liveness check and the daemon-control restart env contract", () => {
    const lib = readSource("scenarios/lib/scripted-daemon-recovery.mjs");
    // isDaemonUp: pid file + signal-0 — the SAME check the product's wait
    // uses for its "daemon is down" warning.
    assert.match(lib, /function isDaemonUp\(stateDir\)/,
      "lib must export the daemon liveness check");
    assert.match(lib, /tamandua\.pid/, "liveness must read the daemon pid file");
    assert.match(lib, /process\.kill\(pid, 0\)/,
      "liveness must signal-0 the daemon pid");
    // recoverScriptedDaemon: the ONLY sanctioned starter (daemon-control
    // scripted start) with the harness env contract (operator HOME + PATH
    // prefixed with <repoRoot>/bin so `tamandua` resolves inside the scope).
    assert.match(lib, /recoverScriptedDaemon\(\{/,
      "lib must export the recovery restart");
    assert.match(lib, /daemonControlPath, \["scripted", "start"\]/,
      "recovery must invoke daemon-control scripted start");
    assert.match(lib, /HOME: accountHome/,
      "recovery must run daemon-control under the operator account home (the harness wrapper contract)");
    assert.match(lib, /path\.join\(repoRoot, "bin"\)/,
      "recovery must put <repoRoot>/bin on PATH for the daemon-control spawn");
    // The watchdog: bounded recovery + honest down-window records.
    assert.match(lib, /maxRecoveries = 3/,
      "the watchdog must bound recovery restarts");
    assert.match(lib, /detectedAt/,
      "each down window must record when it was detected");
    assert.match(lib, /restartAttempted/, "each down window must record whether a restart was attempted");
    assert.match(lib, /restartOk/, "each down window must record whether the restart succeeded");
    assert.match(lib, /recovered/, "each down window must record when the daemon came back");
  });

  it("hermetic recovery mechanics: isDaemonUp + recoverScriptedDaemon against a fake daemon-control double", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w424-rec-"));
    try {
      const stateDir = path.join(scratch, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const double = path.join(scratch, "fake-daemon-control");
      const pidFile = path.join(stateDir, "tamandua.pid");

      // isDaemonUp: no pid file -> down.
      assert.equal(fs.existsSync(pidFile), false, "scratch state must start without a pid file");
      const { isDaemonUp } = await import(pathToFileURL(libPath).href);
      assert.equal(isDaemonUp(stateDir), false, "no pid file must mean the daemon is down");

      // A live fake "daemon" process -> up; once it dies -> down again.
      const daemonChild = spawnDetachedFakeDaemon();
      try {
        fs.writeFileSync(pidFile, `${daemonChild.pid}\n`, "utf8");
        assert.equal(isDaemonUp(stateDir), true, "a live pid must mean the daemon is up");
        daemonChild.kill("SIGKILL");
        daemonChild.unref();
        // Give the OS a moment to reap the killed child.
        await sleep(150);
        assert.equal(isDaemonUp(stateDir), false, "a dead pid must mean the daemon is down");
      } finally {
        try { daemonChild.kill("SIGKILL"); } catch { /* already gone */ }
      }

      // recoverScriptedDaemon against a fake daemon-control double that
      // brings the daemon up: exit 0 + a live pid in the state dir.
      const failFile = path.join(scratch, "fail");
      fs.writeFileSync(double, fakeDaemonControlScript(), { mode: 0o755 });
      const { recoverScriptedDaemon } = await import(pathToFileURL(libPath).href);
      const ok = await recoverScriptedDaemon({
        stateDir,
        repoRoot,
        daemonControlPath: double,
        accountHome: os.homedir(),
        env: { ...process.env, DOUBLE_STATE_DIR: stateDir, DOUBLE_FAIL_FILE: "" },
        upTimeoutMs: 5000,
      });
      assert.equal(ok.ok, true, `fake start must recover the daemon: ${JSON.stringify(ok)}`);
      assert.equal(isDaemonUp(stateDir), true, "daemon must be up after a successful recovery");
      cleanupPid(stateDir);

      // Failure double: exits 1 -> recovery reports ok:false.
      fs.writeFileSync(failFile, "1", "utf8");
      const fail = await recoverScriptedDaemon({
        stateDir,
        repoRoot,
        daemonControlPath: double,
        accountHome: os.homedir(),
        env: { ...process.env, DOUBLE_STATE_DIR: stateDir, DOUBLE_FAIL_FILE: failFile },
        upTimeoutMs: 1000,
      });
      assert.equal(fail.ok, false, "a failing daemon-control start must report ok:false");
      assert.match(fail.error ?? "", /exited 1/, "the failure must carry the daemon-control exit code");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("hermetic watchdog loop: detects DOWN, recovers, closes the window; exhausted bound records honestly and stops", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w424-watch-"));
    try {
      const stateDir = path.join(scratch, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const double = path.join(scratch, "fake-daemon-control");
      fs.writeFileSync(double, fakeDaemonControlScript(), { mode: 0o755 });
      const failFile = path.join(scratch, "fail");
      const { watchScriptedDaemonLiveness, isDaemonUp } = await import(pathToFileURL(libPath).href);

      // Episode 1: daemon down while work is in flight; the double recovers it
      // on the first restart; the window closes and the watch exits when the
      // work finishes.
      const until1 = Date.now() + 3000;
      const result = await watchScriptedDaemonLiveness({
        stateDir,
        repoRoot,
        daemonControlPath: double,
        accountHome: os.homedir(),
        env: { ...process.env, DOUBLE_STATE_DIR: stateDir, DOUBLE_FAIL_FILE: "" },
        isWorkInFlight: () => Date.now() < until1,
        maxRecoveries: 2,
        pollMs: 100,
        retryBackoffMs: 200,
        upTimeoutMs: 5000,
      });
      assert.equal(result.downWindows.length, 1, "one DOWN episode must be recorded");
      const window = result.downWindows[0];
      assert.equal(window.restartAttempted, true, "the window must have attempted a restart");
      assert.equal(window.restartOk, true, "the restart must have succeeded");
      assert.equal(window.recovered, true, "the window must close recovered");
      assert.ok(window.recoveredAt, "the window must record when the daemon came back");
      assert.equal(result.recoveries, 1, "one recovery restart for one window");
      assert.equal(isDaemonUp(stateDir), true, "daemon must be up at watch exit");
      cleanupPid(stateDir);

      // Episode 2: the double ALWAYS fails; the recovery bound (2) is
      // exhausted and the window stays honestly unrecovered — no infinite
      // loop (the watch exits when the work is done).
      fs.writeFileSync(failFile, "1", "utf8");
      const until2 = Date.now() + 3500;
      const exhausted = await watchScriptedDaemonLiveness({
        stateDir,
        repoRoot,
        daemonControlPath: double,
        accountHome: os.homedir(),
        env: { ...process.env, DOUBLE_STATE_DIR: stateDir, DOUBLE_FAIL_FILE: failFile },
        isWorkInFlight: () => Date.now() < until2,
        maxRecoveries: 2,
        pollMs: 100,
        retryBackoffMs: 200,
        upTimeoutMs: 1000,
      });
      assert.equal(exhausted.recoveries, 2, "the recovery bound must be consumed exactly");
      assert.equal(exhausted.downWindows.length, 1, "one DOWN episode across the exhausted attempts");
      assert.equal(exhausted.downWindows[0].restartAttempted, true);
      assert.equal(exhausted.downWindows[0].restartOk, false);
      assert.equal(exhausted.downWindows[0].recovered, false,
        "an exhausted recovery must leave the window honestly unrecovered");
      assert.equal(isDaemonUp(stateDir), false, "daemon must still be down after exhausted recovery");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// The fake daemon-control double: `scripted start` spawns a long-lived fake
// daemon process and records its pid into the state dir's tamandua.pid (the
// file isDaemonUp reads). When DOUBLE_FAIL_FILE is set to a non-empty path,
// it exits 1 without bringing anything up.
function fakeDaemonControlScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "scripted" ] && [ "\${2:-}" = "start" ]; then
  if [ -n "\${DOUBLE_FAIL_FILE:-}" ] && [ -f "\${DOUBLE_FAIL_FILE}" ]; then
    echo "fake daemon-control: FAIL requested" >&2
    exit 1
  fi
  node -e "setInterval(()=>{},1000)" >/dev/null 2>&1 &
  echo $! > "\${DOUBLE_STATE_DIR:?}/tamandua.pid"
  exit 0
fi
echo "unexpected args: \$*" >&2
exit 2
`;
}

// Spawn a long-lived fake "daemon" process (kept alive until killed).
function spawnDetachedFakeDaemon() {
  const child = spawn("node", ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return child;
}

function cleanupPid(stateDir: string): void {
  const pidFile = path.join(stateDir, "tamandua.pid");
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  } catch { /* no pid file */ }
  fs.rmSync(pidFile, { force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
