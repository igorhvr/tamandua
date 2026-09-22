/******************************************************************************
 * ⚠️  WARNING: SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-ALIAS-FIX US-005 — the TWO-DAEMON alias isolation regression gate.
 *
 * The defect (captured twice on vaimetal): the Matchlock short-HOME alias was
 * ONE symlink per uid (`/tmp/tamandua/<uid>/h`). On 2026-09-21T08:06:20Z the
 * synthetic gate of run #53 started its test daemon and the alias flipped to
 * that daemon's home while run #54 (a production run inside a VM) was creating
 * its next VM under the alias:
 *
 *   prepare bootstrap rootfs: create /tmp/tamandua/1000/h/.matchlock/vms/
 *   vm-504ed942/bootstrap.ext4: no such file or directory
 *
 * which force-failed the run at story 7/7. Run #44 died the same way.
 *
 * This gate reproduces that shape on REAL VMs: two isolated production-style
 * daemons with DISTINCT private HOMEs and the SAME uid run concurrent
 * zero-provider `do-now` rounds through the DEFAULT keyed alias. It asserts:
 *
 *   - the two alias paths are DISTINCT under the per-uid keyed tree;
 *   - after daemon B resolves (and admits its own VM), daemon A's alias target
 *     is still byte-for-byte A's real HOME (readlink) and A's live VM state
 *     directory is still valid under A's own HOME;
 *   - both runs reach real status "completed" with the whole-path events
 *     (run.completed + run.harness_probe_ok) and NO alias/infra refusal;
 *   - the observed in-VM rounds are recorded through the shared
 *     matchlock-gate-rounds helper with distinct valid `vm-<8hex>` ids;
 *   - every VM is disposed by EXACT id (never by name/glob); a failed removal
 *     fails the gate and retains the state dir.
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand only:
 *
 *   ./run-matchlock-alias-isolation-e2e-test
 *
 * which takes `flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock`,
 * builds first, resolves the system runtime from PATH (unpinned) and records
 * the observed matchlock version + sha256 as evidence, allocates a NEW mkdtemp
 * evidence directory (outside the repo; never pre-cleaned/reused) and runs this
 * file with two private isolated HOME/STATE/DB trees rooted INSIDE it.
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB per daemon under the evidence
 * dir, TAMANDUA_TEST_GUARD=1, random control ports, never the live worker
 * daemon, never the operator's matchlock store. The gate NEVER touches the live
 * daemon's legacy `/tmp/tamandua/<uid>/h` alias.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanChildEnv, reservePortHandles } from "../tests/helpers/test-env.ts";
import type { PortHandle } from "../tests/helpers/test-env.ts";
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
  type VmInventory,
} from "./helpers/matchlock-gate-lifecycle.ts";
import {
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";
import { inspectMatchlockHomeAlias } from "../dist/installer/matchlock/home-alias.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

// ── environment: the driver resolves the UNPINNED runtime before this file ──
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

// Deterministic TEST-ONLY synthetic-pi fixture image (never a real provider).
const FIXTURE_IMAGE_TAG = "tamandua-synthetic-pi:alias-isolation-gate-fixture";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "matchlock-fixture");
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-pi";

// Evidence dir allocated by the runner; the guard reads observed-rounds.json
// from the SAME dir with the SAME gate label.
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";
const GATE_LABEL = "alias-isolation";
const FIXTURE_IMAGE_CACHE = process.env.TAMANDUA_GATE_FIXTURE_IMAGE_CACHE?.trim() || "";
const GATE_VCPUS = Math.min(
  16,
  Math.max(1, Number.parseInt(process.env.TAMANDUA_GATE_VCPUS ?? "1", 10) || 1),
);

const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 25 * 60_000;
const VM_WAIT_TIMEOUT_MS = 10 * 60_000;
const SAMPLE_INTERVAL_MS = 300;
// do-now = 1 work round x 111 synthetic tokens (the probe carries 0).
const DO_NOW_TOKEN_EXPECT = 111;

function matchlockRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = { TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN };
  if (GUEST_INIT.length > 0) env.MATCHLOCK_GUEST_INIT = GUEST_INIT;
  if (GUEST_FUSED.length > 0) env.MATCHLOCK_GUEST_FUSED = GUEST_FUSED;
  return env;
}

function assertEnv(): void {
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-alias-isolation-e2e-test)",
  );
  assert.ok(
    MATCHLOCK_RPC_BIN.length > 0,
    "TAMANDUA_MATCHLOCK_RPC_BIN must be set (the driver resolves matchlock from PATH)",
  );
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    if (p.length > 0) assert.ok(fs.existsSync(p), `resolved runtime binary missing: ${p}`);
  }
  // The DEFAULT keyed alias is under test: refuse an ambient override.
  const override = process.env.TAMANDUA_MATCHLOCK_HOME_ALIAS;
  assert.ok(
    override === undefined || override.trim() === "",
    `alias isolation gate requires the DEFAULT alias; TAMANDUA_MATCHLOCK_HOME_ALIAS must be unset (got "${override}")`,
  );
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

/** Fresh small git repo (clean tracked tree) for one synthetic do-now run. */
function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# Alias isolation gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n.matchlock-synthetic-pi/\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Matchlock Alias Isolation Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

