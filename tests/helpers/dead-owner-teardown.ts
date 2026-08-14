import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getProcessStartIdentity } from "../../src/lib/process-start-identity.ts";

/**
 * Options for {@link terminateOwnedProcessGroup}.
 */
export interface TerminateOwnedProcessGroupOptions {
  /** Path to the file containing the process-group id. */
  pgidFile: string;
  /** Optional PID of the suite shell process for ABA-safe ownership verification. */
  pid?: number;
  /** Optional process-start-identity string for ABA-safe PID reuse protection. */
  startTime?: string;
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
 *
 * ## ABA-safe PID verification
 *
 * When both `pid` and `startTime` are provided, the helper additionally
 * verifies that the current process running at that PID has the same
 * start-time identity as when the
 * fixture was created.  If the PID was recycled between creation and
 * teardown, the identity won't match and the helper refuses to signal
 * (prevents ABA PID-reuse attacks).
 *
 * ## Fallback marker-scan kill (C2.2)
 *
 * After the pgid-targeted TERM → KILL escalation, the helper performs a
 * best-effort re-scan of ALL processes whose args contain the
 * `ownershipMarker`, regardless of process group.  Each survivor is
 * killed individually with TERM → 500ms grace → KILL.  This catches
 * orphans that the pgid-targeted kill misses due to pgid/session
 * asymmetry (class C2.2).
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
  //
  // IMPORTANT: `ps -eo pgid=` right-aligns the pgid column with leading
  // spaces (e.g. "  53666 /bin/sh..."), so we split on whitespace to get
  // the first column rather than using startsWith, which would miss
  // short pgids typical in plain-shell environments.
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

  // Each output row is "<pgid> <args>".  Split on whitespace to get the
  // pgid as the first token (avoids the leading-space padding trap).
  let ownershipProven = false;
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trimStart();
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace === -1) continue;
    const rowPidStr = trimmed.slice(0, firstSpace);
    const rowPgid = Number(rowPidStr);
    if (!Number.isSafeInteger(rowPgid) || rowPgid !== pgid) continue;
    const args = trimmed.slice(firstSpace + 1);
    if (args.includes(ownershipMarker)) {
      ownershipProven = true;
      break;
    }
  }

  // ── ABA-safe PID ownership verification (when pid + startTime are provided) ──
  // The startTime returned by getProcessStartIdentity uniquely identifies the
  // process incarnation.  If the PID was recycled between fixture creation
  // and teardown, the startTime won't match and we bail out.
  if (ownershipProven && opts.pid !== undefined && opts.startTime !== undefined) {
    const currentIdentity = getProcessStartIdentity(opts.pid);
    if (currentIdentity !== null && currentIdentity !== opts.startTime) {
      // PID was recycled — the process we'd signal is not the one the fixture
      // created.  Do NOT signal.
      console.warn(
        `[dead-owner-teardown] Ownership not proven via process-start-identity: ` +
        `pid=${opts.pid} expected=${opts.startTime} got=${currentIdentity} — refusing to signal (possible PID reuse)`,
      );
      ownershipProven = false;
    }
  }

  if (!ownershipProven) {
    // Ownership not proven: no-op
    return;
  }

  // ── Ownership proven: TERM → grace → KILL (pgid-targeted) ──
  signalProcessGroup(pgid, "SIGTERM");

  // Synchronous grace window; give the group time to clean up after TERM.
  if (graceMs > 0) {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!processGroupHasLiveMembers(pgid)) {
        // All group members are gone or defunct — stop waiting,
        // but continue to the fallback marker scan (don't return early).
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      spinWait(Math.min(remaining, 50));
    }
  }

  signalProcessGroup(pgid, "SIGKILL");

  // ── Fallback: re-scan for survivors matching the ownership marker ──
  // When the pgid-targeted kill leaves survivors (pgid/session asymmetry,
  // C2.2 class), we fall back to killing individual processes whose args
  // contain the ownership marker.  We use TERM → short grace → KILL.
  reapMarkerSurvivors(ownershipMarker);
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // Group already gone: expected
      return;
    }
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      // Darwin/BSD killpg semantics: process.kill(-pgid, sig) raises EPERM
      // when ANY member of the group is unsignalable (Linux succeeds if at
      // least one member is signalable). Tolerate it — the helper's existing
      // per-pid fallbacks (reapMarkerSurvivors marker-scan + direct pid
      // kills, already blanket try/catch'd) provide the coverage when a
      // group signal is refused.
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
    // State codes: Z = zombie, X = dead. Any other state is live.
    // Split on whitespace to avoid the ps column-padding trap (C2.2).
    for (const line of output.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const rowPgid = Number(parts[0]);
      if (rowPgid !== pgid) continue;
      const state = parts[1][0];
      if (state !== "Z" && state !== "X") return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Best-effort reap of specific PIDs (stale orphans from prior runs).
 *
 * Unlike {@link terminateOwnedProcessGroup}, this function takes raw PIDs
 * and does NOT validate ownership — it is intended for use when the
 * caller already knows these PIDs match the dead-owner signature (e.g.,
 * via a prior pgrep).
 *
 * Strategy: TERM → 200ms grace → KILL per pid.
 * Logs each pid killed via console.log so historical leaks self-heal
 * instead of accumulating silently.
 *
 * Never throws — all errors are caught and logged.
 */
export function reapStaleOrphans(pids: number[]): void {
  const alive = pids.filter((p) => isProcessAlive(p));
  if (alive.length === 0) return;

  // TERM
  for (const pid of alive) {
    try { process.kill(pid, "SIGTERM"); } catch { /* */ }
  }

  // Short grace window
  const graceDeadline = Date.now() + 200;
  while (Date.now() < graceDeadline) {
    if (alive.every((p) => !isProcessAlive(p))) break;
    spinWait(Math.min(graceDeadline - Date.now(), 50));
  }

  // KILL + log
  for (const pid of alive) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* */ }
    if (isProcessAlive(pid)) {
      console.log(`[dead-owner-teardown] Could not reap stale orphan pid=${pid}`);
    } else {
      console.log(`[dead-owner-teardown] Best-effort reaped stale orphan pid=${pid}`);
    }
  }
}

