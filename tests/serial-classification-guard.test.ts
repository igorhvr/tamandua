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
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  auditSerialMembership,
  classifyTestFile,
  resolveSourceImport,
} from "./helpers/serial-classification.ts";

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

function withFixtureRepo(run: (repoRoot: string) => void): void {
  const repoRoot = tamanduaTempDir("tamandua-serl-");
  try {
    fs.mkdirSync(path.join(repoRoot, "src", "installer"), { recursive: true });
    run(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe("SERL serial classification rules", () => {
  it("resolves source-style and dist-style imports to source TypeScript", () => {
    withFixtureRepo((repoRoot) => {
      const testFile = path.join(repoRoot, "src", "installer", "example.test.ts");
      const sourceFile = path.join(repoRoot, "src", "installer", "example.ts");
      fs.writeFileSync(testFile, "");
      fs.writeFileSync(sourceFile, "");

      assert.equal(resolveSourceImport(testFile, "./example.js", repoRoot), sourceFile);
      assert.equal(
        resolveSourceImport(testFile, "../../dist/installer/example.js", repoRoot),
        sourceFile,
      );
    });
  });

  it("detects direct child_process imports and daemonctl spawner calls", () => {
    withFixtureRepo((repoRoot) => {
      const direct = path.join(repoRoot, "src", "direct.test.ts");
      const daemon = path.join(repoRoot, "src", "daemon.test.ts");
      fs.writeFileSync(direct, 'import { spawn } from "node:' + 'child_process";\n');
      fs.writeFileSync(daemon, "start" + "Daemon();\n");

      assert.deepEqual(classifyTestFile(direct, repoRoot), ["imports node:child_process"]);
      assert.deepEqual(classifyTestFile(daemon, repoRoot), ["calls daemonctl spawner"]);
    });
  });

  it("detects child_process imported by a source dependency one hop below the tested module", () => {
    withFixtureRepo((repoRoot) => {
      const testFile = path.join(repoRoot, "src", "installer", "scheduler.test.ts");
      const scheduler = path.join(repoRoot, "src", "installer", "scheduler.ts");
      const adapter = path.join(repoRoot, "src", "installer", "adapter.ts");
      fs.writeFileSync(testFile, 'import { run } from "../../dist/installer/scheduler.js";\nrun();\n');
      fs.writeFileSync(
        scheduler,
        'import { spawnAdapter } from "./adapter.js";\nexport function run() { spawnAdapter(); }\n',
      );
      fs.writeFileSync(adapter, 'import { spawn } from "node:' + 'child_process";\n');

      assert.deepEqual(classifyTestFile(testFile, repoRoot), [
        "imports process-spawning source module src/installer/adapter.ts",
      ]);
    });
  });

  it("reports actionable missing and unjustified serial-list entries", () => {
    withFixtureRepo((repoRoot) => {
      const spawning = path.join(repoRoot, "src", "spawning.test.ts");
      const pure = path.join(repoRoot, "src", "pure.test.ts");
      fs.writeFileSync(spawning, 'import { spawn } from "node:' + 'child_process";\n');
      fs.writeFileSync(pure, "const answer = 42;\n");

      const audit = auditSerialMembership(
        [spawning, pure],
        ["src/pure.test.ts"],
        repoRoot,
      );
      assert.deepEqual(audit.missing, [
        "src/spawning.test.ts (imports node:child_process)",
      ]);
      assert.deepEqual(audit.unjustified, [
        "src/pure.test.ts (does not match the process-spawning classification rule)",
      ]);
    });
  });
});

describe("serial-classification-guard", () => {
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

  it("enforces serial membership bidirectionally with actionable diagnostics", () => {
    const audit = auditSerialMembership(allTestFiles(), readSerialFile(), REPO_ROOT);

    assert.deepEqual(
      audit.missing,
      [],
      `The following test files spawn processes but are NOT in tests/serial-files.txt. ` +
        `Add them to the serial lane, keeping the file alphabetized.\n` +
        `Unclassified files (${audit.missing.length}):\n${audit.missing.join("\n")}`,
    );
    assert.deepEqual(
      audit.unjustified,
      [],
      `The following tests/serial-files.txt entries do not match the direct, daemonctl, ` +
        `or indirect source-module spawn rules. Remove them or fix the classifier.\n` +
        `Unjustified entries (${audit.unjustified.length}):\n${audit.unjustified.join("\n")}`,
    );
  });
});
