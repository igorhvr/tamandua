/**
 * `tamandua evidence prune` Full-Pipeline E2E (DIAG-PRUNE US-016) —
 * fast, ZERO model tokens, MANUAL command.
 *
 * Drives the REAL CLI against a terminal scripted run and asserts the manual
 * evidence-prune contract end to end:
 *
 *   1. a completed scripted `do-now` run (REAL daemon → scheduler → harness
 *      spawn → step-ops, with TAMANDUA_PI_BINARY pointed at the deterministic
 *      scripted agent — no models, no tokens) is diagnosed through the real
 *      `tamandua run diagnose` CLI so a real diagnostics bundle exists inside
 *      the state dir;
 *   2. `tamandua evidence prune --older-than 0` (DRY RUN, the default) lists
 *      the diagnostics bundle, the evidence directory and the suite-ledger log
 *      but deletes nothing;
 *   3. `tamandua evidence prune --older-than 0 --yes` removes exactly those
 *      eligible artifacts while the run/step/story rows, the suite_results
 *      rows, the event stream (`<state>/events/*`) and the daemon log
 *      (`<state>/tamandua.log`) are byte-for-byte unchanged;
 *   4. a LIVE run's evidence is refused: a second scripted run whose agent
 *      hangs after claiming its step keeps the run 'running', its evidence
 *      directory survives a `--yes` prune and the run is reported as refused.
 *
 * TEST ISOLATION: each case owns a temp HOME, random ports, its own daemon and
 * its own state dir. It never touches default ports 3334/3338/3339.
 *
 * Run via: ./run-all-scripted-e2e-tests (or ./run-all-e2e-tests).
 * NOT part of `npm test`; lives under e2e-tests/.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  createTempHome,
  baseEnv,
  cli,
  cliMustSucceed,
  spawnScriptedWorkflowRun as spawnWorkflowRun,
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
  type ScriptedAgentConfig,
  type ScriptedBehavior,
} from "./helpers/scripted-agent.ts";

const WORKFLOW_ID = "do-now"; // single agent (`doer`), single step (`execute`)
const TASK =
  "evidence-prune e2e: do not modify files or run commands other than the " +
  "tamandua step commands. Reply with STATUS: done and REPORT: prune e2e ok.";

interface PruneContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  daemon: ChildProcess;
}

interface RunRow {
  status: string;
  scheduling_status: string | null;
  tokens_spent: number;
  updated_at: string;
}

interface SuiteRow {
  id: number;
  run_id: string | null;
  log_path: string | null;
  exit_code: number;
}

/** Full plan/execution JSON shape emitted by `evidence prune --json`. */
interface PruneItemJson {
  kind: string;
  runId: string;
  bareRunId: string;
  path: string;
  sizeBytes: number;
  action: "remove" | "keep";
  reason: string;
}

interface PruneJson {
  dryRun: boolean;
  olderThanMs: number;
  items: PruneItemJson[];
  refusals: Array<{ runId?: string; bareRunId?: string; reason: string }>;
  totals: { removeCount: number; keepCount: number; removeBytes: number };
  removed?: PruneItemJson[];
  skipped?: PruneItemJson[];
  failed?: Array<{ item: PruneItemJson; error: string }>;
}

/** Read the run row's status/scheduling/spend/instant. */
function readRunRow(tamanduaDir: string, runId: string): RunRow {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const row = db
      .prepare(
        "SELECT status, scheduling_status, tokens_spent, updated_at FROM runs WHERE id = ?",
      )
      .get(runId) as RunRow | undefined;
    assert.ok(row, `run row ${runId} must exist`);
    return row;
  } finally {
    db.close();
  }
}

/** Insert a suite-ledger row plus its full `<id>.log` file for the run. */
function insertSuiteLedger(
  tamanduaDir: string,
  runId: string,
): { id: number; logPath: string } {
  const suiteLogsDir = path.join(tamanduaDir, "suite-logs");
  fs.mkdirSync(suiteLogsDir, { recursive: true });
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const now = new Date().toISOString();
    const info = db
      .prepare(
        "INSERT INTO suite_results " +
          "(origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, log_path, run_id, step_id, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "prune-e2e-origin",
        "tree-hash",
        "cmd-hash",
        "npm test",
        0,
        123,
        "ℹ tests 1",
        null,
        runId,
        null,
        now,
      );
    const id = Number(info.lastInsertRowid);
    const logPath = path.join(suiteLogsDir, `${id}.log`);
    fs.writeFileSync(logPath, "suite log for prune e2e\n", "utf-8");
    db.prepare("UPDATE suite_results SET log_path = ? WHERE id = ?").run(logPath, id);
    return { id, logPath };
  } finally {
    db.close();
  }
}

