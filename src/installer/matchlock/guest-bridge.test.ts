/**
 * Guest bridge end-to-end contract tests over REAL subprocesses (serial lane).
 *
 * Builds the actual portable RO guest pack artifact (the same
 * bin/tamandua / bin/tamandua-bridge launchers and lib closure intended for
 * the VM), spawns the guest bridge service as a subprocess with its stdin/
 * stdout acting as the exec pipe, drives the real host broker in-process over
 * that pipe, and runs the REAL guest CLI launcher (absolute path AND bare
 * PATH calls) against the guest-local Unix socket.
 *
 * Zero models/VM are required: the authoritative service side is the
 * FakeStepServices that enforces binding + claim replacement. All child
 * processes run from fresh temp directories with isolated HOME/state, no repo
 * node_modules on PATH, finite deadlines everywhere and cleanup in finally.
 */

import { describe, it, afterEach } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  buildGuestPack,
  validateGuestPack,
  type GuestPackManifest,
} from "../../../dist/installer/matchlock/guest-pack-builder.js";
import {
  createHostBroker,
  type HostBrokerHandle,
} from "../../../dist/installer/matchlock/broker.js";
import {
  FakeStepServices,
  FakeQueryServices,
  type FakeStepRow,
  type FakeQueryFixture,
} from "../../../dist/installer/matchlock/broker-test-services.js";
import type { HostBinding } from "../../../dist/installer/matchlock/broker-services.js";
import type { HostQueryServices } from "../../../dist/installer/matchlock/host-query-services.js";
import type { HostMergeServices } from "../../../dist/installer/matchlock/host-merge-services.js";
import { createHostMergeService } from "../../../dist/installer/matchlock/host-merge-service.js";
import type { MergeCoreEvent } from "../../../dist/installer/matchlock/merge-core.js";
import {
  parseGuestMergeBranchOptions,
  printMergeResult,
  mergeReportFromResult,
} from "../../../dist/installer/matchlock/guest-cli.js";
import { GUEST_BRIDGE_PROTOCOL_VERSION } from "../../../dist/installer/matchlock/guest-protocol.js";
import { spawnSync } from "node:child_process";
import { runPlumbingMerge } from "../../../dist/installer/merge-branch.js";

// Test isolation: the in-process native runPlumbingMerge below consults the DB
// for commit identity/signing, so pin HOME/state/DB to a private temp dir
// before any test runs — the live operator state must never be opened.
const ISOLATED_STATE = tamanduaTempDir("tamandua-guest-bridge-state-");
const ISOLATED_HOME = path.join(ISOLATED_STATE, "home");
fs.mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.HOME = ISOLATED_HOME;
process.env.TAMANDUA_STATE_DIR = ISOLATED_STATE;
process.env.TAMANDUA_DB_PATH = path.join(ISOLATED_STATE, "tamandua.db");

const RUN = "aaaaaaaa-1111-4111-8111-111111111111";
const INV = "bbbbbbbb-2222-4222-8222-222222222222";
const AGENT = "feature-dev-merge_developer";
const STEP1 = "cccccccc-3333-4333-8333-333333333333";
const STEP2 = "dddddddd-4444-4444-8444-444444444444";

const NODE_BIN = process.execPath;
const NODE_DIR = path.dirname(NODE_BIN);

interface CleanupEntry {
  kind: "dir" | "child";
  path?: string;
  child?: ChildProcess;
}

const cleanups: CleanupEntry[] = [];

function tmpDir(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  cleanups.push({ kind: "dir", path: dir });
  return dir;
}

function trackChild(child: ChildProcess): ChildProcess {
  cleanups.push({ kind: "child", child });
  return child;
}

afterEach(() => {
  for (const entry of cleanups.splice(0)) {
    if (entry.kind === "child" && entry.child) {
      const child = entry.child;
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    }
    if (entry.kind === "dir" && entry.path) {
      fs.rmSync(entry.path, { recursive: true, force: true });
    }
  }
});

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${NODE_DIR}:/usr/bin:/bin`,
    HOME: tmpDir("tamandua-guest-home-"),
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_STATE_DIR: tmpDir("tamandua-guest-state-"),
  };
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

interface CollectResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function collect(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs?: number },
): Promise<CollectResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise<CollectResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(err as Error);
      return;
    }
    trackChild(child);
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => errOut.push(c));
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`child "${command} ${args.join(" ")}" timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(errOut).toString("utf-8"),
      });
    });
    if (opts.input !== undefined) {
      child.stdin!.write(opts.input);
    }
    child.stdin!.end();
  });
}

interface PackContext {
  root: string;
  manifest: GuestPackManifest;
  skillPath: string;
}

function buildPack(): PackContext {
  const container = tmpDir("tamandua-guest-pack-");
  const target = path.join(container, "pack");
  const result = buildGuestPack({ targetDir: target });
  const manifest = JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf-8")) as GuestPackManifest;
  return {
    root: target,
    manifest,
    skillPath: path.join(target, "skills", "tamandua-agents", "SKILL.md"),
  };
}

function makeBinding(): HostBinding {
  return {
    runId: RUN,
    invocationId: INV,
    agentId: AGENT,
    jobId: "job-1",
    role: "developer",
    admittedRoots: ["/work"],
    helperProtocolVersion: `${manifestVersion()}+p${GUEST_BRIDGE_PROTOCOL_VERSION}`,
    helperBuildVersion: manifestVersion(),
  };
}

let cachedManifestVersion: string | null = null;
function manifestVersion(): string {
  if (cachedManifestVersion === null) {
    const pack = buildPack();
    cachedManifestVersion = pack.manifest.tamanduaBuildVersion;
  }
  return cachedManifestVersion;
}

function step(stepId: string, over: Partial<FakeStepRow> = {}): FakeStepRow {
  return {
    stepId,
    agentId: AGENT,
    runId: RUN,
    status: "pending",
    expects: "",
    input: `task for ${stepId}`,
    retryCount: 0,
    maxRetries: 2,
    claimId: null,
    ...over,
  };
}

interface BridgeContext {
  pack: PackContext;
  socketDir: string;
  socketPath: string;
  workDir: string;
  serviceEnv: NodeJS.ProcessEnv;
  cliEnv: NodeJS.ProcessEnv;
  services: FakeStepServices;
  query?: FakeQueryServices;
  merge?: HostMergeServices;
  binding: HostBinding;
  broker: HostBrokerHandle;
  serviceChild: ChildProcess;
}

