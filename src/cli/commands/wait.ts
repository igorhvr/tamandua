/**
 * Workflow wait command — block until one or more runs reach terminal status.
 *
 * Usage: tamandua workflow wait <selector...> [--all] [--timeout <duration>] [--json] [--quiet]
 */

import { resolveRunSelectors } from "../../installer/run-selector.js";
import { getDb } from "../../db.js";
import { resolvePiStateDir } from "../../installer/paths.js";
import { parseDuration, readOption } from "../shared.js";
import fs from "node:fs";
import path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

interface RunState {
  runId: string;
  runNumber: number | null;
  workflowId: string;
  status: string;
  tokensSpent: number;
  createdAt: string;
  updatedAt: string;
  steps: StepCounts;
}

interface StepCounts {
  done: number;
  failed: number;
  pending: number;
  running: number;
  waiting: number;
  canceled: number;
}

interface WaitResult {
  runs: RunState[];
  timedOut: boolean;
}

// ── Constants ──────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 60_000;

const TERMINAL_STATUSES = new Set(["completed", "done", "failed", "canceled"]);

// ── Helpers ────────────────────────────────────────────────────────

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function queryRunStates(db: ReturnType<typeof getDb>, runIds: string[]): RunState[] {
  const stmt = db.prepare(
    "SELECT id, run_number, workflow_id, status, tokens_spent, created_at, updated_at FROM runs WHERE id = ?",
  );
  const stepStmt = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM steps WHERE run_id = ? GROUP BY status",
  );

  return runIds.map((runId) => {
    const row = stmt.get(runId) as {
      id: string;
      run_number: number | null;
      workflow_id: string;
      status: string;
      tokens_spent: number;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) {
      return {
        runId,
        runNumber: null,
        workflowId: "unknown",
        status: "unknown",
        tokensSpent: 0,
        createdAt: "",
        updatedAt: "",
        steps: { done: 0, failed: 0, pending: 0, running: 0, waiting: 0, canceled: 0 },
      };
    }

    const stepRows = stepStmt.all(runId) as Array<{ status: string; cnt: number }>;
    const steps: StepCounts = { done: 0, failed: 0, pending: 0, running: 0, waiting: 0, canceled: 0 };
    for (const sr of stepRows) {
      const key = sr.status as keyof StepCounts;
      if (key in steps) {
        steps[key] = sr.cnt;
      }
    }

    return {
      runId: row.id,
      runNumber: row.run_number,
      workflowId: row.workflow_id,
      status: row.status,
      tokensSpent: row.tokens_spent,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      steps,
    };
  });
}

export function stepsSummary(s: StepCounts): string {
  const total = s.done + s.failed + s.pending + s.running + s.waiting + s.canceled;
  return `${s.done}/${total} done, ${s.failed + s.running + s.pending + s.waiting} active`;
}

export function stepCountsKey(s: StepCounts): string {
  return `${s.done},${s.failed},${s.pending},${s.running},${s.waiting},${s.canceled}`;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function computeExitCode(states: RunState[], timedOut: boolean): number {
  if (timedOut) return 2;

  let hasFailed = false;
  let hasCanceled = false;

  for (const s of states) {
    if (s.status === "failed") hasFailed = true;
    if (s.status === "canceled") hasCanceled = true;
  }

  if (hasFailed) return 1;
  if (hasCanceled) return 3;
  return 0;
}

export function formatJsonOutput(result: WaitResult): string {
  return JSON.stringify({
    runs: result.runs.map((r) => ({
      runId: r.runId,
      runNumber: r.runNumber,
      workflowId: r.workflowId,
      status: r.status,
      tokensSpent: r.tokensSpent,
      durationMs: r.createdAt
        ? Date.now() - new Date(r.createdAt).getTime()
        : 0,
      steps: {
        done: r.steps.done,
        failed: r.steps.failed,
        pending: r.steps.pending,
        running: r.steps.running,
      },
    })),
    timedOut: result.timedOut,
  }) + "\n";
}

export function formatHumanOutput(result: WaitResult): string {
  return result.runs
    .map((r) => {
      const prefix = r.runNumber !== null ? `#${r.runNumber}` : r.runId.slice(0, 8);
      const duration = r.createdAt
        ? formatElapsed(Date.now() - new Date(r.createdAt).getTime())
        : "?";
      return `${prefix} ${r.runId.slice(0, 8)} ${r.workflowId} ${r.status} ${duration} ${r.tokensSpent.toLocaleString()} tokens`;
    })
    .join("\n") + "\n";
}

function isDaemonRunning(stateDir: string): boolean {
  const pidFile = path.join(stateDir, "tamandua.pid");
  try {
    if (!fs.existsSync(pidFile)) return false;
    const raw = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract positional selectors from args, skipping flag tokens.
 */
export function extractSelectors(args: string[]): string[] {
  const flagNames = new Set([
    "--all",
    "--json",
    "--quiet",
  ]);
  const selectors: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token.startsWith("--timeout=") || token === "--timeout") {
      // Skip --timeout=30s or --timeout 30s
      i += token === "--timeout" ? 2 : 1;
      continue;
    }
    if (flagNames.has(token)) {
      i++;
      continue;
    }
    selectors.push(token);
    i++;
  }
  return selectors;
}

/**
 * Set up fs.watch on per-run event files for early wake-up.
 * Returns a cleanup function.
 */
function setupEventWatchers(
  runIds: string[],
  stateDir: string,
  onWake: () => void,
): () => void {
  const eventsDir = path.join(stateDir, "events");
  const watchers: fs.FSWatcher[] = [];

  for (const runId of runIds) {
    const eventsFile = path.join(eventsDir, `${runId}.jsonl`);
    try {
      // Ensure the directory exists (file may not exist yet)
      fs.mkdirSync(eventsDir, { recursive: true });
      const watcher = fs.watch(eventsFile, { persistent: false }, (eventType) => {
        if (eventType === "change" || eventType === "rename") {
          onWake();
        }
      });
      watcher.on("error", () => {
        // Best-effort: if watch fails, fall back to pure polling
      });
      watchers.push(watcher);
    } catch {
      // File doesn't exist yet or can't watch — fall back to polling
    }
  }

  return () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // Best effort cleanup
      }
    }
  };
}

