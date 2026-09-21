/******************************************************************************
 * ⚠️  SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * DSH-OVERLAY-FSYNC-FIX US-004 — the REAL-dsh contained boot regression over
 * the OPERATOR-SHAPED real-layout `$DSH_HOME`, proving the run-#35 `ENOENT ...
 * fsync` on the effective home root is fixed, the launch probe command passes,
 * and the first session record lands in the host-mapped store.
 *
 * Root causes this gate pins:
 *  - run #32 (bead tamandua-6sy.33.10.34 follow-up): the real dsh boot
 *    (`composeProfile` → `healProfilesModuleFallback`) takes the cross-process
 *    writer lock `<profiles>/node_modules.lock`. The #31 plan mounted only
 *    individual install-derived children and left the guest without a writable
 *    `profiles/` parent, so every in-VM dsh boot died in ~3s with:
 *
 *      Error: ENOENT: no such file or directory, open
 *        '/workspace/config/dsh/profiles/node_modules.lock'
 *
 *  - run #35: the per-entry plan's two single-FILE destinations directly under
 *    `$DSH_HOME` made the runtime promote the HOME ROOT itself to a synthetic
 *    FUSE router root with no host provider, so `fsync(<DSH_HOME>)` died with:
 *
 *      dsh: ENOENT: no such file or directory, fsync
 *
 * What this gate proves (contained single-run, ZERO real credentials/tokens):
 *  1. A gate-owned `$DSH_HOME` is staged with the US-001 OPERATOR-SHAPED real
 *     layout (>=3 `sessions/<cwd-key>/session-<uuid>/` dirs with
 *     concatenated-zstd artifacts, `storages/session_projcache/sessions/*.json`,
 *     the durable profile config, PLACEHOLDER credentials, EMPTY install-derived
 *     dirs). The operator's real `~/.dsh` is only read for its durable profile
 *     config, never mutated, and its credentials/sessions are never read.
 *  2. The exact launch-probe COMMAND (`/workspace/runtime/bin/tamandua
 *     skill-path`) runs in a fresh VM over that home and exits 0 with the guest
 *     skill PATH; the dsh-MEDIATED probe needs a provider, so the boot itself is
 *     exercised by the real dsh rounds below (the credentialed whole-path
 *     `run.harness_probe_ok` stays in Gate E).
 *  3. The REAL dsh CLI (operator image `igorhvr/bedlam-ubuntu`, seeded from the
 *     operator private matchlock image store) boots in a fresh Matchlock VM
 *     through the PRODUCTION dsh invocation runner with the composed DSH_HOME
 *     plan. The boot's `profiles/node_modules.lock` is created inside the
 *     PRIVATE per-run overlay (observed there while the round is live); the
 *     round's stderr carries NEITHER the run-#32 lock ENOENT NOR the run-#35
 *     root-fsync ENOENT; and the boot persists a FIRST session record into the
 *     mapped `sessions/` store (observed from the HOST with the production
 *     reader, plus the `storages/` projection record).
 *  4. The HOST `profiles/` tree (durable files, farm links, no lock) is
 *     byte-identical before/after every in-VM round; the host never grows a
 *     `profiles/node_modules.lock`, and the seeded real-layout store survives.
 *  5. The #31 native-boot / in-VM alternation runs over the SAME staged home:
 *     a host-side native zero-provider fixture boot heals the synthetic host
 *     farm once, and neither the in-VM rounds nor the inter-round native boot
 *     change it afterwards.
 *  6. Every VM the gate owns is positively closed and removed (exact-owned
 *     ledger; a failed/unknown `rm` throws, an inventory error is never a
 *     clean list).
 *
 * It is deliberately NOT part of any default fast lane (npm test /
 * run-all-smoke / run-all-scripted / run-all-e2e-tests). Run it on demand
 * UNDER THE SHARED GATE LOCK:
 *
 *   flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock \
 *     ./run-matchlock-dsh-real-boot-gate-e2e-test
 *
 * which builds first, accepts the caller's runtime (the runner does not pin the
 * system matchlock hash), creates a NEW never-reused evidence directory and
 * runs this file with a private isolated HOME/STATE/DB/TMPDIR rooted INSIDE
 * that evidence directory.
 *
 * HONEST NOTE: the whole-path launch-probe assertion (exactly one
 * `run.harness_probe_ok` on a real credentialed run) lives in the existing
 * DSV2-in-VM gate e2e-tests/matchlock-dsh-real-gate.test.ts (Gate E), which
 * runs the same fixed plan with the operator's REAL credentials; this
 * contained gate deliberately stages placeholder credentials so it can never
 * spend a model token.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cleanChildEnv } from "../tests/helpers/test-env.ts";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import { inheritedProcessEnv } from "./helpers/smoke-helpers.ts";
import {
  DSH_GATE_BOOT_LOCK_BASENAME,
  DSH_GATE_PLACEHOLDER_CREDENTIALS,
  DshOverlayObserver,
  diffDshHostStore,
  nativeDshBootPlan,
  snapshotDshHostStore,
  snapshotDshProfilesInvariance,
  stageRealLayoutDshHome,
  stderrCarriesDshBootEnoent,
  stderrCarriesDshBootLockEnoent,
  stderrCarriesDshFsyncEnoent,
  watchDshProfilesBootLock,
} from "./helpers/matchlock-dsh-gate-fixtures.ts";
import {
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";
import type { RealLayoutDshHomeLayout } from "./helpers/matchlock-dsh-gate-fixtures.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── environment: caller-provided runtime + operator sources ───────────────
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

// MTLK-UNPIN: the paired runtime is resolved (not pinned). The resolved CLI
// is always exported; the guest-init/fused vars are exported only when the
// driver resolved them, so when unset, matchlock resolves them itself. No
// runtime hash is ever pinned and no guest binary is required to be pre-set.
function matchlockRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = { TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN };
  if (GUEST_INIT.length > 0) env.MATCHLOCK_GUEST_INIT = GUEST_INIT;
  if (GUEST_FUSED.length > 0) env.MATCHLOCK_GUEST_FUSED = GUEST_FUSED;
  return env;
}

// The REAL qualified operator image (ships dsh 0.1.5-rc.2). Its matchlock-store
// copy is the qualified toolchain image; the plain docker tag is not.
const OPERATOR_TAG = "igorhvr/bedlam-ubuntu";

const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";

// Observed-rounds evidence label (TESTER-HONESTY item 3): the runner passes the
// same label to scripts/observed-rounds-guard.mjs.
const GATE_LABEL = "dsh-real-boot";

const OPERATOR_CACHE = process.env.TAMANDUA_GATE_OPERATOR_CACHE ?? "";
// The operator's real dsh home supplies ONLY the durable headless profile
// layout. Its credentials/sessions are never read.
const REAL_DSH_HOME = process.env.TAMANDUA_GATE_REAL_DSH_HOME ?? "";

const DSH_OVERLAY_OBSERVER_INTERVAL_MS = 10;
const ROUND_TIMEOUT_MS = 8 * 60_000;

/** The durable profile config files the real headless layout carries. */
const REQUIRED_DURABLE_PROFILE_FILES = [
  "package.json",
  "cordis.yml",
  "pnpm-workspace.yaml",
] as const;

