import assert from "node:assert/strict";
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

// Strip NODE_TEST_CONTEXT / TAMANDUA_TEST_GUARD from child process env
// so fixture builders (which may run npm test or cargo test internally)
// don't trip on tamandua test isolation guards.
const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT" || k === "TAMANDUA_TEST_GUARD") continue;
    env[k] = v;
  }
  return env;
})();

function execOpts(
  overrides: Partial<Parameters<typeof execSync>[1]> = {},
): Parameters<typeof execSync>[1] {
  return { env: CLEAN_ENV, ...overrides } as Parameters<typeof execSync>[1];
}

// ── All fixture build-golden.sh scripts ──────────────────────────────────

interface Fixture {
  name: string;
  scriptPath: string;
  defaultGoldenDir: string;
  bareName: string;
  // which pattern this fixture uses (REPO_ROOT vs VAR_DIR)
  pattern: "REPO_ROOT" | "VAR_DIR";
}

const fixtures: Fixture[] = [
  {
    name: "tt-poly",
    scriptPath: path.join(repoRoot, "torture-test/fixtures-src/tt-poly/build-golden.sh"),
    defaultGoldenDir: path.join(repoRoot, "torture-test/var/fixtures/golden"),
    bareName: "tt-poly.git",
    pattern: "REPO_ROOT",
  },
  {
    name: "tt-poly-lite",
    scriptPath: path.join(repoRoot, "torture-test/fixtures-src/tt-poly-lite/build-golden.sh"),
    defaultGoldenDir: path.join(repoRoot, "torture-test/var/fixtures/golden"),
    bareName: "tt-poly-lite.git",
    pattern: "REPO_ROOT",
  },
  {
    name: "tt-go",
    scriptPath: path.join(repoRoot, "torture-test/fixtures-src/tt-go/build-golden.sh"),
    defaultGoldenDir: path.join(repoRoot, "torture-test/var/fixtures/golden"),
    bareName: "tt-go.git",
    pattern: "VAR_DIR",
  },
  {
    name: "tt-java",
    scriptPath: path.join(repoRoot, "torture-test/fixtures-src/tt-java/build-golden.sh"),
    defaultGoldenDir: path.join(repoRoot, "torture-test/var/fixtures/golden"),
    bareName: "tt-java.git",
    pattern: "REPO_ROOT",
  },
  {
    name: "tt-python",
    scriptPath: path.join(repoRoot, "torture-test/fixtures-src/tt-python/build-golden.sh"),
    defaultGoldenDir: path.join(repoRoot, "torture-test/var/fixtures/golden"),
    bareName: "tt-python.git",
    pattern: "VAR_DIR",
  },
  {
    name: "tt-python@master",
    scriptPath: path.join(repoRoot, "torture-test/fixtures-src/tt-python@master/build-golden.sh"),
    defaultGoldenDir: path.join(repoRoot, "torture-test/var/fixtures/golden"),
    bareName: "tt-python@master.git",
    pattern: "VAR_DIR",
  },
  {
    name: "tt-rust",
    scriptPath: path.join(repoRoot, "torture-test/fixtures-src/tt-rust/build-golden.sh"),
    defaultGoldenDir: path.join(repoRoot, "torture-test/var/fixtures/golden"),
    bareName: "tt-rust.git",
    pattern: "VAR_DIR",
  },
  {
    name: "tt-ts",
    scriptPath: path.join(repoRoot, "torture-test/fixtures-src/tt-ts/build-golden.sh"),
    defaultGoldenDir: path.join(repoRoot, "torture-test/var/fixtures/golden"),
    bareName: "tt-ts.git",
    pattern: "REPO_ROOT",
  },
];

