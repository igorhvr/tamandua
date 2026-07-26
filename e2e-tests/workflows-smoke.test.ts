/**
 * Smoke / State-Machine Integration Test
 *
 * This is a FAST test that manually advances workflow steps using
 * `tamandua step claim` / `tamandua step complete` with canned outputs.
 * It exercises the workflow state machine, pipeline wiring, and step
 * lifecycle — but it does NOT invoke real Tamandua agents, models, or
 * schedulers. It is NOT a real end-to-end workflow test.
 *
 * For the slow real end-to-end test that runs actual agent invocations,
 * see e2e-tests/workflows-e2e.test.ts (run via ./run-all-real-e2e-tests).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  stepClaim,
  stepComplete,
  spawnWorkflowRun,
  prepareGitRepo,
  resolveFullRunId,
  cleanupTempHome,
} from "./helpers/smoke-helpers.ts";

const fixtureDir = path.join(process.cwd(), "e2e-tests", "fixtures", "sample-project");

const plumbingMergeOutput = (commit: string, tree: string): string =>
  "STATUS: landed\n" +
  `MERGED_COMMIT: ${commit}\n` +
  `MERGED_TREE: ${tree}\n` +
  "TARGET: refs/heads/main\n" +
  "CHECKOUT_REFRESH: updated\n" +
  "REBASED: false\n" +
  `MERGE_COMMIT: ${commit.slice(0, 7)}\n` +
  "MERGED_INTO: main\n" +
  `MERGED_TREE: ${tree}\n` +
  "STATUS: done\n";

interface CannedStep {
  agent: string;
  output: (repoDir: string) => string;
}

interface CannedWorkflow {
  id: string;
  task: string;
  worktree: boolean;
  steps: CannedStep[];
}

async function runCannedWorkflow(workflow: CannedWorkflow): Promise<void> {
  const env = await createTempHome();
  const be = () => baseEnv(env.homeDir, env.controlPort);

  try {
    cliMustSucceed(
      ["workflow", "install", workflow.id],
      be(),
      `install ${workflow.id}`,
    );

    const repoDir = path.join(env.root, "sample-repo");
    prepareGitRepo(fixtureDir, repoDir);
    const runArgs = [
      "workflow",
      "run",
      workflow.id,
      workflow.task,
      "--context",
      `repo=${repoDir}`,
      "--context",
      `branch=smoke/${workflow.id}`,
    ];
    if (workflow.worktree) {
      runArgs.push("--worktree-origin-repository", repoDir);
    }
    const runIdPrefix = await spawnWorkflowRun(runArgs, be());
    const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

    for (const step of workflow.steps) {
      let claimed;
      try {
        claimed = stepClaim(`${workflow.id}_${step.agent}`, runId, be());
      } catch (error) {
        const status = cliMustSucceed(
          ["workflow", "status", runId],
          be(),
          `${workflow.id} failed-claim status`,
        );
        throw new Error(
          `${workflow.id}/${step.agent}: failed to claim step\n${status}`,
          { cause: error },
        );
      }
      const result = stepComplete(claimed.stepId, step.output(repoDir), be());
      assert.ok(
        result.status === "advanced" || result.status === "completed",
        `${workflow.id}/${step.agent}: expected advanced/completed, got ${result.status}`,
      );
    }

    const statusOut = cliMustSucceed(
      ["workflow", "status", runId],
      be(),
      `${workflow.id} status`,
    );
    assert.match(statusOut, /Status:\s+completed/i);
    assert.match(statusOut, /\[done\s+\]\s+step-finalize_merge/);
  } finally {
    cleanupTempHome(env);
  }
}

describe("createTempHome pi auth isolation", () => {
  it("default createTempHome() creates a stub .pi directory (not a symlink)", async () => {
    const env = await createTempHome();
    try {
      const piDir = path.join(env.homeDir, ".pi");
      assert.ok(fs.existsSync(piDir), ".pi directory should exist");
      const stat = fs.lstatSync(piDir);
      assert.ok(stat.isDirectory(), ".pi should be a directory");
      assert.ok(!stat.isSymbolicLink(), ".pi should NOT be a symlink in default mode");

      // Should have a stub settings.json so workflow install/harness don't fail
      const settingsPath = path.join(piDir, "agent", "settings.json");
      assert.ok(fs.existsSync(settingsPath), "stub settings.json should exist");
    } finally {
      cleanupTempHome(env);
    }
  });

  it("createTempHome({ linkRealAgentDirs: true }) symlinks real ~/.pi", async () => {
    const realPiDir = path.join(os.homedir(), ".pi");
    assert.ok(
      fs.existsSync(realPiDir),
      `Real ~/.pi must exist at ${realPiDir} for this test`,
    );

    const env = await createTempHome({ linkRealAgentDirs: true });
    try {
      const isolatedPiLink = path.join(env.homeDir, ".pi");
      const stat = fs.lstatSync(isolatedPiLink);

      assert.ok(
        stat.isSymbolicLink(),
        `Expected ${isolatedPiLink} to be a symlink to the real ~/.pi.`,
      );

      const resolved = fs.realpathSync(isolatedPiLink);
      assert.equal(
        resolved,
        realPiDir,
        `Symlink ${isolatedPiLink} must resolve to ${realPiDir}, got ${resolved}`,
      );

      const settingsPath = path.join(resolved, "agent", "settings.json");
      assert.ok(
        fs.existsSync(settingsPath),
        `Real pi config must exist at ${settingsPath}`,
      );
    } finally {
      cleanupTempHome(env);
    }
  });

  it("baseEnv preserves provider environment variables while keeping Tamandua state isolated", async () => {
    const previousToken = process.env.TAMANDUA_E2E_TEST_PROVIDER_TOKEN;
    const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    const previousWorktreeRoot = process.env.TAMANDUA_WORKTREE_ROOT;

    process.env.TAMANDUA_E2E_TEST_PROVIDER_TOKEN = "present";
    process.env.NODE_TEST_CONTEXT = "node-test-internal-context";
    process.env.TAMANDUA_STATE_DIR = "/tmp/should-not-leak-tamandua-state";
    process.env.TAMANDUA_DB_PATH = "/tmp/should-not-leak-tamandua.db";
    process.env.TAMANDUA_WORKTREE_ROOT = "/tmp/should-not-leak-worktrees";

    const env = await createTempHome();
    try {
      const childEnv = baseEnv(env.homeDir, env.controlPort);
      assert.equal(childEnv.TAMANDUA_E2E_TEST_PROVIDER_TOKEN, "present");
      assert.equal(childEnv.NODE_TEST_CONTEXT, undefined);
      assert.equal(childEnv.HOME, env.homeDir);
      assert.equal(childEnv.TAMANDUA_CONTROL_PORT, String(env.controlPort));
      assert.equal(childEnv.TAMANDUA_STATE_DIR, env.tamanduaDir);
      assert.equal(
        childEnv.TAMANDUA_DB_PATH,
        path.join(env.tamanduaDir, "tamandua.db"),
      );
      assert.equal(
        childEnv.TAMANDUA_WORKTREE_ROOT,
        path.join(env.tamanduaDir, "worktrees"),
      );
    } finally {
      if (previousToken === undefined) {
        delete process.env.TAMANDUA_E2E_TEST_PROVIDER_TOKEN;
      } else {
        process.env.TAMANDUA_E2E_TEST_PROVIDER_TOKEN = previousToken;
      }
      if (previousNodeTestContext === undefined) {
        delete process.env.NODE_TEST_CONTEXT;
      } else {
        process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
      }
      if (previousStateDir === undefined) {
        delete process.env.TAMANDUA_STATE_DIR;
      } else {
        process.env.TAMANDUA_STATE_DIR = previousStateDir;
      }
      if (previousDbPath === undefined) {
        delete process.env.TAMANDUA_DB_PATH;
      } else {
        process.env.TAMANDUA_DB_PATH = previousDbPath;
      }
      if (previousWorktreeRoot === undefined) {
        delete process.env.TAMANDUA_WORKTREE_ROOT;
      } else {
        process.env.TAMANDUA_WORKTREE_ROOT = previousWorktreeRoot;
      }
      cleanupTempHome(env);
    }
  });
});

describe("workflows smoke (state-machine integration)", { concurrency: 1 }, () => {
  it(
    "feature-dev-merge-worktree: plan → setup → implement → verify → test → merge → done",
    { timeout: 120_000 },
    async () => {
      const env = await createTempHome();
      const be = () => baseEnv(env.homeDir, env.controlPort);

      try {
        // 1. Install the workflow
        cliMustSucceed(
          ["workflow", "install", "feature-dev-merge-worktree"],
          be(),
          "install feature-dev-merge-worktree",
        );

        // 2. Prepare a clean git repo from the sample project
        const repoDir = path.join(env.root, "sample-repo");
        prepareGitRepo(fixtureDir, repoDir);

        // 3. Create the run
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "feature-dev-merge-worktree",
            "Add a multiply function to math.ts",
            "--worktree-origin-repository",
            repoDir,
          ],
          be(),
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        // ---- Advance pipeline ----

        // Step: plan (planner)
        const plan = stepClaim(
          "feature-dev-merge-worktree_planner",
          runId,
          be(),
        );
        const planResult = stepComplete(
          plan.stepId,
          "STATUS: done\n" +
            `REPO: ${repoDir}\n` +
            "BRANCH: feature/add-multiply\n" +
            'STORIES_JSON: [{"id":"US-001","title":"Add multiply function","description":"Add a function multiply(a,b) that returns a * b to src/math.ts","acceptanceCriteria":["multiply function exists in src/math.ts","export is added to index if applicable","tests pass","Typecheck passes"]}]\n',
          be(),
        );
        assert.ok(
          planResult.status === "advanced" || planResult.status === "completed",
          `plan: expected advanced/completed, got ${planResult.status}`,
        );

        // Step: setup (setup)
        const setup = stepClaim(
          "feature-dev-merge-worktree_setup",
          runId,
          be(),
        );
        const setupResult = stepComplete(
          setup.stepId,
          "STATUS: done\n" +
            `ORIGINAL_BRANCH: main\n` +
            "BUILD_CMD: npm run build\n" +
            "TEST_CMD: npm test\n" +
            "CI_NOTES: Standard TypeScript project\n" +
            "BASELINE: Build succeeds, 1 test passes, 1 test fails (known bug in add)\n",
          be(),
        );
        assert.equal(setupResult.status, "advanced");

        // Step: implement (developer, loop — US-001)
        const implement = stepClaim(
          "feature-dev-merge-worktree_developer",
          runId,
          be(),
        );
        assert.ok(
          implement.input.includes("US-001"),
          `implement input should reference US-001: ${implement.input.substring(0, 200)}`,
        );
        const implResult = stepComplete(
          implement.stepId,
          "STATUS: done\n" +
            "CHANGES: Added multiply function to src/math.ts\n" +
            "TESTS: Added test for multiply function, all tests pass\n",
          be(),
        );
        assert.equal(implResult.status, "advanced");

        // Step: verify (verifier, triggered by verify_each)
        const verify = stepClaim(
          "feature-dev-merge-worktree_verifier",
          runId,
          be(),
        );
        const verifyResult = stepComplete(
          verify.stepId,
          "STATUS: done\n" +
            "VERIFIED: multiply function exists in src/math.ts, test passes\n",
          be(),
        );
        assert.ok(
          verifyResult.status === "advanced" ||
            verifyResult.status === "completed",
          `verify: expected advanced/completed, got ${verifyResult.status}`,
        );

        // Step: test (tester)
        const testStep = stepClaim(
          "feature-dev-merge-worktree_tester",
          runId,
          be(),
        );
        const testResult = stepComplete(
          testStep.stepId,
          "STATUS: done\n" +
            "RESULTS: Full test suite passes, integration verified\n" +
            "TESTED_TREE: abc123deadbeef\n",
          be(),
        );
        assert.equal(testResult.status, "advanced");

        // Step: finalize_merge (merger)
        const merge = stepClaim(
          "feature-dev-merge-worktree_merger",
          runId,
          be(),
        );
        const mergeResult = stepComplete(
          merge.stepId,
          plumbingMergeOutput("abc1234deadbeef", "abc123deadbeef"),
          be(),
        );
        assert.equal(mergeResult.status, "completed");

        // 4. Verify the run completed
        const statusOut = cliMustSucceed(
          ["workflow", "status", runId],
          be(),
          "workflow status",
        );
        assert.match(statusOut, /Status:\s+completed/i);
        assert.match(statusOut, /\[done\s+\]\s+step-plan/);
        assert.match(statusOut, /\[done\s+\]\s+step-setup/);
        assert.match(statusOut, /\[done\s+\]\s+step-implement/);
        assert.match(statusOut, /\[done\s+\]\s+step-verify/);
        assert.match(statusOut, /\[done\s+\]\s+step-test/);
        assert.match(statusOut, /\[done\s+\]\s+step-finalize_merge/);
      } finally {
        cleanupTempHome(env);
      }
    },
  );

  it(
    "bug-fix-merge-worktree: triage → investigate → setup → fix → verify → merge → done",
    { timeout: 120_000 },
    async () => {
      const env = await createTempHome();
      const be = () => baseEnv(env.homeDir, env.controlPort);

      try {
        // 1. Install the workflow
        cliMustSucceed(
          ["workflow", "install", "bug-fix-merge-worktree"],
          be(),
          "install bug-fix-merge-worktree",
        );

        // 2. Prepare a clean git repo from the sample project
        const repoDir = path.join(env.root, "sample-repo");
        prepareGitRepo(fixtureDir, repoDir);

        // 3. Create the run
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--worktree-origin-repository",
            repoDir,
          ],
          be(),
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        // ---- Advance pipeline ----

        // Step: triage (triager)
        const triage = stepClaim(
          "bug-fix-merge-worktree_triager",
          runId,
          be(),
        );
        const triageResult = stepComplete(
          triage.stepId,
          "STATUS: done\n" +
            `REPO: ${repoDir}\n` +
            "BRANCH: bugfix/fix-add-function\n" +
            "SEVERITY: high\n" +
            "AFFECTED_AREA: src/math.ts — add function\n" +
            "REPRODUCTION: Call add(2, 3) — returns -1 instead of 5\n" +
            "PROBLEM_STATEMENT: The add(a,b) function computes a - b instead of a + b\n",
          be(),
        );
        assert.equal(triageResult.status, "advanced");

        // Step: investigate (investigator)
        const investigate = stepClaim(
          "bug-fix-merge-worktree_investigator",
          runId,
          be(),
        );
        const investigateResult = stepComplete(
          investigate.stepId,
          "STATUS: done\n" +
            "ROOT_CAUSE: The add function in src/math.ts line 2 has a typo: uses subtraction operator (-) instead of addition operator (+)\n" +
            "FIX_APPROACH: Change 'return a - b' to 'return a + b' in src/math.ts\n",
          be(),
        );
        assert.equal(investigateResult.status, "advanced");

        // Step: setup (setup)
        const setup = stepClaim(
          "bug-fix-merge-worktree_setup",
          runId,
          be(),
        );
        const setupResult = stepComplete(
          setup.stepId,
          "STATUS: done\n" +
            "ORIGINAL_BRANCH: main\n" +
            "BUILD_CMD: npm run build\n" +
            "TEST_CMD: npm test\n" +
            "BASELINE: Build succeeds, 1 test passes (bug-matching), 1 test fails (correct expectation)\n",
          be(),
        );
        assert.equal(setupResult.status, "advanced");

        // Step: fix (fixer)
        const fix = stepClaim(
          "bug-fix-merge-worktree_fixer",
          runId,
          be(),
        );
        const fixResult = stepComplete(
          fix.stepId,
          "STATUS: done\n" +
            "CHANGES: Changed 'return a - b' to 'return a + b' in src/math.ts\n" +
            "REGRESSION_TEST: Added test that verifies add(2, 3) === 5 (catches the subtraction bug)\n",
          be(),
        );
        assert.equal(fixResult.status, "advanced");

        // Step: verify (verifier)
        const verify = stepClaim(
          "bug-fix-merge-worktree_verifier",
          runId,
          be(),
        );
        const verifyResult = stepComplete(
          verify.stepId,
          "STATUS: done\n" +
            "VERIFIED: Fix correct — add now returns a + b, regression test passes, all tests pass\n" +
            "TESTED_TREE: scripted-smoke-tree\n",
          be(),
        );
        assert.equal(verifyResult.status, "advanced");

        // Step: finalize_merge (merger)
        const merge = stepClaim(
          "bug-fix-merge-worktree_merger",
          runId,
          be(),
        );
        const mergeResult = stepComplete(
          merge.stepId,
          plumbingMergeOutput("def5678deadbeef", "scripted-smoke-tree"),
          be(),
        );
        assert.equal(mergeResult.status, "completed");

        // 4. Verify the run completed
        const statusOut = cliMustSucceed(
          ["workflow", "status", runId],
          be(),
          "workflow status",
        );
        assert.match(statusOut, /Status:\s+completed/i);
        assert.match(statusOut, /\[done\s+\]\s+step-triage/);
        assert.match(statusOut, /\[done\s+\]\s+step-investigate/);
        assert.match(statusOut, /\[done\s+\]\s+step-setup/);
        assert.match(statusOut, /\[done\s+\]\s+step-fix/);
        assert.match(statusOut, /\[done\s+\]\s+step-verify/);
        assert.match(statusOut, /\[done\s+\]\s+step-finalize_merge/);
      } finally {
        cleanupTempHome(env);
      }
    },
  );

  const bugFixSteps: CannedStep[] = [
    {
      agent: "triager",
      output: (repoDir) =>
        "STATUS: done\n" +
        `REPO: ${repoDir}\n` +
        "BRANCH: bugfix/fix-add-function\n" +
        "SEVERITY: high\n" +
        "AFFECTED_AREA: src/math.ts\n" +
        "REPRODUCTION: add(2, 3) returns -1\n" +
        "PROBLEM_STATEMENT: add subtracts instead of adding\n",
    },
    {
      agent: "investigator",
      output: () =>
        "STATUS: done\n" +
        "ROOT_CAUSE: add uses the subtraction operator\n" +
        "FIX_APPROACH: replace subtraction with addition\n",
    },
    {
      agent: "setup",
      output: () =>
        "STATUS: done\n" +
        "ORIGINAL_BRANCH: main\n" +
        "BUILD_CMD: npm run build\n" +
        "TEST_CMD: npm test\n" +
        "BASELINE: known failing regression test\n",
    },
    {
      agent: "fixer",
      output: () =>
        "STATUS: done\n" +
        "CHANGES: corrected the add implementation\n" +
        "REGRESSION_TEST: verifies add(2, 3) equals 5\n",
    },
    {
      agent: "verifier",
      output: () =>
        "STATUS: done\n" +
        "VERIFIED: fix and regression test pass\n" +
        "TESTED_TREE: bug-fix-smoke-tree\n",
    },
    {
      agent: "merger",
      output: () => plumbingMergeOutput("badd00ddeadbeef", "bug-fix-smoke-tree"),
    },
  ];

  const quarantineSteps: CannedStep[] = [
    {
      agent: "setup",
      output: () =>
        "STATUS: done\n" +
        "ORIGINAL_BRANCH: main\n" +
        "BUILD_CMD: npm run build\n" +
        "TEST_CMD: npm test\n" +
        "CI_NOTES: one broken test\n" +
        "BASELINE: one test fails\n",
    },
    {
      agent: "quarantiner",
      output: () =>
        "STATUS: done\n" +
        "DISABLED: 1\n" +
        "FILES_CHANGED: 1\n" +
        "SUMMARY: quarantined the broken math test\n",
    },
    {
      agent: "verifier",
      output: () =>
        "STATUS: done\n" +
        "VERIFIED: suite passes and only the test file changed\n" +
        "TESTED_TREE: quarantine-smoke-tree\n",
    },
    {
      agent: "merger",
      output: () => plumbingMergeOutput("cafe123deadbeef", "quarantine-smoke-tree"),
    },
  ];

  const securitySteps: CannedStep[] = [
    {
      agent: "scanner",
      output: (repoDir) =>
        "STATUS: done\n" +
        `REPO: ${repoDir}\n` +
        "BRANCH: security-audit-smoke\n" +
        "VULNERABILITY_COUNT: 1\n" +
        "FINDINGS: unsafe input reaches a command\n",
    },
    {
      agent: "prioritizer",
      output: () =>
        "STATUS: done\n" +
        "FIX_PLAN: validate command input\n" +
        "CRITICAL_COUNT: 0\n" +
        "HIGH_COUNT: 1\n" +
        "DEFERRED: none\n" +
        'STORIES_JSON: [{"id":"US-001","title":"Validate command input","description":"Reject unsafe command input","acceptanceCriteria":["unsafe input is rejected","tests pass"]}]\n',
    },
    {
      agent: "setup",
      output: () =>
        "STATUS: done\n" +
        "ORIGINAL_BRANCH: main\n" +
        "BUILD_CMD: npm run build\n" +
        "TEST_CMD: npm test\n" +
        "BASELINE: existing tests pass\n",
    },
    {
      agent: "fixer",
      output: () =>
        "STATUS: done\n" +
        "CHANGES: added command input validation\n" +
        "REGRESSION_TEST: rejects unsafe command input\n",
    },
    {
      agent: "verifier",
      output: () => "STATUS: done\nVERIFIED: vulnerability is fixed\n",
    },
    {
      agent: "tester",
      output: () =>
        "STATUS: done\n" +
        "RESULTS: full suite and audit pass\n" +
        "TESTED_TREE: security-smoke-tree\n" +
        "AUDIT_AFTER: no remaining findings\n",
    },
    {
      agent: "merger",
      output: () => plumbingMergeOutput("5ec0123deadbeef", "security-smoke-tree"),
    },
  ];

  const additionalMergeWorkflows: CannedWorkflow[] = [
    {
      id: "bug-fix-merge",
      task: "Fix the add function",
      worktree: false,
      steps: bugFixSteps,
    },
    {
      id: "quarantine-broken-tests-merge",
      task: "Quarantine broken tests",
      worktree: false,
      steps: quarantineSteps,
    },
    {
      id: "quarantine-broken-tests-merge-worktree",
      task: "Quarantine broken tests",
      worktree: true,
      steps: quarantineSteps,
    },
    {
      id: "security-audit-merge",
      task: "Audit and fix security vulnerabilities",
      worktree: false,
      steps: securitySteps,
    },
    {
      id: "security-audit-merge-worktree",
      task: "Audit and fix security vulnerabilities",
      worktree: true,
      steps: securitySteps,
    },
  ];

  for (const workflow of additionalMergeWorkflows) {
    it(
      `${workflow.id}: canned plumbing merger output completes the workflow`,
      { timeout: 120_000 },
      async () => runCannedWorkflow(workflow),
    );
  }
});
