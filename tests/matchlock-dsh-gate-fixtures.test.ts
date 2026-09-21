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
      prepareDshProfileOverlay(runId, liveState, home);
      const overlayRoot = dshProfileOverlayRoot(runId, liveState);
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
  });
});
