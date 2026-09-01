// S41 (US-004) — probe-sequence sibling runs in the evidence graph + O2
// two-landing model.
//
// The tier-2 campaign (campaign-20260826T225744158Z) left
// W4.10-restart-recovery with VOIDED O1/O2/O11 cells: the case's two-run
// probe sequence (two concurrent bug-fix-merge-worktree runs, each with a
// restart_daemon probe) recorded its SECOND run ONLY in the probe-evidence
// artifact (run-2621299f), never in the captured graph. The terminal
// workflow-status.json carried `steps_snapshot: null, tokens_observed: 0,
// discovered_runs: []` while the product provably retained everything (both
// runs landed, both are in the DB snapshot with real step/token evidence) —
// mechanical artifacts voiding:
//
//   * O1 — O1_WORKFLOW_STEPS_MISSING (root steps_snapshot null) and the
//     sibling run invisible to the graph audit;
//   * O11 — O11_CONTROLLER_TOTAL_MISMATCH (controller tokens_observed 0 vs
//     runs.tokens_spent) and O11_DELTA_RUN_UNKNOWN (the sibling's
//     run.tokens.updated events name a run outside the captured graph);
//   * O2 — the sibling's merge.landed event + its target transition are
//     unattributable (O2_LANDING_RUN_UNKNOWN / O2_REF_TRANSITION_UNATTRIBUTED)
//     and the one-transition model flags the legal two-transition movement
//     (O2_REF_TRANSITION_COUNT / O2_REF_EVENT_MISMATCH).
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC3): pins the campaign void lines verbatim (second run
//     run-2621299f absent from the graph; workflow-status.json
//     `steps_snapshot: null, tokens_observed: 0, discovered_runs: []`) and
//     reproduces the PRE-FIX voiding against the post-fix machinery
//     (history-independent, built inline):
//       - the pre-fix workflow-status graph (root steps null, no sibling row)
//         makes O1 fire O1_WORKFLOW_STEPS_MISSING; a sibling in the context
//         graph but absent from workflow-status makes O1 fire
//         O1_WORKFLOW_STATUS_MISSING;
//       - the pre-fix O2 context (sibling run absent from the captured
//         graph) makes O2 fire O2_LANDING_RUN_UNKNOWN +
//         O2_REF_TRANSITION_UNATTRIBUTED + O2_REF_TRANSITION_COUNT +
//         O2_REF_EVENT_MISMATCH on a REAL two-landing git shape;
//   * GREEN-ARM (AC1/AC2/AC3): the post-fix terminal snapshot registers both
//     probe runs in workflow-status.json with per-run
//     terminal_status/steps_snapshot/tokens_observed (root falls back to the
//     primary probe run for concurrent shapes); the complete graph makes O1
//     PASS; O2 PASSes the two-landing shape when both landings are
//     attributed runs (two transitions, each landing owned by an attributed
//     run); the single-transition invariant stays for single-run shapes
//     (O2_REF_TRANSITION_COUNT still fires on o2-reflog-window-bypass and
//     o2-unparseable-reflog);
//   * ROSTER PIN (AC4): W4.10-restart-recovery declares a two-run
//     restart_daemon probe_sequence + O16 (the probe-evidence lifecycle
//     oracle).
//
// Follows the tier2-*.test.ts self-test pattern (node builtins +
// repo-relative module imports); picked up by self-tests/run.sh's tier2 glob
// automatically.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
// @ts-expect-error -- no ambient declaration for the snapshot module
import { beginOracleEvidenceSnapshot, completeOracleEvidenceSnapshot } from "../bin/oracle-evidence-snapshot.mjs";
// @ts-expect-error -- no ambient declaration for the O1/O2 oracle modules
import { evaluateO1 } from "../oracles/lib/o1.mjs";
// @ts-expect-error -- no ambient declaration for the O1/O2 oracle modules
import { evaluateO2 } from "../oracles/lib/o2.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");

// ── Pinned campaign evidence (campaign-20260826T225744158Z, read-only) ──
// W4.10-restart-recovery's probe's SECOND run id (the adjudication's
// documented prefix; the full uuid lives in the read-only campaign snapshot).
const W4_10_SECOND_RUN_ID = "run-2621299f";
// The workflow-status.json void shape the campaign carried at terminal
// capture (verbatim from the adjudication of the campaign evidence).
const W4_10_GRAPH_VOID_LINE =
  "workflow-status.json steps_snapshot null, tokens_observed 0, discovered_runs []";
// The O1/O11/O2 finding ids the void produced (exact oracle finding ids).
const W4_10_O1_VOID = "O1_WORKFLOW_STEPS_MISSING";
const W4_10_O11_VOIDS = ["O11_CONTROLLER_TOTAL_MISMATCH", "O11_DELTA_RUN_UNKNOWN"];
const W4_10_O2_VOIDS = ["O2_LANDING_RUN_UNKNOWN", "O2_REF_TRANSITION_UNATTRIBUTED", "O2_REF_TRANSITION_COUNT", "O2_REF_EVENT_MISMATCH"];

const ROOT_RUN_ID = "run-11111111-1111-4111-8111-111111111111";
const SIBLING_RUN_ID = "run-22222222-2222-4222-8222-222222222222";
const DB_ROOT_ID = ROOT_RUN_ID.slice(4);
const DB_SIBLING_ID = SIBLING_RUN_ID.slice(4);
const STARTED_AT = "2026-08-01T12:00:00.000Z";
const TERMINAL_AT = "2026-08-01T12:09:00.000Z";
const CAPTURED_AT = "2026-08-01T12:10:00.000Z";
const SUITE_CMD_HASH = createHash("sha256").update("npm test").digest("hex");

