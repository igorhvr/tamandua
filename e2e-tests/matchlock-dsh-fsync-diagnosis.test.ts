/******************************************************************************
 * ⚠️  SLOW REAL-VM DIAGNOSIS GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * DSH-OVERLAY-FSYNC-FIX US-002 — obtain the EXACT path/fd the in-VM dsh boot's
 * failing `fsync` targets (bead tamandua-6sy.33.10.34, third round).
 *
 * vaimetal run #35 (do-now, dsh, --matchlock igorhvr/bedlam-ubuntu, REAL
 * operator DSH_HOME, build 3dfc6c29) failed its launch-time probe after ~9.2 s
 * with `dsh: ENOENT: no such file or directory, fsync` and no in-VM session
 * record reached the host store. The retained vm.log showed exactly FOUR guest
 * FUSE mounts (`/workspace/runtime`, `/workspace/config/dsh`, the repo and
 * `/workspace/runs/<id>`) — one mount at the whole dsh config root with NO
 * separate `/workspace/config/dsh/profiles` entry.
 *
 * This gate reproduces that boot in a fresh VM against the US-001 REAL-LAYOUT
 * home (many `sessions/<projectKey>/`, `storages/session_projcache/sessions/`
 * JSON, the durable `profiles/` config farm) with PLACEHOLDER credentials, and
 * makes the guest's `dsh` a wrapper that:
 *   - dumps the OBSERVED guest mount table (`/proc/mounts`);
 *   - runs the REAL dsh under
 *     `strace -f -y -e trace=fsync,fdatasync,openat,... -e status=failed`;
 *   - emits the trace + mount table back through the round output.
 *
 * It then reconciles the observed guest mounts with the per-durable-entry
 * destinations `planDshHomeMounts` emits and writes the diagnosis as JSON to
 * the retained external path (default
 * `/home/kaladin/matchlock-work/dsh-fsync-diagnosis.json`, env-overridable;
 * never committed).
 *
 * Deliberately NOT part of npm test / run-all-e2e-tests. Run it on demand
 * UNDER THE SHARED GATE LOCK:
 *
 *   flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock \
 *     ./run-matchlock-dsh-fsync-diagnosis-e2e-test
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cleanChildEnv } from "../tests/helpers/test-env.ts";
import { inheritedProcessEnv } from "./helpers/smoke-helpers.ts";
import {
  DSH_GATE_PLACEHOLDER_CREDENTIALS,
  DSH_GATE_REAL_DSH_HOME_ENV,
  stageRealLayoutDshHome,
} from "./helpers/matchlock-dsh-gate-fixtures.ts";
import type { RealLayoutDshHomeLayout } from "./helpers/matchlock-dsh-gate-fixtures.ts";
import {
  buildDshFsyncNodeShimScript,
  buildDshStraceWrapperScript,
  extractMarkerValue,
  mountsUnderRoot,
  parseDshFsyncTrace,
  parseGuestMountTable,
  reconcileObservedMountsWithPlan,
  DSH_FSYNC_DIAG_ERRNO,
  DSH_FSYNC_DIAG_SHIM_BASENAME,
  DSH_FSYNC_DIAG_TRACE_METHOD_MARKER,
} from "./helpers/matchlock-dsh-fsync-trace.ts";
import {
  assertNoOwnedVms,
  cleanupOwnedVms,
  readRunnerVmEvidenceIds,
} from "./helpers/matchlock-gate-lifecycle.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── environment: caller-provided runtime + operator sources ───────────────
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

const OPERATOR_TAG = "igorhvr/bedlam-ubuntu";

const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";
const OPERATOR_CACHE = process.env.TAMANDUA_GATE_OPERATOR_CACHE ?? "";
const REAL_DSH_HOME = process.env[DSH_GATE_REAL_DSH_HOME_ENV] ?? "";
const DIAGNOSIS_JSON =
  process.env.TAMANDUA_GATE_FSYNC_DIAGNOSIS_JSON ??
  "/home/kaladin/matchlock-work/dsh-fsync-diagnosis.json";

const ROUND_TIMEOUT_MS = 8 * 60_000;

function assertEnv(): void {
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-dsh-fsync-diagnosis-e2e-test)",
  );
  assert.ok(MATCHLOCK_RPC_BIN.length > 0, "TAMANDUA_MATCHLOCK_RPC_BIN must be set");
  assert.ok(GUEST_INIT.length > 0, "MATCHLOCK_GUEST_INIT must be set");
  assert.ok(GUEST_FUSED.length > 0, "MATCHLOCK_GUEST_FUSED must be set");
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    assert.ok(fs.existsSync(p), `paired runtime binary missing: ${p}`);
  }
  assert.ok(
    OPERATOR_CACHE.length > 0,
    `TAMANDUA_GATE_OPERATOR_CACHE (the operator ~/.cache/matchlock store carrying the real ${OPERATOR_TAG} image) must be set`,
  );
  assert.ok(
    fs.existsSync(path.join(OPERATOR_CACHE, "images", "metadata.db")),
    `operator matchlock image store missing under ${OPERATOR_CACHE}`,
  );
  assert.ok(
    REAL_DSH_HOME.length > 0,
    `${DSH_GATE_REAL_DSH_HOME_ENV} (the operator's real dsh home carrying the real profile layout) must be set`,
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

function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# dsh fsync diagnosis gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Dsh Fsync Diagnosis Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

// ── operator matchlock image-store seeding (hardlink + copy metadata) ─────
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

// ── shared state ──────────────────────────────────────────────────────────
let homeDir = "";
let tamanduaDir = "";
let dshHome = "";
let stagedLayout: RealLayoutDshHomeLayout | null = null;
let wd = "";
let ledgerPath = "";
let tracingPackPath = "";
let imageIdentity: { digest: string; config_digest: string } | null = null;
const observedVmIds: string[] = [];

function writeEvidence(name: string, content: string): string {
  const p = path.join(EVIDENCE_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

// ── dist (production runner + admission + mount planner) ──────────────────
interface DirectRecord {
  label: string;
  ok: boolean;
  error?: string;
  vmId: string | null;
  vmRemoved?: boolean;
  vmLogsCopiedTo?: string | null;
  cleanupConfirmed?: boolean;
  exitCode: number | null;
  timedOut?: boolean;
  output: string;
  stderrTail: string;
  durationMs?: number;
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
  planDshHomeMounts: (
    hostHome: string,
    overlayRoot: string,
    guestRoot: string,
  ) => Record<string, unknown>;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/dsh-profile-overlay.js`);
  return {
    prepare: (runId, liveStateRoot, hostHome) =>
      mod.prepareDshProfileOverlay(runId, liveStateRoot, hostHome) as { overlayRoot: string },
    root: (runId, liveStateRoot) => mod.dshProfileOverlayRoot(runId, liveStateRoot) as string,
    cleanup: (runId, liveStateRoot) => mod.cleanupDshProfileOverlay(runId, liveStateRoot) as void,
    planDshHomeMounts: (hostHome, overlayRoot, guestRoot) =>
      mod.planDshHomeMounts(hostHome, overlayRoot, guestRoot) as Record<string, unknown>,
  };
}

async function resolveControlHomeAlias(realHome: string): Promise<string> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/home-alias.js`);
  return mod.resolveMatchlockHomeAlias({
    realHome,
    env: { ...inheritedProcessEnv(), HOME: realHome },
  });
}

/**
 * Build a fresh gate-owned copy of the versioned RO helper pack with a `dsh`
 * wrapper at `bin/dsh` that shadows the image dsh on the prepended guest PATH.
 * The pack path stays under `<live>/matchlock/guest-packs/` so the mount-plan
 * managed-pack rule accepts it; the base pack itself is never mutated.
 */
