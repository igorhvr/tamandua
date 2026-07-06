/******************************************************************************
 * ⚠️  WARNING: SLOW, EXPENSIVE REAL E2E TEST — DO NOT RUN BY DEFAULT  ⚠️
 *
 * This test runs a REAL Tamandua do-review-do-verify workflow execution with a
 * LIVE daemon and scheduler processing steps through actual agent invocations
 * (pi/llm calls).
 *
 * COST/TIME WARNING:
 *   - SPENDS REAL API TOKENS (may cost money)
 *   - Expected runtime: ~45 minutes (single real workflow)
 *   - Requires a configured pi agent setup (model, provider, auth)
 *   - Uses significant CPU while the daemon processes steps
 *
 * WHEN TO RUN:
 *   - After major changes to the daemon, scheduler, or agent polling infra
 *   - To validate the do-review-do-verify workflow end-to-end
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
 *   - Uses random ports — no default ports (3334/3338/3339)
 *   - Daemon runs in isolated HOME/TAMANDUA_STATE_DIR
 *   - All .tamandua state (DB, events, logs, PID/port files) is in the
 *     isolated temp HOME and removed by cleanupTempHome()
 *   - after() hook guarantees cleanup on failure
 *
 * CONTRACT (context key enforcement):
 *   After the run completes, the test asserts:
 *   - runs.context contains keys consumed by downstream steps:
 *     changes, report, feedback, issues, verdict, details
 *   - No step output contains the literal string "[missing:" —
 *     if present, a context key was unresolved in a template
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
  collectRunDiagnostics,
} from "./helpers/e2e-helpers.ts";
import { reserveDistinctRandomPorts } from "../tests/helpers/test-env.ts";
import type { ChildProcess } from "node:child_process";

const fixtureDir = path.join(process.cwd(), "e2e-tests", "fixtures", "sample-project-review");

/**
 * Self-contained task for the do-review-do-verify workflow.
 *
 * The task asks the doer to write an isPalindrome function in a TypeScript
 * project (src/palindrome.ts), with tests in test/palindrome.test.ts. The
 * reviewer provides feedback, the do-again refines, and the verifier judges.
 *
 * The function returns true if the input string reads the same forwards and
 * backwards (case-insensitive, ignoring non-alphanumeric characters).
 */
const SELF_CONTAINED_TASK = `
Write an isPalindrome function to src/palindrome.ts in this TypeScript project.
The function isPalindrome(str: string): boolean returns true if the input
string reads the same forwards and backwards. The check must be:
  - Case-insensitive: "Racecar" → true
  - Ignore non-alphanumeric characters: "A man, a plan, a canal: Panama" → true
Also write tests in test/palindrome.test.ts using node:test and node:assert/strict.
Test cases should include: "racecar" → true, "hello" → false, "" → true,
"a" → true, "A man, a plan, a canal: Panama" → true, "RaCeCaR" → true.
Run \`npm test\` to verify all tests pass.
`.trim();

function runNodeModuleScript(repoDir: string, script: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoDir,
    encoding: "utf-8",
  });
}

function testCommandEnv(): NodeJS.ProcessEnv {
  return inheritedProcessEnv();
}

// ── Shared state ────────────────────────────────────────────────────────────
let env: Awaited<ReturnType<typeof createTempHome>>;
let repoDir: string;
let daemon: ChildProcess;