function startBridge(
  services: FakeStepServices,
  query?: FakeQueryServices,
  opts: { merge?: HostMergeServices; binding?: HostBinding; env?: Record<string, string> } = {},
): BridgeContext {
  const pack = buildPack();
  const socketDir = tmpDir("tamandua-guest-sock-");
  const socketPath = path.join(socketDir, "bridge.sock");
  const workDir = tmpDir("tamandua-guest-work-");

  const serviceEnv = childEnv({
    TAMANDUA_GUEST_SOCKET_DIR: socketDir,
    TAMANDUA_GUEST_BUILD_VERSION: pack.manifest.tamanduaBuildVersion,
    TAMANDUA_BRIDGE_HANDSHAKE_TIMEOUT_MS: "5000",
    TAMANDUA_BRIDGE_REQUEST_TIMEOUT_MS: "5000",
    TAMANDUA_RUN_ID: `run-${RUN}`,
    TAMANDUA_INVOCATION_ID: INV,
    TAMANDUA_WORKER_AGENT_ID: AGENT,
    ...(opts.env ?? {}),
  });
  const cliEnv: NodeJS.ProcessEnv = {
    ...serviceEnv,
    TAMANDUA_GUEST_SOCKET: socketPath,
  };

  const serviceChild = trackChild(
    spawn(path.join(pack.root, "bin", "tamandua-bridge"), [], {
      cwd: workDir,
      env: serviceEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );

  const binding = opts.binding ?? makeBinding();
  const broker = createHostBroker({
    binding,
    services,
    pipe: { toGuest: serviceChild.stdin!, fromGuest: serviceChild.stdout! },
    serviceTimeoutMs: 5000,
    ...(query ? { query } : {}),
    ...(opts.merge ? { merge: opts.merge } : {}),
  });
  return { pack, socketDir, socketPath, workDir, serviceEnv, cliEnv, services, query, merge: opts.merge, binding, broker, serviceChild };
}

async function stopBridge(ctx: BridgeContext): Promise<void> {
  try {
    await withTimeout(ctx.broker.close(), 4000, "broker close");
    await withTimeout(ctx.broker.closed, 4000, "broker closed");
  } catch {
    /* ignore */
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      ctx.serviceChild.kill("SIGKILL");
      resolve();
    }, 3000);
    ctx.serviceChild.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ctx.serviceChild.kill("SIGTERM");
  });
}

/** Run the REAL guest CLI launcher via bare PATH (harness-style invocation). */
function runCli(
  ctx: BridgeContext,
  args: string[],
  opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CollectResult> {
  const cwd = opts.cwd ?? ctx.workDir;
  const env = { ...(opts.env ?? ctx.cliEnv), PATH: `${path.join(ctx.pack.root, "bin")}:${NODE_DIR}:/usr/bin:/bin` };
  return collect("tamandua", args, { cwd, env, input: opts.input });
}

describe("guest pack artifact", () => {
  it("builds a self-contained pack; closure stays Node-core only", () => {
    const container = tmpDir("tamandua-guest-pack-check-");
    const target = path.join(container, "pack");
    const result = buildGuestPack({ targetDir: target });
    const rel = (p: string): string => path.relative(target, p);
    for (const f of ["bin/tamandua", "bin/tamandua-bridge", "manifest.json", "lib/installer/matchlock/guest-cli-entry.js"]) {
      assert.ok(fs.existsSync(path.join(target, f)), `pack must contain ${f}`);
    }
    const skill = path.join(target, "skills", "tamandua-agents", "SKILL.md");
    assert.ok(fs.existsSync(skill));
    const skillText = fs.readFileSync(skill, "utf-8");
    assert.match(skillText, /CRITICAL — STATUS line requirement/);
    assert.match(skillText, /STATUS: done/);
    const validation = validateGuestPack(target);
    assert.equal(validation.ok, true, validation.errors.join("; "));
    assert.ok(result.closureModules.length >= 4);
    for (const mod of result.closureModules) {
      assert.ok(mod.startsWith("installer/matchlock/"), `module out of allowed dir: ${mod}`);
    }
    // US-005: the portable pack ships the shared dependency-free merge core as
    // an explicit closure root and validateGuestPack accepts it (Node-core only).
    assert.ok(
      result.closureModules.includes("installer/matchlock/merge-core.js"),
      `merge core must be in the guest pack closure: ${result.closureModules.join(", ")}`,
    );
    assert.ok(
      validation.modules.some((m) => m.endsWith(path.join("installer", "matchlock", "merge-core.js"))),
      `validateGuestPack must validate the merge core: ${validation.modules.join(", ")}`,
    );
    assert.ok(rel(target).length >= 0);
    // Executable bits present on the launchers.
    const modeCli = fs.statSync(path.join(target, "bin", "tamandua")).mode;
    assert.ok((modeCli & 0o111) !== 0, "bin/tamandua must be executable");
    fs.rmSync(target, { recursive: true, force: true });
  });

  it("launcher answers version/help/skill-path locally from a fresh dir with no repo access", async () => {
    const pack = buildPack();
    const fresh = tmpDir("tamandua-guest-fresh-");
    const env = childEnv({ PATH: `${path.join(pack.root, "bin")}:${NODE_DIR}:/usr/bin:/bin` });

    const version = await collect("tamandua", ["version"], { cwd: fresh, env });
    assert.equal(version.code, 0);
    assert.equal(version.stdout.trim(), pack.manifest.tamanduaBuildVersion);
    assert.equal(version.stderr, "");

    const v2 = await collect("tamandua", ["--version"], { cwd: fresh, env });
    assert.equal(v2.stdout.trim(), pack.manifest.tamanduaBuildVersion);
    const v3 = await collect("tamandua", ["-v"], { cwd: fresh, env });
    assert.equal(v3.stdout.trim(), pack.manifest.tamanduaBuildVersion);

    const skill = await collect("tamandua", ["skill-path"], { cwd: fresh, env });
    assert.equal(skill.code, 0);
    assert.equal(fs.realpathSync(skill.stdout.trim()), fs.realpathSync(pack.skillPath));

    const help = await collect("tamandua", ["--help"], { cwd: fresh, env });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Matchlock guest worker helper/);
    assert.match(help.stdout, /Unsupported/);

    const noArgs = await collect("tamandua", [], { cwd: fresh, env });
    assert.equal(noArgs.code, 0);
    assert.match(noArgs.stdout, /Usage: tamandua <command>/);
  });

  it("absolute-path invocation matches bare-PATH invocation", async () => {
    const pack = buildPack();
    const fresh = tmpDir("tamandua-guest-abs-");
    const env = childEnv();
    const abs = await collect(path.join(pack.root, "bin", "tamandua"), ["version"], { cwd: fresh, env });
    assert.equal(abs.code, 0);
    assert.equal(abs.stdout.trim(), pack.manifest.tamanduaBuildVersion);
  });

  it("unsupported commands fail explicitly with no host fallback", async () => {
    const pack = buildPack();
    const fresh = tmpDir("tamandua-guest-unsup-");
    const env = childEnv({ PATH: `${path.join(pack.root, "bin")}:${NODE_DIR}:/usr/bin:/bin` });
    for (const args of [
      ["workflow", "list"],
      ["workflow", "run", "feature-dev-merge-worktree", "task"],
      ["workflow", "runs"],
      ["workflow", "stop", `run-${RUN}`],
      ["update"],
      ["source-path"],
      ["step", "release", `run-${RUN}`],
      ["logs-tail", `run-${RUN}`],
      ["logs", "20"],
      ["logs", "#3"],
    ]) {
      const result = await collect("tamandua", args, { cwd: fresh, env });
      assert.equal(result.code, 1, `expected exit 1 for ${args.join(" ")}`);
      assert.ok(result.stderr.length > 0, `expected stderr for ${args.join(" ")}`);
    }
    // Workflow lifecycle subcommand refusals name the refused command.
    const wfList = await collect("tamandua", ["workflow", "list"], { cwd: fresh, env });
    assert.match(wfList.stderr, /"workflow list" is not supported/);
    const wfRun = await collect("tamandua", ["workflow", "run", "x", "y"], { cwd: fresh, env });
    assert.match(wfRun.stderr, /"workflow run" is not supported/);
    const logsN = await collect("tamandua", ["logs", "20"], { cwd: fresh, env });
    assert.match(logsN.stderr, /global log enumeration/);
  });

  it("pack manifest and guest skill advertise the US-004 query surface; stories/status/logs are no longer unsupported", () => {
    const pack = buildPack();
    const manifest = pack.manifest;
    for (const cap of ["step.stories", "workflow.status", "logs.run", "step.peek", "step.claim", "step.complete", "step.fail"]) {
      assert.ok(manifest.capabilities.includes(cap), `capabilities must advertise ${cap}`);
    }
    // Stories/status/logs are no longer listed as unsupported; admin/other-run
    // shapes still are.
    const unsupportedText = manifest.unsupported.join("\n");
    assert.doesNotMatch(unsupportedText, /stories\/logs|step release\/stories/);
    assert.ok(manifest.unsupported.some((u) => u.includes("step release")), "step release stays unsupported");
    assert.ok(manifest.unsupported.some((u) => u.includes("global log enumeration")), "global log enumeration stays unsupported");
    assert.ok(manifest.unsupported.some((u) => u.includes("workflow lifecycle")), "workflow lifecycle commands stay unsupported");

    const skill = fs.readFileSync(pack.skillPath, "utf-8");
    assert.match(skill, /tamandua step stories <run-id> \[--json\]/);
    assert.match(skill, /tamandua workflow status <run-id> --json/);
    assert.match(skill, /tamandua logs <run-id>/);
    assert.doesNotMatch(skill, /step stories\/ logs|step release.*\/.*step stories/);
    // The unsupported section still refuses operator/lifecycle shapes.
    assert.match(skill, /step release/);
    assert.match(skill, /global log\s+enumeration/);
  });

  it("step CLI usage validation matches native contracts", async () => {
    const pack = buildPack();
    const fresh = tmpDir("tamandua-guest-usage-");
    const env = childEnv({ PATH: `${path.join(pack.root, "bin")}:${NODE_DIR}:/usr/bin:/bin` });

    const missingAgent = await collect("tamandua", ["step", "claim"], { cwd: fresh, env });
    assert.equal(missingAgent.code, 1);
    assert.match(missingAgent.stderr, /Missing agent-id/);

    const missingRun = await collect("tamandua", ["step", "peek", AGENT], { cwd: fresh, env });
    assert.equal(missingRun.code, 1);
    assert.match(missingRun.stderr, /Missing --run-id/);

    const wrongRunPrefix = await collect("tamandua", ["step", "peek", AGENT, "--run-id", `step-${RUN}`], { cwd: fresh, env });
    assert.equal(wrongRunPrefix.code, 1);
    assert.match(wrongRunPrefix.stderr, /that is a step id, not a run id/);

    const missingStep = await collect("tamandua", ["step", "complete"], { cwd: fresh, env });
    assert.equal(missingStep.code, 1);
    assert.match(missingStep.stderr, /Missing step-id/);

    const wrongStepPrefix = await collect("tamandua", ["step", "complete", `run-${RUN}`], { cwd: fresh, env });
    assert.equal(wrongStepPrefix.code, 1);
    assert.match(wrongStepPrefix.stderr, /that is a run id, not a step id/);

    const positional = await collect("tamandua", ["step", "complete", `step-${STEP1}`, "STATUS: done"], { cwd: fresh, env });
    assert.equal(positional.code, 1);
    assert.match(positional.stderr, /unexpected argument/);

    // No bridge configured: broker-bound commands must fail with a clear message.
    const noSocket = await collect("tamandua", ["step", "peek", AGENT, "--run-id", `run-${RUN}`], {
      cwd: fresh,
      env: childEnv({ PATH: `${path.join(pack.root, "bin")}:${NODE_DIR}:/usr/bin:/bin` }),
    });
    assert.equal(noSocket.code, 1);
    assert.match(noSocket.stderr, /guest bridge socket is not configured/);
  });
});

