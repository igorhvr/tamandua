import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parsePiOutputStream } from "../installer/pi-stream-parser.js";

export type AutoresearchDirection = "lower" | "higher";
export type AutoresearchDecision = "baseline" | "keep" | "discard" | "crash" | "checks_failed";
export type AutoresearchRunStatus = "measured" | "crash" | "checks_failed";
export type AutoresearchConfidenceBand = "high" | "medium" | "low" | "unknown";

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
  confidence_score: number | null;
  confidence_band: AutoresearchConfidenceBand;
  noise_floor_mad: number | null;
  confidence_sample_count: number;
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
  confidence_score: number | null;
  confidence_band: AutoresearchConfidenceBand;
  noise_floor_mad: number | null;
  confidence_sample_count: number;
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

export type RunLoopIterationOptions = {
  cwd?: string;
  prompt?: string;
  command?: string;
  timeoutSeconds?: number;
  description?: string;
  iteration?: number;
};

export type RunLoopIterationResult = {
  run: number;
  status: AutoresearchDecision;
  metric: number | null;
  agentSuccess: boolean;
  committed: boolean;
  reverted: boolean;
  logEntry: AutoresearchRunEntry;
};

export type LoopAutoresearchOptions = {
  cwd?: string;
  targetMetric?: number;
  maxIterations?: number;
  maxConsecutiveFailures?: number;
  actionMode?: "measure-only" | "prompt";
  /** Per-pi-action timeout in seconds (default: 300 = 5 minutes). */
  timeoutSeconds?: number;
};

export type LoopAutoresearchResult = {
  iterations: number;
  bestMetric: number | null;
  bestRun: number | null;
  allTimeBestMetric: number | null;
  allTimeBestRun: number | null;
  kept: number;
  discarded: number;
  crashed: number;
  checksFailed: number;
  stopReason: string;
  cancelled: boolean;
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

export const PROTECTED_AUTORESEARCH_FILE_NAMES = new Set([
  "autoresearch.config.json",
  "autoresearch.md",
  "autoresearch.jsonl",
  "autoresearch.sh",
  "autoresearch.checks.sh",
]);

export function isAutoresearchProtectedFile(file: string): boolean {
  return PROTECTED_AUTORESEARCH_FILE_NAMES.has(file) || file.startsWith("autoresearch.hooks/");
}

export function hasDirtyNonAutoresearchFiles(cwd = process.cwd()): { dirty: boolean; dirtyFiles: string[] } {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8" });
  if (status.status !== 0) {
    // Not a git repo — no dirty files
    if (status.stderr?.includes("not a git repository")) return { dirty: false, dirtyFiles: [] };
    throw new Error(`git status failed: ${status.stderr}`);
  }
  const dirtyFiles: string[] = [];
  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rawPath = line.slice(3).trim();
    const file = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
    if (!file || isAutoresearchProtectedFile(file)) continue;
    dirtyFiles.push(file);
  }
  return { dirty: dirtyFiles.length > 0, dirtyFiles };
}

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
    "4. Run `tamandua autoresearch run-experiment`.",
    "5. Run `tamandua autoresearch log-experiment --status auto --description ... --hypothesis ... --learned ... --next-focus ...`.",
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
    confidence_score: null,
    confidence_band: "unknown",
    noise_floor_mad: null,
    confidence_sample_count: 0,
    output_tail: latestResult?.output_tail,
    error_tail: latestResult?.error_tail,
    asi: {
      hypothesis: options.hypothesis,
      learned: options.learned,
      next_focus: options.nextFocus,
    },
  };
  const confidence = calculateAutoresearchConfidence([...entries, entry], config.direction);
  entry.confidence_score = confidence.confidence_score;
  entry.confidence_band = confidence.confidence_band;
  entry.noise_floor_mad = confidence.noise_floor_mad;
  entry.confidence_sample_count = confidence.confidence_sample_count;
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
      confidence_score: null,
      confidence_band: "unknown",
      noise_floor_mad: null,
      confidence_sample_count: 0,
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
  const confidence = calculateAutoresearchConfidence(entries, config.direction);

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
    confidence_score: confidence.confidence_score,
    confidence_band: confidence.confidence_band,
    noise_floor_mad: confidence.noise_floor_mad,
    confidence_sample_count: confidence.confidence_sample_count,
    lastRun,
    nextPrompt: buildNextPrompt(config, runs, best, confidence),
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

