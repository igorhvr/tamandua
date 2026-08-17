import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

describe("tt-poly top-level structure (US-001)", () => {
  it("tt-poly directory exists", () => {
    assert.ok(
      fs.existsSync(ttPolyDir),
      "torture-test/fixtures-src/tt-poly/ directory should exist",
    );
    assert.ok(
      fs.statSync(ttPolyDir).isDirectory(),
      "tt-poly should be a directory",
    );
  });

  it("has .gitignore at root", () => {
    const giPath = path.join(ttPolyDir, ".gitignore");
    assert.ok(fs.existsSync(giPath), ".gitignore should exist");

    const content = fs.readFileSync(giPath, "utf-8");
    // Strip comment lines to check only active gitignore rules
    const activeRules = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    // Must gitignore .venv/
    assert.ok(activeRules.includes(".venv/"), ".gitignore should exclude .venv/");
    // Must NOT gitignore junk probes
    assert.ok(
      !activeRules.includes("__pycache__/"),
      ".gitignore must NOT exclude __pycache__/ (junk probe)",
    );
    assert.ok(
      !activeRules.includes(".pytest_cache/"),
      ".gitignore must NOT exclude .pytest_cache/ (junk probe)",
    );
    assert.ok(
      !activeRules.some((r) =>
        r === "package-lock.json" || r.startsWith("package-lock.json/"),
      ),
      ".gitignore must NOT exclude package-lock.json (junk probe)",
    );
    assert.ok(
      !activeRules.some((r) => r === "node_modules/" ||
        r.startsWith("node_modules/")),
      ".gitignore must NOT exclude node_modules/ (junk probe)",
    );
    assert.ok(
      !activeRules.includes(".flaky_counter"),
      ".gitignore must NOT exclude .flaky_counter (junk probe)",
    );
    // Must NOT gitignore java/target/ or rust/target/
    assert.ok(
      !activeRules.some((r) =>
        r === "java/target/" || r === "rust/target/",
      ),
      ".gitignore must NOT exclude java/target/ or rust/target/ (junk probe)",
    );
  });

  it("has JUNK-IS-INTENTIONAL.md at root", () => {
    const junkPath = path.join(ttPolyDir, "JUNK-IS-INTENTIONAL.md");
    assert.ok(fs.existsSync(junkPath), "JUNK-IS-INTENTIONAL.md should exist");

    const content = fs.readFileSync(junkPath, "utf-8");
    assert.ok(
      content.includes("Do NOT clean up"),
      "JUNK-IS-INTENTIONAL.md should warn against cleanup",
    );
    assert.ok(
      content.includes("load-bearing junk probes"),
      "JUNK-IS-INTENTIONAL.md should mention load-bearing junk probes",
    );
    // Must mention all 5 language junk probes
    assert.ok(
      content.includes("python/__pycache__"),
      "should mention python junk probes",
    );
    assert.ok(
      content.includes("ts/package-lock.json"),
      "should mention ts junk probes",
    );
    assert.ok(
      content.includes("java/target/"),
      "should mention java junk probes",
    );
    assert.ok(
      content.includes("rust/target/"),
      "should mention rust junk probes",
    );
  });

  it("has README-JUNK.md at root", () => {
    const pathRj = path.join(ttPolyDir, "README-JUNK.md");
    assert.ok(fs.existsSync(pathRj), "README-JUNK.md should exist");

    const content = fs.readFileSync(pathRj, "utf-8");
    assert.ok(
      content.includes("Regenerated Junk"),
      "should document regenerated junk class",
    );
    assert.ok(
      content.includes("Inert Operator Junk"),
      "should document inert operator junk class",
    );
    assert.ok(
      content.includes("python/__pycache__/"),
      "should document python junk probes",
    );
    assert.ok(
      content.includes("java/target/"),
      "should document java junk probes",
    );
    assert.ok(
      content.includes("rust/target/"),
      "should document rust junk probes",
    );
  });

  it("has operator-notes.local with fixed byte content", () => {
    const opPath = path.join(ttPolyDir, "operator-notes.local");
    assert.ok(fs.existsSync(opPath), "operator-notes.local should exist");

    const content = fs.readFileSync(opPath, "utf-8");
    assert.ok(
      content.includes("# operator-notes.local"),
      "operator-notes.local should have spec 02 header",
    );
    assert.ok(
      content.includes("inert operator junk probe"),
      "operator-notes.local should mention inert junk probe",
    );
    assert.ok(
      content.includes("do not edit"),
      "operator-notes.local should mention immutability",
    );
    assert.ok(
      content.includes("1-min sampler"),
      "operator-notes.local should mention 1-min sampler",
    );
  });

  it("has README.md at root documenting the 5-subtree monorepo", () => {
    const readmePath = path.join(ttPolyDir, "README.md");
    assert.ok(fs.existsSync(readmePath), "README.md should exist");

    const content = fs.readFileSync(readmePath, "utf-8");
    assert.ok(
      content.includes("Five-Language Storm Monorepo"),
      "README should mention five-language monorepo",
    );
    assert.ok(
      content.includes("tt-poly"),
      "README should mention tt-poly",
    );
    // Must mention all 5 subtrees
    for (const subtree of ["python/", "ts/", "go/", "rust/", "java/"]) {
      assert.ok(
        content.includes(subtree),
        `README should document ${subtree} subtree`,
      );
    }
    assert.ok(
      content.includes("TEST_CMD"),
      "README should document TEST_CMD",
    );
    assert.ok(
      content.includes("./run-all-tests"),
      "README should mention ./run-all-tests",
    );
    assert.ok(
      content.includes("Junk Probes"),
      "README should document junk probes",
    );
  });

  it("has all 5 subtree directories with content (either .gitkeep or real files)", () => {
    const subtrees = ["python", "ts", "go", "java", "rust"];

    for (const sub of subtrees) {
      const subDir = path.join(ttPolyDir, sub);
      assert.ok(fs.existsSync(subDir), `${sub}/ directory should exist`);
      assert.ok(
        fs.statSync(subDir).isDirectory(),
        `${sub}/ should be a directory`,
      );

      // The subtree must have content: either .gitkeep (empty placeholder)
      // or real project files (when the subtree has been populated by a
      // later story such as US-002 for python/).
      const entries = fs.readdirSync(subDir);
      assert.ok(
        entries.length > 0,
        `${sub}/ must have at least one entry (.gitkeep or real files)`,
      );
    }
  });

  it("has operator-notes.local consistent with spec 02 format", () => {
    // tt-poly uses spec 02 expanded format; tt-poly-lite root uses the
    // legacy short format, so byte-identical comparison is not expected.
    // Verify spec 02 structure instead.
    const ttPolyOpPath = path.join(ttPolyDir, "operator-notes.local");
    const content = fs.readFileSync(ttPolyOpPath, "utf-8");

    assert.ok(
      content.includes("# operator-notes.local"),
      "operator-notes.local should have spec 02 header",
    );
    assert.ok(
      content.includes("1-min sampler"),
      "operator-notes.local should mention 1-min sampler",
    );
    assert.ok(
      content.includes("tt-poly (root)"),
      "operator-notes.local should reference tt-poly root",
    );
    assert.ok(
      content.includes("run-all-tests"),
      "operator-notes.local should document run-all-tests",
    );
  });

  it("python/__pycache__/junk-probe.synthetic seeded-junk reference exists, tracked, not gitignored (MACP2)", () => {
    // MACP2: the python __pycache__ junk is a DETERMINISTIC PROVISIONING
    // ARTIFACT — the byte-exact reference lives TRACKED in fixtures-src (never
    // committed into the golden; excluded by the builder's tar rules) and is
    // seeded into work clones by the builder/provisioning.
    const ref = path.join(ttPolyDir, "python", "__pycache__", "junk-probe.synthetic");
    assert.ok(fs.existsSync(ref), "python/__pycache__/junk-probe.synthetic should exist");
    const stat = fs.statSync(ref);
    assert.ok(stat.isFile(), "reference should be a file");
    assert.ok(stat.size > 0, "reference should not be empty");

    const ls = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", "torture-test/fixtures-src/tt-poly/python/__pycache__/junk-probe.synthetic"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(ls.status, 0, "reference must be tracked in git (git ls-files --error-unmatch)");

    const ci = spawnSync(
      "git",
      ["check-ignore", "-q", "torture-test/fixtures-src/tt-poly/python/__pycache__/junk-probe.synthetic"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.notEqual(ci.status, 0, "reference must NOT be gitignored");
  });
});