// ── Main wait handler ──────────────────────────────────────────────

export async function handleWait(args: string[]): Promise<number> {
  const jsonFlag = args.includes("--json");
  const quietFlag = args.includes("--quiet");
  const allFlag = args.includes("--all");
  const timeoutRaw = readOption(args, "--timeout");

  // Extract positional selectors
  const selectors = extractSelectors(args);

  // Validate: need selectors or --all
  if (selectors.length === 0 && !allFlag) {
    process.stderr.write(
      "No selectors provided. Use run UUIDs, prefixes, #N run numbers, or --all.\n",
    );
    return 4;
  }

  // Parse timeout
  let timeoutMs: number | null = null;
  if (timeoutRaw) {
    try {
      timeoutMs = parseDuration(timeoutRaw);
    } catch (err) {
      process.stderr.write(
        `Invalid --timeout format: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 4;
    }
  }

  // Resolve selectors to run IDs
  let resolved: { runIds: string[] };
  try {
    resolved = resolveRunSelectors(selectors, { all: allFlag });
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 4;
  }

  if (resolved.runIds.length === 0) {
    if (!quietFlag) {
      process.stderr.write("No matching runs found.\n");
    }
    return 0;
  }

  // ── Wait loop ────────────────────────────────────────────────────
  const startTime = Date.now();
  const stateDir = resolvePiStateDir();
  const db = getDb();

  // Track previous step count keys to detect transitions
  const prevKeys = new Map<string, string>();
  const daemonWarned = new Set<string>();
  let lastHeartbeatTime = startTime;

  // Shared early-wakeup: a resolver for the current poll-interval sleep.
  // When called, the sleep promise resolves early and the loop iterates.
  let wakeResolve: ((early: boolean) => void) | null = null;

  const doWake = () => {
    if (wakeResolve) {
      wakeResolve(true);
      wakeResolve = null;
    }
  };

  const cleanupWatchers = setupEventWatchers(resolved.runIds, stateDir, doWake);

  function heartbeat(state: RunState, elapsedMs: number, force: boolean): void {
    const key = stepCountsKey(state.steps);
    const prev = prevKeys.get(state.runId);
    const changed = key !== prev;

    if (changed || force) {
      if (changed) {
        prevKeys.set(state.runId, key);
      }
      if (!quietFlag) {
        const elapsed = formatElapsed(elapsedMs);
        const runLabel = state.runNumber !== null ? `#${state.runNumber}` : state.runId.slice(0, 8);
        process.stderr.write(
          `[wait ${elapsed}] ${runLabel} ${state.workflowId}: ${stepsSummary(state.steps)}\n`,
        );
      }
    }
  }

  // Use a flag to track when we should exit the loop.
  let exitCode: number | null = null;
  let timedOut = false;
  let finalStates: RunState[] = [];

  try {
    // Initial query to set baseline
    const initialStates = queryRunStates(db, resolved.runIds);
    for (const s of initialStates) {
      prevKeys.set(s.runId, stepCountsKey(s.steps));
      heartbeat(s, 0, true);
    }

    while (exitCode === null) {
      const elapsed = Date.now() - startTime;

      // Check timeout
      if (timeoutMs !== null && elapsed >= timeoutMs) {
        const states = queryRunStates(db, resolved.runIds);
        const allDone = states.every((s) => isTerminal(s.status));

        // Output results
        if (!quietFlag || jsonFlag) {
          if (jsonFlag) {
            process.stdout.write(
              formatJsonOutput({ runs: states, timedOut: !allDone }),
            );
          } else {
            process.stdout.write(formatHumanOutput({ runs: states, timedOut: !allDone }));
          }
        }

        exitCode = computeExitCode(states, !allDone);
        timedOut = !allDone;
        finalStates = states;
        break;
      }

      // Query current states
      const states = queryRunStates(db, resolved.runIds);
      const allTerminal = states.every((s) => isTerminal(s.status));

      // Heartbeat on transition or every 60s
      const heartbeatDue = (elapsed - lastHeartbeatTime) >= HEARTBEAT_INTERVAL_MS;
      for (const s of states) {
        heartbeat(s, elapsed, heartbeatDue || allTerminal);
      }
      if (heartbeatDue) {
        lastHeartbeatTime = Date.now();
      }

      // Daemon-down warning
      const daemonUp = isDaemonRunning(stateDir);
      for (const s of states) {
        if (
          s.status === "running" &&
          !daemonWarned.has(s.runId) &&
          !daemonUp &&
          !quietFlag
        ) {
          process.stderr.write(
            `warning: run ${s.runId.slice(0, 8)} is 'running' but the daemon is down — it may be stalled\n`,
          );
          daemonWarned.add(s.runId);
        }
      }

      // If all terminal, exit
      if (allTerminal) {
        if (!quietFlag || jsonFlag) {
          if (jsonFlag) {
            process.stdout.write(formatJsonOutput({ runs: states, timedOut: false }));
          } else {
            process.stdout.write(formatHumanOutput({ runs: states, timedOut: false }));
          }
        }
        exitCode = computeExitCode(states, false);
        finalStates = states;
        break;
      }

      // Wait for next poll interval or early wakeup from events file watch.
      // Use a cancellable sleep: the Promise stored in wakeResolve allows
      // fs.watch events to wake us early. We resolve the sleep promise
      // (clearing wakeResolve) before breaking out of the loop so no
      // unsettled promise remains.
      const early = await new Promise<boolean>((resolve) => {
        wakeResolve = resolve;
        const timer = setTimeout(() => {
          if (wakeResolve === resolve) {
            wakeResolve = null;
            resolve(false);
          }
        }, POLL_INTERVAL_MS);
        // Do not unref: we need the timer to keep the event loop alive
      });
      void early;
    }
  } finally {
    // Clear any pending wake promise to prevent unsettled-await warnings
    if (wakeResolve) {
      wakeResolve(false);
      wakeResolve = null;
    }
    cleanupWatchers();
  }

  return exitCode ?? 0;
}

