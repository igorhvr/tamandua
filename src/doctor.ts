/**
 * Doctor — tamandua one-shot diagnostic tool.
 *
 * Runs grouped health checks (ENVIRONMENT, SERVICES, STALENESS, STATE, LLM PROMPT ADHERENCE)
 * and produces pass/fail output with exact remedy commands for failures.
 * All functions return results rather than printing directly, so the
 * CLI layer handles I/O and tests can assert on data.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  isRunning,
  readControlPlanePort,
  readPort,
  readMcpPort,
  isMcpRunning,
  readLogTail,
  getLogFile,
  getMcpPidFile,
} from "./server/daemonctl.js";
import type { DaemonctlPathOptions } from "./server/daemonctl.js";
import { getBuildVersion } from "./lib/version.js";
import { readInstalledCatalogStamp } from "./installer/catalog-version.js";
import { parseExpectedKeys } from "./installer/step-ops.js";
import { getDb } from "./db.js";
import { runMedicCheck } from "./medic/medic.js";
import type { MedicFinding } from "./medic/medic.js";
import { getRunWorktree } from "./installer/worktree-manager.js";
import { collectProcessSnapshot, matchRunEvidence } from "./installer/run-cleanup.js";
import { getRecentEvents } from "./installer/events.js";
import type { TamanduaEvent } from "./installer/events.js";
import { probeHermesStateContract } from "./installer/hermes-usage.js";

// ── Types ──────────────────────────────────────────────────────────

export interface DoctorCheckResult {
  /** Human-readable name of the check (e.g. "Node.js >= 22"). */
  name: string;
  /** Check outcome. */
  status: "pass" | "fail" | "warn" | "info";
  /** Human-readable detail message. */
  message: string;
  /** Exact command to run to fix the issue (only for non-pass statuses). */
  remedy?: string;
}

export interface CheckGroup {
  /** Category label (e.g. "ENVIRONMENT", "SERVICES", etc.). */
  label: string;
  /** Checks in this group. */
  checks: DoctorCheckResult[];
}

// ── Formatter ──────────────────────────────────────────────────────

const STATUS_ICONS: Record<DoctorCheckResult["status"], string> = {
  pass: "✓",
  fail: "✗",
  warn: "⚠",
  info: "ℹ",
};

/**
 * Format check results into a human-readable string.
 *
 * Returns the full output text. Does NOT print to stdout/stderr — the
 * CLI layer handles I/O.
 *
 * @returns The formatted output as a string. Also returns whether any
 *          checks failed (for exit-code logic in the CLI).
 */
