/**
 * `tamandua evidence` command group (DIAG-PRUNE US-015).
 *
 * Exposes the MANUAL evidence-prune command:
 *
 *   tamandua evidence prune --older-than <days> [--yes] [--json]
 *
 * The command is a DRY RUN by default: it asks the US-013 planner
 * (`planEvidencePrune`) what it would remove and only invokes the US-014
 * executor (`executePrunePlan`) when `--yes` is given. Nothing schedules it.
 *
 * The command never starts or contacts the daemon. Its only interaction with
 * the run state is read-only (the planner's SELECTs and filesystem listing);
 * run/step/story rows, the suite ledger, the event stream and the daemon log
 * are never written or removed.
 */
import { resolveStateDir } from "../../lib/tamandua-config.js";
import {
  planEvidencePrune,
  type PrunePlanDb,
} from "../../diagnostics/prune-plan.js";
import { executePrunePlan } from "../../diagnostics/prune-exec.js";
import type {
  PruneExecutionResult,
  PrunePlan,
  PruneRefusal,
} from "../../diagnostics/types.js";

/** Milliseconds in one day; the CLI accepts a day count only. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Injectable command surface. Production callers (the CLI dispatcher) rely on
 * the defaults; tests supply an in-memory db, an isolated state dir and
 * captured streams so no real state, daemon or terminal is touched.
 */
export interface EvidenceCommandDeps {
  /** Injected read-only db used by the planner. */
  db?: PrunePlanDb;
  /** Effective state dir for the evidence/diagnostics/suite-log roots. */
  stateDir?: string;
  /** Injected wall epoch (ms) for the age comparison; defaults to now. */
  now?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  exit?: (code: number) => void;
}

export function getEvidencePruneHelp(): string {
  return `tamandua evidence prune — Remove old run evidence artifacts

Usage: tamandua evidence prune --older-than <days> [--yes] [--json]

Removes per-run evidence directories, per-run diagnostics bundles, suite-logs
files and already-removed run worktrees for runs whose terminal instant is
older than the threshold. DRY-RUN BY DEFAULT: nothing is deleted without
--yes. This command is MANUAL ONLY — nothing schedules it.

Scope and refusals:
  - A run that is running, paused or pending (or that the daemon still
    schedules) is refused: every one of its artifacts is kept and listed.
  - Artifacts that cannot be mapped to a known run are kept.
  - run/step/story rows, the suite ledger, the event stream and the daemon
    log are never touched.

Options:
  --older-than <days>   Required. Prune terminal runs older than this many
                        days. Accepts a bare integer (7) or a day suffix (7d).
  --yes                 Execute the plan (default is a dry run).
  --json                Emit one stable JSON object
                        { dryRun, olderThanMs, items, refusals, totals }
                        (execute mode also includes removed/skipped/failed).

Examples:
  tamandua evidence prune --older-than 7
  tamandua evidence prune --older-than 30d --yes
  tamandua evidence prune --older-than 7 --json`;
}

export function getEvidenceGroupHelp(): string {
  return `tamandua evidence — Manage and prune Tamandua evidence artifacts

Usage: tamandua evidence <prune> ...

Subcommands:
  prune     Remove old run evidence artifacts (dry-run by default, --yes to execute)

Evidence prune is manual only: nothing schedules it. A dry run is always the
default; pass --yes to actually delete the listed paths.

Examples:
  tamandua evidence prune --older-than 7
  tamandua evidence prune --older-than 30d --yes
  tamandua evidence prune --older-than 7 --json`;
}

/** Parsed `evidence prune` arguments. */
interface PruneArgs {
  days: number;
  olderThanMs: number;
  execute: boolean;
  json: boolean;
}

/** Report a usage error on stderr and exit non-zero. */
function fail(
  deps: Required<Pick<EvidenceCommandDeps, "stderr" | "exit">>,
  message: string,
): void {
  deps.stderr(
    `${message}\nUsage: tamandua evidence prune --older-than <days> [--yes] [--json]\n`,
  );
  deps.exit(1);
}

/** Parse a day count: a bare non-negative integer or `<N>d`. */
function parseOlderThanDays(token: string): number | null {
  const match = /^(\d+)(?:d)?$/.exec(token);
  if (match === null) return null;
  const days = Number(match[1]);
  return Number.isSafeInteger(days) ? days : null;
}

/**
 * Parse `evidence prune` arguments. Unknown flags, a missing value and extra
 * positionals are reported through `deps` (never thrown).
 */
function parsePruneArgs(
  args: string[],
  deps: Required<Pick<EvidenceCommandDeps, "stderr" | "exit">>,
): PruneArgs | null {
  let olderThanRaw: string | undefined;
  let execute = false;
  let json = false;

  for (let i = 2; i < args.length; i++) {
    const token = args[i];

    if (token === "--yes") {
      execute = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--older-than") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        fail(deps, "Missing value for --older-than.");
        return null;
      }
      olderThanRaw = value;
      i++;
      continue;
    }
    if (token.startsWith("--older-than=")) {
      const value = token.slice("--older-than=".length);
      if (value.length === 0) {
        fail(deps, "Missing value for --older-than.");
        return null;
      }
      olderThanRaw = value;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      fail(deps, `Unknown option "${token}" for tamandua evidence prune.`);
      return null;
    }
    fail(deps, `Unexpected argument "${token}".`);
    return null;
  }

  if (olderThanRaw === undefined) {
    fail(deps, "Missing required --older-than <days>.");
    return null;
  }

  const days = parseOlderThanDays(olderThanRaw);
  if (days === null) {
    fail(
      deps,
      `Invalid --older-than "${olderThanRaw}": expected a non-negative integer number of days (e.g. 7 or 7d).`,
    );
    return null;
  }

  return { days, olderThanMs: days * MS_PER_DAY, execute, json };
}

