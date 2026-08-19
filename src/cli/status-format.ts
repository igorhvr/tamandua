/**
 * Status formatting for the `tamandua status` command.
 *
 * Formats dashboard, MCP, control-plane, and tamandua installation info
 * into human-readable string sections.
 *
 * Accepts optional dependency injection for unit testing.
 */
import { execSync } from "node:child_process";
import { getDaemonStatus, getDashboardStatus, getMcpStatus, getControlPlaneStatus, getMcpStatusAsync, getControlPlaneStatusAsync, isRunning } from "../server/daemonctl.js";
import { ABANDONED_THRESHOLD_MS } from "../installer/step-ops.js";
import {
  acknowledgeDaemonDeath,
  getLastDaemonDeath,
  isUnseenDaemonDeath,
  type DaemonDeath,
  type DaemonctlPathOptions,
} from "../server/daemon-lifecycle.js";

/**
 * Platform-aware process-listing helper for `tamandua status`.
 *
 * Branches on process.platform:
 * - darwin (macOS/BSD): uses `ps -ax -o pid,etime,command`, strips the column header.
 * - linux (GNU/procps): uses `ps -eo pid,etime,args --no-headers`.
 *
 * Always passes `{ stdio: ["pipe", "pipe", "pipe"] }` so stderr is captured
 * and never leaks raw ps usage text to the user.
 *
 * @param platform Optional platform override for testing (defaults to process.platform).
 */
export function listProcessesForStatus(
  exSync: (cmd: string, options?: Record<string, unknown>) => string | Buffer,
  platform?: string,
): string {
  const options = { stdio: ["pipe", "pipe", "pipe"] };
  const plat = platform ?? process.platform;

  if (plat === "darwin") {
    const output = exSync("ps -ax -o pid,etime,command", options).toString();
    const lines = output.trim().split("\n");
    // Strip the column-header line when present (BSD ps does not support --no-headers).
    if (lines.length > 0 && /^\s*PID\s/i.test(lines[0])) {
      return lines.slice(1).join("\n");
    }
    return output;
  }

  // Linux / GNU ps — preserve existing behavior.
  return exSync("ps -eo pid,etime,args --no-headers", options).toString();
}
import { resolveSourcePath, resolveSkillPath } from "../installer/paths.js";
import { readVersionStatus, type VersionStatus } from "../lib/version-check.js";
import { listRuns as defaultListRuns, type RunInfo } from "../installer/status.js";
import { parseEtimeSeconds } from "../lib/proc-info.js";

export function formatServiceStatus(opts?: {
  getDashboardStatus?: typeof getDashboardStatus;
  getDaemonStatus?: typeof getDaemonStatus;
  getMcpStatus?: typeof getMcpStatus;
  getControlPlaneStatus?: typeof getControlPlaneStatus;
}): string {
  const dashboard = (opts?.getDashboardStatus ?? getDashboardStatus)();
  const daemon = (opts?.getDaemonStatus ?? getDaemonStatus)();
  const mcp = (opts?.getMcpStatus ?? getMcpStatus)();
  const controlPlane = (opts?.getControlPlaneStatus ?? getControlPlaneStatus)();

  const lines: string[] = [];
  lines.push("Services");
  lines.push("--------");

  // Dashboard (standalone UI process)
  if (dashboard.running) {
    lines.push(`Dashboard:      UP   (pid ${dashboard.pid}, port ${dashboard.port}, http://localhost:${dashboard.port})`);
  } else {
    lines.push(`Dashboard:      DOWN (port ${dashboard.port})`);
  }

  // Daemon (control-plane + motor)
  if (daemon.running) {
    lines.push(`Daemon:         UP   (pid ${daemon.pid})`);
  } else {
    lines.push(`Daemon:         DOWN (port ${daemon.port})`);
  }

  // MCP
  if (mcp.running) {
    lines.push(`MCP:            UP   (pid ${mcp.pid}, port ${mcp.port}, http://localhost:${mcp.port}${mcp.endpoint})`);
  } else {
    lines.push(`MCP:            DOWN (port ${mcp.port}, endpoint ${mcp.endpoint})`);
  }

  // Control-plane
  if (controlPlane.running) {
    lines.push(`Control-plane:  UP   (pid ${controlPlane.pid}, port ${controlPlane.port}, http://localhost:${controlPlane.port}${controlPlane.endpoint})`);
  } else {
    lines.push(`Control-plane:  DOWN (port ${controlPlane.port}, endpoint ${controlPlane.endpoint})`);
  }

  return lines.join("\n");
}

