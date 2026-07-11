/**
 * Unit tests for preserveE2eTestHome in smoke-helpers.ts.
 *
 * These tests create isolated temp directories and clean up after themselves.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preserveE2eTestHome } from "./smoke-helpers.ts";

const ARCHIVES_DIR = path.join(os.tmpdir(), "tamandua-e2e-failures");

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Recursively compare two directories: same file names and contents. */
function dirsEqual(a: string, b: string): boolean {
  const aEntries = fs.readdirSync(a, { recursive: true, withFileTypes: true });
  const bEntries = fs.readdirSync(b, { recursive: true, withFileTypes: true });

  const aFiles = new Set(
    aEntries.filter((e) => e.isFile()).map((e) => path.relative(a, path.join(e.parentPath ?? a, e.name))),
  );
  const bFiles = new Set(
    bEntries.filter((e) => e.isFile()).map((e) => path.relative(b, path.join(e.parentPath ?? b, e.name))),
  );

  if (aFiles.size !== bFiles.size) return false;
  for (const rel of aFiles) {
    if (!bFiles.has(rel)) return false;
    const aContent = fs.readFileSync(path.join(a, rel), "utf-8");
    const bContent = fs.readFileSync(path.join(b, rel), "utf-8");
    if (aContent !== bContent) return false;
  }
  return true;
}

describe("preserveE2eTestHome", () => {
  const createdArchives: string[] = [];

  afterEach(() => {
    // Clean up archives created by tests
    for (const archive of createdArchives.splice(0)) {
      try {
        fs.rmSync(archive, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("copies the temp root directory to the archive path", () => {
    const root = makeTempDir("tamandua-test-copy-");
    const archive: string | null = null;
    try {
      // Create some files in the temp dir
      fs.writeFileSync(path.join(root, "hello.txt"), "hello world", "utf-8");
      fs.mkdirSync(path.join(root, "subdir"));
      fs.writeFileSync(
        path.join(root, "subdir", "nested.txt"),
        "nested file",
        "utf-8",
      );

      const result = preserveE2eTestHome(root, "test-copy");
      assert.ok(result !== null, "should return a path string");
      assert.ok(fs.existsSync(result!), "archive path should exist");
      createdArchives.push(result!);

      // Verify archive path format
      assert.ok(
        result!.startsWith(ARCHIVES_DIR),
        `archive should be under ${ARCHIVES_DIR}, got ${result}`,
      );
      const baseName = path.basename(result!);
      // Format: <YYYY-MM-DDTHHmmss>-<slug>
      assert.ok(
        /^\d{4}-\d{2}-\d{2}T\d{6}-test-copy$/.test(baseName),
        `archive name should match format, got ${baseName}`,
      );

      // Verify contents are identical
      assert.ok(dirsEqual(root, result!), "archive contents should match source");
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("sanitizes slug by replacing path-unsafe characters with hyphens", () => {
    const root = makeTempDir("tamandua-test-slug-");
    try {
      fs.writeFileSync(path.join(root, "dummy.txt"), "x", "utf-8");

      const result = preserveE2eTestHome(root, "bad/slug\\with:chars*in?path\"<name>|here");
      assert.ok(result !== null);
      createdArchives.push(result!);

      const baseName = path.basename(result!);
      // All unsafe chars should be replaced with hyphens
      assert.ok(
        baseName.endsWith("-bad-slug-with-chars-in-path--name--here"),
        `slug should be sanitized, got ${baseName}`,
      );
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("prunes to 5 most recent archives (removing oldest beyond limit)", () => {
    const root = makeTempDir("tamandua-test-prune-");
    try {
      fs.writeFileSync(path.join(root, "dummy.txt"), "x", "utf-8");

      const testSlug = `prune-test-${Date.now()}`;
      const archivePaths: string[] = [];

      // Create 6 archives
      for (let i = 0; i < 6; i++) {
        const result = preserveE2eTestHome(root, `${testSlug}-batch${i}`);
        assert.ok(result !== null);
        archivePaths.push(result!);
        createdArchives.push(result!);
      }

      // Verify only 5 archives remain with this slug prefix
      const remaining = fs
        .readdirSync(ARCHIVES_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.includes(testSlug));
      assert.equal(
        remaining.length,
        5,
        `expected 5 archives, got ${remaining.length}`,
      );

      // The first (oldest) archive should have been pruned
      assert.ok(
        !fs.existsSync(archivePaths[0]),
        `oldest archive ${archivePaths[0]} should have been pruned`,
      );
      // The remaining 5 should exist
      for (let i = 1; i < 6; i++) {
        assert.ok(
          fs.existsSync(archivePaths[i]),
          `archive ${archivePaths[i]} should exist`,
        );
      }
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("respects the maxArchives parameter (custom limit)", () => {
    const root = makeTempDir("tamandua-test-maxarch-");
    try {
      fs.writeFileSync(path.join(root, "dummy.txt"), "x", "utf-8");

      const testSlug = `custom-limit-${Date.now()}`;
      const archivePaths: string[] = [];

      // Create 4 archives with maxArchives=3
      for (let i = 0; i < 4; i++) {
        const result = preserveE2eTestHome(root, `${testSlug}-batch${i}`, 3);
        assert.ok(result !== null);
        archivePaths.push(result!);
        createdArchives.push(result!);
      }

      // Verify only 3 archives remain
      const remaining = fs
        .readdirSync(ARCHIVES_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.includes(testSlug));
      assert.equal(remaining.length, 3, `expected 3 archives, got ${remaining.length}`);

      // Oldest should be pruned
      assert.ok(
        !fs.existsSync(archivePaths[0]),
        `oldest archive ${archivePaths[0]} should have been pruned`,
      );
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("returns null and does not throw on error (failure-proof)", () => {
    // Pass a non-existent directory — should not throw
    const result = preserveE2eTestHome(
      "/tmp/nonexistent-path-xyz-12345-that-does-not-exist",
      "failure-proof-test",
    );
    assert.equal(result, null, "should return null on failure");
    // The function did not throw — we reached here
  });

  it("prints archive path to stderr on success", () => {
    const root = makeTempDir("tamandua-test-stderr-");
    try {
      fs.writeFileSync(path.join(root, "dummy.txt"), "x", "utf-8");

      // Capture stderr by intercepting console.error
      const stderrMessages: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        stderrMessages.push(args.map(String).join(" "));
      };

      let result: string | null = null;
      try {
        result = preserveE2eTestHome(root, "stderr-test");
      } finally {
        console.error = originalError;
      }

      assert.ok(result !== null);
      createdArchives.push(result!);

      // Should have printed the archive path with the expected prefix
      const found = stderrMessages.some(
        (msg) =>
          msg.startsWith("[tamandua e2e] FAILURE FORENSICS PRESERVED:") &&
          msg.includes(result!),
      );
      assert.ok(
        found,
        `stderr should contain archive path. Messages: ${stderrMessages.join(" | ")}`,
      );
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
