/******************************************************************************
 * ⚠️  WARNING: SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-FIX US-006 (H1/D1) — the EMPTY-OUTPUT/COMPLETED-STEP zero-provider
 * whole-path real-VM gate.
 *
 * The real-model qualification observed work rounds that surfaced
 * `outcome=empty_output outputBytes=0 exitCode=null` to the scheduler while
 * the guest had ALREADY completed the step protocol through the host broker
 * (the step row is `done` and the harness's final stdout was lost in the VM
 * transport). This gate reproduces that defect path deterministically inside a
 * REAL contained VM: the TEST-ONLY synthetic-pi fixture variant
 * (Dockerfile.synthetic-pi-empty-output) completes every work step through the
 * packed guest CLI but emits NOTHING on stdout.
 *
 * It runs ONE zero-provider `do-now` round through an isolated daemon →
 * scheduler → Matchlock runner → a FRESH VM and asserts:
 *   - the run reaches real status "completed";
 *   - every step is `done` with STATUS: done in the authoritative step DB;
 *   - the per-round "Work round complete" record classifies the empty-stdout
 *     round as `work_done` (never `empty_output`) via the authoritative step
 *     row, and the fallback evidence line is logged;
 *   - no `run.failed` / `run.matchlock_dispatch_refused` /
 *     `run.matchlock_invocation_infra_failed` / `run.harness_probe_failed` /
 *     `run.instant_fail_loop` event;
 *   - one distinct fresh VM per probe/work invocation (2 for do-now);
 *   - positive exact-owned VM teardown with a ledger (exact-id `matchlock rm`).
 *
 * NO provider credentials and NO model calls anywhere in the gate.
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand only:
 *
 *   ./run-matchlock-empty-output-e2e-test
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB under the evidence dir, schema
 * only there, TAMANDUA_TEST_GUARD auto-active under node:test, random control
 * port, never the live worker daemon.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanChildEnv, reservePortHandles } from "../tests/helpers/test-env.ts";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  inheritedProcessEnv,
  cliMustSucceed,
  spawnWorkflowRun,
  resolveFullRunId,
  releasePortReservations,
} from "./helpers/smoke-helpers.ts";
import { startIsolatedDaemon } from "./helpers/e2e-helpers.ts";
import {
  cleanupOwnedVms,
  readVmInventory,
  readRunEvents,
  stopIsolatedDaemonScoped,
} from "./helpers/matchlock-gate-lifecycle.ts";
import {
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";
import type { PortHandle } from "../tests/helpers/test-env.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

const FIXTURE_IMAGE_TAG = "tamandua-synthetic-pi:empty-output-fixture";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "matchlock-fixture");
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-pi-empty-output";

const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";

// Observed-rounds honesty (TESTER-HONESTY item 3): the label shared by this
// driver and its runner's `scripts/observed-rounds-guard.mjs` invocation.
const GATE_LABEL = "empty-output";
const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 25 * 60_000;

// MTLK-UNPIN: the paired runtime is resolved (not pinned). The resolved CLI
// is always exported; the guest-init/fused vars are exported only when the
// driver resolved them, so an unset value lets matchlock resolve it itself.
function matchlockRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = { TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN };
  if (GUEST_INIT.length > 0) env.MATCHLOCK_GUEST_INIT = GUEST_INIT;
  if (GUEST_FUSED.length > 0) env.MATCHLOCK_GUEST_FUSED = GUEST_FUSED;
  return env;
}

function assertEnv(): void {
  assert.ok(EVIDENCE_DIR.length > 0, "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-empty-output-e2e-test)");
  assert.ok(MATCHLOCK_RPC_BIN.length > 0, "TAMANDUA_MATCHLOCK_RPC_BIN must be set (the gate driver resolves matchlock from PATH)");
  // Guest-init/fused are OPTIONAL (MTLK-UNPIN): when unset, matchlock resolves
  // them itself and the gate records whatever it observes.
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    if (p.length > 0) {
      assert.ok(fs.existsSync(p), `resolved runtime binary missing: ${p}`);
    }
  }
}

function gateEnv(homeDir: string, controlPort: number): Record<string, string> {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  return {
    ...inheritedProcessEnv(),
    HOME: homeDir,
    TAMANDUA_CONTROL_PORT: String(controlPort),
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: path.join(tamanduaDir, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDir, "worktrees"),
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_HARNESS_PROBE: "1",
    TAMANDUA_PI_BINARY: "/usr/bin/false",
    TAMANDUA_DSH_BINARY: "/usr/bin/false",
    ...matchlockRuntimeEnv(),
  };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# Empty-output gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n.matchlock-synthetic-pi/\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Matchlock Empty-Output Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

interface VmReceipts {
  firstSeen: Map<string, string>;
  lastSeen: Map<string, string>;
  samples: number;
}

function sampleVmReceipts(receipts: VmReceipts, homeDir: string): void {
  receipts.samples += 1;
  const ts = new Date().toISOString();
  const inv = readVmInventory(homeDir);
  for (const row of inv.rows) {
    if (!receipts.firstSeen.has(row.id)) receipts.firstSeen.set(row.id, ts);
    receipts.lastSeen.set(row.id, ts);
  }
  for (const id of inv.dirIds) {
    if (!receipts.firstSeen.has(id)) receipts.firstSeen.set(id, ts);
    receipts.lastSeen.set(id, ts);
  }
}

let homeDir = "";
let tamanduaDir = "";
let env: Record<string, string> = {};
let daemon: ChildProcess | null = null;
let controlPort = 0;
let portHandles: PortHandle[] = [];
let wdNow = "";
let runNowId = "";
let ledgerPath = "";
let observedVmIds: string[] = [];
let cleanupCompleted = false;

describe(
  "matchlock empty-output/completed-step zero-provider real-VM gate (US-006)",
  { concurrency: 1 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      homeDir = path.join(EVIDENCE_DIR, "home");
      fs.mkdirSync(homeDir, { recursive: true });

      tamanduaDir = path.join(homeDir, ".tamandua");
      fs.mkdirSync(tamanduaDir, { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".cache"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "agent", "settings.json"),
        JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
        "utf-8",
      );
      fs.writeFileSync(path.join(tamanduaDir, "port"), "0", "utf-8");

      const kernelSrc = "/root/.cache/matchlock/kernels";
      assert.ok(fs.existsSync(kernelSrc), `kernel cache source missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), { recursive: true });

      // ── build + import the TEST-ONLY empty-output fixture image ─────
      const dockerBuild = spawnSync(
        "/usr/bin/docker",
        ["build", "-f", FIXTURE_DOCKERFILE, "-t", FIXTURE_IMAGE_TAG, "."],
        {
          cwd: FIXTURE_DOCKER_DIR,
          encoding: "utf-8",
          env: inheritedProcessEnv(),
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      assert.equal(
        dockerBuild.status,
        0,
        `docker build of the empty-output fixture failed (exit ${dockerBuild.status}):\n${(dockerBuild.stdout || "").slice(-4000)}\n${(dockerBuild.stderr || "").slice(-4000)}`,
      );
      const fixtureTar = path.join(EVIDENCE_DIR, "fixture-image.tar");
      const saveOutFd = fs.openSync(fixtureTar, "w");
      const dockerSave = spawnSync("/usr/bin/docker", ["save", FIXTURE_IMAGE_TAG], {
        stdio: ["ignore", saveOutFd, "pipe"],
        env: inheritedProcessEnv(),
      });
      fs.closeSync(saveOutFd);
      assert.equal(dockerSave.status, 0, `docker save of the empty-output fixture failed: ${dockerSave.stderr}`);
      const importEnv = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
      const saveInFd = fs.openSync(fixtureTar, "r");
      const imageImport = spawnSync(MATCHLOCK_RPC_BIN, ["image", "import", FIXTURE_IMAGE_TAG], {
        encoding: "utf-8",
        stdio: [saveInFd, "pipe", "pipe"],
        env: importEnv,
      });
      fs.closeSync(saveInFd);
      assert.equal(
        imageImport.status,
        0,
        `matchlock image import failed: ${imageImport.stdout}\n${imageImport.stderr}`,
      );

      portHandles = await reservePortHandles(1);
      controlPort = portHandles[0].port;
      fs.writeFileSync(path.join(tamanduaDir, "port"), String(controlPort), "utf-8");
      env = gateEnv(homeDir, controlPort);

      cliMustSucceed(["workflow", "install", "do-now"], env, "install do-now workflow");
      wdNow = prepareFixtureRepo(path.join(EVIDENCE_DIR, "fixtures", "wd-now"));
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");
    });

    after(async () => {
      const errors: string[] = [];
      if (daemon) {
        try {
          const closeOutcome = await stopIsolatedDaemonScoped(daemon);
          if (closeOutcome.signal === "SIGKILL-timeout") errors.push("daemon did not close within the scoped bound");
        } catch (err) {
          errors.push(`daemon stop: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          daemon = null;
        }
      }
      if (homeDir && !cleanupCompleted) {
        try {
          cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
        } catch (err) {
          errors.push(`emergency VM cleanup: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await releasePortReservations({ portHandles }).catch(() => {});
      portHandles = [];
      // ── observed-rounds honesty (TESTER-HONESTY item 3) ─────────────
      // Record the distinct in-VM rounds this gate ACTUALLY observed and
      // refuse to certify a zero-round run (VM creation/probe failed before
      // any round) even if the node --test assertions above were bypassed.
      const observedRounds = new Set(observedVmIds).size;
      if (EVIDENCE_DIR.length > 0) {
        writeObservedRoundsEvidence(EVIDENCE_DIR, {
          gate: GATE_LABEL,
          observed_rounds: observedRounds,
          observed_vm_ids: observedVmIds,
          detail: `${GATE_LABEL}: ${observedRounds} distinct in-VM rounds observed`,
        });
      }
      try {
        assertObservedRoundsNonZero(GATE_LABEL, observedRounds, observedVmIds);
      } catch (err) {
        errors.push(`observed-rounds: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (errors.length > 0) {
        throw new Error(`empty-output gate after-hook cleanup failed:\n${errors.join("\n")}`);
      }
    });

    it(
      "a zero-provider do-now run whose work harness emits no stdout still classifies work_done (never empty_output)",
      { timeout: 60 * 60_000 },
      async () => {
        await releasePortReservations({ portHandles });
        portHandles = [];
        daemon = await startIsolatedDaemon(homeDir, controlPort, gateEnv(homeDir, controlPort));

        const receipts: VmReceipts = { firstSeen: new Map(), lastSeen: new Map(), samples: 0 };
        let samplerTimer: NodeJS.Timeout | null = null;
        const startSampler = (): void => {
          if (samplerTimer) return;
          samplerTimer = setInterval(() => {
            try {
              sampleVmReceipts(receipts, homeDir);
            } catch (err) {
              process.stderr.write(`[matchlock-empty-output-gate] VM receipt sampler failed: ${String(err)}\n`);
            }
          }, 250);
        };
        const stopSampler = (): void => {
          if (samplerTimer) {
            clearInterval(samplerTimer);
            samplerTimer = null;
          }
        };

        try {
          startSampler();
          const nowPrefix = await spawnWorkflowRun(
            [
              "workflow", "run", "do-now",
              "Empty-output gate: execute the harmless owned fixture action and report.",
              "--working-directory-for-harness", wdNow,
              "--matchlock", FIXTURE_IMAGE_TAG,
            ],
            env,
            60_000,
          );
          runNowId = resolveFullRunId(nowPrefix, tamanduaDir);
          const nowStatus = await pollTerminalWithNudge(runNowId, env, tamanduaDir, "do-now");
          assert.equal(nowStatus, "completed", `empty-output do-now run must complete; got ${nowStatus}`);
          // The run completes as soon as the GUEST completes the step; the
          // scheduler's per-round classification is logged once the round's
          // exec settles (or the US-006b settle watchdog aborts it). Poll the
          // daemon log instead of racing it with a fixed sleep.
          await waitForWorkRoundClassification(runNowId, 120_000);
          assertRunEvidence(runNowId, wdNow);
          assertWorkRoundClassification(runNowId);

          const events = readRunEvents(tamanduaDir, runNowId);
          const byType = new Map<string, number>();
          for (const e of events) byType.set(String(e.event), (byType.get(String(e.event)) ?? 0) + 1);
          assert.equal(byType.get("run.completed") ?? 0, 1, "expected exactly one run.completed event");
          assert.equal(byType.get("run.harness_probe_ok") ?? 0, 1, "expected exactly one run.harness_probe_ok event");
          for (const bad of [
            "run.matchlock_dispatch_refused",
            "run.matchlock_invocation_infra_failed",
            "run.harness_probe_failed",
            "run.instant_fail_loop",
            "run.failed",
          ]) {
            assert.equal(byType.get(bad) ?? 0, 0, `unexpected ${bad} event`);
          }

          stopSampler();
          observedVmIds = [...new Set([...receipts.firstSeen.keys()])].sort();
          assert.equal(
            observedVmIds.length,
            receipts.firstSeen.size,
            "VM ids must never repeat (fresh VM per probe/work invocation)",
          );
          assert.equal(
            observedVmIds.length,
            2,
            `expected 2 distinct fresh VMs (1 probe + 1 work), got ${observedVmIds.length}: ${observedVmIds.join(",")}`,
          );
          assert.ok(receipts.samples >= 2, `VM receipts sampler must take multiple samples (got ${receipts.samples})`);
        } finally {
          if (daemon) {
            try {
              const closeOutcome = await stopIsolatedDaemonScoped(daemon);
              assert.ok(
                closeOutcome.signal !== "SIGKILL-timeout",
                `gate daemon did not close within the scoped bound (code=${closeOutcome.code}, signal=${closeOutcome.signal})`,
              );
            } finally {
              daemon = null;
            }
          }
        }

        const { ledger } = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
        cleanupCompleted = true;
        assert.ok(fs.existsSync(ledgerPath), `vm cleanup ledger missing at ${ledgerPath}`);
        assert.ok(
          ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
          "cleanup ledger must record completion with no leftovers",
        );
        console.log(
          `[matchlock-empty-output-gate] OK run=${runNowId} vms=${observedVmIds.length} evidence=${EVIDENCE_DIR}`,
        );
      },
    );
  },
);

/**
 * The run reaches "completed" when the GUEST completes the step through the
 * host broker; the scheduler's per-round classification/log is emitted once
 * the round's in-VM exec settles (or the US-006b settle watchdog aborts it).
 * Poll the daemon log for the classification evidence rather than racing it.
 */
