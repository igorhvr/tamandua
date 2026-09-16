/**
 * Launch-Time Harness Probe E2E (IFLB US-006) — fast, ZERO model tokens
 *
 * This tier drives the launch-time harness probe through the REAL daemon →
 * scheduler → harness path (the same real-pipeline plumbing as
 * workflows-scripted.test.ts, but focused on the probe):
 *
 *   (a) A run launched with a harness PATH shim that exits 1 with empty
 *       output must fail within seconds with the mechanical keyline block
 *       (FAILURE_CLASS: harness_unavailable) — zero steps started, no
 *       step.running event, no claims, and run.harness_probe_failed present
 *       in the run's events.
 *
 *   (b) A run launched with a working probe-aware shim (the product scripted
 *       pi runtime, which answers probe prompts by running the quoted
 *       `<launcher> skill-path` command for real) must proceed: the probe is
 *       recorded 'ok' (run.harness_probe_ok precedes the first step.running),
 *       the harness is never probed again, and the run completes normally.
 *
 * The probe is ENABLED (default): TAMANDUA_HARNESS_PROBE is explicitly set to
 * "1" in each daemon env so the tests pin the probe-on behavior regardless of
 * the surrounding shell environment. No models are invoked — zero tokens.
 *
 * Run via: ./run-all-scripted-e2e-tests (or ./run-all-e2e-tests)
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
  spawnWorkflowRun,
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

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");
const WORKFLOW_ID = "do-now"; // single agent (`doer`), single step (`execute`)
const PROBE_TASK =
  "Probe e2e: do not modify files or run commands other than the tamandua step " +
  "commands. Reply with STATUS: done and REPORT: probe e2e ok.";

// ── Shared plumbing ─────────────────────────────────────────────────

interface ProbeRunContext {
  env: Awaited<ReturnType<typeof createTempHome>>;
  daemon: ChildProcess;
}

/** Install the workflow and launch a probe-enabled daemon (probe pinned ON). */
async function startProbeEnvironment(
  env: Awaited<ReturnType<typeof createTempHome>>,
  daemonEnv: Record<string, string>,
): Promise<ProbeRunContext> {
  cliMustSucceed(
    ["workflow", "install", WORKFLOW_ID],
    baseEnv(env.homeDir, env.controlPort),
    `install ${WORKFLOW_ID}`,
  );
  await releasePortReservations(env);
  const daemon = await startIsolatedDaemon(env.homeDir, env.controlPort, {
    // Pin the probe ON (default, but explicit so an inherited
    // TAMANDUA_HARNESS_PROBE=0 from the surrounding shell can never flip
    // this suite to probe-off).
    TAMANDUA_HARNESS_PROBE: "1",
    ...daemonEnv,
  });
  return { env, daemon };
}

async function teardown(ctx: ProbeRunContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await stopIsolatedDaemon(ctx.daemon);
  } catch {
    // best-effort
  }
  cleanupTempHome(ctx.env);
}

/** Append daemon log + run event diagnostics to a failure. */
function diagnostics(ctx: ProbeRunContext, runId?: string): string {
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
      const eventsPath = path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`);
      events = fs
        .readFileSync(eventsPath, "utf-8")
        .trimEnd()
        .split("\n")
        .slice(-15)
        .join("\n");
    } catch {
      // keep default
    }
  }
  return ["── daemon log (last 40 lines) ──", daemonLogTail, "── run events (last 15) ──", events].join("\n");
}

async function waitForTerminalStatus(
  ctx: ProbeRunContext,
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
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n${diagnostics(ctx, runId)}`,
    );
  }
}