/**
 * Async variant of formatServiceStatus that probes live health endpoints
 * for MCP and control-plane instead of relying solely on PID files.
 *
 * PID-file-only checks (the synchronous getControlPlaneStatus / getMcpStatus)
 * always report DOWN when services run in-process with the daemon — the daemon
 * never writes a separate PID file for in-process services.
 *
 * Accepts the same dependency-injection pattern as formatServiceStatus.
 */
export async function formatServiceStatusAsync(opts?: {
  getDashboardStatus?: typeof getDashboardStatus;
  getDaemonStatus?: typeof getDaemonStatus;
  getMcpStatusAsync?: typeof getMcpStatusAsync;
  getControlPlaneStatusAsync?: typeof getControlPlaneStatusAsync;
}): Promise<string> {
  const dashboard = (opts?.getDashboardStatus ?? getDashboardStatus)();
  const daemon = (opts?.getDaemonStatus ?? getDaemonStatus)();
  const mcp = await (opts?.getMcpStatusAsync ?? getMcpStatusAsync)();
  const controlPlane = await (opts?.getControlPlaneStatusAsync ?? getControlPlaneStatusAsync)();

  const lines: string[] = [];
  lines.push("Services");
  lines.push("--------");

  // Dashboard (standalone UI process)
  if (dashboard.running) {
    lines.push(`Dashboard:      UP   (pid ${dashboard.pid}, port ${dashboard.port}, http://localhost:${dashboard.port})`);
  } else {
    lines.push(`Dashboard:      DOWN (port ${dashboard.port})`);
  }

  // Daemon (control-plane + motor)
  if (daemon.running) {
    lines.push(`Daemon:         UP   (pid ${daemon.pid})`);
  } else {
    lines.push(`Daemon:         DOWN (port ${daemon.port})`);
  }

  // MCP
  if (mcp.running) {
    lines.push(`MCP:            UP   (pid ${mcp.pid}, port ${mcp.port}, http://localhost:${mcp.port}${mcp.endpoint})`);
  } else {
    lines.push(`MCP:            DOWN (port ${mcp.port}, endpoint ${mcp.endpoint})`);
  }

  // Control-plane
  if (controlPlane.running) {
    lines.push(`Control-plane:  UP   (pid ${controlPlane.pid}, port ${controlPlane.port}, http://localhost:${controlPlane.port}${controlPlane.endpoint})`);
  } else {
    lines.push(`Control-plane:  DOWN (port ${controlPlane.port}, endpoint ${controlPlane.endpoint})`);
  }

  return lines.join("\n");
}

/**
 * Options for the daemon-lifecycle status surface (formatDaemonLifecycle /
 * collectDaemonLifecycle).
 *
 * `homeDir` resolves the lifecycle state files (lifecycle.log,
 * lifecycle-seen.json) under `<homeDir>/.tamandua/` instead of
 * `~/.tamandua/` — matching the DaemonctlPathOptions convention for test
 * isolation. `getLastDaemonDeath` is the dependency-injection seam for unit
 * tests; the default is the shared reader from src/server/daemon-lifecycle.js.
 */
export interface DaemonLifecycleOpts {
  /** When set, lifecycle state files resolve under <homeDir>/.tamandua/. */
  homeDir?: string;
  /** Dependency injection: override the death reader (default getLastDaemonDeath). */
  getLastDaemonDeath?: (opts?: DaemonctlPathOptions) => DaemonDeath | null;
}

