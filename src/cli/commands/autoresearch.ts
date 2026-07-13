/**
 * autoresearch command group — durable optimization experiment loops.
 *
 * Extracted from src/cli/cli.ts (SPLC story US-011).
 */

import { getWorkflowStatus } from "../../installer/status.js";
import { getDb, upsertAutoresearchSession } from "../../db.js";
import { parseRunContext } from "../../installer/step-ops.js";
import { readOption, requireOption, parseDuration } from "../shared.js";
import {
  findAutoresearchSessionCwd,
  initExperiment,
  runExperiment,
  logExperiment,
  loopAutoresearch,
  runLoopIteration,
  readAutoresearchLog,
  summarizeAutoresearch,
  type AutoresearchDecision,
  type AutoresearchDirection,
  type AutoresearchRunEntry,
  type AutoresearchSummary,
} from "../../autoresearch/autoresearch.js";

function parseDirection(value: string): AutoresearchDirection {
  if (value === "lower" || value === "higher") return value;
  process.stderr.write(`Invalid --direction "${value}". Use "lower" or "higher".\n`);
  process.exit(1);
}

function parseAutoresearchDecision(value: string | undefined): AutoresearchDecision | "auto" | undefined {
  if (!value) return undefined;
  if (value === "auto" || value === "baseline" || value === "keep" || value === "discard" || value === "crash" || value === "metric_not_found" || value === "checks_failed") return value;
  process.stderr.write(`Invalid --status "${value}". Use auto, baseline, keep, discard, crash, metric_not_found, or checks_failed.\n`);
  process.exit(1);
}

export function formatAutoresearchConfidence(value: Pick<AutoresearchSummary, "confidence_score" | "confidence_band" | "noise_floor_mad" | "confidence_sample_count">): string {
  if (value.confidence_score === null) {
    return `unknown (${value.confidence_sample_count} sample${value.confidence_sample_count === 1 ? "" : "s"})`;
  }
  const score = value.confidence_score === Infinity ? "Infinity" : value.confidence_score.toFixed(2);
  const mad = value.noise_floor_mad === null ? "unknown" : String(value.noise_floor_mad);
  return `${value.confidence_band} (score=${score}, MAD=${mad}, n=${value.confidence_sample_count})`;
}

export function printAutoresearchSummary(cwd?: string): void {
  const summary = summarizeAutoresearch(cwd);
  if (!summary.exists) {
    console.log(summary.nextPrompt);
    return;
  }
  console.log("AutoResearch");
  console.log(`Goal:        ${summary.goal}`);
  console.log(`Metric:      ${summary.metricName}${summary.metricUnit ? ` (${summary.metricUnit})` : ""}`);
  console.log(`Direction:   ${summary.direction}`);
  console.log(`Runs:        ${summary.totalRuns} logged (${summary.keptRuns} kept, ${summary.discardedRuns} discarded)`);
  console.log(`Failures:    ${summary.crashedRuns} crash, ${summary.metricNotFoundRuns} metric_not_found, ${summary.checksFailedRuns} checks_failed`);
  console.log(`Baseline:    ${summary.baselineMetric ?? "(none)"}`);
  console.log(`Best:        ${summary.bestMetric ?? "(none)"}${summary.bestRun ? ` at run ${summary.bestRun}` : ""}`);
  console.log(`Confidence:  ${formatAutoresearchConfidence(summary)}`);
  console.log("");
  console.log(summary.nextPrompt);
}

export function resolveAutoresearchCwdForRun(runIdOrPrefix: string): { runId: string; cwd?: string } {
  const detail = getWorkflowStatus(runIdOrPrefix);
  const db = getDb();
  const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(detail.id) as { context?: string | null } | undefined;
  if (!row?.context) return { runId: detail.id };

  const context = parseRunContext(detail.id, row.context);

  return {
    runId: detail.id,
    cwd: context.working_directory_for_harness?.trim() || context.worktree_path?.trim() || context.cwd?.trim() || undefined,
  };
}

