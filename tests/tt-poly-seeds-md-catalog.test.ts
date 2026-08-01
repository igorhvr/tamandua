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
const seedsMdPath = path.join(ttPolyRoot, "seeds", "SEEDS.md");

interface SubtreeSeedInfo {
  name: string;
  langPrefix: string;
  bugIds: string[];
  vulnIds: string[];
  brkIds: string[];
  flakyIds: string[];
  seedFormat: string; // description of seed format convention
}

const subtrees: SubtreeSeedInfo[] = [
  {
    name: "python",
    langPrefix: "P",
    bugIds: ["P1", "P2", "P3", "P4"],
    vulnIds: ["P1", "P2"],
    brkIds: ["P1", "P2"],
    flakyIds: ["P1"],
    seedFormat: "full-file overlays",
  },
  {
    name: "ts",
    langPrefix: "T",
    bugIds: ["T1", "T2", "T3", "T4"],
    vulnIds: ["T1", "T2"],
    brkIds: ["T1", "T2"],
    flakyIds: [],
    seedFormat: "git patches",
  },
  {
    name: "go",
    langPrefix: "G",
    bugIds: ["G1", "G2", "G3", "G4"],
    vulnIds: ["G1", "G2"],
    brkIds: ["G1", "G2"],
    flakyIds: [],
    seedFormat: "full-file overlays",
  },
  {
    name: "rust",
    langPrefix: "R",
    bugIds: ["R1", "R2", "R3", "R4"],
    vulnIds: ["R1", "R2"],
    brkIds: ["R1", "R2"],
    flakyIds: [],
    seedFormat: "full-file overlays",
  },
  {
    name: "java",
    langPrefix: "J",
    bugIds: ["J1", "J2", "J3", "J4"],
    vulnIds: ["J1", "J2"],
    brkIds: ["J1", "J2"],
    flakyIds: [],
    seedFormat: "git patches",
  },
];

const archetypes = ["A1", "A2", "A3", "A4", "A5"];

