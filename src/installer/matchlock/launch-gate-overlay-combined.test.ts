/**
 * launch-gate-overlay-combined.test.ts — G8 ADMISSION-INTEGRATION US-014.
 *
 * The COMBINED-TREE test. The G8 admission gate
 * (`integration/dev16-gate`, US-001..US-013) and the invocation-scoped dsh
 * profile-overlay fix (`integration/dev16-overlay-cont` @ 926f589d) both edit
 * `controller.ts` — the one place a VM is created — and neither line's own
 * suites can see the other's invariants. A clean textual merge therefore proves
 * nothing about the composition, which is exactly what this file pins:
 *
 *   1. the launch-gate verdict is required BEFORE any overlay side effect:
 *      a refused / mis-bound invocation leaves NO overlay root on disk and
 *      spawns NO RPC child at all (the fake driver writes its transcript only
 *      after it is spawned, so an ABSENT transcript proves no child ran);
 *   2. an ADMITTED invocation stages an INVOCATION-SCOPED overlay root
 *      (`<live>/matchlock/dsh-profile-invocations/<runId>/<controller
 *      invocationId>`) that is what the create mount sources — never the host
 *      DSH_HOME and never the legacy run-scoped namespace;
 *   3. two OVERLAPPING admitted invocations of ONE run get DISTINCT roots, and
 *      one invocation's confirmed close publishes + removes ONLY its own root
 *      (the other invocation's overlay and its unpublished artifacts survive);
 *   4. a gate refusal is never converted into an overlay disposition/cleanup
 *      error: the refused controller can still be disposed (its absent root is
 *      an idempotent no-op).
 *
 * Both lines' semantics are consumed AS DELIVERED — this file adds no product
 * behaviour. No VM is ever created: the fake RPC driver stands in for
 * `matchlock rpc`, exactly as `controller.test.ts` does.
 *
 * LANE: SERIAL (tests/serial-files.txt). The file imports `MatchlockController`,
 * which reaches `rpc-client.ts` -> `node:child_process`, so the repository's
 * own classification rule makes it spawn-capable; the last test asserts the
 * registration instead of pretending otherwise.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import { MatchlockController } from "../../../dist/installer/matchlock/controller.js";
import { writeFakeRpcDriver, tempTranscriptPath } from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import { dshProfileOverlayRoot } from "../../../dist/installer/matchlock/dsh-profile-overlay.js";
import type { PinnedImageIdentity } from "../../../dist/installer/matchlock/image.js";
import type { LaunchGateBinding } from "../../../dist/installer/matchlock/launch-gate-wiring.js";
import type { ExecutionIsolation } from "../../../dist/installer/matchlock/policy.js";
import { MATCHLOCK_NETWORK_POLICY_VERSION } from "../../../dist/installer/matchlock/policy.js";

const FAKE_ENV_KEYS = [
  "FAKE_IMAGE_TAG",
  "FAKE_IMAGE_DIGEST",
  "FAKE_IMAGE_CONFIG_DIGEST",
  "FAKE_TRANSCRIPT_FILE",
] as const;

const DSH_TEST_RUN_ID = "11111111-2222-3333-4444-555555555555";

/** The pre-OVERLAY-INV-SCOPED run-scoped namespace: never used by this line. */
const LEGACY_OVERLAY_PARENT = "dsh-profile-overlays";
const INVOCATION_OVERLAY_PARENT = "dsh-profile-invocations";

function pin(digest = "sha256:aaaa", configDigest = "sha256:bbbb", tag = "img:1"): PinnedImageIdentity {
  return { digest, config_digest: configDigest, tag };
}

/** A gate verdict as the wiring writes it: only `invocationId` and
 *  `storeSetKey` are material to the controller backstop, the rest is the real
 *  `LaunchGateBinding` shape. */
function binding(invocationId: string, over: Partial<LaunchGateBinding> = {}): LaunchGateBinding {
  return {
    invocationId,
    kind: "scheduled-attempt",
    storeSetKey: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    receiptPath: `/var/lib/tamandua/matchlock/gate/${invocationId}.json`,
    decidedAt: "2026-10-24T00:00:00.000Z",
    stores: [],
    configJournalMode: "delete",
    configSource: "/opt/config/hermes/config.yaml",
    ...over,
  };
}

function codeOf(o: unknown): string | undefined {
  return typeof o === "object" && o !== null ? (o as { code?: string }).code : undefined;
}

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