/**
 * Format the 'Daemon Lifecycle' section for `tamandua status`.
 *
 * - No death entry → 'No recorded daemon deaths.'
 * - Clean death → 'Last daemon exit: clean at <ts> (pid <pid>, signal <signal>)'
 * - Unclean death → 'Last daemon exit: UNCLEAN at <ts> (prior pid <pid>, last
 *   heartbeat <age>s ago)', prefixed with a visually distinct '[UNSEEN]'
 *   marker when the death's ts is newer than the acknowledged ts in
 *   lifecycle-seen.json.
 *
 * Rendering the text section is the acknowledgment path: when an unseen
 * unclean death is surfaced, lifecycle-seen.json is written with that death's
 * ts (small atomic write) so the next status run shows it as seen. Never
 * throws.
 */
export function formatDaemonLifecycle(opts?: DaemonLifecycleOpts): string {
  const readDeath = opts?.getLastDaemonDeath ?? getLastDaemonDeath;
  const death = readDeath(opts);

  const lines: string[] = ["Daemon Lifecycle", "----------------"];
  if (death === null) {
    lines.push("No recorded daemon deaths.");
    return lines.join("\n");
  }

  if (death.kind === "clean") {
    const signalPart = death.signal ? `, signal ${death.signal}` : "";
    lines.push(`Last daemon exit: clean at ${death.ts} (pid ${death.pid}${signalPart})`);
    return lines.join("\n");
  }

  const ageS =
    death.lastHeartbeatAgeMs !== undefined
      ? Math.max(0, Math.round(death.lastHeartbeatAgeMs / 1000))
      : 0;
  const unseen = isUnseenDaemonDeath(death, opts);
  lines.push(
    unseen
      ? `Last daemon exit: UNCLEAN [UNSEEN] at ${death.ts} (prior pid ${death.pid}, last heartbeat ${ageS}s ago)`
      : `Last daemon exit: UNCLEAN at ${death.ts} (prior pid ${death.pid}, last heartbeat ${ageS}s ago)`,
  );
  if (unseen) {
    acknowledgeDaemonDeath(death.ts, opts);
  }
  return lines.join("\n");
}

/** Structured last-daemon-death shape for --json output. */
export interface JsonDaemonDeath {
  kind: "clean" | "unclean";
  ts: string;
  pid: number;
  signal?: string;
  priorPid?: number;
  lastHeartbeatAgeMs?: number;
  /** True only for an unclean death newer than the acknowledged seen ts. */
  unseen: boolean;
}

/** Structured daemon-lifecycle section for --json output. */
export interface JsonDaemonLifecycle {
  lastDaemonDeath: JsonDaemonDeath | null;
}

/**
 * Collect the structured daemon-lifecycle section for `tamandua status
 * --json`. Unlike formatDaemonLifecycle, this is read-only: it computes
 * `unseen` from lifecycle-seen.json but never acknowledges (never writes
 * lifecycle-seen.json). Never throws.
 */
export function collectDaemonLifecycle(opts?: DaemonLifecycleOpts): JsonDaemonLifecycle {
  const readDeath = opts?.getLastDaemonDeath ?? getLastDaemonDeath;
  const death = readDeath(opts);
  if (death === null) return { lastDaemonDeath: null };
  const unseen = isUnseenDaemonDeath(death, opts);
  return { lastDaemonDeath: { ...death, unseen } };
}

export function formatTamanduaInfo(opts?: {
  getVersion?: () => string;
  resolveSourcePath?: () => string;
  resolveSkillPath?: () => string;
  getReadVersionStatus?: () => VersionStatus;
  execSync?: (cmd: string) => string;
}): string {
  const version = (opts?.getVersion ?? (() => "unknown"))();
  const exSync = opts?.execSync ?? execSync;
  const srcPath = (opts?.resolveSourcePath ?? resolveSourcePath)();
  const skillPath = (opts?.resolveSkillPath ?? resolveSkillPath)();
  const versionStatus = (opts?.getReadVersionStatus ?? readVersionStatus)();

  // Compute source tree SHA256
  let treeSha = "unavailable";
  try {
    const result = exSync(`git -C "${srcPath}" rev-parse HEAD^{tree}`);
    treeSha = result.toString().trim();
    // Validate it looks like a SHA (40 hex chars)
    if (!/^[0-9a-f]{40}$/i.test(treeSha)) {
      treeSha = "unavailable";
    }
  } catch {
    treeSha = "unavailable";
  }

  const lines: string[] = [];
  lines.push("Tamandua Info");
  lines.push("-------------");
  lines.push(`Source-path:    ${srcPath}`);
  lines.push(`Skill-path:     ${skillPath}`);
  lines.push(`Version:        ${version}`);
  if (versionStatus.updateAvailable) {
    lines.push(`Update:         available (run 'tamandua update')`);
  }
  lines.push(`Source tree:    ${treeSha}`);

  return lines.join("\n");
}

