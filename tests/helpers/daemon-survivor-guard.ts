/**
 * Daemon survivor guard (SWEEP-SCOPE US-006, bead tamandua-6sy.77).
 *
 * A test fixture that spawns a long-lived tamandua daemon must stop it before
 * the test file finishes. A leaked test daemon is not merely a resource leak:
 * with the pre-sweep-scope ownership model an orphaned daemon still carrying an
 * inherited `TAMANDUA_RUN_ID` could run its post-grace leaked-process sweep
 * against an unrelated enclosing worktree and SIGKILL live harness rounds
 * (the run-36/run-38 CROSS-RUN KILL defect).
 *
 * Contract:
 *   - `trackDaemonPid(pid, label)` immediately after a daemon is spawned.
 *   - `untrackDaemonPid(pid)` once the daemon has been stopped (or is known
 *     to have exited), so a clean file reports nothing.
 *   - importing this module installs ONE top-level `node:test` `after()` hook
 *     that fails the file (`assertNoTrackedDaemonsAlive`) when any tracked
 *     daemon is still alive.
 *
 * Liveness uses the kernel process state (procfs / the sandbox-safe native
 * helper), which reports `Z` (zombie) and `X` (dead) states correctly — the
 * signal-0 probe alone would treat an unreaped zombie child as a survivor.
 */
import { after } from "node:test";
import { getProcessState } from "../../dist/lib/proc-info.js";

/** A daemon whose pid the fixture promised to stop before the file ended. */
export interface TrackedDaemon {
  pid: number;
  label: string;
}

/** pid -> label for every daemon a fixture has started but not yet stopped. */
const tracked = new Map<number, TrackedDaemon>();

/** True when a pid names a live, non-zombie process. */
export function isDaemonPidAlive(pid: number): boolean {
  const state = getProcessState(pid);
  if (state === null) return false;
  return state !== "Z" && state !== "X";
}

/**
 * Register a started daemon. Values that are not a positive safe integer are
 * ignored (a null/unavailable pid was never a spawnable daemon), which keeps
 * call sites free of null checks after `spawn`.
 */
export function trackDaemonPid(pid: number, label: string): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  tracked.set(pid, { pid, label });
}

/** Forget a daemon (called after it has been stopped, or when it already exited). */
export function untrackDaemonPid(pid: number): void {
  tracked.delete(pid);
}

/** Drop every tracked entry (test isolation; production callers use untrack). */
export function clearTrackedDaemons(): void {
  tracked.clear();
}

/**
 * Every tracked daemon that is still alive, in insertion order. Dead pids are
 * pruned as a side effect so a once-alive entry cannot fail the guard after it
 * has exited.
 */
export function listLiveTrackedDaemons(): TrackedDaemon[] {
  const live: TrackedDaemon[] = [];
  for (const [pid, entry] of tracked) {
    if (isDaemonPidAlive(pid)) live.push(entry);
    else tracked.delete(pid);
  }
  return live;
}

/**
 * Throw when any tracked daemon is still alive. The message names every
 * survivor so the leaking fixture is obvious in the failure output.
 */
export function assertNoTrackedDaemonsAlive(): void {
  const live = listLiveTrackedDaemons();
  if (live.length === 0) return;
  const details = live.map((d) => `pid ${d.pid} (${d.label})`).join(", ");
  throw new Error(
    `daemon survivor guard: ${live.length} daemon(s) started by this test file are still alive: ` +
      `${details}. Stop each daemon by its exact pid in teardown ` +
      `(stopIsolatedDaemon / child.kill) before the file finishes.`,
  );
}

// Register the guard hook exactly once per process. The `queueMicrotask`
// defers registration until after the ENTIRE importing module has finished
// evaluating, so a fixture's own `after()` hooks (registered in its module
// body) run FIRST — node:test runs after hooks in registration order, and a
// daemon stopped in the fixture's after hook must not trip the guard.
let hookRegistered = false;
function registerGuardHook(): void {
  if (hookRegistered) return;
  hookRegistered = true;
  queueMicrotask(() => {
    after(() => {
      assertNoTrackedDaemonsAlive();
    });
  });
}
registerGuardHook();
