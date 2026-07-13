import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { tamanduaTempDir, tamanduaTempRoot } from "../../dist/lib/temp-dir.js";

// ── Event helper ──

function readEventsForRun(
  stateDir: string,
  runId: string,
): Array<Record<string, unknown>> {
  const eventsFile = path.join(stateDir, "events", `${runId}.jsonl`);
  try {
    const content = fs.readFileSync(eventsFile, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function waitForRugpullEvents(
  stateDir: string,
  runId: string,
  maxWaitMs = 5000,
): Promise<Array<Record<string, unknown>>> {
  const start = Date.now();
  let rugpullEvents: Array<Record<string, unknown>> = [];
  while (Date.now() - start < maxWaitMs) {
    const events = readEventsForRun(stateDir, runId);
    rugpullEvents = events.filter(
      (e) =>
        e.event === "run.rugpull_detected" ||
        e.event === "run.rugpull_relaunched" ||
        e.event === "run.rugpull_relaunch_suppressed" ||
        e.event === "run.rugpull_relaunch_failed",
    );
    // Detection and its outcome are written by separate async steps —
    // returning on the first (detected) event races the relaunch path.
    // Wait for a terminal relaunch event; the timeout covers cases where
    // detection legitimately never fires.
    const hasTerminal = rugpullEvents.some(
      (e) =>
        e.event === "run.rugpull_relaunched" ||
        e.event === "run.rugpull_relaunch_suppressed" ||
        e.event === "run.rugpull_relaunch_failed",
    );
    if (hasTerminal) return rugpullEvents;
    await new Promise((r) => setTimeout(r, 50));
  }
  return rugpullEvents;
}

// ── Helpers ──

function runGit(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

function initGitRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  runGit(["init", "--initial-branch=main"], dir);
  runGit(["config", "user.email", "test@tamandua.local"], dir);
  runGit(["config", "user.name", "Tamandua Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf-8");
  runGit(["add", "README.md"], dir);
  runGit(["commit", "-m", "initial commit"], dir);
  const sha = runGit(["rev-parse", "HEAD"], dir);
  assert.ok(sha, "initial commit SHA must exist");
  return sha;
}

function makeCommit(dir: string, message: string): string {
  fs.writeFileSync(
    path.join(dir, "counter.txt"),
    String(Date.now()),
    "utf-8",
  );
  runGit(["add", "counter.txt"], dir);
  runGit(["commit", "-m", message], dir);
  const sha = runGit(["rev-parse", "HEAD"], dir);
  assert.ok(sha, "commit SHA must exist");
  return sha;
}

function insertRun(
  db: ReturnType<typeof import("../../dist/db.js")["getDb"]>,
  runId: string,
  workflowId: string,
  context: Record<string, string>,
  status: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, 1, ?, 'test', ?, ?, 0, ?, ?)`,
  ).run(runId, workflowId, status, JSON.stringify(context), now, now);
}

function insertStep(
  db: ReturnType<typeof import("../../dist/db.js")["getDb"]>,
  stepId: string,
  runId: string,
  stepNameId: string,
  status: string,
  stepIndex: number,
  type: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at)
     VALUES (?, ?, ?, 'dev', ?, 'input', 'STATUS', ?, 0, 4, ?, ?, ?)`,
  ).run(stepId, runId, stepNameId, stepIndex, status, type, now, now);
}

function insertWorktree(
  db: ReturnType<typeof import("../../dist/db.js")["getDb"]>,
  runId: string,
  originRepo: string,
  opts?: { worktreeOriginRef?: string; originalBranch?: string },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO run_worktrees (run_id, worktree_origin_repository, worktree_origin_git_common_dir, worktree_path, worktree_origin_ref, worktree_origin_sha, original_branch, status, cleanup_policy, created_at)
     VALUES (?, ?, ?, ?, ?, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', ?, 'creating', 'remove_on_success', ?)`,
  ).run(runId, originRepo, path.join(originRepo, ".git"), path.join(originRepo, "wt"), opts?.worktreeOriginRef ?? null, opts?.originalBranch ?? null, now);
}

// ── Test suite ──

describe("detectRugpull", () => {
  let tempHome: string;
  let repoDir: string;
  let initialSha: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;
  let origStateDir: string | undefined;

  before(() => {
    tempHome = tamanduaTempDir("tamandua-rugpull-");
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    origStateDir = process.env.TAMANDUA_STATE_DIR;

    const tamanduaDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(tamanduaDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_STATE_DIR = tamanduaDir;

    // Create a git repo for direct-mode tests
    repoDir = path.join(tempHome, "test-repo");
    initialSha = initGitRepo(repoDir);
  });

  after(() => {
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    if (origStateDir !== undefined) {
      process.env.TAMANDUA_STATE_DIR = origStateDir;
    } else {
      delete process.env.TAMANDUA_STATE_DIR;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns isRugpull=true for merge workflow with moved base branch (direct mode)", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Make a second commit so HEAD differs from initialSha
    const newSha = makeCommit(repoDir, "second commit");
    assert.notEqual(newSha, initialSha, "new commit must differ from initial");

    const runId = "run-rugpull-direct-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      base_branch_sha: initialSha,
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true, "should detect rugpull");
    assert.ok(result.reason?.includes("moved"), "reason should mention base moved");
  });

  it("returns isRugpull=true for merge-worktree workflow with moved base branch", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Create a separate origin repo for worktree test
    const originDir = path.join(tempHome, "test-origin-wt-rugpull");
    const originInitialSha = initGitRepo(originDir);
    // Move it forward
    const newSha = makeCommit(originDir, "second commit in origin");
    assert.notEqual(newSha, originInitialSha);

    const runId = "run-rugpull-wt-01";
    insertRun(db, runId, "bug-fix-merge-worktree", {
      repo: path.join(originDir, "wt"),
      working_directory_for_harness: path.join(originDir, "wt"),
      base_branch_sha: originInitialSha,
      workspace_mode: "worktree",
      worktree_path: path.join(originDir, "wt"),
      worktree_origin_repository: originDir,
      worktree_origin_sha: originInitialSha,
    }, "failed");
    insertStep(db, "step-wt-01", runId, "finalize_merge", "failed", 0, "single");
    insertWorktree(db, runId, originDir);

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true, "should detect rugpull for worktree mode");
  });

  it("worktree mode: does NOT false-rugpull when origin HEAD moves but origin_ref is unchanged", async () => {
    // Regression: HEAD in origin repo may be on main while the run used
    // --worktree-origin-ref develop. If main moves but develop does not,
    // the old HEAD-based detection would falsely flag a rugpull.
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Create an origin repo with main committed.
    const originDir = path.join(tempHome, "test-origin-wt-false-positive");
    initGitRepo(originDir); // main branch, commit A
    const mainSha = runGit(["rev-parse", "main"], originDir);
    assert.ok(mainSha);

    // Create develop branch at the same commit as main.
    runGit(["branch", "develop"], originDir);
    const developSha = runGit(["rev-parse", "develop"], originDir);
    assert.equal(developSha, mainSha, "develop and main start at same commit");

    // Move main forward (simulating someone pushing to main while the run
    // was using develop).
    fs.writeFileSync(path.join(originDir, "on-main.txt"), "main moved");
    runGit(["add", "on-main.txt"], originDir);
    runGit(["commit", "-m", "main moves forward"], originDir);
    const newMainSha = runGit(["rev-parse", "main"], originDir);
    assert.notEqual(newMainSha, developSha, "main moved, develop did not");

    // Now verify develop is still at the old SHA.
    const developStill = runGit(["rev-parse", "develop"], originDir);
    assert.equal(developStill, developSha, "develop unchanged");

    const runId = "run-wt-false-positive-01";
    insertRun(db, runId, "bug-fix-merge-worktree", {
      repo: path.join(originDir, "wt"),
      working_directory_for_harness: path.join(originDir, "wt"),
      base_branch_sha: developSha!,
      workspace_mode: "worktree",
      worktree_path: path.join(originDir, "wt"),
      worktree_origin_repository: originDir,
      worktree_origin_ref: "develop",
      worktree_origin_sha: developSha!,
    }, "failed");
    insertStep(db, "step-wt-fp-01", runId, "finalize_merge", "failed", 0, "single");
    insertWorktree(db, runId, originDir, { worktreeOriginRef: "develop" });

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false,
      "should NOT detect rugpull: origin_ref (develop) did not move even though HEAD (main) did");
    assert.ok(
      result.reason?.includes("not changed"),
      `reason should indicate SHA unchanged, got: ${result.reason}`,
    );
  });

  it("worktree mode: detects true rugpull when origin_ref actually moved", async () => {
    // True positive: the actual origin ref used by the run moved.
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const originDir = path.join(tempHome, "test-origin-wt-true-pos");
    const developSha = initGitRepo(originDir);
    runGit(["branch", "develop"], originDir);

    // Move develop forward (actual rugpull).
    runGit(["checkout", "develop"], originDir);
    fs.writeFileSync(path.join(originDir, "on-develop.txt"), "develop moved");
    runGit(["add", "on-develop.txt"], originDir);
    runGit(["commit", "-m", "develop moves"], originDir);
    const newDevelopSha = runGit(["rev-parse", "develop"], originDir);
    assert.notEqual(newDevelopSha, developSha, "develop moved");

    const runId = "run-wt-true-pos-01";
    insertRun(db, runId, "bug-fix-merge-worktree", {
      repo: path.join(originDir, "wt"),
      working_directory_for_harness: path.join(originDir, "wt"),
      base_branch_sha: developSha!,
      workspace_mode: "worktree",
      worktree_path: path.join(originDir, "wt"),
      worktree_origin_repository: originDir,
      worktree_origin_ref: "develop",
      worktree_origin_sha: developSha!,
    }, "failed");
    insertStep(db, "step-wt-tp-01", runId, "finalize_merge", "failed", 0, "single");
    insertWorktree(db, runId, originDir, { worktreeOriginRef: "develop" });

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true, "should detect rugpull when origin_ref actually moved");
    assert.ok(result.reason?.includes("moved"), "reason should mention base moved");
  });

  it("worktree mode: resolves sha against explicit worktree_origin_ref when HEAD points elsewhere (OREF)", async () => {
    // Test that detectRugpull uses the explicit worktree_origin_ref for
    // current sha resolution, not HEAD. When the explicit ref moved but
    // HEAD did not, rugpull should still be detected.
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Create origin repo with main (HEAD) at commit A.
    const originDir = path.join(tempHome, "test-origin-wt-explicit-ref");
    const commitA = initGitRepo(originDir);

    // Create feature branch at commit A, then move it forward.
    runGit(["branch", "feature"], originDir);
    runGit(["checkout", "feature"], originDir);
    fs.writeFileSync(path.join(originDir, "feature-work.txt"), "work");
    runGit(["add", "feature-work.txt"], originDir);
    runGit(["commit", "-m", "work on feature"], originDir);
    const commitB = runGit(["rev-parse", "HEAD"], originDir);
    assert.notEqual(commitB, commitA);

    // Switch HEAD back to main at commit A.
    runGit(["checkout", "main"], originDir);
    const headNow = runGit(["rev-parse", "HEAD"], originDir);
    assert.equal(headNow, commitA, "HEAD is back on main at commit A");

    // Verify feature is at commit B.
    const featureNow = runGit(["rev-parse", "feature"], originDir);
    assert.equal(featureNow, commitB, "feature is at commit B");

    // Run context: base was at commit A, explicit ref is feature → moved to B.
    const runId = "run-wt-explicit-ref-01";
    insertRun(db, runId, "bug-fix-merge-worktree", {
      repo: path.join(originDir, "wt"),
      working_directory_for_harness: path.join(originDir, "wt"),
      base_branch_sha: commitA!,
      workspace_mode: "worktree",
      worktree_path: path.join(originDir, "wt"),
      worktree_origin_repository: originDir,
      worktree_origin_ref: "feature",
      worktree_origin_sha: commitA!,
    }, "failed");
    insertStep(db, "step-wt-er-01", runId, "finalize_merge", "failed", 0, "single");
    insertWorktree(db, runId, originDir, { worktreeOriginRef: "feature" });

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true,
      "should detect rugpull when explicit worktree_origin_ref moved even though HEAD did not");
    assert.ok(result.reason?.includes("moved"), "reason should mention base moved");
  });

  it("worktree mode: falls back to HEAD when worktree_origin_ref is not in context (OREF)", async () => {
    // Test that when worktree_origin_ref is absent from the run context,
    // detectRugpull falls back to HEAD in the origin repo for sha resolution.
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Create origin repo at commit A, then move HEAD forward to commit B.
    const originDir = path.join(tempHome, "test-origin-wt-head-fallback");
    const commitA = initGitRepo(originDir);
    const commitB = makeCommit(originDir, "HEAD moves forward");
    assert.notEqual(commitB, commitA);

    // HEAD is at commit B now.
    const headNow = runGit(["rev-parse", "HEAD"], originDir);
    assert.equal(headNow, commitB);

    // Run context: no worktree_origin_ref key → must fall back to HEAD.
    const runId = "run-wt-head-fallback-01";
    insertRun(db, runId, "bug-fix-merge-worktree", {
      repo: path.join(originDir, "wt"),
      working_directory_for_harness: path.join(originDir, "wt"),
      base_branch_sha: commitA!,
      workspace_mode: "worktree",
      worktree_path: path.join(originDir, "wt"),
      worktree_origin_repository: originDir,
      worktree_origin_sha: commitA!,
      // Deliberately omit worktree_origin_ref — should fall back to HEAD
    }, "failed");
    insertStep(db, "step-wt-hf-01", runId, "finalize_merge", "failed", 0, "single");
    insertWorktree(db, runId, originDir);

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true,
      "should detect rugpull via HEAD fallback when worktree_origin_ref is absent");
    assert.ok(result.reason?.includes("moved"), "reason should mention base moved");
  });

  it("direct mode: does NOT false-rugpull when HEAD is on feature branch but base branch is unchanged", async () => {
    // Regression: after a final-merge failure, HEAD may be on the feature
    // branch, but the base branch (original_branch) did not move.
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Create a repo with main at commit A.
    const dir = path.join(tempHome, "test-direct-false-positive");
    const mainSha = initGitRepo(dir);

    // Create a feature branch at the same commit.
    runGit(["branch", "feature/fix"], dir);

    // Move the feature branch forward (simulating work done on it).
    runGit(["checkout", "feature/fix"], dir);
    fs.writeFileSync(path.join(dir, "feature-work.txt"), "feature work");
    runGit(["add", "feature-work.txt"], dir);
    runGit(["commit", "-m", "work on feature"], dir);
    const featureSha = runGit(["rev-parse", "feature/fix"], dir);
    assert.notEqual(featureSha, mainSha, "feature moved, main did not");

    // main is still at the original SHA.
    const mainStill = runGit(["rev-parse", "main"], dir);
    assert.equal(mainStill, mainSha, "main unchanged");

    // Simulate: run started on main (base_branch_sha = mainSha), final-merge
    // failed, leaving HEAD on feature/fix.
    const runId = "run-direct-fp-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: dir,
      working_directory_for_harness: dir,
      base_branch_sha: mainSha!,
      original_branch: "main",
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-dir-fp-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false,
      "should NOT detect rugpull: base branch (main) did not move even though HEAD (feature/fix) did");
    assert.ok(
      result.reason?.includes("not changed"),
      `reason should indicate SHA unchanged, got: ${result.reason}`,
    );
  });

  it("direct mode: detects true rugpull when original_branch actually moved", async () => {
    // True positive: the recorded base branch actually moved.
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const dir = path.join(tempHome, "test-direct-true-pos");
    const mainSha = initGitRepo(dir);

    // Move main forward (true rugpull).
    fs.writeFileSync(path.join(dir, "main-moved.txt"), "main advanced");
    runGit(["add", "main-moved.txt"], dir);
    runGit(["commit", "-m", "main moves forward"], dir);
    const newMainSha = runGit(["rev-parse", "main"], dir);
    assert.notEqual(newMainSha, mainSha, "main moved");

    const runId = "run-direct-tp-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: dir,
      working_directory_for_harness: dir,
      base_branch_sha: mainSha!,
      original_branch: "main",
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-dir-tp-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true, "should detect rugpull when base branch actually moved");
    assert.ok(result.reason?.includes("moved"), "reason should mention base moved");
  });

  it("direct mode: falls back to HEAD when original_branch is missing", async () => {
    // Backward compatibility: when original_branch is not in context
    // (e.g. runs created before this fix), fall back to HEAD.
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const dir = path.join(tempHome, "test-direct-fallback");
    const initialSha = initGitRepo(dir);
    const newSha = makeCommit(dir, "second commit");
    assert.notEqual(newSha, initialSha);

    const runId = "run-direct-fallback-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: dir,
      working_directory_for_harness: dir,
      base_branch_sha: initialSha,
      workspace_mode: "direct",
      // no original_branch — falls back to HEAD
    }, "failed");
    insertStep(db, "step-dir-fb-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true,
      "should still detect rugpull via HEAD fallback when original_branch is missing");
  });

  it("returns isRugpull=false for non-merge workflows", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-non-merge-01";
    insertRun(db, runId, "security-audit", {
      repo: repoDir,
      base_branch_sha: initialSha,
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-nm-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false, "non-merge workflow should not be rugpull");
    assert.ok(result.reason?.includes("not a merge workflow"), "reason should explain");
  });

  it("returns isRugpull=false when base SHA has not moved", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Use a fresh repo so HEAD matches the recorded base_branch_sha exactly
    const freshDir = path.join(tempHome, "test-repo-sha-same");
    const currentSha = initGitRepo(freshDir);

    const runId = "run-sha-same-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: freshDir,
      working_directory_for_harness: freshDir,
      base_branch_sha: currentSha,
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-same-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false, "unchanged base should not be rugpull");
    assert.ok(result.reason?.includes("not changed"), "reason should mention SHA unchanged");
  });

  it("returns isRugpull=false when failing step is not finalize_merge", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-not-finalize-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      base_branch_sha: initialSha,
      workspace_mode: "direct",
    }, "failed");
    // Failed step is "plan", not "finalize_merge"
    insertStep(db, "step-nf-01", runId, "plan", "failed", 0, "single");

    // Also add a passing finalize_merge to ensure we're checking only failed ones
    insertStep(db, "step-nf-02", runId, "finalize_merge", "done", 1, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false, "non-finalize_merge failure should not be rugpull");
    assert.ok(result.reason?.includes("No failed finalize_merge"), "reason should explain");
  });

  it("returns isRugpull=false when base_branch_sha is missing from context", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-no-sha-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      // no base_branch_sha
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-ns-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false, "missing SHA should not be rugpull");
    assert.ok(result.reason?.includes("Missing base_branch_sha"), "reason should explain");
  });

  it("returns isRugpull=false when base_branch_sha is empty string", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-empty-sha-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      base_branch_sha: "",
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-es-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false, "empty SHA should not be rugpull");
    assert.ok(result.reason?.includes("Missing base_branch_sha"), "reason should explain");
  });

  it("returns isRugpull=false when run does not exist", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );

    // No DB rows inserted — run should not be found
    const result = detectRugpull("nonexistent-run-id");
    assert.equal(result.isRugpull, false, "nonexistent run should not be rugpull");
    assert.equal(result.reason, "Run not found");
  });

  it("handles merge workflows that end with '-merge' but not '-merge-worktree'", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-plain-merge-01";
    // Use a pre-committed SHA so the new commit is newer
    const shaBeforeCommit = runGit(["rev-parse", "HEAD"], repoDir);
    const newSha = makeCommit(repoDir, "plain merge test commit");
    assert.notEqual(newSha, shaBeforeCommit);

    insertRun(db, runId, "some-custom-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      base_branch_sha: shaBeforeCommit!,
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-pm-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true,
      "workflows ending in '-merge' (but not '-merge-worktree') should still be detected");
  });

  it("handles workflows that end in '-merge-worktree'", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-mwt-01";
    const shaBefore = runGit(["rev-parse", "HEAD"], repoDir);
    const newSha = makeCommit(repoDir, "merge-worktree test commit");
    assert.notEqual(newSha, shaBefore);

    insertRun(db, runId, "feature-dev-merge-worktree", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      base_branch_sha: shaBefore!,
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-mwt-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true,
      "merge-worktree workflows should be detected");
  });

  it("handles failed run with multiple steps and finalize_merge among them", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const shaBefore = runGit(["rev-parse", "HEAD"], repoDir);
    const newSha = makeCommit(repoDir, "multi-step test");
    assert.notEqual(newSha, shaBefore);

    const runId = "run-multi-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      base_branch_sha: shaBefore!,
      workspace_mode: "direct",
    }, "failed");
    // Multiple steps — finalize_merge is the one that failed
    insertStep(db, "step-m-plan", runId, "plan", "done", 0, "single");
    insertStep(db, "step-m-setup", runId, "setup", "done", 1, "single");
    insertStep(db, "step-m-implement", runId, "implement", "done", 2, "loop");
    insertStep(db, "step-m-final", runId, "finalize_merge", "failed", 3, "single");
    insertStep(db, "step-m-verify", runId, "verify", "waiting", 4, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true,
      "should find the failed finalize_merge step among other steps");
  });

  it("returns isRugpull=false for workflow ending with '-merge-substring' but not '-merge'", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // "some-merge-helper" ends with "-helper", not "-merge" or "-merge-worktree"
    const runId = "run-merge-substr-01";
    insertRun(db, runId, "some-merge-helper", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      base_branch_sha: initialSha,
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-ms-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false,
      "workflows with '-merge' as substring but not suffix should not be detected");
    assert.ok(result.reason?.includes("not a merge workflow"), "reason should explain");
  });

  it("returns isRugpull=false for worktree mode when worktree record is missing", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-wt-missing-01";
    insertRun(db, runId, "feature-dev-merge-worktree", {
      workspace_mode: "worktree",
      base_branch_sha: "abc123def456789",
    }, "failed");
    insertStep(db, "step-wtm-01", runId, "finalize_merge", "failed", 0, "single");
    // No worktree row inserted — detectRugpull should handle this gracefully

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false,
      "missing worktree record should not be a rugpull");
    assert.ok(result.reason?.includes("Worktree record not found"), "reason should explain");
  });

  it("includes reason with SHA abbreviation in rugpull result", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const shaBefore = runGit(["rev-parse", "HEAD"], repoDir);
    const newSha = makeCommit(repoDir, "reason test");
    assert.notEqual(newSha, shaBefore);

    const runId = "run-reason-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      base_branch_sha: shaBefore!,
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-r-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true);
    assert.ok(result.reason, "reason should be set");
    assert.ok(result.reason.includes(shaBefore!.slice(0, 7)), "reason should include old SHA prefix");
    assert.ok(result.reason.includes(newSha.slice(0, 7)), "reason should include new SHA prefix");
  });

  // ── Self-merge detection (US-002) ──

  it("returns isRugpull=false and emits self_merge_detected when tested_tree matches current tip tree (direct mode)", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Create a repo with initial commit, then a second commit.
    const dir = path.join(tempHome, "test-self-merge-direct");
    const initialSha = initGitRepo(dir);
    const newSha = makeCommit(dir, "second commit");
    assert.notEqual(newSha, initialSha);

    // Resolve the tree hash of the second commit (the current tip)
    const newTree = runGit(["rev-parse", `${newSha}^{tree}`], dir)!;
    assert.ok(newTree, "should resolve tree hash");
    assert.equal(newTree.length, 40, "tree hash should be 40 chars");
    assert.notEqual(newTree, newSha, "tree hash should differ from commit hash");

    const runId = "run-self-merge-direct-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: dir,
      working_directory_for_harness: dir,
      base_branch_sha: initialSha,
      tested_tree: newTree,
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-sm-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false, "should suppress rugpull when tree matches");
    assert.equal(result.reason, "own merge already landed");

    // Verify event was emitted
    const events = readEventsForRun(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );
    const selfMergeEvents = events.filter(
      (e) => e.event === "rugpull.self_merge_detected",
    );
    assert.equal(selfMergeEvents.length, 1, "should emit one self_merge_detected event");
    assert.equal(selfMergeEvents[0].runId, runId);
    assert.ok(
      String(selfMergeEvents[0].detail).includes("Own merge"),
      "event detail should mention Own merge",
    );
    // Verify no rugpull_detected event was emitted
    const rugpullEvents = events.filter(
      (e) => e.event === "run.rugpull_detected",
    );
    assert.equal(rugpullEvents.length, 0, "should NOT emit rugpull_detected when tree matches");
  });

  it("returns isRugpull=true when tested_tree is present but differs from current tip tree (direct mode)", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Create a repo with initial commit and second commit.
    const dir = path.join(tempHome, "test-tree-differs-direct");
    const initialSha = initGitRepo(dir);
    const newSha = makeCommit(dir, "second commit");
    assert.notEqual(newSha, initialSha);

    // Get the tree of the initial commit (different from newSha's tree)
    const initialTree = runGit(["rev-parse", `${initialSha}^{tree}`], dir)!;
    assert.ok(initialTree, "should resolve initial tree hash");
    const newTree = runGit(["rev-parse", `${newSha}^{tree}`], dir)!;
    assert.notEqual(initialTree, newTree, "trees should differ");

    // Run has tested_tree = initial commit's tree, but current tip is newSha
    // with a different tree → rugpull should still be detected.
    const runId = "run-tree-differs-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: dir,
      working_directory_for_harness: dir,
      base_branch_sha: initialSha,
      tested_tree: initialTree,
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-td-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true, "should detect rugpull when trees differ");
    assert.ok(result.reason?.includes("moved"), "reason should mention base moved");

    // Verify no self_merge_detected event was emitted
    const events = readEventsForRun(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );
    const selfMergeEvents = events.filter(
      (e) => e.event === "rugpull.self_merge_detected",
    );
    assert.equal(selfMergeEvents.length, 0, "should NOT emit self_merge_detected when trees differ");
  });

  it("returns isRugpull=true when tested_tree is present but empty/absent from context (direct mode)", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const shaBefore = runGit(["rev-parse", "HEAD"], repoDir);
    const newSha = makeCommit(repoDir, "empty tested_tree test");
    assert.notEqual(newSha, shaBefore);

    // tested_tree is empty string — should behave as absent
    const runId = "run-empty-tree-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      base_branch_sha: shaBefore!,
      tested_tree: "",
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-et-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, true, "empty tested_tree should behave as absent");
    assert.ok(result.reason?.includes("moved"), "reason should mention base moved");

    // Also test: tested_tree key missing entirely — should still detect rugpull
    const runId2 = "run-no-tree-key-01";
    insertRun(db, runId2, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      base_branch_sha: shaBefore!,
      workspace_mode: "direct",
    }, "failed");
    insertStep(db, "step-ntk-01", runId2, "finalize_merge", "failed", 0, "single");

    const result2 = detectRugpull(runId2);
    assert.equal(result2.isRugpull, true, "missing tested_tree should still detect rugpull");
    assert.ok(result2.reason?.includes("moved"), "reason should mention base moved");
  });

  it("returns isRugpull=false and emits self_merge_detected for worktree mode when tree matches", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Create an origin repo with initial commit, then move it forward.
    const originDir = path.join(tempHome, "test-self-merge-worktree");
    const originInitialSha = initGitRepo(originDir);
    const newSha = makeCommit(originDir, "second commit in origin");
    assert.notEqual(newSha, originInitialSha);

    // Resolve the tree of the new tip
    const newTree = runGit(["rev-parse", `${newSha}^{tree}`], originDir)!;
    assert.ok(newTree, "should resolve tree hash");

    const runId = "run-self-merge-wt-01";
    insertRun(db, runId, "bug-fix-merge-worktree", {
      repo: path.join(originDir, "wt"),
      working_directory_for_harness: path.join(originDir, "wt"),
      base_branch_sha: originInitialSha,
      tested_tree: newTree,
      workspace_mode: "worktree",
      worktree_path: path.join(originDir, "wt"),
      worktree_origin_repository: originDir,
      worktree_origin_sha: originInitialSha,
    }, "failed");
    insertStep(db, "step-sm-wt-01", runId, "finalize_merge", "failed", 0, "single");
    insertWorktree(db, runId, originDir);

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false, "should suppress rugpull when tree matches in worktree mode");
    assert.equal(result.reason, "own merge already landed");

    // Verify event
    const events = readEventsForRun(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );
    const selfMergeEvents = events.filter(
      (e) => e.event === "rugpull.self_merge_detected",
    );
    assert.equal(selfMergeEvents.length, 1, "should emit one self_merge_detected event");
    assert.equal(selfMergeEvents[0].runId, runId);
    assert.ok(
      String(selfMergeEvents[0].detail).includes("Own merge"),
      "event detail should mention Own merge",
    );
  });

  it("returns isRugpull=false on corrupt context and emits run.context_corrupt event", async () => {
    const { detectRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-corrupt-ctx-01";
    // Insert a run with a corrupt JSON context
    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
       VALUES (?, 1, ?, 'test', ?, ?, 0, ?, ?)`,
    ).run(runId, "feature-dev-merge", "failed", "{not valid json!!!", new Date().toISOString(), new Date().toISOString());
    insertStep(db, "step-cctx-01", runId, "finalize_merge", "failed", 0, "single");

    const result = detectRugpull(runId);
    assert.equal(result.isRugpull, false, "corrupt context should not be a rugpull");
    assert.ok(result.reason?.includes("Missing base_branch_sha"), "reason should explain");

    // Verify run.context_corrupt event was emitted
    const events = readEventsForRun(process.env.TAMANDUA_STATE_DIR!, runId);
    const corruptEvents = events.filter((e) => e.event === "run.context_corrupt");
    assert.equal(corruptEvents.length, 1, "should emit one run.context_corrupt event");
    assert.ok(
      typeof corruptEvents[0].detail === "string" && corruptEvents[0].detail.length <= 200,
      "detail should be a bounded prefix of the raw context",
    );
  });
});

// ── Helpers for relaunch tests ──

function writeWorkflowYml(
  homeDir: string,
  workflowId: string,
  workspaceMode: "direct" | "worktree",
): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    `id: ${workflowId}\nrun:\n  workspace: ${workspaceMode}\nagents:\n  - id: dev\n    model: fake\n    workspace:\n      baseDir: .\nsteps:\n  - id: implement\n    agent: dev\n    input: Implement the task\n    expects: STATUS, CHANGES, TESTS\n`,
    "utf-8",
  );
}

describe("relaunchRunAfterRugpull", () => {
  let tempHome: string;
  let repoDir: string;
  let controlPort: number;
  let mockServer: http.Server;
  let origHome: string | undefined;
  let origControlPort: string | undefined;
  let origDbPath: string | undefined;
  let origStateDir: string | undefined;
  let origWorktreeRoot: string | undefined;

  before(async () => {
    tempHome = tamanduaTempDir("tamandua-relaunch-");
    origHome = process.env.HOME;
    origControlPort = process.env.TAMANDUA_CONTROL_PORT;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    origStateDir = process.env.TAMANDUA_STATE_DIR;
    origWorktreeRoot = process.env.TAMANDUA_WORKTREE_ROOT;

    const tamanduaDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(tamanduaDir, { recursive: true });

    process.env.HOME = tempHome;
    process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_STATE_DIR = tamanduaDir;
    process.env.TAMANDUA_WORKTREE_ROOT = path.join(tamanduaDir, "worktrees");

    // Start a mock daemon control server that responds 200 to all requests.
    // This is shared across all tests so runWorkflow can register runs successfully.
    controlPort = await new Promise<number>((resolve) => {
      mockServer = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address();
        assert.ok(addr && typeof addr !== "string");
        resolve(addr.port);
      });
    });
    process.env.TAMANDUA_CONTROL_PORT = String(controlPort);

    // Create a git repo for direct-mode tests
    repoDir = path.join(tempHome, "test-repo");
    initGitRepo(repoDir);
  });

  after(async () => {
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origControlPort !== undefined) {
      process.env.TAMANDUA_CONTROL_PORT = origControlPort;
    } else {
      delete process.env.TAMANDUA_CONTROL_PORT;
    }
    if (origDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    if (origStateDir !== undefined) {
      process.env.TAMANDUA_STATE_DIR = origStateDir;
    } else {
      delete process.env.TAMANDUA_STATE_DIR;
    }
    if (origWorktreeRoot !== undefined) {
      process.env.TAMANDUA_WORKTREE_ROOT = origWorktreeRoot;
    } else {
      delete process.env.TAMANDUA_WORKTREE_ROOT;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("suppresses launch when no_relaunch_upon_rugpull is 'true'", async () => {
    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-suppress-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      no_relaunch_upon_rugpull: "true",
    }, "failed");

    const result = await relaunchRunAfterRugpull(runId);
    assert.equal(result.relaunched, false, "should suppress launch");
    assert.equal(result.newRunId, undefined, "no new run ID should be set");

    // Verify suppression event was emitted
    const events = readEventsForRun(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );
    const suppressionEvents = events.filter(
      (e) => e.event === "run.rugpull_relaunch_suppressed",
    );
    assert.equal(suppressionEvents.length, 1, "should emit one suppression event");
    assert.ok(
      String(suppressionEvents[0].detail).includes("suppressed"),
      "event detail should mention suppression",
    );
    // Verify no legacy relaunched event was emitted
    const legacyRelaunched = events.filter(
      (e) => e.event === "run.rugpull_relaunched",
    );
    assert.equal(legacyRelaunched.length, 0, "should not emit legacy relaunched event for suppression");
  });

  it("returns relaunched=false for nonexistent run", async () => {
    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );

    const result = await relaunchRunAfterRugpull("nonexistent-run-id");
    assert.equal(result.relaunched, false);
    assert.equal(result.newRunId, undefined);
  });

  it("returns relaunched=false when working_directory_for_harness is missing (direct mode)", async () => {
    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-no-wd-01";
    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      // no working_directory_for_harness
      workspace_mode: "direct",
    }, "failed");

    const result = await relaunchRunAfterRugpull(runId);
    assert.equal(result.relaunched, false, "should not relaunch without working dir");
  });

  it("returns relaunched=false when worktree_origin_repository is missing (worktree mode)", async () => {
    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-no-wtorigin-01";
    insertRun(db, runId, "feature-dev-merge-worktree", {
      workspace_mode: "worktree",
      // no worktree_origin_repository
      worktree_path: path.join(repoDir, "wt"),
    }, "failed");

    const result = await relaunchRunAfterRugpull(runId);
    assert.equal(result.relaunched, false, "should not relaunch without origin repo");

    // Verify failure event was emitted
    const events = readEventsForRun(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );
    const failedEvents = events.filter(
      (e) => e.event === "run.rugpull_relaunch_failed",
    );
    assert.equal(failedEvents.length, 1, "should emit relaunch_failed event");
    assert.ok(
      String(failedEvents[0].detail).includes("worktree_origin_repository"),
      "event detail should mention missing worktree_origin_repository",
    );
  });

  it("emits run.rugpull_relaunch_failed when working_directory_for_harness is missing (direct mode)", async () => {
    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-no-wd-event-01";
    insertRun(db, runId, "feature-dev-merge", {
      // no working_directory_for_harness, no repo fallback
      workspace_mode: "direct",
    }, "failed");

    await relaunchRunAfterRugpull(runId);

    // Verify failure event was emitted
    const events = readEventsForRun(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );
    const failedEvents = events.filter(
      (e) => e.event === "run.rugpull_relaunch_failed",
    );
    assert.equal(failedEvents.length, 1, "should emit relaunch_failed event");
    assert.ok(
      String(failedEvents[0].detail).includes("working_directory_for_harness"),
      "event detail should mention missing working_directory_for_harness",
    );
  });

  it("emits run.rugpull_relaunch_failed when the daemon rejects registration", async () => {
    // The remaining runWorkflow throw path (post-LNCH) is a REACHABLE control
    // plane that rejects registration with a non-2xx. Unreachability no longer
    // throws — see the pending_register test below.
    const workflowId = "test-relaunch-failure";
    writeWorkflowYml(tempHome, workflowId, "direct");

    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-workflow-fail-01";
    insertRun(db, runId, workflowId, {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      harness_type: "pi",
      no_hurry_save_tokens_mode: "false",
    }, "failed");

    // Per-test mock: health probes succeed, registration is rejected.
    const rejectingServer = http.createServer((req, res) => {
      if (req.url?.includes("register-run")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "registration rejected by test" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    const rejectingPort = await new Promise<number>((resolve) => {
      rejectingServer.listen(0, "127.0.0.1", () => {
        const addr = rejectingServer.address();
        assert.ok(addr && typeof addr !== "string");
        resolve(addr.port);
      });
    });

    const savedPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = String(rejectingPort);
    try {
      const result = await relaunchRunAfterRugpull(runId);
      assert.equal(result.relaunched, false, "should not relaunch when the daemon rejects registration");

      // Verify failure event was emitted
      const events = readEventsForRun(
        process.env.TAMANDUA_STATE_DIR!,
        runId,
      );
      const failedEvents = events.filter(
        (e) => e.event === "run.rugpull_relaunch_failed",
      );
      assert.equal(failedEvents.length, 1, "should emit relaunch_failed event on registration rejection");
    } finally {
      if (savedPort === undefined) {
        delete process.env.TAMANDUA_CONTROL_PORT;
      } else {
        process.env.TAMANDUA_CONTROL_PORT = savedPort;
      }
      await new Promise<void>((resolve) => rejectingServer.close(() => resolve()));
    }
  });

  it("relaunches with pending_register when the control plane is unreachable (LNCH semantics)", async () => {
    // Post-LNCH contract: once the replacement run row exists, control-plane
    // unreachability must NOT fail the relaunch — the run is created,
    // registration is skipped, and the reconciler admits it later.
    const workflowId = "test-relaunch-unreachable";
    writeWorkflowYml(tempHome, workflowId, "direct");

    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = "run-workflow-unreachable-01";
    insertRun(db, runId, workflowId, {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      harness_type: "pi",
      no_hurry_save_tokens_mode: "false",
    }, "failed");

    // Port 1 is unroutable (repo convention). Never DELETE the var to
    // simulate unreachability — the fallback default port may host a real
    // production daemon (observed 2026-07-05: this test registered its
    // relaunch against the live control plane the moment it came up).
    const savedPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = "1";
    try {
      const result = await relaunchRunAfterRugpull(runId);
      assert.equal(result.relaunched, true, "unreachable control plane must not fail the relaunch");
      assert.ok(result.newRunId, "replacement run id should be returned");

      const replacement = db.prepare(
        "SELECT workflow_id, status, scheduling_status FROM runs WHERE id = ?",
      ).get(result.newRunId) as { workflow_id: string; status: string; scheduling_status: string | null } | undefined;
      assert.ok(replacement, "replacement run row must exist");
      assert.equal(replacement!.workflow_id, workflowId);
      assert.equal(replacement!.scheduling_status, "pending_register",
        "replacement run should await reconciler admission");
    } finally {
      if (savedPort === undefined) {
        delete process.env.TAMANDUA_CONTROL_PORT;
      } else {
        process.env.TAMANDUA_CONTROL_PORT = savedPort;
      }
    }
  });

  it("launches replacement run in direct mode with same workflow_id and task", async () => {
    const workflowId = "test-relaunch-direct";
    writeWorkflowYml(tempHome, workflowId, "direct");

    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const failedRunId = crypto.randomUUID();
    insertRun(db, failedRunId, workflowId, {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      harness_type: "pi",
      no_hurry_save_tokens_mode: "false",
    }, "failed");

    const result = await relaunchRunAfterRugpull(failedRunId);
    assert.equal(result.relaunched, true, "should relaunch");
    assert.ok(result.newRunId, "new run ID should be set");
    assert.notEqual(result.newRunId, failedRunId, "new run ID must differ from failed");

    // Verify the original run is still "failed" (preserved unchanged)
    const originalRun = db
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(failedRunId) as { status: string } | undefined;
    assert.ok(originalRun, "original run must still exist");
    assert.equal(originalRun.status, "failed", "original run status must be preserved");

    // Verify the new run exists with correct workflow_id and task
    const newRun = db
      .prepare("SELECT workflow_id, task, status FROM runs WHERE id = ?")
      .get(result.newRunId!) as
      | { workflow_id: string; task: string; status: string }
      | undefined;
    assert.ok(newRun, "new run must exist");
    assert.equal(newRun.workflow_id, workflowId, "new run must have same workflow_id");
    assert.equal(newRun.task, "test", "new run must have same task");
    assert.equal(newRun.status, "running", "new run must be running");

    // Verify relaunch event was emitted on the failed run
    const events = readEventsForRun(
      process.env.TAMANDUA_STATE_DIR!,
      failedRunId,
    );
    const relaunchEvents = events.filter(
      (e) => e.event === "run.rugpull_relaunched",
    );
    assert.equal(relaunchEvents.length, 1, "should emit relaunch event");
    assert.ok(
      String(relaunchEvents[0].detail).includes(result.newRunId!),
      "event detail should include new run ID",
    );
  });

  it("launches replacement run in worktree mode with fresh worktree", async () => {
    const workflowId = "test-relaunch-worktree";
    writeWorkflowYml(tempHome, workflowId, "worktree");

    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const failedRunId = crypto.randomUUID();
    insertRun(db, failedRunId, workflowId, {
      workspace_mode: "worktree",
      worktree_origin_repository: repoDir,
      worktree_origin_ref: "main",
      worktree_path: path.join(repoDir, "wt-old"),
      worktree_origin_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      harness_type: "pi",
      no_hurry_save_tokens_mode: "false",
    }, "failed");

    // Also insert a worktree record for the failed run (simulating the original)
    insertWorktree(db, failedRunId, repoDir);

    const result = await relaunchRunAfterRugpull(failedRunId);
    assert.equal(result.relaunched, true, "should relaunch worktree workflow");
    assert.ok(result.newRunId, "new run ID should be set");
    assert.notEqual(result.newRunId, failedRunId, "new run ID must differ from failed");

    // Verify the original run is still "failed"
    const originalRun = db
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(failedRunId) as { status: string } | undefined;
    assert.ok(originalRun);
    assert.equal(originalRun.status, "failed");

    // Verify the new run exists
    const newRun = db
      .prepare("SELECT workflow_id, task, status FROM runs WHERE id = ?")
      .get(result.newRunId!) as
      | { workflow_id: string; task: string; status: string }
      | undefined;
    assert.ok(newRun, "new run must exist");
    assert.equal(newRun.workflow_id, workflowId);

    // Verify a NEW worktree record was created (different from the failed run's)
    const newWt = db
      .prepare("SELECT worktree_path FROM run_worktrees WHERE run_id = ?")
      .get(result.newRunId!) as { worktree_path: string } | undefined;
    assert.ok(newWt, "new worktree record must exist");
    // The new worktree path should be different from the old one
    assert.notEqual(
      newWt.worktree_path,
      path.join(repoDir, "wt-old"),
      "new worktree must have a different path from the failed run's worktree",
    );

    // Verify relaunch event
    const events = readEventsForRun(
      process.env.TAMANDUA_STATE_DIR!,
      failedRunId,
    );
    const relaunchEvents = events.filter(
      (e) => e.event === "run.rugpull_relaunched",
    );
    assert.equal(relaunchEvents.length, 1, "should emit relaunch event");
  });

  it("preserves original failed run context unchanged after relaunch", async () => {
    const workflowId = "test-preserve-context";
    writeWorkflowYml(tempHome, workflowId, "direct");

    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const originalContext = {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      harness_type: "hermes",
      no_hurry_save_tokens_mode: "true",
      base_branch_sha: "abc123def456",
      custom_field: "custom_value",
    };

    const failedRunId = crypto.randomUUID();
    insertRun(db, failedRunId, workflowId, originalContext, "failed");

    await relaunchRunAfterRugpull(failedRunId);

    // Verify original run context is unchanged
    const run = db
      .prepare("SELECT context, status FROM runs WHERE id = ?")
      .get(failedRunId) as { context: string; status: string } | undefined;
    assert.ok(run);
    assert.equal(run.status, "failed", "original run status preserved");

    const parsedContext = JSON.parse(run.context) as Record<string, string>;
    assert.equal(parsedContext.custom_field, "custom_value", "custom fields preserved");
    assert.equal(parsedContext.harness_type, "hermes", "harness type preserved");
    assert.equal(parsedContext.base_branch_sha, "abc123def456", "base_branch_sha preserved");
  });

  it("forwards custom user context keys to the replacement run", async () => {
    const workflowId = "test-user-context-forwarded";
    writeWorkflowYml(tempHome, workflowId, "direct");

    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const failedRunId = crypto.randomUUID();
    insertRun(db, failedRunId, workflowId, {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      harness_type: "pi",
      no_hurry_save_tokens_mode: "false",
      branch: "feature/my-branch",
      custom_key: "custom_value",
      priority: "high",
    }, "failed");

    const result = await relaunchRunAfterRugpull(failedRunId);
    assert.equal(result.relaunched, true, "should relaunch");
    assert.ok(result.newRunId, "new run ID should be set");

    // Verify replacement run context contains user keys
    const newRun = db
      .prepare("SELECT context FROM runs WHERE id = ?")
      .get(result.newRunId!) as { context: string } | undefined;
    assert.ok(newRun, "replacement run must exist");

    const newContext = JSON.parse(newRun.context) as Record<string, string>;
    assert.equal(newContext.branch, "feature/my-branch", "branch context key should survive");
    assert.equal(newContext.custom_key, "custom_value", "custom_key should survive");
    assert.equal(newContext.priority, "high", "priority should survive");
  });

  it("replacement run regenerates internal context keys (not copied from original)", async () => {
    const workflowId = "test-internal-keys-regenerated";
    writeWorkflowYml(tempHome, workflowId, "direct");

    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const failedRunId = crypto.randomUUID();
    const originalContext = {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      harness_type: "hermes",
      no_hurry_save_tokens_mode: "true",
      base_branch_sha: "abc123def456",
      original_branch: "stale-branch",
      branch: "feature/my-branch",
    };
    insertRun(db, failedRunId, workflowId, originalContext, "failed");

    const result = await relaunchRunAfterRugpull(failedRunId);
    assert.equal(result.relaunched, true, "should relaunch");
    assert.ok(result.newRunId, "new run ID should be set");

    // Verify replacement run context
    const newRun = db
      .prepare("SELECT context FROM runs WHERE id = ?")
      .get(result.newRunId!) as { context: string } | undefined;
    assert.ok(newRun, "replacement run must exist");

    const newContext = JSON.parse(newRun.context) as Record<string, string>;

    // User key should survive
    assert.equal(newContext.branch, "feature/my-branch", "user branch key should survive");

    // base_branch_sha is regenerated from the current repo HEAD, NOT copied from original
    assert.ok(newContext.base_branch_sha, "base_branch_sha should be regenerated");
    assert.notEqual(
      newContext.base_branch_sha,
      "abc123def456",
      "base_branch_sha should be regenerated (not copied from original)",
    );
    // original_branch is regenerated from git, NOT copied from original
    assert.notEqual(
      newContext.original_branch,
      "stale-branch",
      "original_branch should be regenerated (not copied from original)",
    );
    // workspace_mode is regenerated by runWorkflow, not copied from original context
    assert.equal(
      newContext.workspace_mode,
      "direct",
      "workspace_mode should be regenerated by runWorkflow",
    );
    // harness_type is intentionally forwarded as an explicit parameter, so it IS preserved
    assert.equal(
      newContext.harness_type,
      "hermes",
      "harness_type should be forwarded from the original via explicit parameter",
    );
    // no_hurry_save_tokens_mode is intentionally forwarded as an explicit parameter
    assert.equal(
      newContext.no_hurry_save_tokens_mode,
      "true",
      "no_hurry_save_tokens_mode should be forwarded from original via explicit parameter",
    );
    // Internal worktree_ keys should not leak from original context (direct mode doesn't have them anyway)
    assert.equal(
      newContext.worktree_path,
      undefined,
      "worktree_path should not leak from original context",
    );
  });

  it("returns relaunched=false on corrupt context and emits run.context_corrupt event", async () => {
    const workflowId = "test-corrupt-context";
    writeWorkflowYml(tempHome, workflowId, "direct");

    const { relaunchRunAfterRugpull } = await import(
      "../../dist/installer/rugpull.js"
    );
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const failedRunId = crypto.randomUUID();
    // Insert a run with corrupt JSON context
    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
       VALUES (?, 1, ?, 'test', ?, ?, 0, ?, ?)`,
    ).run(failedRunId, workflowId, "failed", "{broken json!!!", new Date().toISOString(), new Date().toISOString());

    const result = await relaunchRunAfterRugpull(failedRunId);
    assert.equal(result.relaunched, false, "corrupt context should not produce a relaunch");

    // Verify run.context_corrupt event was emitted
    const events = readEventsForRun(process.env.TAMANDUA_STATE_DIR!, failedRunId);
    const corruptEvents = events.filter((e) => e.event === "run.context_corrupt");
    assert.equal(corruptEvents.length, 1, "should emit one run.context_corrupt event");
  });
});

