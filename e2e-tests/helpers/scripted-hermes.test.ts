/**
 * Unit tests for createScriptedHermes factory function.
 *
 * Tests verify:
 *   1. Factory creates executable wrapper script
 *   2. Returns correct env vars (TAMANDUA_HERMES_BINARY, HERMES_HOME,
 *      TAMANDUA_PI_BINARY=/usr/bin/false, TAMANDUA_SCRIPTED_BEHAVIORS,
 *      TAMANDUA_SCRIPTED_STATE)
 *   3. Wrapper script invokes the hermes runtime correctly
 *   4. Factory works with same ScriptedAgentConfig shape as createScriptedAgent
 *   5. readInvocations() works correctly
 *   6. workInvocations() and heartbeats() filtering
 *   7. describe() returns readable output
 *
 * Test isolation: uses temp dirs and mock tamandua CLI (same pattern as
 * scripted-hermes-runtime.test.ts). No real tamandua DB needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ScriptedAgentConfig } from "../../e2e-tests/helpers/scripted-agent.js";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";

// Dynamic import since the factory is ESM and tests use tsx
const { createScriptedHermes } = await import(
  "../../e2e-tests/helpers/scripted-hermes.js"
);

const MOCK_RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MOCK_STEP_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PREF_RUN_ID = `run-${MOCK_RUN_ID}`;
const PREF_STEP_ID = `step-${MOCK_STEP_ID}`;

interface TestDirs {
  tmp: string;
  mockCliPath: string;
}

function makeTempDirs(): TestDirs {
  const tmp = tamanduaTempDir("hermes-factory-test-");
  const mockCliPath = path.join(tmp, "mock-tamandua");
  return { tmp, mockCliPath };
}

function createMockCli(dir: string, opts?: { noWork?: boolean }): string {
  const mockPath = path.join(dir, "mock-tamandua");
  const journalPath = path.join(dir, "mock-cli-log.jsonl");

  const noWorkPeek = opts?.noWork ?? false;

  const lines: string[] = [
    "#!/usr/bin/env node",
    "var fs = require('fs');",
    "var journalPath = " + JSON.stringify(journalPath) + ";",
    "",
    "function log(entry) {",
    "  fs.appendFileSync(journalPath, JSON.stringify({ ts: new Date().toISOString() }));",
    "  var data = fs.readFileSync(journalPath, 'utf-8');",
    "  fs.writeFileSync(journalPath, data.slice(0, -1) + ',' + JSON.stringify(entry).slice(1) + '\\n');",
    "}",
    "",
    "var args = process.argv.slice(2);",
    "",
    "log({ cmd: args[0], agentId: args[1], args: args });",
    "",
    "if (args[0] === 'step' && args[1] === 'peek') {",
    noWorkPeek
      ? "  process.stdout.write('NO_WORK'); process.exit(0);"
      : "  process.stdout.write('HAS_WORK'); process.exit(0);",
    "} else if (args[0] === 'step' && args[1] === 'claim') {",
    "  process.stdout.write(JSON.stringify({",
    "    stepId: " + JSON.stringify(PREF_STEP_ID) + ",",
    "    runId: " + JSON.stringify(PREF_RUN_ID) + ",",
    "    input: 'MOCK_INPUT: canned input\\n',",
    "  }));",
    "  process.exit(0);",
    "} else if (args[0] === 'step' && args[1] === 'complete') {",
    "  log({ cmd: 'complete', stepId: args[2] });",
    "  process.exit(0);",
    "} else if (args[0] === 'step' && args[1] === 'fail') {",
    "  log({ cmd: 'fail', stepId: args[2], reason: args.slice(3).join(' ') });",
    "  process.exit(0);",
    "} else {",
    "  process.stderr.write('mock-tamandua: unknown command: ' + JSON.stringify(args));",
    "  process.exit(1);",
    "}",
    "",
  ];

  fs.writeFileSync(mockPath, lines.join("\n"), "utf-8");
  fs.chmodSync(mockPath, 0o755);
  return mockPath;
}

function spawnScriptedHermes(
  binPath: string,
  env: Record<string, string>,
  opts?: { timeoutMs?: number },
): ReturnType<typeof spawnSync> {
  const mockCliPath = env.TAMANDUA_SCRIPTED_MOCK_CLI ?? "";
  const prompt = [
    'workflow "test-wf", agent "test-wf_doer", run "' +
      PREF_RUN_ID +
      '"',
    "Task: do a thing",
    '"' +
      mockCliPath +
      '" step claim "test-wf_doer" --run-id "' +
      PREF_RUN_ID +
      '"',
  ].join("\n");

  return spawnSync(
    binPath,
    ["chat", "--max-turns", "8192", "--yolo", "-Q", "-q", prompt],
    {
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? os.tmpdir(),
        ...env,
      },
      timeout: opts?.timeoutMs ?? 10_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function cleanup(tmp: string) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

describe("createScriptedHermes", () => {
  const defaultConfig: ScriptedAgentConfig = {
    agents: { doer: { output: "STATUS: done\nREPO: /fake/repo" } },
    defaultTokens: 111,
  };

  // ── Factory contract: env vars ─────────────────────────────────────

  describe("factory contract", () => {
    it("returns binPath that is an executable file", () => {
      const dirs = makeTempDirs();
      try {
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);

        assert.ok(
          fs.existsSync(agent.binPath),
          `binPath should exist: ${agent.binPath}`,
        );

        // Should be executable (owner exec bit)
        const stat = fs.statSync(agent.binPath);
        // On Unix: stat.mode & 0o111 (any exec)
        assert.ok(
          (stat.mode & 0o111) !== 0,
          "binPath should be executable",
        );

        // Verify it's a shell script that references the hermes runtime
        const content = fs.readFileSync(agent.binPath, "utf-8");
        assert.ok(
          content.includes("scripted-hermes-runtime.mjs"),
          "wrapper script should reference the hermes runtime",
        );
        assert.ok(
          content.startsWith("#!/usr/bin/env bash"),
          "wrapper script should be a bash script",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("returns correct env vars", () => {
      const dirs = makeTempDirs();
      try {
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);

        assert.ok(
          typeof agent.env.TAMANDUA_HERMES_BINARY === "string",
          "should have TAMANDUA_HERMES_BINARY",
        );
        assert.equal(
          agent.env.TAMANDUA_HERMES_BINARY,
          agent.binPath,
          "TAMANDUA_HERMES_BINARY should equal binPath",
        );

        assert.ok(
          typeof agent.env.HERMES_HOME === "string",
          "should have HERMES_HOME",
        );
        assert.ok(
          fs.statSync(agent.env.HERMES_HOME).isDirectory(),
          "HERMES_HOME should be a directory",
        );

        assert.equal(
          agent.env.TAMANDUA_PI_BINARY,
          "/usr/bin/false",
          "TAMANDUA_PI_BINARY should be /usr/bin/false",
        );

        assert.ok(
          typeof agent.env.TAMANDUA_SCRIPTED_BEHAVIORS === "string",
          "should have TAMANDUA_SCRIPTED_BEHAVIORS",
        );
        assert.ok(
          fs.existsSync(agent.env.TAMANDUA_SCRIPTED_BEHAVIORS),
          "behaviors file should exist",
        );

        assert.ok(
          typeof agent.env.TAMANDUA_SCRIPTED_STATE === "string",
          "should have TAMANDUA_SCRIPTED_STATE",
        );
        assert.ok(
          fs.statSync(agent.env.TAMANDUA_SCRIPTED_STATE).isDirectory(),
          "state dir should exist",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("creates HERMES_HOME without state.db (runtime creates it)", () => {
      const dirs = makeTempDirs();
      try {
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);
        const dbPath = path.join(agent.env.HERMES_HOME, "state.db");

        assert.ok(
          !fs.existsSync(dbPath),
          "state.db should not exist before runtime invocation",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("writes behaviors.json with the config", () => {
      const dirs = makeTempDirs();
      try {
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);

        const behaviors = JSON.parse(
          fs.readFileSync(agent.env.TAMANDUA_SCRIPTED_BEHAVIORS, "utf-8"),
        );
        assert.deepStrictEqual(
          behaviors.agents.doer,
          defaultConfig.agents.doer,
          "behaviors should match config",
        );
        assert.equal(
          behaviors.defaultTokens,
          111,
          "defaultTokens should be preserved",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("has proper stateDir", () => {
      const dirs = makeTempDirs();
      try {
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);

        assert.ok(
          typeof agent.stateDir === "string",
          "should return stateDir",
        );
        assert.ok(
          fs.statSync(agent.stateDir).isDirectory(),
          "stateDir should exist",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── Wrapper script execution ───────────────────────────────────────

  describe("wrapper script execution", () => {
    it("invokes the hermes runtime and produces plain-text output", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);

        const mockCliPath = path.join(dirs.tmp, "mock-tamandua");
        const result = spawnScriptedHermes(agent.binPath, {
          ...agent.env,
          HERMES_HOME: agent.env.HERMES_HOME,
          TAMANDUA_SCRIPTED_STATE: agent.env.TAMANDUA_SCRIPTED_STATE,
          TAMANDUA_SCRIPTED_MOCK_CLI: mockCliPath,
          PATH:
            path.dirname(mockCliPath) +
            ":" +
            (process.env.PATH ?? ""),
        });

        assert.equal(result.status, 0, `should exit 0, got ${result.status}, stderr: ${result.stderr}`);
        const stdout = result.stdout.trim();

        // Should contain plain text output (STATUS report)
        assert.ok(
          stdout.includes("STATUS: done"),
          `should contain STATUS: done, got: "${stdout}"`,
        );

        // Should contain session_id trailer on stderr
        const stderr = result.stderr.trim();
        assert.ok(
          /^session_id:/.test(stderr),
          `stderr should contain session_id trailer, got: "${stderr}"`,
        );

        // Should NOT contain JSON events (hermes output is plain text)
        assert.ok(
          !stdout.includes('"type":"tool_execution_end"'),
          "should not emit pi JSON events",
        );
        assert.ok(
          !stdout.includes('"type":"message_end"'),
          "should not emit pi JSON events",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("creates state.db after execution", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);

        const mockCliPath = path.join(dirs.tmp, "mock-tamandua");
        spawnScriptedHermes(agent.binPath, {
          ...agent.env,
          HERMES_HOME: agent.env.HERMES_HOME,
          TAMANDUA_SCRIPTED_STATE: agent.env.TAMANDUA_SCRIPTED_STATE,
          TAMANDUA_SCRIPTED_MOCK_CLI: mockCliPath,
          PATH:
            path.dirname(mockCliPath) +
            ":" +
            (process.env.PATH ?? ""),
        });

        const dbPath = path.join(agent.env.HERMES_HOME, "state.db");
        assert.ok(
          fs.existsSync(dbPath),
          "state.db should exist after runtime invocation",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("can handle multiple invocations", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        const agent = createScriptedHermes(dirs.tmp, {
          agents: {
            doer: [
              { output: "STATUS: done\nROUND: 1" },
              { output: "STATUS: done\nROUND: 2" },
              { output: "STATUS: done\nROUND: 3" },
            ],
          },
          defaultTokens: 111,
        });

        const mockCliPath = path.join(dirs.tmp, "mock-tamandua");
        const env = {
          ...agent.env,
          HERMES_HOME: agent.env.HERMES_HOME,
          TAMANDUA_SCRIPTED_STATE: agent.env.TAMANDUA_SCRIPTED_STATE,
          TAMANDUA_SCRIPTED_MOCK_CLI: mockCliPath,
          PATH:
            path.dirname(mockCliPath) +
            ":" +
            (process.env.PATH ?? ""),
        };

        for (let i = 0; i < 3; i++) {
          const result = spawnScriptedHermes(agent.binPath, env);
          assert.equal(result.status, 0, `invocation ${i + 1} should exit 0, got ${result.status}, stderr: ${result.stderr}`);
          assert.ok(
            result.stdout.includes(`ROUND: ${i + 1}`),
            `invocation ${i + 1} should use behavior ${i + 1}`,
          );
        }

        // All 3 work invocations logged
        const workEntries = agent.workInvocations();
        assert.equal(
          workEntries.length,
          3,
          `should have 3 work invocations, got ${workEntries.length}`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── readInvocations / workInvocations / heartbeats ─────────────────

  describe("invocation journal", () => {
    it("readInvocations returns empty array when no invocations yet", () => {
      const dirs = makeTempDirs();
      try {
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);

        const entries = agent.readInvocations();
        assert.deepStrictEqual(
          entries,
          [],
          "should return empty array when no invocations",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("workInvocations filters by shortAgent", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        const agent = createScriptedHermes(dirs.tmp, {
          agents: {
            doer: { output: "STATUS: done" },
            reviewer: { output: "STATUS: done" },
          },
        });

        // Spawn with "doer" agent
        const mockCliPath = path.join(dirs.tmp, "mock-tamandua");
        const promptDoer = [
          'workflow "test-wf", agent "test-wf_doer", run "' +
            PREF_RUN_ID +
            '"',
          "Task: do a thing",
          '"' +
            mockCliPath +
            '" step claim "test-wf_doer" --run-id "' +
            PREF_RUN_ID +
            '"',
        ].join("\n");

        spawnSync(
          agent.binPath,
          [
            "chat",
            "--max-turns",
            "8192",
            "--yolo",
            "-Q",
            "-q",
            promptDoer,
          ],
          {
            encoding: "utf-8",
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? os.tmpdir(),
              ...agent.env,
              TAMANDUA_SCRIPTED_STATE: agent.env.TAMANDUA_SCRIPTED_STATE,
              PATH:
                path.dirname(mockCliPath) +
                ":" +
                (process.env.PATH ?? ""),
            },
            timeout: 10_000,
            maxBuffer: 16 * 1024 * 1024,
          },
        );

        const allWork = agent.workInvocations();
        assert.equal(
          allWork.length,
          1,
          `should have 1 work invocation, got ${allWork.length}`,
        );
        assert.equal(allWork[0].shortAgent, "doer");

        const doerWork = agent.workInvocations("doer");
        assert.equal(doerWork.length, 1);

        const reviewerWork = agent.workInvocations("reviewer");
        assert.equal(
          reviewerWork.length,
          0,
          "reviewer should have no work yet",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("heartbeats returns only heartbeat-phase entries", () => {
      const dirs = makeTempDirs();
      try {
        // Uses noWork=true → peek returns NO_WORK → heartbeat phase
        createMockCli(dirs.tmp, { noWork: true });
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);

        const mockCliPath = path.join(dirs.tmp, "mock-tamandua");
        spawnScriptedHermes(agent.binPath, {
          ...agent.env,
          HERMES_HOME: agent.env.HERMES_HOME,
          TAMANDUA_SCRIPTED_STATE: agent.env.TAMANDUA_SCRIPTED_STATE,
          TAMANDUA_SCRIPTED_MOCK_CLI: mockCliPath,
          PATH:
            path.dirname(mockCliPath) +
            ":" +
            (process.env.PATH ?? ""),
        });

        const heartbeats = agent.heartbeats();
        assert.ok(
          heartbeats.length >= 1,
          `should have at least 1 heartbeat, got ${heartbeats.length}`,
        );
        assert.equal(heartbeats[0].phase, "heartbeat");

        // No work phase entries (peek returned NO_WORK)
        const workEntries = agent.workInvocations();
        assert.equal(workEntries.length, 0, "should have 0 work invocations");
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── describe() output ──────────────────────────────────────────────

  describe("describe()", () => {
    it("returns placeholder when no invocations", () => {
      const dirs = makeTempDirs();
      try {
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);

        const desc = agent.describe();
        assert.ok(
          desc.includes("no scripted-hermes invocations recorded"),
          `should return empty placeholder, got: "${desc}"`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("returns readable summary after invocations", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        const agent = createScriptedHermes(dirs.tmp, defaultConfig);

        const mockCliPath = path.join(dirs.tmp, "mock-tamandua");
        spawnScriptedHermes(agent.binPath, {
          ...agent.env,
          HERMES_HOME: agent.env.HERMES_HOME,
          TAMANDUA_SCRIPTED_STATE: agent.env.TAMANDUA_SCRIPTED_STATE,
          TAMANDUA_SCRIPTED_MOCK_CLI: mockCliPath,
          PATH:
            path.dirname(mockCliPath) +
            ":" +
            (process.env.PATH ?? ""),
        });

        const desc = agent.describe();
        assert.ok(desc.length > 0, "should return non-empty description");
        assert.ok(
          desc.includes("agent=doer"),
          "should mention the agent",
        );
        assert.ok(
          desc.includes("note="),
          "should include work/result activity",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── Config shape compatibility ─────────────────────────────────────

  describe("config shape compatibility", () => {
    it("works with same ScriptedAgentConfig as createScriptedAgent", () => {
      const dirs = makeTempDirs();
      try {
        // A config that could be passed to either factory
        const config: ScriptedAgentConfig = {
          agents: {
            fixer: {
              mode: "work",
              output: "STATUS: done\nCHANGES: fixed things",
              tokens: 111,
            },
            verifier: [
              {
                mode: "work",
                output: "STATUS: done\nVERIFIED",
              },
              {
                mode: "no-status",
                output: "I checked but forgot to report",
              },
            ],
          },
          heartbeatTokens: 17,
          defaultTokens: 111,
        };

        const agent = createScriptedHermes(dirs.tmp, config);

        assert.ok(agent.binPath, "should create with multi-agent config");
        assert.equal(
          agent.env.TAMANDUA_PI_BINARY,
          "/usr/bin/false",
          "should still set TAMANDUA_PI_BINARY=/usr/bin/false",
        );

        // Behaviors file should reflect full config
        const behaviors = JSON.parse(
          fs.readFileSync(agent.env.TAMANDUA_SCRIPTED_BEHAVIORS, "utf-8"),
        );
        assert.ok(behaviors.agents.fixer, "should have fixer agent");
        assert.ok(behaviors.agents.verifier, "should have verifier agent");
        assert.equal(behaviors.heartbeatTokens, 17);
        assert.equal(behaviors.defaultTokens, 111);
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── Shared stateDir between pi and hermes ──────────────────────────

  describe("shared state dir", () => {
    it("both pi and hermes can share the same stateDir for invocations", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);

        // Create hermes agent first
        const hermesAgent = createScriptedHermes(dirs.tmp, defaultConfig);

        // Set up a second factory pointing at the same stateDir
        // (not using createScriptedAgent directly to avoid importing pi runtime,
        // but the interface is the same)
        const mockCliPath = path.join(dirs.tmp, "mock-tamandua");
        spawnScriptedHermes(hermesAgent.binPath, {
          ...hermesAgent.env,
          HERMES_HOME: hermesAgent.env.HERMES_HOME,
          TAMANDUA_SCRIPTED_STATE: hermesAgent.env.TAMANDUA_SCRIPTED_STATE,
          PATH:
            path.dirname(mockCliPath) +
            ":" +
            (process.env.PATH ?? ""),
        });

        // Verify invocations exist
        const entries = hermesAgent.readInvocations();
        assert.ok(entries.length >= 1, `should have at least 1 entry, got ${entries.length}`);

        // Second spawn writes to same journal
        spawnScriptedHermes(hermesAgent.binPath, {
          ...hermesAgent.env,
          HERMES_HOME: hermesAgent.env.HERMES_HOME,
          TAMANDUA_SCRIPTED_STATE: hermesAgent.env.TAMANDUA_SCRIPTED_STATE,
          PATH:
            path.dirname(mockCliPath) +
            ":" +
            (process.env.PATH ?? ""),
        });

        const updatedEntries = hermesAgent.readInvocations();
        assert.ok(
          updatedEntries.length >= entries.length + 1,
          `should have more entries after second spawn: ${updatedEntries.length} >= ${entries.length + 1}`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });
});
