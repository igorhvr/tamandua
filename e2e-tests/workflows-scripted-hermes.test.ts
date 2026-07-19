/**
 * Scripted-Hermes Full-Pipeline E2E Test (fast, ZERO model tokens)
 *
 * This tier drives the FULL daemon → scheduler → hermes harness → stream
 * parsing → step-ops → pipeline advance path with zero model tokens and
 * zero token spend. It mirrors the pi scripted suite
 * (workflows-scripted.test.ts) but uses a scripted hermes binary instead
 * of a scripted pi binary.
 *
 * TAMANDUA_HERMES_BINARY is pointed at a scripted hermes (see
 * helpers/scripted-hermes.ts) that executes the real work protocol
 * deterministically, emitting plain-text hermes output with a session_id
 * trailer and writing a fake state.db for token attribution.
 *
 * Runs advance at nudge speed via the daemon control plane.
 *
 * TEST ISOLATION: each test owns a temp HOME, random ports, its own daemon,
 * and its own scripted-hermes state. Safe for parallel execution.
 *
 * Run via: ./run-all-scripted-e2e-tests (or ./run-all-e2e-tests)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  spawnWorkflowRun,
  prepareGitRepo,
  detachOriginCheckout,
  resolveFullRunId,
  cleanupTempHome,
  releasePortReservations,
} from "./helpers/smoke-helpers.ts";
import {
  startIsolatedDaemon,
  stopIsolatedDaemon,
  pollForRunCompletionWithNudge,
} from "./helpers/e2e-helpers.ts";
import {
  createScriptedHermes,
} from "./helpers/scripted-hermes.ts";
import type {
  ScriptedAgent,
  ScriptedAgentConfig,
} from "./helpers/scripted-agent.ts";

const fixtureDir = path.join(process.cwd(), "e2e-tests", "fixtures", "sample-project");
const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

// ── Shared plumbing ─────────────────────────────────────────────────

interface ScriptedHermesRunContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  scripted: ScriptedAgent;
  daemon: ChildProcess;
}

async function startHermesScriptedEnvironment(
  workflowId: string,
  behaviors: ScriptedAgentConfig,
): Promise<ScriptedHermesRunContext> {
  const env = await createTempHome();
  const scripted = createScriptedHermes(env.root, behaviors);
  cliMustSucceed(
    ["workflow", "install", workflowId],
    baseEnv(env.homeDir, env.controlPort),
    `install ${workflowId}`,
  );
  await releasePortReservations(env);
  const daemon = await startIsolatedDaemon(
    env.homeDir,
    env.controlPort,
    scripted.env,
  );
  return { env, scripted, daemon };
}

/**
 * Like startHermesScriptedEnvironment but with a modified env for the daemon.
 * Used when the daemon needs different env vars than the default scripted.env
 * (e.g., scenario d with a read-only HERMES_HOME).
 */
async function startHermesScriptedEnvironmentWithEnv(
  workflowId: string,
  behaviors: ScriptedAgentConfig,
  daemonExtraEnv: Record<string, string>,
): Promise<ScriptedHermesRunContext> {
  const env = await createTempHome();
  const scripted = createScriptedHermes(env.root, behaviors);
  cliMustSucceed(
    ["workflow", "install", workflowId],
    baseEnv(env.homeDir, env.controlPort),
    `install ${workflowId}`,
  );
  await releasePortReservations(env);
  const daemon = await startIsolatedDaemon(
    env.homeDir,
    env.controlPort,
    daemonExtraEnv,
  );
  return { env, scripted, daemon };
}

