/**
 * dsh-home.test.ts — DSH-PROFILE-OVERLAY US-003.
 *
 * Presence-only snapshot/diff of the install-derived dsh profile module farm
 * (`<dshHome>/profiles/node_modules`) that `healProfilesModuleFallback`
 * re-points on every dsh boot. The helpers read metadata only (`lstat` /
 * `readlink`) and never file contents; a difference is evidence, never a
 * failure.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  dshProfileModuleLinksDiffer,
  snapshotDshProfileModuleLinks,
} from "../../../dist/installer/matchlock/dsh-home.js";

const tmpRoots: string[] = [];

function mkTmp(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Create a symlink or throw a skip-friendly error when the FS refuses. */
function symlink(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath);
}

describe("snapshotDshProfileModuleLinks", () => {
  it("returns an empty map for a missing farm and for an empty farm directory", () => {
    const missing = path.join(mkTmp("dsh-farm-missing-"), "no-such-home");
    assert.equal(snapshotDshProfileModuleLinks(missing).size, 0);

    const home = mkTmp("dsh-farm-empty-");
    fs.mkdirSync(path.join(home, "profiles", "node_modules"), { recursive: true });
    assert.equal(snapshotDshProfileModuleLinks(home).size, 0);
  });

  it("returns a stable, name-sorted name -> raw-target map for a fixture farm", () => {
    const home = mkTmp("dsh-farm-fixture-");
    const linksDir = path.join(home, "profiles", "node_modules");
    fs.mkdirSync(linksDir, { recursive: true });
    symlink("/opt/dsh/apps/cli/node_modules/chokidar", path.join(linksDir, "chokidar"));
    symlink("../../packages/relative-dep", path.join(linksDir, "relative-dep"));
    symlink("/opt/dsh/apps/cli/node_modules/@deepseek-ai/cordis", path.join(linksDir, "@deepseek-ai"));

    const first = snapshotDshProfileModuleLinks(home);
    assert.deepEqual(
      [...first.entries()],
      [
        ["@deepseek-ai", "/opt/dsh/apps/cli/node_modules/@deepseek-ai/cordis"],
        ["chokidar", "/opt/dsh/apps/cli/node_modules/chokidar"],
        ["relative-dep", "../../packages/relative-dep"],
      ],
      "raw symlink targets are preserved verbatim and names are sorted",
    );
    // Stable: a second snapshot of an unchanged farm is deep-equal.
    assert.deepEqual([...snapshotDshProfileModuleLinks(home).entries()], [...first.entries()]);
  });

  it("ignores non-symlink entries (real dirs/files) and dangling symlinks stay present", () => {
    const home = mkTmp("dsh-farm-nonsymlink-");
    const linksDir = path.join(home, "profiles", "node_modules");
    fs.mkdirSync(path.join(linksDir, "@scope"), { recursive: true });
    fs.writeFileSync(path.join(linksDir, "plain.txt"), "not a link\n");
    symlink("/opt/dsh/apps/cli/node_modules/kept", path.join(linksDir, "kept"));
    symlink("/does/not/exist/anywhere", path.join(linksDir, "dangling"));

    const snapshot = snapshotDshProfileModuleLinks(home);
    assert.deepEqual([...snapshot.keys()], ["dangling", "kept"]);
    assert.equal(snapshot.get("dangling"), "/does/not/exist/anywhere");
    assert.equal(snapshot.has("plain.txt"), false);
    assert.equal(snapshot.has("@scope"), false);
  });

  it("only snapshots the top-level profiles/node_modules farm (never nested install dirs)", () => {
    const home = mkTmp("dsh-farm-nested-");
    const top = path.join(home, "profiles", "node_modules");
    const nested = path.join(home, "profiles", "headless", "node_modules");
    fs.mkdirSync(top, { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    symlink("/opt/dsh/top-dep", path.join(top, "top-dep"));
    symlink("/opt/dsh/nested-dep", path.join(nested, "nested-dep"));

    const snapshot = snapshotDshProfileModuleLinks(home);
    assert.deepEqual([...snapshot.keys()], ["top-dep"]);
  });

  it("never reads file contents (targets only)", () => {
    const home = mkTmp("dsh-farm-secret-");
    const linksDir = path.join(home, "profiles", "node_modules");
    fs.mkdirSync(linksDir, { recursive: true });
    const secretTarget = "/opt/dsh/apps/cli/node_modules/secret-pkg";
    symlink(secretTarget, path.join(linksDir, "secret-pkg"));
    const snapshot = snapshotDshProfileModuleLinks(home);
    assert.equal(snapshot.get("secret-pkg"), secretTarget);
    assert.equal(JSON.stringify([...snapshot.entries()]).includes("secret-value-that-must-not-leak"), false);
  });
});

describe("dshProfileModuleLinksDiffer", () => {
  function snap(entries: Array<[string, string]>): Map<string, string> {
    return new Map(entries);
  }

  it("reports no difference for identical snapshots", () => {
    const before = snap([
      ["a", "/install/a"],
      ["b", "/install/b"],
    ]);
    const diff = dshProfileModuleLinksDiffer(before, snap([...before.entries()]));
    assert.deepEqual(diff, { added: [], removed: [], retargeted: [] });
  });

  it("detects added, removed and retargeted links (each list sorted)", () => {
    const before = snap([
      ["zeta", "/old/zeta"],
      ["alpha", "/install/alpha"],
      ["gone-b", "/install/gone-b"],
      ["gone-a", "/install/gone-a"],
      ["retarget-b", "/install/b"],
      ["retarget-a", "/install/a"],
    ]);
    const after = snap([
      ["zeta", "/new/zeta"],
      ["alpha", "/install/alpha"],
      ["retarget-b", "/install/b2"],
      ["retarget-a", "/install/a2"],
      ["new-b", "/install/new-b"],
      ["new-a", "/install/new-a"],
    ]);
    const diff = dshProfileModuleLinksDiffer(before, after);
    assert.deepEqual(diff.added, ["new-a", "new-b"]);
    assert.deepEqual(diff.removed, ["gone-a", "gone-b"]);
    assert.deepEqual(diff.retargeted, ["retarget-a", "retarget-b", "zeta"]);
  });

  it("treats a name as retargeted (not added+removed) when it survives", () => {
    const diff = dshProfileModuleLinksDiffer(snap([["x", "/one"]]), snap([["x", "/two"]]));
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.retargeted, ["x"]);
  });

  it("handles empty snapshots on either side", () => {
    const full = snap([["a", "/install/a"]]);
    assert.deepEqual(dshProfileModuleLinksDiffer(new Map(), full), {
      added: ["a"],
      removed: [],
      retargeted: [],
    });
    assert.deepEqual(dshProfileModuleLinksDiffer(full, new Map()), {
      added: [],
      removed: ["a"],
      retargeted: [],
    });
    assert.deepEqual(dshProfileModuleLinksDiffer(new Map(), new Map()), {
      added: [],
      removed: [],
      retargeted: [],
    });
  });
});
