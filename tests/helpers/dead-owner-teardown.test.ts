import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { terminateOwnedProcessGroup } from "./dead-owner-teardown.ts";

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
   * The script does:
   *   echo <pgid> > <pgidFile>
   *   while :; do sleep 0.1; done
   *
   * The ownership marker is baked into the script's args so it appears in
   * `ps eww` output and our helper can validate ownership.
   */
  function spawnDetachedSuite(
    pgidFile: string,
    marker: string,
  ): { pgid: number; child: ChildProcess } {
    const script = join(tempDir, `suite-${marker}.sh`);
    // The marker is embedded in the script path and passed as a literal
    // argument so `ps eww` can see it. Using a unique marker dir suffices.
    writeFileSync(
      script,
      `#!/bin/sh
pgid=$(ps -o pgid= -p $$ | tr -d ' ')
echo "$pgid" > "${pgidFile}"
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
    return { pgid: child.pid!, child };
  }

  /**
   * Poll until the pgid file exists and contains a valid positive integer.
   * Throws after deadlineMs.
   */
  function readPgidWhenReady(pgidFile: string, deadlineMs = 5000): number {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (existsSync(pgidFile)) {
        const raw = readFileSync(pgidFile, "utf-8").trim();
        if (/^[1-9][0-9]*$/.test(raw)) {
          return Number(raw);
        }
      }
      // Busy-wait briefly
      const end = Date.now() + 50;
      while (Date.now() < end) { /* spin */ }
    }
    throw new Error(`pgidFile ${pgidFile} was not written within ${deadlineMs}ms`);
  }

  /**
   * Check if a pid references a live (non-zombie) process.
   *
   * Uses `ps -p <pid> -o state=` which correctly reports Z (zombie)
   * and X (dead) states on all platforms, avoiding the signal-0 trap
   * (process.kill(pid, 0) succeeds for zombies).
   */
  function isAlive(pid: number): boolean {
    try {
      const result = execSync(`ps -p ${pid} -o state= 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (result.length === 0) return false;
      const state = result[0];
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
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
    assert.ok(!isAlive(pgid), "suite must be dead after first teardown");

    // Second teardown must not throw (ESRCH tolerance)
    terminateOwnedProcessGroup({ pgidFile, ownershipMarker: marker, graceMs: 0 });
    // No exception = pass
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
    assert.ok(!isAlive(suitePgid), "suite must be dead");
    assert.ok(isAlive(unrelatedPid), "unrelated process must still be alive after suite teardown");

    // Cleanup unrelated
    try { process.kill(-unrelatedPid, "SIGKILL"); } catch { /* */ }
  });
});
