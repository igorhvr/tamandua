/******************************************************************************
 * ⚠️  REAL E2E CANARY — SPENDS REAL MODEL TOKENS (small, but real)  ⚠️
 *
 * The cheapest possible real-pipeline check: ONE do-now workflow run with a
 * trivial task through the real daemon → scheduler → pi pipeline. One work
 * round with a live model plus a handful of polling rounds.
 *
 * COST/TIME:
 *   - Spends real API tokens (one trivial agent task — cents, not dollars)
 *   - Expected runtime: 2–10 minutes (nudge-driven, so no 5-minute
 *     poll-interval waits)
 *   - Requires a configured pi setup (~/.pi auth is symlinked into the
 *     isolated HOME by createTempHome)
 *
 * WHEN TO RUN (only via ./run-real-e2e-canary, only deliberately):
 *   - At each motor-rewrite milestone, before reaching for the full
 *     ./run-all-real-e2e-tests suite (30–60 min per workflow)
 *
 * WHAT IT ASSERTS beyond "the run completed":
 *   - token accounting (MOTOR-CONTRACT.md C14/C15): work tokens attributed
 *     to the run, run.tokens.updated events emitted, terminal event carries
 *     tokensSpent
 *   - prints the real-model token baseline (work + system tokens) that the
 *     deterministic motor is meant to improve
 *
 * Agents: DO NOT run this by default. Only when explicitly asked.
 *****************************************************************************/

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  spawnWorkflowRun,
  resolveFullRunId,
  cleanupTempHome,
  preserveE2eTestHome,
} from "./helpers/smoke-helpers.ts";
import {
  startIsolatedDaemon,
  stopIsolatedDaemon,
  pollForRunCompletionWithNudge,
  isSuccessfulRunTerminalStatus,
  waitForRunWorkTokens,
  collectRunDiagnostics,
} from "./helpers/e2e-helpers.ts";

const CANARY_TASK =
  "Canary check: do not modify any files or run any commands other than the " +
  "tamandua step commands you are instructed to use. Simply report success. " +
  "Reply with STATUS: done and REPORT: canary ok.";

describe("real e2e canary (LIVE model, single do-now run)", () => {
  let testFailed = false;
  it(
    "do-now completes through the real pipeline and accounts its tokens",
    { timeout: 15 * 60_000 }, // 15 minutes
    async () => {
      const env = await createTempHome();
      let daemon: ChildProcess | undefined;
      try {
        try {
        cliMustSucceed(
          ["workflow", "install", "do-now"],
          baseEnv(env.homeDir, env.controlPort),
          "install do-now",
        );

        const workdir = path.join(env.root, "canary-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        daemon = await startIsolatedDaemon(env.homeDir, env.controlPort);

        const runIdPrefix = await spawnWorkflowRun(
          ["workflow", "run", "do-now", CANARY_TASK, "--working-directory-for-harness", workdir],
          baseEnv(env.homeDir, env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        // Nudge-driven wait: the real work round takes as long as the model
        // takes; nudging only removes the 5-minute poll-interval dead time.
        const status = await pollForRunCompletionWithNudge(
          runId,
          baseEnv(env.homeDir, env.controlPort),
          12 * 60_000, // 12 min for the run itself
          5_000,
          env.tamanduaDir,
        );
        assert.ok(
          isSuccessfulRunTerminalStatus(status),
          `canary run should complete, got "${status}"\n${collectRunDiagnostics(env.tamanduaDir, runId)}`,
        );

        // ── Token accounting with a REAL model (C14/C15) ────────────
        // The final (here: only) round's usage lands a few seconds AFTER
        // the run turns terminal — pi emits usage after the completing
        // tool call, and attribution needs the harness to exit within the
        // teardown grace window. Wait for it instead of racing it.
        const audit = await waitForRunWorkTokens(env.tamanduaDir, runId);
        assert.ok(
          audit.workTokens > 0,
          `real work round should attribute tokens to the run, got ${audit.workTokens}\n` +
            collectRunDiagnostics(env.tamanduaDir, runId),
        );
        assert.ok(
          audit.tokenUpdateEvents > 0,
          `run.tokens.updated events should have been emitted, got ${audit.tokenUpdateEvents}`,
        );
        // Note: run.completed's tokensSpent may legitimately be 0 here —
        // for a single-step run the terminal event fires before the only
        // round's usage is parsed. The DB total is the correct number.
        assert.equal(
          typeof audit.terminalTokensSpent,
          "number",
          "terminal run event should carry tokensSpent",
        );

        // ── Real-model motor baseline (see MOTOR-CONTRACT.md N1/N2):
        // with the polling motor, system tokens > 0 is expected; the
        // deterministic motor should drive them to zero. Printed, not
        // asserted — heartbeat count depends on model latency vs nudges.
        console.log(
          `[real-canary baseline] do-now: workTokens=${audit.workTokens} ` +
            `systemTokens=${audit.systemTokens} tokenUpdateEvents=${audit.tokenUpdateEvents} ` +
            `terminalTokensSpent=${audit.terminalTokensSpent}`,
        );
        } catch (e) {
          testFailed = true;
          throw e;
        }
      } finally {
        if (daemon) {
          try {
            await stopIsolatedDaemon(daemon);
          } catch {
            // best-effort
          }
        }
        if (testFailed) {
          preserveE2eTestHome(env.root, "canary");
        }
        cleanupTempHome(env);
      }
    },
  );
});