describe("tt-poly seeds/SEEDS.md master catalog (US-011)", () => {
  it("seeds/SEEDS.md exists", () => {
    assert.ok(fs.existsSync(seedsMdPath), "seeds/SEEDS.md should exist");
    assert.ok(
      fs.statSync(seedsMdPath).isFile(),
      "seeds/SEEDS.md should be a file",
    );
  });

  it("SEEDS.md is non-empty and reasonable size", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");
    assert.ok(content.length > 5000, "SEEDS.md should be at least 5KB");
  });

  // --- Header / Fixture identification ---
  it("SEEDS.md identifies the fixture as tt-poly", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");
    assert.ok(
      content.includes("tt-poly"),
      "SEEDS.md should reference tt-poly",
    );
    assert.ok(
      content.includes("five-language") || content.includes("5-language"),
      "SEEDS.md should mention five-language",
    );
  });

  // --- Per-subtree seed documentation ---
  for (const subtree of subtrees) {
    describe(`${subtree.name}/ seeds in SEEDS.md`, () => {
      const content = fs.readFileSync(seedsMdPath, "utf-8");
      const prefix = `POLY-BUG-${subtree.langPrefix}`;

      it(`documents ${subtree.name}/ seeds section`, () => {
        assert.ok(
          content.includes(`## ${subtree.name}/ Seeds`),
          `SEEDS.md should have a "${subtree.name}/ Seeds" section`,
        );
      });

      // BUG seeds
      for (const bugId of subtree.bugIds) {
        const fullId = `POLY-BUG-${bugId}`;
        it(`documents ${fullId}`, () => {
          assert.ok(
            content.includes(fullId),
            `SEEDS.md should document ${fullId}`,
          );
        });

        it(`${fullId} has difficulty, modules, description, and verification`, () => {
          // Find the section for this seed
          const idx = content.indexOf(`### ${fullId}`);
          assert.ok(idx >= 0, `SEEDS.md should have a '### ${fullId}' heading`);
          // Extract the section for this seed (to the next ### or ## heading)
          const afterHeading = content.slice(idx);
          const nextHeading = afterHeading.search(/\n(?:###|##) /);
          const section =
            nextHeading >= 0
              ? afterHeading.slice(0, nextHeading)
              : afterHeading;

          assert.ok(
            section.includes("Difficulty"),
            `${fullId} should document Difficulty`,
          );
          assert.ok(
            section.includes("Modules"),
            `${fullId} should document Modules`,
          );
          assert.ok(
            section.includes("Description") || section.includes("**Description**"),
            `${fullId} should document Description`,
          );
          assert.ok(
            section.includes("Verification") || section.includes("Verify"),
            `${fullId} should document Verification`,
          );
        });
      }

      // VULN seeds
      for (const vulnId of subtree.vulnIds) {
        const fullId = `POLY-VULN-${vulnId}`;
        it(`documents ${fullId}`, () => {
          assert.ok(
            content.includes(fullId),
            `SEEDS.md should document ${fullId}`,
          );
        });
      }

      // BRK seeds
      for (const brkId of subtree.brkIds) {
        const fullId = `POLY-BRK-${brkId}`;
        it(`documents ${fullId}`, () => {
          assert.ok(
            content.includes(fullId),
            `SEEDS.md should document ${fullId}`,
          );
        });
      }

      // FLAKY seeds
      for (const flakyId of subtree.flakyIds) {
        const fullId = `POLY-FLAKY-${flakyId}`;
        it(`documents ${fullId}`, () => {
          assert.ok(
            content.includes(fullId),
            `SEEDS.md should document ${fullId}`,
          );
        });
      }

      it(`cross-references ${subtree.name}/FIXTURE.md`, () => {
        assert.ok(
          content.includes(`${subtree.name}/FIXTURE.md`),
          `SEEDS.md should reference ${subtree.name}/FIXTURE.md`,
        );
      });
    });
  }

  // --- Cross-language seed POLY-BUG-A5 ---
  describe("POLY-BUG-A5 cross-language seed", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    it("documents POLY-BUG-A5 in a dedicated section", () => {
      assert.ok(
        content.includes("### POLY-BUG-A5"),
        "SEEDS.md should have a '### POLY-BUG-A5' heading for the cross-language seed",
      );
    });

    it("documents A5 archetype", () => {
      assert.ok(
        content.includes("A5") && content.includes("cross-language"),
        "SEEDS.md should document A5 as cross-language archetype",
      );
    });

    it("documents python/ and ts/ modules", () => {
      assert.ok(
        content.includes("integrations.py") &&
          content.includes("server.ts"),
        "SEEDS.md should document both python/ and ts/ modules for A5",
      );
    });

    it("documents partial-fix cross-language property", () => {
      assert.ok(
        content.includes("partial-fix") &&
          content.includes("cross-language"),
        "SEEDS.md should document the cross-language partial-fix property for A5",
      );
    });
  });

  // --- Archetype Summary Table ---
  describe("Archetype summary", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    it("has Archetype Summary section", () => {
      assert.ok(
        content.includes("## Archetype Summary"),
        "SEEDS.md should have an 'Archetype Summary' section",
      );
    });

    for (const arch of archetypes) {
      it(`documents archetype ${arch}`, () => {
        const archRE = new RegExp(`\\|\\s*${arch}\\s*\\|`);
        assert.ok(
          archRE.test(content),
          `SEEDS.md should document archetype ${arch} in the summary table`,
        );
      });
    }
  });

  // --- Archetype-to-Seed Mapping ---
  describe("Archetype-to-seed mapping", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    it("has Archetype-to-Seed Mapping subsection", () => {
      assert.ok(
        content.includes("Archetype-to-Seed Mapping"),
        "SEEDS.md should have 'Archetype-to-Seed Mapping' subsection",
      );
    });

    it("maps A1 to all 5 subtrees", () => {
      const archSection = content.slice(
        content.indexOf("Archetype-to-Seed Mapping"),
      );
      const nextSection = archSection.search(/\n## /);
      const section =
        nextSection >= 0
          ? archSection.slice(0, nextSection)
          : archSection;
      assert.ok(
        section.includes("POLY-BUG-P1") &&
          section.includes("POLY-BUG-T1") &&
          section.includes("POLY-BUG-G1") &&
          section.includes("POLY-BUG-R1") &&
          section.includes("POLY-BUG-J1"),
        "Archetype-to-seed mapping should map A1 to all 5 subtrees",
      );
    });

    it("maps A5 to POLY-BUG-A5 in python/ and ts/", () => {
      const archSection = content.slice(
        content.indexOf("Archetype-to-Seed Mapping"),
      );
      const nextSection = archSection.search(/\n## /);
      const section =
        nextSection >= 0
          ? archSection.slice(0, nextSection)
          : archSection;
      assert.ok(
        section.includes("POLY-BUG-A5"),
        "Archetype-to-seed mapping should include POLY-BUG-A5",
      );
    });
  });

  // --- Seed Application Conventions ---
  describe("Seed application conventions", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    it("has Seed Application Conventions section", () => {
      assert.ok(
        content.includes("## Seed Application Conventions"),
        "SEEDS.md should have 'Seed Application Conventions' section",
      );
    });

    for (const subtree of subtrees) {
      it(`documents application convention for ${subtree.name}/`, () => {
        const sectionIdx = content.indexOf(
          `### ${subtree.name}/ seeds`,
        );
        assert.ok(
          sectionIdx >= 0,
          `SEEDS.md should have application convention for ${subtree.name}/`,
        );
      });
    }

    it("documents POLY-BUG-A5 cross-language application", () => {
      assert.ok(
        content.includes("### POLY-BUG-A5 (cross-language"),
        "SEEDS.md should document POLY-BUG-A5 application convention",
      );
    });

    it("documents POLY-FLAKY-P1 arming convention", () => {
      assert.ok(
        content.includes("POLY-FLAKY-P1"),
        "SEEDS.md should document POLY-FLAKY-P1 application",
      );
    });
  });

  // --- Storm Composition ---
  describe("Storm composition", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    it("has Storm Composition section", () => {
      assert.ok(
        content.includes("## Storm Composition"),
        "SEEDS.md should have 'Storm Composition' section",
      );
    });

    it("references storm/STORM.md", () => {
      assert.ok(
        content.includes("STORM.md"),
        "SEEDS.md should reference STORM.md",
      );
    });

    it("documents storm roster with all 41 seeds", () => {
      const stormIdx = content.indexOf("### storm roster");
      assert.ok(stormIdx >= 0, "SEEDS.md should have 'storm roster' subsection");

      // Count seed entries in the roster table
      const afterRoster = content.slice(stormIdx);
      const nextHeading = afterRoster.search(/\n## /);
      const rosterSection =
        nextHeading >= 0
          ? afterRoster.slice(0, nextHeading)
          : afterRoster;

      // Count POLY- entries in table rows
      const polyMatches =
        rosterSection.match(/POLY-(BUG|VULN|BRK)-\w\d/g);
      // 20 BUG (21 with A5) + 10 VULN + 10 BRK = 41
      assert.ok(
        polyMatches && polyMatches.length >= 40,
        `Storm roster should document at least 40 seeds (found ${polyMatches ? polyMatches.length : 0})`,
      );
    });

    it("includes POLY-BUG-A5 in storm roster", () => {
      const stormIdx = content.indexOf("### storm roster");
      const afterRoster = content.slice(stormIdx);
      const nextHeading = afterRoster.search(/\n## /);
      const rosterSection =
        nextHeading >= 0
          ? afterRoster.slice(0, nextHeading)
          : afterRoster;
      assert.ok(
        rosterSection.includes("POLY-BUG-A5"),
        "Storm roster should include POLY-BUG-A5",
      );
    });
  });

  // --- Seed Catalog Summary Table ---
  describe("Seed catalog summary", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    it("has Seed Catalog Summary section", () => {
      assert.ok(
        content.includes("## Seed Catalog Summary"),
        "SEEDS.md should have 'Seed Catalog Summary' section",
      );
    });

    it("lists all 5 subtrees in the summary table", () => {
      const summaryIdx = content.indexOf("## Seed Catalog Summary");
      const afterSummary = content.slice(summaryIdx);
      const nextHeading = afterSummary.search(/\n## /);
      const summarySection =
        nextHeading >= 0
          ? afterSummary.slice(0, nextHeading)
          : afterSummary;

      for (const subtree of subtrees) {
        assert.ok(
          summarySection.includes(`${subtree.name}/`),
          `Seed catalog summary should include ${subtree.name}/`,
        );
      }
    });

    it("includes cross-language row in summary table", () => {
      const summaryIdx = content.indexOf("## Seed Catalog Summary");
      const afterSummary = content.slice(summaryIdx);
      const nextHeading = afterSummary.search(/\n## /);
      const summarySection =
        nextHeading >= 0
          ? afterSummary.slice(0, nextHeading)
          : afterSummary;
      assert.ok(
        summarySection.includes("cross-language"),
        "Seed catalog summary should include cross-language row",
      );
    });
  });

  // --- Cross-References ---
  describe("Cross-references", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    it("has Cross-References section", () => {
      assert.ok(
        content.includes("## Cross-References"),
        "SEEDS.md should have 'Cross-References' section",
      );
    });

    for (const subtree of subtrees) {
      it(`cross-references ${subtree.name}/FIXTURE.md`, () => {
        assert.ok(
          content.includes(`${subtree.name}/FIXTURE.md`),
          `Cross-references should include ${subtree.name}/FIXTURE.md`,
        );
      });
    }

    it("cross-references per-subtree SEEDS.md files", () => {
      for (const sub of ["python", "go", "rust", "java"]) {
        assert.ok(
          content.includes(`${sub}/seeds/SEEDS.md`),
          `Cross-references should include ${sub}/seeds/SEEDS.md`,
        );
      }
    });

    it("cross-references fixture spec files", () => {
      assert.ok(
        content.includes("02-fixture-projects.md") ||
          content.includes("tamandua-torture-test-spec"),
        "SEEDS.md should cross-reference fixture spec files",
      );
      assert.ok(
        content.includes("09-wave-5-storm.md") ||
          content.includes("wave-5-storm"),
        "SEEDS.md should cross-reference storm spec",
      );
    });
  });

  // --- Per-Subtree Seed Layouts ---
  describe("Per-subtree seed layouts", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    it("has Per-Subtree Seed Layouts section", () => {
      assert.ok(
        content.includes("## Per-Subtree Seed Layouts"),
        "SEEDS.md should have 'Per-Subtree Seed Layouts' section",
      );
    });

    for (const subtree of subtrees) {
      it(`documents ${subtree.name}/ seed layout`, () => {
        assert.ok(
          content.includes(`### ${subtree.name}/`),
          `SEEDS.md should have '### ${subtree.name}/' seed layout subsection`,
        );
      });
    }
  });

  // --- Document-wide consistency ---
  describe("SEEDS.md consistency", () => {
    const content = fs.readFileSync(seedsMdPath, "utf-8");

    it("all POLY- IDs use uppercase prefix convention", () => {
      // Find all POLY- IDs
      const allIds = content.match(/POLY-[A-Z]+-[A-Z]+\d+/g) || [];
      // Check that all IDs start with POLY-BUG-, POLY-VULN-, POLY-BRK-, POLY-FLAKY-, POLY-FEAT-
      const validPrefixes = ["POLY-BUG-", "POLY-VULN-", "POLY-BRK-", "POLY-FLAKY-", "POLY-FEAT-"];
      for (const id of allIds) {
        const hasValidPrefix = validPrefixes.some((p) => id.startsWith(p));
        assert.ok(
          hasValidPrefix,
          `${id} should use a valid POLY- prefix (BUG/VULN/BRK/FLAKY/FEAT)`,
        );
      }
    });

    it("no non-POLY prefixed old IDs present", () => {
      const oldIds = ["BUG-J", "BUG-G", "BUG-R", "BUG-P", "BUG-T",
        "VULN-J", "VULN-G", "VULN-R", "BRK-J", "BRK-G", "BRK-R"];
      for (const oldId of oldIds) {
        // Check standalone (not prefixed with POLY-)
        const re = new RegExp(`(?<!POLY-)${oldId}\\d`, "g");
        const matches = content.match(re);
        assert.ok(
          !matches || matches.length === 0,
          `SEEDS.md should not contain old non-POLY ID pattern: ${oldId}`,
        );
      }
    });

    it("documents FLAKY seed as having no fix.patch", () => {
      assert.ok(
        content.includes("POLY-FLAKY-P1") &&
          (content.includes("no fix.patch") || content.includes("No fix.patch")),
        "SEEDS.md should document POLY-FLAKY-P1 as having no fix.patch",
      );
    });

    it("documents ts/ VULN seeds as baseline-only (no seed patch)", () => {
      // Check that ts VULN seeds are documented as having no seed patch
      const tsSection = content.slice(
        content.indexOf("## ts/ Seeds"),
        content.indexOf("## go/ Seeds"),
      );
      assert.ok(
        tsSection.includes("No seed patch exists") ||
          tsSection.includes("Fix patch only"),
        "ts/ VULN seeds should be documented as having no seed patch",
      );
    });

    it("documents java/ VULN seeds as dormant baseline classes", () => {
      const javaSection = content.slice(
        content.indexOf("## java/ Seeds"),
      );
      assert.ok(
        javaSection.includes("No seed patch") ||
          javaSection.includes("vuln IS baseline"),
        "java/ VULN seeds should be documented as dormant baseline classes",
      );
    });
  });
});
