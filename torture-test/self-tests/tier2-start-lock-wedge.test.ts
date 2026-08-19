// US-006 (T2.1) — W4.12-port-squatter bootstrap wedge: an orphaned
// daemon-start.lock must never fail the next scripted daemon start.
//
// Campaign evidence (operator run on merged main): W4.12-port-squatter exits
// 1 in ~11s with `run-scripted-scenario: daemon-control scripted start
// failed` and NO daemon log entries — the scripted daemon never came up.
// Diagnosis from the evidence:
//  1. W4.11-sigkill-launch-matrix arm E SIGINTs the `workflow run` launch CLI
//     while the product's startDaemon holds its O_EXCL daemon-start.lock.
//     Node's default SIGINT terminates the process WITHOUT running
//     startDaemon's `finally { releaseStartLock }`, leaving a FRESH orphaned
//     lock (mtime < START_LOCK_STALE_MS = 30s).
//  2. W4.12's bootstrap (immediately after W4.11 in campaign order) runs
//     `tamandua daemon start` via daemon-control's systemd-run. acquireStartLock
//     sees the fresh lock and returns null; waitForDaemonPid polls 10s for a
//     daemon pid that never appears (W4.11's cleanup removed the pid file and
//     no new daemon starts) -> "Timed out waiting for another daemon start
//     attempt to finish." -> exit 1 -> "daemon-control scripted start failed".
//     The wedge only bites inside the 30s staleness window — W4.19 (run 12s
//     later) succeeded because the lock had gone stale.
//
// Fix (confined to torture-test/): bin/daemon-control cmd_start clears an
// orphaned `$state_dir/daemon-start.lock` before launching (clean-slate like
// its systemd scope teardown; daemon-control is the sanctioned starter and
// starts are serialized by the scenario daemon lock), and the W4.11 cell
// cleans the lock it creates (arm E + both safety nets).
//
// This test pins (zero tokens, no daemon, hermetic temp HOME):
//  - the daemon-control fix shape (AC4: no assertion weakened — this is a
//    bootstrap fix, the runner assertions are untouched),
//  - the W4.11 cell cleanup shape,
//  - the PRODUCT wedge mechanism the fix prevents: a fresh orphaned lock
//    makes `tamandua daemon start` fail with the 10s "Timed out waiting for
//    another daemon start attempt" (the exact failure daemon-control's
//    bootstrap hit) — proving the fix is necessary; the daemon-control
//    behavioral green (pre-planted lock + start succeeds) lives in
//    bin/daemon-control.test.sh, and the full corridor green (W4.11 ->
//    W4.12 campaign order from a clean var) is driven by the campaign
//    battery / US-010 re-proof.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");

function readSource(rel: string): string {
  return fs.readFileSync(path.join(ttRoot, rel), "utf8");
}

describe("tier2 start-lock wedge (US-006)", () => {
  it("daemon-control cmd_start clears an orphaned daemon-start.lock before launching", () => {
    const source = readSource("bin/daemon-control");
    // The fix lives INSIDE cmd_start (after the state dir is known) and must
    // remove the product's O_EXCL start lock from the kind's state dir.
    const cmdStart = source.slice(source.indexOf("cmd_start()"));
    assert.match(cmdStart, /rm -f -- "\$state_dir\/daemon-start\.lock"/,
      "cmd_start must remove the orphaned daemon-start.lock from the kind's state dir");
    assert.match(cmdStart, /US-006/,
      "cmd_start must document the W4.12 orphaned-lock fix (US-006)");
    // Clean-slate ordering: the lock is removed BEFORE the launch (the
    // systemd-run / nohup spawn appears later in cmd_start).
    const rmIdx = cmdStart.indexOf('rm -f -- "$state_dir/daemon-start.lock"');
    const launchIdx = cmdStart.indexOf("systemd-run");
    assert.ok(rmIdx >= 0 && launchIdx > rmIdx,
      "the lock removal must precede the launch");
  });

  it("W4.11 cell cleans the daemon-start.lock it orphans (arm E + safety nets)", () => {
    const source = readSource("scenarios/w4.11/sigkill-launch-matrix/run-sigkill-launch-matrix.mjs");
    assert.match(source, /function clearOrphanedStartLock\(\)/,
      "the W4.11 runner must define the lock cleanup helper");
    // Arm E SIGINTs the launch mid-startDaemon — the cleanup must fire right
    // after that SIGINT (before the daemon-survival assertions). The anchor is
    // arm E's own SIGINT assertion message; the clear call must follow within
    // the same block (well before arm F's separate SIGINT assertion).
    const armE = source.slice(source.indexOf("arm E: launch must die by SIGINT"));
    const clearIdx = armE.indexOf("clearOrphanedStartLock();");
    assert.ok(clearIdx >= 0 && clearIdx < 2000,
      "arm E must clear the orphaned lock immediately after its SIGINT");
    // Every safety net must also clean the lock (a mid-arm-E failure must not
    // leak the lock into the next cell).
    const exitHandler = source.slice(source.indexOf('process.on("exit"'));
    assert.match(exitHandler, /clearOrphanedStartLock\(\);/,
      "the exit safety net must clear the orphaned lock");
    const uncaught = source.slice(source.indexOf('process.on("uncaughtException"'));
    assert.match(uncaught, /clearOrphanedStartLock\(\);/,
      "the uncaughtException safety net must clear the orphaned lock");
    // The lock path is contained (under the scenario state dir).
    assert.match(source, /path\.join\(stateDir, "daemon-start\.lock"\)/,
      "the lock path must resolve under the contained state dir");
  });

  it("product mechanism (RED): a fresh orphaned lock wedges `tamandua daemon start` for 10s", () => {
    // Hermetic reproduction of what daemon-control's bootstrap hit: a FRESH
    // daemon-start.lock (mtime < 30s) in the state dir makes the product's
    // startDaemon wait 10s for a daemon pid that never appears, then fail.
    // Temp HOME/TAMANDUA_STATE_DIR keep it fully contained — with the lock
    // present startDaemon never spawns a daemon and never binds a port.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w412-lock-"));
    try {
      const stateDir = path.join(tmpHome, ".tamandua");
      fs.mkdirSync(stateDir, { recursive: true });
      const lockFile = path.join(stateDir, "daemon-start.lock");
      fs.writeFileSync(lockFile, "", { encoding: "utf8" });
      const cli = path.join(repoRoot, "bin", "tamandua");
      const startedAt = Date.now();
      const result = spawnSync(cli, ["daemon", "start"], {
        cwd: tmpHome,
        env: {
          ...process.env,
          HOME: tmpHome,
          TAMANDUA_STATE_DIR: stateDir,
          TAMANDUA_TEST_GUARD: "0",
        },
        encoding: "utf8",
        timeout: 20_000,
      });
      const elapsed = Date.now() - startedAt;
      const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      // The wedge is the 10s waitForDaemonPid timeout, then the throw.
      assert.notEqual(result.status, 0,
        `daemon start with a fresh orphaned lock must fail (got status ${result.status}): ${out}`);
      assert.match(out, /Timed out waiting for another daemon start attempt to finish/,
        `the failure must be the start-lock wedge: ${out}`);
      assert.ok(elapsed >= 8_000 && elapsed < 20_000,
        `the wedge must be the ~10s waitForDaemonPid timeout (got ${elapsed}ms)`);
      // The lock survives — daemon-control's fix removes it at the NEXT start.
      assert.ok(fs.existsSync(lockFile), "the orphaned lock must persist (daemon-control clears it)");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
