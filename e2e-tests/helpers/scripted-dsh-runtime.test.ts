/**
 * Unit tests for scripted-dsh-runtime.mjs.
 *
 * These tests spawn the dsh runtime as a standalone process (simulating
 * how the DshHarnessAdapter invokes it: `dsh --profile headless "<prompt>"`)
 * and verify the pinned dsh headless contract:
 *   1. stdout is EXACTLY the final assistant text plus a newline — plain
 *      text, no JSON, no session trailer
 *   2. stderr is EMPTY on success; exit code 0
 *   3. a valid session.jsonl.zstd is written under
 *      $DSH_HOME/sessions/<escaped-cwd>/session-<uuid>/ with usage chunks
 *      (input + output tokens, cacheReadTokens excluded) so the scheduler's
 *      session-file token lookup (dsh-usage.ts) can attribute tokens
 *   4. All chaos modes (work, hang, die-before-claim, die-after-claim,
 *      no-status, garbage)
 *
 * Test isolation: each test creates its own temp dirs with a mock tamandua
 * CLI that returns canned responses, so no real tamandua DB is needed.
 * No model is ever invoked — zero tokens.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";
import {
  lookupDshSessionTokens,
  dshSessionProjectDir,
} from "../../dist/installer/dsh-usage.js";

const runtimePath = path.resolve(
  process.cwd(),
  "e2e-tests/helpers/scripted-dsh-runtime.mjs",
);

const MOCK_RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MOCK_STEP_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PREF_RUN_ID = `run-${MOCK_RUN_ID}`;
const PREF_STEP_ID = `step-${MOCK_STEP_ID}`;

// ── zstd decompression for fixture verification ─────────────────────
// Prefer node:zlib zstdDecompressSync (Node >= 23.8), fall back to the
// `zstd` binary.

const nodeZstdDecompress =
  typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync ===
  "function"
    ? (zlib as { zstdDecompressSync: (b: Uint8Array) => Buffer })
        .zstdDecompressSync
    : undefined;

function decompressZstd(buffer: Buffer): string {
  if (nodeZstdDecompress) {
    return nodeZstdDecompress(buffer).toString("utf-8");
  }
  const r = spawnSync("zstd", ["-dc"], {
    input: buffer,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `zstd -dc failed: ${r.stderr}`);
  return r.stdout.toString("utf-8");
}

interface TestDirs {
  tmp: string;
  stateDir: string;
  dshHome: string;
  behaviorsPath: string;
  mockCliPath: string;
  workdir: string;
}

function makeTempDirs(): TestDirs {
  const tmp = tamanduaTempDir("dsh-runtime-test-");
  const stateDir = path.join(tmp, "scripted-state");
  const dshHome = path.join(tmp, "dsh-home");
  const behaviorsPath = path.join(tmp, "behaviors.json");
  const mockCliPath = path.join(tmp, "mock-tamandua");
  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  return { tmp, stateDir, dshHome, behaviorsPath, mockCliPath, workdir };
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

/**
 * Spawn the dsh runtime exactly like DshHarnessAdapter does:
 * `dsh --profile headless "<prompt>"` in the harness workdir.
 */
