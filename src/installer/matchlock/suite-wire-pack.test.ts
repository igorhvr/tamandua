/**
 * MTLK-SUITE-WIRE pack end-to-end focused evidence (SERIAL lane).
 *
 * Launches the REAL built guest pack on host vaivm — the actual
 * `bin/tamandua-bridge` service process and `bin/tamandua-test` engine
 * process — over an isolated synthetic HOME/state/Unix socket with the REAL
 * host broker in-process, the REAL host suite SQLite store and the REAL
 * HostInvocationRegistry. Labelled NOT actualVM (no Matchlock VM, no live
 * daemon, no models).
 *
 * Chain under test:
 *
 *   packed bin/tamandua-test (real engine subprocess)
 *     → guest-local Unix socket (real bridge service subprocess)
 *     → bounded framed exec-pipe channel (child stdin/stdout)
 *     → real scoped host broker
 *     → injected host suite transport/services bridge (suite-host-bridge)
 *     → real host suite SQLite store + real HostInvocationRegistry
 *
 * Evidence exercised:
 *   - actual command stdout/stderr/exit through the guest engine;
 *   - strict HELLO framing between the packed bridge service and the broker;
 *   - claim/record/duration-history/events through the REAL chain with a
 *     persisted row (namespace/run/token), no native ledger touched;
 *   - green-TTL replay (second identical invocation replays, no dup row);
 *   - suite.release through the REAL packed socket chain: an engine run is
 *     followed by an exact-token claim → release cycle over the actual packed
 *     bridge service subprocess (released:true, namespace echo, claim row
 *     consumed) plus a foreign-token release refused DENIED;
 *   - foreign run attribution → refused at the host boundary, real guest
 *     execution, NO green record;
 *   - host suite service ABSENT → real guest execution with an explicit
 *     warning and NO recorded green (never native-host fallback).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createTempHome, cleanChildEnv } from "../../../tests/helpers/test-env.ts";
import {
  buildGuestPack,
  validateGuestPack,
  type GuestPackManifest,
} from "../../../dist/installer/matchlock/guest-pack-builder.js";
import { createHostBroker } from "../../../dist/installer/matchlock/broker.js";
import type { HostBinding } from "../../../dist/installer/matchlock/broker-services.js";
import { FakeStepServices } from "../../../dist/installer/matchlock/broker-test-services.js";
import { createHostSuiteBridge, type HostSuiteBridgeScope } from "../../../dist/installer/matchlock/suite-host-bridge.js";
import { HostInvocationRegistry } from "../../../dist/installer/matchlock/native-step-invocations.js";
import { openHostSuiteStore, type HostSuiteStore } from "../../../dist/installer/matchlock/host-suite-store.js";
import {
  GUEST_SUITE_ENV_KEYS,
  stripGuestSuiteEnv,
} from "../../../dist/installer/matchlock/suite-wire-env.js";
import { guestSuiteNamespaceId, type GuestSuiteNamespace } from "../../../dist/installer/matchlock/guest-suite-contract.js";
import { GuestSuiteSocketTransport } from "../../../dist/installer/matchlock/suite-socket-transport.js";
import { committedTreeHash, computeCmdHash } from "../../../dist/installer/matchlock/guest-suite-git.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_DIR = dirname(process.execPath);

const NS_A: GuestSuiteNamespace = {
  imageContentId: "sha256:packe2e0123456789abcdef0123456789abcdef0123456789abcdef",
  guestPlatform: "linux/amd64",
  helperContract: "guest-helper-pack-e2e+suite-v1",
  compatibilityFingerprint: "packe2e-fp-01",
};
const AGENT = "suite-pack-agent";
const JOB = "job-pack-1";
const RUN = "suite-run-pack-1";
const STEP = "suite-step-pack-1";

interface Pack {
  root: string;
  manifest: GuestPackManifest;
}

function buildPack(root: string): Pack {
  const target = join(root, "pack");
  const result = buildGuestPack({ targetDir: target });
  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf-8")) as GuestPackManifest;
  const validated = validateGuestPack(target);
  assert.deepEqual(validated.errors, [], "pack closure re-validation clean");
  return { root: target, manifest };
}

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function collect(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; deadlineMs?: number },
): Promise<ChildResult> {
  const deadline = opts.deadlineMs ?? 20000;
  return new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => err.push(c));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`${command} ${args.join(" ")} timed out after ${deadline}ms`));
    }, deadline);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: cleanChildEnv({
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    }),
    stdio: "pipe",
  });
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

interface Rig {
  root: string;
  pack: Pack;
  repoDir: string;
  originRepo: string;
  socketPath: string;
  store: HostSuiteStore;
  registry: HostInvocationRegistry;
  invocationId: string;
  broker: ReturnType<typeof createHostBroker>;
  serviceChild: ChildProcess;
  engineEnv: (over?: Record<string, string>) => NodeJS.ProcessEnv;
  stop: () => Promise<void>;
}

async function startRig(opts: { suiteEnabled: boolean; injectSuiteBridge: boolean }): Promise<Rig> {
  const temp = createTempHome("suite-wire-pack-");
  const root = temp.root;
  const pack = buildPack(root);
  const bv = pack.manifest.tamanduaBuildVersion;

  const socketDir = join(root, "sock");
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const socketPath = join(socketDir, "bridge.sock");

  // Isolated synthetic git fixture (NOT actualVM).
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "suite-wire@test.invalid"]);
  git(repoDir, ["config", "user.name", "Suite Wire"]);
  writeFileSync(join(repoDir, "README.md"), "# Suite wire fixture\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "init"]);
  writeFileSync(join(repoDir, ".gitignore"), "*.log\n");
  git(repoDir, ["add", ".gitignore"]);
  git(repoDir, ["commit", "-q", "-m", "gitignore"]);
  const originRepo = realpathSync(repoDir);

  const store = openHostSuiteStore(join(root, "host-suite.sqlite"));
  const registry = new HostInvocationRegistry();
  const invocationId = randomUUID();
  assert.deepEqual(registry.admitInvocation({ invocationId, runId: RUN, agentId: AGENT, jobId: JOB }), { ok: true });
  const stepRowId = randomUUID();
  assert.deepEqual(
    registry.register({
      stepRowId,
      stepId: STEP,
      runId: RUN,
      agentId: AGENT,
      jobId: JOB,
      invocationId,
      claimId: `claim-${stepRowId}`,
      rowToken: `rowtok-${stepRowId}`,
      claimedAtMs: Date.now(),
    }),
    { ok: true },
  );

  const bridgeScope: HostSuiteBridgeScope = {
    invocationId,
    runId: RUN,
    agentId: AGENT,
    jobId: JOB,
    registry,
    store,
    namespace: NS_A,
    admittedRoots: [originRepo],
  };
  const brokerBinding: HostBinding = {
    runId: RUN,
    invocationId,
    agentId: AGENT,
    jobId: JOB,
    role: "developer",
    admittedRoots: [originRepo],
    helperProtocolVersion: `${bv}+p1`,
    helperBuildVersion: bv,
  };

  const serviceEnv: NodeJS.ProcessEnv = cleanChildEnv({
    HOME: temp.homeDir,
    PATH: `${NODE_DIR}:/usr/bin:/bin`,
    TAMANDUA_GUEST_SOCKET_DIR: socketDir,
    TAMANDUA_GUEST_BUILD_VERSION: bv,
    TAMANDUA_GUEST_SUITE_ENABLED: opts.suiteEnabled ? "1" : "0",
    TAMANDUA_BRIDGE_HANDSHAKE_TIMEOUT_MS: "8000",
    TAMANDUA_BRIDGE_REQUEST_TIMEOUT_MS: "8000",
    TAMANDUA_TEST_GUARD: "1",
  });
  const serviceChild = spawn(join(pack.root, "bin", "tamandua-bridge"), [], {
    cwd: repoDir,
    env: serviceEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const suiteBridge = opts.injectSuiteBridge ? createHostSuiteBridge(bridgeScope) : undefined;
  const broker = createHostBroker({
    binding: brokerBinding,
    services: new FakeStepServices({ runId: RUN, agentId: AGENT, steps: [] }),
    pipe: { toGuest: serviceChild.stdin!, fromGuest: serviceChild.stdout! },
    handshakeTimeoutMs: 8000,
    serviceTimeoutMs: 15000,
    ...(suiteBridge ? { suite: suiteBridge } : {}),
  });
  const ready = await withTimeout(broker.ready, 9000, "broker ready");
  assert.equal(ready.ok, true, ready.reason);

  const engineEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv =>
    cleanChildEnv({
      HOME: temp.homeDir,
      PATH: `${NODE_DIR}:/usr/bin:/bin`,
      TAMANDUA_GUEST_SOCKET: socketPath,
      TAMANDUA_GUEST_BUILD_VERSION: bv,
      TAMANDUA_GUEST_SUITE_ENABLED: "1",
      TAMANDUA_GUEST_IMAGE_CONTENT_ID: NS_A.imageContentId,
      TAMANDUA_GUEST_PLATFORM: NS_A.guestPlatform,
      TAMANDUA_GUEST_HELPER_CONTRACT: NS_A.helperContract,
      TAMANDUA_GUEST_ENV_FINGERPRINT: NS_A.compatibilityFingerprint,
      TAMANDUA_BRIDGE_REQUEST_TIMEOUT_MS: "8000",
      TAMANDUA_TEST_GUARD: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...over,
    });

  return {
    root,
    pack,
    repoDir,
    originRepo,
    socketPath,
    store,
    registry,
    invocationId,
    broker,
    serviceChild,
    engineEnv,
    stop: async () => {
      await withTimeout(broker.close(), 5000, "broker close");
      await withTimeout(broker.closed, 5000, "broker closed");
      serviceChild.stdin!.end();
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            serviceChild.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 4000);
        serviceChild.on("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
      store.close();
    },
  };
}

function engineArgs(repoDir: string, runId: string, stepId: string, cmd: string[]): string[] {
  return ["--repo", repoDir, "--run", runId, "--step", stepId, "--", ...cmd];
}

describe("MTLK-SUITE-WIRE real pack end-to-end (NOT actualVM)", () => {
  it("packed engine → socket service → broker → real host suite store: real stdout/stderr/exit + persisted row + replay", async () => {
    const rig = await startRig({ suiteEnabled: true, injectSuiteBridge: true });
    try {
      // Closure + launcher + manifest assertions on the ACTUAL built pack.
      assert.ok(existsSync(join(rig.pack.root, "bin", "tamandua-test")), "bin/tamandua-test launcher written");
      assert.equal(rig.pack.manifest.entries.test, "lib/installer/matchlock/guest-suite-cli-entry.js");
      assert.ok(
        existsSync(join(rig.pack.root, "lib", "installer", "matchlock", "guest-suite-cli-entry.js")),
        "compiled guest suite entry inside the pack closure",
      );
      assert.deepEqual(rig.pack.manifest.suite.ops, [
        "suite.lookup",
        "suite.claim",
        "suite.record",
        "suite.release",
        "suite.duration-history",
        "suite.event",
      ]);
      assert.ok(!rig.pack.manifest.capabilities.includes("suite.record"), "suite ops are not advertised as default capabilities");

      const cmd = ["echo", "suite-pack-ok"];
      const run = await collect(
        join(rig.pack.root, "bin", "tamandua-test"),
        engineArgs(rig.repoDir, RUN, STEP, cmd),
        { cwd: rig.repoDir, env: rig.engineEnv(), deadlineMs: 60000 },
      );
      assert.equal(run.code, 0, `engine exit: ${run.stderr}`);
      assert.match(run.stdout, /suite-pack-ok/, "actual command stdout crosses the engine");
      assert.equal(rig.store.resultCount(), 1, "one persisted suite row after the first real run");

      // Green-TTL replay: a second identical invocation replays (same
      // namespace + tree + command), never duplicating the row.
      const replay = await collect(
        join(rig.pack.root, "bin", "tamandua-test"),
        engineArgs(rig.repoDir, RUN, STEP, cmd),
        { cwd: rig.repoDir, env: rig.engineEnv(), deadlineMs: 60000 },
      );
      assert.equal(replay.code, 0, replay.stderr);
      assert.match(replay.stdout, /TAMANDUA-TEST CACHED/, "green replay banner present");
      assert.equal(rig.store.resultCount(), 1, "no duplicate row on replay");
    } finally {
      await rig.stop();
    }
  });

  it("foreign run attribution refused at the host boundary: real execution, NO green record", async () => {
    const rig = await startRig({ suiteEnabled: true, injectSuiteBridge: true });
    try {
      const foreign = await collect(
        join(rig.pack.root, "bin", "tamandua-test"),
        engineArgs(rig.repoDir, "some-other-run-9", STEP, ["echo", "foreign-still-runs"]),
        { cwd: rig.repoDir, env: rig.engineEnv(), deadlineMs: 60000 },
      );
      assert.equal(foreign.code, 0, foreign.stderr);
      assert.match(foreign.stdout, /foreign-still-runs/, "the command still executes guest-locally");
      assert.match(foreign.stderr, /refused|does not match|not recorded/i, "explicit incomplete-evidence warning");
      assert.equal(rig.store.resultCount(), 0, "NO green row for a foreign run");
    } finally {
      await rig.stop();
    }
  });

  it("suite.release over the REAL packed socket chain: claim → foreign-token refusal → exact-token release with namespace echo", async () => {
    // The engine only emits release on drift/interrupt/re-key, so the pack rig
    // drives suite.release through the SAME real chain the packed engine uses:
    // GuestSuiteSocketTransport → real packed bin/tamandua-bridge service
    // subprocess socket → real scoped broker → injected suite bridge → real
    // host suite store/registry. Claim acquires a live exact-token claim row;
    // a foreign token is refused DENIED (claim kept); the exact token release
    // returns released:true with the bound namespace echoed and removes the
    // claim row from the real SQLite store.
    const rig = await startRig({ suiteEnabled: true, injectSuiteBridge: true });
    try {
      const tree = committedTreeHash(rig.repoDir);
      assert.ok(tree, "fixture committed tree hash available for the release key");
      const cmd = "echo release-over-real-pack";
      const ch = computeCmdHash(cmd);
      const transport = new GuestSuiteSocketTransport({
        socketPath: rig.socketPath,
        helperBuildVersion: rig.pack.manifest.tamanduaBuildVersion,
        namespace: NS_A,
        requestTimeoutMs: 8000,
      });
      const key = { namespaceId: guestSuiteNamespaceId(NS_A), originRepo: rig.originRepo, treeHash: tree!, cmdHash: ch };

      const claim = await transport.claim({
        originRepo: rig.originRepo,
        treeHash: tree!,
        cmdHash: ch,
        namespace: NS_A,
        ownerToken: "token-pack-rel",
        runId: RUN,
        stepId: STEP,
      });
      assert.equal(claim.ok, true);
      if (claim.ok) assert.equal(claim.value.action, "run");
      assert.equal(rig.store.peekClaim(key)?.owner_token, "token-pack-rel", "real store holds the exact-token claim row");

      const foreign = await transport.release({
        originRepo: rig.originRepo,
        treeHash: tree!,
        cmdHash: ch,
        namespace: NS_A,
        ownerToken: "token-pack-FOREIGN",
      });
      assert.equal(foreign.ok, false);
      if (!foreign.ok) {
        assert.equal(foreign.reason, "refused");
        assert.equal(foreign.code, "DENIED");
      }
      assert.equal(rig.store.peekClaim(key)?.owner_token, "token-pack-rel", "refused foreign release must not delete the claim");

      const release = await transport.release({
        originRepo: rig.originRepo,
        treeHash: tree!,
        cmdHash: ch,
        namespace: NS_A,
        ownerToken: "token-pack-rel",
      });
      assert.equal(release.ok, true);
      if (release.ok) {
        assert.equal(release.value.released, true);
        assert.equal(release.value.namespaceId, guestSuiteNamespaceId(NS_A));
      }
      assert.equal(rig.store.peekClaim(key), null, "exact-token release consumed the claim row in the real store");
    } finally {
      await rig.stop();
    }
  });

  it("host suite service ABSENT: engine executes guest-locally with an explicit warning and no green record", async () => {
    // The packed bridge service is launched WITHOUT suite capability (the
    // default — no suite-capable host broker), while the engine still has its
    // socket transport wired. Every suite op is refused as absent and the
    // engine degrades: real command, explicit warning, zero rows. Never a
    // native host fallback and never a false green.
    const rig = await startRig({ suiteEnabled: false, injectSuiteBridge: false });
    try {
      const run = await collect(
        join(rig.pack.root, "bin", "tamandua-test"),
        engineArgs(rig.repoDir, RUN, STEP, ["echo", "absent-still-runs"]),
        { cwd: rig.repoDir, env: rig.engineEnv(), deadlineMs: 60000 },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /absent-still-runs/, "real guest execution occurred");
      assert.match(run.stderr, /absent|not served|not recorded|refused/i, "explicit absent/refusal warning");
      assert.equal(rig.store.resultCount(), 0, "no row when the host suite service is absent");
    } finally {
      await rig.stop();
    }
  });

  it("self-dogfood separation: a product-under-test child with a stripped env cannot reach the reporting socket or record", async () => {
    // The outer packed shim is the reporting client. A product-under-test
    // child the wire spawns must get an explicit scoped environment with the
    // reporting socket/suite keys removed (stripGuestSuiteEnv) so it can never
    // inherit the parent socket/authority and record into the parent ledger.
    const rig = await startRig({ suiteEnabled: true, injectSuiteBridge: true });
    try {
      const wiredEnv = rig.engineEnv();
      assert.ok("TAMANDUA_GUEST_SOCKET" in wiredEnv, "reporting socket env present before stripping");
      assert.ok("TAMANDUA_GUEST_SUITE_ENABLED" in wiredEnv, "suite enable present before stripping");
      const stripped = stripGuestSuiteEnv(wiredEnv);
      for (const key of GUEST_SUITE_ENV_KEYS) {
        assert.ok(!(key in stripped), `reporting env key ${key} removed by stripGuestSuiteEnv`);
      }
      // Run the same packed engine under the STRIPPED env: the host suite
      // service is unreachable (no socket), so the engine runs the real
      // command with an explicit warning and records NOTHING into the parent
      // ledger even though a suite-capable host is right there.
      const run = await collect(
        join(rig.pack.root, "bin", "tamandua-test"),
        engineArgs(rig.repoDir, RUN, STEP, ["echo", "product-child-runs"]),
        { cwd: rig.repoDir, env: stripped, deadlineMs: 60000 },
      );
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /product-child-runs/, "product child executed its real command");
      assert.match(run.stderr, /no host-attested|absent|socket is not configured|not recorded/i, "explicit incomplete-evidence warning");
      assert.equal(rig.store.resultCount(), 0, "product-under-test child recorded NOTHING into the parent ledger");
    } finally {
      await rig.stop();
    }
  });
});
