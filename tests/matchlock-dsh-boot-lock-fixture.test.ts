/**
 * Fast, deterministic regression for TESTER-HONESTY item 4 (story US-007):
 * the zero-provider dsh fixture (`e2e-tests/dsh-fixture/fake-dsh.mjs`)
 * reproduces the REAL dsh `withFileLock` at the boot-sibling path
 * `<profiles>/node_modules.lock` — `fs.openSync(lock, "wx", 0o600)`, a
 * durable sibling marker, both released in `finally` — so any dsh mount plan
 * that leaves the guest `profiles/` absent or non-writable fails the synthetic
 * gates too, exactly like vaimetal run #32.
 *
 * The lock is a SIBLING of the mounted `node_modules` destination, never a
 * child of it. These tests therefore assert:
 *   - a writable `profiles/` yields exit 0, a mode-0o600 lock at the exact
 *     sibling path while held, and no leftover lock/marker afterwards;
 *   - an exclusive-create (`wx`) refusal (`EEXIST`) when the lock already
 *     exists;
 *   - an absent and a non-writable `profiles/` parent each refuse with exit 8
 *     and the production `Error: ENOENT: no such file or directory, open
 *     '<profiles>/node_modules.lock'` shape.
 *
 * No VM, no daemon, no provider, no network: every scratch path comes from
 * `tamanduaTempDir()` and each home is a `prepareComposedDshHome()` fixture.
 * The operator's real `~/.dsh` is never read or written.
 *
 * This file imports `node:child_process` (it spawns the fixture) and is
 * therefore classified into the serial lane via `tests/serial-files.txt`.
 */

import { describe, it, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  DSH_GATE_BOOT_LOCK_BASENAME,
  DSH_GATE_BOOT_LOCK_HOLD_MARKER,
  DSH_GATE_FIRST_REQUEST_MARKER,
  DSH_GATE_GUEST_INSTALL_ROOT_ENV,
  prepareComposedDshHome,
  stderrCarriesDshBootLockEnoent,
} from "../e2e-tests/helpers/matchlock-dsh-gate-fixtures.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_DSH = path.join(REPO_ROOT, "e2e-tests", "dsh-fixture", "fake-dsh.mjs");

/** Isolated child env (HOME + PATH only, never a spread of `process.env`). */
function baseEnv(extra: Record<string, string>): Record<string, string> {
  return {
    HOME: extra.HOME ?? "",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...extra,
  };
}

function firstRequestArgs(holdMs = 0): string[] {
  const prompt =
    holdMs > 0
      ? `${DSH_GATE_FIRST_REQUEST_MARKER}: probe ${DSH_GATE_BOOT_LOCK_HOLD_MARKER}:${holdMs}`
      : `${DSH_GATE_FIRST_REQUEST_MARKER}: probe`;
  return [FAKE_DSH, "--profile", "headless", prompt];
}