export function formatDoctorOutput(groups: CheckGroup[]): { output: string; hasFailures: boolean } {
  const lines: string[] = [];
  let hasFailures = false;
  let warningCount = 0;

  for (const group of groups) {
    lines.push(`─── ${group.label} ───`);
    for (const check of group.checks) {
      const icon = STATUS_ICONS[check.status];
      lines.push(`  ${icon} ${check.name}: ${check.message}`);
      if (check.remedy) {
        lines.push(`    → remedy: ${check.remedy}`);
      }
      if (check.status === "fail") {
        hasFailures = true;
      }
      if (check.status === "warn") {
        warningCount++;
      }
    }
    lines.push("");
  }

  if (hasFailures) {
    lines.push("Some checks failed. Review the remedies above to fix each issue.");
  } else if (warningCount > 0) {
    lines.push(`All checks passed with ${warningCount} warning(s) - review items marked with the warning symbol above.`);
  } else {
    lines.push("All checks passed.");
  }

  return { output: lines.join("\n"), hasFailures };
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Check whether a command is available on PATH.
 * Uses `command -v` (POSIX) to avoid shell aliases and builtins.
 */
function commandIsOnPath(name: string): boolean {
  try {
    const stdout = execSync(`command -v "${name}"`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ── ENVIRONMENT checks ──────────────────────────────────────────

/**
 * Probe `node:sqlite` availability. This module only exists in Node.js >= 22.
 * Incompatible runtimes (Bun, node-wrapper, etc.) will throw on import.
 */
async function checkNodeVersion(): Promise<DoctorCheckResult> {
  try {
    await import("node:sqlite");
    const version = process.version;
    return {
      name: "Node.js >= 22",
      status: "pass",
      message: `Node.js ${version} detected`,
    };
  } catch {
    return {
      name: "Node.js >= 22",
      status: "fail",
      message:
        "node:sqlite is unavailable — you may be running an incompatible runtime (Bun, node-wrapper, or Node.js < 22). A real Node.js >= 22 installation is required.",
      remedy:
        "Install Node.js >= 22 from https://nodejs.org or via nvm / fnm",
    };
  }
}

/** Check that `pi` is available on PATH. */
function checkPiOnPath(): DoctorCheckResult {
  const found = commandIsOnPath("pi");
  if (found) {
    return {
      name: "pi present on PATH",
      status: "pass",
      message: "pi found on PATH",
    };
  }
  return {
    name: "pi present on PATH",
    status: "fail",
    message: "pi not found on PATH",
    remedy:
      "Install pi: https://github.com/igorhvr/pi or clone and ./install",
  };
}

/** Check that `gh` (GitHub CLI) is available on PATH. */
function checkGhOnPath(): DoctorCheckResult {
  const found = commandIsOnPath("gh");
  if (found) {
    return {
      name: "gh present",
      status: "pass",
      message: "gh found on PATH",
    };
  }
  return {
    name: "gh present",
    status: "fail",
    message: "gh not found on PATH",
    remedy:
      "Install GitHub CLI: https://cli.github.com",
  };
}

/**
 * Detect `pi-token-saver` on PATH.
 * This is an optional tool — never fail, always report as "info" or "pass".
 */
function checkPiTokenSaver(): DoctorCheckResult {
  const found = commandIsOnPath("pi-token-saver");
  if (found) {
    return {
      name: "pi-token-saver detection",
      status: "pass",
      message: "pi-token-saver found on PATH (optional token-saving tool)",
    };
  }
  return {
    name: "pi-token-saver detection",
    status: "info",
    message:
      "pi-token-saver not found on PATH (optional — only preferred by no-hurry runs)",
  };
}

/** Determine whether a hermes binary is available. */
function hermesBinaryAvailable(): boolean {
  if (process.env.TAMANDUA_HERMES_BINARY) return true;
  return commandIsOnPath("hermes");
}

/**
 * Detect Hermes binary availability.
 * Checks `TAMANDUA_HERMES_BINARY` env var first, then PATH.
 * Hermes support is alpha — always informational.
 */
function checkHermesBinary(): DoctorCheckResult {
  const envBinary = process.env.TAMANDUA_HERMES_BINARY;
  if (envBinary) {
    return {
      name: "TAMANDUA_HERMES_BINARY / hermes",
      status: "info",
      message: `TAMANDUA_HERMES_BINARY is set to: ${envBinary}`,
    };
  }
  const onPath = commandIsOnPath("hermes");
  if (onPath) {
    return {
      name: "TAMANDUA_HERMES_BINARY / hermes",
      status: "info",
      message: "hermes found on PATH (alpha support)",
    };
  }
  return {
    name: "TAMANDUA_HERMES_BINARY / hermes",
    status: "info",
    message:
      "TAMANDUA_HERMES_BINARY not set and hermes not found on PATH (alpha support — optional)",
  };
}

/**
 * Probe the hermes state.db contract when a hermes binary is available.
 *
 * Precondition: `hermesBinaryAvailable()` MUST be true before calling.
 * The caller in `runDoctorChecks` gates this check — it is NOT invoked
 * when no hermes binary exists.
 *
 * - Contract OK → info ("contract OK — token accounting available")
 * - Contract broken → warn with reason + impact note
 *
 * Hermes is alpha — this check never fails; broken contract only warns.
 */
function checkHermesContract(): DoctorCheckResult {
  const probe = probeHermesStateContract();

  if (probe.ok) {
    return {
      name: "Hermes state.db contract",
      status: "info",
      message: "hermes state.db contract OK — token accounting available",
    };
  }

  return {
    name: "Hermes state.db contract",
    status: "warn",
    message: `hermes state.db contract broken: ${probe.reason}. Hermes runs will report 0 tokens.`,
  };
}

/**
 * Detect `hermes-token-saver` on PATH.
 * This is an optional tool — never fail, always report as "info" or "pass".
 */
function checkHermesTokenSaver(): DoctorCheckResult {
  const found = commandIsOnPath("hermes-token-saver");
  if (found) {
    return {
      name: "hermes-token-saver detection",
      status: "pass",
      message: "hermes-token-saver found on PATH (optional token-saving tool)",
    };
  }
  return {
    name: "hermes-token-saver detection",
    status: "info",
    message:
      "hermes-token-saver not found on PATH (optional — only preferred by no-hurry runs)",
  };
}

// ── Doctor options ──────────────────────────────────────────────

/** Options for runDoctorChecks. */
export interface DoctorOpts {
  /** Override HOME directory for test isolation. */
  homeDir?: string;
}

// ── Catalog Staleness check (US-002) ───────────────────────────

/**
 * Compare the installed catalog stamp version against the current build version.
 *
 * - No stamp → warn with "run tamandua update --force" remedy
 * - Stamp version differs → warn with "run tamandua update --force" remedy
 * - Stamp version matches → pass
 * - Synchronous: just stat + read + string compare, no network, no git
 */
function checkCatalogStaleness(): DoctorCheckResult {
  const stamp = readInstalledCatalogStamp();
  const localVersion = getBuildVersion();

  if (!stamp) {
    return {
      name: "Installed catalog vs bundled catalog",
      status: "warn",
      message: "No installed catalog stamp found — installed workflows may be missing or predate catalog version tracking",
      remedy: "Run: tamandua update --force",
    };
  }

  if (stamp.version !== localVersion) {
    return {
      name: "Installed catalog vs bundled catalog",
      status: "warn",
      message: `Installed catalog version ${stamp.version} is older than bundled catalog version ${localVersion}`,
      remedy: "Run: tamandua update --force",
    };
  }

  return {
    name: "Installed catalog vs bundled catalog",
    status: "pass",
    message: `Installed catalog version ${stamp.version} matches bundled catalog version ${localVersion}`,
  };
}

// ── STALENESS check (US-005) ───────────────────────────────────

/**
 * Compare the running daemon's buildVersion (from control plane health)
 * against the local dist/version file.
 *
 * - If buildVersion differs: fail with dashboard restart remedy
 * - If buildVersion is missing (old daemon): warn with inconclusive message
 * - If control plane is unreachable: info (skip — covered by SERVICES)
 * - If matches: pass
 */
async function runStalenessCheck(opts?: DoctorOpts): Promise<DoctorCheckResult[]> {
  const dctlOpts: DaemonctlPathOptions | undefined = opts?.homeDir ? { homeDir: opts.homeDir } : undefined;
  const localVersion = getBuildVersion();

  // Try to fetch health from the control plane.
  try {
    const cpPort = readControlPlanePort(dctlOpts);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${cpPort}/control/health`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      return [{
        name: "Daemon build version vs installed",
        status: "info",
        message: "Staleness check skipped (control plane health returned non-200)",
      }];
    }

    const body = await res.json() as Record<string, unknown>;
    const daemonVersion = body.buildVersion as string | undefined;

    if (daemonVersion === undefined) {
      return [{
        name: "Daemon build version vs installed",
        status: "warn",
        message: "Staleness check inconclusive — daemon predates build version reporting",
        remedy: "Run: tamandua dashboard restart to update",
      }];
    }

    if (daemonVersion !== localVersion) {
      return [{
        name: "Daemon build version vs installed",
        status: "fail",
        message: `Daemon running build ${daemonVersion} but installed build is ${localVersion}`,
        remedy: "Run: tamandua dashboard restart",
      }];
    }

    return [{
      name: "Daemon build version vs installed",
      status: "pass",
      message: `Daemon build ${daemonVersion} matches installed build ${localVersion}`,
    }];
  } catch {
    return [{
      name: "Daemon build version vs installed",
      status: "info",
      message: "Staleness check skipped (control plane unreachable — covered by SERVICES checks above)",
    }];
  }
}

// ── SERVICES checks (US-004) ─────────────────────────────────────

async function runServicesChecks(opts?: DoctorOpts): Promise<DoctorCheckResult[]> {
  const dctlOpts: DaemonctlPathOptions | undefined = opts?.homeDir ? { homeDir: opts.homeDir } : undefined;
  const results: DoctorCheckResult[] = [];
  const daemonStatus = isRunning(dctlOpts);

  // Lazily read daemon log tail on first failure
  let logTail: string | null = null;
  function getLogTailOnce(): string {
    if (logTail === null) {
      logTail = readLogTail(getLogFile(dctlOpts), 20);
    }
    return logTail;
  }
  function withLogTail(msg: string): string {
    const tail = getLogTailOnce();
    return tail ? `${msg}\n\nDaemon log tail:\n${tail}` : msg;
  }

  // 1. Dashboard daemon PID
  if (daemonStatus.running) {
    results.push({
      name: "Dashboard daemon PID alive",
      status: "pass",
      message: `Daemon running (PID ${daemonStatus.pid})`,
    });
  } else {
    results.push({
      name: "Dashboard daemon PID alive",
      status: "fail",
      message: withLogTail("Daemon is not running"),
      remedy: "tamandua dashboard start",
    });
  }

  // 2. Control plane health
  if (daemonStatus.running) {
    try {
      const cpPort = readControlPlanePort(dctlOpts);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`http://127.0.0.1:${cpPort}/control/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        results.push({
          name: "Control plane reachable",
          status: "pass",
          message: `Control plane responding on port ${cpPort}`,
        });
      } else {
        results.push({
          name: "Control plane reachable",
          status: "fail",
          message: withLogTail(`Control plane returned HTTP ${res.status} on port ${cpPort}`),
          remedy: "tamandua dashboard restart",
        });
      }
    } catch {
      results.push({
        name: "Control plane reachable",
        status: "fail",
        message: withLogTail(`Control plane unreachable on port ${readControlPlanePort(dctlOpts)}`),
        remedy: "tamandua dashboard restart",
      });
    }
  } else {
    results.push({
      name: "Control plane reachable",
      status: "fail",
      message: "Control plane unreachable (daemon is not running)",
      remedy: "tamandua dashboard start",
    });
  }

  // 3. Dashboard HTTP
  if (daemonStatus.running) {
    try {
      const dashPort = readPort(dctlOpts);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`http://127.0.0.1:${dashPort}/`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        results.push({
          name: "Dashboard HTTP up",
          status: "pass",
          message: `Dashboard responding on port ${dashPort}`,
        });
      } else {
        results.push({
          name: "Dashboard HTTP up",
          status: "fail",
          message: withLogTail(`Dashboard returned HTTP ${res.status} on port ${dashPort}`),
          remedy: "tamandua dashboard restart",
        });
      }
    } catch {
      results.push({
        name: "Dashboard HTTP up",
        status: "fail",
        message: withLogTail(`Dashboard unreachable on port ${readPort(dctlOpts)}`),
        remedy: "tamandua dashboard restart",
      });
    }
  } else {
    results.push({
      name: "Dashboard HTTP up",
      status: "fail",
      message: "Dashboard unreachable (daemon is not running)",
      remedy: "tamandua dashboard start",
    });
  }

  // 4. MCP server status
  const mcpPidFile = getMcpPidFile(dctlOpts);
  const mcpPidFileExists = fs.existsSync(mcpPidFile);
  if (mcpPidFileExists) {
    const mcpStatus = isMcpRunning(dctlOpts);
    const mcpPort = readMcpPort(dctlOpts);
    if (mcpStatus.running) {
      results.push({
        name: "MCP server status",
        status: "pass",
        message: `MCP server running (PID ${mcpStatus.pid}, port ${mcpPort})`,
      });
    } else {
      results.push({
        name: "MCP server status",
        status: "fail",
        message: withLogTail(`MCP pidfile exists but process not running (pidfile: ${mcpPidFile})`),
        remedy: "tamandua mcp restart",
      });
    }
  } else {
    results.push({
      name: "MCP server status",
      status: "info",
      message: "MCP server is not running (optional — start with: tamandua mcp start)",
    });
  }

  return results;
}

