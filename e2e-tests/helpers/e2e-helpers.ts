/**
 * Helpers for real end-to-end workflow tests.
 *
 * These helpers manage daemon lifecycle and workflow run polling for the
 * slow real e2e tests. They use isolated HOME/TAMANDUA_STATE_DIR to avoid
 * touching live Tamandua state.
 *
 * IMPORTANT: The real e2e tests using these helpers are SLOW and spend
 * real model tokens.  Do not run them as part of regular test suites.
 *
 * Run only via:  ./run-all-real-e2e-tests
 */

import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";
import { baseEnv } from "./smoke-helpers.ts";
import { openE2eDatabase } from "./e2e-database.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");
const daemonScript = path.resolve(repoRoot, "dist", "server", "daemon.js");
const dashboardStandaloneScript = path.resolve(repoRoot, "dist", "server", "dashboard-standalone.js");

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000; // 30 minutes
export const DAEMON_START_TIMEOUT_MS = 15_000;

const TERMINAL_STATUSES = new Set(["completed", "done", "failed", "canceled"]);
const SUCCESSFUL_RUN_STATUSES = new Set(["completed", "done"]);

export function isSuccessfulRunTerminalStatus(status: string): boolean {
  return SUCCESSFUL_RUN_STATUSES.has(status);
}

/**
 * Collect run diagnostics for failure messages: the daemon/CLI log tail and
 * the run's event tail. A 45-minute real-e2e timeout that reports only
 * "last status: running" is the most expensive possible debugging loop —
 * always attach these to timeout errors.
 */
export function collectRunDiagnostics(tamanduaDir: string, runId?: string): string {
  const sections: string[] = [];

  try {
    const logPath = path.join(tamanduaDir, "tamandua.log");
    const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
    sections.push(`── tamandua.log (last 60 lines) ──\n${lines.slice(-60).join("\n")}`);
  } catch {
    sections.push("── tamandua.log ──\n(unreadable or missing)");
  }

  if (runId) {
    try {
      const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
      const lines = fs.readFileSync(eventsPath, "utf-8").trimEnd().split("\n");
      sections.push(`── run events (last 25) ──\n${lines.slice(-25).join("\n")}`);
    } catch {
      sections.push("── run events ──\n(unreadable or missing)");
    }

    try {
      const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
      try {
        const steps = db
          .prepare("SELECT step_index, step_id, agent_id, status, retry_count FROM steps WHERE run_id = ? ORDER BY step_index")
          .all(runId) as Array<{ step_index: number; step_id: string; agent_id: string; status: string; retry_count: number }>;
        sections.push(
          `── steps ──\n${steps.map((s) => `  #${s.step_index} ${s.step_id} (${s.agent_id}) status=${s.status} retries=${s.retry_count}`).join("\n")}`,
        );
      } finally {
        db.close();
      }
    } catch {
      sections.push("── steps ──\n(db unreadable)");
    }
  }

  return sections.join("\n");
}

/**
 * Wait for a run's work-token attribution to land in the DB.
 *
 * The final round's usage arrives AFTER the run turns terminal: pi emits
 * message_end (with usage) after the tool call that ran `step complete`,
 * and attribution happens when the harness process exits and its stream is
 * parsed — protected by HARNESS_TEARDOWN_GRACE_MS. Reading tokens_spent
 * immediately after terminal status races that window. For the same reason
 * the terminal run event's tokensSpent may under-report the final round;
 * the DB total is the eventually-correct number.
 */
export async function waitForRunWorkTokens(
  tamanduaDir: string,
  runId: string,
  timeoutMs = 60_000,
): Promise<RunTokenAudit> {
  const startedAt = Date.now();
  let audit = auditRunTokens(tamanduaDir, runId);
  while (audit.workTokens <= 0 && Date.now() - startedAt < timeoutMs) {
    await sleep(1_000);
    audit = auditRunTokens(tamanduaDir, runId);
  }
  return audit;
}

export interface RunTokenAudit {
  /** runs.tokens_spent — model usage attributed to this run's work. */
  workTokens: number;
  /** tamandua_stats.system_tokens_spent — idle-poll (heartbeat) usage, global. */
  systemTokens: number;
  /** Number of run.tokens.updated events recorded for this run. */
  tokenUpdateEvents: number;
  /** tokensSpent carried by the terminal run.completed/run.failed event, if any. */
  terminalTokensSpent: number | null;
}

/**
 * Audit a run's token accounting from the DB and event log. This is how
 * e2e tests assert the COST of the motor, not just its outcome — the whole
 * point of the deterministic-motor rewrite (see tests/MOTOR-CONTRACT.md
 * N1–N3) is to change these numbers without changing run outcomes.
 */
