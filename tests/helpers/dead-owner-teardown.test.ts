import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { terminateOwnedProcessGroup, reapStaleOrphans, decideOwnershipByIdentity } from "./dead-owner-teardown.ts";
import { getProcessStartIdentity } from "../../src/lib/process-start-identity.ts";
import { getPgid, getProcessState, listProcessDetails } from "../../dist/lib/proc-info.js";

// ── Pure ABA identity-gate decision (v2 matcher) ──────────────────────
//
// These tests need no real process and no `ps`, so they run (and are
// meaningful) even inside a seatbelt-isolated worker round where /bin/ps is
// EPERM. They pin the rule that ONLY a well-formed v2 'same' comparison
// proves ownership and that BOTH a v2 mismatch and an unknown/legacy
// persisted value refuse — the latter never by silent string comparison.
describe("decideOwnershipByIdentity — v2 matcher, legacy refusal", () => {
  it("proves ownership only for a well-formed v2 match", () => {
    const decision = decideOwnershipByIdentity("v2:4242:1700000000000", "v2:4242:1700000000000");
    assert.equal(decision.proven, true);
    assert.equal(decision.verdict, "same");
    assert.match(decision.reason, /v2 identity match/);
  });

  it("proves ownership for a v2 match within the documented tolerance", () => {
    const decision = decideOwnershipByIdentity("v2:4242:1700000000000", "v2:4242:1700000000400");
    assert.equal(decision.proven, true);
    assert.equal(decision.verdict, "same");
  });

  it("refuses a v2 mismatch beyond tolerance (PID reuse) with a mismatch reason", () => {
    const decision = decideOwnershipByIdentity("v2:4242:1700000000000", "v2:4242:1900000000000");
    assert.equal(decision.proven, false);
    assert.equal(decision.verdict, "different");
    assert.match(decision.reason, /mismatch/);
    assert.match(decision.reason, /PID reuse/);
  });

  it("refuses a v2 pid mismatch as a mismatch", () => {
    const decision = decideOwnershipByIdentity("v2:4242:1700000000000", "v2:4243:1700000000000");
    assert.equal(decision.proven, false);
    assert.equal(decision.verdict, "different");
  });

  it("refuses a persisted legacy ps: value with an unknown-format reason", () => {
    const decision = decideOwnershipByIdentity(
      "ps:Sun Sep  6 00:26:59 2026",
      "v2:4242:1700000000000",
    );
    assert.equal(decision.proven, false);
    assert.equal(decision.verdict, "unknown");
    assert.match(decision.reason, /unknown\/legacy identity format/);
    assert.match(decision.reason, /never proven/);
  });

  it("refuses a persisted legacy proc: value with an unknown-format reason", () => {
    const decision = decideOwnershipByIdentity("proc:442043503", "v2:4242:1700000000000");
    assert.equal(decision.proven, false);
    assert.equal(decision.verdict, "unknown");
    assert.match(decision.reason, /legacy ps:\/proc:/);
  });

  it("refuses a non-comparable v2u: value", () => {
    const decision = decideOwnershipByIdentity("v2u:4242", "v2u:4242");
    assert.equal(decision.proven, false);
    assert.equal(decision.verdict, "unknown");
  });

  it("refuses malformed, empty and missing values", () => {
    for (const [expected, current] of [
      ["v2:4242:not-a-number", "v2:4242:1700000000000"],
      ["", "v2:4242:1700000000000"],
      [undefined, "v2:4242:1700000000000"],
      ["v2:4242:1700000000000", null],
      [null, null],
    ] as Array<[string | null | undefined, string | null | undefined]>) {
      const decision = decideOwnershipByIdentity(expected, current);
      assert.equal(decision.proven, false, `expected=${String(expected)} current=${String(current)}`);
      assert.equal(decision.verdict, "unknown");
    }
  });
});

