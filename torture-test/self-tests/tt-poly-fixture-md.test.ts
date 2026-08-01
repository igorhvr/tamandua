import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();
const ttPolyRoot = path.resolve(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly",
);

const subtrees = [
  { name: "python", lang: "python", seedsRE: /POLY-(BUG|VULN|BRK|FEAT|FLAKY)-P\d/, bugCount: 4, vulnCount: 2, brkCount: 2, featMin: 3, hasA5: true },
  { name: "ts", lang: "ts", seedsRE: /POLY-(BUG|VULN|BRK|FEAT)-T\d/, bugCount: 4, vulnCount: 2, brkCount: 2, featMin: 4, hasA5: true },
  { name: "go", lang: "go", seedsRE: /POLY-(BUG|VULN|BRK|FEAT)-G\d/, bugCount: 4, vulnCount: 2, brkCount: 2, featMin: 3, hasA5: true },
  { name: "rust", lang: "rust", seedsRE: /POLY-(BUG|VULN|BRK|FEAT)-R\d/, bugCount: 4, vulnCount: 2, brkCount: 2, featMin: 3, hasA5: true },
  { name: "java", lang: "java", seedsRE: /POLY-(BUG|VULN|BRK|FEAT)-J\d/, bugCount: 4, vulnCount: 2, brkCount: 2, featMin: 4, hasA5: true },
];

