import { describe, it, before, after } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DSH_MODULE_FALLBACK_DIR_NAME,
  DSH_NODE_MODULES_DIR_NAME,
  DSH_PROFILES_DIR_NAME,
  DshProfileOverlayError,
  MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME,
  MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME,
  assertDshOverlayInvocationId,
  assertDshOverlayRunId,
  cleanupDshProfileOverlay,
  discoverDshInstallDerivedDirs,
  dshProfileInvocationGroupRoot,
  dshProfileOverlayProvenancePath,
  dshProfileOverlayRoot,
  dshProfilePublishLockPath,
  isDshProfileOverlayRootShape,
  isHostAttestedDshProfileOverlay,
  planDshHomeMounts,
  prepareDshProfileOverlay,
  publishDshHomeOverlayToHost,
  PUBLISH_LOCK_TIMEOUT_MS,
} from "../../../dist/installer/matchlock/dsh-profile-overlay.js";

const RUN_ID = "11111111-2222-3333-4444-555555555555";
const INV_A = "inv-aaaaaaaa-11111111";
const INV_B = "inv-bbbbbbbb-22222222";
const GUEST_ROOT = "/workspace/config/dsh";

let tmpRoot: string;
const created: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, prefix));
  created.push(dir);
  return dir;
}

/**
 * A synthetic operator dsh home with the real headless profile layout plus a
 * private-farm mismatch: `profiles/node_modules` (scope dir with symlinks),
 * `profiles/headless/node_modules`, `profiles/headless/.dsh-module-fallback/
 * node_modules`, and a node_modules nested under a non-derived subdir.
 */
function makeDshHome(): string {
  const home = mkTmp("dsh-home-");
  fs.mkdirSync(path.join(home, "profiles", "node_modules", "@deepseek-ai"), { recursive: true });
  fs.symlinkSync(
    "/opt/dsh/apps/cli/node_modules/@deepseek-ai/cordis",
    path.join(home, "profiles", "node_modules", "@deepseek-ai", "cordis"),
  );
  fs.mkdirSync(path.join(home, "profiles", "headless", "node_modules"), { recursive: true });
  fs.mkdirSync(
    path.join(home, "profiles", "headless", DSH_MODULE_FALLBACK_DIR_NAME, "node_modules"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(home, "profiles", "headless", "sub", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.yml"), "[]\n", "utf8");
  fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "patch: []\n", "utf8");
  fs.writeFileSync(path.join(home, "profiles", "headless", "package.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(home, "profiles", "headless", "pnpm-workspace.yaml"), "packages: []\n", "utf8");
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(home, "storages"), { recursive: true });
  fs.writeFileSync(path.join(home, ".credentials.yaml"), "refs: []\n", "utf8");
  fs.writeFileSync(path.join(home, ".anonymous-user-id"), "anon\n", "utf8");
  fs.writeFileSync(path.join(home, "unknown-entry.bin"), "x", "utf8");
  return home;
}

/** Prepare a private overlay for `home` and return its root. */
function preparedOverlay(
  home: string,
  runId = RUN_ID,
  invocationId = INV_A,
): { live: string; overlay: string } {
  const live = mkTmp("live-state-");
  prepareDshProfileOverlay(runId, invocationId, live, home);
  return { live, overlay: dshProfileOverlayRoot(runId, invocationId, live) };
}

/**
 * Byte-level, symlink-preserving snapshot of a tree: names, kinds, raw file
 * contents (base64) and raw symlink targets, sorted deterministically.
 */
function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const childRel = rel ? path.join(rel, name) : name;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) out.push(`L ${childRel} -> ${fs.readlinkSync(full)}`);
      else if (st.isDirectory()) {
        out.push(`D ${childRel}`);
        walk(full, childRel);
      } else if (st.isFile()) out.push(`F ${childRel} ${fs.readFileSync(full).toString("base64")}`);
      else out.push(`O ${childRel}`);
    }
  };
  walk(root, "");
  return out;
}

/**
 * A pid that is POSITIVELY dead on this host, proven by the very probe the
 * shipment uses (`process.kill(pid, 0)` throwing `ESRCH` ->
 * `publishLockOwnerIsDead` -> the lock may be broken).
 *
 * The candidates are above any platform `pid_max` (linux <= 4194304, darwin
 * <= 99998), so the kernel can never allocate them: stronger than a reaped
 * child pid, whose number could be reused between the reap and the probe.
 * This is why the crash is modelled WITHOUT `node:child_process` (a
 * `spawnSync(/usr/bin/true)` would reclassify this whole file into the SERIAL
 * lane, while it is a parallel-lane file by design).
 *
 * SIMULATED crash: a dead pid in a planted owner file, NOT a real kill and no
 * VM. Nothing here proves anything about a guest.
 */
function positivelyDeadPid(): number {
  for (const pid of [0x7fffffff, 0x7ffffffe, 1_000_003, 999_983]) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  assert.fail("no positively dead pid candidate was found on this host");
}

/**
 * Plant a publication lock directory, as a crashed/interrupted holder leaves
 * it behind: the lock dir plus (optionally) its `owner` file. `null` models an
 * unreadable owner (no owner file at all).
 */
function plantPublishLock(lockPath: string, ownerBytes: string | null): void {
  fs.mkdirSync(lockPath, { recursive: true });
  if (ownerBytes !== null) fs.writeFileSync(path.join(lockPath, "owner"), ownerBytes, "utf8");
}

/** URL of the COMPILED overlay module, for real worker-thread publishers. */
const COMPILED_OVERLAY_URL = new URL(
  "../../../dist/installer/matchlock/dsh-profile-overlay.js",
  import.meta.url,
).href;

type PublishWorkerOutcome = { ok: boolean; code?: string };

/**
 * Start ONE real worker-thread publisher of `publishDshHomeOverlayToHost`.
 *
 * This is a genuine in-process concurrency arm (two OS threads running the
 * shipped code), NOT VM execution: no Matchlock VM, harness or model is
 * involved, and nothing here proves anything about a guest.
 *
 * `barrier` (optional) is a shared counter the worker bumps and then spins on
 * until it reaches 2, so two publishers can be released into the publication
 * step together. The returned `started` promise resolves the moment the worker
 * is about to CALL publish (before the call), which lets a test observe the
 * shared-boundary lock without racing the thread's startup.
 */
