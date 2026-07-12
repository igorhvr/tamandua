import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { installWorkflow } from "../installer/install.js";
import { checkActiveRuns, type ActiveRunInfo } from "../installer/uninstall.js";
import { listBundledWorkflows } from "../installer/workflow-fetch.js";
import { resolveSourcePath } from "../installer/paths.js";
import { writeCatalogStamp } from "../installer/catalog-version.js";
import {
  getDaemonStatus,
  getDashboardStatus,
  getMcpStatus,
  startDaemon,
  startDashboardStandalone,
  startMcp,
  stopDaemon,
  stopDashboardStandalone,
  stopMcp,
} from "../server/daemonctl.js";
import { runVersionCheck } from "../lib/version-check.js";

export type UpdateServiceStatus =
  | { running: true; pid: number; port: number }
  | { running: false; pid: null; port: number };

export interface UpdateServiceSnapshot {
  daemon: UpdateServiceStatus;
  dashboard: UpdateServiceStatus;
  mcp: UpdateServiceStatus;
}

export interface UpdateServices {
  snapshot: () => UpdateServiceSnapshot;
  stopDaemon: () => boolean;
  stopDashboard: () => boolean;
  stopMcp: () => boolean;
  startDaemon: (port: number) => Promise<{ pid: number; port: number }>;
  startDashboard: (port: number) => Promise<{ pid: number; port: number }>;
  startMcp: (port: number) => Promise<{ pid: number; port: number }>;
}

export interface UpdateOutput {
  log: (message: string) => void;
  warn: (message: string) => void;
}

export interface RunCommandOptions {
  cwd: string;
  stdio: "inherit" | "pipe";
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

export type RunCommand = (
  command: string,
  args: string[],
  options: RunCommandOptions,
) => Promise<RunCommandResult>;

export type UpdateResult =
  | { status: "no_change"; sourcePath: string; head: string }
  | { status: "blocked_active_runs"; sourcePath: string; beforeHead: string; afterHead: string; activeRuns: ActiveRunInfo[] }
  | { status: "updated"; sourcePath: string; beforeHead: string; afterHead: string; services: UpdateServiceSnapshot; installedWorkflows: string[] };

export interface RunUpdateOptions {
  force?: boolean;
  sourcePath?: string;
  runCommand?: RunCommand;
  services?: UpdateServices;
  output?: UpdateOutput;
  listWorkflows?: () => Promise<string[]>;
  installWorkflowById?: (workflowId: string) => Promise<unknown>;
  checkActiveRuns?: () => Promise<ActiveRunInfo[]>;
  waitForProcessExit?: (pid: number) => Promise<void>;
}

const defaultOutput: UpdateOutput = {
  log: (message) => console.log(message),
  warn: (message) => process.stderr.write(`${message}\n`),
};

function shortHead(head: string): string {
  return head.slice(0, 12);
}

function assertSourceCheckout(sourcePath: string): void {
  const buildAndInstall = path.join(sourcePath, "build-and-install");
  const packageJson = path.join(sourcePath, "package.json");

  if (!fs.existsSync(packageJson) || !fs.existsSync(buildAndInstall)) {
    throw new Error(
      `Tamandua source checkout not found at ${sourcePath}. Expected package.json and build-and-install.`,
    );
  }
}

export function createDefaultUpdateServices(): UpdateServices {
  return {
    snapshot: () => ({
      daemon: normalizeServiceStatus(getDaemonStatus()),
      dashboard: normalizeServiceStatus(getDashboardStatus()),
      mcp: normalizeServiceStatus(getMcpStatus()),
    }),
    stopDaemon,
    stopDashboard: stopDashboardStandalone,
    stopMcp,
    startDaemon: (port) => startDaemon(port),
    startDashboard: (port) => startDashboardStandalone(port),
    startMcp: (port) => startMcp(port),
  };
}

function normalizeServiceStatus(status: { running: boolean; pid: number | null; port: number }): UpdateServiceStatus {
  if (status.running && typeof status.pid === "number") {
    return { running: true, pid: status.pid, port: status.port };
  }
  return { running: false, pid: null, port: status.port };
}

export const defaultRunCommand: RunCommand = (command, args, options) => (
  new Promise<RunCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    if (options.stdio === "pipe") {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
    }

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`Command failed (${suffix}): ${[command, ...args].join(" ")}`));
    });
  })
);

