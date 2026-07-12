/**
 * Classification guard for tests/serial-files.txt — the serial-test-lane classification list.
 *
 * This guard is pure-logic (no child_process import, no daemon spawns) and runs in
 * the PARALLEL lane. It fails with a clear, actionable message when a test file
 * spawns processes but is not classified in the serial lane, or when serial-files.txt
 * contains stale entries.
 *
 * This guard itself must NOT appear in tests/serial-files.txt (asserted below).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERIAL_FILES_PATH = path.join(__dirname, "serial-files.txt");

function readSerialFile(): string[] {
  const content = fs.readFileSync(SERIAL_FILES_PATH, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function allTestFiles(): string[] {
  const srcTests = globFiles(path.join(REPO_ROOT, "src"), ".test.ts");
  const testsDir = globFiles(path.join(REPO_ROOT, "tests"), ".test.ts");
  return [...srcTests, ...testsDir].sort();
}

function globFiles(dir: string, suffix: string): string[] {
  const result: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...globFiles(full, suffix));
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        result.push(full);
      }
    }
  } catch {
    // directory may not exist
  }
  return result;
}

function toRelative(p: string): string {
  return path.relative(REPO_ROOT, p);
}

function fileImportsChildProcess(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return /from\s+['"]node:child_process['"]/.test(content);
  } catch {
    return false;
  }
}

const DAEMONCTL_SPAWNER_REGEX =
  /\b(startDaemon|stopDaemon|restartDaemon|startMcp|stopMcp|restartMcp|startControlPlane|stopControlPlane|restartControlPlane|startDashboardStandalone|stopDashboardStandalone|restartDashboardStandalone)\s*\(/;

function fileCallsDaemonSpawner(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return DAEMONCTL_SPAWNER_REGEX.test(content);
  } catch {
    return false;
  }
}

function fileIsSpawnCapable(filePath: string): boolean {
  return fileImportsChildProcess(filePath) || fileCallsDaemonSpawner(filePath);
}

describe("serial-classification-guard", () => {
  it("detects unclassified node:child_process import and fails with clear message", () => {
    const serial = new Set(readSerialFile());
    const allTests = allTestFiles();
    const missing: string[] = [];

    for (const fullPath of allTests) {
      const rel = toRelative(fullPath);
      if (fileImportsChildProcess(fullPath) && !serial.has(rel)) {
        missing.push(rel);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `File ${missing[0] || "?"} imports child_process but is not in tests/serial-files.txt. ` +
        `Add it to the serial lane.\n` +
        `Unclassified files (${missing.length}):\n${missing.join("\n")}`,
    );
  });

  it("detects unclassified daemonctl spawner and fails with clear message", () => {
    const serial = new Set(readSerialFile());
    const allTests = allTestFiles();
    const missing: string[] = [];

    for (const fullPath of allTests) {
      const rel = toRelative(fullPath);
      if (
        !fileImportsChildProcess(fullPath) &&
        fileCallsDaemonSpawner(fullPath) &&
        !serial.has(rel)
      ) {
        missing.push(rel);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `File ${missing[0] || "?"} calls daemonctl spawner but is not in tests/serial-files.txt. ` +
        `Add it to the serial lane.\n` +
        `Unclassified files (${missing.length}):\n${missing.join("\n")}`,
    );
  });

  it("detects stale entries in serial-files.txt (entry pointing to non-existent file)", () => {
    const entries = readSerialFile();
    const stale: string[] = [];

    for (const entry of entries) {
      const full = path.resolve(REPO_ROOT, entry);
      if (!fs.existsSync(full)) {
        stale.push(entry);
      }
    }

    assert.deepEqual(
      stale,
      [],
      `serial-files.txt contains stale entries that do not map to existing files. ` +
        `Remove or update these entries.\n` +
        `Stale entries (${stale.length}):\n${stale.join("\n")}`,
    );
  });

  it("detects stale entries in serial-files.txt (entry is not a .test.ts file)", () => {
    const entries = readSerialFile();
    const stale: string[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".test.ts")) {
        stale.push(entry);
      }
    }

    assert.deepEqual(
      stale,
      [],
      `serial-files.txt contains entries that are not .test.ts files. ` +
        `Remove or update these entries.\n` +
        `Non-.test.ts entries (${stale.length}):\n${stale.join("\n")}`,
    );
  });

  it("guard itself is NOT listed in serial-files.txt", () => {
    const guardRel = toRelative(fileURLToPath(import.meta.url));
    const serial = new Set(readSerialFile());

    assert.ok(
      !serial.has(guardRel),
      `tests/serial-classification-guard.test.ts must NOT be in serial-files.txt — ` +
        `it is pure-logic and runs in the parallel lane. Remove "${guardRel}" from serial-files.txt.`,
    );
  });

  it("all spawn-capable files are correctly classified (comprehensive check)", () => {
    const serial = new Set(readSerialFile());
    const allTests = allTestFiles();
    const unclassified: string[] = [];

    for (const fullPath of allTests) {
      const rel = toRelative(fullPath);
      if (!serial.has(rel) && fileIsSpawnCapable(fullPath)) {
        const reason = fileImportsChildProcess(fullPath)
          ? "imports node:child_process"
          : "calls daemonctl spawner";
        unclassified.push(`${rel} (${reason})`);
      }
    }

    assert.deepEqual(
      unclassified,
      [],
      `The following test files spawn processes but are NOT in tests/serial-files.txt. ` +
        `Add them to the serial lane by appending one entry per line to tests/serial-files.txt.\n` +
        `Unclassified files (${unclassified.length}):\n${unclassified.join("\n")}`,
    );
  });
});