function readRunEvents(
  ctx: ProbeRunContext,
  runId: string,
): Array<Record<string, unknown>> {
  const eventsPath = path.join(ctx.env.tamanduaDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function dbRows<T>(ctx: ProbeRunContext, sql: string, ...params: string[]): T[] {
  const db = openE2eDatabase(path.join(ctx.env.tamanduaDir, "tamandua.db"));
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe("launch-time harness probe e2e (IFLB US-006)", () => {
  it(
    "(a) a harness that exits 1 with empty output fails the run within seconds with FAILURE_CLASS: harness_unavailable; zero steps started",
    { timeout: 90_000 },
    async () => {
      let ctx: ProbeRunContext | undefined;
      try {
        const env = await createTempHome();

        // PATH shim: an executable named `pi` that exits 1 with empty output.
        // The daemon resolves the pi harness via PATH (no TAMANDUA_PI_BINARY),
        // so its very first spawn — the launch-time probe — dies instantly.
        const shimDir = path.join(env.root, "dead-pi-bin");
        fs.mkdirSync(shimDir, { recursive: true });
        const shim = path.join(shimDir, "pi");
        fs.writeFileSync(shim, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

        ctx = await startProbeEnvironment(env, {
          // Prepend the shim dir so PATH resolution finds the dead `pi`.
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          // Never let an inherited TAMANDUA_PI_BINARY bypass the PATH shim.
          TAMANDUA_PI_BINARY: undefined,
        });

        const workdir = path.join(env.root, "probe-workdir");
        fs.mkdirSync(workdir, { recursive: true });
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            WORKFLOW_ID,
            PROBE_TASK,
            "--working-directory-for-harness",
            workdir,
          ],
          baseEnv(env.homeDir, env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        // The run must fail FAST: the probe kills the harness on the first
        // dispatch; a bounded deadline (not an open poll) is the point.
        const status = await waitForTerminalStatus(ctx, runId, 60_000);
        assert.equal(status, "failed", `probe-broken run must fail, got "${status}"\n${diagnostics(ctx, runId)}`);

        // ── Events: run.harness_probe_failed carries the keyline block ──
        const events = readRunEvents(ctx, runId);
        const failed = events.filter((e) => e.event === "run.harness_probe_failed");
        assert.equal(
          failed.length,
          1,
          `exactly one run.harness_probe_failed expected; events: ${events.map((e) => e.event).join(", ")}`,
        );
        const reason = String(failed[0]?.reason ?? "");
        assert.match(reason, /^FAILURE_CLASS: harness_unavailable\n/, "reason must open with the keyline block");
        assert.match(reason, /\nHARNESS: pi\n/, "reason must name the pi harness");
        assert.match(reason, /\nPROBE_CMD: .* skill-path\n/, "reason must quote the probe command");
        assert.match(reason, /\nEXIT_CODE: 1\n/, "reason must carry the harness exit code");
        assert.ok(
          reason.trimEnd().endsWith("STDERR_TAIL:"),
          `STDERR_TAIL must be the LAST key of the block, got: ${reason}`,
        );
        const forceFailures = events.filter((e) => e.event === "run.force_failed");
        assert.equal(forceFailures.length, 1, "the run must be force-failed through the sanctioned path");

        // ── Zero steps started: no step.running, no claims ──
        assert.equal(
          events.filter((e) => e.event === "step.running").length,
          0,
          `a probe-broken run must never start a step; step events: ${events
            .filter((e) => String(e.event).startsWith("step."))
            .map((e) => `${e.event}:${String(e.stepId ?? "").slice(0, 8)}`)
            .join(", ")}`,
        );
        const steps = dbRows<{ step_id: string; status: string; claim_pid: number | null }>(
          ctx,
          "SELECT step_id, status, claim_pid FROM steps WHERE run_id = ?",
          runId,
        );
        assert.ok(steps.length >= 1, "the run should have seeded its workflow steps");
        for (const step of steps) {
          assert.notEqual(
            step.status,
            "done",
            `step ${step.step_id} must not be done (never worked), got ${step.status}`,
          );
          assert.notEqual(
            step.status,
            "failed",
            `step ${step.step_id} must not be failed (never worked), got ${step.status}`,
          );
          assert.ok(
            step.claim_pid === null,
            `step ${step.step_id} must never have been claimed (claim_pid set)`,
          );
        }

        // ── Operator surface: workflow status shows the block verbatim ──
        const statusOut = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
          env: baseEnv(ctx.env.homeDir, ctx.env.controlPort),
          encoding: "utf-8",
        });
        // The CLI's update banner is environment-dependent: the daemon's
        // startup version check compares the checkout HEAD against
        // origin/main, which diverges on any feature branch/worktree. It is
        // unrelated to the operator surface under test, so drop it before
        // asserting the keyline block is the last output.
        const statusStderr = statusOut.stderr
          .split(/\r?\n/)
          .filter((line) => !line.includes("A new version of tamandua is available!"))
          .join("\n");
        const text = `${statusOut.stdout}\n${statusStderr}`;
        assert.match(text, /FAILURE_CLASS: harness_unavailable/, "workflow status must surface the keyline block");
        assert.match(text, /\nHARNESS: pi\n/, "workflow status must surface HARNESS: pi");
        assert.match(text, /STDERR_TAIL:/, "workflow status must surface the last STDERR_TAIL key");
        assert.ok(
          text.trimEnd().endsWith("STDERR_TAIL:"),
          `the keyline block must be the last output of workflow status, got tail: ${text.trimEnd().slice(-200)}`,
        );
      } finally {
        await teardown(ctx);
      }
    },
  );

  it(
    "(b) a working probe-aware shim is probed once (ok precedes the first step.running) and the run completes",
    { timeout: 120_000 },
    async () => {
      let ctx: ProbeRunContext | undefined;
      try {
        const env = await createTempHome();
        const behaviors: ScriptedAgentConfig = {
          agents: {
            doer: {
              output: "STATUS: done\nREPORT: probe-aware scripted doer completed",
            },
          },
        };
        const scripted = createScriptedAgent(env.root, behaviors);

        ctx = await startProbeEnvironment(env, {
          ...scripted.env,
          TAMANDUA_PI_BINARY: scripted.binPath,
        });

        const workdir = path.join(env.root, "probe-workdir");
        fs.mkdirSync(workdir, { recursive: true });
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            WORKFLOW_ID,
            PROBE_TASK,
            "--working-directory-for-harness",
            workdir,
          ],
          baseEnv(env.homeDir, env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        const status = await waitForTerminalStatus(ctx, runId, 90_000);
        assert.equal(status, "completed", `probe-aware run must complete, got "${status}"\n${diagnostics(ctx, runId)}`);

        // ── Event ordering: run.harness_probe_ok precedes step.running ──
        const events = readRunEvents(ctx, runId);
        const okEvents = events.filter((e) => e.event === "run.harness_probe_ok");
        assert.equal(
          okEvents.length,
          1,
          `exactly one run.harness_probe_ok expected; events: ${events.map((e) => e.event).join(", ")}`,
        );
        assert.equal(okEvents[0].harness, "pi");
        assert.equal(
          events.filter((e) => e.event === "run.harness_probe_failed").length,
          0,
          "a working harness must never produce a probe-failure event",
        );
        const firstRunning = events.findIndex((e) => e.event === "step.running");
        assert.ok(firstRunning >= 0, "the run must start its step");
        const okIdx = events.findIndex((e) => e.event === "run.harness_probe_ok");
        assert.ok(
          okIdx >= 0 && okIdx < firstRunning,
          `run.harness_probe_ok (idx ${okIdx}) must precede the first step.running (idx ${firstRunning})`,
        );

        // ── Exactly one probe: the run completed a single step without
        // re-probing, and the probe was never journaled as an invocation ──
        const workRounds = scripted.workInvocations("doer");
        assert.equal(
          workRounds.length,
          1,
          `doer must do exactly 1 work round, got ${workRounds.length}\n${scripted.describe()}`,
        );
        const probeJournaled = scripted
          .readInvocations()
          .some((e) => String(e.note ?? "").includes("probe"));
        assert.equal(probeJournaled, false, "the probe must never be journaled as an invocation");

        // ── DB: probe outcome persisted 'ok' ──
        const runs = dbRows<{ status: string; harness_probe_status: string | null }>(
          ctx,
          "SELECT status, harness_probe_status FROM runs WHERE id = ?",
          runId,
        );
        assert.equal(runs.length, 1);
        assert.equal(runs[0].harness_probe_status, "ok", "the probe outcome must persist 'ok' on the run");
      } finally {
        await teardown(ctx);
      }
    },
  );
});