/**
 * Best-effort reap of any surviving processes whose args contain the
 * ownership marker, regardless of process group.  This catches orphans
 * that the pgid-targeted kill missed due to pgid/session asymmetry (C2.2).
 *
 * Strategy: TERM → 500ms grace with liveness check → KILL, per pid.
 */
function reapMarkerSurvivors(marker: string): void {
  let psOutput: string;
  try {
    psOutput = execSync(`ps -eo pid=,args= 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return;
  }
  if (psOutput.length === 0) return;

  const survivorPids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trimStart();
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace === -1) continue;
    const rowPidStr = trimmed.slice(0, firstSpace);
    const rowPid = Number(rowPidStr);
    if (!Number.isSafeInteger(rowPid) || rowPid <= 0) continue;
    const args = trimmed.slice(firstSpace + 1);
    if (args.includes(marker)) {
      survivorPids.push(rowPid);
    }
  }

  for (const pid of survivorPids) {
    // TERM → 500ms grace → KILL
    try { process.kill(pid, "SIGTERM"); } catch { /* */ }
  }
  if (survivorPids.length > 0) {
    // Short grace window with zombie-aware liveness check.
    // process.kill(pid, 0) returns success for zombies, so we use
    // ps state instead to detect true liveness.
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      if (survivorPids.every((p) => !isProcessAlive(p))) break;
      spinWait(Math.min(deadline - Date.now(), 50));
    }
    for (const pid of survivorPids) {
      // Best-effort KILL: also targets the process group in case the
      // survivor spawned children in its group that escaped the PID scan.
      try { process.kill(-pid, "SIGKILL"); } catch { /* */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* */ }
    }
  }
}

/**
 * Check if a pid references a live process whose state is not Z (zombie) or X (dead).
 * Uses ps state instead of signal-0 because signal-0 succeeds for zombies.
 */
function isProcessAlive(pid: number): boolean {
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
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
