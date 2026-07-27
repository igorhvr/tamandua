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
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  spawnScriptedWorkflowRun as spawnWorkflowRun,
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
  createScriptedAgent,
  type ScriptedAgent,
  type ScriptedAgentConfig,
  type ScriptedBehavior,
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
  await releasePortReservations(env);
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

const MIGRATED_MERGE_WORKFLOWS = [
  { id: "bug-fix-merge", family: "bug-fix", worktree: false },
  { id: "bug-fix-merge-worktree", family: "bug-fix", worktree: true },
  { id: "quarantine-broken-tests-merge", family: "quarantine", worktree: false },
  { id: "quarantine-broken-tests-merge-worktree", family: "quarantine", worktree: true },
  { id: "security-audit-merge", family: "security", worktree: false },
  { id: "security-audit-merge-worktree", family: "security", worktree: true },
] as const;

function createMigratedMergerBehaviors(
  family: (typeof MIGRATED_MERGE_WORKFLOWS)[number]["family"],
): ScriptedAgentConfig {
  const branch = `scripted-${family}-landing`;
  const change = family === "quarantine"
    ? { file: "test/math.test.ts", find: 'it("correctly expects addition"', replace: 'it.skip("correctly expects addition"' }
    : { file: "src/math.ts", find: "a - b", replace: "a + b" };
  const commitMessage = family === "quarantine"
    ? "chore: quarantine broken math test"
    : family === "security"
      ? "fix(security): correct unsafe math operation"
      : "fix: correct add implementation";

  return {
    agents: {
      triager: { output: `STATUS: done\nREPO: {{cwd}}\nBRANCH: ${branch}\nSEVERITY: high\nAFFECTED_AREA: src/math.ts\nREPRODUCTION: add returns subtraction\nPROBLEM_STATEMENT: wrong operator` },
      investigator: { output: "STATUS: done\nROOT_CAUSE: subtraction operator used\nFIX_APPROACH: use addition" },
      scanner: { output: `STATUS: done\nREPO: {{cwd}}\nBRANCH: ${branch}\nVULNERABILITY_COUNT: 1\nFINDINGS: unsafe arithmetic behavior` },
      prioritizer: {
        output: 'STATUS: done\nFIX_PLAN: correct unsafe arithmetic\nCRITICAL_COUNT: 0\nHIGH_COUNT: 1\nDEFERRED: none\nSTORIES_JSON: [{"id":"US-001","title":"Correct arithmetic","description":"Use safe addition","acceptanceCriteria":["addition is used","tests pass"]}]',
      },
      setup: {
        commands: [`git show-ref --verify --quiet "refs/heads/${branch}" && git checkout "${branch}" || git checkout -b "${branch}"`],
        output: "STATUS: done\nORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}\nBUILD_CMD: true\nTEST_CMD: true\nCI_NOTES: scripted fixture\nBASELINE: scripted baseline",
      },
      fixer: {
        edits: [change],
        commands: ["git add -A", `git commit -m "${commitMessage}"`],
        output: "STATUS: done\nCHANGES: corrected scripted fixture\nREGRESSION_TEST: scripted coverage",
      },
      quarantiner: {
        edits: [change],
        commands: ["git add -A", `git commit -m "${commitMessage}"`],
        output: "STATUS: done\nDISABLED: 1\nFILES_CHANGED: 1\nSUMMARY: quarantined broken math test",
      },
      verifier: { output: "STATUS: done\nVERIFIED: scripted change verified\nTESTED_TREE: scripted-tested-tree" },
      tester: { output: "STATUS: done\nRESULTS: scripted suite passed\nTESTED_TREE: scripted-tested-tree\nAUDIT_AFTER: clean" },
      merger: {
        commands: [
          `expected_tip=$(git -C "{{input.ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.ORIGIN_REPOSITORY}}" --branch "${branch}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "${commitMessage} (squash of ${branch})"`,
        ],
        includeCommandOutput: true,
        output: "STATUS: done\nREBASED: false\nMERGED_INTO: {{input.ORIGINAL_BRANCH}}",
      },
    },
  };
}

const BUG_FIX_AGENTS = ["triager", "investigator", "setup", "fixer", "verifier", "merger"];

// ── Tests ───────────────────────────────────────────────────────────