// ── Help text ──────────────────────────────────────────────────────

export function getWaitHelp(): string {
  return `tamandua workflow wait — Block until workflow runs reach a terminal status

Usage: tamandua workflow wait <selector...> [--all] [--timeout <duration>] [--json] [--quiet]

Selectors can be:
  - Run UUID (full): tamandua workflow wait aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
  - Run ID prefix (unambiguous): tamandua workflow wait aaaaaaaa
  - Run number (#N): tamandua workflow wait #42
  - Multiple selectors: tamandua workflow wait aaaa #42 bbbb
  - All non-terminal runs: tamandua workflow wait --all

Options:
  --all              Wait for every non-terminal run at invocation time
  --timeout <dur>    Max wait duration (e.g. 90s, 10m, 2h). Units: s, m, h, d.
  --json             Output one JSON object to stdout (no human lines)
  --quiet            Suppress stderr heartbeat; without --json, suppress stdout too

Exit codes (precedence top-down):
  4   Selector not found or ambiguous (before entering wait loop)
  2   Timeout expired — at least one run still non-terminal
  1   At least one run failed
  3   At least one run canceled (and none failed)
  0   All runs completed/done successfully

Heartbeat (stderr):
  One line on each observed step-status transition, and at least one line
  every 60s while waiting. Format:
    [wait XmXXs] #N workflow-id: X/Y done, Z active

Bounded-wait loop pattern for capped shell harnesses:
    while ! tamandua workflow wait <selector> --timeout 90s; do
      [ $? -eq 2 ] || break
    done

Examples:
  tamandua workflow wait abc12345
  tamandua workflow wait abc12345 #42
  tamandua workflow wait --all
  tamandua workflow wait abc12345 --timeout 5m
  tamandua workflow wait abc12345 --json
  tamandua workflow wait abc12345 --quiet`;
}