// ── STATE checks (US-006) ──────────────────────────────────────────

/** Map MedicFinding severity to DoctorCheckResult status. */
function medicSeverityToStatus(severity: MedicFinding["severity"]): DoctorCheckResult["status"] {
  switch (severity) {
    case "critical": return "fail";
    case "warning": return "warn";
    default: return "info";
  }
}

/** Map MedicFinding action to a readable remedy hint. */
function medicActionToRemedy(action: MedicFinding["action"]): string | undefined {
  switch (action) {
    case "fail_run":
      return "Medic would fail the zombie run. Run: tamandua medic check to auto-remediate.";
    case "teardown_crons":
      return "Medic would teardown idle workflow crons. Run: tamandua medic check to auto-remediate.";
    case "none":
    default:
      return undefined;
  }
}

// ── STORIES_JSON rejection helper (US-005) ──────────────────────────

/** Categorize a STORIES_JSON validation error from a step.retry detail field. */
function categorizeStoriesJsonError(detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes("structural mismatch")) return "structural_mismatch";
  if (d.includes("duplicate key")) return "duplicate_key";
  if (d.includes("failed to parse stories_json") || d.includes("stories_json must be an array")) return "parse_error";
  if (d.includes("missing required fields") ||
      d.includes("invalid id") ||
      d.includes("empty or whitespace") ||
      d.includes("zero stories") ||
      d.includes("duplicate story id") ||
      d.includes("non-string") ||
      d.includes("has ") && d.includes("stories, max is")) return "schema_validation";
  return "unknown";
}