async function teardown(ctx: ScriptedHermesRunContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

/** Append scripted-hermes + daemon log diagnostics to a failure. */
function diagnostics(ctx: ScriptedHermesRunContext): string {
  let daemonLogTail = "(no daemon log)";
  try {
    const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
    const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
    daemonLogTail = lines.slice(-40).join("\n");
  } catch {
    // keep default
  }
  return [
    "── scripted-hermes invocations ──",
    ctx.scripted.describe(),
    "── daemon log (last 40 lines) ──",
    daemonLogTail,
  ].join("\n");
}

async function waitForRun(
  ctx: ScriptedHermesRunContext,
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
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

function dbRows<T>(tamanduaDir: string, sql: string, ...params: string[]): T[] {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/**
 * Wait for the run's tokens_spent to reach `expected`. The hermes token
 * pipeline runs after the round completes (lookupHermesSessionTokens →
 * attributeWorkRoundTokenUsage), and there's a retry loop of up to ~2 s
 * in case of WAL writer lag. So tokens may land slightly after terminal
 * status.
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
      output: ["STATUS: done", "VERIFIED: add() now uses a + b", "TESTED_TREE: scripted-hermes-tree"].join("\n"),
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

describe("scripted-hermes full pipeline (real daemon/scheduler, zero tokens)", { concurrency: 3 }, () => {
  // ── Scenario a: full multi-agent pipeline through bug-fix-merge-worktree ──
  it(
    "bug-fix-merge-worktree: full pipeline through scripted hermes agents merges the fix",
    { timeout: 240_000 },
    async () => {
      let ctx: ScriptedHermesRunContext | undefined;
      try {
        ctx = await startHermesScriptedEnvironment("bug-fix-merge-worktree", bugFixBehaviors);
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch, tip: originTip, tree: originTree } = detachOriginCheckout(repoDir);

        // Pass --hermes-as-harness AND the hermes env (so validateRunHarnessForScheduling
        // can find the fake hermes binary).
        const runEnv = { ...baseEnv(ctx.env.homeDir, ctx.env.controlPort), ...ctx.scripted.env };
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--hermes-as-harness",
            "--worktree-origin-repository",
            repoDir,
            "--worktree-origin-ref",
            originalBranch,
          ],
          runEnv,
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

        // ── Repository outcome: the target ref landed the fix; the detached origin remains unchanged ──
        const targetMath = execSync(`git show "refs/heads/${originalBranch}:src/math.ts"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.ok(targetMath.includes("a + b"), `target ref math.ts should be fixed:\n${targetMath}`);
        assert.ok(!targetMath.includes("a - b"), `target ref math.ts should not keep the bug:\n${targetMath}`);
        // Origin HEAD is detached; working tree and index are unchanged
        assert.notEqual(
          spawnSync("git", ["symbolic-ref", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).status,
          0,
          "HEAD should be detached (symbolic-ref should fail)",
        );
        assert.equal(
          execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim(),
          originTip,
          "origin detached HEAD should remain at the pre-run tip",
        );
        assert.equal(
          execSync("git write-tree", { cwd: repoDir, encoding: "utf-8" }).trim(),
          originTree,
          "origin index should match the pre-run tip tree (unchanged)",
        );
        assert.equal(
          execSync("git status --porcelain", { cwd: repoDir, encoding: "utf-8" }),
          "",
          "origin checkout should be clean (unchanged)",
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
        assert.match(mergeStep.output, /^CHECKOUT_REFRESH: not-applicable$/m);
        const mergeEvents = fs
          .readFileSync(path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`), "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event: string; checkoutRefresh?: string })
          .filter((event) => event.event.startsWith("merge."));
        assert.deepEqual(mergeEvents.map((event) => event.event), ["merge.landed"]);
        assert.equal(mergeEvents[0]?.checkoutRefresh, "not-applicable");

        const targetLog = execSync(`git log --oneline -5 "refs/heads/${originalBranch}"`, { cwd: repoDir, encoding: "utf-8" });
        assert.ok(
          targetLog.trim().split("\n").length >= 2,
          `expected initial + squash-merge commits on target ref, got:\n${targetLog}`,
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
            `agent ${agent} should do exactly 1 work round through hermes, got ${workRounds.length}\n${diagnostics(ctx)}`,
          );
        }

        // ── Token accounting: work usage attributed to the run ────
        const tokens = await waitForRunTokens(ctx.env.tamanduaDir, runId, BUG_FIX_AGENTS.length * WORK_TOKENS);
        assert.ok(
          tokens >= BUG_FIX_AGENTS.length * WORK_TOKENS,
          `tokens_spent should include ${BUG_FIX_AGENTS.length} hermes work rounds ` +
            `(≥${BUG_FIX_AGENTS.length * WORK_TOKENS}), got ${tokens}`,
        );

        // ── Terminal event carries token spend ────────────────────
        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        const completed = events.find((e) => e.event === "run.completed");
        assert.ok(completed, `run.completed event missing; events: ${events.map((e) => e.event).join(", ")}`);
        assert.equal(typeof completed.tokensSpent, "number", "run.completed should carry tokensSpent");

        // ── Deterministic-motor acceptance (MOTOR-CONTRACT.md N1/N2):
        // checking for work never invokes a model. Every harness spawn IS a
        // work round (zero heartbeat invocations) and the system-token
        // ledger never grows.
        const heartbeats = ctx.scripted.heartbeats();
        const stats = dbRow<{ system_tokens_spent: number }>(
          ctx.env.tamanduaDir,
          "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1",
        );
        assert.equal(
          heartbeats.length,
          0,
          `hermes deterministic motor must never spawn a harness without pending work (N2) — ` +
            `got ${heartbeats.length} heartbeat invocations\n${diagnostics(ctx)}`,
        );
        assert.equal(
          stats.system_tokens_spent,
          0,
          `hermes idle dispatch must spend zero system tokens (N1) — got ${stats.system_tokens_spent}. ` +
            `Something reintroduced model-driven polling.\n${diagnostics(ctx)}`,
        );
        assert.equal(
          ctx.scripted.readInvocations().filter((inv) => inv.phase === "work").length,
          BUG_FIX_AGENTS.length,
          `hermes harness invocations should equal executed work rounds (N2)`,
        );

        // ── Verify hermes state.db exists and has session rows ────
        const stateDbPath = path.join(ctx.scripted.env.HERMES_HOME, "state.db");
        assert.ok(fs.existsSync(stateDbPath), `hermes state.db should exist at ${stateDbPath}`);
        const hermesDb = openE2eDatabase(stateDbPath, { readOnly: true });
        try {
          const sessionCount = (hermesDb.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number }).cnt;
          assert.equal(
            sessionCount,
            BUG_FIX_AGENTS.length,
            `hermes state.db should have ${BUG_FIX_AGENTS.length} session rows, got ${sessionCount}`,
          );
        } finally {
          hermesDb.close();
        }

        console.log(
          `[scripted-hermes-e2e baseline] bug-fix-merge-worktree: ` +
            `${ctx.scripted.workInvocations().length} work rounds, ` +
            `${heartbeats.length} heartbeat rounds, ` +
            `${tokens} work tokens attributed to the run, ` +
            `${stats.system_tokens_spent} system tokens`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  // ── Scenario b: no-status chaos mode — lost step recovered and retried ──
  it(
    "do-now: lost step (hermes agent finishes without STATUS report) is recovered and retried",
    { timeout: 120_000 },
    async () => {
      let ctx: ScriptedHermesRunContext | undefined;
      try {
        ctx = await startHermesScriptedEnvironment("do-now", {
          agents: {
            doer: [
              { mode: "no-status", output: "I did some things but never reported them." },
              { output: "STATUS: done\nREPORT: completed on the retry round" },
            ],
          },
        });
        const workdir = path.join(ctx.env.root, "do-now-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        const runEnv = { ...baseEnv(ctx.env.homeDir, ctx.env.controlPort), ...ctx.scripted.env };
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "do-now",
            "Report the current date",
            "--hermes-as-harness",
            "--working-directory-for-harness",
            workdir,
          ],
          runEnv,
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
          `doer should be invoked twice through hermes (lost round + recovery round), got ${workRounds.length}\n${diagnostics(ctx)}`,
        );
        assert.equal(workRounds[0].mode, "no-status");
        assert.equal(workRounds[1].mode, "work", `second round should be the normal retry: ${workRounds[1].note}`);
      } finally {
        await teardown(ctx);
      }
    },
  );

  // ── Scenario c: die-after-claim chaos mode — crashed agent recovered ──
  it(
    "do-now: hermes agent process dying after claim is recovered and retried",
    { timeout: 120_000 },
    async () => {
      let ctx: ScriptedHermesRunContext | undefined;
      try {
        ctx = await startHermesScriptedEnvironment("do-now", {
          agents: {
            doer: [
              { mode: "die-after-claim", exitCode: 7 },
              { output: "STATUS: done\nREPORT: completed after the crash" },
            ],
          },
        });
        const workdir = path.join(ctx.env.root, "do-now-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        const runEnv = { ...baseEnv(ctx.env.homeDir, ctx.env.controlPort), ...ctx.scripted.env };
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "do-now",
            "Report the current date",
            "--hermes-as-harness",
            "--working-directory-for-harness",
            workdir,
          ],
          runEnv,
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
          `doer should be invoked twice through hermes (crashed round + recovery round), got ${workRounds.length}\n${diagnostics(ctx)}`,
        );
        assert.equal(workRounds[0].mode, "die-after-claim");
        assert.equal(workRounds[1].mode, "work", `second round should be the normal retry: ${workRounds[1].note}`);
      } finally {
        await teardown(ctx);
      }
    },
  );

  // ── Scenario d: token degradation — HERMES_HOME with no state.db ──
  it(
    "do-now: token degradation (empty HERMES_HOME with no state.db) — run completes, tokens_spent = 0, no crash",
    { timeout: 120_000 },
    async () => {
      let ctx: ScriptedHermesRunContext | undefined;
      try {
        // Create the scripted hermes normally (this creates HERMES_HOME dir
        // as part of createScriptedHermes) but we override HERMES_HOME when
        // passing env to the DAEMON.
        const env = await createTempHome();
        const behaviors: ScriptedAgentConfig = {
          agents: {
            doer: { output: "STATUS: done\nREPORT: completed with degraded token lookup" },
          },
        };
        const scripted = createScriptedHermes(env.root, behaviors);

        // Create a separate empty HERMES_HOME that has no state.db and
        // will stay empty (the hermes runtime will try to write state.db
        // here, which is fine — we just need the token LOOKUP to fail).
        // To make the lookup fail consistently, we create a read-only
        // directory so the runtime can't create state.db either.
        const brokenHermesHome = path.join(env.root, "broken-hermes-home");
        fs.mkdirSync(brokenHermesHome, { recursive: true });
        // Make it read-only: mkdir + chmod 0o555
        fs.chmodSync(brokenHermesHome, 0o555);

        // Build daemon env with the broken HERMES_HOME
        const daemonEnv = {
          ...scripted.env,
          HERMES_HOME: brokenHermesHome,
        };

        cliMustSucceed(
          ["workflow", "install", "do-now"],
          baseEnv(env.homeDir, env.controlPort),
          "install do-now",
        );
        await releasePortReservations(env);
        const daemon = await startIsolatedDaemon(
          env.homeDir,
          env.controlPort,
          daemonEnv,
        );
        ctx = { env, scripted, daemon };

        const workdir = path.join(env.root, "do-now-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        const runEnv = { ...baseEnv(env.homeDir, env.controlPort), ...scripted.env };
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "do-now",
            "Report the current date",
            "--hermes-as-harness",
            "--working-directory-for-harness",
            workdir,
          ],
          runEnv,
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 90_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete normally even with degraded token lookup, got "${status}"\n${diagnostics(ctx)}`,
        );

        // ── Token accounting: tokens_spent should STAY 0 ──────────
        const tokens = await waitForRunTokens(env.tamanduaDir, runId, 0);
        assert.equal(
          tokens,
          0,
          `tokens_spent should stay 0 when HERMES_HOME has no state.db (degraded), got ${tokens}\n${diagnostics(ctx)}`,
        );

        // ── Run still completes normally ──────────────────────────
        const steps = dbRows<{ step_id: string; status: string }>(
          env.tamanduaDir,
          "SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index",
          runId,
        );
        assert.equal(steps.length, 1, "do-now should have exactly 1 step");
        assert.equal(steps[0].status, "done", "step should complete normally");

        // ── Restore writability so teardown can clean up ──────────
        fs.chmodSync(brokenHermesHome, 0o755);

        console.log(
          `[scripted-hermes-e2e degradation] do-now with broken HERMES_HOME: ` +
            `run completed, tokens_spent=${tokens} (degraded gracefully)`,
        );
      } finally {
        // Restore writability before cleanup in case the test failed mid-way
        try {
          const brokenHermesHome = path.join(ctx?.env.root ?? "/tmp", "broken-hermes-home");
          if (fs.existsSync(brokenHermesHome)) {
            fs.chmodSync(brokenHermesHome, 0o755);
          }
        } catch {
          // best-effort
        }
        await teardown(ctx);
      }
    },
  );

  // ── Scenario e: teardown-kill token attribution ──
  // Agent completes step (run becomes terminal), then the harness process
  // exits with code 130 (simulating real hermes KeyboardInterrupt). Token
  // attribution must survive — session_id was on stderr, state.db was written,
  // and US-002 makes the adapter resolve on non-zero exit.
  it(
    "do-now: teardown-kill token attribution — agent completes step, harness exits 130, tokens still attributed",
    { timeout: 120_000 },
    async () => {
      let ctx: ScriptedHermesRunContext | undefined;
      try {
        ctx = await startHermesScriptedEnvironment("do-now", {
          agents: {
            doer: {
              reportBeforeEmit: true,
              exitCode: 130,
              tokens: 555,
              output: "STATUS: done\nREPORT: teardown-kill after step complete — token attribution should survive",
            },
          },
        });
        const workdir = path.join(ctx.env.root, "do-now-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        const runEnv = { ...baseEnv(ctx.env.homeDir, ctx.env.controlPort), ...ctx.scripted.env };
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "do-now",
            "Report the current date",
            "--hermes-as-harness",
            "--working-directory-for-harness",
            workdir,
          ],
          runEnv,
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 90_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete despite harness exiting 130, got "${status}"\n${diagnostics(ctx)}`,
        );

        // ── Token attribution survived the teardown kill ─────────
        const tokens = await waitForRunTokens(ctx.env.tamanduaDir, runId, 555);
        assert.equal(
          tokens,
          555,
          `teardown-kill token attribution must survive harness exit 130 — ` +
            `expected 555 tokens, got ${tokens}. ` +
            `If this is 0, the adapter didn't capture sessionRef from stderr ` +
            `or the scheduler didn't attribute tokens on the non-zero exit path.\n` +
            `${diagnostics(ctx)}`,
        );

        // ── Step completed normally ──────────────────────────────
        const steps = dbRows<{ step_id: string; status: string }>(
          ctx.env.tamanduaDir,
          "SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index",
          runId,
        );
        assert.equal(steps.length, 1, "do-now should have exactly 1 step");
        assert.equal(
          steps[0].status,
          "done",
          `step should be done (step complete was called before harness exit 130), got ${steps[0].status}`,
        );

        // ── Only one work round (no retries despite exit 130) ────
        const workRounds = ctx.scripted.workInvocations("doer");
        assert.equal(
          workRounds.length,
          1,
          `doer should have exactly 1 work round (step completed before exit 130), ` +
            `got ${workRounds.length}\n${diagnostics(ctx)}`,
        );

        // ── Terminal event exists (token attribution happens
        // asynchronously after run completion — the event may carry 0
        // while the DB has the real count; waitForRunTokens covers
        // attribution correctness).
        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        const completed = events.find((e) => e.event === "run.completed");
        assert.ok(completed, `run.completed event missing; events: ${events.map((e) => e.event).join(", ")}`);
        assert.equal(typeof completed.tokensSpent, "number", "run.completed should carry tokensSpent field");

        console.log(
          `[scripted-hermes-e2e teardown-kill] do-now with exitCode 130: ` +
            `run completed, tokens_spent=${tokens} (attribution survived teardown kill)`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );
});
