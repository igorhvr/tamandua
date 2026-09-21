/**
 * hermes-invocation-runner.test.ts — US-002 (serial lane).
 *
 * The Hermes invocation runner executes ONE opted-in Hermes invocation in a
 * FRESH VM. Real VMs are NOT available in this lane (they belong to the
 * separate synthetic whole-path gate), so this suite drives the REAL
 * production stack down to the RPC boundary and substitutes ONLY the "VM"
 * itself with an explicitly labelled MOCK: a local-VM RPC driver (a scripted
 * `matchlock rpc` child that executes every exec command as a REAL local
 * subprocess with the VM create env, maps the guest /workspace/runtime pack
 * path onto the real host pack and the guest /workspace/config/hermes store
 * path onto the host Hermes config directory). Every other hop is real:
 *
 *   real Hermes adapter plan resolution (frozen submission inputs only)
 *     → config mount scope admission (canonical realpath; broad HOME /
 *       .tamandua / lexical-only admission refused)
 *     → real MatchlockController + real RPC client
 *     → mock local-VM driver (exec_pipe = real local subprocess, base64 frames)
 *     → REAL packed guest bridge service subprocess (bin/tamandua-bridge)
 *     → REAL scoped host broker + REAL NativeStepServices over an ISOLATED
 *       temp HOME/STATE/DB (schema10, TAMANDUA_TEST_GUARD=1)
 *     → REAL packed guest CLI + a SYNTHETIC guest `hermes` (plain-text output,
 *       authoritative stderr `session_id:` trailer, mapped-store state.db)
 *     → REAL host-owned Matchlock suite SQLite store (when suite-capable)
 *     → REAL host progress-resource document
 *
 * Nothing here is a real VM, a live daemon, a real image or a real model.
 * The synthetic Hermes is TEST-ONLY and never calls real providers.
 */

import { describe, it, after, afterEach } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../../../dist/db.js";
import {
  AGENT,
  RUN,
  applyEnv,
  createIsolatedState,
  snapshotEnv,
  type IsolatedState,
} from "../../../dist/installer/matchlock/native-step-test-utils.js";
import { buildGuestPack, type GuestPackManifest } from "../../../dist/installer/matchlock/guest-pack-builder.js";
import { HostInvocationRegistry } from "../../../dist/installer/matchlock/native-step-invocations.js";
import { openHostSuiteStore } from "../../../dist/installer/matchlock/host-suite-store.js";
import {
  runHermesInvocation,
  HermesInvocationError,
  HermesSelectionRefusedError,
  admitHermesConfigMount,
  projectHermesStoreScan,
  projectHermesRecoveredSession,
  type HermesInvocationResult,
} from "../../../dist/installer/matchlock/hermes-invocation-runner.js";
import { resolveHermesAdapterPlan, buildHermesGuestLaunch } from "../../../dist/installer/matchlock/hermes-adapter.js";
import { MatchlockRunnerError } from "../../../dist/installer/matchlock/pi-invocation-runner.js";
import { readOrphanVms } from "../../../dist/installer/matchlock/vm-orphans.js";
import type { ExecutionIsolation } from "../../../dist/installer/matchlock/policy.js";
import { guestSuiteNamespaceId, type GuestSuiteNamespace } from "../../../dist/installer/matchlock/guest-suite-contract.js";
import { committedTreeHash, computeCmdHash } from "../../../dist/installer/matchlock/guest-suite-git.js";
import type { FrozenHermesSubmissionInput } from "../../../dist/installer/matchlock/hermes-profile.js";
// MTLK-ALL-WORKFLOWS US-001: host-attested scoped merge service contract
// (imported as a TYPE only; tests inject a fake through the same seam).
import type { HostMergeServices } from "../../../dist/installer/matchlock/host-merge-services.js";
import { fileURLToPath } from "node:url";

// ── shared identity ────────────────────────────────────────────────────

const INV_A = "aaaaaaaa-1111-4111-8111-111111111111";
const INV_B = "bbbbbbbb-2222-4222-8222-222222222222";
const JOB = "job-11111111-1111-4111-8111-111111111111";
const DIGEST = "sha256:hermes-runner-fixture-digest-0000000001";
const CONFIG_DIGEST = "sha256:hermes-runner-fixture-config-0000000001";
const IMAGE_TAG = "test/synthetic-hermes-runner:fixture";
const NODE_BIN = process.execPath;
const NODE_DIR = path.dirname(NODE_BIN);

/** Guest HERMES_HOME for the DEFAULT profile (approved stable mapping). */
const GUEST_HERMES_HOME = "/workspace/config/hermes";
/** Synthetic session id printed on the authoritative stderr trailer. */
const SESSION_ID = "sess-hermes-runner-0001";

// sticky isolated env (module-level handles never resolve against live state).
const sticky = createIsolatedState("hermes-runner-sticky");
sticky.open();
const stickyEnv = snapshotEnv();

// One shared RO guest pack per file (deterministic; requires npm run build).
const sharedPack = buildSharedPack();

function buildSharedPack(): { root: string; packDir: string; manifest: GuestPackManifest } {
  const root = tamanduaTempDir("tamandua-hermes-runner-pack-");
  const packDir = path.join(root, "pack");
  const result = buildGuestPack({ targetDir: packDir });
  const manifest = JSON.parse(fs.readFileSync(path.join(packDir, "manifest.json"), "utf-8")) as GuestPackManifest;
  return { root, packDir, manifest };
}

