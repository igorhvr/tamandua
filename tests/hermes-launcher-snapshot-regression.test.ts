/**
 * Regression tests for the hermes launcher snapshot/restore/verify safety net
 * (`src/lib/hermes-launcher-snapshot.ts`).
 *
 * Every fixture is a FAKE launcher tree under `tamanduaTempDir(...)`; these
 * tests never read or write the operator's real `~/.hermes`.
 *
 * The discriminating case is the exec SHIM shape: a shim in dir A execs a real
 * launcher in dir B, so a realpath-only resolver misses dir B, and the snapshot
 * would fail to repair the very file the real contamination rewrites.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  resolveLauncherChain,
  snapshotLaunchers,
  restoreLaunchers,
  verifyLaunchers,
  type LauncherSnapshot,
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

/** Create parent dirs and write a file. */
function write(p: string, content: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode });
  fs.chmodSync(p, mode);
  return p;
}

/** A two-line shell exec shim, mirroring the observed macOS launcher shape. */
function shim(execTarget: string): string {
  return `#!/bin/sh\nexec ${execTarget} "$@"\n`;
}

/** The observed contamination: a launcher execing an interpreter under a temp dir. */
function contaminatedShim(tempInterpreter: string): string {
  return `#!/bin/sh\nexec ${tempInterpreter} -m hermes "$@"\n`;
}

