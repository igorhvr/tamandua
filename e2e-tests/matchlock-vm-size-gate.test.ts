/******************************************************************************
 * ⚠️  SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-VM-SIZE US-006 — the focused ONE-VM resource-limits gate.
 *
 * The defect: every Matchlock round used the provisional 2-vCPU / 2 GB
 * resourceLimits and the size was never operator-configurable, so a serial unit
 * lane took 40-45 min in a VM vs 21 min native on a 380-CPU/1.4 TB host.
 *
 * This gate boots exactly ONE fresh real VM through the PRODUCTION
 * MatchlockController `resolveAndAdmitIdentity -> prepareAndCreate ->
 * execStream -> close` seam (the exact seam the pi/dsh/hermes invocation
 * runners use) with a policy whose `resourceLimits` are
 * `{cpus:4, memoryMB:4096, diskSizeMB:20480}`, and proves the resolved limits
 * reach the VM:
 *   - the create request builder emits `resources`
 *     {cpus:4, memory_mb:4096, disk_size_mb:20480};
 *   - `nproc` inside the guest is exactly 4;
 *   - `/proc/meminfo` `MemTotal` is within tolerance of 4096 MB
 *     (> 3.5 GiB and <= 4.2 GiB);
 *   - the single owned VM is positively closed and removed BY EXACT ID
 *     (`cleanupOwnedVms` fails on a failed/unknown removal; no leftovers).
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand ONLY through the
 * lock-taking runner (which also takes
 * `flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock`):
 *
 *   ./run-matchlock-vm-size-gate-e2e-test
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB under the evidence dir, the
 * operator image store seeded (hardlinked blobs + copied metadata), no daemon,
 * no control-plane port, no model calls. TAMANDUA_TEST_GUARD denies any real
 * tamandua state.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoOwnedVms,
  cleanupOwnedVms,
} from "./helpers/matchlock-gate-lifecycle.ts";
import {
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── environment: caller-provided runtime + operator image store ────────────
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

const OPERATOR_TAG = "igorhvr/bedlam-ubuntu";

const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";
const OPERATOR_CACHE = process.env.TAMANDUA_GATE_OPERATOR_CACHE ?? "";

// The observed-rounds evidence / guard label for this gate. The runner passes
// the SAME label to scripts/observed-rounds-guard.mjs.
const GATE_LABEL = "vm-size";

/** The exact VM size this gate resolves + proves inside the guest. */
const GATE_RESOURCE_LIMITS = { cpus: 4, memoryMB: 4096, diskSizeMB: 20480 } as const;

const CREATE_TIMEOUT_MS = 5 * 60_000;
const EXEC_TIMEOUT_MS = 2 * 60_000;

function assertEnv(): void {
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-vm-size-gate-e2e-test)",
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
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# Matchlock VM-size gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Matchlock VM-Size Gate"], targetDir);
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