describe("scripted-agent full pipeline (real daemon/scheduler, zero tokens)", { concurrency: 3 }, () => {
  for (const workflow of MIGRATED_MERGE_WORKFLOWS) {
    it(
      `${workflow.id}: scripted merger lands through plumbing without switching the origin checkout`,
      { timeout: 240_000 },
      async () => {
        let ctx: ScriptedRunContext | undefined;
        try {
          ctx = await startScriptedEnvironment(workflow.id, createMigratedMergerBehaviors(workflow.family));
          const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
          const originalBranch = execSync("git symbolic-ref --short HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
          const initialCheckout = `observer/${workflow.id}`;
          execSync(`git checkout -b "${initialCheckout}"`, { cwd: repoDir, stdio: "ignore" });
          const targetBranch = workflow.worktree ? originalBranch : initialCheckout;
          const expectedFinalCheckout = workflow.worktree
            ? initialCheckout
            : `scripted-${workflow.family}-landing`;
          const originTip = execSync(`git rev-parse "refs/heads/${targetBranch}"`, { cwd: repoDir, encoding: "utf-8" }).trim();

          const runArgs = [
            "workflow", "run", workflow.id, `Exercise plumbing landing for ${workflow.id}`,
            "--context", `repo=${repoDir}`,
          ];
          if (workflow.worktree) {
            runArgs.push(
              "--context", `branch=scripted-${workflow.family}-landing`,
              "--worktree-origin-repository", repoDir,
              "--worktree-origin-ref", originalBranch,
            );
          } else if (workflow.family === "quarantine") {
            runArgs.push("--context", `branch=${initialCheckout}`);
          }
          const runIdPrefix = await spawnWorkflowRun(
            runArgs,
            baseEnv(ctx.env.homeDir, ctx.env.controlPort),
            30_000,
            repoDir,
          );
          const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);
          const status = await waitForRun(ctx, runId, 180_000);
          assert.ok(status === "completed" || status === "done", `${workflow.id} failed: ${status}\n${diagnostics(ctx)}`);

          const mergedCommit = execSync(`git rev-parse "refs/heads/${targetBranch}"`, { cwd: repoDir, encoding: "utf-8" }).trim();
          const mergedTree = execSync(`git rev-parse "refs/heads/${targetBranch}^{tree}"`, { cwd: repoDir, encoding: "utf-8" }).trim();
          const mergeStep = dbRow<{ output: string }>(
            ctx.env.tamanduaDir,
            "SELECT output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
            runId,
          );
          assert.notEqual(mergedCommit, originTip, `target ref should advance to the squash commit\n${mergeStep.output}`);
          assert.equal(
            execSync("git symbolic-ref --short HEAD", { cwd: repoDir, encoding: "utf-8" }).trim(),
            expectedFinalCheckout,
            "origin checkout must stay on its pre-run branch during merger and must not switch to the target",
          );

          assert.match(mergeStep.output, /^STATUS: landed$/m);
          assert.match(mergeStep.output, new RegExp(`^MERGED_COMMIT: ${mergedCommit}$`, "m"));
          assert.match(mergeStep.output, new RegExp(`^MERGED_TREE: ${mergedTree}$`, "m"));
          assert.match(mergeStep.output, /^CHECKOUT_REFRESH: \S+$/m);
          assert.match(mergeStep.output, /^STATUS: done$/m);
          assert.match(mergeStep.output, /^REBASED: false$/m);
          assert.match(mergeStep.output, new RegExp(`^MERGED_INTO: ${targetBranch}$`, "m"));
        } finally {
          await teardown(ctx);
        }
      },
    );
  }

  it(
    "bug-fix-merge-worktree: full pipeline through scripted agents merges the fix",
    { timeout: 240_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        ctx = await startScriptedEnvironment("bug-fix-merge-worktree", bugFixBehaviors);
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch, tip: originTip, tree: originTree } = detachOriginCheckout(repoDir);

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--worktree-origin-repository",
            repoDir,
            "--worktree-origin-ref",
            originalBranch,
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
          .filter((event) => event.event.startsWith("merge.") && event.event !== "merge.gate_overridden");
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
    "RAMP bug-fix-merge-worktree: classified target movement reroutes through verifier before a successful landing",
    { timeout: 240_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        const firstMergerCommand = [
          "set -e",
          'origin="{{input.WORKTREE_ORIGIN_REPOSITORY}}"',
          'target="refs/heads/{{input.ORIGINAL_BRANCH}}"',
          'expected_tip=$(git -C "$origin" rev-parse "$target")',
          `"${process.execPath}" "${cliPath}" merge-branch --origin "$origin" --branch "cdet-target-marker" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "test: advance target during scripted merge"`,
          "set +e",
          `merge_output=$(TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "$origin" --branch "${BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "fix: deterministic target-moved retry (squash of ${BRANCH})" 2>&1)`,
          "merge_exit=$?",
          "set -e",
          'printf "%s\\n" "$merge_output"',
          'printf "CLI_EXIT_CODE: %s\\n" "$merge_exit"',
          'printf "%s\\n" "$merge_exit" > "$origin/.git/cdet-target-moved-exit"',
          'test "$merge_exit" -eq 2',
        ].join("; ");
        const secondMergerCommand = [
          'expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}")',
          `TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "fix: deterministic target-moved retry (squash of ${BRANCH})"`,
        ].join(" && ");
        const targetMovedBehaviors: ScriptedAgentConfig = {
          agents: {
            ...bugFixBehaviors.agents,
            verifier: {
              output: [
                "STATUS: done",
                "VERIFIED: feature tree revalidated after target movement",
                "TESTED_TREE: scripted-tree-after-target-move",
              ].join("\n"),
            },
            merger: [
              {
                commands: [firstMergerCommand],
                includeCommandOutput: true,
                output: "STATUS: failed\nREASON: target moved before landing",
                stepAction: "fail",
                failReason: "target moved before landing\nFAILURE_CLASS: target_moved",
              },
              {
                commands: [secondMergerCommand],
                includeCommandOutput: true,
                output: [
                  "STATUS: done",
                  "REBASED: false",
                  "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
                ].join("\n"),
              },
            ],
          },
        };

        ctx = await startScriptedEnvironment("bug-fix-merge-worktree", targetMovedBehaviors);
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const originalBranch = execSync("git symbolic-ref --short HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
        const initialTip = execSync(`git rev-parse "refs/heads/${originalBranch}"`, {
          cwd: repoDir,
          encoding: "utf-8",
        }).trim();
        execSync("git switch -c cdet-target-marker", { cwd: repoDir, encoding: "utf-8" });
        fs.writeFileSync(path.join(repoDir, "contention-marker.txt"), "independent target update\n", "utf-8");
        execSync("git add contention-marker.txt && git commit -m 'test: prepare independent target update'", {
          cwd: repoDir,
          encoding: "utf-8",
        });
        execSync(`git switch "${originalBranch}"`, { cwd: repoDir, encoding: "utf-8" });
        const originTip = initialTip;

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--worktree-origin-repository",
            repoDir,
            "--worktree-origin-ref",
            originalBranch,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 200_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete after target-moved reroute, got "${status}"\n${diagnostics(ctx)}`,
        );

        assert.equal(
          fs.readFileSync(path.join(repoDir, ".git", "cdet-target-moved-exit"), "utf-8").trim(),
          "2",
          "the first feature landing CLI invocation should exit 2",
        );
        assert.equal(ctx.scripted.workInvocations("verifier").length, 2, "target_moved should reroute through verifier");
        assert.equal(ctx.scripted.workInvocations("merger").length, 2, "merger should retry once after revalidation");

        const steps = dbRows<{ step_id: string; status: string; reroute_count: number | null }>(
          ctx.env.tamanduaDir,
          "SELECT step_id, status, reroute_count FROM steps WHERE run_id = ? ORDER BY step_index",
          runId,
        );
        assert.equal(steps.length, 6);
        for (const step of steps) assert.equal(step.status, "done", `${step.step_id} should finish done`);
        assert.equal(steps.find((step) => step.step_id === "finalize_merge")?.reroute_count, 1);

        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        const rerouted = events.find((event) => event.event === "step.rerouted");
        assert.equal(rerouted?.stepId, "finalize_merge");
        assert.match(String(rerouted?.detail), /verify/);
        assert.match(String(rerouted?.detail), /FAILURE_CLASS: target_moved/);
        const mergeEvents = events.filter(
          (event) => String(event.event).startsWith("merge.") && event.event !== "merge.gate_overridden",
        );
        assert.deepEqual(mergeEvents.map((event) => event.event), ["merge.target_moved", "merge.landed"]);

        const moved = mergeEvents[0];
        const landed = mergeEvents[1];
        const markerTip = execSync(`git rev-parse "refs/heads/${originalBranch}^"`, {
          cwd: repoDir,
          encoding: "utf-8",
        }).trim();
        const mergedCommit = execSync(`git rev-parse "refs/heads/${originalBranch}"`, {
          cwd: repoDir,
          encoding: "utf-8",
        }).trim();
        const mergedTree = execSync(`git rev-parse "refs/heads/${originalBranch}^{tree}"`, {
          cwd: repoDir,
          encoding: "utf-8",
        }).trim();
        for (const event of mergeEvents) {
          assert.equal(event.runId, runId);
          assert.equal(event.origin, repoDir);
          assert.equal(event.branch, BRANCH);
          assert.equal(event.target, `refs/heads/${originalBranch}`);
        }
        assert.equal(moved.expectedTip, initialTip);
        assert.equal(moved.actualTip, markerTip);
        assert.notEqual(moved.actualTip, moved.expectedTip);
        assert.equal(landed.expectedTip, markerTip);
        assert.equal(landed.mergedCommit, mergedCommit);
        assert.equal(landed.mergedTree, mergedTree);
        assert.equal(landed.checkoutRefresh, "refreshed");

        // ── Step output assertions: finalize_merge output matches ──
        const finalizeStep = dbRow<{ output: string }>(
          ctx.env.tamanduaDir,
          "SELECT output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
          runId,
        );
        assert.match(finalizeStep.output, /^STATUS: landed$/m);
        assert.match(finalizeStep.output, new RegExp(`^MERGED_COMMIT: ${mergedCommit}$`, "m"));
        assert.match(finalizeStep.output, new RegExp(`^MERGED_TREE: ${mergedTree}$`, "m"));
        assert.match(finalizeStep.output, new RegExp(`^TARGET: refs/heads/${originalBranch}$`, "m"));
        assert.match(finalizeStep.output, /^CHECKOUT_REFRESH: refreshed$/m);

        // Target ref has the merged content (marker + feature fix)
        assert.equal(
          execSync(`git show "refs/heads/${originalBranch}:contention-marker.txt"`, {
            cwd: repoDir,
            encoding: "utf-8",
          }),
          "independent target update\n",
        );
        const targetMath = execSync(`git show "refs/heads/${originalBranch}:src/math.ts"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.ok(targetMath.includes("a + b"), `target should contain the feature fix:\n${targetMath}`);
        // The clean attached origin follows both managed landings and stays coherent.
        assert.equal(
          execSync("git symbolic-ref HEAD", { cwd: repoDir, encoding: "utf-8" }).trim(),
          `refs/heads/${originalBranch}`,
        );
        assert.equal(execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim(), mergedCommit);
        assert.equal(execSync("git status --porcelain", { cwd: repoDir, encoding: "utf-8" }), "");
        const originLog = execSync("git log --oneline -5", { cwd: repoDir, encoding: "utf-8" });
        assert.match(originLog, /fix: deterministic target-moved retry/);
        assert.ok(originLog.includes(mergedCommit.slice(0, 7)), `origin working-copy log should contain ${mergedCommit}:\n${originLog}`);
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "RAMP bug-fix-merge-worktree: classified conflicts reroute through verifier before a successful landing",
    { timeout: 240_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        const conflictsBehaviors: ScriptedAgentConfig = {
          agents: {
            ...bugFixBehaviors.agents,
            verifier: {
              output: [
                "STATUS: done",
                "VERIFIED: feature tree revalidated after merge conflicts",
                "TESTED_TREE: scripted-tree-after-conflicts",
              ].join("\n"),
            },
            merger: [
              {
                output: "STATUS: failed\nREASON: feature conflicts with the target branch",
                stepAction: "fail",
                failReason: "feature conflicts with the target branch\nFAILURE_CLASS: conflicts",
              },
              {
                commands: [
                  `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "fix: deterministic conflicts retry (squash of ${BRANCH})"`,
                ],
                includeCommandOutput: true,
                output: [
                  "STATUS: done",
                  "REBASED: false",
                  "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
                ].join("\n"),
              },
            ],
          },
        };

        ctx = await startScriptedEnvironment("bug-fix-merge-worktree", conflictsBehaviors);
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--worktree-origin-repository",
            repoDir,
            "--worktree-origin-ref",
            originalBranch,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 200_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete after conflicts reroute, got "${status}"\n${diagnostics(ctx)}`,
        );

        assert.equal(ctx.scripted.workInvocations("verifier").length, 2, "conflicts should reroute through verifier");
        assert.equal(ctx.scripted.workInvocations("merger").length, 2, "merger should retry once after revalidation");

        const steps = dbRows<{ step_id: string; status: string; reroute_count: number | null }>(
          ctx.env.tamanduaDir,
          "SELECT step_id, status, reroute_count FROM steps WHERE run_id = ? ORDER BY step_index",
          runId,
        );
        for (const step of steps) assert.equal(step.status, "done", `${step.step_id} should finish done`);
        assert.equal(steps.find((step) => step.step_id === "finalize_merge")?.reroute_count, 1);

        const rerouted = readRunEvents(ctx.env.tamanduaDir, runId)
          .find((event) => event.event === "step.rerouted");
        assert.equal(rerouted?.stepId, "finalize_merge");
        assert.match(String(rerouted?.detail), /verify/);
        assert.match(String(rerouted?.detail), /FAILURE_CLASS: conflicts/);

        const mergeStep = dbRow<{ output: string }>(
          ctx.env.tamanduaDir,
          "SELECT output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
          runId,
        );
        assert.match(mergeStep.output, /^STATUS: landed$/m);
        assert.match(mergeStep.output, /^STATUS: done$/m);
        const targetMath = execSync(`git show "refs/heads/${originalBranch}:src/math.ts"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.ok(targetMath.includes("a + b"), `target should contain the feature fix:\n${targetMath}`);
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "RAMP bug-fix-merge-worktree: a second permanent refusal fails verbatim after exactly one reroute",
    { timeout: 240_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        const refusalReason = [
          "Landing refused by repository policy.",
          "FAILURE_CLASS: refused_permanent",
          "Required approval is absent; automated landing remains prohibited.",
        ].join("\n");
        const refusedBehaviors: ScriptedAgentConfig = {
          agents: {
            ...bugFixBehaviors.agents,
            verifier: {
              output: "STATUS: done\nVERIFIED: feature tree revalidated after permanent refusal\nTESTED_TREE: scripted-tree-after-refusal",
            },
            merger: [
              { stepAction: "fail", failReason: refusalReason },
              { stepAction: "fail", failReason: refusalReason },
            ],
          },
        };

        ctx = await startScriptedEnvironment("bug-fix-merge-worktree", refusedBehaviors);
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow", "run", "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--worktree-origin-repository", repoDir,
            "--worktree-origin-ref", originalBranch,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 200_000);
        assert.equal(status, "failed", `run should fail after the second permanent refusal\n${diagnostics(ctx)}`);
        assert.equal(ctx.scripted.workInvocations("verifier").length, 2, "only one refusal revalidation should run");
        assert.equal(ctx.scripted.workInvocations("merger").length, 2, "a third merger attempt must not run");

        const run = dbRow<{ status: string }>(ctx.env.tamanduaDir, "SELECT status FROM runs WHERE id = ?", runId);
        assert.equal(run.status, "failed");
        const mergeStep = dbRow<{ status: string; output: string; reroute_count: number }>(
          ctx.env.tamanduaDir,
          "SELECT status, output, reroute_count FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
          runId,
        );
        assert.equal(mergeStep.status, "failed");
        assert.equal(mergeStep.output, refusalReason);
        assert.equal(mergeStep.reroute_count, 1);

        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        const rerouted = events.filter((event) => event.event === "step.rerouted");
        assert.equal(rerouted.length, 1, "the first permanent refusal should be the only reroute");
        assert.equal(rerouted[0].stepId, "finalize_merge");
        assert.match(String(rerouted[0].detail), /verify/);
        assert.ok(String(rerouted[0].detail).includes(refusalReason));
        const stepFailed = events.filter((event) => event.event === "step.failed");
        const runFailed = events.filter((event) => event.event === "run.failed");
        assert.equal(stepFailed.length, 1);
        assert.equal(runFailed.length, 1);
        assert.equal(stepFailed[0].detail, refusalReason);
        assert.equal(runFailed[0].detail, refusalReason);
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "RAMP bug-fix-merge-worktree: a permanent refusal can resolve after its one concessionary reroute",
    { timeout: 240_000 },
    async () => {
      let ctx: ScriptedRunContext | undefined;
      try {
        const refusalReason = [
          "Landing refused while repository policy is being refreshed.",
          "FAILURE_CLASS: refused_permanent",
          "Revalidation may observe the completed policy update.",
        ].join("\n");
        const resolvedBehaviors: ScriptedAgentConfig = {
          agents: {
            ...bugFixBehaviors.agents,
            verifier: {
              output: "STATUS: done\nVERIFIED: feature tree revalidated after permanent refusal\nTESTED_TREE: scripted-tree-after-refusal",
            },
            merger: [
              { stepAction: "fail", failReason: refusalReason },
              {
                commands: [
                  `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "fix: resolved permanent refusal (squash of ${BRANCH})"`,
                ],
                includeCommandOutput: true,
                output: "STATUS: done\nREBASED: false\nMERGED_INTO: {{input.ORIGINAL_BRANCH}}",
              },
            ],
          },
        };

        ctx = await startScriptedEnvironment("bug-fix-merge-worktree", resolvedBehaviors);
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow", "run", "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--worktree-origin-repository", repoDir,
            "--worktree-origin-ref", originalBranch,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

        const status = await waitForRun(ctx, runId, 200_000);
        assert.ok(
          status === "completed" || status === "done",
          `run should complete when the permanent refusal resolves, got "${status}"\n${diagnostics(ctx)}`,
        );
        assert.equal(ctx.scripted.workInvocations("verifier").length, 2, "the refusal should trigger one revalidation");
        assert.equal(ctx.scripted.workInvocations("merger").length, 2, "the merger should land on its second attempt");

        const mergeStep = dbRow<{ status: string; reroute_count: number; output: string }>(
          ctx.env.tamanduaDir,
          "SELECT status, reroute_count, output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
          runId,
        );
        assert.equal(mergeStep.status, "done");
        assert.equal(mergeStep.reroute_count, 1);
        assert.match(mergeStep.output, /^STATUS: landed$/m);

        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        const rerouted = events.filter((event) => event.event === "step.rerouted");
        assert.equal(rerouted.length, 1);
        assert.equal(rerouted[0].stepId, "finalize_merge");
        assert.ok(String(rerouted[0].detail).includes(refusalReason));
        assert.equal(events.filter((event) => event.event === "step.failed").length, 0);
        assert.equal(events.filter((event) => event.event === "run.failed").length, 0);
        assert.equal(events.filter((event) => event.event === "run.completed").length, 1);
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
              {
                output: ["STATUS: done", "VERIFIED: add() now uses a + b, regression test passes", "TESTED_TREE: scripted-tree-reroute"].join("\n"),
              },
            ],
            merger: {
              commands: [
                `origin="{{input.WORKTREE_ORIGIN_REPOSITORY}}" && printf '\n// local dirty bytes must survive managed landing\n' >> "$origin/src/math.ts" && expected_tip=$(git -C "$origin" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "$origin" --branch "${REROUTE_BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "fix: correct add implementation (squash of ${REROUTE_BRANCH})"`,
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
        const originTip = execSync(`git rev-parse "refs/heads/${originalBranch}"`, {
          cwd: repoDir,
          encoding: "utf-8",
        }).trim();
        const dirtyPath = path.join(repoDir, "src", "math.ts");
        const dirtyBytes = Buffer.concat([
          fs.readFileSync(dirtyPath),
          Buffer.from("\n// local dirty bytes must survive managed landing\n"),
        ]);

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--worktree-origin-repository",
            repoDir,
            "--worktree-origin-ref",
            originalBranch,
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

        // ── Repository outcome: the corrected fix landed; the dirty origin is safely parked ──
        const targetMath = execSync(`git show "refs/heads/${originalBranch}:src/math.ts"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.ok(targetMath.includes("a + b"), `target ref math.ts should use addition:\n${targetMath}`);
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
        const parkedBranch = mergeStep.output.match(/^PARKED_BRANCH: (.+)$/m)?.[1];
        assert.ok(parkedBranch, `parked landing should report its backup branch:\n${mergeStep.output}`);
        assert.match(parkedBranch, new RegExp(`^${originalBranch}-tamandua-parked-\\d{8}T\\d{6}Z-${runId.slice(0, 8)}$`));
        assert.match(mergeStep.output, new RegExp(`^CHECKOUT_REFRESH: parked:${parkedBranch}$`, "m"));
        assert.match(mergeStep.output, /^PARKED_REASON: local-changes$/m);
        const mergeEvents = fs
          .readFileSync(path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`), "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as {
            event: string;
            checkoutRefresh?: string;
            parkedBranch?: string;
            parkedReason?: string;
          })
          .filter((event) => event.event.startsWith("merge.") && event.event !== "merge.gate_overridden");
        assert.deepEqual(mergeEvents.map((event) => event.event), ["merge.landed"]);
        assert.equal(mergeEvents[0]?.checkoutRefresh, `parked:${parkedBranch}`);
        assert.equal(mergeEvents[0]?.parkedBranch, parkedBranch);
        assert.equal(mergeEvents[0]?.parkedReason, "local-changes");
        const mergedCommit = execSync(`git rev-parse "refs/heads/${originalBranch}"`, {
          cwd: repoDir,
          encoding: "utf-8",
        }).trim();
        assert.equal(
          execSync("git symbolic-ref HEAD", { cwd: repoDir, encoding: "utf-8" }).trim(),
          `refs/heads/${parkedBranch}`,
        );
        assert.equal(
          execSync(`git rev-parse "refs/heads/${parkedBranch}"`, { cwd: repoDir, encoding: "utf-8" }).trim(),
          originTip,
        );
        assert.equal(execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim(), originTip);
        assert.notEqual(mergedCommit, originTip, "target ref should advance to the landed squash commit");
        assert.deepEqual(fs.readFileSync(dirtyPath), dirtyBytes, "tracked dirty bytes must remain byte-identical while parked");

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

  const LGAT_BRANCH = "feature/lgat-scripted";

  interface LgatRunResult {
    ctx: ScriptedRunContext;
    repoDir: string;
    originalBranch: string;
    originTip: string;
    runId: string;
    status: string;
  }

  interface LgatLedgerRow {
    id: number;
    origin_repo: string;
    tree_hash: string;
    cmd_hash: string;
    cmd_display: string;
    exit_code: number;
    duration_ms: number;
    log_tail: string | null;
    run_id: string | null;
    step_id: string | null;
    created_at: string;
  }

  function assertLgatMarkerLanded(run: LgatRunResult): void {
    const landedTip = execSync(`git rev-parse "refs/heads/${run.originalBranch}"`, {
      cwd: run.repoDir,
      encoding: "utf-8",
    }).trim();
    assert.notEqual(landedTip, run.originTip, "the actual origin ref must advance when LGAT permits landing");
    assert.match(execSync(`git show "refs/heads/${run.originalBranch}:src/lgat-marker.ts"`, {
      cwd: run.repoDir,
      encoding: "utf-8",
    }), /ledger gate scripted acceptance marker/);
  }

  function assertLgatMarkerNotLanded(run: LgatRunResult): void {
    const currentTip = execSync(`git rev-parse "refs/heads/${run.originalBranch}"`, {
      cwd: run.repoDir,
      encoding: "utf-8",
    }).trim();
    assert.equal(currentTip, run.originTip, "a refused LGAT landing must leave the actual origin ref unchanged");
    const marker = spawnSync("git", ["show", `refs/heads/${run.originalBranch}:src/lgat-marker.ts`], {
      cwd: run.repoDir,
      encoding: "utf-8",
    });
    assert.notEqual(marker.status, 0, "the refused LGAT marker must remain absent from the actual origin ref");
  }

  function expectedRedLedgerRefusal(row: LgatLedgerRow): string {
    return [
      "FAILURE_CLASS: refused_permanent",
      "Ledger gate refused finalize_merge: latest matching TSTX suite execution is red.",
      "LEDGER_EVIDENCE: red",
      `ORIGIN_REPO: ${row.origin_repo}`,
      `TREE_HASH: ${row.tree_hash}`,
      `CMD_HASH: ${row.cmd_hash}`,
      `TEST_CMD: ${row.cmd_display}`,
      `LEDGER_ROW_ID: ${row.id}`,
      `EXIT_CODE: ${row.exit_code}`,
      `TIMESTAMP: ${row.created_at}`,
      `DURATION_MS: ${row.duration_ms}`,
      `LEDGER_RUN_ID: ${row.run_id ?? ""}`,
      `LEDGER_STEP_ID: ${row.step_id ?? ""}`,
      `LOG_TAIL: ${row.log_tail ?? ""}`,
    ].join("\n");
  }

  function lgatBehaviors(testCmd: "true" | "false", tester: ScriptedBehavior | ScriptedBehavior[]): ScriptedAgentConfig {
    return {
      agents: {
        planner: {
          output: [
            "STATUS: done",
            "REPO: {{cwd}}",
            `BRANCH: ${LGAT_BRANCH}`,
            `STORIES_JSON: [{"id":"US-001","title":"LGAT scripted acceptance","description":"Exercise ledger gate behavior","acceptanceCriteria":["Gate result is deterministic"]}]`,
          ].join("\n"),
        },
        setup: {
          commands: [`git checkout -b ${LGAT_BRANCH}`],
          output: [
            "STATUS: done",
            "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
            "BUILD_CMD: true",
            `TEST_CMD: ${testCmd}`,
            "BASELINE: scripted fixture ready",
          ].join("\n"),
        },
        developer: {
          writes: [{ file: "src/lgat-marker.ts", content: "// ledger gate scripted acceptance marker\n" }],
          commands: ["git add -A", 'git commit -m "feat: add LGAT acceptance marker"'],
          output: "STATUS: done\nCHANGES: added LGAT marker\nTESTS: scripted fixture",
        },
        verifier: { output: "STATUS: done\nVERIFIED: LGAT marker exists" },
        tester,
        merger: {
          commands: [
            `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${LGAT_BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "feat: LGAT scripted acceptance (squash of ${LGAT_BRANCH})"`,
          ],
          includeCommandOutput: true,
          output: "STATUS: done\nREBASED: false\nMERGED_INTO: {{input.ORIGINAL_BRANCH}}",
        },
      },
    };
  }

  async function launchLgatRun(
    testCmd: "true" | "false",
    tester: ScriptedBehavior | ScriptedBehavior[],
    options: { mergeGate?: "green" | "off"; inert?: boolean } = {},
  ): Promise<LgatRunResult> {
    const ctx = await startScriptedEnvironment("feature-dev-merge-worktree", lgatBehaviors(testCmd, tester));
    if (options.inert) {
      const installedWorkflow = path.join(ctx.env.tamanduaDir, "workflows", "feature-dev-merge-worktree", "workflow.yml");
      const workflowText = fs.readFileSync(installedWorkflow, "utf-8");
      const unattested = workflowText.replace(
        'expects: "STATUS: done\\nregex:^TESTED_TREE:\\\\s*\\\\S+"',
        'expects: "STATUS: done"',
      );
      assert.notEqual(unattested, workflowText, "fixture workflow should drop the TESTED_TREE contract");
      fs.writeFileSync(installedWorkflow, unattested);
    }
    const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
    const { branch: originalBranch, tip: originTip } = detachOriginCheckout(repoDir);
    const args = [
      "workflow", "run", "feature-dev-merge-worktree", "Exercise LGAT scripted acceptance behavior",
      "--worktree-origin-repository", repoDir,
      "--worktree-origin-ref", originalBranch,
    ];
    args.push("--context", `merge_gate=${options.mergeGate ?? "default"}`);
    const runIdPrefix = await spawnWorkflowRun(args, baseEnv(ctx.env.homeDir, ctx.env.controlPort));
    const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);
    const status = await waitForRun(ctx, runId, 200_000);
    return { ctx, repoDir, originalBranch, originTip, runId, status };
  }

  it("LGAT: missing evidence reroutes once, then a real green TSTX row allows landing", { timeout: 240_000 }, async () => {
    let run: Awaited<ReturnType<typeof launchLgatRun>> | undefined;
    try {
      run = await launchLgatRun("true", [
        { output: "STATUS: done\nRESULTS: attested without running TEST_CMD\nTESTED_TREE: {{gitTree}}" },
        {
          commands: ["{{input.BUILD_CMD}}", "{{input.TEST_CMD}}"],
          output: "STATUS: done\nRESULTS: rerun created green ledger evidence\nTESTED_TREE: {{gitTree}}",
        },
      ]);
      assert.equal(run.status, "completed", diagnostics(run.ctx));
      assert.equal(run.ctx.scripted.workInvocations("tester").length, 2);
      assert.equal(run.ctx.scripted.workInvocations("merger").length, 1, "merger must run only after recovery");
      assertLgatMarkerLanded(run);
      const mergeStep = dbRow<{ status: string; reroute_count: number }>(
        run.ctx.env.tamanduaDir,
        "SELECT status, reroute_count FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
        run.runId,
      );
      assert.equal(mergeStep.status, "done");
      assert.equal(mergeStep.reroute_count, 1);
      const rows = dbRows<{ exit_code: number; tree_hash: string; cmd_hash: string; cmd_display: string }>(
        run.ctx.env.tamanduaDir,
        "SELECT exit_code, tree_hash, cmd_hash, cmd_display FROM suite_results WHERE run_id = ? ORDER BY id",
        run.runId,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].exit_code, 0);
      assert.match(rows[0].tree_hash, /^[0-9a-f]{40}$/);
      assert.match(rows[0].cmd_hash, /^[0-9a-f]{64}$/);
      assert.equal(rows[0].cmd_display, "true");
      const events = readRunEvents(run.ctx.env.tamanduaDir, run.runId);
      const gateRefusal = events.find((event) => event.event === "step.rerouted");
      assert.match(String(gateRefusal?.detail), /LEDGER_EVIDENCE: missing/);
    } finally {
      await teardown(run?.ctx);
    }
  });

  it("LGAT: repeated red evidence refuses permanently after one reroute", { timeout: 240_000 }, async () => {
    let run: Awaited<ReturnType<typeof launchLgatRun>> | undefined;
    try {
      const redTester: ScriptedBehavior = {
        commands: ["{{input.BUILD_CMD}}", "{{input.TEST_CMD}} || true"],
        output: "STATUS: done\nRESULTS: failing suite recorded for gate\nTESTED_TREE: {{gitTree}}",
      };
      run = await launchLgatRun("false", [redTester, redTester], { mergeGate: "green" });
      assert.equal(run.status, "failed", diagnostics(run.ctx));
      assert.equal(run.ctx.scripted.workInvocations("tester").length, 2);
      assert.equal(run.ctx.scripted.workInvocations("merger").length, 0, "merge command must never execute");
      assertLgatMarkerNotLanded(run);
      const mergeStep = dbRow<{ status: string; reroute_count: number; output: string }>(
        run.ctx.env.tamanduaDir,
        "SELECT status, reroute_count, output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
        run.runId,
      );
      assert.equal(mergeStep.status, "failed");
      assert.equal(mergeStep.reroute_count, 1);
      const rows = dbRows<LgatLedgerRow>(
        run.ctx.env.tamanduaDir,
        `SELECT id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms,
                log_tail, run_id, step_id, created_at
         FROM suite_results WHERE run_id = ? ORDER BY id`,
        run.runId,
      );
      assert.deepEqual(rows.map((row) => row.exit_code), [1, 1]);
      const firstRefusal = expectedRedLedgerRefusal(rows[0]);
      const terminalRefusal = expectedRedLedgerRefusal(rows[1]);
      assert.equal(mergeStep.output, terminalRefusal, "terminal refusal must preserve the exact latest ledger row");
      const events = readRunEvents(run.ctx.env.tamanduaDir, run.runId);
      const rerouted = events.filter((event) => event.event === "step.rerouted");
      const failed = events.filter((event) => event.event === "step.failed" && event.stepId === "finalize_merge");
      assert.equal(rerouted.length, 1);
      assert.equal(failed.length, 1);
      assert.ok(String(rerouted[0].detail).includes(firstRefusal), "reroute must preserve the exact first red ledger row");
      assert.equal(failed[0].detail, terminalRefusal, "terminal event must preserve the exact latest red ledger row");
      const runFailed = events.filter((event) => event.event === "run.failed");
      assert.equal(runFailed.length, 1);
      assert.equal(runFailed[0].detail, terminalRefusal, "run failure must preserve the exact latest red ledger row");
      const statusText = cliMustSucceed(
        ["workflow", "status", run.runId],
        baseEnv(run.ctx.env.homeDir, run.ctx.env.controlPort),
        "render red LGAT workflow status",
      );
      assert.match(statusText, /LEDGER_EVIDENCE:\s*red/);
    } finally {
      await teardown(run?.ctx);
    }
  });

  it("LGAT: default mode lands over red evidence and surfaces the durable annotation", { timeout: 240_000 }, async () => {
    let run: Awaited<ReturnType<typeof launchLgatRun>> | undefined;
    try {
      run = await launchLgatRun("false", {
        commands: ["{{input.BUILD_CMD}}", "{{input.TEST_CMD}} || true"],
        output: "STATUS: done\nRESULTS: red evidence recorded for annotated landing\nTESTED_TREE: {{gitTree}}",
      });
      assert.equal(run.status, "completed", diagnostics(run.ctx));
      assert.equal(run.ctx.scripted.workInvocations("tester").length, 1);
      assert.equal(run.ctx.scripted.workInvocations("merger").length, 1);
      assertLgatMarkerLanded(run);
      const mergeStep = dbRow<{ status: string; reroute_count: number }>(
        run.ctx.env.tamanduaDir,
        "SELECT status, reroute_count FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
        run.runId,
      );
      assert.equal(mergeStep.status, "done");
      assert.equal(mergeStep.reroute_count, 0);
      const row = dbRow<{ id: number; exit_code: number; created_at: string }>(
        run.ctx.env.tamanduaDir,
        "SELECT id, exit_code, created_at FROM suite_results WHERE run_id = ?",
        run.runId,
      );
      assert.equal(row.exit_code, 1);
      const events = readRunEvents(run.ctx.env.tamanduaDir, run.runId);
      const annotation = events.filter((event) => event.event === "merge.landed_over_red_suite");
      assert.equal(annotation.length, 1);
      assert.equal(annotation[0].runId, run.runId);
      assert.equal(annotation[0].ledgerRowId, row.id);
      assert.equal(annotation[0].exitCode, 1);
      assert.equal(annotation[0].ledgerCreatedAt, row.created_at);
      const statusText = cliMustSucceed(
        ["workflow", "status", run.runId],
        baseEnv(run.ctx.env.homeDir, run.ctx.env.controlPort),
        "render annotated red-ledger landing",
      );
      assert.match(statusText, new RegExp(`Red-ledger landing: row ${row.id}, exit 1`));
    } finally {
      await teardown(run?.ctx);
    }
  });

  it("LGAT: merge_gate=off lands despite red evidence and emits an attributed override", { timeout: 240_000 }, async () => {
    let run: Awaited<ReturnType<typeof launchLgatRun>> | undefined;
    try {
      run = await launchLgatRun("false", {
        commands: ["{{input.BUILD_CMD}}", "{{input.TEST_CMD}} || true"],
        output: "STATUS: done\nRESULTS: red evidence intentionally overridden\nTESTED_TREE: {{gitTree}}",
      }, { mergeGate: "off" });
      assert.equal(run.status, "completed", diagnostics(run.ctx));
      assert.equal(run.ctx.scripted.workInvocations("merger").length, 1);
      assertLgatMarkerLanded(run);
      const rows = dbRows<LgatLedgerRow>(
        run.ctx.env.tamanduaDir,
        `SELECT id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms,
                log_tail, run_id, step_id, created_at
         FROM suite_results WHERE run_id = ?`,
        run.runId,
      );
      assert.deepEqual(rows.map((row) => row.exit_code), [1]);
      const launch = dbRow<{ run_number: number; workflow_id: string; created_at: string }>(
        run.ctx.env.tamanduaDir,
        "SELECT run_number, workflow_id, created_at FROM runs WHERE id = ?",
        run.runId,
      );
      const events = readRunEvents(run.ctx.env.tamanduaDir, run.runId);
      const overrides = events.filter((event) => event.event === "merge.gate_overridden");
      assert.equal(overrides.length, 1);
      assert.equal(overrides[0].runId, run.runId);
      assert.equal(overrides[0].stepId, "finalize_merge");
      assert.equal(overrides[0].gateMode, "off");
      assert.equal(overrides[0].runNumber, launch.run_number);
      assert.equal(overrides[0].launchTs, launch.created_at);
      assert.equal(overrides[0].workflowId, launch.workflow_id);
      assert.equal(overrides[0].origin, rows[0].origin_repo);
      assert.equal(overrides[0].treeHash, rows[0].tree_hash);
      assert.equal(overrides[0].cmdHash, rows[0].cmd_hash);
    } finally {
      await teardown(run?.ctx);
    }
  });

  it("LGAT: an unattested workflow remains inert and lands without gate events", { timeout: 240_000 }, async () => {
    let run: Awaited<ReturnType<typeof launchLgatRun>> | undefined;
    try {
      run = await launchLgatRun("false", {
        output: "STATUS: done\nRESULTS: legacy workflow intentionally omits an attestation",
      }, { mergeGate: "green", inert: true });
      assert.equal(run.status, "completed", diagnostics(run.ctx));
      assert.equal(run.ctx.scripted.workInvocations("merger").length, 1);
      assertLgatMarkerLanded(run);
      const events = readRunEvents(run.ctx.env.tamanduaDir, run.runId);
      assert.equal(events.filter((event) => event.event === "step.rerouted").length, 0);
      assert.equal(events.filter((event) => event.event === "merge.gate_overridden").length, 0);
      assert.equal(dbRows(run.ctx.env.tamanduaDir, "SELECT id FROM suite_results WHERE run_id = ?", run.runId).length, 0);
    } finally {
      await teardown(run?.ctx);
    }
  });

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
          "BUILD_CMD: true",
          "TEST_CMD: true",
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
        commands: ["{{input.BUILD_CMD}}", "{{input.TEST_CMD}}"],
        output: [
          "STATUS: done",
          "RESULTS: Full test suite passes, oref-marker.ts verified",
          "TESTED_TREE: {{gitTree}}",
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
            "--context",
            "merge_gate=default",
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