function assertEnv(): void {
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-dsh-real-boot-gate-e2e-test)",
  );
  assert.ok(MATCHLOCK_RPC_BIN.length > 0, "TAMANDUA_MATCHLOCK_RPC_BIN must be set (the gate driver resolves matchlock from PATH)");
  // Guest-init/fused are OPTIONAL (MTLK-UNPIN): when unset, matchlock resolves
  // them itself and the gate records whatever it observes.
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    if (p.length > 0) {
      assert.ok(fs.existsSync(p), `resolved runtime binary missing: ${p}`);
    }
  }
  assert.ok(
    OPERATOR_CACHE.length > 0,
    "TAMANDUA_GATE_OPERATOR_CACHE (the operator ~/.cache/matchlock store carrying " +
      `the real ${OPERATOR_TAG} image) must be set`,
  );
  assert.ok(
    fs.existsSync(path.join(OPERATOR_CACHE, "images", "metadata.db")),
    `operator matchlock image store missing under ${OPERATOR_CACHE}`,
  );
  assert.ok(
    REAL_DSH_HOME.length > 0,
    "TAMANDUA_GATE_REAL_DSH_HOME (the operator's real dsh home carrying the " +
      "real headless profile layout) must be set",
  );
  assert.ok(
    fs.existsSync(path.join(REAL_DSH_HOME, "profiles", "headless", "package.json")),
    `operator dsh headless profile missing under ${REAL_DSH_HOME}/profiles/headless`,
  );
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Fresh gate-owned git repo (clean tracked tree) for the round's cwd. */
function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# dsh real-boot gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Dsh Real Boot Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

// ── operator matchlock image-store seeding ────────────────────────────────

/**
 * Seed the private matchlock image store from the operator's store via
 * HARDLINKED content-addressed blobs + copied metadata. Never mutates the
 * operator store (blobs are read-only content-addressed; metadata is copied).
 */
function seedOperatorImageStore(operatorCache: string, homeDir: string): void {
  const src = path.join(operatorCache, "images");
  const dst = path.join(homeDir, ".cache", "matchlock", "images");
  fs.mkdirSync(dst, { recursive: true });
  const srcBlobs = path.join(src, "blobs");
  if (fs.existsSync(srcBlobs) && fs.readdirSync(srcBlobs).length > 0) {
    const linked = spawnSync("cp", ["-al", srcBlobs, path.join(dst, "blobs")], {
      encoding: "utf-8",
    });
    if (linked.status !== 0) {
      const copied = spawnSync("cp", ["-a", "--reflink=auto", srcBlobs, path.join(dst, "blobs")], {
        encoding: "utf-8",
      });
      assert.equal(
        copied.status,
        0,
        `seeding operator image blobs failed (hardlink: ${linked.stderr}; copy: ${copied.stderr})`,
      );
    }
  }
  for (const meta of ["metadata.db", "metadata.db-wal", "metadata.db-shm"]) {
    const from = path.join(src, meta);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, meta));
  }
  const local = path.join(src, "local");
  if (fs.existsSync(local)) fs.cpSync(local, path.join(dst, "local"), { recursive: true });
}

function resolveImage(tag: string, homeDir: string): { digest: string; config_digest: string } {
  const r = spawnSync(MATCHLOCK_RPC_BIN, ["image", "resolve", tag], {
    encoding: "utf-8",
    env: cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir }),
  });
  assert.equal(r.status, 0, `matchlock image resolve ${tag} failed: ${r.stderr}`);
  const identity = JSON.parse(r.stdout.trim()) as { digest: string; config_digest: string };
  assert.ok(
    identity.digest.startsWith("sha256:") && identity.config_digest.startsWith("sha256:"),
    `resolved identity for ${tag} incomplete: ${r.stdout.trim()}`,
  );
  return identity;
}

// ── strict VM inventory + cleanup (never inventory-error-to-empty) ────────

function readVmIds(homeDir: string): string[] {
  const stateDb = path.join(homeDir, ".matchlock", "state.db");
  if (!fs.existsSync(stateDb)) return [];
  const db = openE2eDatabase(stateDb);
  try {
    const rows = db.prepare("SELECT id FROM vms ORDER BY created_at").all() as Array<{ id: string }>;
    return rows.map((r) => r.id).filter((id) => /^vm-[0-9a-f]{8}$/.test(id));
  } catch (err) {
    throw new Error(`VM inventory read failed (state DB ${stateDb}): ${String(err)}`);
  } finally {
    db.close();
  }
}

function cleanupOwnedVms(homeDir: string, ledgerPath: string, observedIds: string[]): string[] {
  const ledger: string[] = [];
  const clean = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
  const rowIds = readVmIds(homeDir);
  const vmsDir = path.join(homeDir, ".matchlock", "vms");
  let dirIds: string[] = [];
  if (fs.existsSync(vmsDir)) {
    dirIds = fs
      .readdirSync(vmsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^vm-[0-9a-f]{8}$/.test(e.name))
      .map((e) => e.name);
  }
  const rowIdSet = new Set(rowIds);
  const dirIdSet = new Set(dirIds);
  const target = [...new Set([...rowIds, ...dirIds, ...observedIds])].sort();
  ledger.push(
    `${new Date().toISOString()} VM ids observed during the gate (${observedIds.length}): ${
      observedIds.length > 0 ? observedIds.join(",") : "(none)"
    }`,
  );
  ledger.push(
    `${new Date().toISOString()} VM ids still present at cleanup (rows=${rowIds.length}, dirs=${dirIds.length}): ${
      target.length > 0 ? target.join(",") : "(none — runner positively closed every owned VM)"
    }`,
  );
  for (const id of target) {
    const stateDir = path.join(vmsDir, id);
    if (!rowIdSet.has(id) && !dirIdSet.has(id)) {
      ledger.push(`${new Date().toISOString()} vm ${id} already positively closed by the runner`);
      continue;
    }
    const rm = spawnSync(MATCHLOCK_RPC_BIN, ["rm", id], { encoding: "utf-8", env: clean });
    ledger.push(
      `${new Date().toISOString()} vm ${id} rm rc=${rm.status} out=${(rm.stdout || rm.stderr || "").trim()}`,
    );
    if (rm.status !== 0 && fs.existsSync(stateDir)) {
      ledger.push(
        `${new Date().toISOString()} vm ${id} STATE DIR STILL PRESENT after exact-id rm (rc=${rm.status})`,
      );
      throw new Error(
        `vm ${id} state dir still present after exact-id cleanup (rm rc=${rm.status}): ${(rm.stderr || "").trim()}`,
      );
    }
    if (fs.existsSync(stateDir)) {
      ledger.push(`${new Date().toISOString()} vm ${id} STATE DIR STILL PRESENT after cleanup`);
      throw new Error(`vm ${id} state dir still present after exact-id cleanup`);
    }
  }
  const leftoverRows = readVmIds(homeDir);
  if (leftoverRows.length > 0) {
    ledger.push(`${new Date().toISOString()} LEFTOVER VM ROWS after cleanup: ${leftoverRows.join(",")}`);
    throw new Error(`leftover VM rows after cleanup: ${leftoverRows.join(",")}`);
  }
  ledger.push(`${new Date().toISOString()} cleanup complete: no owned VM rows/state dirs remain`);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const prior = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf-8") : "";
  fs.writeFileSync(ledgerPath, `${prior}${ledger.join("\n")}\n`, "utf-8");
  return ledger;
}

