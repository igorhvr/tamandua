/**
 * CORE-CELLS US-003 — original CORE US-005: BRUN launch-probe versus
 * probe-passing mid-run instant-fail dsh path.
 *
 * Beads tamandua-6sy.7 / tamandua-6sy.7.4. One isolated BRUN recorded-cell
 * regression file covering BOTH current corridors through a proper
 * plain-stdout dsh path (NOT a pi relabel):
 *
 *   (a) FIRST-DISPATCH REAL LAUNCH-PROBE FAILURE — the modern handling of the
 *       historical W4.dsh-do-now launch-broken MISSING_CREDENTIAL shape
 *       (run ba584b54-fbb3-40b4-a7cc-34f5d6843a2d, 21/21 retained rounds,
 *       exit 1 in ~762 ms, stdoutBytes=1, empty trimmed output). A synthetic
 *       boot-broken plain dsh stand-in exits 1 fast on ANY prompt (launch
 *       probe included) writing exactly ONE stdout byte — an EXPLICITLY
 *       DECLARED SYNTHETIC newline (the historical byte is UNKNOWN) — and
 *       MISSING_CREDENTIAL to stderr. The REAL daemon/scheduler probe round
 *       fails, the run is force-failed: exactly one run.harness_probe_failed,
 *       zero work rounds, zero tokens, step never completed.
 *
 *   (b) PROBE-PASSING MID-RUN INSTANT-FAIL LOOP — a suite-owned plain-stdout
 *       dsh frozen runtime (torture-test/scripted-runtimes/runtime-dsh.mjs,
 *       the minimal dsh fork adaptation) ANSWERS the launch probe (plain-text
 *       PATH + newline reply, per the dsh headless stdout contract) and then
 *       instant-fails (fast exit 1, zero output, no claim) on every work
 *       round. The CURRENT motor relaunches after the escalating backoff
 *       window (never strands as previous_round_in_flight after a
 *       backoff-gated tick) and force-fails at N consecutive instant-fail
 *       rounds with exactly one run.instant_fail_loop event.
 *
 * Product defaults K=6 / N=20 (and the 2s wall threshold / 30s base delay)
 * are PRESERVED and asserted unchanged from the built product module. The
 * mid-run corridor uses BOUNDED PER-TEST OVERRIDES (K=2 / N=4 / base 3s /
 * wall 20 s) that are explicitly labeled test-only and are never presented as
 * production-default proof.
 *
 * No real credentials / provider / network and NO probe bypass: the probe is
 * left enabled and both corridors run through the real launch-time harness
 * probe. Run/system token accounting is exactly zero. All owned children
 * (isolated daemon, run-CLI launcher) and the control listener close with
 * positive bounded evidence (exact-handle stop + ECONNREFUSED release probe).
 *
 * Every actual test instance uses private HOME / TAMANDUA_STATE_DIR /
 * TAMANDUA_DB_PATH / TMPDIR, TAMANDUA_TEST_GUARD=1, random control ports and
 * an explicit child env. Sandboxes/evidence are RETAINED under a fresh
 * evidence root in torture-test/var/review-logs/ (git-ignored). Nothing is
 * removed.
 *
 * Designated gate: `node --test torture-test/self-tests/tier0-core-recording-brun-cell.test.ts`
 * on a clean committed tree with dist/ built exits 0.
 */

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

// ── Lazy module loads (mirror tier0-core-recording-tcmd-cells.test.ts) ─
const moduleCache = new Map();
function load(repoRelative: string) {
  const url = pathToFileURL(path.join(repoRoot, repoRelative)).href;
  if (!moduleCache.has(url)) moduleCache.set(url, import(url));
  return moduleCache.get(url);
}

const loadAssets = () => load("torture-test/bin/core-recording-brun-cell-assets.mjs");
const loadExecutor = () => load("torture-test/bin/core-recording-replay-executor.mjs");

// The single corridor agent of the existing motor gate (do-now corridor).
const AGENT = "do-now_doer";

/**
 * One fresh retained evidence root for this whole file run:
 * torture-test/var/review-logs/core-brun-cells-<UTC>Z/ (never removed).
 */
const EVIDENCE_ROOT = (() => {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(repoRoot, "torture-test", "var", "review-logs", `core-brun-cells-${now}Z`);
  fs.mkdirSync(root, { recursive: true });
  return root;
})();

/** True when the built dist (needed by the real daemon/scheduler) is present. */
function distBuilt() {
  return (
    fs.existsSync(path.join(repoRoot, "dist", "cli", "cli.js")) &&
    fs.existsSync(path.join(repoRoot, "dist", "server", "daemon.js")) &&
    fs.existsSync(path.join(repoRoot, "dist", "installer", "instant-fail.js"))
  );
}

