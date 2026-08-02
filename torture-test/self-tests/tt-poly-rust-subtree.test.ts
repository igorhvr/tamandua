import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttPolyRustDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly",
  "rust",
);
const ttRustDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-rust",
);

// Helper: ensure self-tests scratch parent exists, then create a unique subdir.
// Follows the FIX6 pattern from tt-poly-build-golden.test.ts.
function makeScratchDir(prefix: string): string {
  const parent = path.join(repoRoot, "torture-test", "var", "self-tests");
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

describe("tt-poly rust/ subtree integration (US-005)", () => {
  it("rust/ directory exists and contains all Rust source files from tt-rust fixture", () => {
    assert.ok(
      fs.existsSync(ttPolyRustDir),
      "tt-poly/rust/ should exist",
    );
    assert.ok(
      fs.statSync(ttPolyRustDir).isDirectory(),
      "tt-poly/rust/ should be a directory",
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

    const sourceFiles = collectFiles(ttRustDir);
    const destFiles = collectFiles(ttPolyRustDir);

    // Exclude files that are tt-rust-specific (not copied to tt-poly)
    // and .gitkeep (placeholder only).
    const excludedFiles = new Set([
      "build-golden.sh",
      "README.md",
      ".gitignore",
      "FIXTURE.md",
    ]);

    // Map old seed directory names to POLY-* names for the file parity check.
    // The source (tt-rust) uses BUG-R*, BRK-R*, VULN-R* but tt-poly renames
    // them to POLY-BUG-R*, POLY-BRK-R*, POLY-VULN-R*.
    const remapSeedDir = (f: string): string => {
      f = f.replace(/^seeds\/BUG-R/g, "seeds/POLY-BUG-R");
      f = f.replace(/^seeds\/BRK-R/g, "seeds/POLY-BRK-R");
      f = f.replace(/^seeds\/VULN-R/g, "seeds/POLY-VULN-R");
      return f;
    };

    for (const f of sourceFiles) {
      if (excludedFiles.has(f)) continue;
      if (path.basename(f) === ".gitkeep") continue;
      const remapped = remapSeedDir(f);
      assert.ok(
        destFiles.has(remapped),
        `tt-poly/rust/${remapped} should exist (from tt-rust/${f})`,
      );
    }
  });

  it("FIXTURE.md references tt-poly, not tt-rust", () => {
    const mdPath = path.join(ttPolyRustDir, "FIXTURE.md");
    assert.ok(fs.existsSync(mdPath), "FIXTURE.md should exist");

    const content = fs.readFileSync(mdPath, "utf-8");
    assert.ok(
      content.includes("tt-poly rust/ Subtree Seeded Content"),
      'FIXTURE.md title should reference "tt-poly rust/ Subtree"',
    );
    assert.ok(
      content.includes("tt-poly five-language storm monorepo"),
      "FIXTURE.md should mention tt-poly five-language storm monorepo",
    );
    // Must reference POLY-R* naming (re-ID'd from BUG-R*)
    assert.ok(
      content.includes("POLY-BUG-R1"),
      "FIXTURE.md should document POLY-BUG-R1",
    );
    assert.ok(
      content.includes("POLY-VULN-R1"),
      "FIXTURE.md should document POLY-VULN-R1",
    );
    assert.ok(
      content.includes("POLY-BRK-R1"),
      "FIXTURE.md should document POLY-BRK-R1",
    );
  });

  it("rust/Cargo.toml and rust/Cargo.lock present", () => {
    const tomlPath = path.join(ttPolyRustDir, "Cargo.toml");
    assert.ok(fs.existsSync(tomlPath), "Cargo.toml should exist");

    const tomlContent = fs.readFileSync(tomlPath, "utf-8");
    assert.ok(tomlContent.includes("ttrust"), 'Cargo.toml should declare package name "ttrust"');
    assert.ok(tomlContent.includes('edition = "2021"'), "Cargo.toml should specify edition 2021");

    const lockPath = path.join(ttPolyRustDir, "Cargo.lock");
    assert.ok(fs.existsSync(lockPath), "Cargo.lock should exist (committed for deterministic builds)");
  });

  it("rust/src/ contains lib.rs, bucket.rs, config.rs, util_unsafe.rs, util_timing.rs", () => {
    const requiredFiles = [
      "lib.rs",
      "bucket.rs",
      "config.rs",
      "util_unsafe.rs",
      "util_timing.rs",
    ];

    for (const f of requiredFiles) {
      const fPath = path.join(ttPolyRustDir, "src", f);
      assert.ok(fs.existsSync(fPath), `rust/src/${f} should exist`);
      assert.ok(fs.statSync(fPath).isFile(), `rust/src/${f} should be a file`);
    }
  });

  it("rust/src/lib.rs declares all modules and re-exports", () => {
    const libPath = path.join(ttPolyRustDir, "src", "lib.rs");
    const content = fs.readFileSync(libPath, "utf-8");

    // Module declarations
    assert.ok(content.includes("mod bucket;"), "lib.rs should declare bucket module");
    assert.ok(content.includes("mod config;"), "lib.rs should declare config module");
    assert.ok(content.includes("mod util_timing;"), "lib.rs should declare util_timing module (dormant vuln)");
    assert.ok(content.includes("mod util_unsafe;"), "lib.rs should declare util_unsafe module (dormant vuln)");

    // Re-exports
    assert.ok(content.includes("use bucket::TokenBucket;"), "lib.rs should re-export TokenBucket");
    assert.ok(content.includes("use config::RateLimiterConfig;"), "lib.rs should re-export RateLimiterConfig");
  });

  it("rust/src/bucket.rs defines TokenBucket with atomic-based rate limiter", () => {
    const bucketPath = path.join(ttPolyRustDir, "src", "bucket.rs");
    const content = fs.readFileSync(bucketPath, "utf-8");

    // Core types and methods
    assert.ok(content.includes("TokenBucket"), "bucket.rs should define TokenBucket struct");
    assert.ok(content.includes("AtomicU32"), "bucket.rs should use AtomicU32 (lock-free)");
    assert.ok(content.includes("AtomicU64"), "bucket.rs should use AtomicU64 (monotonic clock)");
    assert.ok(content.includes("fn new("), "bucket.rs should define new()");
    assert.ok(content.includes("fn try_consume("), "bucket.rs should define try_consume()");
    assert.ok(content.includes("fn refill("), "bucket.rs should define refill()");
    assert.ok(content.includes("fn available("), "bucket.rs should define available()");
    assert.ok(content.includes("fn reset("), "bucket.rs should define reset()");
    assert.ok(content.includes("#[cfg(test)]"), "bucket.rs should have cfg(test) module with unit tests");
  });

  it("rust/src/config.rs defines RateLimiterConfig with builder methods", () => {
    const configPath = path.join(ttPolyRustDir, "src", "config.rs");
    const content = fs.readFileSync(configPath, "utf-8");

    assert.ok(content.includes("RateLimiterConfig"), "config.rs should define RateLimiterConfig");
    assert.ok(content.includes("max_tokens"), "config.rs should have max_tokens field");
    assert.ok(content.includes("refill_rate"), "config.rs should have refill_rate field");
    assert.ok(content.includes("refill_interval_ms"), "config.rs should have refill_interval_ms field");
    assert.ok(content.includes("burst_size"), "config.rs should have burst_size field");
    assert.ok(content.includes("fn with_burst_size"), "config.rs should define with_burst_size() builder");
    assert.ok(content.includes("fn with_refill_interval"), "config.rs should define with_refill_interval() builder");
    assert.ok(content.includes("#[cfg(test)]"), "config.rs should have cfg(test) module with unit tests");
  });

  it("rust/src/util_unsafe.rs is a dormant vuln module with unsafe pointer operations", () => {
    const utilUnsafePath = path.join(ttPolyRustDir, "src", "util_unsafe.rs");
    const content = fs.readFileSync(utilUnsafePath, "utf-8");

    // Must contain unsafe code (the dormant vulnerability)
    assert.ok(content.includes("get_unchecked"), "util_unsafe.rs should define get_unchecked");
    assert.ok(content.includes("set_unchecked"), "util_unsafe.rs should define set_unchecked");
    assert.ok(
      content.includes("unsafe"),
      "util_unsafe.rs should contain unsafe blocks (dormant vuln)",
    );
    // Should have its own tests
    assert.ok(content.includes("#[cfg(test)]"), "util_unsafe.rs should have cfg(test) module with unit tests");
  });

  it("rust/src/util_timing.rs is a dormant vuln module with timing side-channel", () => {
    const utilTimingPath = path.join(ttPolyRustDir, "src", "util_timing.rs");
    const content = fs.readFileSync(utilTimingPath, "utf-8");

    // Must contain timing-unsafe comparison (the dormant vulnerability)
    assert.ok(
      content.includes("timing_unsafe_compare"),
      "util_timing.rs should define timing_unsafe_compare",
    );
    // Should have its own tests
    assert.ok(content.includes("#[cfg(test)]"), "util_timing.rs should have cfg(test) module with unit tests");
  });

  it("rust/tests/integration.rs present", () => {
    const intPath = path.join(ttPolyRustDir, "tests", "integration.rs");
    assert.ok(fs.existsSync(intPath), "tests/integration.rs should exist");

    const content = fs.readFileSync(intPath, "utf-8");
    assert.ok(content.includes("TokenBucket"), "integration.rs should import TokenBucket");
    assert.ok(content.includes("RateLimiterConfig"), "integration.rs should import RateLimiterConfig");
    assert.ok(content.includes("#[test]"), "integration.rs should have test functions");
  });

  it("operator-notes.local exists in rust/ subtree", () => {
    const opNotesPath = path.join(ttPolyRustDir, "operator-notes.local");
    assert.ok(
      fs.existsSync(opNotesPath),
      "operator-notes.local should exist in rust/",
    );

    const content = fs.readFileSync(opNotesPath, "utf-8");
    assert.ok(content.length > 0, "operator-notes.local should not be empty");
    assert.ok(
      content.includes("TAMANDUA-TT-POLY-RUST-OPERATOR-NOTES") ||
        content.includes("Operator Notes — tt-poly rust/ Subtree"),
      "operator-notes.local should reference tt-poly rust/",
    );
  });

  it("JUNK-IS-INTENTIONAL.md exists in rust/ subtree", () => {
    const junkPath = path.join(ttPolyRustDir, "JUNK-IS-INTENTIONAL.md");
    assert.ok(fs.existsSync(junkPath), "JUNK-IS-INTENTIONAL.md should exist in rust/");

    const content = fs.readFileSync(junkPath, "utf-8");
    assert.ok(
      content.includes("Do NOT clean up"),
      "JUNK-IS-INTENTIONAL.md should warn against cleanup",
    );
    assert.ok(
      content.includes("target/"),
      "JUNK-IS-INTENTIONAL.md should mention target/ junk probe",
    );
    assert.ok(
      content.includes("operator-notes.local"),
      "JUNK-IS-INTENTIONAL.md should mention operator-notes.local",
    );
  });

  it("README-JUNK.md exists in rust/ subtree", () => {
    const junkPath = path.join(ttPolyRustDir, "README-JUNK.md");
    assert.ok(fs.existsSync(junkPath), "README-JUNK.md should exist in rust/");

    const content = fs.readFileSync(junkPath, "utf-8");
    assert.ok(
      content.includes("Cargo.lock"),
      "README-JUNK.md should mention Cargo.lock is tracked",
    );
    assert.ok(
      content.includes("operator-notes.local"),
      "README-JUNK.md should document operator-notes.local",
    );
    assert.ok(
      content.includes("target/"),
      "README-JUNK.md should document target/ junk probe",
    );
  });

  it("seeds/ directory contains POLY-R* seed directories with overlay files and fix patches", () => {
    const seedsDir = path.join(ttPolyRustDir, "seeds");
    assert.ok(fs.existsSync(seedsDir), "seeds/ should exist");

    const seedDirs = [
      "POLY-BUG-R1",
      "POLY-BUG-R2",
      "POLY-BUG-R3",
      "POLY-BUG-R4",
      "POLY-VULN-R1",
      "POLY-VULN-R2",
      "POLY-BRK-R1",
      "POLY-BRK-R2",
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

    // Check POLY-BUG-R1 has bucket.rs overlay
    const bugR1Dir = path.join(seedsDir, "POLY-BUG-R1");
    assert.ok(
      fs.existsSync(path.join(bugR1Dir, "bucket.rs")),
      "seeds/POLY-BUG-R1/bucket.rs should exist",
    );

    // Check POLY-BUG-R2 has both bucket.rs and config.rs overlays
    const bugR2Dir = path.join(seedsDir, "POLY-BUG-R2");
    assert.ok(
      fs.existsSync(path.join(bugR2Dir, "bucket.rs")),
      "seeds/POLY-BUG-R2/bucket.rs should exist",
    );
    assert.ok(
      fs.existsSync(path.join(bugR2Dir, "config.rs")),
      "seeds/POLY-BUG-R2/config.rs should exist",
    );

    // Check POLY-VULN-R1 has util_unsafe.rs
    const vulnR1Dir = path.join(seedsDir, "POLY-VULN-R1");
    assert.ok(
      fs.existsSync(path.join(vulnR1Dir, "util_unsafe.rs")),
      "seeds/POLY-VULN-R1/util_unsafe.rs should exist",
    );

    // Check POLY-VULN-R2 has util_timing.rs
    const vulnR2Dir = path.join(seedsDir, "POLY-VULN-R2");
    assert.ok(
      fs.existsSync(path.join(vulnR2Dir, "util_timing.rs")),
      "seeds/POLY-VULN-R2/util_timing.rs should exist",
    );

    // Check POLY-BRK-R1 has integration.rs
    const brkR1Dir = path.join(seedsDir, "POLY-BRK-R1");
    assert.ok(
      fs.existsSync(path.join(brkR1Dir, "integration.rs")),
      "seeds/POLY-BRK-R1/integration.rs should exist",
    );

    // Check SEEDS.md exists
    assert.ok(
      fs.existsSync(path.join(seedsDir, "SEEDS.md")),
      "seeds/SEEDS.md should exist",
    );
  });

  it("seeds/SEEDS.md documents POLY-R* IDs (not old BUG-R* IDs)", () => {
    const seedsMdPath = path.join(ttPolyRustDir, "seeds", "SEEDS.md");
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    // Must use POLY-R* naming
    assert.ok(content.includes("POLY-BUG-R1"), "SEEDS.md should document POLY-BUG-R1");
    assert.ok(content.includes("POLY-BUG-R4"), "SEEDS.md should document POLY-BUG-R4");
    assert.ok(content.includes("POLY-VULN-R1"), "SEEDS.md should document POLY-VULN-R1");
    assert.ok(content.includes("POLY-VULN-R2"), "SEEDS.md should document POLY-VULN-R2");
    assert.ok(content.includes("POLY-BRK-R1"), "SEEDS.md should document POLY-BRK-R1");
    assert.ok(content.includes("POLY-BRK-R2"), "SEEDS.md should document POLY-BRK-R2");

    // Should reference tt-poly context
    assert.ok(
      content.includes("tt-poly rust/ Subtree Seed Catalog") ||
      content.includes("tt-poly rust/"),
      "SEEDS.md should reference tt-poly",
    );

    // Should NOT use old BUG-R* naming alone (without POLY- prefix)
    // Verify the seed IDs are prefixed with POLY-. Use negative lookbehind
    // to avoid matching BUG-R1 within POLY-BUG-R1.
    assert.ok(
      !/(?<!POLY-)BUG-R1\b/m.test(content),
      "SEEDS.md should not have unreplaced BUG-R1 references",
    );
    assert.ok(
      !/(?<!POLY-)VULN-R1\b/m.test(content),
      "SEEDS.md should not have unreplaced VULN-R1 references",
    );
  });

  it("cargo test --quiet passes from a scratch copy under var/self-tests/", () => {
    const scratchDir = makeScratchDir("tt-poly-rust-");
    try {
      const scratchRustDir = path.join(scratchDir, "rust");
      fs.cpSync(ttPolyRustDir, scratchRustDir, { recursive: true });
      try {
        const output = execSync("cargo test --quiet", {
          cwd: scratchRustDir,
          timeout: 120000,
          encoding: "utf-8",
        });
        // Should have passing test results
        assert.ok(
          output.includes("passed") || output.includes("test result: ok"),
          "cargo test should pass",
        );
        // Should not have FAIL
        assert.ok(
          !output.includes("FAILED"),
          "cargo test should not have any failures",
        );
      } catch (err: any) {
        // If cargo is not available, skip this test
        if (err.message?.includes("command not found") || err.message?.includes("ENOENT")) {
          return; // Skip — cargo not available
        }
        throw err;
      }
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("cargo check passes from a scratch copy under var/self-tests/ (typecheck)", () => {
    const scratchDir = makeScratchDir("tt-poly-rust-");
    try {
      const scratchRustDir = path.join(scratchDir, "rust");
      fs.cpSync(ttPolyRustDir, scratchRustDir, { recursive: true });
      try {
        execSync("cargo check", {
          cwd: scratchRustDir,
          timeout: 120000,
          encoding: "utf-8",
        });
        // cargo check exits 0 on success
      } catch (err: any) {
        if (err.message?.includes("command not found") || err.message?.includes("ENOENT")) {
          return; // Skip — cargo not available
        }
        assert.fail(`cargo check failed: ${err.stderr || err.message}`);
      }
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("rust/ directory has no stale .gitkeep placeholder", () => {
    const gitkeepPath = path.join(ttPolyRustDir, ".gitkeep");
    assert.ok(
      !fs.existsSync(gitkeepPath),
      "rust/.gitkeep should be removed (directory has real content)",
    );
  });
});
