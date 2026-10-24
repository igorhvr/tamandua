/**
 * Fast, deterministic controls for the composed-DSH_HOME gate fixtures
 * (e2e-tests/helpers/matchlock-dsh-gate-fixtures.ts), DSH-PROFILE-OVERLAY
 * US-004. No real VM, no daemon, no child process, no live state: every
 * fixture lives in a tamanduaTempDir scratch root.
 *
 * These assertions pin the two properties the real-VM dsh gate depends on:
 *  1. the synthetic home pre-creates exactly the per-entry mounts the composed
 *     plan places (durable entries + the install-derived dirs); and
 *  2. the private-overlay observer records only what appears while a round is
 *     live (a private farm the guest populates), never a fabricated farm.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  dshProfileOverlayRoot,
  planDshHomeMounts,
  prepareDshProfileOverlay,
} from "../dist/installer/matchlock/dsh-profile-overlay.js";
import {
  DSH_GATE_BOOT_LOCK_BASENAME,
  DSH_GATE_MISMATCHED_FARM_LINKS,
  DshOverlayObserver,
  prepareComposedDshHome,
  snapshotDshFarmLinks,
  snapshotDshTreeDirs,
  snapshotDshTreeLinks,
  invocationRoots,
} from "../e2e-tests/helpers/matchlock-dsh-gate-fixtures.ts";

describe("matchlock dsh gate composed-home fixtures (DSH-PROFILE-OVERLAY US-004)", () => {
  let root = "";

  before(() => {
    root = tamanduaTempDir("mtlk-dsh-gate-fixtures-");
  });

  after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* owned scratch */
    }
  });

  it("pre-creates every durable entry the composed plan mounts per-entry", () => {
    const home = path.join(root, "durable-home");
    const layout = prepareComposedDshHome(home);

    for (const entry of layout.durableEntries) {
      const abs = path.join(home, entry);
      const st = fs.lstatSync(abs);
      assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${entry} must be a real directory`);
    }
    assert.ok(fs.lstatSync(path.join(home, ".credentials.yaml")).isFile());

    const profileDir = path.join(home, "profiles", layout.profile);
    for (const file of ["package.json", "cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml"]) {
      assert.ok(fs.existsSync(path.join(profileDir, file)), `${file} must exist for the per-entry mount`);
    }
  });

  it("pre-creates the install-derived dirs and seeds the mismatched host farm links", () => {
    const home = path.join(root, "farm-home");
    const layout = prepareComposedDshHome(home);

    assert.deepEqual(layout.installDerivedDirs, [
      path.join("profiles", "node_modules"),
      path.join("profiles", layout.profile, "node_modules"),
      path.join("profiles", layout.profile, ".dsh-module-fallback"),
    ]);
    for (const rel of layout.installDerivedDirs) {
      const st = fs.lstatSync(path.join(home, rel));
      assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${rel} must be a real directory`);
    }

    const sharedFarm = path.join(home, "profiles", "node_modules");
    assert.deepEqual(snapshotDshFarmLinks(sharedFarm), {
      commander: "/opt/dsh/apps/cli/node_modules/commander",
      undici: "/nonexistent-install/node_modules/undici",
    });
    assert.deepEqual({ ...DSH_GATE_MISMATCHED_FARM_LINKS }, snapshotDshFarmLinks(sharedFarm));
  });

  it("prepareComposedDshHome is idempotent and re-seeds the farm links", () => {
    const home = path.join(root, "idempotent-home");
    prepareComposedDshHome(home);
    const sharedFarm = path.join(home, "profiles", "node_modules");
    // Replace a link with a real file, then re-prepare: the fixture must restore
    // the mismatched symlink (never leave a non-symlink farm entry behind).
    fs.rmSync(path.join(sharedFarm, "commander"));
    fs.writeFileSync(path.join(sharedFarm, "commander"), "not a link\n", "utf-8");
    prepareComposedDshHome(home);
    const snapshot = snapshotDshFarmLinks(sharedFarm);
    assert.deepEqual(snapshot, {
      commander: "/opt/dsh/apps/cli/node_modules/commander",
      undici: "/nonexistent-install/node_modules/undici",
    });
  });

  it("the composed plan mounts ONE real effective-home root from the private overlay and never the host profile tree (so a guest profile marker cannot persist on the host)", () => {
    const home = path.join(root, "plan-home");
    prepareComposedDshHome(home);
    const liveState = tamanduaTempDir("mtlk-dsh-gate-lived-");
    const runId = "11111111-2222-3333-4444-555555555555";
    const guestRoot = "/workspace/config/dsh";
    try {
      prepareDshProfileOverlay(runId, "inv-aaaaaaaa-11111111", liveState, home);
      const overlayRoot = dshProfileOverlayRoot(runId, "inv-aaaaaaaa-11111111", liveState);
      const mounts = planDshHomeMounts(home, overlayRoot, guestRoot);

      // Exactly ONE destination: the whole effective home at the guest root,
      // sourced from the private per-run overlay (a real host-backed directory
      // whose own fd is fsync-able). The host home is never the source.
      assert.deepEqual(Object.keys(mounts), [guestRoot]);
      assert.equal(mounts[guestRoot]?.host_path, overlayRoot);
      assert.notEqual(mounts[guestRoot]?.host_path, home);
      assert.equal(mounts[guestRoot]?.readonly, false);

      // The private profiles copy inside the effective home is the ONLY
      // profiles source (the guest creates profiles/node_modules.lock there),
      // and a per-session `.gate-profile-*` marker can never reach the host
      // because publish skips profiles/.
      assert.ok(fs.lstatSync(path.join(overlayRoot, "profiles")).isDirectory());
      for (const dir of [
        path.posix.join(guestRoot, "profiles"),
        path.posix.join(guestRoot, "profiles", "headless"),
        path.posix.join(guestRoot, "profiles", "node_modules"),
        path.posix.join(guestRoot, "profiles", "headless", "node_modules"),
        path.posix.join(guestRoot, "profiles", "headless", ".dsh-module-fallback"),
      ]) {
        assert.equal(mounts[dir], undefined, `${dir} must never be its own destination`);
      }

      // The durable profile config files are staged in the private overlay tree
      // (never host-mapped).
      for (const file of ["package.json", "cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml"]) {
        assert.ok(
          fs.existsSync(path.join(overlayRoot, "profiles", "headless", file)),
          `${file} must be staged in the private overlay`,
        );
      }

      // Every whole-directory durable category is materialized in the effective
      // home (the gate's persistence case counts these).
      for (const dir of ["sessions", "storages", "credentials", ".gate-unknown-entries"]) {
        assert.ok(
          fs.lstatSync(path.join(overlayRoot, dir)).isDirectory(),
          `${dir} must be staged as a real directory in the effective home`,
        );
      }
      assert.ok(fs.lstatSync(path.join(overlayRoot, ".credentials.yaml")).isFile());

      // No mount ever exposes the host profile tree or its install-derived farm.
      for (const rel of [
        "profiles",
        "profiles/node_modules",
        "profiles/headless/node_modules",
        "profiles/headless/.dsh-module-fallback",
      ]) {
        assert.notEqual(
          path.join(overlayRoot, rel),
          path.join(home, rel),
          `${rel} must not expose the host source`,
        );
      }
    } finally {
      fs.rmSync(liveState, { recursive: true, force: true });
    }
  });

  it("snapshotDshFarmLinks reads direct symlinks only and ignores real files/dirs", () => {
    const dir = path.join(root, "snapshot-home");
    fs.mkdirSync(path.join(dir, "real-dir"), { recursive: true });
    fs.writeFileSync(path.join(dir, "real-file"), "x\n", "utf-8");
    fs.symlinkSync("/guest/install/a", path.join(dir, "a"));
    fs.symlinkSync("/guest/install/b", path.join(dir, "b"));
    assert.deepEqual(snapshotDshFarmLinks(dir), {
      a: "/guest/install/a",
      b: "/guest/install/b",
    });
    assert.deepEqual(snapshotDshFarmLinks(path.join(dir, "missing")), {});
  });

  it("snapshotDshTreeLinks captures nested symlinks relative to the root without following them", () => {
    const dir = path.join(root, "tree-home");
    fs.mkdirSync(path.join(dir, "profiles", "node_modules"), { recursive: true });
    fs.symlinkSync("/opt/dsh/a", path.join(dir, "profiles", "node_modules", "a"));
    fs.writeFileSync(path.join(dir, "profiles", "config.yml"), "[]\n", "utf-8");
    assert.deepEqual(snapshotDshTreeLinks(dir), {
      [path.join("profiles", "node_modules", "a")]: "/opt/dsh/a",
    });
    assert.deepEqual(snapshotDshTreeDirs(dir), [
      "profiles",
      path.join("profiles", "node_modules"),
    ]);
  });

  it("the private-overlay observer sees the per-round farm and the guest-install links in it", async () => {
    const overlay = path.join(root, "watched-overlay");
    const observer = new DshOverlayObserver(overlay, { intervalMs: 5 }).start();
    // Simulate the controller creating the private overlay root and the guest
    // populating the install-derived farm with GUEST-install links.
    await new Promise((resolve) => setTimeout(resolve, 25));
    fs.mkdirSync(path.join(overlay, "profiles", "node_modules"), { recursive: true });
    fs.symlinkSync(
      "/opt/dsh/apps/cli/node_modules/commander",
      path.join(overlay, "profiles", "node_modules", "commander"),
    );
    // A transient regular file (the real boot writer lock shape): the observer
    // must retain it even after it is removed. The lock is the SIBLING
    // `<profiles>/node_modules.lock` (`DSH_GATE_BOOT_LOCK_BASENAME`), never a
    // child of the mounted `node_modules` destination.
    const profilesDir = path.join(overlay, "profiles");
    const transientLock = path.join(profilesDir, DSH_GATE_BOOT_LOCK_BASENAME);
    fs.writeFileSync(transientLock, "", "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 40));
    fs.rmSync(transientLock, { force: true });
    const observed = observer.stop();
    assert.equal(observed.rootSeen, true, "the private overlay root must be observed while live");
    assert.deepEqual(observed.links, {
      [path.join("profiles", "node_modules", "commander")]:
        "/opt/dsh/apps/cli/node_modules/commander",
    });
    assert.ok(
      observed.dirs.includes(path.join("profiles", "node_modules")),
      `the private install-derived dir must be observed: ${JSON.stringify(observed.dirs)}`,
    );
    const siblingLockRel = path.join("profiles", DSH_GATE_BOOT_LOCK_BASENAME);
    assert.ok(
      observed.files.includes(siblingLockRel),
      `the transient boot lock must be retained at the exact sibling path ${siblingLockRel}: ${JSON.stringify(observed.files)}`,
    );
    assert.ok(
      !observed.files.includes(path.join("profiles", "node_modules", DSH_GATE_BOOT_LOCK_BASENAME)),
      `the boot lock must never be observed inside the node_modules destination: ${JSON.stringify(observed.files)}`,
    );
  });

  it("the private-overlay observer never fabricates a farm that never appeared", () => {
    const observer = new DshOverlayObserver(path.join(root, "never-created"), { intervalMs: 5 }).start();
    const observed = observer.stop();
    assert.equal(observed.rootSeen, false);
    assert.deepEqual(observed.links, {});
    // OVERLAY-INV-SCOPED: the default single-root mode records no invocation
    // dirs at all (the field is additive and always present).
    assert.deepEqual(observed.invocationDirs, []);
  });

  // ── OVERLAY-INV-SCOPED: per-run invocation grouping dir ────────────────
  //
  // The overlay leaf is now bound to a host-generated invocation id a live
  // gate cannot predict, so the observer can be pointed at the per-run
  // grouping dir (`dshProfileInvocationGroupRoot`) and told to sample every
  // immediate invocation subdirectory. SIMULATED: these controls create plain
  // directories with no VM, no daemon and no dsh process.

  it("group-dir observer samples an invocation root created AFTER start() and reports paths relative to it", async () => {
    const group = path.join(root, "inv-group-late");
    // The grouping dir itself does not exist at start(): the controller creates
    // it (and the invocation leaf) only once the round is dispatched.
    const observer = new DshOverlayObserver(group, {
      intervalMs: 5,
      invocationGroupDir: true,
    }).start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const invocationRoot = path.join(group, "inv-bbbbbbbb-99999999");
      fs.mkdirSync(path.join(invocationRoot, "profiles", "node_modules"), {
        recursive: true,
      });
      fs.symlinkSync(
        "/opt/synthetic-guest-install/node_modules/commander",
        path.join(invocationRoot, "profiles", "node_modules", "commander"),
      );
      fs.writeFileSync(
        path.join(invocationRoot, "profiles", DSH_GATE_BOOT_LOCK_BASENAME),
        "",
        "utf-8",
      );
      // Give the interval sampler more than one tick to see the new root.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const observed = observer.stop();

      assert.equal(observed.rootSeen, true, "the late-created invocation root must be observed");
      assert.deepEqual(observed.invocationDirs, ["inv-bbbbbbbb-99999999"]);
      // Paths are RELATIVE to the invocation root, never prefixed by it.
      assert.deepEqual(observed.links, {
        [path.join("profiles", "node_modules", "commander")]:
          "/opt/synthetic-guest-install/node_modules/commander",
      });
      assert.ok(
        observed.files.includes(path.join("profiles", DSH_GATE_BOOT_LOCK_BASENAME)),
        `the invocation-relative boot lock must be observed: ${JSON.stringify(observed.files)}`,
      );
      assert.ok(
        observed.dirs.includes(path.join("profiles", "node_modules")),
        `the invocation-relative dirs must be observed: ${JSON.stringify(observed.dirs)}`,
      );
    } finally {
      observer.stop();
    }
  });

  it("group-dir observer never treats a .prepare.json sibling or a symlink entry as an invocation root", async () => {
    const group = path.join(root, "inv-group-siblings");
    fs.mkdirSync(group, { recursive: true });
    // The R3 publish manifest is a FILE sibling of the invocation dirs.
    fs.writeFileSync(path.join(group, "inv-dddddddd.prepare.json"), "{}\n", "utf-8");
    // A symlink entry that happens to point at a real directory is still not
    // an invocation root (the controller never creates one).
    const target = path.join(root, "symlink-target-inv");
    fs.mkdirSync(path.join(target, "profiles"), { recursive: true });
    fs.symlinkSync(target, path.join(group, "inv-eeeeeeee-symlink"));

    const observer = new DshOverlayObserver(group, {
      intervalMs: 5,
      invocationGroupDir: true,
    }).start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const observed = observer.stop();
      assert.equal(observed.rootSeen, false, "no real invocation dir exists yet");
      assert.deepEqual(observed.invocationDirs, []);
      assert.deepEqual(observed.links, {});
      assert.deepEqual(observed.dirs, []);
    } finally {
      observer.stop();
    }

    // Now add ONE real invocation dir alongside them: only that one is sampled.
    const realInvocation = path.join(group, "inv-ffffffff-real");
    fs.mkdirSync(path.join(realInvocation, "profiles"), { recursive: true });
    fs.symlinkSync("/guest/a", path.join(realInvocation, "profiles", "a"));
    const second = new DshOverlayObserver(group, {
      intervalMs: 5,
      invocationGroupDir: true,
    }).start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const observed = second.stop();
      assert.equal(observed.rootSeen, true);
      assert.deepEqual(observed.invocationDirs, ["inv-ffffffff-real"]);
      assert.deepEqual(observed.links, { [path.join("profiles", "a")]: "/guest/a" });
    } finally {
      second.stop();
    }
  });

  it("invocationRoots returns only real immediate invocation directories and ignores .prepare.json manifest siblings", () => {
    // OVERLAY-INV-SCOPED US-005: the live gates reason about teardown order via
    // this helper, so it must agree with the observer exactly: only REAL
    // immediate subdirectories under the per-run grouping dir are invocation
    // roots. The R3 publish manifest (`<invocationId>.prepare.json`) is a file
    // sibling, and a symlink or regular file entry is never a root.
    const group = path.join(root, "inv-roots-group");
    assert.deepEqual(invocationRoots(group), [], "a missing grouping dir must yield [] (never throw)");

    fs.mkdirSync(path.join(group, "inv-00000002-two", "profiles"), { recursive: true });
    fs.mkdirSync(path.join(group, "inv-00000001-one", "profiles"), { recursive: true });
    fs.writeFileSync(path.join(group, "inv-00000001-one.prepare.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(group, "stray-file"), "x\n", "utf-8");
    const symlinkTarget = path.join(root, "inv-roots-symlink-target");
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.symlinkSync(symlinkTarget, path.join(group, "inv-00000003-symlink"));
    // A DANGLING symlink must not throw (the lstat check is authoritative).
    fs.symlinkSync(path.join(root, "nowhere-at-all"), path.join(group, "inv-00000004-dangling"));

    assert.deepEqual(
      invocationRoots(group),
      [
        path.join(group, "inv-00000001-one"),
        path.join(group, "inv-00000002-two"),
      ],
      "only real immediate invocation dirs, sorted, with no .prepare.json/file/symlink entry",
    );

    // Removing one root shrinks the set (the helper reads live fs state).
    fs.rmSync(path.join(group, "inv-00000001-one"), { recursive: true, force: true });
    assert.deepEqual(invocationRoots(group), [path.join(group, "inv-00000002-two")]);
  });

  it("group-dir observer stop() ends sampling", async () => {
    const group = path.join(root, "inv-group-stop");
    const firstInvocation = path.join(group, "inv-11111111-one");
    fs.mkdirSync(path.join(firstInvocation, "profiles"), { recursive: true });
    fs.symlinkSync("/guest/one", path.join(firstInvocation, "profiles", "one"));

    const observer = new DshOverlayObserver(group, {
      intervalMs: 5,
      invocationGroupDir: true,
    }).start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stopped = observer.stop();
    assert.deepEqual(stopped.invocationDirs, ["inv-11111111-one"]);

    // Anything appearing after stop() must never be sampled again.
    const lateInvocation = path.join(group, "inv-22222222-two");
    fs.mkdirSync(path.join(lateInvocation, "profiles"), { recursive: true });
    fs.symlinkSync("/guest/two", path.join(lateInvocation, "profiles", "two"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const afterStop = observer.stop();
    assert.equal(afterStop.ticks, stopped.ticks, "stop() must freeze the tick count");
    assert.deepEqual(afterStop.invocationDirs, ["inv-11111111-one"]);
    assert.equal(
      Object.keys(afterStop.links).includes(path.join("profiles", "two")),
      false,
      "a post-stop invocation must never be observed",
    );
  });

  it("default observer mode samples only its single root and does not treat children as invocation roots", async () => {
    const group = path.join(root, "inv-group-default");
    const invocation = path.join(group, "inv-33333333-child");
    fs.mkdirSync(path.join(invocation, "profiles"), { recursive: true });
    fs.symlinkSync("/guest/child", path.join(invocation, "profiles", "child"));

    const observer = new DshOverlayObserver(group, { intervalMs: 5 }).start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const observed = observer.stop();
      assert.equal(observed.rootSeen, true);
      assert.deepEqual(observed.invocationDirs, []);
      // The default mode walks the given root as ONE tree: the child keeps its
      // prefix instead of being sampled as its own root.
      assert.deepEqual(observed.links, {
        [path.join("inv-33333333-child", "profiles", "child")]: "/guest/child",
      });
    } finally {
      observer.stop();
    }
  });
});