/** SHA-256 of a file's bytes, or null when it does not exist. */
function hashFileIfPresent(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Snapshot the DB rows and files that prune must never touch. */
function snapshotInvariants(tamanduaDir: string, runId: string) {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const run = db
      .prepare(
        "SELECT status, scheduling_status, tokens_spent, updated_at FROM runs WHERE id = ?",
      )
      .get(runId) as RunRow;
    const steps = db
      .prepare("SELECT COUNT(*) AS c FROM steps WHERE run_id = ?")
      .get(runId) as { c: number };
    const stories = db
      .prepare("SELECT COUNT(*) AS c FROM stories WHERE run_id = ?")
      .get(runId) as { c: number };
    const suite = db
      .prepare(
        "SELECT id, run_id, log_path, exit_code FROM suite_results WHERE run_id = ? ORDER BY id",
      )
      .all(runId) as unknown as SuiteRow[];
    return {
      run,
      steps: steps.c,
      stories: stories.c,
      suite,
      runEvents: hashFileIfPresent(path.join(tamanduaDir, "events", `${runId}.jsonl`)),
      globalEvents: hashFileIfPresent(path.join(tamanduaDir, "events", "all.jsonl")),
      daemonLog: hashFileIfPresent(path.join(tamanduaDir, "tamandua.log")),
    };
  } finally {
    db.close();
  }
}