async function buildTracingPack(stateRoot: string): Promise<string> {
  const sm = await import(`${repoRoot}/dist/installer/matchlock/scheduler-matchlock.js`);
  const base = (await sm.ensureGuestPackForState({ stateRoot })) as string;
  const parent = path.dirname(base);
  const packPath = path.join(
    parent,
    `${path.basename(base)}-fsync-diag-${randomUUID().slice(0, 8)}`,
  );
  fs.cpSync(base, packPath, { recursive: true });
  const wrapperPath = path.join(packPath, "bin", "dsh");
  fs.writeFileSync(wrapperPath, buildDshStraceWrapperScript(), { mode: 0o755 });
  assert.ok(fs.existsSync(wrapperPath), "tracing wrapper must exist");
  const shimPath = path.join(packPath, "bin", DSH_FSYNC_DIAG_SHIM_BASENAME);
  fs.writeFileSync(shimPath, buildDshFsyncNodeShimScript(), { mode: 0o644 });
  assert.ok(
    fs.existsSync(shimPath),
    "node fsync interposer must exist for the ptrace-denied fallback",
  );
  return packPath;
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
    helperPackHostPath: tracingPackPath,
    rpcEnv: {
      HOME: await resolveControlHomeAlias(homeDir),
      TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN,
      MATCHLOCK_GUEST_INIT: GUEST_INIT,
      MATCHLOCK_GUEST_FUSED: GUEST_FUSED,
      TAMANDUA_STATE_DIR: tamanduaDir,
    },
  };
}