async function waitForWorkRoundClassification(runId: string, timeoutMs: number): Promise<void> {
  const logPath = path.join(tamanduaDir, "tamandua.log");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(logPath)) {
      const text = fs.readFileSync(logPath, "utf-8");
      const complete = text.split("\n").some((l) => l.includes("Work round complete") && l.includes(runId));
      const fallback = text
        .split("\n")
        .some((l) => l.includes("Empty harness stdout but the guest completed the step") && l.includes(runId));
      if (complete && fallback) return;
    }
    await sleep(500);
  }
}

/**
 * The work round emitted no stdout but the guest completed the step: the
 * daemon's per-round classification must be work_done via the authoritative
 * step row, and the honest empty_output classification must not appear for
 * this run.
 */
function assertWorkRoundClassification(runId: string): void {
  const logPath = path.join(tamanduaDir, "tamandua.log");
  assert.ok(fs.existsSync(logPath), `daemon log missing at ${logPath}`);
  const lines = fs.readFileSync(logPath, "utf-8").split("\n");
  const completeLines = lines.filter((l) => l.includes("Work round complete") && l.includes(runId));
  assert.ok(completeLines.length >= 1, "no 'Work round complete' line for the run in the daemon log");
  for (const l of completeLines) {
    assert.match(l, /"outcome":"work_done"/, `empty-stdout completed round must be work_done: ${l}`);
    assert.doesNotMatch(l, /"outcome":"empty_output"/, `never classify a completed round empty_output: ${l}`);
  }
  assert.ok(
    lines.some((l) => l.includes("Empty harness stdout but the guest completed the step") && l.includes(runId)),
    "the authoritative step-completion fallback evidence line must be logged",
  );
}

