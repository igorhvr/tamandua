import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Options for {@link terminateOwnedProcessGroup}.
 */
export interface TerminateOwnedProcessGroupOptions {
  /** Path to the file containing the process-group id. */
  pgidFile: string;
  /** Unique marker string that MUST appear in the group leader's command args for ownership to be proven. */
  ownershipMarker: string;
  /** Grace window (ms) between TERM and KILL. Defaults to 2000 if not provided. */
  graceMs?: number;
}

/**
 * Safely tear down a detached process group after first proving the caller
 * owns at least one member of the group.
 *
 * ## Ownership validation
 *
 * Before signalling, the helper queries ALL processes via
 * `ps -eo pgid=,args=` and looks for any row whose pgid column matches
 * AND whose args contain the `ownershipMarker` string.
 *
 * This process-group-scoped query works even when the original session
 * leader (pid == pgid) has already exited — the inner shell and its
 * children survive in the same process group and still carry the marker
 * in their args.
 *
 * If ownership cannot be proven, the helper signals **nothing** — it will
 * never kill unrelated processes.
 *
 * ## Teardown escalation
 *
 * On proven ownership the helper escalates from TERM to KILL:
 * 1. SIGTERM to the whole process group (`process.kill(-pgid, "SIGTERM")`)
 * 2. Wait `graceMs` milliseconds (default 2000)
 * 3. SIGKILL to the whole process group (`process.kill(-pgid, "SIGKILL")`)
 *
 * Every `process.kill` call tolerates ESRCH (the group may already be gone).
 *
 * ## Edge cases
 *
 * - **pgidFile missing** → no-op (returns cleanly)
 * - **pgidFile empty** → no-op
 * - **pgidFile contains non-integer** → no-op
 * - **Group leader already exited** → signals work because ownership is validated via process-group membership, not a PID probe
 * - **No process in the group has the ownershipMarker** → no-op (won't kill unrelated processes)
 */
export function terminateOwnedProcessGroup(opts: TerminateOwnedProcessGroupOptions): void {
  const { pgidFile, ownershipMarker, graceMs = 2000 } = opts;

  // ── Read pgid from file ──
  let pgidStr: string;
  try {
    pgidStr = readFileSync(pgidFile, "utf-8").trim();
  } catch {
    // File missing: no-op
    return;
  }
  if (!/^[1-9][0-9]*$/.test(pgidStr)) {
    // Empty or non-integer: no-op
    return;
  }
  const pgid = Number(pgidStr);
  if (!Number.isSafeInteger(pgid)) {
    return;
  }

  // ── Validate ownership ──
  // We query ALL processes by pgid+args and look for a row whose pgid
  // column matches AND whose args contain the ownershipMarker.
  //
  // We do NOT use `ps -p <pgid>` because the session leader (pid == pgid)
  // may already be dead when the test teardown runs (the shim owner is
  // SIGKILLed first, which can kill the outer shell).  The inner shell
  // and its children survive in the same process group, so a
  // process-group query is the right scope.
  let psOutput: string;
  try {
    psOutput = execSync("ps -eo pgid=,args= 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // ps failed: no-op
    return;
  }

  if (psOutput.length === 0) {
    return;
  }

  // Each output row is "<pgid> <args>".  We filter to rows whose pgid
  // column matches our expected value, then check whether any of those
  // rows' args contain the ownershipMarker.
  const pgidColumnPrefix = `${pgid} `;
  let ownershipProven = false;
  for (const line of psOutput.split("\n")) {
    if (!line.startsWith(pgidColumnPrefix)) continue;
    const args = line.slice(pgidColumnPrefix.length);
    if (args.includes(ownershipMarker)) {
      ownershipProven = true;
      break;
    }
  }

  if (!ownershipProven) {
    // Ownership not proven: no-op
    return;
  }

  // ── Ownership proven: TERM → grace → KILL ──
  signalProcessGroup(pgid, "SIGTERM");

  // Synchronous grace window; give the group time to clean up after TERM.
  // We check process state (not just signal-0) because the group leader
  // can become a zombie (defunct) after SIGTERM but still respond to
  // signal 0, which would cause us to wait the full graceMs unnecessarily.
  if (graceMs > 0) {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!processGroupHasLiveMembers(pgid)) {
        // All group members are gone or defunct — stop waiting
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      spinWait(Math.min(remaining, 50));
    }
  }

  signalProcessGroup(pgid, "SIGKILL");
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // Group already gone: expected
      return;
    }
    throw err;
  }
}

/**
 * Check whether the process group has any live (non-zombie, non-dead) members.
 * Returns false if the group is empty or contains only defunct/dead processes.
 *
 * Uses `ps -eo pgid=,stat=` (portable process-group query) instead of
 * `ps -g <pgid>` which selects by session ID on Linux and would miss
 * process-group members after the session leader exits.
 */
function processGroupHasLiveMembers(pgid: number): boolean {
  try {
    const output = execSync("ps -eo pgid=,stat= 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (output.length === 0) return false;
    const pgidPrefix = `${pgid} `;
    // State codes: Z = zombie, X = dead. Any other state is live.
    for (const line of output.split("\n")) {
      if (!line.startsWith(pgidPrefix)) continue;
      const state = line[pgidPrefix.length];
      if (state !== "Z" && state !== "X" && state !== undefined) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Synchronous sleep for the given number of milliseconds. */
function spinWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait — acceptable for a sub-50ms test teardown tick.
  }
}