describe("guest bridge over real subprocesses", () => {
  it("full worker round: peek -> claim -> current -> complete(accepted); NO_WORK afterwards", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [
        step(STEP1, { expects: "STATUS: done\nCHANGES:" }),
        step(STEP2),
      ],
    });
    const ctx = startBridge(services);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true, ready.reason);

      const peek = await runCli(ctx, ["step", "peek", AGENT, "--run-id", `run-${RUN}`]);
      assert.equal(peek.code, 0, peek.stderr);
      assert.equal(peek.stdout.trim(), "HAS_WORK");

      const claim = await runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]);
      assert.equal(claim.code, 0, claim.stderr);
      const claimJson = JSON.parse(claim.stdout) as { stepId: string; runId: string; input: string };
      assert.equal(claimJson.stepId, `step-${STEP1}`);
      assert.equal(claimJson.runId, `run-${RUN}`);
      assert.equal(claimJson.input, `task for ${STEP1}`);

      const current = await runCli(ctx, ["step", "current", AGENT, "--run-id", `run-${RUN}`]);
      assert.equal(current.code, 0, current.stderr);
      assert.deepEqual(JSON.parse(current.stdout), claimJson);

      // A second concurrent helper invocation may connect while work is held.
      const [cur2, claim2] = await Promise.all([
        runCli(ctx, ["step", "current", AGENT, "--run-id", `run-${RUN}`]),
        runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]),
      ]);
      assert.equal(cur2.code, 0, cur2.stderr);
      assert.deepEqual(JSON.parse(cur2.stdout), claimJson);
      assert.equal(claim2.code, 0, claim2.stderr);
      assert.deepEqual(JSON.parse(claim2.stdout), claimJson, "idempotent claim returns the held step");

      // File report with Unicode + multiline content.
      const reportPath = path.join(ctx.workDir, "report file.txt");
      fs.writeFileSync(reportPath, "STATUS: done\nCHANGES: implemented — ✓ unicode\nTESTS: unit\n");
      const complete = await runCli(ctx, ["step", "complete", claimJson.stepId, "--file", reportPath]);
      assert.equal(complete.code, 0, complete.stderr);
      assert.equal(complete.stdout.trim(), JSON.stringify({ status: "advanced" }));

      // Expects-validation accepted event was emitted by the authoritative service.
      assert.ok(
        services.events.some((e) => e.event === "step.expects.validated" && e.outcome === "accepted"),
        "expected step.expects.validated accepted event",
      );

      const curAfter = await runCli(ctx, ["step", "current", AGENT, "--run-id", `run-${RUN}`]);
      assert.equal(curAfter.stdout.trim(), "NONE");

      // A further mutation in the same invocation is revoked explicitly.
      const late = await runCli(ctx, ["step", "complete", claimJson.stepId, "--file", reportPath]);
      assert.equal(late.code, 1);
      assert.match(late.stderr, /already completed|further mutations are revoked|no current claim/);
    } finally {
      await stopBridge(ctx);
    }
  });

  it("REJECTED completion retains the claim; corrected report completes in the same round", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:\nregex:COMMITS: [0-9a-f]{7,40}" })],
    });
    const ctx = startBridge(services);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true, ready.reason);
      const claim = await runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]);
      const stepId = (JSON.parse(claim.stdout) as { stepId: string }).stepId;

      const badPath = path.join(ctx.workDir, "bad.txt");
      fs.writeFileSync(badPath, "STATUS: done\nTESTS: present\nCOMMITS: abc");
      const bad = await runCli(ctx, ["step", "complete", stepId, "--file", badPath]);
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /REJECTED: output does not satisfy expects/);
      assert.match(bad.stderr, /CHANGES/);
      assert.match(bad.stderr, /you still hold the step/);

      // Claim + retry budget retained for correction.
      assert.equal(services.row(STEP1)?.status, "running");
      assert.equal(services.row(STEP1)?.retryCount, 0);
      const stillHeld = await runCli(ctx, ["step", "current", AGENT, "--run-id", `run-${RUN}`]);
      assert.equal((JSON.parse(stillHeld.stdout) as { stepId: string }).stepId, stepId);

      const goodPath = path.join(ctx.workDir, "good.txt");
      fs.writeFileSync(goodPath, "STATUS: done\nCHANGES: fixed\nCOMMITS: abc1234\nTESTS: yes\n");
      const good = await runCli(ctx, ["step", "complete", stepId, "--file", goodPath]);
      assert.equal(good.code, 0, good.stderr);
      assert.equal(good.stdout.trim(), JSON.stringify({ status: "advanced" }));
      assert.equal(services.row(STEP1)?.status, "done");
      assert.ok(services.events.some((e) => e.event === "step.submit.rejected"), "expected a submit.rejected event");
    } finally {
      await stopBridge(ctx);
    }
  });

  it("step fail with --reason-file (multi-line, spaces) follows native semantics", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const ctx = startBridge(services);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true);
      const claim = await runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]);
      const stepId = (JSON.parse(claim.stdout) as { stepId: string }).stepId;

      const reasonPath = path.join(ctx.workDir, "reason file.txt");
      fs.writeFileSync(reasonPath, "cannot proceed — blocked by missing dependency\nsecond line");
      const failed = await runCli(ctx, ["step", "fail", stepId, "--reason-file", reasonPath]);
      assert.equal(failed.code, 0, failed.stderr);
      assert.equal(failed.stdout.trim(), JSON.stringify({ status: "retrying" }));
      assert.equal(services.row(STEP1)?.status, "pending");
    } finally {
      await stopBridge(ctx);
    }
  });

  it("guest-side STORIES_JSON_FILE dereference inlines a validated JSON array", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    const ctx = startBridge(services);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true);
      const claim = await runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]);
      const stepId = (JSON.parse(claim.stdout) as { stepId: string }).stepId;

      const storiesPath = path.join(ctx.workDir, "stories.json");
      fs.writeFileSync(storiesPath, JSON.stringify([{ id: "US-1", status: "done", title: "x" }]));
      const reportPath = path.join(ctx.workDir, "report.txt");
      fs.writeFileSync(reportPath, `STATUS: done\nCHANGES: x\nSTORIES_JSON_FILE: stories.json\nTESTS: y`);
      const complete = await runCli(ctx, ["step", "complete", stepId, "--file", reportPath]);
      assert.equal(complete.code, 0, complete.stderr);
      assert.equal(complete.stdout.trim(), JSON.stringify({ status: "advanced" }));
      const stored = services.row(STEP1)?.output ?? "";
      assert.match(stored, /STORIES_JSON: \[/);
      assert.ok(!stored.includes("STORIES_JSON_FILE:"), "file reference must be replaced guest-side");
    } finally {
      await stopBridge(ctx);
    }
  });

  it("rejects a STORIES_JSON_FILE that is not a valid array without consuming the claim", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const ctx = startBridge(services);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true);
      const claim = await runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]);
      const stepId = (JSON.parse(claim.stdout) as { stepId: string }).stepId;

      const badStories = path.join(ctx.workDir, "bad-stories.json");
      fs.writeFileSync(badStories, JSON.stringify({ not: "an array" }));
      const reportPath = path.join(ctx.workDir, "report2.txt");
      fs.writeFileSync(reportPath, `STATUS: done\nCHANGES: x\nSTORIES_JSON_FILE: bad-stories.json`);
      const complete = await runCli(ctx, ["step", "complete", stepId, "--file", reportPath]);
      assert.equal(complete.code, 1);
      assert.match(complete.stderr, /STORIES_JSON_FILE error: file .* must contain a JSON array/);
      assert.equal(services.row(STEP1)?.status, "running");
    } finally {
      await stopBridge(ctx);
    }
  });

  it("rejects completion of a step the invocation does not hold (foreign step)", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [
        step(STEP1, { expects: "STATUS: done\nCHANGES:" }),
        step(STEP2),
      ],
    });
    const ctx = startBridge(services);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true);
      const claim = await runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]);
      const stepId = (JSON.parse(claim.stdout) as { stepId: string }).stepId;
      assert.equal(stepId, `step-${STEP1}`);
      assert.equal(services.row(STEP1)?.status, "running");

      // Completing a DIFFERENT step than the one this invocation holds is
      // rejected before any mutation; the held claim stays intact.
      const reportPath = path.join(ctx.workDir, "foreign.txt");
      fs.writeFileSync(reportPath, "STATUS: done\nCHANGES: wrong step");
      const complete = await runCli(ctx, ["step", "complete", `step-${STEP2}`, "--file", reportPath]);
      assert.equal(complete.code, 1);
      assert.match(complete.stderr, /not the step currently claimed/);
      assert.equal(services.row(STEP1)?.status, "running", "held claim must be untouched");
      assert.equal(services.row(STEP2)?.status, "pending", "foreign step must not be consumed");
    } finally {
      await stopBridge(ctx);
    }
  });

  it("stale socket path is refused, never unlinked blindly", async () => {
    const pack = buildPack();
    const socketDir = tmpDir("tamandua-guest-stale-sock-");
    const socketPath = path.join(socketDir, "bridge.sock");
    fs.writeFileSync(socketPath, "pre-existing file content"); // NOT a socket
    const env = childEnv({ TAMANDUA_GUEST_SOCKET_DIR: socketDir, TAMANDUA_GUEST_BUILD_VERSION: pack.manifest.tamanduaBuildVersion });
    const child = trackChild(
      spawn(path.join(pack.root, "bin", "tamandua-bridge"), [], { cwd: socketDir, env, stdio: ["pipe", "pipe", "pipe"] }),
    );
    const result = await withTimeout(
      new Promise<CollectResult>((resolve, reject) => {
        const out: Buffer[] = [];
        const errOut: Buffer[] = [];
        child.stdout!.on("data", (c: Buffer) => out.push(c));
        child.stderr!.on("data", (c: Buffer) => errOut.push(c));
        const timer = setTimeout(() => reject(new Error("stale-socket service did not exit")), 6000);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(errOut).toString("utf-8") });
        });
        child.stdin!.end();
      }),
      8000,
      "stale socket service exit",
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already exists|refusing to unlink/);
    assert.equal(fs.readFileSync(socketPath, "utf-8"), "pre-existing file content", "stale path must not be removed");
  });

  it("step complete via stdin keeps native contracts", async () => {
    const services = new FakeStepServices({
      runId: RUN,
      agentId: AGENT,
      steps: [step(STEP1, { expects: "STATUS: done\nCHANGES:" })],
    });
    const ctx = startBridge(services);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true);
      const claim1 = await runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]);
      assert.equal(claim1.code, 0, claim1.stderr);
      const stepId1 = (JSON.parse(claim1.stdout) as { stepId: string }).stepId;
      const viaStdin = await runCli(ctx, ["step", "complete", stepId1], {
        input: "STATUS: done\nCHANGES: via stdin — ünïcode ✓\nTESTS: x",
      });
      assert.equal(viaStdin.code, 0, viaStdin.stderr);
      assert.equal(viaStdin.stdout.trim(), JSON.stringify({ status: "advanced" }));
    } finally {
      await stopBridge(ctx);
    }
  });

  it("step fail with inline reason and the native default reason", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const ctx = startBridge(services);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true);
      const claim = await runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]);
      assert.equal(claim.code, 0, claim.stderr);
      const stepId = (JSON.parse(claim.stdout) as { stepId: string }).stepId;

      const inline = await runCli(ctx, ["step", "fail", stepId, "cannot continue — blocked ✗"]);
      assert.equal(inline.code, 0, inline.stderr);
      assert.equal(inline.stdout.trim(), JSON.stringify({ status: "retrying" }));
      assert.equal(services.row(STEP1)?.output, "cannot continue — blocked ✗");
    } finally {
      await stopBridge(ctx);
    }
  });

  it("step fail with no reason uses the native default 'Unknown error'", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const ctx = startBridge(services);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true);
      const claim = await runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]);
      const stepId = (JSON.parse(claim.stdout) as { stepId: string }).stepId;
      const noReason = await runCli(ctx, ["step", "fail", stepId]);
      assert.equal(noReason.code, 0, noReason.stderr);
      assert.equal(services.row(STEP1)?.output, "Unknown error");
    } finally {
      await stopBridge(ctx);
    }
  });

  it("NO_WORK / NONE contracts when no step is pending", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const ctx = startBridge(services);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true);
      const peek = await runCli(ctx, ["step", "peek", AGENT, "--run-id", `run-${RUN}`]);
      assert.equal(peek.code, 0, peek.stderr);
      assert.equal(peek.stdout.trim(), "NO_WORK");
      const claim = await runCli(ctx, ["step", "claim", AGENT, "--run-id", `run-${RUN}`]);
      assert.equal(claim.code, 0, claim.stderr);
      assert.equal(claim.stdout.trim(), "NO_WORK");
      const current = await runCli(ctx, ["step", "current", AGENT, "--run-id", `run-${RUN}`]);
      assert.equal(current.code, 0, current.stderr);
      assert.equal(current.stdout.trim(), "NONE");
    } finally {
      await stopBridge(ctx);
    }
  });

  it("host close ends the pipe; the guest service shuts down, unlinks its socket and exits 0", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const ctx = startBridge(services);
    const exitPromise = new Promise<number | null>((resolve) => {
      ctx.serviceChild.once("close", (code) => resolve(code));
    });
    const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
    assert.equal(ready.ok, true);
    const socketExists = (): boolean => fs.existsSync(ctx.socketPath);
    assert.ok(socketExists());
    await withTimeout(ctx.broker.close(), 4000, "broker close");
    await withTimeout(ctx.broker.closed, 4000, "broker closed");
    const code = await withTimeout(exitPromise, 8000, "service exit");
    assert.equal(code, 0);
    assert.equal(socketExists(), false, "owned socket must be unlinked on shutdown");
  });
});

