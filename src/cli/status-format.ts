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
}): string {
  const runsFn = opts?.listRuns ?? defaultListRuns;
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

  // List running and paused runs with details
  const activeRuns = runs.filter(
    (r) => r.status === "running" || r.status === "paused",
  );
  if (activeRuns.length > 0) {
    for (const r of activeRuns) {
      const idShort = r.id.slice(0, 8);
      const taskPreview =
        r.task.length > 60 ? r.task.slice(0, 57) + "..." : r.task;
      lines.push(
        `  [${r.status.padEnd(7)}] ${idShort}  ${r.workflowId.padEnd(14)} ${r.tokensSpent.toLocaleString().padStart(8)} tokens  ${taskPreview}`,
      );
    }
  }

  // Show completed/done count line
  const doneCount = counts["done"] || 0;
  const failedCount = counts["failed"] || 0;
  if (doneCount > 0 || failedCount > 0) {
    const parts: string[] = [];
    if (doneCount > 0) parts.push(`${doneCount} done`);
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
        !lowers.includes("hermes")
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
