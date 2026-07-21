/**
 * CONC: Concurrent-runs stress test — 8 simultaneous bug-fix-merge-worktree
 * pipelines against the SAME origin repository.
 *
 * DIAGNOSTIC ONLY — no product-code changes. This test exercises Tamandua
 * under high run-concurrency and reports what it reveals (retry counts,
 * rugpull relaunches, abandonments, dispatch rounds).
 *
 * Architecture: 8 isolated daemons, each running ONE bug-fix-merge-worktree
 * run against the shared origin repo. Each daemon has its own single-feature
 * scripted agent config, avoiding the work-counter/behavior-array mismatch
 * that occurs when 8 runs share one behavior array under one daemon.
 *
 * Uses the same scripted-agent infrastructure as workflows-scripted.test.ts:
 *   - Isolated daemons (temp HOME, random ports)
 *   - Scripted agents (ZERO tokens, deterministic)
 *   - Nudge-based polling (fast, no 15s dispatch interval wait)
 *
 * Run via:  ./run-all-scripted-e2e-tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
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
  preserveE2eTestHome,
  releasePortReservations,
} from "./helpers/smoke-helpers.ts";
import {
  startIsolatedDaemon,
  stopIsolatedDaemon,
} from "./helpers/e2e-helpers.ts";
import {
  createScriptedAgent,
  type ScriptedAgent,
  type ScriptedAgentConfig,
} from "./helpers/scripted-agent.ts";
import { cleanChildEnv } from "../tests/helpers/test-env.ts";

const repoRoot = process.cwd();
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");
const fixtureDir = path.join(process.cwd(), "e2e-tests", "fixtures", "sample-project-concurrent");

// ── Terminal statuses ──────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["completed", "done", "failed", "canceled"]);

// ── Feature metadata (one per concurrent run) ──────────────────────

interface FeatureInfo {
  n: number;
  file: string;
  branch: string;
  funcName: string;
  fixFind: string;
  fixReplace: string;
}

interface MergeEvent {
  event: "merge.landed" | "merge.target_moved" | "merge.conflicts";
  runId: string;
  origin: string;
  branch: string;
  target: string;
  expectedTip: string;
  actualTip?: string;
  mergedTree?: string;
  mergedCommit?: string;
  checkoutRefresh?: string;
}

const FEATURE_COUNT = 8;

function featureInfo(n: number): FeatureInfo {
  const infos: Record<number, Omit<FeatureInfo, "n" | "branch">> = {
    1: {
      file: "src/feature-1.ts",
      funcName: "concat",
      fixFind: "return a; // BUG: should be a + b",
      fixReplace: "return a + b;",
    },
    2: {
      file: "src/feature-2.ts",
      funcName: "double",
      fixFind: "return n + 2; // BUG: should be n * 2",
      fixReplace: "return n * 2;",
    },
    3: {
      file: "src/feature-3.ts",
      funcName: "greet",
      fixFind: 'return name; // BUG: should return "Hello, " + name + "!"',
      fixReplace: 'return "Hello, " + name + "!";',
    },
    4: {
      file: "src/feature-4.ts",
      funcName: "multiply",
      fixFind: "return a + b; // BUG: should be a * b",
      fixReplace: "return a * b;",
    },
    5: {
      file: "src/feature-5.ts",
      funcName: "isEven",
      fixFind: "return n % 2 !== 0; // BUG: should be n % 2 === 0",
      fixReplace: "return n % 2 === 0;",
    },
    6: {
      file: "src/feature-6.ts",
      funcName: "capitalize",
      fixFind: "return s; // BUG: should return s[0].toUpperCase() + s.slice(1)",
      fixReplace: "return s[0].toUpperCase() + s.slice(1);",
    },
    7: {
      file: "src/feature-7.ts",
      funcName: "strip",
      fixFind: "return s; // BUG: should return s.trim()",
      fixReplace: "return s.trim();",
    },
    8: {
      file: "src/feature-8.ts",
      funcName: "absolute",
      fixFind: "return n; // BUG: should return Math.abs(n)",
      fixReplace: "return Math.abs(n);",
    },
  };
  const info = infos[n];
  return { n, branch: `confix-feature-${n}`, ...info };
}

// ── Build single-feature behavior config ───────────────────────────

function buildFeatureBehaviors(fi: FeatureInfo): ScriptedAgentConfig {
  const branch = fi.branch;

  return {
    agents: {
      triager: {
        output: [
          "STATUS: done",
          "REPO: {{cwd}}",
          `BRANCH: ${branch}`,
          "SEVERITY: high",
          `AFFECTED_AREA: ${fi.file}`,
          `REPRODUCTION: ${fi.funcName}() is broken — see test failures`,
          `PROBLEM_STATEMENT: ${fi.funcName}() in ${fi.file} is incorrectly implemented`,
        ].join("\n"),
      },
      investigator: {
        output: [
          "STATUS: done",
          `ROOT_CAUSE: ${fi.funcName}() in ${fi.file} has a logic error`,
          `FIX_APPROACH: fix the implementation in ${fi.file}`,
        ].join("\n"),
      },
      setup: {
        commands: [`git checkout -b ${branch}`],
        output: [
          "STATUS: done",
          "ORIGINAL_BRANCH: {{input.ORIGINAL_BRANCH}}",
          "BUILD_CMD: true",
          "TEST_CMD: true",
          `BASELINE: ${fi.funcName}() is broken as reported`,
        ].join("\n"),
      },
      fixer: {
        edits: [{ file: fi.file, find: fi.fixFind, replace: fi.fixReplace }],
        commands: [
          "git add -A",
          `git commit -m "fix: correct ${fi.funcName}() implementation"`,
        ],
        output: [
          "STATUS: done",
          `CHANGES: fixed ${fi.funcName}() in ${fi.file}`,
          `REGRESSION_TEST: existing test in test/feature-${fi.n}.test.ts`,
        ].join("\n"),
      },
      verifier: {
        output: [
          "STATUS: done",
          `VERIFIED: ${fi.funcName}() in ${fi.file} now works correctly`,
          "TESTED_TREE: scripted-concurrent-tree",
        ].join("\n"),
      },
      merger: {
        commands: [
          `expected_tip=$(git -C "{{input.WORKTREE_ORIGIN_REPOSITORY}}" rev-parse "refs/heads/{{input.ORIGINAL_BRANCH}}") && TAMANDUA_RUN_ID="{{input.RUN_ID}}" "${process.execPath}" "${cliPath}" merge-branch --origin "{{input.WORKTREE_ORIGIN_REPOSITORY}}" --branch "${branch}" --into "{{input.ORIGINAL_BRANCH}}" --expect-tip "$expected_tip" --message "fix: correct ${fi.funcName}() (squash of ${branch})"`,
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
}

// ── Per-run environment ────────────────────────────────────────────

interface RunEnv {
  env: Awaited<ReturnType<typeof createTempHome>>;
  scripted: ScriptedAgent;
  daemon: ChildProcess;
}

async function createRunEnv(fi: FeatureInfo): Promise<RunEnv> {
  const env = await createTempHome();
  const behaviors = buildFeatureBehaviors(fi);
  const scripted = createScriptedAgent(env.root, behaviors);
  cliMustSucceed(
    ["workflow", "install", "bug-fix-merge-worktree"],
    baseEnv(env.homeDir, env.controlPort),
    `install bug-fix-merge-worktree for feature-${fi.n}`,
  );
  await releasePortReservations(env);
  const daemon = await startIsolatedDaemon(
    env.homeDir,
    env.controlPort,
    scripted.env,
  );
  return { env, scripted, daemon };
}

// ── Diagnostics ───────────────────────────────────────────────────

function dbRow<T>(tamanduaDir: string, sql: string, ...params: (string | number)[]): T {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

function dbRows<T>(tamanduaDir: string, sql: string, ...params: (string | number)[]): T[] {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function collectDiagnostics(
  runEnvs: RunEnv[],
  runIds: string[],
  wallMs: number,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  CONCURRENT STRESS TEST — CONCURRENCY CHURN PROFILE");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push(`Total wall time: ${(wallMs / 1000).toFixed(1)}s`);
  lines.push(`Run count: ${runEnvs.length}`);
  lines.push("");

  // Per-run statuses
  const statuses: Record<string, number> = {};
  for (const [i, runEnv] of runEnvs.entries()) {
    const rid = runIds[i];
    const run = dbRow<{ status: string; tokens_spent: number }>(
      runEnv.env.tamanduaDir,
      "SELECT status, tokens_spent FROM runs WHERE id = ?",
      rid,
    );
    statuses[run.status] = (statuses[run.status] || 0) + 1;
  }
  lines.push("Run statuses:");
  for (const [status, count] of Object.entries(statuses).sort()) {
    lines.push(`  ${status}: ${count}`);
  }
  lines.push("");

  // Per-run step details
  lines.push("Per-run step details:");
  for (const [i, runEnv] of runEnvs.entries()) {
    const rid = runIds[i];
    const fi = featureInfo(i + 1);
    const steps = dbRows<{ step_id: string; status: string; retry_count: number }>(
      runEnv.env.tamanduaDir,
      "SELECT step_id, status, retry_count FROM steps WHERE run_id = ? ORDER BY step_index",
      rid,
    );
    const stepSummary = steps
      .map((s) => `${s.step_id}=${s.status}(r${s.retry_count})`)
      .join(" ");
    lines.push(`  ${fi.branch}: ${stepSummary}`);
  }
  lines.push("");

  // Rugpull events across all daemons
  let rugpullCount = 0;
  for (const [i, runEnv] of runEnvs.entries()) {
    const rid = runIds[i];
    const eventsPath = path.join(runEnv.env.tamanduaDir, "events", `${rid}.jsonl`);
    if (fs.existsSync(eventsPath)) {
      const eventLines = fs.readFileSync(eventsPath, "utf-8").split(/\r?\n/).filter(Boolean);
      rugpullCount += eventLines.filter((l) => l.includes('"run.rugpull_relaunched"')).length;
    }
  }
  let timeoutCount = 0;
  let abandonedCount = 0;
  for (const [i, runEnv] of runEnvs.entries()) {
    const rid = runIds[i];
    const eventsPath = path.join(runEnv.env.tamanduaDir, "events", `${rid}.jsonl`);
    if (fs.existsSync(eventsPath)) {
      const eventLines = fs.readFileSync(eventsPath, "utf-8").split(/\r?\n/).filter(Boolean);
      timeoutCount += eventLines.filter((l) => l.includes('"step.timeout"')).length;
      abandonedCount += eventLines.filter((l) => l.includes('"story.abandoned"')).length;
    }
  }
  lines.push(`Rugpull relaunches: ${rugpullCount}`);
  lines.push(`Step timeouts: ${timeoutCount}`);
  lines.push(`Story abandonments: ${abandonedCount}`);
  lines.push("");

  // Work invocation counts
  let totalWork = 0;
  let totalHeartbeats = 0;
  const workByAgent: Record<string, number> = {};
  for (const runEnv of runEnvs) {
    totalWork += runEnv.scripted.workInvocations().length;
    totalHeartbeats += runEnv.scripted.heartbeats().length;
    for (const inv of runEnv.scripted.workInvocations()) {
      const a = inv.shortAgent ?? "unknown";
      workByAgent[a] = (workByAgent[a] || 0) + 1;
    }
  }
  lines.push(`Total dispatch rounds (scripted-agent work invocations): ${totalWork}`);
  if (Object.keys(workByAgent).length > 0) {
    lines.push("  By agent:");
    for (const [agent, count] of Object.entries(workByAgent).sort()) {
      lines.push(`    ${agent}: ${count}`);
    }
  }
  lines.push(`Heartbeat rounds (should be 0): ${totalHeartbeats}`);
  lines.push("");

  // N1 tripwire: system_tokens_spent across all daemons
  let totalSystemTokens = 0;
  for (const runEnv of runEnvs) {
    const stats = dbRow<{ system_tokens_spent: number }>(
      runEnv.env.tamanduaDir,
      "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1",
    );
    if (stats) totalSystemTokens += stats.system_tokens_spent;
  }
  lines.push(`System tokens spent across all ${runEnvs.length} daemons (N1 — should be 0): ${totalSystemTokens}`);

  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  END CONCURRENCY CHURN PROFILE");
  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}

// ── Poll all runs concurrently with nudge ──────────────────────────

async function pollAllRunsWithNudge(
  runEnvs: RunEnv[],
  runIds: string[],
  timeoutMs: number,
  nudgeIntervalMs = 1_500,
  onPoll?: () => void,
): Promise<Map<string, string>> {
  const startedAt = Date.now();
  const statuses = new Map<string, string>();
  const pending = new Set(runIds.map((_, i) => i));

  while (Date.now() - startedAt < timeoutMs && pending.size > 0) {
    onPoll?.();
    for (const i of [...pending]) {
      const runEnv = runEnvs[i];
      const runId = runIds[i];
      const env = baseEnv(runEnv.env.homeDir, runEnv.env.controlPort);
      const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
        env: cleanChildEnv(env),
        encoding: "utf-8",
      });
      const output = result.stdout || result.stderr || "";
      const statusMatch = output.match(/^Status:\s+(\S+)/m);
      if (statusMatch) {
        const status = statusMatch[1];
        statuses.set(runId, status);
        if (TERMINAL_STATUSES.has(status)) {
          pending.delete(i);
        }
      }
    }

    if (pending.size === 0) break;

    // Nudge each daemon
    for (const i of pending) {
      const runEnv = runEnvs[i];
      spawnSync(process.execPath, [cliPath, "nudge"], {
        env: cleanChildEnv(baseEnv(runEnv.env.homeDir, runEnv.env.controlPort)),
        encoding: "utf-8",
      });
    }

    await sleep(nudgeIntervalMs);
  }

  // Final status check
  for (const i of runEnvs.keys()) {
    const runEnv = runEnvs[i];
    const runId = runIds[i];
    if (!statuses.has(runId)) {
      const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
        env: cleanChildEnv(baseEnv(runEnv.env.homeDir, runEnv.env.controlPort)),
        encoding: "utf-8",
      });
      const output = result.stdout || result.stderr || "";
      const statusMatch = output.match(/^Status:\s+(\S+)/m);
      statuses.set(runId, statusMatch ? statusMatch[1] : "unknown");
    }
  }

  return statuses;
}

// ── Test ───────────────────────────────────────────────────────────

describe("concurrent-runs stress test", { concurrency: 1 }, () => {
  it(
    "CONC: 8 simultaneous bug-fix-merge-worktree runs against the same origin repo",
    { timeout: 600_000 },
    async () => {
      const testSlug = "stress-concurrent-8-runs";
      const runEnvs: RunEnv[] = [];
      const runIds: string[] = [];

      try {
        // ── Prepare shared origin repo ─────────────────────────────
        const tempRoot = tamanduaTempDir("tamandua-e2e-concurrent-");
        const repoDir = prepareGitRepo(fixtureDir, path.join(tempRoot, "origin-repo"));
        const { branch: originalBranch, tip: originTip, tree: originTree } = detachOriginCheckout(repoDir);
        const initialTip = execSync(`git rev-parse "refs/heads/${originalBranch}"`, { cwd: repoDir, encoding: "utf-8" }).trim();
        const originIndexBefore = execSync("git write-tree", { cwd: repoDir, encoding: "utf-8" }).trim();
        const sampledOriginIndexTrees = new Set([originIndexBefore]);

        // ── Create 8 isolated daemon environments ──────────────────
        for (let i = 1; i <= FEATURE_COUNT; i++) {
          const fi = featureInfo(i);
          const runEnv = await createRunEnv(fi);
          runEnvs.push(runEnv);
        }

        // ── Launch all 8 runs concurrently ─────────────────────────
        const launchStartedAt = Date.now();
        const prefixes = await Promise.all(
          runEnvs.map((runEnv, i) => {
            const fi = featureInfo(i + 1);
            const desc = `${fi.funcName}() in ${fi.file} is broken`;
            return spawnWorkflowRun(
              [
                "workflow",
                "run",
                "bug-fix-merge-worktree",
                desc,
                "--worktree-origin-repository",
                repoDir,
                "--worktree-origin-ref",
                originalBranch,
              ],
              baseEnv(runEnv.env.homeDir, runEnv.env.controlPort),
            );
          }),
        );
        console.log(
          `[stress-concurrent] All ${FEATURE_COUNT} runs launched in ${Date.now() - launchStartedAt}ms`,
        );

        // ── Resolve full run IDs ───────────────────────────────────
        for (let i = 0; i < runEnvs.length; i++) {
          const rid = resolveFullRunId(prefixes[i], runEnvs[i].env.tamanduaDir);
          runIds.push(rid);
        }
        console.log(
          `[stress-concurrent] Run IDs: ${runIds.map((id) => id.slice(0, 8)).join(", ")}`,
        );

        // ── Poll all runs to completion ────────────────────────────
        const wallStartedAt = Date.now();
        const statuses = await pollAllRunsWithNudge(
          runEnvs,
          runIds,
          540_000, // 9-minute poll timeout (test timeout is 600s)
          1_500,
          () => {
            const sample = spawnSync("git", ["write-tree"], { cwd: repoDir, encoding: "utf-8" });
            if (sample.status === 0) sampledOriginIndexTrees.add(sample.stdout.trim());
          },
        );
        const wallMs = Date.now() - wallStartedAt;

        // ── Assert: all runs completed ────────────────────────────
        const failStatuses: string[] = [];
        for (let i = 0; i < runEnvs.length; i++) {
          const status = statuses.get(runIds[i]) ?? "unknown";
          if (status !== "completed" && status !== "done") {
            failStatuses.push(`feature-${i + 1} (${runIds[i].slice(0, 8)}): ${status}`);
          }
        }
        assert.equal(
          failStatuses.length,
          0,
          `All ${FEATURE_COUNT} runs should reach 'completed', but got:\n` +
            failStatuses.join("\n"),
        );

        // ── Assert: no run failed ─────────────────────────────────
        for (let i = 0; i < runEnvs.length; i++) {
          const status = statuses.get(runIds[i]) ?? "unknown";
          assert.ok(
            status === "completed" || status === "done",
            `Run feature-${i + 1} (${runIds[i].slice(0, 8)}): "${status}" is not "completed"`,
          );
        }

        // ── Assert: all 8 changes present in the target ref ──────
        for (let i = 1; i <= FEATURE_COUNT; i++) {
          const fi = featureInfo(i);
          const fileContent = execSync(`git show "refs/heads/${originalBranch}:${fi.file}"`, {
            cwd: repoDir,
            encoding: "utf-8",
          });
          assert.ok(
            !fileContent.includes(fi.fixFind),
            `${fi.file} in target ref still contains bug:\n${fileContent.slice(0, 200)}`,
          );
        }

        const fsckResult = spawnSync("git", ["fsck", "--no-dangling"], {
          cwd: repoDir,
          encoding: "utf-8",
        });
        assert.equal(
          fsckResult.status,
          0,
          `git fsck reported errors in origin repo:\n${fsckResult.stderr || fsckResult.stdout}`,
        );
        assert.ok(
          !fsckResult.stderr.includes("error:") && !fsckResult.stdout.includes("error:"),
          `git fsck found errors in origin repo`,
        );

        // ── Assert: target history is exactly 8 single-parent squash commits ─
        const targetHistory = execSync(`git rev-list --first-parent "refs/heads/${originalBranch}"`, {
          cwd: repoDir,
          encoding: "utf-8",
        }).trim().split("\n");
        assert.equal(targetHistory.length, 1 + FEATURE_COUNT);
        assert.equal(targetHistory.at(-1), initialTip);
        const targetLandingCommits = new Set(targetHistory.slice(0, FEATURE_COUNT));
        const targetHistoryTrees = new Set(
          targetHistory.map((commit) =>
            execSync(`git rev-parse "${commit}^{tree}"`, { cwd: repoDir, encoding: "utf-8" }).trim(),
          ),
        );
        targetHistoryTrees.add(originIndexBefore);
        sampledOriginIndexTrees.add(
          execSync("git write-tree", { cwd: repoDir, encoding: "utf-8" }).trim(),
        );
        for (const sampledTree of sampledOriginIndexTrees) {
          assert.ok(
            targetHistoryTrees.has(sampledTree),
            `origin index sample ${sampledTree} is not the pre-merge tree or a committed target-history tree`,
          );
        }
        for (const commit of targetLandingCommits) {
          const commitWithParents = execSync(`git rev-list --parents -n 1 "${commit}"`, {
            cwd: repoDir,
            encoding: "utf-8",
          }).trim().split(/\s+/);
          assert.equal(
            commitWithParents.length,
            2,
            `squash commit ${commit} must have exactly one parent`,
          );
          assert.match(
            execSync(`git show -s --format=%s "${commit}"`, { cwd: repoDir, encoding: "utf-8" }),
            /^fix: correct /,
          );
        }

        // ── Assert: no progress-* files leaked into origin repo ──
        const progressFiles = fs.readdirSync(repoDir).filter((f) => f.startsWith("progress-"));
        assert.equal(
          progressFiles.length,
          0,
          `origin repo contains leaked progress files: ${progressFiles.join(", ")}`,
        );

        // ── Motor contract: deterministic dispatch (N1, N2) ──────
        let totalHeartbeats = 0;
        let totalSystemTokens = 0;
        for (const runEnv of runEnvs) {
          totalHeartbeats += runEnv.scripted.heartbeats().length;
          const stats = dbRow<{ system_tokens_spent: number }>(
            runEnv.env.tamanduaDir,
            "SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1",
          );
          if (stats) totalSystemTokens += stats.system_tokens_spent;
        }
        assert.equal(
          totalHeartbeats,
          0,
          `deterministic motor must never spawn a harness without pending work (N2) — ` +
            `got ${totalHeartbeats} heartbeat invocations`,
        );
        assert.equal(
          totalSystemTokens,
          0,
          `idle dispatch must spend zero system tokens (N1) — got ${totalSystemTokens}`,
        );

        // ── Per-run work rounds: CAS losers may loop through verify + merge ─
        const AGENTS = ["triager", "investigator", "setup", "fixer", "verifier", "merger"];
        for (const agent of AGENTS) {
          let total = 0;
          for (const runEnv of runEnvs) {
            total += runEnv.scripted.workInvocations(agent).length;
          }
          if (agent === "verifier" || agent === "merger") {
            assert.ok(
              total >= FEATURE_COUNT,
              `agent ${agent} should have at least ${FEATURE_COUNT} work rounds across all runs, got ${total}`,
            );
          } else {
            assert.equal(
              total,
              FEATURE_COUNT,
              `agent ${agent} should have exactly ${FEATURE_COUNT} work rounds across all runs, got ${total}`,
            );
          }
        }

        // ── Assert: every step in every run is 'done' ─────────────
        let targetMovedEvents = 0;
        const eventLandingCommits = new Set<string>();
        for (let i = 0; i < runEnvs.length; i++) {
          const runEnv = runEnvs[i];
          const rid = runIds[i];
          const fi = featureInfo(i + 1);
          const steps = dbRows<{ step_id: string; status: string }>(
            runEnv.env.tamanduaDir,
            "SELECT step_id, status FROM steps WHERE run_id = ? ORDER BY step_index",
            rid,
          );
          assert.equal(
            steps.length,
            6,
            `feature-${i + 1}: expected 6 steps, got ${steps.length}`,
          );
          for (const step of steps) {
            assert.equal(
              step.status,
              "done",
              `feature-${i + 1} step ${step.step_id} should be done, got ${step.status}`,
            );
          }
          const mergeOutput = dbRow<{ output: string }>(
            runEnv.env.tamanduaDir,
            "SELECT output FROM steps WHERE run_id = ? AND step_id = 'finalize_merge'",
            rid,
          ).output;
          assert.match(mergeOutput, /^STATUS: landed$/m);
          const mergedCommit = mergeOutput.match(/^MERGED_COMMIT: ([0-9a-f]+)$/m)?.[1];
          const mergedTree = mergeOutput.match(/^MERGED_TREE: ([0-9a-f]+)$/m)?.[1];
          assert.ok(mergedCommit, `feature-${i + 1}: missing MERGED_COMMIT`);
          assert.ok(mergedTree, `feature-${i + 1}: missing MERGED_TREE`);
          assert.match(mergeOutput, new RegExp(`^TARGET: refs/heads/${originalBranch}$`, "m"));
          const outputRefresh = mergeOutput.match(/^CHECKOUT_REFRESH: (.+)$/m)?.[1];
          assert.equal(
            outputRefresh,
            "not-applicable",
            `feature-${i + 1}: detached origin should report CHECKOUT_REFRESH not-applicable, got ${outputRefresh}`,
          );
          const mergeEvents = fs
            .readFileSync(path.join(runEnv.env.tamanduaDir, "events", `${rid}.jsonl`), "utf-8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as MergeEvent)
            .filter((event) => event.event.startsWith("merge."));
          for (const event of mergeEvents) {
            assert.equal(event.runId, rid);
            assert.equal(event.origin, repoDir);
            assert.equal(event.branch, fi.branch);
            assert.equal(event.target, `refs/heads/${originalBranch}`);
            assert.match(event.expectedTip, /^[0-9a-f]+$/);
          }
          const landedEvents = mergeEvents.filter((event) => event.event === "merge.landed");
          const movedEvents = mergeEvents.filter((event) => event.event === "merge.target_moved");
          assert.equal(landedEvents.length, 1);
          assert.equal(mergeEvents.filter((event) => event.event === "merge.conflicts").length, 0);
          assert.equal(landedEvents[0].mergedCommit, mergedCommit);
          assert.equal(landedEvents[0].mergedTree, mergedTree);
          assert.equal(landedEvents[0].checkoutRefresh, "not-applicable");
          assert.ok(targetLandingCommits.has(mergedCommit));
          eventLandingCommits.add(mergedCommit);
          for (const event of movedEvents) {
            assert.match(event.actualTip ?? "", /^[0-9a-f]+$/);
            assert.notEqual(event.actualTip, event.expectedTip);
          }
          assert.equal(
            runEnv.scripted.workInvocations("merger").length,
            movedEvents.length + 1,
            `feature-${i + 1}: every target_moved must lead to one merger retry`,
          );
          assert.equal(
            runEnv.scripted.workInvocations("verifier").length,
            movedEvents.length + 1,
            `feature-${i + 1}: every target_moved must loop through verifier before retry`,
          );
          targetMovedEvents += movedEvents.length;
        }
        if (targetMovedEvents === 0) {
          console.log(
            "[stress-concurrent] NOTE: no merge.target_moved CAS retries observed; deterministic retry coverage passed separately",
          );
        }
        assert.deepEqual([...eventLandingCommits].sort(), [...targetLandingCommits].sort());

        // Once all mergers are quiescent, the origin checkout remains detached
        // at the pre-run tip. Successful landing calls update only the target
        // ref; the detached origin HEAD, index, and working tree stay unchanged.
        assert.notEqual(
          spawnSync("git", ["symbolic-ref", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).status,
          0,
          "origin HEAD should remain detached after all runs",
        );
        assert.equal(
          execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim(),
          originTip,
          "origin detached HEAD should remain at the pre-run tip",
        );
        assert.equal(
          execSync("git write-tree", { cwd: repoDir, encoding: "utf-8" }).trim(),
          originTree,
          "origin index should be unchanged after all runs",
        );
        const finalStatus = execSync("git status --porcelain", { cwd: repoDir, encoding: "utf-8" });
        assert.equal(finalStatus, "", `origin checkout should be clean after all runs:\n${finalStatus}`);

        // ── Diagnostics report ────────────────────────────────────
        const report = collectDiagnostics(runEnvs, runIds, wallMs);
        console.log(report);

        // ── Cleanup on success ────────────────────────────────────
        for (const runEnv of runEnvs) {
          cleanupTempHome(runEnv.env);
        }
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      } catch (err) {
        // Preserve forensics on failure (last runEnv's root for now)
        if (runEnvs.length > 0) {
          preserveE2eTestHome(runEnvs[0].env.root, testSlug);
        }
        throw err;
      } finally {
        for (const runEnv of runEnvs) {
          try {
            await stopIsolatedDaemon(runEnv.daemon);
          } catch {
            // best-effort
          }
        }
      }
    },
  );
});
