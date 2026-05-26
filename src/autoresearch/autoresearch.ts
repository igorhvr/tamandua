import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type AutoresearchDirection = "lower" | "higher";
export type AutoresearchDecision = "baseline" | "keep" | "discard" | "crash" | "checks_failed";
export type AutoresearchRunStatus = "measured" | "crash" | "checks_failed";

export type AutoresearchSessionConfig = {
  goal: string;
  metricName: string;
  metricUnit?: string;
  direction: AutoresearchDirection;
  command: string;
  metricRegex?: string;
  checksCommand?: string;
  maxOutputBytes?: number;
};

export type AutoresearchPaths = {
  cwd: string;
  configFile: string;
  markdownFile: string;
  logFile: string;
  runScript: string;
  checksScript: string;
  hooksDir: string;
};

export type AutoresearchRunEntry = {
  type: "run";
  run: number;
  created_at: string;
  status: AutoresearchDecision;
  metric: number | null;
  metric_name: string;
  metric_unit?: string;
  direction: AutoresearchDirection;
  duration_ms?: number;
  command?: string;
  description: string;
  commit_before?: string;
  commit_after?: string;
  baseline_metric: number | null;
  best_metric: number | null;
  improvement_ratio: number | null;
  output_tail?: string;
  error_tail?: string;
  asi?: {
    hypothesis?: string;
    learned?: string;
    next_focus?: string;
  };
};

export type AutoresearchRunResultEntry = {
  type: "run_result";
  run: number;
  created_at: string;
  status: AutoresearchRunStatus;
  metric: number | null;
  metric_name: string;
  metric_unit?: string;
  direction: AutoresearchDirection;
  duration_ms: number;
  exit_code: number | null;
  command: string;
  commit_before?: string;
  output_tail: string;
  error_tail: string;
  checks?: {
    command: string;
    exit_code: number | null;
    duration_ms: number;
    output_tail: string;
    error_tail: string;
  };
};

export type AutoresearchSessionEntry = {
  type: "session";
  created_at: string;
  goal: string;
  metric_name: string;
  metric_unit?: string;
  direction: AutoresearchDirection;
  command: string;
  metric_regex?: string;
  checks_command?: string;
};

export type AutoresearchLogEntry = AutoresearchSessionEntry | AutoresearchRunResultEntry | AutoresearchRunEntry;

export type AutoresearchSummary = {
  exists: boolean;
  goal?: string;
  metricName?: string;
  metricUnit?: string;
  direction?: AutoresearchDirection;
  command?: string;
  totalRuns: number;
  measuredRuns: number;
  keptRuns: number;
  discardedRuns: number;
  crashedRuns: number;
  checksFailedRuns: number;
  baselineMetric: number | null;
  bestMetric: number | null;
  bestRun: number | null;
  lastRun?: AutoresearchRunEntry | AutoresearchRunResultEntry;
  nextPrompt: string;
};

export type InitExperimentOptions = AutoresearchSessionConfig & {
  cwd?: string;
  overwrite?: boolean;
};

export type RunExperimentOptions = {
  cwd?: string;
  command?: string;
  metricRegex?: string;
  checksCommand?: string;
  timeoutMs?: number;
};