function writeEvidence(name: string, content: string): string {
  const p = path.join(EVIDENCE_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

// ── shared state ──────────────────────────────────────────────────────────
let homeDir = "";
let tamanduaDir = "";
let configDir = "";
let wd = "";
let ledgerPath = "";

const observedVmIds: string[] = [];

// ── dist (production controller + admission) ──────────────────────────────
async function loadController(): Promise<{
  MatchlockController: new (
    policy: unknown,
    opts: Record<string, unknown>,
  ) => {
    resolveAndAdmitIdentity(): Promise<{ digest: string; config_digest: string; tag?: string }>;
    prepareAndCreate(
      pin: { digest: string; config_digest: string; tag?: string },
    ): Promise<{ vmId: string; identity: { digest: string; config_digest: string; tag?: string } }>;
    buildCreateParams(
      helperPackHostPath: string | null,
      identity: { digest: string; config_digest: string; tag?: string },
    ): { resources?: { cpus?: number; memory_mb?: number; disk_size_mb?: number } };
    execStream(
      cmd: { command: string; working_dir?: string },
      notify: (frame: { kind: "stdout" | "stderr" | "ready"; base64?: string; requestId?: number }) => void,
      timeoutMs?: number,
    ): Promise<{ exit_code: number; duration_ms: number }>;
    close(timeoutSeconds: number): Promise<void>;
  };
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/controller.js`);
  return { MatchlockController: mod.MatchlockController };
}

async function loadAdmission(): Promise<{
  admitMatchlockRun: (o: Record<string, unknown>) => Promise<{ policy: Record<string, unknown> }>;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/admission.js`);
  return { admitMatchlockRun: mod.admitMatchlockRun };
}

async function loadGuestPack(): Promise<{
  ensureGuestPackForState: (o: { stateRoot: string }) => Promise<string>;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/scheduler-matchlock.js`);
  return { ensureGuestPackForState: mod.ensureGuestPackForState };
}

async function loadDecodeFrame(): Promise<{
  decodeFrameBytes: (frame: { kind: string; base64?: string }) => Buffer;
}> {
  const mod = await import(`${repoRoot}/dist/installer/matchlock/rpc-client.js`);
  return { decodeFrameBytes: mod.decodeFrameBytes };
}

interface Capture {
  stdout: Buffer[];
  stderr: Buffer[];
}

function makeCapture(): Capture {
  return { stdout: [], stderr: [] };
}

function captured(cap: Capture): { stdout: string; stderr: string } {
  return {
    stdout: Buffer.concat(cap.stdout).toString("utf-8"),
    stderr: Buffer.concat(cap.stderr).toString("utf-8"),
  };
}

// ── the gate ──────────────────────────────────────────────────────────────

describe(
  "matchlock vm-size: policy resourceLimits {cpus:4,memoryMB:4096} reach the guest",
  { concurrency: 1, timeout: 60 * 60_000 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      homeDir = path.join(EVIDENCE_DIR, "home");
      tamanduaDir = path.join(homeDir, ".tamandua");
      configDir = path.join(homeDir, ".pi", "agent");
      process.env.HOME = homeDir;
      process.env.PI_CODING_AGENT_DIR = configDir;
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
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "settings.json"),
        JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
        "utf-8",
      );

      const kernelSrc = path.join(OPERATOR_CACHE, "kernels");
      assert.ok(fs.existsSync(kernelSrc), `operator kernel cache missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), {
        recursive: true,
      });

      seedOperatorImageStore(OPERATOR_CACHE, homeDir);
      wd = prepareFixtureRepo(path.join(EVIDENCE_DIR, "fixtures", "wd-vm-size"));
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");

      // The controller's pre-flight SUN_LEN guard must pass for the private HOME
      // we hand to the matchlock control process.
      const longest = path.join(
        homeDir,
        ".matchlock",
        "vms",
        "vm-12345678",
        "vsock.sock_5001",
      );
      assert.ok(
        Buffer.byteLength(longest) < 108,
        `private gate HOME makes the matchlock socket path too long (${Buffer.byteLength(longest)} >= 108): ${longest}`,
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
      // ── observed-rounds honesty (TESTER-HONESTY item 3) ─────────────
      // Record the distinct in-VM rounds this gate ACTUALLY observed and
      // refuse to certify a zero-round run (VM creation/probe failed before
      // any round) even if the node --test assertions above were bypassed.
      const errors: string[] = [];
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
      if (errors.length > 0) {
        throw new Error(`gate after-hook failure:\n${errors.join("\n")}`);
      }
    });

    it(
      "boots ONE VM with cpus=4/memory=4096 through the production controller and proves nproc + MemTotal inside the guest",
      { timeout: 60 * 60_000 },
      async () => {
        const { MatchlockController } = await loadController();
        const { admitMatchlockRun } = await loadAdmission();
        const { ensureGuestPackForState } = await loadGuestPack();
        const { decodeFrameBytes } = await loadDecodeFrame();

        const packPath = await ensureGuestPackForState({ stateRoot: tamanduaDir });
        assert.ok(fs.existsSync(packPath), `guest helper pack missing at ${packPath}`);

        // ── production admission: policy carries the exact gate limits ─────
        const admitted = await admitMatchlockRun({
          requestedImage: OPERATOR_TAG,
          harness: "pi",
          workspaceMode: "direct",
          workingDirectory: wd,
          resourceLimits: GATE_RESOURCE_LIMITS,
          rpcBinaryPath: MATCHLOCK_RPC_BIN,
          admission: { home: homeDir, liveStateRoot: tamanduaDir },
        });
        const policy = admitted.policy;
        assert.deepEqual(
          policy.resourceLimits,
          GATE_RESOURCE_LIMITS,
          "the admitted policy must persist the exact gate resource limits",
        );

        // ── the production controller seam (no daemon, no model) ───────────
        const controller = new MatchlockController(policy, {
          rpcBinaryPath: MATCHLOCK_RPC_BIN,
          helperPackHostPath: packPath,
          createTimeoutMs: CREATE_TIMEOUT_MS,
          requestTimeoutMs: EXEC_TIMEOUT_MS,
          readyTimeoutMs: 30_000,
          mountAdmission: { home: homeDir, liveStateRoot: tamanduaDir },
        });

        let vmId: string | null = null;
        let createResources: Record<string, unknown> | null = null;
        let nprocRaw = "";
        let memInfoRaw = "";
        let nproc = -1;
        let memTotalKiB = -1;
        let ledger: string[] = [];
        let closeError: unknown = null;
        let cleanupError: unknown = null;
        try {
          const pin = await controller.resolveAndAdmitIdentity();
          assert.ok(
            pin.digest.startsWith("sha256:") && pin.config_digest.startsWith("sha256:"),
            `pinned identity incomplete: ${JSON.stringify(pin)}`,
          );

          // The EXACT create request `prepareAndCreate` will send.
          const createParams = controller.buildCreateParams(packPath, pin);
          createResources = (createParams.resources ?? null) as Record<string, unknown> | null;
          assert.deepEqual(
            createResources,
            { cpus: 4, memory_mb: 4096, disk_size_mb: 20480 },
            "the create request resources must carry cpus=4, memory_mb=4096, disk_size_mb=20480",
          );

          const created = await controller.prepareAndCreate(pin);
          vmId = created.vmId;
          assert.match(vmId, /^vm-[0-9a-f]{8}$/, `unexpected owned VM id: ${vmId}`);
          observedVmIds.push(vmId);

          // ── in-guest proof #1: nproc ─────────────────────────────────────
          const nprocCap = makeCapture();
          const nprocResult = await controller.execStream(
            { command: "nproc", working_dir: "/" },
            (frame) => {
              if (frame.kind === "ready") return;
              const bytes = decodeFrameBytes(frame);
              if (bytes.length === 0) return;
              (frame.kind === "stderr" ? nprocCap.stderr : nprocCap.stdout).push(bytes);
            },
            EXEC_TIMEOUT_MS,
          );
          nprocRaw = captured(nprocCap).stdout.trim();
          assert.equal(
            nprocResult.exit_code,
            0,
            `guest nproc exited ${nprocResult.exit_code}; stderr=${captured(nprocCap).stderr.slice(-2000)}`,
          );
          nproc = Number.parseInt(nprocRaw.split(/\s+/)[0] ?? "", 10);
          assert.equal(nproc, 4, `guest nproc must be 4 (raw=${JSON.stringify(nprocRaw)})`);

          // ── in-guest proof #2: MemTotal ──────────────────────────────────
          const memCap = makeCapture();
          const memResult = await controller.execStream(
            { command: "cat /proc/meminfo", working_dir: "/" },
            (frame) => {
              if (frame.kind === "ready") return;
              const bytes = decodeFrameBytes(frame);
              if (bytes.length === 0) return;
              (frame.kind === "stderr" ? memCap.stderr : memCap.stdout).push(bytes);
            },
            EXEC_TIMEOUT_MS,
          );
          memInfoRaw = captured(memCap).stdout;
          assert.equal(
            memResult.exit_code,
            0,
            `guest /proc/meminfo read exited ${memResult.exit_code}; stderr=${captured(memCap).stderr.slice(-2000)}`,
          );
          const memMatch = memInfoRaw.match(/^MemTotal:\s+(\d+)\s+kB$/m);
          assert.ok(memMatch, `no MemTotal line in guest /proc/meminfo:\n${memInfoRaw.slice(0, 2000)}`);
          memTotalKiB = Number.parseInt(memMatch![1], 10);
          const memTotalBytes = memTotalKiB * 1024;
          assert.ok(
            memTotalBytes > 3.5 * 1024 ** 3 && memTotalBytes <= 4.2 * 1024 ** 3,
            `guest MemTotal must be within tolerance of 4096 MB (got ${memTotalKiB} kB = ${memTotalBytes} bytes)`,
          );
        } finally {
          // Positively close the ONE owned VM (a confirmed wire close), then
          // remove it BY EXACT ID — a failed/unknown removal fails the gate.
          // Both run on EVERY path so no VM leaks on an assertion failure.
          if (vmId) {
            try {
              await controller.close(60);
            } catch (err) {
              closeError = err;
            }
            try {
              const cleanup = cleanupOwnedVms(homeDir, ledgerPath, [vmId], {
                rpcBin: MATCHLOCK_RPC_BIN,
              });
              ledger = cleanup.ledger;
              assertNoOwnedVms(homeDir, "post-cleanup", { rpcBin: MATCHLOCK_RPC_BIN });
            } catch (err) {
              cleanupError = err;
            }
          }
          // Retain the observed evidence even when an assertion failed.
          const evidence = {
            contract: "MTLK-VM-SIZE",
            story: "US-006",
            gate: "matchlock-vm-size",
            image: OPERATOR_TAG,
            identity: admitted.policy.resolvedImageDigest ?? null,
            policyResourceLimits: admitted.policy.resourceLimits,
            createResources,
            vmId,
            vmCount: observedVmIds.length,
            nproc,
            nprocRaw,
            memTotalKiB,
            memTotalBytes: memTotalKiB * 1024,
            memInfoRaw: memInfoRaw.slice(0, 4000),
            cleanupLedger: ledger,
            closeError: closeError instanceof Error ? closeError.message : closeError ? String(closeError) : null,
            cleanupError: cleanupError instanceof Error ? cleanupError.message : cleanupError ? String(cleanupError) : null,
            evidenceDir: EVIDENCE_DIR,
            timestamp: new Date().toISOString(),
          };
          try {
            writeEvidence("vm-size-gate-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
          } catch {
            /* evidence write must never mask the gate outcome */
          }
        }

        assert.ok(vmId, "the gate must have owned exactly one VM");
        assert.equal(observedVmIds.length, 1, `the gate must boot exactly ONE VM (got ${observedVmIds.length})`);
        assert.equal(
          closeError,
          null,
          `positive VM close failed for ${vmId}: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
        );
        assert.equal(
          cleanupError,
          null,
          `exact-owned VM cleanup failed for ${vmId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
        assert.ok(ledger.length > 0, "cleanup ledger must be recorded");
        assert.ok(
          fs.existsSync(ledgerPath),
          `vm cleanup ledger missing at ${ledgerPath}`,
        );

        console.log(
          `[matchlock-vm-size-gate] OK vm=${vmId} cpus=${createResources?.cpus} ` +
            `memory_mb=${createResources?.memory_mb} nproc=${nproc} memTotalKiB=${memTotalKiB} evidence=${EVIDENCE_DIR}`,
        );
      },
    );
  },
);