describe("zero-provider dsh fixture boot-sibling lock (TESTER-HONESTY item 4 / US-007)", () => {
  let root = "";

  before(() => {
    assert.ok(fs.existsSync(FAKE_DSH), `fixture dsh must exist: ${FAKE_DSH}`);
    root = tamanduaTempDir("mtlk-dsh-boot-lock-");
  });

  after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* owned scratch */
    }
  });

  it("creates the withFileLock sibling at the exact <profiles>/node_modules.lock path with mode 0o600 and releases it (exit 0, no leftover)", async () => {
    const home = path.join(root, "writable-home");
    prepareComposedDshHome(home);
    const profilesDir = path.join(home, "profiles");
    const lockPath = path.join(profilesDir, DSH_GATE_BOOT_LOCK_BASENAME);
    // The lock's parent is `profiles/` itself, NOT the mounted `node_modules`
    // destination (that child path is where a naive plan would look).
    const childLockPath = path.join(profilesDir, "node_modules", DSH_GATE_BOOT_LOCK_BASENAME);
    assert.equal(path.dirname(lockPath), profilesDir, "the lock must be a sibling of the farm dir");
    assert.notEqual(lockPath, childLockPath);
    assert.equal(fs.existsSync(lockPath), false, "no lock may exist before the fixture runs");

    const holdMs = 800;
    const child = spawn(process.execPath, firstRequestArgs(holdMs), {
      stdio: ["ignore", "pipe", "pipe"],
      env: baseEnv({
        HOME: path.join(root, "iso-home"),
        DSH_HOME: home,
        [DSH_GATE_GUEST_INSTALL_ROOT_ENV]: path.join(root, "guest-install"),
      }),
    });
    let stdErr = "";
    let stdOut = "";
    child.stderr.on("data", (d: Buffer) => (stdErr += d.toString()));
    child.stdout.on("data", (d: Buffer) => (stdOut += d.toString()));
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));

    let observedMode = -1;
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      if (fs.existsSync(lockPath)) {
        observedMode = fs.statSync(lockPath).mode & 0o777;
        // Sibling semantics: nothing may ever be created at the child path.
        assert.equal(
          fs.existsSync(childLockPath),
          false,
          "the boot lock must never be a child of the node_modules destination",
        );
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const exitCode = await closed;

    assert.notEqual(observedMode, -1, `the held boot lock must be observable: ${stdErr}`);
    // `wx` + 0o600 semantics: the exact open-mode bits, subject only to umask.
    assert.equal(
      observedMode,
      0o600 & ~process.umask(),
      `the boot lock must be created with mode 0o600 (got 0o${observedMode.toString(8)})`,
    );
    assert.equal(observedMode & 0o600, 0o600, "the lock must be owner read/write");
    assert.equal(observedMode & 0o077, 0, "the lock must never be group/other accessible");

    assert.equal(exitCode, 0, `the writable-profiles probe must exit 0: ${stdErr}`);
    assert.ok(
      stdOut.includes("FIRST-REQUEST-RESOLVED:"),
      `stdout must carry the resolved marker: ${stdOut}`,
    );
    // Both boot-sibling artifacts the fixture created are released in finally.
    assert.equal(fs.existsSync(lockPath), false, "the fixture must release the boot lock before exit");
    assert.equal(
      fs.existsSync(path.join(profilesDir, "node_modules.synthetic-boot-marker")),
      false,
      "the durable sibling marker must be removed before exit",
    );
    assert.equal(
      fs.existsSync(childLockPath),
      false,
      "the child destination must never carry the lock",
    );
  });

  it("creates the boot lock exclusively (wx): a pre-existing lock refuses the create with EEXIST", () => {
    const home = path.join(root, "exclusive-home");
    prepareComposedDshHome(home);
    const profilesDir = path.join(home, "profiles");
    const lockPath = path.join(profilesDir, DSH_GATE_BOOT_LOCK_BASENAME);
    fs.writeFileSync(lockPath, "held by another writer\n", "utf-8");

    const run = spawnSync(process.execPath, firstRequestArgs(), {
      encoding: "utf-8",
      timeout: 30_000,
      env: baseEnv({
        HOME: path.join(root, "iso-home"),
        DSH_HOME: home,
        [DSH_GATE_GUEST_INSTALL_ROOT_ENV]: path.join(root, "guest-install"),
      }),
    });
    assert.equal(
      run.status,
      8,
      `a pre-existing sibling lock must refuse the exclusive create: ${run.stderr}`,
    );
    assert.match(
      run.stderr,
      /EEXIST/,
      `the wx create must surface EEXIST: ${run.stderr}`,
    );
    assert.equal(
      stderrCarriesDshBootLockEnoent(run.stderr, profilesDir),
      true,
      `stderr must also carry the production lock failure shape: ${run.stderr}`,
    );
  });

  it("an absent <profiles>/ parent reproduces the run #32 ENOENT shape and exits 8", () => {
    const guestHome = path.join(root, "absent-profiles-home");
    fs.mkdirSync(guestHome, { recursive: true });
    const profilesDir = path.join(guestHome, "profiles");
    const lockPath = path.join(profilesDir, DSH_GATE_BOOT_LOCK_BASENAME);

    const run = spawnSync(process.execPath, firstRequestArgs(), {
      encoding: "utf-8",
      timeout: 30_000,
      env: baseEnv({ HOME: path.join(root, "iso-home"), DSH_HOME: guestHome }),
    });
    assert.equal(run.status, 8, `the absent-profiles probe must exit 8: ${run.stderr}`);
    assert.ok(
      run.stderr.includes("ENOENT: no such file or directory, open"),
      `stderr must carry the ENOENT open shape: ${run.stderr}`,
    );
    assert.ok(run.stderr.includes("node_modules.lock"), `stderr must name the lock: ${run.stderr}`);
    assert.ok(
      run.stderr.includes(lockPath),
      `stderr must name the exact sibling lock path ${lockPath}: ${run.stderr}`,
    );
    assert.equal(
      stderrCarriesDshBootLockEnoent(run.stderr, profilesDir),
      true,
      `the production lock-failure matcher must accept the output: ${run.stderr}`,
    );
    assert.equal(
      fs.existsSync(profilesDir),
      false,
      "the fixture must never fabricate the missing profiles/ parent",
    );
  });

  it("a non-writable <profiles>/ parent refuses with the production lock failure shape and exits 8", (t: TestContext) => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("running as root: mode bits cannot make profiles/ non-writable");
      return;
    }
    const home = path.join(root, "non-writable-home");
    prepareComposedDshHome(home);
    const profilesDir = path.join(home, "profiles");
    const lockPath = path.join(profilesDir, DSH_GATE_BOOT_LOCK_BASENAME);
    fs.chmodSync(profilesDir, 0o500);
    try {
      const run = spawnSync(process.execPath, firstRequestArgs(), {
        encoding: "utf-8",
        timeout: 30_000,
        env: baseEnv({
          HOME: path.join(root, "iso-home"),
          DSH_HOME: home,
          [DSH_GATE_GUEST_INSTALL_ROOT_ENV]: path.join(root, "guest-install"),
        }),
      });
      assert.equal(
        run.status,
        8,
        `a non-writable profiles/ must refuse the boot lock: ${run.stderr}`,
      );
      assert.ok(
        run.stderr.includes("ENOENT: no such file or directory, open"),
        `stderr must reproduce the production ENOENT shape: ${run.stderr}`,
      );
      assert.ok(run.stderr.includes("node_modules.lock"), `stderr must name the lock: ${run.stderr}`);
      assert.equal(
        stderrCarriesDshBootLockEnoent(run.stderr, profilesDir),
        true,
        `the production lock-failure matcher must accept the output: ${run.stderr}`,
      );
      assert.equal(
        fs.existsSync(lockPath),
        false,
        "no lock may exist after the refused create",
      );
    } finally {
      // Restore write permission so the owned scratch tree can be removed.
      fs.chmodSync(profilesDir, 0o700);
    }
  });
});
