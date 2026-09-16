/**
 * GIDN US-008 — scripted full-pipeline e2e proving the run's ONE commit
 * identity reaches every harness round environment and a commit made inside
 * the run worktree.
 *
 * This tier drives the REAL daemon → scheduler → harness spawn → step-ops →
 * pipeline-advance → worktree/merge path with `TAMANDUA_PI_BINARY` pointed at
 * the deterministic scripted agent (e2e-tests/helpers/scripted-agent.ts). No
 * models are invoked and ZERO tokens are spent.
 *
 * The run is launched with GIT_USER_NAME/GIT_USER_EMAIL set in the CLI process
 * env, so `resolveGitIdentity` resolves source "env" (the highest-precedence
 * tier). The developer's scripted round then, inside the run worktree:
 *   1. writes the four GIT_AUTHOR / GIT_COMMITTER vars the round env carries
 *      to a test-owned record file OUTSIDE the worktree (the worktree may be
 *      removed at terminal), and
 *   2. creates a real commit and appends its `git log -1 --format=%an|%ae|%cn|%ce`
 *      identity to the same record file.
 *
 * Assertions (acceptance criteria US-008):
 *   - run.started gitIdentity and runs.context carry the env-resolved identity
 *     with source "env";
 *   - the recorded round env's four vars equal that identity;
 *   - the committed author/committer equal that identity;
 *   - the zero-token motor contract holds (no heartbeat spawns, 0 tokens).
 * As extra GIDN evidence, the landed squash commit on the origin target branch
 * is authored and committed by the same resolved identity.
 *
 * Registration: listed in run-all-scripted-e2e-tests and run-all-e2e-tests.
 *
 * Run via: npm run build && node --test e2e-tests/workflows-round-git-identity.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const WORKFLOW_ID = "feature-dev-merge-worktree";
const BRANCH = "feature/gidn-e2e-round-identity";
// plan, setup, implement, verify, test, test_cmd_review (conditional), finalize_merge
const STEP_COUNT = 7;

/** The identity the run must resolve from the env tier. */
const IDENTITY = {
  name: "GIDN E2E Author",
  email: "gidn-e2e@example.test",
};

// ── Shared plumbing (isolated env + daemon + scripted agent) ────────

interface GidnRunContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  scripted: ScriptedAgent;
  daemon: ChildProcess;
  recordFile: string;
}

/** Append scripted-agent + daemon log diagnostics to a failure. */
function diagnostics(ctx: GidnRunContext): string {
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
  ctx: GidnRunContext,
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

/** Parse the record file: KEY=VALUE round-env lines plus the commit line. */
function parseRecord(text: string): { values: Record<string, string>; commit: string } {
  const values: Record<string, string> = {};
  let commit = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq > 0) {
      values[line.slice(0, eq)] = line.slice(eq + 1);
    } else {
      commit = line;
    }
  }
  return { values, commit };
}

// ── Scripted behaviors ──────────────────────────────────────────────

/**
 * One-story feature-dev-merge-worktree pipeline. The developer round records
 * the round env identity and creates a real commit in the worktree.
 */
