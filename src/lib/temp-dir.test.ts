import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  tamanduaTempRoot,
  tamanduaTempDir,
  _resetTempRoot,
} from "../../dist/lib/temp-dir.js";

// Collect temp dirs created during tests for cleanup.
const _cleanup: string[] = [];

afterEach(() => {
  _resetTempRoot();
});

after(() => {
  for (const dir of _cleanup) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("temp-dir", () => {
  describe("tamanduaTempRoot", () => {
    it("returns /tmp/tamandua-test by default and creates it with mode 0700", () => {
      _resetTempRoot();
      const root = tamanduaTempRoot();

      assert.ok(root.endsWith("tamandua-test"), `expected .../tamandua-test, got ${root}`);
      assert.ok(fs.existsSync(root), "root should exist");
      const stat = fs.statSync(root);
      // mode must be 0700 (no group/other access)
      assert.equal(stat.mode & 0o777, 0o700, "root must have mode 0700");
      assert.ok(stat.isDirectory(), "root must be a directory");
    });

    it("resolves through fs.realpathSync (macOS /tmp -> /private/tmp)", () => {
      _resetTempRoot();
      const root = tamanduaTempRoot();

      // On macOS /tmp is a symlink to /private/tmp; the resolved root must
      // match what fs.realpathSync returns on the same path.
      const reResolved = fs.realpathSync(root);
      assert.equal(root, reResolved, "root must already be a realpath");
      assert.equal(root, fs.realpathSync(path.join(root, "..", "tamandua-test")),
        "root must be canonical (no symlink hops)");
    });

    it("returns the same value on repeated calls (cached)", () => {
      _resetTempRoot();
      const root1 = tamanduaTempRoot();
      const root2 = tamanduaTempRoot();

      assert.equal(root1, root2, "must cache root between calls");
    });

    it("uses TAMANDUA_TEST_TMPDIR env override when set", () => {
      _resetTempRoot();
      const override = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-override-"));
      _cleanup.push(override);

      process.env.TAMANDUA_TEST_TMPDIR = override;
      try {
        const root = tamanduaTempRoot();
        assert.equal(root, fs.realpathSync(override),
          "must use env override when set");
      } finally {
        delete process.env.TAMANDUA_TEST_TMPDIR;
      }
    });

    it("falls back to os.tmpdir() when directory creation fails", () => {
      _resetTempRoot();

      // Create a regular file where we'd want a directory — mkdir will fail
      const fileBlock = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-block-"));
      _cleanup.push(fileBlock);
      const blockedPath = path.join(fileBlock, "nope");
      fs.writeFileSync(blockedPath, "block");

      process.env.TAMANDUA_TEST_TMPDIR = blockedPath;
      try {
        const root = tamanduaTempRoot();
        // Must fall back to os.tmpdir(), not the blocked path
        assert.equal(root, fs.realpathSync(os.tmpdir()),
          "must fall back to os.tmpdir() on creation failure");
      } finally {
        delete process.env.TAMANDUA_TEST_TMPDIR;
      }
    });

    it("does not emit duplicate warnings across repeated calls after fallback", () => {
      _resetTempRoot();

      const fileBlock = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-block2-"));
      _cleanup.push(fileBlock);
      const blockedPath = path.join(fileBlock, "also-nope");
      fs.writeFileSync(blockedPath, "block");

      // Capture stderr for two calls
      const stderrWrite = process.stderr.write.bind(process.stderr);
      const chunks: string[] = [];
      process.stderr.write = (chunk: any, ...args: any[]) => {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      };

      process.env.TAMANDUA_TEST_TMPDIR = blockedPath;
      try {
        tamanduaTempRoot(); // triggers fallback + warning
        chunks.length = 0;
        tamanduaTempRoot(); // cached — no second warning
        assert.equal(chunks.length, 0, "must not emit duplicate warnings");
      } finally {
        delete process.env.TAMANDUA_TEST_TMPDIR;
        process.stderr.write = stderrWrite;
      }
    });

    it("handles non-existent TAMANDUA_TEST_TMPDIR (creates it)", () => {
      _resetTempRoot();

      const customRoot = path.join(os.tmpdir(), "tamandua-missing-root-" + Date.now());
      _cleanup.push(customRoot);

      process.env.TAMANDUA_TEST_TMPDIR = customRoot;
      try {
        const root = tamanduaTempRoot();
        assert.ok(fs.existsSync(root), "custom root must be created");
        const stat = fs.statSync(root);
        assert.equal(stat.mode & 0o777, 0o700, "custom root must have mode 0700");
      } finally {
        delete process.env.TAMANDUA_TEST_TMPDIR;
      }
    });
  });

  describe("tamanduaTempDir", () => {
    it("creates a unique directory under tamanduaTempRoot", () => {
      _resetTempRoot();
      const dir = tamanduaTempDir("tamandua-tdtest-");
      _cleanup.push(dir);

      const root = tamanduaTempRoot();

      assert.ok(dir.startsWith(root + path.sep), "must be under root");
      assert.ok(fs.existsSync(dir), "directory must exist");
      assert.ok(fs.statSync(dir).isDirectory(), "must be a directory");
    });

    it("produces distinct directories on repeated calls", () => {
      _resetTempRoot();
      const dir1 = tamanduaTempDir("tamandua-unique-");
      const dir2 = tamanduaTempDir("tamandua-unique-");
      _cleanup.push(dir1, dir2);

      assert.notEqual(dir1, dir2, "must produce unique directories");
    });
  });

  describe("_resetTempRoot", () => {
    it("clears cached root so next call recomputes", () => {
      _resetTempRoot();
      const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-reset-"));
      _cleanup.push(envDir);

      process.env.TAMANDUA_TEST_TMPDIR = envDir;
      const root1 = tamanduaTempRoot();
      delete process.env.TAMANDUA_TEST_TMPDIR;

      // Without reset, root1 is still cached
      const root2 = tamanduaTempRoot();
      assert.equal(root1, root2, "before reset, cached value should be returned");

      _resetTempRoot();
      const root3 = tamanduaTempRoot();

      assert.notEqual(root3, root1, "after reset, default root should be computed");
      assert.ok(root3.endsWith("tamandua-test"), "should use default after reset");
    });
  });
});