export function formatRunsSummary(opts?: {
  listRuns?: () => RunInfo[];
  isDaemonRunning?: () => boolean;
}): string {
  const runsFn = opts?.listRuns ?? defaultListRuns;
  const daemonCheck = opts?.isDaemonRunning ?? (() => isRunning().running);
  let runs: RunInfo[];
  try {
    runs = runsFn();
  } catch {
    runs = [];
  }

  const lines: string[] = [];
  lines.push("Workflow Runs");
  lines.push("-------------");

  if (runs.length === 0) {
    lines.push("No workflow runs.");
    return lines.join("\n");
  }

  // Count by status
  const counts: Record<string, number> = {};
  for (const r of runs) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  }

  const breakdownParts: string[] = [];
  for (const [status, count] of Object.entries(counts).sort()) {
    breakdownParts.push(`${count} ${status}`);
  }
  lines.push(`${runs.length} total (${breakdownParts.join(", ")})`);

  // List active runs and terminal runs carrying a red-ledger landing annotation.
  // Other terminal runs remain collapsed into the count line below.
  const now = Date.now();
  const daemonRunning = daemonCheck();
  const activeRuns = runs.filter(
    (r) => r.status === "running" || r.status === "paused",
  );
  const annotatedTerminalRuns = runs.filter(
    (r) => r.status !== "running" && r.status !== "paused" && r.redLedgerLanding !== undefined,
  );
  const visibleRuns = [...activeRuns, ...annotatedTerminalRuns];
  if (visibleRuns.length > 0) {
    for (const r of visibleRuns) {
      const idShort = r.id.slice(0, 8);
      const taskPreview =
        r.task.length > 60 ? r.task.slice(0, 57) + "..." : r.task;
      // Staleness annotation: if updatedAt is older than the abandon threshold
      // AND the daemon is not running, annotate the status as stale.
      let displayStatus = r.status;
      const updatedAtMs = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
      if (
        (r.status === "running" || r.status === "paused")
        && !daemonRunning
        && (now - updatedAtMs) > ABANDONED_THRESHOLD_MS
      ) {
        displayStatus = `${r.status} (stale — daemon down?)`;
      }
      const redLedgerMarker = r.redLedgerLanding
        ? `  RED LEDGER row ${r.redLedgerLanding.ledgerRowId}, exit ${r.redLedgerLanding.exitCode} @ ${r.redLedgerLanding.ledgerCreatedAt}`
        : "";
      lines.push(
        `  [${displayStatus.padEnd(7)}] ${idShort}  ${r.workflowId.padEnd(14)} ${r.tokensSpent.toLocaleString().padStart(8)} tokens  ${taskPreview}${redLedgerMarker}`,
      );
    }
  }

  // Show completed/failed count line
  const completedCount = (counts["completed"] || 0)
    - annotatedTerminalRuns.filter((r) => r.status === "completed").length;
  const failedCount = (counts["failed"] || 0)
    - annotatedTerminalRuns.filter((r) => r.status === "failed").length;
  if (completedCount > 0 || failedCount > 0) {
    const parts: string[] = [];
    if (completedCount > 0) parts.push(`${completedCount} completed`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);
    lines.push(`  (${parts.join(", ")} runs not shown)`);
  }

  return lines.join("\n");
}

