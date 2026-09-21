/**
 * pi-invocation-runner.test.ts — US-001 (serial lane).
 *
 * The runner executes ONE opted-in pi invocation in a FRESH VM. Real VMs are
 * NOT available in this lane (they belong to the separate synthetic whole-path
 * gate), so this suite drives the REAL production stack down to the RPC
 * boundary and substitutes ONLY the "VM" itself with an explicitly labelled
 * MOCK: a local-VM RPC driver (a scripted `matchlock rpc` child that executes
 * every exec command as a REAL local subprocess with the VM create env, and
 * maps the guest /workspace/runtime pack path onto the real host pack). Every
 * other hop is real:
 *
 *   real MatchlockController + real RPC client
 *     → mock local-VM driver (exec_pipe = real local subprocess, base64 frames)
 *     → REAL packed guest bridge service subprocess (bin/tamandua-bridge)
 *     → REAL scoped host broker + REAL NativeStepServices over an ISOLATED
 *       temp HOME/STATE/DB (schema10, TAMANDUA_TEST_GUARD=1)
 *     → REAL guest pack CLI (bin/tamandua) + packed tamandua-test engine
 *     → REAL host-owned Matchlock suite SQLite store (canonical namespace)
 *     → REAL host progress-resource document
 *
 * Nothing here is a real VM, a live daemon, a real image or a real model.
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
  runMatchlockInvocation,
  MatchlockRunnerError,
  composeGuestEnv,
  type MatchlockInvocationSuite,
  type MatchlockInvocationResult,
  type MatchlockInvocationFaults,
} from "../../../dist/installer/matchlock/pi-invocation-runner.js";
import type { ExecutionIsolation } from "../../../dist/installer/matchlock/policy.js";
import { guestSuiteNamespaceId, type GuestSuiteNamespace } from "../../../dist/installer/matchlock/guest-suite-contract.js";
import { stripGuestSuiteEnv, GUEST_SUITE_ENV_KEYS } from "../../../dist/installer/matchlock/suite-wire-env.js";
import { committedTreeHash, computeCmdHash } from "../../../dist/installer/matchlock/guest-suite-git.js";
import { PROGRESS_DOC_FILE_NAME } from "../../../dist/installer/matchlock/progress-resource.js";
import { readOrphanVms } from "../../../dist/installer/matchlock/vm-orphans.js";

// ── shared identity ────────────────────────────────────────────────────

const INV_A = "aaaaaaaa-1111-4111-8111-111111111111";
const INV_B = "bbbbbbbb-2222-4222-8222-222222222222";
const JOB = "job-11111111-1111-4111-8111-111111111111";
const DIGEST = "sha256:pi-runner-fixture-digest-000000000001";
const CONFIG_DIGEST = "sha256:pi-runner-fixture-config-000000000001";
const IMAGE_TAG = "test/synthetic-pi-runner:fixture";
const NODE_BIN = process.execPath;
const NODE_DIR = path.dirname(NODE_BIN);

// sticky isolated env (module-level handles never resolve against live state).
const sticky = createIsolatedState("pi-runner-sticky");
sticky.open();
const stickyEnv = snapshotEnv();

// One shared RO guest pack per file (deterministic; requires npm run build).
const sharedPack = buildSharedPack();

function buildSharedPack(): { root: string; packDir: string; manifest: GuestPackManifest } {
  const root = tamanduaTempDir("tamandua-pi-runner-pack-");
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
  configDir: string;
  progressRunRoot: string;
}

/**
 * Legacy fixture base of the run-83 baseline rigs, which ran under the root
 * operator account. Kept verbatim as the default so those cases are unchanged.
 */
const LEGACY_ROOT_FIXTURE_BASE = "/root/matchlock-pi-runner-fixtures";

