/**
 * Unit tests for US-003: behaviors file format with full workflowId_agentId
 * keys and shared counters.
 *
 * Verifies:
 *  1. Full workflowId_agentId key lookup (e.g. "bfmw-w414_planner")
 *  2. Short agent ID fallback for backward compatibility
 *  3. Full-key priority over short-key when both exist
 *  4. Per-key counters increment atomically via file-based mutex
 *  5. Concurrent processes with different workflowId_agentId keys get
 *     independent counters
 *
 * This file uses node:child_process (spawn) for concurrent tests and
 * therefore belongs in the serial test lane.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";

const sharedModulePath = path.resolve(
  process.cwd(),
  "torture-test/scripted-runtimes/runtime-shared.mjs",
);

function makeTempDir(): string {
  return tamanduaTempDir("scripted-behaviors-test-");
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Spawn a worker that calls nextWorkIndex `iterations` times for `key`,
 * returning the indices as JSON. Used to verify concurrent processes
 * get unique, non-overlapping work indices.
 */
function spawnWorkIndexWorker(
  stateDir: string,
  key: string,
  iterations: number,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
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
        reject(
          new Error(
            `Failed to parse worker output: ${stdout}, stderr: ${stderr}`,
          ),
        );
      }
    });
    child.on("error", reject);
  });
}

