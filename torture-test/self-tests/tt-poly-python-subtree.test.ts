import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// This test file performs read-only validation against fixtures-src —
// no commands are executed inside fixtures-src.

const repoRoot = process.cwd();
const ttPolyPythonDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly",
  "python",
);
const ttPolyLitePythonDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly-lite",
  "python",
);

describe("tt-poly python/ subtree integration (US-002)", () => {
  it("python/ directory exists and contains all files from tt-poly-lite", () => {
    assert.ok(
      fs.existsSync(ttPolyPythonDir),
      "tt-poly/python/ should exist",
    );
    assert.ok(
      fs.statSync(ttPolyPythonDir).isDirectory(),
      "tt-poly/python/ should be a directory",
    );

    // Collect all relative file paths in both source and dest
    const collectFiles = (dir: string): Set<string> => {
      const files = new Set<string>();
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else {
            files.add(path.relative(dir, full));
          }
        }
      };
      walk(dir);
      return files;
    };

    const sourceFiles = collectFiles(ttPolyLitePythonDir);
    const destFiles = collectFiles(ttPolyPythonDir);

    // dest may have extra files (e.g., README-JUNK.md added by later stories)
    assert.ok(
      destFiles.size >= sourceFiles.size,
      `dest file count (${destFiles.size}) should be >= source (${sourceFiles.size})`,
    );

    for (const f of sourceFiles) {
      assert.ok(
        destFiles.has(f),
        `tt-poly/python/${f} should exist (from tt-poly-lite)`,
      );
    }
  });

  it("FIXTURE.md references tt-poly, not tt-poly-lite", () => {
    const mdPath = path.join(ttPolyPythonDir, "FIXTURE.md");
    assert.ok(fs.existsSync(mdPath), "FIXTURE.md should exist");

    const content = fs.readFileSync(mdPath, "utf-8");
    assert.ok(
      content.includes("tt-poly python/ Subtree"),
      "FIXTURE.md title should reference tt-poly",
    );
    assert.ok(
      content.includes("tt-poly/python/"),
      "FIXTURE.md fixture path should reference tt-poly",
    );
    assert.ok(
      content.includes("tt-poly five-language storm monorepo") || content.includes("Part of tt-poly monorepo"),
      "FIXTURE.md should say tt-poly monorepo",
    );
    // Should NOT reference tt-poly-lite
    assert.ok(
      !content.includes("tt-poly-lite"),
      "FIXTURE.md should not reference tt-poly-lite",
    );
  });

  it("README.md references tt-poly, not tt-poly-lite", () => {
    const mdPath = path.join(ttPolyPythonDir, "README.md");
    assert.ok(fs.existsSync(mdPath), "README.md should exist");

    const content = fs.readFileSync(mdPath, "utf-8");
    assert.ok(
      !content.includes("tt-poly-lite"),
      "README.md should not reference tt-poly-lite",
    );
    assert.ok(
      content.includes("tt-poly"),
      "README.md should reference tt-poly",
    );
  });

  it("src/schedlib/ contains all required modules", () => {
    const schedlibDir = path.join(ttPolyPythonDir, "src", "schedlib");
    assert.ok(fs.existsSync(schedlibDir), "src/schedlib/ should exist");

    const requiredModules = [
      "engine.py",
      "recurrence.py",
      "conflict.py",
      "dates.py",
      "calendar_helpers.py",
      "integrations.py",
      "__init__.py",
    ];

    for (const mod of requiredModules) {
      const modPath = path.join(schedlibDir, mod);
      assert.ok(fs.existsSync(modPath), `src/schedlib/${mod} should exist`);
      assert.ok(
        fs.statSync(modPath).isFile(),
        `src/schedlib/${mod} should be a file`,
      );
    }
  });

  it("tests/ contains all test files", () => {
    const testsDir = path.join(ttPolyPythonDir, "tests");
    assert.ok(fs.existsSync(testsDir), "tests/ should exist");

    const requiredTests = [
      "test_engine.py",
      "test_recurrence.py",
      "test_conflict.py",
      "test_dates.py",
      "test_calendar_helpers.py",
      "test_performance.py",
      "__init__.py",
    ];

    for (const t of requiredTests) {
      assert.ok(
        fs.existsSync(path.join(testsDir, t)),
        `tests/${t} should exist`,
      );
    }
  });

  it("bootstrap exists and is executable", () => {
    const bootstrapPath = path.join(ttPolyPythonDir, "bootstrap");
    assert.ok(fs.existsSync(bootstrapPath), "bootstrap should exist");

    const stat = fs.statSync(bootstrapPath);
    assert.ok(stat.isFile(), "bootstrap should be a file");
    // Check executable by owner, group, or other
    const mode = stat.mode;
    const isExecutable =
      (mode & fs.constants.S_IXUSR) !== 0 ||
      (mode & fs.constants.S_IXGRP) !== 0 ||
      (mode & fs.constants.S_IXOTH) !== 0;
    assert.ok(isExecutable, "bootstrap should be executable");
  });

  it("$(sentinel)/ subdirectory exists with canary.py", () => {
    const sentinelDir = path.join(ttPolyPythonDir, "$(sentinel)");
    assert.ok(fs.existsSync(sentinelDir), "$(sentinel)/ should exist");
    assert.ok(
      fs.statSync(sentinelDir).isDirectory(),
      "$(sentinel)/ should be a directory",
    );

    const canaryPath = path.join(sentinelDir, "canary.py");
    assert.ok(fs.existsSync(canaryPath), "$(sentinel)/canary.py should exist");
    assert.ok(
      fs.statSync(canaryPath).isFile(),
      "$(sentinel)/canary.py should be a file",
    );
  });

  it("operator-notes.local exists in subtree", () => {
    const opNotesPath = path.join(ttPolyPythonDir, "operator-notes.local");
    assert.ok(
      fs.existsSync(opNotesPath),
      "operator-notes.local should exist in python/",
    );

    const content = fs.readFileSync(opNotesPath, "utf-8");
    assert.ok(content.length > 0, "operator-notes.local should not be empty");
  });

  it("conftest.py and pyproject.toml exist", () => {
    for (const f of ["conftest.py", "pyproject.toml"]) {
      const fPath = path.join(ttPolyPythonDir, f);
      assert.ok(fs.existsSync(fPath), `${f} should exist`);
      assert.ok(fs.statSync(fPath).isFile(), `${f} should be a file`);
    }
  });

  it("seeds/ directory contains POLY-P* seed directories", () => {
    const seedsDir = path.join(ttPolyPythonDir, "seeds");
    assert.ok(fs.existsSync(seedsDir), "seeds/ should exist");

    const expectedSeeds = [
      "POLY-BUG-P1",
      "POLY-BUG-P2",
      "POLY-BUG-P3",
      "POLY-BUG-P4",
      "POLY-VULN-P1",
      "POLY-VULN-P2",
      "POLY-BRK-P1",
      "POLY-BRK-P2",
      "POLY-FLAKY-P1",
    ];

    for (const seed of expectedSeeds) {
      const seedDir = path.join(seedsDir, seed);
      assert.ok(
        fs.existsSync(seedDir),
        `seeds/${seed} should exist`,
      );
    }
  });

  it("python/ .gitignore is appropriate for Python project", () => {
    const giPath = path.join(ttPolyPythonDir, ".gitignore");
    assert.ok(fs.existsSync(giPath), "python/.gitignore should exist");

    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    // Must gitignore venv and build artifacts
    assert.ok(activeRules.includes(".venv/"), ".gitignore should exclude .venv/");
    // Must NOT gitignore junk probes
    assert.ok(
      !activeRules.includes("__pycache__/"),
      ".gitignore should NOT exclude __pycache__/ (junk probe)",
    );
    assert.ok(
      !activeRules.includes(".pytest_cache/"),
      ".gitignore should NOT exclude .pytest_cache/ (junk probe)",
    );
  });
});