/**
 * Surface recent STORIES_JSON validation rejections from step.retry events.
 *
 * Queries the global events JSONL file for step.retry events whose detail
 * field matches C20 error shapes (structural mismatch, duplicate key,
 * malformed JSON, schema validation failures).
 *
 * Categories:
 *   - structural_mismatch: raw id-key count vs parsed story count mismatch
 *   - duplicate_key: any duplicate key detected by the scanner
 *   - parse_error: JSON.parse failure or payload not an array
 *   - schema_validation: invalid id format, empty title/description, empty AC items, zero stories, duplicate story ids
 */
function runStoriesJsonRejectionCheck(opts?: DoctorOpts): DoctorCheckResult {
  // If an isolated homeDir is provided, point TAMANDUA_STATE_DIR at it
  // so getRecentEvents() reads from the test-isolated events file.
  const savedStateDir = process.env.TAMANDUA_STATE_DIR;
  if (opts?.homeDir) {
    process.env.TAMANDUA_STATE_DIR = path.join(opts.homeDir, ".tamandua");
  }

  try {
    // Read up to 200 recent events; STORIES_JSON rejections are rare so
    // a generous window catches older regressions without hurting perf.
    const events = getRecentEvents(200);

    // Filter for step.retry events with STORIES_JSON content in the detail
    const rejections = events.filter(
      (e: TamanduaEvent) =>
        e.event === "step.retry" &&
        e.detail != null &&
        e.detail.toLowerCase().includes("stories_json"),
    );

    if (rejections.length === 0) {
      return {
        name: "STORIES_JSON validation rejections",
        status: "info",
        message: "No recent STORIES_JSON validation rejections",
      };
    }

    // Categorize each rejection
    const categoryCounts: Record<string, number> = {};
    const affectedRuns = new Set<string>();
    const affectedWorkflows = new Set<string>();

    for (const rej of rejections) {
      const cat = categorizeStoriesJsonError(rej.detail ?? "");
      categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
      if (rej.runId) affectedRuns.add(rej.runId);
      if (rej.workflowId) affectedWorkflows.add(rej.workflowId);
    }

    const catSummary = Object.entries(categoryCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([cat, n]) => `${cat}=${n}`)
      .join(", ");

    const runSummary =
      affectedRuns.size <= 3
        ? Array.from(affectedRuns).join(", ")
        : `${Array.from(affectedRuns).slice(0, 3).join(", ")}... (${affectedRuns.size} total)`;

    const wfSummary =
      affectedWorkflows.size <= 3
        ? Array.from(affectedWorkflows).join(", ")
        : `${Array.from(affectedWorkflows).slice(0, 3).join(", ")}... (${affectedWorkflows.size} total)`;

    return {
      name: "STORIES_JSON validation rejections",
      status: "warn",
      message:
        `${rejections.length} STORIES_JSON validation ${rejections.length === 1 ? "rejection" : "rejections"} ` +
        `across ${affectedRuns.size} ${affectedRuns.size === 1 ? "run" : "runs"} ` +
        `[${catSummary}] — runs: ${runSummary} — workflows: ${wfSummary}`,
      remedy: "Check step prompts for malformed STORIES_JSON emission. Review MOTOR-CONTRACT.md C20 for the format contract.",
    };
  } finally {
    // Restore original state dir
    if (savedStateDir !== undefined) {
      process.env.TAMANDUA_STATE_DIR = savedStateDir;
    } else if (opts?.homeDir) {
      delete process.env.TAMANDUA_STATE_DIR;
    }
  }
}

