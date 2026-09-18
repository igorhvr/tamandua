/**
 * Unit tests for the daemon survivor guard (SWEEP-SCOPE US-006).
 *
 * The guard tracks daemons a test file started and fails the file (via an
 * auto-registered `node:test` `after()` hook) when any is still alive. These
 * tests prove the detection and the clearing paths with a real, deliberately
 * left-alive child process owned by this file.
 *
 * Registered in `tests/serial-files.txt`: it imports `node:child_process` and
 * the guard helper (which reads kernel process state via the native/procfs
 * process-info helper).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  trackDaemonPid,
  untrackDaemonPid,
  clearTrackedDaemons,
  listLiveTrackedDaemons,
  assertNoTrackedDaemonsAlive,
  isDaemonPidAlive,
} from "./helpers/daemon-survivor-guard.ts";

const ownedChildren: ChildProcess[] = [];

/** Spawn a portable long-lived child (a node process that just stays idle). */
function spawnIdleChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
  });
  ownedChildren.push(child);
  assert.ok(child.pid, "child should have a pid");
  return child;
}

/** Wait for a child to actually exit (kill(pid,0) succeeds for zombies). */
function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("child did not exit in time")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

after(async () => {
  for (const child of ownedChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  clearTrackedDaemons();
});

describe("daemon survivor guard", () => {
  it("detects a deliberately kept-alive tracked daemon and clears after stop", async () => {
    clearTrackedDaemons();
    const child = spawnIdleChild();
    const pid = child.pid!;

    trackDaemonPid(pid, "unit-alive-child");
    assert.ok(isDaemonPidAlive(pid), "child should be alive while tracked");
    assert.deepEqual(
      listLiveTrackedDaemons(),
      [{ pid, label: "unit-alive-child" }],
      "the live tracked child should be listed",
    );

    // The guard must fail — the survivor is named in the message.
    assert.throws(
      () => assertNoTrackedDaemonsAlive(),
      (err: Error) =>
        err.message.includes("unit-alive-child") && err.message.includes(`pid ${pid}`),
      "assertNoTrackedDaemonsAlive must report the surviving pid and label",
    );

    // Stop by the EXACT pid and wait for the exit event before untracking.
    child.kill("SIGKILL");
    await waitForExit(child);
    untrackDaemonPid(pid);

    assert.deepEqual(listLiveTrackedDaemons(), [], "nothing should remain tracked");
    assert.doesNotThrow(
      () => assertNoTrackedDaemonsAlive(),
      "the guard must pass once the daemon is stopped and untracked",
    );
  });

  it("prunes a tracked daemon that exited on its own", async () => {
    clearTrackedDaemons();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    ownedChildren.push(child);
    const pid = child.pid!;
    trackDaemonPid(pid, "unit-exited-child");

    await waitForExit(child);

    assert.deepEqual(
      listLiveTrackedDaemons(),
      [],
      "a daemon that exited on its own must not be reported as a survivor",
    );
    assert.doesNotThrow(() => assertNoTrackedDaemonsAlive());
  });

  it("ignores invalid pids and untracking an unknown pid is a no-op", () => {
    clearTrackedDaemons();
    trackDaemonPid(0, "zero");
    trackDaemonPid(-1, "negative");
    trackDaemonPid(Number.NaN, "nan");
    trackDaemonPid(Number.POSITIVE_INFINITY, "infinity");
    assert.deepEqual(listLiveTrackedDaemons(), [], "invalid pids are never tracked");

    untrackDaemonPid(99999999);
    assert.doesNotThrow(() => assertNoTrackedDaemonsAlive());
  });

  it("tracks the same pid once (last label wins)", () => {
    clearTrackedDaemons();
    const child = spawnIdleChild();
    const pid = child.pid!;
    trackDaemonPid(pid, "first-label");
    trackDaemonPid(pid, "second-label");
    const live = listLiveTrackedDaemons();
    assert.equal(live.length, 1, "a pid is tracked at most once");
    assert.equal(live[0].label, "second-label");
    untrackDaemonPid(pid);
    child.kill("SIGKILL");
  });
});
