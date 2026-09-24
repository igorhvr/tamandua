/**
 * `tamandua run diagnose` Full-Pipeline E2E (DIAG-PRUNE US-012) —
 * fast, ZERO model tokens.
 *
 * Drives the REAL CLI against a TERMINAL scripted run and asserts the
 * read-only diagnostics bundle contract end to end:
 *
 *   1. a completed scripted `do-now` run (REAL daemon → scheduler → harness
 *      spawn → step-ops, with TAMANDUA_PI_BINARY pointed at the deterministic
 *      scripted agent — no models, no tokens) is diagnosed through the real
 *      `tamandua run diagnose` CLI in both the text and `--json` forms;
 *   2. the bundle directory exists and carries the required files
 *      (run.json, steps.json, events.jsonl, summary.json, SUMMARY.md);
 *   3. the run row (status + tokens_spent) is UNCHANGED after diagnosing,
 *      proving the command is read-only;
 *   4. a terminal run whose event/evidence sources are absent (a synthetic
 *      failed run with no event stream, no evidence dir and no Matchlock
 *      evidence) is diagnosed with exit 0 and the bundle reports explicit
 *      `absent` markers instead of throwing.
 *
 * TEST ISOLATION: each case owns a temp HOME, random ports, its own daemon
 * (case 1) or no daemon at all (case 2, the command never starts one), and its
 * own state dir. It never touches default ports 3334/3338/3339.
 *
 * Run via: ./run-all-scripted-e2e-tests (or ./run-all-e2e-tests).
 * NOT part of `npm test`; lives under e2e-tests/.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
} from "./helpers/scripted-agent.ts";

const WORKFLOW_ID = "do-now"; // single agent (`doer`), single step (`execute`)
const TASK =
  "run-diagnose e2e: do not modify files or run commands other than the " +
  "tamandua step commands. Reply with STATUS: done and REPORT: diagnose e2e ok.";

/** The bundle files the story requires for a terminal scripted run. */
const REQUIRED_BUNDLE_FILES = [
  "run.json",
  "steps.json",
  "events.jsonl",
  "summary.json",
  "SUMMARY.md",
] as const;

interface RunRow {
  status: string;
  tokens_spent: number;
}

interface RunDiagnoseContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  daemon: ChildProcess;
}

/** Append daemon-log + run-event diagnostics to a failure. */
function diagnostics(ctx: RunDiagnoseContext, runId?: string): string {
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
  return ["── daemon log (last 40 lines) ──", daemonLogTail, "── run events (last 20) ──", events].join("\n");
}

/** Read the run row's status and attributed spend. */
function readRunRow(tamanduaDir: string, runId: string): RunRow {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const row = db
      .prepare("SELECT status, tokens_spent FROM runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    assert.ok(row, `run row ${runId} must exist`);
    return { status: row.status, tokens_spent: row.tokens_spent };
  } finally {
    db.close();
  }
}

/** Insert a synthetic terminal run row (used by the absent-sources case). */
function insertSyntheticRun(tamanduaDir: string, runId: string): void {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, 1, WORKFLOW_ID, "absent sources", "failed", "{}", 0, now, now);
  } finally {
    db.close();
  }
}