describe("US-004 guest bounded query surface over real subprocesses", () => {
  function queryFixture(): FakeQueryFixture {
    return {
      stories: [
        {
          storyId: "US-001",
          title: "First story",
          status: "done",
          retryCount: 0,
          resumeResetCount: 0,
          abandonedCount: 3,
          updatedAt: "2026-09-09T00:00:00.000Z",
        },
        {
          storyId: "US-002",
          title: "Blocked story",
          status: "pending",
          retryCount: 2,
          resumeResetCount: 1,
        },
      ],
      status: {
        runId: `run-${RUN}`,
        runNumber: 7,
        workflowId: "feature-dev-merge-worktree",
        status: "running",
        harnessType: "pi",
        task: "Do the thing",
        tokensSpent: 0,
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:01.000Z",
        steps: [
          {
            stepId: `step-${STEP1}`,
            stepIndex: 0,
            agentRole: "developer",
            status: "done",
            displayStatus: "done",
            retryCount: 0,
          },
        ],
        stories: [
          { storyId: "US-001", title: "First story", status: "done", resumeResetCount: 0 },
          { storyId: "US-002", title: "Blocked story", status: "pending", resumeResetCount: 1, priorFailureCount: 1 },
        ],
      },
      logLines: [
        "9:09:09 AM  [run-aaaaaaaa]  developer  Step completed",
        "9:09:10 AM  [run-aaaaaaaa]  Step rerouted",
      ],
    };
  }

  it("step stories <run> --json prints the native-shaped {runId, stories} object through the whole path", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [step(STEP1)] });
    const query = new FakeQueryServices({ runId: RUN, fixture: queryFixture() });
    const ctx = startBridge(services, query);
    try {
      const ready = await withTimeout(ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true, ready.reason);

      const stories = await runCli(ctx, ["step", "stories", `run-${RUN}`, "--json"]);
      assert.equal(stories.code, 0, stories.stderr);
      const parsed = JSON.parse(stories.stdout) as { runId: string; stories: Array<Record<string, unknown>> };
      assert.equal(parsed.runId, `run-${RUN}`);
      assert.equal(parsed.stories.length, 2);
      // Native buildStoriesJson shape: no retry/resume presentation fields.
      const s1 = parsed.stories[0];
      assert.deepEqual(
        Object.keys(s1).sort(),
        ["abandonedCount", "storyId", "title", "status", "updatedAt"].sort(),
      );
      assert.equal(s1.storyId, "US-001");
      assert.equal(s1.status, "done");
      const s2 = parsed.stories[1];
      assert.equal("abandonedCount" in s2, false, "abandonedCount omitted when absent/0");
      assert.equal("retryCount" in s2, false, "retryCount must not leak into native JSON output");
      assert.equal("resumeResetCount" in s2, false, "resumeResetCount must not leak into native JSON output");
      assert.deepEqual(query.calls, ["stories"]);
    } finally {
      await stopBridge(ctx);
    }
  });

  it("step stories <run> human listing matches the native story lines", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const query = new FakeQueryServices({ runId: RUN, fixture: queryFixture() });
    const ctx = startBridge(services, query);
    try {
      await withTimeout(ctx.broker.ready, 6000, "broker ready");
      const stories = await runCli(ctx, ["step", "stories", `run-${RUN}`]);
      assert.equal(stories.code, 0, stories.stderr);
      const lines = stories.stdout.trim().split("\n");
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^US-001\s+\[done\s+\]\s+First story$/);
      // resumeResetCount=1 => native 'pending (reset on resume, 1 prior failure)'
      assert.match(lines[1], /^US-002\s+\[pending \(reset on resume, 1 prior failure\)\]\s+Blocked story \(retry 2\)$/);
    } finally {
      await stopBridge(ctx);
    }
  });

  it("workflow status <run> --json prints the native run-JSON object", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const query = new FakeQueryServices({ runId: RUN, fixture: queryFixture() });
    const ctx = startBridge(services, query);
    try {
      await withTimeout(ctx.broker.ready, 6000, "broker ready");
      const status = await runCli(ctx, ["workflow", "status", `run-${RUN}`, "--json"]);
      assert.equal(status.code, 0, status.stderr);
      assert.deepEqual(JSON.parse(status.stdout), queryFixture().status);
      assert.deepEqual(query.calls, ["workflowStatus"]);
    } finally {
      await stopBridge(ctx);
    }
  });

  it("logs <run> prints bounded native run-event lines; No events yet. when empty", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const query = new FakeQueryServices({ runId: RUN, fixture: queryFixture() });
    const ctx = startBridge(services, query);
    try {
      await withTimeout(ctx.broker.ready, 6000, "broker ready");
      const logs = await runCli(ctx, ["logs", `run-${RUN}`]);
      assert.equal(logs.code, 0, logs.stderr);
      assert.equal(logs.stdout.trim(), queryFixture().logLines.join("\n"));
      assert.deepEqual(query.calls, ["runLogs"]);

      const empty = new FakeQueryServices({ runId: RUN, fixture: { logLines: [] } });
      const ctx2 = startBridge(new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] }), empty);
      try {
        await withTimeout(ctx2.broker.ready, 6000, "broker ready");
        const noEvents = await runCli(ctx2, ["logs", `run-${RUN}`]);
        assert.equal(noEvents.code, 0, noEvents.stderr);
        assert.equal(noEvents.stdout.trim(), "No events yet.");
      } finally {
        await stopBridge(ctx2);
      }
    } finally {
      await stopBridge(ctx);
    }
  });

  it("refuses query commands for usage/foreign-run/global shapes with clear errors and NO host read", async () => {
    const services = new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] });
    const query = new FakeQueryServices({ runId: RUN, fixture: queryFixture() });
    const ctx = startBridge(services, query);
    try {
      await withTimeout(ctx.broker.ready, 6000, "broker ready");
      const OTHER = "eeeeeeee-5555-4555-8555-555555555555";

      // Foreign run -> typed BINDING refusal surfaced to the guest CLI.
      const foreign = await runCli(ctx, ["step", "stories", `run-${OTHER}`, "--json"]);
      assert.equal(foreign.code, 1);
      assert.match(foreign.stderr, /is not bound to this invocation/);

      const foreignStatus = await runCli(ctx, ["workflow", "status", `run-${OTHER}`, "--json"]);
      assert.equal(foreignStatus.code, 1);
      assert.match(foreignStatus.stderr, /is not bound to this invocation/);

      const foreignLogs = await runCli(ctx, ["logs", `run-${OTHER}`]);
      assert.equal(foreignLogs.code, 1);
      assert.match(foreignLogs.stderr, /is not bound to this invocation/);

      // No host read happened for any refused query.
      assert.deepEqual(query.calls, []);

      // Wrong-prefix run id keeps the native wording.
      const wrongPrefix = await runCli(ctx, ["step", "stories", `step-${STEP1}`, "--json"]);
      assert.equal(wrongPrefix.code, 1);
      assert.match(wrongPrefix.stderr, /that is a step id, not a run id/);

      // workflow status requires --json on the restricted surface.
      const humanStatus = await runCli(ctx, ["workflow", "status", `run-${RUN}`]);
      assert.equal(humanStatus.code, 1);
      assert.match(humanStatus.stderr, /requires --json/);

      // Global shapes are refused before any request reaches the host.
      const noRun = await runCli(ctx, ["logs"]);
      assert.equal(noRun.code, 1);
      assert.match(noRun.stderr, /Missing run-id/);
      const numeric = await runCli(ctx, ["logs", "25"]);
      assert.equal(numeric.code, 1);
      assert.match(numeric.stderr, /global log enumeration/);
      assert.deepEqual(query.calls, []);

      // Admin/lifecycle ops stay refused by the guest CLI.
      const release = await runCli(ctx, ["step", "release", `run-${RUN}`]);
      assert.equal(release.code, 1);
      assert.match(release.stderr, /step release.*not supported/);
      const wfList = await runCli(ctx, ["workflow", "list"]);
      assert.equal(wfList.code, 1);
      assert.match(wfList.stderr, /workflow list.*not supported/);
      assert.deepEqual(query.calls, []);
    } finally {
      await stopBridge(ctx);
    }
  });
});

