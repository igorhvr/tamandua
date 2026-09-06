/**
 * VSRP (US-002) — isolated scripted full-pipeline e2e proving the verifier
 * retry verdict end-to-end through the REAL daemon → scheduler → harness
 * spawn → step protocol (ZERO model tokens, deterministic scripted agent).
 *
 * The pure-DB/parser regressions (src/installer/step-ops-verifier-verdict.test.ts)
 * prove the routing predicate in isolation; this file proves the SAME fix
 * through the built product's real motor: an actual verify_each workflow run
 * whose verifier's first round emits the exact retained KHYG report
 * (2026-09-06 02:25 UTC — standalone 'STATUS: retry' followed by the
 * hyphenated 'VERIFIED-OK:' and parenthesized 'ISSUES (...):' headings that
 * pollute the generic multi-line key parse). Evidence (READ ONLY):
 *   /home/igorhvr/idm/tamandua/torture-test/var/review-logs/
 *     native-signal-probes.DHNQbp/verifier-verdict-VSxS3j/raw-output.txt
 * The text below is embedded verbatim (byte-identical to that file).
 *
 * Corridors (feature-dev-merge-worktree natural verify_each layout —
 * implement(loop) → verify adjacent, exactly as bundled; no workflow
 * mutation, the verifier's bundled expects regex:^STATUS:\s*(done|retry)\s*$
 * already accepts both verdict variants):
 *
 *  1. RETRY corridor: two stories; verifier round 1 = the retained KHYG
 *     report (routes as a story retry), verifier rounds 2-3 = plain
 *     'STATUS: done'. Asserted event-led on the isolated run ledger:
 *     - the retry verdict emits NO story.verified and does NOT dispatch the
 *       NEXT story (US-002's story.started only occurs strictly after the
 *       retried story's verification passes);
 *     - the rejected story is retried within budget (story.retry event,
 *       story row retry_count 1 at the end; US-002 untouched at retry 0);
 *     - the implement loop is re-pended (the retried story is re-claimed:
 *       a second story.started for US-001 strictly after story.retry) and
 *       the follow-up plain 'STATUS: done' round verifies the retried story
 *       and advances the run to US-002;
 *     - story.retry retains the findings (its detail carries the whole
 *       retained report, VERIFIED-OK: blocks included);
 *     - normal downstream completion (test_cmd_review auto-completes,
 *       finalize_merge lands) with zero tokens.
 *
 *  2. POSITIVE CONTROL corridor: two stories, verifier always plain
 *     'STATUS: done' — verifies and advances with no story.retry and no
 *     regression on the normal verify_each path.
 *
 * Registration: listed in run-all-scripted-e2e-tests and run-all-e2e-tests.
 *
 * Run via: npm run build && node --test e2e-tests/workflows-verifier-verdict-retry.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  spawnScriptedWorkflowRun,
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
} from "./helpers/scripted-agent.ts";

const fixtureDir = path.join(process.cwd(), "e2e-tests", "fixtures", "sample-project");
const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

// ── Exact retained KHYG verifier report (2026-09-06 02:25 UTC) ───────
// Verbatim from
// /home/igorhvr/idm/tamandua/torture-test/var/review-logs/
//   native-signal-probes.DHNQbp/verifier-verdict-VSxS3j/raw-output.txt
// (read-only evidence). First line 'STATUS: retry'; the hyphenated
// 'VERIFIED-OK:' and parenthesized 'ISSUES (...):' headings do not match
// parseOutputKeyValues' /^([A-Z_]+):\s*(.*)$/ key regex, so pre-VSRP they
// polluted the pending STATUS value and the story was silently approved.
// A faithful verdict MUST read this output as a story retry.
const RETAINED_KHYG_REPORT = `STATUS: retry
VERIFIED-OK:
- Security: .gitignore exists; diff main...HEAD has no .env/*.key/*.pem/*.secret/credentials/node_modules; no credential-like literals in US-004 changed code (only the intentional KHYG-CANARY-SECRET test fixture).
- US-004 product/docs/tests exist at HEAD e70358e3 and mostly pass: harness-launch.ts expired-overall-budget guard in spawnUnprotected (every pre-release fallback route); docs/native-signal-isolation.md + README Security subsection with correct sandbox-exec (not Seatbelt) deprecation attribution and no "removal risk accepted" overclaim; AGENTS.md + tests/serial-files.txt entries; US-001 carries in landlock-helper.test.ts (stage=abi-below-minimum skip classification) and native-build.test.ts (host-independent safety assertions).
- Focused evidence on this Linux rollout host: signal-isolation-compat.test.ts 11/11 pass / 0 skip (real landlock backend usable); npx tsc -p tsconfig.json --noEmit exit 0. No TODOs/placeholders found in changed code.
ISSUES (per COORDINATOR US-004 VERIFIER NOTE 02:22 UTC in the run progress file — it lists these exact items as UNIMPLEMENTED at signed e70358e3 and directs the story retry; each confirmed missing at HEAD):
- signal-isolation-compat.test.ts runChildToCompletion (lines ~158-206): the 30s watchdog (lines 172-185) only group-SIGKILLs a still-live handle and never settles/rejects the promise itself, nor closes owned pipes. If the leader exited while a pipe is held (exitCode !== null), the watchdog does nothing and the promised bound does not exist -> a held pipe strands the test indefinitely. Coordinator: on the bound, settle/reject and close only owned pipes, keeping the still-live-handle kill guard.
- signal-isolation-compat.test.ts probeRealStartup unprotected-fallback branch (lines ~412-418): when the real launch settles as launched + mode=unprotected-fallback, the freshly launched fallback child (outcome.child) is never joined through the bounded collector before the branch returns a skip verdict or throws; the finally (lines ~420-423) then removes the fixture root and restores env while that owned child may still run. Coordinator: settle that owned child before classifying the reason and before fixture/state cleanup.
- signal-isolation-compat.test.ts Mac present-but-unusable classification (KNOWN_UNAVAILABLE_RE line ~371 + probeRealStartup): only regex classification of the fallback reason exists; the US-003-proven two-tier rule is missing (bounded trivial-profile normal nonzero => known host inability/skip; signal death or failure of the REAL profile after the trivial profile succeeds => red). As written, a regex match could blanket-skip an arbitrary real-profile failure and an unmatched present-but-unusable case would go red instead of skipping.
- landlock-helper.test.ts live-handle guards (coordinator 02:13 note): spawnProtected watchdog kill (lines ~120-130) and detectCapability ready===null branch kill (lines ~218-229) call process.kill(-child.pid, "SIGKILL") with no exitCode===null && signalCode===null guard, so a historical PID group can be signaled after the owned child already exited; the READY close check (lines ~146-149) resolves null only when child.exitCode !== null and does not recognize signalCode, so a signal death waits out the 15s timer instead of settling on close.
`;

// ── Shared plumbing (isolated env + daemon + scripted agent) ────────

interface VvrRunContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  scripted: ScriptedAgent;
  daemon: ChildProcess;
}

async function startVvrEnvironment(
  workflowId: string,
  behaviors: ScriptedAgentConfig,
): Promise<VvrRunContext> {
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

async function teardown(ctx: VvrRunContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

/** Append scripted-agent + daemon log diagnostics to a failure. */
function diagnostics(ctx: VvrRunContext): string {
  let daemonLogTail = "(no daemon log)";
  try {
    const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
    const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
    daemonLogTail = lines.slice(-60).join("\n");
  } catch {
    // keep default
  }
  return [
    "── scripted-agent invocations ──",
    ctx.scripted.describe(),
    "── daemon log (last 60 lines) ──",
    daemonLogTail,
  ].join("\n");
}