/** One traced REAL-dsh boot round through the production dsh invocation runner. */
async function tracedDshBootRound(opts: {
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
    exitCode: null,
    output: "",
    stderrTail: "",
  };
  try {
    const options = await buildDirectOptions(
      opts.policy,
      opts.workdir,
      "FSYNC-DIAGNOSIS: boot dsh and read the task from argv. This round uses " +
        "PLACEHOLDER gate credentials and must never reach a real provider.",
      opts.runId,
    );
    const result = await runner.runDshInvocation(options);
    record.ok = true;
    record.vmId = (result.vmId as string | null) ?? null;
    record.vmRemoved = result.vmRemoved as boolean | undefined;
    record.vmLogsCopiedTo = (result.vmLogsCopiedTo as string | null) ?? null;
    record.cleanupConfirmed = result.cleanupConfirmed as boolean | undefined;
    record.exitCode = (result.exitCode as number | null) ?? null;
    record.timedOut = result.timedOut as boolean | undefined;
    record.durationMs = result.durationMs as number | undefined;
    record.output = String(result.output ?? "");
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

/** Read the retained VM console log lines that name the mount table. */
function readMatchlockMountLines(vmLogsCopiedTo: string | null): {
  exactMountsLine: string | null;
  fuseMountLines: string[];
  vmLogPath: string | null;
} {
  if (!vmLogsCopiedTo) return { exactMountsLine: null, fuseMountLines: [], vmLogPath: null };
  const candidates: string[] = [];
  const logsDir = path.join(vmLogsCopiedTo, "logs");
  for (const dir of [logsDir, vmLogsCopiedTo]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".log")) candidates.push(path.join(dir, name));
    }
  }
  let vmLogPath: string | null = null;
  let exactMountsLine: string | null = null;
  const fuseMountLines: string[] = [];
  for (const p of candidates) {
    const text = fs.readFileSync(p, "utf-8");
    for (const line of text.split(/\r?\n/)) {
      if (line.includes("matchlock.exact.mounts=") && exactMountsLine === null) {
        exactMountsLine = line.trim();
        vmLogPath = p;
      }
      if (line.includes("Guest FUSE daemon") || line.includes("FUSE filesystem mounted at")) {
        fuseMountLines.push(line.trim());
      }
    }
  }
  return { exactMountsLine, fuseMountLines, vmLogPath };
}

// ── the gate ──────────────────────────────────────────────────────────────