/**
 * Run STATE checks: database health and run-level anomaly detection.
 *
 * - Opens the database via getDb() and runs a simple query to verify connectivity.
 * - Calls runMedicCheck() to detect stuck steps and zombie runs.
 * - Does NOT write new detection logic — wires the existing medic.
 */
async function runStateChecks(opts?: DoctorOpts): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];

  // If an isolated homeDir is provided, point DB resolution at it.
  // getDb() reads process.env.TAMANDUA_DB_PATH, so we set it temporarily.
  const savedDbPath = process.env.TAMANDUA_DB_PATH;
  if (opts?.homeDir) {
    process.env.TAMANDUA_DB_PATH = path.join(opts.homeDir, ".tamandua", "tamandua.db");
  }

  try {
    // ── 1. Database connectivity check ──
    try {
      const db = getDb();
      // A simple query that exercises the connection.
      db.prepare("SELECT 1").get();
      results.push({
        name: "Database opens",
        status: "pass",
        message: "Database opened successfully",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        name: "Database opens",
        status: "fail",
        message: `Database failed to open: ${msg}`,
        remedy: "Check disk space and file permissions. Ensure the database directory exists and is writable.",
      });
      // Can't run medic if DB doesn't open — return early.
      return results;
    }

    // ── 2. Run-level anomalies (via medic) ──
    try {
      const medicResult = await runMedicCheck();

      if (medicResult.findings.length === 0) {
        results.push({
          name: "Run-level anomalies",
          status: "pass",
          message: "No run-level anomalies detected",
        });
      } else {
        for (const finding of medicResult.findings) {
          results.push({
            name: "Run-level anomaly",
            status: medicSeverityToStatus(finding.severity),
            message: finding.message,
            remedy: medicActionToRemedy(finding.action),
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        name: "Run-level anomalies",
        status: "warn",
        message: `Medic check could not be completed: ${msg}`,
        remedy: "Ensure the database is accessible and medic tables exist. Run: tamandua medic check",
      });
    }

    // ── 3. STORIES_JSON validation rejections (US-005) ──
    // Surfaces recent C20 structural-validation rejections from the events
    // feed so fused-JSON regressions are visible without log spelunking.
    results.push(runStoriesJsonRejectionCheck(opts));

    return results;
  } finally {
    // Restore the original DB path.
    if (savedDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = savedDbPath;
    } else if (opts?.homeDir) {
      delete process.env.TAMANDUA_DB_PATH;
    }
  }
}

// ── Process-Leak Check (US-004) ──────────────────────────────────

/**
 * Scan for processes tied to terminal runs — report-only, never kills.
 *
 * Serves as the accountability layer for accepted sweep-miss risks:
 * daemon restarted before a pending sweep timer fired, late-detaching
 * stragglers after the one-shot sweep, etc.
 */
function runProcessLeakChecks(opts?: DoctorOpts): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];

  const savedDbPath = process.env.TAMANDUA_DB_PATH;
  if (opts?.homeDir) {
    process.env.TAMANDUA_DB_PATH = path.join(opts.homeDir, ".tamandua", "tamandua.db");
  }

  try {
    const db = getDb();

    const rows = db
      .prepare("SELECT id FROM runs WHERE status IN ('completed', 'failed', 'canceled')")
      .all() as { id: string }[];

    // One process-table snapshot for all runs (on macOS a per-pid walk
    // would spawn two subprocesses per process — see run-cleanup.ts).
    let snapshot: ReturnType<typeof collectProcessSnapshot> | null = null;

    for (const row of rows) {
      const runId = row.id;

      const wt = getRunWorktree(runId);
      if (!wt) continue;

      // Worktree directory may have been removed — skip gracefully
      if (!fs.existsSync(wt.worktreePath)) continue;

      snapshot ??= collectProcessSnapshot();
      for (const entry of snapshot) {
        const pid = entry.pid;
        if (pid === process.pid) continue;

        const evidence = matchRunEvidence(entry, runId, wt.worktreePath);
        if (evidence) {
          results.push({
            name: "Run-process leak",
            status: "warn",
            message: `Process ${pid} belongs to terminal run ${runId}: ${evidence}`,
            remedy: `Manual cleanup: kill ${pid}`,
          });
        }
      }
    }

    return results;
  } finally {
    if (savedDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = savedDbPath;
    } else if (opts?.homeDir) {
      delete process.env.TAMANDUA_DB_PATH;
    }
  }
}