function gitHead() {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" });
    return r.status === 0 ? r.stdout.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/**
 * Read the isolated DB rows relevant to the BRUN assertions (read-only).
 */
async function readBrunDbRows(sandbox: any, runId: string): Promise<{ run: any; steps: any[]; stats: any }> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sandbox.dbPath, { readOnly: true });
  try {
    const run = db
      .prepare(
        "SELECT id, status, harness_probe_status, instant_fail_count, tokens_spent, context FROM runs WHERE id = ?",
      )
      .get(runId);
    const steps = db
      .prepare(
        "SELECT id, step_id, agent_id, status, retry_count, run_id FROM steps WHERE run_id = ? ORDER BY step_index",
      )
      .all(runId);
    const stats = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get() ?? null;
    return { run, steps, stats };
  } finally {
    db.close();
  }
}

/**
 * Create the boot-broken plain dsh stand-in for corridor (a): fails fast on
 * ANY prompt (launch probe included) with the recorded MISSING_CREDENTIAL
 * round shape — exit 1, stdoutBytes=1 with empty trimmed output, stderr
 * carrying the recorded error code. The single stdout byte is an EXPLICITLY
 * DECLARED SYNTHETIC newline: the historical byte is UNKNOWN (recorded in the
 * asset), never presented as the captured byte.
 */
function materializeBootBrokenDsh(sandbox: any): string {
  const shim = path.join(sandbox.binDir, "boot-broken-dsh");
  fs.writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      "# BRUN corridor (a): synthetic launch-broken dsh stand-in.",
      "# Exits 1 fast on ANY prompt with the recorded MISSING_CREDENTIAL round shape:",
      "# stdoutBytes=1 (ONE byte), empty trimmed output, MISSING_CREDENTIAL on stderr.",
      "# The single stdout byte is a DECLARED SYNTHETIC newline (0x0A): the historical",
      "# byte of run ba584b54 is UNKNOWN and is never presented as captured.",
      "printf '\\n'",
      "printf '%s\\n' 'dsh: MISSING_CREDENTIAL: synthetic BRUN corridor-a reproduction (recorded error code only; no real credentials)' >&2",
      "exit 1",
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.chmodSync(shim, 0o755);
  return shim;
}

