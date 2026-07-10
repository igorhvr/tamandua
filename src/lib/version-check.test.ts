import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runVersionCheck, readVersionStatus } from "../../dist/lib/version-check.js";
import { createTempHome } from "../../tests/helpers/test-env.ts";

const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const th = createTempHome("tamandua-version-check-");
const testStateDir = th.tamanduaDir;
process.env.TAMANDUA_STATE_DIR = testStateDir;

after(() => {
  if (originalStateDir === undefined) {
    delete process.env.TAMANDUA_STATE_DIR;
  } else {
    process.env.TAMANDUA_STATE_DIR = originalStateDir;
  }
});

describe("version-check", () => {
  it("exports runVersionCheck and readVersionStatus", () => {
    assert.equal(typeof runVersionCheck, "function");
    assert.equal(typeof readVersionStatus, "function");
  });

  it("runVersionCheck writes version-status.json and does not throw", async () => {
    await assert.doesNotReject(() => runVersionCheck());

    const statusPath = path.join(testStateDir, "version-status.json");
    assert.ok(fs.existsSync(statusPath), "version-status.json should exist");

    const raw = fs.readFileSync(statusPath, "utf-8");
    const status = JSON.parse(raw);

    assert.ok("updateAvailable" in status);
    assert.ok("currentHead" in status);
    assert.ok("remoteHead" in status);
    assert.ok("checkedAt" in status);
  });

  it("readVersionStatus returns default when no file exists", () => {
    // Clean up any existing file from previous test
    const statusPath = path.join(testStateDir, "version-status.json");
    try {
      fs.unlinkSync(statusPath);
    } catch {
      // file didn't exist, that's fine
    }

    const status = readVersionStatus();
    assert.equal(status.updateAvailable, false);
    assert.equal(status.currentHead, "");
    assert.equal(status.remoteHead, "");
    assert.equal(status.checkedAt, "");
  });

  it("readVersionStatus reads cached status correctly", () => {
    const statusPath = path.join(testStateDir, "version-status.json");
    const testData = {
      updateAvailable: true,
      currentHead: "abc123",
      remoteHead: "def456",
      checkedAt: "2024-01-15T10:30:00Z",
    };
    fs.mkdirSync(testStateDir, { recursive: true });
    fs.writeFileSync(statusPath, JSON.stringify(testData), "utf-8");

    const status = readVersionStatus();
    assert.equal(status.updateAvailable, true);
    assert.equal(status.currentHead, "abc123");
    assert.equal(status.remoteHead, "def456");
    assert.equal(status.checkedAt, "2024-01-15T10:30:00Z");
  });

  it("readVersionStatus handles malformed JSON gracefully", () => {
    const statusPath = path.join(testStateDir, "version-status.json");
    fs.mkdirSync(testStateDir, { recursive: true });
    fs.writeFileSync(statusPath, "not valid json {{{", "utf-8");

    const status = readVersionStatus();
    assert.equal(status.updateAvailable, false);
  });

  it("runVersionCheck result is readable by readVersionStatus", async () => {
    await runVersionCheck();

    const status = readVersionStatus();
    assert.equal(typeof status.updateAvailable, "boolean");
    assert.equal(typeof status.currentHead, "string");
    assert.equal(typeof status.remoteHead, "string");
    assert.equal(typeof status.checkedAt, "string");
    // checkedAt should be a recent ISO timestamp
    assert.ok(
      status.checkedAt.length > 0,
      "checkedAt should be non-empty after runVersionCheck",
    );
  });

  it("runVersionCheck writes safe default when git operations fail", async () => {
    // Force git commands to fail by using a non-existent GIT_DIR
    const originalGitDir = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = "/nonexistent/git/dir/that/does/not/exist";

      // Should not throw — the error handler writes safe defaults
      await assert.doesNotReject(() => runVersionCheck());

      const statusPath = path.join(testStateDir, "version-status.json");
      assert.ok(fs.existsSync(statusPath), "safe default should be written");

      const status = readVersionStatus();
      assert.equal(status.updateAvailable, false, "safe default should be false");
      assert.equal(status.currentHead, "");
      assert.equal(status.remoteHead, "");
    } finally {
      if (originalGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = originalGitDir;
      }
    }
  });

  it("readVersionStatus returns defaults for missing fields", () => {
    const statusPath = path.join(testStateDir, "version-status.json");
    fs.mkdirSync(testStateDir, { recursive: true });
    fs.writeFileSync(statusPath, JSON.stringify({ updateAvailable: true }), "utf-8");

    const status = readVersionStatus();
    assert.equal(status.updateAvailable, true);
    assert.equal(status.currentHead, "");
    assert.equal(status.remoteHead, "");
    assert.equal(status.checkedAt, "");
  });

  it("readVersionStatus coerces non-boolean updateAvailable to boolean", () => {
    const statusPath = path.join(testStateDir, "version-status.json");
    fs.mkdirSync(testStateDir, { recursive: true });
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        updateAvailable: 1,
        currentHead: null,
        remoteHead: 123,
        checkedAt: null,
      }),
      "utf-8",
    );

    const status = readVersionStatus();
    assert.equal(status.updateAvailable, true); // Number 1 → Boolean true
    assert.equal(typeof status.currentHead, "string");
    assert.equal(typeof status.remoteHead, "string");
    assert.equal(typeof status.checkedAt, "string");
  });
});