interface DaemonGate {
  label: "A" | "B";
  homeDir: string;
  tamanduaDir: string;
  env: Record<string, string>;
  daemon: ChildProcess | null;
  controlPort: number;
  portHandles: PortHandle[];
  wd: string;
  runId: string;
  aliasPath: string;
  aliasKey: string;
  firstSeen: Map<string, string>;
  lastSeen: Map<string, string>;
  dirSeen: Set<string>;
  rowWithoutDir: string[];
  readErrors: number;
  samples: number;
  samplerTimer: NodeJS.Timeout | null;
  cleanupCompleted: boolean;
  ledgerPath: string;
}

function makeGate(label: "A" | "B", homeDir: string, controlPort: number): DaemonGate {
  return {
    label,
    homeDir,
    tamanduaDir: path.join(homeDir, ".tamandua"),
    env: gateEnv(homeDir, controlPort),
    daemon: null,
    controlPort,
    portHandles: [],
    wd: "",
    runId: "",
    aliasPath: "",
    aliasKey: "",
    firstSeen: new Map(),
    lastSeen: new Map(),
    dirSeen: new Set(),
    rowWithoutDir: [],
    readErrors: 0,
    samples: 0,
    samplerTimer: null,
    cleanupCompleted: false,
    ledgerPath: "",
  };
}

/** Sample one daemon's real VM inventory while its round is live. */
function sampleDaemon(gate: DaemonGate): void {
  gate.samples += 1;
  let inv: VmInventory;
  try {
    inv = readVmInventory(gate.homeDir);
  } catch {
    // The state DB may not exist yet, or be momentarily locked by matchlock.
    gate.readErrors += 1;
    return;
  }
  const ts = new Date().toISOString();
  const vmsDir = path.join(gate.homeDir, ".matchlock", "vms");
  for (const row of inv.rows) {
    if (!gate.firstSeen.has(row.id)) gate.firstSeen.set(row.id, ts);
    gate.lastSeen.set(row.id, ts);
    if (fs.existsSync(path.join(vmsDir, row.id))) gate.dirSeen.add(row.id);
    else gate.rowWithoutDir.push(`${row.id}@${ts}`);
  }
  for (const id of inv.dirIds) {
    if (!gate.firstSeen.has(id)) gate.firstSeen.set(id, ts);
    gate.lastSeen.set(id, ts);
    gate.dirSeen.add(id);
  }
}

function startSampler(gate: DaemonGate): void {
  if (gate.samplerTimer) return;
  gate.samplerTimer = setInterval(() => {
    try {
      sampleDaemon(gate);
    } catch (err) {
      process.stderr.write(`[matchlock-alias-isolation-gate] ${gate.label} sampler failed: ${String(err)}\n`);
    }
  }, SAMPLE_INTERVAL_MS);
}

function stopSampler(gate: DaemonGate): void {
  if (gate.samplerTimer) {
    clearInterval(gate.samplerTimer);
    gate.samplerTimer = null;
  }
}

/** Bounded wait for a daemon to have admitted at least one Matchlock VM. */
async function waitForVm(gate: DaemonGate, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const inv = readVmInventory(gate.homeDir);
      if (inv.rows.length > 0 || inv.dirIds.length > 0) return;
    } catch {
      /* state DB not created yet */
    }
    await sleep(500);
  }
  throw new Error(
    `${gate.label}: no Matchlock VM appeared under ${gate.homeDir} within ${timeoutMs}ms`,
  );
}