async function waitForRun(
  ctx: VvrRunContext,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  try {
    return await pollForRunCompletionWithNudge(
      runId,
      baseEnv(ctx.env.homeDir, ctx.env.controlPort),
      timeoutMs,
      1_500,
      ctx.env.tamanduaDir,
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

function readRunEvents(tamanduaDir: string, runId: string): Array<Record<string, unknown>> {
  const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventIndex(events: Array<Record<string, unknown>>, event: string, stepId?: string): number {
  return events.findIndex(
    (e) => e.event === event && (stepId === undefined || e.stepId === stepId),
  );
}

function countEvent(events: Array<Record<string, unknown>>, event: string, stepId?: string): number {
  return events.filter(
    (e) => e.event === event && (stepId === undefined || e.stepId === stepId),
  ).length;
}

/** Launch a worktree-mode workflow run and resolve its full run id. */
async function launchRun(
  ctx: VvrRunContext,
  workflowId: string,
  task: string,
  repoDir: string,
  originalBranch: string,
): Promise<string> {
  const runIdPrefix = await spawnScriptedWorkflowRun(
    [
      "workflow", "run", workflowId, task,
      "--worktree-origin-repository", repoDir,
      "--worktree-origin-ref", originalBranch,
    ],
    baseEnv(ctx.env.homeDir, ctx.env.controlPort),
  );
  return resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);
}

interface StoryRow {
  story_id: string;
  status: string;
  retry_count: number;
}

function assertZeroTokenMotorContract(ctx: VvrRunContext, runId: string): void {
  const run = dbRow<{ status: string; tokens_spent: number }>(
    ctx.env.tamanduaDir,
    "SELECT status, tokens_spent FROM runs WHERE id = ?",
    runId,
  );
  assert.equal(run.status, "completed", `run should complete, got ${run.status}\n${diagnostics(ctx)}`);
  assert.equal(run.tokens_spent, 0, `zero real model tokens expected, got ${run.tokens_spent}\n${diagnostics(ctx)}`);
  const stats = dbRow<{ system_tokens_spent: number }>(
    ctx.env.tamanduaDir,
    "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1",
  );
  assert.equal(stats.system_tokens_spent, 0, `system token tripwire must stay 0 (N1), got ${stats.system_tokens_spent}`);
  assert.equal(
    ctx.scripted.heartbeats().length,
    0,
    `deterministic motor must never spawn without pending work (N2)\n${diagnostics(ctx)}`,
  );
}

function assertAllStepsDone(ctx: VvrRunContext, runId: string, expectedCount: number): void {
  const steps = dbRows<{ step_id: string; status: string }>(
    ctx.env.tamanduaDir,
    "SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index",
    runId,
  );
  assert.equal(steps.length, expectedCount, `expected ${expectedCount} steps, got ${JSON.stringify(steps)}`);
  for (const step of steps) {
    assert.equal(
      step.status,
      "done",
      `step ${step.step_id} should be done, got ${step.status}\n${diagnostics(ctx)}`,
    );
  }
}

// ── RETRY corridor (exact retained KHYG report → story retry) ────────

const RETRY_BRANCH = "feature/vsrp-retry-verdict-scripted";
const RETRY_WORKFLOW = "feature-dev-merge-worktree";
// feature-dev-merge-worktree steps: plan, setup, implement, verify, test,
// test_cmd_review (conditional), finalize_merge.
const RETRY_STEP_COUNT = 7;

function retryCorridorBehaviors(): ScriptedAgentConfig {
  return {
    agents: {
      planner: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          `BRANCH: ${RETRY_BRANCH}`,
          `STORIES_JSON: ${JSON.stringify([
            {
              id: "US-001",
              title: "Retry-verdict story one",
              description: "First story for the VSRP retry-verdict scripted regression.",
              acceptanceCriteria: ["marker-one exists", "Typecheck passes"],
            },
            {
              id: "US-002",
              title: "Retry-verdict story two",
              description: "Second story — the NEXT story that must NOT dispatch while the retry verdict is outstanding.",
              acceptanceCriteria: ["marker-two exists", "Typecheck passes"],
            },
          ])}`,
        ].join("\n"),
      },
      setup: {
        commands: [`git checkout -b ${RETRY_BRANCH}`],
        output: [
          "STATUS: done",
          "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
          "BUILD_CMD: true",
          "TEST_CMD: true",
          "BASELINE: fixture project ready",
        ].join("\n"),
      },
      // 2 stories + 1 verifier retry on story US-001 => 3 developer work
      // rounds. Round 2 (the retry) is a *new* commit so verification can
      // observe the tree advanced in response to the retained findings.
      developer: [
        {
          writes: [{ file: "marker-one.txt", content: "retry-verdict story one\n" }],
          commands: ["git add -A", `git commit -m "feat: US-001 - retry-verdict marker one"`],
          output: [
            "STATUS: done",
            "CHANGES: story US-001 marker added",
            "TESTS: scripted fixture",
          ].join("\n"),
        },
        {
          writes: [{
            file: "marker-one.txt",
            content: "retry-verdict story one (revised after verification feedback)\n",
          }],
          commands: ["git add -A", `git commit -m "feat: US-001 - revise marker one after verification feedback"`],
          output: [
            "STATUS: done",
            "CHANGES: story US-001 revised after verification feedback",
            "TESTS: scripted fixture",
          ].join("\n"),
        },
        {
          writes: [{ file: "marker-two.txt", content: "retry-verdict story two\n" }],
          commands: ["git add -A", `git commit -m "feat: US-002 - retry-verdict marker two"`],
          output: [
            "STATUS: done",
            "CHANGES: story US-002 marker added",
            "TESTS: scripted fixture",
          ].join("\n"),
        },
      ],
      // First invocation (story US-001 verification) is the EXACT retained
      // KHYG report: standalone 'STATUS: retry' followed by VERIFIED-OK: and
      // ISSUES (...) heading blocks. It must route as a story retry — never a
      // silent story.verified. Later invocations are plain 'STATUS: done'.
      verifier: [
        {
          output: RETAINED_KHYG_REPORT,
        },
        {
          output: [
            "STATUS: done",
            "VERIFIED: story one revision confirmed against the marker file",
            "TESTED_TREE: {{gitTree}}",
          ].join("\n"),
        },
        {
          output: [
            "STATUS: done",
            "VERIFIED: story two confirmed against the marker file",
            "TESTED_TREE: {{gitTree}}",
          ].join("\n"),
        },
      ],
      tester: {
        commands: ["{{input.BUILD_CMD}}", "{{input.TEST_CMD}}"],
        output: [
          "STATUS: done",
          "RESULTS: full scripted fixture passes",
          "TESTED_TREE: {{gitTree}}",
        ].join("\n"),
      },
      merger: {
        commands: [
          `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${RETRY_BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "feat: VSRP retry-verdict scripted corridor (squash of ${RETRY_BRANCH})"`,
        ],
        includeCommandOutput: true,
        output: [
          "STATUS: done",
          "REBASED: false",
          "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
        ].join("\n"),
      },
    },
    heartbeatTokens: 0,
    defaultTokens: 0,
  };
}

// ── Positive control corridor (plain STATUS: done everywhere) ────────

const CONTROL_BRANCH = "feature/vsrp-done-verdict-scripted";
const CONTROL_WORKFLOW = "feature-dev-merge-worktree";

function doneControlBehaviors(): ScriptedAgentConfig {
  return {
    agents: {
      planner: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          `BRANCH: ${CONTROL_BRANCH}`,
          `STORIES_JSON: ${JSON.stringify([
            {
              id: "US-001",
              title: "Done-verdict control story one",
              description: "First story for the plain-done positive control.",
              acceptanceCriteria: ["marker-one exists", "Typecheck passes"],
            },
            {
              id: "US-002",
              title: "Done-verdict control story two",
              description: "Second story for the plain-done positive control.",
              acceptanceCriteria: ["marker-two exists", "Typecheck passes"],
            },
          ])}`,
        ].join("\n"),
      },
      setup: {
        commands: [`git checkout -b ${CONTROL_BRANCH}`],
        output: [
          "STATUS: done",
          "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
          "BUILD_CMD: true",
          "TEST_CMD: true",
          "BASELINE: fixture project ready",
        ].join("\n"),
      },
      developer: [
        {
          writes: [{ file: "marker-one.txt", content: "done-verdict control story one\n" }],
          commands: ["git add -A", `git commit -m "feat: US-001 - done-verdict control marker one"`],
          output: [
            "STATUS: done",
            "CHANGES: story US-001 marker added",
            "TESTS: scripted fixture",
          ].join("\n"),
        },
        {
          writes: [{ file: "marker-two.txt", content: "done-verdict control story two\n" }],
          commands: ["git add -A", `git commit -m "feat: US-002 - done-verdict control marker two"`],
          output: [
            "STATUS: done",
            "CHANGES: story US-002 marker added",
            "TESTS: scripted fixture",
          ].join("\n"),
        },
      ],
      // Plain 'STATUS: done' every round: verifies and advances with NO
      // story retry and no regression on the normal verify_each path.
      verifier: [
        {
          output: [
            "STATUS: done",
            "VERIFIED: story one confirmed against the marker file",
            "TESTED_TREE: {{gitTree}}",
          ].join("\n"),
        },
        {
          output: [
            "STATUS: done",
            "VERIFIED: story two confirmed against the marker file",
            "TESTED_TREE: {{gitTree}}",
          ].join("\n"),
        },
      ],
      tester: {
        commands: ["{{input.BUILD_CMD}}", "{{input.TEST_CMD}}"],
        output: [
          "STATUS: done",
          "RESULTS: full scripted fixture passes",
          "TESTED_TREE: {{gitTree}}",
        ].join("\n"),
      },
      merger: {
        commands: [
          `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${CONTROL_BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "feat: VSRP done-verdict positive control (squash of ${CONTROL_BRANCH})"`,
        ],
        includeCommandOutput: true,
        output: [
          "STATUS: done",
          "REBASED: false",
          "MERGED_INTO: {{input.ORIGINAL_BRANCH}}",
        ].join("\n"),
      },
    },
    heartbeatTokens: 0,
    defaultTokens: 0,
  };
}

