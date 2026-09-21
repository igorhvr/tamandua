/******************************************************************************
 * ⚠️  WARNING: SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-CLEANUP US-009 — the real-VM post-harness close/dispose CLEANUP gate.
 *
 * The vaimetal #44 incident: a developer round COMPLETED, the verifier had
 * already claimed the next step, and then the runner's close/dispose of the
 * finished VM failed. The failure was classified as an invocation
 * infrastructure failure, the run was force-failed and every step (including
 * the live verifier) was canceled. US-005/US-007/US-008 changed the policy:
 * a close/dispose failure AFTER the harness exits keeps the round, logs one
 * serialized WARN and hands the stopped VM to the reaper.
 *
 * This gate proves that policy on a REAL fresh VM, using the same deterministic
 * TEST-ONLY synthetic-pi fixture image as the other real-VM gates, plus the
 * US-009 in-process fault seam (`RunMatchlockInvocationOptions.faults`):
 *
 *   1. it creates a REAL fresh Matchlock VM and runs ONE synthetic WORK round
 *      (the synthetic `pi` claims a REAL pending step through the host broker,
 *      writes the guest progress document, and completes the step);
 *   2. it injects `faults: { failClose: true, suppressImmediateReap: true }`,
 *      so the close/dispose fails AFTER the harness exited while the VM is
 *      genuinely stopped and left behind;
 *   3. it asserts the round result is KEPT (stdout/exitCode/stderrTail), the
 *      step is `done`, the pipeline ADVANCED to the next step (pending) and the
 *      run is still `running` — the run CONTINUES past the injected failure;
 *   4. it asserts exactly one WARN carrying the serialized cause (vmId + phase
 *      + code/message, never `[object Object]`) and one US-003 orphan record;
 *   5. it drives the US-006/US-007 reaper over the stopped VM and asserts the
 *      exact id is removed, the state-DB row is gone and no live firecracker
 *      process remains;
 *   6. it positively removes every VM it created and records the cleanup
 *      outcome in a ledger.
 *
 * The fault seam is reachable ONLY through the in-process runner options object
 * (never env/run context/guest input/persisted policy); this gate is its only
 * production-reachable consumer.
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand only:
 *
 *   ./run-matchlock-cleanup-e2e-test
 *
 * which takes `flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock`,
 * builds first, validates the paired runtime binaries, creates a NEW mkdtemp
 * evidence directory (outside the repo; never pre-cleaned/reused) and runs this
 * file with a private isolated HOME/STATE/DB rooted INSIDE that evidence
 * directory. The VM is capped at <= 16 vCPUs (default 1).
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB under the evidence dir,
 * TAMANDUA_TEST_GUARD=1, never the live worker daemon, never the operator's
 * matchlock store.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cleanChildEnv } from "../tests/helpers/test-env.ts";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  cleanupOwnedVms,
  readVmInventory,
  VM_ID_RE,
} from "./helpers/matchlock-gate-lifecycle.ts";
import {
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";
import { inheritedProcessEnv } from "./helpers/smoke-helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── environment: paired runtime resolved from PATH by the runner script ─────
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

// Deterministic TEST-ONLY synthetic-pi fixture image (never igorhvr/bedlam-ubuntu).
const FIXTURE_IMAGE_TAG = "tamandua-synthetic-pi:cleanup-gate-fixture";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "matchlock-fixture");
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-pi";
// The effective guest PATH the fixture Dockerfile declares (pi lives ONLY under
// /opt/tamandua-synthetic-bin). Used when `matchlock image resolve` does not
// echo the OCI config env.
const FIXTURE_IMAGE_PATH =
  "/opt/tamandua-synthetic-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// Evidence dir allocated by the runner script.
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";
// The observed-rounds evidence / guard label for this gate. The runner passes
// the SAME label to scripts/observed-rounds-guard.mjs.
const GATE_LABEL = "cleanup";
// Dev-speed seam (NOT the clean acceptance path): a prior run's
// <home>/.cache/matchlock/images to seed instead of docker-build + import.
const FIXTURE_IMAGE_CACHE = process.env.TAMANDUA_GATE_FIXTURE_IMAGE_CACHE?.trim() || "";
// Hard cap on the requested vCPUs for the single VM (must be <= 16).
const GATE_VCPUS = Math.min(
  16,
  Math.max(1, Number.parseInt(process.env.TAMANDUA_GATE_VCPUS ?? "1", 10) || 1),
);

const AGENT_ID = "do-now_doer";
const WORKFLOW_ID = "do-now";
const GUEST_CLI = "/workspace/runtime/bin/tamandua";

// ── shared state ─────────────────────────────────────────────────────────
let homeDir = "";
let tamanduaDir = "";
let aliasPath = "";
let aliasParent = "";
let runRoot = "";
let fixturesRoot = "";
let wd = "";
let runId = "";
let step1Id = "";
let step2Id = "";
let identity: { digest: string; config_digest: string } = { digest: "", config_digest: "" };
let imagePath = FIXTURE_IMAGE_PATH;
let helperPackHostPath = "";
let policy: Record<string, unknown> = {};
let ledgerPath = "";
let observedVmIds: string[] = [];
let cleanupCompleted = false;
let priorEnv: Record<string, string | undefined> = {};

function assertEnv(): void {
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-cleanup-e2e-test)",
  );
  assert.ok(MATCHLOCK_RPC_BIN.length > 0, "TAMANDUA_MATCHLOCK_RPC_BIN must be set to the matchlock CLI");
  assert.ok(GUEST_INIT.length > 0, "MATCHLOCK_GUEST_INIT must be set to the guest-init");
  assert.ok(GUEST_FUSED.length > 0, "MATCHLOCK_GUEST_FUSED must be set (the fused guest-init)");
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    assert.ok(fs.existsSync(p), `paired runtime binary missing: ${p}`);
  }
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Fresh small git repo (clean tracked tree) for the synthetic work round. */
function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# MTLK-CLEANUP gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n.matchlock-synthetic-pi/\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Matchlock Cleanup Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