export function printAutoresearchTimeline(cwd: string): void {
  const entries = readAutoresearchLog(cwd);
  const runs = entries.filter((entry): entry is AutoresearchRunEntry => entry.type === "run");
  if (runs.length === 0) {
    console.log("Timeline:    No logged experiments yet.");
    return;
  }

  console.log("Timeline:");
  for (const run of runs.slice(-12)) {
    const metric = run.metric === null ? "-" : String(run.metric);
    const confidence = run.confidence_score === null || run.confidence_score === undefined ? "" : ` confidence=${run.confidence_band}`;
    const learned = run.asi?.learned ? ` — ${run.asi.learned}` : "";
    const next = run.asi?.next_focus ? ` | next: ${run.asi.next_focus}` : "";
    console.log(`  #${String(run.run).padStart(2, "0")} [${run.status.padEnd(13)}] ${metric.padEnd(8)} ${run.description}${confidence}${learned}${next}`);
  }
}

export function printWorkflowAutoresearch(runIdOrPrefix: string): void {
  let resolved: { runId: string; cwd?: string };
  try {
    resolved = resolveAutoresearchCwdForRun(runIdOrPrefix);
  } catch (err) {
    const message = err instanceof Error ? err.message : `No run found matching "${runIdOrPrefix}".`;
    console.log(message.startsWith("No run found matching") ? `No run found matching "${runIdOrPrefix}".` : message);
    return;
  }

  if (!resolved.cwd) {
    console.log(`Run ${resolved.runId.slice(0, 8)} has no harness working directory in its context.`);
    return;
  }

  const autoresearchCwd = findAutoresearchSessionCwd(resolved.cwd) ?? resolved.cwd;
  console.log(`Run:         ${resolved.runId.slice(0, 8)}`);
  console.log(`Harness CWD: ${resolved.cwd}`);
  if (autoresearchCwd !== resolved.cwd) console.log(`Session CWD: ${autoresearchCwd}`);
  printAutoresearchSummary(autoresearchCwd);
  const summary = summarizeAutoresearch(autoresearchCwd);
  if (summary.exists) {
    console.log("");
    printAutoresearchTimeline(autoresearchCwd);
  }
}

export function getAutoresearchHelp(): string {
  return `tamandua autoresearch — Run durable optimization experiment loops

Usage: tamandua autoresearch <init|run-experiment|log-experiment|status|next|loop|prune>

AutoResearch stores a project-local session in:
  autoresearch.config.json   Session configuration
  autoresearch.md            Agent-facing objective and loop contract
  autoresearch.jsonl         Append-only experiment history
  autoresearch.sh            Benchmark command
  autoresearch.checks.sh     Optional correctness checks

Subcommands:
  init            Create a new AutoResearch session
  run-experiment  Run the configured experiment command and append a measured result
  log-experiment  Log the keep/discard decision, learning, and next focus
  loop            Run a bounded experiment loop with live terminal progress
  run-loop-iteration
                  Run a single transactional experiment iteration
  status          Summarize baseline, best run, failures, and next prompt
  next            Print the ratchet prompt for the next experiment
  prune           Remove stale AutoResearch registry rows from SQLite (DB only)
  wizard          Interactive setup wizard that guides you through creating
                  an AutoResearch command sequence

Examples:
  tamandua autoresearch init --goal "reduce validation loss" --metric val_bpb --direction lower --command "uv run train.py"
  tamandua autoresearch run-experiment
  tamandua autoresearch log-experiment --status auto --description "try smaller LR" --learned "stable but slower" --next-focus "test warmup"
  tamandua autoresearch prune --older-than 30d`;
}

export function getAutoresearchInitHelp(): string {
  return `tamandua autoresearch init — Create an AutoResearch session

Usage: tamandua autoresearch init --goal <text> --metric <name> --direction <lower|higher> --command <cmd> [options]

Options:
  --unit <unit>             Metric unit, such as seconds, bpb, auc, or ms
  --metric-regex <regex>    Regex with the metric value in capture group 1
  --checks-command <cmd>    Correctness command to run after successful benchmarks
  --cwd <dir>               Project directory (default: current directory)
  --overwrite               Replace existing autoresearch files

Examples:
  tamandua autoresearch init --goal "speed up tests" --metric total_ms --unit ms --direction lower --command "pnpm test --run"`;
}

export function getAutoresearchRunExperimentHelp(): string {
  return `tamandua autoresearch run-experiment — Execute the current experiment

Usage: tamandua autoresearch run-experiment [options]

Runs the configured command, captures stdout/stderr tails, parses the metric,
runs optional checks, and appends a run_result entry to autoresearch.jsonl.

Options:
  --cwd <dir>               Project directory (default: current directory)
  --command <cmd>           Override the configured command for this run
  --metric-regex <regex>    Override metric parser for this run
  --checks-command <cmd>    Override or provide correctness checks
  --timeout-seconds <n>     Command timeout (default: 3600)

Examples:
  tamandua autoresearch run-experiment
  tamandua autoresearch run-experiment --metric-regex "val_bpb=([0-9.]+)"`;
}

