/******************************************************************************
 * ⚠️  SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * DSH-PROFILE-OVERLAY US-005 — the contained native-boot / in-VM-round
 * regression gate for the private dsh profile-module overlay.
 *
 * Root cause (bead tamandua-6sy.33.10.34): the REAL dsh boot re-points
 * `$DSH_HOME/profiles/node_modules` at the RUNNING install's dependency
 * closure (`composeProfile` → `healProfilesModuleFallback`). Before the
 * overlay, Tamandua mounted the operator's whole DSH_HOME read-write into the
 * VM, so every guest boot flipped the host farm to guest paths, every native
 * boot flipped it back, and a request landing between two flips failed with
 * `REQUEST_EXTENSION: DeepSeek request extension preparation failed`.
 *
 * What this gate proves (all deterministic, ZERO model tokens — a synthetic
 * fixture dsh stands in for the real CLI so no provider/network call is ever
 * possible):
 *
 *  1. HOST farm snapshot: a synthetic DSH_HOME (built by
 *     `prepareComposedDshHome`, carrying the REAL headless profile layout) is
 *     seeded with MISMATCHED install links. The gate snapshots the whole
 *     install-derived farm tree, then runs a HOST-side ("native")
 *     zero-provider dsh boot (the fixture's deterministic stand-in for
 *     `healProfilesModuleFallback`) that rewrites the farm to host-install
 *     links, and snapshots the HEALED baseline.
 *  2. IN-VM round: the production dsh invocation runner boots a REAL fresh
 *     Matchlock VM with the COMPOSED DSH_HOME mapping (`configurationRoot` =
 *     the synthetic home). The composed plan maps every install-derived dir
 *     from the host-attested PRIVATE per-run overlay, so the guest's own farm
 *     maintenance lands there and the HOST farm snapshot stays BYTE-IDENTICAL.
 *  3. ALTERNATION: a second native boot then a second in-VM round (distinct
 *     fresh VM + distinct private overlay root) prove neither side's links
 *     change: the host snapshot is byte-identical after every round and the
 *     native boot is idempotent on the healed farm.
 *  4. FIRST REQUEST: inside the VM the fixture resolves the request-extension
 *     provider's module THROUGH the private overlay farm and reports
 *     `FIRST-REQUEST-RESOLVED:<plugin>`; the overlay observer captures the
 *     guest-install link it wrote, and the round records NO session/usage, so
 *     the mapped store gains zero model tokens.
 *  5. CLEANUP: every VM the gate owns is positively closed and removed (exact
 *     owned ids recorded in an evidence ledger). A failed/unknown `rm` throws
 *     — an inventory error is never certified as a clean list.
 *
 * CREDENTIALS: only the synthetic placeholder written by
 * `prepareComposedDshHome` is ever touched. The gate never reads, points at, or
 * mutates the operator's real `~/.dsh`, HOME or credentials.
 *
 * SCOPE: a contained single-run gate. It drives the production run-creation
 * admission (`admitMatchlockRun`) + production dsh invocation runner directly
 * — the exact seams the daemon/scheduler consume — under the paired gate's
 * isolation (private fresh HOME/STATE/DB under the evidence dir, resolved
 * runtime identity recorded as evidence, exact-owned VM cleanup ledger). No daemon is started
 * because one contained round needs no scheduler; the paired whole-path dsh
 * gate (`run-matchlock-dsh-gate-e2e-test`) already covers daemon dispatch.
 *
 * It is NOT part of any default fast lane. Run it on demand (under the shared
 * gate lock) with:
 *
 *   flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock \
 *     ./run-matchlock-dsh-profile-overlay-e2e-test
 *
 * which builds first, resolves the paired runtime binaries (unpinned), creates a NEW
 * evidence directory and runs this file with a private isolated
 * HOME/STATE/DB/TMPDIR rooted INSIDE that evidence directory.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cleanChildEnv } from "../tests/helpers/test-env.ts";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import { inheritedProcessEnv } from "./helpers/smoke-helpers.ts";
import {
  DSH_GATE_BOOT_LOCK_BASENAME,
  DSH_GATE_BOOT_LOCK_HOLD_MARKER,
  DSH_GATE_GUEST_INSTALL_ROOT,
  DSH_GATE_NATIVE_INSTALL_ROOT_ENV,
  DSH_GATE_FIRST_REQUEST_PLUGIN,
  DshOverlayObserver,
  guestFarmLinksAreGuestInstall,
  nativeDshBootPlan,
  parseFirstRequestOutput,
  prepareComposedDshHome,
  snapshotDshInstallDerivedFarms,
  snapshotDshProfilesInvariance,
} from "./helpers/matchlock-dsh-gate-fixtures.ts";
import {
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";
import type { ComposedDshHomeLayout } from "./helpers/matchlock-dsh-gate-fixtures.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// US-004: the in-VM prompt asks the synthetic boot to HOLD its real
// `withFileLock` sibling lock (`profiles/node_modules.lock`) for this bounded
// window, exactly as the real dsh holds it across the whole
// `healProfilesModuleFallback` module heal. 4s >> the 20ms observer interval,
// so the gate observes the transient lock deterministically.
const BOOT_LOCK_HOLD_MS = 4000;
const DSH_OVERLAY_OBSERVER_INTERVAL_MS = 20;
/** The durable profile config files prepareDshProfileOverlay stages privately. */
const DURABLE_PROFILE_CONFIG_FILES = [
  "package.json",
  "cordis.yml",
  "cordis.patch.yml",
  "pnpm-workspace.yaml",
] as const;