function roundIdentityBehaviors(recordFile: string): ScriptedAgentConfig {
  // Runs with the harness round env (applyBehaviorActions spawns `bash -c`
  // with process.env, which the scheduler populated with the run identity),
  // in the harness worktree as cwd.
  const recordCommand = [
    `record="${recordFile}"`,
    "{",
    '  echo "GIT_AUTHOR_NAME=$GIT_AUTHOR_NAME"',
    '  echo "GIT_AUTHOR_EMAIL=$GIT_AUTHOR_EMAIL"',
    '  echo "GIT_COMMITTER_NAME=$GIT_COMMITTER_NAME"',
    '  echo "GIT_COMMITTER_EMAIL=$GIT_COMMITTER_EMAIL"',
    '} > "$record"',
    "git add -A",
    'git commit --allow-empty -m "feat: GIDN E2E round identity probe"',
    `git log -1 --format='%an|%ae|%cn|%ce' >> "$record"`,
  ].join("\n");

  return {
    agents: {
      planner: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          `BRANCH: ${BRANCH}`,
          `STORIES_JSON: ${JSON.stringify([
            {
              id: "US-001",
              title: "GIDN round identity story",
              description:
                "Single story whose developer round records the round-env identity and commits in the worktree.",
              acceptanceCriteria: ["identity is recorded", "Typecheck passes"],
            },
          ])}`,
        ].join("\n"),
      },
      setup: {
        commands: [`git checkout -b ${BRANCH}`],
        output: [
          "STATUS: done",
          "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
          "BUILD_CMD: true",
          "TEST_CMD: true",
          "BASELINE: fixture project ready",
        ].join("\n"),
      },
      developer: {
        writes: [{ file: "gidn-marker.txt", content: "GIDN e2e round identity\n" }],
        commands: [recordCommand],
        output: [
          "STATUS: done",
          "CHANGES: GIDN e2e marker added and identity recorded",
          "TESTS: scripted fixture",
        ].join("\n"),
      },
      verifier: {
        output: [
          "STATUS: done",
          "VERIFIED: GIDN marker present in the worktree",
          "TESTED_TREE: {{gitTree}}",
        ].join("\n"),
      },
      tester: {
        commands: ["{{input.BUILD_CMD}}", "{{input.TEST_CMD}}"],
        output: [
          "STATUS: done",
          "RESULTS: scripted fixture passes",
          "TESTED_TREE: {{gitTree}}",
        ].join("\n"),
      },
      merger: {
        commands: [
          `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${BRANCH}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "feat: GIDN e2e round identity (squash of ${BRANCH})"`,
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

// ── Tests ───────────────────────────────────────────────────────────

describe(
  "GIDN US-008: scripted e2e proves round env and worktree commit identity",
  { concurrency: 1 },
  () => {
    it(
      "feature-dev-merge-worktree: the round env and worktree commit carry the env-resolved GIT_USER identity",
      { timeout: 300_000 },
      async () => {
        let ctx: GidnRunContext | undefined;
        try {
          const env = await createTempHome();
          const recordFile = path.join(env.root, "gidn-round-identity.txt");
          const scripted = createScriptedAgent(env.root, roundIdentityBehaviors(recordFile));

          cliMustSucceed(
            ["workflow", "install", WORKFLOW_ID],
            baseEnv(env.homeDir, env.controlPort),
            `install ${WORKFLOW_ID}`,
          );
          await releasePortReservations(env);
          const daemon = await startIsolatedDaemon(env.homeDir, env.controlPort, scripted.env);
          ctx = { env, scripted, daemon, recordFile };

          const repoDir = prepareGitRepo(fixtureDir, path.join(env.root, "origin-repo"));
          const { branch: originalBranch } = detachOriginCheckout(repoDir);

          // The launch environment carries the identity: resolveGitIdentity
          // must pick the env tier (NOT the fixture repo-local
          // "Tamandua E2E Test <test@tamandua.local>" config).
          const runEnv = {
            ...baseEnv(env.homeDir, env.controlPort),
            GIT_USER_NAME: IDENTITY.name,
            GIT_USER_EMAIL: IDENTITY.email,
          };
          const runIdPrefix = await spawnScriptedWorkflowRun(
            [
              "workflow",
              "run",
              WORKFLOW_ID,
              "Prove the resolved run identity reaches the worktree round environment and a worktree commit",
              "--worktree-origin-repository",
              repoDir,
              "--worktree-origin-ref",
              originalBranch,
            ],
            runEnv,
          );
          const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

          const status = await waitForRun(ctx, runId, 240_000);
          assert.equal(
            status,
            "completed",
            `run should complete, got "${status}"\n${diagnostics(ctx)}`,
          );

          // ── The run identity resolved from the env tier and was recorded ──
          const events = readRunEvents(env.tamanduaDir, runId);
          const started = events.find((e) => e.event === "run.started");
          assert.ok(started, `run.started event must exist; events: ${events.map((e) => e.event).join(", ")}`);
          const gitIdentity = started.gitIdentity as
            | { name?: string; email?: string; source?: string }
            | undefined;
          assert.ok(gitIdentity, "run.started must carry gitIdentity");
          assert.equal(gitIdentity.name, IDENTITY.name, "run.started identity name");
          assert.equal(gitIdentity.email, IDENTITY.email, "run.started identity email");
          assert.equal(gitIdentity.source, "env", "the launch env must win the identity resolution");

          const runRow = dbRow<{ context: string; tokens_spent: number; status: string }>(
            env.tamanduaDir,
            "SELECT context, tokens_spent, status FROM runs WHERE id = ?",
            runId,
          );
          const runContext = JSON.parse(runRow.context) as Record<string, unknown>;
          assert.equal(runContext.git_identity_name, IDENTITY.name, "runs.context git_identity_name");
          assert.equal(runContext.git_identity_email, IDENTITY.email, "runs.context git_identity_email");
          assert.equal(runContext.git_identity_source, "env", "runs.context git_identity_source");

          // ── The recorded round env + worktree commit identity ──
          assert.ok(
            fs.existsSync(recordFile),
            `the developer round must have written ${recordFile}\n${diagnostics(ctx)}`,
          );
          const record = parseRecord(fs.readFileSync(recordFile, "utf-8"));
          assert.equal(
            record.values.GIT_AUTHOR_NAME,
            IDENTITY.name,
            "round env GIT_AUTHOR_NAME must equal the resolved identity",
          );
          assert.equal(
            record.values.GIT_AUTHOR_EMAIL,
            IDENTITY.email,
            "round env GIT_AUTHOR_EMAIL must equal the resolved identity",
          );
          assert.equal(
            record.values.GIT_COMMITTER_NAME,
            IDENTITY.name,
            "round env GIT_COMMITTER_NAME must equal the resolved identity",
          );
          assert.equal(
            record.values.GIT_COMMITTER_EMAIL,
            IDENTITY.email,
            "round env GIT_COMMITTER_EMAIL must equal the resolved identity",
          );
          assert.equal(
            record.commit,
            `${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}`,
            "the worktree commit author/committer must equal the resolved identity",
          );

          // ── Bonus GIDN evidence: the landing squash commit uses the same
          // run identity (resolveRunGitIdentity from runs.context) ──
          const landed = spawnSync(
            "git",
            ["-C", repoDir, "log", "-1", "--format=%an|%ae|%cn|%ce", `refs/heads/${originalBranch}`],
            { encoding: "utf-8" },
          );
          assert.equal(landed.status, 0, `git log on the origin target failed: ${landed.stderr}`);
          assert.equal(
            landed.stdout.trim(),
            `${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}`,
            "the landed squash commit must be authored/committed by the resolved run identity",
          );

          // ── All steps done + zero-token motor contract ──
          const steps = dbRows<{ step_id: string; status: string }>(
            env.tamanduaDir,
            "SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index",
            runId,
          );
          assert.equal(
            steps.length,
            STEP_COUNT,
            `expected ${STEP_COUNT} steps, got ${JSON.stringify(steps)}`,
          );
          for (const step of steps) {
            assert.equal(step.status, "done", `step ${step.step_id} should be done, got ${step.status}`);
          }
          assert.equal(
            runRow.tokens_spent,
            0,
            `scripted e2e must spend zero model tokens, got ${runRow.tokens_spent}`,
          );
          assert.equal(
            ctx.scripted.heartbeats().length,
            0,
            `deterministic motor must never spawn without pending work (N2)\n${diagnostics(ctx)}`,
          );
        } finally {
          if (ctx) {
            try {
              await stopIsolatedDaemon(ctx.daemon);
            } catch {
              // best-effort
            }
            cleanupTempHome(ctx.env);
          }
        }
      },
    );
  },
);