export function getAutoresearchLogExperimentHelp(): string {
  return `tamandua autoresearch log-experiment — Record experiment learning and decision

Usage: tamandua autoresearch log-experiment --description <text> [options]

By default --status auto classifies the latest measured result as baseline,
keep, discard, crash, or checks_failed by comparing it with prior accepted
runs in autoresearch.jsonl.

Options:
  --cwd <dir>               Project directory (default: current directory)
  --status <status>         auto, baseline, keep, discard, crash, metric_not_found, checks_failed
  --metric <number>         Metric value if no latest run_result should be used
  --description <text>      What changed in this experiment
  --hypothesis <text>       Hypothesis tested
  --learned <text>          Evidence learned from the result
  --next-focus <text>       Next experiment direction
  --commit                  Commit kept/baseline results with git
  --revert-discard          Revert non-autoresearch tracked files on discard

Examples:
  tamandua autoresearch log-experiment --status auto --description "cache parser" --learned "faster but flaky" --next-focus "fix invalidation"`;
}

export function getAutoresearchStatusHelp(): string {
  return `tamandua autoresearch status — Summarize the experiment loop

Usage: tamandua autoresearch status [--cwd <dir>]

Shows baseline, best result, keep/discard counts, failure counts, and the
ratchet prompt for the next experiment.

Examples:
  tamandua autoresearch status`;
}

export function getAutoresearchNextHelp(): string {
  return `tamandua autoresearch next — Print the next experiment prompt

Usage: tamandua autoresearch next [--cwd <dir>]

Prints the evidence-driven prompt that agents should read before proposing
the next experiment. This is the ratchet: use prior results before editing.

Examples:
  tamandua autoresearch next`;
}

export function getAutoresearchLoopHelp(): string {
  return `tamandua autoresearch loop — Run a bounded experiment loop

Usage: tamandua autoresearch loop [options]

Runs a bounded AutoResearch experiment loop. An action mode is REQUIRED —
the loop will fail without one.

Action modes:
  --measure-only    Repeated benchmark only (no optimization). Honest measurement;
                    no code/config changes between iterations.
  --prompt          pi-driven optimization. Between iterations, spawns pi to make
                    one small code change guided by AutoResearch history.

Options:
  --target-metric <number>        Stop loop when the target metric is reached
                                  (compared via the configured direction)
  --max-iterations <number>       Maximum number of iterations (default: 20)
  --max-consecutive-failures <n>  Stop after N consecutive failures (default: 3)
  --timeout <duration>            Per-pi-action timeout (default: 5m). Format: <number><s|m|h>
                                  (e.g. 300s, 10m, 1h)
  --cwd <dir>                     Project directory (default: current directory)

Stop conditions (the loop stops when any one is met):
  - Target metric reached (requires --target-metric or config target)
  - Max iterations reached (--max-iterations)
  - Too many consecutive failures (--max-consecutive-failures)
  - User cancels with Ctrl-C / SIGINT

Progress display shows for each iteration:
  [measure-only] or [prompt] label, [N/MAX] iteration number, current focus,
  measured metric, decision (keep/discard/crash), best metric (loop + all-time),
  failure count, and stop reason.

After the loop ends, a final summary prints: total iterations, best
metric (this loop and all-time), best run number, and kept/discarded/crashed counts.

Cancellation (Ctrl-C / SIGINT) prints the last completed iteration info
and leaves autoresearch.jsonl in a consistent state.

Examples:
  tamandua autoresearch loop --measure-only --max-iterations 10
  tamandua autoresearch loop --prompt --target-metric 0.5 --max-iterations 30
  tamandua autoresearch loop --prompt --max-consecutive-failures 5
  tamandua autoresearch loop --prompt --timeout 10m --max-iterations 10`;
}

