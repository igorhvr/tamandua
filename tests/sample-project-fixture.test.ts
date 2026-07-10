import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";

const repoRoot = process.cwd();
const fixtureDir = path.join(repoRoot, "e2e-tests", "fixtures", "sample-project");

describe("sample project fixture", () => {
  it("has package.json with type module and scripts", () => {
    const pkgPath = path.join(fixtureDir, "package.json");
    assert.ok(fs.existsSync(pkgPath), "package.json should exist");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    assert.equal(pkg.type, "module", "should be type module");
    assert.ok(pkg.scripts?.build, "should have build script");
    assert.ok(pkg.scripts?.test, "should have test script");
  });

  it("has tsconfig.json with ES2022+ settings", () => {
    const tsconfigPath = path.join(fixtureDir, "tsconfig.json");
    assert.ok(fs.existsSync(tsconfigPath), "tsconfig.json should exist");
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
    const target = tsconfig.compilerOptions?.target;
    const valid = ["ES2022", "ES2023", "ES2024", "ESNext"];
    assert.ok(
      valid.includes(target),
      `target should be ES2022 or later, got: ${target}`,
    );
    assert.equal(tsconfig.compilerOptions?.rootDir, "src");
    assert.equal(tsconfig.compilerOptions?.outDir, "dist");
  });

  it("has src/math.ts with buggy add() returning a - b", () => {
    const srcPath = path.join(fixtureDir, "src", "math.ts");
    assert.ok(fs.existsSync(srcPath), "src/math.ts should exist");
    const content = fs.readFileSync(srcPath, "utf-8");
    // The bug: a - b where it should be a + b
    assert.ok(
      content.includes("a - b"),
      "src/math.ts should contain the bug: a - b",
    );
    assert.ok(
      content.includes("export function add"),
      "src/math.ts should export an add function",
    );
  });

  it("ignores generated build artifacts", () => {
    const gitignorePath = path.join(fixtureDir, ".gitignore");
    assert.ok(fs.existsSync(gitignorePath), ".gitignore should exist");
    const content = fs.readFileSync(gitignorePath, "utf-8");
    assert.match(content, /^dist\/$/m, "dist/ should be ignored");
    assert.match(content, /^node_modules\/$/m, "node_modules/ should be ignored");
  });

  it("has test/math.test.ts with test exposing the bug", () => {
    const testPath = path.join(fixtureDir, "test", "math.test.ts");
    assert.ok(fs.existsSync(testPath), "test/math.test.ts should exist");
    const content = fs.readFileSync(testPath, "utf-8");
    assert.ok(
      content.includes("import { add }"),
      "test should import add from math.js",
    );
    // At least one test should expect correct addition behavior (which will fail)
    assert.ok(
      content.includes("add(5, 3), 8") || content.includes("addition"),
      "should have a test that expects correct addition (which exposes the bug)",
    );
  });

  it("fixture compiles and shows test failure when run", () => {
    // Copy fixture to temp dir to verify it actually works without polluting
    const th = createTempHome("sample-project-test-");
    const tmpDir = th.root;
    const homeDir = th.homeDir;
    const testEnv = cleanChildEnv({ HOME: homeDir });
    fs.mkdirSync(homeDir, { recursive: true });
      // Copy fixture files
      execSync(`cp -r ${fixtureDir}/. ${tmpDir}/`, {
        encoding: "utf-8",
        env: testEnv,
      });

      // Install dependencies
      execSync("npm install", {
        cwd: tmpDir,
        encoding: "utf-8",
        env: testEnv,
        stdio: "pipe",
      });

      // Build should succeed
      const buildResult = spawnSync("npm", ["run", "build"], {
        cwd: tmpDir,
        encoding: "utf-8",
        env: testEnv,
      });
      assert.equal(
        buildResult.status,
        0,
        `build should succeed: ${buildResult.stderr}`,
      );

      // Test should fail (at least one test failure)
      // Unset NODE_TEST_CONTEXT to avoid recursive test detection when running
      // node --test from within another node --test process.
      delete testEnv.NODE_TEST_CONTEXT;
      const testResult = spawnSync("npm", ["test"], {
        cwd: tmpDir,
        encoding: "utf-8",
        env: testEnv,
      });
      assert.notEqual(
        testResult.status,
        0,
        `npm test should exit with non-zero (test failure). Output: ${testResult.stdout} ${testResult.stderr}`,
      );
  });

  it("fixture has all four required files", () => {
    const requiredFiles = [
      "package.json",
      "tsconfig.json",
      "src/math.ts",
      "test/math.test.ts",
    ];
    for (const file of requiredFiles) {
      const filePath = path.join(fixtureDir, file);
      assert.ok(
        fs.existsSync(filePath),
        `fixture should contain ${file}`,
      );
    }
  });
});