async function readGitHead(sourcePath: string, runCommand: RunCommand): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: sourcePath,
    stdio: "pipe",
  });
  const head = result.stdout.trim();
  if (!head) throw new Error("Unable to read git HEAD for Tamandua source checkout.");
  return head;
}

function formatActiveRuns(activeRuns: ActiveRunInfo[]): string {
  return activeRuns
    .map((run) => `  - ${run.id}: [${run.status}] ${run.task}`)
    .join("\n");
}

async function defaultWaitForProcessExit(pid: number, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function stopRunningServices(
  snapshot: UpdateServiceSnapshot,
  services: UpdateServices,
  output: UpdateOutput,
  waitForProcessExit: (pid: number) => Promise<void>,
): Promise<void> {
  const stoppedPids: number[] = [];

  // Stop daemon first (control-plane+motor), then dashboard, then MCP
  if (snapshot.daemon.running) {
    output.log(`Stopping daemon (PID ${snapshot.daemon.pid})...`);
    services.stopDaemon();
    stoppedPids.push(snapshot.daemon.pid);
  }
  if (snapshot.dashboard.running) {
    output.log(`Stopping dashboard (PID ${snapshot.dashboard.pid})...`);
    services.stopDashboard();
    stoppedPids.push(snapshot.dashboard.pid);
  }
  if (snapshot.mcp.running) {
    output.log(`Stopping standalone MCP server (PID ${snapshot.mcp.pid})...`);
    services.stopMcp();
    stoppedPids.push(snapshot.mcp.pid);
  }

  if (stoppedPids.length === 0) {
    output.log("No Tamandua services were running.");
    return;
  }

  await Promise.all(stoppedPids.map((pid) => waitForProcessExit(pid)));
}

async function restartPreviouslyRunningServices(
  snapshot: UpdateServiceSnapshot,
  services: UpdateServices,
  output: UpdateOutput,
): Promise<void> {
  const failures: string[] = [];

  // Start daemon first (control-plane+motor), then dashboard, then MCP
  if (snapshot.daemon.running) {
    try {
      const started = await services.startDaemon(snapshot.daemon.port);
      output.log(`Daemon (control-plane+motor) restarted on port ${started.port} (PID ${started.pid}).`);
    } catch (err) {
      failures.push(`daemon: ${err instanceof Error ? err.message : String(err)} (recover: tamandua daemon restart)`);
    }
  }

  if (snapshot.dashboard.running) {
    try {
      const started = await services.startDashboard(snapshot.dashboard.port);
      output.log(`Dashboard restarted on port ${started.port} (PID ${started.pid}).`);
    } catch (err) {
      failures.push(`dashboard: ${err instanceof Error ? err.message : String(err)} (recover: tamandua dashboard restart)`);
    }
  }

  if (snapshot.mcp.running) {
    try {
      const started = await services.startMcp(snapshot.mcp.port);
      output.log(`Standalone MCP restarted on port ${started.port} (PID ${started.pid}).`);
    } catch (err) {
      failures.push(`mcp: ${err instanceof Error ? err.message : String(err)} (recover: tamandua mcp restart)`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to restart service(s): ${failures.join("; ")}`);
  }
}

export async function installAllBundledWorkflowsForUpdate(options: {
  output?: UpdateOutput;
  listWorkflows?: () => Promise<string[]>;
  installWorkflowById?: (workflowId: string) => Promise<unknown>;
} = {}): Promise<string[]> {
  const output = options.output ?? defaultOutput;
  const workflowIds = await (options.listWorkflows ?? listBundledWorkflows)();

  if (workflowIds.length === 0) {
    output.log("No bundled workflows found.");
    return [];
  }

  output.log(`Installing ${workflowIds.length} bundled workflow(s)...`);
  const failures: string[] = [];
  const installOne = options.installWorkflowById ?? ((workflowId: string) => installWorkflow({ workflowId }));

  for (const workflowId of workflowIds) {
    try {
      await installOne(workflowId);
      output.log(`  installed ${workflowId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${workflowId}: ${message}`);
      output.warn(`  failed ${workflowId}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to install bundled workflow(s): ${failures.join("; ")}`);
  }

  // Record catalog stamp so staleness checks can detect outdated installed prompts
  writeCatalogStamp(resolveSourcePath());

  return workflowIds;
}

export async function runUpdate(options: RunUpdateOptions = {}): Promise<UpdateResult> {
  const output = options.output ?? defaultOutput;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const sourcePath = options.sourcePath ?? resolveSourcePath();
  const services = options.services ?? createDefaultUpdateServices();
  const waitForProcessExit = options.waitForProcessExit ?? defaultWaitForProcessExit;
  const checkRuns = options.checkActiveRuns ?? checkActiveRuns;

  assertSourceCheckout(sourcePath);

  const beforeHead = await readGitHead(sourcePath, runCommand);
  output.log(`Tamandua source: ${sourcePath}`);
  output.log("Pulling latest changes...");
  await runCommand("git", ["pull"], { cwd: sourcePath, stdio: "inherit" });

  const afterHead = await readGitHead(sourcePath, runCommand);
  if (beforeHead === afterHead) {
    if (!options.force) {
      output.log(`No source changes after git pull; already at ${shortHead(afterHead)}.`);
      output.log("Skipping build, workflow install, and service restart.");
      await runVersionCheck();
      return { status: "no_change", sourcePath, head: afterHead };
    }
    output.log(`No source changes after git pull (at ${shortHead(afterHead)}), but --force set; rebuilding anyway.`);
  } else {
    output.log(`Source updated: ${shortHead(beforeHead)} -> ${shortHead(afterHead)}.`);
  }
  output.log("Running ./build-and-install...");
  await runCommand("./build-and-install", [], { cwd: sourcePath, stdio: "inherit" });

  const serviceSnapshot = services.snapshot();
  const activeRuns = await checkRuns();
  if (activeRuns.length > 0 && !options.force) {
    output.warn(
      `Active Tamandua runs detected (${activeRuns.length}). Leaving services and workflows unchanged.\n` +
      `${formatActiveRuns(activeRuns)}\n\n` +
      "Run `tamandua update --force` to continue despite active runs.",
    );
    await runVersionCheck();
    return {
      status: "blocked_active_runs",
      sourcePath,
      beforeHead,
      afterHead,
      activeRuns,
    };
  }

  if (activeRuns.length > 0 && options.force) {
    const runningRuns = activeRuns.filter(r => r.status === "running");
    output.warn(
      `Active Tamandua runs detected (${activeRuns.length}); --force set, continuing.\n` +
      formatActiveRuns(activeRuns),
    );
    if (runningRuns.length > 0) {
      output.warn(
        `In-flight workers for ${runningRuns.length} running run(s) will be rugpulled and requeued: ` +
        runningRuns.map(r => r.id).join(", "),
      );
    }
  }

  await stopRunningServices(serviceSnapshot, services, output, waitForProcessExit);

  let installedWorkflows: string[] = [];
  try {
    installedWorkflows = await installAllBundledWorkflowsForUpdate({
      output,
      listWorkflows: options.listWorkflows,
      installWorkflowById: options.installWorkflowById,
    });
  } finally {
    await restartPreviouslyRunningServices(serviceSnapshot, services, output);
  }

  output.log("Tamandua update complete.");
  await runVersionCheck();
  return {
    status: "updated",
    sourcePath,
    beforeHead,
    afterHead,
    services: serviceSnapshot,
    installedWorkflows,
  };
}