function run(file: string, args: string[], cwd: string, options: { input?: string; env?: Record<string, string> } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    input: options.input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "S41 Test",
      GIT_AUTHOR_EMAIL: "s41@example.invalid",
      GIT_COMMITTER_NAME: "S41 Test",
      GIT_COMMITTER_EMAIL: "s41@example.invalid",
      ...options.env,
    },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function git(repoDir: string, args: string[], options: { input?: string } = {}) {
  const result = run("git", ["-C", repoDir, ...args], repoRoot, options);
  assert.equal(result.status, 0, `git ${args.join(" ")}:\n${result.stderr}`);
  return result.stdout.trim();
}

function readManifest(): any[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// Throwaway TT var scratch (gitignored) with a committed git repo, an empty
// state dir, and a campaign dir — all under ttRoot so the snapshot
// machinery's containment checks pass. The DB carries the UNION schema O1 and
// O2 both consume (runs/steps/suite_results/tamandua_stats).
function scratch(): { root: string; stateDir: string; repoDir: string; campaignDir: string; databasePath: string } {
  fs.mkdirSync(varRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(varRoot, `s41-${process.pid}-`));
  const stateDir = path.join(root, "state");
  const campaignDir = path.join(root, "results", "campaign-s41");
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(path.join(stateDir, "events"), { recursive: true });
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.mkdirSync(repoDir);
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "S41 Test"]);
  git(repoDir, ["config", "user.email", "s41@example.invalid"]);
  fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "fixture"]);

  const databasePath = path.join(stateDir, "tamandua.db");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
      context TEXT, tokens_spent INTEGER,
      scheduling_status TEXT, scheduling_requested_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
      terminal_reroute_count INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT, step_index INTEGER, status TEXT, type TEXT, current_story_id TEXT,
      claim_pid INTEGER, claim_updated_at TEXT, updated_at TEXT
    );
    CREATE TABLE suite_results (
      id INTEGER PRIMARY KEY, origin_repo TEXT, tree_hash TEXT, cmd_hash TEXT,
      cmd_display TEXT, exit_code INTEGER, duration_ms INTEGER, log_tail TEXT,
      run_id TEXT, step_id TEXT, created_at TEXT
    );
    CREATE TABLE tamandua_stats (id INTEGER PRIMARY KEY, system_tokens_spent INTEGER);
    INSERT INTO tamandua_stats VALUES (1, 0);
  `);
  db.close();
  return { root, stateDir, repoDir, campaignDir, databasePath };
}

// ── The W4.10-restart-recovery two-landing git shape ────────────────────
// Two concurrent bug-fix-merge runs each land ONE feature state on main:
// base -> midCommit (run 1, branch feature) then midCommit -> finalCommit
// (run 2, branch feature2). Both update-refs write target-reflog transitions.
function buildTwoLandingShape(data: { repoDir: string }) {
  const base = git(data.repoDir, ["rev-parse", "HEAD"]);
  git(data.repoDir, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(data.repoDir, "feature.txt"), "wanted change\n");
  git(data.repoDir, ["add", "."]);
  git(data.repoDir, ["commit", "-q", "-m", "feature"]);
  const featureTree = git(data.repoDir, ["rev-parse", "HEAD^{tree}"]);
  fs.writeFileSync(path.join(data.repoDir, "feature.txt"), "second change\n");
  git(data.repoDir, ["add", "."]);
  git(data.repoDir, ["commit", "-q", "-m", "feature2"]);
  const featureTree2 = git(data.repoDir, ["rev-parse", "HEAD^{tree}"]);
  // Each landing owns its own source branch (O2's source-tree check).
  git(data.repoDir, ["branch", "feature2"]);
  git(data.repoDir, ["checkout", "-q", "feature2"]);
  git(data.repoDir, ["branch", "-f", "feature", "HEAD~1"]);
  const midCommit = git(data.repoDir, ["commit-tree", featureTree, "-p", base], { input: "land feature\n" });
  const finalCommit = git(data.repoDir, ["commit-tree", featureTree2, "-p", midCommit], { input: "land feature2\n" });
  git(data.repoDir, ["update-ref", "refs/heads/main", midCommit, base]);
  git(data.repoDir, ["update-ref", "refs/heads/main", finalCommit, midCommit]);
  return { base, featureTree, featureTree2, midCommit, finalCommit };
}

// Plant the terminal DB/event/suite evidence for the two-landing shape: both
// runs completed with their attested tested trees, one merge.landed event per
// run, and one ordinary exact-gate suite row per landed tree.
function plantTwoLandingEvidence(
  data: { databasePath: string; stateDir: string; repoDir: string },
  facts: { base: string; featureTree: string; featureTree2: string; midCommit: string; finalCommit: string },
) {
  const suiteOrigin = fs.realpathSync(data.repoDir);
  const db = new DatabaseSync(data.databasePath);
  db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    DB_ROOT_ID, "bug-fix-merge-worktree", "completed",
    JSON.stringify({ tested_tree: facts.featureTree, worktree_origin_repository: suiteOrigin }), 17,
    null, STARTED_AT, STARTED_AT, TERMINAL_AT,
  );
  db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    DB_SIBLING_ID, "bug-fix-merge-worktree", "completed",
    JSON.stringify({ tested_tree: facts.featureTree2, worktree_origin_repository: suiteOrigin }), 9,
    null, STARTED_AT, STARTED_AT, TERMINAL_AT,
  );
  db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "row-finalize-root", DB_ROOT_ID, "finalize_merge", 0, "synthetic_agent", 0, "done", "single", null, null, null, TERMINAL_AT,
  );
  db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "row-finalize-sibling", DB_SIBLING_ID, "finalize_merge", 0, "synthetic_agent", 0, "done", "single", null, null, null, TERMINAL_AT,
  );
  db.prepare("INSERT INTO suite_results VALUES (1, ?, ?, ?, ?, 0, 12, NULL, ?, ?, ?)").run(
    suiteOrigin, facts.featureTree, SUITE_CMD_HASH, "npm test", DB_ROOT_ID, "step-finalize", "2026-08-01T12:02:00.000Z",
  );
  db.prepare("INSERT INTO suite_results VALUES (2, ?, ?, ?, ?, 0, 12, NULL, ?, ?, ?)").run(
    suiteOrigin, facts.featureTree2, SUITE_CMD_HASH, "npm test", DB_SIBLING_ID, "step-finalize", "2026-08-01T12:02:30.000Z",
  );
  db.close();
  fs.writeFileSync(
    path.join(data.stateDir, "events", "all.jsonl"),
    [
      JSON.stringify({
        ts: "2026-08-01T12:02:00.000Z", event: "merge.landed", runId: ROOT_RUN_ID,
        origin: suiteOrigin, branch: "refs/heads/feature", target: "refs/heads/main",
        expectedTip: facts.base, mergedTree: facts.featureTree, mergedCommit: facts.midCommit, noop: false,
      }),
      JSON.stringify({
        ts: "2026-08-01T12:02:30.000Z", event: "merge.landed", runId: SIBLING_RUN_ID,
        origin: suiteOrigin, branch: "refs/heads/feature2", target: "refs/heads/main",
        expectedTip: facts.midCommit, mergedTree: facts.featureTree2, mergedCommit: facts.finalCommit, noop: false,
      }),
    ].join("\n") + "\n",
  );
}

// ── Snapshot-side helpers (S41) ───────────────────────────────────────
// A snapshot request whose attempt is the W4.10 concurrent shape: bound to
// the primary run but never harvested itself (steps null, tokens 0).
function snapshotRequest(data: { stateDir: string; repoDir: string; campaignDir: string; databasePath: string; root: string }, discoveredRuns: any[] = []) {
  return {
    ttRoot,
    campaignDir: data.campaignDir,
    stateDir: data.stateDir,
    databasePath: data.databasePath,
    repositoryPath: data.repoDir,
    chaosLogPath: path.join(data.root, "chaos", "chaos.log"),
    caseRecord: {
      id: "W4.10-restart-recovery", workflow: "bug-fix-merge-worktree", fixture: "tt-ts",
      harness: "pi", context: { merge_gate: "green", fail_missing: "1", test_cmd: "npm test" },
      boundary_files: ["src"], forbidden: [],
    },
    attempt: {
      id: "attempt-1", run_id: ROOT_RUN_ID, launch_intent_at: "2026-08-01T12:00:00.000Z",
      execution_mode: "real", terminal_status: "completed", tokens_observed: 0, steps_snapshot: null,
    },
    launchArgv: ["workflow", "run", "bug-fix-merge-worktree", "--context", "merge_gate=green"],
    discoveredRuns,
  };
}

function plantMultiRunProbeEvidence(data: { campaignDir: string }, rootSteps: any, rootTokens: number, siblingSteps: any, siblingTokens: number) {
  const probeEvidencePath = path.join(data.campaignDir, "evidence", "W4.10-restart-recovery", "attempt-1", "probe-evidence.json");
  fs.mkdirSync(path.dirname(probeEvidencePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(probeEvidencePath, `${JSON.stringify({
    schema_version: 1,
    case_id: "W4.10-restart-recovery",
    launch_shape: "concurrent",
    sequence_outcome: "completed",
    runs: [
      { run_ordinal: 1, run_id: ROOT_RUN_ID, terminal_status: "completed", tokens_observed: rootTokens, steps_snapshot: rootSteps, actions: [] },
      { run_ordinal: 2, run_id: SIBLING_RUN_ID, terminal_status: "completed", tokens_observed: siblingTokens, steps_snapshot: siblingSteps, actions: [] },
    ],
  }, null, 2)}\n`);
}

// ── O1-side helpers ───────────────────────────────────────────────────
function plantO1Database(data: { databasePath: string }) {
  const db = new DatabaseSync(data.databasePath);
  db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    DB_ROOT_ID, "bug-fix-merge-worktree", "completed", "{}", 17, null, STARTED_AT, STARTED_AT, TERMINAL_AT,
  );
  db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    DB_SIBLING_ID, "bug-fix-merge-worktree", "completed", "{}", 9, null, STARTED_AT, STARTED_AT, TERMINAL_AT,
  );
  db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "row-o1-root", DB_ROOT_ID, "finalize_merge", 0, "synthetic_agent", 0, "done", "single", null, null, null, TERMINAL_AT,
  );
  db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "row-o1-sibling", DB_SIBLING_ID, "finalize_merge", 0, "synthetic_agent", 0, "done", "single", null, null, null, TERMINAL_AT,
  );
  db.close();
}

function o1Evidence(campaignDir: string, snapshotsDir: string, workflowStatus: any) {
  const write = (name: string, value: any) => {
    const file = path.join(snapshotsDir, name);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return file;
  };
  const runEvents = write("run-events.json", {
    schema_version: 1, captured_at: CAPTURED_AT,
    rows: [
      { archive: "all.jsonl", line: 1, event: { ts: TERMINAL_AT, event: "run.completed", runId: ROOT_RUN_ID } },
      { archive: "all.jsonl", line: 2, event: { ts: TERMINAL_AT, event: "run.completed", runId: SIBLING_RUN_ID } },
    ],
  });
  const workflowStatusPath = write("workflow-status.json", workflowStatus);
  return {
    database_snapshot: path.join(snapshotsDir, "database.sqlite"),
    run_events: runEvents,
    workflow_status: workflowStatusPath,
  };
}

function o1Context(caseId: string, attempts: any[], discoveredRuns: any[]): any {
  const workflow = "bug-fix-merge-worktree";
  return {
    contract_version: 1,
    oracle_id: "O1",
    campaign: { id: `campaign-${caseId}`, created_at: STARTED_AT, manifest: { sha256: "a".repeat(64), case_count: 1, case_ids: [caseId] } },
    case: {
      id: caseId, wave: 4, workflow, fixture: "tt-ts", harness: "pi",
      class: "verification", caps: { tokens: 100, wall_min: 75 }, boundary_files: [], forbidden: [], chaos: null,
    },
    run_id: ROOT_RUN_ID,
    attempts,
    discovered_runs: discoveredRuns,
    o1_wave: {
      schema_version: 1, wave: 4,
      duration_floors: [{ workflow, case_id: caseId, duration_floor_ms: 300000, source: "production-median", sample_size: 0 }],
      runs: [...attempts, ...discoveredRuns]
        .filter((run) => typeof run?.run_id === "string")
        .map((run) => ({
          case_id: caseId, run_id: run.run_id, workflow,
          started_at: run.started_at ?? STARTED_AT, terminal_at: run.terminal_at ?? TERMINAL_AT,
          terminal_status: run.terminal_status ?? "completed", expected_fast_failure: false, execution_mode: "real",
        })),
    },
    mechanical_evidence: { schema_version: 1, references: {} },
  };
}

// ── O2-side helpers ───────────────────────────────────────────────────
function evidencePathsFor(completed: { references: Record<string, { path: string } | null> }, campaignDir: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(completed.references)
      .filter(([, ref]) => ref !== null)
      .map(([key, ref]) => [key, path.join(campaignDir, (ref as { path: string }).path)]),
  ) as Record<string, string>;
}

describe("S41 (US-004) — probe-sequence sibling runs in the evidence graph + O2 two-landing model", () => {
  it("RED-ARM: pins the W4.10-restart-recovery campaign void lines verbatim (second run run-2621299f absent; graph steps_snapshot null, tokens_observed 0, discovered_runs [])", () => {
    // The campaign void line is the adjudication's exact wording.
    assert.equal(
      W4_10_GRAPH_VOID_LINE,
      "workflow-status.json steps_snapshot null, tokens_observed 0, discovered_runs []",
    );
    // run-2621299f is a well-formed run id prefix (the full uuid lives in the
    // read-only campaign snapshot).
    assert.match(W4_10_SECOND_RUN_ID, /^run-[0-9a-f]{7}/);
    // The voiding oracle finding ids are the exact ids the campaign report
    // carried for W4.10-restart-recovery's O1/O11/O2 cells.
    assert.equal(W4_10_O1_VOID, "O1_WORKFLOW_STEPS_MISSING");
    assert.deepEqual(W4_10_O11_VOIDS, ["O11_CONTROLLER_TOTAL_MISMATCH", "O11_DELTA_RUN_UNKNOWN"]);
    assert.deepEqual(W4_10_O2_VOIDS, [
      "O2_LANDING_RUN_UNKNOWN", "O2_REF_TRANSITION_UNATTRIBUTED",
      "O2_REF_TRANSITION_COUNT", "O2_REF_EVENT_MISMATCH",
    ]);
    // The W4.10-restart-recovery manifest row declares the two-run
    // restart_daemon probe sequence (the shape whose second run the campaign
    // graph dropped) and O16 (the probe-evidence lifecycle oracle).
    const record = readManifest().find((item) => item.id === "W4.10-restart-recovery");
    assert.ok(record, "W4.10-restart-recovery must exist in tier2.jsonl");
    assert.equal(record.probe_sequence.length, 2, "W4.10-restart-recovery must declare a two-run probe sequence");
    for (const group of record.probe_sequence) {
      assert.ok(group.actions.some((action: any) => action.op === "restart_daemon"), "every W4.10-restart-recovery run group must declare restart_daemon");
    }
    assert.ok(record.oracles.includes("O16"), "W4.10-restart-recovery must declare O16");
  });

  it("RED-ARM: reproduces the pre-fix workflow-status graph void — O1 fires O1_WORKFLOW_STEPS_MISSING on the root and O1_WORKFLOW_STATUS_MISSING on a graph-missing sibling", () => {
    const data = scratch();
    try {
      plantO1Database(data);
      const snapshotsDir = path.join(data.campaignDir, "snapshots");
      fs.mkdirSync(snapshotsDir, { recursive: true });
      const dbCopy = path.join(snapshotsDir, "database.sqlite");
      fs.copyFileSync(data.databasePath, dbCopy);
      fs.chmodSync(dbCopy, 0o400);
      const rootSteps = {
        source: "workflow-status-json", captured_at: CAPTURED_AT,
        steps: [{ stepId: "finalize_merge", agentRole: "developer", status: "done" }],
      };
      const siblingSteps = {
        source: "workflow-status-json", captured_at: CAPTURED_AT,
        steps: [{ stepId: "finalize_merge", agentRole: "developer", status: "done" }],
      };
      const attemptProjection = {
        id: "attempt-root", kind: "workflow", phase: "terminal", execution_mode: "real",
        run_id: ROOT_RUN_ID, started_at: STARTED_AT, terminal_at: TERMINAL_AT,
        terminal_status: "completed", tokens_observed: 0, command_result: { exit_code: 0, signal: null },
        steps_snapshot: null, straggler_capture: null,
      };
      const siblingProjection = {
        ...attemptProjection, id: "attempt-sibling", run_id: SIBLING_RUN_ID,
        parent_run_id: ROOT_RUN_ID, tokens_observed: 9, steps_snapshot: siblingSteps,
      };

      // PRE-FIX graph: root steps_snapshot null + tokens_observed 0 and NO
      // sibling row (the campaign void). With the root in the context graph,
      // O1 fires O1_WORKFLOW_STEPS_MISSING on the root.
      const prefixed = o1Evidence(data.campaignDir, snapshotsDir, {
        schema_version: 1, captured_at: CAPTURED_AT,
        root: { run_id: ROOT_RUN_ID, terminal_status: "completed", tokens_observed: 0, steps_snapshot: null },
        discovered_runs: [],
      });
      const redContext = o1Context("W4.10-restart-recovery", [attemptProjection], []);
      const redEvidenceDir = path.join(data.campaignDir, "o1-red-evidence");
      fs.mkdirSync(redEvidenceDir);
      const red = evaluateO1({
        campaignRoot: data.campaignDir, evidenceDir: redEvidenceDir, evidencePaths: prefixed, context: redContext,
      });
      const redIds = red.findings.map((finding: any) => finding.id);
      assert.ok(redIds.includes("O1_WORKFLOW_STEPS_MISSING"), `pre-fix graph must fire O1_WORKFLOW_STEPS_MISSING: ${JSON.stringify(redIds)}`);

      // PRE-FIX graph vs POST-FIX context: the sibling IS in the context
      // graph (the controller now registers it) but the workflow-status row
      // is missing → O1_WORKFLOW_STATUS_MISSING (the sibling-invisible void).
      const mismatchEvidence = o1Evidence(data.campaignDir, snapshotsDir, {
        schema_version: 1, captured_at: CAPTURED_AT,
        root: { run_id: ROOT_RUN_ID, terminal_status: "completed", tokens_observed: 17, steps_snapshot: rootSteps },
        discovered_runs: [],
      });
      const mismatchContext = o1Context("W4.10-restart-recovery", [attemptProjection], [siblingProjection]);
      const mismatchEvidenceDir = path.join(data.campaignDir, "o1-mismatch-evidence");
      fs.mkdirSync(mismatchEvidenceDir);
      const mismatch = evaluateO1({
        campaignRoot: data.campaignDir, evidenceDir: mismatchEvidenceDir, evidencePaths: mismatchEvidence, context: mismatchContext,
      });
      const mismatchIds = mismatch.findings.map((finding: any) => finding.id);
      assert.ok(mismatchIds.includes("O1_WORKFLOW_STATUS_MISSING"), `graph-missing sibling must fire O1_WORKFLOW_STATUS_MISSING: ${JSON.stringify(mismatchIds)}`);
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC1/AC3): the post-fix terminal snapshot registers both probe runs in workflow-status.json with per-run terminal snapshots (root falls back to the primary probe run)", async () => {
    const data = scratch();
    try {
      const rootSteps = {
        source: "workflow-status-json", captured_at: CAPTURED_AT,
        steps: [{ stepId: "finalize_merge", agentRole: "developer", status: "done" }],
      };
      const siblingSteps = {
        source: "workflow-status-json", captured_at: CAPTURED_AT,
        steps: [{ stepId: "finalize_merge", agentRole: "developer", status: "done" }],
      };
      plantMultiRunProbeEvidence(data, rootSteps, 17, siblingSteps, 9);
      const request = snapshotRequest(data);
      fs.writeFileSync(`${data.databasePath}-wal`, "");
      const started = beginOracleEvidenceSnapshot(request);
      assert.equal(started.status, "BASELINE_CAPTURED");
      fs.rmSync(`${data.databasePath}-wal`);
      const completed = completeOracleEvidenceSnapshot(request, started);
      assert.equal(completed.status, "COMPLETE");
      const workflowStatus = JSON.parse(fs.readFileSync(
        path.join(data.campaignDir, completed.references.workflow_status.path), "utf8",
      )) as { root: any; discovered_runs: any[] };
      // ROOT: the primary probe run's terminal snapshot (the durable attempt
      // was never harvested in the concurrent shape).
      assert.equal(workflowStatus.root.run_id, ROOT_RUN_ID);
      assert.equal(workflowStatus.root.terminal_status, "completed");
      assert.equal(workflowStatus.root.tokens_observed, 17);
      assert.deepEqual(workflowStatus.root.steps_snapshot, rootSteps);
      // The sibling run is registered with its own terminal snapshot.
      const sibling = workflowStatus.discovered_runs.find((run) => run.run_id === SIBLING_RUN_ID);
      assert.ok(sibling, "probe-sequence sibling run must be registered in workflow-status.json");
      assert.equal(sibling.parent_run_id, ROOT_RUN_ID);
      assert.equal(sibling.terminal_status, "completed");
      assert.equal(sibling.tokens_observed, 9);
      assert.deepEqual(sibling.steps_snapshot, siblingSteps);
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC2): O1 PASSes the complete two-run graph (root steps + sibling row with terminal snapshots)", () => {
    const data = scratch();
    try {
      plantO1Database(data);
      const snapshotsDir = path.join(data.campaignDir, "snapshots");
      fs.mkdirSync(snapshotsDir, { recursive: true });
      const dbCopy = path.join(snapshotsDir, "database.sqlite");
      fs.copyFileSync(data.databasePath, dbCopy);
      fs.chmodSync(dbCopy, 0o400);
      const rootSteps = {
        source: "workflow-status-json", captured_at: CAPTURED_AT,
        steps: [{ stepId: "finalize_merge", agentRole: "developer", status: "done" }],
      };
      const siblingSteps = {
        source: "workflow-status-json", captured_at: CAPTURED_AT,
        steps: [{ stepId: "finalize_merge", agentRole: "developer", status: "done" }],
      };
      const attemptProjection = {
        id: "attempt-root", kind: "workflow", phase: "terminal", execution_mode: "real",
        run_id: ROOT_RUN_ID, started_at: STARTED_AT, terminal_at: TERMINAL_AT,
        terminal_status: "completed", tokens_observed: 17, command_result: { exit_code: 0, signal: null },
        steps_snapshot: rootSteps, straggler_capture: null,
      };
      const siblingProjection = {
        ...attemptProjection, id: "attempt-sibling", run_id: SIBLING_RUN_ID,
        parent_run_id: ROOT_RUN_ID, tokens_observed: 9, steps_snapshot: siblingSteps,
      };
      const evidence = o1Evidence(data.campaignDir, snapshotsDir, {
        schema_version: 1, captured_at: CAPTURED_AT,
        root: { run_id: ROOT_RUN_ID, terminal_status: "completed", tokens_observed: 17, steps_snapshot: rootSteps },
        discovered_runs: [{
          run_id: SIBLING_RUN_ID, parent_run_id: ROOT_RUN_ID, terminal_status: "completed",
          tokens_observed: 9, steps_snapshot: siblingSteps,
        }],
      });
      const greenContext = o1Context("W4.10-restart-recovery", [attemptProjection], [siblingProjection]);
      const greenEvidenceDir = path.join(data.campaignDir, "o1-green-evidence");
      fs.mkdirSync(greenEvidenceDir);
      const green = evaluateO1({
        campaignRoot: data.campaignDir, evidenceDir: greenEvidenceDir, evidencePaths: evidence, context: greenContext,
      });
      assert.equal(green.result, "PASS", `complete graph must PASS O1: ${JSON.stringify(green.findings)}`);
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("RED-ARM (AC2/AC3): the pre-fix O2 context (sibling absent from the captured graph) fails a REAL two-landing git shape with the campaign void findings", async () => {
    const data = scratch();
    try {
      const beforeSec = Math.floor(Date.now() / 1000) - 60;
      const facts = buildTwoLandingShape(data);
      plantTwoLandingEvidence(data, facts);
      const afterSec = Math.floor(Date.now() / 1000) + 60;
      const repoIdentity = { fixture_path: "synthetic/repo", git_common_dir: "synthetic/repo/.git", object_format: "sha1" };
      const gitTar = path.join(data.campaignDir, "repository.git.tar");
      run("tar", ["-C", path.join(data.repoDir, ".git"), "-cf", gitTar, "."], data.campaignDir);
      const suiteOrigin = fs.realpathSync(data.repoDir);
      const dbCopy = path.join(data.campaignDir, "database.sqlite");
      fs.copyFileSync(data.databasePath, dbCopy);
      fs.chmodSync(dbCopy, 0o400);
      const references: Record<string, any> = {
        refs_before: { captured_at: new Date(beforeSec * 1000).toISOString() },
        target_reflog: { captured_at: new Date(afterSec * 1000).toISOString() },
      };
      const evidencePaths = {
        database_snapshot: dbCopy,
        run_events: path.join(data.campaignDir, "run-events.json"),
        launch_intent: path.join(data.campaignDir, "launch-intent.json"),
        git_bundle: gitTar,
        refs_before: path.join(data.campaignDir, "refs-before.json"),
        refs_after: path.join(data.campaignDir, "refs-after.json"),
        target_reflog: path.join(data.campaignDir, "target-reflog.json"),
        suite_ledger: path.join(data.campaignDir, "suite-ledger.json"),
        suite_observations: path.join(data.campaignDir, "suite-observations.json"),
      };
      const write = (name: string, value: any) => {
        const file = path.join(data.campaignDir, name);
        fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400 });
        return file;
      };
      write("refs-before.json", {
        schema_version: 1, phase: "before", repository: repoIdentity,
        target_ref: "refs/heads/main", target_tip: facts.base, for_each_ref: "",
      });
      write("refs-after.json", {
        schema_version: 1, phase: "after", repository: repoIdentity,
        target_ref: "refs/heads/main", target_tip: facts.finalCommit,
        for_each_ref: git(data.repoDir, ["for-each-ref", "--sort=refname", "--format=%(objectname)%09%(objecttype)%09%(refname)%09%(upstream)"]),
      });
      write("target-reflog.json", {
        schema_version: 1, captured_at: new Date(afterSec * 1000).toISOString(),
        repository: repoIdentity, target_ref: "refs/heads/main",
        entries: git(data.repoDir, ["reflog", "--format=%gD", "refs/heads/main"]).length > 0
          ? readReflogEntries(data.repoDir, facts.base, facts.midCommit, facts.finalCommit)
          : [],
      });
      write("launch-intent.json", {
        schema_version: 1, captured_at: STARTED_AT,
        policy: { merge_gate: null, fail_missing: null },
        argv: ["workflow", "run", "bug-fix-merge-worktree"],
        argv_sha256: "a".repeat(64),
        gate_key: { origin_repo: suiteOrigin, cmd_hash: SUITE_CMD_HASH },
      });
      const suiteRows = new DatabaseSync(dbCopy, { readOnly: true })
        .prepare("SELECT * FROM suite_results ORDER BY id").all()
        .filter((row: any) => row.origin_repo === suiteOrigin);
      write("suite-ledger.json", { schema_version: 1, captured_at: CAPTURED_AT, rows: suiteRows });
      write("suite-observations.json", { schema_version: 1, captured_at: CAPTURED_AT, rows: [] });
      const db = new DatabaseSync(data.databasePath, { readOnly: true });
      const rootContext = db.prepare("SELECT context FROM runs WHERE id = ?").get(DB_ROOT_ID) as { context: string };
      const siblingContext = db.prepare("SELECT context FROM runs WHERE id = ?").get(DB_SIBLING_ID) as { context: string };
      db.close();
      const mergeLandingEvents = fs.readFileSync(path.join(data.stateDir, "events", "all.jsonl"), "utf8")
        .split(/\r?\n/).filter(Boolean)
        .map((line, index) => ({ archive: "all.jsonl", line: index + 1, event: JSON.parse(line) }));
      write("run-events.json", {
        schema_version: 1, captured_at: CAPTURED_AT,
        run_ids: [ROOT_RUN_ID, SIBLING_RUN_ID], rows: mergeLandingEvents,
      });
      const evidenceDir = path.join(data.campaignDir, "o2-evidence");
      fs.mkdirSync(evidenceDir);
      const makeContext = (discoveredRuns: any[]) => ({
        attempts: [{ run_id: ROOT_RUN_ID }],
        discovered_runs: discoveredRuns,
        mechanical_evidence: { references },
      });

      // PRE-FIX: the sibling run is absent from the captured graph (the
      // campaign shape) — the second landing + transition are unattributable
      // and the one-transition model flags the legal two-transition movement.
      const red = evaluateO2({
        campaignRoot: data.campaignDir, evidenceDir,
        evidencePaths, context: makeContext([]),
      });
      const redIds = red.findings.map((finding: any) => finding.id);
      for (const expected of W4_10_O2_VOIDS) {
        assert.ok(redIds.includes(expected), `pre-fix O2 context must fire ${expected}: ${JSON.stringify(redIds)}`);
      }
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC2): O2 PASSes the two-landing shape when both landings are attributed runs; the single-transition invariant stays for single-run shapes", async () => {
    const data = scratch();
    try {
      const beforeSec = Math.floor(Date.now() / 1000) - 60;
      const facts = buildTwoLandingShape(data);
      plantTwoLandingEvidence(data, facts);
      const afterSec = Math.floor(Date.now() / 1000) + 60;
      const repoIdentity = { fixture_path: "synthetic/repo", git_common_dir: "synthetic/repo/.git", object_format: "sha1" };
      const gitTar = path.join(data.campaignDir, "repository.git.tar");
      run("tar", ["-C", path.join(data.repoDir, ".git"), "-cf", gitTar, "."], data.campaignDir);
      const suiteOrigin = fs.realpathSync(data.repoDir);
      const dbCopy = path.join(data.campaignDir, "database.sqlite");
      fs.copyFileSync(data.databasePath, dbCopy);
      fs.chmodSync(dbCopy, 0o400);
      const references: Record<string, any> = {
        refs_before: { captured_at: new Date(beforeSec * 1000).toISOString() },
        target_reflog: { captured_at: new Date(afterSec * 1000).toISOString() },
      };
      const evidencePaths = {
        database_snapshot: dbCopy,
        run_events: path.join(data.campaignDir, "run-events.json"),
        launch_intent: path.join(data.campaignDir, "launch-intent.json"),
        git_bundle: gitTar,
        refs_before: path.join(data.campaignDir, "refs-before.json"),
        refs_after: path.join(data.campaignDir, "refs-after.json"),
        target_reflog: path.join(data.campaignDir, "target-reflog.json"),
        suite_ledger: path.join(data.campaignDir, "suite-ledger.json"),
        suite_observations: path.join(data.campaignDir, "suite-observations.json"),
      };
      const write = (name: string, value: any) => {
        const file = path.join(data.campaignDir, name);
        fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400 });
        return file;
      };
      write("refs-before.json", {
        schema_version: 1, phase: "before", repository: repoIdentity,
        target_ref: "refs/heads/main", target_tip: facts.base, for_each_ref: "",
      });
      write("refs-after.json", {
        schema_version: 1, phase: "after", repository: repoIdentity,
        target_ref: "refs/heads/main", target_tip: facts.finalCommit,
        for_each_ref: git(data.repoDir, ["for-each-ref", "--sort=refname", "--format=%(objectname)%09%(objecttype)%09%(refname)%09%(upstream)"]),
      });
      write("target-reflog.json", {
        schema_version: 1, captured_at: new Date(afterSec * 1000).toISOString(),
        repository: repoIdentity, target_ref: "refs/heads/main",
        entries: readReflogEntries(data.repoDir, facts.base, facts.midCommit, facts.finalCommit),
      });
      write("launch-intent.json", {
        schema_version: 1, captured_at: STARTED_AT,
        policy: { merge_gate: null, fail_missing: null },
        argv: ["workflow", "run", "bug-fix-merge-worktree"],
        argv_sha256: "a".repeat(64),
        gate_key: { origin_repo: suiteOrigin, cmd_hash: SUITE_CMD_HASH },
      });
      const db = new DatabaseSync(dbCopy, { readOnly: true });
      const suiteRows = db.prepare("SELECT * FROM suite_results ORDER BY id").all()
        .filter((row: any) => row.origin_repo === suiteOrigin);
      db.close();
      write("suite-ledger.json", { schema_version: 1, captured_at: CAPTURED_AT, rows: suiteRows });
      write("suite-observations.json", { schema_version: 1, captured_at: CAPTURED_AT, rows: [] });
      const mergeLandingEvents = fs.readFileSync(path.join(data.stateDir, "events", "all.jsonl"), "utf8")
        .split(/\r?\n/).filter(Boolean)
        .map((line, index) => ({ archive: "all.jsonl", line: index + 1, event: JSON.parse(line) }));
      write("run-events.json", {
        schema_version: 1, captured_at: CAPTURED_AT,
        run_ids: [ROOT_RUN_ID, SIBLING_RUN_ID], rows: mergeLandingEvents,
      });
      const evidenceDir = path.join(data.campaignDir, "o2-green-evidence");
      fs.mkdirSync(evidenceDir);

      // POST-FIX: both runs are in the captured graph (the controller now
      // registers the probe siblings), so the two-landing shape PASSes.
      const green = evaluateO2({
        campaignRoot: data.campaignDir, evidenceDir,
        evidencePaths,
        context: {
          attempts: [{ run_id: ROOT_RUN_ID }],
          discovered_runs: [{ run_id: SIBLING_RUN_ID, parent_run_id: ROOT_RUN_ID }],
          mechanical_evidence: { references },
        },
      });
      assert.equal(green.result, "PASS", `two-landing shape must PASS O2: ${JSON.stringify(green.findings)}`);
    } finally {
      fs.rmSync(data.root, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (AC2): the O2 oracle battery pins the two-landing fixtures — o2-two-landing PASS, broken-chain/unattributed FAIL, single-run O2_REF_TRANSITION_COUNT fixtures unchanged", () => {
    // The oracle self-test battery (oracles/self-test/run.sh) executes these
    // fixtures end-to-end; the S41 arm pins the EXPECTATIONS read-only so a
    // regression in the two-landing model or the single-transition invariant
    // is caught at the manifest level even when the heavy battery is skipped.
    const generator = fs.readFileSync(path.join(ttRoot, "oracles", "self-test", "generate-o2-fixtures.mjs"), "utf8");
    const expectations = [...generator.matchAll(/\{ name: '(o2-[^']+)', expected: '([^']+)'(?:, mutation: '([^']+)')?/g)]
      .map((match) => ({ name: match[1], expected: match[2], mutation: match[3] ?? null }));
    const twoLanding = expectations.filter((entry) => entry.mutation === "two-landing");
    assert.deepEqual(
      twoLanding.map((entry) => `${entry.name}:${entry.expected}`),
      ["o2-two-landing:PASS", "o2-two-landing-broken-chain:FAIL", "o2-two-landing-unattributed:FAIL"],
      "the O2 battery must pin the two-landing PASS + broken-chain/unattributed FAIL fixtures",
    );
    // The single-transition invariant is unchanged for single-run shapes: the
    // pre-existing O2_REF_TRANSITION_COUNT fixtures keep their FAIL
    // expectations.
    for (const name of ["o2-reflog-window-bypass", "o2-unparseable-reflog"]) {
      const entry = expectations.find((candidate) => candidate.name === name);
      assert.ok(entry, `${name} must exist in the O2 battery`);
      assert.equal(entry.expected, "FAIL", `${name} must stay FAIL (single-transition invariant)`);
    }
    const green = expectations.find((entry) => entry.name === "o2-green");
    assert.equal(green?.expected, "PASS", "o2-green must stay PASS");
  });
});

// Archive the REAL target-reflog transitions (logs/refs/heads/main) in the
// snapshot's parsed shape. The real update-ref writes base->mid and mid->final
// in order; the test paces the captured window around the landings so both
// entries' integer-second timestamps land inside it. The premise assertion
// (both landings present in the raw reflog) keeps the fixture honest.
function readReflogEntries(repoDir: string, base: string, mid: string, final: string): any[] {
  const raw = git(repoDir, ["reflog", "--format=%H", "refs/heads/main"]);
  const commits = raw.split(/\r?\n/).filter(Boolean);
  assert.ok(commits.includes(mid), `target reflog must carry the first landing (mid): ${JSON.stringify(commits)}`);
  assert.ok(commits.includes(final), `target reflog must carry the second landing (final): ${JSON.stringify(commits)}`);
  const now = Math.floor(Date.now() / 1000);
  return [
    { old_oid: base, new_oid: mid, timestamp: now, raw: `${base} ${mid} S41 Test <s41@example.invalid> ${now} +0000\tlanding 1` },
    { old_oid: mid, new_oid: final, timestamp: now, raw: `${mid} ${final} S41 Test <s41@example.invalid> ${now} +0000\tlanding 2` },
  ];
}