// ── shared state ──────────────────────────────────────────────────────────

let homeDir = "";
let tamanduaDir = "";
let dshHome = "";
let stagedLayout: RealLayoutDshHomeLayout | null = null;
let hostInstallRoot = "";
let wd = "";
let ledgerPath = "";
let imageIdentity: { digest: string; config_digest: string } | null = null;
const observedVmIds: string[] = [];

function writeEvidence(name: string, content: string): string {
  const p = path.join(EVIDENCE_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

// ── dist (production runner + admission + overlay geometry) ───────────────

interface DirectRecord {
  label: string;
  ok: boolean;
  vmId: string | null;
  cleanupConfirmed: boolean | undefined;
  exitCode: number | null;
  timedOut: boolean | undefined;
  stdout: string;
  stderrTail: string;
  error?: string;
}

async function loadDirectRunner(): Promise<{
  runDshInvocation: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/dsh-invocation-runner.js`);
  return { runDshInvocation: mod.runDshInvocation };
}

async function loadAdmission(): Promise<{
  admitMatchlockRun: (o: Record<string, unknown>) => Promise<{ policy: Record<string, unknown> }>;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/admission.js`);
  return { admitMatchlockRun: mod.admitMatchlockRun };
}

async function loadOverlayHelpers(): Promise<{
  prepare: (runId: string, liveStateRoot: string, hostHome: string) => { overlayRoot: string };
  root: (runId: string, liveStateRoot: string) => string;
  cleanup: (runId: string, liveStateRoot: string) => void;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/dsh-profile-overlay.js`);
  return {
    prepare: (runId, liveStateRoot, hostHome) =>
      mod.prepareDshProfileOverlay(runId, liveStateRoot, hostHome) as { overlayRoot: string },
    root: (runId, liveStateRoot) => mod.dshProfileOverlayRoot(runId, liveStateRoot) as string,
    cleanup: (runId, liveStateRoot) =>
      mod.cleanupDshProfileOverlay(runId, liveStateRoot) as void,
  };
}

async function resolveControlHomeAlias(realHome: string): Promise<string> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/home-alias.js`);
  return mod.resolveMatchlockHomeAlias({
    realHome,
    env: { ...inheritedProcessEnv(), HOME: realHome },
  });
}

// ── dsh probe / store seams (US-004) ───────────────────────────────────────

async function loadSchedulerDsh(): Promise<{
  DSH_MATCHLOCK_GUEST_CLI: string;
  DSH_MATCHLOCK_GUEST_SKILL_FILE: string;
  buildDshProbePrompt: () => string;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/scheduler-dsh.js`);
  return {
    DSH_MATCHLOCK_GUEST_CLI: mod.DSH_MATCHLOCK_GUEST_CLI as string,
    DSH_MATCHLOCK_GUEST_SKILL_FILE: mod.DSH_MATCHLOCK_GUEST_SKILL_FILE as string,
    buildDshProbePrompt: mod.buildDshProbePrompt as () => string,
  };
}

async function loadSharedRunner(): Promise<{
  runMatchlockInvocation: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/pi-invocation-runner.js`);
  return { runMatchlockInvocation: mod.runMatchlockInvocation };
}

async function loadProbeEvaluator(): Promise<{
  passesHarnessProbe: (message: string, expectedPath: string) => boolean;
}> {
  const mod = await import(`${repoRoot}/dist/installer/harness-probe.js`);
  return { passesHarnessProbe: mod.passesHarnessProbe };
}