describe("VSRP US-002: scripted e2e - verifier retry verdict never verifies or advances the next story", { concurrency: 1 }, () => {
  it(
    "feature-dev-merge-worktree: the exact retained KHYG retry report emits no story.verified and no next-story dispatch; a plain STATUS: done round then verifies and advances",
    { timeout: 300_000 },
    async () => {
      let ctx: VvrRunContext | undefined;
      try {
        ctx = await startVvrEnvironment(RETRY_WORKFLOW, retryCorridorBehaviors());
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runId = await launchRun(
          ctx,
          RETRY_WORKFLOW,
          "Exercise the VSRP verifier retry-verdict scripted regression",
          repoDir,
          originalBranch,
        );

        const status = await waitForRun(ctx, runId, 240_000);
        assert.equal(status, "completed", `run should complete, got "${status}"\n${diagnostics(ctx)}`);

        assertAllStepsDone(ctx, runId, RETRY_STEP_COUNT);

        // ── Work-round accounting: 2 stories + 1 retry => 3 developer and
        // 3 verifier rounds; no other agent ran early ──
        assert.equal(
          ctx.scripted.workInvocations("developer").length,
          3,
          `developer: 2 stories + 1 retry => 3 work rounds\n${diagnostics(ctx)}`,
        );
        assert.equal(
          ctx.scripted.workInvocations("verifier").length,
          3,
          `verifier: retained-report retry then two passes => 3 work rounds\n${diagnostics(ctx)}`,
        );
        assert.equal(
          ctx.scripted.workInvocations("reviewer").length,
          0,
          `reviewer must never dispatch (test_cmd_review auto-completes)\n${diagnostics(ctx)}`,
        );
        for (const agent of ["planner", "setup", "tester", "merger"]) {
          assert.equal(
            ctx.scripted.workInvocations(agent).length,
            1,
            `agent ${agent} should do exactly 1 work round\n${diagnostics(ctx)}`,
          );
        }

        // ── Event ledger: one bounded story retry, no false verification ──
        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        const storyList = (e: Record<string, unknown>): string =>
          `${String(e.event)}${e.storyId ? ` story=${String(e.storyId)}` : ""}`;
        const ledger = () => events.map(storyList).join(", ");

        const retryIdx = eventIndex(events, "story.retry");
        const verifiedIdx = events
          .map((e, i) => (e.event === "story.verified" ? i : -1))
          .filter((i) => i >= 0);
        assert.equal(countEvent(events, "story.retry"), 1, `exactly one story.retry; ledger: ${ledger()}`);
        assert.equal(countEvent(events, "story.verified"), 2, `exactly two passing verifications; ledger: ${ledger()}`);
        assert.equal(countEvent(events, "story.done"), 3, "story.done: US-001, US-001 retry, US-002");
        assert.ok(retryIdx >= 0, "a story.retry event must exist");
        assert.equal(
          verifiedIdx.filter((i) => i < retryIdx).length,
          0,
          "NO story.verified may precede the retry verdict — the retained report must never approve the story",
        );

        // The story.retry event retains the FULL findings: the whole
        // retained report (including the VERIFIED-OK: block and the ISSUES
        // (...) findings) becomes the retry feedback.
        const retryEvent = events[retryIdx] as { detail?: string };
        assert.ok(
          retryEvent.detail?.includes("runChildToCompletion") &&
            retryEvent.detail.includes("landlock-helper.test.ts live-handle guards") &&
            retryEvent.detail.includes("VERIFIED-OK:"),
          "story.retry must carry the retained report's findings text",
        );

        // ── No next-story dispatch while the retry verdict is outstanding:
        // the retried story is re-claimed (2nd story.started US-001 strictly
        // after the retry) and the NEXT story (US-002) only starts strictly
        // after the retried story's verification passes ──
        const starts = events
          .map((e, i) => ({ i, storyId: e.storyId as string | undefined, event: e.event as string }))
          .filter((e) => e.event === "story.started" && e.storyId);
        const us001Starts = starts.filter((s) => s.storyId === "US-001").map((s) => s.i);
        const us002Starts = starts.filter((s) => s.storyId === "US-002").map((s) => s.i);
        assert.equal(us001Starts.length, 2, `US-001 must be started twice (attempt + retry); ledger: ${ledger()}`);
        assert.equal(us002Starts.length, 1, `US-002 must be started exactly once; ledger: ${ledger()}`);
        assert.ok(
          us001Starts[1]! > retryIdx,
          `the retried story must be re-claimed after the retry verdict (retry at ${retryIdx}, 2nd US-001 start at ${us001Starts[1]})`,
        );
        const firstVerified = verifiedIdx[0]!;
        assert.ok(
          us002Starts[0]! > firstVerified,
          `the NEXT story must not dispatch while the retry verdict is outstanding — ` +
            `US-002 may only start after the retried story's verification passes ` +
            `(first story.verified at ${firstVerified}, US-002 start at ${us002Starts[0]})`,
        );
        assert.equal(countEvent(events, "step.running", "verify"), 3, "verify claimed once per verification round (retry + 2 passes)");
        assert.equal(countEvent(events, "step.running", "implement"), 3, "implement claimed once per story round (2 stories + 1 retry)");

        // ── Story rows: US-001 done with exactly one bounded retry; the
        // next story US-002 never retried ──
        const stories = dbRows<StoryRow>(
          ctx.env.tamanduaDir,
          "SELECT story_id, status, retry_count FROM stories WHERE run_id = ? ORDER BY story_index",
          runId,
        );
        assert.equal(stories.length, 2, `expected two story rows, got ${JSON.stringify(stories)}`);
        const byId = new Map(stories.map((s) => [s.story_id, s]));
        const first = byId.get("US-001");
        const second = byId.get("US-002");
        assert.ok(first && second, `expected US-001 and US-002 story rows, got ${JSON.stringify(stories)}`);
        assert.equal(first.status, "done", `US-001 should end done, got ${first.status}`);
        assert.equal(second.status, "done", `US-002 should end done, got ${second.status}`);
        assert.equal(first.retry_count, 1, `US-001 should carry one bounded retry, got ${first.retry_count}`);
        assert.equal(second.retry_count, 0, `US-002 should never retry, got ${second.retry_count}`);

        // Verify step row finished done with the story-scoped budget reset;
        // the implement loop ended done with zero story-accounted retries on
        // the step row itself.
        const verifyStep = dbRow<{ status: string; retry_count: number }>(
          ctx.env.tamanduaDir,
          "SELECT status, retry_count FROM steps WHERE run_id = ? AND step_id = 'verify'",
          runId,
        );
        assert.equal(verifyStep.status, "done", `verify step should be done, got ${verifyStep.status}`);
        assert.equal(verifyStep.retry_count, 0, "verify retry_count is story-scoped and resets to 0");
        const implementStep = dbRow<{ status: string; retry_count: number }>(
          ctx.env.tamanduaDir,
          "SELECT status, retry_count FROM steps WHERE run_id = ? AND step_id = 'implement'",
          runId,
        );
        assert.equal(implementStep.status, "done", `implement step should be done, got ${implementStep.status}`);
        assert.equal(implementStep.retry_count, 0, "story-level retries do not bump the loop step retry_count");

        // Downstream completion: conditional test_cmd_review auto-completes
        // after the final story.verified, then finalize_merge lands.
        const lastVerifiedIdx = events.map((e) => e.event).lastIndexOf("story.verified");
        const reviewAutoIdx = eventIndex(events, "step.auto_completed", "test_cmd_review");
        const testerRunningIdx = eventIndex(events, "step.running", "test");
        const finalizeRunningIdx = eventIndex(events, "step.running", "finalize_merge");
        assert.ok(
          testerRunningIdx > lastVerifiedIdx,
          "the integration test step must run after the final verification passes",
        );
        assert.ok(
          reviewAutoIdx > testerRunningIdx && finalizeRunningIdx > testerRunningIdx,
          "test_cmd_review auto-completes and finalize_merge dispatches after the test step",
        );

        assertZeroTokenMotorContract(ctx, runId);

        // ── Repository outcome: the retry revision and both markers landed
        // on the original branch ──
        const markerOne = execSync(`git show "refs/heads/${originalBranch}:marker-one.txt"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.ok(
          markerOne.includes("revised after verification feedback"),
          `marker-one.txt should carry the retry revision:\n${markerOne}`,
        );
        execSync(`git show "refs/heads/${originalBranch}:marker-two.txt"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        const mergeStep = dbRow<{ status: string; output: string }>(
          ctx.env.tamanduaDir,
          "SELECT status, output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
          runId,
        );
        assert.equal(mergeStep.status, "done");
        assert.match(mergeStep.output, /^STATUS: landed$/m);

        console.log(
          `[vsrp e2e retry corridor] run ${runId.slice(0, 8)} completed: retained KHYG report routed as retry ` +
            `(no false story.verified, no next-story dispatch), retried story verified on the plain done round, 0 tokens`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "feature-dev-merge-worktree (positive control): plain STATUS: done verifier output verifies and advances with no story retry",
    { timeout: 300_000 },
    async () => {
      let ctx: VvrRunContext | undefined;
      try {
        ctx = await startVvrEnvironment(CONTROL_WORKFLOW, doneControlBehaviors());
        const repoDir = prepareGitRepo(fixtureDir, path.join(ctx.env.root, "origin-repo"));
        const { branch: originalBranch } = detachOriginCheckout(repoDir);
        const runId = await launchRun(
          ctx,
          CONTROL_WORKFLOW,
          "Exercise the VSRP plain-done positive control",
          repoDir,
          originalBranch,
        );

        const status = await waitForRun(ctx, runId, 240_000);
        assert.equal(status, "completed", `run should complete, got "${status}"\n${diagnostics(ctx)}`);

        assertAllStepsDone(ctx, runId, RETRY_STEP_COUNT);

        // 2 stories, no retry: developer and verifier each do exactly 2 work
        // rounds; no other agent ran early.
        assert.equal(
          ctx.scripted.workInvocations("developer").length,
          2,
          `developer: 2 stories => 2 work rounds\n${diagnostics(ctx)}`,
        );
        assert.equal(
          ctx.scripted.workInvocations("verifier").length,
          2,
          `verifier: 2 passes => 2 work rounds\n${diagnostics(ctx)}`,
        );
        assert.equal(
          ctx.scripted.workInvocations("reviewer").length,
          0,
          `reviewer must never dispatch (test_cmd_review auto-completes)\n${diagnostics(ctx)}`,
        );
        for (const agent of ["planner", "setup", "tester", "merger"]) {
          assert.equal(
            ctx.scripted.workInvocations(agent).length,
            1,
            `agent ${agent} should do exactly 1 work round\n${diagnostics(ctx)}`,
          );
        }

        // Every story verified on the first pass; zero retries anywhere.
        const events = readRunEvents(ctx.env.tamanduaDir, runId);
        assert.equal(countEvent(events, "story.retry"), 0, "no story.retry on the plain-done path");
        assert.equal(countEvent(events, "story.verified"), 2, "both stories verify and advance");
        assert.equal(countEvent(events, "story.started"), 2, "each story started exactly once");
        assert.equal(countEvent(events, "step.running", "verify"), 2);
        const lastVerifiedIdx = events.map((e) => e.event).lastIndexOf("story.verified");
        const testerRunningIdx = eventIndex(events, "step.running", "test");
        assert.ok(
          lastVerifiedIdx < testerRunningIdx,
          "the final verification must precede the integration test step",
        );

        const stories = dbRows<StoryRow>(
          ctx.env.tamanduaDir,
          "SELECT story_id, status, retry_count FROM stories WHERE run_id = ? ORDER BY story_index",
          runId,
        );
        assert.equal(stories.length, 2, `expected two story rows, got ${JSON.stringify(stories)}`);
        for (const story of stories) {
          assert.equal(story.status, "done", `story ${story.story_id} should end done, got ${story.status}`);
          assert.equal(story.retry_count, 0, `story ${story.story_id} should carry zero retries, got ${story.retry_count}`);
        }

        assertZeroTokenMotorContract(ctx, runId);

        // Repository outcome: both markers landed on the original branch.
        execSync(`git show "refs/heads/${originalBranch}:marker-one.txt"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        execSync(`git show "refs/heads/${originalBranch}:marker-two.txt"`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
        const mergeStep = dbRow<{ status: string; output: string }>(
          ctx.env.tamanduaDir,
          "SELECT status, output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
          runId,
        );
        assert.equal(mergeStep.status, "done");
        assert.match(mergeStep.output, /^STATUS: landed$/m);

        console.log(
          `[vsrp e2e done control] run ${runId.slice(0, 8)} completed: plain STATUS: done verified and advanced ` +
            `both stories with no retry, 0 tokens`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );
});
