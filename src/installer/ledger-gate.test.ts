import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { closeDb, getDb } from "../../dist/db.js";
import {
  evaluateFinalizeMergeLedgerGate,
  formatLedgerGateRefusal,
  type LedgerGateDecision,
  type LedgerGateRefusalDecision,
} from "../../dist/installer/ledger-gate.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { computeCmdHash, getOriginRepo } from "../../dist/suite/tree-hash.js";

const TEST_CMD = "npm test -- --runInBand ";
const TESTED_TREE = "0123456789abcdef0123456789abcdef01234567";

type LedgerState = "green" | "red" | "missing";
type GateMode = "default" | "green" | "off";

describe("finalize_merge ledger gate evaluator", () => {
  let fixtureRoot: string;
  let originRepo: string;
  let worktreeRepo: string;
  let stateDir: string;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;

  before(() => {
    fixtureRoot = tamanduaTempDir("tamandua-ledger-gate-repo-");
    originRepo = path.join(fixtureRoot, "origin");
    worktreeRepo = path.join(fixtureRoot, "managed-worktree");
    fs.mkdirSync(originRepo, { recursive: true });
    execFileSync("git", ["init"], { cwd: originRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ledger-gate@example.test"], { cwd: originRepo });
    execFileSync("git", ["config", "user.name", "Ledger Gate Test"], { cwd: originRepo });
    fs.writeFileSync(path.join(originRepo, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: originRepo });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: originRepo, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "ledger-gate-test", worktreeRepo], {
      cwd: originRepo,
      stdio: "ignore",
    });
  });

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-ledger-gate-state-");
    process.env.HOME = stateDir;
    process.env.TAMANDUA_STATE_DIR = path.join(stateDir, ".tamandua");
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, ".tamandua", "tamandua.db");
    closeDb();
    getDb();
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = originalDbPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  after(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function seedEligibleRun(mode: GateMode, options: { attested?: boolean; stepId?: string } = {}): void {
    const db = getDb();
    const context: Record<string, string> = {
      repo: worktreeRepo,
      worktree_origin_repository: originRepo,
      test_cmd: TEST_CMD,
      // This launch-time seed must never be accepted as an attestation.
      tested_tree: "seeded-run-creation-tree",
    };
    if (mode !== "default") context.merge_gate = mode;

    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES ('run-current', 'feature-dev-merge-worktree', 'task', 'running', ?, datetime('now'), datetime('now'))`,
    ).run(JSON.stringify(context));
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, created_at, updated_at)
       VALUES ('tester-step', 'run-current', 'test', 'tester', 0, '', '', 'done', ?, datetime('now'), datetime('now'))`,
    ).run(options.attested === false ? "STATUS: done\nRESULTS: no attestation" : `STATUS: done\nTESTED_TREE: ${TESTED_TREE}`);
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
       VALUES ('finalize-step', 'run-current', ?, 'merger', 1, '', '', 'pending', datetime('now'), datetime('now'))`,
    ).run(options.stepId ?? "finalize_merge");
  }

  function seedLedger(state: Exclude<LedgerState, "missing">): { latestId: number; latestCreatedAt: string } {
    const db = getDb();
    const origin = getOriginRepo(worktreeRepo);
    assert.equal(origin, fs.realpathSync(originRepo), "managed worktree must resolve to its origin repository");
    const cmdHash = computeCmdHash(TEST_CMD);
    const olderExitCode = state === "green" ? 9 : 0;
    const latestExitCode = state === "green" ? 0 : 7;

    db.prepare(
      `INSERT INTO suite_results
         (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, ?, 10, 'older', 'another-run', 'another-step', '2026-01-01T00:00:00.000Z')`,
    ).run(origin, TESTED_TREE, cmdHash, TEST_CMD, olderExitCode);
    const latestCreatedAt = "2026-01-02T00:00:00.000Z";
    const result = db.prepare(
      `INSERT INTO suite_results
         (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, ?, 20, 'latest', 'unrelated-run', 'unrelated-step', ?)`,
    ).run(origin, TESTED_TREE, cmdHash, TEST_CMD, latestExitCode, latestCreatedAt);
    return { latestId: Number(result.lastInsertRowid), latestCreatedAt };
  }

  function assertKey(decision: Exclude<LedgerGateDecision, { status: "inert" }>): void {
    assert.equal(decision.treeHash, TESTED_TREE);
    assert.equal(decision.cmdHash, computeCmdHash(TEST_CMD));
    assert.equal(decision.originRepo, fs.realpathSync(originRepo));
    assert.equal(
      decision.testedRepo,
      worktreeRepo,
      "the tested worktree path must be retained separately from the normalized ledger origin",
    );
    assert.equal(decision.testCmd, TEST_CMD, "the exact raw test command must be retained and hashed");
  }

  for (const mode of ["default", "green", "off"] as const) {
    for (const state of ["green", "red", "missing"] as const) {
      it(`returns the ${state}/${mode} decision`, () => {
        seedEligibleRun(mode);
        const latest = state === "missing" ? null : seedLedger(state);

        const decision = evaluateFinalizeMergeLedgerGate("finalize-step");

        if (mode === "off") {
          assert.equal(decision.status, "overridden");
          assertKey(decision);
          return;
        }
        assert.equal(decision.status, state);
        assert.equal(decision.gateMode, mode);
        assertKey(decision);
        if (state === "missing") {
          assert.equal("row" in decision, false);
        } else {
          assert.ok(latest);
          assert.equal(decision.row.id, latest.latestId, "latest matching row must win regardless of writer run");
          assert.equal(decision.row.createdAt, latest.latestCreatedAt);
          assert.equal(decision.row.runId, "unrelated-run");
          assert.equal(decision.row.exitCode, state === "green" ? 0 : 7);
        }
      });
    }
  }

  it("is inert for a non-finalize step despite a completed attestation and seeded tested_tree", () => {
    seedEligibleRun("default", { stepId: "review" });
    seedLedger("red");

    assert.deepEqual(evaluateFinalizeMergeLedgerGate("finalize-step"), {
      status: "inert",
      reason: "not_finalize_merge",
    });
  });

  it("is inert without an upstream TESTED_TREE attestation despite the run-creation seed", () => {
    seedEligibleRun("green", { attested: false });
    seedLedger("red");

    assert.deepEqual(evaluateFinalizeMergeLedgerGate("finalize-step"), {
      status: "inert",
      reason: "no_tested_tree_attestation",
    });
  });

  it("is inert when the raw run test_cmd is empty", () => {
    seedEligibleRun("default");
    const db = getDb();
    const context = JSON.parse((db.prepare("SELECT context FROM runs WHERE id = 'run-current'").get() as { context: string }).context);
    context.test_cmd = "   ";
    db.prepare("UPDATE runs SET context = ? WHERE id = 'run-current'").run(JSON.stringify(context));

    assert.deepEqual(evaluateFinalizeMergeLedgerGate("finalize-step"), {
      status: "inert",
      reason: "no_test_cmd",
    });
  });
});

describe("formatLedgerGateRefusal diagnostics", () => {
  let fixtureRoot: string;
  let originRepo: string;
  let worktreeRepo: string;
  let stateDir: string;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;

  before(() => {
    fixtureRoot = tamanduaTempDir("tamandua-refusal-diag-repo-");
    originRepo = path.join(fixtureRoot, "origin");
    worktreeRepo = path.join(fixtureRoot, "tested-worktree");
    fs.mkdirSync(originRepo, { recursive: true });
    execFileSync("git", ["init"], { cwd: originRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "refusal-diag@example.test"], { cwd: originRepo });
    execFileSync("git", ["config", "user.name", "Refusal Diag Test"], { cwd: originRepo });
    fs.writeFileSync(path.join(originRepo, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: originRepo });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: originRepo, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "refusal-diag-test", worktreeRepo], {
      cwd: originRepo,
      stdio: "ignore",
    });
  });

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-refusal-diag-state-");
    process.env.HOME = stateDir;
    process.env.TAMANDUA_STATE_DIR = path.join(stateDir, ".tamandua");
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, ".tamandua", "tamandua.db");
    closeDb();
    getDb();
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = originalDbPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
    // Clean up any test detritus from the shared repo
    try { fs.unlinkSync(path.join(originRepo, "unstaged.txt")); } catch { /* ok */ }
    execFileSync("git", ["clean", "-fd"], { cwd: worktreeRepo, stdio: "ignore" });
  });

  after(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function makeMissingDecision(options: { testedRepo?: string } = {}): LedgerGateRefusalDecision {
    return {
      status: "missing",
      gateMode: "default",
      originRepo: fs.realpathSync(originRepo),
      ...(options.testedRepo === undefined ? {} : { testedRepo: options.testedRepo }),
      treeHash: "abcdef1234567890abcdef1234567890abcdef12",
      cmdHash: computeCmdHash(TEST_CMD),
      testCmd: TEST_CMD,
    };
  }

  it("includes WORKSPACE_STATE clean for a clean repo", () => {
    const decision = makeMissingDecision();
    const output = formatLedgerGateRefusal(decision);
    assert.match(output, /^FAILURE_CLASS: refused_permanent$/m);
    assert.match(output, /^LEDGER_EVIDENCE: missing$/m);
    assert.match(output, /^WORKSPACE_STATE: clean$/m);
    assert.match(output, /^ACTION: execute the test suite/m);
  });

  it("includes WORKSPACE_STATE dirty with file count for a dirty repo", () => {
    // Make the repo dirty by adding an uncommitted file
    fs.writeFileSync(path.join(originRepo, "unstaged.txt"), "dirty\n");
    const decision = makeMissingDecision();
    const output = formatLedgerGateRefusal(decision);
    assert.match(output, /^FAILURE_CLASS: refused_permanent$/m);
    assert.match(output, /^WORKSPACE_STATE: dirty \(1 file: \?\? unstaged.txt\)$/m);
    assert.match(output, /^Uncommitted changes mean the tested tree/m);
    assert.match(output, /^ACTION: commit all workspace changes/m);
  });

  it("diagnoses a dirty tested worktree when its ledger origin is clean", () => {
    fs.writeFileSync(path.join(worktreeRepo, "worktree-only.txt"), "dirty\n");
    const decision = makeMissingDecision({ testedRepo: worktreeRepo });

    assert.equal(execFileSync("git", ["status", "--porcelain"], {
      cwd: originRepo,
      encoding: "utf-8",
    }).trim(), "", "the shared origin must remain clean for this regression");

    const output = formatLedgerGateRefusal(decision);
    assert.match(output, /^WORKSPACE_STATE: dirty \(1 file: \?\? worktree-only.txt\)$/m);
  });

  it("caps dirty tested-worktree diagnostics at 32 paths", () => {
    for (let index = 0; index < 35; index += 1) {
      fs.writeFileSync(path.join(worktreeRepo, `dirty-${String(index).padStart(2, "0")}.txt`), "dirty\n");
    }
    const output = formatLedgerGateRefusal(makeMissingDecision({ testedRepo: worktreeRepo }));
    const workspaceLine = output.split("\n").find((line) => line.startsWith("WORKSPACE_STATE:"));

    assert.ok(workspaceLine);
    assert.match(workspaceLine, /\?\? dirty-00\.txt/);
    assert.match(workspaceLine, /\?\? dirty-31\.txt/);
    assert.doesNotMatch(workspaceLine, /dirty-32\.txt/);
    assert.match(workspaceLine, /… and 3 more \(35 total\)/);
  });

  it("includes NEAREST_EVIDENCE none when no suite_results exist", () => {
    const decision = makeMissingDecision();
    const output = formatLedgerGateRefusal(decision);
    assert.match(output, /^NEAREST_EVIDENCE: none for this test command$/m);
    assert.match(output, /^No recording was ever made/m);
  });

  it("includes NEAREST_EVIDENCE with matching rows when evidence exists", () => {
    const db = getDb();
    const decision = makeMissingDecision();
    const otherTree = "9999999abcdef9999999abcdef9999999abc";
    db.prepare(
      `INSERT INTO suite_results
         (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 0, 100, 'log', 'some-run', 'some-step', ?)`,
    ).run(decision.originRepo, otherTree, decision.cmdHash, TEST_CMD, "2026-07-01T00:00:00.000Z");
    const output = formatLedgerGateRefusal(decision);
    assert.match(output, /^NEAREST_EVIDENCE: tree 9999999 exit 0 recorded 2026-07-01/m);
    assert.match(output, /^Evidence exists for a DIFFERENT tree/m);
  });

  it("falls back gracefully when git status fails (nonexistent repo)", () => {
    const decision: LedgerGateRefusalDecision = {
      status: "missing",
      gateMode: "default",
      originRepo: "/nonexistent/path/to/repo",
      treeHash: "abcdef1234567890abcdef1234567890abcdef12",
      cmdHash: computeCmdHash(TEST_CMD),
      testCmd: TEST_CMD,
    };
    const output = formatLedgerGateRefusal(decision);
    assert.match(output, /^FAILURE_CLASS: refused_permanent$/m);
    assert.match(output, /^WORKSPACE_STATE: unavailable$/m);
    assert.match(output, /^NEAREST_EVIDENCE: none for this test command$/m);
    assert.match(output, /^ACTION: ensure the workspace is clean/m);
  });

  it("format is unchanged for red decisions (diagnostics appended after existing red lines)", () => {
    const db = getDb();
    const origin = fs.realpathSync(originRepo);
    const cmdHash = computeCmdHash(TEST_CMD);
    const result = db.prepare(
      `INSERT INTO suite_results
         (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 7, 50, 'red-log', 'red-run', 'red-step', '2026-06-15T12:00:00.000Z')`,
    ).run(origin, "abcdef1234567890abcdef1234567890abcdef12", cmdHash, TEST_CMD);
    const decision: LedgerGateRefusalDecision = {
      status: "red",
      gateMode: "green",
      originRepo: origin,
      treeHash: "abcdef1234567890abcdef1234567890abcdef12",
      cmdHash,
      testCmd: TEST_CMD,
      row: {
        id: Number(result.lastInsertRowid),
        exitCode: 7,
        durationMs: 50,
        logTail: "red-log",
        runId: "red-run",
        stepId: "red-step",
        createdAt: "2026-06-15T12:00:00.000Z",
      },
    };
    const output = formatLedgerGateRefusal(decision);
    assert.match(output, /^FAILURE_CLASS: refused_permanent$/m);
    assert.match(output, /^LEDGER_EVIDENCE: red$/m);
    assert.match(output, /^LEDGER_ROW_ID: \d+$/m);
    assert.match(output, /^EXIT_CODE: 7$/m);
    assert.match(output, /^LOG_TAIL: red-log$/m);
    // Diagnostics are appended after
    assert.match(output, /^WORKSPACE_STATE: clean$/m);
    assert.match(output, /^NEAREST_EVIDENCE: tree abcdef1/m);
    assert.match(output, /^ACTION: execute the test suite/m);
  });
});
