/**
 * Scripted-Agent Full-Pipeline E2E Test (fast, ZERO model tokens)
 *
 * This tier closes the gap between the smoke test (manual step claim/complete,
 * scheduler bypassed) and the real e2e test (real model invocations, 30-60min,
 * real tokens):
 *
 *   REAL daemon → REAL scheduler/cron → REAL harness spawn → REAL stream
 *   parsing → REAL step-ops/pipeline advance → REAL worktrees + git merges
 *
 * ...but TAMANDUA_PI_BINARY points at a scripted agent (see
 * helpers/scripted-agent.ts) that executes the work protocol
 * deterministically. No models, no tokens, seconds per workflow.
 *
 * This is the primary regression net for changes to the "motor" — the
 * machinery that drives workflow progress (agent-scheduler, run-harness,
 * step-ops pipeline advance). See tests/MOTOR-CONTRACT.md. The motor is
 * deterministic dispatch: the scheduler peeks for work in-process and only
 * spawns a harness when a pending step exists, so these tests also assert
 * the N1/N2 acceptance criteria (zero heartbeat invocations, zero system
 * tokens).
 *
 * Runs advance at nudge speed: tests nudge the daemon control plane between
 * status polls rather than waiting out the 15s fallback dispatch interval.
 *
 * TEST ISOLATION: each test owns a temp HOME, random ports, its own daemon,
 * and its own scripted-agent state. Safe for parallel execution.
 *
 * Run via: ./run-all-scripted-e2e-tests (or ./run-all-e2e-tests)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  spawnWorkflowRun,
  prepareGitRepo,
  resolveFullRunId,
  cleanupTempHome,
} from "./helpers/smoke-helpers.ts";
import {
  startIsolatedDaemon,
  stopIsolatedDaemon,
  pollForRunCompletionWithNudge,
} from "./helpers/e2e-helpers.ts";
import {
  createScriptedAgent,
  type ScriptedAgent,
  type ScriptedAgentConfig,
} from "./helpers/scripted-agent.ts";

const fixtureDir = path.join(process.cwd(), "e2e-tests", "fixtures", "sample-project");
const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

// ── Shared plumbing ─────────────────────────────────────────────────

interface ScriptedRunContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  scripted: ScriptedAgent;
  daemon: ChildProcess;
}

async function startScriptedEnvironment(
  workflowId: string,
  behaviors: ScriptedAgentConfig,
): Promise<ScriptedRunContext> {
  const env = await createTempHome();
  const scripted = createScriptedAgent(env.root, behaviors);
  cliMustSucceed(
    ["workflow", "install", workflowId],
    baseEnv(env.homeDir, env.controlPort),
    `install ${workflowId}`,
  );
  // Release port handles so the daemon can bind to the control port.
  await Promise.all(env.portHandles.map((h) => h.close()));
  const daemon = await startIsolatedDaemon(
    env.homeDir,
    env.controlPort,
    scripted.env,
  );
  return { env, scripted, daemon };
}

async function teardown(ctx: ScriptedRunContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

/** Append scripted-agent + daemon log diagnostics to a failure. */
function diagnostics(ctx: ScriptedRunContext): string {
  let daemonLogTail = "(no daemon log)";
  try {
    const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
    const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
    daemonLogTail = lines.slice(-40).join("\n");
  } catch {
    // keep default
  }
  return [
    "── scripted-agent invocations ──",
    ctx.scripted.describe(),
    "── daemon log (last 40 lines) ──",
    daemonLogTail,
  ].join("\n");
}