// ── environment: resolved (unpinned) paired runtime ────────────────────────────────────
// The runner script (run-matchlock-dsh-profile-overlay-e2e-test) resolves these (or leaves guest-init to
// matchlock) before launching this file; the test only requires any resolved
// paths to exist.
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

// Deterministic TEST-ONLY derived fixture image (never igorhvr/bedlam-ubuntu).
const FIXTURE_TAG = "tamandua-synthetic-dsh:gate-fixture";
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-dsh";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "dsh-fixture");
const FAKE_DSH_PATH = path.join(FIXTURE_DOCKER_DIR, "fake-dsh.mjs");

// Evidence root: the runner exports TAMANDUA_GATE_EVIDENCE_DIR (a NEW
// /root/matchlock-work/evidence/dsh-profile-overlay-<UTC-Z timestamp>/ dir).
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";

// Observed-rounds evidence label (TESTER-HONESTY item 3): the runner passes the
// same label to scripts/observed-rounds-guard.mjs.
const GATE_LABEL = "dsh-profile-overlay";

const GATE_TIMEOUT_MS = 90 * 60_000;
const ROUND_TIMEOUT_MS = 20 * 60_000;

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
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-dsh-profile-overlay-e2e-test)",
  );
  assert.ok(MATCHLOCK_RPC_BIN.length > 0, "TAMANDUA_MATCHLOCK_RPC_BIN must be set (the gate driver resolves matchlock from PATH)");
  // Guest-init/fused are OPTIONAL (MTLK-UNPIN): when unset, matchlock resolves
  // them itself and the gate records whatever it observes.
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    if (p.length > 0) {
      assert.ok(fs.existsSync(p), `resolved runtime binary missing: ${p}`);
    }
  }
  assert.ok(fs.existsSync(FAKE_DSH_PATH), `synthetic fixture dsh missing: ${FAKE_DSH_PATH}`);
}

