/**
 * `tamandua run` command group (DIAG-PRUNE US-011).
 *
 * Exposes the read-only diagnostics subcommand:
 *
 *   tamandua run diagnose <run-id|run-number> [--out <dir>] [--json]
 *
 * The command resolves the selector through the shared
 * `resolveRunTarget` (US-002), assembles the bundle with
 * `createDiagnosticsBundle` (US-010) and prints the summary plus the bundle
 * path. It is READ-ONLY: the daemon is never started or contacted.
 *
 * A run that does not exist (or an ambiguous prefix) is a hard error — the
 * selector is operator input, not a missing source — while every missing
 * bundle source is reported as `absent` by the orchestrator, never thrown.
 */
import { getDb } from "../../db.js";
import { resolveStateDir } from "../../lib/tamandua-config.js";
import {
  createDiagnosticsBundle,
  type DiagnosticsBundleDb,
} from "../../diagnostics/bundle.js";
import {
  AmbiguousRunError,
  resolveRunTarget,
  RunNotFoundError,
} from "../../diagnostics/run-target.js";
import { renderSummaryMarkdown } from "../../diagnostics/summary.js";

/**
 * Injectable command surface. Production callers (the CLI dispatcher) rely on
 * the defaults; tests supply an in-memory db, an isolated state dir and
 * captured streams so no real state, daemon or terminal is touched.
 */
export interface RunCommandDeps {
  /** Injected read-only db (both for resolution and the bundle). */
  db?: DiagnosticsBundleDb;
  /** Effective state dir for the bundle/evidence/log roots. */
  stateDir?: string;
  /** Bundle timestamp spelling; defaults to the current UTC instant. */
  timestamp?: string;
  /** Environment used to resolve harness session homes. */
  homes?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  exit?: (code: number) => void;
}

export function getRunDiagnoseHelp(): string {
  return `tamandua run diagnose — Assemble a read-only diagnostics bundle for a run

Usage: tamandua run diagnose <run-id|run-number> [--out <dir>] [--json]

Collects everything an operator needs to attach to a bug report for one run
into a single directory: the run/step/story/worktree rows, the run's event
stream (across rotations), matching daemon-log lines, harness session-store
PATHS (never contents), the run's evidence directory listing and suite-ledger
rows (with full log paths), and — for Matchlock-backed runs — VM ids, console
logs, invocation error records and the redacted Matchlock policy.

The command is READ-ONLY: it never starts or touches the daemon and works
while the daemon is running or stopped. A missing source is reported as
"absent" inside the bundle, never as an error.

Selector:
  <run-id>       exact run id or an unambiguous id prefix
  <run-number>   bare integer or #<N>

Options:
  --out <dir>    Write the bundle to <dir>/<run-id> instead of the default
                 <state>/diagnostics/<run-id>-<timestamp>.
  --json         Print exactly one JSON object
                 { runId, bundlePath, summary } on stdout and nothing else.

Examples:
  tamandua run diagnose 87
  tamandua run diagnose run-dff0c254-3e7e-4767-9a66-489e8dbdd90e
  tamandua run diagnose #87 --out ./diag-out --json`;
}

export function getRunHelp(): string {
  return `tamandua run — Inspect and diagnose workflow runs

Usage: tamandua run <diagnose> ...

Subcommands:
  diagnose   Assemble a read-only diagnostics bundle for a run

Examples:
  tamandua run diagnose 87
  tamandua run diagnose <run-id> --out ./diag-out
  tamandua run diagnose #87 --json`;
}

/** Parsed `run diagnose` arguments. */
interface DiagnoseArgs {
  selector?: string;
  outDir?: string;
  json: boolean;
}

/** Report a usage error on stderr and exit non-zero. */
function fail(
  deps: Required<Pick<RunCommandDeps, "stderr" | "exit">>,
  message: string,
): void {
  deps.stderr(`${message}\nUsage: tamandua run diagnose <run-id|run-number> [--out <dir>] [--json]\n`);
  deps.exit(1);
}

/**
 * Parse `run diagnose` arguments. Unknown flags, a missing value and extra
 * positionals are reported through `deps` (never thrown).
 */
function parseDiagnoseArgs(
  args: string[],
  deps: Required<Pick<RunCommandDeps, "stderr" | "exit">>,
): DiagnoseArgs | null {
  const parsed: DiagnoseArgs = { json: false };

  for (let i = 2; i < args.length; i++) {
    const token = args[i];

    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--out") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        fail(deps, "Missing value for --out.");
        return null;
      }
      parsed.outDir = value;
      i++;
      continue;
    }
    if (token.startsWith("--out=")) {
      const value = token.slice("--out=".length);
      if (value.length === 0) {
        fail(deps, "Missing value for --out.");
        return null;
      }
      parsed.outDir = value;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      fail(deps, `Unknown option "${token}" for tamandua run diagnose.`);
      return null;
    }
    if (parsed.selector !== undefined) {
      fail(deps, `Unexpected argument "${token}".`);
      return null;
    }
    parsed.selector = token;
  }

  if (parsed.selector === undefined) {
    fail(deps, "Missing run selector.");
    return null;
  }
  return parsed;
}

/** Handle `tamandua run diagnose`. */
function handleRunDiagnose(args: string[], deps: RunCommandDeps): void {
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const parsed = parseDiagnoseArgs(args, { stderr, exit });
  if (parsed === null) return;

  const db = deps.db ?? (getDb() as unknown as DiagnosticsBundleDb);

  let target;
  try {
    target = resolveRunTarget(parsed.selector as string, db);
  } catch (error) {
    if (error instanceof RunNotFoundError) {
      stderr(`No run found matching "${parsed.selector}".\n`);
      exit(1);
      return;
    }
    if (error instanceof AmbiguousRunError) {
      stderr(`${error.message}\n`);
      exit(1);
      return;
    }
    throw error;
  }

  const bundle = createDiagnosticsBundle({
    runId: target.runId,
    stateDir: deps.stateDir ?? resolveStateDir(),
    ...(parsed.outDir !== undefined ? { outRoot: parsed.outDir } : {}),
    db,
    ...(deps.timestamp !== undefined ? { timestamp: deps.timestamp } : {}),
    ...(deps.homes !== undefined ? { homes: deps.homes } : {}),
  });

  if (parsed.json) {
    stdout(
      `${JSON.stringify({ runId: bundle.runId, bundlePath: bundle.bundlePath, summary: bundle.summary })}\n`,
    );
    return;
  }

  stdout(`${renderSummaryMarkdown(bundle.summary)}\n`);
  stdout(`Bundle: ${bundle.bundlePath}\n`);
}

/**
 * Handle `tamandua run ...` commands. Returns false for unrelated groups.
 *
 * The `run` group is dispatched synchronously: every operation (target
 * resolution, bundle assembly) is synchronous filesystem/db work.
 */
export function handleRun(group: string, args: string[], deps: RunCommandDeps = {}): boolean {
  if (group !== "run") return false;

  const action = args[1];
  if (action === "diagnose") {
    handleRunDiagnose(args, deps);
    return true;
  }

  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  stderr(
    `Unknown run action: ${action ?? "(none)"}\nUsage: tamandua run <diagnose> ...\n`,
  );
  exit(1);
  return true;
}