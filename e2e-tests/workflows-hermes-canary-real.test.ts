/******************************************************************************
 * ⚠️  REAL HERMES E2E CANARY — SPENDS REAL TOKENS via HERMES  ⚠️
 *
 * Validates the full hermes pipeline (session_id trailer → state.db token
 * lookup) against the REAL hermes binary. One trivial do-now run through
 * the daemon → scheduler → hermes harness → stream parsing → token
 * attribution path.
 *
 * COST/TIME:
 *   - Spends real API tokens (one trivial agent task — cents/dollars)
 *   - Expected runtime: 30+ minutes (hermes is a slow Python CLI)
 *   - Requires a working hermes installation (on PATH or
 *     TAMANDUA_HERMES_BINARY) and ~/.hermes credentials/config
 *
 * WHEN TO RUN (only via ./run-hermes-e2e-canary, only deliberately):
 *   - Hermes-upgrade milestones to catch trailer format or state.db
 *     schema breakage before a production run does
 *
 * WHAT IT ASSERTS:
 *   - Run completes through the real hermes pipeline
 *   - Token accounting: runs.tokens_spent > 0
 *   - Token update events: run.tokens.updated emitted
 *
 * Agents: DO NOT run this by default. Only when explicitly asked.
 *****************************************************************************/

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  spawnWorkflowRun,
  resolveFullRunId,
  cleanupTempHome,
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
  "Reply with STATUS: done and REPORT: hermes canary ok.";

function isHermesAvailable(): boolean {
  if (process.env.TAMANDUA_HERMES_BINARY) return true;
  try {
    // `command` is a shell builtin, not an executable — it must run
    // inside sh or the spawn fails and hermes is never detected on PATH.
    const r = spawnSync("sh", ["-c", "command -v hermes"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

describe("real hermes e2e canary (LIVE hermes, single do-now run)", () => {
  it(
    "do-now completes through real hermes pipeline and accounts its tokens",
    { timeout: 35 * 60_000 }, // 35 minutes
    async (t) => {
      if (!isHermesAvailable()) {
        t.skip(
          "Hermes binary not found on PATH and TAMANDUA_HERMES_BINARY is unset. " +
            "Install hermes or set TAMANDUA_HERMES_BINARY to run the real hermes canary.",
        );
        return;
      }

      const env = await createTempHome();
      let daemon: ChildProcess | undefined;
      try {
        cliMustSucceed(
          ["workflow", "install", "do-now"],
          baseEnv(env.homeDir, env.controlPort),
          "install do-now",
        );

        const workdir = path.join(env.root, "canary-hermes-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        daemon = await startIsolatedDaemon(
          env.homeDir,
          env.controlPort,
        );

        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "do-now",
            CANARY_TASK,
            "--hermes-as-harness",
            "--working-directory-for-harness",
            workdir,
          ],
          baseEnv(env.homeDir, env.controlPort),
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        // Nudge-driven wait. Hermes is very slow; allow up to 30 minutes
        // for the run itself (leaving 5 minutes of the 35-minute test
        // timeout for setup/teardown/token-audit).
        const status = await pollForRunCompletionWithNudge(
          runId,
          baseEnv(env.homeDir, env.controlPort),
          30 * 60_000, // 30 min for the run itself
          5_000,
          env.tamanduaDir,
        );
        assert.ok(
          isSuccessfulRunTerminalStatus(status),
          `hermes canary run should complete, got "${status}"\n${collectRunDiagnostics(env.tamanduaDir, runId)}`,
        );

        // ── Token accounting with REAL hermes ────────────
        // The final round's usage lands a few seconds AFTER the run turns
        // terminal — hermes emits the session_id trailer, then the
        // harness adapter parses it and calls lookupHermesSessionTokens
        // (with retry loop for WAL writer lag). Wait for it.
        const audit = await waitForRunWorkTokens(
          env.tamanduaDir,
          runId,
          120_000,
        );
        assert.ok(
          audit.workTokens > 0,
          `real hermes work round should attribute tokens to the run, got ${audit.workTokens}\n` +
            collectRunDiagnostics(env.tamanduaDir, runId),
        );
        assert.ok(
          audit.tokenUpdateEvents > 0,
          `run.tokens.updated events should have been emitted, got ${audit.tokenUpdateEvents}`,
        );
        assert.equal(
          typeof audit.terminalTokensSpent,
          "number",
          "terminal run event should carry tokensSpent",
        );

        console.log(
          `[hermes-canary baseline] do-now: workTokens=${audit.workTokens} ` +
            `systemTokens=${audit.systemTokens} tokenUpdateEvents=${audit.tokenUpdateEvents} ` +
            `terminalTokensSpent=${audit.terminalTokensSpent}`,
        );
      } finally {
        if (daemon) {
          try {
            await stopIsolatedDaemon(daemon);
          } catch {
            // best-effort
          }
        }
        cleanupTempHome(env);
      }
    },
  );
});
