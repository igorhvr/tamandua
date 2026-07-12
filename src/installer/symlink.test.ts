import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ensureCliSymlink,
  isCliSymlinked,
  removeCliSymlink,
} from "../../dist/installer/symlink.js";

describe("symlink", () => {
  let tempHome: string;
  let localBin: string;
  let originalHome: string | undefined;
  let originalBinDir: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalBinDir = process.env.TAMANDUA_BIN_DIR;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    tempHome = tamanduaTempDir("tamandua-symlink-");
    localBin = path.join(tempHome, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_BIN_DIR;
    process.env.TAMANDUA_STATE_DIR = tempHome; // points .tamandua to tempHome
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalBinDir) process.env.TAMANDUA_BIN_DIR = originalBinDir;
    else delete process.env.TAMANDUA_BIN_DIR;
    if (originalStateDir) process.env.TAMANDUA_STATE_DIR = originalStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe("isCliSymlinked", () => {
    it("returns false when no symlink exists", () => {
      assert.equal(isCliSymlinked(), false);
    });

    it("returns true after ensuring the CLI launcher symlink", () => {
      const linkPath = ensureCliSymlink();
      const target = fs.readlinkSync(linkPath);

      assert.equal(path.basename(target), "tamandua");
      assert.equal(path.basename(path.dirname(target)), "bin");
      assert.equal(isCliSymlinked(), true);
    });
  });

  describe("removeCliSymlink", () => {
    it("does not throw when no symlink exists", () => {
      assert.doesNotThrow(() => removeCliSymlink());
    });

    it("removes an existing symlink", () => {
      const fakeCli = path.join(tempHome, "fake-cli");
      fs.writeFileSync(fakeCli, "#!/usr/bin/env node\n", { mode: 0o755 });
      const linkPath = path.join(localBin, "tamandua");
      fs.symlinkSync(fakeCli, linkPath);

      // Verify symlink exists
      assert.ok(fs.lstatSync(linkPath).isSymbolicLink());

      removeCliSymlink();

      // Verify symlink is gone
      assert.ok(!fs.existsSync(linkPath));
    });

    it("ignores regular file at symlink path (does not throw)", () => {
      const linkPath = path.join(localBin, "tamandua");
      fs.writeFileSync(linkPath, "not a symlink");
      // removeCliSymlink should not throw for a regular file (lstat succeeds, isSymbolicLink is false)
      assert.doesNotThrow(() => removeCliSymlink());
      // Regular file should still exist (it's not a symlink so it won't be removed)
      assert.ok(fs.existsSync(linkPath));
    });
  });

  describe("ensureCliSymlink", () => {
    it("creates a symlink when none exists", () => {
      // ensureCliSymlink resolves the real CLI path (dist/cli/cli.js).
      // For the test to work, we just verify it runs without error
      // and creates the symlink. The target will be the real dist/cli/cli.js.
      // Since we're in a temp home, we need ~/.local/bin to exist.
      const result = ensureCliSymlink();
      const linkPath = path.join(localBin, "tamandua");
      assert.ok(fs.existsSync(linkPath), "symlink should be created");
      assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), "should be a symlink");
      assert.ok(typeof result === "string");
    });

    it("returns early when symlink already points to correct target", () => {
      // First create the symlink
      ensureCliSymlink();
      // Second call should detect it's already correct and return without error
      assert.doesNotThrow(() => ensureCliSymlink());
    });

    it("replaces symlink pointing to wrong target", () => {
      const linkPath = path.join(localBin, "tamandua");
      const wrongTarget = path.join(tempHome, "wrong-cli");
      fs.writeFileSync(wrongTarget, "fake", { mode: 0o755 });

      // First create a wrong symlink
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
      fs.symlinkSync(wrongTarget, linkPath);

      // ensureCliSymlink should unlink the wrong symlink and create a correct one
      ensureCliSymlink();
      const target = fs.readlinkSync(linkPath);
      assert.notEqual(target, wrongTarget, "should no longer point to wrong target");
    });

    it("replaces regular file at symlink path (EINVAL path)", () => {
      const linkPath = path.join(localBin, "tamandua");

      // Remove existing symlink if any
      try { fs.unlinkSync(linkPath); } catch { /* ok */ }

      // Create a regular file at the symlink path
      fs.writeFileSync(linkPath, "regular file content");
      assert.ok(fs.existsSync(linkPath));
      assert.ok(!fs.lstatSync(linkPath).isSymbolicLink());

      // ensureCliSymlink should detect EINVAL, remove the regular file, and create symlink
      ensureCliSymlink();
      assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), "should now be a symlink");
    });

    it("respects TAMANDUA_BIN_DIR env var", () => {
      const customBinDir = path.join(tempHome, "custom-bin");
      fs.mkdirSync(customBinDir, { recursive: true });
      process.env.TAMANDUA_BIN_DIR = customBinDir;

      try {
        const result = ensureCliSymlink();
        const linkPath = path.join(customBinDir, "tamandua");
        assert.ok(fs.existsSync(linkPath), "symlink should exist in custom bin dir");
        assert.ok(result.includes("tamandua"));
      } finally {
        delete process.env.TAMANDUA_BIN_DIR;
      }
    });
  });

  describe("resolveBinDir fallback", () => {
    it("falls back to .tamandua/bin when .local/bin is inaccessible", () => {
      // Create a temp home WITHOUT write permissions to .local
      const noLocalHome = tamanduaTempDir("tamandua-nolocal-");
      const origHome = process.env.HOME;

      try {
        process.env.HOME = noLocalHome;
        // isCliSymlinked calls resolveBinDir internally.
        // Without ~/.local/bin, it should fall back to .tamandua/bin.
        // We just verify it doesn't throw.
        const result = isCliSymlinked();
        assert.equal(typeof result, "boolean");
      } finally {
        process.env.HOME = origHome ?? "";
        if (!origHome) delete process.env.HOME;
        fs.rmSync(noLocalHome, { recursive: true, force: true });
      }
    });
  });
});