function spawnDsh(
  dirs: TestDirs,
  env: Record<string, string>,
  opts?: { timeoutMs?: number },
): SpawnSyncReturns<string> {
  const prompt = [
    'workflow "test-wf", agent "test-wf_doer", run "' + PREF_RUN_ID + '"',
    "Task: do a thing",
    '"' + dirs.mockCliPath + '" step claim "test-wf_doer" --run-id "' + PREF_RUN_ID + '"',
  ].join("\n");

  return spawnSync(
    process.execPath,
    [runtimePath, "--profile", "headless", prompt],
    {
      encoding: "utf-8",
      cwd: dirs.workdir,
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

function listSessionDirs(dirs: TestDirs): string[] {
  const projectDir = dshSessionProjectDir(dirs.dshHome, dirs.workdir);
  if (!fs.existsSync(projectDir)) return [];
  return fs
    .readdirSync(projectDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function readSessionLogText(dirs: TestDirs, sessionName: string): string {
  const projectDir = dshSessionProjectDir(dirs.dshHome, dirs.workdir);
  const logPath = path.join(projectDir, sessionName, "session.jsonl.zstd");
  return decompressZstd(fs.readFileSync(logPath));
}

function cleanup(tmp: string) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

describe("scripted-dsh-runtime", () => {
  // ── Output contract tests (dsh headless) ──────────────────────────

  describe("output contract", () => {
    it("emits exactly the final text plus newline on stdout, nothing on stderr, exit 0", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done\nREPO: /fake/repo" } },
        });

        const result = spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(
          result.status,
          0,
          `should exit 0, got status=${result.status} signal=${result.signal}, stderr: ${result.stderr}`,
        );
        assert.equal(
          result.stdout,
          "STATUS: done\nREPO: /fake/repo\n",
          `stdout should be exactly the report text plus a newline, got: "${result.stdout}"`,
        );
        assert.equal(
          result.stderr,
          "",
          `stderr should be empty on success, got: "${result.stderr}"`,
        );

        // Should NOT contain JSON events or any session trailer
        assert.ok(!result.stdout.includes('"type":"message_end"'), "no JSON events");
        assert.ok(!result.stdout.includes("session_id"), "no session trailer on stdout");
        assert.ok(!result.stdout.includes("session-"), "no session id on stdout");
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("handles multi-line output text verbatim", () => {
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

        const result = spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.equal(result.stderr, "", "stderr should stay empty");
        assert.ok(result.stdout.includes("STATUS: done\nREPO: /fake/repo"));
        assert.ok(result.stdout.includes("COMMITS: abc123, def456"));
        assert.ok(result.stdout.endsWith("\n"), "stdout should end with exactly one newline");
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── Session file tests (token attribution) ────────────────────────

  describe("session file", () => {
    it("writes a valid session.jsonl.zstd with usage chunks under the escaped-cwd dir", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done", tokens: 111 } },
        });

        spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const sessionDirs = listSessionDirs(dirs);
        assert.equal(sessionDirs.length, 1, `should have exactly 1 session dir, got: ${JSON.stringify(sessionDirs)}`);
        assert.match(sessionDirs[0], /^session-[0-9a-f-]{36}$/, "session dir should be session-<uuid>");

        const text = readSessionLogText(dirs, sessionDirs[0]);
        const lines = text.split("\n").filter(Boolean);

        // First line: session header
        const header = JSON.parse(lines[0]);
        assert.equal(header.type, "session");
        assert.equal(header.id, sessionDirs[0].replace(/^session-/, ""));

        // Usage chunks: input on the first, output on the second, cache
        // reads sprinkled on both (must be excluded by the reader).
        const usageLines = lines
          .slice(1)
          .map((l) => JSON.parse(l) as {
            type: string;
            data: {
              chunk: {
                type: string;
                usage: {
                  inputTokens: number;
                  outputTokens: number;
                  cacheReadTokens: number;
                };
              };
            };
          });
        assert.equal(usageLines.length, 2, "should have 2 usage chunks");
        for (const line of usageLines) {
          assert.equal(line.type, "assistant/chunk");
          assert.equal(line.data.chunk.type, "usage");
        }
        const inputTotal = usageLines.reduce((s, l) => s + l.data.chunk.usage.inputTokens, 0);
        const outputTotal = usageLines.reduce((s, l) => s + l.data.chunk.usage.outputTokens, 0);
        assert.equal(inputTotal, 100, `input should total 100 (111 - 11), got ${inputTotal}`);
        assert.equal(outputTotal, 11, `output should total 11, got ${outputTotal}`);
        const cacheReadTotal = usageLines.reduce((s, l) => s + l.data.chunk.usage.cacheReadTokens, 0);
        assert.equal(cacheReadTotal, 8, `cache reads should total 8, got ${cacheReadTotal}`);
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("is readable by the real lookupDshSessionTokens end to end", async () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done", tokens: 237 } },
        });

        spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const usage = await lookupDshSessionTokens({
          spawnedAtMs: 0,
          workdir: dirs.workdir,
          env: { DSH_HOME: dirs.dshHome },
        });

        assert.ok(usage !== null, "lookup should find the fake session");
        assert.equal(
          usage.totalTokens,
          237,
          `total should be 237 (cache reads excluded), got ${usage?.totalTokens}`,
        );
        assert.match(usage.sessionRef, /^session-[0-9a-f-]{36}$/);
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("creates a unique session dir per invocation", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done" } },
        });

        for (let i = 0; i < 3; i++) {
          const r = spawnDsh(dirs, {
            DSH_HOME: dirs.dshHome,
            TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
            TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
          });
          assert.equal(r.status, 0, `invocation ${i + 1} failed: ${r.stderr}`);
        }

        const sessionDirs = listSessionDirs(dirs);
        assert.equal(
          sessionDirs.length,
          3,
          `3 invocations should produce 3 session dirs, got: ${JSON.stringify(sessionDirs)}`,
        );
        assert.equal(new Set(sessionDirs).size, 3, "session ids should be unique");
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("degradation: missing DSH_HOME — still produces valid output", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done" } },
        });

        const result = spawnDsh(dirs, {
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.ok(
          result.stdout.includes("STATUS: done"),
          `should produce STATUS output even without DSH_HOME, got: "${result.stdout}"`,
        );
        assert.equal(result.stderr, "", "stderr should stay empty");
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── Chaos mode tests ───────────────────────────────────────────────

  describe("chaos modes", () => {
    it("mode=garbage: emits garbage on stdout with empty stderr", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { mode: "garbage", output: "anything" } },
        });

        const result = spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.ok(
          result.stdout.includes("%%% not plain text"),
          `garbage mode should emit scripted garbage text, got: "${result.stdout}"`,
        );
        assert.equal(result.stderr, "", "stderr should stay empty in garbage mode");
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

        const result = spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.ok(
          result.stdout.includes("I did things"),
          `no-status mode should emit output text, got: "${result.stdout}"`,
        );
        assert.ok(!result.stdout.includes("STATUS: done"));
        assert.ok(!result.stdout.includes("STATUS: failed"));
        assert.equal(result.stderr, "", "stderr should stay empty");
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

        const result = spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(
          result.status,
          3,
          `die-before-claim should exit with code 3, got status=${result.status} signal=${result.signal}, stderr: ${result.stderr}`,
        );
        assert.equal(
          listSessionDirs(dirs).length,
          0,
          "die-before-claim should not write a session log",
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("mode=die-after-claim: claims, writes the session log, then exits non-zero", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { mode: "die-after-claim", exitCode: 7, tokens: 111 } },
        });

        const result = spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(
          result.status,
          7,
          `die-after-claim should exit with code 7, got status=${result.status} signal=${result.signal}, stderr: ${result.stderr}`,
        );
        assert.equal(result.stdout, "", "stdout should be empty when dying after claim");
        assert.equal(result.stderr, "", "stderr should be empty when dying after claim");

        // The session log must exist so token attribution survives the kill.
        const sessionDirs = listSessionDirs(dirs);
        assert.equal(sessionDirs.length, 1, "die-after-claim should still write the session log");
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

        const result = spawnDsh(
          dirs,
          {
            DSH_HOME: dirs.dshHome,
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

        const r1 = spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });
        assert.ok(
          r1.stdout.includes("ROUND: first"),
          `first invocation should use first behavior, got: "${r1.stdout.trim()}", stderr: ${r1.stderr}`,
        );

        const r2 = spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });
        assert.ok(
          r2.stdout.includes("ROUND: second"),
          `second invocation should use second behavior, got: "${r2.stdout.trim()}"`,
        );

        const r3 = spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
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

    it("respects per-round token counts in the session log", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp);
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done", tokens: 237 } },
        });

        spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        const sessionDirs = listSessionDirs(dirs);
        assert.equal(sessionDirs.length, 1);
        const text = readSessionLogText(dirs, sessionDirs[0]);
        let inputTotal = 0;
        let outputTotal = 0;
        for (const line of text.split("\n").filter(Boolean)) {
          const record = JSON.parse(line) as {
            type: string;
            data?: {
              chunk?: {
                type?: string;
                usage?: { inputTokens?: number; outputTokens?: number };
              };
            };
          };
          if (record.data?.chunk?.usage) {
            inputTotal += record.data.chunk.usage.inputTokens ?? 0;
            outputTotal += record.data.chunk.usage.outputTokens ?? 0;
          }
        }
        assert.equal(inputTotal + outputTotal, 237, `usage chunks should total 237, got ${inputTotal + outputTotal}`);
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("heartbeat (NO_WORK peek) emits NO_WORK_AVAILABLE without a session log", () => {
      const dirs = makeTempDirs();
      try {
        createMockCli(dirs.tmp, { noWork: true });
        writeBehaviors(dirs.behaviorsPath, {
          agents: { doer: { output: "STATUS: done" } },
        });

        const result = spawnDsh(dirs, {
          DSH_HOME: dirs.dshHome,
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.equal(result.stdout, "NO_WORK_AVAILABLE\n");
        assert.equal(result.stderr, "", "stderr should stay empty");
        assert.equal(listSessionDirs(dirs).length, 0, "heartbeat should not write a session log");
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });
});
