/**
 * Unit tests for scripted-agent-runtime-shared.mjs — the shared module
 * used by both pi and hermes scripted-agent runtimes.
 *
 * Tests focus on the atomic file-locking behavior of nextWorkIndex():
 *   1. Sequential calls produce contiguous indices (single-process baseline)
 *   2. Concurrent processes produce unique indices without duplicates
 *   3. Lock directory is cleaned up after each increment
 *   4. Different keys have independent counters
 *   5. Backward compatibility: single-run behavior unchanged
 *
 * Test isolation: each test creates its own temp state dir.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";

const sharedModulePath = path.resolve(
  process.cwd(),
  "e2e-tests/helpers/scripted-agent-runtime-shared.mjs",
);

function makeTempStateDir(): string {
  return tamanduaTempDir("scripted-shared-test-");
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Spawn a child process that imports the shared module and calls
 * nextWorkIndex `iterations` times, returning the indices as JSON.
 */
function spawnWorkIndexWorker(
  stateDir: string,
  key: string,
  iterations: number,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    // Inline script using dynamic import so the CWD is correct.
    const code = [
      `const { nextWorkIndex } = await import(${JSON.stringify(sharedModulePath)});`,
      `const stateDir = ${JSON.stringify(stateDir)};`,
      `const key = ${JSON.stringify(key)};`,
      `const results = [];`,
      `for (let i = 0; i < ${iterations}; i++) {`,
      `  results.push(nextWorkIndex(stateDir, key));`,
      `}`,
      `process.stdout.write(JSON.stringify(results));`,
    ].join("\n");

    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf-8",
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`Worker exited ${exitCode}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Failed to parse worker output: ${stdout}, stderr: ${stderr}`));
      }
    });
    child.on("error", reject);
  });
}

