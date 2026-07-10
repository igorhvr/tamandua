/**
 * Fixture Health — Deterministic Compilation Checks
 *
 * Tests all three e2e fixtures deterministically: no agents, no models,
 * no tokens. For each fixture, copies it to a temp dir, runs
 * `npm install --no-audit --no-fund --no-package-lock` followed by
 * `npm exec --yes --package typescript -- tsc`, and asserts the result.
 *
 * Guards:
 * - sample-project-review and sample-project-vuln MUST compile clean (exit 0).
 * - sample-project MUST compile clean AND still contain the planted-bug markers
 *   ("a - b" in src/math.ts, test named "returns the difference").
 *
 * Temp dirs are managed via createTempHome / cleanupTempHome from
 * smoke-helpers for consistent cleanup across the e2e suite.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createTempHome, cleanupTempHome } from "./helpers/smoke-helpers.ts";

const fixturesDir = path.join(process.cwd(), "e2e-tests", "fixtures");

/**
 * Copy a fixture to a temp dir (under `root`) and run the install+tsc sequence.
 * Returns { exitCode, stderr, tempDir }.
 */
function buildFixture(fixtureName: string, root: string): {
  exitCode: number;
  stderr: string;
  tempDir: string;
} {
  const src = path.join(fixturesDir, fixtureName);
  const tempDir = path.join(root, `build-${fixtureName}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Copy fixture to temp dir
  const cpResult = spawnSync("cp", ["-r", `${src}/.`, `${tempDir}/`], {
    encoding: "utf-8",
  });
  assert.equal(cpResult.status, 0, `cp ${fixtureName} failed: ${cpResult.stderr}`);

  // Install deps then compile (matching buildSampleProject sequence)
  const cmd =
    "npm install --no-audit --no-fund --no-package-lock && npm exec --yes --package typescript -- tsc";
  const result = spawnSync(cmd, {
    cwd: tempDir,
    shell: true,
    encoding: "utf-8",
  });

  return { exitCode: result.status ?? -1, stderr: result.stderr, tempDir };
}

describe("fixture-health — sample-project-review", () => {
  it("compiles clean (tsc exit 0)", async () => {
    const env = await createTempHome();
    try {
      const { exitCode, stderr } = buildFixture("sample-project-review", env.root);
      assert.equal(
        exitCode,
        0,
        `sample-project-review tsc failed (exit ${exitCode}): ${stderr}`,
      );
    } finally {
      cleanupTempHome(env);
    }
  });
});

describe("fixture-health — sample-project-vuln", () => {
  it("compiles clean (tsc exit 0)", async () => {
    const env = await createTempHome();
    try {
      const { exitCode, stderr } = buildFixture("sample-project-vuln", env.root);
      assert.equal(
        exitCode,
        0,
        `sample-project-vuln tsc failed (exit ${exitCode}): ${stderr}`,
      );
    } finally {
      cleanupTempHome(env);
    }
  });
});

describe("fixture-health — sample-project", () => {
  it("compiles clean (tsc exit 0)", async () => {
    const env = await createTempHome();
    try {
      const { exitCode, stderr } = buildFixture("sample-project", env.root);
      assert.equal(
        exitCode,
        0,
        `sample-project tsc failed (exit ${exitCode}): ${stderr}`,
      );
    } finally {
      cleanupTempHome(env);
    }
  });

  it('still contains planted bug "a - b" in src/math.ts', () => {
    const mathPath = path.join(fixturesDir, "sample-project", "src", "math.ts");
    assert.ok(fs.existsSync(mathPath), `src/math.ts not found at ${mathPath}`);
    const content = fs.readFileSync(mathPath, "utf-8");
    assert.ok(
      content.includes("a - b"),
      "Planted bug marker 'a - b' missing from sample-project/src/math.ts — " +
        "the fixture may have been inadvertently fixed.",
    );
  });

  it('still contains test named "returns the difference" in test/math.test.ts', () => {
    const testPath = path.join(
      fixturesDir,
      "sample-project",
      "test",
      "math.test.ts",
    );
    assert.ok(
      fs.existsSync(testPath),
      `test/math.test.ts not found at ${testPath}`,
    );
    const content = fs.readFileSync(testPath, "utf-8");
    assert.ok(
      content.includes('returns the difference'),
      "Test 'returns the difference' missing from sample-project/test/math.test.ts — " +
        "the fixture may have been inadvertently fixed.",
    );
  });
});