function sha256(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function real(p: string): string {
  return fs.realpathSync(p);
}

/** Resolve a fake chain from an entry shim, returning the canonical snapshot. */
function snapshotFrom(entryPath: string, realHermesRoot?: string): LauncherSnapshot {
  const chain = resolveLauncherChain({ entryPath, realHermesRoot });
  return snapshotLaunchers(chain);
}

describe("hermes launcher snapshot/restore/verify", () => {
  it("(a) restores the observed contamination shape byte-for-byte and re-applies mode", () => {
    const root = tmp("hs-contam-");
    const dirA = path.join(root, "A");
    const original = "#!/bin/sh\necho real-launcher-v1\n";
    const aHermes = write(path.join(dirA, "hermes"), original, 0o755);
    // A sibling launcher must also be snapshotted/restored.
    const aAcp = write(path.join(dirA, "hermes-acp"), "#!/bin/sh\necho acp-v1\n", 0o755);

    const snap = snapshotFrom(aHermes);
    assert.equal(snap.noop, false);
    assert.deepEqual(
      snap.entries.map((e) => e.path).sort(),
      [aHermes, aAcp].sort(),
    );
    // Records absolute path, bytes, sha256 and mode; no temp path leaks in.
    assert.ok(snap.entries.every((e) => path.isAbsolute(e.path)));
    assert.ok(snap.entries.every((e) => e.path.startsWith(real(root))));
    assert.equal(snap.entries[0].sha256, sha256(snap.entries[0].bytes));
    const hermesEntry = snap.entries.find((e) => e.path === aHermes);
    assert.equal(hermesEntry?.sha256, sha256(original));
    assert.equal((hermesEntry?.mode ?? 0) & 0o777, 0o755);

    // Tamper: rewrite dir A's launcher to exec an interpreter under a temp dir,
    // exactly the contamination shape observed on the affected host.
    const tempInterpreter = path.join(root, "temp-home", ".hermes", "tools", "python", "bin", "python3");
    write(aHermes, contaminatedShim(tempInterpreter), 0o600);
    assert.notEqual(fs.readFileSync(aHermes, "utf-8"), original);

    const result = restoreLaunchers(snap);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.restored, [aHermes]);
    assert.deepEqual(result.unchanged, [aAcp]);

    assert.equal(fs.readFileSync(aHermes, "utf-8"), original, "bytes restored exactly");
    assert.equal(fs.statSync(aHermes).mode & 0o777, 0o755, "recorded mode restored");
    assert.equal(verifyLaunchers(snap).ok, true, "byte-identity holds after restore");
  });

  it("(b) shim shape: dir B is captured via shim reading and restored (realpath-only would miss it)", () => {
    const root = tmp("hs-shim-");
    const dirA = path.join(root, "A");
    const dirB = path.join(root, "B");
    const bOriginal = "#!/bin/sh\necho real-launcher-v1\n";
    const bHermes = write(path.join(dirB, "hermes"), bOriginal, 0o755);
    const bAcp = write(path.join(dirB, "hermes-acp"), "#!/bin/sh\necho acp-v1\n", 0o755);
    const aHermes = write(path.join(dirA, "hermes"), shim(bHermes), 0o755);

    // Discriminating precondition: the shim is not a symlink, so following
    // realpath alone stays in dir A and never sees dir B.
    assert.equal(real(aHermes), aHermes);

    const snap = snapshotFrom(aHermes);
    const snapPaths = snap.entries.map((e) => e.path);
    assert.ok(snapPaths.includes(bHermes), "dir B launcher is in the snapshot");
    assert.ok(snapPaths.includes(bAcp), "dir B sibling is in the snapshot");
    assert.ok(snapPaths.includes(aHermes), "dir A shim is in the snapshot");

    // Tamper dir B's real launcher (the file a realpath-only resolver missed).
    write(bHermes, contaminatedShim(path.join(root, "tmp", "python3")), 0o600);
    assert.notEqual(fs.readFileSync(bHermes, "utf-8"), bOriginal);

    const result = restoreLaunchers(snap);
    assert.deepEqual(result.failed, []);
    assert.ok(result.restored.includes(bHermes), "dir B file is restored");
    assert.equal(fs.readFileSync(bHermes, "utf-8"), bOriginal, "dir B byte-identity restored");
    assert.equal(fs.statSync(bHermes).mode & 0o777, 0o755);
    assert.equal(verifyLaunchers(snap).ok, true);
  });

  it("(c) unchanged files are a strict no-op: bytes and mtime untouched, nothing rewritten", () => {
    const root = tmp("hs-unchanged-");
    const dirA = path.join(root, "A");
    const aHermes = write(path.join(dirA, "hermes"), "#!/bin/sh\necho stable\n", 0o755);

    const past = new Date("2001-01-01T00:00:00Z");
    fs.utimesSync(aHermes, past, past);
    const mtimeBefore = fs.statSync(aHermes).mtimeMs;

    const snap = snapshotFrom(aHermes);
    const result = restoreLaunchers(snap);

    assert.deepEqual(result.restored, [], "no file is rewritten");
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.unchanged, [aHermes]);
    assert.equal(fs.readFileSync(aHermes, "utf-8"), "#!/bin/sh\necho stable\n");
    const mtimeAfter = fs.statSync(aHermes).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, "mtime is untouched by a no-op restore");
    assert.ok(Math.abs(mtimeAfter - past.getTime()) < 5000, "file was not rewritten recently");
    assert.equal(verifyLaunchers(snap).ok, true);
  });

  it("(d) a failed write makes restore throw a loud Error naming the path (never silent success)", () => {
    const root = tmp("hs-failed-");
    const dirA = path.join(root, "A");
    const aHermes = write(path.join(dirA, "hermes"), "#!/bin/sh\necho original\n", 0o755);

    const snap = snapshotFrom(aHermes);
    // Tamper, then make restoration impossible by removing the parent dir.
    write(aHermes, contaminatedShim(path.join(root, "tmp", "python3")), 0o600);
    fs.rmSync(dirA, { recursive: true, force: true });

    // A combined restore+verify caller must never treat the failure as success.
    let threw = false;
    let verification = null;
    try {
      restoreLaunchers(snap);
      verification = verifyLaunchers(snap);
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /could not restore/i);
      assert.ok(
        (err as Error).message.includes(aHermes),
        "Error names the failing path",
      );
    }
    assert.equal(threw, true, "restore fails loudly");
    assert.equal(verification, null, "no verification result is returned on failure");

    const verify = verifyLaunchers(snap);
    assert.equal(verify.ok, false, "verification reports the missing file");
    assert.equal(verify.entries[0].actualSha256, null);
  });

  it("(e) a missing launcher dir is an explicit no-op with zero writes", () => {
    const root = tmp("hs-missing-");
    const entry = path.join(root, "ghost-dir", "hermes");

    const chain = resolveLauncherChain({ entryPath: entry });
    assert.equal(chain.noop, true);
    assert.equal(chain.files.length, 0);

    const snap = snapshotLaunchers(chain);
    assert.equal(snap.noop, true);
    assert.equal(snap.entries.length, 0);
    assert.ok(snap.reasons.some((r) => r.includes("no-op")));

    const result = restoreLaunchers(snap);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.unchanged, []);
    assert.deepEqual(result.failed, []);
    assert.equal(fs.existsSync(entry), false, "no file was created");

    const verify = verifyLaunchers(snap);
    assert.equal(verify.entries.length, 0);
    assert.equal(verify.ok, true);
  });

  it("restores a deleted launcher file from the snapshot", () => {
    const root = tmp("hs-deleted-");
    const dirA = path.join(root, "A");
    const original = "#!/bin/sh\necho del\n";
    const aHermes = write(path.join(dirA, "hermes"), original, 0o755);

    const snap = snapshotFrom(aHermes);
    fs.rmSync(aHermes, { force: true });
    assert.equal(fs.existsSync(aHermes), false);

    const result = restoreLaunchers(snap);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.restored, [aHermes]);
    assert.equal(fs.readFileSync(aHermes, "utf-8"), original);
    assert.equal(verifyLaunchers(snap).ok, true);
  });
});