/** Render a byte count for humans; never throws on odd values. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Format one refusal line. */
function formatRefusal(refusal: PruneRefusal): string {
  const subject =
    refusal.runId !== undefined && refusal.runId.length > 0
      ? refusal.runId
      : refusal.bareRunId ?? refusal.path ?? "(unknown)";
  return `${subject}: ${refusal.reason}`;
}

/** Human-readable dry-run output. */
function renderDryRun(plan: PrunePlan, days: number, stdout: (text: string) => void): void {
  const lines: string[] = [];
  lines.push(
    `Evidence prune plan (dry run) — older than ${days} day(s) (${plan.olderThanMs} ms).`,
  );
  const removals = plan.items.filter((item) => item.action === "remove");
  lines.push(
    `Planned removals: ${removals.length} item(s), ${formatBytes(plan.totals.removeBytes)}.`,
  );
  for (const item of removals) {
    lines.push(`  [${item.kind}] ${formatBytes(item.sizeBytes)} ${item.path}`);
  }
  lines.push(
    `Kept: ${plan.totals.keepCount} item(s), ${formatBytes(plan.totals.keepBytes)}.`,
  );
  if (plan.refusals.length > 0) {
    lines.push(`Refused ${plan.refusals.length} run(s):`);
    for (const refusal of plan.refusals) lines.push(`  ${formatRefusal(refusal)}`);
  }
  lines.push("Dry run only. Re-run with --yes to execute.");
  stdout(`${lines.join("\n")}\n`);
}

/** Human-readable execute output. */
function renderExecute(
  plan: PrunePlan,
  result: PruneExecutionResult,
  days: number,
  stdout: (text: string) => void,
): void {
  const lines: string[] = [];
  lines.push(`Evidence prune — older than ${days} day(s) (${plan.olderThanMs} ms).`);

  const removedBytes = result.removed.reduce((sum, item) => sum + item.sizeBytes, 0);
  lines.push(`Removed: ${result.removed.length} item(s), ${formatBytes(removedBytes)}.`);
  for (const item of result.removed) {
    lines.push(`  [${item.kind}] ${formatBytes(item.sizeBytes)} ${item.path}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped: ${result.skipped.length} item(s) (already gone).`);
    for (const item of result.skipped) lines.push(`  [${item.kind}] ${item.path}`);
  }
  if (result.failed.length > 0) {
    lines.push(`Failed: ${result.failed.length} item(s).`);
    for (const failure of result.failed) {
      lines.push(`  ${failure.item.path}: ${failure.error}`);
    }
  }
  if (plan.refusals.length > 0) {
    lines.push(`Refused ${plan.refusals.length} run(s):`);
    for (const refusal of plan.refusals) lines.push(`  ${formatRefusal(refusal)}`);
  }
  stdout(`${lines.join("\n")}\n`);
}

/** Handle `tamandua evidence prune`. */
function handleEvidencePrune(args: string[], deps: EvidenceCommandDeps): void {
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const parsed = parsePruneArgs(args, { stderr, exit });
  if (parsed === null) return;

  const stateDir = deps.stateDir ?? resolveStateDir();
  const plan = planEvidencePrune({
    olderThanMs: parsed.olderThanMs,
    stateDir,
    ...(deps.db !== undefined ? { db: deps.db } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  if (!parsed.execute) {
    if (parsed.json) {
      stdout(
        `${JSON.stringify({
          dryRun: true,
          olderThanMs: parsed.olderThanMs,
          items: plan.items,
          refusals: plan.refusals,
          totals: plan.totals,
        })}\n`,
      );
      return;
    }
    renderDryRun(plan, parsed.days, stdout);
    return;
  }

  const result = executePrunePlan(plan, { stateDir });

  if (parsed.json) {
    stdout(
      `${JSON.stringify({
        dryRun: false,
        olderThanMs: parsed.olderThanMs,
        items: plan.items,
        refusals: plan.refusals,
        totals: plan.totals,
        removed: result.removed,
        skipped: result.skipped,
        failed: result.failed,
      })}\n`,
    );
    return;
  }

  renderExecute(plan, result, parsed.days, stdout);
}

/**
 * Handle `tamandua evidence ...` commands. Returns false for unrelated groups.
 *
 * The `evidence` group is dispatched synchronously: the planner and executor
 * are synchronous filesystem/db work.
 */
export function handleEvidence(
  group: string,
  args: string[],
  deps: EvidenceCommandDeps = {},
): boolean {
  if (group !== "evidence") return false;

  const action = args[1];
  if (action === "prune") {
    handleEvidencePrune(args, deps);
    return true;
  }

  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  stderr(
    `Unknown evidence action: ${action ?? "(none)"}\nUsage: tamandua evidence <prune> ...\n`,
  );
  exit(1);
  return true;
}