export function getAutoresearchRunLoopIterationHelp(): string {
  return `tamandua autoresearch run-loop-iteration — Run a transactional experiment iteration

Usage: tamandua autoresearch run-loop-iteration [options]

Runs a single transactional AutoResearch experiment iteration. The iteration
follows this lifecycle:

  1. If --prompt is provided, invokes pi to make one candidate code change.
  2. Runs the configured experiment command and measures the metric.
  3. Logs the result to autoresearch.jsonl:
     - keep/baseline results are committed (autoresearch* files excluded).
     - discard results are reverted (candidate changes rolled back).
     - crash/checks_failed results are reverted.
  4. Ensures the working tree has no dirty non-autoresearch files.

Options:
  --cwd <dir>               Project directory (default: current directory)
  --prompt <text>           pi agent prompt for code change (optional)
  --command <cmd>           Override the configured experiment command
  --timeout <duration>      Per-pi-action timeout (default: 5m). Format: <number><s|m|h>
                            (e.g. 300s, 10m, 1h)
  --iteration <n>           Iteration number (for logging)
  --description <text>      Description of the experiment

Output:
  JSON object with run number, status, metric, agent success,
  committed/reverted flags, and the full log entry.

Examples:
  tamandua autoresearch run-loop-iteration --prompt "try smaller LR" --iteration 1
  tamandua autoresearch run-loop-iteration --command "uv run train.py" --iteration 5
  tamandua autoresearch run-loop-iteration --prompt test --iteration 1`;
}

export function getAutoresearchPruneHelp(): string {
  return `tamandua autoresearch prune — Remove stale AutoResearch registry rows

Usage: tamandua autoresearch prune --older-than <duration> [--missing] [--dry-run]

Prunes (removes) stale autoresearch_sessions registry rows from the SQLite DB.
This never touches project-local autoresearch.jsonl or config files — those
remain safe on disk.

Options:
  --older-than <d>   Prune sessions older than the given duration (required).
  --missing          Only prune sessions whose cwd/config/log files no longer exist.
  --dry-run          Print what would be pruned without actually deleting anything.

Duration format:
  Duration is specified as a number followed by a unit letter:
    d — days   (e.g. 30d = 30 days)
    h — hours  (e.g. 24h = 24 hours)
    m — minutes(e.g. 30m = 30 minutes)

Examples:
  tamandua autoresearch prune --older-than 30d
  tamandua autoresearch prune --older-than 7d --missing
  tamandua autoresearch prune --older-than 30d --dry-run`;
}

export function getAutoresearchWizardHelp(): string {
  return `tamandua autoresearch wizard — Interactive AutoResearch setup wizard

Usage: tamandua autoresearch wizard [--cwd <dir>]

Launches an interactive wizard that guides you through setting up an
AutoResearch session. The wizard asks questions about what you want to
improve and how to measure success, then generates the exact Tamandua
command sequence you need.

The wizard does not directly create project files. If initialization is
needed, it generates and optionally executes the correct tamandua
autoresearch init command. Then it generates the tamandua autoresearch
loop command to start the optimization loop.

Options:
  --cwd <dir>    Working directory (default: current directory)

Examples:
  tamandua autoresearch wizard
  tamandua autoresearch wizard --cwd /path/to/project`;
}

/**
 * Handle autoresearch command group (init, run-experiment, log-experiment,
 * status, next, loop, run-loop-iteration, prune, wizard).
 * Returns true if the command was handled, false if not recognized.
 */
