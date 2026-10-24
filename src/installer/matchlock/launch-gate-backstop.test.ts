/**
 * launch-gate-backstop.test.ts — G8 ADMISSION-INTEGRATION US-004.
 *
 * The controller is the LAST place a VM can be created, so it carries a
 * backstop: when a gate verdict context is supplied it refuses to create
 * unless a verdict exists for THE CURRENT RESOLVED INVOCATION (same invocation
 * id, a non-empty store-set key). The controller NEVER re-evaluates the gate.
 *
 * These tests drive the REAL controller against the existing fake rpc driver
 * and journal every wire request into the driver's transcript, so
 * "zero create calls" and "before any RPC spawn" are measured, not asserted
 * from prose. A second group scans the production construction sites so a
 * future edit cannot silently drop the backstop wiring from the hermes paths.
 *
 * SERIAL lane (registered in tests/serial-files.txt): the controller owns an
 * RPC child through rpc-client.ts.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  MatchlockController,
  MatchlockControllerError,
} from "../../../dist/installer/matchlock/controller.js";
import { writeFakeRpcDriver, tempTranscriptPath } from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import { MATCHLOCK_NETWORK_POLICY_VERSION } from "../../../dist/installer/matchlock/policy.js";
import type { PinnedImageIdentity } from "../../../dist/installer/matchlock/image.js";
import type { ExecutionIsolation } from "../../../dist/installer/matchlock/policy.js";
import type { LaunchGateBinding } from "../../../dist/installer/matchlock/launch-gate-wiring.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const FAKE_ENV_KEYS = [
  "FAKE_IMAGE_TAG",
  "FAKE_IMAGE_DIGEST",
  "FAKE_IMAGE_CONFIG_DIGEST",
  "FAKE_TRANSCRIPT_FILE",
  "FAKE_CREATE_REJECT_IMAGE_IDENTITY",
  "FAKE_CREATE_ACTUAL_DIGEST",
  "FAKE_CREATE_ACTUAL_CONFIG_DIGEST",
] as const;

function snapshotFakeEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of FAKE_ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreFakeEnv(saved: Record<string, string | undefined>): void {
  for (const k of FAKE_ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function readTranscript0(p: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function codeOf(err: unknown): string | undefined {
  return err instanceof MatchlockControllerError ? err.code : undefined;
}

function pin(digest = "sha256:aaaa", configDigest = "sha256:bbbb", tag = "img:1"): PinnedImageIdentity {
  return { digest, config_digest: configDigest, tag };
}

function policy(over: Partial<ExecutionIsolation> = {}): ExecutionIsolation {
  return {
    version: 1,
    backend: "matchlock",
    requestedImage: "img:1",
    requestedImageSource: "explicit",
    rootUsageConsent: false,
    harness: "hermes",
    configurationRoot: "/opt/config/hermes",
    configurationProfile: "config.yaml",
    guestConfigurationRoot: "/workspace/config/hermes",
    workPathMode: "host-absolute",
    workingDirectory: "/opt/project",
    workMounts: [{ hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" }],
    originalRepositoryRoot: "/opt/project",
    gitMetadataRoots: ["/opt/project/.git"],
    mountPolicyVersion: 1,
    networkPolicyVersion: MATCHLOCK_NETWORK_POLICY_VERSION,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 0 },
    ...over,
  };
}

/** A gate verdict as the wiring writes it (only the fields the backstop reads
 *  are material; the rest is the real LaunchGateBinding shape). */
function binding(
  invocationId: string,
  over: Partial<LaunchGateBinding> = {},
): LaunchGateBinding {
  return {
    invocationId,
    kind: "scheduled-attempt",
    storeSetKey: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    receiptPath: `/var/lib/tamandua/matchlock/gate/${invocationId}.json`,
    decidedAt: "2026-10-23T00:00:00.000Z",
    stores: [],
    configJournalMode: "delete",
    configSource: "/opt/config/hermes/config.yaml",
    ...over,
  };
}