/**
 * US-004: a NARROW descendant of the REAL operator home, computed from the
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
  "matchlock-pi-runner-fixtures",
);

function makeRig(tag: string, fixtureBase: string = WRITABLE_FIXTURE_BASE): FixtureRig {
  const st = createIsolatedState(tag);
  st.open();
  // Guest destinations may never shadow protected guest roots (/tmp etc.), so
  // the exact-path work mount lives under a NARROW fixture root below the
  // operator home (accepted exact-path semantics: a legitimate narrow
  // descendant of /root). The isolated DB/state stay under the temp st.root.
  // /root (the operator home) hosts the exact-path mount root on this vaivm
  // host; guest destinations may never shadow protected guest roots (/tmp etc.),
  // so narrow /root descendants are the accepted exact-path location.
  fs.mkdirSync(fixtureBase, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(fixtureBase, `${tag}-`));
  tempDirs.push(fixtureRoot);
  const repoDir = path.join(fixtureRoot, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-q"], repoDir);
  git(["config", "user.email", "pi-runner@test.invalid"], repoDir);
  git(["config", "user.name", "Pi Runner"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Pi runner fixture\n");
  git(["add", "README.md"], repoDir);
  git(["commit", "-q", "-m", "init"], repoDir);
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.log\n");
  git(["add", ".gitignore"], repoDir);
  git(["commit", "-q", "-m", "gitignore"], repoDir);
  const configDir = path.join(fixtureRoot, "pi-config");
  fs.mkdirSync(path.join(configDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "settings.json"), "{}");
  fs.writeFileSync(path.join(configDir, "agents", "default.md"), "synthetic agent config\n");
  // Every rig owns a running run row (claim/complete require real run state).
  st.insertRun({ workflowId: "feature-dev", status: "running" });
  return { st, root: st.root, repoDir, configDir, progressRunRoot: path.join(st.root, "state", "runs") };
}

function fixturePolicy(rig: FixtureRig, over: Partial<ExecutionIsolation> = {}): ExecutionIsolation {
  return {
    version: 2,
    backend: "matchlock",
    requestedImage: IMAGE_TAG,
    resolvedImageDigest: DIGEST,
    resolvedImageConfigDigest: CONFIG_DIGEST,
    harness: "pi",
    configurationRoot: rig.configDir,
    configurationProfile: "settings.json",
    guestConfigurationRoot: "/workspace/config/pi",
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

const NS: GuestSuiteNamespace = {
  imageContentId: "sha256:pi-runner-suite-image-0000000000000000000000",
  guestPlatform: "linux/amd64",
  helperContract: "pi-runner-helper+suite-v1",
  compatibilityFingerprint: "pi-runner-fp-01",
};

// ── mock local-VM RPC driver ───────────────────────────────────────────
// EXPLICIT MOCK: plays the role of the Matchlock VM + runtime on the RPC wire
// ONLY. exec commands run as REAL local subprocesses under the VM create env
// with /workspace/runtime translated to the host pack dir. Never presented as
// real-VM evidence.
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
const imageTag = env.FAKE_IMAGE_TAG || "test/synthetic-pi-runner:fixture";
const imageDigest = env.FAKE_IMAGE_DIGEST || "sha256:default";
const imageConfigDigest = env.FAKE_IMAGE_CONFIG_DIGEST || "sha256:default";
const runtimeRoot = env.FAKE_VM_RUNTIME_ROOT || "";
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
  if (runtimeRoot && typeof p === "string" && p.indexOf("/workspace/runtime") >= 0) {
    return p.split("/workspace/runtime").join(runtimeRoot);
  }
  return p;
}
function childEnv(over) {
  const out = {};
  for (const k of Object.keys(process.env)) out[k] = process.env[k];
  for (const k of Object.keys(over || {})) out[k] = over[k];
  if (runtimeRoot && typeof out.PATH === "string") out.PATH = out.PATH.split("/workspace/runtime").join(runtimeRoot);
  return out;
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
  // the guest already did its work. Only the harness exec is affected.
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
  if (env.FAKE_SPAWN_ERR === "1") {
    setTimeout(() => { if (!st.done) { st.done = true; sendError(id, -32000, "exec spawn error (fixture)"); } }, 10);
    return st;
  }
  const child = spawn("/bin/sh", ["-c", command], {
    cwd,
    env: childEnv(vmEnv),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  st.child = child;
  // US-006: with the reject+suppress knob the harness stdout never reaches the
  // host (the corrupted-relay case: the exec rejects with zero frames).
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
    // MATCHLOCK-OBS US-004: when the fixture opts into a mock VM state root,
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
  const dir = tamanduaTempDir("tamandua-pi-runner-driver-");
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
  if (opts.chunkBytes !== undefined) env.FAKE_STDOUT_CHUNK_BYTES = String(opts.chunkBytes);
  if (opts.createDelayMs !== undefined) env.FAKE_CREATE_DELAY_MS = String(opts.createDelayMs);
  if (opts.closeFail !== undefined) env.FAKE_CLOSE_FAIL = String(opts.closeFail);
  if (opts.bridgeExit !== undefined) env.FAKE_BRIDGE_EXIT = opts.bridgeExit;
  if (opts.harnessExecError !== undefined) env.FAKE_HARNESS_EXEC_ERROR = opts.harnessExecError;
  if (opts.harnessExecErrorCode !== undefined) env.FAKE_HARNESS_EXEC_ERROR_CODE = String(opts.harnessExecErrorCode);
  if (opts.harnessExecErrorSuppressOutput) env.FAKE_HARNESS_EXEC_ERROR_SUPPRESS_OUTPUT = "1";
  return { dir, driverPath, env };
}

/**
 * MATCHLOCK-OBS US-004: fake `matchlock` CLI serving BOTH seams the runner
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
  const dir = tmpDir("tamandua-pi-runner-matchlock-");
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

function freshTranscript(): string {
  const dir = tamanduaTempDir("tamandua-pi-runner-txn-");
  return path.join(dir, "transcript.jsonl");
}

interface TxnLine {
  method?: string;
  event?: string;
  command?: string;
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

type FakePiBehavior = "probe" | "work" | "sleep" | "idle" | "claim-only";

/** Write a synthetic-guest-pi script (MOCK harness) with canned behavior. */
function writeFakePi(behavior: FakePiBehavior, rig: FixtureRig, opts: { runId: string; stepId?: string; sleepMs?: number; runSuite?: boolean; saveClaimTo?: string }): string {
  const dir = tmpDir("tamandua-pi-runner-fakepi-");
  const file = path.join(dir, "pi");
  const runId = opts.runId;
  const L: string[] = [];
  L.push("#!/usr/bin/env node");
  L.push("const cp = require('node:child_process');");
  L.push("const fs = require('node:fs');");
  L.push("const path = require('node:path');");
  L.push("const argv = process.argv;");
  L.push("const prompt = argv[argv.length - 1];");
  if (behavior === "sleep") {
    L.push("process.stdin.resume();");
    L.push(`setTimeout(() => { process.exit(0); }, ${opts.sleepMs ?? 5000});`);
  } else if (behavior === "idle") {
    L.push("process.stdout.write('idle harness finished\\n');");
    L.push("process.exit(0);");
  } else if (behavior === "probe") {
    L.push("try {");
    L.push("  const out = cp.execFileSync('tamandua', ['skill-path'], { encoding: 'utf8' });");
    L.push("  process.stdout.write('SKILL_PATH=' + out.trim() + '\\n');");
    L.push("  process.exit(0);");
    L.push("} catch (e) {");
    L.push("  process.stderr.write('skill-path failed: ' + String((e && e.stderr) || e));");
    L.push("  process.exit(2);");
    L.push("}");
  } else if (behavior === "claim-only") {
    L.push("let claim;");
    L.push("try {");
    L.push(`  const raw = cp.execFileSync('tamandua', ['step','claim',${JSON.stringify(AGENT)},'--run-id','run-' + ${JSON.stringify(runId)}], { encoding: 'utf8' });`);
    L.push("  claim = JSON.parse(raw.trim());");
    L.push("} catch (e) {");
    L.push("  process.stderr.write('claim failed: ' + String((e && e.stderr) || e));");
    L.push("  process.exit(3);");
    L.push("}");
    L.push("if (!claim || !claim.stepId) { process.stderr.write('claim returned no step: ' + JSON.stringify(claim)); process.exit(4); }");
    if (opts.saveClaimTo) {
      L.push(`fs.writeFileSync(${JSON.stringify(opts.saveClaimTo)}, JSON.stringify(claim));`);
    }
    L.push("process.stdout.write('claim-only finished\\n');");
    L.push("process.exit(0);");
  } else {
    // work: claim → (optional packed tamandua-test) → complete.
    L.push("let claim;");
    L.push("try {");
    L.push(`  const raw = cp.execFileSync('tamandua', ['step','claim',${JSON.stringify(AGENT)},'--run-id','run-' + ${JSON.stringify(runId)}], { encoding: 'utf8' });`);
    L.push("  claim = JSON.parse(raw.trim());");
    L.push("} catch (e) {");
    L.push("  process.stderr.write('claim failed: ' + String((e && e.stderr) || e));");
    L.push("  process.exit(3);");
    L.push("}");
    L.push("if (!claim || !claim.stepId) { process.stderr.write('claim returned no step: ' + JSON.stringify(claim)); process.exit(4); }");
    if (opts.saveClaimTo) {
      L.push(`fs.writeFileSync(${JSON.stringify(opts.saveClaimTo)}, JSON.stringify(claim));`);
    }
    L.push("fs.writeFileSync(path.join(process.cwd(), 'invocation-marker.txt'), 'ran\\n');");
    if (opts.runSuite) {
      const suiteArgs = JSON.stringify([
        "--repo", rig.repoDir,
        "--run", runId,
        "--step", opts.stepId ?? "implement",
        "--",
        "echo", "suite-marker-ok",
      ]);
      L.push(`const r = cp.spawnSync('tamandua-test', ${suiteArgs}, { stdio: 'inherit' });`);
      L.push("if (r.status !== 0) { process.stderr.write('tamandua-test exited ' + r.status + '\\n'); process.exit(7); }");
    }
    L.push("const report = 'STATUS: done\\nCHANGES: runner round-trip — ✓ utf8 é\\nTESTS: runner\\n';");
    L.push("try {");
    L.push(`  cp.execFileSync('tamandua', ['step','complete', claim.stepId], { encoding: 'utf8', input: report });`);
    L.push("} catch (e) {");
    L.push("  process.stderr.write('complete failed: ' + String((e && e.stderr) || e));");
    L.push("  process.exit(6);");
    L.push("}");
    L.push("process.stdout.write('work round finished\\n');");
    L.push("process.exit(0);");
  }
  fs.writeFileSync(file, L.join("\n") + "\n", { mode: 0o755 });
  return file;
}