/** Behaviors file for corridor (b): every work round dies before claim. */
function writeDieBeforeClaimBehaviors(sandbox: any): string {
  const behaviorsPath = path.join(sandbox.root, "behaviors.json");
  fs.writeFileSync(
    behaviorsPath,
    JSON.stringify(
      {
        defaultTokens: 111,
        agents: { [AGENT]: { mode: "die-before-claim", exitCode: 1 } },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return behaviorsPath;
}

/** Read the daemon log lines for a message name with a JSON tail. */
function readLogLinesWithJson(logPath: string, message: string): Array<{ line: string; meta: any }> {
  if (!fs.existsSync(logPath)) return [];
  const out: Array<{ line: string; meta: any }> = [];
  for (const line of fs.readFileSync(logPath, "utf-8").split(/\r?\n/)) {
    const idx = line.indexOf(` ${message} `);
    if (idx === -1) continue;
    const tail = line.slice(idx + message.length + 2);
    const jsonStart = tail.indexOf("{");
    if (jsonStart === -1) continue;
    try {
      out.push({ line, meta: JSON.parse(tail.slice(jsonStart)) });
    } catch {
      // keep only parseable JSON tails
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run ONE real isolated dsh corridor (a or b) and return a report with real
 * receipts + positive closure evidence. Mirrors the executor's isolation and
 * ownership contract: private HOME/state/DB/TMPDIR, guard1, random control
 * port, explicit child env, exact-handle daemon stop, ECONNREFUSED control
 * listener release probe, and a retained sandbox (never removed).
 */
async function runDshCorridor(opts: {
  corridor: "a_first_dispatch_probe_failure" | "b_probe_passing_mid_run_instant_fail";
  taskText: string;
}): Promise<any> {
  const executor = await loadExecutor();
  const { createSandbox, buildIsolatedEnv, reserveRandomPort, installCorridorWorkflow } = executor;
  const { materializeRuntimeWrapper, spawnIsolatedDaemon, stopExactChild, probePortClosed } = executor;
  const { launchWorkflowRun, resolveFullRunId, pollRunToTerminal, collectReceipts, describeError } = executor;

  const label = opts.corridor.startsWith("a_") ? "a-probe-failure" : "b-instant-fail";
  const sandbox = createSandbox(EVIDENCE_ROOT, `sandbox-${label}`);
  const env = buildIsolatedEnv({
    homeDir: sandbox.homeDir,
    controlPort: await reserveRandomPort(),
    tmpdir: sandbox.root,
  });
  const controlPort = Number(env.TAMANDUA_CONTROL_PORT);

  // dsh binary for the corridor: corridor (a) boot-broken shim; corridor (b)
  // the suite-owned plain-stdout frozen dsh runtime wrapper.
  let dshBinary: string;
  let behaviorsPath = "";
  if (opts.corridor === "a_first_dispatch_probe_failure") {
    dshBinary = materializeBootBrokenDsh(sandbox);
  } else {
    dshBinary = materializeRuntimeWrapper(sandbox, repoRoot, "dsh");
    behaviorsPath = writeDieBeforeClaimBehaviors(sandbox);
  }

  // Corridor (b) BOUNDED PER-TEST OVERRIDES — explicitly labeled test-only,
  // never production-default proof (product defaults K6/N20 asserted in the
  // file from the built module). Corridor (a) uses NO overrides.
  const daemonEnvExtra: Record<string, string> =
    opts.corridor === "b_probe_passing_mid_run_instant_fail"
      ? {
          // test-only bounded overrides for a deterministic fast corridor
          TAMANDUA_INSTANT_FAIL_BACKOFF_K: "2",
          TAMANDUA_INSTANT_FAIL_ESCALATION_N: "4",
          TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS: "3000",
          TAMANDUA_INSTANT_FAIL_WALL_MS: "20000",
        }
      : {};

  const daemonEnv = {
    ...env,
    TAMANDUA_DSH_BINARY: dshBinary,
    DSH_HOME: sandbox.dshHome,
    TAMANDUA_PI_BINARY: "/usr/bin/false", // accidental pi spawns fail loudly
    TAMANDUA_HERMES_BINARY: "/usr/bin/false", // accidental hermes spawns fail loudly
    TAMANDUA_HARNESS_PROBE: "1", // probe ENABLED — no probe bypass
    TAMANDUA_DEBUG: "1", // dispatch skip reasons land in the daemon log
    ...(behaviorsPath ? { TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath } : {}),
    TAMANDUA_SCRIPTED_STATE: sandbox.stateDir,
    ...daemonEnvExtra,
  };

  const report: any = {
    corridor: opts.corridor,
    sandbox: sandbox.root,
    artifacts: {
      dbPath: sandbox.dbPath,
      stateDir: sandbox.stateDir,
      dshBinary,
      behaviorsPath: behaviorsPath || null,
      logPath: daemonLogPath(sandbox),
      eventsPath: null,
      invocationsPath: path.join(sandbox.stateDir, "invocations.jsonl"),
    },
    freshRunId: null,
    runStatus: null,
    daemonStop: null,
    launchStop: null,
    controlPortProbe: null,
    receipts: null,
    error: null,
    executed: true,
  };
  let daemon: any = null;
  let launch: any = null;
  let launchStopped = false;
  try {
    installCorridorWorkflow({ repoRoot, env });
    daemon = spawnIsolatedDaemon({ repoRoot, env: daemonEnv });
    await daemon.ready;

    launch = launchWorkflowRun({
      repoRoot,
      env,
      taskText: opts.taskText,
      workdir: sandbox.workdir,
      dsh: true,
    });
    const runInfo = await launch.ready;
    const freshRunId = await resolveFullRunId(sandbox, runInfo.prefix);
    report.freshRunId = freshRunId;
    report.artifacts.eventsPath = path.join(sandbox.tamanduaDir, "events", `${freshRunId}.jsonl`);

    // Reap the launcher CLI exactly (natural-exit grace then exact stop) and
    // require positive closure before trusting the case.
    const launchStop = await launch.stop();
    launchStopped = true;
    report.launchStop = launchStop;
    if (launchStop.stopError) {
      throw new Error(`run-CLI launcher cleanup failure: ${launchStop.stopError}`);
    }

    // Poll to a terminal status through real nudges.
    const runStatus = await pollRunToTerminal({ repoRoot, env, runId: freshRunId, timeoutMs: 240000 });
    report.runStatus = runStatus;
    // Settle window so post-terminal event/usage writes drain.
    await sleep(1500);

    const { run: dbRun, steps, stats } = await readBrunDbRows(sandbox, freshRunId);
    report.dbRun = dbRun;
    report.steps = steps;
    report.stats = stats;

    report.receipts = await collectReceipts(sandbox, freshRunId);
    report.events = report.receipts.events;
    report.invocations = report.receipts.invocations;
  } catch (e: unknown) {
    report.error = describeError(e);
    throw e;
  } finally {
    if (launch && !launchStopped) {
      try {
        report.launchStop = await launch.stop();
        launchStopped = true;
      } catch (e) {
        report.launchStop = { stopError: e instanceof Error ? e.message : String(e) };
      }
    }
    if (daemon) {
      try {
        report.daemonStop = await stopExactChild(daemon.child);
      } catch (e) {
        report.daemonStop = { stopError: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  // ── Cleanup / closure evidence ────────────────────────────────────
  const daemonSpawnError =
    report.daemonStop && typeof report.daemonStop.spawnError === "string"
      ? report.daemonStop.spawnError
      : null;
  const cleanupFailures: string[] = [];
  if (daemon) {
    if (daemonSpawnError) {
      // daemon never spawned — no process/listener existed
    } else if (!report.daemonStop || !report.daemonStop.exitObserved || report.daemonStop.stopError) {
      cleanupFailures.push(
        `daemon shutdown not positively observed (${JSON.stringify(report.daemonStop)})`,
      );
    } else {
      report.controlPortProbe = await probePortClosed(controlPort);
      if (report.controlPortProbe.state !== "released") {
        cleanupFailures.push(
          `control listener release not positively evidenced (${report.controlPortProbe.state}: ${report.controlPortProbe.detail})`,
        );
      }
    }
  }
  if (report.launchStop) {
    if (report.launchStop.stopError) {
      cleanupFailures.push(`run-CLI launcher cleanup failure: ${report.launchStop.stopError}`);
    } else if (report.launchStop.exitObserved !== true && !report.launchStop.spawnError) {
      cleanupFailures.push("run-CLI launcher shutdown not positively observed");
    }
  }
  report.cleanup = { clean: cleanupFailures.length === 0, failures: cleanupFailures };
  if (report.error === null && !report.cleanup.clean) {
    report.error = { message: `cleanup failures: ${cleanupFailures.join("; ")}` };
  }
  return report;
}

// ── Parsing helpers for the daemon log ──────────────────────────────

function daemonLogPath(sandbox: any): string {
  return path.join(sandbox.tamanduaDir, "tamandua.log");
}

describe("CORE-CELLS US-003 — BRUN launch-probe versus probe-passing mid-run instant-fail dsh path", () => {
  it("BRUN source facts are preserved: MISSING_CREDENTIAL shape, UNKNOWN exact stdout byte, declared-synthetic newline, no private-source dependency", async () => {
    const assets = await loadAssets();
    const asset = assets.loadBrunAsset();
    assert.equal(asset.caseId, "W4.dsh-do-now-missing-credential");
    assert.equal(asset.sourceIdentity.runId, "ba584b54-fbb3-40b4-a7cc-34f5d6843a2d");
    const blob = JSON.stringify(asset);
    const check = assets.assertNoPrivateSourceDependency(blob);
    assert.equal(check.ok, true, `asset depends on a private location (${check.marker ?? "?"})`);
    for (const marker of ["igorhvr", "/home/", "file:///home", "sk-", "ghp_", "BEGIN PRIVATE KEY"]) {
      assert.equal(blob.includes(marker), false, `asset must not contain private marker ${marker}`);
    }

    const h = asset.historical;
    // Recorded missing-credential facts (source-backed).
    assert.equal(h.roundShape.exitCode, 1, "producer exits 1");
    assert.equal(h.roundShape.signal, null);
    assert.equal(h.roundShape.durationMs, 762);
    assert.equal(h.roundShape.stdoutBytes, 1, "stdoutBytes=1 recorded");
    assert.equal(h.roundShape.stdoutTrimmedBytes, 0, "empty trimmed output recorded");
    assert.equal(h.roundShape.emptyTrimmedOutput, true);
    assert.equal(h.missingCredentialCode.code, "MISSING_CREDENTIAL");
    assert.equal(h.missingCredentialCode.valueBytes, Buffer.byteLength("MISSING_CREDENTIAL", "utf-8"));
    assert.deepEqual(h.missingCredentialCode.terminalCodeCounts, { MISSING_CREDENTIAL: 21 });
    assert.equal(h.retainedSessions.matchedRunIdInNativePayload, 21);
    assert.equal(h.archivedDb.runRow.status, "canceled");
    assert.equal(h.archivedDb.runRow.tokensSpent, 0);

    // UNKNOWN exact stdout byte, with reason; newline explicitly synthetic.
    assert.equal(h.exactStdoutByte.value, "UNKNOWN");
    assert.ok(h.exactStdoutByte.reason.length > 40, "reason for the UNKNOWN byte must be recorded");
    assert.equal(h.exactStdoutByte.classification, "unknown");
    assert.equal(h.newlineAdaptation.implemented, true);
    assert.equal(h.newlineAdaptation.classification, "synthetic");
    assert.match(h.newlineAdaptation.note, /presented as the captured historical byte/i);

    // Deterministic source digest over the public payload.
    assert.equal(asset.sourceSha256.length, 64);
    assert.equal(asset.sourceSha256, assets.brunSpecimenSourceSha256());

    // Corridor declarations carry the bounded per-test override labels.
    assert.equal(asset.corridors.a_first_dispatch_probe_failure.expected.probeFailedCount, 1);
    assert.equal(asset.corridors.a_first_dispatch_probe_failure.expected.workRoundCount, 0);
    assert.equal(asset.corridors.b_probe_passing_mid_run_instant_fail.testOnlyOverrides.K, 2);
    assert.equal(asset.corridors.b_probe_passing_mid_run_instant_fail.testOnlyOverrides.N, 4);
    assert.match(
      asset.corridors.b_probe_passing_mid_run_instant_fail.testOnlyOverrides.note,
      /not proof of production defaults|production defaults K6\/N20 remain/,
    );
  });

  it("product defaults K6/N20 are preserved in the built implementation (corridor overrides are bounded and separate)", async () => {
    assert.equal(distBuilt(), true, "dist must be built before the real-daemon designated gate");
    // Read the production defaults from the BUILT module (side-effect-free:
    // instant-fail.ts has no runtime imports). These are the defaults the
    // daemon uses whenever the env overrides are absent.
    const instantFail = await import(
      pathToFileURL(path.join(repoRoot, "dist", "installer", "instant-fail.js")).href
    );
    assert.equal(
      instantFail.DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD,
      6,
      "product default K=6 must be preserved",
    );
    assert.equal(
      instantFail.DEFAULT_INSTANT_FAIL_ESCALATION_THRESHOLD,
      20,
      "product default N=20 must be preserved",
    );
    // PORT US-008: the base product raised the harness-wall threshold default
    // from 2000ms to 6000ms in base commit 098c4f5f ("add pre-claim death
    // backoff and harness-wall-time classification"). Base is product truth,
    // so the guard tracks the current built default.
    assert.equal(instantFail.DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS, 6000);
    assert.equal(instantFail.DEFAULT_INSTANT_FAIL_BACKOFF_BASE_MS, 30000);
    // The asset's test-only overrides stay clearly separate from the defaults.
    const assets = await loadAssets();
    const corridorB = assets.loadBrunAsset().corridors.b_probe_passing_mid_run_instant_fail;
    assert.notEqual(corridorB.testOnlyOverrides.K, instantFail.DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD);
    assert.notEqual(corridorB.testOnlyOverrides.N, instantFail.DEFAULT_INSTANT_FAIL_ESCALATION_THRESHOLD);
  });

  it("corridor (a): first-dispatch REAL launch-probe failure for the MISSING_CREDENTIAL shape through the plain-stdout dsh path", async () => {
    assert.equal(distBuilt(), true, "dist must be built before running the real-daemon designated gate");
    const assets = await loadAssets();
    assert.equal(
      assets.loadBrunAsset().corridors.a_first_dispatch_probe_failure.expected.workRoundCount,
      0,
      "corridor (a) expects zero work rounds",
    );
    const taskText =
      "Synthetic zero-token BRUN corridor (a): first-dispatch REAL launch-probe " +
      "failure of a launch-broken dsh producer reproducing the recorded " +
      "W4.dsh-do-now MISSING_CREDENTIAL shape (source run " +
      "ba584b54-fbb3-40b4-a7cc-34f5d6843a2d). No real credentials/provider/network.";
    // eslint-disable-next-line no-console
    console.log(`[brun-cell] corridor (a) first-dispatch probe failure (evidence root ${EVIDENCE_ROOT})`);
    const report = await runDshCorridor({ corridor: "a_first_dispatch_probe_failure", taskText });

    const evidenceDir = path.join(EVIDENCE_ROOT, "corridor-a");
    writeJson(path.join(evidenceDir, "case-report.json"), {
      corridor: report.corridor,
      freshRunId: report.freshRunId,
      runStatus: report.runStatus,
      dbRun: report.dbRun,
      steps: report.steps,
      artifacts: report.artifacts,
      cleanup: report.cleanup,
      daemonStop: report.daemonStop,
      controlPortProbe: report.controlPortProbe,
      error: report.error,
    });

    assert.equal(report.cleanup.clean, true, `corridor (a) cleanup unclean: ${report.cleanup.failures.join("; ")}`);
    assert.ok(report.freshRunId, "fresh run id missing");
    assert.notEqual(report.freshRunId, assets.loadBrunAsset().sourceIdentity.runId, "fresh run id must never equal the historical uuid");

    // ── The probe FAILED (first-dispatch real launch-probe failure).
    const events = report.events ?? [];
    const probeOk = events.filter((e: any) => e.event === "run.harness_probe_ok");
    const probeFailed = events.filter((e: any) => e.event === "run.harness_probe_failed");
    assert.equal(probeOk.length, 0, "no probe-ok event may exist");
    assert.equal(probeFailed.length, 1, "exactly one run.harness_probe_failed expected");
    assert.equal(probeFailed[0].harness, "dsh", "probe failure must be harness dsh");
    assert.equal(probeFailed[0].runId, report.freshRunId, "probe event must bind the FRESH run");
    assert.equal(probeFailed[0].exitCode, 1, "recorded exit-1 producer shape reproduced");
    assert.match(probeFailed[0].reason ?? "", /FAILURE_CLASS: harness_unavailable/);
    assert.match((probeFailed[0].stderrTail ?? "").toString(), /MISSING_CREDENTIAL/, "recorded error code present in stderr forensics");
    assert.ok(events.some((e: any) => e.event === "run.force_failed"), "probe failure must force-fail the run");
    assert.equal(events.filter((e: any) => e.event === "run.instant_fail_loop").length, 0, "a probe failure is NOT an instant-fail loop");

    // ── Run/DB state: force-failed, probe failed, zero instant-fail count.
    assert.equal(report.runStatus, "failed");
    assert.equal(report.dbRun.harness_probe_status, "failed");
    assert.equal(report.dbRun.instant_fail_count, 0, "probe rounds are never classified as instant-fail");
    assert.ok(["waiting", "pending", "canceled"].includes(report.steps[0]?.status), `step must never be done (got ${report.steps[0]?.status})`);
    assert.equal(report.dbRun.tokens_spent, 0, "runs.tokens_spent must be 0");
    assert.equal(report.stats?.system_tokens_spent ?? 0, 0, "tamandua_stats.system_tokens_spent must be 0");

    // ── Zero work rounds: no invocation journal rows at all.
    const invocations = report.invocations ?? [];
    assert.equal(invocations.length, 0, `no work round may run (got ${invocations.length} invocation rows)`);
    assert.equal(report.receipts.workcounts[AGENT] ?? 0, 0, "no work index may be consumed");

    // ── Fresh daemon log mirrors the recorded round shape (exit 1 fast,
    //    stdoutBytes=1, empty trimmed output, MISSING_CREDENTIAL stderr) on
    //    the PROBE round (the modern first-dispatch equivalent of the
    //    historical 21 launch-broken rounds).
    const logPath = report.artifacts?.logPath;
    const completed = readLogLinesWithJson(logPath, "dsh completed");
    const failedLines = readLogLinesWithJson(logPath, "dsh execution failed");
    writeJson(path.join(evidenceDir, "fresh-round-shape.json"), {
      dshCompleted: completed.map((l) => l.meta),
      dshExecutionFailed: failedLines.map((l) => l.meta),
      note: "fresh corridor-(a) log lines mirror the recorded stdoutBytes=1/exit-1/empty-trimmed shape; the single stdout byte is a declared-synthetic newline (historical byte UNKNOWN)",
    });
    const completedMeta = completed.find((l) => l.meta.exitCode === 1);
    assert.ok(completedMeta, "a dsh completed line with exitCode 1 must exist");
    assert.equal(completedMeta.meta.stdoutBytes, 1, "stdoutBytes=1 reproduced on the fresh probe round");
    assert.equal(completedMeta.meta.stdoutPreview, "", "trimmed stdout preview must be empty");
    const failedMeta = failedLines.find((l) => l.meta.exitCode === 1);
    assert.ok(failedMeta, "a dsh execution failed line with exitCode 1 must exist");
    assert.match(failedMeta.meta.stderrPreview ?? "", /MISSING_CREDENTIAL/);
    assert.ok(
      Number(completedMeta.meta.durationMs) < 20000,
      `probe round must be fast (got ${completedMeta.meta.durationMs} ms)`,
    );
  });

  it("corridor (b): probe-passing mid-run instant-fail loop relaunches after backoff and escalates at N with exact bounded accounting", async () => {
    assert.equal(distBuilt(), true, "dist must be built before running the real-daemon designated gate");
    const assets = await loadAssets();
    const asset = assets.loadBrunAsset();
    const corridorSpec = asset.corridors.b_probe_passing_mid_run_instant_fail;
    const ov = corridorSpec.testOnlyOverrides;
    const taskText =
      "Synthetic zero-token BRUN corridor (b): probe-passing mid-run instant-fail " +
      "loop of the suite-owned plain-stdout dsh runtime (die-before-claim exit 1). " +
      "Bounded test-only overrides K=2/N=4/base 3s; product defaults K6/N20 are " +
      "asserted unchanged elsewhere. Source run ba584b54-fbb3-40b4-a7cc-34f5d6843a2d " +
      "is provenance only. No real credentials/provider/network.";
    // eslint-disable-next-line no-console
    console.log(`[brun-cell] corridor (b) probe-passing mid-run instant-fail (evidence root ${EVIDENCE_ROOT})`);
    const report = await runDshCorridor({ corridor: "b_probe_passing_mid_run_instant_fail", taskText });

    const evidenceDir = path.join(EVIDENCE_ROOT, "corridor-b");
    writeJson(path.join(evidenceDir, "case-report.json"), {
      corridor: report.corridor,
      freshRunId: report.freshRunId,
      runStatus: report.runStatus,
      dbRun: report.dbRun,
      steps: report.steps,
      artifacts: report.artifacts,
      testOnlyOverrides: ov,
      productDefaultsNote: corridorSpec.productDefaultNote ?? "production defaults asserted unchanged from the built module",
      cleanup: report.cleanup,
      daemonStop: report.daemonStop,
      controlPortProbe: report.controlPortProbe,
      error: report.error,
    });

    assert.equal(report.cleanup.clean, true, `corridor (b) cleanup unclean: ${report.cleanup.failures.join("; ")}`);
    assert.ok(report.freshRunId, "fresh run id missing");
    assert.notEqual(report.freshRunId, asset.sourceIdentity.runId, "fresh run id must never equal the historical uuid");

    const events = report.events ?? [];
    const probeOk = events.filter((e: any) => e.event === "run.harness_probe_ok");
    const probeFailed = events.filter((e: any) => e.event === "run.harness_probe_failed");
    assert.equal(probeOk.length, 1, "exactly one run.harness_probe_ok expected (probe PASSES)");
    assert.equal(probeOk[0].harness, "dsh", "probe-ok must be harness dsh");
    assert.equal(probeOk[0].runId, report.freshRunId, "probe-ok must bind the FRESH run");
    assert.equal(probeFailed.length, 0, "no probe failure may exist");

    // ── Escalation: exactly one run.instant_fail_loop at N=4.
    const loopEvents = events.filter((e: any) => e.event === "run.instant_fail_loop");
    assert.equal(loopEvents.length, 1, "exactly one run.instant_fail_loop expected");
    assert.equal(loopEvents[0].consecutiveInstantFails, ov.N, "loop event carries N consecutive instant-fail rounds");
    assert.match(loopEvents[0].reason ?? "", /worker instant-fail loop/);
    assert.ok(events.some((e: any) => e.event === "run.force_failed"), "instant-fail escalation force-fails the run");
    assert.equal(report.runStatus, "failed", "run must be force-failed (failed)");
    assert.equal(report.dbRun.harness_probe_status, "ok");
    assert.equal(report.dbRun.instant_fail_count, ov.N, "runs.instant_fail_count must equal the N consecutive rounds");

    // ── Zero tokens; step never completed.
    assert.equal(report.dbRun.tokens_spent, 0, "runs.tokens_spent must be 0");
    assert.equal(report.stats?.system_tokens_spent ?? 0, 0, "tamandua_stats.system_tokens_spent must be 0");
    assert.ok(["waiting", "pending", "canceled"].includes(report.steps[0]?.status), `step must never be done (got ${report.steps[0]?.status})`);

    // ── EXACT bounded relaunch accounting: N die-before-claim work rounds at
    //    contiguous work indices (0..N-1) — i.e. the motor RELAUNCHED after
    //    each backoff window instead of stranding as previous_round_in_flight.
    const invocations = report.invocations ?? [];
    const workRows = invocations.filter((i: any) => i.phase === "work");
    assert.equal(workRows.length, ov.N, `exactly N=${ov.N} work rounds must have run (relaunch after backoff), got ${workRows.length}`);
    const indices = workRows.map((i: any) => i.workIndex).sort((a: number, b: number) => a - b);
    assert.deepEqual(indices, [0, 1, 2, 3], "work indices must be contiguous 0..N-1 (each relaunch consumed a fresh round)");
    const normRunId = (id: unknown) => String(id).replace(/^run-/, "");
    for (const row of workRows) {
      assert.equal(row.mode, "die-before-claim", "every work round must die before claim");
      assert.equal(
        normRunId(row.runId),
        normRunId(report.freshRunId),
        "every invocation must bind the FRESH run",
      );
    }
    const resultRows = invocations.filter((i: any) => i.phase === "result");
    assert.equal(resultRows.length, 0, "no round may claim/report");
    const heartbeatRows = invocations.filter((i: any) => i.phase === "heartbeat");
    assert.equal(heartbeatRows.length, 0, "no heartbeat spawns (work always pending)");

    // ── Backoff evidence in the daemon log: at least one gated tick between
    //    relaunches (instant_fail_backoff) and NO permanent stranding after a
    //    backoff-gated tick (N was reached).
    const logPath = report.artifacts?.logPath;
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
    assert.match(logText, /instant_fail_backoff/, "a backoff-gated dispatch skip must appear in the daemon log");
    assert.match(logText, /Worker round classified as instant fail/, "instant-fail classifications must be logged");
    writeJson(path.join(evidenceDir, "daemon-log-evidence.json"), {
      hasInstantFailBackoffSkip: /instant_fail_backoff/.test(logText),
      hasInstantFailClassification: /Worker round classified as instant fail/.test(logText),
      workRoundCount: workRows.length,
      instantFailCountDb: report.dbRun.instant_fail_count,
      loopEventCount: loopEvents.length,
      logTail: logText.slice(-8000),
    });

    // Compact receipts summary retained as evidence.
    writeJson(path.join(evidenceDir, "receipts-summary.json"), {
      runStatus: report.runStatus,
      freshRunId: report.freshRunId,
      probeOk: probeOk.length,
      probeFailed: probeFailed.length,
      instantFailLoop: loopEvents.length,
      dbInstantFailCount: report.dbRun.instant_fail_count,
      workRows: workRows.map((i: any) => ({ workIndex: i.workIndex, mode: i.mode, runId: i.runId })),
      tokens: { runs: report.dbRun.tokens_spent, system: report.stats?.system_tokens_spent ?? 0 },
    });
  });

  it("retained evidence root holds real receipts, daemon logs and closure records for both corridors", async () => {
    for (const dir of ["corridor-a", "corridor-b"]) {
      const caseReportPath = path.join(EVIDENCE_ROOT, dir, "case-report.json");
      assert.ok(fs.existsSync(caseReportPath), `${dir} case report missing`);
      const caseReport = JSON.parse(fs.readFileSync(caseReportPath, "utf-8"));
      assert.equal(caseReport.cleanup.clean, true, `${dir} cleanup not clean`);
      assert.ok(caseReport.freshRunId, `${dir} fresh run id missing`);
      assert.equal(caseReport.dbRun.id, caseReport.freshRunId, `${dir} DB run row must bind the fresh run id`);
      // Real receipts under the retained sandbox (paths recorded by the runner).
      const dbPath = caseReport.artifacts?.dbPath;
      assert.ok(dbPath && fs.existsSync(dbPath), `${dir} isolated DB must be retained`);
      const eventsPath = caseReport.artifacts?.eventsPath;
      assert.ok(eventsPath && fs.existsSync(eventsPath), `${dir} per-run events file must be retained`);
      const logPath = caseReport.artifacts?.logPath;
      assert.ok(logPath && fs.existsSync(logPath), `${dir} daemon log must be retained`);
      const eventsText = fs.readFileSync(eventsPath, "utf-8");
      if (dir === "corridor-a") {
        assert.match(eventsText, /run\.harness_probe_failed/, "corridor (a) events must retain the probe-failure receipt");
      } else {
        assert.match(eventsText, /run\.instant_fail_loop/, "corridor (b) events must retain the instant-fail-loop receipt");
      }
      const receiptsSummaryPath = path.join(EVIDENCE_ROOT, dir, "receipts-summary.json");
      if (dir === "corridor-b") {
        assert.ok(fs.existsSync(receiptsSummaryPath), "corridor (b) receipts summary missing");
      }
    }
  });

  it("evidence summary written with git head and per-corridor results", async () => {
    const assets = await loadAssets();
    const asset = assets.loadBrunAsset();
    const summary = {
      evidenceRoot: EVIDENCE_ROOT,
      gitHead: gitHead(),
      caseId: asset.caseId,
      historicalRunId: asset.sourceIdentity.runId,
      exactStdoutByte: asset.historical.exactStdoutByte,
      newlineAdaptation: asset.historical.newlineAdaptation,
    };
    writeJson(path.join(EVIDENCE_ROOT, "cells-summary.json"), summary);
    assert.equal(summary.historicalRunId, "ba584b54-fbb3-40b4-a7cc-34f5d6843a2d");
  });
});