// ── Check Runner ───────────────────────────────────────────────────

/**
 * Run all doctor check groups.
 *
 * Orchestrates the four check categories:
 *   1. ENVIRONMENT — runtime environment checks (Node.js, pi, gh, etc.)
 *   2. SERVICES    — daemon, control plane, dashboard, MCP liveness
 *   3. STALENESS   — running daemon build vs. installed build
 *   4. STATE       — database health, run-level anomalies, process leaks
 */
/**
 * Run LLM PROMPT ADHERENCE checks: per-step key-emission rates.
 *
 * Queries the most recent 50 terminal runs and checks which Reply-with
 * contract keys each DONE step actually delivered in the run context.
 * Reports emission rates grouped by workflow, warns on keys below 50%
 * over at least 5 samples.
 */
export async function runLlmPromptAdherenceChecks(opts?: DoctorOpts): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];

  const savedDbPath = process.env.TAMANDUA_DB_PATH;
  if (opts?.homeDir) {
    process.env.TAMANDUA_DB_PATH = path.join(opts.homeDir, ".tamandua", "tamandua.db");
  }

  try {
    const db = getDb();

    // Query most recent 50 terminal runs
    const runs = db.prepare(
      `SELECT id, workflow_id, status, context, created_at, updated_at
       FROM runs
       WHERE status IN ('completed', 'failed', 'canceled')
       ORDER BY updated_at DESC
       LIMIT 50`
    ).all() as { id: string; workflow_id: string; status: string; context: string; created_at: string; updated_at: string }[];

    if (runs.length === 0) {
      return results;
    }

    if (runs.length < 5) {
      results.push({
        name: "Key-emission rates",
        status: "info",
        message: `Insufficient data — only ${runs.length} terminal runs found (need at least 5)`,
      });
      return results;
    }

    // Aggregation: workflow_id → step_id → key → { present, total }
    const stats: Record<string, Record<string, Record<string, { present: number; total: number }>>> = {};
    let totalKeysTracked = 0;
    let totalKeyPresence = 0;

    for (const run of runs) {
      let runContext: Record<string, unknown> = {};
      try {
        runContext = JSON.parse(run.context);
      } catch {
        // Legacy / corrupt context — treat as empty
      }

      const steps = db.prepare(
        `SELECT step_id, input_template
         FROM steps
         WHERE run_id = ? AND status = 'done'
         ORDER BY step_index ASC`
      ).all(run.id) as { step_id: string; input_template: string }[];

      const wfId = run.workflow_id;

      for (const step of steps) {
        const rawExpectedKeys = parseExpectedKeys(step.input_template);
        // STORIES_JSON is intentionally skipped by parseOutputKeyValues
        // (its value is multi-line raw JSON, not key-value pairs), so it
        // never appears in run context.  Exclude it from key-emission
        // tracking — the step's output is measured by story count in the
        // stories table, not by raw text presence in the context blob.
        const expectedKeys = rawExpectedKeys.filter(k => k !== 'stories_json');
        if (expectedKeys.length === 0) continue;

        const wfStats = (stats[wfId] = stats[wfId] ?? {});
        const keyStats = (wfStats[step.step_id] = wfStats[step.step_id] ?? {});

        for (const key of expectedKeys) {
          const entry = (keyStats[key] = keyStats[key] ?? { present: 0, total: 0 });
          entry.total++;
          if (hasOwn(runContext, key)) {
            entry.present++;
            totalKeyPresence++;
          }
          totalKeysTracked++;
        }
      }
    }

    // Generate output lines — only entries below 100%
    for (const [wfId, wfStats] of Object.entries(stats).sort()) {
      for (const [stepId, keyMap] of Object.entries(wfStats).sort()) {
        for (const [key, entry] of Object.entries(keyMap).sort()) {
          const rate = entry.present / entry.total;
          const percent = (rate * 100).toFixed(0);

          if (rate < 1) {
            if (rate < 0.5 && entry.total >= 5) {
              results.push({
                name: `${wfId} ${stepId} ${key.toUpperCase()}`,
                status: "warn",
                message: `${wfId} ${stepId} ${key.toUpperCase()}: ${entry.present}/${entry.total} (${percent}%)`,
                remedy: `Check the ${stepId} step prompt in ${wfId} workflow for ${key.toUpperCase()} key emission`,
              });
            } else {
              results.push({
                name: `${wfId} ${stepId} ${key.toUpperCase()}`,
                status: "info",
                message: `${wfId} ${stepId} ${key.toUpperCase()}: ${entry.present}/${entry.total} (${percent}%)`,
              });
            }
          }
        }
      }
    }

    // Summary line
    const overallRate = totalKeysTracked > 0 ? totalKeyPresence / totalKeysTracked : 0;
    const overallPercent = (overallRate * 100).toFixed(0);
    const oldest = runs[runs.length - 1].updated_at;
    const newest = runs[0].updated_at;

    results.push({
      name: "Summary",
      status: "info",
      message: `${totalKeysTracked} keys tracked across ${runs.length} runs (${oldest} → ${newest}), overall emission rate: ${overallPercent}%`,
    });

    return results;
  } finally {
    if (savedDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = savedDbPath;
    } else if (opts?.homeDir) {
      delete process.env.TAMANDUA_DB_PATH;
    }
  }
}