export function formatProcessList(opts?: {
  isDaemonRunning?: () => boolean;
  execSync?: (cmd: string, options?: Record<string, unknown>) => string | Buffer;
}): string {
  const daRunning = opts?.isDaemonRunning ?? (() => isRunning().running);
  const exSync = opts?.execSync ?? execSync;

  const lines: string[] = [];
  lines.push("Running Processes");
  lines.push("-----------------");

  if (!daRunning()) {
    lines.push("Daemon not running — no agent processes active.");
    return lines.join("\n");
  }

  try {
    const psOutput = listProcessesForStatus(exSync);
    const processLines = psOutput
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l.trim());

    const matches: Array<{
      pid: string;
      elapsed: string;
      harness: string;
      summary: string;
    }> = [];

    for (const line of processLines) {
      // Match on tamandua-related patterns
      const lowers = line.toLowerCase();
      if (
        !lowers.includes("tamandua") &&
        !lowers.includes("pi ") &&
        !lowers.includes("hermes") &&
        !lowers.includes("dsh")
      ) {
        continue;
      }

      const parts = line.trim().split(/\s+/);
      const pid = parts[0];
      const elapsed = parts[1];
      const command = parts.slice(2).join(" ");

      let harness = "unknown";
      if (command.includes("pi --print") || command.includes("pi ")) {
        harness = "pi";
      } else if (command.includes("hermes")) {
        harness = "hermes";
      } else if (command.includes("dsh")) {
        harness = "dsh";
      } else if (command.includes("tamandua step")) {
        harness = "pi";
      } else if (command.includes("tamandua")) {
        harness = "tamandua";
      }

      // Build a short summary of the command
      const summary =
        command.length > 80 ? command.slice(0, 77) + "..." : command;

      matches.push({ pid, elapsed, harness, summary });
    }

    if (matches.length === 0) {
      lines.push("No active agent processes found.");
    } else {
      for (const m of matches) {
        lines.push(
          `  [${m.harness.padEnd(8)}] PID ${m.pid.padEnd(7)}  up ${m.elapsed.padEnd(8)}  ${m.summary}`,
        );
      }
    }
  } catch {
    lines.push("Unable to scan for agent processes.");
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Structured data collectors for --json output
// ═══════════════════════════════════════════════════════════════════

export interface JsonServiceEntry {
  up: boolean;
  pid?: number | null;
  port?: number;
  endpoint?: string;
}

export interface JsonServices {
  dashboard: JsonServiceEntry;
  daemon: JsonServiceEntry;
  mcp: JsonServiceEntry;
  controlPlane: JsonServiceEntry;
}

export interface JsonTamanduaInfo {
  sourcePath: string;
  skillPath: string;
  version: string;
  sourceTreeSha: string;
}

export interface JsonRunsSummary {
  total: number;
  statusCounts: Record<string, number>;
}

export interface JsonProcess {
  pid: number;
  kind: string;
  uptimeSeconds?: number;
}

/**
 * Collect structured service status for JSON output.
 * Calls the same service status functions as formatServiceStatusAsync.
 */
export async function collectServiceStatusAsync(opts?: {
  getDashboardStatus?: typeof getDashboardStatus;
  getDaemonStatus?: typeof getDaemonStatus;
  getMcpStatusAsync?: typeof getMcpStatusAsync;
  getControlPlaneStatusAsync?: typeof getControlPlaneStatusAsync;
}): Promise<JsonServices> {
  const dashboard = (opts?.getDashboardStatus ?? getDashboardStatus)();
  const daemon = (opts?.getDaemonStatus ?? getDaemonStatus)();
  const mcp = await (opts?.getMcpStatusAsync ?? getMcpStatusAsync)();
  const controlPlane = await (opts?.getControlPlaneStatusAsync ?? getControlPlaneStatusAsync)();

  const dashboardEntry: JsonServiceEntry = { up: dashboard.running, port: dashboard.port };
  if (dashboard.running && dashboard.pid !== null) dashboardEntry.pid = dashboard.pid;

  const daemonEntry: JsonServiceEntry = { up: daemon.running, port: daemon.port };
  if (daemon.running && daemon.pid !== null) daemonEntry.pid = daemon.pid;

  const mcpEntry: JsonServiceEntry = { up: mcp.running, port: mcp.port, endpoint: mcp.endpoint };
  if (mcp.running && mcp.pid !== null) mcpEntry.pid = mcp.pid;

  const cpEntry: JsonServiceEntry = { up: controlPlane.running, port: controlPlane.port, endpoint: controlPlane.endpoint };
  if (controlPlane.running && controlPlane.pid !== null) cpEntry.pid = controlPlane.pid;

  return {
    dashboard: dashboardEntry,
    daemon: daemonEntry,
    mcp: mcpEntry,
    controlPlane: cpEntry,
  };
}

/**
 * Collect structured tamandua info for JSON output.
 * Uses the same data sources as formatTamanduaInfo.
 */
export function collectTamanduaInfo(opts?: {
  getVersion?: () => string;
  resolveSourcePath?: () => string;
  resolveSkillPath?: () => string;
  execSync?: (cmd: string) => string;
}): JsonTamanduaInfo {
  const version = (opts?.getVersion ?? (() => "unknown"))();
  const exSync = opts?.execSync ?? execSync;
  const srcPath = (opts?.resolveSourcePath ?? resolveSourcePath)();
  const skillPath = (opts?.resolveSkillPath ?? resolveSkillPath)();

  let treeSha = "unavailable";
  try {
    const result = exSync(`git -C "${srcPath}" rev-parse HEAD^{tree}`);
    const trimmed = result.toString().trim();
    if (/^[0-9a-f]{40}$/i.test(trimmed)) {
      treeSha = trimmed;
    }
  } catch {
    // treeSha stays "unavailable"
  }

  return { sourcePath: srcPath, skillPath, version, sourceTreeSha: treeSha };
}

/**
 * Collect structured runs summary for JSON output.
 * Uses the same data sources as formatRunsSummary.
 */
export function collectRunsSummary(opts?: {
  listRuns?: () => RunInfo[];
}): JsonRunsSummary {
  const runsFn = opts?.listRuns ?? defaultListRuns;
  let runs: RunInfo[];
  try {
    runs = runsFn();
  } catch {
    runs = [];
  }

  const statusCounts: Record<string, number> = {};
  for (const r of runs) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }

  return { total: runs.length, statusCounts };
}