export type AutoresearchConfidence = Pick<
  AutoresearchRunEntry,
  "confidence_score" | "confidence_band" | "noise_floor_mad" | "confidence_sample_count"
>;

export function calculateAutoresearchConfidence(
  entries: AutoresearchLogEntry[],
  direction?: AutoresearchDirection,
): AutoresearchConfidence {
  const configEntry = entries.find((entry): entry is AutoresearchSessionEntry => entry.type === "session");
  const resolvedDirection = direction ?? configEntry?.direction ?? "lower";
  const runs = entries.filter((entry): entry is AutoresearchRunEntry => entry.type === "run");
  const numericRuns = runs.filter((entry) =>
    typeof entry.metric === "number" &&
    Number.isFinite(entry.metric) &&
    entry.metric > 0,
  );
  const sampleCount = numericRuns.length;
  if (sampleCount < 3) return unknownConfidence(sampleCount);

  const baseline = numericRuns[0];
  if (!baseline || baseline.metric === null) return unknownConfidence(sampleCount);

  const kept = numericRuns.filter((entry) => entry.status === "keep");
  const best = kept.reduce<AutoresearchRunEntry | undefined>((currentBest, entry) => {
    if (!currentBest || isImprovement(entry.metric as number, currentBest.metric as number, resolvedDirection)) return entry;
    return currentBest;
  }, undefined);
  if (!best || best.metric === null || best.metric === baseline.metric) return unknownConfidence(sampleCount);

  const values = numericRuns.map((entry) => entry.metric as number);
  const valueMedian = median(values);
  const mad = median(values.map((value) => Math.abs(value - valueMedian)));
  const improvement = Math.abs(
    resolvedDirection === "lower"
      ? (baseline.metric as number) - (best.metric as number)
      : (best.metric as number) - (baseline.metric as number),
  );

  if (mad === 0) return unknownConfidence(sampleCount, 0);

  const score = improvement / mad;
  return {
    confidence_score: score,
    confidence_band: confidenceBand(score),
    noise_floor_mad: mad,
    confidence_sample_count: sampleCount,
  };
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

export function commitAutoresearchResult(cwd: string, run: number, description: string): string | undefined {
  const add = spawnSync("git", ["add", "-A"], { cwd, encoding: "utf-8" });
  if (add.status !== 0) {
    // Not a git repo — skip commit
    if (add.stderr?.includes("not a git repository")) return undefined;
    throw new Error(`git add failed: ${add.stderr}`);
  }
  // Unstage protected AutoResearch files so they are never committed
  const protectedResetPaths = [...PROTECTED_AUTORESEARCH_FILE_NAMES, "autoresearch.hooks"];
  const reset = spawnSync("git", ["reset", "--", ...protectedResetPaths], { cwd, encoding: "utf-8" });
  if (reset.status !== 0) throw new Error(`git reset (autoresearch files) failed: ${reset.stderr}`);
  const message = `autoresearch: keep run ${run}\n\n${description}`;
  const commit = spawnSync("git", ["commit", "-m", message], { cwd, encoding: "utf-8" });
  if (commit.status !== 0) {
    const err = `${commit.stderr ?? ""}${commit.stdout ?? ""}`;
    // No non-autoresearch changes to commit — this is not an error
    if (err.includes("nothing to commit") || err.includes("nothing added to commit")) return undefined;
    throw new Error(`git commit failed: ${err}`);
  }
  return readGitHead(cwd);
}

function revertExperimentChanges(cwd: string): void {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8" });
  if (status.status !== 0) {
    // Not a git repo — nothing to revert
    if (status.stderr?.includes("not a git repository")) return;
    throw new Error(`git status failed: ${status.stderr}`);
  }
  const trackedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const porcelainStatus = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const file = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
    if (!file || isAutoresearchProtectedFile(file)) continue;
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

function buildNextPrompt(
  config: AutoresearchSessionConfig,
  runs: AutoresearchRunEntry[],
  best: AutoresearchRunEntry | undefined,
  confidence: AutoresearchConfidence = calculateAutoresearchConfidence(runs, config.direction),
): string {
  const last = runs.at(-1);
  const learned = last?.asi?.learned || last?.description || "No completed experiments yet.";
  const nextFocus = last?.asi?.next_focus || "Choose the smallest experiment that can improve the target metric.";
  const bestText = best ? `Best run ${best.run}: ${best.metric} ${config.metricUnit ?? ""} (${best.description})` : "No accepted best run yet.";
  const lines = [
    `Goal: ${config.goal}`,
    bestText,
    `Last learning: ${learned}`,
    `Next focus: ${nextFocus}`,
  ];
  if (confidence.confidence_score !== null) {
    if (confidence.confidence_band === "low") {
      lines.push("Confidence: low. Rerun or confirm the current best change before stacking more changes.");
    } else if (confidence.confidence_band === "medium") {
      lines.push("Confidence: medium. Validate the current best or narrow benchmark noise before making a larger change.");
    } else if (confidence.confidence_band === "high") {
      lines.push("Confidence: high. The current best is likely above the measured noise floor.");
    }
  }
  lines.push("Before editing, state one hypothesis. After measuring, log what changed, what was learned, and the next focus.");
  return lines.join("\n");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function unknownConfidence(sampleCount: number, noiseFloorMad: number | null = null): AutoresearchConfidence {
  return {
    confidence_score: null,
    confidence_band: "unknown",
    noise_floor_mad: noiseFloorMad,
    confidence_sample_count: sampleCount,
  };
}

function confidenceBand(score: number): AutoresearchConfidenceBand {
  if (score >= 2) return "high";
  if (score >= 1) return "medium";
  return "low";
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
  const confidence = calculateAutoresearchConfidence(entries, config?.direction);
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
          confidence_score: confidence.confidence_score,
          confidence_band: confidence.confidence_band,
          noise_floor_mad: confidence.noise_floor_mad,
          confidence_sample_count: confidence.confidence_sample_count,
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

export function parseAgentFields(text: string): { status: string; changes: string; hypothesis?: string; learned?: string; nextFocus?: string } | null {
  const statusMatch = text.match(/^STATUS:\s*(.+)$/m);
  if (!statusMatch) return null;
  const status = statusMatch[1].trim();
  const changesMatch = text.match(/^CHANGES:\s*(.+)$/m);
  const changes = changesMatch?.[1].trim() ?? "";
  const hypothesisMatch = text.match(/^HYPOTHESIS:\s*(.+)$/m);
  const hypothesis = hypothesisMatch?.[1].trim();
  const learnedMatch = text.match(/^LEARNED:\s*(.+)$/m);
  const learned = learnedMatch?.[1].trim();
  const nextFocusMatch = text.match(/^NEXT_FOCUS:\s*(.+)$/m);
  const nextFocus = nextFocusMatch?.[1].trim();
  return { status, changes, hypothesis, learned, nextFocus };
}

async function runPiAgent(cwd: string, prompt: string, timeoutMs = 300_000): Promise<{ success: boolean; stdout: string; stderr: string; hypothesis?: string; learned?: string; nextFocus?: string }> {
  return new Promise((resolve) => {
    const piCmd = "pi";
    const args = ["--print", "--no-session", "--mode", "json", prompt];
    const child = spawn(piCmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: { success: boolean; stdout: string; stderr: string; hypothesis?: string; learned?: string; nextFocus?: string }) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ success: false, stdout, stderr: `pi agent timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", async (code) => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/);
      const parsedStream = await parsePiOutputStream(lines);
      const assistantText = parsedStream.assistantText || (parsedStream.textFallback ?? "");
      const fields = parseAgentFields(assistantText);
      settle({
        success: code === 0 && fields?.status === "done",
        stdout,
        stderr,
        hypothesis: fields?.hypothesis,
        learned: fields?.learned,
        nextFocus: fields?.nextFocus,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({ success: false, stdout, stderr: String(err) });
    });
  });
}

export async function runLoopIteration(options: RunLoopIterationOptions = {}): Promise<RunLoopIterationResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const config = readSessionConfig(cwd);
  const entries = readAutoresearchLog(cwd);
  const baseRun = nextRunNumber(entries);

  // Phase 1: Optionally invoke pi agent
  let agentSuccess = false;
  let hypothesis: string | undefined;
  let learned: string | undefined;
  let nextFocus: string | undefined;
  let agentChanges = "";
  const dirtyBeforeAgent = hasDirtyNonAutoresearchFiles(cwd);

  if (options.prompt) {
    const timeoutMs = (options.timeoutSeconds ?? 300) * 1000;
    const agentResult = await runPiAgent(cwd, options.prompt, timeoutMs);

    // Parse agent output text so we can detect no_change even when
    // runPiAgent reports success=false (it only considers "done" as success).
    const lines = agentResult.stdout.split(/\r?\n/);
    const parsedStream = await parsePiOutputStream(lines);
    const agentText = parsedStream.assistantText || (parsedStream.textFallback ?? "");
    const fields = parseAgentFields(agentText);

    if (agentResult.success) {
      agentSuccess = true;
      hypothesis = agentResult.hypothesis;
      learned = agentResult.learned;
      nextFocus = agentResult.nextFocus;
      agentChanges = fields?.changes ?? "";
    }

    // Handle no_change: agent ran fine (exit code 0) but couldn't improve.
    // If files were dirtied by the agent, revert them regardless of whether
    // runPiAgent considered the invocation "successful".
    if (fields?.status === "no_change") {
      const dirtyAfterAgent = hasDirtyNonAutoresearchFiles(cwd);
      if (dirtyAfterAgent.dirty) {
        revertExperimentChanges(cwd);
      }
      return {
        run: baseRun,
        status: "crash",
        metric: null,
        agentSuccess: true, // agent ran fine but declared no_change
        committed: false,
        reverted: dirtyAfterAgent.dirty,
        logEntry: await logExperiment({
          cwd,
          status: "crash",
          description: options.description ?? `Loop iteration ${options.iteration ?? baseRun}: agent returned no_change but files were modified`,
          hypothesis: agentResult.hypothesis,
          learned: agentResult.learned,
          nextFocus: agentResult.nextFocus,
          revertDiscard: true,
        }),
      };
    }

    // Agent failed or timed out (and wasn't no_change) — revert any non-autoresearch changes made by the agent
    if (!agentResult.success) {
      const dirtyAfterAgent = hasDirtyNonAutoresearchFiles(cwd);
      if (dirtyAfterAgent.dirty) {
        revertExperimentChanges(cwd);
      }
      return {
        run: baseRun,
        status: "crash",
        metric: null,
        agentSuccess: false,
        committed: false,
        reverted: dirtyAfterAgent.dirty,
        logEntry: await logExperiment({
          cwd,
          status: "crash",
          description: options.description ?? `Loop iteration ${options.iteration ?? baseRun}: agent failed or timed out`,
          hypothesis: agentResult.hypothesis,
          learned: agentResult.learned,
          nextFocus: agentResult.nextFocus,
          revertDiscard: true,
        }),
      };
    }
  }

  // Phase 2: Run experiment
  const runResult = await runExperiment({ cwd, command: options.command });

  const description = options.description ?? `Loop iteration ${options.iteration ?? baseRun}: ${runResult.status === "measured" ? runResult.metric : runResult.status}`;

  // Phase 3: Log experiment with commit/revert behavior
  const logEntry = await logExperiment({
    cwd,
    status: "auto",
    description,
    hypothesis,
    learned,
    nextFocus,
    commit: true,
    revertDiscard: true,
  });

  // logExperiment's revertDiscard only handles status=discard.
  // Manually revert crash and checks_failed changes here.
  if (logEntry.status === "crash" || logEntry.status === "checks_failed") {
    revertExperimentChanges(cwd);
  }

  // Phase 4: Verify clean working tree
  const dirtyAfter = hasDirtyNonAutoresearchFiles(cwd);
  if (dirtyAfter.dirty) {
    throw new Error(
      `Working tree has dirty non-autoresearch files after runLoopIteration (run ${logEntry.run}): ${dirtyAfter.dirtyFiles.join(", ")}`,
    );
  }

  const keep = logEntry.status === "baseline" || logEntry.status === "keep";
  const discard = logEntry.status === "discard";

  return {
    run: logEntry.run,
    status: logEntry.status,
    metric: logEntry.metric,
    agentSuccess,
    committed: keep && Boolean(logEntry.commit_after),
    reverted: discard || logEntry.status === "crash" || logEntry.status === "checks_failed",
    logEntry,
  };
}

export async function loopAutoresearch(options: LoopAutoresearchOptions = {}): Promise<LoopAutoresearchResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const config = readSessionConfig(cwd);

  // Refuse to start if there are dirty non-autoresearch files (skip for non-git dirs)
  let dirtyBeforeLoop: { dirty: boolean; dirtyFiles: string[] } = { dirty: false, dirtyFiles: [] };
  try {
    dirtyBeforeLoop = hasDirtyNonAutoresearchFiles(cwd);
  } catch {
    // Not a git repo — no dirty files to worry about
  }
  if (dirtyBeforeLoop.dirty) {
    throw new Error(
      `Working tree has dirty non-autoresearch files. Clean them before starting the loop:\n  ${dirtyBeforeLoop.dirtyFiles.join("\n  ")}`,
    );
  }

  if (!options.actionMode) {
    throw new Error(
      "No action mode specified. Use --measure-only for repeated benchmarks (no optimization) or --prompt for pi-driven optimization.",
    );
  }

  const maxIterations = options.maxIterations ?? 20;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  const isMeasureOnly = options.actionMode === "measure-only";

  const initialSummary = summarizeAutoresearch(cwd);
  const allTimeBestMetric = initialSummary.bestMetric;
  const allTimeBestRun = initialSummary.bestRun;

  let bestMetric: number | null = null;
  let bestRun: number | null = null;
  let iterations = 0;
  let consecutiveFailures = 0;
  let kept = 0;
  let discarded = 0;
  let crashed = 0;
  let checksFailed = 0;
  let stopReason: string | null = null;
  let lastCompletedIteration = 0;
  let cancelled = false;

  const sigintHandler = () => {
    cancelled = true;
    process.stdout.write("\n");
    if (lastCompletedIteration > 0) {
      process.stdout.write(`\nCancelled after iteration ${lastCompletedIteration}/${maxIterations}.\n`);
      process.stdout.write(`Last completed: iteration ${lastCompletedIteration}\n`);
    } else {
      process.stdout.write(`\nCancelled before first iteration completed.\n`);
    }
    process.stdout.write(`autoresearch.jsonl is intact.\n`);
    process.exit(0);
  };

  process.on("SIGINT", sigintHandler);

  try {
    while (iterations < maxIterations) {
      iterations++;
      const summary = summarizeAutoresearch(cwd);
      const nextPromptLines = summary.nextPrompt.split("\n");
      const nextFocusLine = nextPromptLines.find((line) => line.startsWith("Next focus:"));
      const nextFocus = nextFocusLine?.replace("Next focus: ", "") ?? "Explore improvements";

      const modeLabel = isMeasureOnly ? "[measure-only]" : "[prompt]";
      process.stdout.write(`${modeLabel} [${iterations}/${maxIterations}] Focus: ${nextFocus.slice(0, 80)}${nextFocus.length > 80 ? "..." : ""}\n`);

      // Build agent prompt for prompt-mode iterations
      let agentPrompt: string | undefined;
      if (!isMeasureOnly) {
        process.stdout.write(`${modeLabel} [${iterations}/${maxIterations}] Invoking agent...\n`);
        const remainingIters = maxIterations - iterations;
        const targetMsg = options.targetMetric !== undefined
          ? `You have at most ${remainingIters} remaining iterations. Target: ${config.metricName} ${config.direction === "lower" ? "<=" : ">="} ${options.targetMetric}.`
          : `You have at most ${remainingIters} remaining iterations.`;
        const failureMsg = `Stop if you cannot make progress after ${maxConsecutiveFailures} consecutive attempts.`;
        agentPrompt = [
          summary.nextPrompt,
          "",
          "INSTRUCTIONS:",
          `- This is iteration ${iterations} of an AutoResearch loop. ${targetMsg} ${failureMsg}`,
          "- Make exactly ONE small code change to improve the metric.",
          "- After your change, output exactly these fields on separate lines:",
          "  STATUS: done (if you made a change) or STATUS: no_change (if you could not improve further)",
          "  CHANGES: brief description of what you changed",
          "  HYPOTHESIS: why you think this change will improve the metric",
          "  LEARNED: what you learned (regardless of outcome)",
          "  NEXT_FOCUS: what to try next",
          "- Do not run experiments yourself — the loop will measure after you finish.",
        ].join("\n");
      }

      const iterationResult = await runLoopIteration({
        cwd,
        prompt: agentPrompt,
        timeoutSeconds: options.timeoutSeconds,
        description: `Loop iteration ${iterations}`,
        iteration: iterations,
      });

      lastCompletedIteration = iterations;
      const logEntry = iterationResult.logEntry;

      if (logEntry.status === "crash") {
        crashed++;
        consecutiveFailures++;
      } else if (logEntry.status === "checks_failed") {
        checksFailed++;
        consecutiveFailures++;
      } else {
        consecutiveFailures = 0;
        if (logEntry.status === "keep" || logEntry.status === "baseline") {
          kept++;
        } else {
          discarded++;
        }
      }

      if (iterationResult.metric !== null) {
        if (bestMetric === null || isImprovement(iterationResult.metric, bestMetric, config.direction)) {
          bestMetric = iterationResult.metric;
          bestRun = iterations;
        }
      }

      const metricStr = iterationResult.metric !== null ? String(iterationResult.metric) : "crash";
      const loopBestStr = bestMetric !== null ? String(bestMetric) : "-";
      const allTimeStr = allTimeBestMetric !== null ? `${allTimeBestMetric}${allTimeBestRun ? ` (run ${allTimeBestRun})` : ""}` : "-";
      const transactionLabel = iterationResult.committed ? "committed" : (iterationResult.reverted ? "reverted" : "unchanged");
      process.stdout.write(`${modeLabel} [${iterations}/${maxIterations}] ${config.metricName}=${metricStr} decision=${logEntry.status} best=${loopBestStr} (loop) | ${allTimeStr} (all-time) confidence=${formatConfidenceLabel(logEntry)} failures=${consecutiveFailures} ${transactionLabel}\n`);

      if (options.targetMetric !== undefined && iterationResult.metric !== null) {
        const targetReached = config.direction === "lower"
          ? iterationResult.metric <= options.targetMetric
          : iterationResult.metric >= options.targetMetric;
        if (targetReached) {
          stopReason = `Target metric reached: ${config.metricName}=${iterationResult.metric} (target: ${options.targetMetric})`;
          break;
        }
      }

      if (consecutiveFailures >= maxConsecutiveFailures) {
        stopReason = `Too many consecutive failures (${consecutiveFailures}/${maxConsecutiveFailures})`;
        break;
      }
    }

    if (stopReason === null) {
      stopReason = `Max iterations reached (${maxIterations})`;
    }

    process.stdout.write(`\nLoop complete. ${stopReason}\n`);
    process.stdout.write(`Iterations: ${iterations}\n`);
    process.stdout.write(`Best (this loop): ${bestMetric !== null ? `${config.metricName}=${bestMetric}` : "(none)"}${bestRun ? ` (run ${bestRun})` : ""}\n`);
    process.stdout.write(`Best (all-time): ${allTimeBestMetric !== null ? `${config.metricName}=${allTimeBestMetric}` : "(none)"}${allTimeBestRun ? ` (run ${allTimeBestRun})` : ""}\n`);
    process.stdout.write(`Confidence: ${formatConfidenceLabel(summarizeAutoresearch(cwd))}\n`);
    process.stdout.write(`Kept: ${kept}  Discarded: ${discarded}  Crashed: ${crashed}  Checks failed: ${checksFailed}\n`);

    return {
      iterations,
      bestMetric,
      bestRun,
      allTimeBestMetric,
      allTimeBestRun,
      kept,
      discarded,
      crashed,
      checksFailed,
      stopReason,
      cancelled,
    };
  } finally {
    process.off("SIGINT", sigintHandler);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatConfidenceLabel(confidence: AutoresearchConfidence): string {
  if (confidence.confidence_score === null) return "unknown";
  const score = confidence.confidence_score === Infinity ? "Infinity" : confidence.confidence_score.toFixed(2);
  return `${confidence.confidence_band}(${score})`;
}
