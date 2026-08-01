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

// Feature backlog expectations per subtree — matches spec 09 storm roster
// S1: go/worker-pool, S2: java/ledger, S3: python/scheduling, S5/S9: ts/src/store.ts
const featureBacklogs = [
  {
    name: "python",
    featIDs: ["POLY-FEAT-P1", "POLY-FEAT-P2", "POLY-FEAT-P3"],
    flavors: ["Backend", "Backend", "Backend"],
    stormTaskArea: "python/scheduling (S3)",
    stormKeywords: [
      ["recurrence", "engine"],
      ["timezone", "scheduling", "engine"],
      ["reminder", "engine"],
    ],
  },
  {
    name: "ts",
    featIDs: ["POLY-FEAT-T1", "POLY-FEAT-T2", "POLY-FEAT-T3", "POLY-FEAT-T4"],
    flavors: ["Frontend", "Frontend", "Backend", "Backend"],
    stormTaskArea: "ts/src/store.ts (S5/S9 overlap pair)",
    stormKeywords: [
      ["store.ts", "InMemoryStore", "category"],
      ["store.ts", "store.getCategoryTotalsByMonth", "dashboard"],
      ["server.ts", "CSV", "export"],
      ["store.ts", "recurring", "server.ts"],
    ],
  },
  {
    name: "go",
    featIDs: ["POLY-FEAT-G1", "POLY-FEAT-G2", "POLY-FEAT-G3"],
    flavors: ["Backend", "Backend", "Backend"],
    stormTaskArea: "go/worker-pool (S1)",
    stormKeywords: [
      ["worker", "pool", "env"],
      ["priority", "task", "queue"],
      ["retry", "backoff"],
    ],
  },
  {
    name: "rust",
    featIDs: ["POLY-FEAT-R1", "POLY-FEAT-R2", "POLY-FEAT-R3"],
    flavors: ["Backend", "Backend", "Backend"],
    stormTaskArea: "rust/ rate limiter (S4)",
    stormKeywords: [
      ["sliding", "window", "VecDeque"],
      ["per-key", "HashMap", "Key"],
      ["metrics", "counter", "statistics"],
    ],
  },
  {
    name: "java",
    featIDs: ["POLY-FEAT-J1", "POLY-FEAT-J2", "POLY-FEAT-J3", "POLY-FEAT-J4"],
    flavors: ["Backend", "Backend", "Backend", "Backend"],
    stormTaskArea: "java/ledger (S2)",
    stormKeywords: [
      ["tag", "tagging", "label"],
      ["monthly", "report"],
      ["validate", "dry-run"],
      ["date", "format"],
    ],
  },
];

/**
 * Find the table row for a feature ID by searching for backtick-quoted form.
 * Returns the content of the table row line, or empty string if not found.
 */
function findFeatureRow(content: string, featID: string): string {
  const searchStr = `\`${featID}\``;
  const idx = content.indexOf(searchStr);
  if (idx < 0) return "";

  // Get the full line containing this feature ID
  const lineStart = content.lastIndexOf("\n", idx) + 1;
  const lineEnd = content.indexOf("\n", idx);
  return content.slice(lineStart, lineEnd);
}

/**
 * Check if any keyword appears in the given text (case-insensitive).
 */
function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