export async function handleAutoresearch(group: string, args: string[]): Promise<boolean> {
  if (group !== "autoresearch") return false;

  const cwd = readOption(args, "--cwd");
  const action = args[1];

  if (action === "init") {
    const usage = "tamandua autoresearch init --goal <text> --metric <name> --direction <lower|higher> --command <cmd>";
    const entry = initExperiment({
      cwd,
      goal: requireOption(args, "--goal", usage),
      metricName: requireOption(args, "--metric", usage),
      metricUnit: readOption(args, "--unit"),
      direction: parseDirection(requireOption(args, "--direction", usage)),
      command: requireOption(args, "--command", usage),
      metricRegex: readOption(args, "--metric-regex"),
      checksCommand: readOption(args, "--checks-command"),
      overwrite: args.includes("--overwrite"),
    });
    console.log(`Initialized AutoResearch session for metric ${entry.metric_name} (${entry.direction}).`);
    console.log("Next: tamandua autoresearch run-experiment");
    upsertAutoresearchSession(cwd ?? process.cwd());
    return true;
  }

  if (action === "run-experiment") {
    const timeoutSecondsRaw = readOption(args, "--timeout-seconds");
    const timeoutMs = timeoutSecondsRaw ? Math.max(1, Number(timeoutSecondsRaw)) * 1000 : undefined;
    if (timeoutSecondsRaw && !Number.isFinite(timeoutMs)) {
      process.stderr.write(`Invalid --timeout-seconds "${timeoutSecondsRaw}".\n`);
      process.exit(1);
    }
    const result = await runExperiment({
      cwd,
      command: readOption(args, "--command"),
      metricRegex: readOption(args, "--metric-regex"),
      checksCommand: readOption(args, "--checks-command"),
      timeoutMs,
    });
    console.log(JSON.stringify(result, null, 2));
    upsertAutoresearchSession(cwd ?? process.cwd());
    return true;
  }

  if (action === "log-experiment") {
    const metricRaw = readOption(args, "--metric");
    const metric = metricRaw === undefined ? undefined : Number(metricRaw);
    if (metricRaw !== undefined && !Number.isFinite(metric)) {
      process.stderr.write(`Invalid --metric "${metricRaw}".\n`);
      process.exit(1);
    }
    const usage = "tamandua autoresearch log-experiment --description <text>";
    const entry = await logExperiment({
      cwd,
      metric,
      status: parseAutoresearchDecision(readOption(args, "--status")) ?? "auto",
      description: requireOption(args, "--description", usage),
      hypothesis: readOption(args, "--hypothesis"),
      learned: readOption(args, "--learned"),
      nextFocus: readOption(args, "--next-focus"),
      commit: args.includes("--commit"),
      revertDiscard: args.includes("--revert-discard"),
    });
    console.log(`Logged run ${entry.run}: ${entry.status}${entry.metric === null ? "" : ` (${entry.metric})`}.`);
    console.log(`Best: ${entry.best_metric ?? "(none)"}`);
    console.log(`Confidence: ${formatAutoresearchConfidence(entry)}`);
    upsertAutoresearchSession(cwd ?? process.cwd());
    return true;
  }

  if (action === "status") {
    upsertAutoresearchSession(cwd ?? process.cwd());
    printAutoresearchSummary(cwd);
    return true;
  }

  if (action === "next") {
    upsertAutoresearchSession(cwd ?? process.cwd());
    console.log(summarizeAutoresearch(cwd).nextPrompt);
    return true;
  }

  if (action === "loop") {
    const targetMetricRaw = readOption(args, "--target-metric");
    const targetMetric = targetMetricRaw !== undefined ? Number(targetMetricRaw) : undefined;
    if (targetMetricRaw !== undefined && !Number.isFinite(targetMetric)) {
      process.stderr.write(`Invalid --target-metric "${targetMetricRaw}".\n`);
      process.exit(1);
    }
    const maxIterRaw = readOption(args, "--max-iterations");
    const maxIterations = maxIterRaw !== undefined ? Math.max(1, parseInt(maxIterRaw, 10)) : undefined;
    if (maxIterRaw !== undefined && !Number.isFinite(maxIterations)) {
      process.stderr.write(`Invalid --max-iterations "${maxIterRaw}".\n`);
      process.exit(1);
    }
    const maxFailRaw = readOption(args, "--max-consecutive-failures");
    const maxConsecutiveFailures = maxFailRaw !== undefined ? Math.max(1, parseInt(maxFailRaw, 10)) : undefined;
    if (maxFailRaw !== undefined && !Number.isFinite(maxConsecutiveFailures)) {
      process.stderr.write(`Invalid --max-consecutive-failures "${maxFailRaw}".\n`);
      process.exit(1);
    }
    const timeoutRaw = readOption(args, "--timeout");
    let timeoutSeconds: number | undefined;
    if (timeoutRaw !== undefined) {
      try {
        timeoutSeconds = Math.floor(parseDuration(timeoutRaw) / 1000);
        if (timeoutSeconds <= 0) {
          process.stderr.write(`Invalid --timeout "${timeoutRaw}": must be a positive number.\n`);
          process.exit(1);
        }
      } catch (err) {
        process.stderr.write(`Invalid --timeout "${timeoutRaw}": ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    }
    const isMeasureOnly = args.includes("--measure-only");
    const isPrompt = args.includes("--prompt");
    if (!isMeasureOnly && !isPrompt) {
      process.stderr.write(
        "No action mode specified. Use --measure-only for repeated benchmarks (no optimization) or --prompt for pi-driven optimization.\n",
      );
      process.exit(1);
    }
    if (isMeasureOnly && isPrompt) {
      process.stderr.write("Can only specify one action mode at a time (--measure-only or --prompt).\n");
      process.exit(1);
    }
    const actionMode = isMeasureOnly ? "measure-only" : "prompt";
    upsertAutoresearchSession(cwd ?? process.cwd());
    await loopAutoresearch({ cwd, targetMetric, maxIterations, maxConsecutiveFailures, actionMode, timeoutSeconds });
    return true;
  }

  if (action === "prune") {
    const olderThanIdx = args.indexOf("--older-than");
    if (olderThanIdx === -1 || !args[olderThanIdx + 1]) {
      process.stderr.write(
        "Missing --older-than <duration>.\nUsage: tamandua autoresearch prune --older-than <duration> [--missing] [--dry-run]\n",
      );
      process.exit(1);
    }

    let thresholdMs: number;
    try {
      thresholdMs = parseDuration(args[olderThanIdx + 1]);
    } catch (err) {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }

    const dryRun = args.includes("--dry-run");
    const missingOnly = args.includes("--missing");
    const cutoff = new Date(Date.now() - thresholdMs).toISOString();

    const { getAutoresearchSessions, deleteAutoresearchSession } = await import("../../db.js");
    const sessions = getAutoresearchSessions({ includeMissing: true });

    const candidates = sessions.filter((s) => {
      // Check if session is older than threshold
      const updatedAt = s.updated_at;
      if (!updatedAt || updatedAt >= cutoff) return false;

      // If --missing, only include sessions whose files are gone
      if (missingOnly && !s.files_missing) return false;

      return true;
    });

    if (candidates.length === 0) {
      console.log("No sessions to prune.");
      return true;
    }

    for (const s of candidates) {
      const reasonParts: string[] = [];
      if (s.files_missing) reasonParts.push("missing files");
      reasonParts.push(`last seen ${s.last_seen_at ?? "never"}`);
      const reason = reasonParts.join(", ");

      if (dryRun) {
        console.log(
          `[DRY RUN] Would prune: ${s.cwd} (${s.metric_name ?? "unknown metric"}) — ${reason}`,
        );
      } else {
        deleteAutoresearchSession(s.id);
        console.log(
          `Pruned: ${s.cwd} (${s.metric_name ?? "unknown metric"}) — ${reason}`,
        );
      }
    }

    if (dryRun) {
      console.log(`\nDry run: ${candidates.length} session(s) would be pruned.`);
    } else {
      console.log(`\nPruned ${candidates.length} session(s).`);
    }
    return true;
  }

  if (action === "run-loop-iteration") {
    const timeoutRaw = readOption(args, "--timeout");
    let timeoutSeconds: number | undefined;
    if (timeoutRaw !== undefined) {
      try {
        timeoutSeconds = Math.floor(parseDuration(timeoutRaw) / 1000);
        if (timeoutSeconds <= 0) {
          process.stderr.write(`Invalid --timeout "${timeoutRaw}": must be a positive number.\n`);
          process.exit(1);
        }
      } catch (err) {
        process.stderr.write(`Invalid --timeout "${timeoutRaw}": ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    }
    const iterationRaw = readOption(args, "--iteration");
    const iteration = iterationRaw !== undefined ? Math.max(1, parseInt(iterationRaw, 10)) : undefined;
    if (iterationRaw !== undefined && !Number.isFinite(iteration)) {
      process.stderr.write(`Invalid --iteration "${iterationRaw}".\n`);
      process.exit(1);
    }
    upsertAutoresearchSession(cwd ?? process.cwd());
    const result = await runLoopIteration({
      cwd,
      prompt: readOption(args, "--prompt"),
      command: readOption(args, "--command"),
      timeoutSeconds,
      iteration,
      description: readOption(args, "--description"),
    });
    console.log(JSON.stringify(result, null, 2));
    return true;
  }

  if (action === "wizard") {
    const wizardCwd = readOption(args, "--cwd");
    const { runWizard } = await import("../wizard-orchestrator.js");
    await runWizard({ cwd: wizardCwd, binaryName: "tamandua" });
    return true;
  }

  process.stderr.write(`Unknown autoresearch action: ${action}\nUsage: tamandua autoresearch <init|run-experiment|log-experiment|status|next|loop|run-loop-iteration|prune|wizard>\n`);
  process.exit(1);
}