async function waitForRun(
  ctx: ScriptedRunContext,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  try {
    return await pollForRunCompletionWithNudge(
      runId,
      baseEnv(ctx.env.homeDir, ctx.env.controlPort),
      timeoutMs,
    );
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${diagnostics(ctx)}`);
  }
}

function dbRow<T>(tamanduaDir: string, sql: string, ...params: string[]): T {
  const db = new DatabaseSync(path.join(tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

function dbRows<T>(tamanduaDir: string, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(path.join(tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/**
 * Poll until the run's tokens_spent reaches `expected`. Token attribution
 * for the FINAL round lands shortly after the run turns terminal (the
 * harness flushes usage after reporting, under the teardown grace window),
 * so reading tokens_spent immediately after completion would race it.
 */
async function waitForRunTokens(
  tamanduaDir: string,
  runId: string,
  expected: number,
  timeoutMs = 20_000,
): Promise<number> {
  const startedAt = Date.now();
  let last = -1;
  while (Date.now() - startedAt < timeoutMs) {
    last = dbRow<{ tokens_spent: number }>(
      tamanduaDir,
      "SELECT tokens_spent FROM runs WHERE id = ?",
      runId,
    ).tokens_spent;
    if (last >= expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

function readRunEvents(tamanduaDir: string, runId: string): Array<Record<string, unknown>> {
  const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Scripted behaviors: bug-fix-merge-worktree happy path ───────────

const BRANCH = "bugfix-scripted-add";
const WORK_TOKENS = 111; // defaultTokens; six work rounds → ≥666 attributed

const bugFixBehaviors: ScriptedAgentConfig = {
  agents: {
    triager: {
      output: [
        "STATUS: done",
        "REPO: {{cwd}}",
        `BRANCH: ${BRANCH}`,
        "SEVERITY: high",
        "AFFECTED_AREA: src/math.ts",
        "REPRODUCTION: add(5, 3) returns 2 instead of 8",
        "PROBLEM_STATEMENT: add() subtracts instead of adding",
      ].join("\n"),
    },
    investigator: {
      output: [
        "STATUS: done",
        "ROOT_CAUSE: add() uses the subtraction operator",
        "FIX_APPROACH: replace a - b with a + b in src/math.ts",
      ].join("\n"),
    },
    setup: {
      commands: [`git checkout -b ${BRANCH}`],
      output: [
        "STATUS: done",
        "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
        "BUILD_CMD: true",
        "TEST_CMD: true",
        "BASELINE: add() is broken as reported",
      ].join("\n"),
    },
    fixer: {
      edits: [{ file: "src/math.ts", find: "a - b", replace: "a + b" }],
      commands: [
        "git add -A",
        'git commit -m "fix: correct add implementation"',
      ],
      output: [
        "STATUS: done",
        "CHANGES: corrected add() to use addition",
        "REGRESSION_TEST: covered by existing math test",
      ].join("\n"),
    },
    verifier: {
      output: ["STATUS: done", "VERIFIED: add() now uses a + b", "TESTED_TREE: scripted-tree"].join("\n"),
    },
    merger: {
      commands: [
        `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "fix: correct add implementation (squash of ${BRANCH})"`,
      ],
      includeCommandOutput: true,
      output: [
        "STATUS: done",
        "REBASED: false",
        "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
      ].join("\n"),
    },
  },
};

const BUG_FIX_AGENTS = ["triager", "investigator", "setup", "fixer", "verifier", "merger"];

// ── Tests ───────────────────────────────────────────────────────────

describe("scripted-agent full pipeline (real daemon/scheduler, zero tokens)", { concurrency: 3 }, () => {
  it(
    "bug-fix-merge-worktree: full pipeline through scripted agents merges the fix",
    { timeout: 240_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        ctx = await startScriptedEnvironment("bug-fix-merge-worktree", bugFixBehaviors);
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const originalBranch = execSync("git symbolic-ref --short HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
        const originMathBefore = fs.readFileSync(path.join(repoDir, "src", "math.ts"), "utf-8");
        const originIndexBefore = execSync("git write-tree", { cwd: repoDir, encoding: "utf-8" }).trim();

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--worktree-origin-repository",
            repoDir,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 180_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete, got "${status}"\n${diagnostics(ctx)}`,
        );

        // ── Pipeline state: every step done, none failed ──────────
        const steps = dbRows<{ step_id: string; status: string }>(
          ctx.env.tamanduaDir,
          "SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index",
          runId,
        );
        assert.equal(steps.length, 6, `expected 6 steps, got ${JSON.stringify(steps)}`);
        for (const step of steps) {
          assert.equal(step.status, "done", `step ${step.step_id} should be done, got ${step.status}`);
        }

        // ── Repository outcome: the target ref landed the fix without touching origin state ──
        const targetMath = execSync(`git show "refs/heads/${originalBranch}:src/math.ts"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.ok(targetMath.includes("a + b"), `target ref math.ts should be fixed:\n${targetMath}`);
        assert.ok(!targetMath.includes("a - b"), `target ref math.ts should not keep the bug:\n${targetMath}`);
        assert.equal(
          fs.readFileSync(path.join(repoDir, "src", "math.ts"), "utf-8"),
          originMathBefore,
          "plumbing landing must not rewrite the origin working-tree file",
        );
        assert.equal(
          execSync("git write-tree", { cwd: repoDir, encoding: "utf-8" }).trim(),
          originIndexBefore,
          "plumbing landing must not rewrite the origin index",
        );

        const mergedTree = execSync(`git rev-parse "refs/heads/${originalBranch}^{tree}"`, {
          cwd: repoDir,
          encoding: "utf-8",
        }).trim();
        const mergeStep = dbRow<{ output: string }>(
          ctx.env.tamanduaDir,
          "SELECT output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
          runId,
        );
        assert.match(mergeStep.output, /^STATUS: landed$/m);
        assert.match(mergeStep.output, new RegExp(`^MERGED_TREE: ${mergedTree}$`, "m"));
        const mergeEvents = fs
          .readFileSync(path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`), "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event: string })
          .filter((event) => event.event.startsWith("merge."));
        assert.deepEqual(mergeEvents.map((event) => event.event), ["merge.landed"]);

        const gitLog = execSync("git log --oneline -5", { cwd: repoDir, encoding: "utf-8" });
        assert.ok(
          gitLog.trim().split("\n").length >= 2,
          `expected initial + squash-merge commits, got:\n${gitLog}`,
        );
        // ── Regression: no progress-* files leaked into the repo working tree ─
        const progressFiles = fs.readdirSync(repoDir).filter((f) => f.startsWith("progress-"));
        assert.equal(progressFiles.length, 0, `origin repo contains leaked progress files: ${progressFiles.join(", ")}`);

        // ── Motor contract: each agent did exactly one work round ─
        for (const agent of BUG_FIX_AGENTS) {
          const workRounds = ctx.scripted.workInvocations(agent);
          assert.equal(
            workRounds.length,
            1,
            `agent ${agent} should do exactly 1 work round, got ${workRounds.length}\n${diagnostics(ctx)}`,
          );
        }

        // ── Token accounting: work usage attributed to the run ────
        const run = dbRow<{ tokens_spent: number }>(
          ctx.env.tamanduaDir,
          "SELECT tokens_spent FROM runs WHERE id = ?",
          runId,
        );
        assert.ok(
          run.tokens_spent >= BUG_FIX_AGENTS.length * WORK_TOKENS,
          `tokens_spent should include ${BUG_FIX_AGENTS.length} work rounds ` +
            `(≥${BUG_FIX_AGENTS.length * WORK_TOKENS}), got ${run.tokens_spent}`,
        );

        // ── Terminal event carries token spend ────────────────────
        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        const completed = events.find((e) => e.event === "run.completed");
        assert.ok(completed, `run.completed event missing; events: ${events.map((e) => e.event).join(", ")}`);
        assert.equal(typeof completed.tokensSpent, "number", "run.completed should carry tokensSpent");

        // ── Deterministic-motor acceptance (MOTOR-CONTRACT.md N1/N2):
        // checking for work never invokes a model. Every harness spawn IS a
        // work round (zero heartbeat invocations) and the system-token
        // ledger — kept as a tripwire — never grows. Under the old polling
        // motor this run burned ~30 heartbeat rounds / ~500 system tokens.
        const heartbeats = ctx.scripted.heartbeats();
        const stats = dbRow<{ system_tokens_spent: number }>(
          ctx.env.tamanduaDir,
          "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1",
        );
        assert.equal(
          heartbeats.length,
          0,
          `deterministic motor must never spawn a harness without pending work (N2) — ` +
            `got ${heartbeats.length} heartbeat invocations\n${diagnostics(ctx)}`,
        );
        assert.equal(
          stats.system_tokens_spent,
          0,
          `idle dispatch must spend zero system tokens (N1) — got ${stats.system_tokens_spent}. ` +
            `Something reintroduced model-driven polling.\n${diagnostics(ctx)}`,
        );
        assert.equal(
          ctx.scripted.readInvocations().filter((inv) => inv.phase === "work").length,
          BUG_FIX_AGENTS.length,
          `harness invocations should equal executed work rounds (N2)`,
        );
        console.log(
          `[scripted-e2e baseline] bug-fix-merge-worktree: ` +
            `${ctx.scripted.workInvocations().length} work rounds, ` +
            `${heartbeats.length} heartbeat rounds, ` +
            `${run.tokens_spent} work tokens attributed to the run, ` +
            `${stats.system_tokens_spent} system tokens`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "do-now: lost step (agent finishes without STATUS report) is recovered and retried",
    { timeout: 120_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        ctx = await startScriptedEnvironment("do-now", {
          agents: {
            doer: [
              { mode: "no-status", output: "I did some things but never reported them." },
              { output: "STATUS: done\nREPORT: completed on the retry round" },
            ],
          },
        });
        const workdir = path.join(ctx.env.root, "do-now-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "do-now",
            "Report the current date",
            "--working-directory-for-harness",
            workdir,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 90_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete after lost-step recovery, got "${status}"\n${diagnostics(ctx)}`,
        );

        const workRounds = ctx.scripted.workInvocations("doer");
        assert.equal(
          workRounds.length,
          2,
          `doer should be invoked twice (lost round + recovery round), got ${workRounds.length}\n${diagnostics(ctx)}`,
        );
        assert.equal(workRounds[0].mode, "no-status");
        assert.equal(workRounds[1].mode, "work", `second round should be the normal retry: ${workRounds[1].note}`);
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "do-now: final-round token usage survives completion teardown (real-pi event ordering)",
    { timeout: 120_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        // Real pi reports `step complete` via a tool call BEFORE emitting the
        // final message_end that carries token usage. Completing the run's
        // final step triggers scheduling teardown — without the
        // HARNESS_TEARDOWN_GRACE_MS grace window, the harness is killed
        // before the usage event is flushed and the round's tokens are lost.
        ctx = await startScriptedEnvironment("do-now", {
          agents: {
            doer: {
              reportBeforeEmit: true,
              tokens: 555,
              output: "STATUS: done\nREPORT: reported completion before usage flush",
            },
          },
        });
        const workdir = path.join(ctx.env.root, "do-now-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "do-now",
            "Report the current date",
            "--working-directory-for-harness",
            workdir,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 90_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete, got "${status}"\n${diagnostics(ctx)}`,
        );

        const tokens = await waitForRunTokens(ctx.env.tamanduaDir, runId, 555);
        assert.equal(
          tokens,
          555,
          `final round's usage (555 tokens, emitted AFTER step complete) should be ` +
            `attributed to the run — got ${tokens}. If this is 0, completion teardown ` +
            `killed the harness before it flushed usage.\n${diagnostics(ctx)}`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "do-now: daemon SIGKILL'd mid-work — restarted daemon recovers the step and completes the run (C18)",
    { timeout: 120_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      let daemon2: ChildProcess | undefined;
      try {
        // Round 1 claims then hangs so we can kill the daemon with the step
        // running and a worker in flight; round 2 completes after recovery.
        ctx = await startScriptedEnvironment("do-now", {
          agents: {
            doer: [
              { mode: "hang-after-claim" },
              { output: "STATUS: done\nREPORT: completed after the daemon was killed" },
            ],
          },
        });
        const workdir = path.join(ctx.env.root, "do-now-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        const runIdPrefix = await spawnWorkflowRun(
          ["workflow", "run", "do-now", "Report the current date", "--working-directory-for-harness", workdir],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        // Wait until the step is claimed (running) by the hanging worker.
        const claimDeadline = Date.now() + 30_000;
        for (;;) {
          const step = dbRow<{ status: string } | undefined>(
            ctx.env.tamanduaDir,
            "SELECT status FROM steps WHERE run_id = ?",
            runId,
          );
          if (step?.status === "running") break;
          if (Date.now() > claimDeadline) {
            throw new Error(`step never reached running before daemon kill\n${diagnostics(ctx)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        // Hard-kill the daemon: no shutdown handler runs, no children are
        // cleaned up — exactly a crash/reboot. Then kill the orphaned
        // hanging worker ourselves so the test doesn't leak it (its
        // claim_pid — the dead daemon — is what recovery keys on).
        ctx.daemon.kill("SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 500));
        for (const inv of ctx.scripted.readInvocations()) {
          if (typeof inv.pid === "number") {
            try { process.kill(inv.pid, "SIGKILL"); } catch { /* already gone */ }
          }
        }

        // Fresh daemon, same state: its reconciler's dead-worker sweep
        // must requeue the step within seconds — NOT the 45-minute
        // age-based threshold — and the run must complete.
        // Port handles were already closed before the first daemon spawn
        // (startScriptedEnvironment). The killed daemon already released
        // its port bindings, so daemon2 can bind directly.
        daemon2 = await startIsolatedDaemon(
          ctx.env.homeDir,
          ctx.env.controlPort,
          ctx.scripted.env,
        );

        const status = await waitForRun(ctx, runId, 60_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete after daemon crash recovery, got "${status}"\n${diagnostics(ctx)}`,
        );

        const workRounds = ctx.scripted.workInvocations("doer");
        assert.equal(
          workRounds.length,
          2,
          `doer should run twice (killed round + recovery round), got ${workRounds.length}\n${diagnostics(ctx)}`,
        );
      } finally {
        if (daemon2) {
          try {
            await stopIsolatedDaemon(daemon2);
          } catch {
            // best-effort
          }
        }
        await teardown(ctx);
      }
    },
  );

  it(
    "bug-fix-merge-worktree: verifier exhaustion triggers reroute to fixer via retry_step",
    { timeout: 240_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        const REROUTE_BRANCH = "bugfix-scripted-reroute";
        const rerouteBehaviors: ScriptedAgentConfig = {
          agents: {
            triager: {
              output: [
                "STATUS: done",
                "REPO: {{cwd}}",
                `BRANCH: ${REROUTE_BRANCH}`,
                "SEVERITY: high",
                "AFFECTED_AREA: src/math.ts",
                "REPRODUCTION: add(5, 3) returns 2 instead of 8",
                "PROBLEM_STATEMENT: add() subtracts instead of adding",
              ].join("\n"),
            },
            investigator: {
              output: [
                "STATUS: done",
                "ROOT_CAUSE: add() uses the subtraction operator",
                "FIX_APPROACH: replace a - b with a + b in src/math.ts",
              ].join("\n"),
            },
            setup: {
              commands: [`git checkout -b ${REROUTE_BRANCH}`],
              output: [
                "STATUS: done",
                "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
                "BUILD_CMD: true",
                "TEST_CMD: true",
                "BASELINE: add() is broken as reported",
              ].join("\n"),
            },
            // Fixer: two behaviors — first produces a flawed fix, second (after reroute) fixes it
            fixer: [
              {
                edits: [{ file: "src/math.ts", find: "a - b", replace: "a - b + 0" }],
                commands: [
                  "git add -A",
                  'git commit -m "fix: attempt to correct add (flawed)"',
                ],
                output: [
                  "STATUS: done",
                  "CHANGES: replaced subtraction with addition-adjacent expression",
                  "REGRESSION_TEST: covered by existing math test",
                ].join("\n"),
              },
              {
                edits: [{ file: "src/math.ts", find: "a - b + 0", replace: "a + b" }],
                commands: [
                  "git add -A",
                  'git commit -m "fix: correct add implementation"',
                ],
                output: [
                  "STATUS: done",
                  "CHANGES: corrected add() to use addition",
                  "REGRESSION_TEST: covered by existing math test",
                ].join("\n"),
              },
            ],
            // Verifier: fails 5 times (exhausting max_retries=4) then succeeds after reroute
            verifier: [
              { stepAction: "fail", failReason: "Fix does not address root cause — expression still involves subtraction" },
              { stepAction: "fail", failReason: "Regression test does not properly validate the fix logic" },
              { stepAction: "fail", failReason: "Code quality issues — unnecessary complexity in the expression" },
              { stepAction: "fail", failReason: "Side effects not addressed — edge cases still broken" },
              { stepAction: "fail", failReason: "Fix is semantically wrong — produces incorrect results" },
              { output: ["STATUS: done", "VERIFIED: add() now uses a + b, regression test passes", "TESTED_TREE: scripted-tree-reroute"].join("\n") },
            ],
            merger: {
              commands: [
                `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${REROUTE_BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "fix: correct add implementation (squash of ${REROUTE_BRANCH})"`,
              ],
              includeCommandOutput: true,
              output: [
                "STATUS: done",
                "REBASED: false",
                "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
              ].join("\n"),
            },
          },
        };

        ctx = await startScriptedEnvironment("bug-fix-merge-worktree", rerouteBehaviors);
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const originalBranch = execSync("git symbolic-ref --short HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
        const originMathBefore = fs.readFileSync(path.join(repoDir, "src", "math.ts"), "utf-8");
        const originIndexBefore = execSync("git write-tree", { cwd: repoDir, encoding: "utf-8" }).trim();

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--worktree-origin-repository",
            repoDir,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 200_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete after reroute, got "${status}"\n${diagnostics(ctx)}`,
        );

        // ── Pipeline state: every step done, none failed ──
        const steps = dbRows<{ step_id: string; status: string; reroute_count: number | null }>(
          ctx.env.tamanduaDir,
          "SELECT step_id, status, reroute_count FROM steps WHERE run_id = ? ORDER BY step_index",
          runId,
        );
        assert.equal(steps.length, 6, `expected 6 steps, got ${JSON.stringify(steps)}`);
        for (const step of steps) {
          assert.equal(
            step.status,
            "done",
            `step ${step.step_id} should be done, got ${step.status}\n${diagnostics(ctx)}`,
          );
        }

        // ── step.rerouted event exists with expected fields ──
        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        const reroutedEvent = events.find((e) => e.event === "step.rerouted");
        assert.ok(
          reroutedEvent,
          `step.rerouted event missing; events: ${events.map((e) => e.event).join(", ")}`,
        );
        assert.equal(
          reroutedEvent.stepId,
          "verify",
          `rerouted event should reference verify step, got ${reroutedEvent.stepId}`,
        );
        assert.ok(
          typeof reroutedEvent.detail === "string" && reroutedEvent.detail.includes("fix"),
          `rerouted event detail should mention target step "fix": ${reroutedEvent.detail}`,
        );

        // ── Run completed event exists ──
        const completed = events.find((e) => e.event === "run.completed");
        assert.ok(completed, "run.completed event missing");

        // ── DB: verifier has reroute_count = 1 ──
        const verifyStep = steps.find((s) => s.step_id === "verify");
        assert.equal(
          verifyStep?.reroute_count,
          1,
          `verify reroute_count should be 1, got ${verifyStep?.reroute_count}`,
        );

        // ── Work round counts ──
        // triager(1) + investigator(1) + setup(1) + fixer(2) + verifier(6) + merger(1) = 12
        const fixerRounds = ctx.scripted.workInvocations("fixer");
        const verifierRounds = ctx.scripted.workInvocations("verifier");
        assert.equal(
          fixerRounds.length,
          2,
          `fixer should have 2 work rounds (initial + reroute), got ${fixerRounds.length}`,
        );
        assert.equal(
          verifierRounds.length,
          6,
          `verifier should have 6 work rounds (5 fails + 1 success), got ${verifierRounds.length}`,
        );

        const totalWorkRounds = ctx.scripted.workInvocations().length;
        assert.equal(
          totalWorkRounds,
          12,
          `expected 12 total work rounds, got ${totalWorkRounds}\n${diagnostics(ctx)}`,
        );

        // ── No heartbeats (deterministic motor, N2) ──
        const heartbeats = ctx.scripted.heartbeats();
        assert.equal(
          heartbeats.length,
          0,
          `expected 0 heartbeats, got ${heartbeats.length}\n${diagnostics(ctx)}`,
        );

        // ── Repository outcome: the corrected fix landed without origin state mutation ──
        const targetMath = execSync(`git show "refs/heads/${originalBranch}:src/math.ts"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.ok(targetMath.includes("a + b"), `target ref math.ts should use addition:\n${targetMath}`);
        assert.equal(fs.readFileSync(path.join(repoDir, "src", "math.ts"), "utf-8"), originMathBefore);
        assert.equal(execSync("git write-tree", { cwd: repoDir, encoding: "utf-8" }).trim(), originIndexBefore);
        const mergedTree = execSync(`git rev-parse "refs/heads/${originalBranch}^{tree}"`, {
          cwd: repoDir,
          encoding: "utf-8",
        }).trim();
        const mergeStep = dbRow<{ output: string }>(
          ctx.env.tamanduaDir,
          "SELECT output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
          runId,
        );
        assert.match(mergeStep.output, /^STATUS: landed$/m);
        assert.match(mergeStep.output, new RegExp(`^MERGED_TREE: ${mergedTree}$`, "m"));
        const mergeEvents = fs
          .readFileSync(path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`), "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event: string })
          .filter((event) => event.event.startsWith("merge."));
        assert.deepEqual(mergeEvents.map((event) => event.event), ["merge.landed"]);

        console.log(
          `[scripted-e2e reroute] verifier exhaustion → reroute to fixer: ` +
            `${totalWorkRounds} work rounds, ${verifierRounds.length} verifier invocations (5 fails + 1 success), ` +
            `${fixerRounds.length} fixer invocations (initial + reroute), ` +
            `${heartbeats.length} heartbeats`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "do-now: agent process dying after claim is recovered and retried",
    { timeout: 120_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        ctx = await startScriptedEnvironment("do-now", {
          agents: {
            doer: [
              { mode: "die-after-claim", exitCode: 7 },
              { output: "STATUS: done\nREPORT: completed after the crash" },
            ],
          },
        });
        const workdir = path.join(ctx.env.root, "do-now-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "do-now",
            "Report the current date",
            "--working-directory-for-harness",
            workdir,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 90_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete after crash recovery, got "${status}"\n${diagnostics(ctx)}`,
        );

        const workRounds = ctx.scripted.workInvocations("doer");
        assert.equal(
          workRounds.length,
          2,
          `doer should be invoked twice (crashed round + recovery round), got ${workRounds.length}\n${diagnostics(ctx)}`,
        );
        assert.equal(workRounds[0].mode, "die-after-claim");
        assert.equal(workRounds[1].mode, "work", `second round should be the normal retry: ${workRounds[1].note}`);
      } finally {
        await teardown(ctx);
      }
    },
  );

  // ── feature-dev-merge-worktree: non-default branch via --worktree-origin-ref ──

  const OREF_BRANCH = "feature/scripted-oref-test";
  const OREF_MERGE_TARGET = "alt-branch";

  const OREF_WORK_TOKENS = 111;
  const FEATURE_DEV_AGENTS = ["planner", "setup", "developer", "verifier", "tester", "merger"];

  const featureDevOrefBehaviors: ScriptedAgentConfig = {
    agents: {
      planner: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          `BRANCH: ${OREF_BRANCH}`,
          `STORIES_JSON: [{"id":"US-001","title":"OREF non-default branch merge test","description":"Add a test marker file to verify the merge lands on the correct branch when --worktree-origin-ref targets a non-default branch","acceptanceCriteria":["Test marker file exists","Build passes","Typecheck passes"]}]`,
        ].join("\n"),
      },
      setup: {
        commands: [`git checkout -b ${OREF_BRANCH}`],
        output: [
          "STATUS: done",
          "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
          "BUILD_CMD: npm run build",
          "TEST_CMD: npm test",
          "BASELINE: fixture project ready",
        ].join("\n"),
      },
      developer: {
        writes: [{ file: "src/oref-marker.ts", content: "// OREF non-default branch merge test marker\n" }],
        commands: [
          "git add -A",
          `git commit -m "feat: US-001 - OREF non-default branch merge test marker"`,
        ],
        output: [
          "STATUS: done",
          "CHANGES: Added src/oref-marker.ts test marker file",
          "TESTS: Verified build passes",
        ].join("\n"),
      },
      verifier: {
        output: ["STATUS: done", "VERIFIED: src/oref-marker.ts exists, build passes"].join("\n"),
      },
      tester: {
        output: [
          "STATUS: done",
          "RESULTS: Full test suite passes, oref-marker.ts verified",
          "TESTED_TREE: scripted-oref-tree",
        ].join("\n"),
      },
      merger: {
        commands: [
          `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${OREF_BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "feat: OREF non-default branch merge test (squash of ${OREF_BRANCH})"`,
        ],
        includeCommandOutput: true,
        output: [
          "STATUS: done",
          "REBASED: false",
          "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
        ].join("\n"),
      },
    },
  };

  it(
    "feature-dev-merge-worktree: --worktree-origin-ref targets non-default branch — merge lands on that branch, not the checkout (OREF)",
    { timeout: 240_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        ctx = await startScriptedEnvironment("feature-dev-merge-worktree", featureDevOrefBehaviors);
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const originalBranch = execSync("git symbolic-ref --short HEAD", {
          cwd: repoDir,
          encoding: "utf-8",
        }).trim();

        // Create alt-branch at the same commit, add a marker, then switch back to the original branch.
        // The original branch is checked out in the origin repo — if the OREF fix works, the merger
        // will target alt-branch (not the original branch) because --worktree-origin-ref overrides
        // the checked-out branch.
        execSync(`git checkout -b ${OREF_MERGE_TARGET}`, { cwd: repoDir });
        execSync(`git commit --allow-empty -m "marker: alt-branch exists"`, { cwd: repoDir });
        execSync(`git checkout ${originalBranch}`, { cwd: repoDir });

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "feature-dev-merge-worktree",
            "Test OREF non-default branch merge target",
            "--worktree-origin-repository",
            repoDir,
            "--worktree-origin-ref",
            OREF_MERGE_TARGET,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 180_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete, got "${status}"\n${diagnostics(ctx)}`,
        );

        // ── Pipeline state: every step done, none failed ──
        const steps = dbRows<{ step_id: string; status: string }>(
          ctx.env.tamanduaDir,
          "SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index",
          runId,
        );
        assert.equal(
          steps.length,
          6,
          `expected 6 steps (plan, setup, implement, verify, test, finalize_merge), got ${JSON.stringify(steps)}`,
        );
        for (const step of steps) {
          assert.equal(
            step.status,
            "done",
            `step ${step.step_id} should be done, got ${step.status}\n${diagnostics(ctx)}`,
          );
        }

        // ── Repository outcome: merge landed on alt-branch, NOT the original branch ──
        // alt-branch should have the oref-marker.ts from the squash merge
        execSync(`git checkout ${OREF_MERGE_TARGET}`, { cwd: repoDir });
        const altMarker = fs.readFileSync(path.join(repoDir, "src", "oref-marker.ts"), "utf-8");
        assert.ok(
          altMarker.includes("OREF non-default branch merge test marker"),
          `alt-branch should contain oref-marker.ts from the merge:\n${altMarker}`,
        );

        // alt-branch git log should show: marker commit + squash merge (= 2 commits past initial)
        const altLog = execSync("git log --oneline", { cwd: repoDir, encoding: "utf-8" }).trim();
        const altLogLines = altLog.split("\n");
        assert.ok(
          altLogLines.length >= 3,
          `alt-branch should have at least 3 commits (initial + marker + squash), got ${altLogLines.length}:\n${altLog}`,
        );
        assert.ok(
          altLogLines.some((l) => l.includes("OREF non-default branch merge test")),
          `alt-branch log should contain the squash merge commit:\n${altLog}`,
        );

        // The original branch should NOT have oref-marker.ts
        execSync(`git checkout ${originalBranch}`, { cwd: repoDir });
        assert.ok(
          !fs.existsSync(path.join(repoDir, "src", "oref-marker.ts")),
          `${originalBranch} should NOT contain oref-marker.ts — merge should have landed on alt-branch, not ${originalBranch}`,
        );

        // The original branch should have only the initial commit (no squash merge)
        const originalBranchLog = execSync("git log --oneline", { cwd: repoDir, encoding: "utf-8" }).trim();
        const originalBranchLogLines = originalBranchLog.split("\n");
        assert.equal(
          originalBranchLogLines.length,
          1,
          `${originalBranch} should have exactly 1 commit (initial), got ${originalBranchLogLines.length}:\n${originalBranchLog}`,
        );

        // ── Origin repo not left dirty ──
        const porcelain = execSync("git status --porcelain", { cwd: repoDir, encoding: "utf-8" });
        assert.equal(porcelain.trim(), "", `origin repo left dirty:\n${porcelain}`);

        // ── No progress-* files leaked into the origin repo ──
        const progressFiles = fs.readdirSync(repoDir).filter((f) => f.startsWith("progress-"));
        assert.equal(
          progressFiles.length,
          0,
          `origin repo contains leaked progress files: ${progressFiles.join(", ")}`,
        );

        // ── Motor contract: each agent did exactly one work round ──
        for (const agent of FEATURE_DEV_AGENTS) {
          const workRounds = ctx.scripted.workInvocations(agent);
          assert.equal(
            workRounds.length,
            1,
            `agent ${agent} should do exactly 1 work round, got ${workRounds.length}\n${diagnostics(ctx)}`,
          );
        }

        // ── Token accounting: work usage attributed to the run ──
        const run = dbRow<{ tokens_spent: number }>(
          ctx.env.tamanduaDir,
          "SELECT tokens_spent FROM runs WHERE id = ?",
          runId,
        );
        assert.ok(
          run.tokens_spent >= FEATURE_DEV_AGENTS.length * OREF_WORK_TOKENS,
          `tokens_spent should include ${FEATURE_DEV_AGENTS.length} work rounds ` +
            `(≥${FEATURE_DEV_AGENTS.length * OREF_WORK_TOKENS}), got ${run.tokens_spent}`,
        );

        // ── Terminal event carries token spend ──
        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        const completed = events.find((e) => e.event === "run.completed");
        assert.ok(completed, `run.completed event missing; events: ${events.map((e) => e.event).join(", ")}`);
        assert.equal(typeof completed.tokensSpent, "number", "run.completed should carry tokensSpent");

        // ── Deterministic motor: zero heartbeats, zero system tokens ──
        const heartbeats = ctx.scripted.heartbeats();
        const stats = dbRow<{ system_tokens_spent: number }>(
          ctx.env.tamanduaDir,
          "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1",
        );
        assert.equal(
          heartbeats.length,
          0,
          `deterministic motor must never spawn a harness without pending work (N2) — ` +
            `got ${heartbeats.length} heartbeat invocations\n${diagnostics(ctx)}`,
        );
        assert.equal(
          stats.system_tokens_spent,
          0,
          `idle dispatch must spend zero system tokens (N1) — got ${stats.system_tokens_spent}\n${diagnostics(ctx)}`,
        );
        assert.equal(
          ctx.scripted.readInvocations().filter((inv) => inv.phase === "work").length,
          FEATURE_DEV_AGENTS.length,
          `harness invocations should equal executed work rounds (N2)`,
        );

        console.log(
          `[scripted-e2e OREF] feature-dev-merge-worktree with --worktree-origin-ref ${OREF_MERGE_TARGET}: ` +
            `${ctx.scripted.workInvocations().length} work rounds, ` +
            `${heartbeats.length} heartbeat rounds, ` +
            `${run.tokens_spent} work tokens, ` +
            `${stats.system_tokens_spent} system tokens`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );
});
