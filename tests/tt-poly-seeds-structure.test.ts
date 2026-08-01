import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttPolyDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly",
);
const seedsDir = path.join(ttPolyDir, "seeds");

// Helpers
const dirs = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

const entries = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).map((e) => e.name);

const filesOnly = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);

describe("tt-poly seeds/ directory structure (US-010)", () => {
  it("tt-poly/seeds/ directory exists", () => {
    assert.ok(fs.existsSync(seedsDir), "seeds/ should exist");
    assert.ok(fs.statSync(seedsDir).isDirectory(), "seeds/ should be a directory");
  });

  it("seeds/ has all 5 subtree directories", () => {
    const subs = dirs(seedsDir);
    for (const lang of ["python", "ts", "go", "rust", "java"]) {
      assert.ok(subs.includes(lang), `seeds/ should contain ${lang}/ subdirectory`);
    }
  });

  // --- python/ seeds ---
  describe("python/ seeds", () => {
    const pySeeds = path.join(seedsDir, "python");

    it("python/ seed directory exists", () => {
      assert.ok(fs.existsSync(pySeeds));
    });

    const expectedPySeeds = [
      "POLY-BUG-P1", "POLY-BUG-P2", "POLY-BUG-P3", "POLY-BUG-P4",
      "POLY-VULN-P1", "POLY-VULN-P2",
      "POLY-BRK-P1", "POLY-BRK-P2",
      "POLY-FLAKY-P1",
    ];

    it("has all POLY-P* seed directories", () => {
      const subs = dirs(pySeeds);
      for (const seed of expectedPySeeds) {
        assert.ok(subs.includes(seed), `python seeds should contain ${seed}`);
      }
    });

    for (const seed of expectedPySeeds) {
      it(`${seed} has overlay file(s)`, () => {
        const seedDir = path.join(pySeeds, seed);
        const files = entries(seedDir);
        // Every seed dir must have at least one file that is NOT fix.patch
        const overlays = files.filter((f) => f !== "fix.patch");
        assert.ok(overlays.length > 0, `${seed} should have at least one overlay file, got: ${files.join(", ")}`);
      });

      // POLY-FLAKY-P1 has no fix.patch (it's a flaky test probe)
      if (seed !== "POLY-FLAKY-P1") {
        it(`${seed} has fix.patch`, () => {
          const fixPatch = path.join(pySeeds, seed, "fix.patch");
          assert.ok(fs.existsSync(fixPatch), `${seed} should have fix.patch`);
        });
      }
    }

    // POLY-FLAKY-P1: conftest.py is the arming overlay, no fix.patch
    it("POLY-FLAKY-P1 has conftest.py arming overlay and no fix.patch", () => {
      assert.ok(
        fs.existsSync(path.join(pySeeds, "POLY-FLAKY-P1", "conftest.py")),
        "POLY-FLAKY-P1 should have conftest.py",
      );
      assert.ok(
        !fs.existsSync(path.join(pySeeds, "POLY-FLAKY-P1", "fix.patch")),
        "POLY-FLAKY-P1 should NOT have fix.patch",
      );
    });
  });

  // --- ts/ seeds ---
  describe("ts/ seeds", () => {
    const tsSeeds = path.join(seedsDir, "ts");

    it("ts/ seed directory exists", () => {
      assert.ok(fs.existsSync(tsSeeds));
    });

    const expectedTsPatches = [
      "POLY-BUG-T1.patch", "POLY-BUG-T2.patch", "POLY-BUG-T3.patch", "POLY-BUG-T4.patch",
      "POLY-BRK-T1.patch", "POLY-BRK-T2.patch",
      "POLY-BUG-T1-T4-combined.patch",
    ];

    it("has all POLY-T* .patch files", () => {
      const files = filesOnly(tsSeeds);
      for (const patch of expectedTsPatches) {
        assert.ok(files.includes(patch), `ts seeds should contain ${patch}`);
      }
    });

    it("has fix/ directory", () => {
      const fixDir = path.join(tsSeeds, "fix");
      assert.ok(fs.existsSync(fixDir), "ts seeds should have fix/ directory");
      assert.ok(fs.statSync(fixDir).isDirectory());
    });

    it("fix/ has all expected fix patches", () => {
      const fixDir = path.join(tsSeeds, "fix");
      const expectedFixes = [
        "POLY-BUG-T1-fix.patch", "POLY-BUG-T2-fix.patch",
        "POLY-BUG-T3-fix.patch", "POLY-BUG-T4-fix.patch",
        "POLY-BRK-T1-fix.patch", "POLY-BRK-T2-fix.patch",
        "POLY-VULN-T1-fix.patch", "POLY-VULN-T2-fix.patch",
      ];
      const files = filesOnly(fixDir);
      for (const fix of expectedFixes) {
        assert.ok(files.includes(fix), `fix/ should contain ${fix}`);
      }
    });
  });

  // --- go/ seeds ---
  describe("go/ seeds", () => {
    const goSeeds = path.join(seedsDir, "go");

    it("go/ seed directory exists", () => {
      assert.ok(fs.existsSync(goSeeds));
    });

    const expectedGoSeeds = [
      "POLY-BUG-G1", "POLY-BUG-G2", "POLY-BUG-G3", "POLY-BUG-G4",
      "POLY-VULN-G1", "POLY-VULN-G2",
      "POLY-BRK-G1", "POLY-BRK-G2",
    ];

    it("has all POLY-G* seed directories", () => {
      const subs = dirs(goSeeds);
      for (const seed of expectedGoSeeds) {
        assert.ok(subs.includes(seed), `go seeds should contain ${seed}`);
      }
    });

    for (const seed of expectedGoSeeds) {
      it(`${seed} has overlay file(s) and fix.patch`, () => {
        const seedDir = path.join(goSeeds, seed);
        const files = entries(seedDir);
        const overlays = files.filter((f) => f !== "fix.patch");
        assert.ok(overlays.length > 0, `${seed} should have at least one overlay file`);
        assert.ok(files.includes("fix.patch"), `${seed} should have fix.patch`);
      });
    }

    // Specific overlay target mappings
    it("POLY-BUG-G1 overlay targets pool.go", () => {
      assert.ok(
        fs.existsSync(path.join(goSeeds, "POLY-BUG-G1", "pool.go")),
        "POLY-BUG-G1 should have pool.go",
      );
    });

    it("POLY-BUG-G2 overlay targets pool.go + worker.go", () => {
      assert.ok(
        fs.existsSync(path.join(goSeeds, "POLY-BUG-G2", "pool.go")),
        "POLY-BUG-G2 should have pool.go",
      );
      assert.ok(
        fs.existsSync(path.join(goSeeds, "POLY-BUG-G2", "worker.go")),
        "POLY-BUG-G2 should have worker.go",
      );
    });

    it("POLY-VULN-G1 overlay targets util/command.go", () => {
      assert.ok(
        fs.existsSync(path.join(goSeeds, "POLY-VULN-G1", "util_command.go")),
        "POLY-VULN-G1 should have util_command.go",
      );
    });

    it("POLY-VULN-G2 overlay targets util/archive.go", () => {
      assert.ok(
        fs.existsSync(path.join(goSeeds, "POLY-VULN-G2", "util_archive.go")),
        "POLY-VULN-G2 should have util_archive.go",
      );
    });
  });

  // --- rust/ seeds ---
  describe("rust/ seeds", () => {
    const rustSeeds = path.join(seedsDir, "rust");

    it("rust/ seed directory exists", () => {
      assert.ok(fs.existsSync(rustSeeds));
    });

    const expectedRustSeeds = [
      "POLY-BUG-R1", "POLY-BUG-R2", "POLY-BUG-R3", "POLY-BUG-R4",
      "POLY-VULN-R1", "POLY-VULN-R2",
      "POLY-BRK-R1", "POLY-BRK-R2",
    ];

    it("has all POLY-R* seed directories", () => {
      const subs = dirs(rustSeeds);
      for (const seed of expectedRustSeeds) {
        assert.ok(subs.includes(seed), `rust seeds should contain ${seed}`);
      }
    });

    for (const seed of expectedRustSeeds) {
      it(`${seed} has overlay file(s) and fix.patch`, () => {
        const seedDir = path.join(rustSeeds, seed);
        const files = entries(seedDir);
        const overlays = files.filter((f) => f !== "fix.patch");
        assert.ok(overlays.length > 0, `${seed} should have at least one overlay file`);
        assert.ok(files.includes("fix.patch"), `${seed} should have fix.patch`);
      });
    }

    // Specific overlay target mappings
    it("POLY-BUG-R1 overlay targets bucket.rs", () => {
      assert.ok(
        fs.existsSync(path.join(rustSeeds, "POLY-BUG-R1", "bucket.rs")),
        "POLY-BUG-R1 should have bucket.rs",
      );
    });

    it("POLY-BUG-R2 overlay targets bucket.rs + config.rs (two-module bug)", () => {
      assert.ok(
        fs.existsSync(path.join(rustSeeds, "POLY-BUG-R2", "bucket.rs")),
        "POLY-BUG-R2 should have bucket.rs",
      );
      assert.ok(
        fs.existsSync(path.join(rustSeeds, "POLY-BUG-R2", "config.rs")),
        "POLY-BUG-R2 should have config.rs",
      );
    });

    it("POLY-VULN-R1 overlay targets util_unsafe.rs", () => {
      assert.ok(
        fs.existsSync(path.join(rustSeeds, "POLY-VULN-R1", "util_unsafe.rs")),
        "POLY-VULN-R1 should have util_unsafe.rs",
      );
    });

    it("POLY-VULN-R2 overlay targets util_timing.rs", () => {
      assert.ok(
        fs.existsSync(path.join(rustSeeds, "POLY-VULN-R2", "util_timing.rs")),
        "POLY-VULN-R2 should have util_timing.rs",
      );
    });

    it("POLY-BRK-R1 and POLY-BRK-R2 overlay target integration.rs", () => {
      assert.ok(
        fs.existsSync(path.join(rustSeeds, "POLY-BRK-R1", "integration.rs")),
        "POLY-BRK-R1 should have integration.rs",
      );
      assert.ok(
        fs.existsSync(path.join(rustSeeds, "POLY-BRK-R2", "integration.rs")),
        "POLY-BRK-R2 should have integration.rs",
      );
    });
  });

  // --- java/ seeds ---
  describe("java/ seeds", () => {
    const javaSeeds = path.join(seedsDir, "java");

    it("java/ seed directory exists", () => {
      assert.ok(fs.existsSync(javaSeeds));
    });

    const expectedJavaPatches = [
      "POLY-BUG-J1.patch", "POLY-BUG-J2.patch", "POLY-BUG-J3.patch", "POLY-BUG-J4.patch",
      "POLY-BRK-J1.patch", "POLY-BRK-J2.patch",
    ];

    it("has all POLY-J* .patch files", () => {
      const files = filesOnly(javaSeeds);
      for (const patch of expectedJavaPatches) {
        assert.ok(files.includes(patch), `java seeds should contain ${patch}`);
      }
    });

    it("has fix/ directory", () => {
      const fixDir = path.join(javaSeeds, "fix");
      assert.ok(fs.existsSync(fixDir), "java seeds should have fix/ directory");
      assert.ok(fs.statSync(fixDir).isDirectory());
    });

    it("fix/ has all expected fix patches", () => {
      const fixDir = path.join(javaSeeds, "fix");
      const expectedFixes = [
        "POLY-BUG-J1-fix.patch", "POLY-BUG-J2-fix.patch",
        "POLY-BUG-J3-fix.patch", "POLY-BUG-J4-fix.patch",
        "POLY-BRK-J1-fix.patch", "POLY-BRK-J2-fix.patch",
        "POLY-VULN-J1-fix.patch", "POLY-VULN-J2-fix.patch",
      ];
      const files = filesOnly(fixDir);
      for (const fix of expectedFixes) {
        assert.ok(files.includes(fix), `fix/ should contain ${fix}`);
      }
    });
  });

  // --- Cross-subtree consistency ---
  describe("cross-subtree consistency", () => {
    it("all seed IDs use POLY- prefix", () => {
      const allSeedNames: string[] = [];
      for (const lang of ["python", "ts", "go", "rust", "java"]) {
        const langDir = path.join(seedsDir, lang);
        if (!fs.existsSync(langDir)) continue;

        if (lang === "ts" || lang === "java") {
          // Patch-based — seed names are .patch filenames
          for (const f of entries(langDir)) {
            if (f.endsWith(".patch") && !f.includes("-fix")) {
              allSeedNames.push(f);
            }
          }
        } else {
          // Directory-based
          for (const d of dirs(langDir)) {
            allSeedNames.push(d);
          }
        }
      }

      for (const name of allSeedNames) {
        // Strip .patch suffix for patch-based seeds
        const seedId = name.replace(/\.patch$/, "");
        assert.ok(
          seedId.startsWith("POLY-"),
          `seed ID "${seedId}" should start with POLY-`,
        );
      }
    });

    it("no old non-POLY IDs remain (BUG-G*, BUG-R*, BUG-J*, BRK-G*, etc.)", () => {
      const badPattern = /^(BUG-[GJR]|VULN-[GJR]|BRK-[GJR])/i;
      const allSeedNames: string[] = [];
      for (const lang of ["python", "ts", "go", "rust", "java"]) {
        const langDir = path.join(seedsDir, lang);
        if (!fs.existsSync(langDir)) continue;

        if (lang === "ts" || lang === "java") {
          for (const f of entries(langDir)) {
            if (f.endsWith(".patch") && !f.includes("-fix")) {
              allSeedNames.push(f);
            }
          }
        } else {
          for (const d of dirs(langDir)) {
            allSeedNames.push(d);
          }
        }
      }

      for (const name of allSeedNames) {
        const seedId = name.replace(/\.patch$/, "");
        assert.ok(
          !badPattern.test(seedId),
          `seed "${seedId}" should use POLY- prefix, not old BUG/VULN/BRK- prefix`,
        );
      }
    });

    it("go/ and rust/ SEEDS.md files present for per-subtree documentation", () => {
      for (const lang of ["go", "rust", "java"]) {
        const seedsMd = path.join(seedsDir, lang, "SEEDS.md");
        assert.ok(fs.existsSync(seedsMd), `${lang}/ seeds should have SEEDS.md`);
      }
    });

    it("python/ and ts/ do NOT have per-subtree SEEDS.md (documented in tt-poly-lite)", () => {
      for (const lang of ["python", "ts"]) {
        const seedsMd = path.join(seedsDir, lang, "SEEDS.md");
        assert.ok(!fs.existsSync(seedsMd), `${lang} seeds should NOT have SEEDS.md (documented in parent fixture)`);
      }
    });

    it("seeds/ content matches per-subtree seeds/ content byte-for-byte", () => {
      // For each subtree, compare the files in seeds/<lang>/ with <lang>/seeds/
      for (const lang of ["python", "ts", "go", "rust", "java"]) {
        const topSeeds = path.join(seedsDir, lang);
        const subSeeds = path.join(ttPolyDir, lang, "seeds");

        const collectRelative = (dir: string, base: string): string[] => {
          const result: string[] = [];
          const walk = (d: string) => {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
              const full = path.join(d, entry.name);
              if (entry.isDirectory()) {
                walk(full);
              } else {
                result.push(path.relative(base, full));
              }
            }
          };
          walk(dir);
          return result;
        };

        const topFiles = collectRelative(topSeeds, topSeeds).sort();
        const subFiles = collectRelative(subSeeds, subSeeds).sort();

        // Check all top-level files exist in subtree
        for (const f of topFiles) {
          assert.ok(
            subFiles.includes(f),
            `${lang}/ seeds: top-level file "${f}" missing from subtree seeds`,
          );
        }
        // Check all subtree files exist in top-level
        for (const f of subFiles) {
          assert.ok(
            topFiles.includes(f),
            `${lang}/ seeds: subtree file "${f}" missing from top-level seeds`,
          );
        }

        // Byte-identical check
        for (const f of topFiles) {
          const topPath = path.join(topSeeds, f);
          const subPath = path.join(subSeeds, f);
          const topContent = fs.readFileSync(topPath);
          const subContent = fs.readFileSync(subPath);
          assert.deepStrictEqual(
            topContent,
            subContent,
            `${lang}/ seeds: file "${f}" differs between top-level and subtree`,
          );
        }
      }
    });
  });
});