/** Isolated child env: never the live worker daemon, never the operator HOME. */
function gateEnv(homeDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  const env: Record<string, string> = {
    ...inheritedProcessEnv(),
    HOME: homeDir,
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: path.join(tamanduaDir, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDir, "worktrees"),
    TMPDIR: path.join(EVIDENCE_DIR, "tmp"),
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_HARNESS_PROBE: "1",
    TAMANDUA_PI_BINARY: "/usr/bin/false",
    TAMANDUA_DSH_BINARY: "/usr/bin/false",
    ...matchlockRuntimeEnv(),
  };
  // The synthetic dsh home is passed explicitly; never inherit an ambient one.
  delete env.DSH_HOME;
  return { ...env, ...extra };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Prepare a fresh small git repo (matches the paired dsh gate's fixture). */
function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# dsh profile-overlay gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n.matchlock-synthetic-dsh/\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Dsh Profile Overlay Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

// ── docker → matchlock image plumbing ─────────────────────────────────────

function dockerBuild(dockerfile: string, tag: string): void {
  const b = spawnSync(
    "/usr/bin/docker",
    ["build", "-f", dockerfile, "-t", tag, "."],
    { cwd: FIXTURE_DOCKER_DIR, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024 },
  );
  assert.equal(
    b.status,
    0,
    `docker build ${dockerfile} failed (exit ${b.status}, signal ${b.signal}, error ${
      b.error ? b.error.message : "none"
    }):\n${(b.stdout || "").slice(-4000)}\n${(b.stderr || "").slice(-4000)}`,
  );
}

async function importImage(tag: string, homeDir: string): Promise<void> {
  const importEnv = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
  const save = spawn("/usr/bin/docker", ["save", tag], { stdio: ["ignore", "pipe", "pipe"] });
  const imp = spawn(MATCHLOCK_RPC_BIN, ["image", "import", tag], {
    stdio: ["pipe", "pipe", "pipe"],
    env: importEnv,
  });
  let saveErr = "";
  let impErr = "";
  save.stderr.on("data", (d) => (saveErr += d));
  imp.stderr.on("data", (d) => (impErr += d));
  save.stdout.pipe(imp.stdin);
  const saveCode = await new Promise<number | null>((res) => save.on("close", res));
  const impCode = await new Promise<number | null>((res) => imp.on("close", res));
  assert.equal(saveCode, 0, `docker save ${tag} failed: ${saveErr.slice(-2000)}`);
  assert.equal(impCode, 0, `matchlock image import ${tag} failed: ${impErr.slice(-2000)}`);
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

/** STRICT VM inventory: unreadable/corrupt state DB THROWS (never empty). */
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

/**
 * Positively dispose every VM this gate owns and APPEND the outcome ledger.
 * A failed exact-id `rm` that leaves a state dir THROWS (never a recursive
 * sweep that masks a teardown failure), and leftover rows at the end THROW.
 */
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
    `${new Date().toISOString()} VM ids observed during the gate (${observedIds.length}): ${observedIds.length > 0 ? observedIds.join(",") : "(none)"}`,
  );
  ledger.push(
    `${new Date().toISOString()} VM ids still present at cleanup (rows=${rowIds.length}, dirs=${dirIds.length}): ${target.length > 0 ? target.join(",") : "(none — runner positively closed every owned VM)"}`,
  );
  for (const id of target) {
    const stateDir = path.join(vmsDir, id);
    if (!rowIdSet.has(id) && !dirIdSet.has(id)) {
      ledger.push(`${new Date().toISOString()} vm ${id} already positively closed by the runner (no row and no state dir)`);
      continue;
    }
    const rm = spawnSync(MATCHLOCK_RPC_BIN, ["rm", id], { encoding: "utf-8", env: clean });
    ledger.push(`${new Date().toISOString()} vm ${id} rm rc=${rm.status} out=${(rm.stdout || rm.stderr || "").trim()}`);
    if (rm.status !== 0 && fs.existsSync(stateDir)) {
      ledger.push(`${new Date().toISOString()} vm ${id} STATE DIR STILL PRESENT after exact-id rm (rc=${rm.status})`);
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
let synthHome = "";
let synthLayout: ComposedDshHomeLayout | null = null;
let hostInstallRoot = "";
let wd = "";
let ledgerPath = "";
const observedVmIds: string[] = [];
const EVIDENCE_FILES: string[] = [];

function writeEvidence(name: string, content: string): string {
  const p = path.join(EVIDENCE_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  EVIDENCE_FILES.push(p);
  return p;
}

// ── dist (direct runner + admission + overlay geometry) ───────────────────

type DirectResult = Record<string, unknown>;

async function loadDirectRunner(): Promise<{ runDshInvocation: (o: DirectResult) => Promise<DirectResult> }> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/dsh-invocation-runner.js`);
  return { runDshInvocation: mod.runDshInvocation };
}

async function loadAdmission(): Promise<{
  admitMatchlockRun: (o: Record<string, unknown>) => Promise<{ policy: Record<string, unknown> }>;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/admission.js`);
  return { admitMatchlockRun: mod.admitMatchlockRun };
}

async function loadOverlayRoot(): Promise<(runId: string, liveStateRoot: string) => string> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/dsh-profile-overlay.js`);
  return mod.dshProfileOverlayRoot as (runId: string, liveStateRoot: string) => string;
}

async function loadHomeAlias(): Promise<(realHome: string) => string> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/home-alias.js`);
  return (rh: string) =>
    mod.resolveMatchlockHomeAlias({ realHome: rh, env: { ...inheritedProcessEnv(), HOME: rh } });
}

async function ensurePackHostPath(): Promise<string> {
  const sm = await import(`${repoRoot}/dist/installer/matchlock/scheduler-matchlock.js`);
  return sm.ensureGuestPackForState({ stateRoot: tamanduaDir });
}

/**
 * The production dsh invocation options for one DIRECT real-VM round. Mirrors
 * the paired dsh gate's direct plumbing: the exact production runner
 * composes the guest launch over the shared registry/broker/pack/progress
 * lifecycle and positively closes its owned VM.
 */
async function buildDirectOptions(
  label: string,
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
    timeoutMs: 150_000,
    createTimeoutMs: 240_000,
    readyTimeoutMs: 30_000,
    handshakeTimeoutMs: 90_000,
    serviceTimeoutMs: 180_000,
    closeTimeoutSeconds: 60,
    helperPackHostPath: await ensurePackHostPath(),
    rpcEnv: {
      HOME: await (await loadHomeAlias())(homeDir),
      ...matchlockRuntimeEnv(),
      TAMANDUA_STATE_DIR: tamanduaDir,
    },
  };
}

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