describe("scripted-runtime-behaviors (US-003)", () => {
  describe("behaviorForInvocation — full workflowId_agentId key", () => {
    it("looks up behavior by full workflowId_agentId key", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: { "bfmw-w414_planner": "plan-behavior" },
      };
      const result = mod.behaviorForInvocation(
        config,
        "bfmw-w414_planner",
        "planner",
        0,
      );
      assert.equal(
        result,
        "plan-behavior",
        "should find behavior by full workflowId_agentId key",
      );
    });

    it("looks up behavior array by full workflowId_agentId key", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: {
          "bfmw-w414_fixer": ["fix-first", "fix-second", "fix-third"],
        },
      };
      assert.equal(
        mod.behaviorForInvocation(config, "bfmw-w414_fixer", "fixer", 0),
        "fix-first",
      );
      assert.equal(
        mod.behaviorForInvocation(config, "bfmw-w414_fixer", "fixer", 1),
        "fix-second",
      );
      assert.equal(
        mod.behaviorForInvocation(config, "bfmw-w414_fixer", "fixer", 2),
        "fix-third",
      );
      assert.equal(
        mod.behaviorForInvocation(config, "bfmw-w414_fixer", "fixer", 3),
        "fix-third",
        "last entry repeats",
      );
    });

    it("handles underscore-separated workflow IDs in agentId", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: {
          "feature-dev-merge-worktree_developer": "feature-dev-behavior",
        },
      };
      const result = mod.behaviorForInvocation(
        config,
        "feature-dev-merge-worktree_developer",
        "developer",
        0,
      );
      assert.equal(
        result,
        "feature-dev-behavior",
        "should handle multi-segment workflow IDs (e.g. feature-dev-merge-worktree)",
      );
    });

    it("returns undefined for unknown full key", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: { "known-wf_known-agent": "some-behavior" },
      };
      const result = mod.behaviorForInvocation(
        config,
        "unknown-wf_unknown-agent",
        "unknown-agent",
        0,
      );
      assert.equal(result, undefined, "unknown full key should return undefined");
    });
  });

  describe("behaviorForInvocation — short agent ID fallback", () => {
    it("falls back to short agent ID when full key not found", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: { planner: "legacy-planner-behavior" },
      };
      // Look up with a full key that isn't in the config
      const result = mod.behaviorForInvocation(
        config,
        "bfmw-w414_planner",
        "planner",
        0,
      );
      assert.equal(
        result,
        "legacy-planner-behavior",
        "should fall back to short agent ID when full key not found",
      );
    });

    it("falls back for array behaviors keyed by short agent ID", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: {
          developer: ["dev-round-1", "dev-round-2"],
        },
      };
      assert.equal(
        mod.behaviorForInvocation(
          config,
          "feature-dev-merge-worktree_developer",
          "developer",
          0,
        ),
        "dev-round-1",
        "index 0 should use short-agent fallback",
      );
      assert.equal(
        mod.behaviorForInvocation(
          config,
          "feature-dev-merge-worktree_developer",
          "developer",
          1,
        ),
        "dev-round-2",
        "index 1 should use short-agent fallback",
      );
    });

    it("returns undefined when neither full key nor short key exists", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: { planner: "only-planner" },
      };
      const result = mod.behaviorForInvocation(
        config,
        "wf_nonexistent",
        "nonexistent",
        0,
      );
      assert.equal(
        result,
        undefined,
        "should return undefined when neither key exists",
      );
    });
  });

  describe("behaviorForInvocation — full-key priority over short-key", () => {
    it("full key takes priority when both exist", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: {
          "scenario-a_feature-dev-merge-worktree_developer":
            "scenario-a-specific-behavior",
          developer: "generic-developer-behavior",
        },
      };
      const result = mod.behaviorForInvocation(
        config,
        "scenario-a_feature-dev-merge-worktree_developer",
        "developer",
        0,
      );
      assert.equal(
        result,
        "scenario-a-specific-behavior",
        "full key should take priority over short key",
      );
    });

    it("full key wins even when short key has array", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: {
          "w414_verifier": "w414-verifier-single",
          verifier: ["v1", "v2", "v3"],
        },
      };
      const result = mod.behaviorForInvocation(
        config,
        "w414_verifier",
        "verifier",
        0,
      );
      assert.equal(
        result,
        "w414-verifier-single",
        "full key should take priority, array vs single value",
      );
    });

    it("scenario-unique workflow copies get their own behaviors via full keys", async () => {
      const mod = await import(sharedModulePath);
      const config = {
        agents: {
          "bfmw-w414_planner": "scenario-414-planner",
          "bfmw-w415_planner": "scenario-415-planner",
        },
      };
      assert.equal(
        mod.behaviorForInvocation(config, "bfmw-w414_planner", "planner", 0),
        "scenario-414-planner",
        "scenario 414 should get its own planner behavior",
      );
      assert.equal(
        mod.behaviorForInvocation(config, "bfmw-w415_planner", "planner", 0),
        "scenario-415-planner",
        "scenario 415 should get its own planner behavior",
      );
    });
  });

  describe("loadBehaviors — file format with full keys", () => {
    it("loads behaviors file with full workflowId_agentId keys", async () => {
      const mod = await import(sharedModulePath);
      const tmp = makeTempDir();
      const behaviorsFile = path.join(tmp, "behaviors.json");
      try {
        const config = {
          agents: {
            "bfmw-w414_planner": "plan-414",
            "bfmw-w414_developer": ["dev-1", "dev-2"],
            "bfmw-w415_planner": "plan-415",
          },
          heartbeatTokens: 50,
          defaultTokens: 200,
        };
        fs.writeFileSync(behaviorsFile, JSON.stringify(config), "utf-8");

        const loaded = mod.loadBehaviors(behaviorsFile);
        assert.deepEqual(
          loaded.agents,
          config.agents,
          "should load full workflowId_agentId keys",
        );
        assert.equal(loaded.heartbeatTokens, 50);
        assert.equal(loaded.defaultTokens, 200);
      } finally {
        cleanup(tmp);
      }
    });

    it("loadBehaviors returns defaults when file missing (no crash)", async () => {
      const mod = await import(sharedModulePath);
      const config = mod.loadBehaviors("/nonexistent/path/behaviors.json");
      assert.deepEqual(config.agents, {}, "should default to empty agents");
      assert.equal(config.heartbeatTokens, 17);
      assert.equal(config.defaultTokens, 111);
    });

    it("loadBehaviors handles empty agents map", async () => {
      const mod = await import(sharedModulePath);
      const tmp = makeTempDir();
      const behaviorsFile = path.join(tmp, "empty-behaviors.json");
      try {
        fs.writeFileSync(
          behaviorsFile,
          JSON.stringify({ agents: {}, heartbeatTokens: 99 }),
          "utf-8",
        );
        const loaded = mod.loadBehaviors(behaviorsFile);
        assert.deepEqual(loaded.agents, {}, "empty agents map should load");
        assert.equal(loaded.heartbeatTokens, 99);
      } finally {
        cleanup(tmp);
      }
    });
  });

  describe("nextWorkIndex — full workflowId_agentId counter keys", () => {
    it("uses full workflowId_agentId as counter key", async () => {
      const mod = await import(sharedModulePath);
      const stateDir = makeTempDir();
      try {
        // Full key: "bfmw-w414_planner"
        const idx0 = mod.nextWorkIndex(stateDir, "bfmw-w414_planner");
        assert.equal(idx0, 0, "first call with full key should return 0");
        const idx1 = mod.nextWorkIndex(stateDir, "bfmw-w414_planner");
        assert.equal(idx1, 1, "second call with full key should return 1");
      } finally {
        cleanup(stateDir);
      }
    });

    it("different full workflowId_agentId keys have independent counters", async () => {
      const mod = await import(sharedModulePath);
      const stateDir = makeTempDir();
      try {
        assert.equal(
          mod.nextWorkIndex(stateDir, "bfmw-w414_planner"),
          0,
          "scenario 414 planner should start at 0",
        );
        assert.equal(
          mod.nextWorkIndex(stateDir, "bfmw-w415_planner"),
          0,
          "scenario 415 planner should start at 0 (independent counter)",
        );
        assert.equal(
          mod.nextWorkIndex(stateDir, "bfmw-w414_planner"),
          1,
          "scenario 414 planner second call should be 1",
        );
        assert.equal(
          mod.nextWorkIndex(stateDir, "bfmw-w415_planner"),
          1,
          "scenario 415 planner second call should be 1",
        );
      } finally {
        cleanup(stateDir);
      }
    });

    it("full key counters use the mkdirSync mutex", async () => {
      const mod = await import(sharedModulePath);
      const stateDir = makeTempDir();
      try {
        mod.nextWorkIndex(stateDir, "scenario-a_developer");
        // Verify no .lock directory remains
        const lockDir = path.join(stateDir, "scenario-a_developer.workcount.lock");
        assert.ok(
          !fs.existsSync(lockDir),
          "lock directory should be cleaned up after increment",
        );
        // Verify count file exists with correct key name
        const countFile = path.join(stateDir, "scenario-a_developer.workcount");
        assert.ok(
          fs.existsSync(countFile),
          "count file should persist with full key name",
        );
      } finally {
        cleanup(stateDir);
      }
    });
  });

  describe("concurrent process isolation with full keys", () => {
    it("two concurrent processes with different full keys get independent work indices", async () => {
      const stateDir = makeTempDir();
      try {
        // Each worker uses a DIFFERENT full key. This simulates
        // scenario-unique workflow copies running concurrently —
        // neither should interfere with the other's work index.
        const [resultsA, resultsB] = await Promise.all([
          spawnWorkIndexWorker(stateDir, "scenario-a_developer", 3),
          spawnWorkIndexWorker(stateDir, "scenario-b_developer", 3),
        ]);

        // Each worker should independently get [0, 1, 2] since keys differ.
        resultsA.sort((a, b) => a - b);
        resultsB.sort((a, b) => a - b);

        assert.deepEqual(
          resultsA,
          [0, 1, 2],
          `scenario-a_developer should get [0,1,2], got ${JSON.stringify(resultsA)}`,
        );
        assert.deepEqual(
          resultsB,
          [0, 1, 2],
          `scenario-b_developer should get [0,1,2], got ${JSON.stringify(resultsB)}`,
        );
      } finally {
        cleanup(stateDir);
      }
    });

    it("two concurrent processes with same full key get unique indices (shared counter)", async () => {
      const stateDir = makeTempDir();
      try {
        // Same key — counter is SHARED, each worker should get unique indices.
        const [results1, results2] = await Promise.all([
          spawnWorkIndexWorker(stateDir, "shared-wf_agent", 4),
          spawnWorkIndexWorker(stateDir, "shared-wf_agent", 4),
        ]);

        const all = [...results1, ...results2];
        all.sort((a, b) => a - b);

        assert.deepEqual(
          all,
          [0, 1, 2, 3, 4, 5, 6, 7],
          `shared key workers should produce indices 0-7, got ${JSON.stringify(all)}`,
        );
      } finally {
        cleanup(stateDir);
      }
    });
  });
});