async function pollTerminalWithNudge(gate: DaemonGate): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", gate.runId], {
      env: cleanChildEnv(gate.env),
      encoding: "utf-8",
    });
    const out = result.stdout || result.stderr || "";
    const m = out.match(/^Status:\s+(\S+)/m);
    if (m) {
      lastStatus = m[1];
      if (["completed", "done", "failed", "canceled"].includes(lastStatus)) return lastStatus;
    }
    spawnSync(process.execPath, [cliPath, "nudge"], {
      env: cleanChildEnv(gate.env),
      encoding: "utf-8",
    });
    await sleep(DEFAULT_POLL_MS);
  }
  throw new Error(
    `${gate.label}: timeout after ${RUN_TIMEOUT_MS}ms waiting for terminal status; last=${lastStatus || "(none)"}`,
  );
}

/** Whole-path evidence for one completed synthetic do-now run. */
function assertRunEvidence(gate: DaemonGate): void {
  const progressFile = path.join(gate.tamanduaDir, "runs", gate.runId, "progress-resource", "progress.txt");
  assert.ok(fs.existsSync(progressFile), `${gate.label}: guest progress document missing at ${progressFile}`);
  assert.ok(
    fs.readFileSync(progressFile, "utf-8").trim().length > 0,
    `${gate.label}: progress document is empty`,
  );

  const db = openE2eDatabase(path.join(gate.tamanduaDir, "tamandua.db"));
  try {
    const rows = db
      .prepare("SELECT step_id, agent_id, status, output FROM steps WHERE run_id = ? ORDER BY step_index")
      .all(gate.runId) as Array<{ step_id: string; agent_id: string; status: string; output: string | null }>;
    assert.ok(rows.length >= 1, `${gate.label}: no steps found in step DB`);
    for (const row of rows) {
      assert.equal(
        row.status,
        "done",
        `${gate.label}: step ${row.step_id} (${row.agent_id}) not done (status=${row.status})`,
      );
      assert.ok(
        row.output && /STATUS:\s*done/i.test(row.output),
        `${gate.label}: step ${row.step_id} has no STATUS: done output`,
      );
    }
    const runRow = db
      .prepare("SELECT tokens_spent FROM runs WHERE id = ?")
      .get(gate.runId) as { tokens_spent: number } | undefined;
    assert.ok(runRow, `${gate.label}: run row missing tokens_spent`);
    assert.equal(
      runRow.tokens_spent,
      DO_NOW_TOKEN_EXPECT,
      `${gate.label}: expected synthetic usage total ${DO_NOW_TOKEN_EXPECT}, got ${runRow.tokens_spent}`,
    );
  } finally {
    db.close();
  }

  // Whole-path / no-fallback events: exactly one completion + probe, and no
  // alias/infra/dispatch refusal anywhere in the run.
  const events = readRunEvents(gate.tamanduaDir, gate.runId);
  const byType = new Map<string, number>();
  for (const e of events) byType.set(String(e.event), (byType.get(String(e.event)) ?? 0) + 1);
  assert.equal(byType.get("run.completed") ?? 0, 1, `${gate.label}: expected exactly one run.completed event`);
  assert.equal(
    byType.get("run.harness_probe_ok") ?? 0,
    1,
    `${gate.label}: expected exactly one run.harness_probe_ok event`,
  );
  for (const bad of [
    "run.matchlock_home_alias_untrusted",
    "run.matchlock_dispatch_refused",
    "run.matchlock_invocation_infra_failed",
    "run.harness_probe_failed",
    "run.instant_fail_loop",
    "run.failed",
  ]) {
    assert.equal(byType.get(bad) ?? 0, 0, `${gate.label}: unexpected ${bad} event`);
  }

  const markerDir = path.join(gate.wd, ".matchlock-synthetic-pi");
  assert.ok(fs.existsSync(markerDir), `${gate.label}: synthetic marker dir missing in repo ${gate.wd}`);
  assert.ok(fs.statSync(markerDir).isDirectory(), `${gate.label}: synthetic marker path is not a directory`);
}