interface InvokeOptions {
  rig: FixtureRig;
  driver: DriverRun;
  fakePi: string;
  /** Policy override (defaults to the rig's pi fixture policy). */
  policy?: ExecutionIsolation;
  invocationId: string;
  kind: "probe" | "work";
  promptText: string;
  registry: HostInvocationRegistry;
  timeoutMs: number;
  progressResource?: { runId: string; runRoot: string };
  suite?: MatchlockInvocationSuite;
  signal?: AbortSignal;
  guestEnvOverrides?: Record<string, string>;
  rpcEnv?: Record<string, string>;
  /** US-004 seam: CLI binary used for BOTH the RPC child and the VM `rm`. */
  rpcBinaryPath?: string;
  /** US-004 seam: RPC child argv (default [driverPath]). */
  rpcArgs?: string[];
  label: string;
  createTimeoutMs?: number;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** MTLK-CLEANUP US-009: test-only close/dispose fault seam. */
  faults?: MatchlockInvocationFaults;
  onLog?: (l: string, m: string, f?: Record<string, unknown>) => void;
}

function invoke(opts: InvokeOptions): Promise<MatchlockInvocationResult> {
  return runMatchlockInvocation({
    policy: opts.policy ?? fixturePolicy(opts.rig),
    identity: identity(opts.invocationId),
    kind: opts.kind,
    promptText: opts.promptText,
    workingDirectoryForHarness: opts.rig.repoDir,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    progressResource: opts.progressResource,
    suite: opts.suite,
    registry: opts.registry,
    helperPackHostPath: sharedPack.packDir,
    harnessArgv: [opts.fakePi],
    imagePath: `${NODE_DIR}:/usr/bin:/bin`,
    rpcBinaryPath: opts.rpcBinaryPath ?? NODE_BIN,
    rpcArgs: opts.rpcArgs ?? [opts.driver.driverPath],
    rpcEnv: opts.rpcEnv ?? opts.driver.env,
    guestEnvOverrides: opts.guestEnvOverrides,
    closeTimeoutSeconds: 25,
    createTimeoutMs: opts.createTimeoutMs ?? 15000,
    requestTimeoutMs: opts.requestTimeoutMs ?? 15000,
    handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 20000,
    serviceTimeoutMs: 120000,
    faults: opts.faults,
    onLog: opts.onLog ?? (() => {}),
  });
}

// ── tests ──────────────────────────────────────────────────────────────

