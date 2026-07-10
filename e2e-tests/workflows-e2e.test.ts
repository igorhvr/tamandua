/******************************************************************************
 * ⚠️  WARNING: SLOW, EXPENSIVE REAL E2E TEST — DO NOT RUN BY DEFAULT  ⚠️
 *
 * This test runs REAL Tamandua workflow executions with a LIVE daemon and
 * scheduler processing steps through actual agent invocations (pi/llm calls).
 *
 * COST/TIME WARNING:
 *   - SPENDS REAL API TOKENS (may cost money)
 *   - Expected runtime: 90–180 minutes (four sequential real workflows)
 *   - Requires a configured pi agent setup (model, provider, auth)
 *   - Uses significant CPU while the daemon processes steps
 *
 * WHEN TO RUN:
 *   - After major changes to the daemon, scheduler, or agent polling infra
 *   - To validate the full Tamandua pipeline end-to-end
 *   - Only via: ./run-all-real-e2e-tests
 *
 * WHEN NOT TO RUN:
 *   - During routine development
 *   - As part of CI
 *   - Unless you explicitly understand the cost and time commitment
 *
 * FOR FAINT OF HEART:
 *   ./run-all-smoke-e2e-tests  — fast state-machine test (~10s, no tokens)
 *
 * This test is separate from the regular test suite (npm test) and is NOT
 * picked up by tsconfig.json or npm test globs. It lives in e2e-tests/.
 *
 * TEST ISOLATION:
 *   - Uses temp HOME isolation via createTempHome()
 *   - Uses reserveDistinctRandomPorts() — no default ports (3334/3338/3339)
 *   - Daemon runs in isolated HOME/TAMANDUA_STATE_DIR
 *   - Worktree directories are created under the isolated HOME (os.homedir()
 *     respects HOME env var), so cleanupTempHome() removes them
 *   - All .tamandua state (DB, events, logs, PID/port files) is in the
 *     isolated temp HOME and removed by cleanupTempHome()
 *   - after() hook + per-test finally blocks guarantee cleanup on failure
 *
 * TEST ORDERING:
 *   The four tests run SEQUENTIALLY (concurrency: 1):
 *   1. bug-fix-merge-worktree  — fixes the deliberately broken add function
 *   2. feature-dev-merge-worktree — adds a multiply function
 *   3. quarantine-broken-tests-merge-worktree — quarantines failing test
 *   4. security-audit-merge-worktree — fixes command injection vulnerability
 *   Tests 1–2 share the origin-repo (sample-project fixture). Tests 3 and 4
 *   use separate repos: quarantine-repo (sample-project fixture) and
 *   origin-vuln-repo (sample-project-vuln fixture). All tests share the
 *   same temp HOME and before/after hooks.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createTempHome,
  baseEnv,
  inheritedProcessEnv,
  cliMustSucceed,
  spawnWorkflowRun,
  prepareGitRepo,
  resolveFullRunId,
  cleanupTempHome,
} from "./helpers/smoke-helpers.ts";
import {
  startIsolatedDaemon,
  stopIsolatedDaemon,
  waitForRunTerminal,
  auditRunTokens,
  waitForRunWorkTokens,
  pollForRunCompletionWithNudge,
  isSuccessfulRunTerminalStatus,
  collectRunDiagnostics,
} from "./helpers/e2e-helpers.ts";
import { reserveDistinctRandomPorts } from "../tests/helpers/test-env.ts";
import type { ChildProcess } from "node:child_process";

const fixtureDir = path.join(process.cwd(), "e2e-tests", "fixtures", "sample-project");

function runNodeModuleScript(repoDir: string, script: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoDir,
    encoding: "utf-8",
  });
}

function testCommandEnv(): NodeJS.ProcessEnv {
  return inheritedProcessEnv();
}

function buildSampleProject(repoDir: string): void {
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], {
    cwd: repoDir,
    encoding: "utf-8",
  });
  execFileSync("npm", ["exec", "--yes", "--package", "typescript", "--", "tsc"], {
    cwd: repoDir,
    encoding: "utf-8",
  });
}

function assertRepoClean(repoDir: string, context: string): void {
  const status = execSync("git status --porcelain", { cwd: repoDir, encoding: "utf-8" });
  assert.equal(status.trim(), "", `${context} left origin repository dirty:\n${status}`);
}

/**
 * stripComments removes line comments (double-slash) and block comments
 * (slash-star to star-slash) from source code, while preserving those
 * character sequences inside string literals.
 *
 * This allows assertions on source content (e.g. checking for exec()
 * calls) without being tripped by comment mentions like
 * "// FIX: use fs.readFile() instead of shell exec()".
 */
function stripComments(source: string): string {
  const result: string[] = [];
  let i = 0;

  while (i < source.length) {
    // ── Check for the start of a string literal ─────────────────
    const quote = source[i];
    if (quote === "'" || quote === '"' || quote === "`") {
      result.push(quote);
      i++;
      // Consume until matching closing quote (handling escapes)
      while (i < source.length) {
        const ch = source[i];
        if (ch === "\\") {
          result.push(ch);
          i++;
          if (i < source.length) {
            result.push(source[i]);
            i++;
          }
        } else if (ch === quote) {
          result.push(ch);
          i++;
          break;
        } else {
          result.push(ch);
          i++;
        }
      }
      continue;
    }

    // ── Check for // line comment ──────────────────────────────
    if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "/") {
      // Skip to end of line
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      continue;
    }

    // ── Check for /* block comment ─────────────────────────────
    if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "*") {
      i += 2; // skip /*
      let depth = 1;
      // Scan for matching */, handling nested /* (increment depth)
      // and unclosed comments (strip to end of source)
      while (i < source.length && depth > 0) {
        if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "*") {
          i += 2;
          depth++;
        } else if (source[i] === "*" && i + 1 < source.length && source[i + 1] === "/") {
          i += 2;
          depth--;
        } else {
          i++;
        }
      }
      continue;
    }

    // ── Regular code character ─────────────────────────────────
    result.push(source[i]);
    i++;
  }

  return result.join("");
}

// ── Shared state across both sequential tests ────────────────────────────
let env: Awaited<ReturnType<typeof createTempHome>>;
let repoDir: string;
let daemon: ChildProcess;