/** One DIRECT real-VM first-request round through the production dsh runner. */
async function directFirstRequestRound(opts: {
  label: string;
  policy: Record<string, unknown>;
  workdir: string;
  runId: string;
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
      opts.label,
      opts.policy,
      opts.workdir,
      // US-004: ask the synthetic boot to hold the real withFileLock sibling
      // lock for a bounded window so the on-host observer captures it.
      "SYNTHETIC-DSH-FIRST-REQUEST: resolve the request-extension provider module through the private profile farm (zero provider tokens) " +
        `${DSH_GATE_BOOT_LOCK_HOLD_MARKER}:${BOOT_LOCK_HOLD_MS}`,
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

// ── build the production dsh policy for the synthetic home ────────────────

async function admitDshPolicy(): Promise<Record<string, unknown>> {
  const { admitMatchlockRun } = await loadAdmission();
  const result = await admitMatchlockRun({
    requestedImage: FIXTURE_TAG,
    harness: "dsh",
    workspaceMode: "direct",
    workingDirectory: wd,
    // Frozen submission context — exactly what `workflow run --matchlock
    // --dsh-as-harness` captures: the submitting HOME, cwd and DSH_HOME.
    submission: { homeDir, cwd: wd, env: { DSH_HOME: synthHome } },
    rpcBinaryPath: MATCHLOCK_RPC_BIN,
    admission: { home: homeDir, liveStateRoot: tamanduaDir },
  });
  return result.policy;
}

// ── the gate ──────────────────────────────────────────────────────────────

describe(
  "matchlock dsh profile-overlay gate: native boot vs in-VM round over one synthetic DSH_HOME (zero models)",
  { concurrency: 1, timeout: GATE_TIMEOUT_MS },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      // Fresh private HOME rooted inside the evidence dir (never the live
      // worker daemon / live ~/.tamandua / operator ~/.dsh). The gate drives
      // the production runner in-process, so pin the process env BEFORE the
      // first lazy dist import.
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
      delete process.env.DSH_HOME;

      fs.mkdirSync(tamanduaDir, { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".cache"), { recursive: true });
      fs.mkdirSync(path.join(EVIDENCE_DIR, "tmp"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "agent", "settings.json"),
        JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
        "utf-8",
      );

      // Kernel cache for the fresh matchlock state (copy — never mutate the
      // operator's cache).
      const kernelSrc = "/root/.cache/matchlock/kernels";
      assert.ok(fs.existsSync(kernelSrc), `kernel cache source missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), { recursive: true });

      // Deterministic TEST-ONLY fixture image (contains the synthetic
      // zero-provider dsh). Build + import into the PRIVATE store; a store
      // that already resolves it (dev-speed reuse) skips the rebuild.
      const tagsResolvable = (tag: string): boolean => {
        try {
          resolveImage(tag, homeDir);
          return true;
        } catch {
          return false;
        }
      };
      const fixtureImageCache = process.env.TAMANDUA_GATE_FIXTURE_IMAGE_CACHE?.trim() || "";
      if (!tagsResolvable(FIXTURE_TAG)) {
        if (fixtureImageCache.length > 0) {
          // Hardlink a prior run's content-addressed blobs + copy its tiny
          // metadata DB (never duplicate payloads; resolved digests identical).
          const src = path.join(fixtureImageCache, "images");
          assert.ok(fs.existsSync(src), `TAMANDUA_GATE_FIXTURE_IMAGE_CACHE has no images dir: ${src}`);
          const dst = path.join(homeDir, ".cache", "matchlock", "images");
          fs.mkdirSync(dst, { recursive: true });
          const srcBlobs = path.join(src, "blobs");
          if (fs.existsSync(srcBlobs) && fs.readdirSync(srcBlobs).length > 0) {
            const linked = spawnSync("cp", ["-al", srcBlobs, path.join(dst, "blobs")], { encoding: "utf-8" });
            assert.equal(linked.status, 0, `hardlink cache blobs failed: ${linked.stderr}`);
          }
          for (const meta of ["metadata.db", "metadata.db-wal", "metadata.db-shm"]) {
            const from = path.join(src, meta);
            if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, meta));
          }
          const localSrc = path.join(src, "local");
          if (fs.existsSync(localSrc)) fs.cpSync(localSrc, path.join(dst, "local"), { recursive: true });
        } else {
          dockerBuild(FIXTURE_DOCKERFILE, FIXTURE_TAG);
          await importImage(FIXTURE_TAG, homeDir);
        }
      }
      const identity = resolveImage(FIXTURE_TAG, homeDir);

      // Synthetic DSH_HOME with the REAL headless profile layout + mismatched
      // install-derived farm (never the operator's real DSH_HOME).
      synthHome = path.join(EVIDENCE_DIR, "synth-dsh");
      synthLayout = prepareComposedDshHome(synthHome);
      assert.ok(
        fs.realpathSync(synthHome).startsWith(fs.realpathSync(EVIDENCE_DIR) + path.sep),
        "synthetic DSH_HOME must live inside the gate evidence dir (never the operator home)",
      );

      wd = prepareFixtureRepo(path.join(EVIDENCE_DIR, "fixtures", "wd-overlay"));
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");

      writeEvidence(
        "fixture-image.json",
        JSON.stringify({ tag: FIXTURE_TAG, digest: identity.digest, configDigest: identity.config_digest }, null, 2),
      );
    });

    after(async () => {
      // Best-effort secondary sweep; the test body owns the authoritative
      // (throwing) cleanup so a leftover VM fails the gate.
      if (homeDir) {
        try {
          cleanupOwnedVms(homeDir, ledgerPath, observedVmIds);
        } catch {
          /* body already asserted */
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
      "alternating native boot and in-VM round never flips the host farm and the in-VM first request resolves through the private farm",
      { timeout: GATE_TIMEOUT_MS },
      async () => {
        assert.ok(synthLayout, "before() must initialize the synthetic home layout");
        const layout = synthLayout;

        // 1. Initial (mismatched) host farm snapshot.
        const initialFarm = snapshotDshInstallDerivedFarms(synthHome, layout.installDerivedDirs);
        assert.ok(
          Object.values(initialFarm).some((t) => t.startsWith("/opt/dsh/")),
          `fixture must seed the mismatched /opt/dsh link before the native boot: ${JSON.stringify(initialFarm)}`,
        );

        // 2. NATIVE zero-provider dsh boot (host side): heals the host farm.
        const nativeHome = path.join(EVIDENCE_DIR, "native-home");
        fs.mkdirSync(nativeHome, { recursive: true });
        const plan = nativeDshBootPlan({
          nodePath: process.execPath,
          fakeDshPath: FAKE_DSH_PATH,
          homeDir: nativeHome,
          dshHome: synthHome,
          hostInstallRoot,
        });
        const boot1 = spawnSync(plan.command, plan.args, {
          encoding: "utf-8",
          timeout: plan.timeoutMs,
          env: plan.env,
          maxBuffer: 16 * 1024 * 1024,
        });
        assert.equal(
          boot1.status,
          0,
          `native dsh boot must heal the host farm successfully (exit ${boot1.status}):\n${(boot1.stdout || "").slice(-2000)}\n${(boot1.stderr || "").slice(-2000)}`,
        );
        assert.match(boot1.stdout || "", /^NATIVE-HEAL: links=\d+ /m, "native boot must report its deterministic heal");

        // The heal CHANGED the farm (the mismatched links were retargeted).
        const healedFarm = snapshotDshInstallDerivedFarms(synthHome, layout.installDerivedDirs);
        assert.notDeepEqual(
          healedFarm,
          initialFarm,
          "the native boot must heal the synthetic host farm (fixture links retargeted)",
        );
        // Every healed link points at the host-side install root — NOT a guest path.
        for (const [rel, target] of Object.entries(healedFarm)) {
          assert.ok(
            target === hostInstallRoot || target.startsWith(hostInstallRoot + path.sep),
            `healed host farm link ${rel} -> ${target} must point at the host install root`,
          );
        }
        assert.ok(
          Object.keys(healedFarm).length >= 4,
          `healed farm must carry the fixture closure: ${JSON.stringify(healedFarm)}`,
        );
        writeEvidence(
          "native-heal.json",
          JSON.stringify({ plan: { args: plan.args, timeoutMs: plan.timeoutMs, env: { ...plan.env, HOME: "(isolated)" } }, stdout: boot1.stdout, stderr: boot1.stderr, initialFarm, healedFarm }, null, 2),
        );

        // 3. Production admission for the synthetic home (no daemon needed:
        //    this is the exact run-creation seam the scheduler consumes).
        const policy = await admitDshPolicy();
        assert.equal(policy.harness, "dsh", "admitted policy must be harness dsh");
        assert.equal(policy.guestConfigurationRoot, "/workspace/config/dsh", "guest DSH_HOME override must be unchanged");
        assert.equal(
          (policy.workMounts as Array<Record<string, string>>)[0].guestPath,
          wd,
          "work mount must keep the exact host/guest spelling",
        );
        const baselineFarm = snapshotDshInstallDerivedFarms(synthHome, layout.installDerivedDirs);
        assert.deepEqual(baselineFarm, healedFarm, "the healed baseline must be stable before any round");
        // US-004: the WHOLE host profiles/ tree (regular files + links + the
        // boot-sibling lock/marker) is the byte-invariance baseline every in-VM
        // round must leave untouched. The host must never carry a lock.
        const baselineProfiles = snapshotDshProfilesInvariance(synthHome);
        assert.equal(baselineProfiles.lockPresent, false, "no HOST profiles/node_modules.lock may exist before any round");
        assert.equal(baselineProfiles.bootMarkerPresent, false, "no HOST boot sibling marker may exist before any round");
        for (const file of DURABLE_PROFILE_CONFIG_FILES) {
          assert.ok(
            fs.existsSync(path.join(synthHome, "profiles", layout.profile, file)),
            `the synthetic host home must carry the durable profile config ${file}`,
          );
        }

        const overlayRootForRun = await loadOverlayRoot();
        const sessionsBefore = fs.existsSync(path.join(synthHome, "sessions"))
          ? fs.readdirSync(path.join(synthHome, "sessions"))
          : [];

        const rounds: Array<Record<string, unknown>> = [];
        for (let round = 1; round <= 2; round += 1) {
          // 4. IN-VM first-request round through the production dsh runner.
          const runId = randomUUID();
          const overlayRoot = overlayRootForRun(runId, tamanduaDir);
          assert.ok(
            overlayRoot.startsWith(tamanduaDir + path.sep),
            `private overlay root must live under the attested live state: ${overlayRoot}`,
          );
          const observer = new DshOverlayObserver(overlayRoot, {
            intervalMs: DSH_OVERLAY_OBSERVER_INTERVAL_MS,
          }).start();
          const rec = await directFirstRequestRound({
            label: `first-request-round-${round}`,
            policy,
            workdir: wd,
            runId,
          });
          const observed = observer.stop();
          const afterFarm = snapshotDshInstallDerivedFarms(synthHome, layout.installDerivedDirs);
          const afterProfiles = snapshotDshProfilesInvariance(synthHome);

          // Host farm byte-identical: the guest's farm maintenance landed in
          // the PRIVATE overlay, never in the shared host farm.
          assert.deepEqual(
            afterFarm,
            baselineFarm,
            `round ${round}: the HOST profile-module farm must stay byte-identical (no flip)`,
          );
          // US-004: the WHOLE host profiles/ tree is byte-identical too, and the
          // guest's real boot writer lock never leaked to the host.
          assert.deepEqual(
            afterProfiles,
            baselineProfiles,
            `round ${round}: the HOST profiles/ tree must stay byte-identical (files, links, no lock)`,
          );
          assert.equal(
            afterProfiles.lockPresent,
            false,
            `round ${round}: the guest's profiles/${DSH_GATE_BOOT_LOCK_BASENAME} must never appear on the HOST`,
          );
          assert.equal(
            fs.existsSync(path.join(synthHome, "profiles", DSH_GATE_BOOT_LOCK_BASENAME)),
            false,
            `round ${round}: no HOST profiles/${DSH_GATE_BOOT_LOCK_BASENAME} exists`,
          );

          // The round succeeded with zero model tokens: the fixture resolved
          // the first request through the private farm and recorded no session.
          assert.ok(rec.ok, `round ${round}: direct invocation rejected: ${rec.error}`);
          assert.equal(rec.exitCode, 0, `round ${round}: fixture must exit 0 (stdout=${rec.stdout.slice(0, 600)})`);
          assert.equal(rec.cleanupConfirmed, true, `round ${round}: owned VM must be positively closed+removed`);
          assert.ok(rec.vmId !== null, `round ${round}: a fresh VM must have been owned`);
          const outcome = parseFirstRequestOutput(rec.stdout);
          assert.equal(
            outcome.requestExtensionFailure,
            false,
            `round ${round}: no request-extension failure may occur: ${rec.stdout.slice(0, 800)}`,
          );
          assert.equal(
            outcome.resolved,
            true,
            `round ${round}: the in-VM first request must resolve through the private farm: ${rec.stdout.slice(0, 800)}`,
          );
          assert.equal(outcome.plugin, DSH_GATE_FIRST_REQUEST_PLUGIN, `round ${round}: resolved plugin mismatch`);

          // The guest PRIVATE farm carried GUEST-install links only.
          assert.equal(observed.rootSeen, true, `round ${round}: the private overlay root must be observed while live`);
          assert.ok(
            guestFarmLinksAreGuestInstall(observed.links),
            `round ${round}: guest private farm links must be guest-install links: ${JSON.stringify(observed.links)}`,
          );
          const pluginKey = Object.keys(observed.links).find((k) => k.endsWith(DSH_GATE_FIRST_REQUEST_PLUGIN));
          assert.ok(pluginKey, `round ${round}: the first-request plugin link must be observed: ${JSON.stringify(observed.links)}`);
          assert.ok(
            String(observed.links[pluginKey]).startsWith(DSH_GATE_GUEST_INSTALL_ROOT + path.sep),
            `round ${round}: plugin link ${pluginKey} -> ${observed.links[pluginKey]} must point at the guest install root`,
          );

          // US-004: the guest's REAL boot-sibling writer lock
          // (`profiles/node_modules.lock`, created `wx` + 0o600 by
          // withFileLock) landed in the PRIVATE overlay and was observed there
          // while the guest held it. This is the exact artifact whose missing
          // parent killed vaimetal run #32. The lock is the SIBLING
          // `<profiles>/node_modules.lock` (`DSH_GATE_BOOT_LOCK_BASENAME`),
          // never a child of the mounted `node_modules` destination.
          const privateLockRel = path.join("profiles", DSH_GATE_BOOT_LOCK_BASENAME);
          const privateLockChildRel = path.join(
            "profiles",
            "node_modules",
            DSH_GATE_BOOT_LOCK_BASENAME,
          );
          assert.equal(
            path.dirname(privateLockRel),
            "profiles",
            "the boot lock must be a sibling of the farm dir",
          );
          assert.ok(
            observed.files.includes(privateLockRel),
            `round ${round}: the private overlay must have carried ${privateLockRel} while the guest held the boot lock (files=${JSON.stringify(observed.files)})`,
          );
          assert.ok(
            !observed.files.includes(privateLockChildRel),
            `round ${round}: the boot lock must never be observed inside the node_modules destination (${privateLockChildRel})`,
          );
          assert.ok(
            observed.files.includes(path.join("profiles", "node_modules.synthetic-boot-marker")),
            `round ${round}: the private overlay must have carried the boot sibling marker (files=${JSON.stringify(observed.files)})`,
          );

          // US-004: the private overlay carries a REAL profiles/ directory with
          // the copied DURABLE profile config files (a private copy-on-write
          // tree, not a per-child mount).
          assert.ok(
            observed.dirs.includes("profiles"),
            `round ${round}: the private overlay must carry a real profiles/ dir (dirs=${JSON.stringify(observed.dirs)})`,
          );
          assert.ok(
            observed.dirs.includes(path.join("profiles", layout.profile)),
            `round ${round}: the private profiles/ must carry the ${layout.profile} profile dir (dirs=${JSON.stringify(observed.dirs)})`,
          );
          for (const file of DURABLE_PROFILE_CONFIG_FILES) {
            const rel = path.join("profiles", layout.profile, file);
            assert.ok(
              observed.files.includes(rel),
              `round ${round}: the private profiles/ must carry the copied durable config ${rel} (files=${JSON.stringify(observed.files)})`,
            );
          }
          writeEvidence(
            `private-boot-lock-${round}.json`,
            JSON.stringify(
              {
                round,
                runId,
                overlayRoot,
                privateBootLock: {
                  rel: privateLockRel,
                  observed: observed.files.includes(privateLockRel),
                  holdMs: BOOT_LOCK_HOLD_MS,
                },
                privateProfilesDirObserved: observed.dirs.includes("profiles"),
                durableProfileConfigObserved: DURABLE_PROFILE_CONFIG_FILES.map((f) =>
                  observed.files.includes(path.join("profiles", layout.profile, f)),
                ),
                observedFiles: observed.files,
                observedDirs: observed.dirs,
                hostProfilesLockPresentAfterRound: afterProfiles.lockPresent,
                timestamp: new Date().toISOString(),
              },
              null,
              2,
            ),
          );

          // The private overlay root is removed after the confirmed close.
          assert.equal(
            fs.existsSync(overlayRoot),
            false,
            `round ${round}: the private overlay root must be removed after the confirmed close`,
          );

          // ZERO MODEL TOKENS: no session (and therefore no usage) was written.
          const sessionsAfter = fs.existsSync(path.join(synthHome, "sessions"))
            ? fs.readdirSync(path.join(synthHome, "sessions"))
            : [];
          assert.deepEqual(
            sessionsAfter,
            sessionsBefore,
            `round ${round}: the in-VM first-request round must record NO session (zero model tokens)`,
          );

          rounds.push({
            round,
            runId,
            overlayRoot,
            vmId: rec.vmId,
            exitCode: rec.exitCode,
            cleanupConfirmed: rec.cleanupConfirmed,
            stdout: rec.stdout,
            stderrTail: rec.stderrTail.slice(-2000),
            firstRequest: outcome,
            guestPrivateFarm: {
              rootSeen: observed.rootSeen,
              links: observed.links,
              dirs: observed.dirs,
              files: observed.files,
              ticks: observed.ticks,
            },
            privateBootLock: {
              rel: privateLockRel,
              observed: observed.files.includes(privateLockRel),
            },
            hostFarmBefore: baselineFarm,
            hostFarmAfter: afterFarm,
            hostFarmByteIdentical: JSON.stringify(baselineFarm) === JSON.stringify(afterFarm),
            hostProfilesBefore: baselineProfiles,
            hostProfilesAfter: afterProfiles,
            hostProfilesByteIdentical: JSON.stringify(baselineProfiles) === JSON.stringify(afterProfiles),
          });

          // 5. ALTERNATION: a native boot between rounds must be a no-op on the
          //    healed farm (the in-VM round did not perturb it, so the next
          //    heal finds it current).
          const boot = spawnSync(plan.command, plan.args, {
            encoding: "utf-8",
            timeout: plan.timeoutMs,
            env: plan.env,
            maxBuffer: 16 * 1024 * 1024,
          });
          assert.equal(boot.status, 0, `inter-round native boot must succeed (exit ${boot.status})`);
          const afterBoot = snapshotDshInstallDerivedFarms(synthHome, layout.installDerivedDirs);
          assert.deepEqual(
            afterBoot,
            baselineFarm,
            `inter-round native boot must not change the healed host farm (round ${round})`,
          );
        }

        // 6. Both rounds owned DISTINCT fresh VMs, all positively closed.
        const vms = rounds.map((r) => r.vmId);
        assert.equal(observedVmIds.length >= 2, true, `expected >=2 owned VMs, saw ${JSON.stringify(observedVmIds)}`);
        assert.notEqual(vms[0], vms[1], "each round must boot its own distinct fresh VM");

        writeEvidence(
          "dsh-profile-overlay-gate.json",
          JSON.stringify(
            {
              gate: "matchlock-dsh-profile-overlay-gate",
              contract: "DSH-PROFILE-OVERLAY",
              image: FIXTURE_TAG,
              syntheticHome: synthHome,
              hostInstallRoot,
              installDerivedDirs: layout.installDerivedDirs,
              initialFarm,
              healedFarm,
              baselineFarm,
              baselineProfiles,
              hostFarmByteIdenticalAcrossEveryRound: rounds.every((r) => r.hostFarmByteIdentical === true),
              hostProfilesByteIdenticalAcrossEveryRound: rounds.every((r) => r.hostProfilesByteIdentical === true),
              hostProfilesLockPresentAcrossEveryRound: rounds.some(
                (r) => (r.hostProfilesAfter as { lockPresent?: boolean } | undefined)?.lockPresent === true,
              ),
              privateBootLockObservedEveryRound: rounds.every(
                (r) => (r.privateBootLock as { observed?: boolean } | undefined)?.observed === true,
              ),
              privateBootLockRelPath: path.join("profiles", DSH_GATE_BOOT_LOCK_BASENAME),
              bootLockHoldMs: BOOT_LOCK_HOLD_MS,
              durableProfileConfigFiles: [...DURABLE_PROFILE_CONFIG_FILES],
              zeroModelTokens: true,
              rounds,
              honestNotes:
                "The native boot is the deterministic zero-provider fixture (fake-dsh.mjs), the deterministic stand-in for the real healProfilesModuleFallback; it rewrites ONLY the synthetic host farm. The in-VM round is the production dsh invocation runner on a fresh Matchlock VM whose composed DSH_HOME maps every install-derived dir from the host-attested private per-run overlay. The in-VM prompt asks the fixture to HOLD its real withFileLock sibling lock (profiles/node_modules.lock) for 4s, mirroring the real dsh heal duration, so the 20ms observer captures it in the private overlay. No provider credentials and no model call are used anywhere, so the round spends zero model tokens. The HOST profiles/ tree (files, links, no lock) is byte-identical across every round. Only synthetic fixture credentials exist.",
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        );

        // 7. Authoritative (throwing) VM cleanup: a leftover fails the gate.
        const ledger = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds);
        assert.ok(ledger.length > 0, "cleanup ledger must be recorded");
        console.log(
          `[dsh-profile-overlay-gate] OK — host farm + host profiles/ tree byte-identical across ${rounds.length} in-VM rounds; ` +
            `private profiles/node_modules.lock observed in every private overlay; ` +
            `VMs positively closed: ${observedVmIds.join(",")}`,
        );
      },
    );
  },
);