/** Assert the completed run's authoritative steps + retained fixture markers. */
function assertRunEvidence(runId: string, repoDir: string): void {
  const progressFile = path.join(tamanduaDir, "runs", runId, "progress-resource", "progress.txt");
  assert.ok(fs.existsSync(progressFile), `guest progress document missing at ${progressFile}`);
  const progressText = fs.readFileSync(progressFile, "utf-8");
  assert.ok(progressText.trim().length > 0, "progress document is empty");
  assert.ok(
    progressText.includes("suppressing work-round stdout"),
    "the fixture must have exercised the US-006 empty-stdout knob",
  );

  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const rows = db
      .prepare("SELECT step_id, agent_id, status, output FROM steps WHERE run_id = ? ORDER BY step_index")
      .all(runId) as Array<{ step_id: string; agent_id: string; status: string; output: string | null }>;
    assert.ok(rows.length >= 1, "no steps found in step DB");
    for (const row of rows) {
      assert.equal(row.status, "done", `step ${row.step_id} (${row.agent_id}) not done (status=${row.status})`);
      assert.ok(row.output && /STATUS:\s*done/i.test(row.output), `step ${row.step_id} has no STATUS: done output`);
    }
  } finally {
    db.close();
  }

  const markerDir = path.join(repoDir, ".matchlock-synthetic-pi");
  assert.ok(fs.existsSync(markerDir), `synthetic marker dir missing in repo ${repoDir}`);
  const markers = fs.readdirSync(markerDir).filter((f) => f.endsWith(".marker"));
  assert.ok(markers.length >= 1, "no synthetic marker files retained");
}

async function pollTerminalWithNudge(
  runId: string,
  envIn: Record<string, string>,
  tamanduaDirIn: string,
  label: string,
): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
      env: cleanChildEnv(envIn),
      encoding: "utf-8",
    });
    const out = result.stdout || result.stderr || "";
    const m = out.match(/^Status:\s+(\S+)/m);
    if (m) {
      lastStatus = m[1];
      if (["completed", "done", "failed", "canceled"].includes(lastStatus)) return lastStatus;
    }
    spawnSync(process.execPath, [cliPath, "nudge"], { env: cleanChildEnv(envIn), encoding: "utf-8" });
    await sleep(DEFAULT_POLL_MS);
  }
  const eventsPath = path.join(tamanduaDirIn, "events", `${runId}.jsonl`);
  let tail = "";
  try {
    const lines = fs.readFileSync(eventsPath, "utf-8").trimEnd().split("\n");
    tail = lines.slice(-20).join("\n");
  } catch {
    /* ignore */
  }
  throw new Error(
    `[${label}] timeout after ${RUN_TIMEOUT_MS}ms waiting for terminal status; last=${lastStatus || "(none)"}\n${tail}`,
  );
}