describe(
  "real e2e workflows (LIVE agents, daemon, scheduler)",
  {
    // Sequential: tests share the temp HOME and sample repo.
    // High timeout: each individual test may need 45+ minutes.
    concurrency: 1,
  },
  () => {
    // ── before: shared environment setup ──────────────────────────────
    before(async () => {
      // Create isolated temp HOME (symlinks real ~/.pi for auth)
      env = await createTempHome();

      // Install both workflows
      cliMustSucceed(
        ["workflow", "install", "feature-dev-merge-worktree"],
        baseEnv(env.homeDir, env.controlPort),
        "install feature-dev-merge-worktree",
      );
      cliMustSucceed(
        ["workflow", "install", "bug-fix-merge-worktree"],
        baseEnv(env.homeDir, env.controlPort),
        "install bug-fix-merge-worktree",
      );
      cliMustSucceed(
        ["workflow", "install", "quarantine-broken-tests-merge-worktree"],
        baseEnv(env.homeDir, env.controlPort),
        "install quarantine-broken-tests-merge-worktree",
      );
      cliMustSucceed(
        ["workflow", "install", "security-audit-merge-worktree"],
        baseEnv(env.homeDir, env.controlPort),
        "install security-audit-merge-worktree",
      );

      // Prepare a clean git repo from the sample-project fixture.
      // Both tests share this origin repository.
      repoDir = path.join(env.root, "origin-repo");
      prepareGitRepo(fixtureDir, repoDir);
    });

    // ── after: cleanup ─────────────────────────────────────────────────
    after(async () => {
      try {
        await stopIsolatedDaemon(daemon);
      } catch {
        // best-effort
      }
      cleanupTempHome(env);
    });

    // ── TEST 1: bug-fix-merge-worktree ────────────────────────────────
    it(
      "bug-fix-merge-worktree: fixes broken add function",
      { timeout: 60 * 60_000 }, // 60 minutes
      async () => {
        // ── Start daemon ────────────────────────────────────────────
        daemon = await startIsolatedDaemon(
          env.dashboardPort,
          env.homeDir,
          env.controlPort,
        );

        try {
          // ── Verify precondition: add function starts broken ──────
          const preMathTs = fs.readFileSync(
            path.join(repoDir, "src", "math.ts"),
            "utf-8",
          );
          assert.ok(
            preMathTs.includes("a - b") || preMathTs.includes("a-b"),
            `Precondition: add function should be broken (a - b). Content:\n${preMathTs}`,
          );

          // ── Create run ───────────────────────────────────────────
          const runIdPrefix = await spawnWorkflowRun(
            [
              "workflow",
              "run",
              "bug-fix-merge-worktree",
              "The add function in src/math.ts returns a - b instead of a + b",
              "--worktree-origin-repository",
              repoDir,
            ],
            baseEnv(env.homeDir, env.controlPort),
          );
          const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

          // ── Wait for completion ──────────────────────────────────
          await waitForRunTerminal(
            runId,
            baseEnv(env.homeDir, env.controlPort),
            45 * 60_000, // 45 min timeout
            10_000,       // poll every 10s
            env.tamanduaDir, // attach log/event/step diagnostics on timeout
          );

          // ── Verify run status ────────────────────────────────────
          const statusOut = cliMustSucceed(
            ["workflow", "status", runId],
            baseEnv(env.homeDir, env.controlPort),
            "workflow status after bug-fix completion",
          );
          assert.match(statusOut, /Status:\s+completed/i);

          // ── Token accounting audit (MOTOR-CONTRACT.md C14/C15) ───
          const bugFixAudit = auditRunTokens(env.tamanduaDir, runId);
          assert.ok(
            bugFixAudit.workTokens > 0,
            `bug-fix run should have attributed work tokens, got ${bugFixAudit.workTokens}`,
          );
          assert.equal(
            typeof bugFixAudit.terminalTokensSpent,
            "number",
            "run.completed should carry tokensSpent",
          );
          console.log(
            `[real-e2e baseline] bug-fix-merge-worktree: workTokens=${bugFixAudit.workTokens} ` +
              `systemTokens=${bugFixAudit.systemTokens} tokenUpdateEvents=${bugFixAudit.tokenUpdateEvents}`,
          );

          // ── Verify repository state ──────────────────────────────
          // After the bug-fix workflow completes, the origin repo should
          // have a fix for the add function.

          // Git log shows a merge commit for the fix on main
          const gitLog = execSync(
            "git log --oneline -5",
            { cwd: repoDir, encoding: "utf-8" },
          );
          const commitLines = gitLog.trim().split("\n");
          assert.ok(
            commitLines.length >= 2,
            `Expected at least 2 commits (initial + fix merge), got:\n${gitLog}`,
          );

          // Add function is FIXED: returns a + b (not a - b)
          const mathTs = fs.readFileSync(
            path.join(repoDir, "src", "math.ts"),
            "utf-8",
          );
          assert.ok(
            mathTs.includes("a + b") || mathTs.includes("a+b"),
            `src/math.ts add function should be fixed (a + b). Content:\n${mathTs}`,
          );
          assert.ok(
            !mathTs.includes("a - b") && !mathTs.includes("a-b"),
            `src/math.ts should NOT contain the broken subtract logic. Content:\n${mathTs}`,
          );

          // Assert the actual runtime behavior: add(5, 3) === 8.
          const runtimeOutput = runNodeModuleScript(
            repoDir,
            `
              const { add } = await import("./src/math.ts");
              if (add(5, 3) !== 8) throw new Error("add(5, 3) failed");
              console.log("add ok");
            `,
          );
          assert.match(runtimeOutput, /add ok/);

          buildSampleProject(repoDir);
          const testOutput = execSync("npm test", {
            cwd: repoDir,
            encoding: "utf-8",
            env: testCommandEnv(),
          });
          assert.ok(
            testOutput.match(/pass|OK|0 fail/),
            `Tests should pass after fix. Output:\n${testOutput.substring(0, 500)}`,
          );

          // add(5, 3) === 8 should be asserted in tests
          const testPath = path.join(repoDir, "test", "math.test.ts");
          if (fs.existsSync(testPath)) {
            const testContent = fs.readFileSync(testPath, "utf-8");
            // The fixed test should expect add(5, 3) === 8
            assert.ok(
              testContent.includes("8"),
              `math.test.ts should assert add(5, 3) === 8 after fix. Content:\n${testContent.substring(0, 500)}`,
            );
            // Should NOT still assert add(5, 3) === 2
            assert.ok(
              !testContent.match(/add\(5,\s*3\).*2/) && !testContent.includes("expects subtraction"),
              `math.test.ts should no longer assert the buggy value 2. Content:\n${testContent.substring(0, 500)}`,
            );
          }

          assertRepoClean(repoDir, "bug-fix post-check");
        } finally {
          // ── Stop daemon between workflows for clean scheduler state ─
          await stopIsolatedDaemon(daemon);
        }
      },
    );

    // ── TEST 2: feature-dev-merge-worktree (sequential, same repo) ──
    it(
      "feature-dev-merge-worktree: adds multiply function (sequential, same repo)",
      { timeout: 60 * 60_000 }, // 60 minutes
      async () => {
        // ── Restart daemon for clean scheduler state ────────────────
        daemon = await startIsolatedDaemon(
          env.dashboardPort,
          env.homeDir,
          env.controlPort,
        );

        try {
          // ── Verify precondition: add function was fixed by test 1 ─
          const preMathTs = fs.readFileSync(
            path.join(repoDir, "src", "math.ts"),
            "utf-8",
          );
          assert.ok(
            preMathTs.includes("a + b") || preMathTs.includes("a+b"),
            `Precondition: add function should already be fixed (a + b). Content:\n${preMathTs}`,
          );

          // ── Create run ───────────────────────────────────────────
          const runIdPrefix = await spawnWorkflowRun(
            [
              "workflow",
              "run",
              "feature-dev-merge-worktree",
              "Add a multiply function to math.ts that multiplies two numbers",
              "--worktree-origin-repository",
              repoDir,
            ],
            baseEnv(env.homeDir, env.controlPort),
          );
          const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

          // ── Wait for completion ──────────────────────────────────
          await waitForRunTerminal(
            runId,
            baseEnv(env.homeDir, env.controlPort),
            45 * 60_000, // 45 min timeout
            10_000,       // poll every 10s
            env.tamanduaDir, // attach log/event/step diagnostics on timeout
          );

          // ── Verify run status ────────────────────────────────────
          const statusOut = cliMustSucceed(
            ["workflow", "status", runId],
            baseEnv(env.homeDir, env.controlPort),
            "workflow status after feature-dev completion",
          );
          assert.match(statusOut, /Status:\s+completed/i);

          // ── Token accounting audit (MOTOR-CONTRACT.md C14/C15) ───
          const featureAudit = auditRunTokens(env.tamanduaDir, runId);
          assert.ok(
            featureAudit.workTokens > 0,
            `feature-dev run should have attributed work tokens, got ${featureAudit.workTokens}`,
          );
          assert.equal(
            typeof featureAudit.terminalTokensSpent,
            "number",
            "run.completed should carry tokensSpent",
          );
          console.log(
            `[real-e2e baseline] feature-dev-merge-worktree: workTokens=${featureAudit.workTokens} ` +
              `systemTokens=${featureAudit.systemTokens} tokenUpdateEvents=${featureAudit.tokenUpdateEvents}`,
          );

          // ── Verify repository state ──────────────────────────────
          // After the workflow completes, the origin repo should have
          // the add fix from test 1 and a squash merge commit with multiply.

          // Git log shows a second merge commit on main
          const gitLog = execSync(
            "git log --oneline -5",
            { cwd: repoDir, encoding: "utf-8" },
          );
          const commitLines = gitLog.trim().split("\n");
          assert.ok(
            commitLines.length >= 3,
            `Expected at least 3 commits (initial + fix merge + feature merge), got:\n${gitLog}`,
          );

          // Add function remains fixed with no regression, and multiply exists
          const mathTs = fs.readFileSync(
            path.join(repoDir, "src", "math.ts"),
            "utf-8",
          );
          assert.ok(
            mathTs.includes("a + b") || mathTs.includes("a+b"),
            `src/math.ts add function should be fixed (a + b). Content:\n${mathTs}`,
          );
          assert.ok(
            !mathTs.includes("a - b") && !mathTs.includes("a-b"),
            `src/math.ts should NOT contain the broken subtract logic. Content:\n${mathTs}`,
          );

          // Assert the actual runtime behavior: add remains fixed and multiply works.
          const runtimeOutput = runNodeModuleScript(
            repoDir,
            `
              const { add, multiply } = await import("./src/math.ts");
              if (add(5, 3) !== 8) throw new Error("add(5, 3) failed");
              if (multiply(2, 3) !== 6) throw new Error("multiply(2, 3) regressed");
              if (multiply(0, 5) !== 0) throw new Error("multiply(0, 5) failed");
              if (multiply(-2, 3) !== -6) throw new Error("multiply(-2, 3) failed");
              console.log("runtime ok");
            `,
          );
          assert.match(runtimeOutput, /runtime ok/);

          buildSampleProject(repoDir);
          const testOutput = execSync("npm test", {
            cwd: repoDir,
            encoding: "utf-8",
            env: testCommandEnv(),
          });
          assert.ok(
            testOutput.match(/pass|OK|0 fail/),
            `Tests should pass after fix. Output:\n${testOutput.substring(0, 500)}`,
          );

          // add(5, 3) === 8 should be asserted in tests
          const testPath = path.join(repoDir, "test", "math.test.ts");
          if (fs.existsSync(testPath)) {
            const testContent = fs.readFileSync(testPath, "utf-8");
            // The fixed test should expect add(5, 3) === 8
            assert.ok(
              testContent.includes("8"),
              `math.test.ts should assert add(5, 3) === 8 after fix. Content:\n${testContent.substring(0, 500)}`,
            );
            // Should NOT still assert add(5, 3) === 2
            assert.ok(
              !testContent.match(/add\(5,\s*3\).*2/) && !testContent.includes("expects subtraction"),
              `math.test.ts should no longer assert the buggy value 2. Content:\n${testContent.substring(0, 500)}`,
            );
          }

          // ── Verify multiply exists and its tests are present ─────
          assert.ok(
            mathTs.includes("multiply") || mathTs.includes("Multiply"),
            `multiply function should exist after feature workflow. Content:\n${mathTs}`,
          );
          assert.ok(
            testOutput.includes("multiply") || testOutput.includes("Multiply"),
            `Multiply tests should pass after feature workflow. Output:\n${testOutput.substring(0, 500)}`,
          );

          assertRepoClean(repoDir, "feature-dev post-check");
        } finally {
          // ── Stop daemon ─────────────────────────────────────────
          await stopIsolatedDaemon(daemon);
        }
      },
    );

    // ── TEST 3: quarantine-broken-tests-merge-worktree (separate repo) ─
    it(
      "quarantine-broken-tests-merge-worktree: quarantines failing test",
      { timeout: 60 * 60_000 }, // 60 minutes
      async () => {
        // Prepare a separate repo from the fixture (not the shared repoDir
        // — tests 1/2 modified their repo; quarantine gets a fresh copy).
        const quarantineRepoDir = path.join(env.root, "quarantine-repo");
        prepareGitRepo(fixtureDir, quarantineRepoDir);

        // ── Start daemon ──────────────────────────────────────────
        daemon = await startIsolatedDaemon(
          env.dashboardPort,
          env.homeDir,
          env.controlPort,
        );

        try {
          // ── Verify preconditions ────────────────────────────────
          const preTest = fs.readFileSync(
            path.join(quarantineRepoDir, "test", "math.test.ts"),
            "utf-8",
          );
          assert.ok(
            preTest.includes("correctly expects addition"),
            "Precondition: failing test (correctly expects addition) must exist",
          );
          assert.ok(
            preTest.includes("returns the difference"),
            "Precondition: passing test (returns the difference) must exist",
          );

          // ── Create run ──────────────────────────────────────────
          const runIdPrefix = await spawnWorkflowRun(
            [
              "workflow",
              "run",
              "quarantine-broken-tests-merge-worktree",
              "Quarantine broken tests in the sample math project",
              "--context",
              "branch=quarantine/broken-tests",
              "--worktree-origin-repository",
              quarantineRepoDir,
            ],
            baseEnv(env.homeDir, env.controlPort),
          );
          const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

          // ── Wait for completion ──────────────────────────────────
          await waitForRunTerminal(
            runId,
            baseEnv(env.homeDir, env.controlPort),
            45 * 60_000, // 45 min timeout
            10_000,       // poll every 10s
            env.tamanduaDir,
          );

          // ── Verify run status ────────────────────────────────────
          const statusOut = cliMustSucceed(
            ["workflow", "status", runId],
            baseEnv(env.homeDir, env.controlPort),
            "workflow status after quarantine completion",
          );
          assert.match(statusOut, /Status:\s+completed/i);

          // ── Token accounting audit ───────────────────────────────
          const quarantineAudit = auditRunTokens(env.tamanduaDir, runId);
          assert.ok(
            quarantineAudit.workTokens > 0,
            `quarantine run should have attributed work tokens, got ${quarantineAudit.workTokens}`,
          );
          assert.equal(
            typeof quarantineAudit.terminalTokensSpent,
            "number",
            "run.completed should carry tokensSpent",
          );
          console.log(
            `[real-e2e baseline] quarantine-broken-tests-merge-worktree: workTokens=${quarantineAudit.workTokens} ` +
              `systemTokens=${quarantineAudit.systemTokens} tokenUpdateEvents=${quarantineAudit.tokenUpdateEvents}`,
          );

          // ── Verify quarantine result ─────────────────────────────
          // After the workflow completes, the origin repo should have
          // a squash-merge commit with the quarantined test changes.
          const testPath = path.join(quarantineRepoDir, "test", "math.test.ts");
          const testContent = fs.readFileSync(testPath, "utf-8");

          // Failing test should be quarantined with .skip (not deleted).
          assert.ok(
            testContent.includes(".skip"),
            `Failing test should have .skip. Content:\n${testContent.substring(0, 800)}`,
          );

          // The failing test description must still be present.
          assert.ok(
            testContent.includes("correctly expects addition"),
            "Failing test must still exist (not deleted)",
          );

          // The previously-passing test must still be present.
          assert.ok(
            testContent.includes("returns the difference"),
            "Passing test must still exist",
          );

          // Verify a merge commit is present on the default branch.
          const gitLog = execSync(
            "git log --oneline -5",
            { cwd: quarantineRepoDir, encoding: "utf-8" },
          );
          const logLines = gitLog.trim().split("\n");
          assert.ok(
            logLines.length >= 2,
            `Expected at least 2 commits (initial + quarantine merge), got:\n${gitLog}`,
          );
          assert.ok(
            logLines.some((line) => line.includes("chore")),
            `Expected a chore commit for quarantine in:\n${gitLog}`,
          );

          assertRepoClean(quarantineRepoDir, "quarantine post-check");
        } finally {
          // ── Stop daemon ─────────────────────────────────────────
          await stopIsolatedDaemon(daemon);
        }
      },
    );

    // ── TEST 4: security-audit-merge-worktree (separate vuln repo) ─
    it(
      "security-audit-merge-worktree: fixes command injection in server.ts",
      { timeout: 60 * 60_000 }, // 60 minutes
      async () => {
        // ── Prepare a git repo from the vulnerable fixture ──────
        const vulnFixtureDir = path.join(
          process.cwd(),
          "e2e-tests",
          "fixtures",
          "sample-project-vuln",
        );
        const vulnRepoDir = path.join(env.root, "origin-vuln-repo");
        prepareGitRepo(vulnFixtureDir, vulnRepoDir);

        // ── Restart daemon for clean scheduler state ────────────
        daemon = await startIsolatedDaemon(
          env.dashboardPort,
          env.homeDir,
          env.controlPort,
        );

        try {
          // ── Verify precondition: server.ts has exec() vuln ───
          const preServerTs = fs.readFileSync(
            path.join(vulnRepoDir, "src", "server.ts"),
            "utf-8",
          );
          assert.ok(
            stripComments(preServerTs).includes("exec("),
            `Precondition: server.ts should contain exec() vulnerability. Content:\n${preServerTs}`,
          );

          // ── Verify non-security code exists pre-fix ──────────
          const preMathTs = fs.readFileSync(
            path.join(vulnRepoDir, "src", "math.ts"),
            "utf-8",
          );
          assert.ok(
            preMathTs.includes("a - b"),
            `Precondition: math.ts should have the subtract bug. Content:\n${preMathTs}`,
          );

          // ── Create run ───────────────────────────────────────
          const runIdPrefix = await spawnWorkflowRun(
            [
              "workflow",
              "run",
              "security-audit-merge-worktree",
              "Perform a security audit of this codebase. The repository contains a command injection vulnerability in src/server.ts where user input is passed unsanitized to a shell command.",
              "--worktree-origin-repository",
              vulnRepoDir,
            ],
            baseEnv(env.homeDir, env.controlPort),
          );
          const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

          // ── Wait for completion ──────────────────────────────
          await waitForRunTerminal(
            runId,
            baseEnv(env.homeDir, env.controlPort),
            45 * 60_000, // 45 min timeout
            10_000,       // poll every 10s
            env.tamanduaDir, // attach log/event/step diagnostics on timeout
          );

          // ── Verify run status ────────────────────────────────
          const statusOut = cliMustSucceed(
            ["workflow", "status", runId],
            baseEnv(env.homeDir, env.controlPort),
            "workflow status after security-audit completion",
          );
          assert.match(statusOut, /Status:\s+completed/i);

          // ── Token accounting audit (MOTOR-CONTRACT.md C14/C15) ──
          const securityAudit = auditRunTokens(env.tamanduaDir, runId);
          assert.ok(
            securityAudit.workTokens > 0,
            `security-audit run should have attributed work tokens, got ${securityAudit.workTokens}`,
          );
          assert.equal(
            typeof securityAudit.terminalTokensSpent,
            "number",
            "run.completed should carry tokensSpent",
          );
          console.log(
            `[real-e2e baseline] security-audit-merge-worktree: workTokens=${securityAudit.workTokens} ` +
              `systemTokens=${securityAudit.systemTokens} tokenUpdateEvents=${securityAudit.tokenUpdateEvents}`,
          );

          // ── Verify repository state ──────────────────────────
          // Git log shows a fix(security) merge commit on main
          const gitLog = execSync("git log --oneline -5", {
            cwd: vulnRepoDir,
            encoding: "utf-8",
          });
          const commitLines = gitLog.trim().split("\n");
          assert.ok(
            commitLines.length >= 2,
            `Expected at least 2 commits (initial + fix merge), got:\n${gitLog}`,
          );
          const hasSecurityCommit =
            gitLog.includes("fix(security)") ||
            gitLog.toLowerCase().includes("security");
          assert.ok(
            hasSecurityCommit,
            `Expected a fix(security) or security-related merge commit in git log:\n${gitLog}`,
          );

          // ── Verify the vulnerability is fixed ────────────────
          // src/server.ts should no longer use exec() with unsanitized input
          const postServerTs = fs.readFileSync(
            path.join(vulnRepoDir, "src", "server.ts"),
            "utf-8",
          );
          const strippedPostServerTs = stripComments(postServerTs);
          // (a) Assert no import/require of exec/execSync from child_process
          // (covers both ESM imports and CommonJS requires, incl. destructuring)
          assert.ok(
            !(/require\(\s*["'](node:)?child_process["']\s*\)/i.test(strippedPostServerTs) &&
              /\bexec(Sync)?\b/i.test(strippedPostServerTs)) &&
              !/import[^;]*\{[^}]*\b(exec|execSync)\b[^}]*\}[^;]*from[^;]*["'](node:)?child_process/i.test(strippedPostServerTs),
            `src/server.ts should not import exec/execSync from child_process after fix. Content:\n${postServerTs.substring(0, 800)}`,
          );
          // (b) Assert no exec( or execSync( call exists outside comments
          assert.ok(
            !(/(?<![A-Za-z0-9_])exec(Sync)?\s*\(/.test(strippedPostServerTs)),
            `src/server.ts should no longer call exec()/execSync() after fix. Content:\n${postServerTs.substring(0, 800)}`,
          );

          // ── Verify non-security code survives unchanged ──────
          const postMathTs = fs.readFileSync(
            path.join(vulnRepoDir, "src", "math.ts"),
            "utf-8",
          );
          assert.ok(
            postMathTs.includes("a - b"),
            `math.ts should be unchanged by security audit (only the vulnerability should be fixed). Content:\n${postMathTs}`,
          );

          // ── Build and test after fix ─────────────────────────
          buildSampleProject(vulnRepoDir);
          const testOutput = execSync("npm test", {
            cwd: vulnRepoDir,
            encoding: "utf-8",
            env: testCommandEnv(),
          });
          assert.ok(
            testOutput.match(/pass|OK|0 fail/),
            `Tests should pass after fix. Output:\n${testOutput.substring(0, 500)}`,
          );

          // ── Verify regression test still exists ──────────────
          const serverTestPath = path.join(
            vulnRepoDir,
            "test",
            "server.test.ts",
          );
          if (fs.existsSync(serverTestPath)) {
            const serverTestTs = fs.readFileSync(serverTestPath, "utf-8");
            assert.ok(
              serverTestTs.includes("catFile"),
              `server.test.ts should still test catFile after fix. Content:\n${serverTestTs.substring(0, 500)}`,
            );
            // The regression test from US-001 reads a safe filename
            assert.ok(
              serverTestTs.includes("legitimate") ||
                serverTestTs.includes("safe") ||
                serverTestTs.includes("catFile"),
              `server.test.ts should have safe-path tests.`,
            );
          }

          assertRepoClean(vulnRepoDir, "security-audit post-check");
        } finally {
          // ── Stop daemon ─────────────────────────────────────
          await stopIsolatedDaemon(daemon);
        }
      },
    );
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// do-now: single-step real e2e test (separate isolated lifecycle)
// ═══════════════════════════════════════════════════════════════════════════
//
// This describe block has its own distinct temp HOME, daemon, and cleanup
// — it is NOT nested inside the sequential describe above. Each test run
// through the real daemon → scheduler → pi pipeline with a live model.

/******************************************************************************
 * ⚠️  SLOW REAL E2E — SPENDS REAL MODEL TOKENS (cheapest in the suite)  ⚠️
 *
 * This test runs a single do-now workflow execution through the real
 * pipeline: daemon → scheduler → pi agent invocation.
 *
 * COST/TIME WARNING:
 *   - Spends real API tokens (one trivial agent task — cents, not dollars)
 *   - Expected runtime: 2–10 minutes (single step, nudge-driven polling)
 *   - Requires a configured pi agent setup (model, provider, auth)
 *
 * WHEN TO RUN:
 *   - Only via: ./run-all-real-e2e-tests
 *
 * FOR FAINT OF HEART:
 *   ./run-all-scripted-e2e-tests — do-now has scripted-tier coverage (~0s,
 *     no tokens)
 *
 * This test is separate from the regular test suite (npm test) and is NOT
 * picked up by tsconfig.json or npm test globs. It lives in e2e-tests/.
 *****************************************************************************/

describe("real e2e do-now workflow (LIVE agent, daemon, scheduler)", () => {
  it(
    "do-now creates a file in the working directory through the real pipeline",
    { timeout: 15 * 60_000 }, // 15 minutes
    async () => {
      const env = await createTempHome();
      let daemon: ChildProcess | undefined;
      try {
        cliMustSucceed(
          ["workflow", "install", "do-now"],
          baseEnv(env.homeDir, env.controlPort),
          "install do-now",
        );

        const workdir = path.join(env.root, "do-now-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        daemon = await startIsolatedDaemon(
          env.dashboardPort,
          env.homeDir,
          env.controlPort,
        );

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "do-now",
            "Create a file named output.txt in the current working directory containing exactly the text: tamandua e2e test passed",
            "--working-directory-for-harness",
            workdir,
          ],
          baseEnv(env.homeDir, env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        // Nudge-driven poll — a single-step run completes when the
        // model finishes; nudging removes the 5-minute interval dead time.
        const status = await pollForRunCompletionWithNudge(
          runId,
          baseEnv(env.homeDir, env.controlPort),
          12 * 60_000, // 12 min for the run itself
          5_000,       // nudge every 5 s
          env.tamanduaDir,
        );
        assert.ok(
          isSuccessfulRunTerminalStatus(status),
          `do-now run should complete, got "${status}"\n${collectRunDiagnostics(env.tamanduaDir, runId)}`,
        );

        // ── Artifact verification ─────────────────────────────────
        const outputPath = path.join(workdir, "output.txt");
        assert.ok(
          fs.existsSync(outputPath),
          `output.txt should exist at ${outputPath}`,
        );
        const fileContents = fs.readFileSync(outputPath, "utf-8");
        assert.equal(
          fileContents.trim(),
          "tamandua e2e test passed",
          `output.txt should contain expected string, got: "${fileContents.trim()}"`,
        );

        // ── Token accounting ───────────────────────────────────────
        const audit = await waitForRunWorkTokens(env.tamanduaDir, runId);
        assert.ok(
          audit.workTokens > 0,
          `do-now run should have attributed work tokens, got ${audit.workTokens}`,
        );
        assert.equal(
          audit.systemTokens,
          0,
          `system_tokens_spent must be 0 (deterministic motor N1, no idle-poll tokens), got ${audit.systemTokens}`,
        );
        assert.ok(
          audit.tokenUpdateEvents > 0,
          `should have run.tokens.updated events, got ${audit.tokenUpdateEvents}`,
        );
        assert.equal(
          typeof audit.terminalTokensSpent,
          "number",
          `terminalTokensSpent should be a number, got ${typeof audit.terminalTokensSpent}`,
        );

        // ── MPRT fallback report parsing ───────────────────────────
        // do-now's execute step has no Reply-with format block, so the
        // REPORT field is parsed by the generic KEY:value parser.
        const db = new DatabaseSync(path.join(env.tamanduaDir, "tamandua.db"));
        try {
          const row = db
            .prepare("SELECT context FROM runs WHERE id = ?")
            .get(runId) as { context: string } | undefined;
          const context = row?.context ? JSON.parse(row.context) : {};
          assert.ok(
            context.report !== undefined && context.report !== null,
            `run context should have a report key (MPRT fallback path), got: ${JSON.stringify(context)}`,
          );
          assert.ok(
            typeof context.report === "string" && context.report.length > 0,
            `context.report should be a non-empty string, got: ${JSON.stringify(context.report)}`,
          );
        } finally {
          db.close();
        }

        // ── Baseline token numbers ─────────────────────────────────
        console.log(
          `[real-e2e baseline] do-now: workTokens=${audit.workTokens} ` +
            `systemTokens=${audit.systemTokens} tokenUpdateEvents=${audit.tokenUpdateEvents} ` +
            `terminalTokensSpent=${audit.terminalTokensSpent}`,
        );
      } finally {
        if (daemon) {
          try {
            await stopIsolatedDaemon(daemon);
          } catch {
            // best-effort
          }
        }
        cleanupTempHome(env);
      }
    },
  );
});

// ── stripComments unit tests ────────────────────────────────────────────
describe("stripComments helper", () => {
  it("removes // line comments", () => {
    const result = stripComments("const x = 1; // inline comment\nconst y = 2;");
    assert.equal(result, "const x = 1; \nconst y = 2;");
  });

  it("removes single-line /* */ block comments", () => {
    const result = stripComments("const x = /* value */ 1;");
    assert.equal(result, "const x =  1;");
  });

  it("removes multiline /* */ block comments", () => {
    const result = stripComments("before\n/* multi\nline\ncomment */\nafter");
    assert.equal(result, "before\n\nafter");
  });

  it("does NOT remove // inside string literals", () => {
    const result = stripComments('const url = "https://example.com";');
    assert.ok(result.includes("https://example.com"), `Expected // in string to be preserved, got: ${result}`);
    assert.ok(result.includes("//"), `// inside string should survive`);
  });

  it("does NOT remove /* inside string literals", () => {
    const result = stripComments('const pattern = "/*comment*/";');
    assert.ok(result.includes("/*comment*/"), `/* inside string should survive, got: ${result}`);
  });

  it("preserves // inside backtick template literals", () => {
    const result = stripComments("const s = `url: //path`;");
    assert.ok(result.includes("//path"), `// inside template literal should survive, got: ${result}`);
  });

  it("preserves /* inside backtick template literals", () => {
    const result = stripComments("const s = `/* not a comment */`;");
    assert.ok(result.includes("/* not a comment */"), `/* inside template literal should survive, got: ${result}`);
  });

  it("handles escaped quotes inside strings", () => {
    const result = stripComments('const s = "she said \\"hello\\""; // comment');
    // stripComments preserves source-level escapes: \" stays \"
    assert.ok(result.includes('she said \\"hello\\"'), `escaped quotes should be preserved, got: ${result}`);
    assert.ok(!result.includes("comment"), `line comment should be stripped`);
  });

  it("handles escaped backslash before quote", () => {
    const result = stripComments('const s = "path\\\\" + x;');
    assert.ok(result.includes('path\\\\'), `escaped backslash should be preserved`);
  });

  it("handles unclosed block comment — strips to end of source", () => {
    const result = stripComments("before /* open but no close");
    assert.equal(result, "before ");
  });

  it("handles nested /* — treats as part of outer block comment", () => {
    const result = stripComments("before /* outer /* inner */ still outer */ after");
    assert.equal(result, "before  after");
  });

  it("exact real-failure comment: exec() only in comment → absent after stripping", () => {
    const source = '// FIX: use fs.readFile() instead of shell exec() to prevent command injection.\nimport fs from "fs";\nfs.readFile(filename, "utf-8");';
    const stripped = stripComments(source);
    assert.ok(!stripped.includes("exec("), `exec() in comment should be stripped, got: ${stripped}`);
    assert.ok(stripped.includes("import fs"), `code after comment should survive`);
    assert.ok(stripped.includes("readFile"), `readFile call should survive`);
  });

  it("preserves exec() calls in actual code (not in comments)", () => {
    const source = 'exec("ls -la");';
    const stripped = stripComments(source);
    assert.ok(stripped.includes("exec(\""), `exec() call should survive, got: ${stripped}`);
  });

  it("block comment containing exec(", () => {
    const source = "/* this used exec() for shell commands */\nconst x = 1;";
    const stripped = stripComments(source);
    assert.ok(!stripped.includes("exec("), `exec() in block comment should be stripped, got: ${stripped}`);
    assert.ok(stripped.includes("const x = 1;"), `code after block comment should survive`);
  });

  it("mixed comments and code", () => {
    const source = [
      "// line comment",
      'const x = "// not a comment";',
      "/* block */ const y = 1; // trailing",
      "const z = 2;",
    ].join("\n");
    const stripped = stripComments(source);
    assert.ok(stripped.includes('const x = "// not a comment";'), `string with // should survive`);
    assert.ok(!stripped.includes("trailing"), `trailing comment should be stripped`);
    assert.ok(stripped.includes("const y = 1;"), `code around block comment should survive`);
    assert.ok(stripped.includes("const z = 2;"), `uncommented line should survive`);
  });

  it("comment-like patterns in double-quoted string are preserved", () => {
    const result = stripComments('const a = "/*"; const b = "*/";');
    assert.equal(result, 'const a = "/*"; const b = "*/";');
  });

  it("comment-like patterns in single-quoted string are preserved", () => {
    const result = stripComments("const a = '/*'; const b = '*/';");
    assert.equal(result, "const a = '/*'; const b = '*/';");
  });

  it("standalone // inside a string literal is not a comment start", () => {
    const source = 'const url = "https://example.com/path";\nconst next = 1;';
    const stripped = stripComments(source);
    assert.ok(stripped.includes('const url = "https://example.com/path";'), `full line should survive`);
  });

  it("mixed quotes: single-quoted // does not start comment", () => {
    const result = stripComments("const x = '//'; const y = 1; // real comment");
    assert.ok(result.includes("'//'"), `// inside single-quoted string should survive, got: ${result}`);
    assert.ok(!result.includes("real comment"), `real comment should be stripped`);
  });
});

describe("comment-blind exec() assertions", () => {
  /** Replicates the post-fix assertion pattern from the security-audit e2e test. */
  function assertNoExecInFixedFile(source: string): { passed: boolean; failures: string[] } {
    const failures: string[] = [];
    const stripped = stripComments(source);

    // (a) Assert no import/require of exec/execSync from child_process
    // (covers both ESM imports and CommonJS requires, incl. destructuring)
    const hasRequireExec =
      /require\(\s*["'](node:)?child_process["']\s*\)/i.test(stripped) &&
      /\bexec(Sync)?\b/i.test(stripped);
    const hasImportExec = /import[^;]*\{[^}]*\b(exec|execSync)\b[^}]*\}[^;]*from[^;]*["'](node:)?child_process/i.test(stripped);
    if (hasRequireExec || hasImportExec) {
      failures.push(
        `should not import exec/execSync from child_process (require=${hasRequireExec}, import=${hasImportExec})`,
      );
    }

    // (b) Assert no exec( or execSync( call exists outside comments
    const hasExecCall = /(?<![A-Za-z0-9_])exec(Sync)?\s*\(/.test(stripped);
    if (hasExecCall) {
      failures.push(
        `should not call exec()/execSync()`,
      );
    }

    return { passed: failures.length === 0, failures };
  }

  it("passes when exec() is only mentioned in a comment (the real-failure scenario)", () => {
    const source = [
      '// FIX: use fs.readFile() instead of shell exec() to prevent command injection.',
      'import fs from "fs";',
      'export function catFile(filename: string): string {',
      '  return fs.readFileSync(filename, "utf-8");',
      '}',
    ].join("\n");
    const result = assertNoExecInFixedFile(source);
    assert.ok(result.passed, `Expected pass but got failures: ${result.failures.join("; ")}`);
  });

  it("fails when exec() is called in actual non-comment code", () => {
    const source = [
      'import { exec } from "child_process";',
      'export function catFile(filename: string): string {',
      '  return exec(`cat ${filename}`);',
      '}',
    ].join("\n");
    const result = assertNoExecInFixedFile(source);
    assert.ok(!result.passed, "Expected failure but got pass");
    assert.ok(result.failures.length >= 2, `Expected at least 2 failures (import + exec call), got: ${JSON.stringify(result.failures)}`);
  });

  it("fails when execSync() is called in actual code", () => {
    const source = [
      'import { execSync } from "child_process";',
      'export function catFile(filename: string): string {',
      '  return execSync(`cat ${filename}`);',
      '}',
    ].join("\n");
    const result = assertNoExecInFixedFile(source);
    assert.ok(!result.passed, "Expected failure but got pass");
    assert.ok(result.failures.length >= 2, `Expected at least 2 failures (import + execSync call), got: ${JSON.stringify(result.failures)}`);
  });

  it("fails when exec is imported from child_process even without a call", () => {
    const source = 'import { exec } from "child_process";\nconst x = 1;';
    const result = assertNoExecInFixedFile(source);
    assert.ok(!result.passed, "Expected failure for exec import but got pass");
    assert.ok(
      result.failures.some((f) => f.includes("import")),
      `Expected import-related failure, got: ${JSON.stringify(result.failures)}`,
    );
  });

  it("fails when exec is required from child_process even without a call", () => {
    const source = 'const { exec } = require("child_process");\nconst x = 1;';
    const result = assertNoExecInFixedFile(source);
    assert.ok(!result.passed, "Expected failure for exec require but got pass");
    assert.ok(
      result.failures.some((f) => f.includes("import")),
      `Expected import-related failure covering require, got: ${JSON.stringify(result.failures)}`,
    );
  });

  it("passes for a correctly fixed file using fs.readFileSync", () => {
    const source = [
      'import fs from "fs";',
      'export function catFile(filename: string): string {',
      '  return fs.readFileSync(filename, "utf-8");',
      '}',
    ].join("\n");
    const result = assertNoExecInFixedFile(source);
    assert.ok(result.passed, `Expected pass but got failures: ${result.failures.join("; ")}`);
  });

  it("precondition check with stripComments still detects exec() in fixture code", () => {
    // The fixture has exec() in actual code, not just in a comment
    const fixtureSource = [
      'import { exec } from "child_process";',
      'export function catFile(filename: string): string {',
      '  return exec(`cat ${filename}`);',
      '}',
    ].join("\n");
    assert.ok(
      stripComments(fixtureSource).includes("exec("),
      "stripComments should preserve exec() in actual code",
    );
  });

  it("post-fix assertion with import of unrelated 'exec' named function does not false-positive", () => {
    const source = [
      'import { exec } from "./utils";',
      'export function catFile(filename: string): string {',
      '  return exec(filename);',
      '}',
    ].join("\n");
    // The import regex requires "from child_process" — importing exec from a local module should pass
    const stripped = stripComments(source);
    const hasImportExec = /import.*\{.*exec.*\}.*from.*child_process/i.test(stripped);
    assert.ok(!hasImportExec, "exec import from non-child_process module should not match");
    // But the exec() call check should still flag it
    assert.ok(
      stripped.includes("exec("),
      "exec() call should still be detected regardless of import source",
    );
  });

  it("block comment referencing exec() next to real exec() call → call is detected", () => {
    const source = [
      '// FIX: use fs.readFile() instead of shell exec() to prevent command injection.',
      'import { exec } from "child_process";',
      'export function catFile(filename: string): string {',
      '  return exec(`cat ${filename}`);',
      '}',
    ].join("\n");
    const result = assertNoExecInFixedFile(source);
    assert.ok(!result.passed, "Expected failure even though comment also mentions exec()");
    assert.ok(
      result.failures.length >= 1,
      `Expected failures when real exec() is present alongside comment, got: ${JSON.stringify(result.failures)}`,
    );
  });

  // ── execFile/execFileSync must NOT false-positive (they bypass the shell) ──

  it("passes when using execFile (safe, bypasses shell) as a legitimate fix", () => {
    const source = [
      'import { execFile } from "node:child_process";',
      'export function catFile(filename: string): string {',
      '  return new Promise((resolve, reject) => {',
      '    execFile("cat", [filename], (err, stdout) => {',
      '      if (err) reject(err);',
      '      else resolve(stdout);',
      '    });',
      '  });',
      '}',
    ].join("\n");
    const result = assertNoExecInFixedFile(source);
    assert.ok(result.passed, `Expected pass for safe execFile fix but got failures: ${result.failures.join("; ")}`);
  });

  it("passes when importing execFile from child_process without a call", () => {
    const source = 'import { execFile } from "child_process";\nconst x = 1;';
    const result = assertNoExecInFixedFile(source);
    assert.ok(result.passed, `Expected pass for execFile import without call but got failures: ${result.failures.join("; ")}`);
  });

  it("fails when BOTH execFile and execSync are imported (execSync remains dangerous)", () => {
    const source = [
      'import { execFile, execSync } from "node:child_process";',
      'export function catFile(filename: string): string {',
      '  return execSync(`cat ${filename}`);',
      '}',
    ].join("\n");
    const result = assertNoExecInFixedFile(source);
    assert.ok(!result.passed, "Expected failure when both execFile and execSync imported");
    assert.ok(
      result.failures.some((f) => f.includes("import")),
      `Expected import failure for execSync, got: ${JSON.stringify(result.failures)}`,
    );
  });

  it("fails when execSync is imported and called (regression guard)", () => {
    const source = [
      'import { execSync } from "child_process";',
      'export function catFile(filename: string): string {',
      '  return execSync(`cat ${filename}`);',
      '}',
    ].join("\n");
    const result = assertNoExecInFixedFile(source);
    assert.ok(!result.passed, "Expected failure for execSync import/call");
    assert.ok(result.failures.length >= 2, `Expected at least 2 failures (import + execSync call), got: ${JSON.stringify(result.failures)}`);
  });

  it("fails when exec is imported and called (regression guard)", () => {
    const source = [
      'import { exec } from "child_process";',
      'export function catFile(filename: string): string {',
      '  return exec(`cat ${filename}`);',
      '}',
    ].join("\n");
    const result = assertNoExecInFixedFile(source);
    assert.ok(!result.passed, "Expected failure for exec import/call");
    assert.ok(result.failures.length >= 2, `Expected at least 2 failures (import + exec call), got: ${JSON.stringify(result.failures)}`);
  });
});