async function loadSessionReader(): Promise<{
  readDshSessionArtifact: (o: {
    artifactPath: string;
    admittedRoot?: string;
  }) => Record<string, unknown>;
  discoverSessionArtifacts: (dirPath: string) => Record<string, unknown>;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/dsh-session-store.js`);
  return {
    readDshSessionArtifact: mod.readDshSessionArtifact,
    discoverSessionArtifacts: mod.discoverSessionArtifacts,
  };
}

async function ensurePackHostPath(): Promise<string> {
  const sm = await import(`${repoRoot}/dist/installer/matchlock/scheduler-matchlock.js`);
  return sm.ensureGuestPackForState({ stateRoot: tamanduaDir });
}

async function buildDirectOptions(
  policy: Record<string, unknown>,
  workdir: string,
  promptText: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const invocationId = randomUUID();
  return {
    policy,
    identity: {
      runId,
      agentId: "do-now_doer",
      workflowId: "do-now",
      jobId: `job-${invocationId.slice(0, 8)}`,
      invocationId,
    },
    kind: "work",
    promptText,
    workingDirectoryForHarness: workdir,
    timeoutMs: ROUND_TIMEOUT_MS,
    createTimeoutMs: 240_000,
    readyTimeoutMs: 30_000,
    handshakeTimeoutMs: 90_000,
    serviceTimeoutMs: ROUND_TIMEOUT_MS,
    closeTimeoutSeconds: 60,
    helperPackHostPath: await ensurePackHostPath(),
    rpcEnv: {
      HOME: await resolveControlHomeAlias(homeDir),
      ...matchlockRuntimeEnv(),
      TAMANDUA_STATE_DIR: tamanduaDir,
    },
  };
}

/** One direct REAL-dsh boot round through the production dsh invocation runner. */
async function directRealBootRound(opts: {
  label: string;
  policy: Record<string, unknown>;
  workdir: string;
  runId: string;
  prompt: string;
}): Promise<DirectRecord> {
  const runner = await loadDirectRunner();
  const record: DirectRecord = {
    label: opts.label,
    ok: false,
    vmId: null,
    cleanupConfirmed: undefined,
    exitCode: null,
    timedOut: undefined,
    stdout: "",
    stderrTail: "",
  };
  try {
    const options = await buildDirectOptions(
      opts.policy,
      opts.workdir,
      opts.prompt,
      opts.runId,
    );
    const result = await runner.runDshInvocation(options);
    record.ok = true;
    record.vmId = (result.vmId as string | null) ?? null;
    record.cleanupConfirmed = result.cleanupConfirmed as boolean | undefined;
    record.exitCode = (result.exitCode as number | null) ?? null;
    record.timedOut = result.timedOut as boolean | undefined;
    record.stdout = String(result.output ?? "");
    record.stderrTail = String(result.stderrTail ?? "");
    if (record.vmId) observedVmIds.push(record.vmId);
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
  }
  return record;
}

/**
 * US-004 — the contained LAUNCH-PROBE command round: run the exact probe
 * command `/workspace/runtime/bin/tamandua skill-path` in a fresh VM over the
 * real-layout `$DSH_HOME`, through the SAME production Matchlock invocation
 * lifecycle the dsh runner uses (registry → controller → mounts → execPipe →
 * revoke → positively-closed VM).
 *
 * The dsh-MEDIATED probe (`dsh` boots, then a provider-backed agent runs the
 * command) cannot complete on a contained gate's PLACEHOLDER credentials, so
 * this round executes the probe COMMAND itself (zero model tokens) and asserts
 * it exits 0 with the exact guest skill PATH; the real dsh BOOT is separately
 * exercised by {@link directRealBootRound}, and the credentialed whole-path
 * `run.harness_probe_ok` assertion remains in Gate E
 * (e2e-tests/matchlock-dsh-real-gate.test.ts).
 */
async function directProbeCommandRound(opts: {
  policy: Record<string, unknown>;
  workdir: string;
  runId: string;
}): Promise<DirectRecord> {
  const runner = await loadSharedRunner();
  const sched = await loadSchedulerDsh();
  const record: DirectRecord = {
    label: "launch-probe-command",
    ok: false,
    vmId: null,
    cleanupConfirmed: undefined,
    exitCode: null,
    timedOut: undefined,
    stdout: "",
    stderrTail: "",
  };
  try {
    const options = await buildDirectOptions(
      opts.policy,
      opts.workdir,
      "skill-path",
      opts.runId,
    );
    options.kind = "probe";
    // The shared runner appends promptText as one quoted argv entry, so this
    // exact guest command runs: `/workspace/runtime/bin/tamandua skill-path`.
    options.harnessArgv = [sched.DSH_MATCHLOCK_GUEST_CLI];
    // Mirror `runDshInvocation`: prepend the helper-pack bin ONLY to the image's
    // declared effective PATH (the pack CLI wrapper resolves `node` from it).
    if (opts.policy.imagePath !== undefined) options.imagePath = opts.policy.imagePath;
    const result = await runner.runMatchlockInvocation(options);
    record.ok = true;
    record.vmId = (result.vmId as string | null) ?? null;
    record.cleanupConfirmed = result.cleanupConfirmed as boolean | undefined;
    record.exitCode = (result.exitCode as number | null) ?? null;
    record.timedOut = result.timedOut as boolean | undefined;
    record.stdout = String(result.output ?? "");
    record.stderrTail = String(result.stderrTail ?? "");
    if (record.vmId) observedVmIds.push(record.vmId);
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
  }
  return record;
}

async function admitDshPolicy(): Promise<Record<string, unknown>> {
  const { admitMatchlockRun } = await loadAdmission();
  const result = await admitMatchlockRun({
    requestedImage: OPERATOR_TAG,
    harness: "dsh",
    workspaceMode: "direct",
    workingDirectory: wd,
    submission: { homeDir, cwd: wd, env: { DSH_HOME: dshHome } },
    rpcBinaryPath: MATCHLOCK_RPC_BIN,
    admission: { home: homeDir, liveStateRoot: tamanduaDir },
  });
  return result.policy;
}

// ── the gate ──────────────────────────────────────────────────────────────

describe(
  "matchlock dsh real-boot gate: the REAL dsh boot creates its writer lock in the private profiles overlay",
  { concurrency: 1, timeout: 60 * 60_000 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      homeDir = path.join(EVIDENCE_DIR, "home");
      tamanduaDir = path.join(homeDir, ".tamandua");
      hostInstallRoot = path.join(EVIDENCE_DIR, "host-install");
      process.env.HOME = homeDir;
      process.env.TAMANDUA_STATE_DIR = tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
      process.env.TAMANDUA_WORKTREE_ROOT = path.join(tamanduaDir, "worktrees");
      Object.assign(process.env, matchlockRuntimeEnv());
      process.env.TAMANDUA_TEST_GUARD = "1";
      process.env.TMPDIR = path.join(EVIDENCE_DIR, "tmp");

      fs.mkdirSync(tamanduaDir, { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".cache"), { recursive: true });
      fs.mkdirSync(path.join(EVIDENCE_DIR, "tmp"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "agent", "settings.json"),
        JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
        "utf-8",
      );
      fs.writeFileSync(path.join(tamanduaDir, "port"), "0", "utf-8");

      const kernelSrc = path.join(OPERATOR_CACHE, "kernels");
      assert.ok(fs.existsSync(kernelSrc), `operator kernel cache missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), {
        recursive: true,
      });

      seedOperatorImageStore(OPERATOR_CACHE, homeDir);
      imageIdentity = resolveImage(OPERATOR_TAG, homeDir);
      console.log(
        `[matchlock-dsh-real-boot-gate] image ${OPERATOR_TAG} digest=${imageIdentity.digest} ` +
          `config=${imageIdentity.config_digest}`,
      );

      // Fresh gate-owned DSH_HOME: the OPERATOR-SHAPED real layout (US-001:
      // >=3 `sessions/<cwd-key>/session-<uuid>/` dirs with concatenated-zstd
      // artifacts, `storages/session_projcache/sessions/*.json`, the durable
      // profile config) with PLACEHOLDER credentials. The #34 gate used a
      // MINIMAL home and therefore never exercised the real store shape.
      dshHome = path.join(EVIDENCE_DIR, "dsh-home");
      stagedLayout = stageRealLayoutDshHome({
        sourceHome: REAL_DSH_HOME,
        destinationHome: dshHome,
      });
      assert.ok(
        fs.realpathSync(dshHome).startsWith(fs.realpathSync(EVIDENCE_DIR) + path.sep),
        "gate-owned DSH_HOME must live inside the evidence dir (never the operator home)",
      );
      // The staged home must be stageable by the production overlay planner
      // (no symlink under profiles/). This is the same call the runner's
      // controller makes before create; undo it immediately so the round owns
      // its own overlay lifecycle.
      const overlayHelpers = await loadOverlayHelpers();
      const sanityRunId = randomUUID();
      overlayHelpers.prepare(sanityRunId, tamanduaDir, dshHome);
      overlayHelpers.cleanup(sanityRunId, tamanduaDir);
      assert.equal(
        fs.existsSync(overlayHelpers.root(sanityRunId, tamanduaDir)),
        false,
        "the staging sanity overlay must be removed before the rounds",
      );

      wd = prepareFixtureRepo(path.join(EVIDENCE_DIR, "fixtures", "wd-real-boot"));
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");

      writeEvidence(
        "real-dsh-boot-image.json",
        JSON.stringify(
          {
            image: OPERATOR_TAG,
            digest: imageIdentity.digest,
            configDigest: imageIdentity.config_digest,
            sourceDshHome: REAL_DSH_HOME,
            gateDshHome: dshHome,
            durableProfileFiles: stagedLayout.durableProfileFiles,
            installDerivedDirs: stagedLayout.installDerivedDirs,
            realLayout: {
              sessionProjectDirs: stagedLayout.sessionProjectDirs.length,
              sessionDirs: stagedLayout.sessionDirs.length,
              currentSessionArtifacts: stagedLayout.currentSessionArtifacts.length,
              storageRecordFiles: stagedLayout.storageRecordFiles.length,
              synthesizedConfigFiles: stagedLayout.synthesizedConfigFiles,
            },
            placeholderCredentialsOnly: true,
          },
          null,
          2,
        ),
      );
    });

    after(async () => {
      if (homeDir) {
        try {
          cleanupOwnedVms(homeDir, ledgerPath, observedVmIds);
        } catch {
          /* the test body owns the authoritative (throwing) cleanup */
        }
      }
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
      assertObservedRoundsNonZero(GATE_LABEL, observedRounds, observedVmIds);
    });

    it(
      "the REAL dsh boot creates the private overlay writer lock and leaves the host profiles/ tree untouched",
      { timeout: 60 * 60_000 },
      async () => {
        assert.ok(stagedLayout, "before() must stage the gate-owned real-layout DSH_HOME");
        const layout = stagedLayout;

        // 1. The gate-owned home is the US-001 OPERATOR-SHAPED real layout
        //    (not the minimal headless-only fixture that let #34 pass): >= 3
        //    distinct session project dirs with concatenated-zstd artifacts,
        //    storages JSON records, the durable profile config, placeholder
        //    creds and empty install-derived dirs.
        assert.ok(
          layout.sessionDirs.length >= 3,
          `the real-layout home must carry >=3 session dirs: ${JSON.stringify(layout.sessionDirs)}`,
        );
        assert.equal(layout.sessionProjectDirs.length, layout.sessionDirs.length);
        assert.ok(
          layout.currentSessionArtifacts.length >= 3,
          "the real-layout home must carry >=3 current v3 session artifacts",
        );
        assert.ok(
          layout.storageRecordFiles.length >= 1,
          "the real-layout home must carry storages/session_projcache/sessions JSON records",
        );
        for (const file of REQUIRED_DURABLE_PROFILE_FILES) {
          assert.ok(
            fs.existsSync(path.join(dshHome, "profiles", layout.profile, file)),
            `the staged home must carry the durable profile config ${file}`,
          );
        }
        assert.equal(
          fs.readFileSync(path.join(dshHome, ".credentials.yaml"), "utf-8"),
          DSH_GATE_PLACEHOLDER_CREDENTIALS,
          "the gate-owned home must carry placeholder credentials only",
        );
        // The seeded real-layout store must survive every round untouched and
        // is the baseline for the "first request record landed" delta.
        const seededStore = snapshotDshHostStore(dshHome);
        assert.equal(seededStore.sessionDirs.length, layout.sessionDirs.length);
        const profilesBeforeNative = snapshotDshProfilesInvariance(dshHome);
        assert.equal(profilesBeforeNative.lockPresent, false, "no host lock before any round");

        // 2. NATIVE zero-provider boot (#31 alternation): the deterministic
        //    fixture heals the synthetic HOST farm once.
        const nativeHome = path.join(EVIDENCE_DIR, "native-home");
        fs.mkdirSync(nativeHome, { recursive: true });
        const nativePlan = nativeDshBootPlan({
          nodePath: process.execPath,
          fakeDshPath: path.join(repoRoot, "e2e-tests", "dsh-fixture", "fake-dsh.mjs"),
          homeDir: nativeHome,
          dshHome,
          hostInstallRoot,
        });
        const nativeBoot = (): { status: number | null; stdout: string; stderr: string } => {
          const r = spawnSync(nativePlan.command, nativePlan.args, {
            encoding: "utf-8",
            timeout: nativePlan.timeoutMs,
            env: nativePlan.env,
            maxBuffer: 16 * 1024 * 1024,
          });
          return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
        };
        const boot1 = nativeBoot();
        assert.equal(boot1.status, 0, `native boot failed: ${boot1.stderr.slice(-2000)}`);
        assert.match(boot1.stdout, /^NATIVE-HEAL: links=\d+ /m);
        const baselineProfiles = snapshotDshProfilesInvariance(dshHome);
        assert.equal(baselineProfiles.lockPresent, false, "no HOST profiles/node_modules.lock after the native boot");
        assert.ok(
          Object.keys(baselineProfiles.links).length > 0,
          `the native boot must have healed the host farm: ${JSON.stringify(baselineProfiles.links)}`,
        );

        const policy = await admitDshPolicy();
        assert.equal(policy.harness, "dsh", "admitted policy must be harness dsh");
        assert.equal(
          fs.realpathSync(String(policy.configurationRoot)),
          fs.realpathSync(dshHome),
          "the admitted config root must be the gate-owned home",
        );
        assert.equal(policy.guestConfigurationRoot, "/workspace/config/dsh");
        assert.equal(policy.configurationProfile, layout.profile, "the admitted profile must be headless");

        const overlayHelpers = await loadOverlayHelpers();
        const sessions = await loadSchedulerDsh();
        const probeEvaluator = await loadProbeEvaluator();
        const sessionStore = await loadSessionReader();
        const rounds: Array<Record<string, unknown>> = [];

        // 3. US-004 LAUNCH-PROBE command round: the exact
        //    `/workspace/runtime/bin/tamandua skill-path` command runs in a
        //    fresh VM over the real-layout home and exits 0 with the guest
        //    skill PATH (ZERO model tokens — the dsh-MEDIATED probe needs a
        //    provider and is asserted on real credentials in Gate E).
        const probeRunId = randomUUID();
        const storeBeforeProbe = snapshotDshHostStore(dshHome);
        const probeRec = await directProbeCommandRound({
          policy,
          workdir: wd,
          runId: probeRunId,
        });
        const probeStoreDelta = diffDshHostStore(
          storeBeforeProbe,
          snapshotDshHostStore(dshHome),
        );
        const probeCombined = `${probeRec.stderrTail}\n${probeRec.stdout}`;
        assert.ok(probeRec.ok, `launch-probe round rejected: ${probeRec.error}`);
        assert.ok(probeRec.vmId !== null, "launch probe must own a fresh VM");
        assert.equal(
          probeRec.cleanupConfirmed,
          true,
          `launch probe owned VM must be positively closed (cleanup=${probeRec.cleanupConfirmed}, timedOut=${probeRec.timedOut})`,
        );
        assert.equal(
          probeRec.exitCode,
          0,
          `the launch probe command ${sessions.DSH_MATCHLOCK_GUEST_CLI} skill-path must exit 0: ` +
            `stdout=${probeRec.stdout.slice(0, 1000)} stderr=${probeRec.stderrTail.slice(-2000)}`,
        );
        assert.equal(
          probeEvaluator.passesHarnessProbe(probeRec.stdout, sessions.DSH_MATCHLOCK_GUEST_SKILL_FILE),
          true,
          `the launch probe must print the guest skill PATH ${sessions.DSH_MATCHLOCK_GUEST_SKILL_FILE}: ` +
            `stdout=${probeRec.stdout.slice(0, 1000)}`,
        );
        assert.equal(
          stderrCarriesDshBootEnoent(probeCombined),
          false,
          `the launch probe stderr must carry neither ENOENT ... fsync nor ENOENT ... node_modules.lock: ${probeRec.stderrTail.slice(-2000)}`,
        );
        // The probe command is read-only: it must not fabricate a store record.
        assert.deepEqual(
          probeStoreDelta,
          { addedSessionDirs: [], addedSessionFiles: [], addedStorageFiles: [] },
          `the read-only launch probe must not write the store: ${JSON.stringify(probeStoreDelta)}`,
        );
        writeEvidence(
          "dsh-real-boot-launch-probe.json",
          JSON.stringify(
            {
              runId: probeRunId,
              command: `${sessions.DSH_MATCHLOCK_GUEST_CLI} skill-path`,
              expectedSkillPath: sessions.DSH_MATCHLOCK_GUEST_SKILL_FILE,
              exitCode: probeRec.exitCode,
              passesHarnessProbe: probeEvaluator.passesHarnessProbe(
                probeRec.stdout,
                sessions.DSH_MATCHLOCK_GUEST_SKILL_FILE,
              ),
              bootEnoentAbsent: !stderrCarriesDshBootEnoent(probeCombined),
              vmId: probeRec.vmId,
              cleanupConfirmed: probeRec.cleanupConfirmed,
              stdout: probeRec.stdout.slice(0, 2000),
              stderrTail: probeRec.stderrTail.slice(-2000),
              zeroModelTokens: true,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        );

        for (let round = 1; round <= 2; round += 1) {
          const runId = randomUUID();
          // Pre-prepare the production private overlay so the observer/watcher
          // can watch `profiles/` from before the VM even boots (the runner's
          // controller re-prepares the same root idempotently).
          const overlayRoot = overlayHelpers.prepare(runId, tamanduaDir, dshHome).overlayRoot;
          assert.equal(
            overlayRoot,
            overlayHelpers.root(runId, tamanduaDir),
            `round ${round}: the pre-prepared overlay root must be the production run's attested root`,
          );
          const lockWatch = watchDshProfilesBootLock(path.join(overlayRoot, "profiles"), {
            pollMs: 2,
          });
          const observer = new DshOverlayObserver(overlayRoot, {
            intervalMs: DSH_OVERLAY_OBSERVER_INTERVAL_MS,
          }).start();

          const storeBefore = snapshotDshHostStore(dshHome);
          const rec = await directRealBootRound({
            label: `real-dsh-boot-round-${round}`,
            policy,
            workdir: wd,
            runId,
            // The REAL dsh launch-probe prompt (scheduler-dsh's production
            // probe prompt): this is the exact dsh boot the production launch
            // probe performs; with placeholder credentials the agent round then
            // stops at MISSING_CREDENTIAL, after the boot has already persisted
            // the session record (zero model tokens).
            prompt: sessions.buildDshProbePrompt(),
          });

          const observed = observer.stop();
          const lockObs = lockWatch.stop();
          const afterProfiles = snapshotDshProfilesInvariance(dshHome);
          const storeAfter = snapshotDshHostStore(dshHome);
          const storeDelta = diffDshHostStore(storeBefore, storeAfter);

          // 2. The HOST profiles/ tree is byte-identical and never carries the
          //    guest's writer lock.
          assert.deepEqual(
            afterProfiles,
            baselineProfiles,
            `round ${round}: the HOST profiles/ tree must stay byte-identical (files, links, no lock)`,
          );
          assert.equal(
            afterProfiles.lockPresent,
            false,
            `round ${round}: no HOST profiles/${DSH_GATE_BOOT_LOCK_BASENAME} may exist`,
          );
          assert.equal(
            fs.existsSync(path.join(dshHome, "profiles", DSH_GATE_BOOT_LOCK_BASENAME)),
            false,
            `round ${round}: the guest boot lock must never leak to the host`,
          );

          // 3. The round went through the production runner and positively
          //    closed its owned VM.
          assert.ok(rec.ok, `round ${round}: runner rejected the round: ${rec.error}`);
          assert.ok(rec.vmId !== null, `round ${round}: a fresh VM must have been owned`);
          assert.equal(
            rec.cleanupConfirmed,
            true,
            `round ${round}: the owned VM must be positively closed (cleanup=${rec.cleanupConfirmed}, timedOut=${rec.timedOut})`,
          );
          assert.ok(
            typeof rec.exitCode === "number" || rec.timedOut === true,
            `round ${round}: the round must settle (exitCode=${rec.exitCode}, timedOut=${rec.timedOut})`,
          );

          // 4. The REAL dsh boot got PAST healProfilesModuleFallback AND past
          //    the run-#35 root-fsync: it created the writer lock inside its
          //    PRIVATE overlay, and the round's stderr carries NEITHER the
          //    run-#35 `ENOENT ... fsync` on the effective home NOR the run-#32
          //    `ENOENT ... profiles/node_modules.lock` boot-lock failure. Any
          //    provider/credential error is a strictly later-class outcome.
          const lockSeen =
            lockObs.seen || observed.files.includes(path.join("profiles", DSH_GATE_BOOT_LOCK_BASENAME));
          assert.ok(
            lockSeen,
            `round ${round}: the guest must create profiles/${DSH_GATE_BOOT_LOCK_BASENAME} in the private overlay ` +
              `(watchEvents=${JSON.stringify(lockObs.events)}, observedFiles=${JSON.stringify(observed.files)})`,
          );
          const combinedStderr = `${rec.stderrTail}\n${rec.stdout}`;
          assert.equal(
            stderrCarriesDshFsyncEnoent(combinedStderr),
            false,
            `round ${round}: the REAL dsh boot must not fail with the run-#35 ENOENT fsync on the effective home:\n${combinedStderr.slice(-4000)}`,
          );
          assert.equal(
            stderrCarriesDshBootLockEnoent(combinedStderr, path.join(overlayRoot, "profiles")),
            false,
            `round ${round}: stderr must not carry the run-#32 ENOENT lock failure:\n${combinedStderr.slice(-4000)}`,
          );
          assert.equal(
            stderrCarriesDshBootEnoent(combinedStderr, path.join(overlayRoot, "profiles")),
            false,
            `round ${round}: stderr must carry neither boot-fatal ENOENT shape:\n${combinedStderr.slice(-4000)}`,
          );

          // 4b. US-004 FIRST REQUEST RECORD: the boot's session store write is
          //     merged back to the REAL host home by US-003's publish, and the
          //     new artifact is observed from the host with the PRODUCTION
          //     reader (the exact seam host attribution uses). The store was
          //     writable and fsync-able (the boot reached this write). The
          //     seeded real-layout store is left intact.
          assert.ok(
            storeDelta.addedSessionDirs.length >= 1,
            `round ${round}: the REAL dsh boot must create a new session dir in the mapped store: ${JSON.stringify(storeDelta)}`,
          );
          const newSessionArtifacts = storeDelta.addedSessionFiles.filter((rel) =>
            rel.endsWith(`session.v${3}.jsonl.zstd`),
          );
          assert.ok(
            newSessionArtifacts.length >= 1,
            `round ${round}: the new session dir must carry a current v3 artifact: ${JSON.stringify(storeDelta)}`,
          );
          // `discoverSessionArtifacts` must classify the new session dir with the
          // current v3 artifact and no problem (the same discovery host
          // attribution performs before reading).
          const newSessionDiscovery = sessionStore.discoverSessionArtifacts(
            path.join(dshHome, storeDelta.addedSessionDirs[0]),
          ) as {
            current?: string | null;
            problem?: string | null;
          };
          assert.equal(
            newSessionDiscovery.problem ?? null,
            null,
            `round ${round}: the new session dir must discover cleanly: ${JSON.stringify(newSessionDiscovery)}`,
          );
          assert.equal(
            newSessionDiscovery.current,
            "session.v3.jsonl.zstd",
            `round ${round}: discoverSessionArtifacts must pick the current v3 artifact: ${JSON.stringify(newSessionDiscovery)}`,
          );
          const newSessionRead = sessionStore.readDshSessionArtifact({
            artifactPath: path.join(dshHome, newSessionArtifacts[0]),
            admittedRoot: dshHome,
          });
          assert.equal(
            newSessionRead.decode,
            "ok",
            `round ${round}: the production reader must decode the new session record: ${JSON.stringify(newSessionRead)}`,
          );
          assert.equal(
            (newSessionRead.header as { version?: number } | null)?.version,
            3,
            `round ${round}: the new record must be a v3 session header: ${JSON.stringify(newSessionRead.header)}`,
          );
          // The storages projection path must be a real, reachable directory in
          // the mapped store; when the boot flushed its projection cache (it
          // does on this path) the record is observed too. The session artifact
          // above is the definitive first-request record.
          assert.ok(
            fs.existsSync(path.join(dshHome, "storages", "session_projcache", "sessions")),
            `round ${round}: the mapped storages/ projection path must be reachable`,
          );
          for (const rel of seededStore.sessionDirs) {
            assert.ok(
              storeAfter.sessionDirs.includes(rel),
              `round ${round}: the seeded real-layout session dir ${rel} must survive the round`,
            );
          }
          assert.ok(
            storeAfter.sessionFiles.length >= seededStore.sessionFiles.length,
            `round ${round}: the seeded real-layout session artifacts must survive the round`,
          );

          // The private overlay farm carries links the REAL dsh heal wrote
          // (guest install paths), corroborating that heal ran in the private
          // tree.
          assert.equal(
            observed.rootSeen,
            true,
            `round ${round}: the private overlay root must be observed while live`,
          );
          assert.ok(
            Object.keys(observed.links).length > 0,
            `round ${round}: the REAL dsh heal must populate the private farm: ${JSON.stringify(observed)}`,
          );
          assert.equal(
            fs.existsSync(overlayRoot),
            false,
            `round ${round}: the private overlay root must be removed after the confirmed close`,
          );

          rounds.push({
            round,
            runId,
            overlayRoot,
            vmId: rec.vmId,
            exitCode: rec.exitCode,
            timedOut: rec.timedOut,
            cleanupConfirmed: rec.cleanupConfirmed,
            stderrTail: rec.stderrTail.slice(-4000),
            stdoutTail: rec.stdout.slice(-2000),
            firstLockSeen: lockSeen,
            watchEvents: lockObs.events,
            watchAvailable: lockObs.watchAvailable,
            observedFiles: observed.files,
            observedDirs: observed.dirs,
            observedLinkCount: Object.keys(observed.links).length,
            observedLinks: observed.links,
            hostProfilesBefore: baselineProfiles,
            hostProfilesAfter: afterProfiles,
            hostProfilesByteIdentical:
              JSON.stringify(baselineProfiles) === JSON.stringify(afterProfiles),
            hostProfilesLockPresent: afterProfiles.lockPresent,
            lockEnoentInStderr: stderrCarriesDshBootLockEnoent(
              combinedStderr,
              path.join(overlayRoot, "profiles"),
            ),
            fsyncEnoentInStderr: stderrCarriesDshFsyncEnoent(combinedStderr),
            bootEnoentInStderr: stderrCarriesDshBootEnoent(
              combinedStderr,
              path.join(overlayRoot, "profiles"),
            ),
            storeBefore,
            storeAfter,
            storeDelta,
            firstSessionRecord: {
              addedSessionDirs: storeDelta.addedSessionDirs,
              addedSessionFiles: storeDelta.addedSessionFiles,
              newArtifact: newSessionArtifacts[0],
              discovery: {
                current: newSessionDiscovery.current ?? null,
                problem: newSessionDiscovery.problem ?? null,
              },
              productionReader: {
                decode: newSessionRead.decode,
                headerVersion: (newSessionRead.header as { version?: number } | null)?.version ?? null,
                sessionId: (newSessionRead.header as { id?: string } | null)?.id ?? null,
              },
            },
            addedStorageFiles: storeDelta.addedStorageFiles,
            seededStoreIntact: seededStore.sessionDirs.every((rel) =>
              storeAfter.sessionDirs.includes(rel),
            ),
          });

          writeEvidence(
            `real-dsh-boot-round-${round}.json`,
            JSON.stringify(rounds[rounds.length - 1], null, 2),
          );

          // 5. ALTERNATION: a native boot between rounds must be a no-op on the
          //    healed host farm (the in-VM round did not perturb it).
          const bootBetween = nativeBoot();
          assert.equal(
            bootBetween.status,
            0,
            `round ${round}: inter-round native boot must succeed: ${bootBetween.stderr.slice(-2000)}`,
          );
          const afterNative = snapshotDshProfilesInvariance(dshHome);
          assert.deepEqual(
            afterNative,
            baselineProfiles,
            `round ${round}: the inter-round native boot must not change the healed host profiles/ tree`,
          );
        }

        // 6. Three distinct fresh VMs (one launch-probe command round + two
        //    REAL dsh boot rounds), each positively closed.
        const vmIds = rounds.map((r) => r.vmId);
        const distinctObserved = new Set([probeRec.vmId, ...vmIds]);
        assert.equal(
          observedVmIds.length >= 3,
          true,
          `expected >=3 owned VMs (1 probe + 2 boot rounds): ${JSON.stringify(observedVmIds)}`,
        );
        assert.equal(
          distinctObserved.size,
          observedVmIds.length,
          `every round must boot its own distinct fresh VM: ${JSON.stringify(observedVmIds)}`,
        );
        assert.notEqual(vmIds[0], vmIds[1], "each boot round must boot its own distinct fresh VM");

        writeEvidence(
          "dsh-real-boot-gate.json",
          JSON.stringify(
            {
              gate: "matchlock-dsh-real-boot-gate",
              contract: "DSH-OVERLAY-FSYNC-FIX",
              story: "US-004",
              image: { tag: OPERATOR_TAG, ...imageIdentity },
              sourceDshHome: REAL_DSH_HOME,
              gateDshHome: dshHome,
              realLayoutHome: {
                sessionDirs: layout.sessionDirs.length,
                currentSessionArtifacts: layout.currentSessionArtifacts.length,
                storageRecordFiles: layout.storageRecordFiles.length,
                durableProfileFiles: layout.durableProfileFiles,
                installDerivedDirs: layout.installDerivedDirs,
                synthesizedConfigFiles: layout.synthesizedConfigFiles,
                placeholderCredentialsOnly: true,
              },
              observedInVmRounds: observedVmIds.length,
              probeCommand: `${sessions.DSH_MATCHLOCK_GUEST_CLI} skill-path`,
              launchProbe: {
                runId: probeRunId,
                exitCode: probeRec.exitCode,
                passesHarnessProbe: probeEvaluator.passesHarnessProbe(
                  probeRec.stdout,
                  sessions.DSH_MATCHLOCK_GUEST_SKILL_FILE,
                ),
                bootEnoentAbsent: !stderrCarriesDshBootEnoent(probeCombined),
                vmId: probeRec.vmId,
                cleanupConfirmed: probeRec.cleanupConfirmed,
                zeroModelTokens: true,
              },
              policy: {
                harness: policy.harness,
                configurationRoot: policy.configurationRoot,
                configurationProfile: policy.configurationProfile,
                guestConfigurationRoot: policy.guestConfigurationRoot,
              },
              durableProfileFiles: layout.durableProfileFiles,
              installDerivedDirs: layout.installDerivedDirs,
              lockBasename: DSH_GATE_BOOT_LOCK_BASENAME,
              hostProfilesByteIdenticalAcrossEveryRound: rounds.every(
                (r) => r.hostProfilesByteIdentical === true,
              ),
              lockObservedEveryRound: rounds.every((r) => r.firstLockSeen === true),
              lockEnoentAbsentEveryRound: rounds.every((r) => r.lockEnoentInStderr === false),
              fsyncEnoentAbsentEveryRound: rounds.every(
                (r) => r.fsyncEnoentInStderr === false,
              ),
              firstSessionRecordEveryRound: rounds.every(
                (r) =>
                  (r.firstSessionRecord as { productionReader?: { decode?: string } } | undefined)
                    ?.productionReader?.decode === "ok",
              ),
              addedStorageFilesEveryRound: rounds.every(
                (r) => Array.isArray(r.addedStorageFiles) && r.addedStorageFiles.length >= 1,
              ),
              storageProjectionRecordObservedRounds: rounds.filter(
                (r) => Array.isArray(r.addedStorageFiles) && r.addedStorageFiles.length >= 1,
              ).length,
              seededStoreIntactEveryRound: rounds.every((r) => r.seededStoreIntact === true),
              rounds,
              honestNotes:
                "The REAL dsh CLI (operator image, seeded from the operator matchlock image " +
                "store) booted in fresh Matchlock VMs through the production dsh invocation " +
                "runner against the US-001 OPERATOR-SHAPED real-layout DSH_HOME (>=3 zstd " +
                "session dirs, storages projection records, the durable profile config) with " +
                "PLACEHOLDER credentials, so no real provider can be reached and no model " +
                "token is spent. The boot's real withFileLock sibling " +
                "(profiles/node_modules.lock) was observed inside the private per-run overlay " +
                "and never on the host; the HOST profiles/ tree is byte-identical across every " +
                "round and the inter-round native boot; no round carries the run-#35 " +
                "`ENOENT ... fsync` on the effective home or the run-#32 " +
                "`ENOENT ... profiles/node_modules.lock`. Because a dsh-MEDIATED launch probe " +
                "requires a provider, the contained gate runs the exact probe COMMAND " +
                "(`/workspace/runtime/bin/tamandua skill-path`, zero tokens) as its own round " +
                "and asserts it exits 0 with the guest skill PATH; the whole-path " +
                "run.harness_probe_ok assertion on real credentials belongs to " +
                "e2e-tests/matchlock-dsh-real-gate.test.ts (Gate E). Each REAL dsh boot round " +
                "persisted a first session record that the PRODUCTION reader " +
                "(discoverSessionArtifacts/readDshSessionArtifact) decodes from the host home, " +
                "proving the mapped sessions/ + storages/ store is reachable, writable and " +
                "fsync-able with no ENOENT.",
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        );

        // 7. Authoritative (throwing) exact-owned VM cleanup: a leftover fails
        //    the gate.
        const ledger = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds);
        assert.ok(ledger.length > 0, "cleanup ledger must be recorded");
        assert.equal(readVmIds(homeDir).length, 0, "no VM rows may remain after exact-owned cleanup");
        console.log(
          `[matchlock-dsh-real-boot-gate] OK — launch probe exited ${probeRec.exitCode} with the ` +
            `guest skill PATH; REAL dsh boot created the private overlay ` +
            `profiles/${DSH_GATE_BOOT_LOCK_BASENAME} in ${rounds.length} rounds with no host lock, ` +
            `no ENOENT fsync and a first session record on the host; ` +
            `VMs positively closed: ${observedVmIds.join(",")}`,
        );
      },
    );
  },
);