export function auditRunTokens(tamanduaDir: string, runId: string): RunTokenAudit {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  let workTokens = 0;
  let systemTokens = 0;
  try {
    const run = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as
      | { tokens_spent: number }
      | undefined;
    workTokens = run?.tokens_spent ?? 0;
    const stats = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get() as
      | { system_tokens_spent: number }
      | undefined;
    systemTokens = stats?.system_tokens_spent ?? 0;
  } finally {
    db.close();
  }

  let tokenUpdateEvents = 0;
  let terminalTokensSpent: number | null = null;
  try {
    const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
    const events = fs
      .readFileSync(eventsPath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    tokenUpdateEvents = events.filter((e) => e.event === "run.tokens.updated").length;
    const terminal = events.find((e) => e.event === "run.completed" || e.event === "run.failed");
    if (terminal && typeof terminal.tokensSpent === "number") {
      terminalTokensSpent = terminal.tokensSpent;
    }
  } catch {
    // events file missing — leave defaults
  }

  return { workTokens, systemTokens, tokenUpdateEvents, terminalTokensSpent };
}

/**
 * Poll for a workflow run to reach a terminal status.
 *
 * Calls `tamandua workflow status <runId>` at regular intervals and
 * parses the output to extract the current status. Returns the terminal
 * status string ("completed", "failed", or "canceled") when reached.
 * "done" is also accepted as a legacy success alias.
 *
 * Throws with timeout diagnostics (last known status and output) if the
 * run does not reach a terminal status within `timeoutMs`.
 */
export async function pollForRunCompletion(
  runId: string,
  env: Record<string, string>,
  timeoutMs: number = DEFAULT_RUN_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  tamanduaDir?: string,
): Promise<string> {
  const startedAt = Date.now();
  let lastOutput = "";
  let lastStatus = "";

  while (Date.now() - startedAt < timeoutMs) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });

    lastOutput = result.stdout || result.stderr || "";

    // Extract status from "Status: <value>" line
    const statusMatch = lastOutput.match(/^Status:\s+(\S+)/m);
    if (statusMatch) {
      lastStatus = statusMatch[1];
      if (TERMINAL_STATUSES.has(lastStatus)) {
        return lastStatus;
      }
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Timeout after ${timeoutMs}ms waiting for run ${runId.slice(0, 8)} to complete.\n` +
      `Last status: ${lastStatus || "(unknown)"}\n` +
      `Last output:\n${lastOutput || "(no output)"}` +
      (tamanduaDir ? `\n${collectRunDiagnostics(tamanduaDir, runId)}` : ""),
  );
}

/**
 * Start an isolated daemon process.
 *
 * Spawns the daemon.js script with an isolated HOME directory (so all
 * PID, port, DB, and log files go to the temp ~/.tamandua directory).
 *
 * The daemon hosts ONLY the control plane + reconciler/motor (no
 * dashboard). The control port is passed via TAMANDUA_CONTROL_PORT
 * in the environment (set by baseEnv).
 *
 * Waits for the daemon to print its "control plane listening" message
 * before resolving.  Throws if the daemon fails to start or exits
 * before becoming ready.
 *
 * Returns the ChildProcess handle for cleanup via stopIsolatedDaemon.
 */
export function startIsolatedDaemon(
  homeDir: string,
  controlPort: number,
  extraEnv: Record<string, string> = {},
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["--disable-warning=ExperimentalWarning", daemonScript],
      {
        env: cleanChildEnv({ ...baseEnv(homeDir, controlPort), ...extraEnv }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Daemon failed to start within ${DAEMON_START_TIMEOUT_MS}ms.\n` +
            `Output:\n${output || "(no output)"}`,
        ),
      );
    }, DAEMON_START_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      if (!resolved && output.includes("Tamandua control plane listening")) {
        resolved = true;
        clearTimeout(timeout);
        resolve(child);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Daemon exited with code ${code} before becoming ready.\n` +
            `Output:\n${output || "(no output)"}`,
        ),
      );
    });
  });
}

/**
 * Stop an isolated daemon process.
 *
 * Sends SIGTERM to the daemon and waits for it to exit.  Falls back to
 * SIGKILL after 5 s if the process does not exit gracefully.
 */
export async function stopIsolatedDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (!child.pid) return;

  // Check if the process is still alive
  try {
    process.kill(child.pid, 0);
  } catch {
    return; // already dead
  }

  child.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const forceTimeout = setTimeout(() => {
      if (child.exitCode === null && child.pid) {
        try {
          child.kill("SIGKILL");
        } catch {
          // process may have already exited
        }
      }
      resolve();
    }, 5000);

    child.once("exit", () => {
      clearTimeout(forceTimeout);
      resolve();
    });
  });
}

/**
 * Start an isolated dashboard standalone process.
 *
 * Spawns dashboard-standalone.js with an isolated HOME directory.
 * The dashboard is the UI process only — it has no coupling to the
 * motor or scheduling.
 *
 * Waits for the dashboard to print its "started on port" message
 * before resolving.  Throws if the dashboard fails to start or
 * exits before becoming ready.
 *
 * Returns the ChildProcess handle for cleanup via stopIsolatedDashboard.
 */
export function startIsolatedDashboard(
  port: number,
  homeDir: string,
  extraEnv: Record<string, string> = {},
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["--disable-warning=ExperimentalWarning", dashboardStandaloneScript, String(port)],
      {
        env: cleanChildEnv({ HOME: homeDir, ...extraEnv }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Dashboard failed to start within ${DAEMON_START_TIMEOUT_MS}ms.\n` +
            `Output:\n${output || "(no output)"}`,
        ),
      );
    }, DAEMON_START_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      if (!resolved && output.includes("Tamandua dashboard server started")) {
        resolved = true;
        clearTimeout(timeout);
        resolve(child);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Dashboard exited with code ${code} before becoming ready.\n` +
            `Output:\n${output || "(no output)"}`,
        ),
      );
    });
  });
}

/**
 * Stop an isolated dashboard process.
 *
 * Sends SIGTERM to the dashboard and waits for it to exit.  Falls back
 * to SIGKILL after 5 s if the process does not exit gracefully.
 */
export async function stopIsolatedDashboard(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (!child.pid) return;

  // Check if the process is still alive
  try {
    process.kill(child.pid, 0);
  } catch {
    return; // already dead
  }

  child.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const forceTimeout = setTimeout(() => {
      if (child.exitCode === null && child.pid) {
        try {
          child.kill("SIGKILL");
        } catch {
          // process may have already exited
        }
      }
      resolve();
    }, 5000);

    child.once("exit", () => {
      clearTimeout(forceTimeout);
      resolve();
    });
  });
}

/**
 * Poll for run completion while nudging the scheduler every cycle.
 *
 * The in-process cron timers fire only once per intervalMinutes (default
 * 5 minutes), so without nudging even an instant agent advances one step
 * per 5 minutes. `tamandua nudge` asks the daemon to launch a polling
 * round for every scheduled agent immediately, which lets scripted-agent
 * e2e tests advance the pipeline at second scale.
 *
 * Returns the terminal status. Throws with diagnostics on timeout.
 */
export async function pollForRunCompletionWithNudge(
  runId: string,
  env: Record<string, string>,
  timeoutMs: number,
  nudgeIntervalMs = 1_500,
  tamanduaDir?: string,
): Promise<string> {
  const startedAt = Date.now();
  let lastOutput = "";
  let lastStatus = "";

  while (Date.now() - startedAt < timeoutMs) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });
    lastOutput = result.stdout || result.stderr || "";
    const statusMatch = lastOutput.match(/^Status:\s+(\S+)/m);
    if (statusMatch) {
      lastStatus = statusMatch[1];
      if (TERMINAL_STATUSES.has(lastStatus)) {
        return lastStatus;
      }
    }

    // Wake every scheduled agent for the next round (best-effort).
    spawnSync(process.execPath, [cliPath, "nudge"], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });

    await sleep(nudgeIntervalMs);
  }

  throw new Error(
    `Timeout after ${timeoutMs}ms waiting for run ${runId.slice(0, 8)} to complete (with nudging).\n` +
      `Last status: ${lastStatus || "(unknown)"}\n` +
      `Last output:\n${lastOutput || "(no output)"}` +
      (tamanduaDir ? `\n${collectRunDiagnostics(tamanduaDir, runId)}` : ""),
  );
}

/**
 * Wait for a workflow run to reach a successful terminal status.
 *
 * Thin wrapper around pollForRunCompletion that throws if the terminal
 * status is anything other than "completed" (or legacy alias "done").
 */
export async function waitForRunTerminal(
  runId: string,
  env: Record<string, string>,
  timeoutMs: number = DEFAULT_RUN_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  tamanduaDir?: string,
): Promise<string> {
  const status = await pollForRunCompletion(runId, env, timeoutMs, pollIntervalMs, tamanduaDir);

  if (!isSuccessfulRunTerminalStatus(status)) {
    throw new Error(
      `Run ${runId.slice(0, 8)} reached terminal status "${status}" (expected "completed").` +
        (tamanduaDir ? `\n${collectRunDiagnostics(tamanduaDir, runId)}` : ""),
    );
  }

  return status;
}
