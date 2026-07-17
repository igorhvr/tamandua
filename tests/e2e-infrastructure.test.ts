import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { releasePortReservations } from "../e2e-tests/helpers/smoke-helpers.ts";

const repoRoot = process.cwd();
const e2eDatabaseHelper = path.join(
  repoRoot,
  "e2e-tests",
  "helpers",
  "e2e-database.mjs",
);

function findDatabaseSyncConstructors(source: string): number[] {
  const matches: number[] = [];
  const pattern = /\bnew\s+DatabaseSync\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    matches.push(match.index);
  }
  return matches;
}

function walkFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
  });
}

describe("e2e test infrastructure", () => {
  it("e2e-tests/ directory exists", () => {
    assert.ok(fs.statSync(path.join(repoRoot, "e2e-tests")).isDirectory());
  });

  it("centralizes direct DatabaseSync construction in the busy-timeout helper", () => {
    const fixture = 'const db = new DatabaseSync("fixture.db");';
    assert.equal(
      findDatabaseSyncConstructors(fixture).length,
      1,
      "scanner self-check must detect a direct DatabaseSync construction",
    );

    const directOpenSites = walkFiles(path.join(repoRoot, "e2e-tests"))
      .flatMap((filePath) =>
        findDatabaseSyncConstructors(fs.readFileSync(filePath, "utf-8")).map(
          () => path.relative(repoRoot, filePath),
        ),
      );

    assert.deepEqual(
      directOpenSites,
      [path.relative(repoRoot, e2eDatabaseHelper)],
      `e2e DatabaseSync construction must stay centralized in ${path.relative(repoRoot, e2eDatabaseHelper)}; found:\n${directOpenSites.join("\n")}`,
    );
  });

  it("run-all-e2e-tests script exists and is executable", () => {
    const scriptPath = path.join(repoRoot, "run-all-e2e-tests");
    assert.ok(fs.existsSync(scriptPath), "run-all-e2e-tests should exist");
    fs.accessSync(scriptPath, fs.constants.X_OK); // throws if not executable
  });

  it("run-all-tests documents e2e test separation", () => {
    const content = fs.readFileSync(path.join(repoRoot, "run-all-tests"), "utf-8");
    assert.ok(
      content.includes("End-to-end tests live under e2e-tests/") &&
        content.includes("NOT included"),
      "run-all-tests should note e2e tests are separate",
    );
  });

  it("npm test does not pick up files from e2e-tests/", () => {
    // PRLL: npm test delegates to scripts/run-all-lanes.sh which orchestrates
    // serial + parallel lanes. e2e exclusion is enforced in run-parallel-tests.sh
    // via find + filter, not via npm test globs.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
    );
    const testCmd: string = pkg.scripts.test;
    assert.ok(
      !testCmd.includes("e2e-tests"),
      `npm test command should not include e2e-tests/, got: ${testCmd}`,
    );

    // Verify the orchestrator itself does not reference e2e-tests
    const allLanes = fs.readFileSync(
      path.join(repoRoot, "scripts", "run-all-lanes.sh"),
      "utf-8",
    );
    assert.ok(
      !allLanes.includes("e2e-tests"),
      "run-all-lanes.sh should not reference e2e-tests",
    );

    // Verify run-parallel-tests.sh excludes e2e-tests/ via find + filter
    const parallelRunner = fs.readFileSync(
      path.join(repoRoot, "scripts", "run-parallel-tests.sh"),
      "utf-8",
    );
    assert.ok(
      parallelRunner.includes("e2e-tests"),
      "run-parallel-tests.sh should reference e2e-tests for exclusion",
    );
    assert.ok(
      parallelRunner.includes("*/e2e-tests/*"),
      "run-parallel-tests.sh should exclude files under e2e-tests/ directory",
    );
    // The serial lane reads from tests/serial-files.txt — e2e files are never
    // listed there by the classification guard (tests/serial-files-integrity.test.ts).
  });

  it("e2e-tests/ is not compiled by tsconfig.json", () => {
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "tsconfig.json"), "utf-8"),
    );
    // rootDir is "src", include is ["src/**/*.ts"] — e2e-tests/ should not be referenced
    assert.ok(
      !tsconfig.include?.some((p: string) => p.includes("e2e")),
      "tsconfig include should not reference e2e-tests/",
    );
    assert.equal(tsconfig.compilerOptions?.rootDir, "src");
  });

  it("AGENTS.md documents e2e test separation and agent guidance", () => {
    const agentsMd = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf-8");
    // Should have an E2E test section
    assert.ok(
      agentsMd.includes("End-to-End Tests"),
      "AGENTS.md should have an End-to-End Tests section",
    );
    // Should tell agents not to run e2e tests by default — with emphasis
    assert.ok(
      agentsMd.includes("AGENTS MUST NOT RUN") ||
        agentsMd.includes("Agents must NOT run") ||
        agentsMd.includes("NOT RUN"),
      "AGENTS.md should prominently instruct agents not to run real e2e tests by default",
    );
    // Should distinguish smoke vs real e2e
    assert.ok(
      agentsMd.includes("smoke") || agentsMd.includes("Smoke"),
      "AGENTS.md should mention the smoke (fast) e2e test",
    );
    assert.ok(
      agentsMd.includes("REAL E2E") ||
        agentsMd.includes("real e2e") ||
        agentsMd.includes("Real e2e") ||
        agentsMd.includes("Real End-to-End"),
      "AGENTS.md should mention the real (slow) e2e test",
    );
  });

  it("AGENTS.md documents how to run real e2e tests explicitly", () => {
    const agentsMd = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf-8");
    assert.ok(
      agentsMd.includes("run-all-real-e2e-tests"),
      "AGENTS.md should document ./run-all-real-e2e-tests as the real e2e command",
    );
    assert.ok(
      agentsMd.includes("explicitly asked") ||
        agentsMd.includes("when explicitly"),
      "AGENTS.md should say real e2e should only be run when explicitly asked",
    );
  });

  it("AGENTS.md documents expected duration and token cost of real e2e", () => {
    const agentsMd = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf-8");
    // Should document duration
    assert.ok(
      agentsMd.includes("30+ minutes") ||
        agentsMd.includes("30-60 minutes") ||
        agentsMd.includes("30 minute"),
      "AGENTS.md should document real e2e test duration (30+ minutes)",
    );
    // Should document token cost
    assert.ok(
      agentsMd.includes("token") &&
        (agentsMd.includes("spends") || agentsMd.includes("cost") || agentsMd.includes("expensive") || agentsMd.includes("Tokens:")),
      "AGENTS.md should document real e2e test token cost",
    );
  });

  it("AGENTS.md clearly distinguishes smoke vs real e2e", () => {
    const agentsMd = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf-8");
    // The distinction should be TABLE-like or have clear separation
    assert.ok(
      agentsMd.includes("Smoke") && agentsMd.includes("Real"),
      "AGENTS.md should distinguish smoke from real e2e tests",
    );
    // Should mention both script names separately
    assert.ok(
      agentsMd.includes("run-all-smoke-e2e-tests"),
      "AGENTS.md should mention run-all-smoke-e2e-tests",
    );
    assert.ok(
      agentsMd.includes("run-all-real-e2e-tests"),
      "AGENTS.md should mention run-all-real-e2e-tests",
    );
  });

  it("run-all-e2e-tests runs only the smoke test by default", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "run-all-e2e-tests"),
      "utf-8",
    );
    assert.ok(
      content.includes("e2e-tests/workflows-smoke.test.ts"),
      "run-all-e2e-tests should run e2e-tests/workflows-smoke.test.ts",
    );
    assert.ok(
      content.includes("run-all-real-e2e-tests"),
      "run-all-e2e-tests should reference run-all-real-e2e-tests for real e2e",
    );
  });

  it("run-all-smoke-e2e-tests exists and is executable", () => {
    const scriptPath = path.join(repoRoot, "run-all-smoke-e2e-tests");
    assert.ok(
      fs.existsSync(scriptPath),
      "run-all-smoke-e2e-tests should exist",
    );
    fs.accessSync(scriptPath, fs.constants.X_OK);
  });

  it("run-all-smoke-e2e-tests runs only the smoke test file", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "run-all-smoke-e2e-tests"),
      "utf-8",
    );
    assert.ok(
      content.includes("e2e-tests/workflows-smoke.test.ts"),
      "run-all-smoke-e2e-tests should run workflows-smoke.test.ts",
    );
    assert.ok(
      content.includes("FAST"),
      "run-all-smoke-e2e-tests should mention it's fast",
    );
  });

  it("run-all-real-e2e-tests exists and is executable", () => {
    const scriptPath = path.join(repoRoot, "run-all-real-e2e-tests");
    assert.ok(
      fs.existsSync(scriptPath),
      "run-all-real-e2e-tests should exist",
    );
    fs.accessSync(scriptPath, fs.constants.X_OK);
  });

  it("run-all-real-e2e-tests runs only the real e2e test file", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "run-all-real-e2e-tests"),
      "utf-8",
    );
    assert.ok(
      content.includes("e2e-tests/workflows-e2e.test.ts"),
      "run-all-real-e2e-tests should run workflows-e2e.test.ts",
    );
  });

  it("run-all-real-e2e-tests has a prominent cost/time warning", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "run-all-real-e2e-tests"),
      "utf-8",
    );
    assert.ok(
      content.includes("WARNING") || content.includes("SLOW"),
      "run-all-real-e2e-tests should prominently warn about cost/time",
    );
    assert.ok(
      content.includes("token") || content.includes("model") || content.includes("cost"),
      "run-all-real-e2e-tests should warn about token/model cost",
    );
    assert.ok(
      content.includes("minute") || content.includes("30"),
      "run-all-real-e2e-tests should mention expected duration",
    );
  });

  it("run-all-real-e2e-tests tells agents NOT to run by default", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "run-all-real-e2e-tests"),
      "utf-8",
    );
    assert.ok(
      content.includes("NOT run") || content.includes("not run") || content.includes("DO NOT"),
      "run-all-real-e2e-tests should tell agents not to run by default",
    );
  });

  // ── Real e2e test file structure (does NOT run the slow test) ──────────

  it("e2e-tests/workflows-e2e.test.ts exists", () => {
    const filePath = path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts");
    assert.ok(fs.existsSync(filePath), "e2e-tests/workflows-e2e.test.ts should exist");
  });

  it("e2e-tests/workflows-e2e.test.ts has a prominent slowness/cost warning", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      (content.includes("WARNING") || content.includes("SLOW")) &&
        (content.includes("token") || content.includes("cost") || content.includes("TOKEN")),
      "real e2e test should prominently warn about slowness and token cost",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts tells agents not to run it by default", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("NOT RUN") ||
        content.includes("not run") ||
        content.includes("DO NOT RUN") ||
        content.includes("NOT picked up"),
      "real e2e test should instruct agents to not run it by default",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts uses isolated daemon and polling helpers", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("startIsolatedDaemon") || content.includes("e2e-helpers"),
      "real e2e test should use isolated daemon helpers",
    );
    assert.ok(
      content.includes("waitForRunTerminal") ||
        content.includes("pollForRunCompletion"),
      "real e2e test should use run polling helpers",
    );
    assert.ok(
      content.includes("stopIsolatedDaemon"),
      "real e2e test should stop the daemon in cleanup",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts verifies repository state after completion", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("multiply") || content.includes("Merge") || content.includes("merge"),
      "real e2e test should verify multiply function exists in repo",
    );
    assert.ok(
      content.includes("git log") || content.includes("gitLog"),
      "real e2e test should check git log for merge",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts has a long timeout suitable for real agents", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    // Should have a timeout of at least 30 minutes (30 * 60 * 1000 = 1_800_000ms)
    const timeoutMatch = content.match(/timeout.*?(\d+[_\d]*)\s*\*/);
    assert.ok(
      timeoutMatch || content.includes("60_000") || content.includes("45_000"),
      "real e2e test should declare a long timeout for agent processing",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts cleans up with a finally block", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("finally"),
      "real e2e test should use a finally block for guaranteed cleanup",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts does NOT use manual step claim/complete", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      !content.includes("stepClaim") && !content.includes("stepComplete"),
      "real e2e test should NOT use manual step claim/complete — uses daemon + polling",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts uses createTempHome for isolation", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("createTempHome"),
      "real e2e test should use createTempHome for test isolation",
    );
  });

  // ── US-005: bug-fix-merge-worktree sequential test ──────────────────

  it("e2e-tests/workflows-e2e.test.ts uses before/after hooks for shared state", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("before(") || content.includes("before ("),
      "real e2e test should use before hook for shared setup",
    );
    assert.ok(
      content.includes("after(") || content.includes("after ("),
      "real e2e test should use after hook for shared cleanup",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts documents sequential test ordering", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("SEQUENTIALLY") || content.includes("sequential") || content.includes("TEST ORDERING"),
      "real e2e test should document that tests run sequentially",
    );
    assert.ok(
      content.includes("bug-fix-merge-worktree"),
      "real e2e test should reference bug-fix-merge-worktree workflow",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts installs bug-fix-merge-worktree workflow", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes('"bug-fix-merge-worktree"'),
      "real e2e test should install the bug-fix-merge-worktree workflow",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts restarts daemon between workflows", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    // Should stop daemon in test 1's finally, start again in test 2
    const stopCount = (content.match(/stopIsolatedDaemon/g) || []).length;
    const startCount = (content.match(/startIsolatedDaemon/g) || []).length;
    assert.ok(
      stopCount >= 2 && startCount >= 2,
      `real e2e test should start/stop daemon at least 2 times (once per test). Found: ${startCount} starts, ${stopCount} stops`,
    );
    assert.ok(
      content.includes("clean scheduler state"),
      "real e2e test should comment about clean scheduler state on restart",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts verifies add function is fixed (a + b)", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes('"a + b"') || content.includes('"a+b"'),
      "real e2e test should verify add function returns a + b after fix",
    );
    assert.ok(
      content.includes('"a - b"') || content.includes('"a-b"'),
      "real e2e test should also check that a - b is no longer present",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts verifies add stays fixed after feature-dev", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("Add function remains fixed") ||
        content.includes("add remains fixed") ||
        content.includes("no regression"),
      "real e2e test should verify the feature workflow does not regress the bug-fix",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts checks precondition: add is broken before fix", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("Precondition") || content.includes("precondition"),
      "real e2e test should check precondition that add is broken before starting the bug-fix",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts verifies git log after sequential runs", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    // After both workflows, at least 3 commits: initial + feature merge + fix merge
    assert.ok(
      content.includes("commitLines.length >= 3") || content.includes("at least 3 commits"),
      "real e2e test should verify at least 3 commits after both workflows",
    );
  });

  // ── US-007: test isolation verification ─────────────────────────────

  it("e2e-tests/workflows-e2e.test.ts uses port handle reservation via createTempHome", () => {
    const smokeHelpers = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "helpers", "smoke-helpers.ts"),
      "utf-8",
    );
    // createTempHome must use reservePortHandles (not the deprecated reserveDistinctRandomPorts)
    assert.ok(
      smokeHelpers.includes("reservePortHandles"),
      "createTempHome must use reservePortHandles to avoid TOCTOU port race",
    );
  });

  it("port reservation handoff closes each handle at most once", async () => {
    const closeCounts = [0, 0];
    const env = {
      portHandles: closeCounts.map((_, index) => ({
        async close() {
          closeCounts[index] += 1;
        },
      })),
    };

    await Promise.all([
      releasePortReservations(env),
      releasePortReservations(env),
    ]);
    await releasePortReservations(env);

    assert.deepEqual(closeCounts, [1, 1]);
  });

  it("daemon-spawning e2e tests release reserved ports", () => {
    const e2eDir = path.join(repoRoot, "e2e-tests");
    const testFileNames = fs.readdirSync(e2eDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => entry.name);

    for (const fileName of testFileNames) {
      const content = fs.readFileSync(path.join(e2eDir, fileName), "utf-8");
      if (!content.includes("startIsolatedDaemon(")) continue;

      assert.ok(
        content.includes("releasePortReservations("),
        `${fileName} starts an isolated daemon but does not release reserved ports`,
      );
    }
  });

  for (const fileName of [
    "workflows-stress-concurrent.test.ts",
    "workflows-e2e.test.ts",
  ]) {
    it(`${fileName} releases reserved ports before every daemon start`, () => {
      const content = fs.readFileSync(
        path.join(repoRoot, "e2e-tests", fileName),
        "utf-8",
      );
      const startOffsets = Array.from(
        content.matchAll(/\bstartIsolatedDaemon\s*\(/g),
        (match) => match.index,
      );
      assert.ok(startOffsets.length > 0, `${fileName} should start an isolated daemon`);

      let previousStart = -1;
      for (const startOffset of startOffsets) {
        const releaseOffset = content.lastIndexOf(
          "await releasePortReservations(env);",
          startOffset,
        );
        assert.ok(
          releaseOffset > previousStart,
          `${fileName} must release env port reservations before daemon start at offset ${startOffset}`,
        );
        previousStart = startOffset;
      }
    });
  }

  it("e2e-tests/workflows-e2e.test.ts documents worktree cleanup", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    // Worktree directories are created under isolated HOME (os.homedir()
    // respects HOME env var), so cleanupTempHome() removes them.
    assert.ok(
      content.includes("worktree") && content.includes("cleanup"),
      "real e2e test should document worktree cleanup",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts documents temp HOME removal", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("cleanupTempHome"),
      "real e2e test should use cleanupTempHome for temp HOME removal",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts uses after hook for cleanup", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("after"),
      "real e2e test should use after hook for guaranteed cleanup on failure",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts has isolation comment block in header", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    assert.ok(
      content.includes("TEST ISOLATION"),
      "real e2e test should document test isolation in its header comment",
    );
    assert.ok(
      content.includes("temp HOME") || content.includes("createTempHome"),
      "real e2e test isolation docs should mention temp HOME",
    );
    assert.ok(
      content.includes("default ports") || content.includes("3334"),
      "real e2e test isolation docs should explain default port avoidance",
    );
  });

  it("e2e-tests/workflows-e2e.test.ts does not use default port constants", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    // The real e2e test must not hardcode 3334, 3338, or 3339 as port numbers in code.
    // Comment/markdown lines mentioning these ports for documentation are fine.
    const portNumberLines = content.split("\n").filter((line) =>
      /\b(3334|3338|3339)\b/.test(line) &&
      !line.trim().startsWith("//") &&
      !line.trim().startsWith("*") &&
      !line.includes("default ports") &&
      !line.includes("3334/3338/3339")
    );
    assert.deepEqual(
      portNumberLines,
      [],
      `real e2e test must not use default ports 3334/3338/3339 in code:\n${portNumberLines.join("\n")}`,
    );
  });

  it("e2e-tests/workflows-e2e.test.ts uses the same repo for both workflows", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "e2e-tests", "workflows-e2e.test.ts"),
      "utf-8",
    );
    // repoDir should be declared once in before and reused in both tests
    assert.ok(
      content.includes("same repo") || content.includes("sequential") || content.includes("Shared state"),
      "real e2e test should document shared repo between sequential tests",
    );
    // repoDir appears in both test it() blocks
    const repoDirMatches = content.match(/repoDir/g);
    assert.ok(
      repoDirMatches && repoDirMatches.length >= 4,
      `repoDir should be referenced in both tests. Found: ${repoDirMatches?.length || 0} references`,
    );
  });
});
