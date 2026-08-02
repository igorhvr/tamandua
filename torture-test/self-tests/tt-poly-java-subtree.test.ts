import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// This test file performs read-only validation against fixtures-src —
// no commands are executed inside fixtures-src.

const repoRoot = process.cwd();
const ttPolyJavaDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly",
  "java",
);
const ttJavaDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-java",
);

describe("tt-poly java/ subtree integration (US-006)", () => {
  it("java/ directory exists and contains all Java source files from tt-java fixture", () => {
    assert.ok(
      fs.existsSync(ttPolyJavaDir),
      "tt-poly/java/ should exist",
    );
    assert.ok(
      fs.statSync(ttPolyJavaDir).isDirectory(),
      "tt-poly/java/ should be a directory",
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

    const sourceFiles = collectFiles(ttJavaDir);
    const destFiles = collectFiles(ttPolyJavaDir);

    // Exclude files that are tt-java-specific (not copied to tt-poly)
    const excludedFiles = new Set([
      "build-golden.sh",
      "validate-e2e.sh",
      ".gitignore",
      "FIXTURE.md",
      "README.md",
      "JUNK-IS-INTENTIONAL.md",
      "README-JUNK.md",
      "operator-notes.local",
    ]);

    // Map old seed file names to POLY-* names for the file parity check.
    // The source (tt-java) uses BUG-J*, BRK-J*, VULN-J* but tt-poly renames
    // them to POLY-BUG-J*, POLY-BRK-J*, POLY-VULN-J*.
    const remapSeedFile = (f: string): string => {
      if (f.startsWith("seeds/")) {
        f = f.replace(/\/BUG-J/, "/POLY-BUG-J");
        f = f.replace(/\/BRK-J/, "/POLY-BRK-J");
        f = f.replace(/\/VULN-J/, "/POLY-VULN-J");
        // Handle fix/ subdirectory
        f = f.replace(/fix\/BUG-J/, "fix/POLY-BUG-J");
        f = f.replace(/fix\/BRK-J/, "fix/POLY-BRK-J");
        f = f.replace(/fix\/VULN-J/, "fix/POLY-VULN-J");
      }
      return f;
    };

    for (const f of sourceFiles) {
      if (excludedFiles.has(f)) continue;
      if (path.basename(f) === ".gitkeep") continue;
      const remapped = remapSeedFile(f);
      assert.ok(
        destFiles.has(remapped),
        `tt-poly/java/${remapped} should exist (from tt-java/${f})`,
      );
    }
  });

  it("FIXTURE.md references tt-poly, not tt-java", () => {
    const mdPath = path.join(ttPolyJavaDir, "FIXTURE.md");
    assert.ok(fs.existsSync(mdPath), "FIXTURE.md should exist");

    const content = fs.readFileSync(mdPath, "utf-8");
    assert.ok(
      content.includes("tt-poly java/ Subtree Seeded Content"),
      'FIXTURE.md title should reference "tt-poly java/ Subtree"',
    );
    assert.ok(
      content.includes("tt-poly five-language storm monorepo"),
      "FIXTURE.md should mention tt-poly five-language storm monorepo",
    );
    // Must reference POLY-J* naming (re-ID'd from BUG-J*)
    assert.ok(
      content.includes("POLY-BUG-J1"),
      "FIXTURE.md should document POLY-BUG-J1",
    );
    assert.ok(
      content.includes("POLY-BUG-J4"),
      "FIXTURE.md should document POLY-BUG-J4",
    );
    assert.ok(
      content.includes("POLY-VULN-J1"),
      "FIXTURE.md should document POLY-VULN-J1",
    );
    assert.ok(
      content.includes("POLY-BRK-J1"),
      "FIXTURE.md should document POLY-BRK-J1",
    );
    assert.ok(
      content.includes("POLY-BRK-J2"),
      "FIXTURE.md should document POLY-BRK-J2",
    );
    assert.ok(
      content.includes("POLY-FEAT-J1"),
      "FIXTURE.md should document POLY-FEAT-J1",
    );
  });

  it("java/pom.xml and java/mvnw present", () => {
    const pomPath = path.join(ttPolyJavaDir, "pom.xml");
    assert.ok(fs.existsSync(pomPath), "pom.xml should exist");

    const pomContent = fs.readFileSync(pomPath, "utf-8");
    assert.ok(pomContent.includes("com.tamandua"), "pom.xml should have com.tamandua groupId");
    assert.ok(pomContent.includes("tt-java"), "pom.xml should have tt-java artifactId");
    assert.ok(pomContent.includes("maven.compiler.release"), "pom.xml should specify compiler release");
    assert.ok(pomContent.includes("junit-jupiter"), "pom.xml should have JUnit Jupiter dependency");
    assert.ok(
      pomContent.includes("maven-surefire-plugin"),
      "pom.xml should have maven-surefire-plugin",
    );

    const mvnwPath = path.join(ttPolyJavaDir, "mvnw");
    assert.ok(fs.existsSync(mvnwPath), "mvnw should exist");
    assert.ok(fs.statSync(mvnwPath).isFile(), "mvnw should be a file");

    const mvnwPerms = fs.statSync(mvnwPath).mode;
    // Check if the file has execute permission (owner, group, or other)
    const isExecutable = (mvnwPerms & 0o111) !== 0;
    assert.ok(isExecutable, "mvnw should be executable");

    const mvnwCmdPath = path.join(ttPolyJavaDir, "mvnw.cmd");
    assert.ok(fs.existsSync(mvnwCmdPath), "mvnw.cmd should exist (Windows wrapper)");
  });

  it(".mvn/wrapper/maven-wrapper.properties present", () => {
    const propsPath = path.join(
      ttPolyJavaDir,
      ".mvn",
      "wrapper",
      "maven-wrapper.properties",
    );
    assert.ok(
      fs.existsSync(propsPath),
      ".mvn/wrapper/maven-wrapper.properties should exist",
    );

    const content = fs.readFileSync(propsPath, "utf-8");
    assert.ok(
      content.includes("distributionUrl"),
      "maven-wrapper.properties should have distributionUrl",
    );
    assert.ok(
      content.includes("distributionUrl"),
      "maven-wrapper.properties should have distributionUrl",
    );
  });

  it("java/src/main/java/com/tamandua/ledger/ contains all source classes", () => {
    const mainSrcDir = path.join(
      ttPolyJavaDir,
      "src",
      "main",
      "java",
      "com",
      "tamandua",
      "ledger",
    );

    const requiredClasses = [
      "LedgerEntry.java",
      "CsvParser.java",
      "MoneyUtils.java",
      "LedgerService.java",
      "CliApp.java",
      "XmlImportService.java",
      "ExportService.java",
    ];

    for (const f of requiredClasses) {
      const fPath = path.join(mainSrcDir, f);
      assert.ok(
        fs.existsSync(fPath),
        `src/main/java/com/tamandua/ledger/${f} should exist`,
      );
      assert.ok(
        fs.statSync(fPath).isFile(),
        `src/main/java/com/tamandua/ledger/${f} should be a file`,
      );
      const content = fs.readFileSync(fPath, "utf-8");
      assert.ok(
        content.startsWith("package com.tamandua.ledger;"),
        `${f} should declare package com.tamandua.ledger`,
      );
    }
  });

  it("java/src/test/java/com/tamandua/ledger/ contains all test classes", () => {
    const testSrcDir = path.join(
      ttPolyJavaDir,
      "src",
      "test",
      "java",
      "com",
      "tamandua",
      "ledger",
    );

    const requiredTests = [
      "LedgerEntryTest.java",
      "CsvParserTest.java",
      "MoneyUtilsTest.java",
      "LedgerServiceTest.java",
      "CliAppTest.java",
    ];

    for (const f of requiredTests) {
      const fPath = path.join(testSrcDir, f);
      assert.ok(
        fs.existsSync(fPath),
        `src/test/java/com/tamandua/ledger/${f} should exist`,
      );
      assert.ok(
        fs.statSync(fPath).isFile(),
        `src/test/java/com/tamandua/ledger/${f} should be a file`,
      );
      const content = fs.readFileSync(fPath, "utf-8");
      assert.ok(
        content.includes("org.junit.jupiter"),
        `${f} should use JUnit Jupiter`,
      );
    }
  });

  it("CsvParser.java defines LedgerEntry model and CSV parsing", () => {
    const fPath = path.join(
      ttPolyJavaDir,
      "src",
      "main",
      "java",
      "com",
      "tamandua",
      "ledger",
      "CsvParser.java",
    );
    const content = fs.readFileSync(fPath, "utf-8");

    assert.ok(content.includes("class CsvParser"), "CsvParser.java should define CsvParser class");
    assert.ok(content.includes("parse("), "CsvParser.java should have parse() method");
    assert.ok(
      content.includes("LedgerEntry"),
      "CsvParser.java should reference LedgerEntry",
    );
    assert.ok(
      content.includes("BigDecimal"),
      "CsvParser.java should use BigDecimal for amounts",
    );
  });

  it("MoneyUtils.java defines money arithmetic utilities", () => {
    const fPath = path.join(
      ttPolyJavaDir,
      "src",
      "main",
      "java",
      "com",
      "tamandua",
      "ledger",
      "MoneyUtils.java",
    );
    const content = fs.readFileSync(fPath, "utf-8");

    assert.ok(
      content.includes("class MoneyUtils"),
      "MoneyUtils.java should define MoneyUtils class",
    );
    assert.ok(content.includes("add("), "MoneyUtils.java should have add() method");
    assert.ok(
      content.includes("subtract("),
      "MoneyUtils.java should have subtract() method",
    );
    assert.ok(
      content.includes("round("),
      "MoneyUtils.java should have round() method",
    );
    assert.ok(
      content.includes("format("),
      "MoneyUtils.java should have format() method",
    );
    assert.ok(
      content.includes("HALF_UP"),
      "MoneyUtils.java should use HALF_UP rounding",
    );
  });

  it("LedgerService.java defines business logic methods", () => {
    const fPath = path.join(
      ttPolyJavaDir,
      "src",
      "main",
      "java",
      "com",
      "tamandua",
      "ledger",
      "LedgerService.java",
    );
    const content = fs.readFileSync(fPath, "utf-8");

    assert.ok(
      content.includes("class LedgerService"),
      "LedgerService.java should define LedgerService class",
    );
    assert.ok(
      content.includes("getTotal("),
      "LedgerService.java should have getTotal() method",
    );
    assert.ok(
      content.includes("getByCategory("),
      "LedgerService.java should have getByCategory() method",
    );
    assert.ok(
      content.includes("getCategoryTotals("),
      "LedgerService.java should have getCategoryTotals() method",
    );
    assert.ok(
      content.includes("getByDateRange("),
      "LedgerService.java should have getByDateRange() method",
    );
  });

  it("CliApp.java is the CLI entry point", () => {
    const fPath = path.join(
      ttPolyJavaDir,
      "src",
      "main",
      "java",
      "com",
      "tamandua",
      "ledger",
      "CliApp.java",
    );
    const content = fs.readFileSync(fPath, "utf-8");

    assert.ok(
      content.includes("class CliApp"),
      "CliApp.java should define CliApp class",
    );
    assert.ok(
      content.includes("main("),
      "CliApp.java should have main() entry point",
    );
    assert.ok(content.includes("summary"), "CliApp.java should support summary subcommand");
    assert.ok(content.includes("filter"), "CliApp.java should support filter subcommand");
    assert.ok(content.includes("list"), "CliApp.java should support list subcommand");
  });

  it("XmlImportService.java and ExportService.java exist (dormant vuln modules)", () => {
    // XmlImportService — VULN-J1 dormant code path
    const xmlPath = path.join(
      ttPolyJavaDir,
      "src",
      "main",
      "java",
      "com",
      "tamandua",
      "ledger",
      "XmlImportService.java",
    );
    assert.ok(
      fs.existsSync(xmlPath),
      "XmlImportService.java should exist (dormant vuln)",
    );
    const xmlContent = fs.readFileSync(xmlPath, "utf-8");
    assert.ok(
      xmlContent.includes("DocumentBuilderFactory"),
      "XmlImportService.java should use DocumentBuilderFactory",
    );
    assert.ok(
      xmlContent.includes("importFromXml"),
      "XmlImportService.java should have importFromXml() method",
    );

    // ExportService — VULN-J2 dormant code path
    const exportPath = path.join(
      ttPolyJavaDir,
      "src",
      "main",
      "java",
      "com",
      "tamandua",
      "ledger",
      "ExportService.java",
    );
    assert.ok(
      fs.existsSync(exportPath),
      "ExportService.java should exist (dormant vuln)",
    );
    const exportContent = fs.readFileSync(exportPath, "utf-8");
    assert.ok(
      exportContent.includes("FileWriter"),
      "ExportService.java should use FileWriter",
    );
    assert.ok(
      exportContent.includes("exportToFile"),
      "ExportService.java should have exportToFile() method",
    );
  });

  it("operator-notes.local exists in java/ subtree with proper content", () => {
    const opNotesPath = path.join(ttPolyJavaDir, "operator-notes.local");
    assert.ok(
      fs.existsSync(opNotesPath),
      "operator-notes.local should exist in java/",
    );

    const content = fs.readFileSync(opNotesPath, "utf-8");
    assert.ok(content.length > 0, "operator-notes.local should not be empty");
    assert.ok(
      content.includes("TAMANDUA-TT-POLY-JAVA-OPERATOR-NOTES") ||
        content.includes("Operator Notes — tt-poly java/ Subtree"),
      "operator-notes.local should reference tt-poly java/",
    );
    assert.ok(
      content.includes("tt-poly java/ Subtree") ||
        content.includes("tt-poly java/"),
      "operator-notes.local should mention tt-poly java/",
    );
  });

  it("JUNK-IS-INTENTIONAL.md exists and references target/ junk probe", () => {
    const junkPath = path.join(ttPolyJavaDir, "JUNK-IS-INTENTIONAL.md");
    assert.ok(
      fs.existsSync(junkPath),
      "JUNK-IS-INTENTIONAL.md should exist in java/",
    );

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

  it("README-JUNK.md exists and documents java/ junk probes", () => {
    const readmeJunkPath = path.join(ttPolyJavaDir, "README-JUNK.md");
    assert.ok(
      fs.existsSync(readmeJunkPath),
      "README-JUNK.md should exist in java/",
    );

    const content = fs.readFileSync(readmeJunkPath, "utf-8");
    assert.ok(
      content.includes("operator-notes.local"),
      "README-JUNK.md should document operator-notes.local",
    );
    assert.ok(
      content.includes("target/"),
      "README-JUNK.md should document target/ junk probe",
    );
    assert.ok(
      content.includes("tt-poly"),
      "README-JUNK.md should reference tt-poly",
    );
  });

  it("README.md exists with JAVA_HOME setup instructions", () => {
    const readmePath = path.join(ttPolyJavaDir, "README.md");
    assert.ok(fs.existsSync(readmePath), "README.md should exist");

    const content = fs.readFileSync(readmePath, "utf-8");
    assert.ok(
      content.includes("JAVA_HOME"),
      "README.md should document JAVA_HOME requirement",
    );
    assert.ok(
      content.includes("mvnw"),
      "README.md should mention Maven Wrapper",
    );
    assert.ok(
      content.includes("./mvnw -q -B test"),
      "README.md should document test command",
    );
    assert.ok(
      content.includes("JDK 21"),
      "README.md should mention JDK 21 requirement",
    );
    assert.ok(
      content.includes("tt-poly"),
      "README.md should reference tt-poly",
    );
  });

  it("seeds/ directory contains POLY-J* seed patches with fix patches", () => {
    const seedsDir = path.join(ttPolyJavaDir, "seeds");
    assert.ok(fs.existsSync(seedsDir), "seeds/ should exist");

    const seedFiles = [
      "POLY-BUG-J1.patch",
      "POLY-BUG-J2.patch",
      "POLY-BUG-J3.patch",
      "POLY-BUG-J4.patch",
      "POLY-BRK-J1.patch",
      "POLY-BRK-J2.patch",
    ];

    for (const f of seedFiles) {
      const fPath = path.join(seedsDir, f);
      assert.ok(fs.existsSync(fPath), `seeds/${f} should exist`);
      assert.ok(fs.statSync(fPath).isFile(), `seeds/${f} should be a file`);
    }

    const fixDir = path.join(seedsDir, "fix");
    assert.ok(fs.existsSync(fixDir), "seeds/fix/ should exist");

    const fixFiles = [
      "POLY-BUG-J1-fix.patch",
      "POLY-BUG-J2-fix.patch",
      "POLY-BUG-J3-fix.patch",
      "POLY-BUG-J4-fix.patch",
      "POLY-BRK-J1-fix.patch",
      "POLY-BRK-J2-fix.patch",
      "POLY-VULN-J1-fix.patch",
      "POLY-VULN-J2-fix.patch",
    ];

    for (const f of fixFiles) {
      const fPath = path.join(fixDir, f);
      assert.ok(fs.existsSync(fPath), `seeds/fix/${f} should exist`);
    }

    // Verify a seed patch contains correct path prefix
    const bugJ1Patch = fs.readFileSync(
      path.join(seedsDir, "POLY-BUG-J1.patch"),
      "utf-8",
    );
    assert.ok(
      bugJ1Patch.includes("tt-poly/java/"),
      "POLY-BUG-J1.patch should reference tt-poly/java/ paths",
    );
  });

  it("seeds/SEEDS.md documents POLY-J* IDs (not old BUG-J* IDs)", () => {
    const seedsMdPath = path.join(ttPolyJavaDir, "seeds", "SEEDS.md");
    assert.ok(fs.existsSync(seedsMdPath), "seeds/SEEDS.md should exist");

    const content = fs.readFileSync(seedsMdPath, "utf-8");

    // Must use POLY-J* naming
    assert.ok(
      content.includes("POLY-BUG-J1"),
      "SEEDS.md should document POLY-BUG-J1",
    );
    assert.ok(
      content.includes("POLY-BUG-J4"),
      "SEEDS.md should document POLY-BUG-J4",
    );
    assert.ok(
      content.includes("POLY-VULN-J1"),
      "SEEDS.md should document POLY-VULN-J1",
    );
    assert.ok(
      content.includes("POLY-VULN-J2"),
      "SEEDS.md should document POLY-VULN-J2",
    );
    assert.ok(
      content.includes("POLY-BRK-J1"),
      "SEEDS.md should document POLY-BRK-J1",
    );
    assert.ok(
      content.includes("POLY-BRK-J2"),
      "SEEDS.md should document POLY-BRK-J2",
    );

    // Should reference tt-poly context
    assert.ok(
      content.includes("tt-poly java/") ||
        content.includes("tt-poly java\\/"),
      "SEEDS.md should reference tt-poly java/",
    );

    // Should NOT use old BUG-J* naming alone (without POLY- prefix)
    // Use negative lookbehind to avoid matching BUG-J1 within POLY-BUG-J1.
    assert.ok(
      !/(?<!POLY-)BUG-J1\b/m.test(content),
      "SEEDS.md should not have unreplaced BUG-J1 references",
    );
    assert.ok(
      !/(?<!POLY-)BRK-J1\b/m.test(content),
      "SEEDS.md should not have unreplaced BRK-J1 references",
    );
    assert.ok(
      !/(?<!POLY-)VULN-J1\b/m.test(content),
      "SEEDS.md should not have unreplaced VULN-J1 references",
    );
  });

  it("java/ directory has no stale .gitkeep placeholder", () => {
    const gitkeepPath = path.join(ttPolyJavaDir, ".gitkeep");
    assert.ok(
      !fs.existsSync(gitkeepPath),
      "java/.gitkeep should be removed (directory has real content)",
    );
  });
});
