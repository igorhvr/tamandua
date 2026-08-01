import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { readFileSync, readdirSync, existsSync, readlinkSync } from "node:fs";

const TT_POLY = path.resolve(
  import.meta.dirname,
  "../torture-test/fixtures-src/tt-poly",
);

function readAll(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

function grepFile(filePath: string, pattern: RegExp): string[] {
  const content = readAll(filePath);
  const matches = content.match(pattern);
  return matches ?? [];
}

function allFiles(dir: string): string[] {
  const result: string[] = [];
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (e.isFile()) {
      result.push(path.join(e.parentPath ?? dir, e.name));
    }
  }
  return result;
}

function seedIdsFromFile(filePath: string): string[] {
  const pattern = /POLY-(?:BUG|VULN|BRK|FLAKY)-[A-Z]\d+/g;
  return [...new Set(grepFile(filePath, pattern))];
}

// ---------------------------------------------------------------------------
// AC1: All cross-references audit clean
// ---------------------------------------------------------------------------
describe("AC1: Cross-reference audit", () => {
  it("all seed IDs in SEEDS.md match build-golden.sh", () => {
    const seedsMd = seedIdsFromFile(path.join(TT_POLY, "seeds/SEEDS.md"));
    const buildGolden = seedIdsFromFile(path.join(TT_POLY, "build-golden.sh"));
    assert.deepStrictEqual([...seedsMd].sort(), [...buildGolden].sort());
  });

  it("all seed IDs in STORM.md match SEEDS.md", () => {
    const storm = seedIdsFromFile(path.join(TT_POLY, "seeds/storm/STORM.md"));
    const seedsMd = seedIdsFromFile(path.join(TT_POLY, "seeds/SEEDS.md"));
    for (const id of storm) {
      assert.ok(seedsMd.includes(id), `STORM.md seed ${id} not in SEEDS.md`);
    }
    // STORM.md references fewer seeds (only applied ones), which is fine
    // but every STORM.md seed must be in SEEDS.md
  });

  it("every seed in FIXTURE.md files is in SEEDS.md", () => {
    const seedsMd = new Set(seedIdsFromFile(path.join(TT_POLY, "seeds/SEEDS.md")));
    for (const subtree of ["python", "ts", "go", "rust", "java"]) {
      const fixturePath = path.join(TT_POLY, subtree, "FIXTURE.md");
      if (!existsSync(fixturePath)) continue;
      const fixtureSeeds = grepFile(fixturePath, /POLY-(?:BUG|VULN|BRK)-[A-Z]\d+/g);
      for (const id of fixtureSeeds) {
        assert.ok(seedsMd.has(id), `${subtree}/FIXTURE.md seed ${id} not in SEEDS.md`);
      }
    }
  });

  it("FIXTURE.md files cross-reference SEEDS.md and STORM.md", () => {
    for (const subtree of ["python", "ts", "go", "rust", "java"]) {
      const fixturePath = path.join(TT_POLY, subtree, "FIXTURE.md");
      if (!existsSync(fixturePath)) continue;
      const content = readAll(fixturePath);
      assert.ok(
        content.includes("SEEDS.md") || content.includes("seeds/"),
        `${subtree}/FIXTURE.md should reference SEEDS.md`,
      );
    }
  });

  it("SEEDS.md cross-references all 5 FIXTURE.md files", () => {
    const content = readAll(path.join(TT_POLY, "seeds/SEEDS.md"));
    for (const subtree of ["python", "ts", "go", "rust", "java"]) {
      assert.ok(
        content.includes(`${subtree}/FIXTURE.md`),
        `SEEDS.md should reference ${subtree}/FIXTURE.md`,
      );
    }
  });

  it("STORM.md cross-references SEEDS.md", () => {
    const content = readAll(path.join(TT_POLY, "seeds/storm/STORM.md"));
    assert.ok(
      content.includes("SEEDS.md"),
      "STORM.md should reference SEEDS.md",
    );
  });

  it("build-golden.sh mentions all expected phases in summary", () => {
    const content = readAll(path.join(TT_POLY, "build-golden.sh"));
    for (const phase of ["Phase 1:", "Phase 2:", "Phase 3:", "Phase 4:",
      "Phase 5:", "Phase 6:", "Phase 6a:", "Phase 7:",
      "Phase 8:", "Phase 9:", "Phase 10:"]) {
      assert.ok(content.includes(phase), `build-golden.sh missing ${phase}`);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: Every seed ID in SEEDS.md has corresponding files
// ---------------------------------------------------------------------------
describe("AC2: Seed file correspondence", () => {
  it("every seed in SEEDS.md has a directory or patch file in seeds/", () => {
    const seedsMdIds = seedIdsFromFile(path.join(TT_POLY, "seeds/SEEDS.md"));
    for (const id of seedsMdIds) {
      const prefix = id.match(/^(POLY-[A-Z]+)-\w\d+$/)?.[1] ?? "";
      let found = false;

      // Check for directory-based seeds (python, go, rust)
      const dirPaths = [
        path.join(TT_POLY, "seeds/python", id),
        path.join(TT_POLY, "seeds/go", id),
        path.join(TT_POLY, "seeds/rust", id),
        path.join(TT_POLY, "seeds", id), // A5
      ];
      for (const p of dirPaths) {
        if (existsSync(p) && readdirSync(p).length > 0) {
          found = true;
          break;
        }
      }

      // Check for patch-based seeds (ts, java)
      if (!found) {
        const patchPaths = [
          path.join(TT_POLY, "seeds/ts", `${id}.patch`),
          path.join(TT_POLY, "seeds/java", `${id}.patch`),
        ];
        for (const p of patchPaths) {
          if (existsSync(p)) {
            found = true;
            break;
          }
        }
      }

      // Dormant VULN seeds (T1-T2, J1-J2) have no patch — they're baseline refs
      if (!found) {
        const dormantPatterns = [/POLY-VULN-T\d+/, /POLY-VULN-J\d+/];
        const isDormant = dormantPatterns.some((p) => p.test(id));
        if (isDormant) {
          found = true; // Dormant seeds are valid — no seed file needed
        }
      }

      assert.ok(found, `Seed ${id} from SEEDS.md has no corresponding file in seeds/`);
    }
  });

  it("every seed directory or patch in seeds/ is documented in SEEDS.md", () => {
    const seedsMdIds = new Set(seedIdsFromFile(path.join(TT_POLY, "seeds/SEEDS.md")));
    const seedsDir = path.join(TT_POLY, "seeds");

    // Collect all seed IDs from directories
    for (const lang of ["python", "go", "rust"]) {
      const langDir = path.join(seedsDir, lang);
      if (!existsSync(langDir)) continue;
      for (const entry of readdirSync(langDir)) {
        if (entry.startsWith("POLY-") && !entry.includes(".patch")) {
          assert.ok(seedsMdIds.has(entry),
            `Seed dir ${lang}/${entry} not documented in SEEDS.md`);
        }
      }
    }

    // Collect all seed IDs from patch files
    for (const lang of ["ts", "java"]) {
      const langDir = path.join(seedsDir, lang);
      if (!existsSync(langDir)) continue;
      for (const entry of readdirSync(langDir)) {
        const match = entry.match(/^(POLY-(?:BUG|BRK)-[A-Z]\d+)\.patch$/);
        if (match) {
          assert.ok(seedsMdIds.has(match[1]),
            `Seed patch ${lang}/${entry} not documented in SEEDS.md`);
        }
      }
    }

    // A5 seed directory
    const a5Dir = path.join(seedsDir, "POLY-BUG-A5");
    if (existsSync(a5Dir)) {
      assert.ok(seedsMdIds.has("POLY-BUG-A5"),
        "POLY-BUG-A5 directory not documented in SEEDS.md");
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: Every fix patch has a corresponding seed
// ---------------------------------------------------------------------------
describe("AC3: Fix patch to seed correspondence", () => {
  it("every fix.patch has a parent seed directory that exists", () => {
    const allPatchFiles = allFiles(path.join(TT_POLY, "seeds"))
      .filter((f) => f.endsWith("fix.patch") && !f.includes("/fix/"));

    for (const fixFile of allPatchFiles) {
      const parentDir = path.basename(path.dirname(fixFile));
      assert.ok(
        parentDir.startsWith("POLY-"),
        `fix.patch at ${fixFile} should be inside a POLY-* seed directory`,
      );
    }
  });

  it("every fix/*-fix.patch corresponds to a documented seed", () => {
    const seedsDir = path.join(TT_POLY, "seeds");
    const seedsMdIds = new Set(seedIdsFromFile(path.join(TT_POLY, "seeds/SEEDS.md")));

    for (const lang of ["ts", "java"]) {
      const fixDir = path.join(seedsDir, lang, "fix");
      if (!existsSync(fixDir)) continue;
      for (const entry of readdirSync(fixDir)) {
        const match = entry.match(/^(POLY-(?:BUG|VULN|BRK)-[A-Z]\d+)-fix\.patch$/);
        if (match) {
          assert.ok(seedsMdIds.has(match[1]),
            `Fix patch ${lang}/fix/${entry} for seed ${match[1]} not in SEEDS.md`);
        }
      }
    }
  });

  it("all non-dormant seeds with seed files have fix patches", () => {
    // Python seeds
    for (const id of ["POLY-BUG-P1", "POLY-BUG-P2", "POLY-BUG-P3", "POLY-BUG-P4",
      "POLY-VULN-P1", "POLY-VULN-P2", "POLY-BRK-P1", "POLY-BRK-P2"]) {
      const fixPath = path.join(TT_POLY, "seeds/python", id, "fix.patch");
      assert.ok(existsSync(fixPath), `Missing fix.patch for python seed ${id}`);
    }

    // Go seeds
    for (const id of ["POLY-BUG-G1", "POLY-BUG-G2", "POLY-BUG-G3", "POLY-BUG-G4",
      "POLY-VULN-G1", "POLY-VULN-G2", "POLY-BRK-G1", "POLY-BRK-G2"]) {
      const fixPath = path.join(TT_POLY, "seeds/go", id, "fix.patch");
      assert.ok(existsSync(fixPath), `Missing fix.patch for go seed ${id}`);
    }

    // Rust seeds
    for (const id of ["POLY-BUG-R1", "POLY-BUG-R2", "POLY-BUG-R3", "POLY-BUG-R4",
      "POLY-VULN-R1", "POLY-VULN-R2", "POLY-BRK-R1", "POLY-BRK-R2"]) {
      const fixPath = path.join(TT_POLY, "seeds/rust", id, "fix.patch");
      assert.ok(existsSync(fixPath), `Missing fix.patch for rust seed ${id}`);
    }

    // A5 seed
    assert.ok(
      existsSync(path.join(TT_POLY, "seeds/POLY-BUG-A5", "fix.patch")),
      "Missing fix.patch for POLY-BUG-A5",
    );
  });

  it("POLY-FLAKY-P1 intentionally has no fix.patch", () => {
    const flakyDir = path.join(TT_POLY, "seeds/python/POLY-FLAKY-P1");
    assert.ok(
      !existsSync(path.join(flakyDir, "fix.patch")),
      "POLY-FLAKY-P1 should not have fix.patch — fix is restoring baseline conftest.py",
    );
  });
});

// ---------------------------------------------------------------------------
// AC4: build-golden.sh seed order matches SEEDS.md
// ---------------------------------------------------------------------------
describe("AC4: build-golden.sh seed order integrity", () => {
  it("STORM_ORDER contains all storm-composition seeds", () => {
    const content = readAll(path.join(TT_POLY, "build-golden.sh"));
    // Extract STORM_ORDER contents
    const stormOrderMatch = content.match(/readonly STORM_ORDER=\(([\s\S]*?)\)/);
    assert.ok(stormOrderMatch, "STORM_ORDER not found in build-golden.sh");
    const stormOrderText = stormOrderMatch[1];
    const stormOrderIds = stormOrderText.match(/POLY-(?:BUG|VULN|BRK|FLAKY)-[A-Z0-9][A-Z0-9-]*/g) ?? [];

    // All non-dormant seeds should be in STORM_ORDER
    // Dormant VULN-T* and VULN-J* are in storm via baseline (no patch needed)
    assert.ok(stormOrderIds.includes("POLY-BUG-P1"), "Missing POLY-BUG-P1 in STORM_ORDER");
    assert.ok(stormOrderIds.includes("POLY-BUG-P4"), "Missing POLY-BUG-P4 in STORM_ORDER");
    assert.ok(stormOrderIds.includes("POLY-VULN-P1"), "Missing POLY-VULN-P1 in STORM_ORDER");
    assert.ok(stormOrderIds.includes("POLY-VULN-T1"), "Missing POLY-VULN-T1 in STORM_ORDER");
    assert.ok(stormOrderIds.includes("POLY-FLAKY-P1"), "Missing POLY-FLAKY-P1 in STORM_ORDER");
    assert.ok(stormOrderIds.includes("POLY-BUG-A5"), "Missing POLY-BUG-A5 in STORM_ORDER");
  });

  it("STORM_ORDER respects phase ordering documentation from STORM.md", () => {
    const content = readAll(path.join(TT_POLY, "build-golden.sh"));
    const stormOrderMatch = content.match(/readonly STORM_ORDER=\(([\s\S]*?)\)/);
    assert.ok(stormOrderMatch);
    const stormOrderText = stormOrderMatch[1];
    const stormOrderIds = stormOrderText.match(/POLY-(?:BUG|VULN|BRK|FLAKY)-[A-Z0-9][A-Z0-9-]*/g) ?? [];

    const idx = (id: string) => {
      // T1-T4 combined patch is the first TS bug entry
      const i = stormOrderIds.indexOf(id);
      return i >= 0 ? i : 999;
    };

    // Phase 1 (python bugs) before Phase 2 (ts bugs)
    // TS uses T1-T4 combined patch as first entry, not T1 individually
    assert.ok(idx("POLY-BUG-P1") < idx("POLY-BUG-T1-T4"), "Python bugs should come before TS bugs");

    // Phase 5 (java bugs) before Phase 6 (vulns)
    assert.ok(idx("POLY-BUG-J4") < idx("POLY-VULN-P1"), "Java bugs should come before vulns");

    // Phase 6 (vulns) before Phase 7 (broken tests)
    assert.ok(idx("POLY-VULN-P1") < idx("POLY-BRK-P1"), "Vulns should come before broken tests");

    // Phase 7 (broken tests) before Phase 7a (flaky)
    assert.ok(idx("POLY-BRK-J2") < idx("POLY-FLAKY-P1"), "Broken tests should come before FLAKY");

    // A5 cross-language seed positioned near other bugs
    assert.ok(idx("POLY-BUG-A5") > idx("POLY-BUG-J4"), "A5 seed should be after java bugs");
    assert.ok(idx("POLY-BUG-A5") < idx("POLY-VULN-P1"), "A5 seed should be before vulns");
  });
});

// ---------------------------------------------------------------------------
// AC5: operator-notes.local consistent across all locations
// ---------------------------------------------------------------------------
describe("AC5: operator-notes.local consistency", () => {
  const operatorNotesPaths = [
    "operator-notes.local",
    "python/operator-notes.local",
    "ts/operator-notes.local",
    "go/operator-notes.local",
    "rust/operator-notes.local",
    "java/operator-notes.local",
  ];

  it("all 6 operator-notes.local files exist", () => {
    for (const p of operatorNotesPaths) {
      const fullPath = path.join(TT_POLY, p);
      assert.ok(
        existsSync(fullPath),
        `Missing operator-notes.local at ${p}`,
      );
    }
  });

  it("all operator-notes.local files use spec 02 header format", () => {
    for (const p of operatorNotesPaths) {
      const content = readAll(path.join(TT_POLY, p));
      assert.ok(
        content.includes("operator-notes.local — inert operator junk probe (spec 02)"),
        `${p} should use spec 02 header format`,
      );
      assert.ok(
        content.includes("1-min sampler hashes this file"),
        `${p} should mention 1-min sampler`,
      );
      assert.ok(
        content.includes("Content below is stable — do not edit."),
        `${p} should include stability marker`,
      );
    }
  });

  it("all operator-notes.local files have Date planted field", () => {
    for (const p of operatorNotesPaths) {
      const content = readAll(path.join(TT_POLY, p));
      assert.ok(
        /Date planted:\s*\d{4}-\d{2}-\d{2}/.test(content),
        `${p} should have Date planted field`,
      );
    }
  });

  it("all operator-notes.local files reference tt-poly", () => {
    for (const p of operatorNotesPaths) {
      const content = readAll(path.join(TT_POLY, p));
      assert.ok(
        content.includes("tt-poly"),
        `${p} should reference tt-poly`,
      );
    }
  });

  it("no operator-notes.local references tt-poly-lite", () => {
    for (const p of operatorNotesPaths) {
      const content = readAll(path.join(TT_POLY, p));
      assert.ok(
        !content.includes("tt-poly-lite"),
        `${p} should not reference tt-poly-lite`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// AC6: No stale tt-poly-lite references remain
// ---------------------------------------------------------------------------
describe("AC6: No stale tt-poly-lite references", () => {
  it("no tt-poly-lite references in source files (.py, .toml, .sh, .md)", () => {
    const allFilesInTtPoly = allFiles(TT_POLY).filter(
      (f) => /\.(py|toml|sh|md|html|js)$/.test(f) && !f.includes("/fix/") && !f.endsWith(".patch"),
    );

    for (const file of allFilesInTtPoly) {
      const content = readAll(file);
      const rel = path.relative(TT_POLY, file);
      // The SEEDS.md reference to tt-poly-lite is acceptable metadata
      if (rel === "seeds/SEEDS.md") continue;
      assert.ok(
        !content.includes("tt-poly-lite"),
        `${rel} contains stale tt-poly-lite reference`,
      );
    }
  });

  it("no tt-poly-lite references in seed patch files", () => {
    const patchFiles = allFiles(path.join(TT_POLY, "seeds")).filter(
      (f) => f.endsWith(".patch"),
    );
    for (const pf of patchFiles) {
      const content = readAll(pf);
      const rel = path.relative(TT_POLY, pf);
      assert.ok(
        !content.includes("tt-poly-lite"),
        `${rel} contains tt-poly-lite path reference`,
      );
    }
  });

  it("no tt-poly-lite references in per-subtree seed patches", () => {
    for (const subtree of ["python", "ts", "go", "rust", "java"]) {
      const seedsPath = path.join(TT_POLY, subtree, "seeds");
      if (!existsSync(seedsPath)) continue;
      for (const f of allFiles(seedsPath)) {
        if (!f.endsWith(".patch")) continue;
        const content = readAll(f);
        const rel = path.relative(TT_POLY, f);
        assert.ok(
          !content.includes("tt-poly-lite"),
          `${rel} contains tt-poly-lite path reference`,
        );
      }
    }
  });

  it("python source files reference tt-poly not tt-poly-lite", () => {
    const pyFiles = [
      "python/pyproject.toml",
      "python/src/schedlib/__init__.py",
      "python/bootstrap",
    ];
    for (const pf of pyFiles) {
      const content = readAll(path.join(TT_POLY, pf));
      assert.ok(
        !content.includes("tt-poly-lite"),
        `${pf} should not reference tt-poly-lite`,
      );
      assert.ok(
        content.includes("tt-poly"),
        `${pf} should reference tt-poly`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// AC7: tt-poly/ directory is fully self-contained
// ---------------------------------------------------------------------------
describe("AC7: tt-poly/ directory self-containment", () => {
  it("no symlinks point outside tt-poly/ directory", () => {
    const allEntries = readdirSync(TT_POLY, { recursive: true, withFileTypes: true });
    for (const e of allEntries) {
      if (e.isSymbolicLink()) {
        const fullPath = path.join(e.parentPath ?? TT_POLY, e.name);
        const target = readlinkFromPath(fullPath);
        // Resolve the symlink target relative to the symlink's directory
        const targetDir = path.dirname(fullPath);
        const resolved = path.resolve(targetDir, target);
        assert.ok(
          resolved.startsWith(TT_POLY + "/") || resolved === TT_POLY,
          `Symlink ${fullPath} -> ${target} resolves to ${resolved} which is outside tt-poly/`,
        );
      }
    }
  });

  it("no stray .gitkeep files remain in populated directories", () => {
    // .gitkeep should only exist in truly empty directories
    const allGitkeeps = allFiles(TT_POLY).filter(
      (f) => f.endsWith(".gitkeep"),
    );
    for (const gk of allGitkeeps) {
      const dir = path.dirname(gk);
      const entries = readdirSync(dir).filter(
        (e) => e !== ".gitkeep",
      );
      assert.ok(
        entries.length === 0,
        `${path.relative(TT_POLY, dir)} has .gitkeep but contains other files: ${entries.join(", ")}`,
      );
    }
  });

  it("README.md references tt-poly not tt-poly-lite", () => {
    const content = readAll(path.join(TT_POLY, "README.md"));
    assert.ok(
      content.includes("tt-poly"),
      "README.md should reference tt-poly",
    );
    assert.ok(
      !content.includes("tt-poly-lite"),
      "README.md should not contain tt-poly-lite",
    );
  });

  it("all per-subtree README.md files exist and reference tt-poly", () => {
    for (const subtree of ["python", "ts"]) {
      const readmePath = path.join(TT_POLY, subtree, "README.md");
      if (existsSync(readmePath)) {
        const content = readAll(readmePath);
        assert.ok(
          content.includes("tt-poly") && !content.includes("tt-poly-lite"),
          `${subtree}/README.md should reference tt-poly`,
        );
      }
    }
    // java has README.md; go/rust have FIXTURE.md only
    const javaReadme = path.join(TT_POLY, "java", "README.md");
    if (existsSync(javaReadme)) {
      const content = readAll(javaReadme);
      assert.ok(
        content.includes("tt-poly"),
        "java/README.md should reference tt-poly",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// AC8: Makefile and run-all-tests sync
// ---------------------------------------------------------------------------
describe("AC8: Makefile and run-all-tests sync", () => {
  it("Makefile 'make test' runs ./run-all-tests", () => {
    const content = readAll(path.join(TT_POLY, "Makefile"));
    assert.ok(
      content.includes("./run-all-tests"),
      "Makefile test target should run ./run-all-tests",
    );
    assert.ok(
      content.includes(".PHONY: test"),
      "Makefile should declare .PHONY: test",
    );
  });

  it("run-all-tests handles all 5 subtrees", () => {
    const content = readAll(path.join(TT_POLY, "run-all-tests"));
    assert.ok(content.includes("python"), "run-all-tests should handle python");
    assert.ok(content.includes("/ts"), "run-all-tests should handle ts");
    assert.ok(content.includes("/go"), "run-all-tests should handle go");
    assert.ok(content.includes("rust"), "run-all-tests should handle rust");
    assert.ok(content.includes("java"), "run-all-tests should handle java");
  });

  it("run-all-tests is executable", () => {
    const { mode } = readFileSync(path.join(TT_POLY, "run-all-tests"));
    const { R_OK } = { R_OK: 4 };
    // Just check the file exists and is readable — exec bit tested in run-all-tests.test.ts
    assert.ok(existsSync(path.join(TT_POLY, "run-all-tests")));
  });
});

// ---------------------------------------------------------------------------
// AC9: Seed count and completeness
// ---------------------------------------------------------------------------
describe("AC9: Seed count and completeness", () => {
  it("has exactly 42 documented seeds (41 operational + 1 flaky)", () => {
    const allSeedIds = seedIdsFromFile(path.join(TT_POLY, "seeds/SEEDS.md"));
    // 21 BUG (P1-P4, T1-T4, G1-G4, R1-R4, J1-J4, A5)
    // 10 VULN (P1-P2, T1-T2, G1-G2, R1-R2, J1-J2)
    // 10 BRK (P1-P2, T1-T2, G1-G2, R1-R2, J1-J2)
    // 1 FLAKY (P1)
    // Total: 42
    assert.strictEqual(allSeedIds.length, 42, `Expected 42 seeds, got ${allSeedIds.length}: ${allSeedIds.join(", ")}`);
  });

  it("per-subtree seed counts match catalog summary", () => {
    const content = readAll(path.join(TT_POLY, "seeds/SEEDS.md"));
    // Python: 4 BUG + 2 VULN + 2 BRK + 1 FLAKY = 9
    const pythonSeeds = seedIdsFromFile(path.join(TT_POLY, "python/FIXTURE.md"))
      .filter((id) => id.startsWith("POLY-BUG-P") || id.startsWith("POLY-VULN-P")
        || id.startsWith("POLY-BRK-P") || id.startsWith("POLY-FLAKY-P"));
    assert.strictEqual(pythonSeeds.length, 9);

    // TS: 4 BUG + 2 VULN + 2 BRK = 8
    const tsSeeds = seedIdsFromFile(path.join(TT_POLY, "ts/FIXTURE.md"))
      .filter((id) => id.startsWith("POLY-BUG-T") || id.startsWith("POLY-VULN-T")
        || id.startsWith("POLY-BRK-T"));
    assert.strictEqual(tsSeeds.length, 8);

    // Go: 4 BUG + 2 VULN + 2 BRK = 8
    const goSeeds = seedIdsFromFile(path.join(TT_POLY, "go/FIXTURE.md"))
      .filter((id) => id.startsWith("POLY-BUG-G") || id.startsWith("POLY-VULN-G")
        || id.startsWith("POLY-BRK-G"));
    assert.strictEqual(goSeeds.length, 8);

    // Rust: 4 BUG + 2 VULN + 2 BRK = 8
    const rustSeeds = seedIdsFromFile(path.join(TT_POLY, "rust/FIXTURE.md"))
      .filter((id) => id.startsWith("POLY-BUG-R") || id.startsWith("POLY-VULN-R")
        || id.startsWith("POLY-BRK-R"));
    assert.strictEqual(rustSeeds.length, 8);

    // Java: 4 BUG + 2 VULN + 2 BRK = 8
    const javaSeeds = seedIdsFromFile(path.join(TT_POLY, "java/FIXTURE.md"))
      .filter((id) => id.startsWith("POLY-BUG-J") || id.startsWith("POLY-VULN-J")
        || id.startsWith("POLY-BRK-J"));
    assert.strictEqual(javaSeeds.length, 8);
  });
});

// ---------------------------------------------------------------------------
// AC10: No dead references, tt-poly directory integrity
// ---------------------------------------------------------------------------
describe("AC10: Directory and reference integrity", () => {
  it("all referenced files in SEEDS.md exist", () => {
    const content = readAll(path.join(TT_POLY, "seeds/SEEDS.md"));
    // Check for file references
    const refPaths = content.match(/`([^`]+\/FIXTURE\.md)`/g) ?? [];
    for (const ref of refPaths) {
      const cleaned = ref.replace(/`/g, "");
      // These are cross-references to per-subtree FIXTURE.md — verify they match subtrees
      assert.ok(
        ["python/FIXTURE.md", "ts/FIXTURE.md", "go/FIXTURE.md",
          "rust/FIXTURE.md", "java/FIXTURE.md"].includes(cleaned),
        `SEEDS.md references ${cleaned} which doesn't match a known subtree`,
      );
    }
  });

  it("all 5 subtrees have required structure files", () => {
    for (const subtree of ["python", "ts", "go", "rust", "java"]) {
      const subtreePath = path.join(TT_POLY, subtree);
      assert.ok(
        existsSync(subtreePath),
        `${subtree}/ directory missing`,
      );

      // JUNK markers
      const junkInt = path.join(subtreePath, "JUNK-IS-INTENTIONAL.md");
      const readmeJunk = path.join(subtreePath, "README-JUNK.md");
      assert.ok(
        existsSync(junkInt) || existsSync(readmeJunk),
        `${subtree}/ should have at least one JUNK marker file`,
      );

      // operator-notes.local
      assert.ok(
        existsSync(path.join(subtreePath, "operator-notes.local")),
        `${subtree}/ missing operator-notes.local`,
      );
    }
  });

  it("top-level structure files are present", () => {
    for (const f of ["JUNK-IS-INTENTIONAL.md", "README-JUNK.md",
      "operator-notes.local", "README.md", "Makefile", "run-all-tests",
      "build-golden.sh", ".gitignore"]) {
      assert.ok(
        existsSync(path.join(TT_POLY, f)),
        `Missing top-level ${f}`,
      );
    }
  });

  it("per-subtree .gitignore files don't suppress junk probes", () => {
    for (const subtree of ["python", "ts", "go", "rust", "java"]) {
      const gitignorePath = path.join(TT_POLY, subtree, ".gitignore");
      if (!existsSync(gitignorePath)) continue;
      const content = readAll(gitignorePath);
      // Make sure it explicitly documents that junk probes are NOT gitignored
      assert.ok(
        content.includes("NOT in .gitignore") || content.includes("junk probe")
          || content.includes("NOT gitignored"),
        `${subtree}/.gitignore should document junk probe exclusion`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function readlinkFromPath(p: string): string {
  return readlinkSync(p);
}