export type LogExperimentOptions = {
  cwd?: string;
  metric?: number;
  status?: AutoresearchDecision | "auto";
  description: string;
  hypothesis?: string;
  learned?: string;
  nextFocus?: string;
  commit?: boolean;
  revertDiscard?: boolean;
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

const DEFAULT_MAX_OUTPUT_BYTES = 12000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function getAutoresearchPaths(cwd = process.cwd()): AutoresearchPaths {
  const root = path.resolve(cwd);
  return {
    cwd: root,
    configFile: path.join(root, "autoresearch.config.json"),
    markdownFile: path.join(root, "autoresearch.md"),
    logFile: path.join(root, "autoresearch.jsonl"),
    runScript: path.join(root, "autoresearch.sh"),
    checksScript: path.join(root, "autoresearch.checks.sh"),
    hooksDir: path.join(root, "autoresearch.hooks"),
  };
}

export function findAutoresearchSessionCwd(cwd = process.cwd(), options: { maxDepth?: number; maxDirs?: number } = {}): string | undefined {
  const root = path.resolve(cwd);
  const maxDepth = options.maxDepth ?? 2;
  const maxDirs = options.maxDirs ?? 200;
  const skip = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__"]);
  const candidates: Array<{ cwd: string; mtimeMs: number }> = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && visited < maxDirs) {
    const item = stack.shift()!;
    visited++;

    const paths = getAutoresearchPaths(item.dir);
    if (fs.existsSync(paths.configFile)) {
      const statPath = fs.existsSync(paths.logFile) ? paths.logFile : paths.configFile;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(statPath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      candidates.push({ cwd: item.dir, mtimeMs });
      continue;
    }

    if (item.depth >= maxDepth) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skip.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".workspace") continue;
      stack.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.cwd;
}

export function readSessionConfig(cwd = process.cwd()): AutoresearchSessionConfig {
  const paths = getAutoresearchPaths(cwd);
  if (!fs.existsSync(paths.configFile)) {
    throw new Error(`No autoresearch session found at ${paths.configFile}. Run: tamandua autoresearch init`);
  }
  const raw = JSON.parse(fs.readFileSync(paths.configFile, "utf-8")) as Partial<AutoresearchSessionConfig>;
  if (!raw.goal || !raw.metricName || !raw.direction || !raw.command) {
    throw new Error(`Invalid autoresearch config at ${paths.configFile}.`);
  }
  if (raw.direction !== "lower" && raw.direction !== "higher") {
    throw new Error(`Invalid autoresearch direction "${raw.direction}". Use "lower" or "higher".`);
  }
  return {
    goal: raw.goal,
    metricName: raw.metricName,
    metricUnit: raw.metricUnit,
    direction: raw.direction,
    command: raw.command,
    metricRegex: raw.metricRegex,
    checksCommand: raw.checksCommand,
    maxOutputBytes: raw.maxOutputBytes,
  };
}

export function readAutoresearchLog(cwd = process.cwd()): AutoresearchLogEntry[] {
  const paths = getAutoresearchPaths(cwd);
  if (!fs.existsSync(paths.logFile)) return [];
  const lines = fs.readFileSync(paths.logFile, "utf-8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line) as AutoresearchLogEntry;
    } catch (err) {
      throw new Error(`Invalid JSON in ${paths.logFile} at line ${idx + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function initExperiment(options: InitExperimentOptions): AutoresearchSessionEntry {
  const paths = getAutoresearchPaths(options.cwd);
  fs.mkdirSync(paths.cwd, { recursive: true });

  if (!options.overwrite) {
    for (const file of [paths.configFile, paths.markdownFile, paths.logFile, paths.runScript]) {
      if (fs.existsSync(file)) {
        throw new Error(`Refusing to overwrite existing ${path.basename(file)}. Pass --overwrite to replace the session.`);
      }
    }
  }

  validateDirection(options.direction);
  const config: AutoresearchSessionConfig = {
    goal: options.goal,
    metricName: options.metricName,
    metricUnit: options.metricUnit,
    direction: options.direction,
    command: options.command,
    metricRegex: options.metricRegex,
    checksCommand: options.checksCommand,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };

  fs.writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + "\n");
  fs.writeFileSync(paths.runScript, `#!/usr/bin/env bash\nset -euo pipefail\n${options.command}\n`);
  fs.chmodSync(paths.runScript, 0o755);
  if (options.checksCommand) {
    fs.writeFileSync(paths.checksScript, `#!/usr/bin/env bash\nset -euo pipefail\n${options.checksCommand}\n`);
    fs.chmodSync(paths.checksScript, 0o755);
  }

  const markdown = [
    "# AutoResearch",
    "",
    `Goal: ${options.goal}`,
    `Metric: ${options.metricName}${options.metricUnit ? ` (${options.metricUnit})` : ""}`,
    `Direction: ${options.direction}`,
    `Command: ${options.command}`,
    "",
    "## Operating Loop",
    "",
    "1. Inspect `autoresearch.jsonl`, the current best result, and the previous learning.",
    "2. Choose one narrow hypothesis for the next experiment.",
    "3. Edit only the files needed for that hypothesis.",
    "4. Run `tamandua autoresearch run`.",
    "5. Run `tamandua autoresearch log --status auto --description ... --hypothesis ... --learned ... --next-focus ...`.",
    "6. Use the logged keep/discard result to define the next experiment.",
    "",
    "The loop is a ratchet: every iteration must learn from measured evidence before proposing the next experiment.",
    "",
  ].join("\n");
  fs.writeFileSync(paths.markdownFile, markdown);

  const entry: AutoresearchSessionEntry = {
    type: "session",
    created_at: new Date().toISOString(),
    goal: options.goal,
    metric_name: options.metricName,
    metric_unit: options.metricUnit,
    direction: options.direction,
    command: options.command,
    metric_regex: options.metricRegex,
    checks_command: options.checksCommand,
  };
  fs.writeFileSync(paths.logFile, JSON.stringify(entry) + "\n");
  return entry;
}

export async function runExperiment(options: RunExperimentOptions = {}): Promise<AutoresearchRunResultEntry> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const paths = getAutoresearchPaths(cwd);
  const config = readSessionConfig(cwd);
  const entries = readAutoresearchLog(cwd);
  const run = nextRunNumber(entries);
  const command = options.command ?? config.command;
  const metricRegex = options.metricRegex ?? config.metricRegex;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  await runHook(paths, "before", buildHookPayload("before", cwd, entries, undefined));
  const commitBefore = readGitHead(cwd);
  const result = await runCommand(command, cwd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const metric = result.exitCode === 0 ? parseMetric(result.stdout + "\n" + result.stderr, config.metricName, metricRegex) : null;

  let status: AutoresearchRunStatus = result.exitCode === 0 && metric !== null ? "measured" : "crash";
  let checks: AutoresearchRunResultEntry["checks"] | undefined;
  const checksCommand = options.checksCommand ?? config.checksCommand ?? (fs.existsSync(paths.checksScript) ? paths.checksScript : undefined);
  if (status === "measured" && checksCommand) {
    const checksResult = await runCommand(checksCommand, cwd, DEFAULT_TIMEOUT_MS);
    checks = {
      command: checksCommand,
      exit_code: checksResult.exitCode,
      duration_ms: checksResult.durationMs,
      output_tail: tail(checksResult.stdout, maxOutputBytes),
      error_tail: tail(checksResult.stderr, maxOutputBytes),
    };
    if (checksResult.exitCode !== 0) status = "checks_failed";
  }

  const entry: AutoresearchRunResultEntry = {
    type: "run_result",
    run,
    created_at: new Date().toISOString(),
    status,
    metric,
    metric_name: config.metricName,
    metric_unit: config.metricUnit,
    direction: config.direction,
    duration_ms: result.durationMs,
    exit_code: result.exitCode,
    command,
    commit_before: commitBefore,
    output_tail: tail(result.stdout, maxOutputBytes),
    error_tail: tail(result.stderr, maxOutputBytes),
    checks,
  };
  appendLogEntry(paths, entry);
  return entry;
}

export async function logExperiment(options: LogExperimentOptions): Promise<AutoresearchRunEntry> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const paths = getAutoresearchPaths(cwd);
  const config = readSessionConfig(cwd);
  const entries = readAutoresearchLog(cwd);
  const latestResult = [...entries].reverse().find((entry): entry is AutoresearchRunResultEntry => entry.type === "run_result");
  const run = latestResult?.run ?? nextRunNumber(entries);
  const metric = options.metric ?? latestResult?.metric ?? null;
  const rawStatus = options.status ?? "auto";
  const status = rawStatus === "auto"
    ? decideStatus(entries, metric, latestResult?.status)
    : rawStatus;

  const priorRunEntries = entries.filter((entry): entry is AutoresearchRunEntry => entry.type === "run");
  const baselineMetric = findBaselineMetric(priorRunEntries) ?? (status === "baseline" ? metric : null);
  const bestMetric = findBestMetric(priorRunEntries, config.direction);
  const nextBestMetric = metric !== null && (status === "baseline" || status === "keep")
    ? selectBestMetric(bestMetric, metric, config.direction)
    : bestMetric;

  let commitAfter: string | undefined;
  if (options.commit && (status === "baseline" || status === "keep")) {
    commitAfter = commitAutoresearchResult(cwd, run, options.description);
  }
  if (options.revertDiscard && status === "discard") {
    revertExperimentChanges(cwd);
  }

  const entry: AutoresearchRunEntry = {
    type: "run",
    run,
    created_at: new Date().toISOString(),
    status,
    metric,
    metric_name: config.metricName,
    metric_unit: config.metricUnit,
    direction: config.direction,
    duration_ms: latestResult?.duration_ms,
    command: latestResult?.command ?? config.command,
    description: options.description,
    commit_before: latestResult?.commit_before,
    commit_after: commitAfter,
    baseline_metric: baselineMetric,
    best_metric: nextBestMetric,
    improvement_ratio: calculateImprovementRatio(baselineMetric, metric, config.direction),
    output_tail: latestResult?.output_tail,
    error_tail: latestResult?.error_tail,
    asi: {
      hypothesis: options.hypothesis,
      learned: options.learned,
      next_focus: options.nextFocus,
    },
  };
  appendLogEntry(paths, entry);
  await runHook(paths, "after", buildHookPayload("after", cwd, [...entries, entry], entry));
  await runHook(paths, "before", buildHookPayload("before", cwd, [...entries, entry], undefined));
  return entry;
}

export function summarizeAutoresearch(cwd = process.cwd()): AutoresearchSummary {
  const paths = getAutoresearchPaths(cwd);
  if (!fs.existsSync(paths.configFile)) {
    return {
      exists: false,
      totalRuns: 0,
      measuredRuns: 0,
      keptRuns: 0,
      discardedRuns: 0,
      crashedRuns: 0,
      checksFailedRuns: 0,
      baselineMetric: null,
      bestMetric: null,
      bestRun: null,
      nextPrompt: "No AutoResearch session found. Run `tamandua autoresearch init` first.",
    };
  }

  const config = readSessionConfig(cwd);
  const entries = readAutoresearchLog(cwd);
  const runs = entries.filter((entry): entry is AutoresearchRunEntry => entry.type === "run");
  const results = entries.filter((entry): entry is AutoresearchRunResultEntry => entry.type === "run_result");
  const baselineMetric = findBaselineMetric(runs);
  const best = findBestRun(runs, config.direction);
  const lastRun = [...entries].reverse().find((entry): entry is AutoresearchRunEntry | AutoresearchRunResultEntry => entry.type === "run" || entry.type === "run_result");

  return {
    exists: true,
    goal: config.goal,
    metricName: config.metricName,
    metricUnit: config.metricUnit,
    direction: config.direction,
    command: config.command,
    totalRuns: runs.length,
    measuredRuns: results.filter((entry) => entry.status === "measured").length,
    keptRuns: runs.filter((entry) => entry.status === "baseline" || entry.status === "keep").length,
    discardedRuns: runs.filter((entry) => entry.status === "discard").length,
    crashedRuns: runs.filter((entry) => entry.status === "crash").length + results.filter((entry) => entry.status === "crash").length,
    checksFailedRuns: runs.filter((entry) => entry.status === "checks_failed").length + results.filter((entry) => entry.status === "checks_failed").length,
    baselineMetric,
    bestMetric: best?.metric ?? null,
    bestRun: best?.run ?? null,
    lastRun,
    nextPrompt: buildNextPrompt(config, runs, best),
  };
}

export function parseMetric(output: string, metricName: string, metricRegex?: string): number | null {
  const regexes = [
    metricRegex ? new RegExp(metricRegex, "m") : undefined,
    new RegExp(`${escapeRegExp(metricName)}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "i"),
    /(?:metric|score|loss|result)\s*[:=]\s*(-?\d+(?:\.\d+)?)/i,
  ].filter((item): item is RegExp => Boolean(item));

  for (const regex of regexes) {
    const match = output.match(regex);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function decideStatus(
  entries: AutoresearchLogEntry[],
  metric: number | null,
  runStatus: AutoresearchRunStatus | undefined,
): AutoresearchDecision {
  if (runStatus === "crash") return "crash";
  if (runStatus === "checks_failed") return "checks_failed";
  if (metric === null) return "crash";
  const configEntry = entries.find((entry): entry is AutoresearchSessionEntry => entry.type === "session");
  const direction = configEntry?.direction ?? "lower";
  const priorRuns = entries.filter((entry): entry is AutoresearchRunEntry => entry.type === "run");
  if (priorRuns.length === 0 || findBaselineMetric(priorRuns) === null) return "baseline";
  const bestMetric = findBestMetric(priorRuns, direction);
  if (bestMetric === null) return "keep";
  return isImprovement(metric, bestMetric, direction) ? "keep" : "discard";
}

function appendLogEntry(paths: AutoresearchPaths, entry: AutoresearchLogEntry): void {
  fs.appendFileSync(paths.logFile, JSON.stringify(entry) + "\n");
}

function validateDirection(direction: AutoresearchDirection): void {
  if (direction !== "lower" && direction !== "higher") {
    throw new Error(`Invalid direction "${direction}". Use "lower" or "higher".`);
  }
}

function nextRunNumber(entries: AutoresearchLogEntry[]): number {
  const runs = entries
    .filter((entry): entry is AutoresearchRunEntry | AutoresearchRunResultEntry => entry.type === "run" || entry.type === "run_result")
    .map((entry) => entry.run);
  return runs.length === 0 ? 1 : Math.max(...runs) + 1;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: timedOut ? null : code, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ exitCode: null, stdout, stderr: stderr + err.message, durationMs: Date.now() - started, timedOut });
    });
  });
}

function tail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf-8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(buffer.length - maxBytes).toString("utf-8");
}

function findBaselineMetric(runs: AutoresearchRunEntry[]): number | null {
  const baseline = runs.find((entry) => entry.status === "baseline" && entry.metric !== null);
  return baseline?.metric ?? null;
}

function findBestMetric(runs: AutoresearchRunEntry[], direction: AutoresearchDirection): number | null {
  return findBestRun(runs, direction)?.metric ?? null;
}

function findBestRun(runs: AutoresearchRunEntry[], direction: AutoresearchDirection): AutoresearchRunEntry | undefined {
  const candidates = runs.filter((entry) =>
    (entry.status === "baseline" || entry.status === "keep") && entry.metric !== null,
  );
  return candidates.reduce<AutoresearchRunEntry | undefined>((best, entry) => {
    if (!best || isImprovement(entry.metric as number, best.metric as number, direction)) return entry;
    return best;
  }, undefined);
}

function selectBestMetric(current: number | null, next: number, direction: AutoresearchDirection): number {
  if (current === null) return next;
  return isImprovement(next, current, direction) ? next : current;
}

function isImprovement(candidate: number, current: number, direction: AutoresearchDirection): boolean {
  return direction === "lower" ? candidate < current : candidate > current;
}

function calculateImprovementRatio(baseline: number | null, metric: number | null, direction: AutoresearchDirection): number | null {
  if (baseline === null || metric === null || baseline === 0) return null;
  return direction === "lower" ? baseline / metric : metric / baseline;
}

function readGitHead(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function commitAutoresearchResult(cwd: string, run: number, description: string): string | undefined {
  const add = spawnSync("git", ["add", "-A"], { cwd, encoding: "utf-8" });
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const message = `autoresearch: keep run ${run}\n\n${description}`;
  const commit = spawnSync("git", ["commit", "-m", message], { cwd, encoding: "utf-8" });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  return readGitHead(cwd);
}

function revertExperimentChanges(cwd: string): void {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8" });
  if (status.status !== 0) throw new Error(`git status failed: ${status.stderr}`);
  const protectedNames = new Set([
    "autoresearch.config.json",
    "autoresearch.md",
    "autoresearch.jsonl",
    "autoresearch.sh",
    "autoresearch.checks.sh",
  ]);
  const trackedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const porcelainStatus = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const file = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
    if (!file || protectedNames.has(file) || file.startsWith("autoresearch.hooks/")) continue;
    if (porcelainStatus === "??") untrackedPaths.push(file);
    else trackedPaths.push(file);
  }
  if (trackedPaths.length > 0) {
    const restore = spawnSync("git", ["restore", "--staged", "--worktree", "--", ...trackedPaths], { cwd, encoding: "utf-8" });
    if (restore.status !== 0) throw new Error(`git restore failed: ${restore.stderr}`);
  }
  if (untrackedPaths.length > 0) {
    const clean = spawnSync("git", ["clean", "-fd", "--", ...untrackedPaths], { cwd, encoding: "utf-8" });
    if (clean.status !== 0) throw new Error(`git clean failed: ${clean.stderr}`);
  }
}

function buildNextPrompt(config: AutoresearchSessionConfig, runs: AutoresearchRunEntry[], best: AutoresearchRunEntry | undefined): string {
  const last = runs.at(-1);
  const learned = last?.asi?.learned || last?.description || "No completed experiments yet.";
  const nextFocus = last?.asi?.next_focus || "Choose the smallest experiment that can improve the target metric.";
  const bestText = best ? `Best run ${best.run}: ${best.metric} ${config.metricUnit ?? ""} (${best.description})` : "No accepted best run yet.";
  return [
    `Goal: ${config.goal}`,
    bestText,
    `Last learning: ${learned}`,
    `Next focus: ${nextFocus}`,
    "Before editing, state one hypothesis. After measuring, log what changed, what was learned, and the next focus.",
  ].join("\n");
}

function buildHookPayload(
  event: "before" | "after",
  cwd: string,
  entries: AutoresearchLogEntry[],
  runEntry: AutoresearchRunEntry | undefined,
): Record<string, unknown> {
  const config = entries.find((entry): entry is AutoresearchSessionEntry => entry.type === "session");
  const runs = entries.filter((entry): entry is AutoresearchRunEntry => entry.type === "run");
  const best = config ? findBestRun(runs, config.direction) : undefined;
  return {
    event,
    cwd,
    next_run: nextRunNumber(entries),
    run_entry: runEntry,
    last_run: runs.at(-1) ?? null,
    session: config
      ? {
          metric_name: config.metric_name,
          metric_unit: config.metric_unit,
          direction: config.direction,
          baseline_metric: findBaselineMetric(runs),
          best_metric: best?.metric ?? null,
          run_count: runs.length,
          goal: config.goal,
        }
      : null,
  };
}

async function runHook(paths: AutoresearchPaths, name: "before" | "after", payload: Record<string, unknown>): Promise<void> {
  const hookPath = path.join(paths.hooksDir, `${name}.sh`);
  if (!fs.existsSync(hookPath)) return;
  const stat = fs.statSync(hookPath);
  if ((stat.mode & 0o111) === 0) return;
  await new Promise<void>((resolve) => {
    const child = spawn(hookPath, { cwd: paths.cwd, stdio: ["pipe", "ignore", "ignore"] });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.stdin?.end(JSON.stringify(payload) + "\n");
    child.on("close", () => { clearTimeout(timeout); resolve(); });
    child.on("error", () => { clearTimeout(timeout); resolve(); });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
