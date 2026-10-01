/**
 * Regression tests for the pure hermes launcher-chain resolver
 * (`src/lib/hermes-launcher-snapshot.ts`).
 *
 * These tests build FAKE launcher trees under `tamanduaTempDir(...)` and never
 * touch the operator's real `~/.hermes`. The discriminating case is the exec
 * SHIM shape: a shim in dir A execs a real launcher file in dir B, so a
 * realpath-only resolver (which does not follow `exec` targets) misses dir B.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  resolveRealHermesRoot,
  resolveLauncherChain,
  snapshotLaunchers,
  restoreLaunchers,
  verifyLaunchers,
} from "../src/lib/hermes-launcher-snapshot.ts";

const created: string[] = [];

function tmp(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** Create parent dirs and write a file (default mode 0o644). */
function write(p: string, content: string, mode = 0o644): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode });
  return p;
}

/** A two-line shell exec shim, mirroring the observed macOS launcher shape. */
function shim(execTarget: string): string {
  return `#!/bin/sh\nexec ${execTarget} "$@"\n`;
}

/** Canonicalize an expected path so /tmp vs /private/tmp never flakes. */
function real(p: string): string {
  return fs.realpathSync(p);
}

describe("hermes launcher chain resolver", () => {
  it("resolveRealHermesRoot follows the .hermes symlink and reports absolute/exists", () => {
    const root = tmp("hc-root-");
    const realHome = path.join(root, "real-home");
    fs.mkdirSync(realHome, { recursive: true });
    const tempHome = path.join(root, "temp-home");
    fs.mkdirSync(tempHome, { recursive: true });
    fs.symlinkSync(realHome, path.join(tempHome, ".hermes"));

    const res = resolveRealHermesRoot(tempHome);
    assert.equal(res.root, real(realHome));
    assert.equal(res.absolute, true);
    assert.equal(res.exists, true);
    assert.equal(res.hops, 1);
    assert.ok(res.reasons.length > 0);
  });

  it("resolveRealHermesRoot accepts a plain .hermes directory", () => {
    const root = tmp("hc-plain-");
    const tempHome = path.join(root, "temp-home");
    fs.mkdirSync(path.join(tempHome, ".hermes"), { recursive: true });

    const res = resolveRealHermesRoot(tempHome);
    assert.equal(res.root, real(path.join(tempHome, ".hermes")));
    assert.equal(res.absolute, true);
    assert.equal(res.exists, true);
    assert.equal(res.hops, 0);
  });

  it("resolveRealHermesRoot is an explicit no-op for a missing link (never throws)", () => {
    const root = tmp("hc-missing-link-");
    const res = resolveRealHermesRoot(path.join(root, "does-not-exist"));
    assert.equal(res.root, null);
    assert.equal(res.absolute, false);
    assert.equal(res.exists, false);
    assert.ok(res.reasons.some((r) => r.includes("no-op")));

    // Empty input is also a recorded no-op, not a throw.
    const empty = resolveRealHermesRoot("");
    assert.equal(empty.root, null);
    assert.ok(empty.reasons.length > 0);
  });

  it("follows a transitive symlink chain and scans every hop directory", () => {
    const root = tmp("hc-chain-");
    const installBin = path.join(root, "install", "bin");
    const realHermes = write(path.join(installBin, "hermes"), "#!/bin/sh\necho hermes\n", 0o755);
    write(path.join(installBin, "hermes-acp"), "#!/bin/sh\necho acp\n", 0o755);

    const linkDir = path.join(root, "links");
    fs.mkdirSync(linkDir, { recursive: true });
    const midDir = path.join(root, "mid");
    fs.mkdirSync(midDir, { recursive: true });
    const mid = path.join(midDir, "hermes-mid");
    fs.symlinkSync(realHermes, mid);
    const entry = path.join(linkDir, "hermes");
    fs.symlinkSync(mid, entry); // entry -> mid -> realHermes

    const res = resolveLauncherChain({ entryPath: entry });

    const dirs = res.scanDirs.map((d) => d.path);
    assert.ok(dirs.includes(real(linkDir)), "entry directory is scanned");
    assert.ok(dirs.includes(real(midDir)), "intermediate symlink dir is scanned");
    assert.ok(dirs.includes(real(installBin)), "resolved realpath dir is scanned");

    const filePaths = res.files.map((f) => f.path);
    assert.ok(filePaths.includes(realHermes), "real launcher is enumerated");
    assert.ok(
      filePaths.includes(path.join(installBin, "hermes-acp")),
      "sibling launcher is enumerated",
    );
    assert.equal(res.noop, false);
  });

  it("reads exec-shim targets so dir B is captured though dir A is the entry dir", () => {
    const root = tmp("hc-shim-");
    const dirA = path.join(root, "A");
    const dirB = path.join(root, "B");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const bHermes = write(path.join(dirB, "hermes"), "#!/bin/sh\necho real\n", 0o755);
    write(path.join(dirB, "hermes-acp"), "#!/bin/sh\necho acp\n", 0o755);
    const aHermes = write(path.join(dirA, "hermes"), shim(bHermes), 0o755);

    // Discriminating precondition: the shim is NOT a symlink, so realpath alone
    // would stay in dir A and never see dir B.
    assert.equal(real(aHermes), aHermes);

    const res = resolveLauncherChain({ entryPath: aHermes });
    const dirs = res.scanDirs.map((d) => d.path);
    assert.ok(dirs.includes(real(dirA)), "entry dir A is scanned");
    assert.ok(dirs.includes(real(dirB)), "exec target dir B is scanned via shim reading");

    const filePaths = res.files.map((f) => f.path);
    assert.ok(filePaths.includes(bHermes), "dir B launcher is captured via shim reading");
    assert.ok(filePaths.includes(aHermes), "dir A shim is captured");
  });

  it("ignores non-launcher interpreter exec targets (does not recurse into python)", () => {
    const root = tmp("hc-interp-");
    const dirA = path.join(root, "A");
    const interpDir = path.join(root, "tools", "python", "bin");
    const dirC = path.join(root, "C");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(interpDir, { recursive: true });
    fs.mkdirSync(dirC, { recursive: true });

    const cHermes = write(path.join(dirC, "hermes"), "#!/bin/sh\necho unreachable\n", 0o755);
    // The interpreter file itself execs a launcher — but because its basename
    // is not hermes*, the resolver must not follow it.
    const python = write(
      path.join(interpDir, "python3"),
      shim(cHermes),
      0o755,
    );
    const aHermes = write(path.join(dirA, "hermes"), shim(python), 0o755);

    const res = resolveLauncherChain({ entryPath: aHermes });
    const dirs = res.scanDirs.map((d) => d.path);
    assert.ok(dirs.includes(real(interpDir)), "exec target dir is still recorded");
    assert.ok(!dirs.includes(real(dirC)), "interpreter target is NOT recursed into");

    const filePaths = res.files.map((f) => f.path);
    assert.ok(!filePaths.includes(python), "non-launcher basename is never enumerated");
    assert.ok(!filePaths.includes(cHermes), "unreached launcher is not enumerated");
  });

  it("treats a missing entry directory as an explicit no-op", () => {
    const root = tmp("hc-noop-");
    const res = resolveLauncherChain({
      entryPath: path.join(root, "ghost-dir", "hermes"),
    });

    assert.equal(res.noop, true);
    assert.equal(res.files.length, 0);
    const ghost = res.scanDirs.find((d) => d.path === path.resolve(path.join(root, "ghost-dir")));
    assert.ok(ghost, "missing entry dir is recorded");
    assert.equal(ghost?.existed, false);
    assert.ok(res.reasons.some((r) => r.includes("no-op")));

    // No entry at all is also a no-op, never a throw.
    const none = resolveLauncherChain({});
    assert.equal(none.noop, true);
    assert.equal(none.files.length, 0);
    assert.ok(none.reasons.some((r) => r.includes("no-op")));
  });

  it("scans the belt-and-braces source-bin dir only when it exists", () => {
    const root = tmp("hc-bb-");
    const realRoot = path.join(root, "real-home");
    const bbDir = path.join(realRoot, "hermes-agent", ".hermes", "bin");
    fs.mkdirSync(bbDir, { recursive: true });
    const bbHermes = write(path.join(bbDir, "hermes"), "#!/bin/sh\necho bb\n", 0o755);
    write(path.join(bbDir, "hermes-acp"), "#!/bin/sh\necho bb-acp\n", 0o755);

    // No entry path: the belt-and-braces scan must still protect the real files.
    const res = resolveLauncherChain({ entryPath: null, realHermesRoot: realRoot });
    const bb = res.scanDirs.find((d) => d.path === real(bbDir));
    assert.ok(bb, "belt-and-braces dir is added when it exists");
    assert.equal(bb?.source, "belt-and-braces");
    assert.equal(bb?.existed, true);

    const filePaths = res.files.map((f) => f.path);
    assert.ok(filePaths.includes(bbHermes));
    assert.ok(filePaths.includes(path.join(bbDir, "hermes-acp")));
    assert.equal(res.noop, false);
  });

  it("records a missing belt-and-braces dir as an explicit existed:false no-op", () => {
    const root = tmp("hc-bb-absent-");
    const dirA = path.join(root, "A");
    const aHermes = write(path.join(dirA, "hermes"), "#!/bin/sh\necho a\n", 0o755);
    const realRoot = path.join(root, "real-home");
    fs.mkdirSync(realRoot, { recursive: true });
    const bbDir = path.join(realRoot, "hermes-agent", ".hermes", "bin");

    const res = resolveLauncherChain({ entryPath: aHermes, realHermesRoot: realRoot });
    const bb = res.scanDirs.find((d) => d.path === path.resolve(bbDir));
    assert.ok(bb, "missing belt-and-braces dir is recorded explicitly");
    assert.equal(
      bb?.existed,
      false,
      "missing belt-and-braces dir is an explicit existed:false record",
    );
    assert.equal(bb?.source, "belt-and-braces");
    assert.ok(
      res.reasons.some((r) => r.includes("belt-and-braces") && r.includes("does not exist")),
      "missing belt-and-braces dir is recorded as a no-op reason",
    );
    assert.equal(res.noop, false, "the entry shim is still snapshotted");
  });

  it("never enumerates directories as launcher files", () => {
    const root = tmp("hc-dirs-");
    const dirA = path.join(root, "A");
    fs.mkdirSync(dirA, { recursive: true });
    const aHermes = write(path.join(dirA, "hermes"), "#!/bin/sh\necho a\n", 0o755);
    // A directory whose name matches hermes* must be excluded.
    fs.mkdirSync(path.join(dirA, "hermes-dir"), { recursive: true });
    // A symlink to a directory whose name matches hermes* must also be excluded.
    fs.mkdirSync(path.join(root, "target-dir"), { recursive: true });
    fs.symlinkSync(path.join(root, "target-dir"), path.join(dirA, "hermes-link"));

    const res = resolveLauncherChain({ entryPath: aHermes });
    const filePaths = res.files.map((f) => f.path);
    assert.ok(filePaths.includes(aHermes));
    assert.ok(!filePaths.some((p) => p.endsWith("hermes-dir")));
    assert.ok(!filePaths.some((p) => p.endsWith("hermes-link")));
  });

  it("exports the full US-002/US-003 surface and imports no child_process", () => {
    assert.equal(typeof snapshotLaunchers, "function");
    assert.equal(typeof restoreLaunchers, "function");
    assert.equal(typeof verifyLaunchers, "function");

    const helperPath = fileURLToPath(
      new URL("../src/lib/hermes-launcher-snapshot.ts", import.meta.url),
    );
    const source = fs.readFileSync(helperPath, "utf-8");
    assert.ok(
      !/from\s+["']node:child_process["']/.test(source),
      "helper must not import child_process",
    );
  });
});
