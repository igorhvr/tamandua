/******************************************************************************
 * ⚠️  WARNING: SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-FIX item 1c (US-005) — the LONG-HOME (>= 90 char) zero-provider
 * whole-path gate.
 *
 * The real-model qualification (run #70, isolated run ea2b810c) failed before
 * any model call because the private HOME was long enough that the Firecracker
 * API unix socket path Matchlock derives from HOME exceeded Linux's 107-byte
 * `sockaddr_un` limit. This gate proves the delivery fix end-to-end: a real
 * HOME path of >= 90 characters, with the DEFAULT short-HOME alias (no
 * TAMANDUA_MATCHLOCK_HOME_ALIAS override), still reaches real run completion
 * through an isolated daemon → scheduler → Matchlock runner → a FRESH VM.
 *
 * It runs ONE zero-provider `do-now` round with the deterministic TEST-ONLY
 * "synthetic pi" fixture image (e2e-tests/matchlock-fixture/). NO provider
 * credentials and NO model calls anywhere in the gate.
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand only:
 *
 *   ./run-matchlock-long-home-e2e-test
 *
 * which builds first, resolves the paired runtime binaries (unpinned), creates a NEW
 * mkdtemp evidence directory under /root/matchlock-work/evidence/mtlk-fix-XXXXXX/
 * (outside the repo; never pre-cleaned/reused), keeps a private fresh TMPDIR for
 * scratch, and runs this file with a private isolated HOME rooted INSIDE that
 * evidence directory. The DEFAULT alias is the LITERAL /tmp/tamandua/<uid>/h
 * (never the platform temp dir), so a deep TMPDIR cannot lengthen it; the gate does NOT
 * need TMPDIR to shorten the alias.
 *
 * Per-run assertions:
 *   - the run reaches real status "completed";
 *   - the real HOME is >= 90 chars AND its computed socket path exceeds 107
 *     bytes (it WOULD fail without the alias), while the resolved default alias
 *     socket path is under 107 bytes;
 *   - the guest progress document persists, every step is done with
 *     STATUS: done, and the packed tamandua-test recorded an integer exit in
 *     [0,255] bound to THIS run in the host-owned suite store;
 *   - one distinct fresh VM per probe/work invocation (2 for do-now);
 *   - positive exact-owned VM teardown with a ledger (exact-id `matchlock rm`).
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB/TMPDIR under the evidence dir,
 * schema10 only there, TAMANDUA_TEST_GUARD auto-active under node:test, random
 * control port, never the live worker daemon.
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
  LONG_HOME_MIN_CHARS,
  buildLongHomePath,
  probeLongHomeAlias,
  type LongHomeAliasProbe,
} from "./helpers/matchlock-long-home.ts";
import {
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";
import type { PortHandle } from "../tests/helpers/test-env.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

// ── environment: resolved (unpinned) paired runtime ────────────────────────────────────
// The runner script (run-matchlock-long-home-e2e-test) resolves these (or leaves guest-init to
// matchlock) before launching this file; the test only requires any resolved
// paths to exist.
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

// Deterministic TEST-ONLY fixture image tag (never igorhvr/bedlam-ubuntu).
const FIXTURE_IMAGE_TAG = "tamandua-synthetic-pi:gate-fixture";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "matchlock-fixture");
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-pi";

// Evidence root: the runner exports TAMANDUA_GATE_EVIDENCE_DIR (a NEW
// /root/matchlock-work/evidence/mtlk-fix-XXXXXX/ directory).
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";

// Observed-rounds honesty (TESTER-HONESTY item 3): the label shared by this
// driver and its runner's `scripts/observed-rounds-guard.mjs` invocation.
const GATE_LABEL = "long-home";

const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 25 * 60_000;

// Synthetic pi usage total: do-now = 1 work round x 111 (the probe carries 0).
const DO_NOW_TOKEN_EXPECT = 111;

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
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-long-home-e2e-test)",
  );
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

/** Prepare a fresh small git repo (clean tracked tree) for the synthetic run. */
function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# Long-HOME gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n.matchlock-synthetic-pi/\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Matchlock Long-HOME Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

