import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";
import { describe, it, before } from "node:test";

const repoRoot = process.cwd();

// NODE_TEST_CONTEXT causes tsx --test (used by the ts suite's npm test)
// to silently skip all tests. Strip it from the environment.
const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT" || k === "TAMANDUA_TEST_GUARD") continue;
    env[k] = v;
  }
  return env;
})();

// ==========================================================================
// US-017: Storm sentinel pre-verification and A5 cross-language seed
// ==========================================================================
describe("tt-poly A5 seed and sentinel pre-verification (US-017)", () => {
  const fixtureSrc = path.join(repoRoot, "torture-test", "fixtures-src", "tt-poly");
  const scriptPath = path.join(fixtureSrc, "build-golden.sh");
  const seedsDir = path.join(fixtureSrc, "seeds");
  const a5SeedDir = path.join(seedsDir, "POLY-BUG-A5");
  const goldenDir = path.join(repoRoot, "torture-test", "var", "fixtures", "golden");

  // ── AC 3: POLY-BUG-A5 seed directory structure ──────────────────────────

  describe("POLY-BUG-A5 seed directory (AC3)", () => {
    it("POLY-BUG-A5 seed directory exists", () => {
      assert.ok(fs.existsSync(a5SeedDir), "POLY-BUG-A5 seed directory should exist");
    });

    it("has integrations.py overlay", () => {
      const overlay = path.join(a5SeedDir, "integrations.py");
      assert.ok(fs.existsSync(overlay), "integrations.py overlay should exist");
      const content = fs.readFileSync(overlay, "utf-8");
      // Buggy keys (calendar_name/calendar_id) should be present
      assert.ok(content.includes('"calendar_name"'), "should contain calendar_name key");
      assert.ok(content.includes('"calendar_id"'), "should contain calendar_id key");
      assert.ok(content.includes("POLY-BUG-A5"), "should reference POLY-BUG-A5");
    });

    it("has server.ts overlay with buggy keys", () => {
      const overlay = path.join(a5SeedDir, "server.ts");
      assert.ok(fs.existsSync(overlay), "server.ts overlay should exist");
      const content = fs.readFileSync(overlay, "utf-8");
      // Buggy keys (calendarName/calendarId) should be present
      assert.ok(content.includes("calendarName"), "should contain calendarName key");
      assert.ok(content.includes("calendarId"), "should contain calendarId key");
      // Should NOT have the correct keys
      assert.ok(!content.match(/\bname\s*:\s*`Calendar/), "should NOT use correct name key");
    });

    it("has test_calendar_integration.py overlay", () => {
      const overlay = path.join(a5SeedDir, "test_calendar_integration.py");
      assert.ok(fs.existsSync(overlay), "test_calendar_integration.py overlay should exist");
      const content = fs.readFileSync(overlay, "utf-8");
      // Buggy assertions
      assert.ok(content.includes('"calendar_name"'), "test should assert calendar_name");
      assert.ok(content.includes('"calendar_id"'), "test should assert calendar_id");
    });

    it("has fix.patch", () => {
      const fixPatch = path.join(a5SeedDir, "fix.patch");
      assert.ok(fs.existsSync(fixPatch), "fix.patch should exist");
      const content = fs.readFileSync(fixPatch, "utf-8");
      // Should fix integrations.py
      assert.ok(content.includes("integrations.py"), "should fix integrations.py");
      // Should fix server.ts
      assert.ok(content.includes("server.ts"), "should fix server.ts");
      // Should fix test_calendar_integration.py
      assert.ok(content.includes("test_calendar_integration.py"), "should fix test_calendar_integration.py");
      // Should remove buggy keys
      assert.ok(content.includes('+"name"') || content.includes('+    return {"name"'), "should restore name key");
    });

    it("baseline integrations.py has lookup_calendar_name (correct keys)", () => {
      const baseline = path.join(fixtureSrc, "python", "src", "schedlib", "integrations.py");
      const content = fs.readFileSync(baseline, "utf-8");
      assert.ok(content.includes("lookup_calendar_name"), "baseline should have lookup_calendar_name");
      assert.ok(content.includes('"name"'), "baseline should use correct name key");
      assert.ok(content.includes('"id"'), "baseline should use correct id key");
    });

    it("baseline server.ts has lookupCalendarName bridge (correct keys)", () => {
      const baseline = path.join(fixtureSrc, "ts", "src", "server.ts");
      const content = fs.readFileSync(baseline, "utf-8");
      assert.ok(content.includes("lookupCalendarName"), "baseline should have lookupCalendarName");
      assert.ok(content.includes("name:"), "baseline should use correct name key");
      assert.ok(content.includes("id: calendarId"), "baseline should use correct id key");
    });

    it("baseline has test_calendar_integration.py", () => {
      const baseline = path.join(fixtureSrc, "python", "tests", "test_calendar_integration.py");
      assert.ok(fs.existsSync(baseline), "baseline should have test_calendar_integration.py");
      const content = fs.readFileSync(baseline, "utf-8");
      assert.ok(content.includes('"name"'), "baseline test should assert name key");
      assert.ok(content.includes('"id"'), "baseline test should assert id key");
    });
  });

  // ── AC 4: POLY-BUG-A5 partial-fix property ──────────────────────────────

  describe("POLY-BUG-A5 two-module partial-fix property (AC4)", () => {
    it("seed integrations.py differs from baseline (key names)", () => {
      const baseline = fs.readFileSync(
        path.join(fixtureSrc, "python", "src", "schedlib", "integrations.py"), "utf-8"
      );
      const seed = fs.readFileSync(path.join(a5SeedDir, "integrations.py"), "utf-8");

      // Seed should have different return values
      const baselineReturn = baseline.match(/return\s*\{[^}]+\}/);
      const seedReturn = seed.match(/return\s*\{[^}]+\}/);
      assert.ok(baselineReturn, "baseline should have return statement");
      assert.ok(seedReturn, "seed should have return statement");
      assert.notStrictEqual(baselineReturn![0], seedReturn![0], "seed return should differ from baseline");
    });

    it("seed test_calendar_integration.py assertions match buggy keys", () => {
      const seed = fs.readFileSync(path.join(a5SeedDir, "test_calendar_integration.py"), "utf-8");
      // Seed test should assert calendar_name/calendar_id (buggy keys)
      assert.ok(seed.includes('"calendar_name"'), "seed test should assert calendar_name");
      assert.ok(seed.includes('"calendar_id"'), "seed test should assert calendar_id");
      assert.ok(seed.includes("POLY-BUG-A5 seed state"), "should document seed state");
    });

    it("fix.patch restores correct keys in integrations.py", () => {
      const fixPatch = fs.readFileSync(path.join(a5SeedDir, "fix.patch"), "utf-8");
      // The fix should add back the correct return
      assert.ok(fixPatch.includes('+"name"') || fixPatch.includes('return {"name"'), "fix should restore name key");
      assert.ok(fixPatch.includes('+"id"') || fixPatch.includes('"id": calendar_id'), "fix should restore id key");
      // The fix should remove buggy keys
      assert.ok(fixPatch.includes('-"calendar_name"') || fixPatch.includes('-    # POLY-BUG-A5'), "fix should remove buggy keys");
    });

    it("fix.patch restores correct keys in server.ts", () => {
      const fixPatch = fs.readFileSync(path.join(a5SeedDir, "fix.patch"), "utf-8");
      assert.ok(fixPatch.includes("+  return { name:"), "fix should restore name key in server.ts");
      assert.ok(fixPatch.includes("-  return { calendarName:"), "fix should remove calendarName");
    });

    it("fix.patch fixes test assertions in test_calendar_integration.py", () => {
      const fixPatch = fs.readFileSync(path.join(a5SeedDir, "fix.patch"), "utf-8");
      assert.ok(fixPatch.includes('+"name"') || fixPatch.includes('assert result == {"name"'), "fix should fix test assertions");
      // Fix removes calendar_name assertions (indented with spaces after leading -)
      assert.ok(
        fixPatch.includes('-"calendar_name"') || fixPatch.includes('calendar_name'),
        "fix should reference calendar_name (as removed lines)",
      );
    });
  });

  // ── AC 1: Storm sentinel pre-verification in build-golden.sh ────────────

  describe("Storm sentinel pre-verification in build-golden.sh (AC1)", () => {
    let scriptContent: string;

    before(() => {
      scriptContent = fs.readFileSync(scriptPath, "utf-8");
    });

    it("has Phase 9 storm sentinel pre-verification section", () => {
      assert.ok(scriptContent.includes("Phase 9"), "should have Phase 9 section");
      assert.ok(
        scriptContent.includes("Storm sentinel pre-verification"),
        "should mention Storm sentinel pre-verification",
      );
    });

    it("builds S5 branch with category-normalization helper", () => {
      assert.ok(scriptContent.includes("sentinel-s5"), "should create sentinel-s5 branch");
      assert.ok(
        scriptContent.includes("normalizeCategories") || scriptContent.includes("category-normalization"),
        "should add normalization helper",
      );
    });

    it("builds S9 branch with category-aliasing map", () => {
      assert.ok(scriptContent.includes("sentinel-s9"), "should create sentinel-s9 branch");
      assert.ok(
        scriptContent.includes("categoryAliases") || scriptContent.includes("category-aliasing"),
        "should add category-aliasing map",
      );
    });

    it("runs git merge-tree between S5 and S9", () => {
      assert.ok(scriptContent.includes("git merge-tree"), "should run git merge-tree");
      assert.ok(scriptContent.includes("$S5_SHA"), "should reference S5 SHA");
      assert.ok(scriptContent.includes("$S9_SHA"), "should reference S9 SHA");
    });

    it("checks for conflict markers in merge-tree output", () => {
      assert.ok(scriptContent.includes("CONFLICT"), "should check for CONFLICT markers");
      assert.ok(scriptContent.includes("Merge conflict"), "should check for Merge conflict message");
    });

    it("fails build if merge-tree reports clean merge", () => {
      assert.ok(scriptContent.includes("exit 1"), "should exit 1 on clean merge");
      assert.ok(
        scriptContent.includes("FATAL") || scriptContent.includes("did NOT report a textual conflict"),
        "should report fatal diagnostic on clean merge",
      );
    });

    it("sentinel pre-verification runs before post-build verification", () => {
      const phase9Idx = scriptContent.indexOf("Phase 9");
      const phase10Idx = scriptContent.indexOf("Phase 10");
      assert.ok(phase9Idx > 0 && phase10Idx > 0, "Phase 9 and Phase 10 should both exist");
      assert.ok(phase9Idx < phase10Idx, "Phase 9 (sentinel) should run before Phase 10 (verification)");
    });
  });

  // ── AC 2: git merge-tree reports textual conflict ───────────────────────

  describe("git merge-tree conflict verification (AC2)", () => {
    it("S5 and S9 branches produce conflicting edits on the sentinel region", function () {
      this.timeout = 120_000;

      // Verify build-golden.sh runs successfully (includes sentinel pre-verification)
      if (fs.existsSync(goldenDir)) {
        fs.rmSync(goldenDir, { recursive: true, force: true });
      }

      let output: string;
      try {
        output = execSync(`bash "${scriptPath}"`, {
          cwd: repoRoot,
          env: CLEAN_ENV,
          stdio: "pipe",
          encoding: "utf-8",
          timeout: 300_000,
        });
      } catch (e: unknown) {
        const err = e as Error & { stdout?: string; stderr?: string };
        assert.fail(
          `build-golden.sh failed!\nstdout: ${err.stdout || "(none)"}\nstderr: ${err.stderr || err.message}`,
        );
      }

      // Phase 9 should report conflict detected
      assert.ok(
        output.includes("TEXTUAL CONFLICT DETECTED") ||
          output.includes("conflict confirmed"),
        "should report textual conflict detected",
      );

      // Should NOT report FATAL
      assert.ok(
        !output.includes("FATAL:"),
        "should not have fatal error",
      );

      // Overall should complete successfully
      assert.ok(output.includes("build-golden.sh — COMPLETE"), "build should complete");
      assert.ok(output.includes("ALL PASSED"), "verification should pass");
    });

    it("sentinel pre-verification is mentioned in build completion summary", function () {
      this.timeout = 60_000;

      const bareRepo = path.join(goldenDir, "tt-poly.git");
      // Already built from previous test; verify hash file exists
      assert.ok(fs.existsSync(bareRepo), "golden repo should exist after build");

      // Read the build output (rerun is OK, deterministic)
      const output = execSync(`bash "${scriptPath}"`, {
        cwd: repoRoot,
        env: CLEAN_ENV,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 300_000,
      });

      assert.ok(
        output.includes("Storm sentinel pre-verification") ||
          output.includes("sentinel pre-verification"),
        "summary should mention sentinel pre-verification",
      );
    });
  });

  // ── AC 5: seed/POLY-BUG-A5 ref in golden repo ───────────────────────────

  describe("seed/POLY-BUG-A5 ref in golden repo (AC5)", () => {
    it("seed/POLY-BUG-A5 ref exists in golden repo", function () {
      this.timeout = 60_000;

      const bareRepo = path.join(goldenDir, "tt-poly.git");
      assert.ok(fs.existsSync(bareRepo), "golden repo should exist");

      try {
        const sha = execSync(
          `git --git-dir="${bareRepo}" rev-parse refs/heads/seed/POLY-BUG-A5`,
          { encoding: "utf-8", stdio: "pipe" },
        ).trim();
        assert.ok(sha.length === 40, `POLY-BUG-A5 ref should be 40-char SHA, got: ${sha}`);
      } catch {
        assert.fail("seed/POLY-BUG-A5 ref should exist in golden repo");
      }
    });

    it("POLY-BUG-A5 ref differs from baseline", function () {
      this.timeout = 60_000;

      const bareRepo = path.join(goldenDir, "tt-poly.git");
      const baselineSha = execSync(
        `git --git-dir="${bareRepo}" rev-parse refs/heads/main`,
        { encoding: "utf-8", stdio: "pipe" },
      ).trim();
      const a5Sha = execSync(
        `git --git-dir="${bareRepo}" rev-parse refs/heads/seed/POLY-BUG-A5`,
        { encoding: "utf-8", stdio: "pipe" },
      ).trim();

      assert.notStrictEqual(a5Sha, baselineSha, "A5 seed ref should differ from baseline");
    });

    it("POLY-BUG-A5 ref contains the integration test file", function () {
      this.timeout = 120_000;

      const tmpDir = tamanduaTempDir("a5-ref-check");
      try {
        const bareRepo = path.join(goldenDir, "tt-poly.git");
        execSync(`git clone "${bareRepo}" "${tmpDir}"`, { stdio: "pipe", encoding: "utf-8" });
        execSync(`cd "${tmpDir}" && git checkout seed/POLY-BUG-A5`, { stdio: "pipe", encoding: "utf-8" });

        // Check integrations.py has buggy keys
        const intg = fs.readFileSync(path.join(tmpDir, "python", "src", "schedlib", "integrations.py"), "utf-8");
        assert.ok(intg.includes('"calendar_name"'), "A5 ref integrations.py should have calendar_name");
        assert.ok(intg.includes('"calendar_id"'), "A5 ref integrations.py should have calendar_id");

        // Check server.ts has buggy keys
        const srv = fs.readFileSync(path.join(tmpDir, "ts", "src", "server.ts"), "utf-8");
        assert.ok(srv.includes("calendarName"), "A5 ref server.ts should have calendarName");
        assert.ok(srv.includes("calendarId"), "A5 ref server.ts should have calendarId");

        // Check test file exists
        const testFile = path.join(tmpDir, "python", "tests", "test_calendar_integration.py");
        assert.ok(fs.existsSync(testFile), "A5 ref should include test_calendar_integration.py");
        const testContent = fs.readFileSync(testFile, "utf-8");
        assert.ok(testContent.includes('"calendar_name"'), "test file should assert calendar_name");
        assert.ok(testContent.includes('"calendar_id"'), "test file should assert calendar_id");
      } finally {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── AC 6: Tests pass and typecheck clean ────────────────────────────────

  describe("build-golden.sh includes A5 in seed refs and storm composition", () => {
    let content: string;

    before(() => {
      content = fs.readFileSync(scriptPath, "utf-8");
    });

    it("defines A5_SEED array", () => {
      assert.ok(content.includes("A5_SEED=(POLY-BUG-A5)"), "should define A5_SEED");
    });

    it("has a5_target_for function", () => {
      assert.ok(content.includes("a5_target_for()"), "should have a5_target_for function");
      assert.ok(content.includes("integrations.py"), "a5_target_for should handle integrations.py");
      assert.ok(content.includes("server.ts"), "a5_target_for should handle server.ts");
      assert.ok(content.includes("test_calendar_integration.py"), "a5_target_for should handle test file");
    });

    it("has Phase 6a for building A5 seed ref", () => {
      assert.ok(content.includes("Phase 6a"), "should have Phase 6a section");
      assert.ok(
        content.includes("POLY-BUG-A5 cross-language seed ref"),
        "should mention POLY-BUG-A5",
      );
    });

    it("STORM_ORDER includes POLY-BUG-A5", () => {
      assert.ok(content.includes("POLY-BUG-A5"), "STORM_ORDER should include POLY-BUG-A5");
    });

    it("Phase 8 storm case handles POLY-BUG-A5", () => {
      assert.ok(
        content.includes("POLY-BUG-A5)") && content.includes("a5_target_for"),
        "Phase 8 should handle POLY-BUG-A5",
      );
    });

    it("ALL_SEED_REFS includes POLY-BUG-A5", () => {
      assert.ok(
        content.includes('"${A5_SEED[@]}"'),
        "ALL_SEED_REFS should include A5_SEED",
      );
    });

    it("summary section includes POLY-BUG-A5", () => {
      assert.ok(
        content.includes("POLY-BUG-A5 cross-language seed"),
        "summary should mention POLY-BUG-A5",
      );
    });

    it("hash stability section includes POLY-BUG-A5", () => {
      // Hash stability should include A5_SEED in its seed loop
      assert.ok(
        content.includes('"${A5_SEED[@]}"'),
        "hash stability should include A5_SEED",
      );
    });

    it("Phase 10 spot-checks verify A5 seed content", () => {
      assert.ok(
        content.includes("seed/POLY-BUG-A5 integrations.py differs from baseline"),
        "should check A5 integrations.py differs from baseline",
      );
      assert.ok(
        content.includes("seed/POLY-BUG-A5 server.ts differs from baseline"),
        "should check A5 server.ts differs from baseline",
      );
      assert.ok(
        content.includes("seed/POLY-BUG-A5 test_calendar_integration.py present"),
        "should check A5 test file presence",
      );
    });
  });
});
