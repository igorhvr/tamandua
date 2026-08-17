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

const subtrees = ["python", "ts", "go", "java", "rust"] as const;

describe("tt-poly Makefile and subtree junk probe markers (US-008)", () => {
  // --- Makefile ---

  it("Makefile exists at tt-poly root", () => {
    const mf = path.join(ttPolyDir, "Makefile");
    assert.ok(fs.existsSync(mf), "Makefile should exist");
    assert.ok(fs.statSync(mf).isFile(), "Makefile should be a file");
  });

  it("Makefile has .PHONY: test target that runs ./run-all-tests", () => {
    const content = fs.readFileSync(path.join(ttPolyDir, "Makefile"), "utf-8");
    assert.ok(content.includes(".PHONY: test"), "Makefile should declare .PHONY: test");
    assert.ok(content.includes("make test") || content.match(/^test:/m), "Makefile should have test target");
    assert.ok(content.includes("./run-all-tests"), "test target should run ./run-all-tests");
  });

  // --- Junk probes: each subtree has operator-notes.local ---

  for (const sub of subtrees) {
    it(`${sub}/ has operator-notes.local`, () => {
      const opNotes = path.join(ttPolyDir, sub, "operator-notes.local");
      assert.ok(fs.existsSync(opNotes), `${sub}/operator-notes.local should exist`);
      const stat = fs.statSync(opNotes);
      assert.ok(stat.isFile(), `${sub}/operator-notes.local should be a file`);
      assert.ok(stat.size > 0, `${sub}/operator-notes.local should not be empty`);
    });
  }

  it("root has operator-notes.local", () => {
    const opNotes = path.join(ttPolyDir, "operator-notes.local");
    assert.ok(fs.existsSync(opNotes), "root operator-notes.local should exist");
  });

  // --- Junk probes: each subtree has README-JUNK.md ---

  for (const sub of subtrees) {
    it(`${sub}/ has README-JUNK.md`, () => {
      const rj = path.join(ttPolyDir, sub, "README-JUNK.md");
      assert.ok(fs.existsSync(rj), `${sub}/README-JUNK.md should exist`);
      const content = fs.readFileSync(rj, "utf-8");
      assert.ok(content.length > 0, `${sub}/README-JUNK.md should not be empty`);
    });
  }

  // --- Python synthetic junk reference (MACP2): deterministic seeded junk ---

  it("python/ __pycache__/junk-probe.synthetic reference exists, tracked, not gitignored", () => {
    const ref = path.join(ttPolyDir, "python", "__pycache__", "junk-probe.synthetic");
    assert.ok(fs.existsSync(ref), "fixtures-src python/__pycache__/junk-probe.synthetic should exist");
    const stat = fs.statSync(ref);
    assert.ok(stat.isFile(), "reference should be a file");
    assert.ok(stat.size > 0, "reference should not be empty");

    // Tracked in git: git ls-files --error-unmatch succeeds.
    const ls = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", "torture-test/fixtures-src/tt-poly/python/__pycache__/junk-probe.synthetic"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(ls.status, 0, "reference must be tracked in git (git ls-files --error-unmatch)");

    // NOT gitignored: git check-ignore must fail.
    const ci = spawnSync(
      "git",
      ["check-ignore", "-q", "torture-test/fixtures-src/tt-poly/python/__pycache__/junk-probe.synthetic"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.notEqual(ci.status, 0, "reference must NOT be gitignored");
  });

  it("python/ __pycache__/junk-probe.synthetic filename can never collide with an importable module", () => {
    const name = "junk-probe.synthetic";
    assert.ok(!name.endsWith(".pyc"), "marker filename must not look like a pyc module artifact");
    assert.ok(
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
      "marker filename must not be a valid module identifier",
    );
    assert.ok(name.includes("-"), "marker filename must carry a non-identifier char (hyphen)");
  });

  it("python/ __pycache__/junk-probe.synthetic reference is the byte-exact provisioning payload", () => {
    // Byte-identical to the canonical tt-python MACP2 marker — the seeded
    // junk oracle compares the clone's marker against this fixtures-src
    // reference with cmp, so the reference bytes must be stable.
    const polyRef = path.join(ttPolyDir, "python", "__pycache__", "junk-probe.synthetic");
    const canonicalRef = path.join(
      repoRoot,
      "torture-test",
      "fixtures-src",
      "tt-python",
      "__pycache__",
      "junk-probe.synthetic",
    );
    assert.ok(fs.existsSync(canonicalRef), "canonical tt-python reference should exist");
    assert.equal(
      fs.readFileSync(polyRef, "utf-8"),
      fs.readFileSync(canonicalRef, "utf-8"),
      "tt-poly reference must be byte-identical to the canonical MACP2 marker",
    );
  });

  // --- Python junk probes: __pycache__/, .pytest_cache/, .flaky_counter NOT gitignored ---

  it("python/ __pycache__/ is NOT gitignored", () => {
    const giPath = path.join(ttPolyDir, "python", ".gitignore");
    assert.ok(fs.existsSync(giPath), "python/.gitignore should exist");

    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = parseGitignoreRules(content);
    assert.ok(
      !activeRules.includes("__pycache__/"),
      "python/.gitignore must NOT gitignore __pycache__/ (junk probe)",
    );
  });

  it("python/ .pytest_cache/ is NOT gitignored", () => {
    const giPath = path.join(ttPolyDir, "python", ".gitignore");
    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = parseGitignoreRules(content);
    assert.ok(
      !activeRules.includes(".pytest_cache/"),
      "python/.gitignore must NOT gitignore .pytest_cache/ (junk probe)",
    );
  });

  it("python/ .flaky_counter is NOT gitignored", () => {
    const giPath = path.join(ttPolyDir, "python", ".gitignore");
    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = parseGitignoreRules(content);
    assert.ok(
      !activeRules.includes(".flaky_counter"),
      "python/.gitignore must NOT gitignore .flaky_counter (junk probe)",
    );
  });

  // --- TS junk probes: package-lock.json, node_modules/ NOT gitignored ---

  it("ts/ package-lock.json is NOT gitignored", () => {
    const giPath = path.join(ttPolyDir, "ts", ".gitignore");
    assert.ok(fs.existsSync(giPath), "ts/.gitignore should exist");

    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = parseGitignoreRules(content);
    assert.ok(
      !activeRules.some((r) => r === "package-lock.json"),
      "ts/.gitignore must NOT gitignore package-lock.json (junk probe)",
    );
  });

  it("ts/ node_modules/ is NOT gitignored", () => {
    const giPath = path.join(ttPolyDir, "ts", ".gitignore");
    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = parseGitignoreRules(content);
    assert.ok(
      !activeRules.some((r) => r === "node_modules/" || r === "node_modules"),
      "ts/.gitignore must NOT gitignore node_modules/ (junk probe)",
    );
  });

  // --- Go junk probe: testdata/exec-bit-probe.sh committed with exec bit ---

  it("go/ testdata/exec-bit-probe.sh exists with exec bit", () => {
    const probePath = path.join(ttPolyDir, "go", "testdata", "exec-bit-probe.sh");
    assert.ok(fs.existsSync(probePath), "go/testdata/exec-bit-probe.sh should exist");

    const stat = fs.statSync(probePath);
    assert.ok(stat.isFile(), "should be a regular file");
    const mode = stat.mode;
    const isExecutable =
      (mode & fs.constants.S_IXUSR) !== 0 ||
      (mode & fs.constants.S_IXGRP) !== 0 ||
      (mode & fs.constants.S_IXOTH) !== 0;
    assert.ok(isExecutable, "go/testdata/exec-bit-probe.sh must have exec bit set");
  });

  // --- Go: .gitignore exists and does not suppress exec-bit-probe ---

  it("go/ .gitignore does NOT suppress testdata/exec-bit-probe.sh or operator-notes.local", () => {
    const giPath = path.join(ttPolyDir, "go", ".gitignore");
    assert.ok(fs.existsSync(giPath), "go/.gitignore should exist");

    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = parseGitignoreRules(content);
    assert.ok(
      !activeRules.some((r) => r.includes("exec-bit-probe")),
      "go/.gitignore must NOT gitignore exec-bit-probe (junk probe)",
    );
    assert.ok(
      !activeRules.some((r) => r.includes("operator-notes.local")),
      "go/.gitignore must NOT gitignore operator-notes.local (inert junk probe)",
    );
  });

  // --- Rust junk probe: target/ NOT gitignored ---

  it("rust/ target/ is NOT gitignored", () => {
    const giPath = path.join(ttPolyDir, "rust", ".gitignore");
    assert.ok(fs.existsSync(giPath), "rust/.gitignore should exist");

    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = parseGitignoreRules(content);
    assert.ok(
      !activeRules.some((r) => r === "target/" || r === "target"),
      "rust/.gitignore must NOT gitignore target/ (junk probe)",
    );
  });

  // --- Java junk probes: target/ NOT gitignored and .gitattributes with text=auto ---

  it("java/ target/ is NOT gitignored", () => {
    const giPath = path.join(ttPolyDir, "java", ".gitignore");
    assert.ok(fs.existsSync(giPath), "java/.gitignore should exist");

    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = parseGitignoreRules(content);
    assert.ok(
      !activeRules.some((r) => r === "target/" || r === "target"),
      "java/.gitignore must NOT gitignore target/ (junk probe)",
    );
  });

  it("java/ .gitattributes exists with * text=auto", () => {
    const gaPath = path.join(ttPolyDir, "java", ".gitattributes");
    assert.ok(fs.existsSync(gaPath), "java/.gitattributes should exist");
    assert.ok(fs.statSync(gaPath).isFile(), "java/.gitattributes should be a file");

    const content = fs.readFileSync(gaPath, "utf-8");
    assert.ok(
      content.includes("* text=auto"),
      "java/.gitattributes should contain '* text=auto' for line-ending churn trap",
    );
  });

  // --- Top-level .gitignore does NOT suppress any subtree junk probe ---

  it("top-level .gitignore does NOT suppress any subtree's junk probe", () => {
    const giPath = path.join(ttPolyDir, ".gitignore");
    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = parseGitignoreRules(content);

    // Each of these must NOT appear as an active gitignore rule at the top level
    const forbiddenRules = [
      "python/__pycache__/",
      "python/.pytest_cache/",
      "python/.flaky_counter",
      "ts/package-lock.json",
      "ts/node_modules/",
      "java/target/",
      "rust/target/",
    ];

    for (const rule of forbiddenRules) {
      assert.ok(
        !activeRules.includes(rule),
        `top-level .gitignore must NOT exclude ${rule} (junk probe)`,
      );
    }
  });

  // --- Each subtree .gitignore documents junk probes ---

  it("python/ .gitignore documents .flaky_counter as NOT gitignored", () => {
    const content = fs.readFileSync(path.join(ttPolyDir, "python", ".gitignore"), "utf-8");
    assert.ok(
      content.includes(".flaky_counter"),
      "python/.gitignore should mention .flaky_counter as a junk probe",
    );
  });

  it("python/ .gitignore references tt-poly (not tt-poly-lite)", () => {
    const content = fs.readFileSync(path.join(ttPolyDir, "python", ".gitignore"), "utf-8");
    assert.ok(
      !content.includes("tt-poly-lite"),
      "python/.gitignore should not reference tt-poly-lite",
    );
    assert.ok(
      content.includes("tt-poly"),
      "python/.gitignore should reference tt-poly",
    );
  });

  // --- python/ operator-notes.local references tt-poly (not tt-poly-lite) ---

  it("python/ operator-notes.local references tt-poly (not tt-poly-lite)", () => {
    const content = fs.readFileSync(path.join(ttPolyDir, "python", "operator-notes.local"), "utf-8");
    assert.ok(
      !content.includes("tt-poly-lite"),
      "python/operator-notes.local should not reference tt-poly-lite",
    );
    assert.ok(
      content.includes("tt-poly"),
      "python/operator-notes.local should reference tt-poly",
    );
  });
});

/**
 * Parse a .gitignore file into active rules (stripping comments and blank lines).
 */
function parseGitignoreRules(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}