describe("TORTURE_GOLDEN_DIR env var override", () => {
  // ── AC 1: All 8 scripts support TORTURE_GOLDEN_DIR override ────────────

  for (const fixture of fixtures) {
    it(`${fixture.name}: GOLDEN_DIR uses TORTURE_GOLDEN_DIR override with fallback`, () => {
      const content = fs.readFileSync(fixture.scriptPath, "utf-8");
      const regex = /\bGOLDEN_DIR\s*=\s*"\$\{TORTURE_GOLDEN_DIR:-[^}]+\}"/;
      assert.match(content, regex, `${fixture.name} should use TORTURE_GOLDEN_DIR override`);
    });
  }

  // ── AC 2: Default unchanged when TORTURE_GOLDEN_DIR is not set ─────────

  it("all scripts default to the correct path when TORTURE_GOLDEN_DIR is not set", () => {
    for (const fixture of fixtures) {
      const content = fs.readFileSync(fixture.scriptPath, "utf-8");
      // The fallback inside ${TORTURE_GOLDEN_DIR:-...} must match the expected
      // default path pattern (either REPO_ROOT or VAR_DIR based).
      if (fixture.pattern === "REPO_ROOT") {
        assert.match(
          content,
          /\$\{TORTURE_GOLDEN_DIR:-\$REPO_ROOT\/torture-test\/var\/fixtures\/golden\}/,
          `${fixture.name}: default should use $REPO_ROOT/torture-test/var/fixtures/golden`,
        );
      } else {
        assert.match(
          content,
          /\$\{TORTURE_GOLDEN_DIR:-\$VAR_DIR\/fixtures\/golden\}/,
          `${fixture.name}: default should use $VAR_DIR/fixtures/golden`,
        );
      }
    }
  });

  // ── AC 3: Build with override redirects output to the overridden dir ───
  // We test tt-go as a representative since it's the cheapest to build.

  it("tt-go: builds into overridden dir when TORTURE_GOLDEN_DIR is set", function () {
    const fixture = fixtures.find((f) => f.name === "tt-go")!;
    const overrideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tamandua-test-golden-override-"),
    );
    const expectedBare = path.join(overrideDir, fixture.bareName);

    try {
      // Sanity: verify the script exists
      assert.ok(fs.existsSync(fixture.scriptPath), "build-golden.sh exists");

      // Run with override
      execSync(`bash "${fixture.scriptPath}"`, {
        env: { ...CLEAN_ENV, TORTURE_GOLDEN_DIR: overrideDir },
        stdio: "pipe",
        timeout: 60_000,
      });

      // Verify output went to the overridden dir
      assert.ok(
        fs.existsSync(expectedBare),
        `Expected bare repo at ${expectedBare}`,
      );

      // Verify it's a valid git bare repo
      const head = execSync("git rev-parse HEAD", {
        cwd: expectedBare,
        encoding: "utf-8",
        env: CLEAN_ENV,
      }).trim();
      assert.match(head, /^[0-9a-f]{40}$/, "should have a valid HEAD commit");
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  // ── AC 4: Default behavior (no env var) still works and doesn't write ──
  // into the override scratch area.

  it("tt-go: builds into default dir when TORTURE_GOLDEN_DIR is not set", function () {
    const fixture = fixtures.find((f) => f.name === "tt-go")!;
    const expectedBare = path.join(fixture.defaultGoldenDir, fixture.bareName);

    // Run without override
    execSync(`bash "${fixture.scriptPath}"`, {
      env: CLEAN_ENV,
      stdio: "pipe",
      timeout: 60_000,
    });

    // Verify output went to the default dir
    assert.ok(
      fs.existsSync(expectedBare),
      `Expected bare repo at ${expectedBare}`,
    );
  });

  // ── Additional smoke: tt-python builds into overridden dir ─────────
  it("tt-python: builds into overridden dir when TORTURE_GOLDEN_DIR is set", function () {
    const fixture = fixtures.find((f) => f.name === "tt-python")!;
    const overrideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tamandua-test-golden-override-python-"),
    );
    const expectedBare = path.join(overrideDir, fixture.bareName);

    try {
      execSync(`bash "${fixture.scriptPath}"`, {
        env: { ...CLEAN_ENV, TORTURE_GOLDEN_DIR: overrideDir },
        stdio: "pipe",
        timeout: 120_000,
      });

      assert.ok(
        fs.existsSync(expectedBare),
        `Expected bare repo at ${expectedBare}`,
      );
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  // ── AC: All 8 scripts are valid bash syntax after the change ────────────

  for (const fixture of fixtures) {
    it(`${fixture.name}: script passes bash -n syntax check`, () => {
      execFileSync("bash", ["-n", fixture.scriptPath], { env: CLEAN_ENV });
    });
  }
});
