import { readFileSync } from "node:fs";
import {
  compareProcessStartIdentities,
  getProcessStartIdentity,
  type ProcessStartIdentityComparison,
} from "../../src/lib/process-start-identity.ts";
import {
  getPgid,
  getProcessState,
  listProcessDetails,
} from "../../dist/lib/proc-info.js";

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

/** Verdict of the ABA-safe identity gate, plus a human-readable reason. */
export interface OwnershipIdentityDecision {
  /** True ONLY for a well-formed v2 `'same'` comparison. */
  proven: boolean;
  /** The underlying matcher verdict (`same` | `different` | `unknown`). */
  verdict: ProcessStartIdentityComparison;
  /** Diagnostic naming the format/verdict; safe to log. */
  reason: string;
}

/**
 * Decide whether a persisted `expected` start identity proves the caller still
 * owns the process whose freshly-read identity is `current`.
 *
 * Only `'same'` (two well-formed `v2:<pid>:<startEpochMs>` values, same pid,
 * within the documented tolerance) proves ownership. `'different'` is a
 * PID-reuse refusal; `'unknown'` (legacy `ps:`/`proc:`, `v2u:`, malformed,
 * empty, or missing on either side) is a format refusal. Both refusals name
 * the format so a log reader can tell them apart.
 */