describe(
  "real e2e do-review-do-verify workflow (LIVE agents, daemon, scheduler)",
  {
    // Single test, sequential execution.
    concurrency: 1,
  },
  () => {
    // ── before: isolated environment setup ──────────────────────────────
    before(async () => {
      // Create isolated temp HOME (symlinks real ~/.pi for auth)
      env = await createTempHome();

      // Install the do-review-do-verify workflow
      cliMustSucceed(
        ["workflow", "install", "do-review-do-verify"],
        baseEnv(env.homeDir, env.controlPort),
        "install do-review-do-verify workflow",
      );

      // Prepare a clean git repo from the sample-project fixture
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

    // ── TEST: do-review-do-verify workflow ────────────────────────────
    it(
      "do-review-do-verify: palindrome function with review/verify pipeline",
      { timeout: 60 * 60_000 }, // 60 minutes
      async () => {
        // ── Start daemon ────────────────────────────────────────────
        daemon = await startIsolatedDaemon(
          env.dashboardPort,
          env.homeDir,
          env.controlPort,
        );

        try {
          // ── Create run ───────────────────────────────────────────
          const runIdPrefix = await spawnWorkflowRun(
            [
              "workflow",
              "run",
              "do-review-do-verify",
              SELF_CONTAINED_TASK,
              "--working-directory-for-harness",
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
            "workflow status after do-review-do-verify completion",
          );
          assert.match(statusOut, /Status:\s+completed/i);

          // ── Token accounting audit (MOTOR-CONTRACT.md C14/C15) ───
          const audit = auditRunTokens(env.tamanduaDir, runId);
          assert.ok(
            audit.workTokens > 0,
            `run should have attributed work tokens, got ${audit.workTokens}`,
          );
          assert.equal(
            audit.systemTokens,
            0,
            `systemTokens should be 0 (deterministic motor, no idle polling overhead), got ${audit.systemTokens}`,
          );
          assert.equal(
            typeof audit.terminalTokensSpent,
            "number",
            "terminal event should carry tokensSpent as a number",
          );
          console.log(
            `[real-e2e baseline] do-review-do-verify: workTokens=${audit.workTokens} ` +
              `systemTokens=${audit.systemTokens} tokenUpdateEvents=${audit.tokenUpdateEvents} ` +
              `terminalTokensSpent=${audit.terminalTokensSpent}`,
          );

          // ── Verify artifact: src/palindrome.ts exists ────────────
          const palindromePath = path.join(repoDir, "src", "palindrome.ts");
          assert.ok(
            fs.existsSync(palindromePath),
            `src/palindrome.ts should exist after workflow. Expected at: ${palindromePath}`,
          );

          const palindromeContent = fs.readFileSync(palindromePath, "utf-8");
          assert.ok(
            palindromeContent.includes("isPalindrome") || palindromeContent.includes("is_palindrome"),
            "palindrome.ts should export an isPalindrome function",
          );

          // ── Verify isPalindrome runtime behavior ────────────────
          const runtimeOutput = runNodeModuleScript(
            repoDir,
            `
              const { isPalindrome } = await import("./src/palindrome.ts");
              const cases = [
                ["racecar", true],
                ["hello", false],
                ["", true],
                ["RaCeCaR", true],
              ];
              for (const [input, expected] of cases) {
                const result = isPalindrome(input);
                if (result !== expected) {
                  throw new Error("isPalindrome(" + JSON.stringify(input) + ") expected " + expected + " but got " + result);
                }
              }
              console.log("isPalindrome runtime ok");
            `,
          );
          assert.match(runtimeOutput, /isPalindrome runtime ok/);

          // ── Verify npm test passes in fixture repo ──────────────
          // npm test runs node --test with native TS support.
          const testOutput = execSync("npm test", {
            cwd: repoDir,
            encoding: "utf-8",
            env: testCommandEnv(),
          });
          assert.ok(
            testOutput.match(/pass|OK|0 fail/),
            `npm test should pass after workflow. Output:
${testOutput.substring(0, 500)}`,
          );

          // ── CONTEXT KEY CONTRACT: runs.context ───────────────────
          // Assert run context contains keys consumed by downstream
          // steps, and no step output has unresolved templates.
          // Key flow: do → (changes, report) → review → (feedback, issues)
          // → do-again → (changes, report) → verify → (verdict, details)
          const dbPath = path.join(env.tamanduaDir, "tamandua.db");
          const db = new DatabaseSync(dbPath);
          try {
            // 1. Assert runs.context has expected keys
            const contextRows = db
              .prepare("SELECT context FROM runs WHERE id = ?")
              .all(runId) as Array<{ context: string }>;
            assert.ok(
              contextRows.length > 0,
              `Run ${runId.slice(0, 8)} not found in DB`,
            );
            const context = JSON.parse(contextRows[0].context);
            const expectedContextKeys = [
              "changes", "report", "feedback", "issues", "verdict", "details",
            ];
            const missingKeys: string[] = [];
            for (const key of expectedContextKeys) {
              if (!(key in context)) {
                missingKeys.push(key);
              }
            }
            if (missingKeys.length > 0) {
              assert.fail(
                `runs.context missing keys: [${missingKeys.join(", ")}]. ` +
                `Full context: ${JSON.stringify(context)}`,
              );
            }

            // 2. Assert no step output contains [missing:
            const stepRows = db
              .prepare(
                "SELECT step_id, output FROM steps WHERE run_id = ? AND output IS NOT NULL",
              )
              .all(runId) as Array<{ step_id: string; output: string }>;
            const unresolvedSteps: Array<{ step: string; missing: string }> = [];
            for (const step of stepRows) {
              const missingMatch = step.output.match(/\[missing:\s*([^\]]+)\]/);
              if (missingMatch) {
                unresolvedSteps.push({
                  step: step.step_id,
                  missing: missingMatch[1],
                });
              }
            }
            if (unresolvedSteps.length > 0) {
              const diagnostics = unresolvedSteps
                .map((u) => `  step "${u.step}": missing key "${u.missing}"`)
                .join("\n");
              assert.fail(
                `Found ${unresolvedSteps.length} step output(s) with unresolved template keys [missing: ...]:\n${diagnostics}\n` +
                `This means context keys were not available when step templates were rendered. ` +
                `Check the workflow definition for key enforcement gaps.`,
              );
            }
            if (stepRows.length === 0) {
              // Completed run with zero step outputs is a workflow defect.
              console.log(
                "[real-e2e] WARNING: No step outputs found for completed run. " +
                "This may indicate a workflow definition defect where steps don't produce output keys.",
              );
            }

            console.log(
              `[real-e2e] Context key contract OK: ${expectedContextKeys.length} keys present, ` +
              `${stepRows.length} step outputs checked, no [missing: found`,
            );
          } finally {
            db.close();
          }

          console.log(
            `[real-e2e] do-review-do-verify completed for run ${runId.slice(0, 8)}`,
          );
        } finally {
          // ── Stop daemon ─────────────────────────────────────────
          await stopIsolatedDaemon(daemon);
        }
      },
    );
  },
);