// ── failStep rugpull integration tests (US-005) ──

describe("failStep rugpull integration", () => {
  let tempHome: string;
  let repoDir: string;
  let initialSha: string;
  let controlPort: number;
  let mockServer: http.Server;
  let origHome: string | undefined;
  let origControlPort: string | undefined;
  let origDbPath: string | undefined;
  let origStateDir: string | undefined;
  let origWorktreeRoot: string | undefined;

  before(async () => {
    tempHome = fs.mkdtempSync(
      path.join(tamanduaTempRoot(), "tamandua-failstep-rugpull-"),
    );
    origHome = process.env.HOME;
    origControlPort = process.env.TAMANDUA_CONTROL_PORT;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    origStateDir = process.env.TAMANDUA_STATE_DIR;
    origWorktreeRoot = process.env.TAMANDUA_WORKTREE_ROOT;

    const tamanduaDir = path.join(tempHome, ".tamandua");
    fs.mkdirSync(tamanduaDir, { recursive: true });

    process.env.HOME = tempHome;
    process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_STATE_DIR = tamanduaDir;
    process.env.TAMANDUA_WORKTREE_ROOT = path.join(tamanduaDir, "worktrees");

    // Mock daemon control server for runWorkflow (called by relaunchRunAfterRugpull)
    controlPort = await new Promise<number>((resolve) => {
      mockServer = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address();
        assert.ok(addr && typeof addr !== "string");
        resolve(addr.port);
      });
    });
    process.env.TAMANDUA_CONTROL_PORT = String(controlPort);

    // Create a git repo for tests
    repoDir = path.join(tempHome, "test-repo");
    initialSha = initGitRepo(repoDir);
  });

  after(async () => {
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origControlPort !== undefined) {
      process.env.TAMANDUA_CONTROL_PORT = origControlPort;
    } else {
      delete process.env.TAMANDUA_CONTROL_PORT;
    }
    if (origDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    if (origStateDir !== undefined) {
      process.env.TAMANDUA_STATE_DIR = origStateDir;
    } else {
      delete process.env.TAMANDUA_STATE_DIR;
    }
    if (origWorktreeRoot !== undefined) {
      process.env.TAMANDUA_WORKTREE_ROOT = origWorktreeRoot;
    } else {
      delete process.env.TAMANDUA_WORKTREE_ROOT;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("triggers rugpull detection and relaunch after merge step failure exhausts retries", async () => {
    const workflowId = "test-failstep-rugpull-merge";
    writeWorkflowYml(tempHome, workflowId, "direct");

    const { failStep } = await import("../../dist/installer/step-ops.js");
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Move base forward so SHA differs from initial
    const newSha = makeCommit(repoDir, "second commit");
    assert.notEqual(newSha, initialSha);

    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    // Insert a run and step with exhausted retries (retry_count === max_retries)
    insertRun(db, runId, workflowId, {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      base_branch_sha: initialSha,
      harness_type: "pi",
      no_hurry_save_tokens_mode: "false",
    }, "running");
    insertStep(db, stepId, runId, "finalize_merge", "running", 0, "single");
    // Set retry_count to max_retries so the next failStep exhausts
    db.prepare(
      "UPDATE steps SET retry_count = max_retries WHERE id = ?",
    ).run(stepId);

    const result = await failStep(stepId, "merge conflict");
    assert.equal(result.status, "failed", "step should be failed after exhaustion");

    // Wait for the fire-and-forget rugpull detection (setImmediate + async)
    const events = await waitForRugpullEvents(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );

    const detectedEvents = events.filter(
      (e) => e.event === "run.rugpull_detected",
    );
    assert.equal(
      detectedEvents.length,
      1,
      "should emit run.rugpull_detected event",
    );
    assert.ok(
      String(detectedEvents[0].detail).includes("moved"),
      "event detail should mention base moved",
    );

    const relaunchedEvents = events.filter(
      (e) => e.event === "run.rugpull_relaunched",
    );
    assert.equal(
      relaunchedEvents.length,
      1,
      "should emit run.rugpull_relaunched event",
    );

    // Verify the run is still marked as failed (original run preserved)
    const run = db
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(runId) as { status: string } | undefined;
    assert.ok(run);
    assert.equal(run.status, "failed", "original run should be failed");
  });

  it("does NOT trigger rugpull for non-merge workflow failures", async () => {
    const { failStep } = await import("../../dist/installer/step-ops.js");
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    insertRun(db, runId, "security-audit", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      base_branch_sha: initialSha,
    }, "running");
    insertStep(db, stepId, runId, "scan", "running", 0, "single");
    db.prepare(
      "UPDATE steps SET retry_count = max_retries WHERE id = ?",
    ).run(stepId);

    const result = await failStep(stepId, "scan failed");
    assert.equal(result.status, "failed");

    // Wait and verify no rugpull events
    const events = await waitForRugpullEvents(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );
    assert.equal(
      events.length,
      0,
      "non-merge workflow should not emit rugpull events",
    );
  });

  it("does NOT trigger rugpull for loop step failures", async () => {
    const { failStep } = await import("../../dist/installer/step-ops.js");
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      base_branch_sha: initialSha,
    }, "running");
    // Insert a loop step with a current story
    insertStep(db, stepId, runId, "implement", "running", 0, "loop");
    // Also insert a story so the loop branch in failStep fires
    const storyId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, 0, 'US-001', 'Test Story', 'desc', '["ac"]', 'running', 3, 4, datetime('now'), datetime('now'))`,
    ).run(storyId, runId);
    // Link the story to the step (as claimStep does)
    db.prepare(
      "UPDATE steps SET current_story_id = ? WHERE id = ?",
    ).run(storyId, stepId);

    const result = await failStep(stepId, "implement failed");
    // Loop step with story retries — should retry, not fail
    assert.equal(result.status, "retrying");

    // Wait and verify no rugpull events
    const events = await waitForRugpullEvents(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
      1000,
    );
    assert.equal(
      events.length,
      0,
      "loop step failure should not emit rugpull events",
    );
  });

  it("failStep still returns failed even when rugpull detection would error", async () => {
    const { failStep } = await import("../../dist/installer/step-ops.js");
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    // Insert a run with missing required context (no workspace_mode) —
    // detectRugpull won't error on this, but relaunchRunAfterRugpull will
    // return { relaunched: false } for missing working directory.
    // The key assertion is that failStep itself does not throw.
    insertRun(db, runId, "feature-dev-merge", {
      // No working_directory_for_harness, no workspace_mode — edge case
      base_branch_sha: initialSha,
    }, "running");
    insertStep(db, stepId, runId, "finalize_merge", "running", 0, "single");
    db.prepare(
      "UPDATE steps SET retry_count = max_retries WHERE id = ?",
    ).run(stepId);

    // This should not throw — error in detection/relaunch is swallowed
    const result = await failStep(stepId, "some error");
    assert.equal(result.status, "failed", "failStep still reports failed");

    // Verify run is marked as failed
    const run = db
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(runId) as { status: string } | undefined;
    assert.ok(run);
    assert.equal(run.status, "failed", "run should be failed despite rugpull errors");
  });

  it("integration: no_relaunch_upon_rugpull suppresses relaunch (detection still fires)", async () => {
    const workflowId = "test-no-relaunch-suppress-merge";
    writeWorkflowYml(tempHome, workflowId, "direct");

    const { failStep } = await import("../../dist/installer/step-ops.js");
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    // Move base forward so rugpull WOULD be detected
    const newSha = makeCommit(repoDir, "suppress test commit");
    assert.notEqual(newSha, initialSha);

    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    insertRun(db, runId, workflowId, {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      base_branch_sha: initialSha,
      no_relaunch_upon_rugpull: "true",
      harness_type: "pi",
      no_hurry_save_tokens_mode: "false",
    }, "running");
    insertStep(db, stepId, runId, "finalize_merge", "running", 0, "single");
    db.prepare(
      "UPDATE steps SET retry_count = max_retries WHERE id = ?",
    ).run(stepId);

    const result = await failStep(stepId, "merge conflict");
    assert.equal(result.status, "failed");

    // Wait for fire-and-forget events
    const events = await waitForRugpullEvents(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );

    // Detection should still fire (rugpull IS a rugpull)
    const detectedEvents = events.filter(
      (e) => e.event === "run.rugpull_detected",
    );
    assert.equal(detectedEvents.length, 1, "rugpull should still be detected");

    // But relaunch should be suppressed
    const suppressedEvents = events.filter(
      (e) => e.event === "run.rugpull_relaunch_suppressed",
    );
    assert.equal(suppressedEvents.length, 1, "should emit relaunch_suppressed event");
    assert.ok(
      String(suppressedEvents[0].detail).includes("suppressed"),
      "relaunch event should indicate suppression",
    );
    // Verify no legacy relaunched event was emitted
    const legacyRelaunched = events.filter(
      (e) => e.event === "run.rugpull_relaunched",
    );
    assert.equal(legacyRelaunched.length, 0, "should not emit legacy relaunched event for suppression");
  });

  it("does NOT trigger rugpull when planner step fails", async () => {
    const { failStep } = await import("../../dist/installer/step-ops.js");
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    // Move base forward so it WOULD be a rugpull if it were finalize_merge
    const newSha = makeCommit(repoDir, "planner test");
    assert.notEqual(newSha, initialSha);

    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      base_branch_sha: initialSha,
    }, "running");
    // Fail the planner step
    insertStep(db, stepId, runId, "plan", "running", 0, "single");
    db.prepare(
      "UPDATE steps SET retry_count = max_retries WHERE id = ?",
    ).run(stepId);

    const result = await failStep(stepId, "plan failed");
    assert.equal(result.status, "failed");

    const events = await waitForRugpullEvents(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );
    assert.equal(events.length, 0, "planner failure should not emit rugpull events");
  });

  it("does NOT trigger rugpull when verifier step fails", async () => {
    const { failStep } = await import("../../dist/installer/step-ops.js");
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    const newSha = makeCommit(repoDir, "verifier test");
    assert.notEqual(newSha, initialSha);

    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      base_branch_sha: initialSha,
    }, "running");
    // Fail the verifier step
    insertStep(db, stepId, runId, "verify", "running", 0, "single");
    db.prepare(
      "UPDATE steps SET retry_count = max_retries WHERE id = ?",
    ).run(stepId);

    const result = await failStep(stepId, "verify failed");
    assert.equal(result.status, "failed");

    const events = await waitForRugpullEvents(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );
    assert.equal(events.length, 0, "verifier failure should not emit rugpull events");
  });

  it("does NOT trigger rugpull when failing step is not finalize_merge", async () => {
    const { failStep } = await import("../../dist/installer/step-ops.js");
    const { getDb } = await import("../../dist/db.js");
    const db = getDb();

    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    // Move base forward so it WOULD be a rugpull if it were finalize_merge
    const newSha = makeCommit(repoDir, "not-finalize test");
    assert.notEqual(newSha, initialSha);

    insertRun(db, runId, "feature-dev-merge", {
      repo: repoDir,
      working_directory_for_harness: repoDir,
      workspace_mode: "direct",
      base_branch_sha: initialSha,
    }, "running");
    // Fail the "plan" step, not "finalize_merge"
    insertStep(db, stepId, runId, "plan", "running", 0, "single");
    db.prepare(
      "UPDATE steps SET retry_count = max_retries WHERE id = ?",
    ).run(stepId);

    const result = await failStep(stepId, "plan step failed");
    assert.equal(result.status, "failed");

    // Wait and verify no rugpull events
    const events = await waitForRugpullEvents(
      process.env.TAMANDUA_STATE_DIR!,
      runId,
    );
    // Note: failStep fires rugpull detection for ALL single step failures.
    // detectRugpull itself checks that the failed step is finalize_merge.
    // So no events should be emitted because detectRugpull returns false.
    assert.equal(
      events.length,
      0,
      "non-finalize_merge step should not emit rugpull events",
    );
  });
});

// ── extractUserContext ──

describe("extractUserContext", () => {
  it("removes all internally-seeded keys", async () => {
    const { extractUserContext } = await import(
      "../../dist/installer/rugpull.js"
    );

    const context: Record<string, string> = {
      task: "Build feature X",
      workspace_mode: "direct",
      base_branch_sha: "abc123def456",
      working_directory_for_harness: "/tmp/repo",
      harness_type: "pi",
      no_hurry_save_tokens_mode: "false",
      no_relaunch_upon_rugpull: "false",
      repo: "/tmp/repo",
      original_branch: "main",
      worktree_path: "/tmp/wt",
      worktree_origin_repository: "/tmp/origin",
      worktree_origin_ref: "main",
      worktree_origin_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      target_working_directory_for_harness: "/tmp/target",
      // Additional worktree_ prefix keys for defense in depth
      worktree_extra_field: "should-be-stripped",
      worktree_custom: "also-stripped",
    };

    const result = extractUserContext(context);
    assert.deepEqual(result, {}, "all internal keys should be removed");
  });

  it("preserves user-provided keys like branch and custom_key", async () => {
    const { extractUserContext } = await import(
      "../../dist/installer/rugpull.js"
    );

    const context: Record<string, string> = {
      task: "Build feature X",
      workspace_mode: "direct",
      base_branch_sha: "abc123def456",
      branch: "feature/my-branch",
      custom_key: "custom_value",
      priority: "high",
    };

    const result = extractUserContext(context);
    assert.deepEqual(
      result,
      { branch: "feature/my-branch", custom_key: "custom_value", priority: "high" },
      "user-provided keys should be preserved",
    );
  });

  it("returns empty object when only internal keys are present", async () => {
    const { extractUserContext } = await import(
      "../../dist/installer/rugpull.js"
    );

    const context: Record<string, string> = {
      task: "Build feature X",
      workspace_mode: "direct",
      harness_type: "pi",
      no_hurry_save_tokens_mode: "false",
      no_relaunch_upon_rugpull: "false",
    };

    const result = extractUserContext(context);
    assert.deepEqual(result, {}, "empty result when only internal keys present");
  });

  it("handles empty input gracefully", async () => {
    const { extractUserContext } = await import(
      "../../dist/installer/rugpull.js"
    );

    const result = extractUserContext({});
    assert.deepEqual(result, {}, "empty input should return empty object");
  });

  it("strips worktree_ prefixed keys as defense in depth", async () => {
    const { extractUserContext } = await import(
      "../../dist/installer/rugpull.js"
    );

    const context: Record<string, string> = {
      task: "Build feature X",
      workspace_mode: "worktree",
      branch: "feature/my-branch",
      worktree_some_unknown_key: "unexpected",
      worktree_another: "also unexpected",
    };

    const result = extractUserContext(context);
    assert.deepEqual(
      result,
      { branch: "feature/my-branch" },
      "worktree_ prefixed keys should be stripped",
    );
  });

  it("does not mutate the input object", async () => {
    const { extractUserContext } = await import(
      "../../dist/installer/rugpull.js"
    );

    const context: Record<string, string> = {
      task: "Build feature X",
      branch: "feature/my-branch",
      base_branch_sha: "abc123",
    };

    const originalKeys = Object.keys(context).sort();
    extractUserContext(context);

    assert.deepEqual(
      Object.keys(context).sort(),
      originalKeys,
      "input object should not be mutated",
    );
    assert.equal(context.branch, "feature/my-branch", "input values intact");
    assert.equal(context.task, "Build feature X", "input values intact");
    assert.equal(context.base_branch_sha, "abc123", "input values intact");
  });
});
