/**
 * Tests for scripts/inject-version.js
 *
 * Run with: node --test tests/inject-version.test.ts
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");
const distVersion = path.join(repoRoot, "dist", "version");
const distStandalone = path.join(repoRoot, "dist", "cli", "commands", "standalone.js");

describe("inject-version.js", () => {
  it("creates dist/version with ISO8601_refhash format", () => {
    // dist/version should exist after build
    assert.ok(fs.existsSync(distVersion), "dist/version should exist after build");

    const content = fs.readFileSync(distVersion, "utf-8").trim();

    // Pattern: YYYYMMDDTHHMMSSZ_40-char-hex
    const pattern = /^\d{8}T\d{6}Z_[0-9a-f]{40}$/;
    assert.match(content, pattern, `dist/version content (${content}) should match ISO8601_refhash format`);
  });

  it("injects version into dist/cli/commands/standalone.js", () => {
    assert.ok(fs.existsSync(distStandalone), "dist/cli/commands/standalone.js should exist");
    const standaloneSource = fs.readFileSync(distStandalone, "utf-8");

    // __VERSION__ placeholder should be replaced
    assert.ok(
      !standaloneSource.includes("__VERSION__"),
      "dist/cli/commands/standalone.js should not contain __VERSION__ placeholder"
    );

    // Should contain the actual version string (ISO8601_refhash)
    const versionPattern = /\d{8}T\d{6}Z_[0-9a-f]{40}/;
    assert.match(standaloneSource, versionPattern, "standalone.js should contain injected version string");
  });

  it("dist/version and standalone.js BUILT_VERSION match", () => {
    const versionContent = fs.readFileSync(distVersion, "utf-8").trim();
    const standaloneSource = fs.readFileSync(distStandalone, "utf-8");

    // Extract the version from standalone.js - it's assigned to BUILT_VERSION.
    const match = standaloneSource.match(/BUILT_VERSION\s*=\s*"([^"]+)"/);
    assert.ok(match, "BUILT_VERSION assignment should be found in standalone.js");
    assert.equal(match[1], versionContent, "dist/version and BUILT_VERSION in standalone.js should match");
  });

  it("version format components are valid", () => {
    const content = fs.readFileSync(distVersion, "utf-8").trim();
    const parts = content.split("_");

    assert.equal(parts.length, 2, "Version should have timestamp and sha1 separated by underscore");

    const [timestamp, sha1] = parts;

    // Validate timestamp components
    const year = parseInt(timestamp.slice(0, 4), 10);
    const month = parseInt(timestamp.slice(4, 6), 10);
    const day = parseInt(timestamp.slice(6, 8), 10);
    const hour = parseInt(timestamp.slice(9, 11), 10);
    const min = parseInt(timestamp.slice(11, 13), 10);
    const sec = parseInt(timestamp.slice(13, 15), 10);

    assert.ok(year >= 2024 && year <= 2100, `Year ${year} should be in valid range`);
    assert.ok(month >= 1 && month <= 12, `Month ${month} should be 1-12`);
    assert.ok(day >= 1 && day <= 31, `Day ${day} should be 1-31`);
    assert.ok(hour >= 0 && hour <= 23, `Hour ${hour} should be 0-23`);
    assert.ok(min >= 0 && min <= 59, `Minute ${min} should be 0-59`);
    assert.ok(sec >= 0 && sec <= 59, `Second ${sec} should be 0-59`);
    assert.equal(timestamp[8], "T", "Timestamp should have T separator");
    assert.equal(timestamp[15], "Z", "Timestamp should end with Z");

    // Validate sha1: 40 hex chars
    assert.equal(sha1.length, 40, `SHA1 should be 40 chars, got ${sha1.length}`);
    assert.match(sha1, /^[0-9a-f]{40}$/, "SHA1 should be lowercase hex");
  });
});