describe("scripted-agent-runtime-shared", () => {
  describe("substitute", () => {
    it("renders the current git tree for tester attestations", async () => {
      const mod = await import(sharedModulePath);
      const expectedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: process.cwd(),
        encoding: "utf-8",
      }).trim();

      assert.equal(
        mod.substitute("TESTED_TREE: {{gitTree}}", process.cwd(), {}),
        `TESTED_TREE: ${expectedTree}`,
      );
    });
  });

  describe("nextWorkIndex sequential (single-process)", () => {
    it("returns 0 on first call for a key", async () => {
      const stateDir = makeTempStateDir();
      try {
        const mod = await import(sharedModulePath);
        const idx = mod.nextWorkIndex(stateDir, "test-key");
        assert.equal(idx, 0, "first call should return 0");
      } finally {
        cleanup(stateDir);
      }
    });

    it("returns contiguous indices on repeated calls", async () => {
      const stateDir = makeTempStateDir();
      try {
        const mod = await import(sharedModulePath);
        for (let i = 0; i < 5; i++) {
          const idx = mod.nextWorkIndex(stateDir, "test-key");
          assert.equal(idx, i, `call ${i + 1} should return ${i}, got ${idx}`);
        }
      } finally {
        cleanup(stateDir);
      }
    });

    it("different keys have independent counters", async () => {
      const stateDir = makeTempStateDir();
      try {
        const mod = await import(sharedModulePath);
        const a = mod.nextWorkIndex(stateDir, "key-a");
        const b = mod.nextWorkIndex(stateDir, "key-b");
        assert.equal(a, 0, "key-a first call should return 0");
        assert.equal(b, 0, "key-b first call should return 0");
        const a2 = mod.nextWorkIndex(stateDir, "key-a");
        const b2 = mod.nextWorkIndex(stateDir, "key-b");
        assert.equal(a2, 1, "key-a second call should return 1");
        assert.equal(b2, 1, "key-b second call should return 1");
      } finally {
        cleanup(stateDir);
      }
    });
  });

  describe("nextWorkIndex concurrent (multi-process)", () => {
    it("two concurrent processes produce unique indices 0-7 with no duplicates", async () => {
      const stateDir = makeTempStateDir();
      try {
        // Launch two workers concurrently, each calling nextWorkIndex 4 times.
        const [results1, results2] = await Promise.all([
          spawnWorkIndexWorker(stateDir, "conc-key", 4),
          spawnWorkIndexWorker(stateDir, "conc-key", 4),
        ]);

        const all = [...results1, ...results2];
        all.sort((a, b) => a - b);

        // Should be exactly indices 0-7 without duplicates.
        assert.deepEqual(
          all,
          [0, 1, 2, 3, 4, 5, 6, 7],
          `concurrent workers should produce indices 0-7, got ${JSON.stringify(all)}`,
        );
      } finally {
        cleanup(stateDir);
      }
    });

    it("three concurrent processes produce unique indices 0-8", async () => {
      const stateDir = makeTempStateDir();
      try {
        const [r1, r2, r3] = await Promise.all([
          spawnWorkIndexWorker(stateDir, "triple-key", 3),
          spawnWorkIndexWorker(stateDir, "triple-key", 3),
          spawnWorkIndexWorker(stateDir, "triple-key", 3),
        ]);

        const all = [...r1, ...r2, ...r3];
        all.sort((a, b) => a - b);

        assert.deepEqual(
          all,
          [0, 1, 2, 3, 4, 5, 6, 7, 8],
          `three concurrent workers should produce indices 0-8, got ${JSON.stringify(all)}`,
        );
      } finally {
        cleanup(stateDir);
      }
    });
  });

  describe("lock cleanup", () => {
    it("removes lock directory after each increment", async () => {
      const stateDir = makeTempStateDir();
      try {
        const mod = await import(sharedModulePath);
        mod.nextWorkIndex(stateDir, "cleanup-key");

        // No .workcount.lock directory should remain.
        const lockDir = path.join(stateDir, "cleanup-key.workcount.lock");
        assert.ok(
          !fs.existsSync(lockDir),
          `lock directory should not exist after increment: ${lockDir}`,
        );
      } finally {
        cleanup(stateDir);
      }
    });

    it("no .lock files leaked after multiple increments", async () => {
      const stateDir = makeTempStateDir();
      try {
        const mod = await import(sharedModulePath);
        for (let i = 0; i < 10; i++) {
          mod.nextWorkIndex(stateDir, "no-leak-key");
        }

        // Check no .lock entries in stateDir.
        const entries = fs.readdirSync(stateDir);
        const lockEntries = entries.filter((e) => e.includes(".lock"));
        assert.equal(
          lockEntries.length,
          0,
          `no .lock entries should remain in stateDir, found: ${JSON.stringify(lockEntries)}`,
        );
      } finally {
        cleanup(stateDir);
      }
    });

    it("count file persists between increments", async () => {
      const stateDir = makeTempStateDir();
      try {
        const mod = await import(sharedModulePath);
        mod.nextWorkIndex(stateDir, "persist-key");
        mod.nextWorkIndex(stateDir, "persist-key");
        mod.nextWorkIndex(stateDir, "persist-key");

        const countFile = path.join(stateDir, "persist-key.workcount");
        assert.ok(fs.existsSync(countFile), "count file should persist");
        const count = parseInt(fs.readFileSync(countFile, "utf-8"), 10);
        assert.equal(count, 3, `count file should read 3, got ${count}`);
      } finally {
        cleanup(stateDir);
      }
    });
  });

  describe("backward compatibility", () => {
    it("single-process sequential calls still produce correct work indices", async () => {
      const stateDir = makeTempStateDir();
      try {
        const mod = await import(sharedModulePath);

        // Simulate a typical scripted workflow:
        // triager (idx 0), investigator (idx 1), implementer (idx 2),
        // reviewer (idx 3), verifier (idx 4), merger (idx 5)
        const roles = ["triager", "investigator", "implementer", "reviewer", "verifier", "merger"];
        for (let i = 0; i < roles.length; i++) {
          const idx = mod.nextWorkIndex(stateDir, roles[i]);
          assert.equal(idx, 0, `${roles[i]} first invocation should be 0, got ${idx}`);
        }

        // Second invocation for triager should be 1
        const triagerSecond = mod.nextWorkIndex(stateDir, "triager");
        assert.equal(triagerSecond, 1, "triager second invocation should be 1");
      } finally {
        cleanup(stateDir);
      }
    });

    it("existing single-run tests pass with the locked counter", async () => {
      const stateDir = makeTempStateDir();
      try {
        const mod = await import(sharedModulePath);

        // Same pattern as the real runtimes: call nextWorkIndex with
        // the short agent name as key.
        const keys = [
          "bug-fix-merge-worktree_triager",
          "bug-fix-merge-worktree_investigator",
          "bug-fix-merge-worktree_developer",
          "bug-fix-merge-worktree_reviewer",
          "bug-fix-merge-worktree_verifier",
          "bug-fix-merge-worktree_merger",
        ];

        for (let i = 0; i < keys.length; i++) {
          const idx = mod.nextWorkIndex(stateDir, keys[i]);
          assert.equal(idx, 0, `first call for ${keys[i]} should be 0, got ${idx}`);
        }

        // Each key should have its own independent counter
        for (const key of keys) {
          const idx = mod.nextWorkIndex(stateDir, key);
          assert.equal(idx, 1, `second call for ${key} should be 1, got ${idx}`);
        }
      } finally {
        cleanup(stateDir);
      }
    });
  });

  describe("other shared exports unmodified", () => {
    it("parseInputVars still works correctly", async () => {
      const mod = await import(sharedModulePath);
      const input = "REPO: /some/repo\nBRANCH: feature-branch\nCOMMITS: abc, def";
      const vars = mod.parseInputVars(input);
      assert.deepEqual(vars, {
        REPO: "/some/repo",
        BRANCH: "feature-branch",
        COMMITS: "abc, def",
      });
    });

    it("substitute still works correctly", async () => {
      const mod = await import(sharedModulePath);
      const input = "REPO: /some/repo\nBRANCH: feature-branch";
      const vars = mod.parseInputVars(input);
      const result = mod.substitute("cd {{input.REPO}} && git checkout {{input.BRANCH}}", "/workdir", vars);
      assert.equal(result, "cd /some/repo && git checkout feature-branch");
    });

    it("applyBehaviorActions returns command stdout for verbatim fixture reporting", async () => {
      const workdir = makeTempStateDir();
      try {
        const mod = await import(sharedModulePath);
        const result = mod.applyBehaviorActions(
          { commands: ["printf 'STATUS: landed\\nMERGED_TREE: abc123\\n'"] },
          workdir,
          {},
        );
        assert.equal(result.commandOutput, "STATUS: landed\nMERGED_TREE: abc123");
      } finally {
        cleanup(workdir);
      }
    });

    it("loadBehaviors returns defaults when file is missing", async () => {
      const mod = await import(sharedModulePath);
      const config = mod.loadBehaviors("/nonexistent/behaviors.json");
      assert.ok(config.agents, "should have agents key");
      assert.equal(config.heartbeatTokens, 17);
      assert.equal(config.defaultTokens, 111);
    });

    it("behaviorForInvocation consumes arrays correctly", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: { doer: ["first", "second", "third"] },
      };
      assert.equal(mod.behaviorForInvocation(config, "wf_doer", "doer", 0), "first");
      assert.equal(mod.behaviorForInvocation(config, "wf_doer", "doer", 1), "second");
      assert.equal(mod.behaviorForInvocation(config, "wf_doer", "doer", 2), "third");
      assert.equal(mod.behaviorForInvocation(config, "wf_doer", "doer", 3), "third"); // last repeats
    });
  });
});