function prepareFixtureImageOnce(fixtureTar: string): void {
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
    `docker build of the synthetic fixture failed (exit ${dockerBuild.status}, signal ${dockerBuild.signal}):\n${(dockerBuild.stdout || "").slice(-4000)}\n${(dockerBuild.stderr || "").slice(-4000)}`,
  );
  const saveOutFd = fs.openSync(fixtureTar, "w");
  const dockerSave = spawnSync("/usr/bin/docker", ["save", FIXTURE_IMAGE_TAG], {
    stdio: ["ignore", saveOutFd, "pipe"],
    env: inheritedProcessEnv(),
  });
  fs.closeSync(saveOutFd);
  assert.equal(dockerSave.status, 0, `docker save of the synthetic fixture failed: ${dockerSave.stderr}`);
}

function importFixtureImage(homeDir: string, fixtureTar: string): void {
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
    `matchlock image import failed for ${homeDir}: ${imageImport.stdout}\n${imageImport.stderr}`,
  );
  const resolved = spawnSync(MATCHLOCK_RPC_BIN, ["image", "resolve", FIXTURE_IMAGE_TAG], {
    encoding: "utf-8",
    env: importEnv,
  });
  assert.equal(resolved.status, 0, `matchlock image resolve failed for ${homeDir}: ${resolved.stderr}`);
  const identity = JSON.parse(resolved.stdout.trim()) as { digest: string; config_digest: string };
  assert.ok(
    identity.digest.startsWith("sha256:") && identity.config_digest.startsWith("sha256:"),
    `resolved fixture identity incomplete for ${homeDir}`,
  );
}

/** Seed a private HOME's image cache from a prior run (dev-speed seam). */
function seedImageCache(homeDir: string, cacheImagesDir: string): void {
  const dst = path.join(homeDir, ".cache", "matchlock", "images");
  fs.mkdirSync(dst, { recursive: true });
  const srcBlobs = path.join(cacheImagesDir, "blobs");
  if (fs.existsSync(srcBlobs) && fs.statSync(srcBlobs).isDirectory()) {
    const linked = spawnSync("cp", ["-al", srcBlobs, path.join(dst, "blobs")], { encoding: "utf-8" });
    if (linked.status !== 0) {
      const copied = spawnSync("cp", ["-a", "--reflink=auto", srcBlobs, path.join(dst, "blobs")], {
        encoding: "utf-8",
      });
      assert.equal(copied.status, 0, `seeding image blobs failed: ${linked.stderr}; ${copied.stderr}`);
    }
  }
  for (const meta of ["metadata.db", "metadata.db-wal", "metadata.db-shm"]) {
    const from = path.join(cacheImagesDir, meta);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, meta));
  }
  const local = path.join(cacheImagesDir, "local");
  if (fs.existsSync(local)) fs.cpSync(local, path.join(dst, "local"), { recursive: true });
}

function prepareKernelCache(homeDir: string, kernelSrc: string): void {
  if (fs.existsSync(kernelSrc)) {
    fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), { recursive: true });
  } else {
    process.stderr.write(`[matchlock-alias-isolation-gate] kernel cache not found at ${kernelSrc}; continuing\n`);
  }
}

