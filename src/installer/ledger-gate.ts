import { getDb } from "../db.js";
import { computeCmdHash, getOriginRepo } from "../suite/tree-hash.js";

export type LedgerGateMode = "default" | "green" | "off";

export interface LedgerGateKey {
  originRepo: string;
  treeHash: string;
  cmdHash: string;
  testCmd: string;
}

export interface LedgerGateRow {
  id: number;
  exitCode: number;
  durationMs: number;
  logTail: string | null;
  runId: string | null;
  stepId: string | null;
  createdAt: string;
}

export type LedgerGateDecision =
  | {
      status: "inert";
      reason:
        | "step_not_found"
        | "not_finalize_merge"
        | "run_not_found"
        | "no_tested_tree_attestation"
        | "no_test_cmd"
        | "no_origin_repo";
    }
  | ({ status: "overridden"; gateMode: "off" } & LedgerGateKey)
  | ({ status: "missing"; gateMode: Exclude<LedgerGateMode, "off"> } & LedgerGateKey)
  | ({
      status: "green";
      gateMode: Exclude<LedgerGateMode, "off">;
      row: LedgerGateRow;
    } & LedgerGateKey)
  | ({
      status: "red";
      gateMode: Exclude<LedgerGateMode, "off">;
      row: LedgerGateRow;
    } & LedgerGateKey);

export type LedgerGateRefusalDecision =
  | ({ status: "missing"; gateMode: Exclude<LedgerGateMode, "off"> } & LedgerGateKey)
  | ({
      status: "red";
      gateMode: Exclude<LedgerGateMode, "off">;
      row: LedgerGateRow;
    } & LedgerGateKey);

interface StepRow {
  run_id: string;
  step_id: string;
  step_index: number;
}

interface SuiteResultRow {
  id: number;
  exit_code: number;
  duration_ms: number;
  log_tail: string | null;
  run_id: string | null;
  step_id: string | null;
  created_at: string;
}

function parseContext(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

function testedTreeFromOutput(output: string | null): string | null {
  if (!output) return null;
  for (const line of output.split("\n")) {
    const match = line.match(/^TESTED_TREE:\s*(.*)$/);
    if (match?.[1].trim()) return match[1].trim();
  }
  return null;
}

function gateModeFromContext(context: Record<string, string>): LedgerGateMode {
  if (context.merge_gate === "green") return "green";
  if (context.merge_gate === "off") return "off";
  return "default";
}

/**
 * Evaluate the TSTX ledger evidence for a pending finalize_merge step.
 *
 * Eligibility deliberately comes from a completed upstream step's output,
 * never from the run context's launch-time tested_tree seed. The lookup is
 * repository-wide and therefore accepts evidence written by any run.
 */
export function evaluateFinalizeMergeLedgerGate(stepId: string): LedgerGateDecision {
  const db = getDb();
  const step = db.prepare(
    "SELECT run_id, step_id, step_index FROM steps WHERE id = ?",
  ).get(stepId) as StepRow | undefined;
  if (!step) return { status: "inert", reason: "step_not_found" };
  if (step.step_id !== "finalize_merge") {
    return { status: "inert", reason: "not_finalize_merge" };
  }

  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(step.run_id) as
    | { context: string }
    | undefined;
  if (!run) return { status: "inert", reason: "run_not_found" };

  const upstream = db.prepare(
    `SELECT output
     FROM steps
     WHERE run_id = ? AND step_index < ? AND status = 'done'
     ORDER BY step_index DESC`,
  ).all(step.run_id, step.step_index) as Array<{ output: string | null }>;
  const treeHash = upstream
    .map((candidate) => testedTreeFromOutput(candidate.output))
    .find((candidate): candidate is string => candidate !== null);
  if (!treeHash) {
    return { status: "inert", reason: "no_tested_tree_attestation" };
  }

  const context = parseContext(run.context);
  const testCmd = typeof context.test_cmd_raw === "string"
    ? context.test_cmd_raw
    : typeof context.test_cmd === "string"
      ? context.test_cmd
      : "";
  if (!testCmd.trim()) return { status: "inert", reason: "no_test_cmd" };

  const repoPath = context.worktree_origin_repository
    || context.repo
    || context.working_directory_for_harness;
  if (!repoPath?.trim()) return { status: "inert", reason: "no_origin_repo" };

  const key: LedgerGateKey = {
    originRepo: getOriginRepo(repoPath),
    treeHash,
    cmdHash: computeCmdHash(testCmd),
    testCmd,
  };
  const gateMode = gateModeFromContext(context);
  if (gateMode === "off") {
    return { status: "overridden", gateMode, ...key };
  }

  const row = db.prepare(
    `SELECT id, exit_code, duration_ms, log_tail, run_id, step_id, created_at
     FROM suite_results
     WHERE origin_repo = ? AND tree_hash = ? AND cmd_hash = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(key.originRepo, key.treeHash, key.cmdHash) as SuiteResultRow | undefined;
  if (!row) return { status: "missing", gateMode, ...key };

  return {
    status: row.exit_code === 0 ? "green" : "red",
    gateMode,
    ...key,
    row: {
      id: row.id,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      logTail: row.log_tail,
      runId: row.run_id,
      stepId: row.step_id,
      createdAt: row.created_at,
    },
  };
}

/** Build the caller-owned failure text consumed by RAMP terminal routing. */
export function formatLedgerGateRefusal(decision: LedgerGateRefusalDecision): string {
  const lines = [
    "FAILURE_CLASS: refused_permanent",
    decision.status === "missing" ? "LEDGER_EVIDENCE: missing" : "LEDGER_EVIDENCE: red",
    `ORIGIN_REPO: ${decision.originRepo}`,
    `TREE_HASH: ${decision.treeHash}`,
    `CMD_HASH: ${decision.cmdHash}`,
    `TEST_CMD: ${decision.testCmd}`,
  ];

  if (decision.status === "missing") {
    lines.splice(1, 0, "Ledger gate refused finalize_merge: no matching TSTX suite execution exists.");
  } else {
    lines.splice(1, 0, "Ledger gate refused finalize_merge: latest matching TSTX suite execution is red.");
    lines.push(
      `LEDGER_ROW_ID: ${decision.row.id}`,
      `EXIT_CODE: ${decision.row.exitCode}`,
      `TIMESTAMP: ${decision.row.createdAt}`,
      `DURATION_MS: ${decision.row.durationMs}`,
      `LEDGER_RUN_ID: ${decision.row.runId ?? ""}`,
      `LEDGER_STEP_ID: ${decision.row.stepId ?? ""}`,
      `LOG_TAIL: ${decision.row.logTail ?? ""}`,
    );
  }

  return lines.join("\n");
}