function appendEvidenceJsonl(name: string, record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.appendFileSync(path.join(EVIDENCE_DIR, name), `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    process.stderr.write(`[matchlock-cleanup-gate] evidence append failed: ${String(err)}\n`);
  }
}

/** Seed the private image store from a prior run's cache dir (dev-speed seam). */
function seedImageCache(cacheImagesDir: string): void {
  const dst = path.join(homeDir, ".cache", "matchlock", "images");
  fs.mkdirSync(dst, { recursive: true });
  const srcBlobs = path.join(cacheImagesDir, "blobs");
  if (fs.existsSync(srcBlobs) && fs.readdirSync(srcBlobs).length > 0) {
    const linked = spawnSync("cp", ["-al", srcBlobs, path.join(dst, "blobs")], { encoding: "utf-8" });
    if (linked.status !== 0) {
      const copied = spawnSync("cp", ["-a", "--reflink=auto", srcBlobs, path.join(dst, "blobs")], {
        encoding: "utf-8",
      });
      assert.equal(
        copied.status,
        0,
        `seeding image blobs failed (hardlink: ${linked.stderr}; copy: ${copied.stderr})`,
      );
    }
  }
  for (const meta of ["metadata.db", "metadata.db-wal", "metadata.db-shm"]) {
    const from = path.join(cacheImagesDir, meta);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, meta));
  }
  const local = path.join(cacheImagesDir, "local");
  if (fs.existsSync(local)) fs.cpSync(local, path.join(dst, "local"), { recursive: true });
}

/** Build + import the TEST-ONLY fixture image (or seed it from a cache). */
function prepareFixtureImage(): void {
  if (FIXTURE_IMAGE_CACHE.length > 0 && fs.existsSync(FIXTURE_IMAGE_CACHE)) {
    seedImageCache(FIXTURE_IMAGE_CACHE);
    return;
  }
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
    `docker build of the synthetic fixture failed (exit ${dockerBuild.status}):\n` +
      `${(dockerBuild.stdout || "").slice(-2000)}\n${(dockerBuild.stderr || "").slice(-2000)}`,
  );
  const fixtureTar = path.join(EVIDENCE_DIR, "fixture-image.tar");
  const saveOutFd = fs.openSync(fixtureTar, "w");
  const dockerSave = spawnSync("/usr/bin/docker", ["save", FIXTURE_IMAGE_TAG], {
    stdio: ["ignore", saveOutFd, "pipe"],
    env: inheritedProcessEnv(),
  });
  fs.closeSync(saveOutFd);
  assert.equal(dockerSave.status, 0, `docker save of the synthetic fixture failed: ${dockerSave.stderr}`);
  const importEnv = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
  const saveInFd = fs.openSync(fixtureTar, "r");
  const imageImport = spawnSync(MATCHLOCK_RPC_BIN, ["image", "import", FIXTURE_IMAGE_TAG], {
    encoding: "utf-8",
    stdio: [saveInFd, "pipe", "pipe"],
    env: importEnv,
  });
  fs.closeSync(saveInFd);
  assert.equal(imageImport.status, 0, `matchlock image import failed: ${imageImport.stdout}\n${imageImport.stderr}`);
}

function resolveFixtureIdentity(): { digest: string; config_digest: string; imagePath: string } {
  const r = spawnSync(MATCHLOCK_RPC_BIN, ["image", "resolve", FIXTURE_IMAGE_TAG], {
    encoding: "utf-8",
    env: cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir }),
  });
  assert.equal(r.status, 0, `matchlock image resolve ${FIXTURE_IMAGE_TAG} failed: ${r.stderr}`);
  const raw = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
  const digest = String(raw.digest ?? "");
  const configDigest = String(raw.config_digest ?? "");
  assert.ok(digest.startsWith("sha256:") && configDigest.startsWith("sha256:"), `resolved identity incomplete: ${r.stdout}`);
  const oci = raw.oci as { env?: { PATH?: unknown } } | undefined;
  const resolvedPath = typeof oci?.env?.PATH === "string" && oci.env.PATH.trim().length > 0
    ? oci.env.PATH.trim()
    : FIXTURE_IMAGE_PATH;
  return { digest, config_digest: configDigest, imagePath: resolvedPath };
}

/**
 * TRUE when the recorded pid is a live process whose command line names this
 * VM's runtime. Mirrors the reaper's guard: a pid of 0 (matchlock's stopped
 * marker) or a recycled pid of an unrelated process is NOT the VM's runtime.
 * Uses `ps` (portable; no `/proc` literal) and never trusts `matchlock list`.
 */
function hasLiveVmProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf-8" });
  if (r.status !== 0) return false;
  const args = (r.stdout ?? "").trim();
  return /firecracker|matchlock/i.test(args);
}

function readVmRow(vmId: string): { id: string; pid: number; status: string } | null {
  const stateDb = path.join(homeDir, ".matchlock", "state.db");
  if (!fs.existsSync(stateDb)) return null;
  const db = openE2eDatabase(stateDb);
  try {
    const row = db.prepare("SELECT id, pid, status FROM vms WHERE id = ?").get(vmId) as
      | { id: string; pid: number; status: string }
      | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

/** Seed a REAL run + two ordered steps through the real migrated DB. */
async function seedRunAndSteps(): Promise<void> {
  const dbMod = await import(`${repoRoot}/dist/db.js`);
  const db = dbMod.getDb();
  const bare = runId;
  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
  ).run(bare, WORKFLOW_ID, "MTLK-CLEANUP US-009 gate run", "running", "{}");
  const insertStep = (id: string, stepId: string, index: number, status: string): void => {
    db.prepare(
      `INSERT INTO steps (
         id, run_id, step_id, agent_id, step_index, input_template, expects,
         status, output, retry_count, max_retries, type, loop_config,
         current_story_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(
      id,
      bare,
      stepId,
      AGENT_ID,
      index,
      "Complete this synthetic gate step and report STATUS: done.",
      "STATUS: done",
      status,
      null,
      0,
      2,
      "single",
      null,
      null,
    );
  };
  insertStep(step1Id, "implement", 0, "pending");
  insertStep(step2Id, "verify", 1, "waiting");
}

function stepStatus(stepId: string): string {
  const stateDb = path.join(tamanduaDir, "tamandua.db");
  const db = openE2eDatabase(stateDb);
  try {
    const row = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as
      | { status: string }
      | undefined;
    assert.ok(row, `step ${stepId} not found`);
    return row!.status;
  } finally {
    db.close();
  }
}

function runStatus(): string {
  const stateDb = path.join(tamanduaDir, "tamandua.db");
  const db = openE2eDatabase(stateDb);
  try {
    const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
      | { status: string }
      | undefined;
    assert.ok(row, `run ${runId} not found`);
    return row!.status;
  } finally {
    db.close();
  }
}

function buildWorkPrompt(): string {
  return [
    `You are the developer agent. You are working on workflow "${WORKFLOW_ID}", agent "${AGENT_ID}", run "run-${runId}".`,
    "",
    "Claim and complete your ONE pending step. Run the exact command:",
    `  "${GUEST_CLI}" step claim ${AGENT_ID} --run-id run-${runId}`,
    "",
    "Then submit your report with `step complete`. Keep the STATUS line contract.",
  ].join("\n");
}

/** Production-shaped harness:"pi" policy for the fixture image. */
async function buildPolicy(): Promise<Record<string, unknown>> {
  const policyMod = await import(`${repoRoot}/dist/installer/matchlock/policy.js`);
  return policyMod.buildMatchlockPolicy({
    requestedImage: FIXTURE_IMAGE_TAG,
    identity: { digest: identity.digest, config_digest: identity.config_digest },
    harness: "pi",
    imagePath,
    workingDirectory: wd,
    originalRepositoryRoot: wd,
    workMounts: [
      { hostPath: wd, hostRealPath: fs.realpathSync(wd), guestPath: wd },
    ],
    gitMetadataRoots: [],
    configurationRoot: path.join(homeDir, ".pi", "agent"),
    configurationProfile: "settings.json",
    guestConfigurationRoot: "/workspace/config/pi",
    resourceLimits: { cpus: GATE_VCPUS, memoryMB: 1024, diskSizeMB: 2048 },
  }) as Record<string, unknown>;
}

async function resolveAlias(realHome: string): Promise<string> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/home-alias.js`);
  const tempMod = await import(`${repoRoot}/dist/lib/temp-dir.js`);
  // The default alias is a per-uid symlink shared with the live worker, and the
  // alias MUST stay short (SUN_LEN), so give this gate its OWN alias under the
  // canonical short Tamandua temp root (tamanduaTempRoot(), a short literal path
  // from src/lib/temp-dir.ts) rather than the deep evidence dir. It can never
  // clobber or be refused by the live per-uid default alias symlink.
  aliasParent = tempMod.tamanduaTempDir("mtlk-cleanup-");
  aliasPath = path.join(aliasParent, "h");
  return mod.resolveMatchlockHomeAlias({
    realHome,
    env: { ...inheritedProcessEnv(), HOME: realHome, TAMANDUA_MATCHLOCK_HOME_ALIAS: aliasPath },
  });
}

describe("matchlock cleanup gate (US-009): injected post-harness close/dispose failure", { concurrency: 1 }, () => {
  before(async () => {
    assertEnv();
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    priorEnv = {
      HOME: process.env.HOME,
      TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
      TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
      TAMANDUA_MATCHLOCK_RPC_BIN: process.env.TAMANDUA_MATCHLOCK_RPC_BIN,
      MATCHLOCK_GUEST_INIT: process.env.MATCHLOCK_GUEST_INIT,
      MATCHLOCK_GUEST_FUSED: process.env.MATCHLOCK_GUEST_FUSED,
    };

    homeDir = path.join(EVIDENCE_DIR, "home");
    tamanduaDir = path.join(homeDir, ".tamandua");
    runRoot = path.join(tamanduaDir, "runs");
    fs.mkdirSync(tamanduaDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".cache"), { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".pi", "agent", "settings.json"),
      JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
      "utf-8",
    );
    fs.writeFileSync(path.join(tamanduaDir, "port"), "0", "utf-8");

    // Private kernel cache (the fresh matchlock HOME resolves kernels under
    // $HOME/.cache/matchlock). Never mutates the operator's cache.
    const kernelSrc =
      process.env.TAMANDUA_GATE_KERNEL_CACHE?.trim() ||
      path.join(priorEnv.HOME ?? "", ".cache", "matchlock", "kernels");
    if (fs.existsSync(kernelSrc)) {
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), { recursive: true });
    } else {
      process.stderr.write(`[matchlock-cleanup-gate] kernel cache not found at ${kernelSrc}; continuing\n`);
    }

    // Point the in-process runner/services at the isolated state BEFORE any
    // dist module opens a DB handle.
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = tamanduaDir;
    process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_TEST_GUARD = "1";
    process.env.TAMANDUA_MATCHLOCK_RPC_BIN = MATCHLOCK_RPC_BIN;
    process.env.MATCHLOCK_GUEST_INIT = GUEST_INIT;
    process.env.MATCHLOCK_GUEST_FUSED = GUEST_FUSED;

    prepareFixtureImage();
    const resolved = resolveFixtureIdentity();
    identity = { digest: resolved.digest, config_digest: resolved.config_digest };
    imagePath = resolved.imagePath;

    fixturesRoot = path.join(EVIDENCE_DIR, "fixtures");
    wd = prepareFixtureRepo(path.join(fixturesRoot, "work"));
    ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");

    runId = randomUUID();
    step1Id = randomUUID();
    step2Id = randomUUID();
    await seedRunAndSteps();

    aliasPath = await resolveAlias(homeDir);
    const sm = await import(`${repoRoot}/dist/installer/matchlock/scheduler-matchlock.js`);
    helperPackHostPath = await sm.ensureGuestPackForState({ stateRoot: tamanduaDir });
    policy = await buildPolicy();

    appendEvidenceJsonl("gate-setup.jsonl", {
      at: new Date().toISOString(),
      homeDir,
      tamanduaDir,
      runRoot,
      repo: wd,
      runId,
      vcpus: GATE_VCPUS,
      imageTag: FIXTURE_IMAGE_TAG,
      imageDigest: identity.digest,
      imagePath,
      aliasPath,
      helperPackHostPath,
    });
  });

  after(async () => {
    const errors: string[] = [];
    if (homeDir && !cleanupCompleted) {
      try {
        cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
      } catch (err) {
        errors.push(`emergency VM cleanup: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (aliasParent.length > 0) {
      try {
        fs.rmSync(aliasParent, { recursive: true, force: true });
      } catch (err) {
        errors.push(`owned alias cleanup: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // ── observed-rounds honesty (TESTER-HONESTY item 3) ─────────────────
    // Record the distinct in-VM rounds this gate ACTUALLY observed and refuse
    // to certify a zero-round run (VM creation/probe failed before any round)
    // even if the node --test assertions above were bypassed.
    const observedRounds = new Set(observedVmIds).size;
    if (EVIDENCE_DIR.length > 0) {
      try {
        writeObservedRoundsEvidence(EVIDENCE_DIR, {
          gate: GATE_LABEL,
          observed_rounds: observedRounds,
          observed_vm_ids: observedVmIds,
          detail: `${GATE_LABEL}: ${observedRounds} distinct in-VM rounds observed`,
        });
      } catch (err) {
        errors.push(
          `observed-rounds evidence: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      assertObservedRoundsNonZero(GATE_LABEL, observedRounds, observedVmIds);
    } catch (err) {
      errors.push(`observed-rounds: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (errors.length > 0) throw new Error(`gate after-hook cleanup failed:\n${errors.join("\n")}`);
  });

  it(
    "a real-VM post-harness close/dispose failure keeps the round, continues the run and the reaper disposes the VM",
    { timeout: 45 * 60_000 },
    async () => {
      const runnerMod = await import(`${repoRoot}/dist/installer/matchlock/pi-invocation-runner.js`);
      const nsi = await import(`${repoRoot}/dist/installer/matchlock/native-step-invocations.js`);
      const reaperMod = await import(`${repoRoot}/dist/installer/matchlock/vm-reaper.js`);
      const orphanMod = await import(`${repoRoot}/dist/installer/matchlock/vm-orphans.js`);

      const registry = new nsi.HostInvocationRegistry();
      const invocationId = randomUUID();
      const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
      const onLog = (level: string, message: string, fields?: Record<string, unknown>): void => {
        if (logs.length < 500) logs.push({ level, message, fields });
        try {
          fs.appendFileSync(
            path.join(EVIDENCE_DIR, "runner-logs.jsonl"),
            `${JSON.stringify({ at: new Date().toISOString(), level, message, fields })}\n`,
            "utf-8",
          );
        } catch {
          /* evidence must never affect the round */
        }
      };

      let result: Record<string, unknown> | null = null;
      try {
        result = (await runnerMod.runMatchlockInvocation({
          policy,
          identity: {
            runId: `run-${runId}`,
            agentId: AGENT_ID,
            workflowId: WORKFLOW_ID,
            jobId: `job-${invocationId.slice(0, 8)}`,
            invocationId,
          },
          kind: "work",
          promptText: buildWorkPrompt(),
          workingDirectoryForHarness: wd,
          timeoutMs: 300_000,
          progressResource: { runId: `run-${runId}`, runRoot },
          registry,
          helperPackHostPath,
          imagePath,
          rpcEnv: {
            HOME: aliasPath,
            TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN,
            MATCHLOCK_GUEST_INIT: GUEST_INIT,
            MATCHLOCK_GUEST_FUSED: GUEST_FUSED,
            TAMANDUA_STATE_DIR: tamanduaDir,
          },
          createTimeoutMs: 240_000,
          readyTimeoutMs: 30_000,
          handshakeTimeoutMs: 90_000,
          serviceTimeoutMs: 180_000,
          closeTimeoutSeconds: 60,
          // MTLK-CLEANUP US-009: TEST-ONLY in-process fault seam.
          faults: { failClose: true, suppressImmediateReap: true },
          onLog,
        })) as Record<string, unknown>;
      } catch (err) {
        appendEvidenceJsonl("gate-result.jsonl", {
          at: new Date().toISOString(),
          thrown: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
        throw err;
      }

      const vmId = (result.vmId as string | null) ?? null;
      assert.ok(vmId && VM_ID_RE.test(vmId), `the round created a real owned VM (got ${JSON.stringify(vmId)})`);
      observedVmIds.push(vmId!);

      // 1. The round result is KEPT — the run CONTINUES past the injected failure.
      assert.equal(result.exitCode, 0, `round exit kept (stderr: ${String(result.stderrTail).slice(0, 400)})`);
      assert.ok(
        String(result.output).length > 0,
        `the harness round output is kept (got ${JSON.stringify(String(result.output).slice(0, 200))})`,
      );
      assert.equal(result.cleanupConfirmed, false, "cleanup is NOT confirmed for the injected close failure");
      assert.equal(stepStatus(step1Id), "done", "the completed step stays done");
      assert.equal(stepStatus(step2Id), "pending", "the pipeline ADVANCED to the next step");
      assert.equal(runStatus(), "running", "the run is still running (never force-failed)");

      // 2. The bounded serialized vmCleanupFailure carries phase + vmId + cause.
      const failure = String(result.vmCleanupFailure ?? "");
      assert.match(failure, /phase=close/, "serialized failure carries the failing phase");
      assert.match(failure, /name=MatchlockRpcError/, "serialized failure names the error");
      assert.match(failure, /code=-32000/, "serialized failure carries the injected RPC code");
      assert.match(failure, /injected matchlock close\/dispose failure/, "serialized failure carries the injected cause");
      assert.match(failure, new RegExp(`vmId=${vmId}`), "serialized failure carries the owned vmId");
      assert.doesNotMatch(failure, /\[object Object\]/, "the incident's [object Object] is impossible");

      // 3. Exactly one WARN carries the serialized cause with vmId + phase.
      const closeWarns = logs.filter(
        (l) => l.level === "warn" && /post-harness vm close\/dispose failed/.test(l.message),
      );
      assert.equal(closeWarns.length, 1, `exactly one post-harness close WARN (got ${closeWarns.length})`);
      assert.equal(closeWarns[0].fields?.vmId, vmId, "WARN names the vmId");
      assert.equal(closeWarns[0].fields?.phase, "close", "WARN names the phase");
      assert.match(String(closeWarns[0].fields?.error ?? ""), /code=-32000/, "WARN carries the serialized cause");

      // 4. Exactly one US-003 orphan record was written for that vmId.
      const orphans = orphanMod.readOrphanVms({ runId, runRoot }) as Array<Record<string, unknown>>;
      assert.equal(orphans.length, 1, `one orphan record for the handed-off VM (got ${orphans.length})`);
      assert.equal(orphans[0].vmId, vmId, "orphan record is keyed by the owned vmId");
      assert.equal(orphans[0].phase, "close", "orphan record carries the failing phase");
      assert.match(String(orphans[0].error ?? ""), /injected matchlock close\/dispose failure/, "orphan record carries the cause");

      // The failed VM is genuinely STOPPED and LEFT BEHIND (suppressed immediate
      // reap): the reaper, not the runner, must dispose it.
      const pre = readVmRow(vmId!);
      assert.ok(pre, "the stopped VM row is still present before the reaper runs");
      assert.equal(pre!.status, "stopped", `the failed VM is stopped (got ${pre!.status})`);
      assert.equal(pre!.pid, 0, "matchlock records pid 0 for a stopped VM");

      // 5. Drive the reaper (RUN-TEARDOWN mode: the run's recorded orphans) and
      // assert positive removal. This is exactly the run's completion cleanup
      // retry (US-007) over the US-003 orphan record.
      const reap = reaperMod.reapOrphanedMatchlockVms({
        runId,
        runRoot,
        cliBinaryPath: MATCHLOCK_RPC_BIN,
        onLog,
      }) as {
        ok: boolean;
        homes: string[];
        scanned: number;
        eligible: number;
        results: Array<{ vmId: string; action: string; pid?: number; removalExitCode?: number | null; removalError?: string }>;
        diagnostics: string[];
      };
      const reapResult = reap.results.find((r) => r.vmId === vmId);
      assert.ok(reapResult, `the reaper reported the exact VM (results: ${JSON.stringify(reap.results)})`);
      assert.equal(
        reapResult!.action,
        "removed",
        `the reaper positively removed the VM (action=${reapResult!.action}, error=${reapResult!.removalError ?? ""})`,
      );
      appendEvidenceJsonl("reaper.jsonl", { at: new Date().toISOString(), vmId, reap });

      // 5b. Post-state: no stopped row, no state dir, no live firecracker pid.
      assert.equal(readVmRow(vmId!), null, "the state-DB row is gone after the reaper pass");
      assert.equal(
        fs.existsSync(path.join(homeDir, ".matchlock", "vms", vmId!)),
        false,
        "the VM state dir is gone after the reaper pass",
      );
      if (typeof pre!.pid === "number" && pre!.pid > 0) {
        assert.equal(hasLiveVmProcess(pre!.pid), false, `no live firecracker process remains for pid ${pre!.pid}`);
      }

      // 5c. The orphan record was cleared by the confirmed removal.
      const orphansAfter = orphanMod.readOrphanVms({ runId, runRoot }) as Array<Record<string, unknown>>;
      assert.equal(orphansAfter.length, 0, "the orphan record is cleared after the reaper removed the VM");

      // 6. Positively dispose every VM this gate created + ledger.
      const clean = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
      cleanupCompleted = true;
      assert.ok(fs.existsSync(ledgerPath), `cleanup ledger missing at ${ledgerPath}`);
      assert.ok(
        clean.ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
        "cleanup ledger records completion with no leftovers",
      );
      appendEvidenceJsonl("gate-result.jsonl", {
        at: new Date().toISOString(),
        runId,
        vmId,
        vcpus: GATE_VCPUS,
        step1: stepStatus(step1Id),
        step2: stepStatus(step2Id),
        runStatus: runStatus(),
        reaperAction: reapResult!.action,
        cleanup: clean.ledger,
      });
    },
  );

  // Fast control: the inventory reader must fail loudly on a stopped row that
  // belongs to a LIVE process (never trust the stale status column).
  it("a stopped VM whose recorded pid is LIVE is never a reap target", async () => {
    // Build a fabricated state DB with one stopped row pointing at THIS live
    // process, then prove the reaper guard skips it.
    const ctrlHome = fs.mkdtempSync(path.join(EVIDENCE_DIR, "ctrl-home-"));
    const matchlockDir = path.join(ctrlHome, ".matchlock");
    fs.mkdirSync(path.join(matchlockDir, "vms"), { recursive: true });
    const db = openE2eDatabase(path.join(matchlockDir, "state.db"));
    try {
      db.exec("CREATE TABLE vms (id TEXT PRIMARY KEY, pid INTEGER, status TEXT, created_at TEXT)");
      db.prepare("INSERT INTO vms (id, pid, status, created_at) VALUES (?, ?, 'stopped', ?)").run(
        "vm-11223344",
        process.pid,
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
    const reaperMod = await import(`${repoRoot}/dist/installer/matchlock/vm-reaper.js`);
    const forcedAlive = (): boolean => true; // deterministic live-process probe
    const reap = reaperMod.reapOrphanedMatchlockVms({
      matchlockHome: ctrlHome,
      vmIds: ["vm-11223344"],
      cliBinaryPath: MATCHLOCK_RPC_BIN,
      isProcessAlive: forcedAlive,
      onLog: () => {},
    }) as { results: Array<{ vmId: string; action: string }> };
    assert.deepEqual(
      reap.results.map((r) => ({ id: r.vmId, action: r.action })),
      [{ id: "vm-11223344", action: "skipped-live" }],
      "a stopped row with a live process is skipped, never removed",
    );
    // The fabricated stopped row is untouched (evidence for the gate; the
    // dir is private to this control and removed by the after hook).
    const inv = readVmInventory(ctrlHome);
    assert.equal(inv.rows.length, 1, "the live-pid stopped row is retained");
  });
});
