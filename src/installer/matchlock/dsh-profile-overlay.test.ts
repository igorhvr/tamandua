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
  assertDshOverlayRunId,
  cleanupDshProfileOverlay,
  discoverDshInstallDerivedDirs,
  dshProfileOverlayRoot,
  isDshProfileOverlayRootShape,
  isHostAttestedDshProfileOverlay,
  planDshHomeMounts,
  prepareDshProfileOverlay,
  publishDshHomeOverlayToHost,
} from "../../../dist/installer/matchlock/dsh-profile-overlay.js";

const RUN_ID = "11111111-2222-3333-4444-555555555555";
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
function preparedOverlay(home: string, runId = RUN_ID): { live: string; overlay: string } {
  const live = mkTmp("live-state-");
  prepareDshProfileOverlay(runId, live, home);
  return { live, overlay: dshProfileOverlayRoot(runId, live) };
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
    it("derives <liveState>/matchlock/dsh-profile-overlays/<bareRunId> (run- prefix stripped)", () => {
      const live = "/tmp/live-state-example";
      assert.equal(
        dshProfileOverlayRoot(RUN_ID, live),
        path.join(live, "matchlock", "dsh-profile-overlays", RUN_ID),
      );
      assert.equal(
        dshProfileOverlayRoot(`run-${RUN_ID}`, live),
        path.join(live, "matchlock", "dsh-profile-overlays", RUN_ID),
      );
    });

    it("refuses a malformed run id with a typed error", () => {
      for (const bad of ["", "not-a-uuid", "../../escape", 42 as unknown as string]) {
        assert.throws(
          () => dshProfileOverlayRoot(bad, "/tmp/live"),
          (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_run_id",
        );
      }
      assert.throws(
        () => assertDshOverlayRunId("xyz"),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_run_id",
      );
    });

    it("attests exactly one overlay root and fails closed for any other path", () => {
      const live = "/tmp/live-state-example";
      const root = dshProfileOverlayRoot(RUN_ID, live);
      assert.equal(isHostAttestedDshProfileOverlay(root, RUN_ID, live), true);
      assert.equal(isHostAttestedDshProfileOverlay(`${root}-sibling`, RUN_ID, live), false);
      assert.equal(isHostAttestedDshProfileOverlay("/tmp/elsewhere", RUN_ID, live), false);
      assert.equal(isHostAttestedDshProfileOverlay(root, "99999999-...", live), false);
      assert.equal(isDshProfileOverlayRootShape(root), true);
      assert.equal(isDshProfileOverlayRootShape("/tmp/live/matchlock/other/abc"), false);
      assert.equal(isDshProfileOverlayRootShape(path.join(live, "runs", RUN_ID)), false);
    });
  });

  // ── prepare ────────────────────────────────────────────────────────
  describe("prepareDshProfileOverlay", () => {
    it("creates a real private dir per install-derived path, idempotently", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-");
      const first = prepareDshProfileOverlay(RUN_ID, live, home);
      assert.equal(first.runId, RUN_ID);
      assert.equal(first.overlayRoot, dshProfileOverlayRoot(RUN_ID, live));
      assert.deepEqual(first.relPaths, discoverDshInstallDerivedDirs(home));
      for (const rel of first.relPaths) {
        const st = fs.lstatSync(path.join(first.overlayRoot, rel));
        assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${rel} must be a real directory`);
      }
      // Idempotent: a second prepare succeeds and creates nothing new/linking out.
      const second = prepareDshProfileOverlay(RUN_ID, live, home);
      assert.deepEqual(second.relPaths, first.relPaths);
      assert.ok(fs.lstatSync(second.overlayRoot).isDirectory());
    });

    it("refuses a symlinked matchlock parent (never writes through it)", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-symlink-matchlock-");
      const target = mkTmp("symlink-target-");
      fs.symlinkSync(target, path.join(live, "matchlock"));
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, live, home),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
      assert.deepEqual(fs.readdirSync(target), [], "nothing may be created through a symlinked parent");
    });

    it("refuses a symlinked overlays parent and a symlinked run root", () => {
      const home = makeDshHome();
      const liveA = mkTmp("live-state-symlink-overlays-");
      fs.mkdirSync(path.join(liveA, "matchlock"), { recursive: true });
      const target = mkTmp("symlink-target-overlays-");
      fs.symlinkSync(target, path.join(liveA, "matchlock", "dsh-profile-overlays"));
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, liveA, home),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );

      const liveB = mkTmp("live-state-symlink-root-");
      fs.mkdirSync(path.join(liveB, "matchlock", "dsh-profile-overlays"), { recursive: true });
      const escape = mkTmp("symlink-target-root-");
      fs.symlinkSync(escape, dshProfileOverlayRoot(RUN_ID, liveB));
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, liveB, home),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
      assert.deepEqual(fs.readdirSync(escape), [], "nothing may be created through a symlinked run root");
    });

    it("stages a private byte-identical copy of the host profiles tree", () => {
      const home = makeDshHome();
      const hostBefore = snapshotTree(home);
      const live = mkTmp("live-state-stage-");
      const layout = prepareDshProfileOverlay(RUN_ID, live, home);
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
      const layout = prepareDshProfileOverlay(RUN_ID, live, home);
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
        () => prepareDshProfileOverlay(RUN_ID, live, home),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_source_symlink",
      );
      // Nothing was taken through the symlink.
      assert.deepEqual(fs.readdirSync(outside), ["secret.txt"]);
      assert.equal(
        fs.existsSync(path.join(dshProfileOverlayRoot(RUN_ID, live), "profiles", "headless", "linked-outside")),
        false,
      );
    });

    it("is idempotent, repairs staged content, and never writes through an overlay symlink", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-repair-");
      const first = prepareDshProfileOverlay(RUN_ID, live, home);
      const stagedCordis = path.join(first.overlayRoot, "profiles", "headless", "cordis.yml");
      const hostCordis = path.join(home, "profiles", "headless", "cordis.yml");

      // Delete a staged file: a second prepare repairs it byte-identically.
      fs.rmSync(stagedCordis);
      prepareDshProfileOverlay(RUN_ID, live, home);
      assert.equal(fs.readFileSync(stagedCordis, "utf8"), fs.readFileSync(hostCordis, "utf8"));

      // Corrupt a staged file: a second prepare restores the host content.
      fs.writeFileSync(stagedCordis, "corrupted\n", "utf8");
      prepareDshProfileOverlay(RUN_ID, live, home);
      assert.equal(fs.readFileSync(stagedCordis, "utf8"), fs.readFileSync(hostCordis, "utf8"));

      // A symlink planted at a staged destination must never be followed.
      const escape = mkTmp("overlay-escape-target-");
      fs.writeFileSync(path.join(escape, "sentinel.txt"), "keep\n", "utf8");
      fs.rmSync(stagedCordis);
      fs.symlinkSync(path.join(escape, "sentinel.txt"), stagedCordis);
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, live, home),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
      assert.equal(
        fs.readFileSync(path.join(escape, "sentinel.txt"), "utf8"),
        "keep\n",
        "the symlink target must be untouched",
      );

      // A symlinked staged directory is also refused, not followed.
      const profilesDir = path.join(first.overlayRoot, "profiles");
      const headless = path.join(profilesDir, "headless");
      fs.rmSync(headless, { recursive: true, force: true });
      fs.symlinkSync(escape, headless);
      assert.throws(
        () => prepareDshProfileOverlay(RUN_ID, live, home),
        (e: unknown) =>
          e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
      assert.deepEqual(fs.readdirSync(escape), ["sentinel.txt"]);
    });
  });

  // ── cleanup ────────────────────────────────────────────────────────
  describe("cleanupDshProfileOverlay", () => {
    it("removes exactly the attested run root and is idempotent", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-cleanup-");
      const { overlayRoot, relPaths } = prepareDshProfileOverlay(RUN_ID, live, home);
      assert.ok(relPaths.length > 0);
      const sibling = path.join(live, "matchlock", "dsh-profile-overlays", "keep-me");
      fs.mkdirSync(sibling, { recursive: true });
      cleanupDshProfileOverlay(RUN_ID, live);
      assert.equal(fs.existsSync(overlayRoot), false);
      assert.equal(fs.existsSync(sibling), true, "sibling roots must be untouched");
      assert.equal(
        fs.existsSync(path.join(live, "matchlock", "dsh-profile-overlays")),
        true,
        "the parent overlays dir is retained",
      );
      cleanupDshProfileOverlay(RUN_ID, live); // idempotent
    });

    it("refuses a symlinked run root and never removes its target", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-cleanup-symlink-");
      prepareDshProfileOverlay(RUN_ID, live, home);
      const root = dshProfileOverlayRoot(RUN_ID, live);
      fs.rmSync(root, { recursive: true, force: true });
      const target = mkTmp("cleanup-target-");
      fs.writeFileSync(path.join(target, "sentinel"), "keep\n", "utf8");
      fs.symlinkSync(target, root);
      assert.throws(
        () => cleanupDshProfileOverlay(RUN_ID, live),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
      assert.equal(fs.existsSync(path.join(target, "sentinel")), true, "symlink target must survive");
    });

    it("refuses a malformed run id", () => {
      assert.throws(
        () => cleanupDshProfileOverlay("nope", "/tmp/live"),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_run_id",
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
      const { overlayRoot } = prepareDshProfileOverlay(RUN_ID, live, home);
      planDshHomeMounts(home, overlayRoot, GUEST_ROOT);
      assert.deepEqual(snapshotTree(home), hostBefore, "prepare + plan must never modify the host home");
    });

    it("refuses a missing staged private profiles directory", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-missing-overlay-");
      const overlay = dshProfileOverlayRoot(RUN_ID, live);
      fs.mkdirSync(overlay, { recursive: true }); // attested shape, but profiles/ not staged
      assert.throws(
        () => planDshHomeMounts(home, overlay, GUEST_ROOT),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_source_missing",
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
        () => prepareDshProfileOverlay(RUN_ID, mkTmp("live-state-symlink-top-"), home),
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
        () => prepareDshProfileOverlay(RUN_ID, mkTmp("live-state-inner-link-"), home2),
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

      publishDshHomeOverlayToHost(RUN_ID, live, home);

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
      publishDshHomeOverlayToHost(RUN_ID, live, home);
      publishDshHomeOverlayToHost(RUN_ID, live, home); // idempotent
      assert.equal(fs.lstatSync(hostCred).ino, hostIno, "an unchanged hard-linked file is not rewritten");
      assert.equal(fs.readFileSync(hostCred, "utf8"), fs.readFileSync(overlayCred, "utf8"));
    });

    it("refuses a symlinked overlay root and is a no-op for an absent one", () => {
      const home = makeDshHome();
      const live = mkTmp("live-state-publish-foreign-");
      // Absent attested root: nothing to publish, no throw.
      publishDshHomeOverlayToHost(RUN_ID, live, home);
      // A symlink at the attested root is refused, never followed.
      const root = dshProfileOverlayRoot(RUN_ID, live);
      fs.mkdirSync(path.dirname(root), { recursive: true });
      const target = mkTmp("publish-escape-");
      fs.symlinkSync(target, root);
      assert.throws(
        () => publishDshHomeOverlayToHost(RUN_ID, live, home),
        (e: unknown) => e instanceof DshProfileOverlayError && e.code === "dsh_profile_overlay_foreign_root",
      );
      assert.deepEqual(fs.readdirSync(target), []);
    });
  });
});