describe("terminateOwnedProcessGroup", { concurrency: 1 }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), "dead-owner-teardown-test-"));
  const ownedChildren: ChildProcess[] = [];

  function uniqueMarker(): string {
    return `dead-owner-marker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /**
   * Spawn a detached shell loop with a unique ownership marker, write its
   * pgid to a file, and return the pgid and marker.
   *
   * The script just runs the loop; the group id is written by the test from
   * the SPAWN HANDLE after `detached: true` made `child.pid` the leader of a
   * new process group.
   *
   * Why not `$$` from the script: on Linux `/bin/sh` (dash) forks a nested
   * shell to run `/bin/sh -c <script>`, so the script's `$$` is that nested
   * shell's pid — a group MEMBER, not the group id. Recording it makes
   * `terminateOwnedProcessGroup`'s ownership scan look for a process group
   * that does not exist, so ownership is never proven and teardown silently
   * no-ops. `child.pid` is the kernel's true group id for every member.
   */
  function spawnDetachedSuite(
    pgidFile: string,
    marker: string,
  ): { pgid: number; child: ChildProcess } {
    const script = join(tempDir, `suite-${marker}.sh`);
    // The marker is embedded in the script path and passed as a literal
    // argument so the process table can see it. Using a unique marker dir
    // suffices.
    writeFileSync(
      script,
      `#!/bin/sh
while :; do sleep 0.1; done
`,
      { mode: 0o755 },
    );

    const child = spawn("/bin/sh", ["-c", script], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    });
    child.unref();
    ownedChildren.push(child);
    // Record the TRUE process-group id from the spawn handle — see the
    // function doc for why the script's `$$` is wrong on Linux.
    const pgid = child.pid!;
    writeFileSync(pgidFile, String(pgid));
    writeFileSync(`${pgidFile}.pid`, String(pgid));
    // Do NOT return until the kernel process table proves ownership: the
    // spawn handle names the group immediately, but its argv still shows the
    // parent until exec(), so an immediate teardown would (correctly) refuse.
    waitForOwnedGroupReady(pgid, marker);
    return { pgid, child };
  }

  /**
   * Spawn a detached suite whose recorded pgid file deliberately holds the
   * NESTED shell's pid (`$$`), NOT the process-group leader.
   *
   * On Linux `/bin/sh` (dash) forks a nested shell to run
   * `/bin/sh -c <script>`, so the script's `$$` is a group MEMBER pid while
   * `child.pid` (with `detached: true`) is the group leader. Recording the
   * member pid used to make `terminateOwnedProcessGroup`'s ownership scan
   * look for a process group that does not exist, so ownership was never
   * proven and teardown silently no-oped. This helper pins the kernel
   * `getPgid()` resolution that makes the member pid work again.
   */
  function spawnDetachedNestedShellSuite(
    pgidFile: string,
    marker: string,
  ): { leaderPgid: number; memberPid: number; child: ChildProcess } {
    const script = join(tempDir, `nested-${marker}.sh`);
    const memberFile = `${pgidFile}.member`;
    // The marker is embedded in the script path, so it is visible in the
    // group members' command lines (the ownership-scan evidence).
    writeFileSync(
      script,
      `#!/bin/sh
echo $$ > ${memberFile}
while :; do sleep 0.1; done
`,
      { mode: 0o755 },
    );

    const child = spawn("/bin/sh", ["-c", script], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    });
    child.unref();
    ownedChildren.push(child);
    const leaderPgid = child.pid!;
    // As in spawnDetachedSuite: wait until the marker is visible in the
    // group's argv before any teardown can run (fork→exec race).
    waitForOwnedGroupReady(leaderPgid, marker);
    const memberPid = readIntegerFileWhenReady(memberFile);
    // Record the MEMBER pid ON PURPOSE (the regression scenario).
    writeFileSync(pgidFile, String(memberPid));
    return { leaderPgid, memberPid, child };
  }

  /**
   * Poll until the file exists and contains a valid positive integer.
   * Throws after deadlineMs.
   */
  function readIntegerFileWhenReady(file: string, deadlineMs = 5000): number {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf-8").trim();
        if (/^[1-9][0-9]*$/.test(raw)) {
          return Number(raw);
        }
      }
      // Busy-wait briefly
      const end = Date.now() + 50;
      while (Date.now() < end) { /* spin */ }
    }
    throw new Error(`${file} was not written within ${deadlineMs}ms`);
  }

  /**
   * Poll until the pgid file exists and contains a valid positive integer.
   * Throws after deadlineMs.
   */
  function readPgidWhenReady(pgidFile: string, deadlineMs = 5000): number {
    return readIntegerFileWhenReady(pgidFile, deadlineMs);
  }

  /**
   * True when the kernel process table shows a member of `pgid` whose command
   * line carries `marker` — the exact evidence `terminateOwnedProcessGroup`
   * requires before it will signal.
   */
  function processTableHasOwnedMember(pgid: number, marker: string): boolean {
    try {
      for (const detail of listProcessDetails()) {
        if (detail.pgid !== pgid) continue;
        if (detail.cmdline.includes(marker)) return true;
      }
    } catch {
      // Process table temporarily unavailable — keep polling to the deadline.
    }
    return false;
  }

  /**
   * Bounded wait until the freshly spawned group is actually OWNED by the
   * marker: a member process (pgid match) whose argv contains the marker.
   *
   * `spawn()` returns as soon as the child is forked; between fork() and
   * exec() the child still carries the PARENT's Node argv, which does not
   * contain the per-test marker. A teardown issued in that window finds no
   * owned member, refuses to signal (correctly — it must not kill unproven
   * groups), and the "suite must be dead" assertion fails. Polling the
   * process table until ownership is visible is deterministic and uses the
   * same 5000 ms deadline as the pid-file readers instead of a fixed sleep.
   *
   * Throws (rather than silently proceeding) when the deadline passes: an
   * unowned group is a broken fixture, not a teardown scenario to exercise.
   */
  function waitForOwnedGroupReady(pgid: number, marker: string, deadlineMs = 5000): void {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (processTableHasOwnedMember(pgid, marker)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `process group ${pgid} did not expose ownership marker ${marker} within ${deadlineMs}ms`,
        );
      }
      spinWait(25);
    }
  }

  /**
   * Bounded wait for a pid to be truly dead (kernel state not Z/X and gone).
   * SIGKILL delivery is not assumed synchronous; the teardown helper returns
   * as soon as it has signalled, so assertions poll instead of racing.
   */
  function waitUntilDead(pid: number, deadlineMs = 5000): void {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return;
      spinWait(25);
    }
  }

  /**
   * Check if a pid references a live (non-zombie) process.
   *
   * Uses the kernel process state (procfs on Linux, the sandbox-safe native
   * helper on macOS), which correctly reports Z (zombie) and X (dead) states
   * on all platforms, avoiding the signal-0 trap (process.kill(pid, 0)
   * succeeds for zombies).
   */
  function isAlive(pid: number): boolean {
    const state = getProcessState(pid);
    if (state === null) return false;
    return state !== "Z" && state !== "X";
  }

  function spinWait(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait */ }
  }

  after(() => {
    // Reap all test-owned children
    for (const child of ownedChildren) {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* */ }
      try { child.kill("SIGKILL"); } catch { /* */ }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Edge cases: no-op scenarios ──

  it("is a no-op when the pgid file does not exist", () => {
    const nonExistent = join(tempDir, "does-not-exist.pid");
    // Must not throw
    terminateOwnedProcessGroup({ pgidFile: nonExistent, ownershipMarker: "anything" });
  });

  it("is a no-op when the pgid file is empty", () => {
    const emptyFile = join(tempDir, "empty.pid");
    writeFileSync(emptyFile, "");
    terminateOwnedProcessGroup({ pgidFile: emptyFile, ownershipMarker: "anything" });
    // Must not throw
  });

  it("is a no-op when the pgid file contains a non-integer", () => {
    const junkFile = join(tempDir, "junk.pid");
    writeFileSync(junkFile, "not-a-pid");
    terminateOwnedProcessGroup({ pgidFile: junkFile, ownershipMarker: "anything" });
  });

  it("is a no-op when the pgid file contains a negative number", () => {
    const negFile = join(tempDir, "neg.pid");
    writeFileSync(negFile, "-42");
    terminateOwnedProcessGroup({ pgidFile: negFile, ownershipMarker: "anything" });
  });

  it("is a no-op when the pgid file contains zero", () => {
    const zeroFile = join(tempDir, "zero.pid");
    writeFileSync(zeroFile, "0");
    terminateOwnedProcessGroup({ pgidFile: zeroFile, ownershipMarker: "anything" });
  });

  it("is a no-op for a non-existent PID in the pgid file", () => {
    const staleFile = join(tempDir, "stale.pid");
    writeFileSync(staleFile, "99999999");
    // Must not throw — ps returns empty output
    terminateOwnedProcessGroup({ pgidFile: staleFile, ownershipMarker: "anything" });
  });

  // ── Ownership validation ──

  it("records a pgidFile whose value the kernel resolves to the suite's process group", () => {
    const marker = uniqueMarker();
    const pgidFile = join(tempDir, `pgid-source-${marker}.pid`);
    const { pgid } = spawnDetachedSuite(pgidFile, marker);
    const recorded = readPgidWhenReady(pgidFile);

    assert.equal(recorded, pgid, "recorded value must be the spawn-handle group leader");
    assert.equal(
      getPgid(recorded),
      recorded,
      "kernel getPgid must confirm the recorded value names the live process group",
    );

    // The pid file must carry the same leader pid (the ABA identity pid).
    const pidFromFile = Number(readFileSync(`${pgidFile}.pid`, "utf-8").trim());
    assert.equal(pidFromFile, pgid);

    try { process.kill(-pgid, "SIGKILL"); } catch { /* */ }
  });

  it("resolves a recorded group-member pid to the kernel process group and tears the group down", () => {
    const marker = uniqueMarker();
    const pgidFile = join(tempDir, `nested-member-${marker}.pid`);
    const { leaderPgid, memberPid } = spawnDetachedNestedShellSuite(pgidFile, marker);

    assert.ok(isAlive(leaderPgid), "suite leader should be alive before teardown");
    assert.ok(isAlive(memberPid), "nested shell member should be alive before teardown");

    // The recorded value is a group MEMBER pid, not the group id — exactly the
    // Linux `/bin/sh -c <script>` (dash) `$$` case. The kernel must map it back
    // to the process group before the ownership scan runs.
    const recorded = readPgidWhenReady(pgidFile);
    assert.equal(recorded, memberPid, "pgidFile must hold the nested-shell member pid");
    assert.equal(
      getPgid(memberPid),
      leaderPgid,
      "kernel getPgid must resolve the member pid to the suite's process group",
    );

    terminateOwnedProcessGroup({ pgidFile, ownershipMarker: marker, graceMs: 500 });

    waitUntilDead(leaderPgid);
    waitUntilDead(memberPid);
    assert.ok(!isAlive(leaderPgid), "whole group must be torn down from a recorded member pid");
    assert.ok(!isAlive(memberPid), "nested shell member must be torn down");
  });

  it("does NOT signal a process whose args lack the ownership marker", () => {
    const marker = uniqueMarker();
    const pgidFile = join(tempDir, `unowned-${marker}.pid`);
    const { pgid } = spawnDetachedSuite(pgidFile, marker);
    readPgidWhenReady(pgidFile);
    assert.ok(isAlive(pgid), "suite should be alive before teardown");

    // Use a WRONG marker — the helper must NOT signal
    terminateOwnedProcessGroup({ pgidFile, ownershipMarker: `WRONG-MARKER-${marker}` });

    // Process must still be alive
    assert.ok(isAlive(pgid), "suite must still be alive when ownership is not proven");

    // Cleanup
    try { process.kill(-pgid, "SIGKILL"); } catch { /* */ }
  });

  // ── Full teardown: ownership proven ──

  it("terminates a proven process group with TERM then KILL", () => {
    const marker = uniqueMarker();
    const pgidFile = join(tempDir, `owned-${marker}.pid`);
    const { pgid } = spawnDetachedSuite(pgidFile, marker);
    readPgidWhenReady(pgidFile);
    assert.ok(isAlive(pgid), "suite should be alive before teardown");

    terminateOwnedProcessGroup({ pgidFile, ownershipMarker: marker, graceMs: 500 });

    // After teardown, the process group should be dead
    waitUntilDead(pgid);
    assert.ok(!isAlive(pgid), "suite must be dead after ownership-scoped teardown");
  });

  // ── ESRCH tolerance: double teardown ──

  it("tolerates ESRCH when the group is already gone (idempotent)", () => {
    const marker = uniqueMarker();
    const pgidFile = join(tempDir, `double-teardown-${marker}.pid`);
    const { pgid } = spawnDetachedSuite(pgidFile, marker);
    readPgidWhenReady(pgidFile);

    // First teardown kills
    terminateOwnedProcessGroup({ pgidFile, ownershipMarker: marker, graceMs: 500 });
    // SIGKILL delivery is not assumed synchronous: poll the kernel state
    // (bounded) instead of racing the assertion against process reaping.
    waitUntilDead(pgid);
    assert.ok(!isAlive(pgid), "suite must be dead after first teardown");

    // Second teardown must not throw (ESRCH tolerance)
    terminateOwnedProcessGroup({ pgidFile, ownershipMarker: marker, graceMs: 0 });
    // No exception = pass
  });

  it("tolerates EPERM when the group signal is refused (Darwin killpg semantics)", () => {
    const marker = uniqueMarker();
    const pgidFile = join(tempDir, `eperm-${marker}.pid`);
    const { pgid } = spawnDetachedSuite(pgidFile, marker);
    readPgidWhenReady(pgidFile);
    assert.ok(isAlive(pgid), "suite should be alive before teardown");

    // Stub process.kill to simulate Darwin/BSD killpg semantics: a group
    // signal raises EPERM when ANY member of the group is unsignalable.
    // signalProcessGroup must tolerate it and fall through to the helper's
    // per-pid fallbacks (marker-scan + direct kills, all blanket
    // try/catch'd), so terminateOwnedProcessGroup must not throw.
    const originalKill = process.kill;
    const epermError = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    process.kill = (() => {
      throw epermError;
    }) as typeof process.kill;
    try {
      terminateOwnedProcessGroup({ pgidFile, ownershipMarker: marker, graceMs: 0 });
    } finally {
      process.kill = originalKill;
    }
    // No exception = pass

    // The mocked kill was a no-op, so the suite is still alive — clean up.
    try { process.kill(-pgid, "SIGKILL"); } catch { /* */ }
  });

  // ── Unrelated process preservation ──

  it("does not kill unrelated processes", () => {
    const marker = uniqueMarker();
    const pgidFile = join(tempDir, `safe-${marker}.pid`);
    const { pgid: suitePgid } = spawnDetachedSuite(pgidFile, marker);
    readPgidWhenReady(pgidFile);

    // Spawn a SECOND unrelated process that is alive
    const unrelatedChild = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    unrelatedChild.unref();
    ownedChildren.push(unrelatedChild);
    const unrelatedPid = unrelatedChild.pid!;
    assert.ok(isAlive(unrelatedPid), "unrelated process should be alive");

    // Write the suite's pgid, but use a WRONG marker — teardown must not signal
    terminateOwnedProcessGroup({ pgidFile, ownershipMarker: `WRONG-MARKER-${marker}`, graceMs: 0 });

    // Unrelated process must still be alive
    assert.ok(isAlive(unrelatedPid), "unrelated process must NOT be killed");

    // Now prove ownership and tear down
    terminateOwnedProcessGroup({ pgidFile, ownershipMarker: marker, graceMs: 500 });
    waitUntilDead(suitePgid);
    assert.ok(!isAlive(suitePgid), "suite must be dead");
    assert.ok(isAlive(unrelatedPid), "unrelated process must still be alive after suite teardown");

    // Cleanup unrelated
    try { process.kill(-unrelatedPid, "SIGKILL"); } catch { /* */ }
  });

  // ── ABA-safe PID ownership verification ──

  it("terminates a process group when pid + startTime match (ABA protection passes)", () => {
    const marker = uniqueMarker();
    const pgidFile = join(tempDir, `aba-valid-${marker}.pid`);
    const { pgid } = spawnDetachedSuite(pgidFile, marker);
    readPgidWhenReady(pgidFile);
    assert.ok(isAlive(pgid), "suite should be alive before teardown");

    // Read the PID from the .pid file and compute the start identity
    const pidFile = `${pgidFile}.pid`;
    assert.ok(existsSync(pidFile), "pid file must exist");
    const suitePid = Number(readFileSync(pidFile, "utf-8").trim());
    const startIdentity = getProcessStartIdentity(suitePid);
    assert.ok(startIdentity !== null, "process start identity must be computable");

    terminateOwnedProcessGroup({
      pgidFile,
      pid: suitePid,
      startTime: startIdentity!,
      ownershipMarker: marker,
      graceMs: 500,
    });

    // Suite must be dead
    waitUntilDead(pgid);
    assert.ok(!isAlive(pgid), "suite must be dead when ABA identity matches");
  });

  it("refuses to signal when pid is provided but startTime does not match (PID reused)", () => {
    const marker = uniqueMarker();
    const pgidFile = join(tempDir, `aba-mismatch-${marker}.pid`);
    const { pgid } = spawnDetachedSuite(pgidFile, marker);
    readPgidWhenReady(pgidFile);
    assert.ok(isAlive(pgid), "suite should be alive before teardown");

    // Provide a well-formed v2 value for the SAME pid whose start epoch is
    // far beyond the documented tolerance — a stale/earlier incarnation.
    terminateOwnedProcessGroup({
      pgidFile,
      pid: pgid,
      startTime: `v2:${pgid}:1`,
      ownershipMarker: marker,
      graceMs: 500,
    });

    // Suite must still be alive — ABA protection blocked the kill
    assert.ok(isAlive(pgid), "suite must still be alive when ABA identity mismatches");

    // Cleanup
    try { process.kill(-pgid, "SIGKILL"); } catch { /* */ }
  });

  // ── Fallback marker-scan kill ──

  it("marker-scan fallback kills survivors that the pgid-targeted kill misses", () => {
    // Spawn a detached process whose args contain the marker but that is
    // NOT in the recorded pgid — the marker-scan fallback should catch it.
    const marker = uniqueMarker();
    const pgidFile = join(tempDir, `marker-scan-${marker}.pid`);

    // Spawn a suite normally (records its pgid + pid)
    const { pgid: suitePgid } = spawnDetachedSuite(pgidFile, marker);
    readPgidWhenReady(pgidFile);
    assert.ok(isAlive(suitePgid), "suite should be alive before teardown");

    // Also spawn a SECOND detached process with the SAME marker but in a
    // DIFFERENT process group. This simulates what happens when the
    // fixture spawns a child that escapes the parent's pgid.
    const strayScript = join(tempDir, `stray-${marker}.sh`);
    writeFileSync(
      strayScript,
      `#!/bin/sh\n# marker: ${marker}\nwhile :; do sleep 0.1; done\n`,
      { mode: 0o755 },
    );
    const strayChild = spawn("/bin/sh", ["-c", strayScript], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    });
    strayChild.unref();
    ownedChildren.push(strayChild);
    const strayPid = strayChild.pid!;
    // Wait for stray to start
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (isAlive(strayPid)) break;
      spinWait(50);
    }
    assert.ok(isAlive(strayPid), "stray process should be alive before teardown");

    // The pgid-targeted kill handles the main suite; the marker-scan
    // fallback should catch the stray.
    terminateOwnedProcessGroup({
      pgidFile,
      ownershipMarker: marker,
      graceMs: 500,
    });

    // Both main suite AND stray must be dead
    waitUntilDead(suitePgid);
    waitUntilDead(strayPid);
    assert.ok(!isAlive(suitePgid), "main suite must be dead");
    assert.ok(!isAlive(strayPid), "stray process must be dead after marker-scan fallback");
  });

  // ── reapStaleOrphans ──

  it("reapStaleOrphans kills a live process and logs it", () => {
    // Spawn a detached process we can reap
    const marker = uniqueMarker();
    const script = join(tempDir, `reap-test-${marker}.sh`);
    writeFileSync(
      script,
      `#!/bin/sh\nwhile :; do sleep 0.1; done\n`,
      { mode: 0o755 },
    );
    const child = spawn("/bin/sh", ["-c", script], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    });
    child.unref();
    ownedChildren.push(child);
    const pid = child.pid!;

    // Wait for it to start
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (isAlive(pid)) break;
      spinWait(50);
    }
    assert.ok(isAlive(pid), "process should be alive before reap");

    // Reap it
    reapStaleOrphans([pid]);

    // Must be dead
    waitUntilDead(pid);
    assert.ok(!isAlive(pid), "process must be dead after reapStaleOrphans");
  });

  it("reapStaleOrphans is a no-op for an empty array", () => {
    // Must not throw
    reapStaleOrphans([]);
  });

  it("reapStaleOrphans tolerates non-existent PIDs", () => {
    // Must not throw for a PID that doesn't exist
    reapStaleOrphans([99999999]);
  });

  it("reapStaleOrphans tolerates a mix of alive and dead PIDs", () => {
    const marker = uniqueMarker();
    const script = join(tempDir, `reap-mix-${marker}.sh`);
    writeFileSync(
      script,
      `#!/bin/sh\nwhile :; do sleep 0.1; done\n`,
      { mode: 0o755 },
    );
    const child = spawn("/bin/sh", ["-c", script], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    });
    child.unref();
    ownedChildren.push(child);
    const alivePid = child.pid!;

    // Wait for it to start
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (isAlive(alivePid)) break;
      spinWait(50);
    }
    assert.ok(isAlive(alivePid), "process should be alive before reap");

    // Reap mix: one alive, one non-existent
    reapStaleOrphans([alivePid, 99999999]);

    // Alive one must be dead, call must not have thrown
    waitUntilDead(alivePid);
    assert.ok(!isAlive(alivePid), "alive process must be dead after reapStaleOrphans");
  });
});
