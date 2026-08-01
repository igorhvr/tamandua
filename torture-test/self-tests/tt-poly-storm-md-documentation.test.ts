import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();
const stormMdPath = path.resolve(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly",
  "seeds",
  "storm",
  "STORM.md",
);

const content = fs.existsSync(stormMdPath)
  ? fs.readFileSync(stormMdPath, "utf-8")
  : "";

const subtrees = [
  { name: "python", prefix: "P", seedFormat: "full-file overlays" },
  { name: "ts", prefix: "T", seedFormat: "git patches" },
  { name: "go", prefix: "G", seedFormat: "full-file overlays" },
  { name: "rust", prefix: "R", seedFormat: "full-file overlays" },
  { name: "java", prefix: "J", seedFormat: "git patches" },
];

const allBugSeeds = [
  "POLY-BUG-P1", "POLY-BUG-P2", "POLY-BUG-P3", "POLY-BUG-P4",
  "POLY-BUG-T1", "POLY-BUG-T2", "POLY-BUG-T3", "POLY-BUG-T4",
  "POLY-BUG-G1", "POLY-BUG-G2", "POLY-BUG-G3", "POLY-BUG-G4",
  "POLY-BUG-R1", "POLY-BUG-R2", "POLY-BUG-R3", "POLY-BUG-R4",
  "POLY-BUG-J1", "POLY-BUG-J2", "POLY-BUG-J3", "POLY-BUG-J4",
  "POLY-BUG-A5",
];

const allVulnSeeds = [
  "POLY-VULN-P1", "POLY-VULN-P2",
  "POLY-VULN-T1", "POLY-VULN-T2",
  "POLY-VULN-G1", "POLY-VULN-G2",
  "POLY-VULN-R1", "POLY-VULN-R2",
  "POLY-VULN-J1", "POLY-VULN-J2",
];

const allBrkSeeds = [
  "POLY-BRK-P1", "POLY-BRK-P2",
  "POLY-BRK-T1", "POLY-BRK-T2",
  "POLY-BRK-G1", "POLY-BRK-G2",
  "POLY-BRK-R1", "POLY-BRK-R2",
  "POLY-BRK-J1", "POLY-BRK-J2",
];