export function decideOwnershipByIdentity(
  expected: string | null | undefined,
  current: string | null | undefined,
): OwnershipIdentityDecision {
  const verdict = compareProcessStartIdentities(expected, current);
  if (verdict === "same") {
    return {
      proven: true,
      verdict,
      reason: `v2 identity match (expected=${String(expected)} current=${String(current)})`,
    };
  }
  if (verdict === "different") {
    return {
      proven: false,
      verdict,
      reason:
        `v2 identity mismatch (possible PID reuse): expected=${String(expected)} ` +
        `current=${String(current)}`,
    };
  }
  return {
    proven: false,
    verdict,
    reason:
      `unknown/legacy identity format: expected=${String(expected)} current=${String(current)} ` +
      `— only well-formed v2 values are comparable; legacy ps:/proc: and v2u: ` +
      `values are never proven and are never signalled on`,
  };
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
 * - **Recorded value is a group member pid** (e.g. the nested-shell `$$` that
 *   Linux `/bin/sh -c <script>` writes) → resolved through the kernel
 *   `getPgid()` to the real process group; a dead leader's stored group id
 *   falls back to the recorded integer
 * - **Group leader already exited** → signals work because ownership is validated via process-group membership, not a PID probe
 * - **No process in the group has the ownershipMarker** → no-op (won't kill unrelated processes)
 *
 * ## ABA-safe PID verification (v2 identity)
 *
 * When both `pid` and `startTime` are provided, the helper additionally
 * verifies the current process at that PID through
 * {@link decideOwnershipByIdentity} — i.e. the TZ-independent
 * `v2:<pid>:<startEpochMs>` matcher in src/lib/process-start-identity.ts.
 * Only a `'same'` verdict proves ownership. A `'different'` verdict (pid
 * mismatch, or a start epoch beyond the documented tolerance) refuses the
 * signal, exactly like a PID-reuse attack. An `'unknown'` verdict — a
 * persisted legacy `ps:`/`proc:` value, a non-comparable `v2u:` value, a
 * malformed/empty value, or an unavailable current identity — ALSO refuses:
 * legacy formats are never silently compared as strings, so an upgrade can
 * never reap a process it cannot prove it owns.
 *
 * See also tests/helpers/invocation-owned-cleanup.ts, which uses the same
 * matcher for its recorded-vs-current identity provenance gate.
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
  const recorded = Number(pgidStr);
  if (!Number.isSafeInteger(recorded)) {
    return;
  }

  // ── Resolve the recorded value to the kernel process group ──
  // The recorded integer is USUALLY a process-group id, but on Linux
  // `/bin/sh -c <script>` (dash) forks a nested shell, so a caller that
  // records the script's `$$` stores a group MEMBER pid. The kernel
  // getPgid() maps any live pid to the group it belongs to, so resolve first.
  // A dead leader's stored group id still works: when the recorded pid is
  // gone getPgid() returns null and we keep the recorded integer (a process
  // group can outlive its leader). This is not a safety boundary — the
  // ownership-marker scan and the ABA/identity gate below still refuse to
  // signal unless ownership is proven.
  const pgid = getPgid(recorded) ?? recorded;

  // ── Validate ownership ──
  // We query ALL processes by pgid+cmdline and look for a row whose pgid
  // matches AND whose command line contains the ownershipMarker.
  //
  // We do NOT use `ps -p <pgid>` because the session leader (pid == pgid)
  // may already be dead when the test teardown runs (the shim owner is
  // SIGKILLed first, which can kill the outer shell).  The inner shell
  // and its children survive in the same process group, so a
  // process-group query is the right scope.
  //
  // The process table comes from listProcessDetails(): procfs on Linux, the
  // sandbox-safe native sysctl helper on macOS (ps is EPERM inside the
  // Seatbelt signal profile), and ps only as a last resort.
  let ownershipProven = false;
  try {
    for (const detail of listProcessDetails()) {
      if (detail.pgid !== pgid) continue;
      if (detail.cmdline.includes(ownershipMarker)) {
        ownershipProven = true;
        break;
      }
    }
  } catch {
    // process table unavailable: no-op
    return;
  }

  // ── ABA-safe PID ownership verification (when pid + startTime are provided) ──
  // The startTime is a versioned, TZ-independent v2 identity. Only a 'same'
  // verdict proves ownership; a 'different' verdict (PID reuse) AND an
  // 'unknown' verdict (legacy ps:/proc:, v2u:, malformed, empty, or an
  // unreadable current identity) both refuse to signal. A legacy persisted
  // value must never be compared as a string — an upgrade cannot reap a
  // process it cannot prove it owns.
  if (ownershipProven && opts.pid !== undefined && opts.startTime !== undefined) {
    const currentIdentity = getProcessStartIdentity(opts.pid);
    const decision = decideOwnershipByIdentity(opts.startTime, currentIdentity);
    if (!decision.proven) {
      console.warn(
        `[dead-owner-teardown] Ownership not proven via process-start-identity ` +
        `(verdict=${decision.verdict}): ${decision.reason} — refusing to signal`,
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
 * Uses the sandbox-safe process table (`listProcessDetails()`) instead of
 * `ps -g <pgid>`, which selects by session ID on Linux and would miss
 * process-group members after the session leader exits.
 */
function processGroupHasLiveMembers(pgid: number): boolean {
  try {
    for (const detail of listProcessDetails()) {
      if (detail.pgid !== pgid) continue;
      // State codes: Z = zombie, X = dead. Any other state is live.
      const state = detail.state[0];
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
 * Best-effort reap of any surviving processes whose command line contains the
 * ownership marker, regardless of process group.  This catches orphans
 * that the pgid-targeted kill missed due to pgid/session asymmetry (C2.2).
 *
 * Strategy: TERM → 500ms grace with liveness check → KILL, per pid.
 */
function reapMarkerSurvivors(marker: string): void {
  const survivorPids: number[] = [];
  try {
    for (const detail of listProcessDetails()) {
      if (detail.cmdline.includes(marker)) survivorPids.push(detail.pid);
    }
  } catch {
    return;
  }
  if (survivorPids.length === 0) return;

  for (const pid of survivorPids) {
    // TERM → 500ms grace → KILL
    try { process.kill(pid, "SIGTERM"); } catch { /* */ }
  }
  {
    // Short grace window with zombie-aware liveness check.
    // process.kill(pid, 0) returns success for zombies, so we use the
    // kernel state instead to detect true liveness.
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
 * Uses the kernel state (procfs or the sandbox-safe native helper) instead of
 * signal-0 because signal-0 succeeds for zombies.
 */
function isProcessAlive(pid: number): boolean {
  const state = getProcessState(pid);
  if (state === null) return false;
  return state !== "Z" && state !== "X";
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