/** Append daemon-log + run-event diagnostics to a failure. */
function diagnostics(ctx: PruneContext, runId?: string): string {
  let daemonLogTail = "(no daemon log)";
  try {
    const logPath = path.join(ctx.env.tamanduaDir, "tamandua.log");
    const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
    daemonLogTail = lines.slice(-40).join("\n");
  } catch {
    // keep default
  }
  let events = "(no events)";
  if (runId) {
    try {
      events = fs
        .readFileSync(path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`), "utf-8")
        .trimEnd()
        .split("\n")
        .slice(-20)
        .join("\n");
    } catch {
      // keep default
    }
  }
  return [
    "── daemon log (last 40 lines) ──",
    daemonLogTail,
    "── run events (last 20) ──",
    events,
  ].join("\n");
}

/**
 * Wait until the run's closing `run.tokens.final` event lands (scheduler
 * teardown emits it AFTER the final round's usage is attributed). This keeps
 * the invariant snapshots stable: without it the final round's attribution
 * could land between the pre- and post-prune reads and look like a mutation.
 */
async function waitForRunTokensFinal(
  tamanduaDir: string,
  runId: string,
  timeoutMs = 45_000,
): Promise<void> {
  const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const lines = fs.readFileSync(eventsPath, "utf-8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          if ((JSON.parse(line) as { event?: string }).event === "run.tokens.final") return;
        } catch {
          // torn/corrupt line — keep scanning
        }
      }
    } catch {
      // event file not there yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Poll until a run row reaches `running` (the hang-after-claim round). */
async function waitForRunRunning(
  tamanduaDir: string,
  runId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
    try {
      const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
        | { status: string }
        | undefined;
      if (row?.status === "running") return;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`run ${runId} did not reach 'running' within ${timeoutMs}ms`);
}

async function startScriptedEnvironment(doer: ScriptedBehavior): Promise<PruneContext> {
  const env = await createTempHome();
  const behaviors: ScriptedAgentConfig = {
    agents: { doer },
    defaultTokens: 111,
  };
  const scripted = createScriptedAgent(env.root, behaviors);
  cliMustSucceed(
    ["workflow", "install", WORKFLOW_ID],
    baseEnv(env.homeDir, env.controlPort),
    `install ${WORKFLOW_ID}`,
  );
  await releasePortReservations(env);
  const daemon = await startIsolatedDaemon(env.homeDir, env.controlPort, scripted.env);
  return { env, daemon };
}

async function teardown(ctx: PruneContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

/** Run the first scripted run to completion and return its bare run id. */
async function completeScriptedRun(ctx: PruneContext, workdir: string): Promise<string> {
  const runIdPrefix = await spawnWorkflowRun(
    [
      "workflow",
      "run",
      WORKFLOW_ID,
      TASK,
      "--working-directory-for-harness",
      workdir,
    ],
    baseEnv(ctx.env.homeDir, ctx.env.controlPort),
    30_000,
    workdir,
  );
  const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);

  let status: string;
  try {
    status = await pollForRunCompletionWithNudge(
      runId,
      baseEnv(ctx.env.homeDir, ctx.env.controlPort),
      120_000,
      undefined,
      ctx.env.tamanduaDir,
    );
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n${diagnostics(ctx, runId)}`,
    );
  }
  assert.equal(
    status,
    "completed",
    `scripted ${WORKFLOW_ID} run must complete, got "${status}"\n${diagnostics(ctx, runId)}`,
  );
  await waitForRunTokensFinal(ctx.env.tamanduaDir, runId);
  return runId;
}

function parsePruneJson(text: string): PruneJson {
  assert.equal(
    text.trim().split("\n").length,
    1,
    `--json must print exactly one line, got: ${JSON.stringify(text)}`,
  );
  return JSON.parse(text.trim()) as PruneJson;
}

function removeItemsFor(json: PruneJson, artifactPath: string): PruneItemJson[] {
  return json.items.filter(
    (item) => path.resolve(item.path) === path.resolve(artifactPath),
  );
}

describe("evidence prune e2e (DIAG-PRUNE US-016)", { concurrency: 1 }, () => {
  it(
    "dry-run lists bundle/evidence/suite-log without deleting, and --yes removes only eligible paths while rows/events/daemon log are untouched",
    { timeout: 180_000 },
    async () => {
      let ctx: PruneContext | undefined;
      try {
        ctx = await startScriptedEnvironment({
          output: "STATUS: done\nREPORT: prune e2e ok",
        });
        const workdir = path.join(ctx.env.root, "prune-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        const runId = await completeScriptedRun(ctx, workdir);
        const tamanduaDir = ctx.env.tamanduaDir;

        // ── eligible artifacts the plan must list ──────────────────
        // An evidence directory for the terminal run.
        const evidenceDir = path.join(tamanduaDir, "runs", runId);
        fs.mkdirSync(evidenceDir, { recursive: true });
        const evidenceFile = path.join(evidenceDir, "evidence.txt");
        fs.writeFileSync(evidenceFile, "evidence for prune e2e\n", "utf-8");

        // A suite-ledger row plus its full log file.
        const ledger = insertSuiteLedger(tamanduaDir, runId);
        assert.ok(fs.existsSync(ledger.logPath), "suite-ledger log file must exist");

        // A real diagnostics bundle assembled by the real `run diagnose` CLI
        // (written under <state>/diagnostics so the planner can map it).
        const diagnose = cli(
          ["run", "diagnose", runId, "--out", path.join(tamanduaDir, "diagnostics")],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        assert.equal(
          diagnose.status,
          0,
          `run diagnose must exit 0: ${diagnose.stderr || diagnose.stdout}`,
        );
        const bundleDir = path.join(tamanduaDir, "diagnostics", runId);
        assert.ok(
          fs.statSync(bundleDir).isDirectory(),
          `diagnostics bundle ${bundleDir} must exist`,
        );

        const expectedPaths = [bundleDir, evidenceDir, ledger.logPath].sort();

        // ── snapshot everything prune must not touch ───────────────
        const before = snapshotInvariants(tamanduaDir, runId);

        // ── dry run: lists every eligible artifact, deletes nothing ─
        const dryRun = cli(
          ["evidence", "prune", "--older-than", "0", "--json"],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        assert.equal(
          dryRun.status,
          0,
          `evidence prune dry-run must exit 0: ${dryRun.stderr || dryRun.stdout}`,
        );
        const dryJson = parsePruneJson(dryRun.stdout);
        assert.equal(dryJson.dryRun, true, "default must be a dry run");
        assert.equal(dryJson.olderThanMs, 0);

        for (const expected of expectedPaths) {
          const matches = removeItemsFor(dryJson, expected);
          assert.equal(
            matches.length,
            1,
            `dry-run must list exactly one remove item for ${expected}: ${JSON.stringify(dryJson.items)}`,
          );
          assert.equal(matches[0].action, "remove", `${expected} must be eligible`);
        }
        // Dry run deletes nothing.
        for (const expected of expectedPaths) {
          assert.ok(fs.existsSync(expected), `dry run must not delete ${expected}`);
        }
        assert.deepEqual(
          snapshotInvariants(tamanduaDir, runId),
          before,
          "a dry run must not mutate rows/events/daemon log",
        );

        // ── execute: removes exactly the eligible paths ────────────
        const execute = cli(
          ["evidence", "prune", "--older-than", "0", "--yes", "--json"],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        assert.equal(
          execute.status,
          0,
          `evidence prune --yes must exit 0: ${execute.stderr || execute.stdout}`,
        );
        const execJson = parsePruneJson(execute.stdout);
        assert.equal(execJson.dryRun, false);
        assert.ok(Array.isArray(execJson.removed), "--yes JSON must include removed items");
        assert.deepEqual(
          (execJson.removed ?? []).map((item) => path.resolve(item.path)).sort(),
          expectedPaths,
          "only the eligible artifacts may be removed",
        );
        assert.equal((execJson.failed ?? []).length, 0, "no artifact may fail to remove");
        for (const expected of expectedPaths) {
          assert.ok(!fs.existsSync(expected), `${expected} must be gone after --yes`);
        }

        // ── the invariant surface is byte-for-byte unchanged ───────
        const after = snapshotInvariants(tamanduaDir, runId);
        assert.deepEqual(after, before, "prune must not touch rows/events/daemon log");
        assert.equal(after.run.status, "completed");
        assert.ok(after.suite.length >= 1, "the suite_results row must survive");
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "refuses a live run: a running run's evidence survives a --yes prune and is reported as refused",
    { timeout: 120_000 },
    async () => {
      let ctx: PruneContext | undefined;
      try {
        // The agent claims its step and then hangs, so the run stays
        // 'running' for the duration of the prune.
        ctx = await startScriptedEnvironment({ mode: "hang-after-claim" });
        const workdir = path.join(ctx.env.root, "prune-live-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            WORKFLOW_ID,
            TASK,
            "--working-directory-for-harness",
            workdir,
          ],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
          30_000,
          workdir,
        );
        const runId = resolveFullRunId(runIdPrefix, ctx.env.tamanduaDir);
        await waitForRunRunning(ctx.env.tamanduaDir, runId);
        assert.equal(readRunRow(ctx.env.tamanduaDir, runId).status, "running");

        // The live run's evidence directory that must survive the prune.
        const evidenceDir = path.join(ctx.env.tamanduaDir, "runs", runId);
        fs.mkdirSync(evidenceDir, { recursive: true });
        const evidenceFile = path.join(evidenceDir, "live-evidence.txt");
        fs.writeFileSync(evidenceFile, "live run evidence\n", "utf-8");

        const result = cli(
          ["evidence", "prune", "--older-than", "0", "--yes", "--json"],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        assert.equal(
          result.status,
          0,
          `evidence prune --yes must exit 0: ${result.stderr || result.stdout}`,
        );
        const json = parsePruneJson(result.stdout);

        // The live run must be listed as refused, and never as removed.
        assert.ok(
          json.refusals.some(
            (refusal) => refusal.runId === runId || refusal.bareRunId === runId,
          ),
          `live run ${runId} must be reported as refused: ${JSON.stringify(json.refusals)}`,
        );
        assert.ok(
          !(json.removed ?? []).some(
            (item) => path.resolve(item.path) === path.resolve(evidenceDir),
          ),
          "a live run's evidence directory must never be removed",
        );
        const evidenceItems = removeItemsFor(json, evidenceDir);
        assert.equal(evidenceItems.length, 1, "the live evidence dir must appear in the plan");
        assert.equal(evidenceItems[0].action, "keep", "the live evidence dir must be kept");

        assert.ok(
          fs.existsSync(evidenceFile),
          "the live run's evidence file must survive the --yes prune",
        );
        assert.equal(readRunRow(ctx.env.tamanduaDir, runId).status, "running");
      } finally {
        await teardown(ctx);
      }
    },
  );
});