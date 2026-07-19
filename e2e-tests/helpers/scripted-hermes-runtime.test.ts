/**
 * Unit tests for scripted-hermes-runtime.mjs.
 *
 * These tests spawn the hermes runtime as a standalone process (simulating
 * how the hermes harness adapter invokes it) and verify:
 *   1. Plain-text output (no JSON events)
 *   2. session_id trailer with valid UUID
 *   3. state.db creation with sessions table and correct token rows
 *   4. All chaos modes (work, hang, die-before-claim, die-after-claim, no-status, garbage)
 *   5. Behavior consumption and work protocol
 *
 * Test isolation: each test creates its own temp dirs with a mock tamandua
 * CLI that returns canned responses, so no real tamandua DB is needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openE2eDatabase } from "./e2e-database.mjs";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";

const runtimePath = path.resolve(
  process.cwd(),
  "e2e-tests/helpers/scripted-hermes-runtime.mjs",
);

const MOCK_RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MOCK_STEP_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PREF_RUN_ID = `run-${MOCK_RUN_ID}`;
const PREF_STEP_ID = `step-${MOCK_STEP_ID}`;

interface TestDirs {
  tmp: string;
  stateDir: string;
  hermesHome: string;
  behaviorsPath: string;
  mockCliPath: string;
}

function makeTempDirs(): TestDirs {
  const tmp = tamanduaTempDir("hermes-runtime-test-");
  const stateDir = path.join(tmp, "scripted-state");
  const hermesHome = path.join(tmp, "hermes-home");
  const behaviorsPath = path.join(tmp, "behaviors.json");
  const mockCliPath = path.join(tmp, "mock-tamandua");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(hermesHome, { recursive: true });
  return { tmp, stateDir, hermesHome, behaviorsPath, mockCliPath };
}

function writeBehaviors(behaviorsPath: string, config: Record<string, unknown>) {
  fs.writeFileSync(behaviorsPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Create a mock tamandua CLI that returns canned, deterministic responses.
 *
 * step peek → prints "HAS_WORK" (or "NO_WORK")
 * step claim → prints JSON stepId/runId/input
 * step complete → exits 0
 * step fail → exits 0
 */
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
    "  // append the rest — hacky but avoids Object.assign polyfill",
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

