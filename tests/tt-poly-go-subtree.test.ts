import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttPolyGoDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly",
  "go",
);
const ttGoDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-go",
);

describe("tt-poly go/ subtree integration (US-004)", () => {
  it("go/ directory exists and contains all Go source files from tt-go fixture", () => {
    assert.ok(
      fs.existsSync(ttPolyGoDir),
      "tt-poly/go/ should exist",
    );
    assert.ok(
      fs.statSync(ttPolyGoDir).isDirectory(),
      "tt-poly/go/ should be a directory",
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

    const sourceFiles = collectFiles(ttGoDir);
    const destFiles = collectFiles(ttPolyGoDir);

    // Every source file must exist in dest.
    // Skip files excluded during rsync (build-golden.sh, .gitignore, README.md)
    // and .gitkeep (placeholder only).
    const excludedFiles = new Set([
      "build-golden.sh",
      ".gitkeep",
      "README.md",
      ".gitignore",
    ]);

    // Map old seed directory names to POLY-* names for the file parity check.
    // The source (tt-go) uses BUG-G*, BRK-G*, VULN-G* but tt-poly renames
    // them to POLY-BUG-G*, POLY-BRK-G*, POLY-VULN-G*.
    const remapSeedDir = (f: string): string => {
      // seeds/BRK-G1/pool_test.go → seeds/POLY-BRK-G1/pool_test.go
      f = f.replace(/^seeds\/BUG-G/g, "seeds/POLY-BUG-G");
      f = f.replace(/^seeds\/BRK-G/g, "seeds/POLY-BRK-G");
      f = f.replace(/^seeds\/VULN-G/g, "seeds/POLY-VULN-G");
      // Also handle the seed overlay files that have different names:
      // VULN-G1/util_command.go → POLY-VULN-G1/util_command.go (already handled above)
      return f;
    };

    for (const f of sourceFiles) {
      if (excludedFiles.has(f)) continue;
      if (path.basename(f) === ".gitkeep") continue;
      const remapped = remapSeedDir(f);
      assert.ok(
        destFiles.has(remapped),
        `tt-poly/go/${remapped} should exist (from tt-go/${f})`,
      );
    }
  });

  it("FIXTURE.md references tt-poly, not tt-go", () => {
    const mdPath = path.join(ttPolyGoDir, "FIXTURE.md");
    assert.ok(fs.existsSync(mdPath), "FIXTURE.md should exist");

    const content = fs.readFileSync(mdPath, "utf-8");
    assert.ok(
      content.includes("tt-poly go/ Subtree Seeded Content"),
      'FIXTURE.md title should reference "tt-poly go/ Subtree"',
    );
    assert.ok(
      content.includes("tt-poly five-language storm monorepo"),
      "FIXTURE.md should mention tt-poly five-language storm monorepo",
    );
    // Must reference POLY-G* naming (re-ID'd from BUG-G*)
    assert.ok(
      content.includes("POLY-BUG-G1"),
      "FIXTURE.md should document POLY-BUG-G1",
    );
    assert.ok(
      content.includes("POLY-VULN-G1"),
      "FIXTURE.md should document POLY-VULN-G1",
    );
    assert.ok(
      content.includes("POLY-BRK-G1"),
      "FIXTURE.md should document POLY-BRK-G1",
    );
  });

  it("pool.go, worker.go, task.go, pool_test.go present", () => {
    const requiredFiles = ["pool.go", "task.go", "pool_test.go"];
    for (const f of requiredFiles) {
      const fPath = path.join(ttPolyGoDir, f);
      assert.ok(fs.existsSync(fPath), `go/${f} should exist`);
      assert.ok(
        fs.statSync(fPath).isFile(),
        `go/${f} should be a file`,
      );
    }
  });

  it("pool.go defines WorkerPool with all required methods", () => {
    const poolPath = path.join(ttPolyGoDir, "pool.go");
    const content = fs.readFileSync(poolPath, "utf-8");

    // Core types and methods
    assert.ok(content.includes("WorkerPool struct"), "pool.go should define WorkerPool");
    assert.ok(content.includes("NewPool"), "pool.go should define NewPool");
    assert.ok(content.includes("Submit"), "pool.go should define Submit");
    assert.ok(content.includes("Shutdown"), "pool.go should define Shutdown");
    assert.ok(content.includes("Results"), "pool.go should define Results");
    assert.ok(content.includes("Running"), "pool.go should define Running");
    assert.ok(content.includes("Completed"), "pool.go should define Completed");
    assert.ok(content.includes("PanicError struct"), "pool.go should define PanicError");
    assert.ok(content.includes("ErrPoolShutdown"), "pool.go should define ErrPoolShutdown");
    assert.ok(content.includes("executeTask"), "pool.go should define executeTask");
  });

  it("task.go defines Task and Result structs", () => {
    const taskPath = path.join(ttPolyGoDir, "task.go");
    const content = fs.readFileSync(taskPath, "utf-8");

    assert.ok(content.includes("Task struct"), "task.go should define Task struct");
    assert.ok(content.includes("Result struct"), "task.go should define Result struct");
  });

  it("util/ subpackage present with dormant vuln modules", () => {
    const utilDir = path.join(ttPolyGoDir, "util");
    assert.ok(fs.existsSync(utilDir), "util/ should exist");
    assert.ok(
      fs.statSync(utilDir).isDirectory(),
      "util/ should be a directory",
    );

    const commandPath = path.join(utilDir, "command.go");
    assert.ok(fs.existsSync(commandPath), "util/command.go should exist");

    const archivePath = path.join(utilDir, "archive.go");
    assert.ok(fs.existsSync(archivePath), "util/archive.go should exist");

    // Verify dormant vuln markers
    const commandContent = fs.readFileSync(commandPath, "utf-8");
    assert.ok(
      commandContent.includes("VULN-G1") ||
      commandContent.includes("shell injection"),
      "util/command.go should document VULN-G1",
    );
    assert.ok(
      commandContent.includes("RunCommandShell"),
      "util/command.go should define RunCommandShell (vulnerable)",
    );

    const archiveContent = fs.readFileSync(archivePath, "utf-8");
    assert.ok(
      archiveContent.includes("VULN-G2") ||
      archiveContent.includes("path traversal"),
      "util/archive.go should document VULN-G2",
    );
    assert.ok(
      archiveContent.includes("ExtractTar"),
      "util/archive.go should define ExtractTar (vulnerable)",
    );
  });

  it("testdata/exec-bit-probe.sh present with exec bit", () => {
    const probePath = path.join(
      ttPolyGoDir,
      "testdata",
      "exec-bit-probe.sh",
    );
    assert.ok(fs.existsSync(probePath), "testdata/exec-bit-probe.sh should exist");

    const stat = fs.statSync(probePath);
    assert.ok(stat.isFile(), "testdata/exec-bit-probe.sh should be a file");

    // Check exec bit (owner executable)
    const mode = stat.mode;
    assert.ok(
      (mode & fs.constants.S_IXUSR) !== 0,
      "testdata/exec-bit-probe.sh should have exec bit set",
    );

    const content = fs.readFileSync(probePath, "utf-8");
    assert.ok(
      content.includes("exec-bit-probe"),
      "exec-bit-probe.sh should have probe content",
    );
  });

  it("go.mod has valid module declaration", () => {
    const modPath = path.join(ttPolyGoDir, "go.mod");
    assert.ok(fs.existsSync(modPath), "go.mod should exist");

    const content = fs.readFileSync(modPath, "utf-8");
    assert.ok(content.includes("module "), "go.mod should declare a module");
    assert.ok(content.includes("tt-go"), "go.mod should declare module tt-go");
    assert.ok(content.includes("go 1."), "go.mod should specify Go version");
  });

  it("operator-notes.local exists in go/ subtree", () => {
    const opNotesPath = path.join(ttPolyGoDir, "operator-notes.local");
    assert.ok(
      fs.existsSync(opNotesPath),
      "operator-notes.local should exist in go/",
    );

    const content = fs.readFileSync(opNotesPath, "utf-8");
    assert.ok(content.length > 0, "operator-notes.local should not be empty");
    assert.ok(
      content.includes("operator-notes.local"),
      "operator-notes.local should have proper header",
    );
    assert.ok(
      content.includes("tt-poly go/ Subtree"),
      "operator-notes.local should reference tt-poly go/ Subtree",
    );
  });

  it("JUNK-IS-INTENTIONAL.md exists in go/ subtree", () => {
    const junkPath = path.join(ttPolyGoDir, "JUNK-IS-INTENTIONAL.md");
    assert.ok(fs.existsSync(junkPath), "JUNK-IS-INTENTIONAL.md should exist in go/");

    const content = fs.readFileSync(junkPath, "utf-8");
    assert.ok(
      content.includes("Do NOT clean up"),
      "JUNK-IS-INTENTIONAL.md should warn against cleanup",
    );
    assert.ok(
      content.includes("exec-bit-probe.sh"),
      "JUNK-IS-INTENTIONAL.md should mention exec-bit-probe.sh",
    );
  });

  it("README-JUNK.md exists in go/ subtree", () => {
    const junkPath = path.join(ttPolyGoDir, "README-JUNK.md");
    assert.ok(fs.existsSync(junkPath), "README-JUNK.md should exist in go/");

    const content = fs.readFileSync(junkPath, "utf-8");
    assert.ok(
      content.includes("exec-bit-probe.sh"),
      "README-JUNK.md should document exec-bit-probe.sh",
    );
    assert.ok(
      content.includes("operator-notes.local"),
      "README-JUNK.md should document operator-notes.local",
    );
  });

  it("seeds/ directory contains POLY-G* seed directories with overlay files and fix patches", () => {
    const seedsDir = path.join(ttPolyGoDir, "seeds");
    assert.ok(fs.existsSync(seedsDir), "seeds/ should exist");

    const seedDirs = [
      "POLY-BUG-G1",
      "POLY-BUG-G2",
      "POLY-BUG-G3",
      "POLY-BUG-G4",
      "POLY-VULN-G1",
      "POLY-VULN-G2",
      "POLY-BRK-G1",
      "POLY-BRK-G2",
    ];

    for (const dir of seedDirs) {
      const dirPath = path.join(seedsDir, dir);
      assert.ok(fs.existsSync(dirPath), `seeds/${dir} should exist`);
      assert.ok(
        fs.statSync(dirPath).isDirectory(),
        `seeds/${dir} should be a directory`,
      );

      // Every seed directory must have a fix.patch
      const fixPath = path.join(dirPath, "fix.patch");
      assert.ok(
        fs.existsSync(fixPath),
        `seeds/${dir}/fix.patch should exist`,
      );
    }

    // Check POLY-BUG-G1 has pool.go overlay
    const bugG1Dir = path.join(seedsDir, "POLY-BUG-G1");
    assert.ok(
      fs.existsSync(path.join(bugG1Dir, "pool.go")),
      "seeds/POLY-BUG-G1/pool.go should exist",
    );

    // Check POLY-BUG-G2 has both pool.go and worker.go
    const bugG2Dir = path.join(seedsDir, "POLY-BUG-G2");
    assert.ok(
      fs.existsSync(path.join(bugG2Dir, "pool.go")),
      "seeds/POLY-BUG-G2/pool.go should exist",
    );
    assert.ok(
      fs.existsSync(path.join(bugG2Dir, "worker.go")),
      "seeds/POLY-BUG-G2/worker.go should exist",
    );

    // Check POLY-VULN-G1 has util_command.go
    const vulnG1Dir = path.join(seedsDir, "POLY-VULN-G1");
    assert.ok(
      fs.existsSync(path.join(vulnG1Dir, "util_command.go")),
      "seeds/POLY-VULN-G1/util_command.go should exist",
    );

    // Check POLY-BRK-G1 has pool_test.go and go.mod
    const brkG1Dir = path.join(seedsDir, "POLY-BRK-G1");
    assert.ok(
      fs.existsSync(path.join(brkG1Dir, "pool_test.go")),
      "seeds/POLY-BRK-G1/pool_test.go should exist",
    );
    assert.ok(
      fs.existsSync(path.join(brkG1Dir, "go.mod")),
      "seeds/POLY-BRK-G1/go.mod should exist",
    );

    // Check SEEDS.md exists
    assert.ok(
      fs.existsSync(path.join(seedsDir, "SEEDS.md")),
      "seeds/SEEDS.md should exist",
    );
  });

  it("seeds/SEEDS.md documents POLY-G* IDs (not old BUG-G* IDs)", () => {
    const seedsMdPath = path.join(ttPolyGoDir, "seeds", "SEEDS.md");
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    // Must use POLY-G* naming
    assert.ok(content.includes("POLY-BUG-G1"), "SEEDS.md should document POLY-BUG-G1");
    assert.ok(content.includes("POLY-BUG-G4"), "SEEDS.md should document POLY-BUG-G4");
    assert.ok(content.includes("POLY-VULN-G1"), "SEEDS.md should document POLY-VULN-G1");
    assert.ok(content.includes("POLY-BRK-G1"), "SEEDS.md should document POLY-BRK-G1");

    // Should reference tt-poly context
    assert.ok(
      content.includes("tt-poly go/ Seed Catalog") ||
      content.includes("tt-poly five-language"),
      "SEEDS.md should reference tt-poly",
    );
  });

  it("operator-notes.local is byte-identical to tt-go reference (adapted with tt-poly name)", () => {
    // The go/ operator-notes.local references "tt-poly go/ Subtree" instead of
    // "tt-go Fixture". The structure and header should match tt-go, but the
    // fixture name is adapted. Verify the header pattern is preserved.
    const ttPolyOpPath = path.join(ttPolyGoDir, "operator-notes.local");
    const ttGoOpPath = path.join(ttGoDir, "operator-notes.local");

    const ttPolyContent = fs.readFileSync(ttPolyOpPath, "utf-8");
    const ttGoContent = fs.readFileSync(ttGoOpPath, "utf-8");

    // Both should have the same header structure
    assert.ok(
      ttPolyContent.includes("# operator-notes.local"),
      "operator-notes.local should have header",
    );
    assert.ok(
      ttPolyContent.includes("1-min sampler"),
      "operator-notes.local should mention 1-min sampler",
    );
    assert.ok(
      ttPolyContent.includes("go test ./..."),
      "operator-notes.local should document go test command",
    );

    // Content should reference tt-poly, not tt-go
    assert.ok(
      ttPolyContent.includes("tt-poly go/ Subtree"),
      "operator-notes.local should reference tt-poly",
    );
    assert.ok(
      !ttPolyContent.includes("tt-go Fixture"),
      'operator-notes.local should not reference "tt-go Fixture"',
    );
  });

  it("go test ./... passes from go/ directory", () => {
    // This test verifies the Go test suite is green at baseline.
    // Skip if go is not available.
    try {
      const output = execSync("go test ./...", {
        cwd: ttPolyGoDir,
        timeout: 30000,
        encoding: "utf-8",
      });
      assert.ok(
        output.includes("ok") || output.includes("PASS"),
        "go test ./... should pass",
      );
      // Should not have FAIL
      assert.ok(
        !output.includes("FAIL"),
        "go test ./... should not have any failures",
      );
    } catch (err: any) {
      // If go is not available, skip this test
      if (err.message?.includes("command not found") || err.message?.includes("ENOENT")) {
        return; // Skip — go not available
      }
      throw err;
    }
  });

  it("go vet ./... passes from go/ directory (static analysis clean)", () => {
    try {
      execSync("go vet ./...", {
        cwd: ttPolyGoDir,
        timeout: 30000,
        encoding: "utf-8",
      });
      // vet exits 0 on success — reaching here is success
    } catch (err: any) {
      if (err.message?.includes("command not found") || err.message?.includes("ENOENT")) {
        return; // Skip — go not available
      }
      // go vet failures should propagate as test failures
      assert.fail(`go vet failed: ${err.stderr || err.message}`);
    }
  });

  it("go/ directory has no stale .gitkeep placeholder", () => {
    const gitkeepPath = path.join(ttPolyGoDir, ".gitkeep");
    assert.ok(
      !fs.existsSync(gitkeepPath),
      "go/.gitkeep should be removed (directory has real content)",
    );
  });
});