describe("tt-poly feature backlog (US-015)", () => {
  // ── AC1: All 5 subtrees have feature backlogs in FIXTURE.md ──
  describe("AC1 — feature backlog presence", () => {
    for (const fb of featureBacklogs) {
      it(`${fb.name}/FIXTURE.md has feature backlog section`, () => {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");
        const hasSection =
          content.includes("Seeded Features") ||
          content.includes("Feature Backlog") ||
          content.includes("feature backlog");
        assert.ok(
          hasSection,
          `${fb.name}/FIXTURE.md should have a feature backlog section`,
        );
      });

      it(`${fb.name}/FIXTURE.md documents all expected feature IDs`, () => {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");
        for (const featID of fb.featIDs) {
          assert.ok(
            content.includes(featID),
            `${fb.name}/FIXTURE.md should document ${featID}`,
          );
        }
      });
    }
  });

  // ── AC2: Features match storm roster task areas from spec 09 ──
  describe("AC2 — storm task area alignment", () => {
    for (const fb of featureBacklogs) {
      it(`${fb.name} feature backlog aligns with storm task area: ${fb.stormTaskArea}`, () => {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");

        for (let i = 0; i < fb.featIDs.length; i++) {
          const featID = fb.featIDs[i];
          const keywords = fb.stormKeywords[i];

          // Find the table row for this feature (backtick-quoted)
          const rowLine = findFeatureRow(content, featID);
          assert.ok(rowLine.length > 0, `${featID} table row not found in ${fb.name}/FIXTURE.md`);

          // Check keywords in the row
          const foundKeywords = keywords.filter(kw =>
            rowLine.toLowerCase().includes(kw.toLowerCase()),
          );
          assert.ok(
            foundKeywords.length > 0,
            `${fb.name}: Feature ${featID} should mention at least one of [${keywords.join(", ")}] in its table row.\nRow: ${rowLine.slice(0, 200)}`,
          );
        }
      });
    }

    // Specific storm roster alignment checks
    it("go/ worker-pool features (S1) reference pool/worker concepts", () => {
      const content = fs.readFileSync(path.join(ttPolyRoot, "go", "FIXTURE.md"), "utf-8");
      const featSectionStart = content.indexOf("## Seeded Features");
      const featSection = content.slice(featSectionStart);
      assert.ok(
        featSection.includes("pool") || featSection.includes("WorkerPool") || featSection.includes("worker"),
        "go/ features should reference worker-pool concepts (storm S1 task area)",
      );
    });

    it("java/ ledger features (S2) reference ledger/CSV concepts", () => {
      const content = fs.readFileSync(path.join(ttPolyRoot, "java", "FIXTURE.md"), "utf-8");
      const featSectionStart = content.indexOf("## Feature Backlog");
      const featSection = content.slice(featSectionStart);
      assert.ok(
        featSection.includes("Ledger") || featSection.includes("CSV") || featSection.includes("CliApp"),
        "java/ features should reference ledger concepts (storm S2 task area)",
      );
    });

    it("python/ scheduling features (S3) reference scheduling concepts", () => {
      const content = fs.readFileSync(path.join(ttPolyRoot, "python", "FIXTURE.md"), "utf-8");
      const featSectionStart = content.indexOf("## Seeded Features");
      const featSection = content.slice(featSectionStart);
      assert.ok(
        featSection.includes("event") || featSection.includes("scheduling") || featSection.includes("recurrence"),
        "python/ features should reference scheduling concepts (storm S3 task area)",
      );
    });

    it("ts/ features (S5/S9) reference store.ts", () => {
      const content = fs.readFileSync(path.join(ttPolyRoot, "ts", "FIXTURE.md"), "utf-8");
      const featSectionStart = content.indexOf("## Seeded Features");
      const featSection = content.slice(featSectionStart);
      assert.ok(
        featSection.includes("store.ts") || featSection.includes("InMemoryStore"),
        "ts/ features should reference store.ts (storm S5/S9 overlap task area)",
      );
    });
  });

  // ── AC3: Each feature has stable ID, description, and acceptance boundaries ──
  describe("AC3 — feature structure (ID, Flavor, Description, Acceptance Boundaries)", () => {
    for (const fb of featureBacklogs) {
      it(`${fb.name}/FIXTURE.md feature table has Flavor column`, () => {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");

        const featSectionStart =
          content.indexOf("## Seeded Features") >= 0
            ? content.indexOf("## Seeded Features")
            : content.indexOf("## Feature Backlog");

        const nextSection = content.indexOf("\n## ", featSectionStart + 1);
        const featSection = nextSection > 0
          ? content.slice(featSectionStart, nextSection)
          : content.slice(featSectionStart);

        const tableStart = featSection.indexOf("| ID");
        assert.ok(tableStart >= 0, `${fb.name}/FIXTURE.md feature section should have a table`);
        const headerEnd = featSection.indexOf("\n", tableStart);
        const headerRow = featSection.slice(tableStart, headerEnd);
        assert.ok(
          headerRow.includes("Flavor"),
          `${fb.name}/FIXTURE.md feature table should have a Flavor column.\nHeader: ${headerRow}`,
        );
      });

      it(`${fb.name}/FIXTURE.md feature table has Acceptance Boundaries column`, () => {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");

        const featSectionStart =
          content.indexOf("## Seeded Features") >= 0
            ? content.indexOf("## Seeded Features")
            : content.indexOf("## Feature Backlog");

        const nextSection = content.indexOf("\n## ", featSectionStart + 1);
        const featSection = nextSection > 0
          ? content.slice(featSectionStart, nextSection)
          : content.slice(featSectionStart);

        const tableStart = featSection.indexOf("| ID");
        assert.ok(tableStart >= 0, `${fb.name}/FIXTURE.md feature section should have a table`);
        const headerEnd = featSection.indexOf("\n", tableStart);
        const headerRow = featSection.slice(tableStart, headerEnd);
        assert.ok(
          headerRow.includes("Acceptance Boundaries") || headerRow.includes("Acceptance"),
          `${fb.name}/FIXTURE.md feature table should have an Acceptance Boundaries column.\nHeader: ${headerRow}`,
        );
      });

      it(`${fb.name}/FIXTURE.md features have correct flavors`, () => {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");

        for (let i = 0; i < fb.featIDs.length; i++) {
          const featID = fb.featIDs[i];
          const expectedFlavor = fb.flavors[i];

          // Find the backtick-quoted feature ID in the table
          const rowLine = findFeatureRow(content, featID);
          assert.ok(rowLine.length > 0, `Feature ${featID} row not found`);

          assert.ok(
            rowLine.includes(expectedFlavor),
            `${fb.name}: ${featID} should have flavor "${expectedFlavor}".\nRow: ${rowLine.slice(0, 200)}`,
          );
        }
      });

      it(`${fb.name}/FIXTURE.md features have non-empty descriptions`, () => {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");

        for (const featID of fb.featIDs) {
          const rowLine = findFeatureRow(content, featID);
          assert.ok(rowLine.length > 0, `Feature ${featID} row not found`);

          // The description is between Flavor and Acceptance Boundaries columns
          // The row has format: | `POLY-FEAT-XX` | Flavor | Description | Acceptance Boundaries |
          // Get the text between the second and third-to-last pipe
          const parts = rowLine.split("|").map(p => p.trim());
          // Parts: [ '', '`FEAT-XX`', 'Flavor', 'Description text...', 'Acceptance boundaries...', '' ]
          assert.ok(
            parts.length >= 5,
            `${fb.name}: ${featID} row should have at least 5 pipe-separated parts, found ${parts.length}`,
          );

          // The description is parts[3]
          const description = parts[3] || "";
          assert.ok(
            description.length > 10,
            `${fb.name}: ${featID} should have a meaningful description (>10 chars). Found: "${description.slice(0, 50)}"`,
          );
        }
      });

      it(`${fb.name}/FIXTURE.md features have non-empty acceptance boundaries`, () => {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");

        for (const featID of fb.featIDs) {
          const rowLine = findFeatureRow(content, featID);
          assert.ok(rowLine.length > 0, `Feature ${featID} row not found`);

          // Get the acceptance boundaries (last significant pipe section)
          const parts = rowLine.split("|").map(p => p.trim());
          assert.ok(
            parts.length >= 5,
            `${fb.name}: ${featID} row should have at least 5 parts`,
          );

          // The acceptance boundaries are in parts[4] (fifth pipe section)
          const acceptance = parts[4] || "";
          assert.ok(
            acceptance.length > 10,
            `${fb.name}: ${featID} should have non-empty acceptance boundaries (>10 chars). Found: "${acceptance.slice(0, 50)}"`,
          );
        }
      });
    }

    // ts-specific: exactly 2 frontend and 2 backend
    it("ts/ FIXTURE.md has exactly 2 frontend-flavored and 2 backend-flavored features", () => {
      const content = fs.readFileSync(path.join(ttPolyRoot, "ts", "FIXTURE.md"), "utf-8");
      const featSectionStart = content.indexOf("## Seeded Features");
      const nextSection = content.indexOf("\n## ", featSectionStart + 1);
      const featSection = content.slice(featSectionStart, nextSection > 0 ? nextSection : undefined);

      const frontendCount = (featSection.match(/\| `POLY-FEAT-T\d` \| Frontend \|/g) || []).length;
      const backendCount = (featSection.match(/\| `POLY-FEAT-T\d` \| Backend \|/g) || []).length;

      assert.equal(frontendCount, 2, `ts/ should have 2 frontend-flavored features, found ${frontendCount}`);
      assert.equal(backendCount, 2, `ts/ should have 2 backend-flavored features, found ${backendCount}`);
    });

    // go/rust/java/python all backend
    for (const fb of featureBacklogs.filter(f => f.name !== "ts")) {
      it(`${fb.name}/ FIXTURE.md features are all Backend-flavored`, () => {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");

        const featSectionStart =
          content.indexOf("## Seeded Features") >= 0
            ? content.indexOf("## Seeded Features")
            : content.indexOf("## Feature Backlog");
        const nextSection = content.indexOf("\n## ", featSectionStart + 1);
        const featSection = content.slice(featSectionStart, nextSection > 0 ? nextSection : undefined);

        // Should not have any Frontend flavor
        const frontendLines = featSection.match(/\| `POLY-FEAT-.*` \| Frontend \|/g);
        assert.ok(
          !frontendLines || frontendLines.length === 0,
          `${fb.name}/FIXTURE.md should not have Frontend-flavored features`,
        );
      });
    }
  });

  // ── AC4: Features are documentation only (no seed patches created) ──
  describe("AC4 — features are documentation only", () => {
    const seedsRoot = path.join(ttPolyRoot, "seeds");

    it("no FEAT seed directories exist under seeds/", () => {
      if (!fs.existsSync(seedsRoot)) return;
      const entries = fs.readdirSync(seedsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toUpperCase().includes("FEAT")) {
          assert.fail(
            `Found feature seed directory: seeds/${entry.name}. Features should be documentation only.`,
          );
        }
        if (entry.isFile() && entry.name.toUpperCase().includes("FEAT")) {
          assert.fail(
            `Found feature seed file: seeds/${entry.name}. Features should be documentation only.`,
          );
        }
      }
    });

    it("no FEAT seed patches exist in per-subtree seeds/ directories", () => {
      for (const fb of featureBacklogs) {
        const subtreeSeeds = path.join(ttPolyRoot, fb.name, "seeds");
        if (!fs.existsSync(subtreeSeeds)) continue;

        const walkDir = (dir: string): void => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (entry.name.toUpperCase().includes("FEAT")) {
                assert.fail(
                  `Feature seed in ${fb.name}/: ${entry.name}. Features should be documentation only.`,
                );
              }
              walkDir(fullPath);
            } else if (entry.isFile() && entry.name.toUpperCase().includes("FEAT")) {
              assert.fail(
                `Feature seed file in ${fb.name}/: ${entry.name}. Features should be documentation only.`,
              );
            }
          }
        };
        walkDir(subtreeSeeds);
      }
    });

    it("each FIXTURE.md states features are documentation only", () => {
      for (const fb of featureBacklogs) {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");

        const featSectionStart =
          content.indexOf("## Seeded Features") >= 0
            ? content.indexOf("## Seeded Features")
            : content.indexOf("## Feature Backlog");
        const nextSection = content.indexOf("\n## ", featSectionStart + 1);
        const featSection = content.slice(featSectionStart, nextSection > 0 ? nextSection : undefined);

        assert.ok(
          featSection.includes("documentation only"),
          `${fb.name}/FIXTURE.md feature section should state features are documentation only`,
        );
      }
    });
  });

  // ── Cross-feature consistency ──
  describe("cross-feature consistency", () => {
    it("all feature IDs use POLY-FEAT-* naming convention", () => {
      for (const fb of featureBacklogs) {
        for (const featID of fb.featIDs) {
          assert.ok(
            featID.startsWith("POLY-FEAT-"),
            `${featID} should use POLY-FEAT-* naming convention`,
          );
          assert.ok(
            /^POLY-FEAT-[PTGRJ]\d$/.test(featID),
            `${featID} should match pattern POLY-FEAT-<LANG><NUM>`,
          );
        }
      }
    });

    it("total feature count across all 5 subtrees is correct (17 features)", () => {
      const totalFeatures = featureBacklogs.reduce((sum, fb) => sum + fb.featIDs.length, 0);
      assert.equal(
        totalFeatures,
        17,
        `Expected 17 total features (3+4+3+3+4), got ${totalFeatures}`,
      );
    });

    it("every feature ID in FIXTURE.md uses backtick formatting in table row", () => {
      for (const fb of featureBacklogs) {
        const mdPath = path.join(ttPolyRoot, fb.name, "FIXTURE.md");
        const content = fs.readFileSync(mdPath, "utf-8");
        for (const featID of fb.featIDs) {
          const backtickQuoted = "`" + featID + "`";
          assert.ok(
            content.includes(backtickQuoted),
            `${fb.name}/FIXTURE.md: ${featID} should use backtick formatting (\`${featID}\`)`,
          );
        }
      }
    });

    it("go/ features reference worker-pool concepts (storm S1)", () => {
      const content = fs.readFileSync(path.join(ttPolyRoot, "go", "FIXTURE.md"), "utf-8");
      const featSectionStart = content.indexOf("## Seeded Features");
      const featSection = content.slice(featSectionStart);
      const workerPoolRefs = [
        "WorkerPool",
        "worker",
        "pool size",
        "NewPool",
        "maxWorkers",
        "Task",
        "task queue",
        "priority",
        "retry",
      ];
      const foundRefs = workerPoolRefs.filter(r => featSection.toLowerCase().includes(r.toLowerCase()));
      assert.ok(
        foundRefs.length >= 3,
        `go/ features should extensively reference worker-pool concepts (found ${foundRefs.length}: ${foundRefs.join(", ")})`,
      );
    });

    it("java/ features reference ledger/CLI concepts (storm S2)", () => {
      const content = fs.readFileSync(path.join(ttPolyRoot, "java", "FIXTURE.md"), "utf-8");
      const featSectionStart = content.indexOf("## Feature Backlog");
      const featSection = content.slice(featSectionStart);
      const ledgerRefs = [
        "LedgerEntry",
        "CliApp",
        "CsvParser",
        "LedgerService",
        "CSV",
        "tag",
        "report",
        "validate",
        "date format",
      ];
      const foundRefs = ledgerRefs.filter(r => featSection.toLowerCase().includes(r.toLowerCase()));
      assert.ok(
        foundRefs.length >= 3,
        `java/ features should extensively reference ledger/CSV concepts (found ${foundRefs.length}: ${foundRefs.join(", ")})`,
      );
    });
  });
});