describe("matchlock controller launch-gate backstop (G8 US-004)", () => {
  let tmp: string;
  let configDir: string;
  let helperPack: string;
  let fakeDriver: string;
  let savedEnv: Record<string, string | undefined>;

  before(() => {
    tmp = tamanduaTempDir("tamandua-mtlk-backstop-");
    configDir = path.join(tmp, "config-hermes");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.yaml"), "terminal:\n  backend: local\n", "utf8");
    helperPack = path.join(tmp, "runtime");
    fs.mkdirSync(helperPack, { recursive: true });
    fs.writeFileSync(path.join(helperPack, "bin-tamandua"), "#!/bin/sh\n", "utf8");
    fakeDriver = writeFakeRpcDriver({ dir: path.join(tmp, "driver") });
    savedEnv = snapshotFakeEnv();
  });

  after(() => {
    restoreFakeEnv(savedEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Fresh transcript + env per test; the controller is always disposed. */
  function scaffold(t: { after: (fn: () => Promise<unknown> | void) => void }) {
    const saved = snapshotFakeEnv();
    const transcriptPath = tempTranscriptPath();
    process.env.FAKE_TRANSCRIPT_FILE = transcriptPath;
    process.env.FAKE_IMAGE_TAG = "img:1";
    process.env.FAKE_IMAGE_DIGEST = "sha256:aaaa";
    process.env.FAKE_IMAGE_CONFIG_DIGEST = "sha256:bbbb";
    t.after(() => restoreFakeEnv(saved));
    return {
      readTranscript: (): Array<Record<string, unknown>> => readTranscript0(transcriptPath),
      methods: (): string[] =>
        readTranscript0(transcriptPath)
          .map((e) => (typeof e.method === "string" ? (e.method as string) : undefined))
          .filter((m): m is string => typeof m === "string"),
      makeController: (launchGate?: { invocationId: string; binding: LaunchGateBinding | null }) => {
        const c = new MatchlockController(policy({ configurationRoot: configDir }), {
          rpcBinaryPath: process.execPath,
          rpcArgs: [fakeDriver],
          helperPackHostPath: helperPack,
          onLog: () => {},
          requestTimeoutMs: 10_000,
          ...(launchGate !== undefined ? { launchGate } : {}),
        });
        t.after(() => c.dispose());
        return c;
      },
    };
  }

  it("refuses a verdict that belongs to a DIFFERENT invocation, with zero RPC calls", async (t) => {
    const s = scaffold(t);
    const c = s.makeController({ invocationId: "run:r1:round:j1:attempt:1", binding: binding("run:r1:round:j1:attempt:0") });

    await assert.rejects(c.prepareAndCreate(pin()), (err: unknown) => {
      assert.equal(codeOf(err), "matchlock_gate_verdict_missing");
      const message = (err as Error).message;
      assert.match(message, /run:r1:round:j1:attempt:1/, "the message names the invocation that required a verdict");
      assert.match(message, /run:r1:round:j1:attempt:0/, "the message names the foreign verdict it found");
      assert.match(message, /attempt:0\.json/, "the message carries the foreign receipt path");
      assert.match(message, /never re-evaluates/, "the message states the controller does not re-evaluate");
      return true;
    });

    assert.deepEqual(s.readTranscript(), [], "a refused create spawns no RPC child at all (no resolve, no create)");
    assert.equal(c.rpcRunning, false);
    assert.equal(c.identity.vmId, null);
  });

  it("refuses a null binding (no verdict) before any spawn", async (t) => {
    const s = scaffold(t);
    const c = s.makeController({ invocationId: "run:r1:round:j1:attempt:1", binding: null });

    await assert.rejects(c.prepareAndCreate(pin()), (err: unknown) => {
      assert.equal(codeOf(err), "matchlock_gate_verdict_missing");
      assert.match((err as Error).message, /no launch-gate verdict exists for this invocation/);
      assert.match((err as Error).message, /run:r1:round:j1:attempt:1/);
      return true;
    });
    assert.deepEqual(s.readTranscript(), [], "no RPC child was ever spawned");
    assert.equal(c.rpcRunning, false);
  });

  it("refuses a verdict that binds no store-set key", async (t) => {
    const s = scaffold(t);
    const c = s.makeController({
      invocationId: "inv-x",
      binding: binding("inv-x", { storeSetKey: "   " }),
    });
    await assert.rejects(c.prepareAndCreate(pin()), (err: unknown) => {
      assert.equal(codeOf(err), "matchlock_gate_verdict_missing");
      assert.match((err as Error).message, /carries no store-set key/);
      return true;
    });
    assert.deepEqual(s.readTranscript(), []);
  });

  it("refuses an empty required invocation id (a verdict can never be bound to it)", async (t) => {
    const s = scaffold(t);
    const c = s.makeController({ invocationId: "", binding: binding("") });
    await assert.rejects(c.prepareAndCreate(pin()), (err: unknown) => {
      assert.equal(codeOf(err), "matchlock_gate_verdict_missing");
      assert.match((err as Error).message, /invocation id is missing/);
      return true;
    });
    assert.deepEqual(s.readTranscript(), []);
  });

  it("creates the VM exactly once with a matching binding (one create on the wire)", async (t) => {
    const s = scaffold(t);
    const c = s.makeController({ invocationId: "inv-match", binding: binding("inv-match") });
    const { vmId, identity } = await c.prepareAndCreate(pin());
    assert.match(vmId, /^vm-/);
    assert.deepEqual(identity, pin());
    assert.deepEqual(
      s.methods().filter((m) => m === "create"),
      ["create"],
      "exactly one create was journaled",
    );
    assert.deepEqual(
      s.methods(),
      ["resolve_image", "create"],
      "the create path re-resolves then creates once (the backstop adds no RPC)",
    );
  });

  it("does not consume the single-shot invocation on a gate refusal (a later bound create still works)", async (t) => {
    const s = scaffold(t);
    const c = s.makeController({ invocationId: "inv-late", binding: null });
    await assert.rejects(c.prepareAndCreate(pin()), (err: unknown) => codeOf(err) === "matchlock_gate_verdict_missing");
    assert.deepEqual(s.readTranscript(), [], "the refusal touched no transport");

    // A fresh controller for the same invocation WITH the verdict creates once:
    // the refusal was a pre-create barrier, never a half-started invocation.
    const ok = s.makeController({ invocationId: "inv-late", binding: binding("inv-late") });
    const created = await ok.prepareAndCreate(pin());
    assert.match(created.vmId, /^vm-/);
    assert.deepEqual(s.methods().filter((m) => m === "create"), ["create"]);
  });

  it("keeps the ungated (native) path byte-identical: no launchGate option ⇒ no verdict required", async (t) => {
    const s = scaffold(t);
    const c = s.makeController(undefined);
    const { vmId } = await c.prepareAndCreate(pin());
    assert.match(vmId, /^vm-/);
    assert.deepEqual(s.methods().filter((m) => m === "create"), ["create"]);
  });
});

// ── production wiring guards (source scans) ──────────────────────────────

describe("launch-gate backstop production wiring (source guards)", () => {
  function read(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  }

  it("controller.ts imports NO gate observation/evaluation module at runtime (only types)", () => {
    const source = read("src/installer/matchlock/controller.ts");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    const gateSpecifiers = ["store-set", "store-header", "store-observation-adapter", "launch-gate"];
    for (const line of importLines) {
      if (!gateSpecifiers.some((spec) => line.includes(`./${spec}`) || line.includes(`"./${spec}`))) continue;
      assert.match(
        line,
        /^\s*import\s+type\b/,
        `controller.ts may only TYPE-import a gate module (runtime import found): ${line.trim()}`,
      );
    }
    // The backstop itself reads exactly four facts and never evaluates.
    assert.match(source, /matchlock_gate_verdict_missing/);
    assert.doesNotMatch(source, /evaluateGate|evaluateAndRecordLaunchGate|observeStore|resolveStoreSet/);
  });

  it("every production MatchlockController construction is classified (and the hermes ones pass launchGate)", () => {
    const sites: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(rel));
        else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(rel);
      }
      return out;
    };
    for (const file of walk("src")) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      if (source.includes("new MatchlockController(")) sites.push(file);
    }
    // Exactly the three known production sites. A NEW constructon site must be
    // classified here deliberately (and gated if it is a hermes path) rather
    // than silently launching an ungated VM.
    assert.deepEqual(
      sites.sort(),
      [
        "src/installer/matchlock/hermes-invocation-runner.ts",
        "src/installer/matchlock/interactive-session.ts",
        "src/installer/matchlock/pi-invocation-runner.ts",
      ],
      "unexpected/unclassified MatchlockController construction site",
    );

    // Native pi is untouched: no launchGate context anywhere in that runner.
    assert.doesNotMatch(
      read("src/installer/matchlock/pi-invocation-runner.ts"),
      /launchGate/,
      "native pi must never pass a launchGate context",
    );

    // Hermes scheduled rounds forward ONLY the caller's binding (never a
    // fabricated allow): the value is derived from opts.launchGate.
    const hermesRunner = read("src/installer/matchlock/hermes-invocation-runner.ts");
    const construction = hermesRunner.slice(hermesRunner.indexOf("new MatchlockController(hermesPolicy"));
    assert.match(construction, /launchGate:/, "the hermes controller construction must pass launchGate");
    assert.match(
      construction,
      /launchGate:\s*\n?\s*opts\.launchGate !== undefined/,
      "the hermes runner derives launchGate from opts.launchGate only",
    );
    assert.match(construction, /binding: opts\.launchGate/);

    // Interactive sessions derive it from the admitted plan, and a hermes plan
    // without a verdict is an EXPLICIT null binding (refusal), never a skip.
    const interactive = read("src/installer/matchlock/interactive-session.ts");
    const start = interactive.indexOf("const controllerOptions: MatchlockControllerOptions");
    assert.ok(start >= 0, "interactive-session.ts builds an explicit controller options object");
    const sessionWindow = interactive.slice(start, interactive.indexOf("return create(", start));
    assert.match(sessionWindow, /this\.plan\.launchGate/, "the plan's binding is the backstop context");
    assert.match(sessionWindow, /binding: null/, "a hermes plan without a verdict is an explicit null binding");
    assert.match(sessionWindow, /this\.plan\.harness === "hermes"/);
  });

  it("the controller backstop refuses BEFORE any state mutation (no overlay/invoked side effect)", async (t) => {
    // Direct unit assertion on the guard ordering: a dsh controller with an
    // overlay attestation must refuse the gate WITHOUT preparing the overlay
    // directories (that happens later in prepareAndCreate).
    const tmp = tamanduaTempDir("tamandua-mtlk-backstop-order-");
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const helperPack = path.join(tmp, "runtime");
    fs.mkdirSync(helperPack, { recursive: true });
    fs.writeFileSync(path.join(helperPack, "bin-tamandua"), "#!/bin/sh\n", "utf8");
    const liveStateRoot = path.join(tmp, "state");
    fs.mkdirSync(path.join(liveStateRoot, "run"), { recursive: true });
    const configRoot = path.join(tmp, "config-dsh");
    fs.mkdirSync(path.join(configRoot, "profiles", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(configRoot, "config.yaml"), "x: 1\n", "utf8");

    const c = new MatchlockController(
      { ...policy(), harness: "dsh", configurationRoot: configRoot, guestConfigurationRoot: "/workspace/config/dsh" },
      {
        rpcBinaryPath: process.execPath,
        rpcArgs: [writeFakeRpcDriver({ dir: path.join(tmp, "driver") })],
        helperPackHostPath: helperPack,
        dshProfileOverlay: { runId: "run-order", liveStateRoot },
        onLog: () => {},
        launchGate: { invocationId: "inv-order", binding: null },
      },
    );
    t.after(() => c.dispose());
    await assert.rejects(c.prepareAndCreate(pin()), (err: unknown) => codeOf(err) === "matchlock_gate_verdict_missing");
    const overlayRoot = path.join(liveStateRoot, "run", "run-order");
    assert.equal(
      fs.existsSync(overlayRoot),
      false,
      "the gate refusal precedes the dsh overlay preparation (no host side effect before the verdict)",
    );
  });
});