// ── US-007 guest merge-branch over real subprocesses ─────────────────────────

describe("US-007 guest merge-branch command over real subprocesses", () => {
  const MERGER_AGENT = "feature-dev-merge-worktree_merger";
  const MERGE_STEP = "eeeeeeee-5555-4555-8555-555555555555";

  const FIXED_GIT_ENV: Record<string, string> = {
    GIT_AUTHOR_NAME: "Tamandua Test",
    GIT_AUTHOR_EMAIL: "test@tamandua.local",
    GIT_COMMITTER_NAME: "Tamandua Test",
    GIT_COMMITTER_EMAIL: "test@tamandua.local",
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  function gitEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/root",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...FIXED_GIT_ENV,
    };
  }

  function git(cwd: string, args: string[]): string {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return (result.stdout ?? "").trim();
  }

  interface MergeFixture {
    repo: string;
    initial: string;
  }

  function mergeFixture(): MergeFixture {
    const repo = tamanduaTempDir("tamandua-guest-merge-");
    cleanups.push({ kind: "dir", path: repo });
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@tamandua.local"]);
    git(repo, ["config", "user.name", "Tamandua Test"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-m", "base"]);
    return { repo, initial: git(repo, ["rev-parse", "HEAD"]) };
  }

  function addFeature(fx: MergeFixture, branch = "feature"): string {
    git(fx.repo, ["switch", "-c", branch]);
    fs.writeFileSync(path.join(fx.repo, "feature.txt"), "feature\n");
    git(fx.repo, ["add", "feature.txt"]);
    git(fx.repo, ["commit", "-m", `feat ${branch}`]);
    const tip = git(fx.repo, ["rev-parse", "HEAD"]);
    git(fx.repo, ["switch", "main"]);
    return tip;
  }

  function realTip(origin: string, into: string): string | null {
    const result = spawnSync("git", ["-C", origin, "rev-parse", "--verify", `refs/heads/${into}^{commit}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    });
    return result.status === 0 ? (result.stdout ?? "").trim() : null;
  }

  function fixedRunner(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    });
    return { stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), status: result.status ?? -1 };
  }

  function mergerServices(): FakeStepServices {
    return new FakeStepServices({
      runId: RUN,
      agentId: MERGER_AGENT,
      steps: [
        {
          stepId: MERGE_STEP,
          agentId: MERGER_AGENT,
          runId: RUN,
          status: "running",
          expects: "",
          input: "finalize",
          retryCount: 0,
          maxRetries: 0,
          claimId: "claim-merge",
        },
      ],
    });
  }

  function mergerBinding(agentId = MERGER_AGENT, role = "merger"): HostBinding {
    return {
      runId: RUN,
      invocationId: INV,
      agentId,
      jobId: "job-merge",
      role,
      admittedRoots: [],
      helperProtocolVersion: `${manifestVersion()}+p${GUEST_BRIDGE_PROTOCOL_VERSION}`,
      helperBuildVersion: manifestVersion(),
    };
  }

  interface MergeHarness {
    ctx: BridgeContext;
    events: MergeCoreEvent[];
    services: FakeStepServices;
  }

  function startMergeHarness(
    repo: string,
    opts: {
      agentId?: string;
      role?: string;
      services?: FakeStepServices;
      readTargetTip?: (origin: string, into: string) => string | null;
    } = {},
  ): MergeHarness {
    const agentId = opts.agentId ?? MERGER_AGENT;
    const role = opts.role ?? "merger";
    const events: MergeCoreEvent[] = [];
    const merge = createHostMergeService(
      {
        runId: RUN,
        originalRepositoryRoot: repo,
        originalBranch: "main",
        finalizeMergeStepId: MERGE_STEP,
        admittedRoots: [repo],
        imageDigest: "sha256:img",
      },
      {
        readTargetTip: opts.readTargetTip ?? realTip,
        emitEvent: (event) => events.push(event),
        now: () => new Date("2026-01-02T03:04:05.000Z"),
      },
    );
    const services = opts.services ?? mergerServices();
    const ctx = startBridge(services, undefined, {
      merge,
      binding: mergerBinding(agentId, role),
      env: { TAMANDUA_WORKER_AGENT_ID: agentId, ...FIXED_GIT_ENV },
    });
    return { ctx, events, services };
  }

  function field(stdout: string, name: string): string {
    const match = stdout.match(new RegExp(`^${name}: (.*)$`, "m"));
    assert.ok(match, `missing ${name} in:\n${stdout}`);
    return match![1]!;
  }

  async function runMergeCli(
    h: MergeHarness,
    repo: string,
    over: { branch?: string; into?: string; expectTip?: string; message?: string } = {},
  ): Promise<CollectResult> {
    const ready = await withTimeout(h.ctx.broker.ready, 6000, "broker ready");
    assert.equal(ready.ok, true, ready.reason);
    return runCli(h.ctx, [
      "merge-branch",
      "--origin", repo,
      "--branch", over.branch ?? "feature",
      "--into", over.into ?? "main",
      "--expect-tip", over.expectTip ?? git(repo, ["rev-parse", "HEAD"]),
      "--message", over.message ?? "merge feature",
    ]);
  }

  it("lands a real feature branch with native output/exit and byte-identical MERGED_TREE/MERGED_COMMIT vs native", async () => {
    const nativeFx = mergeFixture();
    addFeature(nativeFx);
    const nativeEvents: MergeCoreEvent[] = [];
    const native = runPlumbingMerge(
      { origin: nativeFx.repo, branch: "feature", into: "main", expectTip: nativeFx.initial, message: "merge feature", runId: RUN },
      { runGit: fixedRunner, emitEvent: (e) => nativeEvents.push(e as MergeCoreEvent), now: () => new Date("2026-01-02T03:04:05.000Z") },
    );
    assert.equal(native.status, "landed");

    const guestFx = mergeFixture();
    addFeature(guestFx);
    const h = startMergeHarness(guestFx.repo);
    try {
      const result = await runMergeCli(h, guestFx.repo, { expectTip: guestFx.initial });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(field(result.stdout, "STATUS"), "landed");
      assert.equal(field(result.stdout, "NOOP"), "false");
      assert.equal(field(result.stdout, "TARGET"), "refs/heads/main");
      assert.equal(field(result.stdout, "CHECKOUT_REFRESH"), "refreshed");
      assert.equal(field(result.stdout, "MERGED_TREE"), native.status === "landed" ? native.mergedTree : "");
      assert.equal(field(result.stdout, "MERGED_COMMIT"), native.status === "landed" ? native.mergedCommit : "");
      // Real run attribution + real target advance.
      assert.equal(h.events.length, 1);
      assert.equal(h.events[0]!.event, "merge.landed");
      assert.equal(h.events[0]!.runId, RUN);
      assert.equal(git(guestFx.repo, ["rev-parse", "HEAD"]), native.mergedCommit);
      // Run-attributed reflog on the advanced target.
      assert.match(git(guestFx.repo, ["reflog", "-1", "refs/heads/main", "--format=%gs"]), new RegExp(`run=${RUN}`));
    } finally {
      await stopBridge(h.ctx);
    }
  });

  it("carries a multiline/Unicode commit message into the landing commit", async () => {
    const fx = mergeFixture();
    addFeature(fx);
    const h = startMergeHarness(fx.repo);
    try {
      const message = "Résumé ✓\n\nBody with Unicode: naïve — ünïcode\n\nCo-Authored-By: Tamandua <tamandua@tetradactyla.org>";
      const result = await runMergeCli(h, fx.repo, { expectTip: fx.initial, message });
      assert.equal(result.code, 0, result.stderr);
      const mergedCommit = field(result.stdout, "MERGED_COMMIT");
      assert.equal(git(fx.repo, ["log", "-1", "--format=%B", mergedCommit]).trim(), message);
    } finally {
      await stopBridge(h.ctx);
    }
  });

  it("reports conflicts with native exit 3 and a run-attributed conflicts event", async () => {
    const fx = mergeFixture();
    git(fx.repo, ["switch", "-c", "feature"]);
    fs.writeFileSync(path.join(fx.repo, "base.txt"), "feature version\n");
    git(fx.repo, ["commit", "-am", "feature conflict"]);
    git(fx.repo, ["switch", "main"]);
    fs.writeFileSync(path.join(fx.repo, "base.txt"), "main version\n");
    git(fx.repo, ["commit", "-am", "main conflict"]);
    const h = startMergeHarness(fx.repo);
    try {
      const result = await runMergeCli(h, fx.repo, { expectTip: git(fx.repo, ["rev-parse", "HEAD"]) });
      assert.equal(result.code, 3, result.stderr);
      assert.match(result.stdout, /^STATUS: conflicts\n/);
      assert.match(result.stdout, /base\.txt/);
      assert.equal(h.events.length, 1);
      assert.equal(h.events[0]!.event, "merge.conflicts");
      assert.equal(h.events[0]!.runId, RUN);
    } finally {
      await stopBridge(h.ctx);
    }
  });

  it("reports target_moved with exit 2 when the target moves after authorization (no target change by the guest)", async () => {
    const fx = mergeFixture();
    addFeature(fx);
    const staleTip = fx.initial;
    // The target moves after the host authorized the (now stale) expect-tip.
    git(fx.repo, ["commit", "--allow-empty", "-m", "external target advance"]);
    const movedTip = git(fx.repo, ["rev-parse", "HEAD"]);
    let reads = 0;
    const h = startMergeHarness(fx.repo, {
      // First read (authorization): the tip that was current when authorized.
      // Later reads (receipt verification): the real, moved tip.
      readTargetTip: () => (reads++ === 0 ? staleTip : realTip(fx.repo, "main")),
    });
    try {
      const result = await runMergeCli(h, fx.repo, { expectTip: staleTip });
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stdout, /^STATUS: target_moved\n/);
      assert.equal(git(fx.repo, ["rev-parse", "HEAD"]), movedTip, "target must be untouched");
      assert.equal(h.events.length, 1);
      assert.equal(h.events[0]!.event, "merge.target_moved");
      assert.equal(h.events[0]!.runId, RUN);
    } finally {
      await stopBridge(h.ctx);
    }
  });

  it("parks a dirty owner with native CHECKOUT_REFRESH/PARKED_* output and MERGED_TREE parity", async () => {
    const nativeFx = mergeFixture();
    addFeature(nativeFx);
    fs.writeFileSync(path.join(nativeFx.repo, "base.txt"), "dirty owner\n");
    const nativeEvents: MergeCoreEvent[] = [];
    const native = runPlumbingMerge(
      { origin: nativeFx.repo, branch: "feature", into: "main", expectTip: nativeFx.initial, message: "merge dirty", runId: RUN },
      { runGit: fixedRunner, emitEvent: (e) => nativeEvents.push(e as MergeCoreEvent), now: () => new Date("2026-01-02T03:04:05.000Z") },
    );
    assert.equal(native.status, "landed");
    if (native.status !== "landed") return;
    assert.match(native.checkoutRefresh, /^parked:/);

    const guestFx = mergeFixture();
    addFeature(guestFx);
    fs.writeFileSync(path.join(guestFx.repo, "base.txt"), "dirty owner\n");
    const h = startMergeHarness(guestFx.repo);
    try {
      const result = await runMergeCli(h, guestFx.repo, { expectTip: guestFx.initial, message: "merge dirty" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(field(result.stdout, "MERGED_TREE"), native.mergedTree);
      assert.match(field(result.stdout, "CHECKOUT_REFRESH"), /^parked:/);
      assert.equal(field(result.stdout, "PARKED_REASON"), "local-changes");
      assert.match(result.stdout, /^PARKED_BRANCH: /m);
      assert.equal(fs.readFileSync(path.join(guestFx.repo, "base.txt"), "utf-8"), "dirty owner\n", "local bytes preserved");
    } finally {
      await stopBridge(h.ctx);
    }
  });

  it("refuses an unauthorized finalizer BEFORE any Git action with zero ref/file mutation", async () => {
    const fx = mergeFixture();
    addFeature(fx);
    const before = {
      refs: git(fx.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]),
      feature: git(fx.repo, ["rev-parse", "feature"]),
    };
    const h = startMergeHarness(fx.repo, {
      agentId: AGENT,
      role: "developer",
      services: new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] }),
    });
    try {
      const result = await runMergeCli(h, fx.repo, { expectTip: git(fx.repo, ["rev-parse", "HEAD"]) });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /role "developer" is not authorized to merge/);
      assert.equal(h.events.length, 0);
      assert.deepEqual(
        {
          refs: git(fx.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]),
          feature: git(fx.repo, ["rev-parse", "feature"]),
        },
        before,
      );
    } finally {
      await stopBridge(h.ctx);
    }
  });

  it("refuses an unadmitted origin and a foreign target before any Git action", async () => {
    const fx = mergeFixture();
    addFeature(fx);
    const h = startMergeHarness(fx.repo);
    try {
      const ready = await withTimeout(h.ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true, ready.reason);
      const refsBefore = git(fx.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
      const outside = await runCli(h.ctx, [
        "merge-branch",
        "--origin", path.join(fx.repo, "..", "not-admitted"),
        "--branch", "feature", "--into", "main",
        "--expect-tip", git(fx.repo, ["rev-parse", "HEAD"]),
        "--message", "x",
      ]);
      assert.equal(outside.code, 1);
      assert.match(outside.stderr, /outside the admitted original repository root/);
      const foreignTarget = await runMergeCli(h, fx.repo, { into: "release" });
      assert.equal(foreignTarget.code, 1);
      assert.match(foreignTarget.stderr, /is not this run's original branch/);
      assert.equal(git(fx.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]), refsBefore);
      assert.equal(h.events.length, 0);
    } finally {
      await stopBridge(h.ctx);
    }
  });

  it("reports an already-landed ancestor as a NOOP with exit 0 and MERGED_TREE parity", async () => {
    const nativeFx = mergeFixture();
    addFeature(nativeFx);
    git(nativeFx.repo, ["merge", "--ff-only", "feature"]);
    const native = runPlumbingMerge(
      { origin: nativeFx.repo, branch: "feature", into: "main", expectTip: git(nativeFx.repo, ["rev-parse", "HEAD"]), message: "noop", runId: RUN },
      { runGit: fixedRunner, emitEvent: () => undefined, now: () => new Date("2026-01-02T03:04:05.000Z") },
    );
    assert.equal(native.status, "landed");
    if (native.status !== "landed") return;
    assert.equal(native.noop, true);

    const guestFx = mergeFixture();
    addFeature(guestFx);
    git(guestFx.repo, ["merge", "--ff-only", "feature"]);
    const h = startMergeHarness(guestFx.repo);
    try {
      const result = await runMergeCli(h, guestFx.repo, { message: "noop" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(field(result.stdout, "NOOP"), "true");
      assert.equal(field(result.stdout, "MERGED_TREE"), native.mergedTree);
      assert.equal(field(result.stdout, "MERGED_COMMIT"), native.mergedCommit);
      assert.equal(field(result.stdout, "CHECKOUT_REFRESH"), "already-coherent");
      assert.equal(h.events.length, 1);
      assert.equal(h.events[0]!.event, "merge.landed");
      assert.equal(h.events[0]!.noop, true);
    } finally {
      await stopBridge(h.ctx);
    }
  });

  it("refuses a stale expect-tip before any landing Git action and mutates nothing", async () => {
    const fx = mergeFixture();
    addFeature(fx);
    const h = startMergeHarness(fx.repo);
    try {
      const ready = await withTimeout(h.ctx.broker.ready, 6000, "broker ready");
      assert.equal(ready.ok, true, ready.reason);
      const refsBefore = git(fx.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
      const result = await runMergeCli(h, fx.repo, { expectTip: "0".repeat(40) });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /does not match the current authoritative target tip/);
      assert.equal(git(fx.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]), refsBefore);
      assert.equal(h.events.length, 0);
    } finally {
      await stopBridge(h.ctx);
    }
  });

  it("parses the exact named options and refuses malformed option shapes", () => {
    const parsed = parseGuestMergeBranchOptions([
      "--origin", "/repo", "--branch", "feature", "--into", "main",
      "--expect-tip", "a".repeat(40), "--message", "line one\nline two", "--run-id", "run-x",
    ]);
    assert.equal(parsed["--origin"], "/repo");
    assert.equal(parsed["--message"], "line one\nline two");
    assert.equal(parsed["--run-id"], "run-x");
    assert.throws(() => parseGuestMergeBranchOptions(["--origin", "/repo"]), /Missing required option/);
    assert.throws(() => parseGuestMergeBranchOptions(["--bogus", "x"]), /Unknown option/);
    assert.throws(() => parseGuestMergeBranchOptions(["--origin", "/r", "--origin", "/r"]), /Duplicate option/);
    assert.throws(() => parseGuestMergeBranchOptions(["--origin", "/r", "positional"]), /Unexpected argument/);
  });

  it("maps pure-core results into the wire report and renders native output", () => {
    const report = mergeReportFromResult("auth-1", {
      status: "landed", exitCode: 0, mergedCommit: "1".repeat(40), mergedTree: "2".repeat(40),
      target: "refs/heads/main", noop: false, checkoutRefresh: "parked:main-tamandua-parked-x-run",
      parkedBranch: "main-tamandua-parked-x-run", parkedReason: "local-changes",
    });
    assert.equal(report.status, "landed");
    assert.equal(report.parkedBranch, "main-tamandua-parked-x-run");
    const out: string[] = [];
    const errOut: string[] = [];
    const printed = printMergeResult(
      { cwd: "/", envGet: () => undefined, writeOut: (t) => out.push(t), writeErr: (t) => errOut.push(t), readStdin: async () => "" },
      {
        status: "landed", exitCode: 0, mergedCommit: "1".repeat(40), mergedTree: "2".repeat(40),
        target: "refs/heads/main", noop: false, checkoutRefresh: "parked:main-tamandua-parked-x-run",
        parkedBranch: "main-tamandua-parked-x-run", parkedReason: "local-changes",
      },
    );
    assert.equal(printed.exitCode, 0);
    assert.match(out.join(""), /^STATUS: landed\nNOOP: false\nMERGED_COMMIT: /);
    assert.match(out.join(""), /PARKED_BRANCH: main-tamandua-parked-x-run\nPARKED_REASON: local-changes\n$/);
    assert.equal(errOut.length, 0);
  });
});