/** A tiny in-gate VM receipts sampler (distinct owned ids, first/last seen). */
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

// ── shared state ──────────────────────────────────────────────────────────
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
let aliasProbe: LongHomeAliasProbe | null = null;
let cleanupCompleted = false;

describe(
  "matchlock long-HOME (>= 90 char) zero-provider real-VM gate (US-005)",
  { concurrency: 1 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      // The DEFAULT alias is under test: refuse an ambient override so the
      // gate cannot accidentally pass with a hand-configured alias.
      const override = process.env.TAMANDUA_MATCHLOCK_HOME_ALIAS;
      assert.ok(
        override === undefined || override.trim() === "",
        `long-HOME gate requires the DEFAULT alias; TAMANDUA_MATCHLOCK_HOME_ALIAS must be unset (got "${override}")`,
      );

      // A real HOME path of >= 90 characters under the fresh evidence root.
      homeDir = buildLongHomePath(EVIDENCE_DIR);
      assert.ok(
        Buffer.byteLength(homeDir, "utf8") >= LONG_HOME_MIN_CHARS,
        `long-HOME gate HOME must be >= ${LONG_HOME_MIN_CHARS} chars: ${homeDir}`,
      );
      // The real HOME must exist before the alias resolver verifies its target.
      fs.mkdirSync(homeDir, { recursive: true });

      // Prove the premise + the fix BEFORE any VM: the real HOME alone exceeds
      // the 107-byte sun_path limit, the verified DEFAULT alias does not.
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      aliasProbe = probeLongHomeAlias(homeDir, { env: {}, uid });
      assert.ok(
        aliasProbe.realHomeRefusal,
        `real HOME ${aliasProbe.realHomeLength} -> socket ${aliasProbe.realHomeSocketBytes} bytes must exceed the limit`,
      );
      assert.equal(aliasProbe.aliasRefusal, null);
      assert.ok(
        aliasProbe.aliasSocketBytes < aliasProbe.limit,
        `default alias socket path must fit under ${aliasProbe.limit} bytes (got ${aliasProbe.aliasSocketBytes}: ${aliasProbe.aliasSocketPath})`,
      );
      assert.equal(aliasProbe.resolution.disabled, false);
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "long-home-alias.json"),
        JSON.stringify(
          {
            realHome: aliasProbe.realHome,
            realHomeLength: aliasProbe.realHomeLength,
            realHomeSocketPath: aliasProbe.realHomeSocketPath,
            realHomeSocketBytes: aliasProbe.realHomeSocketBytes,
            realHomeRefusalMessage: aliasProbe.realHomeRefusal?.message ?? null,
            aliasHome: aliasProbe.aliasHome,
            aliasSocketPath: aliasProbe.aliasSocketPath,
            aliasSocketBytes: aliasProbe.aliasSocketBytes,
            aliasRefusal: aliasProbe.aliasRefusal,
            limit: aliasProbe.limit,
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );

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

      // Kernel cache for the fresh matchlock state (the candidate runtime
      // resolves kernels under $HOME/.cache/matchlock). Copy the qualified
      // kernel tree — never mutate the operator's cache.
      const kernelSrc = "/root/.cache/matchlock/kernels";
      assert.ok(fs.existsSync(kernelSrc), `kernel cache source missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), {
        recursive: true,
      });

      // ── build + import the TEST-ONLY derived fixture image ──────────
      const dockerBuild = spawnSync(
        "/usr/bin/docker", ["build", "-f", FIXTURE_DOCKERFILE, "-t", FIXTURE_IMAGE_TAG, "."],
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
        `docker build of the synthetic fixture failed (exit ${dockerBuild.status}, signal ${dockerBuild.signal}, error ${
          dockerBuild.error ? dockerBuild.error.message : "none"
        }):\n${(dockerBuild.stdout || "").slice(-4000)}\n${(dockerBuild.stderr || "").slice(-4000)}`,
      );
      // docker save → fixture tar streamed to a file (spawnSync stdout
      // buffering would corrupt a multi-hundred-MB tar).
      const fixtureTar = path.join(EVIDENCE_DIR, "fixture-image.tar");
      const saveOutFd = fs.openSync(fixtureTar, "w");
      const dockerSave = spawnSync("/usr/bin/docker", ["save", FIXTURE_IMAGE_TAG], {
        stdio: ["ignore", saveOutFd, "pipe"],
        env: inheritedProcessEnv(),
      });
      fs.closeSync(saveOutFd);
      assert.equal(
        dockerSave.status,
        0,
        `docker save of the synthetic fixture failed: ${dockerSave.stderr}`,
      );
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
      const resolved = spawnSync(MATCHLOCK_RPC_BIN, ["image", "resolve", FIXTURE_IMAGE_TAG], {
        encoding: "utf-8",
        env: importEnv,
      });
      assert.equal(resolved.status, 0, `matchlock image resolve failed: ${resolved.stderr}`);
      const identity = JSON.parse(resolved.stdout.trim()) as { digest: string; config_digest: string };
      assert.ok(
        identity.digest.startsWith("sha256:") && identity.config_digest.startsWith("sha256:"),
        "resolved fixture identity incomplete",
      );

      portHandles = await reservePortHandles(1);
      controlPort = portHandles[0].port;
      fs.writeFileSync(path.join(tamanduaDir, "port"), String(controlPort), "utf-8");
      env = gateEnv(homeDir, controlPort);

      cliMustSucceed(["workflow", "install", "do-now"], env, "install do-now workflow");

      // Fresh git fixture working directory (harmless owned fixture action
      // target; host evidence retained under the evidence dir).
      wdNow = prepareFixtureRepo(path.join(EVIDENCE_DIR, "fixtures", "wd-now"));
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");
    });

    after(async () => {
      // Emergency teardown that NEVER swallows cleanup failure: if the test
      // body never ran its authoritative cleanup (early failure), this hook
      // performs the exact-id VM disposal and PROPAGATES any failure.
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
        throw new Error(`long-HOME gate after-hook cleanup failed:\n${errors.join("\n")}`);
      }
    });

    it(
      "one zero-provider do-now run completes through fresh VMs under a >=90-char HOME",
      { timeout: 60 * 60_000 },
      async () => {
        // ── Start the isolated real daemon ─────────────────────────
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
              process.stderr.write(`[matchlock-long-home-gate] VM receipt sampler failed: ${String(err)}\n`);
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
              "Long-HOME gate: under a >= 90-char HOME, execute the harmless owned fixture action and report.",
              "--working-directory-for-harness", wdNow,
              "--matchlock", FIXTURE_IMAGE_TAG,
            ],
            env,
            60_000,
          );
          runNowId = resolveFullRunId(nowPrefix, tamanduaDir);
          const nowStatus = await pollTerminalWithNudge(runNowId, env, tamanduaDir, "do-now");
          assert.equal(nowStatus, "completed", `do-now run must complete under a long HOME; got ${nowStatus}`);
          await sleep(500);
          assertRunEvidence(runNowId, wdNow);

          // Whole-path / no-fallback assertions.
          const events = readRunEvents(tamanduaDir, runNowId);
          const byType = new Map<string, number>();
          for (const e of events) byType.set(String(e.event), (byType.get(String(e.event)) ?? 0) + 1);
          assert.equal(byType.get("run.completed") ?? 0, 1, "expected exactly one run.completed event");
          assert.equal(
            byType.get("run.harness_probe_ok") ?? 0,
            1,
            "expected exactly one run.harness_probe_ok event",
          );
          for (const bad of [
            "run.matchlock_dispatch_refused",
            "run.matchlock_invocation_infra_failed",
            "run.harness_probe_failed",
            "run.instant_fail_loop",
            "run.failed",
          ]) {
            assert.equal(byType.get(bad) ?? 0, 0, `unexpected ${bad} event`);
          }

          // Fresh VM per invocation: do-now = 1 probe + 1 work → 2 distinct.
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

        // Authoritative exact-owned VM teardown + ledger (cleanup failure
        // propagates and fails the gate).
        const { ledger } = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
        cleanupCompleted = true;
        assert.ok(fs.existsSync(ledgerPath), `vm cleanup ledger missing at ${ledgerPath}`);
        assert.ok(
          ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
          "cleanup ledger must record completion with no leftovers",
        );
        console.log(
          `[matchlock-long-home-gate] OK home=${homeDir} (${homeDir.length} chars) alias=${aliasProbe?.aliasHome} run=${runNowId} vms=${observedVmIds.length}`,
        );
      },
    );
  },
);

/**
 * Assert one completed synthetic matchlock run under the long HOME: progress
 * resource persisted, real step DB rows, host suite store row bound to the run
 * with an integer exit, intended usage total, and the retained fixture marker.
 */
function assertRunEvidence(runId: string, repoDir: string): void {
  const progressFile = path.join(tamanduaDir, "runs", runId, "progress-resource", "progress.txt");
  assert.ok(fs.existsSync(progressFile), `guest progress document missing at ${progressFile}`);
  assert.ok(fs.readFileSync(progressFile, "utf-8").trim().length > 0, "progress document is empty");

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
    const runRow = db
      .prepare("SELECT tokens_spent FROM runs WHERE id = ?")
      .get(runId) as { tokens_spent: number } | undefined;
    assert.ok(runRow, "run row missing tokens_spent");
    assert.equal(
      runRow.tokens_spent,
      DO_NOW_TOKEN_EXPECT,
      `expected synthetic usage total ${DO_NOW_TOKEN_EXPECT}, got ${runRow.tokens_spent}`,
    );
  } finally {
    db.close();
  }

  const suiteStore = path.join(tamanduaDir, "matchlock", "suite", "host-suite.db");
  assert.ok(fs.existsSync(suiteStore), `host suite store missing at ${suiteStore}`);
  const sdb = openE2eDatabase(suiteStore);
  try {
    const rows = sdb
      .prepare(
        "SELECT id, origin_repo, tree_hash, cmd_hash, exit_code, run_id, invocation_id, agent_id, job_id FROM host_suite_results ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
    const runRows = rows.filter((r) => String(r.run_id ?? "") === runId);
    assert.ok(runRows.length >= 1, `no suite result row EXACTLY bound to run ${runId}`);
    const rec = runRows[0];
    assert.equal(String(rec.origin_repo ?? ""), repoDir, "suite origin_repo must equal the admitted fixture repo");
    assert.ok(/^[0-9a-f]{40}$/.test(String(rec.tree_hash ?? "")), "suite tree_hash must be 40-hex");
    assert.ok(Number.isInteger(rec.exit_code) && (rec.exit_code as number) >= 0 && (rec.exit_code as number) <= 255,
      `suite exit_code must be an integer in [0,255] (got ${rec.exit_code})`);
    assert.ok(String(rec.cmd_hash ?? "").length > 0, "suite row missing cmd_hash");
    assert.ok(String(rec.invocation_id ?? "").length > 0, "suite row must carry a host-bound invocation id");
    assert.ok(String(rec.agent_id ?? "").length > 0, "suite row must carry the bound agent id");
    assert.ok(String(rec.job_id ?? "").length > 0, "suite row must carry the bound job id");
  } finally {
    sdb.close();
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
      if (["completed", "done", "failed", "canceled"].includes(lastStatus)) {
        return lastStatus;
      }
    }
    spawnSync(process.execPath, [cliPath, "nudge"], {
      env: cleanChildEnv(envIn),
      encoding: "utf-8",
    });
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