function spawnHermes(
  mockCliPath: string,
  env: Record<string, string>,
  opts?: { timeoutMs?: number },
): ReturnType<typeof spawnSync> {
  const prefRunId = PREF_RUN_ID;
  const prompt = [
    'workflow "test-wf", agent "test-wf_doer", run "' + prefRunId + '"',
    "Task: do a thing",
    '"' + mockCliPath + '" step claim "test-wf_doer" --run-id "' + prefRunId + '"',
  ].join("\n");

  return spawnSync(
    process.execPath,
    [
      runtimePath,
      "chat",
      "--max-turns",
      "8192",
      "--yolo",
      "-Q",
      "-q",
      prompt,
    ],
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

function readStateDb(dbPath: string): Array<Record<string, unknown>> {
  const db = openE2eDatabase(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM sessions").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function readInvocations(invocationsPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(invocationsPath)) return [];
  return fs
    .readFileSync(invocationsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function cleanup(tmp: string) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

describe("scripted-hermes-runtime", () => {
  // ── Output format tests ───────────────────────────────────────────

  describe("output format", () => {
    it("emits plain text stdout with session_id trailer (no JSON)", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done\nREPO: /fake/repo" } },
        });

        const result = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();
        assert.ok(stdout.length > 0, `hermes runtime should produce stdout, stderr: ${result.stderr}`);

        // Should NOT contain JSON events
        assert.ok(
          !stdout.includes('"type":"tool_execution_end"'),
          "hermes runtime should NOT emit JSON tool_execution_end events",
        );
        assert.ok(
          !stdout.includes('"type":"message_end"'),
          "hermes runtime should NOT emit JSON message_end events",
        );

        // The session_id trailer should be on stderr (real hermes contract)
        assert.ok(
          /^session_id:\s+[0-9a-f-]{36}$/.test(stderr),
          `stderr should contain session_id: <uuid>, got: "${stderr}"`,
        );

        // STATUS report text should be on stdout (clean, no session_id)
        assert.ok(
          stdout.includes("STATUS: done"),
          `stdout should contain STATUS report, got: "${stdout}"`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("generates unique session IDs per invocation", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done" } },
        });

        const results: string[] = [];
        for (let i = 0; i < 3; i++) {
          const r = spawnHermes(dirs.mockCliPath, {
            HERMES_HOME: dirs.hermesHome,
            TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
            TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
          });
          const stderrTrimmed = r.stderr.trim();
          const match = /^session_id:\s*([0-9a-f-]{36})$/.exec(stderrTrimmed);
          results.push(match?.[1] ?? "");
        }

        const unique = new Set(results);
        assert.equal(
          unique.size,
          3,
          `3 invocations should produce 3 unique session IDs, got: ${JSON.stringify(results)}`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("handles multi-line output text with trailing session_id", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: {
            doer: {
              output: [
                "STATUS: done",
                "REPO: /fake/repo",
                "BRANCH: fake-branch",
                "COMMITS: abc123, def456",
                "CHANGES: Multi-line report",
              ].join("\n"),
            },
          },
        });

        const result = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();

        assert.ok(stdout.length > 0, `should have stdout content, got: "${stdout}"`);
        assert.ok(
          stdout.includes("REPO:"),
          "should contain REPO line on stdout",
        );
        assert.ok(
          stdout.includes("BRANCH:"),
          "should contain BRANCH line on stdout",
        );

        // session_id trailer should be on stderr
        assert.ok(
          /^session_id:/.test(stderr),
          `session_id should be on stderr, got: "${stderr}"`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── state.db tests ─────────────────────────────────────────────────

  describe("state.db", () => {
    it("creates state.db with sessions table and correct token row", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done", tokens: 111 } },
        });

        spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const dbPath = path.join(dirs.hermesHome, "state.db");
        assert.ok(fs.existsSync(dbPath), `state.db should exist at ${dbPath}`);

        const rows = readStateDb(dbPath);
        assert.equal(rows.length, 1, "should have exactly 1 session row");

        const row = rows[0] as Record<string, unknown>;
        assert.ok(typeof row.id === "string" && row.id.length > 0, "session should have an id");
        assert.equal(row.source, "scripted-hermes");
        assert.ok(typeof row.started_at === "number", "started_at should be a number");
        assert.equal(row.input_tokens, 100, `input_tokens should be 100 (111 - 11), got ${row.input_tokens}`);
        assert.equal(row.output_tokens, 11, `output_tokens should be 11, got ${row.output_tokens}`);
        assert.equal(row.cache_read_tokens, 0);
        assert.equal(row.cache_write_tokens, 0);
        assert.equal(row.reasoning_tokens, 0);
        assert.ok(typeof row.estimated_cost_usd === "number");
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("creates sessions table with all required columns", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done" } },
        });

        spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const dbPath = path.join(dirs.hermesHome, "state.db");
        const db = openE2eDatabase(dbPath, { readOnly: true });
        try {
          const columns = (
            db
              .prepare("SELECT name FROM pragma_table_info('sessions')")
              .all() as Array<{ name: string }>
          ).map((c) => c.name);

          const required = [
            "id",
            "source",
            "started_at",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "reasoning_tokens",
            "estimated_cost_usd",
          ];
          for (const col of required) {
            assert.ok(
              columns.includes(col),
              `sessions table should have column "${col}", got: ${columns.join(", ")}`,
            );
          }
        } finally {
          db.close();
        }
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("degradation: missing HERMES_HOME — still produces valid output", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done" } },
        });

        const result = spawnHermes(dirs.mockCliPath, {
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const stdout = result.stdout.trim();
        assert.ok(
          stdout.includes("STATUS: done"),
          `should produce STATUS output even without HERMES_HOME, stderr: ${result.stderr}`,
        );
        assert.ok(
          /session_id:/.test(result.stderr),
          "should still emit session_id trailer on stderr",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("degradation: non-writeable HERMES_HOME — still produces valid output", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done" } },
        });

        const nonWriteable = path.join(dirs.tmp, "readonly-hermes");
        fs.mkdirSync(nonWriteable, { mode: 0o555 });

        const result = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: nonWriteable,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const stdout = result.stdout.trim();
        assert.ok(
          stdout.includes("STATUS: done"),
          `should produce STATUS output even with non-writeable HERMES_HOME, stderr: ${result.stderr}`,
        );
        assert.ok(
          /session_id:/.test(result.stderr),
          "should still emit session_id trailer on stderr",
        );

        const dbPath = path.join(nonWriteable, "state.db");
        assert.ok(!fs.existsSync(dbPath), "state.db should not exist in non-writeable dir");
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── Chaos mode tests ───────────────────────────────────────────────

  describe("chaos modes", () => {
    it("mode=garbage: emits non-JSON garbage with session_id trailer", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { mode: "garbage", output: "anything" } },
        });

        const result = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const stdout = result.stdout.trim();
        assert.ok(
          stdout.includes("%%% not plain text"),
          `garbage mode should emit scripted garbage text, got: "${stdout}", stderr: ${result.stderr}`,
        );
        assert.ok(
          /session_id:/.test(result.stderr),
          "garbage mode should still emit session_id trailer on stderr",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("mode=no-status: emits output without step complete", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: {
            doer: { mode: "no-status", output: "I did things but didn't report" },
          },
        });

        const result = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const stdout = result.stdout.trim();
        assert.ok(
          stdout.includes("I did things"),
          `no-status mode should emit output text, got: "${stdout}", stderr: ${result.stderr}`,
        );
        assert.ok(
          /session_id:/.test(result.stderr),
          "no-status mode should emit session_id trailer on stderr",
        );

        assert.ok(
          !stdout.includes("STATUS: done"),
          "no-status mode should NOT contain STATUS: done",
        );
        assert.ok(
          !stdout.includes("STATUS: failed"),
          "no-status mode should NOT contain STATUS: failed",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("mode=die-before-claim: exits non-zero without claiming", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { mode: "die-before-claim", exitCode: 3 } },
        });

        const result = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(
          result.status,
          3,
          `die-before-claim should exit with code 3, got status=${result.status} signal=${result.signal}, stderr: ${result.stderr}`,
        );
        assert.ok(
          !/session_id:/.test(result.stderr.trim()),
          "die-before-claim should NOT emit session_id (it dies before claiming)",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("mode=die-after-claim: claims then exits non-zero", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { mode: "die-after-claim", exitCode: 7 } },
        });

        const result = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(
          result.status,
          7,
          `die-after-claim should exit with code 7, got status=${result.status} signal=${result.signal}, stderr: ${result.stderr}`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("mode=hang: times out without completing", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { mode: "hang" } },
        });

        const result = spawnHermes(
          dirs.mockCliPath,
          {
            HERMES_HOME: dirs.hermesHome,
            TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
            TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
          },
          { timeoutMs: 2000 },
        );

        assert.ok(
          result.signal !== null || result.status !== 0,
          `hang mode should be terminated, got status=${result.status} signal=${result.signal}`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── Behavior consumption tests ─────────────────────────────────────

  describe("behavior consumption", () => {
    it("consumes per-agent arrays in order, last entry repeats", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: {
            doer: [
              { output: "STATUS: done\nROUND: first" },
              { output: "STATUS: done\nROUND: second" },
            ],
          },
        });

        const r1 = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });
        assert.ok(
          r1.stdout.includes("ROUND: first"),
          `first invocation should use first behavior, got: "${r1.stdout.trim()}", stderr: ${r1.stderr}`,
        );

        const r2 = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });
        assert.ok(
          r2.stdout.includes("ROUND: second"),
          `second invocation should use second behavior, got: "${r2.stdout.trim()}"`,
        );

        const r3 = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });
        assert.ok(
          r3.stdout.includes("ROUND: second"),
          `third invocation should repeat last behavior, got: "${r3.stdout.trim()}"`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("respects per-round token counts", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done", tokens: 237 } },
        });

        spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const rows = readStateDb(path.join(dirs.hermesHome, "state.db"));
        assert.equal(rows.length, 1);
        const row = rows[0] as Record<string, unknown>;
        assert.equal(row.input_tokens, 226);
        assert.equal(row.output_tokens, 11);
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("uses defaultTokens from config when behavior has no explicit tokens", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done" } },
          defaultTokens: 77,
        });

        spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const rows = readStateDb(path.join(dirs.hermesHome, "state.db"));
        assert.equal(rows.length, 1);
        const row = rows[0] as Record<string, unknown>;
        assert.equal(row.input_tokens, 66);
        assert.equal(row.output_tokens, 11);
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("supports stepAction=fail to fail a step", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: {
            doer: {
              stepAction: "fail",
              failReason: "intentional test failure",
              output: "STATUS: failed\nREASON: intentional test failure",
            },
          },
        });

        const result = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const stdout = result.stdout.trim();
        assert.ok(
          stdout.includes("STATUS: failed"),
          `should emit STATUS: failed, got: "${stdout}", stderr: ${result.stderr}`,
        );
        assert.ok(
          stdout.includes("intentional test failure"),
          "should emit fail reason",
        );
        // session_id should be on stderr
        assert.ok(
          /session_id:/.test(result.stderr),
          "should emit session_id trailer on stderr",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── Invocation journaling tests ────────────────────────────────────

  describe("invocation journaling", () => {
    it("logs invocations to invocations.jsonl", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done" } },
        });

        spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const journalPath = path.join(dirs.stateDir, "invocations.jsonl");
        assert.ok(fs.existsSync(journalPath), "invocations.jsonl should exist");

        const lines = fs
          .readFileSync(journalPath, "utf-8")
          .split(/\r?\n/)
          .filter(Boolean);

        assert.ok(lines.length >= 2, `should have at least 2 journal entries, got ${lines.length}`);

        const entries = lines.map((l) => JSON.parse(l));
        const workEntries = entries.filter((e: Record<string, unknown>) => e.phase === "work");
        assert.ok(workEntries.length >= 1, `should have at least 1 work entry, got ${workEntries.length}`);
        assert.equal(workEntries[0].shortAgent, "doer");
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── Edge case tests ────────────────────────────────────────────────

  describe("edge cases", () => {
    it("unparseable prompt exits with error", () => {
      const dirs = makeTempDirs();
      try {
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done" } },
        });

        const result = spawnSync(
          process.execPath,
          [runtimePath, "chat", "--max-turns", "8192", "--yolo", "-Q", "-q", "garbage prompt with no workflow info"],
          {
            encoding: "utf-8",
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? os.tmpdir(),
              HERMES_HOME: dirs.hermesHome,
              TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
              TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
            },
            timeout: 10_000,
            maxBuffer: 16 * 1024 * 1024,
          },
        );

        assert.notEqual(result.status, 0, `unparseable prompt should cause non-zero exit, got ${result.status}`);
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("agent with no scripted behavior fails fast", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { some_other_agent: { output: "STATUS: done" } },
        });

        const result = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const stdout = result.stdout.trim();
        assert.ok(
          stdout.includes("STATUS: failed"),
          `should emit STATUS: failed for unscripted agent, got: "${stdout}", stderr: ${result.stderr}`,
        );
        assert.ok(
          stdout.includes("no scripted behavior for agent"),
          `should explain missing behavior, got: "${stdout}"`,
        );
        // session_id should be on stderr
        assert.ok(
          /session_id:/.test(result.stderr),
          "should emit session_id trailer on stderr",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("token overflow: totalTokens=0 produces zero row", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done", tokens: 0 } },
        });

        spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const rows = readStateDb(path.join(dirs.hermesHome, "state.db"));
        assert.equal(rows.length, 1);
        const row = rows[0] as Record<string, unknown>;
        assert.equal(row.input_tokens, 0);
        assert.equal(row.output_tokens, 0);
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("reportBeforeEmit with exitCode: exits with configured code after step complete", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { reportBeforeEmit: true, exitCode: 130, tokens: 555 } },
        });

        const result = spawnHermes(dirs.mockCliPath, {
          HERMES_HOME: dirs.hermesHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        // Exits with the configured exitCode (130 = KeyboardInterrupt)
        assert.equal(
          result.status,
          130,
          `reportBeforeEmit with exitCode=130 should exit 130, got ${result.status}, stderr: ${result.stderr}`,
        );

        // session_id trailer is on stderr (US-001 fix)
        const stderrLines = result.stderr.trim().split(/\r?\n/);
        const trailerLine = stderrLines[stderrLines.length - 1];
        const trailerMatch = /^session_id:\s*(\S+)/.exec(trailerLine);
        assert.ok(trailerMatch, `stderr should end with session_id trailer, got: "${trailerLine}"`);

        // state.db was written (token attribution survives)
        const rows = readStateDb(path.join(dirs.hermesHome, "state.db"));
        assert.equal(rows.length, 1, "state.db should have one session row");
        const row = rows[0] as Record<string, unknown>;
        assert.ok((row.input_tokens as number) > 0, `input_tokens should be > 0, got ${row.input_tokens}`);

        // Step complete was called before exit
        const invocations = readInvocations(path.join(dirs.stateDir, "invocations.jsonl"));
        const resultLog = invocations.find((e) => e.phase === "result");
        assert.ok(resultLog, "should have result invocation log");
        assert.equal(resultLog.ok, true);
        assert.ok(
          resultLog.note?.includes("reporting step complete before emitting output"),
          `result note should mention reportBeforeEmit, got: ${resultLog.note}`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });
});