describe(
  "matchlock dsh fsync diagnosis: strace the REAL dsh boot on the real-layout home",
  { concurrency: 1, timeout: 60 * 60_000 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      homeDir = path.join(EVIDENCE_DIR, "home");
      tamanduaDir = path.join(homeDir, ".tamandua");
      process.env.HOME = homeDir;
      process.env.TAMANDUA_STATE_DIR = tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
      process.env.TAMANDUA_WORKTREE_ROOT = path.join(tamanduaDir, "worktrees");
      process.env.TAMANDUA_MATCHLOCK_RPC_BIN = MATCHLOCK_RPC_BIN;
      process.env.MATCHLOCK_GUEST_INIT = GUEST_INIT;
      process.env.MATCHLOCK_GUEST_FUSED = GUEST_FUSED;
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

      const kernelSrc = path.join(OPERATOR_CACHE, "kernels");
      assert.ok(fs.existsSync(kernelSrc), `operator kernel cache missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), {
        recursive: true,
      });

      seedOperatorImageStore(OPERATOR_CACHE, homeDir);
      imageIdentity = resolveImage(OPERATOR_TAG, homeDir);
      console.log(
        `[matchlock-dsh-fsync-diagnosis] image ${OPERATOR_TAG} digest=${imageIdentity.digest} ` +
          `config=${imageIdentity.config_digest}`,
      );

      dshHome = path.join(EVIDENCE_DIR, "dsh-home");
      stagedLayout = stageRealLayoutDshHome({
        sourceHome: REAL_DSH_HOME,
        destinationHome: dshHome,
      });
      assert.ok(
        fs.realpathSync(dshHome).startsWith(fs.realpathSync(EVIDENCE_DIR) + path.sep),
        "gate-owned DSH_HOME must live inside the evidence dir (never the operator home)",
      );
      assert.equal(
        fs.readFileSync(path.join(dshHome, ".credentials.yaml"), "utf-8"),
        DSH_GATE_PLACEHOLDER_CREDENTIALS,
        "the gate-owned home must carry placeholder credentials only",
      );

      wd = prepareFixtureRepo(path.join(EVIDENCE_DIR, "fixtures", "wd-fsync-diagnosis"));
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");
      tracingPackPath = await buildTracingPack(tamanduaDir);

      writeEvidence(
        "dsh-fsync-diagnosis-image.json",
        JSON.stringify(
          {
            image: OPERATOR_TAG,
            digest: imageIdentity.digest,
            configDigest: imageIdentity.config_digest,
            sourceDshHome: REAL_DSH_HOME,
            gateDshHome: dshHome,
            tracingPackPath,
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
          cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
        } catch {
          /* the test body owns the authoritative (throwing) cleanup */
        }
      }
    });

    it(
      "traces the REAL dsh boot, recovers the failing fsync target, and reconciles the guest mount table",
      { timeout: 60 * 60_000 },
      async () => {
        assert.ok(stagedLayout, "before() must stage the gate-owned real-layout DSH_HOME");
        const layout = stagedLayout;

        // 1. The composed plan the CURRENT build emits, for reconciliation.
        const overlayHelpers = await loadOverlayHelpers();
        const planRunId = randomUUID();
        const planOverlay = overlayHelpers.prepare(planRunId, tamanduaDir, dshHome).overlayRoot;
        const plan = overlayHelpers.planDshHomeMounts(
          dshHome,
          planOverlay,
          "/workspace/config/dsh",
        );
        const plannedDestinations = Object.keys(plan).sort();
        overlayHelpers.cleanup(planRunId, tamanduaDir);
        assert.ok(
          plannedDestinations.length >= 1,
          `the composed plan must name at least the effective-home root destination: ${JSON.stringify(plannedDestinations)}`,
        );

        // 2. One traced REAL-dsh boot round through the production runner.
        const policy = await admitDshPolicy();
        assert.equal(policy.harness, "dsh", "admitted policy must be harness dsh");
        assert.equal(
          fs.realpathSync(String(policy.configurationRoot)),
          fs.realpathSync(dshHome),
          "the admitted config root must be the gate-owned home",
        );
        assert.equal(policy.guestConfigurationRoot, "/workspace/config/dsh");

        const runId = randomUUID();
        const rec = await tracedDshBootRound({
          label: "dsh-fsync-diagnosis-round-1",
          policy,
          workdir: wd,
          runId,
        });

        assert.ok(rec.ok, `the traced round must reach the runner: ${rec.error}`);
        assert.ok(rec.vmId !== null, "a fresh VM must have been owned");
        assert.equal(
          rec.cleanupConfirmed,
          true,
          `the owned VM must be positively closed (cleanup=${rec.cleanupConfirmed}, timedOut=${rec.timedOut})`,
        );

        const combined = `${rec.output}\n${rec.stderrTail}`;
        const traceMethod =
          extractMarkerValue(combined, DSH_FSYNC_DIAG_TRACE_METHOD_MARKER) ?? "unknown";
        const finding = parseDshFsyncTrace(combined);
        const mountEntries = parseGuestMountTable(combined);
        const observedUnderRoot = mountsUnderRoot(mountEntries, String(policy.guestConfigurationRoot));
        const reconciliation = reconcileObservedMountsWithPlan(
          observedUnderRoot.map((e) => e.mountPoint),
          plannedDestinations,
          String(policy.guestConfigurationRoot),
        );
        const vmLog = readMatchlockMountLines(rec.vmLogsCopiedTo ?? null);
        const vmEvidenceIds = readRunnerVmEvidenceIds(
          path.join(tamanduaDir, "runs"),
          runId,
        );

        const roundCount = rec.vmId ? 1 : 0;

        const diagnosis: Record<string, unknown> = {
          contract: "DSH-OVERLAY-FSYNC-FIX",
          story: "US-002",
          gate: "matchlock-dsh-fsync-diagnosis",
          traceMethod,
          straceProbeFailure: finding.straceProbeFailure,
          nodeShimBasename: DSH_FSYNC_DIAG_SHIM_BASENAME,
          failingSyscall: finding.failingSyscall,
          targetPathOrFd: finding.targetPathOrFd,
          exactPath: finding.exactPath,
          fd: finding.fd,
          errno: DSH_FSYNC_DIAG_ERRNO,
          rawTraceLine: finding.rawLine,
          realDshBinary: finding.realDshBinary,
          observedMountTable: mountEntries,
          observedMountPointsUnderRoot: observedUnderRoot.map((e) => e.mountPoint),
          matchlockExactMountsLine: vmLog.exactMountsLine,
          matchlockFuseMountLines: vmLog.fuseMountLines,
          plannedDestinations,
          planReconciliation: {
            matches: reconciliation.matches,
            discrepancy: reconciliation.discrepancy,
            observedUnderRoot: reconciliation.observedUnderRoot,
            plannedDestinations: reconciliation.plannedDestinations,
          },
          failedCalls: finding.failedCalls,
          enoentFsyncs: finding.enoentFsyncs,
          roundCount,
          evidenceDir: EVIDENCE_DIR,
          vmIds: observedVmIds.slice(),
          vmRunnerEvidenceIds: vmEvidenceIds,
          vmLogPath: vmLog.vmLogPath,
          gateDshHomeShape: {
            sessionDirs: layout.sessionDirs.length,
            storageRecordFiles: layout.storageRecordFiles.length,
            durableProfileFiles: layout.durableProfileFiles,
            installDerivedDirs: layout.installDerivedDirs,
            synthesizedConfigFiles: layout.synthesizedConfigFiles,
          },
          round: {
            runId,
            vmId: rec.vmId,
            exitCode: rec.exitCode,
            timedOut: rec.timedOut ?? false,
            durationMs: rec.durationMs ?? null,
            cleanupConfirmed: rec.cleanupConfirmed,
            vmRemoved: rec.vmRemoved ?? null,
            stderrTail: rec.stderrTail.slice(-4000),
          },
          honestNotes:
            "One fresh Matchlock VM booted the REAL dsh CLI (operator image seeded from the " +
            "operator matchlock store) through the production dsh invocation runner against the " +
            "US-001 real-layout DSH_HOME with PLACEHOLDER credentials (zero model tokens). The " +
            "guest dsh is a wrapper that dumps /proc/mounts and traces dsh: it prefers " +
            "`strace -f -y -e trace=... -e status=failed`, and when the guest sandbox denies " +
            "ptrace (PTRACE_TRACEME EPERM, recorded in straceProbeFailure) falls back to a Node " +
            "`--require` interposer over FileHandle.prototype.sync / fs.fsync* that logs the " +
            "exact `/proc/self/fd/<fd>` target. After US-003 the shipped plan is ONE real " +
            "effective-home root destination, so the guest mount table matches the plan and no " +
            "fsync/fdatasync fails with ENOENT on the home root. roundCount is the number of VMs " +
            "that reached a live round. This gate is on-demand and is not part of npm test or " +
            "run-all-e2e-tests.",
          timestamp: new Date().toISOString(),
        };

        fs.mkdirSync(path.dirname(DIAGNOSIS_JSON), { recursive: true });
        fs.writeFileSync(DIAGNOSIS_JSON, `${JSON.stringify(diagnosis, null, 2)}\n`, "utf-8");
        const parsedBack = JSON.parse(fs.readFileSync(DIAGNOSIS_JSON, "utf-8")) as Record<
          string,
          unknown
        >;
        assert.equal(parsedBack.exactPath, finding.exactPath, "diagnosis JSON must round-trip");

        writeEvidence("dsh-fsync-diagnosis.json", JSON.stringify(diagnosis, null, 2));
        writeEvidence("dsh-fsync-diagnosis-strace.log", finding.enoentFsyncs.map((c) => c.rawLine).join("\n"));

        // 3. The FIX-under-test: no failing `fsync`/`fdatasync` ENOENT and the
        //    observed guest mount set matches the shipped composed plan. The
        //    JSON above is written FIRST so the honest observation is retained
        //    even when the assertions fall short.
        assert.equal(
          roundCount > 0,
          true,
          "the gate must record observed in-VM rounds > 0 (a VM that never booted is a failure)",
        );
        assert.equal(
          traceMethod === "guest-strace" || traceMethod === "guest-node-fs-shim",
          true,
          `the guest must run the traced dsh (method=${traceMethod}); stderrTail=${rec.stderrTail.slice(-2000)}`,
        );
        assert.equal(
          finding.enoentFsyncs.length,
          0,
          `no fsync/fdatasync may fail with ENOENT on the effective home ` +
            `(syscall=${finding.failingSyscall}, path=${finding.exactPath}); ` +
            `traceMethod=${finding.traceMethod}; output tail=${rec.output.slice(-4000)}; stderrTail=${rec.stderrTail.slice(-2000)}`,
        );
        assert.equal(
          reconciliation.matches,
          true,
          `the observed guest mounts must match the shipped composed plan: ${reconciliation.discrepancy}`,
        );

        // 4. Authoritative (throwing) exact-owned VM cleanup: a leftover fails
        //    the gate. The runner normally already removed the VM.
        assertNoOwnedVms(homeDir, "post-round", {
          rpcBin: MATCHLOCK_RPC_BIN,
          pollTimeoutMs: 15_000,
        });
        const { ledger } = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, {
          rpcBin: MATCHLOCK_RPC_BIN,
        });
        assert.ok(ledger.length > 0, "cleanup ledger must be recorded");

        console.log(
          `[matchlock-dsh-fsync-diagnosis] OK — no ENOENT fsync on the effective home; ` +
            `traceMethod=${traceMethod}; planReconciliation.matches=${reconciliation.matches}; VM ${rec.vmId} closed`,
        );
      },
    );
  },
);