describe("pi invocation runner (mock local-VM driver; real broker/services/pack)", () => {
  it("probe and work each get their own FRESH VM (one create per driver journal); admission precedes create; shared registry", async () => {
    const rig = makeRig("runner-fresh");
    const registry = new HostInvocationRegistry();
    try {
      // PROBE: fresh driver + VM #1.
      const fakePi = writeFakePi("probe", rig, { runId: RUN });
      const driver = makeDriver({ transcriptPath: freshTranscript() });
      const probe = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
          invocationId: INV_A,
          kind: "probe",
          promptText: "Run the packed tamandua skill-path and report the path.",
          registry,
          timeoutMs: 60000,
          label: "probe",
        }),
        120000,
        "probe invocation",
      );
      assert.equal(probe.exitCode, 0, `probe exit; stderr: ${probe.stderrTail}`);
      assert.match(probe.output, /SKILL_PATH=.*skills\/tamandua-agents\/SKILL\.md/);
      assert.equal(probe.cleanupConfirmed, true);
      const probeTxn = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
      assert.equal(probeTxn.filter((l) => l.method === "create").length, 1, "probe = exactly one create");
      assert.ok(probeTxn.some((l) => l.event === "vm_created"), "probe created a VM");
      assert.ok(probeTxn.some((l) => l.event === "vm_closed"), "probe VM positively closed");
      const probeVm = probeTxn.find((l) => l.event === "vm_created");

      // WORK: fresh driver + VM #2 (never shared with the probe).
      const fakePiW = writeFakePi("work", rig, { runId: RUN });
      rig.st.insertStep({
        id: randomUUID(),
        runId: RUN,
        stepId: "implement",
        agentId: AGENT,
        stepIndex: 0,
        inputTemplate: "fixture task",
        status: "pending",
        type: "single",
        maxRetries: 2,
      });
      const driverW = makeDriver({ transcriptPath: freshTranscript() });
      const work = await withTimeout(
        invoke({
          rig,
          driver: driverW,
          fakePi: fakePiW,
          invocationId: INV_B,
          kind: "work",
          promptText: "Implement the fixture.",
          registry,
          timeoutMs: 120000,
          label: "work",
        }),
        180000,
        "work invocation",
      );
      assert.equal(work.exitCode, 0, `work exit; stderr: ${work.stderrTail}`);
      assert.equal(work.cleanupConfirmed, true);
      const workTxn = readTranscript(driverW.env.FAKE_TRANSCRIPT_FILE!);
      assert.equal(workTxn.filter((l) => l.method === "create").length, 1, "work = exactly one create");
      assert.ok(workTxn.some((l) => l.event === "vm_created"), "work created its own VM");
      assert.ok(workTxn.some((l) => l.event === "vm_closed"), "work VM positively closed");
      const workVm = workTxn.find((l) => l.event === "vm_created");
      assert.ok(probeVm && workVm, "both journals recorded a VM");
      assert.notEqual(probeVm!.id, workVm!.id, "probe and work must use DIFFERENT VMs");
      // Registry admission + terminal revocation for both invocations.
      assert.equal(registry.admissionCount, 2);
      assert.equal(registry.revocationCount, 2);
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("a dsh invocation mounts ONE real effective-home root from a private per-run overlay and removes it after the confirmed close", async () => {
    const rig = makeRig("runner-dsh-overlay", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    try {
      // Synthetic dsh home: one install-derived profile module dir + durable
      // categories. It lives OUTSIDE the live state root (never admin state).
      const dshHome = path.join(rig.root, "dsh-home");
      fs.mkdirSync(path.join(dshHome, "profiles", "headless", "node_modules"), { recursive: true });
      fs.mkdirSync(path.join(dshHome, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(dshHome, ".credentials.yaml"), "refs: []\n", "utf8");
      const dshFixt = fixturePolicy(rig, {
        harness: "dsh",
        configurationRoot: dshHome,
        guestConfigurationRoot: "/workspace/config/dsh",
      });
      const fakePi = writeFakePi("probe", rig, { runId: RUN });
      const driver = makeDriver({ transcriptPath: freshTranscript() });
      const probe = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
          policy: dshFixt,
          invocationId: INV_A,
          kind: "probe",
          promptText: "Run the packed tamandua skill-path and report the path.",
          registry,
          timeoutMs: 60000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          label: "dsh-overlay",
        }),
        120000,
        "dsh overlay invocation",
      );
      assert.equal(probe.exitCode, 0, `dsh probe exit; stderr: ${probe.stderrTail}`);
      assert.equal(probe.cleanupConfirmed, true);
      const txn = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
      const create = txn.find((l) => l.method === "create");
      assert.ok(create, "a create reached the wire");
      const params = create!.params as Record<string, unknown>;
      const mounts = (params.vfs as Record<string, unknown>).mounts as Record<
        string,
        { host_path?: string; readonly?: boolean }
      >;
      const overlayRoot = path.join(rig.root, "state", "matchlock", "dsh-profile-overlays", RUN);
      // ONE real effective-home root from the private overlay: the home root is
      // host-backed (fsync-able) while profiles/ stays the private copy.
      assert.equal(
        mounts["/workspace/config/dsh"]?.host_path,
        overlayRoot,
        "the effective home root must be sourced from the private per-run overlay",
      );
      assert.notEqual(
        mounts["/workspace/config/dsh"]?.host_path,
        dshHome,
        "the host DSH_HOME must never be mounted directly",
      );
      assert.equal(
        mounts["/workspace/config/dsh/profiles"],
        undefined,
        "no nested profiles destination may exist",
      );
      assert.equal(
        mounts["/workspace/config/dsh/profiles/headless/node_modules"],
        undefined,
        "no per-child profile destination may exist",
      );
      assert.equal(
        fs.existsSync(overlayRoot),
        false,
        "the attested overlay root must be removed after the confirmed close",
      );
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("records pre/post dsh profile-module farm snapshot counts and never fails a round on a difference", async () => {
    const rig = makeRig("runner-dsh-farm", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    try {
      const dshHome = path.join(rig.root, "dsh-home");
      const farm = path.join(dshHome, "profiles", "node_modules");
      fs.mkdirSync(farm, { recursive: true });
      fs.mkdirSync(path.join(dshHome, "profiles", "headless", "node_modules"), { recursive: true });
      fs.mkdirSync(path.join(dshHome, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(dshHome, ".credentials.yaml"), "refs: []\n", "utf8");
      fs.symlinkSync("/opt/dsh/apps/cli/node_modules/alpha", path.join(farm, "alpha"));
      const dshFixt = fixturePolicy(rig, {
        harness: "dsh",
        configurationRoot: dshHome,
        guestConfigurationRoot: "/workspace/config/dsh",
      });
      const fakePi = writeFakePi("probe", rig, { runId: RUN });
      const driver = makeDriver({ transcriptPath: freshTranscript() });
      const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
      // Simulate a concurrent NATIVE dsh boot healing the operator's farm AFTER
      // the runner's pre-snapshot. The difference is evidence, never a failure:
      // the round must still succeed and the post record must report the flip.
      const onLog = (level: string, msg: string, fields?: Record<string, unknown>): void => {
        logs.push({ level, msg, fields });
        if (msg === "dsh profile-module farm pre-snapshot") {
          fs.symlinkSync("/opt/dsh/apps/cli/node_modules/beta", path.join(farm, "beta"));
          fs.rmSync(path.join(farm, "alpha"));
          fs.symlinkSync("/opt/dsh/apps/cli/node_modules/alpha-v2", path.join(farm, "alpha"));
        }
      };
      const probe = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
          policy: dshFixt,
          invocationId: INV_A,
          kind: "probe",
          promptText: "Run the packed tamandua skill-path and report the path.",
          registry,
          timeoutMs: 60000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          onLog,
          label: "dsh-farm-evidence",
        }),
        120000,
        "dsh farm evidence invocation",
      );
      assert.equal(probe.exitCode, 0, `dsh farm probe exit; stderr: ${probe.stderrTail}`);
      assert.equal(probe.cleanupConfirmed, true);
      const pre = logs.find((l) => l.msg === "dsh profile-module farm pre-snapshot");
      const post = logs.find((l) => l.msg === "dsh profile-module farm post-snapshot");
      assert.ok(pre, "a pre-snapshot evidence record is logged");
      assert.ok(post, "a post-snapshot evidence record is logged");
      assert.equal(pre!.fields?.linkCount, 1, "pre-snapshot counts the single seeded link");
      assert.equal(post!.fields?.linkCount, 2, "post-snapshot counts the survived+added links");
      assert.equal(post!.fields?.added, 1);
      assert.equal(post!.fields?.removed, 0);
      assert.equal(post!.fields?.retargeted, 1);
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("positive work round trip: typed claim + complete through the REAL broker/step-ops and guest CLI; utf8 survives base64 decode once; story-plan writes land in the host progress-resource doc", async () => {
    const rig = makeRig("runner-roundtrip");
    const registry = new HostInvocationRegistry();
    const storyId = randomUUID();
    rig.st.insertStory({ id: storyId, runId: RUN, storyId: "US-001", title: "Runner fixture story", description: "desc", acceptanceCriteria: ["works"] });
    const stepRow = randomUUID();
    rig.st.insertStep({
      id: stepRow,
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "fixture task",
      status: "pending",
      type: "single",
      expects: "STATUS: done\nCHANGES:",
      maxRetries: 2,
    });
    const saveClaimTo = path.join(rig.root, "claim-captured.json");
    const fakePi = writeFakePi("work", rig, { runId: RUN, saveClaimTo });
    // Aggressive 2-byte stdout chunking forces multi-byte UTF-8 characters to
    // split across base64 frame boundaries (decode exactly once contract).
    const driver = makeDriver({ transcriptPath: freshTranscript(), chunkBytes: 2 });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakePi,
        invocationId: INV_A,
        kind: "work",
        promptText: "Implement the fixture.",
        registry,
        timeoutMs: 180000,
        progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
        label: "positive round trip",
      }),
      240000,
      "positive work round trip",
    );
    assert.equal(result.exitCode, 0, `work exit; stderr: ${result.stderrTail}`);
    assert.equal(result.cleanupConfirmed, true);
    assert.match(result.vmId ?? "", /^vm-[0-9a-f]{8}-1$/, "driver-assigned fresh VM id");

    // US-006: the real pi round reports the split timing contract — VM setup
    // (create/boot → harness exec) separate from the guest exec → exit harness
    // interval, with the whole round covering both.
    assert.equal(typeof result.vmSetupMs, "number", `pi vmSetupMs; got ${String(result.vmSetupMs)}`);
    assert.equal(typeof result.harnessWallMs, "number", `pi harnessWallMs; got ${String(result.harnessWallMs)}`);
    assert.ok((result.vmSetupMs as number) >= 0, "vmSetupMs must be a real interval");
    assert.ok((result.harnessWallMs as number) >= 0, "harnessWallMs must be a real interval");
    assert.ok(
      (result.vmSetupMs as number) + (result.harnessWallMs as number) <= (result.durationMs as number),
      `durationMs (${String(result.durationMs)}) is the whole round and must cover setup (${String(result.vmSetupMs)}) + harness (${String(result.harnessWallMs)})`,
    );

    // The typed complete flowed through real step-ops.
    const row = getDbRow(rig, stepRow);
    assert.equal(row.status, "done", "typed complete advanced the step");
    assert.ok(String(row.output).includes("STATUS: done"), "submitted output stored");
    assert.ok(String(row.output).includes("✓ utf8 é"), "multi-byte content survived exact-once decode");

    // The claim JSON the guest CLI received is intact.
    assert.ok(fs.existsSync(saveClaimTo), "claim captured by the synthetic guest pi");
    const claim = JSON.parse(fs.readFileSync(saveClaimTo, "utf8")) as { stepId: string; runId: string };
    assert.equal(claim.runId, `run-${RUN}`);
    assert.equal(claim.stepId, `step-${stepRow}`);

    // Host progress-resource document written by the completion path.
    const progressDoc = path.join(rig.progressRunRoot, RUN, "progress-resource", PROGRESS_DOC_FILE_NAME);
    assert.ok(fs.existsSync(progressDoc), "host progress-resource doc must exist");
    const doc = fs.readFileSync(progressDoc, "utf8");
    assert.match(doc, /## Story Plan/);
    assert.match(doc, /Runner fixture story/);

    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    assert.ok(lines.some((l) => l.event === "vm_closed"), "VM positively closed");
    assert.equal(registry.revocationCount, 1, "registry revocation exactly once");
    assert.equal(registry.getAdmission(INV_A)?.state, "revoked");
    assert.equal(registry.getLeaseByInvocation(INV_A), undefined, "lease released");
  });

  // ── US-006 (H1/D1): a rejected harness exec is surfaced, never swallowed ─
  it("US-006: a rejected pi harness exec (VM relay error) surfaces the real bounded RPC error while the guest's step completion still lands", async () => {
    const rig = makeRig("runner-exec-reject");
    const registry = new HostInvocationRegistry();
    const stepRow = randomUUID();
    rig.st.insertStep({
      id: stepRow,
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "reject fixture task",
      status: "pending",
      type: "single",
      expects: "STATUS: done\nCHANGES:",
      maxRetries: 2,
    });
    const saveClaimTo = path.join(rig.root, "claim-exec-reject.json");
    const driver = makeDriver({
      transcriptPath: freshTranscript(),
      harnessExecError: "relay dropped final stdout frames",
      harnessExecErrorCode: -32000,
      harnessExecErrorSuppressOutput: true,
    });
    const fakePi = writeFakePi("work", rig, { runId: RUN, saveClaimTo });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakePi,
        invocationId: INV_A,
        kind: "work",
        promptText: "reject the harness exec after the guest completed the step",
        registry,
        timeoutMs: 180000,
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
    // The guest's authoritative step completion still landed (the scheduler
    // classifies from the step row, never the lost stdout).
    assert.equal(getDbRow(rig, stepRow).status, "done");
    assert.ok(fs.existsSync(saveClaimTo), "claim captured by the synthetic guest pi");
    assert.equal(registry.revocationCount, 1, "terminal teardown still ran exactly once");
    assert.equal(registry.getAdmission(INV_A)?.state, "revoked");
  });

  it("claim/current of a story-bearing step renders the GUEST progress pointer through the real guest CLI", async () => {
    const rig = makeRig("runner-pointer");
    const registry = new HostInvocationRegistry();
    const storyId = randomUUID();
    rig.st.insertStory({ id: storyId, runId: RUN, storyId: "US-001", title: "Loop story", description: "d", acceptanceCriteria: ["a"] });
    rig.st.insertStep({
      id: randomUUID(),
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "loop progress file: {{progress_file}}\n",
      status: "pending",
      type: "loop",
      loopConfig: JSON.stringify({ over: "stories", verifyEach: false }),
      maxRetries: 2,
    });
    const saveClaimTo = path.join(rig.root, "pointer-claim.json");
    const fakePi = writeFakePi("claim-only", rig, { runId: RUN, saveClaimTo });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakePi,
        invocationId: INV_A,
        kind: "work",
        promptText: "Claim the story step and stop.",
        registry,
        timeoutMs: 120000,
        progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
        label: "guest pointer claim",
      }),
      180000,
      "guest-pointer claim",
    );
    assert.equal(result.exitCode, 0, `exit; stderr: ${result.stderrTail}`);
    const claim = JSON.parse(fs.readFileSync(saveClaimTo, "utf8")) as { input: string };
    assert.match(claim.input, new RegExp(`/workspace/runs/${RUN}/progress\\.txt`), "claimed input renders the guest progress file pointer");
    assert.ok(!claim.input.includes(rig.progressRunRoot), "guest input must never leak the host canonical path");
  });

  it("packed tamandua-test records an integer exit row in the host suite store under the canonical namespace", async () => {
    const rig = makeRig("runner-suite");
    const registry = new HostInvocationRegistry();
    const storePath = path.join(rig.root, "host-suite.sqlite");
    const suite: MatchlockInvocationSuite = { storePath, namespace: NS, admittedRoots: [fs.realpathSync(rig.repoDir)] };
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
    const fakePi = writeFakePi("work", rig, { runId: RUN, stepId: "implement", runSuite: true });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakePi,
        invocationId: INV_A,
        kind: "work",
        promptText: "Run the suite and report.",
        registry,
        timeoutMs: 180000,
        suite,
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
      assert.equal(evidence!.exit_code, 0, "recorded exit is the REAL integer exit 0 of the command (0..255)");
    } finally {
      store.close();
    }
    assert.equal(registry.revocationCount, 1);
  });

  it("suite-absent invocation degrades to real guest-local execution with explicit incomplete evidence and NO green (no store ever created)", async () => {
    const rig = makeRig("runner-suite-absent");
    const registry = new HostInvocationRegistry();
    const storePath = path.join(rig.root, "host-suite-absent.sqlite");
    void storePath;
    rig.st.insertStep({
      id: randomUUID(),
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "suite fixture",
      status: "pending",
      type: "single",
      maxRetries: 2,
    });
    const fakePi = writeFakePi("work", rig, { runId: RUN, stepId: "implement", runSuite: true });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakePi,
        invocationId: INV_A,
        kind: "work",
        promptText: "Run the suite (absent).",
        registry,
        timeoutMs: 180000,
        // NO suite option: host suite service is ABSENT for this invocation.
        label: "suite-absent work",
      }),
      240000,
      "suite-absent invocation",
    );
    assert.equal(result.exitCode, 0, `absent exit; stderr: ${result.stderrTail}`);
    assert.equal(result.suiteAbsent, true, "suite-absent flag reported");
    assert.match(result.output, /suite-marker-ok/, "the real command still executed guest-locally");
    assert.match(result.stderrTail, /absent|not served|refused|incomplete/i, "explicit incomplete-evidence warning on stderr");
    // The runner never created a suite store and nothing was recorded.
    assert.equal(fs.existsSync(storePath), false, "no suite store file when suite absent");
    assert.equal(registry.revocationCount, 1);
  });

  it("strict HELLO build mismatch refuses BEFORE any harness work and positively closes the owned VM", async () => {
    const rig = makeRig("runner-hello");
    const registry = new HostInvocationRegistry();
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    await assert.rejects(
      withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
          invocationId: INV_A,
          kind: "work",
          promptText: "should never run",
          registry,
          timeoutMs: 30000,
          guestEnvOverrides: { TAMANDUA_GUEST_BUILD_VERSION: "stale-build-000" },
          label: "HELLO mismatch",
        }),
        120000,
        "HELLO mismatch invocation",
      ),
      (err: unknown) => err instanceof MatchlockRunnerError && err.code === "guest_bridge_unavailable",
      "build mismatch must refuse with guest_bridge_unavailable",
    );
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    assert.ok(lines.some((l) => l.event === "vm_created"), "VM was created");
    assert.ok(lines.some((l) => l.event === "vm_closed"), "VM positively closed on refusal");
    const harnessStarts = lines.filter((l) => l.event === "exec_started" && !String(l.command).includes("tamandua-bridge"));
    assert.equal(harnessStarts.length, 0, "no harness command ran before HELLO refusal");
    assert.equal(registry.revocationCount, 1, "authority revoked exactly once");
  });

  it("guest EOF (bridge exits before handshake) refuses before work and cleans up", async () => {
    const rig = makeRig("runner-eof");
    const registry = new HostInvocationRegistry();
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript(), bridgeExit: "1" });
    await assert.rejects(
      withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
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
      (err: unknown) => err instanceof MatchlockRunnerError,
      "bridge EOF must refuse the invocation",
    );
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    assert.ok(lines.some((l) => l.event === "vm_closed") || lines.some((l) => l.event === "exec_no_spawn"), "owned VM cleaned up");
    const harnessStarts = lines.filter((l) => l.event === "exec_started" && !String(l.command).includes("tamandua-bridge"));
    assert.equal(harnessStarts.length, 0, "no harness work after bridge EOF");
    assert.equal(registry.revocationCount, 1);
  });

  it("timeout terminally revokes authority exactly once, releases leases and positively closes the owned VM", async () => {
    const rig = makeRig("runner-timeout");
    const registry = new HostInvocationRegistry();
    rig.st.insertStep({
      id: randomUUID(),
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "fixture",
      status: "pending",
      type: "single",
      maxRetries: 2,
    });
    const fakePi = writeFakePi("sleep", rig, { runId: RUN, sleepMs: 30000 });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakePi,
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
    const rig = makeRig("runner-cancel");
    const registry = new HostInvocationRegistry();
    const fakePi = writeFakePi("sleep", rig, { runId: RUN, sleepMs: 30000 });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1200);
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
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

  it("idle-close: an invocation that never claims still terminally revokes authority exactly once and closes the VM", async () => {
    const rig = makeRig("runner-idle");
    const registry = new HostInvocationRegistry();
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakePi,
        invocationId: INV_A,
        kind: "work",
        promptText: "idle fixture",
        registry,
        timeoutMs: 60000,
        label: "idle",
      }),
      90000,
      "idle invocation",
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(registry.revocationCount, 1, "idle close still revokes exactly once");
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    assert.ok(lines.some((l) => l.event === "vm_closed"), "VM positively closed after idle completion");
  });

  it("close-before-create (already-aborted signal) performs NO VM create and revokes once", async () => {
    const rig = makeRig("runner-close-before-create");
    const registry = new HostInvocationRegistry();
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    const ac = new AbortController();
    ac.abort();
    const result = await withTimeout(
      invoke({
        rig,
        driver,
        fakePi,
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
    const rig = makeRig("runner-late-create");
    const registry = new HostInvocationRegistry();
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript(), createDelayMs: 1500 });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 300);
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
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

  // ── MTLK-CLEANUP US-005: a post-harness close failure is non-fatal ─────
  it("US-005: a post-harness close failure keeps the round result, logs one WARN with the serialized cause and records one orphan", async () => {
    const rig = makeRig("runner-cleanup-fail", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const stepRow = randomUUID();
    rig.st.insertStep({
      id: stepRow,
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "fixture task",
      status: "pending",
      type: "single",
      expects: "STATUS: done\nCHANGES:",
      maxRetries: 2,
    });
    const fakePi = writeFakePi("work", rig, { runId: RUN });
    const transcript = freshTranscript();
    const driver = makeDriver({ transcriptPath: transcript, closeFail: 5 });
    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const onLog = (level: string, message: string, fields?: Record<string, unknown>): void => {
      logs.push({ level, message, fields });
    };
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
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
      const closeWarns = logs.filter((l) => l.level === "warn" && /post-harness vm close\/dispose failed/.test(l.message));
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

  // ── MTLK-CLEANUP US-009: fault-injection seam (test-only, options-only) ─
  it("US-009: the injected failClose fault keeps the round, logs the serialized cause and hands the VM to the reaper", async () => {
    const rig = makeRig("runner-us009-failclose", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const stepRow = randomUUID();
    rig.st.insertStep({
      id: stepRow,
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "fixture task",
      status: "pending",
      type: "single",
      expects: "STATUS: done\nCHANGES:",
      maxRetries: 2,
    });
    const fakePi = writeFakePi("work", rig, { runId: RUN });
    const transcript = freshTranscript();
    const driver = makeDriver({ transcriptPath: transcript });
    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
          invocationId: INV_A,
          kind: "work",
          promptText: "US-009 injected close failure fixture",
          registry,
          timeoutMs: 180000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          faults: { failClose: true, suppressImmediateReap: true },
          onLog: (level, message, fields) => logs.push({ level, message, fields }),
          label: "US-009 failClose",
        }),
        240000,
        "US-009 failClose invocation",
      );

      // 1. The round result is KEPT (the injected fault is post-harness only).
      assert.equal(result.exitCode, 0, `round exit kept; stderr: ${result.stderrTail}`);
      assert.match(result.output, /work round finished/, "round output kept");
      assert.equal(getDbRow(rig, stepRow).status, "done", "the completed step evidence is kept");
      assert.equal(result.cleanupConfirmed, false, "cleanup is not confirmed for the injected close failure");
      assert.equal(result.vmRemoved, undefined, "no removal happened on the injected path");

      // 2. The bounded serialized vmCleanupFailure carries phase + owned vmId +
      // the injected cause (never '[object Object]').
      const created = readTranscript(transcript).find((l) => l.event === "vm_created");
      assert.ok(created && typeof created.id === "string", "the fixture VM was created");
      const failure = result.vmCleanupFailure ?? "";
      assert.match(failure, /phase=close/, "serialized failure carries the failing phase");
      assert.match(failure, /name=MatchlockRpcError/, "serialized failure names the error");
      assert.match(failure, /code=-32000/, "serialized failure carries the injected RPC code");
      assert.match(failure, /injected matchlock close\/dispose failure/, "serialized failure carries the injected cause");
      assert.match(failure, new RegExp(`vmId=${created!.id}`), "serialized failure carries the owned vmId");
      assert.doesNotMatch(failure, /\[object Object\]/, "the incident's [object Object] is impossible");
      assert.ok(failure.length <= 2048, "vmCleanupFailure is byte-bounded");

      // 3. Exactly one WARN carries the serialized cause with vmId + phase.
      const closeWarns = logs.filter((l) => l.level === "warn" && /post-harness vm close\/dispose failed/.test(l.message));
      assert.equal(closeWarns.length, 1, "exactly one post-harness close WARN");
      assert.equal(closeWarns[0].fields?.vmId, created!.id, "WARN names the vmId");
      assert.equal(closeWarns[0].fields?.phase, "close", "WARN names the phase");
      assert.match(String(closeWarns[0].fields?.error ?? ""), /injected matchlock close\/dispose failure/, "WARN carries the serialized cause");

      // 4. Exactly one orphan record was written for that vmId.
      const orphans = readOrphanVms({ runId: RUN, runRoot: rig.progressRunRoot });
      assert.equal(orphans.length, 1, "one orphan record for the handed-off VM");
      assert.equal(orphans[0].vmId, created!.id, "orphan record is keyed by the owned vmId");
      assert.equal(orphans[0].phase, "close", "orphan record carries the failing phase");
      assert.match(orphans[0].error, /injected matchlock close\/dispose failure/, "orphan record carries the injected cause");
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("US-009: the fault seam is OFF by default and is unreachable from the environment", async () => {
    const rig = makeRig("runner-us009-env-off", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const stepRow = randomUUID();
    rig.st.insertStep({
      id: stepRow,
      runId: RUN,
      stepId: "implement",
      agentId: AGENT,
      stepIndex: 0,
      inputTemplate: "fixture task",
      status: "pending",
      type: "single",
      expects: "STATUS: done\nCHANGES:",
      maxRetries: 2,
    });
    const fakePi = writeFakePi("work", rig, { runId: RUN });
    const transcript = freshTranscript();
    const driver = makeDriver({ transcriptPath: transcript });
    const prior = process.env.TAMANDUA_MATCHLOCK_FAULT_FAIL_CLOSE;
    process.env.TAMANDUA_MATCHLOCK_FAULT_FAIL_CLOSE = "1";
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
          invocationId: INV_A,
          kind: "work",
          promptText: "US-009 no-fault fixture",
          registry,
          timeoutMs: 180000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          onLog: () => {},
          label: "US-009 no-fault",
        }),
        240000,
        "US-009 no-fault invocation",
      );
      assert.equal(result.exitCode, 0, `clean round exit; stderr: ${result.stderrTail}`);
      assert.equal(result.cleanupConfirmed, true, "a run with no faults confirms its cleanup");
      assert.equal(result.vmCleanupFailure, undefined, "the env var cannot arm the fault seam");
      assert.equal(
        readOrphanVms({ runId: RUN, runRoot: rig.progressRunRoot }).length,
        0,
        "no orphan record on the clean path",
      );
    } finally {
      if (prior === undefined) delete process.env.TAMANDUA_MATCHLOCK_FAULT_FAIL_CLOSE;
      else process.env.TAMANDUA_MATCHLOCK_FAULT_FAIL_CLOSE = prior;
      rig.st.dispose(stickyEnv);
    }
  });

  // ── MTLK-CLEANUP US-005: a close failure BEFORE the harness exits stays fatal
  it("US-005: a close failure before the harness has exited remains fatal and surfaces the serialized cause", async () => {
    const rig = makeRig("runner-cleanup-serialize", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const transcript = freshTranscript();
    const driver = makeDriver({ transcriptPath: transcript, closeFail: 5 });
    let surfaced: MatchlockRunnerError | null = null;
    await assert.rejects(
      withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
          invocationId: INV_A,
          kind: "work",
          promptText: "cleanup serialize fixture",
          registry,
          timeoutMs: 60000,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
          // A HELLO build mismatch refuses BEFORE the harness exec starts, so
          // the cleanup close runs before any harness exit.
          guestEnvOverrides: { TAMANDUA_GUEST_BUILD_VERSION: "stale-build-000" },
          label: "cleanup serialize",
        }),
        120000,
        "cleanup-serialize invocation",
      ),
      (err: unknown) => {
        if (err instanceof MatchlockRunnerError) surfaced = err;
        return err instanceof MatchlockRunnerError && err.code === "matchlock_cleanup_failed";
      },
      "a close failure before the harness exited must surface matchlock_cleanup_failed",
    );
    const message = surfaced!.message;
    // The inciting body is the RPC client's PLAIN `{code,message}` object; the
    // pre-US-001 path rendered it as `[object Object]`.
    assert.match(message, /vm close\/dispose:/);
    assert.match(message, /name=MatchlockRpcError/);
    assert.match(message, /code=-32000/);
    assert.match(message, /message=close failed \(fixture\)/);
    assert.match(message, /phase=close/);
    assert.doesNotMatch(message, /\[object Object\]/);
    const created = readTranscript(transcript).find((l) => l.event === "vm_created");
    assert.ok(created && typeof created.id === "string", "the fixture VM was created");
    assert.match(
      message,
      new RegExp(`vmId=${created!.id}`),
      "serialized cleanup detail carries the owned vmId",
    );
    // No harness exit happened, so no post-harness handoff was written.
    assert.equal(
      readOrphanVms({ runId: RUN, runRoot: rig.progressRunRoot }).length,
      0,
      "no orphan record before the harness exits",
    );
  });

  // ── MTLK-CLEANUP US-005: create/probe/exec failures stay typed+fatal ───
  it("US-005: a pre-harness failure still throws the typed error and never writes an orphan (fatal path unchanged)", async () => {
    const rig = makeRig("runner-preharness-fatal", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    await assert.rejects(
      withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
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
      (err: unknown) => err instanceof MatchlockRunnerError && err.code === "guest_bridge_unavailable",
      "a probe/handshake failure keeps its typed error",
    );
    assert.equal(
      readOrphanVms({ runId: RUN, runRoot: rig.progressRunRoot }).length,
      0,
      "a pre-harness failure is fatal and writes no orphan handoff",
    );
  });

  // ── US-004 (MATCHLOCK-OBS finding 2): capture VM evidence + remove the VM ─
  it("US-004: probe and work rounds capture VM evidence and remove the VM after a confirmed close", async () => {
    const rig = makeRig("runner-vm-reap", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const removalHome = tmpDir("tamandua-pi-runner-vmhome-");
    const rmJournal = path.join(tmpDir("tamandua-pi-runner-rm-"), "rm.jsonl");
    const fakeCli = writeFakeMatchlockCli({ journalPath: rmJournal });
    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const onLog = (level: string, message: string, fields?: Record<string, unknown>): void => {
      logs.push({ level, message, fields });
    };
    try {
      const probeDriver = makeDriver({ transcriptPath: freshTranscript() });
      const probePi = writeFakePi("probe", rig, { runId: RUN });
      const probe = await withTimeout(
        invoke({
          rig,
          driver: probeDriver,
          fakePi: probePi,
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
        status: "pending",
        type: "single",
        maxRetries: 2,
      });
      const workDriver = makeDriver({ transcriptPath: freshTranscript() });
      const workPi = writeFakePi("work", rig, { runId: RUN });
      const work = await withTimeout(
        invoke({
          rig,
          driver: workDriver,
          fakePi: workPi,
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

  it("US-004: a reaper failure is reported on the result and logged at warn without failing the round", async () => {
    const rig = makeRig("runner-vm-reap-fail", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const removalHome = tmpDir("tamandua-pi-runner-vmhome-");
    const rmJournal = path.join(tmpDir("tamandua-pi-runner-rm-"), "rm.jsonl");
    const fakeCli = writeFakeMatchlockCli({
      journalPath: rmJournal,
      rmExit: 7,
      rmStderr: "fixture: rm refused by test wrapper\n",
    });
    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
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

  it("US-004/US-005: no VM is removed when the close was never positively confirmed (the VM is handed to the reaper instead)", async () => {
    const rig = makeRig("runner-vm-reap-unconfirmed", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const removalHome = tmpDir("tamandua-pi-runner-vmhome-");
    const rmJournal = path.join(tmpDir("tamandua-pi-runner-rm-"), "rm.jsonl");
    const fakeCli = writeFakeMatchlockCli({ journalPath: rmJournal });
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript(), closeFail: 5 });
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
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
      // US-005: post-harness close failure is non-fatal, so the round is kept.
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

  it("US-004: a dispose-only teardown (no VM, no confirmed close) never invokes the reaper", async () => {
    const rig = makeRig("runner-vm-reap-dispose", WRITABLE_FIXTURE_BASE);
    const registry = new HostInvocationRegistry();
    const removalHome = tmpDir("tamandua-pi-runner-vmhome-");
    const rmJournal = path.join(tmpDir("tamandua-pi-runner-rm-"), "rm.jsonl");
    const fakeCli = writeFakeMatchlockCli({ journalPath: rmJournal });
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    const ac = new AbortController();
    ac.abort();
    try {
      const result = await withTimeout(
        invoke({
          rig,
          driver,
          fakePi,
          invocationId: INV_A,
          kind: "work",
          promptText: "dispose-only fixture",
          registry,
          timeoutMs: 30000,
          signal: ac.signal,
          progressResource: { runId: `run-${RUN}`, runRoot: rig.progressRunRoot },
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
        60000,
        "dispose-only invocation",
      );
      assert.equal(result.canceled, true);
      assert.equal(result.vmId, null, "no VM was ever created");
      assert.equal(result.vmRemoved, undefined, "a dispose-only teardown records no vmRemoved");
      assert.equal(readRmJournal(rmJournal).length, 0, "no rm for a dispose-only teardown");
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("unpinned policy refuses BEFORE any VM create (image identity required)", async () => {
    const rig = makeRig("runner-unpinned");
    const registry = new HostInvocationRegistry();
    const fakePi = writeFakePi("idle", rig, { runId: RUN });
    const driver = makeDriver({ transcriptPath: freshTranscript() });
    await assert.rejects(
      withTimeout(
        runMatchlockInvocation({
          policy: fixturePolicy(rig, { resolvedImageDigest: undefined, resolvedImageConfigDigest: undefined }),
          identity: identity(INV_A),
          kind: "work",
          promptText: "unpinned",
          workingDirectoryForHarness: rig.repoDir,
          timeoutMs: 30000,
          helperPackHostPath: sharedPack.packDir,
          registry,
          harnessArgv: [fakePi],
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
      (err: unknown) => err instanceof MatchlockRunnerError && err.code === "image_identity_required",
      "unpinned policy must refuse before any VM create",
    );
    const lines = readTranscript(driver.env.FAKE_TRANSCRIPT_FILE!);
    assert.equal(lines.filter((l) => l.method === "create").length, 0, "zero create requests");
    assert.equal(registry.revocationCount, 1, "refusal before create terminally revokes the admission (no VM effects)");
  });

  it("product-under-test children get stripGuestSuiteEnv (no parent reporting/ledger authority inherited)", () => {
    const composed = composeGuestEnv({
      invocationId: INV_A,
      runId: RUN,
      agentId: AGENT,
      manifest: sharedPack.manifest,
      imagePath: `${NODE_DIR}:/usr/bin:/bin`,
      suite: { storePath: "/x.sqlite", namespace: NS, admittedRoots: [] },
    });
    assert.equal(composed.env.TAMANDUA_GUEST_SUITE_ENABLED, "1");
    assert.ok(composed.env.TAMANDUA_GUEST_SOCKET);
    const stripped = stripGuestSuiteEnv(composed.env);
    for (const key of GUEST_SUITE_ENV_KEYS) {
      assert.ok(!(key in stripped), `reporting env key ${key} removed by stripGuestSuiteEnv`);
    }
  });

  it("mapExecPipeToBrokerPipe decodes each base64 frame EXACTLY once (multi-byte split across frames)", async () => {
    const { mapExecPipeToBrokerPipe } = await import("../../../dist/installer/matchlock/pi-invocation-runner.js");
    // A fake exec pipe whose result never settles (frames are fed directly).
    const execPipe = {
      requestId: 1,
      stdin: {
        write: async (_d: Buffer | string) => {},
        eof: async () => {},
      },
      result: new Promise<never>(() => {}),
    } as unknown as Parameters<typeof mapExecPipeToBrokerPipe>[0];
    const bridge = mapExecPipeToBrokerPipe(execPipe);
    // One framed JSON line whose payload is split across THREE base64 frames,
    // the middle one carrying multi-byte UTF-8 bytes.
    const payload1 = Buffer.from('{"kind":"hello","helperBuildVersion":"bv');
    const payload2 = Buffer.from("é-✓-wörld", "utf8");
    const payload3 = Buffer.from('","packLayoutVersion":1,"protocolVersion":1}\n', "utf8");
    bridge.notify({ kind: "stdout", base64: payload1.toString("base64") });
    bridge.notify({ kind: "stdout", base64: payload2.toString("base64") });
    bridge.notify({ kind: "stdout", base64: payload3.toString("base64") });
    const collected: Buffer[] = [];
    bridge.pipe.fromGuest.on("data", (c: Buffer) => collected.push(c));
    await new Promise<void>((r) => setTimeout(r, 50));
    const decoded = Buffer.concat(collected);
    const expected = Buffer.concat([payload1, payload2, payload3]);
    assert.ok(decoded.equals(expected), "bytes must be decoded exactly once (concat equals the original byte stream)");
  });
});


/** Read a step row from the currently-open isolated DB. */
function getDbRow(rig: FixtureRig, stepRowId: string): Record<string, unknown> {
  void rig;
  return getDb().prepare("SELECT status, output, run_id FROM steps WHERE id = ?").get(stepRowId) as Record<string, unknown>;
}