after(() => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(sticky.root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(sharedPack.root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

afterEach(() => {
  applyEnv(stickyEnv);
  // The mock local-VM driver runs the guest bridge as a host process whose
  // socket dir lands at /tmp/tamandua-guest-<invocationId> (guest /tmp is the
  // host /tmp in the mock). Remove ONLY the exact dirs this suite owns.
  for (const inv of [INV_A, INV_B]) {
    try {
      fs.rmSync(`/tmp/tamandua-guest-${inv}`, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ── fixtures ───────────────────────────────────────────────────────────

function git(args: string[], cwd: string): void {
  spawnSync("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/root",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdio: "pipe",
  });
}

interface FixtureRig {
  st: IsolatedState;
  root: string;
  repoDir: string;
  hermesDir: string;
  progressRunRoot: string;
}

/**
 * Legacy fixture base of the run-83 baseline rigs, which ran under the root
 * operator account. Kept verbatim as the default so those cases are unchanged.
 */
const LEGACY_ROOT_FIXTURE_BASE = "/root/matchlock-hermes-runner-fixtures";

/**
 * US-005: a NARROW descendant of the REAL operator home, computed from the
 * passwd entry (never the test-isolated $HOME). It is a legitimate guest
 * destination (mount-plan only rejects wholesale `/home`/`/root`, never narrow
 * descendants) and is writable by the non-root operator, so the new VM-reaper
 * cases run and pass here instead of failing with the documented
 * `/root/...` EACCES host delta.
 */
const WRITABLE_FIXTURE_BASE = path.join(
  (() => {
    try {
      return os.userInfo().homedir;
    } catch {
      return os.homedir();
    }
  })(),
  "matchlock-hermes-runner-fixtures",
);

function makeRig(tag: string, fixtureBase: string = WRITABLE_FIXTURE_BASE): FixtureRig {
  const st = createIsolatedState(tag);
  st.open();
  // Narrow exact-path mounts live under a NARROW fixture root below the
  // operator home (accepted exact-path semantics).
  fs.mkdirSync(fixtureBase, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(fixtureBase, `${tag}-`));
  tempDirs.push(fixtureRoot);
  const repoDir = path.join(fixtureRoot, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-q"], repoDir);
  git(["config", "user.email", "hermes-runner@test.invalid"], repoDir);
  git(["config", "user.name", "Hermes Runner"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Hermes runner fixture\n");
  git(["add", "README.md"], repoDir);
  git(["commit", "-q", "-m", "init"], repoDir);
  // Synthetic NON-SECRET Hermes config fixture (never real credentials).
  const hermesDir = path.join(fixtureRoot, "hermes-home");
  fs.mkdirSync(hermesDir, { recursive: true });
  fs.writeFileSync(
    path.join(hermesDir, "config.yaml"),
    "terminal:\n  backend: local\nmodel: synthetic-local-model\n",
  );
  // Every rig owns a running run row (claim/complete require real run state).
  st.insertRun({ workflowId: "feature-dev", status: "running" });
  return { st, root: st.root, repoDir, hermesDir, progressRunRoot: path.join(st.root, "state", "runs") };
}

function fixturePolicy(rig: FixtureRig, over: Partial<ExecutionIsolation> = {}): ExecutionIsolation {
  return {
    version: 2,
    backend: "matchlock",
    requestedImage: IMAGE_TAG,
    resolvedImageDigest: DIGEST,
    resolvedImageConfigDigest: CONFIG_DIGEST,
    harness: "pi" as ExecutionIsolation["harness"],
    configurationRoot: rig.hermesDir,
    configurationProfile: "settings.json",
    guestConfigurationRoot: GUEST_HERMES_HOME,
    workPathMode: "host-absolute",
    workingDirectory: rig.repoDir,
    workMounts: [{ hostPath: rig.repoDir, hostRealPath: fs.realpathSync(rig.repoDir), guestPath: rig.repoDir }],
    originalRepositoryRoot: rig.repoDir,
    gitMetadataRoots: [],
    mountPolicyVersion: 1,
    networkPolicyVersion: 1,
    resourceLimits: { cpus: 1, memoryMB: 512, diskSizeMB: 2048 },
    ...over,
  };
}

function identity(invocationId: string) {
  return { runId: `run-${RUN}`, agentId: AGENT, workflowId: "feature-dev", jobId: JOB, invocationId };
}

function submission(homeDir: string, over: Partial<FrozenHermesSubmissionInput> = {}): FrozenHermesSubmissionInput {
  return { homeDir, env: {}, cwd: homeDir, ...over };
}

const NS: GuestSuiteNamespace = {
  imageContentId: "sha256:hermes-runner-suite-image-000000000000000",
  guestPlatform: "linux/amd64",
  helperContract: "hermes-runner-helper+suite-v1",
  compatibilityFingerprint: "hermes-runner-fp-01",
};

// ── mock local-VM RPC driver ───────────────────────────────────────────
// EXPLICIT MOCK: plays the role of the Matchlock VM + runtime on the RPC wire
// ONLY. exec commands run as REAL local subprocesses under the VM create env
// with /workspace/runtime translated to the host pack dir and the guest
// Hermes config root translated to the host Hermes config directory. Never
// presented as real-VM evidence.
const LOCAL_VM_DRIVER = String.raw`// Mock local-VM matchlock rpc driver (ESM; executed as a plain node script).
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
const env = process.env;
const txnFile = env.FAKE_TRANSCRIPT_FILE || "";
function txn(o) { if (txnFile) fs.appendFileSync(txnFile, JSON.stringify(o) + "\n"); }
function send(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
function sendResult(id, result) { send({ jsonrpc: "2.0", result, id }); }
function sendError(id, code, message) { send({ jsonrpc: "2.0", error: { code, message }, id }); }
const imageTag = env.FAKE_IMAGE_TAG || "test/synthetic-hermes-runner:fixture";
const imageDigest = env.FAKE_IMAGE_DIGEST || "sha256:default";
const imageConfigDigest = env.FAKE_IMAGE_CONFIG_DIGEST || "sha256:default";
const runtimeRoot = env.FAKE_VM_RUNTIME_ROOT || "";
const configGuest = env.FAKE_VM_CONFIG_GUEST || "";
const configHost = env.FAKE_VM_CONFIG_HOST || "";
const chunkBytes = Number.parseInt(env.FAKE_STDOUT_CHUNK_BYTES || "8192", 10);
const createDelayMs = Number.parseInt(env.FAKE_CREATE_DELAY_MS || "0", 10);
let closeFailuresLeft = Number.parseInt(env.FAKE_CLOSE_FAIL || "0", 10);
const bridgeExit = env.FAKE_BRIDGE_EXIT;
const vmEnv = {};
let vmCreated = false;
let vmSeq = 0;
const vmPrefix = env.FAKE_VM_PREFIX || "vm-";
const execs = new Map();
function translate(p) {
  if (typeof p !== "string") return p;
  let s = p;
  if (runtimeRoot) s = s.split("/workspace/runtime").join(runtimeRoot);
  if (configGuest && configHost) s = s.split(configGuest).join(configHost);
  return s;
}
function childEnv(over) {
  const out = {};
  for (const k of Object.keys(process.env)) out[k] = process.env[k];
  for (const k of Object.keys(over || {})) out[k] = over[k];
  const x = {};
  for (const k of Object.keys(out)) x[k] = translate(out[k]);
  return x;
}
function emitChunks(method, kind, id, buf) {
  let off = 0;
  while (off < buf.length) {
    const end = Math.min(off + chunkBytes, buf.length);
    send({ jsonrpc: "2.0", method: method + "." + kind, params: { id, data: buf.subarray(off, end).toString("base64") } });
    off = end;
  }
}
function finishExec(st, canceled) {
  if (st.done) return;
  st.done = true;
  if (canceled || st.canceled) { sendError(st.id, -32003, "request cancelled"); return; }
  // US-006 (H1/D1): simulate a harness exec whose VM transport REJECTS after
  // the guest already did its work (the relay dropped the final stdout
  // frames). Only the harness exec is affected — the guest bridge keeps
  // serving step completion over its own request.
  if (!st.isBridge && env.FAKE_HARNESS_EXEC_ERROR) {
    sendError(st.id, Number.parseInt(env.FAKE_HARNESS_EXEC_ERROR_CODE || "-32000", 10), env.FAKE_HARNESS_EXEC_ERROR);
    return;
  }
  const code = st.exitCode == null ? 1 : st.exitCode;
  sendResult(st.id, { exit_code: code, duration_ms: 1 });
}
function spawnExec(id, method, params) {
  const command = translate(String(params.command));
  const cwd = params.working_dir ? translate(String(params.working_dir)) : process.cwd();
  const st = { id, method, child: null, done: false, canceled: false, exitCode: null, noSpawn: false, isBridge: false };
  execs.set(id, st);
  txn({ event: "exec_started", id, method, command, cwd });
  const isBridge = command.indexOf("tamandua-bridge") >= 0;
  st.isBridge = isBridge;
  if (method === "exec_pipe" && isBridge && bridgeExit !== undefined && bridgeExit !== "") {
    st.noSpawn = true;
    st.exitCode = Number.parseInt(bridgeExit, 10);
    txn({ event: "exec_no_spawn", id, exitCode: st.exitCode });
    setTimeout(() => finishExec(st, false), 20);
    return st;
  }
  const child = spawn("/bin/sh", ["-c", command], {
    cwd,
    env: childEnv(vmEnv),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  st.child = child;
  // US-006: with the reject+suppress knob the harness's stdout never reaches
  // the host (the corrupted-relay case: the exec rejects with zero frames).
  const suppressHarnessOutput =
    !st.isBridge && env.FAKE_HARNESS_EXEC_ERROR && env.FAKE_HARNESS_EXEC_ERROR_SUPPRESS_OUTPUT === "1";
  child.stdout.on("data", (b) => { if (!suppressHarnessOutput) emitChunks(method, "stdout", id, b); });
  child.stderr.on("data", (b) => { if (!suppressHarnessOutput) emitChunks(method, "stderr", id, b); });
  child.on("error", (err) => {
    txn({ event: "exec_error", id, message: String(err && err.message) });
    if (!st.done) { st.done = true; sendError(id, -32000, "exec spawn error: " + String(err && err.message)); }
  });
  child.on("close", (code, sig) => {
    st.exitCode = code;
    txn({ event: "exec_closed", id, code, sig });
    finishExec(st, false);
  });
  return st;
}
function killTree(st) {
  if (st.child) {
    try { process.kill(-st.child.pid, "SIGKILL"); } catch { try { st.child.kill("SIGKILL"); } catch { /* gone */ } }
  }
}
function shutdown() {
  for (const st of execs.values()) killTree(st);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
async function handle(req) {
  txn(req);
  const method = req.method;
  if (method === "resolve_image") {
    sendResult(req.id, { tag: imageTag, digest: imageDigest, config_digest: imageConfigDigest, source: "import", size: 1, oci: { cmd: ["/bin/sh"], env: { PATH: "/usr/bin:/bin" } } });
    return;
  }
  if (method === "create") {
    const p = req.params || {};
    if (p.env && typeof p.env === "object") { for (const k of Object.keys(p.env)) vmEnv[k] = p.env[k]; }
    vmCreated = true;
    vmSeq += 1;
    const id = vmPrefix + String(vmSeq);
    // MATCHLOCK-OBS US-005: when the fixture opts into a mock VM state root,
    // materialize the same on-disk layout a real matchlock create leaves
    // behind (a state dir + config.json + logs/) so the reaper's copy-before-rm
    // path is exercised end to end. close deliberately KEEPS the state dir
    // (matching the real close semantics this fix targets).
    const vmStateRoot = env.FAKE_VM_STATE_ROOT || "";
    if (vmStateRoot) {
      const stateDir = vmStateRoot + "/.matchlock/vms/" + id;
      fs.mkdirSync(stateDir + "/logs", { recursive: true });
      fs.writeFileSync(stateDir + "/config.json", JSON.stringify({ id, tag: imageTag }));
      fs.writeFileSync(stateDir + "/logs/guest.log", "guest log for " + id + "\n");
    }
    txn({ event: "vm_created", id });
    if (createDelayMs > 0) await new Promise((r) => setTimeout(r, createDelayMs));
    sendResult(req.id, { id });
    return;
  }
  if (method === "exec_pipe") {
    const id = req.id;
    if (id == null) { sendError(req.id, -32600, "exec_pipe requires request id"); return; }
    send({ jsonrpc: "2.0", method: "exec_pipe.ready", params: { id } });
    txn({ event: "ready_sent", id });
    spawnExec(id, "exec_pipe", req.params || {});
    return;
  }
  if (method === "exec_stream") {
    spawnExec(req.id, "exec_stream", req.params || {});
    return;
  }
  if (method === "exec_pipe.stdin") {
    const st = execs.get(req.params && req.params.id);
    if (st && st.child) {
      try { st.child.stdin.write(Buffer.from(req.params.data || "", "base64")); } catch { /* ignore */ }
    }
    return;
  }
  if (method === "exec_pipe.stdin_eof") {
    const st = execs.get(req.params && req.params.id);
    if (st && st.child) {
      try { st.child.stdin.end(); } catch { /* ignore */ }
    }
    return;
  }
  if (method === "cancel") {
    const id = req.params && req.params.id;
    const st = execs.get(id);
    if (st && !st.canceled) {
      st.canceled = true;
      txn({ event: "cancel", id });
      killTree(st);
      if (st.noSpawn) finishExec(st, true);
    }
    sendResult(req.id, { cancelled: Boolean(st) });
    return;
  }
  if (method === "close") {
    if (closeFailuresLeft > 0) {
      closeFailuresLeft -= 1;
      sendError(req.id, -32000, "close failed (fixture)");
      return;
    }
    for (const st of execs.values()) {
      st.canceled = true;
      killTree(st);
    }
    vmCreated = false;
    txn({ event: "vm_closed" });
    sendResult(req.id, {});
    return;
  }
  sendError(req.id, -32601, "Method not found");
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = String(line).trim();
  if (t === "") return;
  let req;
  try { req = JSON.parse(t); } catch { sendError(null, -32700, "Parse error"); return; }
  Promise.resolve(handle(req)).catch((e) => sendError(req.id, -32000, String((e && e.message) || e)));
});
rl.on("close", shutdown);
`;

interface DriverOptions {
  transcriptPath: string;
  chunkBytes?: number;
  createDelayMs?: number;
  closeFail?: number;
  bridgeExit?: string;
  configGuest?: string;
  configHost?: string;
  /** US-006: reject the harness exec with this RPC error message (guest bridge unaffected). */
  harnessExecError?: string;
  /** US-006: numeric RPC code for harnessExecError (default -32000). */
  harnessExecErrorCode?: number;
  /** US-006: also suppress the harness's stdout/stderr frames (lost-output case). */
  harnessExecErrorSuppressOutput?: boolean;
}

interface DriverRun {
  dir: string;
  driverPath: string;
  env: Record<string, string>;
}

function makeDriver(opts: DriverOptions): DriverRun {
  const dir = tamanduaTempDir("tamandua-hermes-runner-driver-");
  const driverPath = path.join(dir, "local-vm-matchlock-rpc.mjs");
  fs.writeFileSync(driverPath, LOCAL_VM_DRIVER, "utf8");
  fs.chmodSync(driverPath, 0o755);
  const env: Record<string, string> = {
    FAKE_IMAGE_TAG: IMAGE_TAG,
    FAKE_IMAGE_DIGEST: DIGEST,
    FAKE_IMAGE_CONFIG_DIGEST: CONFIG_DIGEST,
    FAKE_VM_RUNTIME_ROOT: sharedPack.packDir,
    FAKE_TRANSCRIPT_FILE: opts.transcriptPath,
    FAKE_VM_PREFIX: `vm-${randomUUID().slice(0, 8)}-`,
  };
  if (opts.configGuest) env.FAKE_VM_CONFIG_GUEST = opts.configGuest;
  if (opts.configHost) env.FAKE_VM_CONFIG_HOST = opts.configHost;
  if (opts.chunkBytes !== undefined) env.FAKE_STDOUT_CHUNK_BYTES = String(opts.chunkBytes);
  if (opts.createDelayMs !== undefined) env.FAKE_CREATE_DELAY_MS = String(opts.createDelayMs);
  if (opts.closeFail !== undefined) env.FAKE_CLOSE_FAIL = String(opts.closeFail);
  if (opts.bridgeExit !== undefined) env.FAKE_BRIDGE_EXIT = opts.bridgeExit;
  if (opts.harnessExecError !== undefined) env.FAKE_HARNESS_EXEC_ERROR = opts.harnessExecError;
  if (opts.harnessExecErrorCode !== undefined) env.FAKE_HARNESS_EXEC_ERROR_CODE = String(opts.harnessExecErrorCode);
  if (opts.harnessExecErrorSuppressOutput) env.FAKE_HARNESS_EXEC_ERROR_SUPPRESS_OUTPUT = "1";
  return { dir, driverPath, env };
}

function freshTranscript(): string {
  const dir = tamanduaTempDir("tamandua-hermes-runner-txn-");
  return path.join(dir, "transcript.jsonl");
}

interface TxnLine {
  method?: string;
  event?: string;
  command?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

function readTranscript(p: string): TxnLine[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TxnLine);
}

/**
 * MATCHLOCK-OBS US-005: fake `matchlock` CLI serving BOTH seams the runner
 * owns — the RPC child (`<cli> rpc` → the local-VM driver) and the post-close
 * removal (`<cli> rm <vmId>`). The rm branch records its exact argv, the
 * effective HOME and whether the VM state dir existed at spawn time, then
 * removes it (or exits non-zero for the failure case).
 */
function writeFakeMatchlockCli(opts: {
  journalPath: string;
  rmExit?: number;
  rmStderr?: string;
}): string {
  const dir = tmpDir("tamandua-hermes-runner-matchlock-");
  const file = path.join(dir, "matchlock");
  const L: string[] = [];
  L.push("#!/usr/bin/env node");
  L.push("const fs = require('node:fs');");
  L.push("const cp = require('node:child_process');");
  L.push("const argv = process.argv.slice(2);");
  L.push(`const JOURNAL = ${JSON.stringify(opts.journalPath)};`);
  L.push(`const RM_EXIT = ${opts.rmExit ?? 0};`);
  L.push(`const RM_STDERR = ${JSON.stringify(opts.rmStderr ?? "")};`);
  L.push("const home = process.env.HOME || '';");
  L.push("const vmId = argv[1];");
  L.push("const stateDir = home + '/.matchlock/vms/' + vmId;");
  L.push("if (argv[0] === 'rm') {");
  L.push("  const record = { event: 'rm', argv: argv, home: home, vmId: vmId, stateDirExisted: fs.existsSync(stateDir) };");
  L.push("  fs.appendFileSync(JOURNAL, JSON.stringify(record) + '\\n');");
  L.push("  if (RM_EXIT !== 0) { process.stderr.write(RM_STDERR); process.exit(RM_EXIT); }");
  L.push("  fs.rmSync(stateDir, { recursive: true, force: true });");
  L.push("  process.exit(0);");
  L.push("}");
  L.push("const driver = process.env.FAKE_DRIVER_PATH || '';");
  // Forward only the fake-driver contract (FAKE_* keys) plus PATH/HOME —
  // never the ambient environment (test-isolation guard).
  L.push("const childEnv = {};");
  L.push("for (const k of Object.keys(process.env)) { if (k.indexOf('FAKE_') === 0) childEnv[k] = process.env[k]; }");
  L.push("childEnv.PATH = process.env.PATH || '';");
  L.push("childEnv.HOME = process.env.HOME || '';");
  L.push("const r = cp.spawnSync(process.execPath, [driver].concat(argv), { stdio: 'inherit', env: childEnv });");
  L.push("process.exit(r.status === null ? 1 : r.status);");
  fs.writeFileSync(file, L.join("\n") + "\n", { mode: 0o755 });
  return file;
}

interface RmJournalLine {
  event: string;
  argv: string[];
  home: string;
  vmId: string;
  stateDirExisted: boolean;
}

function readRmJournal(p: string): RmJournalLine[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RmJournalLine);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const tempDirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = tamanduaTempDir(prefix);
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

type FakeHermesBehavior =
  | "plain"
  | "work"
  | "merge-probe"
  | "sleep"
  | "idle"
  | "no-store"
  | "store-no-trailer"
  | "store-null-tokens"
  | "store-two-rows";

/** Write a synthetic-guest-hermes script (MOCK harness) with canned behavior.
 *  TEST-ONLY: never calls a real model/provider. Prints plain-text output,
 *  an authoritative `session_id:` trailer on STDERR, and (for the store
 *  behaviors) a synthetic sessions row in the mapped store. */
function writeFakeHermes(
  behavior: FakeHermesBehavior,
  opts: {
    runId: string;
    sessionId?: string;
    stepId?: string;
    sleepMs?: number;
    runSuite?: boolean;
    repoDir?: string;
    saveClaimTo?: string;
    outputText?: string;
  } = { runId: RUN },
): string {
  const dir = tmpDir("tamandua-hermes-runner-fakehermes-");
  const file = path.join(dir, "hermes");
  const sessionId = opts.sessionId ?? SESSION_ID;
  const L: string[] = [];
  L.push("#!/usr/bin/env node");
  L.push("const cp = require('node:child_process');");
  L.push("const fs = require('node:fs');");
  L.push("const path = require('node:path');");
  L.push("const { DatabaseSync } = require('node:sqlite');");
  L.push("const argv = process.argv;");
  L.push("const prompt = argv[argv.length - 1];");
  L.push("const hermesHome = process.env.HERMES_HOME || '';");
  L.push("if (!hermesHome) { process.stderr.write('fake hermes: HERMES_HOME unset\\n'); process.exit(5); }");
  L.push("fs.mkdirSync(hermesHome, { recursive: true });");
  // state.db writer (synthetic row; cache_read present but excluded).
  L.push("function writeSessionRow(id, tokens) {");
  L.push("  const dbPath = path.join(hermesHome, 'state.db');");
  L.push("  const db = new DatabaseSync(dbPath);");
  L.push("  db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER)');");
  L.push("  db.prepare('INSERT OR REPLACE INTO sessions (id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?)').run(id, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite);");
  L.push("  db.close();");
  L.push("}");
  L.push("const tokens = { input: 100, output: 50, cacheRead: 9999, cacheWrite: 5 };");
  L.push("const nullTokens = { input: null, output: null, cacheRead: null, cacheWrite: null };");
  if (behavior === "sleep") {
    L.push("process.stdin.resume();");
    L.push(`setTimeout(() => { process.exit(0); }, ${opts.sleepMs ?? 5000});`);
  } else if (behavior === "idle") {
    L.push("process.stdout.write('idle hermes round finished\\n');");
    L.push("process.exit(0);");
  } else if (behavior === "work") {
    L.push("let claim;");
    L.push("try {");
    L.push(`  const raw = cp.execFileSync('tamandua', ['step','claim',${JSON.stringify(AGENT)},'--run-id','run-' + ${JSON.stringify(opts.runId)}], { encoding: 'utf8' });`);
    L.push("  claim = JSON.parse(raw.trim());");
    L.push("} catch (e) {");
    L.push("  process.stderr.write('claim failed: ' + String((e && e.stderr) || e));");
    L.push("  process.exit(3);");
    L.push("}");
    L.push("if (!claim || !claim.stepId) { process.stderr.write('claim returned no step: ' + JSON.stringify(claim)); process.exit(4); }");
    if (opts.saveClaimTo) {
      L.push(`fs.writeFileSync(${JSON.stringify(opts.saveClaimTo)}, JSON.stringify(claim));`);
    }
    L.push("fs.writeFileSync(path.join(process.cwd(), 'hermes-invocation-marker.txt'), 'ran\\n');");
    if (opts.runSuite) {
      const suiteArgs = JSON.stringify([
        "--repo", opts.repoDir ?? "",
        "--run", opts.runId,
        "--step", opts.stepId ?? "implement",
        "--",
        "echo", "suite-marker-ok",
      ]);
      L.push(`const r = cp.spawnSync('tamandua-test', ${suiteArgs}, { stdio: 'inherit' });`);
      L.push("if (r.status !== 0) { process.stderr.write('tamandua-test exited ' + r.status + '\\n'); process.exit(7); }");
    }
    L.push("const report = 'STATUS: done\\nCHANGES: hermes round trip — ✓ utf8 é\\nTESTS: runner\\n';");
    L.push("try {");
    L.push(`  cp.execFileSync('tamandua', ['step','complete', claim.stepId], { encoding: 'utf8', input: report });`);
    L.push("} catch (e) {");
    L.push("  process.stderr.write('complete failed: ' + String((e && e.stderr) || e));");
    L.push("  process.exit(6);");
    L.push("}");
    L.push("writeSessionRow(" + JSON.stringify(sessionId) + ", tokens);");
    L.push(`process.stdout.write(${JSON.stringify(opts.outputText ?? "hermes work round finished — ✓ plain text\n")});`);
    L.push(`process.stderr.write('\\nsession_id: ' + ${JSON.stringify(sessionId)} + '\\n');`);
    L.push("process.exit(0);");
  } else if (behavior === "merge-probe") {
    // MTLK-ALL-WORKFLOWS US-001: drive the SCOPED guest merge bridge op
    // (`tamandua merge-branch`) through the REAL guest CLI + bridge + broker.
    // The injected host merge service fully owns authorize/report, so a fake
    // service returning a refusal proves the op reached the host service
    // WITHOUT any Git; with no service wired the broker refuses UNSUPPORTED.
    const tip = "1".repeat(40);
    L.push("const r = cp.spawnSync('tamandua', [");
    L.push("  'merge-branch',");
    L.push(`  '--origin', ${JSON.stringify(opts.repoDir ?? "")},`);
    L.push("  '--branch', 'feature',");
    L.push("  '--into', 'main',");
    L.push(`  '--expect-tip', ${JSON.stringify(tip)},`);
    L.push("  '--message', 'merge probe',");
    L.push("], { encoding: 'utf8' });");
    L.push("process.stdout.write('merge-probe-rc:' + String(r.status) + '\\n');");
    L.push("process.stdout.write('merge-probe-stdout:' + String(r.stdout || '') + '\\n');");
    L.push("process.stdout.write('merge-probe-stderr:' + String(r.stderr || '') + '\\n');");
    L.push("writeSessionRow(" + JSON.stringify(sessionId) + ", tokens);");
    L.push(`process.stdout.write(${JSON.stringify(opts.outputText ?? "hermes merge-probe round finished\nSTATUS: done\nCHANGES: merge probe\nTESTS: merge probe\n")});`);
    L.push(`process.stderr.write('\\nsession_id: ' + ${JSON.stringify(sessionId)} + '\\n');`);
    L.push("process.exit(0);");
  } else if (behavior === "no-store") {
    L.push(`process.stdout.write(${JSON.stringify(opts.outputText ?? "hermes no-store round finished\n")});`);
    L.push(`process.stderr.write('\\nsession_id: ' + ${JSON.stringify(sessionId)} + '\\n');`);
    L.push("process.exit(0);");
  } else if (behavior === "store-no-trailer") {
    // H2 (US-007): the round writes its session row to the mapped store but
    // its session_id trailer is lost (same lossy exit that drops stdout).
    L.push("writeSessionRow(" + JSON.stringify(sessionId) + ", tokens);");
    L.push(`process.stdout.write(${JSON.stringify(opts.outputText ?? "hermes store-recovery round finished without a trailer\n")});`);
    L.push("process.exit(0);");
  } else if (behavior === "store-null-tokens") {
    L.push("writeSessionRow(" + JSON.stringify(sessionId) + ", nullTokens);");
    L.push("process.stdout.write('hermes null-token round finished without a trailer\\n');");
    L.push("process.exit(0);");
  } else if (behavior === "store-two-rows") {
    L.push("writeSessionRow(" + JSON.stringify(sessionId) + ", tokens);");
    L.push("writeSessionRow(" + JSON.stringify(sessionId + "-second") + ", tokens);");
    L.push("process.stdout.write('hermes two-row round finished without a trailer\\n');");
    L.push("process.exit(0);");
  } else {
    // plain
    L.push("writeSessionRow(" + JSON.stringify(sessionId) + ", tokens);");
    L.push(`process.stdout.write(${JSON.stringify(opts.outputText ?? "hermes plain round finished — ✓ utf8 é\nSTATUS: done\nCHANGES: runner\nTESTS: runner\n")});`);
    L.push(`process.stderr.write('\\nsession_id: ' + ${JSON.stringify(sessionId)} + '\\n');`);
    L.push("process.exit(0);");
  }
  fs.writeFileSync(file, L.join("\n") + "\n", { mode: 0o755 });
  return file;
}

interface InvokeOptions {
  rig: FixtureRig;
  driver: DriverRun;
  fakeHermes: string;
  invocationId: string;
  kind: "probe" | "work";
  promptText: string;
  registry: HostInvocationRegistry;
  timeoutMs: number;
  submission?: FrozenHermesSubmissionInput;
  progressResource?: { runId: string; runRoot: string };
  suite?: { storePath: string; namespace: GuestSuiteNamespace; admittedRoots: string[] };
  /** MTLK-ALL-WORKFLOWS US-001: injected host merge service (fake). */
  merge?: HostMergeServices;
  signal?: AbortSignal;
  guestEnvOverrides?: Record<string, string>;
  mountAdmission?: { home?: string; liveStateRoot?: string };
  label: string;
  createTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** US-005 seam: CLI binary used for BOTH the RPC child and the VM `rm`. */
  rpcBinaryPath?: string;
  /** US-005 seam: RPC child argv (default [driverPath]). */
  rpcArgs?: string[];
  /** US-005 seam: RPC child env (defaults to the driver env). */
  rpcEnv?: Record<string, string>;
  onLog?: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;
}

function invoke(opts: InvokeOptions): Promise<HermesInvocationResult> {
  const sub = opts.submission ?? submission(opts.rig.root, { env: { HERMES_HOME: opts.rig.hermesDir }, cwd: opts.rig.repoDir });
  return runHermesInvocation({
    policy: fixturePolicy(opts.rig),
    identity: identity(opts.invocationId),
    kind: opts.kind,
    promptText: opts.promptText,
    workingDirectoryForHarness: opts.rig.repoDir,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    progressResource: opts.progressResource,
    suite: opts.suite,
    merge: opts.merge,
    registry: opts.registry,
    helperPackHostPath: sharedPack.packDir,
    submission: sub,
    hermes: { binary: opts.fakeHermes },
    imagePath: `${NODE_DIR}:/usr/bin:/bin`,
    rpcBinaryPath: opts.rpcBinaryPath ?? NODE_BIN,
    rpcArgs: opts.rpcArgs ?? [opts.driver.driverPath],
    rpcEnv: opts.rpcEnv ?? opts.driver.env,
    guestEnvOverrides: opts.guestEnvOverrides,
    mountAdmission: opts.mountAdmission ?? { home: process.env.HOME, liveStateRoot: path.join(opts.rig.root, "state") },
    closeTimeoutSeconds: 25,
    createTimeoutMs: opts.createTimeoutMs ?? 15000,
    requestTimeoutMs: opts.requestTimeoutMs ?? 15000,
    handshakeTimeoutMs: 20000,
    serviceTimeoutMs: 120000,
    onLog: opts.onLog ?? (() => {}),
  });
}

// ── pure adapter/mount resolution tests ────────────────────────────────

describe("hermes invocation runner — pure resolution/mount admission", () => {
  it("default / named / custom / relative HERMES_HOME resolve through the adapter with buildHermesGuestLaunch argv and host-identical guest cwd", () => {
    const base = tmpDir("tamandua-hermes-resolve-");
    const userHome = path.join(base, "user-home");
    fs.mkdirSync(userHome, { recursive: true });
    // Default profile: HERMES_HOME unset → <home>/.hermes. The root exists
    // but has NO config.yaml → genuine absence under a valid root = built-in
    // native defaults (terminal backend local).
    const defaultRoot = path.join(userHome, ".hermes");
    fs.mkdirSync(defaultRoot, { recursive: true });
    // named profile home
    const root = path.join(base, "hermes-root");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "config.yaml"), "terminal:\n  backend: local\n");
    const profiles = path.join(root, "profiles");
    const named = path.join(profiles, "coder");
    fs.mkdirSync(named, { recursive: true });
    fs.writeFileSync(path.join(named, "config.yaml"), "terminal:\n  backend: local\n");
    // custom root at a completely different path
    const custom = path.join(base, "custom-hermes");
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, "config.yaml"), "terminal:\n  backend: local\n");
    // relative HERMES_HOME (resolved against the submission cwd)
    const workdir = path.join(base, "workdir");
    fs.mkdirSync(workdir, { recursive: true });
    const rel = path.join(workdir, "rel-hermes");
    fs.mkdirSync(rel, { recursive: true });
    fs.writeFileSync(path.join(rel, "config.yaml"), "terminal:\n  backend: local\n");

    const guestCwd = "/host/identical/workdir";
    // default: no HERMES_HOME → homeDir/.hermes (missing config.yaml under a
    // VALID root = built-in default, never a refusal).
    const defaultInput: FrozenHermesSubmissionInput = { homeDir: userHome, env: {}, cwd: workdir };
    const dPlan = resolveHermesAdapterPlan(defaultInput, { prompt: "p", guestCwd });
    assert.equal(dPlan.selectionRefused, false);
    assert.equal(dPlan.launchAdmission.ok, true);
    assert.ok(dPlan.launch, "default profile launch descriptor");
    assert.equal(dPlan.profile.profile, "default");
    assert.equal(dPlan.capturedIdentity.hostEffectiveDir, defaultRoot);
    assert.equal(dPlan.config.status, "absent");
    const dLaunch = buildHermesGuestLaunch({
      profileArg: dPlan.profile.profile,
      hermesHome: dPlan.profile.guestHermesHome,
      prompt: "p",
      guestCwd,
      binary: "hermes",
    });
    assert.deepEqual(dLaunch.argv.slice(0, 5), ["hermes", "--profile", "default", "chat", "--max-turns"]);
    assert.equal(dLaunch.cwd, guestCwd);
    assert.equal(dLaunch.env.HERMES_HOME, "/workspace/config/hermes");
    assert.equal(dPlan.profile.guestHermesHome, "/workspace/config/hermes");

    // named: HERMES_HOME points INTO a profiles dir
    const namedInput: FrozenHermesSubmissionInput = { homeDir: userHome, env: { HERMES_HOME: named }, cwd: workdir };
    const nPlan = resolveHermesAdapterPlan(namedInput, { prompt: "p", guestCwd });
    assert.equal(nPlan.launchAdmission.ok, true);
    assert.equal(nPlan.profile.profile, "coder");
    assert.equal(nPlan.profile.isNamedProfile, true);
    assert.equal(nPlan.profile.guestHermesHome, "/workspace/config/hermes/profiles/coder");
    const nLaunch = buildHermesGuestLaunch({
      profileArg: nPlan.profile.profile,
      hermesHome: nPlan.profile.guestHermesHome,
      prompt: "p",
      guestCwd,
      binary: "hermes",
    });
    assert.equal(nLaunch.argv[2], "coder");
    assert.equal(nLaunch.env.HERMES_HOME, "/workspace/config/hermes/profiles/coder");

    // custom: HERMES_HOME = an arbitrary absolute dir (default profile, host home root)
    const cInput: FrozenHermesSubmissionInput = { homeDir: userHome, env: { HERMES_HOME: custom }, cwd: workdir };
    const cPlan = resolveHermesAdapterPlan(cInput, { prompt: "p", guestCwd });
    assert.equal(cPlan.launchAdmission.ok, true);
    assert.equal(cPlan.profile.profile, "default");
    assert.equal(cPlan.capturedIdentity.hostEffectiveDir, custom);
    assert.equal(cPlan.profile.guestHermesHome, "/workspace/config/hermes");

    // relative: HERMES_HOME relative → resolved against the frozen cwd
    const rInput: FrozenHermesSubmissionInput = { homeDir: userHome, env: { HERMES_HOME: "rel-hermes" }, cwd: workdir };
    const rPlan = resolveHermesAdapterPlan(rInput, { prompt: "p", guestCwd });
    assert.equal(rPlan.launchAdmission.ok, true);
    assert.equal(rPlan.capturedIdentity.hostEffectiveDir, rel);
  });

  it("admitHermesConfigMount mounts the WHOLE canonical effective dir RW at guest HERMES_HOME; broad HOME / live admin state / lexical symlink escape refused", () => {
    const base = tmpDir("tamandua-hermes-mount-");
    const operatorHome = path.join(base, "operator-home");
    const liveState = path.join(base, "live-state");
    fs.mkdirSync(operatorHome, { recursive: true });
    fs.mkdirSync(liveState, { recursive: true });

    const root = path.join(base, "hermes-root");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "config.yaml"), "terminal:\n  backend: local\n");
    const plan = resolveHermesAdapterPlan({ homeDir: base, env: { HERMES_HOME: root }, cwd: base }, { prompt: "p" });
    const spec = admitHermesConfigMount(plan, { home: operatorHome, liveStateRoot: liveState });
    assert.equal(spec.hostConfigDir, fs.realpathSync(root));
    assert.equal(spec.guestConfigDir, "/workspace/config/hermes");
    assert.equal(spec.isNamedProfile, false);

    // BROAD host HOME: the whole operator home (HERMES_HOME == home) is never
    // a mount source, even though the adapter admits it lexically.
    fs.writeFileSync(path.join(operatorHome, "config.yaml"), "terminal:\n  backend: local\n");
    const homePlan = resolveHermesAdapterPlan(
      { homeDir: base, env: { HERMES_HOME: operatorHome }, cwd: base },
      { prompt: "p" },
    );
    assert.equal(homePlan.launchAdmission.ok, true, "lexical admission admits; realpath admission must refuse");
    assert.throws(
      () => admitHermesConfigMount(homePlan, { home: operatorHome, liveStateRoot: liveState }),
      (err: unknown) => err instanceof HermesSelectionRefusedError && err.code === "hermes_config_scope_refused",
    );

    // live .tamandua admin state (a real dir under the live state root) is refused.
    const adminDir = path.join(liveState, "runs", "x");
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, "config.yaml"), "terminal:\n  backend: local\n");
    const adminPlan = resolveHermesAdapterPlan({ homeDir: base, env: { HERMES_HOME: adminDir }, cwd: base }, { prompt: "p" });
    assert.equal(adminPlan.launchAdmission.ok, true);
    assert.throws(
      () => admitHermesConfigMount(adminPlan, { home: operatorHome, liveStateRoot: liveState }),
      (err: unknown) => err instanceof HermesSelectionRefusedError && err.code === "hermes_config_scope_refused",
    );

    // LEXICAL-only admission: a named profile symlink resolving OUTSIDE the
    // admitted root (to the operator home) is refused by realpath.
    const lexRoot = path.join(base, "lex-root");
    fs.mkdirSync(path.join(lexRoot, "profiles"), { recursive: true });
    fs.symlinkSync(operatorHome, path.join(lexRoot, "profiles", "coder"), "dir");
    fs.writeFileSync(path.join(lexRoot, "active_profile"), "coder\n");
    fs.writeFileSync(path.join(lexRoot, "config.yaml"), "terminal:\n  backend: local\n");
    const lexPlan = resolveHermesAdapterPlan({ homeDir: base, env: { HERMES_HOME: lexRoot }, cwd: base }, { prompt: "p" });
    assert.equal(lexPlan.launchAdmission.ok, true, "lexical resolution admits; realpath admission must refuse");
    assert.throws(
      () => admitHermesConfigMount(lexPlan, { home: operatorHome, liveStateRoot: liveState }),
      (err: unknown) => err instanceof HermesSelectionRefusedError && err.code === "hermes_config_scope_refused",
    );
  });

  it("projectHermesStoreScan: total = input+output+cache_write only; unavailable/ambiguous/truncated never a fabricated zero", () => {
    const row = { input_tokens: 10, output_tokens: 20, cache_read_tokens: 9999, cache_write_tokens: 3 };
    const ok = projectHermesStoreScan({ status: "row", row }, "s");
    assert.equal(ok.status, "ok");
    assert.equal(ok.tokens, 33); // cache_read 9999 excluded

    const nullRow = { input_tokens: 10, output_tokens: null, cache_read_tokens: 1, cache_write_tokens: 3 };
    const amb = projectHermesStoreScan({ status: "row", row: nullRow }, "s");
    assert.equal(amb.status, "ambiguous");
    assert.equal(amb.tokens, undefined);

    for (const status of ["no-db", "missing-columns", "session-not-found", "bad-args"] as const) {
      const u = projectHermesStoreScan({ status }, "s");
      assert.equal(u.status, "unavailable");
      assert.equal(u.tokens, undefined, "unavailable is never a fabricated zero");
    }
    const t = projectHermesStoreScan({ status: "read-error" }, "s");
    assert.equal(t.status, "truncated");
    assert.equal(t.tokens, undefined);
  });

  it("projectHermesRecoveredSession (H2/US-007): store fallback recovers the row's id + total; missing/NULL/ambiguous never a fabricated zero", () => {
    // The single newly created row carries the round's session id + tokens.
    const row = {
      id: "sess-recovered-0001",
      input_tokens: 3594,
      output_tokens: 1055,
      cache_read_tokens: 88704,
      cache_write_tokens: 0,
    };
    const ok = projectHermesRecoveredSession({ status: "row", row, candidateCount: 1 });
    assert.equal(ok.status, "ok");
    assert.equal(ok.sessionId, "sess-recovered-0001");
    assert.equal(ok.tokens, 4649, "input+output+cache_write; cache_read 88704 excluded");

    // NULL token columns: the session EXISTS (id recovered) but the count is
    // unverified — ambiguous, never a fabricated zero.
    const amb = projectHermesRecoveredSession({
      status: "row",
      row: { ...row, output_tokens: null },
      candidateCount: 1,
    });
    assert.equal(amb.status, "ambiguous");
    assert.equal(amb.sessionId, "sess-recovered-0001", "the session id is still recovered");
    assert.equal(amb.tokens, undefined, "NULL tokens are never a fabricated zero");

    // A row with no id cannot be attributed.
    const noId = projectHermesRecoveredSession({
      status: "row",
      row: { ...row, id: null },
      candidateCount: 1,
    });
    assert.equal(noId.status, "ambiguous");
    assert.equal(noId.sessionId, null);
    assert.equal(noId.tokens, undefined);

    // Genuinely missing/absent evidence is unavailable or ambiguous.
    for (const status of ["no-db", "no-table", "missing-columns", "no-new-session", "bad-args"] as const) {
      const u = projectHermesRecoveredSession({ status });
      assert.equal(u.status, "unavailable");
      assert.equal(u.sessionId, null);
      assert.equal(u.tokens, undefined, "unavailable is never a fabricated zero");
    }
    const twoRows = projectHermesRecoveredSession({ status: "ambiguous-new-session", candidateCount: 2 });
    assert.equal(twoRows.status, "ambiguous");
    assert.equal(twoRows.sessionId, null, "two new rows are never 'newest wins'");
    assert.equal(twoRows.tokens, undefined);

    const err = projectHermesRecoveredSession({ status: "read-error" });
    assert.equal(err.status, "truncated");
    assert.equal(err.tokens, undefined);

    // A non-finite token field is unverified, never clamped/zeroed.
    const bad = projectHermesRecoveredSession({
      status: "row",
      row: { ...row, input_tokens: Number.NaN },
      candidateCount: 1,
    });
    assert.equal(bad.status, "unavailable");
    assert.equal(bad.sessionId, "sess-recovered-0001");
    assert.equal(bad.tokens, undefined);
  });
});

// ── full runner tests (mock local-VM driver; real broker/services/pack) ──

describe("hermes invocation runner (mock local-VM driver; real broker/services/pack)", () => {
  it("refused adapter plan throws a typed refusal BEFORE any VM create / broker op / registry effect (counting fakes)", async () => {
    const rig = makeRig("hermes-refuse");
    const registry = new HostInvocationRegistry();
    try {
      // Explicit non-local terminal.backend → plan refused.
      const badDir = path.join(rig.root, "hermes-remote");
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(path.join(badDir, "config.yaml"), "terminal:\n  backend: ssh\n");
      const transcript = freshTranscript();
      const driver = makeDriver({ transcriptPath: transcript });
      await assert.rejects(
        withTimeout(
          invoke({
            rig,
            driver,
            fakeHermes: "/nonexistent/fake-hermes",
            invocationId: INV_A,
            kind: "work",
            promptText: "should never run",
            registry,
            timeoutMs: 30000,
            submission: submission(rig.root, { env: { HERMES_HOME: badDir }, cwd: rig.repoDir }),
            label: "adapter refusal",
          }),
          60000,
          "adapter refusal invocation",
        ),
        (err: unknown) => err instanceof HermesSelectionRefusedError && err.code === "hermes_selection_refused",
        "remote backend must refuse with hermes_selection_refused",
      );
      assert.equal(registry.admissionCount, 0, "zero registry admissions before the refusal");
      assert.equal(registry.revocationCount, 0, "zero registry revocations before the refusal");
      const lines = readTranscript(transcript);
      assert.equal(lines.length, 0, "the RPC driver never even started (zero wire effects)");
      assert.equal(fs.existsSync(transcript), false, "no transcript file created (no child spawn)");
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("refused config mount scope (broad host source) throws a typed refusal BEFORE any registry/VM effect", async () => {
    const rig = makeRig("hermes-scope-refuse");
    const registry = new HostInvocationRegistry();
    try {
      // The WHOLE operator home (a broad source) is the selected config dir.
      const broadHome = path.join(rig.root, "broad-home");
      fs.mkdirSync(broadHome, { recursive: true });
      fs.writeFileSync(path.join(broadHome, "config.yaml"), "terminal:\n  backend: local\n");
      const transcript = freshTranscript();
      const driver = makeDriver({ transcriptPath: transcript });
      await assert.rejects(
        withTimeout(
          invoke({
            rig,
            driver,
            fakeHermes: "/nonexistent/fake-hermes",
            invocationId: INV_A,
            kind: "work",
            promptText: "should never run",
            registry,
            timeoutMs: 30000,
            submission: submission(rig.root, { env: { HERMES_HOME: broadHome }, cwd: broadHome }),
            mountAdmission: { home: broadHome, liveStateRoot: path.join(rig.root, "state") },
            label: "scope refusal",
          }),
          60000,
          "scope refusal invocation",
        ),
        (err: unknown) => err instanceof HermesSelectionRefusedError && err.code === "hermes_config_scope_refused",
        "broad host source must refuse with hermes_config_scope_refused",
      );
      assert.equal(registry.admissionCount, 0);
      assert.equal(registry.revocationCount, 0);
      assert.equal(fs.existsSync(transcript), false, "no RPC child spawned before the refusal");
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("default-profile work round: fresh VM, whole config dir RW at guest HERMES_HOME (create journal), plain-text output, stderr-trailer session id, exact usage total; raw stdout/stderr preserved separately", async () => {
    const rig = makeRig("hermes-default");
    const registry = new HostInvocationRegistry();
    const saveClaimTo = path.join(rig.root, "hermes-claim.json");
    const stepRow = randomUUID();
    rig.st.insertStep({
      id: stepRow,
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "hermes fixture task",
      status: "pending",
      type: "single",
      expects: "STATUS: done\nCHANGES:",
      maxRetries: 2,
    });
    const promptText = "Implement the fixture 'quoted' prompt.";
    // 1-byte chunking forces every multi-byte UTF-8 character AND the stderr
    // session_id trailer to split across base64 frame boundaries.
    const driver = makeDriver({ transcriptPath: freshTranscript(), chunkBytes: 1, configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const fakeHermes = writeFakeHermes("work", { runId: RUN, sessionId: SESSION_ID, saveClaimTo, outputText: "hermes round finished — ✓ wörld\nSTATUS: done\nCHANGES: runner\nTESTS: runner\n" });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText,
        registry,
        timeoutMs: 120000,
        progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
        label: "default work round",
      }),
      240000,
      "default work round",
    );
    assert.equal(result.exitCode, 0, `exit; stderr: ${result.stderrTail}`);
    assert.equal(result.cleanupConfirmed, true);
    assert.match(result.vmId ?? "", /^vm-[0-9a-f]{8}-1$/, "one fresh driver-assigned VM");
    // US-006: the real Hermes round reports the split timing contract — VM
    // setup (create/boot → harness exec) separate from guest exec → exit, with
    // the whole round covering both.
    assert.equal(typeof result.vmSetupMs, "number", `hermes vmSetupMs; got ${String(result.vmSetupMs)}`);
    assert.equal(typeof result.harnessWallMs, "number", `hermes harnessWallMs; got ${String(result.harnessWallMs)}`);
    assert.ok((result.vmSetupMs as number) >= 0, "vmSetupMs must be a real interval");
    assert.ok((result.harnessWallMs as number) >= 0, "harnessWallMs must be a real interval");
    assert.ok(
      (result.vmSetupMs as number) + (result.harnessWallMs as number) <= (result.durationMs as number),
      `durationMs (${String(result.durationMs)}) is the whole round and must cover setup (${String(result.vmSetupMs)}) + harness (${String(result.harnessWallMs)})`,
    );
    // Plain-text final message (no pi JSON anywhere).
    assert.match(result.output, /hermes round finished — ✓ wörld/);
    assert.match(result.output, /STATUS: done/);
    assert.ok(!result.output.includes("session_id:"), "trailer stripped from the final message");
    // Session id from the AUTHORITATIVE stderr trailer (chunk-boundary safe).
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.sessionSource, "stderr");
    // Raw stdout/stderr preserved separately from the final message.
    assert.ok(result.rawStdout.includes("hermes round finished — ✓ wörld"));
    assert.ok(result.rawStderr.includes(`session_id: ${SESSION_ID}`));
    // Usage total = input + output + cache_write (cache_read excluded).
    assert.equal(result.usage.status, "ok", `usage evidence: ${JSON.stringify(result.usage)}`);
    assert.equal(result.usage.tokens, 155);

    // The step was claimed + completed through the REAL broker/step-ops.
    assert.ok(fs.existsSync(saveClaimTo), "claim captured by the synthetic guest hermes");
    const claim = JSON.parse(fs.readFileSync(saveClaimTo, "utf8")) as { stepId: string; runId: string };
    assert.equal(claim.runId, `run-${RUN}`);
    assert.equal(claim.stepId, `step-${stepRow}`);
    const row = getDbRow(rig, stepRow);
    assert.equal(row.status, "done", "typed complete advanced the step");
    assert.ok(String(row.output).includes("STATUS: done"));

    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    assert.equal(lines.filter((l) => l.method === "create").length, 1, "exactly one create");
    assert.ok(lines.some((l) => l.event === "vm_created"));
    assert.ok(lines.some((l) => l.event === "vm_closed"), "owned VM positively closed");
    assert.equal(registry.revocationCount, 1, "registry revocation exactly once");
    assert.equal(registry.getAdmission(INV_A)?.state, "revoked");
    assert.equal(registry.getLeaseByInvocation(INV_A), undefined, "lease released");
    // Harness ran the Hermes launch argv (buildHermesGuestLaunch shape) with
    // the host-identical guest cwd.
    const harness = lines.find(
      (l) =>
        l.event === "exec_started" &&
        !String(l.command).includes("tamandua-bridge") &&
        !String(l.command).includes("tamandua-guest-usage-helper"),
    );
    assert.ok(harness, "harness exec recorded");
    assert.match(
      String(harness.command),
      /'--profile' 'default' 'chat' '--max-turns' '8192' '--yolo' '-Q' '-q'/,
      `hermes launch argv; command: ${String(harness?.command)}`,
    );
    assert.ok(String(harness.command).includes("'Implement the fixture '\\''quoted'\\'' prompt.'"), "prompt shell-quoted exactly");
    assert.equal(String(harness.cwd), rig.repoDir, "host-identical guest cwd");
  });

  // ── US-006 (H1/D1): a rejected harness exec is surfaced, never swallowed ─
  it("US-006: a rejected harness exec (VM relay error) surfaces the real bounded RPC error while the guest's step completion still lands", async () => {
    const rig = makeRig("hermes-exec-reject");
    const registry = new HostInvocationRegistry();
    const saveClaimTo = path.join(rig.root, "hermes-claim-reject.json");
    const stepRow = randomUUID();
    rig.st.insertStep({
      id: stepRow,
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "hermes reject fixture task",
      status: "pending",
      type: "single",
      expects: "STATUS: done\nCHANGES:",
      maxRetries: 2,
    });
    const driver = makeDriver({
      transcriptPath: freshTranscript(),
      configGuest: GUEST_HERMES_HOME,
      configHost: rig.hermesDir,
      harnessExecError: "relay dropped final stdout frames",
      harnessExecErrorCode: -32000,
      harnessExecErrorSuppressOutput: true,
    });
    // The synthetic guest claims + completes the step through the REAL broker,
    // then exits — its stdout never reaches the host because the exec rejects.
    const fakeHermes = writeFakeHermes("work", {
      runId: RUN,
      sessionId: SESSION_ID,
      saveClaimTo,
      outputText: "STATUS: done\nCHANGES: runner\nTESTS: runner\n",
    });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "reject the harness exec after the guest completed the step",
        registry,
        timeoutMs: 120000,
        label: "rejected harness exec",
      }),
      240000,
      "rejected harness exec",
    );

    // The rejection is NOT swallowed into a clean empty round.
    assert.equal(result.output, "");
    assert.equal(result.exitCode, null, "a rejected exec has no exit code (never fabricated)");
    assert.ok(result.harnessExecError, `harnessExecError must be set; stderrTail=${JSON.stringify(result.stderrTail)}`);
    assert.match(result.harnessExecError!, /matchlock rpc error -32000/);
    assert.match(result.harnessExecError!, /relay dropped final stdout frames/);
    assert.match(result.stderrTail, /harness exec failed: matchlock rpc error -32000/, "the real error is appended to the stderr tail");
    assert.doesNotMatch(result.harnessExecError!, /\[object Object\]/);
    // The guest's authoritative step completion still landed (this is exactly
    // why the scheduler must classify from the step row, not the lost stdout).
    assert.equal(getDbRow(rig, stepRow).status, "done");
    assert.ok(fs.existsSync(saveClaimTo), "claim captured by the synthetic guest hermes");
    assert.equal(registry.revocationCount, 1, "terminal teardown still ran exactly once");
    assert.equal(registry.getAdmission(INV_A)?.state, "revoked");
  });

  it("create journal: whole effective Hermes config dir mounted RW at guest HERMES_HOME; broad host sources absent; env maps HERMES_HOME", async () => {
    const rig = makeRig("hermes-mount-journal");
    const registry = new HostInvocationRegistry();
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const fakeHermes = writeFakeHermes("plain", { runId: RUN });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "probe",
        promptText: "probe",
        registry,
        timeoutMs: 60000,
        label: "mount journal",
      }),
      120000,
      "mount journal invocation",
    );
    assert.equal(result.exitCode, 0, `exit; stderr: ${result.stderrTail}`);
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    const create = lines.find((l) => l.method === "create");
    assert.ok(create, "create request journaled");
    const params = (create!.params ?? {}) as Record<string, any>;
    const mounts = (params.vfs?.mounts ?? {}) as Record<string, { type: string; host_path: string; readonly: boolean }>;
    const guestMount = mounts[GUEST_HERMES_HOME];
    assert.ok(guestMount, "guest HERMES_HOME mount present in create params");
    assert.equal(guestMount.type, "host_fs");
    assert.equal(guestMount.host_path, fs.realpathSync(rig.hermesDir), "canonical realpath source");
    assert.equal(guestMount.readonly, false, "whole config dir mounted RW");
    const repoMount = mounts[rig.repoDir];
    assert.ok(repoMount && repoMount.readonly === false, "work repo mounted RW at identical path");
    // env: guest HERMES_HOME maps to the approved guest path (never a host path).
    const env = (params.env ?? {}) as Record<string, string>;
    assert.equal(env.HERMES_HOME, GUEST_HERMES_HOME);
    assert.equal(env.PI_CODING_AGENT_DIR, GUEST_HERMES_HOME, "planner harness override targets the hermes guest root, not /workspace/config/pi");
    // Broad host sources never exported.
    for (const [dest, m] of Object.entries(mounts)) {
      assert.ok(!String(m.host_path).startsWith(rig.st.homeDir), `operator home not a mount source (${m.host_path})`);
      assert.ok(!String(m.host_path).startsWith(path.join(rig.root, "state")), `live admin state not a mount source (${m.host_path})`);
      assert.ok(!String(m.host_path).startsWith("/root/.tamandua"), `real live admin state not a mount source (${m.host_path})`);
      assert.notEqual(m.host_path, "/root");
      assert.notEqual(m.host_path, process.env.HOME);
    }
    assert.ok(lines.some((l) => l.event === "vm_closed"));
    assert.equal(registry.revocationCount, 1);
  });

  it("named-profile work round executes with HERMES_HOME = /workspace/config/hermes/profiles/<name> (whole profile dir mounted there)", async () => {
    const rig = makeRig("hermes-named");
    const registry = new HostInvocationRegistry();
    const namedDir = path.join(rig.hermesDir, "profiles", "coder");
    fs.mkdirSync(namedDir, { recursive: true });
    fs.writeFileSync(path.join(namedDir, "config.yaml"), "terminal:\n  backend: local\n");
    const guestNamed = `${GUEST_HERMES_HOME}/profiles/coder`;
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: guestNamed, configHost: namedDir });
    const fakeHermes = writeFakeHermes("plain", { runId: RUN });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "probe",
        promptText: "named probe",
        registry,
        timeoutMs: 60000,
        submission: submission(rig.root, { env: { HERMES_HOME: namedDir }, cwd: rig.repoDir }),
        label: "named round",
      }),
      120000,
      "named round",
    );
    assert.equal(result.exitCode, 0, `exit; stderr: ${result.stderrTail}`);
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    const create = lines.find((l) => l.method === "create");
    const params = (create!.params ?? {}) as Record<string, any>;
    const mounts = (params.vfs?.mounts ?? {}) as Record<string, { host_path: string }>;
    assert.equal(mounts[guestNamed]?.host_path, fs.realpathSync(namedDir), "whole named profile dir mounted at guest profiles/<name>");
    assert.equal((params.env as Record<string, string>).HERMES_HOME, guestNamed);
    const harness = lines.find(
      (l) =>
        l.event === "exec_started" &&
        !String(l.command).includes("tamandua-bridge") &&
        !String(l.command).includes("tamandua-guest-usage-helper"),
    );
    assert.ok(harness && String(harness.command).includes("'--profile' 'coder' 'chat'"), `named profile launch argv; command: ${String(harness?.command)}`);
    assert.equal(registry.revocationCount, 1);
  });

  it("missing/absent token evidence is unavailable, never a fabricated zero (no state.db)", async () => {
    const rig = makeRig("hermes-no-store");
    const registry = new HostInvocationRegistry();
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const fakeHermes = writeFakeHermes("no-store", { runId: RUN, sessionId: SESSION_ID });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "no store",
        registry,
        timeoutMs: 60000,
        label: "no-store round",
      }),
      120000,
      "no-store round",
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, SESSION_ID, "trailer still recovered");
    assert.equal(result.usage.status, "unavailable");
    assert.equal(result.usage.tokens, undefined, "unavailable token data is NEVER a fabricated zero");
    assert.ok(result.usage.evidence.length > 0);
    assert.equal(registry.revocationCount, 1);
  });

  it("no trailer → usageSkippedNoSession (incomplete accounting, never fabricated)", async () => {
    const rig = makeRig("hermes-no-trailer");
    const registry = new HostInvocationRegistry();
    // Fresh rig-local store mapping: no state.db exists, so the H2 fallback
    // genuinely finds no session row (never borrows another test's store).
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const fakeHermes = writeFakeHermes("idle", { runId: RUN });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "idle",
        registry,
        timeoutMs: 60000,
        label: "no-trailer round",
      }),
      120000,
      "no-trailer round",
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, null);
    assert.equal(result.sessionSource, null);
    assert.equal(result.usageSkippedNoSession, true);
    assert.equal(result.usage.status, "unavailable");
    assert.equal(result.usage.tokens, undefined);
    assert.equal(registry.revocationCount, 1);
  });

  it("H2/US-007: a lost session trailer recovers the round's MAPPED-STORE session and attributes its exact delta", async () => {
    const rig = makeRig("hermes-store-recovery");
    const registry = new HostInvocationRegistry();
    const storeSessionId = "sess-hermes-store-recovered-0001";
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const fakeHermes = writeFakeHermes("store-no-trailer", { runId: RUN, sessionId: storeSessionId });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "recover the store session",
        registry,
        timeoutMs: 60000,
        label: "store-recovery round",
      }),
      120000,
      "store-recovery round",
    );
    assert.equal(result.exitCode, 0, `exit; stderr: ${result.stderrTail}`);
    // The trailer is genuinely absent from every captured stream.
    assert.ok(!result.rawStderr.includes("session_id:"), "no stderr trailer");
    assert.ok(!result.rawStdout.includes("session_id:"), "no stdout trailer");
    // The session + usage come from the round's OWN newly created store row.
    assert.equal(result.sessionId, storeSessionId);
    assert.equal(result.sessionSource, "store");
    assert.ok(!result.usageSkippedNoSession, "a session that exists is never reported unavailable");
    assert.equal(result.usage.status, "ok", `usage evidence: ${JSON.stringify(result.usage)}`);
    assert.equal(result.usage.tokens, 155, "input 100 + output 50 + cache_write 5; cache_read 9999 excluded");
    // The store read happened INSIDE the VM (guest helper exec), never host-side.
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    const helperExec = lines.find(
      (l) => l.event === "exec_started" && String(l.command).includes("tamandua-guest-usage-helper"),
    );
    assert.ok(helperExec, "the in-VM usage helper ran as a guest exec");
    assert.equal(registry.revocationCount, 1);
  });

  it("H2/US-007: with a pre-existing store row, only the round's own NEW row is attributed (never a borrowed session)", async () => {
    const rig = makeRig("hermes-store-populated");
    const registry = new HostInvocationRegistry();
    const storeSessionId = "sess-hermes-store-new-round";
    // A previous round's row already exists in the mapped store. Written
    // host-side ON PURPOSE as a TEST FIXTURE (the production runner never does).
    const { DatabaseSync } = await import("node:sqlite");
    fs.mkdirSync(rig.hermesDir, { recursive: true });
    const fixtureDb = new DatabaseSync(path.join(rig.hermesDir, "state.db"));
    fixtureDb.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER)",
    );
    fixtureDb
      .prepare("INSERT INTO sessions (id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?)")
      .run("sess-previous-round", 7000, 1000, 5, 0);
    fixtureDb.close();
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const fakeHermes = writeFakeHermes("store-no-trailer", { runId: RUN, sessionId: storeSessionId });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "recover only the new row",
        registry,
        timeoutMs: 60000,
        label: "populated-store recovery round",
      }),
      120000,
      "populated-store recovery round",
    );
    assert.equal(result.exitCode, 0, `exit; stderr: ${result.stderrTail}`);
    assert.equal(result.sessionId, storeSessionId, "the round's own new row, not the pre-existing one");
    assert.equal(result.sessionSource, "store");
    assert.equal(result.usage.status, "ok");
    assert.equal(result.usage.tokens, 155, "delta equals the round's store total, never the pre-existing row");
    assert.equal(registry.revocationCount, 1);
  });

  it("H2/US-007: a NULL-token store row is ambiguous (session recovered, no fabricated zero)", async () => {
    const rig = makeRig("hermes-store-null");
    const registry = new HostInvocationRegistry();
    const storeSessionId = "sess-hermes-store-null";
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const fakeHermes = writeFakeHermes("store-null-tokens", { runId: RUN, sessionId: storeSessionId });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "null tokens",
        registry,
        timeoutMs: 60000,
        label: "null-token round",
      }),
      120000,
      "null-token round",
    );
    assert.equal(result.exitCode, 0, `exit; stderr: ${result.stderrTail}`);
    assert.equal(result.sessionId, storeSessionId, "the session identity is still recovered");
    assert.equal(result.sessionSource, "store");
    assert.equal(result.usage.status, "ambiguous");
    assert.equal(result.usage.tokens, undefined, "NULL token columns are never a fabricated zero");
    assert.ok(!result.usageSkippedNoSession, "the session exists, so the projection did run");
    assert.equal(registry.revocationCount, 1);
  });

  it("H2/US-007: two store rows created in one round are ambiguous — never 'newest wins'", async () => {
    const rig = makeRig("hermes-store-ambiguous");
    const registry = new HostInvocationRegistry();
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const fakeHermes = writeFakeHermes("store-two-rows", { runId: RUN, sessionId: "sess-hermes-store-first" });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "two rows",
        registry,
        timeoutMs: 60000,
        label: "two-row round",
      }),
      120000,
      "two-row round",
    );
    assert.equal(result.exitCode, 0, `exit; stderr: ${result.stderrTail}`);
    assert.equal(result.sessionId, null, "two candidates are never resolved by recency");
    assert.equal(result.sessionSource, null);
    assert.equal(result.usage.status, "ambiguous");
    assert.equal(result.usage.tokens, undefined);
    assert.equal(result.usageSkippedNoSession, true);
    assert.equal(registry.revocationCount, 1);
  });

  it("H2/US-007: the projection never opens the mapped store with host-side SQLite", () => {
    const runnerSrc = fs.readFileSync(
      new URL("../../../dist/installer/matchlock/hermes-invocation-runner.js", import.meta.url),
      "utf8",
    );
    // The only SQLite open lives in the in-VM guest helper source literal.
    const marker = runnerSrc.indexOf("GUEST_USAGE_HELPER_SOURCE");
    const tickStart = runnerSrc.indexOf("`", marker);
    const tickEnd = runnerSrc.indexOf("`", tickStart + 1);
    assert.ok(marker >= 0 && tickStart > marker && tickEnd > tickStart, "guest helper source literal found");
    const helperLiteral = runnerSrc.slice(tickStart, tickEnd + 1);
    const outside = runnerSrc.slice(0, tickStart) + runnerSrc.slice(tickEnd + 1);
    assert.ok(helperLiteral.includes("DatabaseSync"), "the in-VM helper is the SQLite opener");
    assert.ok(!outside.includes("DatabaseSync"), "no host-side SQLite open outside the in-VM helper");
    assert.ok(!outside.includes("node:sqlite"), "no host-side SQLite import");
    assert.ok(!runnerSrc.includes("scanHermesStoreTokens"), "never calls the host-side mapped-store reader");
  });

  it("suite-capable hermes work round records a real integer-exit row in the host suite store under the canonical namespace", async () => {
    const rig = makeRig("hermes-suite");
    const registry = new HostInvocationRegistry();
    const storePath = path.join(rig.root, "host-suite.sqlite");
    const stepRow = randomUUID();
    rig.st.insertStep({
      id: stepRow,
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "suite fixture",
      status: "pending",
      type: "single",
      maxRetries: 2,
    });
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const fakeHermes = writeFakeHermes("work", { runId: RUN, stepId: "implement", runSuite: true, repoDir: rig.repoDir });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "Run the suite and report.",
        registry,
        timeoutMs: 180000,
        suite: { storePath, namespace: NS, admittedRoots: [fs.realpathSync(rig.repoDir)] },
        label: "suite-capable work",
      }),
      240000,
      "suite-capable invocation",
    );
    assert.equal(result.exitCode, 0, `suite work exit; stderr: ${result.stderrTail}`);
    assert.equal(result.suiteAbsent, false);

    const store = openHostSuiteStore(storePath);
    try {
      assert.equal(store.resultCount(), 1, "one persisted suite row");
      const nsId = guestSuiteNamespaceId(NS);
      assert.ok(store.getNamespace(nsId), "namespace registered under its canonical id");
      const evidence = store.queryMergeEvidence({
        namespaceId: nsId,
        originRepo: fs.realpathSync(rig.repoDir),
        treeHash: committedTreeHash(rig.repoDir) ?? "",
        cmdHash: computeCmdHash("echo suite-marker-ok"),
      });
      assert.ok(evidence, "suite row resolvable under the canonical namespace + identity");
      assert.equal(evidence!.exit_code, 0, "recorded exit is the REAL integer exit 0");
    } finally {
      store.close();
    }
    assert.equal(registry.revocationCount, 1);
  });

  it("US-001: a supplied host merge service is forwarded to the broker and serves merge.authorize; without one the op refuses UNSUPPORTED (no Git)", async () => {
    // Use the narrow, non-root fixture base so this case runs under the
    // non-root operator (the /root legacy base is the documented baseline
    // EACCES host class).
    const rig = makeRig("hermes-merge-probe", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const driver = makeDriver({
      transcriptPath: freshTranscript(),
      configGuest: GUEST_HERMES_HOME,
      configHost: rig.hermesDir,
    });
    const authorizeRequests: unknown[] = [];
    const fakeMerge: HostMergeServices = {
      async authorize(_binding, _claim, request) {
        authorizeRequests.push(request);
        // Refuse in the host service BEFORE any guest Git: the guest CLI then
        // prints the refusal and exits non-zero, proving the exact scoped op
        // reached the injected host service through the broker.
        return { ok: false, code: "MERGE_TIP", message: "synthetic merge refusal (no git)" };
      },
      async report() {
        return { ok: false, code: "MERGE_SERVICE", message: "report not expected" };
      },
      revokeAuthority() {
        /* terminal revocation is host-owned; nothing to release in the fake */
      },
    };
    const fakeHermes = writeFakeHermes("merge-probe", {
      runId: RUN,
      sessionId: SESSION_ID,
      repoDir: rig.repoDir,
    });

    // 1. With the merge service wired, merge.authorize is served by it.
    const withMerge = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "Attempt the scoped merge.",
        registry,
        timeoutMs: 120000,
        merge: fakeMerge,
        label: "merge-capable work",
      }),
      240000,
      "merge-capable invocation",
    );
    assert.equal(withMerge.exitCode, 0, `merge-capable exit; stderr: ${withMerge.stderrTail}`);
    assert.equal(withMerge.suiteAbsent, true, "merge-only fixture is not suite-capable");
    assert.equal(authorizeRequests.length, 1, "the injected host merge service served merge.authorize");
    assert.match(
      `${withMerge.output}\n${withMerge.stderrTail}`,
      /synthetic merge refusal \(no git\)/,
      "the host service refusal round-trips to the guest CLI",
    );

    // 2. Without a merge service the broker refuses the op UNSUPPORTED and no
    //    host service is reachable — the guest CLI never touches Git.
    const withoutMerge = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_B,
        kind: "work",
        promptText: "Attempt the scoped merge without host wiring.",
        registry,
        timeoutMs: 120000,
        label: "merge-absent work",
      }),
      240000,
      "merge-absent invocation",
    );
    assert.equal(withoutMerge.exitCode, 0, `merge-absent exit; stderr: ${withoutMerge.stderrTail}`);
    assert.match(
      `${withoutMerge.output}\n${withoutMerge.stderrTail}`,
      /host merge service is absent/,
      "an absent merge service refuses UNSUPPORTED (no fallback, no Git)",
    );
  });

  it("US-001: runProductionHermesRound forwards a supplied host merge context via createMergeServiceForContext (source contract)", () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
    );
    const src = fs.readFileSync(
      path.join(repoRoot, "src", "installer", "matchlock", "scheduler-matchlock.ts"),
      "utf-8",
    );
    const start = src.indexOf("async function runProductionHermesRound");
    assert.ok(start >= 0, "runProductionHermesRound must exist in scheduler-matchlock.ts");
    const body = src.slice(start);
    assert.match(
      body,
      /\.\.\.\(round\.merge \? \{ merge: createMergeServiceForContext\(round\.merge\) \} : \{\}\)/,
      "runProductionHermesRound must convert round.merge with createMergeServiceForContext and forward it to runHermesInvocation",
    );
  });

  it("timeout terminally revokes authority exactly once and positively closes the owned VM", async () => {
    const rig = makeRig("hermes-timeout");
    const registry = new HostInvocationRegistry();
    const fakeHermes = writeFakeHermes("sleep", { runId: RUN, sleepMs: 30000 });
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "slow fixture",
        registry,
        timeoutMs: 1500,
        label: "timeout",
      }),
      60000,
      "timeout invocation",
    );
    assert.equal(result.timedOut, true, "round recorded as timed out");
    assert.equal(result.exitCode, null);
    assert.equal(registry.revocationCount, 1, "revoked exactly once on timeout");
    assert.equal(registry.getLeaseByInvocation(INV_A), undefined, "lease released");
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    assert.ok(lines.some((l) => l.event === "vm_closed"), "owned VM positively closed after timeout");
  });

  it("cancel (AbortSignal) revokes authority exactly once, cancels the exact exec and positively closes the VM", async () => {
    const rig = makeRig("hermes-cancel");
    const registry = new HostInvocationRegistry();
    const fakeHermes = writeFakeHermes("sleep", { runId: RUN, sleepMs: 30000 });
    const driver = makeDriver({ transcriptPath: freshTranscript(), configGuest: GUEST_HERMES_HOME, configHost: rig.hermesDir });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1200);
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakeHermes,
          invocationId: INV_A,
          kind: "work",
          promptText: "cancellable fixture",
          registry,
          timeoutMs: 60000,
          signal: ac.signal,
          label: "cancel",
        }),
        90000,
        "cancel invocation",
      );
      assert.equal(result.canceled, true, "round reported canceled");
      assert.equal(registry.revocationCount, 1, "revoked exactly once on cancel");
      const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
      assert.ok(lines.some((l) => l.event === "vm_closed"), "owned VM positively closed after cancel");
      assert.ok(lines.some((l) => l.event === "cancel"), "exact in-flight exec canceled");
    } finally {
      clearTimeout(timer);
    }
  });

  it("close-before-create (already-aborted signal) performs NO VM create and revokes once", async () => {
    const rig = makeRig("hermes-close-before-create");
    const registry = new HostInvocationRegistry();
    const fakeHermes = writeFakeHermes("idle", { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    const ac = new AbortController();
    ac.abort();
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakeHermes,
        invocationId: INV_A,
        kind: "work",
        promptText: "never creates",
        registry,
        timeoutMs: 30000,
        signal: ac.signal,
        label: "close-before-create",
      }),
      60000,
      "close-before-create",
    );
    assert.equal(result.canceled, true);
    assert.equal(result.vmId, null, "no VM was ever created");
    // US-006: a pre-create cancel never fabricates a harness/setup interval —
    // an absent timing signal is what keeps the round out of the classifier.
    assert.equal(result.harnessWallMs, undefined, "no fabricated harnessWallMs before any VM/harness");
    assert.equal(result.vmSetupMs, undefined, "no fabricated vmSetupMs before any VM create");
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    assert.equal(lines.filter((l) => l.method === "create").length, 0, "zero create requests");
    assert.equal(registry.revocationCount, 1, "admission terminally revoked even without a VM");
  });

  it("late-create-after-cancel: an abort during VM create is bounded and the late VM is positively closed (never launches work)", async () => {
    const rig = makeRig("hermes-late-create");
    const registry = new HostInvocationRegistry();
    const fakeHermes = writeFakeHermes("idle", { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript(), createDelayMs: 1500 });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 300);
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakeHermes,
          invocationId: INV_A,
          kind: "work",
          promptText: "late-create fixture",
          registry,
          timeoutMs: 60000,
          signal: ac.signal,
          createTimeoutMs: 10000,
          requestTimeoutMs: 10000,
          label: "late-create",
        }),
        90000,
        "late-create-after-cancel",
      );
      assert.equal(result.canceled, true);
      const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
      assert.equal(lines.filter((l) => l.event === "vm_created").length, 1, "create was accepted (late VM)");
      assert.equal(lines.filter((l) => l.method === "create").length, 1);
      assert.ok(lines.some((l) => l.event === "vm_closed"), "the late VM was positively closed (bounded cleanup)");
      const harnessStarts = lines.filter((l) => l.event === "exec_started" && !String(l.command).includes("tamandua-bridge"));
      assert.equal(harnessStarts.length, 0, "late VM never launched harness work");
      assert.equal(registry.revocationCount, 1);
    } finally {
      clearTimeout(timer);
    }
  });

  it("guest EOF (bridge exits before handshake) refuses before work, revokes once and cleans up", async () => {
    const rig = makeRig("hermes-eof");
    const registry = new HostInvocationRegistry();
    const fakeHermes = writeFakeHermes("idle", { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript(), bridgeExit: "1" });
    await assert.rejects(
      withTimeout(
        invoke({
          rig,
          driver,
          fakeHermes,
          invocationId: INV_A,
          kind: "work",
          promptText: "should never run",
          registry,
          timeoutMs: 30000,
          label: "EOF",
        }),
        120000,
        "EOF invocation",
      ),
      (err: unknown) => err instanceof HermesInvocationError && err.code === "guest_bridge_unavailable",
      "bridge EOF must refuse the invocation",
    );
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    const harnessStarts = lines.filter((l) => l.event === "exec_started" && !String(l.command).includes("tamandua-bridge"));
    assert.equal(harnessStarts.length, 0, "no harness work after bridge EOF");
    assert.equal(registry.revocationCount, 1);
  });

  // ── MTLK-CLEANUP US-008: rewritten contradictory assertion ──────────────
  // MTLK-HERMES-EXEC's source title "cleanup-failure propagation: an
  // unconfirmable close surfaces matchlock_cleanup_failed, never a swallow"
  // asserted that ANY unconfirmable close is fatal. MTLK-PI-EXEC's
  // post-harness close/dispose policy (pi US-005) makes a close/dispose
  // failure AFTER the harness process exited non-fatal (round kept + orphan
  // handoff), so this title was split: the before-harness half stays fatal
  // here and the post-harness half moved to the US-008 non-fatal test below.
  it("US-008: a close failure BEFORE the hermes harness exits remains fatal and surfaces the serialized cause", async () => {
    const rig = makeRig("hermes-cleanup-fail", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const fakeHermes = writeFakeHermes("idle", { runId: RUN });
    const transcript = freshTranscript();
    // A bridge exit before the handshake refuses the invocation BEFORE any
    // harness exec starts, so the cleanup close runs before any harness exit.
    const driver = makeDriver({ transcriptPath: transcript, bridgeExit: "1", closeFail: 5 });
    let surfaced: MatchlockRunnerError | null = null;
    await assert.rejects(
      withTimeout(
        invoke({
          rig,
          driver,
          fakeHermes,
          invocationId: INV_A,
          kind: "work",
          promptText: "cleanup fail fixture",
          registry,
          timeoutMs: 60000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          label: "cleanup failure",
        }),
        120000,
        "cleanup-failure invocation",
      ),
      (err: unknown) => {
        if (err instanceof MatchlockRunnerError) surfaced = err;
        return err instanceof MatchlockRunnerError && err.code === "matchlock_cleanup_failed";
      },
      "a close failure before the harness exited must surface matchlock_cleanup_failed",
    );
    const message = surfaced!.message;
    assert.match(message, /vm close\/dispose:/);
    assert.match(message, /name=MatchlockRpcError/);
    assert.match(message, /code=-32000/);
    assert.match(message, /message=close failed \(fixture\)/);
    assert.match(message, /phase=close/);
    assert.doesNotMatch(message, /\[object Object\]/);
    const created = readTranscript(transcript).find((l) => l.event === "vm_created");
    assert.ok(created && typeof created.id === "string", "the fixture VM was created");
    assert.match(message, new RegExp(`vmId=${created!.id}`), "serialized cleanup detail carries the owned vmId");
    // No harness exit happened, so no post-harness handoff was written.
    assert.equal(
      readOrphanVms({ runId: RUN, runRoot: rig.progressRunRoot }).length,
      0,
      "no orphan record before the harness exits",
    );
    assert.equal(registry.revocationCount, 1, "authority revoked before the failed close");
  });

  // ── MTLK-CLEANUP US-008 AC2: create/probe/exec failures stay typed+fatal
  it("US-008: a pre-harness create/probe/exec failure still throws the typed hermes/runner infra error and never writes an orphan", async () => {
    const rig = makeRig("hermes-preharness-fatal", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const fakeHermes = writeFakeHermes("idle", { runId: RUN });
    const transcript = freshTranscript();
    // A guest HELLO build-version mismatch refuses the bridge handshake BEFORE
    // any harness exec — a pre-harness (create/probe) class failure. It must
    // stay typed + fatal exactly like the pi runner's pre-harness path.
    const driver = makeDriver({
      transcriptPath: transcript,
      configGuest: GUEST_HERMES_HOME,
      configHost: rig.hermesDir,
    });
    let surfaced: MatchlockRunnerError | null = null;
    await assert.rejects(
      withTimeout(
        invoke({
          rig,
          driver,
          fakeHermes,
          invocationId: INV_A,
          kind: "work",
          promptText: "pre-harness fatal fixture",
          registry,
          timeoutMs: 30000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          guestEnvOverrides: { TAMANDUA_GUEST_BUILD_VERSION: "stale-build-000" },
          label: "pre-harness fatal",
        }),
        120000,
        "pre-harness fatal invocation",
      ),
      (err: unknown) => {
        if (err instanceof MatchlockRunnerError) surfaced = err;
        return err instanceof HermesInvocationError && err.code === "guest_bridge_unavailable";
      },
      "a create/probe/exec failure keeps its typed hermes/runner infra error",
    );
    assert.ok(surfaced instanceof MatchlockRunnerError, "the typed runner infra error is preserved");
    assert.match(surfaced!.message, /handshake refused before work/, "the refusal names the pre-harness phase");
    assert.doesNotMatch(surfaced!.message, /\[object Object\]/, "the refusal is serialized");
    const harnessStarts = readTranscript(transcript).filter(
      (l) => l.event === "exec_started" && !String(l.command).includes("tamandua-bridge"),
    );
    assert.equal(harnessStarts.length, 0, "no harness work after a pre-harness refusal");
    assert.equal(
      readOrphanVms({ runId: RUN, runRoot: rig.progressRunRoot }).length,
      0,
      "a pre-harness failure is fatal and writes no orphan handoff",
    );
  });

  it("unpinned policy refuses BEFORE any VM create (image identity required)", async () => {
    const rig = makeRig("hermes-unpinned");
    const registry = new HostInvocationRegistry();
    const fakeHermes = writeFakeHermes("idle", { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    await assert.rejects(
      withTimeout(
        runHermesInvocation({
          policy: fixturePolicy(rig, { resolvedImageDigest: undefined, resolvedImageConfigDigest: undefined }),
          identity: identity(INV_A),
          kind: "work",
          promptText: "unpinned",
          workingDirectoryForHarness: rig.repoDir,
          timeoutMs: 30000,
          submission: submission(rig.root, { env: { HERMES_HOME: rig.hermesDir }, cwd: rig.repoDir }),
          hermes: { binary: fakeHermes },
          registry,
          helperPackHostPath: sharedPack.packDir,
          imagePath: `${NODE_DIR}:/usr/bin:/bin`,
          rpcBinaryPath: NODE_BIN,
          rpcArgs: [driver.driverPath],
          rpcEnv: driver.env,
          closeTimeoutSeconds: 25,
          onLog: () => {},
        }),
        60000,
        "unpinned invocation",
      ),
      (err: unknown) => err instanceof HermesInvocationError && err.code === "image_identity_required",
      "unpinned policy must refuse before any VM create",
    );
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    assert.equal(lines.filter((l) => l.method === "create").length, 0, "zero create requests");
    assert.equal(registry.admissionCount, 0, "pin refusal happens before any registry admission");
    assert.equal(registry.revocationCount, 0, "nothing admitted, nothing to revoke");
  });

  // ── US-005 (MATCHLOCK-OBS finding 2): capture VM evidence + remove the VM ─
  it("US-005: the hermes runner source keeps no direct node:child_process import", () => {
    const src = fs.readFileSync(new URL("./hermes-invocation-runner.ts", import.meta.url), "utf8");
    assert.doesNotMatch(
      src,
      /from\s+["']node:child_process["']/,
      "the hermes runner must not import node:child_process directly",
    );
    assert.doesNotMatch(
      src,
      /require\(\s*["']node:child_process["']\s*\)/,
      "the hermes runner must not require node:child_process directly",
    );
    assert.match(
      src,
      /from\s+["']\.\/vm-evidence\.js["']/,
      "the hermes runner routes its spawn through the vm-evidence seam",
    );
  });

  // ── MTLK-CLEANUP US-008: a post-harness close failure is non-fatal ─────
  it("US-008: a post-harness close failure keeps the round result, logs one WARN with the serialized cause and records one orphan", async () => {
    const rig = makeRig("hermes-cleanup-nonfatal", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const stepRow = randomUUID();
    rig.st.insertStep({
      id: stepRow,
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "fixture task",
      expects: "STATUS: done\nCHANGES:",
      status: "pending",
      type: "single",
      maxRetries: 2,
    });
    const fakeHermes = writeFakeHermes("work", { runId: RUN });
    const transcript = freshTranscript();
    const driver = makeDriver({
      transcriptPath: transcript,
      closeFail: 5,
      configGuest: GUEST_HERMES_HOME,
      configHost: rig.hermesDir,
    });
    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const onLog = (level: string, message: string, fields?: Record<string, unknown>): void => {
      logs.push({ level, message, fields });
    };
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakeHermes,
          invocationId: INV_A,
          kind: "work",
          promptText: "post-harness close failure fixture",
          registry,
          timeoutMs: 180000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          onLog,
          label: "post-harness close failure",
        }),
        240000,
        "post-harness close failure invocation",
      );

      // 1. The round result is KEPT (not thrown) with its evidence intact.
      assert.equal(result.exitCode, 0, `round exit kept; stderr: ${result.stderrTail}`);
      assert.match(result.output, /work round finished/, "round output kept");
      assert.equal(typeof result.stderrTail, "string", "round stderr tail kept");
      assert.equal(getDbRow(rig, stepRow).status, "done", "the completed step evidence is kept");
      assert.equal(result.cleanupConfirmed, false, "cleanup is not confirmed for a failed close");
      assert.equal(result.vmRemoved, undefined, "vmRemoved is untouched when no removal happened");

      // 2. The bounded serialized vmCleanupFailure carries phase + owned vmId + cause.
      const created = readTranscript(transcript).find((l) => l.event === "vm_created");
      assert.ok(created && typeof created.id === "string", "the fixture VM was created");
      const failure = result.vmCleanupFailure ?? "";
      assert.match(failure, /phase=close/, "serialized failure carries the failing phase");
      assert.match(failure, /name=MatchlockRpcError/, "serialized failure names the error");
      assert.match(failure, /code=-32000/, "serialized failure carries the RPC code");
      assert.match(failure, /message=close failed \(fixture\)/, "serialized failure carries the message");
      assert.match(failure, new RegExp(`vmId=${created!.id}`), "serialized failure carries the owned vmId");
      assert.doesNotMatch(failure, /\[object Object\]/, "the incident's [object Object] is impossible");
      assert.ok(failure.length <= 2048, "vmCleanupFailure is byte-bounded");

      // 3. Exactly one WARN carries the serialized cause with vmId + phase.
      const closeWarns = logs.filter(
        (l) => l.level === "warn" && /post-harness vm close\/dispose failed/.test(l.message),
      );
      assert.equal(closeWarns.length, 1, "exactly one post-harness close WARN");
      assert.equal(closeWarns[0].fields?.vmId, created!.id, "WARN names the vmId");
      assert.equal(closeWarns[0].fields?.phase, "close", "WARN names the phase");
      assert.match(String(closeWarns[0].fields?.error ?? ""), /code=-32000/, "WARN carries the serialized cause");

      // 4. Exactly one orphan record was written for that vmId.
      const orphans = readOrphanVms({ runId: RUN, runRoot: rig.progressRunRoot });
      assert.equal(orphans.length, 1, "one orphan record for the handed-off VM");
      assert.equal(orphans[0].vmId, created!.id, "orphan record is keyed by the owned vmId");
      assert.equal(orphans[0].runId, RUN, "orphan record carries the bare run id");
      assert.equal(orphans[0].invocationId, INV_A, "orphan record carries the invocation id");
      assert.equal(orphans[0].phase, "close", "orphan record carries the failing phase");
      assert.doesNotMatch(orphans[0].error, /\[object Object\]/, "orphan record carries the serialized cause");
      assert.equal(registry.revocationCount, 1, "authority revoked before the failed close");
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("US-005: probe and work rounds capture VM evidence and remove the VM after a confirmed close", async () => {
    const rig = makeRig("hermes-vm-reap", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const removalHome = tmpDir("tamandua-hermes-runner-vmhome-");
    const rmJournal = path.join(tmpDir("tamandua-hermes-runner-rm-"), "rm.jsonl");
    const fakeCli = writeFakeMatchlockCli({ journalPath: rmJournal });
    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const onLog = (level: string, message: string, fields?: Record<string, unknown>): void => {
      logs.push({ level, message, fields });
    };
    try {
      const probeDriver = makeDriver({
        transcriptPath: freshTranscript(),
        configGuest: GUEST_HERMES_HOME,
        configHost: rig.hermesDir,
      });
      const probeHermes = writeFakeHermes("idle", { runId: RUN });
      const probe = await withTimeout(
        invoke({
          rig,
          driver: probeDriver,
          fakeHermes: probeHermes,
          invocationId: INV_A,
          kind: "probe",
          promptText: "Run the packed tamandua skill-path and report the path.",
          registry,
          timeoutMs: 60000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          rpcBinaryPath: fakeCli,
          rpcArgs: ["rpc"],
          rpcEnv: {
            ...probeDriver.env,
            HOME: removalHome,
            FAKE_VM_STATE_ROOT: removalHome,
            FAKE_DRIVER_PATH: probeDriver.driverPath,
          },
          onLog,
          label: "probe reap",
        }),
        120000,
        "probe reap invocation",
      );
      assert.equal(probe.exitCode, 0, `probe exit; stderr: ${probe.stderrTail}`);
      assert.equal(probe.cleanupConfirmed, true);
      assert.ok(probe.vmId, "probe created an owned VM");
      assert.equal(probe.vmRemoved, true, "probe VM removed after the confirmed close");
      const probeDest = path.join(rig.progressRunRoot, RUN, "matchlock", probe.vmId!);
      assert.equal(probe.vmLogsCopiedTo, probeDest, "probe evidence copied into the run evidence dir");
      assert.ok(fs.existsSync(path.join(probeDest, "config.json")), "probe config.json captured");
      assert.ok(fs.existsSync(path.join(probeDest, "logs", "guest.log")), "probe logs captured");
      assert.equal(
        fs.existsSync(path.join(removalHome, ".matchlock", "vms", probe.vmId!)),
        false,
        "probe VM state dir removed",
      );

      // WORK: fresh driver + its own VM. No progressResource override so the
      // default runRoot (resolveRunRoot) also produces the exact destination.
      const stepRow = randomUUID();
      rig.st.insertStep({
        id: stepRow,
        runId: RUN,
        stepId: "implement",
        agentId: AGENT,
        stepIndex: 0,
        inputTemplate: "fixture task",
        expects: "STATUS: done\nCHANGES:",
        status: "pending",
        type: "single",
        maxRetries: 2,
      });
      const workDriver = makeDriver({
        transcriptPath: freshTranscript(),
        configGuest: GUEST_HERMES_HOME,
        configHost: rig.hermesDir,
      });
      const workHermes = writeFakeHermes("work", { runId: RUN });
      const work = await withTimeout(
        invoke({
          rig,
          driver: workDriver,
          fakeHermes: workHermes,
          invocationId: INV_B,
          kind: "work",
          promptText: "Implement the fixture.",
          registry,
          timeoutMs: 120000,
          rpcBinaryPath: fakeCli,
          rpcArgs: ["rpc"],
          rpcEnv: {
            ...workDriver.env,
            HOME: removalHome,
            FAKE_VM_STATE_ROOT: removalHome,
            FAKE_DRIVER_PATH: workDriver.driverPath,
          },
          onLog,
          label: "work reap",
        }),
        180000,
        "work reap invocation",
      );
      assert.equal(work.exitCode, 0, `work exit; stderr: ${work.stderrTail}`);
      assert.equal(work.cleanupConfirmed, true);
      assert.equal(getDbRow(rig, stepRow).status, "done", "the work round still completed its step");
      assert.ok(work.vmId, "work created an owned VM");
      assert.notEqual(work.vmId, probe.vmId, "probe and work used different VMs");
      assert.equal(work.vmRemoved, true, "work VM removed after the confirmed close");
      const workDest = path.join(rig.progressRunRoot, RUN, "matchlock", work.vmId!);
      assert.equal(work.vmLogsCopiedTo, workDest, "work evidence destination (default runRoot)");
      assert.ok(fs.existsSync(path.join(workDest, "config.json")), "work config.json captured");
      assert.equal(
        fs.existsSync(path.join(removalHome, ".matchlock", "vms", work.vmId!)),
        false,
        "work VM state dir removed",
      );

      const journal = readRmJournal(rmJournal);
      assert.equal(journal.length, 2, "exactly one rm per round (probe + work)");
      for (const vmId of [probe.vmId!, work.vmId!]) {
        const entry = journal.find((e) => e.vmId === vmId);
        assert.ok(entry, `rm journal entry for ${vmId}`);
        assert.deepEqual(entry!.argv, ["rm", vmId], `exact rm argv for ${vmId}`);
        assert.equal(entry!.home, removalHome, `rm child HOME is the effective matchlock HOME for ${vmId}`);
        assert.equal(entry!.stateDirExisted, true, `VM state dir existed at rm time for ${vmId}`);
      }
      assert.ok(
        logs.some((l) => l.level === "info" && String(l.fields?.vmId ?? "") === String(probe.vmId)),
        "success is logged via onLog naming the vmId",
      );
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("US-005: a hermes reaper failure is reported on the result and logged at warn without failing the round", async () => {
    const rig = makeRig("hermes-vm-reap-fail", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const removalHome = tmpDir("tamandua-hermes-runner-vmhome-");
    const rmJournal = path.join(tmpDir("tamandua-hermes-runner-rm-"), "rm.jsonl");
    const fakeCli = writeFakeMatchlockCli({
      journalPath: rmJournal,
      rmExit: 7,
      rmStderr: "fixture: rm refused by test wrapper\n",
    });
    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const driver = makeDriver({
      transcriptPath: freshTranscript(),
      configGuest: GUEST_HERMES_HOME,
      configHost: rig.hermesDir,
    });
    const fakeHermes = writeFakeHermes("idle", { runId: RUN });
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakeHermes,
          invocationId: INV_A,
          kind: "work",
          promptText: "reaper failure fixture",
          registry,
          timeoutMs: 60000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          rpcBinaryPath: fakeCli,
          rpcArgs: ["rpc"],
          rpcEnv: {
            ...driver.env,
            HOME: removalHome,
            FAKE_VM_STATE_ROOT: removalHome,
            FAKE_DRIVER_PATH: driver.driverPath,
          },
          onLog: (level, message, fields) => logs.push({ level, message, fields }),
          label: "reaper failure",
        }),
        120000,
        "reaper failure invocation",
      );
      assert.equal(result.exitCode, 0, "the round still succeeded");
      assert.equal(result.cleanupConfirmed, true, "a removal failure never changes cleanupConfirmed");
      assert.equal(result.vmRemoved, false, "removal failure reported on the result");
      assert.match(result.vmRemovalError ?? "", /rm refused by test wrapper/, "bounded removalError surfaced");
      assert.ok(result.vmId, "VM id present");
      const dest = path.join(rig.progressRunRoot, RUN, "matchlock", result.vmId!);
      assert.equal(result.vmLogsCopiedTo, dest, "evidence was captured before the failed rm");
      assert.ok(fs.existsSync(path.join(dest, "config.json")), "copied evidence is retained on failure");
      assert.equal(
        fs.existsSync(path.join(removalHome, ".matchlock", "vms", result.vmId!)),
        true,
        "a failed removal leaves the VM state dir in place",
      );
      const journal = readRmJournal(rmJournal);
      assert.equal(journal.length, 1, "rm attempted exactly once");
      assert.deepEqual(journal[0].argv, ["rm", result.vmId]);
      assert.equal(journal[0].home, removalHome);
      assert.ok(
        logs.some((l) => l.level === "warn" && String(l.fields?.vmId ?? "") === String(result.vmId)),
        "the removal failure is logged via onLog at warn naming the vmId",
      );
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("US-005/US-008: no VM is removed when the close was never positively confirmed (the VM is handed to the reaper instead)", async () => {
    const rig = makeRig("hermes-vm-reap-unconfirmed", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const removalHome = tmpDir("tamandua-hermes-runner-vmhome-");
    const rmJournal = path.join(tmpDir("tamandua-hermes-runner-rm-"), "rm.jsonl");
    const fakeCli = writeFakeMatchlockCli({ journalPath: rmJournal });
    const driver = makeDriver({
      transcriptPath: freshTranscript(),
      closeFail: 5,
      configGuest: GUEST_HERMES_HOME,
      configHost: rig.hermesDir,
    });
    const fakeHermes = writeFakeHermes("idle", { runId: RUN });
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakeHermes,
          invocationId: INV_A,
          kind: "work",
          promptText: "unconfirmed close fixture",
          registry,
          timeoutMs: 60000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          rpcBinaryPath: fakeCli,
          rpcArgs: ["rpc"],
          rpcEnv: {
            ...driver.env,
            HOME: removalHome,
            FAKE_VM_STATE_ROOT: removalHome,
            FAKE_DRIVER_PATH: driver.driverPath,
          },
          label: "unconfirmed close",
        }),
        120000,
        "unconfirmed close invocation",
      );
      // US-008: post-harness close failure is non-fatal, so the round is kept.
      assert.equal(result.cleanupConfirmed, false, "an unconfirmed close is not a confirmed cleanup");
      assert.match(result.vmCleanupFailure ?? "", /phase=close/, "bounded close failure reported on the result");
      assert.equal(result.vmRemoved, undefined, "never remove a VM whose close was not confirmed");
      assert.equal(readRmJournal(rmJournal).length, 0, "no rm when the close was never confirmed");
      const orphans = readOrphanVms({ runId: RUN, runRoot: rig.progressRunRoot });
      assert.equal(orphans.length, 1, "the unconfirmed VM is handed to the reaper");
      assert.equal(orphans[0].matchlockHome, removalHome, "orphan record carries the effective matchlock HOME");
      assert.equal(
        fs.existsSync(path.join(removalHome, ".matchlock", "vms")),
        true,
        "the VM state dir is retained (never removed on an unconfirmed close)",
      );
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("US-005: a hermes dispose-only teardown (no VM, no confirmed close) never invokes the reaper", async () => {
    const rig = makeRig("hermes-vm-reap-dispose", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const removalHome = tmpDir("tamandua-hermes-runner-vmhome-");
    const rmJournal = path.join(tmpDir("tamandua-hermes-runner-rm-"), "rm.jsonl");
    const fakeCli = writeFakeMatchlockCli({ journalPath: rmJournal });
    const driver = makeDriver({
      transcriptPath: freshTranscript(),
      configGuest: GUEST_HERMES_HOME,
      configHost: rig.hermesDir,
    });
    const fakeHermes = writeFakeHermes("idle", { runId: RUN });
    const ac = new AbortController();
    ac.abort();
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakeHermes,
          invocationId: INV_A,
          kind: "work",
          promptText: "dispose-only fixture",
          registry,
          timeoutMs: 60000,
          signal: ac.signal,
          rpcBinaryPath: fakeCli,
          rpcArgs: ["rpc"],
          rpcEnv: {
            ...driver.env,
            HOME: removalHome,
            FAKE_VM_STATE_ROOT: removalHome,
            FAKE_DRIVER_PATH: driver.driverPath,
          },
          label: "dispose-only",
        }),
        120000,
        "dispose-only invocation",
      );
      assert.equal(result.canceled, true);
      assert.equal(result.vmId, null, "no VM was ever created");
      assert.equal(result.vmRemoved, undefined, "no reap outcome is recorded for a dispose-only teardown");
      assert.equal(readRmJournal(rmJournal).length, 0, "no rm on a dispose-only teardown");
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });
});

/** Read a step row from the currently-open isolated DB. */
function getDbRow(rig: FixtureRig, stepRowId: string): Record<string, unknown> {
  void rig;
  return getDb().prepare("SELECT status, output, run_id FROM steps WHERE id = ?").get(stepRowId) as Record<string, unknown>;
}