/**
 * Wait until the run's closing `run.tokens.final` event lands (scheduler
 * teardown emits it AFTER the final round's usage is attributed). This makes
 * the read-only snapshot stable: without it, the final round's attribution
 * could land between the pre- and post-diagnose reads and look like a
 * mutation. A timeout is not fatal — the caller still compares the row.
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

async function startScriptedEnvironment(): Promise<RunDiagnoseContext> {
  const env = await createTempHome();
  const behaviors: ScriptedAgentConfig = {
    // One successful single-step round; defaultTokens gives a positive,
    // attributable spend so the read-only check compares a non-trivial value.
    agents: { doer: { output: "STATUS: done\nREPORT: diagnose e2e ok" } },
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

async function teardown(ctx: RunDiagnoseContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

describe("run diagnose e2e (DIAG-PRUNE US-012)", { concurrency: 1 }, () => {
  it(
    "diagnoses a terminal scripted run read-only (text + --json) and writes the required bundle files",
    { timeout: 180_000 },
    async () => {
      let ctx: RunDiagnoseContext | undefined;
      try {
        ctx = await startScriptedEnvironment();
        const workdir = path.join(ctx.env.root, "diagnose-workdir");
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

        // Let the closing attribution settle so the read-only snapshot cannot
        // race the final round's token accounting.
        await waitForRunTokensFinal(ctx.env.tamanduaDir, runId);
        const before = readRunRow(ctx.env.tamanduaDir, runId);
        assert.equal(before.status, "completed");

        // ── text form ──────────────────────────────────────────────
        const textOut = path.join(ctx.env.root, "diagnose-text-out");
        const textRun = cli(
          ["run", "diagnose", runId, "--out", textOut],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        assert.equal(
          textRun.status,
          0,
          `run diagnose (text) must exit 0: ${textRun.stderr || textRun.stdout}`,
        );
        const bundlePath = path.join(textOut, runId);
        assert.ok(
          textRun.stdout.includes(`Bundle: ${bundlePath}`),
          `text output must print the bundle path, got: ${textRun.stdout}`,
        );
        assert.ok(
          fs.statSync(bundlePath).isDirectory(),
          `bundle directory ${bundlePath} must exist`,
        );
        for (const name of REQUIRED_BUNDLE_FILES) {
          const file = path.join(bundlePath, name);
          assert.ok(fs.existsSync(file), `bundle must contain ${name}`);
          assert.ok(fs.statSync(file).size > 0, `bundle file ${name} must be non-empty`);
        }
        // The run-scoped event stream is present and real (not the absent marker).
        const eventsText = fs.readFileSync(path.join(bundlePath, "events.jsonl"), "utf-8");
        assert.ok(eventsText.trim().length > 0, "events.jsonl must not be empty");
        assert.doesNotMatch(eventsText, /"absent":true/, "terminal run events must be present");
        const summary = JSON.parse(
          fs.readFileSync(path.join(bundlePath, "summary.json"), "utf-8"),
        ) as { runId?: string };
        assert.equal(summary.runId, runId, "summary must name the diagnosed run");

        // ── --json form ────────────────────────────────────────────
        const jsonOut = path.join(ctx.env.root, "diagnose-json-out");
        const jsonRun = cli(
          ["run", "diagnose", runId, "--out", jsonOut, "--json"],
          baseEnv(ctx.env.homeDir, ctx.env.controlPort),
        );
        assert.equal(
          jsonRun.status,
          0,
          `run diagnose --json must exit 0: ${jsonRun.stderr || jsonRun.stdout}`,
        );
        assert.equal(
          jsonRun.stdout.trim().split("\n").length,
          1,
          `--json must print exactly one line, got: ${JSON.stringify(jsonRun.stdout)}`,
        );
        const parsed = JSON.parse(jsonRun.stdout.trim()) as {
          runId?: string;
          bundlePath?: string;
          summary?: { runId?: string };
        };
        assert.equal(parsed.runId, runId, "--json must report the diagnosed run id");
        assert.equal(
          parsed.bundlePath,
          path.join(jsonOut, runId),
          "--json must report the bundle path",
        );
        assert.equal(parsed.summary?.runId, runId, "--json summary must name the run");
        assert.ok(
          fs.statSync(parsed.bundlePath as string).isDirectory(),
          "--json bundle directory must exist",
        );

        // ── READ-ONLY: the run row is untouched ────────────────────
        const after = readRunRow(ctx.env.tamanduaDir, runId);
        assert.deepEqual(
          after,
          before,
          "run diagnose must not mutate the run row (status/tokens_spent)",
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "reports explicit absent markers with exit 0 for a terminal run whose event/evidence sources are absent",
    { timeout: 60_000 },
    async () => {
      // No daemon is started for this case: `run diagnose` must work while the
      // daemon is stopped. A synthetic terminal run row has no event stream,
      // no evidence directory and no Matchlock evidence.
      const env = await createTempHome();
      try {
        // Force the isolated DB schema into existence (the command never
        // creates it) before inserting the synthetic run row.
        cliMustSucceed(["status"], baseEnv(env.homeDir, env.controlPort), "status");
        const runId = "11111111-2222-3333-4444-555555555555";
        insertSyntheticRun(env.tamanduaDir, runId);

        const outDir = path.join(env.root, "diagnose-absent-out");
        const result = cli(
          ["run", "diagnose", runId, "--out", outDir],
          baseEnv(env.homeDir, env.controlPort),
        );
        assert.equal(
          result.status,
          0,
          `run diagnose must exit 0 for absent sources: ${result.stderr || result.stdout}`,
        );

        const bundlePath = path.join(outDir, runId);
        assert.ok(fs.statSync(bundlePath).isDirectory(), "bundle directory must exist");

        // events: explicit absent marker line, never a throw.
        const events = fs.readFileSync(path.join(bundlePath, "events.jsonl"), "utf-8");
        assert.match(events, /"absent":\s*true/, "events.jsonl must carry an explicit absent marker");

        // daemon log: explicit absent marker line.
        const daemonLog = fs.readFileSync(path.join(bundlePath, "daemon-log.txt"), "utf-8");
        assert.match(daemonLog, /absent/, "daemon-log.txt must carry an explicit absent marker");

        // evidence: absent with a reason.
        const evidence = JSON.parse(
          fs.readFileSync(path.join(bundlePath, "evidence.json"), "utf-8"),
        ) as { status?: string; absenceReason?: string };
        assert.equal(evidence.status, "absent", "evidence must report absent");
        assert.ok(evidence.absenceReason, "evidence absent entry must carry a reason");

        // matchlock: absent with a reason (native run, no VM evidence).
        const matchlock = JSON.parse(
          fs.readFileSync(path.join(bundlePath, "matchlock.json"), "utf-8"),
        ) as { status?: string; absenceReason?: string; policyStatus?: string };
        assert.equal(matchlock.status, "absent", "matchlock must report absent");
        assert.equal(matchlock.policyStatus, "absent", "native run has no matchlock policy");
        assert.ok(matchlock.absenceReason, "matchlock absent entry must carry a reason");

        // summary still renders and names the missing sources.
        const summaryMd = fs.readFileSync(path.join(bundlePath, "SUMMARY.md"), "utf-8");
        assert.match(summaryMd, /events: absent/, "SUMMARY.md must report the absent sources");
        assert.ok(
          result.stdout.includes(`Bundle: ${bundlePath}`),
          `text output must print the bundle path, got: ${result.stdout}`,
        );
      } finally {
        cleanupTempHome(env);
      }
    },
  );
});