async function startPublishWorker(
  args: { runId: string; invocationId: string; live: string; home: string },
  barrier?: Int32Array,
): Promise<{ started: Promise<void>; result: Promise<PublishWorkerOutcome> }> {
  const { Worker } = await import("node:worker_threads");
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const result = new Promise<PublishWorkerOutcome>((resolve, reject) => {
    const src = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const mod = await import(workerData.moduleUrl);
        if (workerData.counter) {
          const c = new Int32Array(workerData.counter);
          Atomics.add(c, 0, 1);
          Atomics.notify(c, 0);
          while (Atomics.load(c, 0) < 2) {
            Atomics.wait(c, 0, Atomics.load(c, 0), 1000);
          }
        }
        parentPort.postMessage({ phase: "started" });
        try {
          mod.publishDshHomeOverlayToHost(
            workerData.runId, workerData.invocationId, workerData.live, workerData.home,
          );
          parentPort.postMessage({ phase: "done", ok: true });
        } catch (err) {
          parentPort.postMessage({
            phase: "done",
            ok: false,
            code: err && err.code ? String(err.code) : String(err),
          });
        }
      })().catch((err) => {
        parentPort.postMessage({
          phase: "done",
          ok: false,
          code: "worker-failure:" + String((err && err.stack) || err),
        });
      });
    `;
    const worker = new Worker(src, {
      eval: true,
      workerData: {
        moduleUrl: COMPILED_OVERLAY_URL,
        counter: barrier ? barrier.buffer : undefined,
        ...args,
      },
    });
    worker.on("message", (msg: { phase: string; ok?: boolean; code?: string }) => {
      if (msg.phase === "started") {
        markStarted();
        return;
      }
      void worker.terminate();
      resolve({ ok: msg.ok === true, code: msg.code });
    });
    worker.once("error", (err) => {
      reject(err);
    });
  });
  return { started, result };
}

/** Start two real worker-thread publishers released together at the barrier. */
async function publishConcurrently(
  args: { runId: string; live: string; home: string },
  invocationIds: [string, string],
): Promise<[PublishWorkerOutcome, PublishWorkerOutcome]> {
  const counter = new Int32Array(new SharedArrayBuffer(4));
  const [a, b] = await Promise.all([
    startPublishWorker({ ...args, invocationId: invocationIds[0] }, counter),
    startPublishWorker({ ...args, invocationId: invocationIds[1] }, counter),
  ]);
  const [ra, rb] = await Promise.all([a.result, b.result]);
  return [ra, rb];
}

describe("dsh profile overlay", () => {
  before(() => {
    tmpRoot = tamanduaTempDir("tamandua-dsh-overlay-");
  });
  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── module shape ───────────────────────────────────────────────────
  it("exports the planner surface and imports only node: builtins", () => {
    const src = fs.readFileSync(new URL("./dsh-profile-overlay.ts", import.meta.url), "utf8");
    const specs = [...src.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
    assert.ok(specs.length >= 2, `expected node builtin imports, got ${JSON.stringify(specs)}`);
    for (const spec of specs) {
      assert.ok(spec.startsWith("node:"), `unexpected non-builtin import: ${spec}`);
      assert.notEqual(spec, "node:child_process");
    }
  });

  // ── discovery ──────────────────────────────────────────────────────
  describe("discoverDshInstallDerivedDirs", () => {
    it("returns every outermost install-derived dir (including nested) for a fixture home", () => {
      const home = makeDshHome();
      assert.deepEqual(discoverDshInstallDerivedDirs(home), [
        "profiles/headless/.dsh-module-fallback",
        "profiles/headless/node_modules",
        "profiles/headless/sub/node_modules",
        "profiles/node_modules",
      ]);
    });

    it("does not follow symlinked directory entries", () => {
      const home = mkTmp("dsh-home-link-");
      fs.mkdirSync(path.join(home, "profiles"), { recursive: true });
      const outside = mkTmp("outside-");
      fs.mkdirSync(path.join(outside, "node_modules"), { recursive: true });
      fs.symlinkSync(outside, path.join(home, "profiles", "linked-profile"));
      assert.deepEqual(discoverDshInstallDerivedDirs(home), []);
    });

    it("returns [] for a home with profiles but no install-derived directories", () => {
      const home = mkTmp("dsh-home-none-");
      fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
      fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.yml"), "[]\n", "utf8");
      assert.deepEqual(discoverDshInstallDerivedDirs(home), []);
    });

    it("returns [] for a home with no profiles directory", () => {
      const home = mkTmp("dsh-home-bare-");
      fs.writeFileSync(path.join(home, ".credentials.yaml"), "refs: []\n", "utf8");
      assert.deepEqual(discoverDshInstallDerivedDirs(home), []);
    });
  });

  // ── overlay root derivation/predicate ──────────────────────────────
  describe("overlay root", () => {
    it("derives <liveState>/matchlock/dsh-profile-invocations/<bareRunId>/<invocationId> (run- prefix stripped)", () => {
      const live = "/tmp/live-state-example";
      assert.equal(
        dshProfileOverlayRoot(RUN_ID, INV_A, live),
        path.join(live, "matchlock", "dsh-profile-invocations", RUN_ID, INV_A),
      );
      assert.equal(
        dshProfileOverlayRoot(`run-${RUN_ID}`, INV_A, live),
        path.join(live, "matchlock", "dsh-profile-invocations", RUN_ID, INV_A),
      );
      // The new namespace is DISJOINT from the legacy run-scoped namespace.
      assert.equal(
        dshProfileOverlayRoot(RUN_ID, INV_A, live).startsWith(
          path.join(live, "matchlock", MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME) + path.sep,
        ),
        false,
        "a per-invocation root must never be nested inside the legacy overlays parent",
      );
    });

    it("gives two invocations of one run DISTINCT roots", () => {
      const live = "/tmp/live-state-example";
      assert.notEqual(
        dshProfileOverlayRoot(RUN_ID, INV_A, live),
        dshProfileOverlayRoot(RUN_ID, INV_B, live),
      );
      assert.equal(
        dshProfileInvocationGroupRoot(RUN_ID, live),
        path.join(live, "matchlock", MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME, RUN_ID),
      );
    });

    it("refuses a malformed run id or invocation id with a typed error", () => {
      for (const bad of ["", "not-a-uuid", "../../escape", 42 as unknown as string]) {
        assert.throws(
          () => dshProfileOverlayRoot(bad, INV_A, "/tmp/live"),
          (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_run_id",
        );
      }
      assert.throws(
        () => assertDshOverlayRunId("xyz"),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_run_id",
      );
      // The exact malformed ids the acceptance criteria name, plus path-escape
      // spellings: none may ever be joined into an overlay path.
      const badInvocations = [
        "",
        "inv-",
        "../x",
        "inv-zz",
        "inv-1a2b3c4d-5e6f7a8b/../x",
        "not-an-invocation",
        "../../escape",
        "inv-/../escape",
        "inv-x",
        42 as unknown as string,
      ];
      for (const badInv of badInvocations) {
        assert.throws(
          () => dshProfileOverlayRoot(RUN_ID, badInv, "/tmp/live"),
          (e: unknown) =>
            e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_invocation_id",
        );
      }
      assert.throws(
        () => assertDshOverlayInvocationId("nope"),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_invocation_id",
      );
    });

    it("attests exactly one invocation root and fails closed for any other path (including legacy)", () => {
      const live = "/tmp/live-state-example";
      const root = dshProfileOverlayRoot(RUN_ID, INV_A, live);
      assert.equal(isHostAttestedDshProfileOverlay(root, RUN_ID, INV_A, live), true);
      assert.equal(isHostAttestedDshProfileOverlay(root, RUN_ID, INV_B, live), false);
      assert.equal(isHostAttestedDshProfileOverlay(`${root}-sibling`, RUN_ID, INV_A, live), false);
      assert.equal(isHostAttestedDshProfileOverlay("/tmp/elsewhere", RUN_ID, INV_A, live), false);
      assert.equal(isHostAttestedDshProfileOverlay(root, "99999999-...", INV_A, live), false);
      assert.equal(isDshProfileOverlayRootShape(root), true);
      // The legacy run-scoped shape is explicitly NOT accepted as an overlay root.
      const legacy = path.join(live, "matchlock", MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME, RUN_ID);
      assert.equal(isDshProfileOverlayRootShape(legacy), false, "the legacy shape must be rejected");
      assert.equal(isDshProfileOverlayRootShape("/tmp/live/matchlock/other/abc"), false);
      assert.equal(isDshProfileOverlayRootShape(path.join(live, "runs", RUN_ID)), false);
      assert.equal(
        isDshProfileOverlayRootShape(path.join(live, "matchlock", "dsh-profile-invocations", RUN_ID)),
        false,
        "the run grouping dir is not itself an overlay root",
      );
    });
  });

  // ── prepare ────────────────────────────────────────────────────────
  describe("prepareDshProfileOverlay", () => {
    it("creates a real private dir per install-derived path and allocates the root EXCLUSIVELY", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-");
      const first = prepareDshProfileOverlay(RUN_ID, INV_A, live, home);
      assert.equal(first.runId, RUN_ID);
      assert.equal(first.invocationId, INV_A);
      assert.equal(first.overlayRoot, dshProfileOverlayRoot(RUN_ID, INV_A, live));
      assert.deepEqual(first.relPaths, discoverDshInstallDerivedDirs(home));
      for (const rel of first.relPaths) {
        const st = fs.lstatSync(path.join(first.overlayRoot, rel));
        assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${rel} must be a real directory`);
      }
      // EXCLUSIVE: a second prepare under the SAME invocation identity refuses
      // to adopt the preexisting root (never a silent successor reuse) and
      // leaves the existing tree BYTE-IDENTICAL.
      const rootBefore = snapshotTree(first.overlayRoot);
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, INV_A, live, home),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_root_exists",
      );
      assert.deepEqual(
        snapshotTree(first.overlayRoot),
        rootBefore,
        "a refused re-prepare must leave the existing invocation tree untouched",
      );
      assert.ok(fs.lstatSync(first.overlayRoot).isDirectory());
      // A DIFFERENT invocation of the same run gets its own distinct root.
      const second = prepareDshProfileOverlay(RUN_ID, INV_B, live, home);
      assert.notEqual(second.overlayRoot, first.overlayRoot);
      assert.equal(second.invocationId, INV_B);
      assert.ok(fs.lstatSync(second.overlayRoot).isDirectory());
      // Both invocation roots coexist under the run grouping dir, each with its
      // OWN host-side prepare-time provenance manifest (a host-only sibling of
      // the mounted root — the guest can never see it).
      assert.deepEqual(
        fs
          .readdirSync(dshProfileInvocationGroupRoot(RUN_ID, live))
          .filter((name) => !name.endsWith(".prepare.json"))
          .sort(),
        [INV_A, INV_B].sort(),
      );
      assert.ok(fs.existsSync(dshProfileOverlayProvenancePath(RUN_ID, INV_A, live)));
      assert.ok(fs.existsSync(dshProfileOverlayProvenancePath(RUN_ID, INV_B, live)));
      // The manifests are OUTSIDE every mounted overlay root.
      for (const inv of [INV_A, INV_B]) {
        const manifest = path.resolve(dshProfileOverlayProvenancePath(RUN_ID, inv, live));
        const root = path.resolve(dshProfileOverlayRoot(RUN_ID, inv, live));
        assert.equal(
          manifest.startsWith(root + path.sep),
          false,
          `the provenance manifest must never live inside the guest-writable overlay (${manifest})`,
        );
      }
    });

    it("refuses a symlinked matchlock parent (never writes through it)", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-symlink-matchlock-");
      const target = mkTmp("symlink-target-");
      fs.symlinkSync(target, path.join(live, "matchlock"));
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, INV_A, live, home),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
      assert.deepEqual(fs.readdirSync(target), [], "nothing may be created through a symlinked parent");
    });

    it("refuses a symlinked invocations parent and a symlinked invocation root", () => {
      const home = makeDshHome();
      const liveA = mkTmp("live-state-symlink-invocations-");
      fs.mkdirSync(path.join(liveA, "matchlock"), { recursive: true });
      const target = mkTmp("symlink-target-invocations-");
      fs.symlinkSync(target, path.join(liveA, "matchlock", "dsh-profile-invocations"));
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, INV_A, liveA, home),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );

      const liveB = mkTmp("live-state-symlink-root-");
      fs.mkdirSync(path.join(liveB, "matchlock", "dsh-profile-invocations", RUN_ID), { recursive: true });
      const escape = mkTmp("symlink-target-root-");
      fs.symlinkSync(escape, dshProfileOverlayRoot(RUN_ID, INV_A, liveB));
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, INV_A, liveB, home),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_root_exists",
      );
      assert.deepEqual(fs.readdirSync(escape), [], "nothing may be created through a symlinked invocation root");
    });

    it("stages a private byte-identical copy of the host profiles tree", () => {
      const home = makeDshHome();
      const hostBefore = snapshotTree(home);
      const live = mkTmp("live-state-stage-");
      const layout = prepareDshProfileOverlay(RUN_ID, INV_A, live, home);
      const overlayProfiles = path.join(layout.overlayRoot, "profiles");

      // profilesStaged is an always-present fact for the prepared overlay.
      assert.equal(layout.profilesStaged, true);
      const st = fs.lstatSync(overlayProfiles);
      assert.ok(st.isDirectory() && !st.isSymbolicLink(), "overlay profiles must be a real directory");

      // Durable profile config files are copied byte-identically.
      for (const name of ["package.json", "cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml"]) {
        const staged = path.join(overlayProfiles, "headless", name);
        assert.equal(
          fs.readFileSync(staged, "utf8"),
          fs.readFileSync(path.join(home, "profiles", "headless", name), "utf8"),
          `${name} must be copied byte-identically`,
        );
      }

      // Every install-derived path is an EMPTY real directory (farm content
      // never copied through).
      for (const rel of layout.relPaths) {
        const derivedDir = path.join(layout.overlayRoot, rel);
        const dst = fs.lstatSync(derivedDir);
        assert.ok(dst.isDirectory() && !dst.isSymbolicLink(), `${rel} must be a real directory`);
        assert.deepEqual(fs.readdirSync(derivedDir), [], `${rel} must be empty in the private overlay`);
      }

      // The staged tree is reported: durable entries + empty derived dirs.
      const expectedStaged = [
        "profiles/headless",
        "profiles/headless/.dsh-module-fallback",
        "profiles/headless/cordis.patch.yml",
        "profiles/headless/cordis.yml",
        "profiles/headless/node_modules",
        "profiles/headless/package.json",
        "profiles/headless/pnpm-workspace.yaml",
        "profiles/headless/sub",
        "profiles/headless/sub/node_modules",
        "profiles/node_modules",
      ].sort((a, b) => a.localeCompare(b));
      assert.deepEqual(layout.stagedProfilePaths, expectedStaged);

      // Host tree is byte-identical after prepare.
      assert.deepEqual(snapshotTree(home), hostBefore, "host profiles tree must be untouched");
    });

    it("still creates a real empty profiles dir when the host has no profiles directory", () => {
      const home = mkTmp("dsh-home-bare-");
      fs.writeFileSync(path.join(home, ".credentials.yaml"), "refs: []\n", "utf8");
      const live = mkTmp("live-state-bare-");
      const layout = prepareDshProfileOverlay(RUN_ID, INV_A, live, home);
      const overlayProfiles = path.join(layout.overlayRoot, "profiles");
      assert.equal(layout.profilesStaged, true);
      assert.deepEqual(layout.stagedProfilePaths, []);
      const st = fs.lstatSync(overlayProfiles);
      assert.ok(st.isDirectory() && !st.isSymbolicLink());
      assert.deepEqual(fs.readdirSync(overlayProfiles), []);
    });

    it("refuses a symlinked entry inside host profiles and copies nothing through it", () => {
      const home = makeDshHome();
      const outside = mkTmp("outside-profile-target-");
      fs.writeFileSync(path.join(outside, "secret.txt"), "host-secret\n", "utf8");
      fs.symlinkSync(outside, path.join(home, "profiles", "headless", "linked-outside"));
      const live = mkTmp("live-state-symlink-entry-");
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, INV_A, live, home),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_source_symlink",
      );
      // Nothing was taken through the symlink.
      assert.deepEqual(fs.readdirSync(outside), ["secret.txt"]);
      assert.equal(
        fs.existsSync(path.join(dshProfileOverlayRoot(RUN_ID, INV_A, live), "profiles", "headless", "linked-outside")),
        false,
      );
    });

    it("never writes through an overlay symlink planted under a fresh invocation root", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-repair-");
      // A symlinked staged destination is refused on the FIRST prepare for an
      // invocation whose root already contains the planted link (a foreign
      // root this invocation did not allocate is never adopted).
      const rootA = dshProfileOverlayRoot(RUN_ID, INV_A, live);
      fs.mkdirSync(path.dirname(rootA), { recursive: true });
      fs.mkdirSync(rootA);
      const escape = mkTmp("overlay-escape-target-");
      fs.writeFileSync(path.join(escape, "sentinel.txt"), "keep\n", "utf8");
      fs.mkdirSync(path.join(rootA, "profiles", "headless"), { recursive: true });
      fs.symlinkSync(
        path.join(escape, "sentinel.txt"),
        path.join(rootA, "profiles", "headless", "cordis.yml"),
      );
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, INV_A, live, home),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_root_exists",
      );
      assert.equal(
        fs.readFileSync(path.join(escape, "sentinel.txt"), "utf8"),
        "keep\n",
        "the symlink target must be untouched",
      );

      // A fresh invocation root that already contains a symlinked staged
      // directory is likewise never adopted/followed: exclusive allocation
      // refuses the preexisting root before any staging write.
      const rootB = dshProfileOverlayRoot(RUN_ID, INV_B, live);
      fs.mkdirSync(path.dirname(rootB), { recursive: true });
      fs.mkdirSync(rootB);
      fs.symlinkSync(escape, path.join(rootB, "profiles"));
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, INV_B, live, home),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_root_exists",
      );
      assert.deepEqual(fs.readdirSync(escape), ["sentinel.txt"]);
    });
  });

  // ── cleanup ────────────────────────────────────────────────────────
  describe("cleanupDshProfileOverlay", () => {
    it("removes exactly the attested invocation root and is idempotent (empty group pruned, sibling invocations kept)", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-cleanup-");
      const { overlayRoot, relPaths } = prepareDshProfileOverlay(RUN_ID, INV_A, live, home);
      assert.ok(relPaths.length > 0);
      // A sibling INVOCATION root of the same run must survive A's cleanup.
      const siblingInvocation = prepareDshProfileOverlay(RUN_ID, INV_B, live, home).overlayRoot;
      // A LEGACY run-scoped root in the old namespace must never be touched.
      const legacySibling = path.join(live, "matchlock", "dsh-profile-overlays", RUN_ID);
      fs.mkdirSync(legacySibling, { recursive: true });
      fs.writeFileSync(path.join(legacySibling, "keep.txt"), "legacy\n", "utf8");

      cleanupDshProfileOverlay(RUN_ID, INV_A, live);
      assert.equal(fs.existsSync(overlayRoot), false, "A's root is removed");
      assert.equal(fs.existsSync(siblingInvocation), true, "B's live root must survive A's cleanup");
      assert.equal(fs.existsSync(path.join(legacySibling, "keep.txt")), true, "the legacy root is never touched");
      assert.equal(
        fs.existsSync(dshProfileInvocationGroupRoot(RUN_ID, live)),
        true,
        "the run grouping dir is retained while B still owns a root",
      );
      cleanupDshProfileOverlay(RUN_ID, INV_A, live); // idempotent

      // Removing the last invocation root collapses the empty group dirs, but
      // the disjoint legacy namespace is still untouched.
      cleanupDshProfileOverlay(RUN_ID, INV_B, live);
      assert.equal(fs.existsSync(siblingInvocation), false);
      assert.equal(fs.existsSync(path.join(live, "matchlock", "dsh-profile-invocations")), false);
      assert.equal(fs.existsSync(path.join(legacySibling, "keep.txt")), true);
    });

    it("refuses a symlinked invocation root and never removes its target", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-cleanup-symlink-");
      prepareDshProfileOverlay(RUN_ID, INV_A, live, home);
      const root = dshProfileOverlayRoot(RUN_ID, INV_A, live);
      fs.rmSync(root, { recursive: true, force: true });
      const target = mkTmp("cleanup-target-");
      fs.writeFileSync(path.join(target, "sentinel"), "keep\n", "utf8");
      fs.symlinkSync(target, root);
      assert.throws(
        () => cleanupDshProfileOverlay(RUN_ID, INV_A, live),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
      assert.equal(fs.existsSync(path.join(target, "sentinel")), true, "symlink target must survive");
    });

    it("refuses a malformed run id or invocation id", () => {
      assert.throws(
        () => cleanupDshProfileOverlay("nope", INV_A, "/tmp/live"),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_run_id",
      );
      assert.throws(
        () => cleanupDshProfileOverlay(RUN_ID, "nope", "/tmp/live"),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_invocation_id",
      );
    });

    it("refuses to clean up ANOTHER invocation's root (identity-bound cleanup)", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-cleanup-identity-");
      const rootA = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      // Cleaning up B's (non-existent) root never removes A's root.
      cleanupDshProfileOverlay(RUN_ID, INV_B, live);
      assert.equal(fs.existsSync(rootA), true, "an invocation's cleanup never touches another's root");
    });

    it("never touches a PRE-PLANTED legacy run-scoped root, through prepare AND cleanup", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-legacy-preplant-");
      // A legacy run-scoped root left by an older runtime, with real content.
      // OVERLAY-INV-SCOPED never reclaims, deletes or migrates it.
      const legacyParent = path.join(live, "matchlock", MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME);
      const legacyRoot = path.join(legacyParent, RUN_ID);
      fs.mkdirSync(path.join(legacyRoot, "profiles"), { recursive: true });
      fs.writeFileSync(path.join(legacyRoot, "marker.txt"), "legacy-marker\n", "utf8");
      fs.writeFileSync(path.join(legacyRoot, "profiles", "keep.yml"), "keep: true\n", "utf8");
      const legacyBefore = snapshotTree(legacyParent);

      prepareDshProfileOverlay(RUN_ID, INV_A, live, home);
      assert.deepEqual(
        snapshotTree(legacyParent),
        legacyBefore,
        "prepare must never touch the legacy dsh-profile-overlays namespace",
      );
      // The new invocation root is a SIBLING namespace, never nested in it.
      assert.equal(
        fs.existsSync(path.join(legacyRoot, INV_A)),
        false,
        "the invocation root is never created inside the legacy run-scoped root",
      );

      cleanupDshProfileOverlay(RUN_ID, INV_A, live);
      assert.deepEqual(
        snapshotTree(legacyParent),
        legacyBefore,
        "cleanup must never touch the legacy dsh-profile-overlays namespace",
      );
      assert.equal(
        fs.readFileSync(path.join(legacyRoot, "marker.txt"), "utf8"),
        "legacy-marker\n",
        "the legacy marker file is byte-identical after prepare + cleanup",
      );
    });
  });

  // ── plan ───────────────────────────────────────────────────────────
  describe("planDshHomeMounts", () => {
    it("mounts ONE real effective-home root from the private overlay and never the host profiles farm", () => {
      const home = makeDshHome();
      const { overlay } = preparedOverlay(home);
      const mounts = planDshHomeMounts(home, overlay, GUEST_ROOT);

      // Exactly ONE destination: the whole effective home at the guest root.
      assert.deepEqual(Object.keys(mounts), [GUEST_ROOT]);
      assert.equal(mounts[GUEST_ROOT]?.host_path, overlay);
      assert.equal(mounts[GUEST_ROOT]?.type, "host_fs");
      assert.equal(mounts[GUEST_ROOT]?.readonly, false);

      // The private profiles copy inside the effective home is the only
      // profiles source; the host install-derived farm is never exposed.
      const stagedProfiles = path.join(overlay, DSH_PROFILES_DIR_NAME);
      assert.ok(fs.lstatSync(stagedProfiles).isDirectory());
      const derived = new Set(discoverDshInstallDerivedDirs(home));
      assert.ok(derived.size > 0, "fixture must have install-derived dirs");
      for (const rel of derived) {
        assert.notEqual(
          path.join(overlay, rel),
          path.join(home, rel),
          `${rel} must not be staged from the host install-derived source`,
        );
      }

      // Every durable top-level entry is materialized in the effective home.
      for (const rel of [".credentials.yaml", ".anonymous-user-id", "sessions", "storages", "unknown-entry.bin"]) {
        assert.equal(fs.existsSync(path.join(overlay, rel)), true, `${rel} must be staged in the effective home`);
      }
      // The empty durable dirs are real directories (new artifacts merge back).
      for (const rel of ["sessions", "storages"]) {
        const st = fs.lstatSync(path.join(overlay, rel));
        assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${rel} must be a real staging directory`);
      }

      // No symlink anywhere under the effective home: a mounted root can never
      // traverse a link (which the runtime refuses as an escape) to reach a
      // durable entry.
      const walk = (dir: string): void => {
        for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, dirent.name);
          assert.ok(!dirent.isSymbolicLink(), `${full} must not be a symlink`);
          if (dirent.isDirectory()) walk(full);
        }
      };
      walk(overlay);
    });

    it("gives the failing-fsync home root a real, writable, fsync-able host directory", () => {
      const home = makeDshHome();
      const { overlay } = preparedOverlay(home);
      const mounts = planDshHomeMounts(home, overlay, GUEST_ROOT);
      const rootHost = mounts[GUEST_ROOT]?.host_path;
      assert.equal(rootHost, overlay);
      // The exact target of the run-#35 `ENOENT ... fsync` is <DSH_HOME>: a
      // real host directory whose own fd can be fsync-ed.
      const fd = fs.openSync(rootHost!, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // A newly created subdirectory and a rename inside it are fsync-able too.
      const project = path.join(rootHost!, "sessions", "proj-a");
      fs.mkdirSync(project, { recursive: true });
      const pdf = fs.openSync(project, "r");
      try {
        fs.fsyncSync(pdf);
      } finally {
        fs.closeSync(pdf);
      }
    });

    it("always maps the effective home (even when the host has no profiles directory)", () => {
      const home = mkTmp("dsh-home-nop-");
      fs.writeFileSync(path.join(home, ".credentials.yaml"), "refs: []\n", "utf8");
      fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
      const { overlay } = preparedOverlay(home);
      const mounts = planDshHomeMounts(home, overlay, GUEST_ROOT);
      assert.deepEqual(Object.keys(mounts), [GUEST_ROOT]);
      assert.equal(mounts[GUEST_ROOT]?.host_path, overlay);
      assert.ok(fs.lstatSync(path.join(overlay, "profiles")).isDirectory());
      assert.ok(fs.lstatSync(path.join(overlay, "sessions")).isDirectory());
      assert.ok(fs.lstatSync(path.join(overlay, ".credentials.yaml")).isFile());
    });

    it("leaves the host profiles tree byte-identical after prepare + plan", () => {
      const home = makeDshHome();
      const hostBefore = snapshotTree(home);
      const live = mkTmp("live-state-plan-invariance-");
      const { overlayRoot } = prepareDshProfileOverlay(RUN_ID, INV_A, live, home);
      planDshHomeMounts(home, overlayRoot, GUEST_ROOT);
      assert.deepEqual(snapshotTree(home), hostBefore, "prepare + plan must never modify the host home");
    });

    it("refuses a missing staged private profiles directory", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-missing-overlay-");
      const overlay = dshProfileOverlayRoot(RUN_ID, INV_A, live);
      fs.mkdirSync(overlay, { recursive: true }); // attested shape, but profiles/ not staged
      assert.throws(
        () => planDshHomeMounts(home, overlay, GUEST_ROOT),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_source_missing",
      );
    });

    it("refuses the LEGACY run-scoped shape as a mount source", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-legacy-shape-");
      const legacy = path.join(live, "matchlock", MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME, RUN_ID);
      fs.mkdirSync(path.join(legacy, "profiles"), { recursive: true });
      assert.throws(
        () => planDshHomeMounts(home, legacy, GUEST_ROOT),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
    });

    it("refuses a foreign (non-attested-shape) overlay root", () => {
      const home = makeDshHome();
      const foreign = mkTmp("foreign-overlay-");
      assert.throws(
        () => planDshHomeMounts(home, foreign, GUEST_ROOT),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
    });

    it("refuses a broad host source and an unsafe guest root", () => {
      const home = makeDshHome();
      const { overlay } = preparedOverlay(home);
      assert.throws(
        () => planDshHomeMounts("/", overlay, GUEST_ROOT),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_broad_source",
      );
      assert.throws(
        () => planDshHomeMounts(home, overlay, "/"),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_destination_unsafe",
      );
    });

    it("refuses a symlinked top-level host entry and a symlinked staged entry (fail closed)", () => {
      const home = makeDshHome();
      const { overlay } = preparedOverlay(home);
      // A symlinked top-level host entry is refused while staging the effective
      // home (never followed, never mounted).
      fs.symlinkSync(path.join(home, ".credentials.yaml"), path.join(home, "linked-credentials"));
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, INV_A, mkTmp("live-state-symlink-top-"), home),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_source_symlink",
      );

      // A symlink inside the host profiles tree is no longer the plan's concern:
      // profiles/ maps wholly from the private overlay, so the plan succeeds and
      // the overlay is the source. prepareDshProfileOverlay is what refuses it.
      const home2 = makeDshHome();
      const { overlay: overlay2 } = preparedOverlay(home2);
      fs.symlinkSync(
        path.join(home2, "profiles", "headless", "cordis.yml"),
        path.join(home2, "profiles", "headless", "linked-cordis.yml"),
      );
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, INV_A, mkTmp("live-state-inner-link-"), home2),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_source_symlink",
      );

      // A symlink planted in the staged effective home is refused by the plan.
      fs.symlinkSync("/etc/hostname", path.join(overlay, "staged-escape"));
      assert.throws(
        () => planDshHomeMounts(home, overlay, GUEST_ROOT),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_source_symlink",
      );
      assert.ok(overlay2.length > 0);
    });

    it("does not mutate the host install-derived directory", () => {
      const home = makeDshHome();
      const farm = path.join(home, "profiles", DSH_NODE_MODULES_DIR_NAME, "@deepseek-ai");
      const before = fs.readdirSync(farm).sort();
      const beforeRoot = fs.readdirSync(path.join(home, DSH_PROFILES_DIR_NAME)).sort();
      const { overlay } = preparedOverlay(home);
      planDshHomeMounts(home, overlay, GUEST_ROOT);
      assert.deepEqual(fs.readdirSync(farm).sort(), before);
      assert.deepEqual(fs.readdirSync(path.join(home, DSH_PROFILES_DIR_NAME)).sort(), beforeRoot);
    });
  });

  // ── publish (merge-back) ───────────────────────────────────────────
  describe("publishDshHomeOverlayToHost", () => {
    it("publishes guest-written durable entries to the host but never profiles/", () => {
      const home = makeDshHome();
      const { live, overlay } = preparedOverlay(home);
      // Simulate a guest round writing a new session into the effective home.
      const sessionDir = path.join(overlay, "sessions", "--proj--", "session-abc");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "session.v3.jsonl.zstd"), "guest-bytes", "utf8");
      // Simulate a guest-created durable file and a profile write that must stay private.
      fs.writeFileSync(path.join(overlay, "new-entry.bin"), "new\n", "utf8");
      fs.writeFileSync(path.join(overlay, "profiles", "node_modules.lock"), "private-lock\n", "utf8");

      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home);

      const published = path.join(home, "sessions", "--proj--", "session-abc", "session.v3.jsonl.zstd");
      assert.equal(fs.readFileSync(published, "utf8"), "guest-bytes");
      assert.equal(fs.readFileSync(path.join(home, "new-entry.bin"), "utf8"), "new\n");
      // The private profiles tree is never published.
      assert.equal(fs.existsSync(path.join(home, "profiles", "node_modules.lock")), false);
    });

    it("skips unchanged hard-linked files (same inode) and is idempotent", () => {
      const home = makeDshHome();
      const { live, overlay } = preparedOverlay(home);
      const hostCred = path.join(home, ".credentials.yaml");
      const overlayCred = path.join(overlay, ".credentials.yaml");
      const hostIno = fs.lstatSync(hostCred).ino;
      assert.equal(fs.lstatSync(overlayCred).ino, hostIno, "staged durable file must share the host inode");
      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home);
      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home); // idempotent
      assert.equal(fs.lstatSync(hostCred).ino, hostIno, "an unchanged hard-linked file is not rewritten");
      assert.equal(fs.readFileSync(hostCred, "utf8"), fs.readFileSync(overlayCred, "utf8"));
    });

    it("merges two overlapping invocations' unique artifacts without loss in EITHER teardown order", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-overlap-");
      const overlayA = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      const overlayB = prepareDshProfileOverlay(RUN_ID, INV_B, live, home).overlayRoot;
      // Each invocation writes a DISTINCT session artifact.
      fs.mkdirSync(path.join(overlayA, "sessions", "proj-a"), { recursive: true });
      fs.writeFileSync(path.join(overlayA, "sessions", "proj-a", "a.jsonl"), "A\n", "utf8");
      fs.mkdirSync(path.join(overlayB, "sessions", "proj-b"), { recursive: true });
      fs.writeFileSync(path.join(overlayB, "sessions", "proj-b", "b.jsonl"), "B\n", "utf8");
      // Teardown order A then B: both unique artifacts survive.
      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home);
      publishDshHomeOverlayToHost(RUN_ID, INV_B, live, home);
      assert.equal(fs.readFileSync(path.join(home, "sessions", "proj-a", "a.jsonl"), "utf8"), "A\n");
      assert.equal(fs.readFileSync(path.join(home, "sessions", "proj-b", "b.jsonl"), "utf8"), "B\n");

      // Reverse order with a fresh live root: B then A, both survive too.
      const live2 = mkTmp("live-state-publish-overlap2-");
      const overlayA2 = prepareDshProfileOverlay(RUN_ID, INV_A, live2, home).overlayRoot;
      const overlayB2 = prepareDshProfileOverlay(RUN_ID, INV_B, live2, home).overlayRoot;
      fs.mkdirSync(path.join(overlayA2, "sessions", "proj-a2"), { recursive: true });
      fs.writeFileSync(path.join(overlayA2, "sessions", "proj-a2", "a2.jsonl"), "A2\n", "utf8");
      fs.mkdirSync(path.join(overlayB2, "sessions", "proj-b2"), { recursive: true });
      fs.writeFileSync(path.join(overlayB2, "sessions", "proj-b2", "b2.jsonl"), "B2\n", "utf8");
      publishDshHomeOverlayToHost(RUN_ID, INV_B, live2, home);
      publishDshHomeOverlayToHost(RUN_ID, INV_A, live2, home);
      assert.equal(fs.readFileSync(path.join(home, "sessions", "proj-a2", "a2.jsonl"), "utf8"), "A2\n");
      assert.equal(fs.readFileSync(path.join(home, "sessions", "proj-b2", "b2.jsonl"), "utf8"), "B2\n");
    });

    it("refuses a symlinked overlay root and is a no-op for an absent one", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-foreign-");
      // Absent attested root: nothing to publish, no throw.
      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home);
      // A symlink at the attested root is refused, never followed.
      const root = dshProfileOverlayRoot(RUN_ID, INV_A, live);
      fs.mkdirSync(path.dirname(root), { recursive: true });
      const target = mkTmp("publish-escape-");
      fs.symlinkSync(target, root);
      assert.throws(
        () => publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
      assert.deepEqual(fs.readdirSync(target), []);
    });

    it("refuses to publish from ANOTHER invocation's root (identity-bound publish)", () => {
      const home = makeDshHome();
      const { live } = preparedOverlay(home, RUN_ID, INV_A);
      // Publishing under identity B (never allocated) is a no-op: it cannot
      // read A's data and cannot erase A's root.
      publishDshHomeOverlayToHost(RUN_ID, INV_B, live, home);
      assert.equal(
        fs.existsSync(dshProfileOverlayRoot(RUN_ID, INV_A, live)),
        true,
        "another invocation's root is never touched by publish",
      );
    });
  });

  // ── prepare-time provenance manifest (R3) ──────────────────────────
  describe("dsh overlay provenance manifest", () => {
    it("derives <groupingDir>/<invocationId>.prepare.json OUTSIDE the mounted overlay root", () => {
      const live = "/tmp/live-state-example";
      const manifest = dshProfileOverlayProvenancePath(RUN_ID, INV_A, live);
      assert.equal(
        manifest,
        path.join(
          live,
          "matchlock",
          MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME,
          RUN_ID,
          `${INV_A}.prepare.json`,
        ),
      );
      // A SIBLING of the invocation root, inside the host-only grouping dir.
      assert.equal(path.dirname(manifest), dshProfileInvocationGroupRoot(RUN_ID, live));
      assert.equal(
        manifest.startsWith(dshProfileOverlayRoot(RUN_ID, INV_A, live) + path.sep),
        false,
        "the manifest must never live inside the guest-writable overlay",
      );
      // Not itself a mountable overlay root, and never derived from the legacy
      // run-scoped namespace.
      assert.equal(isDshProfileOverlayRootShape(manifest), false);
      assert.equal(
        manifest.startsWith(path.join(live, "matchlock", MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME) + path.sep),
        false,
        "the manifest is never placed in the LEGACY overlays namespace",
      );
      // The `run-` prefix is stripped like every other overlay path.
      assert.equal(
        dshProfileOverlayProvenancePath(`run-${RUN_ID}`, INV_A, live),
        manifest,
      );
      // Malformed ids are refused before they are ever joined into a path.
      assert.throws(
        () => dshProfileOverlayProvenancePath(RUN_ID, "nope", live),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_invocation_id",
      );
    });

    it("records one fingerprint per durable host file (recursive) with NO profiles/ entry, and cleanup removes it", () => {
      const home = makeDshHome();
      // A nested durable directory proves the walk is recursive.
      fs.mkdirSync(path.join(home, "nested", "deep"), { recursive: true });
      fs.writeFileSync(path.join(home, "nested", "deep", "file.bin"), "nested\n", "utf8");
      const live = mkTmp("live-state-provenance-");
      prepareDshProfileOverlay(RUN_ID, INV_A, live, home);

      const manifestPath = dshProfileOverlayProvenancePath(RUN_ID, INV_A, live);
      assert.ok(fs.existsSync(manifestPath), "prepare must record the provenance manifest");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        version: number;
        runId: string;
        invocationId: string;
        hostHome: string;
        files: Record<string, { dev: number; ino: number; size: number; mtimeMs: number }>;
      };
      assert.equal(manifest.version, 1);
      assert.equal(manifest.runId, RUN_ID);
      assert.equal(manifest.invocationId, INV_A);
      assert.equal(manifest.hostHome, path.resolve(home));
      assert.deepEqual(Object.keys(manifest.files).sort(), [
        ".anonymous-user-id",
        ".credentials.yaml",
        "nested/deep/file.bin",
        "unknown-entry.bin",
      ]);
      for (const rel of Object.keys(manifest.files)) {
        assert.equal(
          rel === "profiles" || rel.startsWith(`profiles${path.sep}`),
          false,
          `the private profiles tree must never be recorded as a durable host file: ${rel}`,
        );
        assert.deepEqual(
          Object.keys(manifest.files[rel]).sort(),
          ["dev", "ino", "mtimeMs", "size"],
          "a fingerprint is exactly dev/ino/size/mtimeMs (ctime is deliberately excluded)",
        );
      }
      // The recorded fingerprint is the real host inode identity.
      const credStat = fs.lstatSync(path.join(home, ".credentials.yaml"));
      assert.equal(manifest.files[".credentials.yaml"].ino, credStat.ino);
      assert.equal(manifest.files[".credentials.yaml"].dev, credStat.dev);
      assert.equal(manifest.files[".credentials.yaml"].size, credStat.size);

      // A completed cleanup removes the manifest (so the empty grouping dirs
      // can collapse); nothing else about the host home is touched.
      cleanupDshProfileOverlay(RUN_ID, INV_A, live);
      assert.equal(fs.existsSync(manifestPath), false, "cleanup removes this invocation's manifest");
      assert.equal(fs.existsSync(dshProfileInvocationGroupRoot(RUN_ID, live)), false);
    });
  });

  // ── publication conflict policy + serialization (R3) ───────────────
  describe("publication conflict policy", () => {
    it("flows a legitimate update when the host destination is unchanged since prepare, and is retry-safe", () => {
      const home = makeDshHome();
      const { live, overlay } = preparedOverlay(home);
      const hostCred = path.join(home, ".credentials.yaml");
      const hostStatBefore = fs.lstatSync(hostCred);
      // The guest atomically replaces the hard-linked credentials file (a new
      // inode with new bytes) instead of writing through the shared inode; the
      // HOST destination itself was untouched since prepare.
      fs.rmSync(path.join(overlay, ".credentials.yaml"));
      fs.writeFileSync(path.join(overlay, ".credentials.yaml"), "refs: [updated]\n", "utf8");

      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home);
      assert.equal(fs.readFileSync(hostCred, "utf8"), "refs: [updated]\n");
      // The host inode identity is preserved (an in-place copy, not a replace).
      assert.equal(fs.lstatSync(hostCred).ino, hostStatBefore.ino);
      // A retry after our OWN publish is a byte-identical no-op, never a
      // spurious conflict (ordinary single-invocation behavior unchanged).
      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home);
      assert.equal(fs.readFileSync(hostCred, "utf8"), "refs: [updated]\n");
    });

    it("retains a TRUE conflict instead of silently overwriting an independently changed host destination", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-conflict-");
      const overlayA = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      fs.mkdirSync(path.join(overlayA, "sessions", "conflict"), { recursive: true });
      fs.writeFileSync(path.join(overlayA, "sessions", "conflict", "x.jsonl"), "from-invocation\n", "utf8");
      // Independent host change AFTER prepare at the SAME destination path.
      fs.mkdirSync(path.join(home, "sessions", "conflict"), { recursive: true });
      fs.writeFileSync(path.join(home, "sessions", "conflict", "x.jsonl"), "from-host\n", "utf8");

      assert.throws(
        () => publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_publish_conflict",
      );
      // The independently changed host destination is NEVER overwritten...
      assert.equal(
        fs.readFileSync(path.join(home, "sessions", "conflict", "x.jsonl"), "utf8"),
        "from-host\n",
      );
      // ...and the invocation root is RETAINED so its artifact is not lost.
      assert.ok(fs.existsSync(overlayA), "the conflicting invocation root must be retained");
      assert.equal(
        fs.readFileSync(path.join(overlayA, "sessions", "conflict", "x.jsonl"), "utf8"),
        "from-invocation\n",
      );
      // A refusal still releases the shared publication lock.
      assert.equal(fs.existsSync(dshProfilePublishLockPath(live, home)), false);
    });

    it("retains a conflict for a destination recorded at prepare and replaced independently since", () => {
      const home = makeDshHome();
      const { live } = preparedOverlay(home);
      const hostCred = path.join(home, ".credentials.yaml");
      // Independent replacement (new inode, new bytes) of a path that WAS
      // recorded at prepare: the fingerprint no longer matches.
      fs.rmSync(hostCred);
      fs.writeFileSync(hostCred, "refs: [someone-else]\n", "utf8");

      assert.throws(
        () => publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_publish_conflict",
      );
      assert.equal(fs.readFileSync(hostCred, "utf8"), "refs: [someone-else]\n");
    });

    it("refuses to re-create a destination that existed at prepare and was removed independently", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-removed-");
      const overlay = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      const hostAnon = path.join(home, ".anonymous-user-id");
      assert.ok(fs.existsSync(hostAnon));
      fs.rmSync(hostAnon); // independent removal after prepare

      assert.throws(
        () => publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_publish_conflict",
      );
      assert.equal(fs.existsSync(hostAnon), false, "a removed destination is never re-created");
      assert.equal(
        fs.existsSync(path.join(overlay, ".anonymous-user-id")),
        true,
        "the invocation's copy is retained",
      );
    });

    it("treats byte-identical content as retry-safe and creates a genuinely new artifact with the source mode", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-identical-");
      const overlay = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      // Byte-identical: another writer created the same content at a path that
      // was absent at prepare (different inode — a copy would happen without
      // the content check).
      fs.mkdirSync(path.join(home, "sessions", "same"), { recursive: true });
      const hostSame = path.join(home, "sessions", "same", "x.jsonl");
      fs.writeFileSync(hostSame, "same-bytes\n", "utf8");
      const hostSameBefore = fs.lstatSync(hostSame);
      fs.mkdirSync(path.join(overlay, "sessions", "same"), { recursive: true });
      fs.writeFileSync(path.join(overlay, "sessions", "same", "x.jsonl"), "same-bytes\n", "utf8");
      // A genuinely new artifact (absent at prepare, still absent) with an
      // explicit source mode that must be reproduced on the host.
      fs.mkdirSync(path.join(overlay, "sessions", "fresh"), { recursive: true });
      const freshOverlay = path.join(overlay, "sessions", "fresh", "y.jsonl");
      fs.writeFileSync(freshOverlay, "fresh\n", "utf8");
      fs.chmodSync(freshOverlay, 0o640);

      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home);

      // No copy for the identical file: same inode and mtime as before.
      const hostSameAfter = fs.lstatSync(hostSame);
      assert.equal(hostSameAfter.ino, hostSameBefore.ino, "a byte-identical destination is not replaced");
      assert.equal(hostSameAfter.mtimeMs, hostSameBefore.mtimeMs, "a byte-identical destination is not rewritten");
      assert.equal(fs.readFileSync(hostSame, "utf8"), "same-bytes\n");
      // The new artifact is created with the source's mode.
      const freshHost = path.join(home, "sessions", "fresh", "y.jsonl");
      assert.equal(fs.readFileSync(freshHost, "utf8"), "fresh\n");
      assert.equal(fs.statSync(freshHost).mode & 0o777, 0o640);
    });

    it("refuses a malformed, identity-mismatched or shape-mismatched provenance manifest (never trusts it)", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-malformed-");
      const overlay = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      fs.mkdirSync(path.join(overlay, "sessions", "m"), { recursive: true });
      const hostProbe = path.join(home, "sessions", "m", "x.jsonl");
      fs.writeFileSync(path.join(overlay, "sessions", "m", "x.jsonl"), "guest\n", "utf8");
      const manifestPath = dshProfileOverlayProvenancePath(RUN_ID, INV_A, live);
      const good = fs.readFileSync(manifestPath, "utf8");
      const isMismatch = (e: unknown): boolean =>
        e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_provenance_mismatch";

      // 1. Unparseable.
      fs.writeFileSync(manifestPath, "{ this is not json", "utf8");
      assert.throws(() => publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home), isMismatch);
      assert.equal(fs.existsSync(hostProbe), false, "nothing is published from an untrusted manifest");
      assert.equal(fs.existsSync(dshProfilePublishLockPath(live, home)), false, "the lock is released on refusal");

      // 2. Identity mismatch (a valid manifest for ANOTHER invocation).
      const wrongInvocation = JSON.parse(good) as Record<string, unknown>;
      wrongInvocation.invocationId = INV_B;
      fs.writeFileSync(manifestPath, JSON.stringify(wrongInvocation), "utf8");
      assert.throws(() => publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home), isMismatch);

      // 3. Identity mismatch on the host home (re-pointed destination).
      const wrongHome = JSON.parse(good) as Record<string, unknown>;
      wrongHome.hostHome = "/somewhere/else";
      fs.writeFileSync(manifestPath, JSON.stringify(wrongHome), "utf8");
      assert.throws(() => publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home), isMismatch);

      // 4. Shape mismatch (a fingerprint without the four numeric fields).
      const wrongShape = JSON.parse(good) as { files: Record<string, unknown> };
      wrongShape.files[".credentials.yaml"] = { dev: 1 };
      fs.writeFileSync(manifestPath, JSON.stringify(wrongShape), "utf8");
      assert.throws(() => publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home), isMismatch);

      // The authentic manifest publishes normally again.
      fs.writeFileSync(manifestPath, good, "utf8");
      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home);
      assert.equal(fs.readFileSync(hostProbe, "utf8"), "guest\n");
    });
  });

  describe("publication serialization", () => {
    it("keys the publication lock by the host home under the host-only live state", () => {
      const live = "/tmp/live-state-example";
      const a = dshProfilePublishLockPath(live, "/tmp/home-a");
      const b = dshProfilePublishLockPath(live, "/tmp/home-b");
      assert.notEqual(a, b, "two host homes must not share one publication lock");
      assert.equal(dshProfilePublishLockPath(live, "/tmp/home-a/"), a, "the key is normalized");
      assert.equal(path.dirname(path.dirname(a)), path.join(live, "matchlock"));
      assert.match(path.basename(a), /^[0-9a-f]{24}$/);
      assert.equal(PUBLISH_LOCK_TIMEOUT_MS, 30_000);
    });

    it("holds the shared host-home lock while publishing and releases it after (real in-process worker thread, not VM execution)", { timeout: 30_000 }, async () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-lock-");
      const overlay = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      fs.mkdirSync(path.join(overlay, "sessions", "lockprobe"), { recursive: true });
      fs.writeFileSync(path.join(overlay, "sessions", "lockprobe", "x.jsonl"), "lock-probe\n", "utf8");
      const hostArtifact = path.join(home, "sessions", "lockprobe", "x.jsonl");
      const lockPath = dshProfilePublishLockPath(live, home);

      // A lock held by a LIVE owner (this process) must NEVER be broken.
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner"), `${process.pid}\n`, "utf8");

      const worker = await startPublishWorker({ runId: RUN_ID, invocationId: INV_A, live, home });
      await worker.started; // the worker is about to CALL publish
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Publication therefore cannot have proceeded: the lock is intact, the
      // owner file is untouched and nothing reached the host home.
      assert.equal(fs.existsSync(lockPath), true, "a live holder's lock is never broken by a waiter");
      assert.equal(fs.existsSync(path.join(lockPath, "owner")), true);
      assert.equal(fs.readFileSync(path.join(lockPath, "owner"), "utf8"), `${process.pid}\n`);
      assert.equal(
        fs.existsSync(hostArtifact),
        false,
        "nothing may be published while the shared publication lock is held",
      );

      // Releasing the shared boundary lets the waiting publisher in.
      fs.rmSync(lockPath, { recursive: true, force: true });
      const outcome = await worker.result;
      assert.equal(outcome.ok, true, `the waiting publisher must complete: ${JSON.stringify(outcome)}`);
      assert.equal(fs.readFileSync(hostArtifact, "utf8"), "lock-probe\n");
      assert.equal(fs.existsSync(lockPath), false, "the publication lock is released after publish");
    });

    it("serializes two genuinely concurrent finalizers: ONE winner + one retained conflict on a shared destination", { timeout: 30_000 }, async () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-concurrent-");
      const overlayA = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      const overlayB = prepareDshProfileOverlay(RUN_ID, INV_B, live, home).overlayRoot;
      // ONE shared destination written by BOTH invocations.
      fs.mkdirSync(path.join(overlayA, "sessions", "shared"), { recursive: true });
      fs.writeFileSync(path.join(overlayA, "sessions", "shared", "one.jsonl"), "from-a\n", "utf8");
      fs.mkdirSync(path.join(overlayB, "sessions", "shared"), { recursive: true });
      fs.writeFileSync(path.join(overlayB, "sessions", "shared", "one.jsonl"), "from-b\n", "utf8");

      const [ra, rb] = await publishConcurrently({ runId: RUN_ID, live, home }, [INV_A, INV_B]);
      const winners = [ra, rb].filter((r) => r.ok);
      const conflicts = [ra, rb].filter((r) => !r.ok);
      assert.equal(winners.length, 1, `exactly one publisher may win the shared path: ${JSON.stringify([ra, rb])}`);
      assert.equal(conflicts.length, 1, `the loser must retain a typed conflict: ${JSON.stringify([ra, rb])}`);
      assert.equal(conflicts[0].code, "dsh_profile_overlay_publish_conflict");

      const hostShared = path.join(home, "sessions", "shared", "one.jsonl");
      const hostContent = fs.readFileSync(hostShared, "utf8");
      assert.ok(hostContent === "from-a\n" || hostContent === "from-b\n", hostContent);
      // The losing invocation's root is retained and holds the artifact that
      // did not win on the host: NO artifact is lost.
      const losingRoot = hostContent === "from-a\n" ? overlayB : overlayA;
      const losingContent = hostContent === "from-a\n" ? "from-b\n" : "from-a\n";
      assert.ok(fs.existsSync(losingRoot), "the losing invocation root must be retained");
      assert.equal(
        fs.readFileSync(path.join(losingRoot, "sessions", "shared", "one.jsonl"), "utf8"),
        losingContent,
      );
      // The shared boundary lock is released by both publishers.
      assert.equal(fs.existsSync(dshProfilePublishLockPath(live, home)), false);
    });

    it("keeps BOTH invocations' UNIQUE artifacts under genuinely concurrent finalization", { timeout: 30_000 }, async () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-concurrent-unique-");
      const overlayA = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      const overlayB = prepareDshProfileOverlay(RUN_ID, INV_B, live, home).overlayRoot;
      fs.mkdirSync(path.join(overlayA, "sessions", "ua"), { recursive: true });
      fs.writeFileSync(path.join(overlayA, "sessions", "ua", "a.jsonl"), "A\n", "utf8");
      fs.mkdirSync(path.join(overlayB, "sessions", "ub"), { recursive: true });
      fs.writeFileSync(path.join(overlayB, "sessions", "ub", "b.jsonl"), "B\n", "utf8");

      const results = await publishConcurrently({ runId: RUN_ID, live, home }, [INV_A, INV_B]);
      assert.ok(
        results.every((r) => r.ok),
        `both unique publications must succeed: ${JSON.stringify(results)}`,
      );
      assert.equal(fs.readFileSync(path.join(home, "sessions", "ua", "a.jsonl"), "utf8"), "A\n");
      assert.equal(fs.readFileSync(path.join(home, "sessions", "ub", "b.jsonl"), "utf8"), "B\n");
      assert.equal(fs.existsSync(dshProfilePublishLockPath(live, home)), false);
    });

    // ── crashed holders + contradictory teardown orders ──────────────
    // These arms are SIMULATED (no VM / no Matchlock / no guest): the "crash"
    // is a PLANTED lock whose owner file names a positively dead pid, and the
    // teardown orders are plain host-side calls to the shipped functions.

    it("breaks a CRASHED holder's lock and still publishes (SIMULATED crash: dead pid, no VM)", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-lock-crashed-");
      const overlay = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      fs.mkdirSync(path.join(overlay, "sessions", "crashed"), { recursive: true });
      fs.writeFileSync(path.join(overlay, "sessions", "crashed", "x.jsonl"), "crashed-holder\n", "utf8");
      const hostArtifact = path.join(home, "sessions", "crashed", "x.jsonl");
      const lockPath = dshProfilePublishLockPath(live, home);
      // A crashed holder left its lock behind: the recorded owner pid is gone.
      plantPublishLock(lockPath, `${positivelyDeadPid()}\n`);

      const startedAt = performance.now();
      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home);
      const elapsedMs = performance.now() - startedAt;

      // It completed (no `dsh_profile_overlay_publish_lock_timeout`), and it
      // broke the stale lock immediately instead of waiting out the 30s budget.
      assert.ok(
        elapsedMs < 5_000,
        `a crashed holder's lock must be broken at once, took ${elapsedMs}ms (budget ${PUBLISH_LOCK_TIMEOUT_MS}ms)`,
      );
      assert.equal(fs.readFileSync(hostArtifact, "utf8"), "crashed-holder\n");
      assert.equal(fs.existsSync(lockPath), false, "the broken lock path is removed, not left behind");
    });

    it("never breaks an UNREADABLE/indeterminate lock owner (bounded observation, never the 30s budget)", { timeout: 30_000 }, async () => {
      // The shipped probe only breaks a lock on POSITIVE proof (ESRCH). Anything
      // else — non-numeric, zero/negative, or a missing owner file — must be
      // treated as indeterminate and NEVER broken. This is asserted by a short
      // BOUNDED observation of a waiting publisher, not by a 30s timeout test.
      const plantedShapes: Array<{ label: string; ownerBytes: string | null }> = [
        { label: "non-numeric owner", ownerBytes: "not-a-pid\n" },
        { label: "non-positive owner", ownerBytes: "0\n" },
        { label: "missing owner file", ownerBytes: null },
      ];
      for (const shape of plantedShapes) {
        const home = makeDshHome();
        const live = mkTmp("live-state-publish-lock-indeterminate-");
        const overlay = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
        fs.mkdirSync(path.join(overlay, "sessions", "indeterminate"), { recursive: true });
        fs.writeFileSync(
          path.join(overlay, "sessions", "indeterminate", "x.jsonl"),
          `indeterminate:${shape.label}\n`,
          "utf8",
        );
        const hostArtifact = path.join(home, "sessions", "indeterminate", "x.jsonl");
        const lockPath = dshProfilePublishLockPath(live, home);
        const ownerPath = path.join(lockPath, "owner");
        plantPublishLock(lockPath, shape.ownerBytes);

        const worker = await startPublishWorker({ runId: RUN_ID, invocationId: INV_A, live, home });
        await worker.started;
        await new Promise((resolve) => setTimeout(resolve, 250));

        // A bounded window into the wait: the planted lock SURVIVED with its
        // exact bytes, and nothing was published through it.
        assert.equal(fs.existsSync(lockPath), true, `[${shape.label}] an indeterminate owner's lock is never broken`);
        if (shape.ownerBytes === null) {
          assert.equal(fs.existsSync(ownerPath), false, `[${shape.label}] no owner file may be invented`);
        } else {
          assert.equal(
            fs.readFileSync(ownerPath, "utf8"),
            shape.ownerBytes,
            `[${shape.label}] the planted owner bytes survive the aborted attempt`,
          );
        }
        assert.equal(
          fs.existsSync(hostArtifact),
          false,
          `[${shape.label}] nothing may be published while the lock stays unbroken`,
        );

        // Release the boundary: the publisher was WAITING, never breaking.
        fs.rmSync(lockPath, { recursive: true, force: true });
        const outcome = await worker.result;
        assert.equal(outcome.ok, true, `[${shape.label}] the waiting publisher must complete: ${JSON.stringify(outcome)}`);
        assert.equal(fs.readFileSync(hostArtifact, "utf8"), `indeterminate:${shape.label}\n`);
        assert.equal(fs.existsSync(lockPath), false, "the publication lock is released after publish");
      }
    });

    it("loses no artifact under EITHER teardown order (A-then-B and B-then-A; SIMULATED: no VM)", () => {
      // Two distinct invocations of ONE run, each with a UNIQUE artifact, are
      // finalized in both contradictory orders. Per-invocation teardown is the
      // controller's wire-confirmed-close order: publish THEN remove own root
      // (a cleanup-before-publish discards the artifact by design, so it is not
      // a "teardown order" — the crossed order is which INVOCATION goes first).
      for (const order of [[INV_A, INV_B], [INV_B, INV_A]] as const) {
        const home = makeDshHome();
        const live = mkTmp("live-state-teardown-order-");
        const overlayA = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
        const overlayB = prepareDshProfileOverlay(RUN_ID, INV_B, live, home).overlayRoot;
        fs.mkdirSync(path.join(overlayA, "sessions", "order-a"), { recursive: true });
        fs.writeFileSync(path.join(overlayA, "sessions", "order-a", "a.jsonl"), "A-unique\n", "utf8");
        fs.mkdirSync(path.join(overlayB, "sessions", "order-b"), { recursive: true });
        fs.writeFileSync(path.join(overlayB, "sessions", "order-b", "b.jsonl"), "B-unique\n", "utf8");

        for (const invocationId of order) {
          publishDshHomeOverlayToHost(RUN_ID, invocationId, live, home);
          cleanupDshProfileOverlay(RUN_ID, invocationId, live);
        }

        assert.equal(
          fs.readFileSync(path.join(home, "sessions", "order-a", "a.jsonl"), "utf8"),
          "A-unique\n",
          `[${order.join(" -> ")}] A's unique artifact must reach the host`,
        );
        assert.equal(
          fs.readFileSync(path.join(home, "sessions", "order-b", "b.jsonl"), "utf8"),
          "B-unique\n",
          `[${order.join(" -> ")}] B's unique artifact must reach the host`,
        );
        assert.equal(fs.existsSync(overlayA), false, `[${order.join(" -> ")}] A's invocation root is gone`);
        assert.equal(fs.existsSync(overlayB), false, `[${order.join(" -> ")}] B's invocation root is gone`);
        assert.equal(
          fs.existsSync(dshProfileInvocationGroupRoot(RUN_ID, live)),
          false,
          `[${order.join(" -> ")}] the emptied invocation grouping dir is pruned`,
        );
        assert.equal(fs.existsSync(dshProfilePublishLockPath(live, home)), false);
      }
    });

    it("loses no artifact when a CRASHED holder's lock is left behind under the reverse teardown order (SIMULATED: no VM)", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-teardown-order-crashed-holder-");
      const overlayA = prepareDshProfileOverlay(RUN_ID, INV_A, live, home).overlayRoot;
      const overlayB = prepareDshProfileOverlay(RUN_ID, INV_B, live, home).overlayRoot;
      fs.mkdirSync(path.join(overlayA, "sessions", "crash-a"), { recursive: true });
      fs.writeFileSync(path.join(overlayA, "sessions", "crash-a", "a.jsonl"), "A-after-crash\n", "utf8");
      fs.mkdirSync(path.join(overlayB, "sessions", "crash-b"), { recursive: true });
      fs.writeFileSync(path.join(overlayB, "sessions", "crash-b", "b.jsonl"), "B-after-crash\n", "utf8");
      const lockPath = dshProfilePublishLockPath(live, home);

      // A crashed holder died mid-publish BEFORE the first teardown: B (first in
      // the reversed order) must recover, and a SECOND crash left behind for A
      // must recover too — one break is not a lucky first-waiter path.
      plantPublishLock(lockPath, `${positivelyDeadPid()}\n`);
      publishDshHomeOverlayToHost(RUN_ID, INV_B, live, home);
      cleanupDshProfileOverlay(RUN_ID, INV_B, live);
      assert.equal(
        fs.readFileSync(path.join(home, "sessions", "crash-b", "b.jsonl"), "utf8"),
        "B-after-crash\n",
        "B's artifact must be published through the crashed holder's stale lock",
      );
      assert.equal(fs.existsSync(lockPath), false, "B's publish leaves no stale lock behind");

      plantPublishLock(lockPath, `${positivelyDeadPid()}\n`);
      publishDshHomeOverlayToHost(RUN_ID, INV_A, live, home);
      cleanupDshProfileOverlay(RUN_ID, INV_A, live);

      assert.equal(
        fs.readFileSync(path.join(home, "sessions", "crash-a", "a.jsonl"), "utf8"),
        "A-after-crash\n",
        "A's artifact must be published through the second crashed holder's stale lock",
      );
      assert.equal(fs.existsSync(overlayA), false, "A's invocation root is gone");
      assert.equal(fs.existsSync(overlayB), false, "B's invocation root is gone");
      assert.equal(
        fs.existsSync(dshProfileInvocationGroupRoot(RUN_ID, live)),
        false,
        "the emptied invocation grouping dir is pruned",
      );
      assert.equal(fs.existsSync(lockPath), false, "no stale lock is left behind");
    });
  });
});