describe("tt-poly seeds/storm/STORM.md composite storm documentation (US-012)", () => {
  // --- Existence and basic structure ---
  it("seeds/storm/STORM.md exists", () => {
    assert.ok(fs.existsSync(stormMdPath), "seeds/storm/STORM.md should exist");
    assert.ok(
      fs.statSync(stormMdPath).isFile(),
      "seeds/storm/STORM.md should be a file",
    );
    assert.ok(content.length > 1000, "STORM.md should have substantial content");
  });

  it("has title mentioning seed/storm composite ref", () => {
    assert.ok(
      content.includes("# STORM.md") || content.includes("seed/storm"),
      "Should have title with STORM.md and seed/storm reference",
    );
  });

  // --- Deterministic application order (AC-2) ---
  describe("deterministic application order (AC-2)", () => {
    for (const st of subtrees) {
      it(`documents Phase for ${st.name}/ bug seeds`, () => {
        const phasePattern = new RegExp(
          `Phase.*${st.name}/.*bug`,
          "i",
        );
        assert.ok(
          phasePattern.test(content),
          `Should document application phase for ${st.name}/ bug seeds`,
        );
      });
    }

    it("documents POLY-BUG-A5 cross-language seed application", () => {
      assert.ok(
        content.includes("POLY-BUG-A5"),
        "Should document POLY-BUG-A5 cross-language seed",
      );
    });

    it("documents all vulns phase", () => {
      assert.ok(
        /Phase.*vuln/i.test(content),
        "Should document a phase for all vulnerabilities",
      );
    });

    it("documents all broken tests phase", () => {
      assert.ok(
        /Phase.*broken/i.test(content),
        "Should document a phase for all broken tests",
      );
    });

    it("documents seed order numbers (1 through 41)", () => {
      for (let i = 1; i <= 41; i++) {
        const numPattern = new RegExp(`\\b${i}\\.\\s+POLY-`);
        assert.ok(
          numPattern.test(content),
          `Should have numbered step ${i} (POLY-...)`,
        );
      }
    });

    it("Phase 1 contains all python bug seeds in order", () => {
      const phase1Idx = content.indexOf("Phase 1: python");
      const phase2Idx = content.indexOf("Phase 2: ts/");
      assert.ok(phase1Idx >= 0, "Phase 1 should exist");
      assert.ok(phase2Idx > phase1Idx, "Phase 2 should come after Phase 1");
      const phase1Section = content.slice(phase1Idx, phase2Idx);
      for (const bugId of ["POLY-BUG-P1", "POLY-BUG-P2", "POLY-BUG-P3", "POLY-BUG-P4"]) {
        assert.ok(phase1Section.includes(bugId), `Phase 1 should include ${bugId}`);
      }
    });

    it("Phase 2 contains all ts bug seeds in order", () => {
      const phase2Idx = content.indexOf("Phase 2: ts/");
      const phase3Idx = content.indexOf("Phase 3: go/");
      assert.ok(phase2Idx >= 0, "Phase 2 should exist");
      assert.ok(phase3Idx > phase2Idx, "Phase 3 should come after Phase 2");
      const phase2Section = content.slice(phase2Idx, phase3Idx);
      for (const bugId of ["POLY-BUG-T1", "POLY-BUG-T2", "POLY-BUG-T3", "POLY-BUG-T4"]) {
        assert.ok(phase2Section.includes(bugId), `Phase 2 should include ${bugId}`);
      }
    });

    it("Phase 3 contains all go bug seeds in order", () => {
      const phase3Idx = content.indexOf("Phase 3: go/");
      const phase4Idx = content.indexOf("Phase 4: rust/");
      assert.ok(phase3Idx >= 0, "Phase 3 should exist");
      assert.ok(phase4Idx > phase3Idx, "Phase 4 should come after Phase 3");
      const phase3Section = content.slice(phase3Idx, phase4Idx);
      for (const bugId of ["POLY-BUG-G1", "POLY-BUG-G2", "POLY-BUG-G3", "POLY-BUG-G4"]) {
        assert.ok(phase3Section.includes(bugId), `Phase 3 should include ${bugId}`);
      }
    });

    it("Phase 4 contains all rust bug seeds in order", () => {
      const phase4Idx = content.indexOf("Phase 4: rust/");
      const phase5Idx = content.indexOf("Phase 5: java/");
      assert.ok(phase4Idx >= 0, "Phase 4 should exist");
      assert.ok(phase5Idx > phase4Idx, "Phase 5 should come after Phase 4");
      const phase4Section = content.slice(phase4Idx, phase5Idx);
      for (const bugId of ["POLY-BUG-R1", "POLY-BUG-R2", "POLY-BUG-R3", "POLY-BUG-R4"]) {
        assert.ok(phase4Section.includes(bugId), `Phase 4 should include ${bugId}`);
      }
    });

    it("Phase 5 contains all java bug seeds in order", () => {
      const phase5Idx = content.indexOf("Phase 5: java/");
      const phase6Idx = content.indexOf("Phase 6: POLY-BUG-A5");
      assert.ok(phase5Idx >= 0, "Phase 5 should exist");
      assert.ok(phase6Idx > phase5Idx, "Phase 6 should come after Phase 5");
      const phase5Section = content.slice(phase5Idx, phase6Idx);
      for (const bugId of ["POLY-BUG-J1", "POLY-BUG-J2", "POLY-BUG-J3", "POLY-BUG-J4"]) {
        assert.ok(phase5Section.includes(bugId), `Phase 5 should include ${bugId}`);
      }
    });

    it("Phase 7 contains all vulns", () => {
      const phase7Idx = content.indexOf("Phase 7: all vulnerabilities");
      const phase8Idx = content.indexOf("Phase 8: all broken tests");
      assert.ok(phase7Idx >= 0, "Phase 7 should exist");
      assert.ok(phase8Idx > phase7Idx, "Phase 8 should come after Phase 7");
      const phase7Section = content.slice(phase7Idx, phase8Idx);
      for (const vulnId of allVulnSeeds) {
        assert.ok(
          phase7Section.includes(vulnId),
          `Phase 7 should include ${vulnId}`,
        );
      }
    });

    it("Phase 8 contains all broken test seeds", () => {
      const phase8Idx = content.indexOf("Phase 8: all broken tests");
      assert.ok(phase8Idx >= 0, "Phase 8 should exist");
      const phase8Section = content.slice(phase8Idx);
      for (const brkId of allBrkSeeds) {
        assert.ok(
          phase8Section.includes(brkId),
          `Phase 8 should include ${brkId}`,
        );
      }
    });

    it("documents substep ordering rules (P1 before P2 for recurrence.py)", () => {
      assert.ok(
        content.includes("P2 must be applied after P1") ||
          content.includes("P1 between P2"),
        "Should document that P2 must be applied after P1 due to shared recurrence.py",
      );
    });
  });

  // --- Verified symptoms per subtree (AC-3) ---
  describe("verified symptoms per subtree (AC-3)", () => {
    for (const st of subtrees) {
      it(`documents verified symptoms for ${st.name}/ subtree`, () => {
        const symptomSectionPattern = new RegExp(
          `###\\s+${st.name}/\\s+symptoms`,
          "i",
        );
        assert.ok(
          symptomSectionPattern.test(content),
          `Should have symptoms section for ${st.name}/`,
        );
      });

      it(`${st.name}/ symptoms table has Cause column entries`, () => {
        const symptomIdx = content.indexOf(`### ${st.name}/ symptoms`);
        assert.ok(symptomIdx >= 0, `Should have ${st.name}/ symptoms section`);
        // Find next section or end
        const nextSectionIdx = content.indexOf("### ", symptomIdx + 10);
        const section = content.slice(
          symptomIdx,
          nextSectionIdx > 0 ? nextSectionIdx : undefined,
        );
        assert.ok(
          /\bCause\b/.test(section),
          `${st.name}/ symptoms table should have Cause column`,
        );
      });

      it(`${st.name}/ symptoms documents POLY-BUG entries`, () => {
        const symptomIdx = content.indexOf(`### ${st.name}/ symptoms`);
        const nextSectionIdx = content.indexOf("### ", symptomIdx + 10);
        const section = content.slice(
          symptomIdx,
          nextSectionIdx > 0 ? nextSectionIdx : undefined,
        );
        const bugPattern = new RegExp(`POLY-BUG-${st.prefix}`, "i");
        assert.ok(
          bugPattern.test(section),
          `${st.name}/ symptoms should reference POLY-BUG-${st.prefix} seeds`,
        );
      });

      it(`${st.name}/ symptoms documents POLY-BRK entries`, () => {
        const symptomIdx = content.indexOf(`### ${st.name}/ symptoms`);
        const nextSectionIdx = content.indexOf("### ", symptomIdx + 10);
        const section = content.slice(
          symptomIdx,
          nextSectionIdx > 0 ? nextSectionIdx : undefined,
        );
        const brkPattern = new RegExp(`POLY-BRK-${st.prefix}`, "i");
        assert.ok(
          brkPattern.test(section),
          `${st.name}/ symptoms should reference POLY-BRK-${st.prefix} seeds`,
        );
      });
    }

    it("python/ symptoms document POLY-FLAKY-P1", () => {
      const pySymptomIdx = content.indexOf("### python/ symptoms");
      const nextIdx = content.indexOf("### ts/ symptoms", pySymptomIdx + 10);
      const section = content.slice(pySymptomIdx, nextIdx);
      assert.ok(
        section.includes("POLY-FLAKY-P1") || section.includes("FLAKY"),
        "python/ symptoms should document POLY-FLAKY-P1",
      );
    });

    it("documents baseline green + sentinel present for ts/", () => {
      assert.ok(
        content.includes("Baseline: 59 passed") ||
          content.includes("59 passed, green"),
        "Should document ts/ baseline test count",
      );
    });
  });

  // --- Storm sentinel line (AC-4) ---
  describe("storm sentinel line (AC-4)", () => {
    it("documents STORM-SENTINEL location in ts/src/store.ts", () => {
      assert.ok(
        content.includes("STORM-SENTINEL") &&
          (content.includes("ts/src/store.ts") ||
            content.includes("ts/src/store")),
        "Should document STORM-SENTINEL in ts/src/store.ts",
      );
    });

    it("documents the sentinel hash value 4a7f2e9b1c6d8", () => {
      assert.ok(
        content.includes("4a7f2e9b1c6d8"),
        "Should document sentinel hash value",
      );
    });

    it("documents sentinel location between getByCategory and getByDateRange", () => {
      assert.ok(
        content.includes("getByCategory") &&
          content.includes("getByDateRange"),
        "Should mention getByCategory and getByDateRange location context",
      );
    });

    it("documents S5 role (bug-fix-merge-worktree, hermes)", () => {
      assert.ok(
        content.includes("storm-bfmw-2") || content.includes("S5"),
        "Should document S5 (bug-fix-merge-worktree) role",
      );
    });

    it("documents S9 role (feature-dev-merge-worktree, pi)", () => {
      assert.ok(
        content.includes("storm-fdmw-4") || content.includes("S9"),
        "Should document S9 (feature-dev-merge-worktree) role",
      );
    });

    it("documents that S5/S9 produce a guaranteed conflict", () => {
      assert.ok(
        /guaranteed.conflict/i.test(content) &&
          (content.includes("S5") || content.includes("S9")),
        "Should document guaranteed conflict between S5 and S9",
      );
    });

    it("documents git merge-tree pre-verification", () => {
      assert.ok(
        content.includes("merge-tree"),
        "Should document git merge-tree pre-verification",
      );
    });

    it("documents non-overlap guarantee for all other task areas", () => {
      assert.ok(
        /non.overlap|other.task.area.*disjoint/i.test(content),
        "Should document that all other task areas are disjoint",
      );
    });
  });

  // --- Fix patch verification (AC-5) ---
  describe("fix patch verification results (AC-5)", () => {
    for (const st of subtrees) {
      it(`documents fix patch verification table for ${st.name}/`, () => {
        const fixTablePattern = new RegExp(
          `###\\s+${st.name}/\\s+fix\\s+patch`,
          "i",
        );
        assert.ok(
          fixTablePattern.test(content),
          `Should have fix patch verification section for ${st.name}/`,
        );
      });

      // Verify some per-subtree seeds have fix patches documented
      const bugSeeds = allBugSeeds.filter((s) => s.includes(`-${st.prefix}`));
      for (const seed of bugSeeds.slice(0, 2)) {
        it(`${seed} fix patch documented in ${st.name}/ fix table`, () => {
          // The fix table section should reference the seed
          const fixSection = content.slice(
            content.indexOf(`### ${st.name}/ fix patches`),
          );
          assert.ok(
            fixSection.includes(seed),
            `${st.name}/ fix table should include ${seed}`,
          );
        });
      }
    }

    it("documents POLY-BUG-A5 fix patch (cross-language coordinated fix)", () => {
      assert.ok(
        content.includes("POLY-BUG-A5") &&
          (content.includes("fix.patch") || content.includes("coordinated")),
        "Should document POLY-BUG-A5 fix patch",
      );
    });

    it("documents POLY-FLAKY-P1 has no fix.patch", () => {
      assert.ok(
        content.includes("no fix.patch") || content.includes("Restore baseline"),
        "Should document that POLY-FLAKY-P1 has no fix.patch",
      );
    });

    it("documents result column ('green' or specific outcome)", () => {
      const greenCount = (content.match(/\bgreen\b/gi) || []).length;
      assert.ok(
        greenCount >= 20,
        `Should have at least 20 'green' result entries, got ${greenCount}`,
      );
    });

    it("documents fix patches for all vulns", () => {
      for (const vulnId of allVulnSeeds) {
        assert.ok(
          content.includes(vulnId),
          `Should document fix patch for ${vulnId}`,
        );
      }
    });

    it("documents fix patches for all broken test seeds", () => {
      for (const brkId of allBrkSeeds) {
        assert.ok(
          content.includes(brkId),
          `Should document fix patch for ${brkId}`,
        );
      }
    });
  });

  // --- Integrity invariants (AC-6) ---
  describe("integrity invariants (AC-6)", () => {
    it("has Integrity Invariants section", () => {
      assert.ok(
        /integrity\s+invariants/i.test(content),
        "Should have Integrity Invariants section",
      );
    });

    it("documents deterministic build invariant (byte-stable hashes)", () => {
      const invSection = content.slice(
        content.search(/integrity\s+invariants/i),
      );
      assert.ok(
        /deterministic|byte.stable|identical.*(hash|commit)/i.test(invSection),
        "Should document deterministic build invariant",
      );
    });

    it("documents baseline green + sentinel present invariant", () => {
      const invSection = content.slice(
        content.search(/integrity\s+invariants/i),
      );
      assert.ok(
        /baseline.*green|sentinel.*present|main.*green/i.test(invSection),
        "Should document baseline green + sentinel present",
      );
    });

    it("documents composite correctness invariant", () => {
      const invSection = content.slice(
        content.search(/integrity\s+invariants/i),
      );
      assert.ok(
        /composite|all.*seed.*simultaneously|documented.*symptom/i.test(
          invSection,
        ),
        "Should document composite correctness invariant",
      );
    });

    it("documents fix isolation invariant", () => {
      const invSection = content.slice(
        content.search(/integrity\s+invariants/i),
      );
      assert.ok(
        /fix.*isolation|individually|restores.*green/i.test(invSection),
        "Should document fix isolation invariant",
      );
    });

    it("documents conflict pre-verification invariant", () => {
      const invSection = content.slice(
        content.search(/integrity\s+invariants/i),
      );
      assert.ok(
        /conflict.*pre.?verif|merge.?tree/i.test(invSection),
        "Should document conflict pre-verification",
      );
    });

    it("documents subtrees independent invariant", () => {
      const invSection = content.slice(
        content.search(/integrity\s+invariants/i),
      );
      assert.ok(
        /subtree.*independent|affect.*own.*file/i.test(invSection),
        "Should document subtrees independence invariant",
      );
    });

    it("has at least 6 integrity invariants", () => {
      const invSection = content.slice(
        content.search(/integrity\s+invariants/i),
      );
      const numItems = (invSection.match(/^\d+\.\s/gm) || []).length;
      assert.ok(
        numItems >= 6,
        `Should have at least 6 numbered invariants, got ${numItems}`,
      );
    });
  });

  // --- Reference documents ---
  describe("reference documents", () => {
    it("links to master SEEDS.md catalog", () => {
      assert.ok(
        content.includes("seeds/SEEDS.md") || content.includes("SEEDS.md"),
        "Should link to master SEEDS.md catalog",
      );
    });

    for (const st of subtrees) {
      it(`links to ${st.name}/FIXTURE.md`, () => {
        const fixRef = new RegExp(`${st.name}/FIXTURE\\.md`, "i");
        assert.ok(
          fixRef.test(content),
          `Should reference ${st.name}/FIXTURE.md`,
        );
      });
    }

    it("links to spec 02 (fixture-projects.md)", () => {
      assert.ok(
        content.includes("02-fixture-projects.md"),
        "Should reference spec 02",
      );
    });

    it("links to spec 09 (wave-5-storm.md)", () => {
      assert.ok(
        content.includes("09-wave-5-storm.md"),
        "Should reference spec 09",
      );
    });
  });

  // --- seed/storm vs broken-tests section ---
  describe("seed/storm vs broken-tests comparison", () => {
    it("documents broken-tests branch purpose", () => {
      assert.ok(
        content.includes("broken-tests"),
        "Should document broken-tests branch",
      );
    });

    it("documents that S7 (storm-quar) lands on broken-tests, not main", () => {
      assert.ok(
        /storm.?quar|S7.*broken|quarantine.*broken/i.test(content),
        "Should document S7 quarantine landing on broken-tests",
      );
    });
  });

  // --- Seed count consistency ---
  describe("seed count consistency", () => {
    it("mentions 41 seeds for seed/storm", () => {
      assert.ok(
        content.includes("41 seed") || content.includes("41 storm"),
        "Should mention 41 seeds in seed/storm composite",
      );
    });

    it("counts all POLY-BUG seeds referenced", () => {
      for (const seed of allBugSeeds) {
        assert.ok(
          content.includes(seed),
          `Should reference ${seed} somewhere in STORM.md`,
        );
      }
    });
  });

  // --- Git identity for deterministic commits ---
  describe("deterministic commit identity", () => {
    it("documents deterministic git author name", () => {
      assert.ok(
        content.includes("Tamandua Fixture Builder"),
        "Should document deterministic git author name",
      );
    });

    it("documents deterministic git author email", () => {
      assert.ok(
        content.includes("fixtures@tamandua.tetradactyla.org"),
        "Should document deterministic git author email",
      );
    });

    it("documents deterministic commit date (2026-01-01T00:00:00Z)", () => {
      assert.ok(
        content.includes("2026-01-01T00:00:00Z"),
        "Should document deterministic commit date",
      );
    });
  });

  // --- Structural consistency ---
  describe("document structural consistency", () => {
    it("contains Construction section", () => {
      assert.ok(
        content.includes("## Construction"),
        "Should have Construction section",
      );
    });

    it("contains Verified Symptoms section", () => {
      assert.ok(
        content.includes("## Verified Symptoms"),
        "Should have Verified Symptoms section",
      );
    });

    it("contains Fix Patch Verification section", () => {
      assert.ok(
        content.includes("## Fix Patch Verification"),
        "Should have Fix Patch Verification section",
      );
    });

    it("contains Storm Sentinel Line section", () => {
      assert.ok(
        content.includes("## Storm Sentinel Line"),
        "Should have Storm Sentinel Line section",
      );
    });

    it("contains Integrity Invariants section", () => {
      assert.ok(
        content.includes("## Integrity Invariants"),
        "Should have Integrity Invariants section",
      );
    });

    it("contains Reference Documents section", () => {
      assert.ok(
        content.includes("## Reference Documents"),
        "Should have Reference Documents section",
      );
    });
  });
});
