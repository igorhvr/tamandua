/**
 * Integrity tests for tests/serial-files.txt — the serial-test-lane classification list.
 *
 * This test file is itself pure-logic (no child_process import, no daemon spawns)
 * and must NOT appear in serial-files.txt.
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

function fileCallsDaemonSpawner(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    // Match calls to daemonctl functions that spawn OS processes
    return /\b(startDaemon|stopDaemon|restartDaemon|startMcp|stopMcp|restartMcp|startControlPlane|stopControlPlane|restartControlPlane|startDashboardStandalone|stopDashboardStandalone|restartDashboardStandalone)\s*\(/.test(
      content,
    );
  } catch {
    return false;
  }
}

describe("serial-files.txt integrity", () => {
  it("serial-files.txt exists and is non-empty", () => {
    // Membership is pinned bidirectionally by the classification tests below
    // (every spawn-capable file listed / every listed file spawn-capable), so
    // an exact-count assertion would only add churn on every legitimate change.
    assert.ok(fs.existsSync(SERIAL_FILES_PATH), "tests/serial-files.txt must exist");
    const entries = readSerialFile();
    assert.ok(entries.length > 0, "serial-files.txt must not be empty");
  });

  it("every entry is a valid relative path to an existing .test.ts file", () => {
    const entries = readSerialFile();
    for (const entry of entries) {
      const full = path.resolve(REPO_ROOT, entry);
      assert.ok(
        fs.existsSync(full),
        `serial-files.txt entry "${entry}" must point to an existing file`,
      );
      assert.ok(
        entry.endsWith(".test.ts"),
        `serial-files.txt entry "${entry}" must be a .test.ts file`,
      );
    }
  });

  it("every serial-files.txt entry has no duplicates", () => {
    const entries = readSerialFile();
    const seen = new Set<string>();
    for (const entry of entries) {
      assert.ok(
        !seen.has(entry),
        `serial-files.txt has duplicate entry: "${entry}"`,
      );
      seen.add(entry);
    }
  });

  it("all files importing node:child_process are in serial-files.txt", () => {
    const serial = new Set(readSerialFile());
    const allTests = allTestFiles();
    const missing: string[] = [];

    for (const fullPath of allTests) {
      const rel = toRelative(fullPath);
      if (fileImportsChildProcess(fullPath) && !serial.has(rel)) {
        missing.push(rel);
      }
    }

    assert.deepEqual(missing, [],
      `The following files import node:child_process but are NOT in tests/serial-files.txt. ` +
      `Add them to the serial lane:\n${missing.join("\n")}`);
  });

  it("all daemonctl spawner files are in serial-files.txt", () => {
    const serial = new Set(readSerialFile());
    const allTests = allTestFiles();
    const missing: string[] = [];

    for (const fullPath of allTests) {
      const rel = toRelative(fullPath);
      if (!fileImportsChildProcess(fullPath) && fileCallsDaemonSpawner(fullPath) && !serial.has(rel)) {
        missing.push(rel);
      }
    }

    assert.deepEqual(missing, [],
      `The following files call daemonctl spawner functions but are NOT in tests/serial-files.txt. ` +
      `Add them to the serial lane:\n${missing.join("\n")}`);
  });

  it("all test files NOT in serial-files.txt are pure-logic (no child_process, no daemon spawns)", () => {
    const serial = new Set(readSerialFile());
    const allTests = allTestFiles();
    const violators: string[] = [];

    for (const fullPath of allTests) {
      const rel = toRelative(fullPath);
      if (serial.has(rel)) continue;

      if (fileImportsChildProcess(fullPath)) {
        violators.push(`${rel}: imports node:child_process but not in serial-files.txt`);
      } else if (fileCallsDaemonSpawner(fullPath)) {
        violators.push(`${rel}: calls daemonctl spawner but not in serial-files.txt`);
      }
    }

    assert.deepEqual(violators, [],
      `The following files are NOT in serial-files.txt but spawn processes. ` +
      `Either add them to the serial lane or remove the process-spawning code:\n${violators.join("\n")}`);
  });

  it("serial-files.txt is sorted alphabetically", () => {
    const entries = readSerialFile();
    const sorted = [...entries].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(entries, sorted,
      "serial-files.txt must be sorted alphabetically. Expected order:\n" + sorted.join("\n"));
  });

  it("this guard test itself is NOT in serial-files.txt", () => {
    const guardRel = toRelative(fileURLToPath(import.meta.url));
    const serial = new Set(readSerialFile());
    assert.ok(
      !serial.has(guardRel),
      `This guard test (${guardRel}) must NOT be in serial-files.txt — it is pure-logic`,
    );
  });
});
