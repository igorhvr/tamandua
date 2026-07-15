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

function toRelative(p: string): string {
  return path.relative(REPO_ROOT, p);
}

describe("serial-files.txt integrity", () => {
  it("serial-files.txt exists and is non-empty", () => {
    // Membership is pinned bidirectionally by serial-classification-guard.test.ts,
    // so an exact-count assertion would only add churn on legitimate changes.
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