/**
 * Collect structured process list for JSON output.
 * Parses the same ps output as formatProcessList.
 */
export function collectProcessList(opts?: {
  isDaemonRunning?: () => boolean;
  execSync?: (cmd: string, options?: Record<string, unknown>) => string | Buffer;
}): JsonProcess[] {
  const daRunning = opts?.isDaemonRunning ?? (() => isRunning().running);
  const exSync = opts?.execSync ?? execSync;

  if (!daRunning()) {
    return [];
  }

  try {
    const psOutput = listProcessesForStatus(exSync);
    const processLines = psOutput
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l.trim());

    const result: JsonProcess[] = [];

    for (const line of processLines) {
      const lowers = line.toLowerCase();
      if (
        !lowers.includes("tamandua") &&
        !lowers.includes("pi ") &&
        !lowers.includes("hermes") &&
        !lowers.includes("dsh")
      ) {
        continue;
      }

      const parts = line.trim().split(/\s+/);
      const pidStr = parts[0];
      const elapsed = parts[1];
      const command = parts.slice(2).join(" ");

      let kind = "unknown";
      if (command.includes("pi --print") || command.includes("pi ")) {
        kind = "pi";
      } else if (command.includes("hermes")) {
        kind = "hermes";
      } else if (command.includes("dsh")) {
        kind = "dsh";
      } else if (command.includes("tamandua step")) {
        kind = "pi";
      } else if (command.includes("tamandua")) {
        kind = "tamandua";
      }

      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) continue;

      const entry: JsonProcess = { pid, kind };
      const uptime = parseEtimeSeconds(elapsed);
      if (uptime !== null) entry.uptimeSeconds = uptime;

      result.push(entry);
    }

    return result;
  } catch {
    return [];
  }
}