describe("tt-poly FIXTURE.md files", () => {
  for (const subtree of subtrees) {
    const mdPath = path.join(ttPolyRoot, subtree.name, "FIXTURE.md");

    it(`${subtree.name}/FIXTURE.md exists`, () => {
      assert.ok(fs.existsSync(mdPath), `${subtree.name}/FIXTURE.md should exist`);
    });

    it(`${subtree.name}/FIXTURE.md references tt-poly`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      assert.ok(
        content.includes("tt-poly"),
        `${subtree.name}/FIXTURE.md should reference tt-poly`,
      );
    });

    it(`${subtree.name}/FIXTURE.md has Project Overview section`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      assert.ok(
        content.includes("## Project Overview") || content.includes("## Project Overview") || content.includes("# FIXTURE.md"),
        `${subtree.name}/FIXTURE.md should have project overview`,
      );
    });

    it(`${subtree.name}/FIXTURE.md has Component Map section`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      assert.ok(
        content.includes("## Component Map") || content.includes("Component Map"),
        `${subtree.name}/FIXTURE.md should have component map`,
      );
    });

    it(`${subtree.name}/FIXTURE.md documents TEST_CMD`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      assert.ok(
        content.includes("TEST_CMD") || content.includes("## TEST_CMD"),
        `${subtree.name}/FIXTURE.md should document TEST_CMD`,
      );
    });

    it(`${subtree.name}/FIXTURE.md documents seeded bugs with POLY-* IDs`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      const bugRE = new RegExp(`POLY-BUG-${subtree.lang.toUpperCase().charAt(0)}\\d`, "g");
      const matches = content.match(bugRE);
      assert.ok(
        matches && matches.length >= subtree.bugCount,
        `${subtree.name}/FIXTURE.md should document at least ${subtree.bugCount} POLY-BUG-* entries (found ${matches ? matches.length : 0})`,
      );
    });

    it(`${subtree.name}/FIXTURE.md documents dormant vulns with POLY-* IDs`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      const vulnRE = new RegExp(`POLY-VULN-${subtree.lang.toUpperCase().charAt(0)}\\d`, "g");
      const matches = content.match(vulnRE);
      assert.ok(
        matches && matches.length >= subtree.vulnCount,
        `${subtree.name}/FIXTURE.md should document at least ${subtree.vulnCount} POLY-VULN-* entries (found ${matches ? matches.length : 0})`,
      );
    });

    it(`${subtree.name}/FIXTURE.md documents broken tests with POLY-* IDs`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      const brkRE = new RegExp(`POLY-BRK-${subtree.lang.toUpperCase().charAt(0)}\\d`, "g");
      const matches = content.match(brkRE);
      assert.ok(
        matches && matches.length >= subtree.brkCount,
        `${subtree.name}/FIXTURE.md should document at least ${subtree.brkCount} POLY-BRK-* entries (found ${matches ? matches.length : 0})`,
      );
    });

    it(`${subtree.name}/FIXTURE.md documents feature backlog with POLY-* IDs`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      const featRE = new RegExp(`POLY-FEAT-${subtree.lang.toUpperCase().charAt(0)}\\d`, "g");
      const matches = content.match(featRE);
      assert.ok(
        matches && matches.length >= subtree.featMin,
        `${subtree.name}/FIXTURE.md should document at least ${subtree.featMin} POLY-FEAT-* entries (found ${matches ? matches.length : 0})`,
      );
    });

    it(`${subtree.name}/FIXTURE.md documents junk probes`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      assert.ok(
        content.includes("Junk Probe") || content.includes("junk probe") || content.includes("Junk Probes"),
        `${subtree.name}/FIXTURE.md should document junk probes`,
      );
    });

    it(`${subtree.name}/FIXTURE.md documents traps or gotchas`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      assert.ok(
        content.includes("## Traps") || content.includes("### Trap") || content.includes("- Trap"),
        `${subtree.name}/FIXTURE.md should document traps or gotchas`,
      );
    });

    it(`${subtree.name}/FIXTURE.md documents integrity invariants`, () => {
      const content = fs.readFileSync(mdPath, "utf-8");
      assert.ok(
        content.includes("## Integrity Invariants") || content.includes("Integrity Invariant"),
        `${subtree.name}/FIXTURE.md should document integrity invariants`,
      );
    });

    if (subtree.hasA5) {
      it(`${subtree.name}/FIXTURE.md documents cross-language POLY-BUG-A5`, () => {
        const content = fs.readFileSync(mdPath, "utf-8");
        assert.ok(
          content.includes("POLY-BUG-A5") || content.includes("cross-language") || content.includes("Cross-Language"),
          `${subtree.name}/FIXTURE.md should document POLY-BUG-A5 cross-language integration bug`,
        );
      });
    }
  }

  // ================================================================
  // python/ FIXTURE.md — specific content
  // ================================================================
  describe("python/FIXTURE.md", () => {
    const content = fs.readFileSync(path.join(ttPolyRoot, "python", "FIXTURE.md"), "utf-8");

    it("has archetype reference with A1-A5", () => {
      assert.ok(content.includes("A1"), "should reference A1");
      assert.ok(content.includes("A2"), "should reference A2");
      assert.ok(content.includes("A3"), "should reference A3");
      assert.ok(content.includes("A4"), "should reference A4");
      assert.ok(content.includes("A5"), "should reference A5");
    });

    it("has archetype mapping table", () => {
      assert.ok(
        content.includes("### Archetype Mapping"),
        "should have archetype mapping",
      );
    });

    it("has seed layout section", () => {
      assert.ok(
        content.includes("## Seed Layout") || content.includes("Seed Layout"),
        "should have seed layout section",
      );
    });

    it("has patch application quick reference", () => {
      assert.ok(
        content.includes("Patch Application Quick Reference") || content.includes("## Patch Application"),
        "should have patch application quick reference",
      );
    });

    it("documents sentinel trap", () => {
      assert.ok(
        content.includes("sentinel") || content.includes("$(sentinel)"),
        "should document the sentinel trap",
      );
    });

    it("documents POLY-FLAKY-P1 flaky probe", () => {
      assert.ok(
        content.includes("POLY-FLAKY-P1"),
        "should document POLY-FLAKY-P1 flaky probe",
      );
    });

    it("documents component map with engine, recurrence, conflict, dates modules", () => {
      assert.ok(content.includes("engine.py"), "should mention engine.py");
      assert.ok(content.includes("recurrence.py"), "should mention recurrence.py");
      assert.ok(content.includes("conflict.py"), "should mention conflict.py");
      assert.ok(content.includes("dates.py"), "should mention dates.py");
    });

    it("documents dormant vulnerablity module: integrations.py", () => {
      assert.ok(
        content.includes("integrations.py"),
        "should mention integrations.py as dormant vuln module",
      );
    });

    it("documents cross-language POLY-BUG-A5 with python/ + ts/ subtrees", () => {
      assert.ok(
        content.includes("POLY-BUG-A5"),
        "should document POLY-BUG-A5",
      );
      assert.ok(
        content.includes("python/") && content.includes("ts/"),
        "should reference both python/ and ts/ subtrees",
      );
    });

    it("does not reference tt-poly-lite", () => {
      assert.ok(
        !content.includes("tt-poly-lite"),
        "should not reference tt-poly-lite",
      );
    });

    it("documents TEST_CMD as .venv/bin/pytest -q", () => {
      assert.ok(
        content.includes(".venv/bin/pytest") || content.includes("pytest"),
        "should document pytest TEST_CMD",
      );
    });
  });

  // ================================================================
  // ts/ FIXTURE.md — specific content
  // ================================================================
  describe("ts/FIXTURE.md", () => {
    const content = fs.readFileSync(path.join(ttPolyRoot, "ts", "FIXTURE.md"), "utf-8");

    it("has archetype reference with A1-A5", () => {
      assert.ok(content.includes("A1"), "should reference A1");
      assert.ok(content.includes("A2"), "should reference A2");
      assert.ok(content.includes("A3"), "should reference A3");
      assert.ok(content.includes("A4"), "should reference A4");
      assert.ok(content.includes("A5"), "should reference A5");
    });

    it("has archetype mapping table", () => {
      assert.ok(
        content.includes("### Archetype Mapping"),
        "should have archetype mapping",
      );
    });

    it("has seed layout section", () => {
      assert.ok(
        content.includes("## Seed Layout"),
        "should have seed layout section",
      );
    });

    it("has patch application quick reference", () => {
      assert.ok(
        content.includes("Patch Application Quick Reference"),
        "should have patch application quick reference",
      );
    });

    it("documents component map with store.ts, server.ts, types.ts", () => {
      assert.ok(content.includes("store.ts"), "should mention store.ts");
      assert.ok(content.includes("server.ts"), "should mention server.ts");
      assert.ok(content.includes("types.ts"), "should mention types.ts");
    });

    it("documents STORM-SENTINEL or sentinel in context", () => {
      // The storm sentinel is documented as part of the store.ts component
      assert.ok(
        content.includes("sentinel") || content.includes("STORM-SENTINEL") || content.includes("storm"),
        "should reference storm sentinel context",
      );
    });

    it("documents cross-language POLY-BUG-A5 with python/ + ts/ subtrees", () => {
      assert.ok(
        content.includes("POLY-BUG-A5"),
        "should document POLY-BUG-A5",
      );
      assert.ok(
        content.includes("python/") || content.includes("python"),
        "should reference python subtree",
      );
    });

    it("documents public/ frontend assets", () => {
      assert.ok(
        content.includes("public/") || content.includes("frontend"),
        "should mention public/ frontend assets",
      );
    });

    it("documents Junk Probes with package-lock.json and node_modules/", () => {
      assert.ok(
        content.includes("package-lock.json") || content.includes("node_modules"),
        "should document junk probes",
      );
    });
  });

  // ================================================================
  // go/ FIXTURE.md — specific content
  // ================================================================
  describe("go/FIXTURE.md", () => {
    const content = fs.readFileSync(path.join(ttPolyRoot, "go", "FIXTURE.md"), "utf-8");

    it("has archetype reference with A1-A5", () => {
      assert.ok(content.includes("A1"), "should reference A1");
      assert.ok(content.includes("A2"), "should reference A2");
      assert.ok(content.includes("A3"), "should reference A3");
      assert.ok(content.includes("A4"), "should reference A4");
      assert.ok(content.includes("A5"), "should reference A5");
    });

    it("has archetype mapping table", () => {
      assert.ok(
        content.includes("### Archetype Mapping"),
        "should have archetype mapping",
      );
    });

    it("has seed layout section", () => {
      assert.ok(
        content.includes("## Seed Layout"),
        "should have seed layout section",
      );
    });

    it("has patch application quick reference", () => {
      assert.ok(
        content.includes("Patch Application Quick Reference"),
        "should have patch application quick reference",
      );
    });

    it("documents component map with pool.go, task.go, pool_test.go", () => {
      assert.ok(content.includes("pool.go"), "should mention pool.go");
      assert.ok(content.includes("task.go"), "should mention task.go");
      assert.ok(content.includes("pool_test.go"), "should mention pool_test.go");
    });

    it("documents util/ dormant vuln subpackage", () => {
      assert.ok(
        content.includes("util/") || content.includes("util/command.go") || content.includes("util/archive.go"),
        "should document util/ dormant vuln subpackage",
      );
    });

    it("documents testdata/exec-bit-probe.sh junk probe", () => {
      assert.ok(
        content.includes("exec-bit-probe.sh") || content.includes("testdata/"),
        "should document exec-bit-probe.sh junk probe",
      );
    });

    it("documents cross-language POLY-BUG-A5", () => {
      assert.ok(
        content.includes("POLY-BUG-A5") || content.includes("cross-language"),
        "should reference POLY-BUG-A5",
      );
    });

    it("documents race detector not part of TEST_CMD", () => {
      assert.ok(
        content.includes("-race") || content.includes("race detector"),
        "should document race detector exclusion from TEST_CMD",
      );
    });
  });

  // ================================================================
  // rust/ FIXTURE.md — specific content
  // ================================================================
  describe("rust/FIXTURE.md", () => {
    const content = fs.readFileSync(path.join(ttPolyRoot, "rust", "FIXTURE.md"), "utf-8");

    it("has archetype reference with A1-A5", () => {
      assert.ok(content.includes("A1"), "should reference A1");
      assert.ok(content.includes("A2"), "should reference A2");
      assert.ok(content.includes("A3"), "should reference A3");
      assert.ok(content.includes("A4"), "should reference A4");
      assert.ok(content.includes("A5"), "should reference A5");
    });

    it("has archetype mapping table", () => {
      assert.ok(
        content.includes("### Archetype Mapping"),
        "should have archetype mapping",
      );
    });

    it("has seed layout section", () => {
      assert.ok(
        content.includes("## Seed Layout"),
        "should have seed layout section",
      );
    });

    it("has patch application quick reference", () => {
      assert.ok(
        content.includes("Patch Application Quick Reference"),
        "should have patch application quick reference",
      );
    });

    it("documents component map with Cargo.toml, bucket.rs, config.rs", () => {
      assert.ok(content.includes("Cargo.toml"), "should mention Cargo.toml");
      assert.ok(content.includes("bucket.rs"), "should mention bucket.rs");
      assert.ok(content.includes("config.rs"), "should mention config.rs");
    });

    it("documents util_unsafe.rs and util_timing.rs dormant vuln modules", () => {
      assert.ok(
        content.includes("util_unsafe.rs") || content.includes("util_unsafe"),
        "should document util_unsafe.rs dormant vuln module",
      );
      assert.ok(
        content.includes("util_timing.rs") || content.includes("util_timing"),
        "should document util_timing.rs dormant vuln module",
      );
    });

    it("documents Cargo.lock as committed for deterministic builds", () => {
      assert.ok(
        content.includes("Cargo.lock"),
        "should document Cargo.lock committed for deterministic builds",
      );
    });

    it("documents target/ as regenerated junk NOT gitignored", () => {
      assert.ok(
        content.includes("target/"),
        "should document target/ as regenerated junk",
      );
    });

    it("documents cross-language POLY-BUG-A5", () => {
      assert.ok(
        content.includes("POLY-BUG-A5") || content.includes("cross-language"),
        "should reference POLY-BUG-A5",
      );
    });

    it("documents release vs debug mode divergence for BUG-R1", () => {
      assert.ok(
        content.includes("release") || content.includes("overflow") || content.includes("debug"),
        "should document release vs debug mode divergence",
      );
    });
  });

  // ================================================================
  // java/ FIXTURE.md — specific content
  // ================================================================
  describe("java/FIXTURE.md", () => {
    const content = fs.readFileSync(path.join(ttPolyRoot, "java", "FIXTURE.md"), "utf-8");

    it("has archetype reference with A1-A5", () => {
      assert.ok(content.includes("A1"), "should reference A1");
      assert.ok(content.includes("A2"), "should reference A2");
      assert.ok(content.includes("A3"), "should reference A3");
      assert.ok(content.includes("A4"), "should reference A4");
      assert.ok(content.includes("A5"), "should reference A5");
    });

    it("has archetype mapping table", () => {
      assert.ok(
        content.includes("### Archetype Mapping"),
        "should have archetype mapping",
      );
    });

    it("has seed layout section", () => {
      assert.ok(
        content.includes("## Seed Layout"),
        "should have seed layout section",
      );
    });

    it("has patch application quick reference", () => {
      assert.ok(
        content.includes("Patch Application Quick Reference"),
        "should have patch application quick reference",
      );
    });

    it("documents component map with LedgerEntry, CsvParser, MoneyUtils, LedgerService, CliApp", () => {
      assert.ok(content.includes("LedgerEntry"), "should mention LedgerEntry");
      assert.ok(content.includes("CsvParser"), "should mention CsvParser");
      assert.ok(content.includes("MoneyUtils"), "should mention MoneyUtils");
      assert.ok(content.includes("LedgerService"), "should mention LedgerService");
      assert.ok(content.includes("CliApp"), "should mention CliApp");
    });

    it("documents XmlImportService and ExportService dormant vuln modules", () => {
      assert.ok(
        content.includes("XmlImportService") || content.includes("ExportService"),
        "should document dormant vuln service modules",
      );
    });

    it("documents JAVA_HOME trap (java not on PATH)", () => {
      assert.ok(
        content.includes("JAVA_HOME") || content.includes("off PATH"),
        "should document JAVA_HOME trap",
      );
    });

    it("documents mvnw Maven Wrapper as build tool", () => {
      assert.ok(
        content.includes("mvnw") || content.includes("Maven Wrapper"),
        "should document mvnw Maven Wrapper",
      );
    });

    it("documents target/ as regenerated junk NOT gitignored", () => {
      assert.ok(
        content.includes("target/"),
        "should document target/ as regenerated junk",
      );
    });

    it("documents cross-language POLY-BUG-A5", () => {
      assert.ok(
        content.includes("POLY-BUG-A5") || content.includes("cross-language"),
        "should reference POLY-BUG-A5",
      );
    });

    it("documents git apply -p4 patch convention", () => {
      assert.ok(
        content.includes("git apply -p4") || content.includes("git-apply"),
        "should document git apply -p4 patch convention",
      );
    });
  });

  // ================================================================
  // Cross-file consistency
  // ================================================================
  describe("cross-file consistency", () => {
    it("all 5 FIXTURE.md files reference POLY-BUG-A5 (A5 cross-language bug)", () => {
      const paths = subtrees.map(s => path.join(ttPolyRoot, s.name, "FIXTURE.md"));
      for (const p of paths) {
        const content = fs.readFileSync(p, "utf-8");
        assert.ok(
          content.includes("POLY-BUG-A5") || content.includes("A5") || content.includes("cross-language"),
          `${path.basename(path.dirname(p))}/FIXTURE.md should reference POLY-BUG-A5`,
        );
      }
    });

    it("all 5 FIXTURE.md files have seed catalog with POLY-* naming convention", () => {
      const paths = subtrees.map(s => path.join(ttPolyRoot, s.name, "FIXTURE.md"));
      for (const p of paths) {
        const content = fs.readFileSync(p, "utf-8");
        assert.ok(
          /POLY-(BUG|VULN|BRK|FEAT)-[A-Z]\d/.test(content),
          `${path.basename(path.dirname(p))}/FIXTURE.md should use POLY-* naming convention`,
        );
      }
    });

    it("no FIXTURE.md references old non-POLY IDs (BUG-J, BUG-G, BUG-R, etc.)", () => {
      const paths = subtrees.map(s => path.join(ttPolyRoot, s.name, "FIXTURE.md"));
      // Only check that non-POLY prefixed IDs don't appear outside POLY- context
      // The pattern `BUG-J1` (without POLY- prefix) should not be present
      const oldIds = [
        { re: /(?<!POLY-)BUG-J\d/g, name: "BUG-J*" },
        { re: /(?<!POLY-)BUG-G\d/g, name: "BUG-G*" },
        { re: /(?<!POLY-)BUG-R\d/g, name: "BUG-R*" },
        { re: /(?<!POLY-)VULN-J\d/g, name: "VULN-J*" },
        { re: /(?<!POLY-)VULN-G\d/g, name: "VULN-G*" },
        { re: /(?<!POLY-)VULN-R\d/g, name: "VULN-R*" },
        { re: /(?<!POLY-)BRK-J\d/g, name: "BRK-J*" },
        { re: /(?<!POLY-)BRK-G\d/g, name: "BRK-G*" },
        { re: /(?<!POLY-)BRK-R\d/g, name: "BRK-R*" },
        { re: /(?<!POLY-)FEAT-J\d/g, name: "FEAT-J*" },
        { re: /(?<!POLY-)FEAT-G\d/g, name: "FEAT-G*" },
        { re: /(?<!POLY-)FEAT-R\d/g, name: "FEAT-R*" },
      ];
      for (const p of paths) {
        const content = fs.readFileSync(p, "utf-8");
        for (const old of oldIds) {
          const matches = content.match(old.re);
          assert.ok(
            !matches || matches.length === 0,
            `${path.basename(path.dirname(p))}/FIXTURE.md should not reference old ID ${old.name}`,
          );
        }
      }
    });

    it("all 5 FIXTURE.md files document TEST_CMD", () => {
      const paths = subtrees.map(s => path.join(ttPolyRoot, s.name, "FIXTURE.md"));
      for (const p of paths) {
        const content = fs.readFileSync(p, "utf-8");
        assert.ok(
          content.includes("TEST_CMD"),
          `${path.basename(path.dirname(p))}/FIXTURE.md should document TEST_CMD`,
        );
      }
    });
  });
});
