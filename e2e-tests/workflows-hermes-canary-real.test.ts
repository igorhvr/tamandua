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
  releasePortReservations,
} from "./helpers/smoke-helpers.ts";
import {
  startIsolatedDaemon,
  stopIsolatedDaemon,
  pollForRunCompletionWithNudge,
  isSuccessfulRunTerminalStatus,
  waitForRunWorkTokens,
  auditHermesSessionStore,
  waitForHarnessStoreReconciliation,
  collectRunDiagnostics,
} from "./helpers/e2e-helpers.ts";
// HCANARY-CONTAM | LAUNCHER-SNAPSHOT: shared pure resolver + snapshot/restore net.
// The brief names this as `../../src/lib/hermes-launcher-snapshot.ts` (the path
// from `e2e-tests/helpers/`); this canary lives directly in `e2e-tests/`, so the
// correct relative specifier is one level up (matching the other
// `e2e-tests/*.test.ts` files that import `../src/lib/...`).
import {
  resolveRealHermesRoot,
  resolveLauncherChain,
  snapshotLaunchers,
  restoreLaunchers,
  verifyLaunchers,
} from "../src/lib/hermes-launcher-snapshot.ts";

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

/**
 * Resolve the launcher entry path for the HCANARY-CONTAM guard.
 *
 * `command -v hermes` is authoritative; `TAMANDUA_HERMES_BINARY` is the
 * documented fallback when the command resolves nothing. A null result is an
 * explicit recorded no-op for the guard — it never skips the canary.
 */
