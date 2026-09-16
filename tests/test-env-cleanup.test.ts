/**
 * Regression tests for removeTestTempDirWithDiagnostics cleanup of read-only
 * temp trees (RED 2, beads tamandua-6sy.27 identity fixtures).
 *
 * Mac certifications failed the src/installer/run.test.ts after-hook with
 * `Failed to remove test temp dir .../.hermes/skills/apple/apple-notes/
 * SKILL.md: EACCES: permission denied`. A hermes skills fixture materializes
 * read-only directories/files (0o500 dir containing 0o400 files) under the
 * isolated temp HOME, and fs.rmSync cannot unlink an entry whose parent
 * directory lacks owner write permission. removeTestTempDirWithDiagnostics now
 * recursively repairs owner write/execute permissions before its existing
 * rmSync retry loop, never following symlinks, and still throws the same
 * `(remaining entries: ...)` diagnostic when removal genuinely fails.
 *
 * Parallel-lane safe: this file does NOT import node:child_process and spawns
 * no process, so it must NOT be listed in tests/serial-files.txt (see
 * tests/serial-classification-guard.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTempHome, removeTestTempDirWithDiagnostics } from "./helpers/test-env.ts";

describe("removeTestTempDirWithDiagnostics", () => {
  it("removes a tree containing a 0o500 directory with a 0o400 file (hermes fixture shape)", () => {
    const th = createTempHome("tamandua-env-cleanup-ro-");
    const roDir = path.join(th.root, "home", ".hermes", "skills", "apple", "apple-notes");
    fs.mkdirSync(roDir, { recursive: true });
    const roFile = path.join(roDir, "SKILL.md");
    fs.writeFileSync(roFile, "# read-only hermes fixture\n", "utf-8");
    fs.chmodSync(roFile, 0o400);
    fs.chmodSync(roDir, 0o500);

    assert.ok(fs.existsSync(roFile), "read-only fixture file must exist before cleanup");

    removeTestTempDirWithDiagnostics(th.root);

    assert.equal(
      fs.existsSync(th.root),
      false,
      "read-only temp tree must be completely removed",
    );
  });

  it("does not follow symlinks when repairing permissions", () => {
    const th = createTempHome("tamandua-env-cleanup-link-");
    const target = createTempHome("tamandua-env-cleanup-target-");
    const targetFile = path.join(target.root, "outside.txt");
    fs.writeFileSync(targetFile, "target content\n", "utf-8");
    fs.chmodSync(targetFile, 0o400);

    const link = path.join(th.root, "link-to-outside.txt");
    fs.symlinkSync(targetFile, link);

    removeTestTempDirWithDiagnostics(th.root);

    assert.equal(fs.existsSync(th.root), false, "tree with symlink must be removed");
    assert.ok(
      fs.existsSync(targetFile),
      "symlink target outside the tree must be untouched",
    );
    assert.equal(
      fs.statSync(targetFile).mode & 0o777,
      0o400,
      "symlink target mode must not be changed (link not followed)",
    );

    removeTestTempDirWithDiagnostics(target.root);
  });

  it("still throws the diagnostic naming remaining entries when removal genuinely fails", () => {
    const th = createTempHome("tamandua-env-cleanup-fail-");
    const stuck = path.join(th.root, "stuck.txt");
    fs.writeFileSync(stuck, "stuck content\n", "utf-8");

    const originalRmSync = fs.rmSync;
    // Simulate an unremovable entry: rmSync always fails. The repair walk uses
    // chmod/readdir only, so it must not be affected.
    (fs as { rmSync: typeof fs.rmSync }).rmSync = (() => {
      throw new Error("simulated EACCES");
    }) as typeof fs.rmSync;

    try {
      assert.throws(
        () => removeTestTempDirWithDiagnostics(th.root),
        (err: Error) => {
          assert.match(err.message, /^Failed to remove test temp dir /);
          assert.match(err.message, /simulated EACCES/);
          assert.match(err.message, /remaining entries: .*stuck\.txt/);
          return true;
        },
        "removal failure must surface the existing diagnostic with remaining entries",
      );
    } finally {
      (fs as { rmSync: typeof fs.rmSync }).rmSync = originalRmSync;
      removeTestTempDirWithDiagnostics(th.root);
    }
  });
});