/** Orphan-safe own-property check. */
function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Run a check-group runner defensively: a crashing runner becomes a single
 * failed check instead of taking down the whole doctor. The doctor exists to
 * diagnose broken states (unopenable DB, corrupt state dir) — those same
 * states must not crash the diagnosis itself.
 */
async function guardedChecks(
  name: string,
  fn: () => DoctorCheckResult[] | Promise<DoctorCheckResult[]>,
): Promise<DoctorCheckResult[]> {
  try {
    return await fn();
  } catch (err) {
    return [{
      name,
      status: "fail",
      message: `check group crashed: ${err instanceof Error ? err.message : String(err)}`,
      remedy: "This usually indicates broken tamandua state (DB path, state dir permissions). Inspect the message above and fix the underlying path/state issue.",
    }];
  }
}

export async function runDoctorChecks(opts?: DoctorOpts): Promise<CheckGroup[]> {
  // ENVIRONMENT — wired in US-003
  const envPromises: Array<DoctorCheckResult | Promise<DoctorCheckResult>> = [
    checkNodeVersion(),
    checkPiOnPath(),
    checkGhOnPath(),
    checkPiTokenSaver(),
    checkHermesTokenSaver(),
    checkHermesBinary(),
  ];

  // Hermes contract check: only included when a hermes binary is available.
  if (hermesBinaryAvailable()) {
    envPromises.push(checkHermesContract());
  }

  const environmentChecks = await Promise.all(envPromises);

  // SERVICES — wired in US-004
  const servicesChecks = await guardedChecks("Services checks", () => runServicesChecks(opts));

  // STALENESS — wired in US-005
  const stalenessChecks = await guardedChecks("Staleness check", () => runStalenessCheck(opts));

  // Catalog staleness — synchronous check, no need for guardedChecks async wrapper
  // but we still wrap it for consistency
  const catalogStalenessCheck = await guardedChecks("Catalog staleness check", () =>
    Promise.resolve([checkCatalogStaleness()]),
  );
  stalenessChecks.push(...catalogStalenessCheck);

  // STATE — wired in US-006
  const stateChecks = await guardedChecks("State checks", () => runStateChecks(opts));

  // Process-leak checks — wired in US-004 (report-only, appended after existing STATE checks)
  const leakChecks = await guardedChecks("Process-leak scan", () => runProcessLeakChecks(opts));
  stateChecks.push(...leakChecks);

  // LLM PROMPT ADHERENCE — wired in US-001
  const adherenceChecks = await guardedChecks("LLM prompt adherence", () => runLlmPromptAdherenceChecks(opts));

  return [
    { label: "ENVIRONMENT", checks: environmentChecks },
    { label: "SERVICES", checks: servicesChecks },
    { label: "STALENESS", checks: stalenessChecks },
    { label: "STATE", checks: stateChecks },
    { label: "LLM PROMPT ADHERENCE", checks: adherenceChecks },
  ];
}