function resolveHermesLauncherEntry(): string | null {
  try {
    const r = spawnSync("sh", ["-c", "command -v hermes"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status === 0) {
      const resolved = r.stdout.trim();
      if (resolved.length > 0) return resolved;
    }
  } catch {
    // fall through to the env fallback
  }
  const fallback = process.env.TAMANDUA_HERMES_BINARY?.trim();
  return fallback && fallback.length > 0 ? fallback : null;
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

      const env = await createTempHome({ linkRealAgentDirs: true });

      // ── Launcher-contamination guard: pre-run snapshot (HCANARY-CONTAM) ──
      // Runs AFTER the hermes-availability skip check and BEFORE the daemon
      // starts, because hermes's profile-boot launcher publication is what
      // rewrote the REAL source-install launchers through the temp HOME.
      //
      // Mechanism check (task item b) against the STAGED affected-host source
      // (hermes HEAD 16c59d0e): `_launchers.py` sha256 d8e5d079... and
      // `hermes_constants.py` sha256 1bef6b10... (both verified before use).
      //
      //   * HERMES_HOME does NOT verify: `get_default_hermes_root()`
      //     (hermes_constants.py ~L216-233) returns `native_home`
      //     (= Path.home()/".hermes") whenever the HERMES_HOME path resolves
      //     under `native_home.resolve()`. createTempHome symlinks
      //     <tempHome>/.hermes to the REAL ~/.hermes, so BOTH the unset case and
      //     `HERMES_HOME=<realpath of the real hermes root>` resolve under the
      //     temp native_home and still return the literal <tempHome>/.hermes —
      //     the very temp path observed in the contamination. Setting it cannot
      //     change the minted interpreter path, so it is deliberately NOT set.
      //   * No explicit env switch in the two briefed, authoritative files
      //     disables the boot-repair publication. The minted interpreter comes
      //     from `resolve_store_python()` (_launchers.py), which delegates to
      //     `store_root(repo_root)` in the `pm.environments` module — the brief
      //     declares `pm.environments.store_root` UNSTAGED, and neither briefed
      //     file resolves it. A later `environments.py` copy now sits beside the
      //     brief and exposes an `HERMES_RUNTIME_DIR` override, but it is outside
      //     the briefed authoritative pair and applying it would require guessing
      //     the real store path while changing canary behavior beyond this story,
      //     so no unverified mechanism is picked.
      // NO mechanism is applied here: the required snapshot/restore net below is
      // the guard. A resolution/entry failure is a recorded no-op and must NOT
      // skip the canary.
      const realHermesRoot = resolveRealHermesRoot(env.homeDir);
      const launcherEntry = resolveHermesLauncherEntry();
      const launcherChain = resolveLauncherChain({
        entryPath: launcherEntry,
        realHermesRoot: realHermesRoot.root,
      });
      const launcherSnapshot = snapshotLaunchers(launcherChain);
      console.log(
        `[hermes-canary launcher-guard] realRoot=${realHermesRoot.root ?? "(none)"} ` +
          `entry=${launcherEntry ?? "(none)"} ` +
          `snapshotted=${launcherSnapshot.entries.length} file(s) ` +
          `noop=${launcherSnapshot.noop}`,
      );

      let daemon: ChildProcess | undefined;
      try {
        cliMustSucceed(
          ["workflow", "install", "do-now"],
          baseEnv(env.homeDir, env.controlPort),
          "install do-now",
        );

        const workdir = path.join(env.root, "canary-hermes-workdir");
        fs.mkdirSync(workdir, { recursive: true });

        await releasePortReservations(env);
        daemon = await startIsolatedDaemon(
          env.homeDir,
          env.controlPort,
        );

        // Session-store reconciliation scopes to hermes sessions started
        // at/after this timestamp, so the symlinked real ~/.hermes's older
        // sessions are never counted.
        const runStartedMs = Date.now();

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

        // ── Session-store reconciliation (tamandua-6sy.52, tolerance 0) ──
        // hermes' own state.db is the source of truth. Assert the DB total
        // equals the sum over this run's sessions under the shared policy.
        // The live schema exposes cwd + started_at (verified against
        // /root/.hermes/state.db), so this is a HARD assert symmetric with
        // the pi canary — not a best-effort skip.
        const reconciliation = await waitForHarnessStoreReconciliation({
          tamanduaDir: env.tamanduaDir,
          runId,
          auditStore: () =>
            auditHermesSessionStore({
              homeDir: env.homeDir,
              workdir,
              sinceMs: runStartedMs,
            }),
        });
        assert.ok(
          reconciliation.store.sessions > 0,
          `hermes state.db should contain this run's session(s) for ${workdir} ` +
            `(matched ${reconciliation.store.sessions}; runs.tokens_spent=${reconciliation.workTokens})\n` +
            collectRunDiagnostics(env.tamanduaDir, runId),
        );
        assert.equal(
          reconciliation.workTokens,
          reconciliation.store.policyTotal,
          `runs.tokens_spent (${reconciliation.workTokens}) must equal hermes' state.db ` +
            `total under the shared policy (input+output+cache_write, cache_read excluded) = ` +
            `${reconciliation.store.policyTotal}; cache-inclusive total was ` +
            `${reconciliation.store.cacheInclusiveTotal} over ${reconciliation.store.sessions} session(s)\n` +
            collectRunDiagnostics(env.tamanduaDir, runId),
        );

        console.log(
          `[hermes-canary reconciliation] runs.tokens_spent=${reconciliation.workTokens} ` +
            `store.policyTotal=${reconciliation.store.policyTotal} ` +
            `store.cacheInclusiveTotal=${reconciliation.store.cacheInclusiveTotal} ` +
            `sessions=${reconciliation.store.sessions} ` +
            `usageCount=${reconciliation.store.usageCount} ` +
            `policy=input+output+cache_write cache_read=excluded matched=true`,
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

        // ── Launcher-contamination guard: restore + verify ─────────────────
        // Runs AFTER the daemon stops and AFTER the temp home is cleaned, so
        // the repair uses only the pre-run snapshot (the temp home is gone and
        // can no longer influence resolution). Unchanged files are never
        // rewritten. A restore failure OR any non-identical file FAILS the
        // test loudly with the drifted paths — never a silent pass.
        let restoreFailure: unknown;
        try {
          restoreLaunchers(launcherSnapshot);
        } catch (err) {
          restoreFailure = err;
        }
        const launcherVerification = verifyLaunchers(launcherSnapshot);
        if (restoreFailure !== undefined || !launcherVerification.ok) {
          const drift = launcherVerification.entries
            .filter((entry) => !entry.identical)
            .map(
              (entry) =>
                `  ${entry.path}: expected sha256=${entry.expectedSha256}, ` +
                `actual sha256=${entry.actualSha256 ?? "(missing)"}`,
            )
            .join("\n");
          throw new Error(
            "[HCANARY-CONTAM] real hermes launcher(s) could not be confirmed " +
              "byte-identical after the canary run; the real hermes install may " +
              "be corrupted and must be repaired before use.\n" +
              `restoreError=${restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure ?? "none")}\n` +
              (drift.length > 0
                ? `drifted launcher files:\n${drift}`
                : "no per-file drift recorded"),
          );
        }
      }
    },
  );
});
