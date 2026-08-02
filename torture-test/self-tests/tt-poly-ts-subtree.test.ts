import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// This test file performs read-only validation against fixtures-src —
// no commands are executed inside fixtures-src.

const repoRoot = process.cwd();
const ttPolyTsDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly",
  "ts",
);
const ttPolyLiteTsDir = path.join(
  repoRoot,
  "torture-test",
  "fixtures-src",
  "tt-poly-lite",
  "ts",
);

describe("tt-poly ts/ subtree integration (US-003)", () => {
  it("ts/ directory exists and contains all files from tt-poly-lite/ts/", () => {
    assert.ok(
      fs.existsSync(ttPolyTsDir),
      "tt-poly/ts/ should exist",
    );
    assert.ok(
      fs.statSync(ttPolyTsDir).isDirectory(),
      "tt-poly/ts/ should be a directory",
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

    const sourceFiles = collectFiles(ttPolyLiteTsDir);
    const destFiles = collectFiles(ttPolyTsDir);

    // Every source file must exist in dest.
    // Skip .gitkeep files — they are only needed for empty directories
    // and are harmless to omit when the directory has real content.
    for (const f of sourceFiles) {
      if (path.basename(f) === '.gitkeep') continue;
      assert.ok(
        destFiles.has(f),
        `tt-poly/ts/${f} should exist (from tt-poly-lite/ts/)`,
      );
    }
  });

  it("FIXTURE.md references tt-poly, not tt-poly-lite", () => {
    const mdPath = path.join(ttPolyTsDir, "FIXTURE.md");
    assert.ok(fs.existsSync(mdPath), "FIXTURE.md should exist");

    const content = fs.readFileSync(mdPath, "utf-8");
    assert.ok(
      content.includes("tt-poly ts/ Subtree"),
      'FIXTURE.md title should reference "tt-poly ts/ Subtree"',
    );
    assert.ok(
      content.includes("tt-poly five-language storm monorepo"),
      "FIXTURE.md should mention tt-poly five-language storm monorepo",
    );
    // Should NOT reference tt-poly-lite
    assert.ok(
      !content.includes("tt-poly-lite"),
      "FIXTURE.md should not reference tt-poly-lite",
    );
  });

  it("ts/src/store.ts STORM-SENTINEL line preserved exactly", () => {
    const storePath = path.join(ttPolyTsDir, "src", "store.ts");
    assert.ok(fs.existsSync(storePath), "src/store.ts should exist");

    const content = fs.readFileSync(storePath, "utf-8");
    assert.ok(
      content.includes("STORM-SENTINEL: 4a7f2e9b1c6d8"),
      "STORM-SENTINEL marker must be present in store.ts",
    );
    assert.ok(
      content.includes("guaranteed-conflict overlap pair for S5/S9"),
      "STORM-SENTINEL comment must include S5/S9 conflict description",
    );

    // Verify sentinel is between getByCategory and getByDateRange
    const sentinelIndex = content.indexOf("STORM-SENTINEL");
    const getByCategoryIndex = content.indexOf("getByCategory");
    const getByDateRangeIndex = content.indexOf("getByDateRange");

    assert.ok(sentinelIndex > -1, "STORM-SENTINEL should be present");
    assert.ok(getByCategoryIndex > -1, "getByCategory should be present");
    assert.ok(getByDateRangeIndex > -1, "getByDateRange should be present");
    assert.ok(
      sentinelIndex > getByCategoryIndex,
      "STORM-SENTINEL should appear after getByCategory",
    );
    assert.ok(
      sentinelIndex < getByDateRangeIndex,
      "STORM-SENTINEL should appear before getByDateRange",
    );
  });

  it("src/ directory contains all required TypeScript source files", () => {
    const srcDir = path.join(ttPolyTsDir, "src");
    assert.ok(fs.existsSync(srcDir), "src/ should exist");

    const requiredFiles = [
      "server.ts",
      "types.ts",
      "store.ts",
      "store.test.ts",
      "server.test.ts",
      "index.ts",
    ];

    for (const f of requiredFiles) {
      const fPath = path.join(srcDir, f);
      assert.ok(fs.existsSync(fPath), `src/${f} should exist`);
      assert.ok(
        fs.statSync(fPath).isFile(),
        `src/${f} should be a file`,
      );
    }
  });

  it("src/server.ts exists and is a valid TS source", () => {
    const serverPath = path.join(ttPolyTsDir, "src", "server.ts");
    assert.ok(fs.existsSync(serverPath), "src/server.ts should exist");

    const content = fs.readFileSync(serverPath, "utf-8");
    assert.ok(
      content.includes("createServer"),
      "server.ts should contain createServer (HTTP server)",
    );
  });

  it("src/types.ts exists and defines Expense/Category types", () => {
    const typesPath = path.join(ttPolyTsDir, "src", "types.ts");
    assert.ok(fs.existsSync(typesPath), "src/types.ts should exist");

    const content = fs.readFileSync(typesPath, "utf-8");
    assert.ok(
      content.includes("Expense"),
      "types.ts should define Expense type",
    );
    assert.ok(
      content.includes("Category"),
      "types.ts should define Category type",
    );
  });

  it("public/ directory contains frontend assets", () => {
    const publicDir = path.join(ttPolyTsDir, "public");
    assert.ok(fs.existsSync(publicDir), "public/ should exist");

    const requiredFiles = ["index.html", "app.js", "style.css"];
    for (const f of requiredFiles) {
      const fPath = path.join(publicDir, f);
      assert.ok(fs.existsSync(fPath), `public/${f} should exist`);
      assert.ok(
        fs.statSync(fPath).isFile(),
        `public/${f} should be a file`,
      );
    }
  });

  it("tsconfig.json exists and is valid", () => {
    const tsconfigPath = path.join(ttPolyTsDir, "tsconfig.json");
    assert.ok(fs.existsSync(tsconfigPath), "tsconfig.json should exist");

    const content = fs.readFileSync(tsconfigPath, "utf-8");
    const config = JSON.parse(content);
    assert.ok(
      config.compilerOptions,
      "tsconfig.json should have compilerOptions",
    );
  });

  it("package.json exists and defines test script", () => {
    const pkgPath = path.join(ttPolyTsDir, "package.json");
    assert.ok(fs.existsSync(pkgPath), "package.json should exist");

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    assert.ok(
      pkg.scripts?.test,
      "package.json should define a test script",
    );
    assert.ok(
      pkg.devDependencies?.typescript,
      "package.json should depend on typescript (dev)",
    );
    assert.ok(
      pkg.devDependencies?.tsx,
      "package.json should depend on tsx (dev)",
    );
  });

  it("scripts/create-stray.js exists for junk probe", () => {
    const strayPath = path.join(ttPolyTsDir, "scripts", "create-stray.js");
    assert.ok(fs.existsSync(strayPath), "scripts/create-stray.js should exist");
    assert.ok(
      fs.statSync(strayPath).isFile(),
      "scripts/create-stray.js should be a file",
    );
  });

  it("operator-notes.local exists in ts/ subtree", () => {
    const opNotesPath = path.join(ttPolyTsDir, "operator-notes.local");
    assert.ok(
      fs.existsSync(opNotesPath),
      "operator-notes.local should exist in ts/",
    );

    const content = fs.readFileSync(opNotesPath, "utf-8");
    assert.ok(content.length > 0, "operator-notes.local should not be empty");
    assert.ok(
      content.includes("# operator-notes.local"),
      "operator-notes.local should have spec 02 header",
    );
    assert.ok(
      content.includes("tt-poly ts/ Subtree"),
      "operator-notes.local should reference tt-poly ts/ Subtree",
    );
  });

  it("README-JUNK.md exists in ts/ subtree", () => {
    const junkPath = path.join(ttPolyTsDir, "README-JUNK.md");
    assert.ok(fs.existsSync(junkPath), "README-JUNK.md should exist in ts/");

    const content = fs.readFileSync(junkPath, "utf-8");
    assert.ok(
      content.includes("Regenerated Junk") || content.includes("regenerated"),
      "README-JUNK.md should document regenerated junk",
    );
  });

  it("seeds/ directory contains POLY-T* seed patches and fix/ patches", () => {
    const seedsDir = path.join(ttPolyTsDir, "seeds");
    assert.ok(fs.existsSync(seedsDir), "seeds/ should exist");

    const expectedPatches = [
      "POLY-BUG-T1.patch",
      "POLY-BUG-T2.patch",
      "POLY-BUG-T3.patch",
      "POLY-BUG-T4.patch",
      "POLY-BRK-T1.patch",
      "POLY-BRK-T2.patch",
      "POLY-BUG-T1-T4-combined.patch",
    ];

    for (const patch of expectedPatches) {
      const patchPath = path.join(seedsDir, patch);
      assert.ok(
        fs.existsSync(patchPath),
        `seeds/${patch} should exist`,
      );
    }

    // Check fix/ directory
    const fixDir = path.join(seedsDir, "fix");
    assert.ok(fs.existsSync(fixDir), "seeds/fix/ should exist");

    const expectedFixes = [
      "POLY-BUG-T1-fix.patch",
      "POLY-BUG-T2-fix.patch",
      "POLY-BUG-T3-fix.patch",
      "POLY-BUG-T4-fix.patch",
      "POLY-BRK-T1-fix.patch",
      "POLY-BRK-T2-fix.patch",
      "POLY-VULN-T1-fix.patch",
      "POLY-VULN-T2-fix.patch",
    ];

    for (const fix of expectedFixes) {
      const fixPath = path.join(fixDir, fix);
      assert.ok(
        fs.existsSync(fixPath),
        `seeds/fix/${fix} should exist`,
      );
    }
  });

  it("ts/ .gitignore is appropriate for TS/Node project", () => {
    const giPath = path.join(ttPolyTsDir, ".gitignore");
    assert.ok(fs.existsSync(giPath), "ts/.gitignore should exist");

    const content = fs.readFileSync(giPath, "utf-8");
    const activeRules = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    // Must gitignore dist/ (compiled output)
    assert.ok(
      activeRules.includes("dist/"),
      ".gitignore should exclude dist/",
    );

    // Must NOT gitignore junk probes
    assert.ok(
      !activeRules.some((r) =>
        r === "package-lock.json" ||
        r.startsWith("package-lock.json/")
      ),
      ".gitignore must NOT exclude package-lock.json (junk probe)",
    );
    assert.ok(
      !activeRules.some((r) =>
        r === "node_modules/" ||
        r.startsWith("node_modules")
      ),
      ".gitignore must NOT exclude node_modules/ (junk probe)",
    );
  });

  it("store.ts is byte-identical to tt-poly-lite reference", () => {
    const ttPolyStorePath = path.join(ttPolyTsDir, "src", "store.ts");
    const ttPolyLiteStorePath = path.join(
      ttPolyLiteTsDir,
      "src",
      "store.ts",
    );

    assert.ok(
      fs.existsSync(ttPolyLiteStorePath),
      "tt-poly-lite reference store.ts should exist",
    );

    const ttPolyContent = fs.readFileSync(ttPolyStorePath);
    const ttPolyLiteContent = fs.readFileSync(ttPolyLiteStorePath);

    assert.equal(
      ttPolyContent.length,
      ttPolyLiteContent.length,
      "store.ts files should have the same byte length",
    );
    assert.ok(
      ttPolyContent.equals(ttPolyLiteContent),
      "tt-poly ts/src/store.ts must be byte-identical to tt-poly-lite reference",
    );
  });

  it("operator-notes.local has spec 02 structure consistent with tt-poly-lite reference", () => {
    // tt-poly ts/ uses spec 02 expanded format; tt-poly-lite ts/ uses the
    // legacy short format, so byte-identical comparison is not expected.
    // Verify spec 02 structure and key content instead.
    const ttPolyOpPath = path.join(ttPolyTsDir, "operator-notes.local");
    const ttPolyLiteOpPath = path.join(
      ttPolyLiteTsDir,
      "operator-notes.local",
    );

    assert.ok(
      fs.existsSync(ttPolyLiteOpPath),
      "tt-poly-lite reference operator-notes.local should exist",
    );

    const ttPolyContent = fs.readFileSync(ttPolyOpPath, "utf-8");

    assert.ok(
      ttPolyContent.includes("# operator-notes.local"),
      "operator-notes.local should have spec 02 header",
    );
    assert.ok(
      ttPolyContent.includes("1-min sampler"),
      "operator-notes.local should mention 1-min sampler",
    );
    assert.ok(
      ttPolyContent.includes("tt-poly ts/ Subtree"),
      "operator-notes.local should reference tt-poly ts/ Subtree",
    );
    assert.ok(
      ttPolyContent.includes("npm test"),
      "operator-notes.local should document npm test",
    );
    assert.ok(
      ttPolyContent.includes("STORM-SENTINEL"),
      "operator-notes.local should document STORM-SENTINEL",
    );
  });
});