function preparePrivateHome(homeDir: string): void {
  fs.mkdirSync(path.join(homeDir, ".tamandua"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".cache"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".pi", "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
    "utf-8",
  );
  fs.writeFileSync(path.join(homeDir, ".tamandua", "port"), "0", "utf-8");
}

function appendEvidenceJsonl(name: string, record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.appendFileSync(path.join(EVIDENCE_DIR, name), `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    process.stderr.write(`[matchlock-alias-isolation-gate] evidence append failed: ${String(err)}\n`);
  }
}

// ── shared state ──────────────────────────────────────────────────────────
let gateA: DaemonGate;
let gateB: DaemonGate;
let observedVmIds: string[] = [];
let portHandles: PortHandle[] = [];

/** Alias resolution for a private HOME (read-only; the daemon creates it). */
function resolveAlias(homeDir: string, uid: number): { aliasPath: string; aliasKey: string } {
  const inspection = inspectMatchlockHomeAlias({ realHome: homeDir, env: {}, uid });
  assert.equal(inspection.disabled, false, `alias must be enabled for ${homeDir}`);
  assert.ok(inspection.aliasPath, `no alias path resolved for ${homeDir}`);
  assert.ok(inspection.aliasKey, `no alias key resolved for ${homeDir}`);
  return { aliasPath: inspection.aliasPath, aliasKey: inspection.aliasKey };
}

describe(
  "matchlock two-daemon alias isolation gate (US-005)",
  { concurrency: 1 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      const homeA = path.join(EVIDENCE_DIR, "daemon-a", "home");
      const homeB = path.join(EVIDENCE_DIR, "daemon-b", "home");
      preparePrivateHome(homeA);
      preparePrivateHome(homeB);

      const kernelSrc = process.env.TAMANDUA_GATE_KERNEL_CACHE?.trim() || "";
      prepareKernelCache(homeA, kernelSrc);
      prepareKernelCache(homeB, kernelSrc);

      // Two DISTINCT home paths -> two distinct alias keys (same uid).
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      if (FIXTURE_IMAGE_CACHE.length > 0 && fs.existsSync(FIXTURE_IMAGE_CACHE)) {
        seedImageCache(homeA, FIXTURE_IMAGE_CACHE);
        seedImageCache(homeB, FIXTURE_IMAGE_CACHE);
      } else {
        const fixtureTar = path.join(EVIDENCE_DIR, "fixture-image.tar");
        prepareFixtureImageOnce(fixtureTar);
        importFixtureImage(homeA, fixtureTar);
        importFixtureImage(homeB, fixtureTar);
      }

      portHandles = await reservePortHandles(2);
      const portA = portHandles[0].port;
      const portB = portHandles[1].port;
      fs.writeFileSync(path.join(homeA, ".tamandua", "port"), String(portA), "utf-8");
      fs.writeFileSync(path.join(homeB, ".tamandua", "port"), String(portB), "utf-8");

      gateA = makeGate("A", homeA, portA);
      gateB = makeGate("B", homeB, portB);
      const aliasA = resolveAlias(homeA, uid);
      const aliasB = resolveAlias(homeB, uid);
      gateA.aliasPath = aliasA.aliasPath;
      gateA.aliasKey = aliasA.aliasKey;
      gateB.aliasPath = aliasB.aliasPath;
      gateB.aliasKey = aliasB.aliasKey;

      assert.notEqual(gateA.aliasKey, gateB.aliasKey, "distinct homes must yield distinct alias keys");
      assert.notEqual(gateA.aliasPath, gateB.aliasPath, "distinct keys must yield distinct alias paths");

      gateA.wd = prepareFixtureRepo(path.join(EVIDENCE_DIR, "fixtures", "wd-a"));
      gateB.wd = prepareFixtureRepo(path.join(EVIDENCE_DIR, "fixtures", "wd-b"));
      gateA.ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger-a.txt");
      gateB.ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger-b.txt");

      cliMustSucceed(["workflow", "install", "do-now"], gateA.env, "install do-now workflow (A)");
      cliMustSucceed(["workflow", "install", "do-now"], gateB.env, "install do-now workflow (B)");

      appendEvidenceJsonl("gate-setup.jsonl", {
        at: new Date().toISOString(),
        homeA,
        homeB,
        aliasPathA: gateA.aliasPath,
        aliasKeyA: gateA.aliasKey,
        aliasPathB: gateB.aliasPath,
        aliasKeyB: gateB.aliasKey,
        controlPortA: portA,
        controlPortB: portB,
        vcpus: GATE_VCPUS,
        imageTag: FIXTURE_IMAGE_TAG,
      });
    });

    after(async () => {
      const errors: string[] = [];
      for (const gate of [gateA, gateB]) {
        if (!gate) continue;
        stopSampler(gate);
        if (gate.daemon) {
          try {
            const closeOutcome = await stopIsolatedDaemonScoped(gate.daemon);
            if (closeOutcome.signal === "SIGKILL-timeout") {
              errors.push(`${gate.label}: daemon did not close within the scoped bound`);
            }
          } catch (err) {
            errors.push(`${gate.label} daemon stop: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            gate.daemon = null;
          }
        }
        if (gate.homeDir && !gate.cleanupCompleted) {
          try {
            cleanupOwnedVms(gate.homeDir, gate.ledgerPath, [...gate.firstSeen.keys()], {
              rpcBin: MATCHLOCK_RPC_BIN,
            });
          } catch (err) {
            errors.push(`${gate.label} emergency VM cleanup: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      await releasePortReservations({ portHandles }).catch(() => {});
      portHandles = [];

      // ── observed-rounds honesty: never certify a hollow green ──────────
      const observedRounds = new Set(observedVmIds).size;
      if (EVIDENCE_DIR.length > 0) {
        try {
          writeObservedRoundsEvidence(EVIDENCE_DIR, {
            gate: GATE_LABEL,
            observed_rounds: observedRounds,
            observed_vm_ids: observedVmIds,
            detail: `${GATE_LABEL}: ${observedRounds} distinct in-VM rounds observed across two daemons`,
          });
        } catch (err) {
          errors.push(`observed-rounds evidence: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        assertObservedRoundsNonZero(GATE_LABEL, observedRounds, observedVmIds);
      } catch (err) {
        errors.push(`observed-rounds: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (errors.length > 0) {
        throw new Error(`alias isolation gate after-hook cleanup failed:\n${errors.join("\n")}`);
      }
    });

    it(
      "daemon B cannot re-point daemon A's alias while both run fresh Matchlock rounds",
      { timeout: 60 * 60_000 },
      async () => {
        // Start BOTH isolated daemons up front so daemon-B startup latency does
        // not let A finish before the concurrent B round begins.
        await releasePortReservations({ portHandles: [portHandles[0]] });
        gateA.daemon = await startIsolatedDaemon(gateA.homeDir, gateA.controlPort, gateA.env);
        await releasePortReservations({ portHandles: [portHandles[1]] });
        gateB.daemon = await startIsolatedDaemon(gateB.homeDir, gateB.controlPort, gateB.env);

        startSampler(gateA);
        startSampler(gateB);

        try {
          // ── daemon A: admit a live in-VM round ──────────────────────
          const prefixA = await spawnWorkflowRun(
            [
              "workflow", "run", "do-now",
              "Alias isolation gate A: under the default keyed alias, execute the harmless owned fixture action and report.",
              "--working-directory-for-harness", gateA.wd,
              "--matchlock", FIXTURE_IMAGE_TAG,
            ],
            gateA.env,
            60_000,
          );
          gateA.runId = resolveFullRunId(prefixA, gateA.tamanduaDir);
          await waitForVm(gateA, VM_WAIT_TIMEOUT_MS);
          assert.ok(
            gateA.firstSeen.size >= 1,
            "daemon A must have admitted a Matchlock round (VM row) before B starts its round",
          );

          // ── daemon B: admit its own concurrent round ────────────────
          const prefixB = await spawnWorkflowRun(
            [
              "workflow", "run", "do-now",
              "Alias isolation gate B: under the default keyed alias, execute the harmless owned fixture action and report.",
              "--working-directory-for-harness", gateB.wd,
              "--matchlock", FIXTURE_IMAGE_TAG,
            ],
            gateB.env,
            60_000,
          );
          gateB.runId = resolveFullRunId(prefixB, gateB.tamanduaDir);
          await waitForVm(gateB, VM_WAIT_TIMEOUT_MS);

          // ── THE REGRESSION ASSERTIONS ───────────────────────────────
          // The two aliases are distinct keyed paths under the per-uid tree.
          assert.notEqual(gateA.aliasPath, gateB.aliasPath, "alias paths must be distinct");
          assert.notEqual(gateA.aliasKey, gateB.aliasKey, "alias keys must be distinct");

          // Resolving B must NOT have moved A's alias: it still targets A's
          // real HOME byte-for-byte, and each daemon owns its own alias.
          assert.equal(
            fs.readlinkSync(gateA.aliasPath),
            gateA.homeDir,
            "daemon B must not re-point daemon A's alias",
          );
          assert.equal(
            fs.readlinkSync(gateB.aliasPath),
            gateB.homeDir,
            "daemon B's alias must target daemon B's real HOME",
          );

          // A's VM directory under A's OWN HOME stayed valid while B resolved:
          // A's sampler positively saw a state dir, and every A VM row that is
          // STILL live has its directory (the historical alias-flip defect made
          // the VM dir vanish under the flipped alias).
          assert.ok(
            gateA.dirSeen.size >= 1,
            "daemon A's VM state directory must have existed under A's real HOME during the concurrent run",
          );
          const aVmsDir = path.join(gateA.homeDir, ".matchlock", "vms");
          const aLive = readVmInventory(gateA.homeDir);
          for (const row of aLive.rows) {
            if (fs.existsSync(path.join(aVmsDir, row.id))) continue;
            // A row can be removed by the runner between the inventory read and
            // the exists check; only a row STILL present without its directory
            // is the defect.
            const recheck = readVmInventory(gateA.homeDir);
            assert.ok(
              !recheck.rows.some((r) => r.id === row.id),
              `daemon A's live VM directory for ${row.id} must remain valid under A's real HOME`,
            );
          }

          appendEvidenceJsonl("alias-isolation.jsonl", {
            at: new Date().toISOString(),
            runIdA: gateA.runId,
            runIdB: gateB.runId,
            aliasPathA: gateA.aliasPath,
            aliasPathB: gateB.aliasPath,
            readlinkAAfterB: fs.readlinkSync(gateA.aliasPath),
            readlinkB: fs.readlinkSync(gateB.aliasPath),
            dirSeenA: [...gateA.dirSeen].sort(),
            rowWithoutDirA: gateA.rowWithoutDir,
          });

          // ── both rounds complete on the real whole path ─────────────
          const statusA = await pollTerminalWithNudge(gateA);
          const statusB = await pollTerminalWithNudge(gateB);
          assert.equal(statusA, "completed", `daemon A run must complete; got ${statusA}`);
          assert.equal(statusB, "completed", `daemon B run must complete; got ${statusB}`);
          await sleep(500);
          assertRunEvidence(gateA);
          assertRunEvidence(gateB);
        } finally {
          stopSampler(gateA);
          stopSampler(gateB);
          for (const gate of [gateA, gateB]) {
            if (gate.daemon) {
              try {
                const closeOutcome = await stopIsolatedDaemonScoped(gate.daemon);
                assert.ok(
                  closeOutcome.signal !== "SIGKILL-timeout",
                  `${gate.label}: daemon did not close within the scoped bound (code=${closeOutcome.code}, signal=${closeOutcome.signal})`,
                );
              } finally {
                gate.daemon = null;
              }
            }
          }
        }

        // ── observed rounds: distinct valid vm-<8hex> ids ─────────────
        const idsA = [...gateA.firstSeen.keys()].sort();
        const idsB = [...gateB.firstSeen.keys()].sort();
        observedVmIds = [...new Set([...idsA, ...idsB])].sort();
        assert.ok(idsA.length >= 1, `daemon A must observe >= 1 VM (got ${idsA.length})`);
        assert.ok(idsB.length >= 1, `daemon B must observe >= 1 VM (got ${idsB.length})`);
        assert.equal(
          observedVmIds.length,
          idsA.length + idsB.length,
          `the two daemons must observe distinct VM ids (A=${idsA.join(",")}, B=${idsB.join(",")})`,
        );
        for (const id of observedVmIds) {
          assert.match(id, /^vm-[0-9a-f]{8}$/, `observed VM id must be vm-<8hex>: ${id}`);
        }

        // ── exact-id teardown per private HOME (never name/glob) ──────
        const cleanA = cleanupOwnedVms(gateA.homeDir, gateA.ledgerPath, idsA, { rpcBin: MATCHLOCK_RPC_BIN });
        gateA.cleanupCompleted = true;
        const cleanB = cleanupOwnedVms(gateB.homeDir, gateB.ledgerPath, idsB, { rpcBin: MATCHLOCK_RPC_BIN });
        gateB.cleanupCompleted = true;
        assert.ok(
          cleanA.ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
          "daemon A cleanup ledger must record completion with no leftovers",
        );
        assert.ok(
          cleanB.ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
          "daemon B cleanup ledger must record completion with no leftovers",
        );
        assert.ok(fs.existsSync(gateA.ledgerPath), `cleanup ledger missing at ${gateA.ledgerPath}`);
        assert.ok(fs.existsSync(gateB.ledgerPath), `cleanup ledger missing at ${gateB.ledgerPath}`);
        appendEvidenceJsonl("gate-result.jsonl", {
          at: new Date().toISOString(),
          runIdA: gateA.runId,
          runIdB: gateB.runId,
          observedVmIdsA: idsA,
          observedVmIdsB: idsB,
          observedRounds: observedVmIds.length,
          cleanupA: cleanA.ledger,
          cleanupB: cleanB.ledger,
        });
      },
    );
  },
);