describe("combined tree: launch gate x invocation-scoped dsh overlay (G8 US-014)", () => {
  let tmp: string;
  let helperPack: string;
  let fakeDriver: string;
  let savedEnv: Record<string, string | undefined>;
  const transcriptDirs: string[] = [];

  before(() => {
    tmp = tamanduaTempDir("tamandua-mtlk-gate-overlay-");
    helperPack = path.join(tmp, "runtime");
    fs.mkdirSync(helperPack, { recursive: true });
    fs.writeFileSync(path.join(helperPack, "bin-tamandua"), "#!/bin/sh\n", "utf8");
    fakeDriver = writeFakeRpcDriver({ dir: path.join(tmp, "driver") });
    savedEnv = snapshotFakeEnv();
  });

  after(() => {
    restoreFakeEnv(savedEnv);
    for (const d of transcriptDirs) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A composed DSH_HOME fixture: an install-derived farm under profiles/ plus
   *  the durable entries the overlay stages into the effective home. */
  function makeDshHomeFixture(prefix: string): string {
    const home = fs.mkdtempSync(path.join(tmp, prefix));
    fs.mkdirSync(path.join(home, "profiles", "headless", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(home, "profiles", "headless", ".dsh-module-fallback", "node_modules"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(home, ".credentials.yaml"), "refs: []\n", "utf8");
    return home;
  }

  function dshPolicy(configurationRoot: string): ExecutionIsolation {
    return {
      version: 1,
      backend: "matchlock",
      requestedImage: "img:1",
      requestedImageSource: "explicit",
      rootUsageConsent: false,
      harness: "dsh",
      configurationRoot,
      configurationProfile: "settings.json",
      guestConfigurationRoot: "/workspace/config/dsh",
      workPathMode: "host-absolute",
      workingDirectory: "/opt/project",
      workMounts: [{ hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" }],
      originalRepositoryRoot: "/opt/project",
      gitMetadataRoots: ["/opt/project/.git"],
      mountPolicyVersion: 1,
      networkPolicyVersion: MATCHLOCK_NETWORK_POLICY_VERSION,
      resourceLimits: { cpus: 2, memoryMB: 2048, swapMB: 0, diskSizeMB: 20480 },
    };
  }

  interface Scaffold {
    setFake: (opts: Record<string, string | undefined>) => void;
    /** Attach a FRESH transcript to the NEXT spawned controller/child. */
    useTranscript: () => string;
    readTranscript: (transcriptPath: string) => Array<Record<string, unknown>>;
    makeController: (opts: {
      home: string;
      liveState: string;
      launchGate: { invocationId: string; binding: LaunchGateBinding | null };
    }) => MatchlockController;
  }

  function scaffold(t: { after: (fn: () => Promise<unknown> | void) => void }): Scaffold {
    const saved = snapshotFakeEnv();
    t.after(() => restoreFakeEnv(saved));
    return {
      setFake: (opts) => {
        for (const [k, v] of Object.entries(opts)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      },
      useTranscript: () => {
        const p = tempTranscriptPath();
        transcriptDirs.push(path.dirname(p));
        process.env.FAKE_TRANSCRIPT_FILE = p;
        return p;
      },
      readTranscript: (transcriptPath) => {
        if (!fs.existsSync(transcriptPath)) return [];
        return fs
          .readFileSync(transcriptPath, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      },
      makeController: ({ home, liveState, launchGate }) => {
        const c = new MatchlockController(dshPolicy(home), {
          rpcBinaryPath: process.execPath,
          rpcArgs: [fakeDriver],
          helperPackHostPath: helperPack,
          onLog: () => {},
          requestTimeoutMs: 10_000,
          readyTimeoutMs: 3_000,
          stdinDrainTimeoutMs: 3_000,
          execCancelSettleTimeoutMs: 3_000,
          dshProfileOverlay: { runId: DSH_TEST_RUN_ID, liveStateRoot: liveState },
          mountAdmission: { home: path.join(tmp, "operator-home"), liveStateRoot: liveState },
          launchGate,
        });
        t.after(() => c.dispose());
        return c;
      },
    };
  }

  function liveStateDir(): string {
    return fs.mkdtempSync(path.join(tmp, "live-state-"));
  }

  function methods(txn: Array<Record<string, unknown>>): Array<string | undefined> {
    return txn.map((e) => (typeof e.method === "string" ? (e.method as string) : undefined)).filter((m): m is string => m !== undefined);
  }

  const HAPPY_FAKE = {
    FAKE_IMAGE_TAG: "img:1",
    FAKE_IMAGE_DIGEST: "sha256:aaaa",
    FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbb",
  };

  it("a gate refusal requires the verdict BEFORE the overlay: no overlay root, no RPC child", async (t) => {
    const s = scaffold(t);
    s.setFake(HAPPY_FAKE);
    const transcriptPath = s.useTranscript();
    const home = makeDshHomeFixture("dsh-home-refuse-");
    const liveState = liveStateDir();
    const c = s.makeController({
      home,
      liveState,
      launchGate: { invocationId: "run:combined:round:j1:dispatch", binding: null },
    });
    const overlayRoot = dshProfileOverlayRoot(DSH_TEST_RUN_ID, c.invocationId, liveState);

    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (err: unknown) => codeOf(err) === "matchlock_gate_verdict_missing",
      "a hermes/dsh invocation with no verdict is refused by the backstop",
    );

    assert.equal(fs.existsSync(overlayRoot), false, "the gate refusal precedes ANY overlay preparation");
    assert.equal(
      fs.existsSync(path.join(liveState, "matchlock", INVOCATION_OVERLAY_PARENT)),
      false,
      "not even the invocation-overlay namespace is created before the verdict",
    );
    assert.equal(
      fs.existsSync(path.join(liveState, "matchlock", LEGACY_OVERLAY_PARENT)),
      false,
      "the legacy run-scoped namespace is never created either",
    );
    assert.equal(fs.existsSync(transcriptPath), false, "no RPC child was spawned at all (transcript absent)");
    assert.equal(c.isClosed, false, "a refused controller was never invoked");

    // Disposition is a filesystem decision: disposing a refused controller must
    // not turn the gate refusal into a cleanup error (absent root = no-op).
    await c.dispose();
    assert.equal(fs.existsSync(overlayRoot), false);
  });

  it("a verdict that belongs to a DIFFERENT invocation also refuses before the overlay", async (t) => {
    const s = scaffold(t);
    s.setFake(HAPPY_FAKE);
    const transcriptPath = s.useTranscript();
    const home = makeDshHomeFixture("dsh-home-foreign-");
    const liveState = liveStateDir();
    const c = s.makeController({
      home,
      liveState,
      launchGate: {
        invocationId: "run:combined:round:j1:attempt:1",
        binding: binding("run:combined:round:j1:attempt:0"),
      },
    });
    const overlayRoot = dshProfileOverlayRoot(DSH_TEST_RUN_ID, c.invocationId, liveState);

    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (err: unknown) => codeOf(err) === "matchlock_gate_verdict_missing",
      "a verdict for another invocation never authorises this create",
    );
    assert.equal(fs.existsSync(overlayRoot), false, "no overlay was staged for a foreign verdict");
    assert.equal(fs.existsSync(transcriptPath), false, "no RPC child was spawned");
  });

  it("an admitted invocation stages an INVOCATION-SCOPED overlay that the create mount sources", async (t) => {
    const s = scaffold(t);
    s.setFake(HAPPY_FAKE);
    const transcriptPath = s.useTranscript();
    const home = makeDshHomeFixture("dsh-home-allow-");
    const liveState = liveStateDir();
    const invocationId = "run:combined:round:j1:dispatch";
    const c = s.makeController({ home, liveState, launchGate: { invocationId, binding: binding(invocationId) } });
    const overlayRoot = dshProfileOverlayRoot(DSH_TEST_RUN_ID, c.invocationId, liveState);

    assert.equal(fs.existsSync(overlayRoot), false, "no overlay exists before the invocation");
    await c.prepareAndCreate(pin());

    // The root is bound to the CONTROLLER's own invocation identity (never a
    // caller-supplied one, never the run-scoped legacy path).
    assert.ok(fs.existsSync(overlayRoot), "the admitted invocation staged its overlay");
    assert.equal(
      overlayRoot,
      path.join(liveState, "matchlock", INVOCATION_OVERLAY_PARENT, DSH_TEST_RUN_ID, c.invocationId),
      "the overlay root is the invocation-scoped path",
    );
    assert.equal(
      overlayRoot.startsWith(path.join(liveState, "matchlock", LEGACY_OVERLAY_PARENT) + path.sep),
      false,
      "the legacy run-scoped overlay namespace is not used",
    );
    assert.notEqual(c.invocationId, invocationId, "the controller identity is host-generated, not the gate id");

    const txn = s.readTranscript(transcriptPath);
    assert.equal(methods(txn).filter((m) => m === "create").length, 1, "exactly one create reached the wire");
    assert.deepEqual(
      methods(txn).filter((m) => m !== "create"),
      ["resolve_image"],
      "the only frame before create is the identity resolve — no other invocation frame",
    );
    const createIdx = txn.findIndex((e) => e.method === "create");
    const createParams = txn[createIdx].params as Record<string, unknown>;
    const mounts = (createParams.vfs as Record<string, unknown>).mounts as Record<
      string,
      { type?: string; host_path?: string; readonly?: boolean }
    >;
    assert.equal(
      mounts["/workspace/config/dsh"].host_path,
      overlayRoot,
      "the effective home mount is sourced from THIS invocation's overlay",
    );
    assert.notEqual(mounts["/workspace/config/dsh"].host_path, home, "the host DSH_HOME is never mounted");
    assert.equal(mounts["/workspace/config/dsh"].readonly, false);

    await c.close(30);
    assert.equal(c.isClosed, true);
    assert.equal(fs.existsSync(overlayRoot), false, "a confirmed close removes this invocation's root");
    assert.deepEqual(c.dshProfileOverlayStatus, { status: "finalized" });
  });

  it("two overlapping admitted invocations of ONE run get distinct roots and finalize independently", async (t) => {
    const s = scaffold(t);
    s.setFake(HAPPY_FAKE);
    const home = makeDshHomeFixture("dsh-home-overlap-");
    const liveState = liveStateDir();

    const dispatchId = "run:combined:round:j1:dispatch";
    const attemptId = "run:combined:round:j1:attempt";
    const tx1 = s.useTranscript();
    const c1 = s.makeController({ home, liveState, launchGate: { invocationId: dispatchId, binding: binding(dispatchId) } });
    await c1.prepareAndCreate(pin());
    const tx2 = s.useTranscript();
    const c2 = s.makeController({ home, liveState, launchGate: { invocationId: attemptId, binding: binding(attemptId) } });
    await c2.prepareAndCreate(pin());

    const root1 = dshProfileOverlayRoot(DSH_TEST_RUN_ID, c1.invocationId, liveState);
    const root2 = dshProfileOverlayRoot(DSH_TEST_RUN_ID, c2.invocationId, liveState);
    assert.notEqual(root1, root2, "overlapping invocations never share one overlay root");
    assert.ok(fs.existsSync(root1) && fs.existsSync(root2), "both live overlays exist concurrently");
    assert.equal(methods(s.readTranscript(tx1)).filter((m) => m === "create").length, 1);
    assert.equal(methods(s.readTranscript(tx2)).filter((m) => m === "create").length, 1);

    // Each guest writes a durable entry into ITS overlay's sessions/.
    fs.writeFileSync(path.join(root1, "sessions", "dispatch.jsonl"), "dispatch\n", "utf8");
    fs.writeFileSync(path.join(root2, "sessions", "attempt.jsonl"), "attempt\n", "utf8");

    await c1.close(30);
    assert.equal(fs.existsSync(root1), false, "the finalized invocation removed its own root");
    assert.ok(fs.existsSync(root2), "the other invocation's live overlay is untouched");
    assert.equal(
      fs.readFileSync(path.join(home, "sessions", "dispatch.jsonl"), "utf8"),
      "dispatch\n",
      "the finalized invocation published its durable entry",
    );
    assert.equal(
      fs.existsSync(path.join(home, "sessions", "attempt.jsonl")),
      false,
      "a still-live invocation's unpublished entry is never merged early",
    );
    assert.deepEqual(c1.dshProfileOverlayStatus, { status: "finalized" });
    assert.deepEqual(c2.dshProfileOverlayStatus, { status: "pending" });

    await c2.close(30);
    assert.equal(fs.existsSync(root2), false);
    assert.equal(
      fs.readFileSync(path.join(home, "sessions", "attempt.jsonl"), "utf8"),
      "attempt\n",
      "the second invocation publishes only on its own confirmed close",
    );
    assert.deepEqual(c2.dshProfileOverlayStatus, { status: "finalized" });
  });

  it("this combined-tree file is registered in the serial lane it belongs to", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const serial = fs.readFileSync(path.join(repoRoot, "tests", "serial-files.txt"), "utf8");
    assert.ok(
      serial.includes("src/installer/matchlock/launch-gate-overlay-combined.test.ts"),
      "importing MatchlockController reaches node:child_process, so the classifier requires the serial lane",
    );
  });
});
