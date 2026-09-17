/**
 * Unit tests for scripted-agent-runtime.mjs (the pi scripted runtime).
 *
 * The pi runtime is exercised end to end by workflows-scripted.test.ts and
 * workflows-harness-probe.test.ts; this file pins the launch-time harness
 * probe (IFLB) behavior at the runtime level, mirroring the probe tests of
 * the dsh and hermes scripted runtimes:
 *   1. A probe prompt (first line `TAMANDUA_HARNESS_PROBE: skill-path`) is
 *      answered by running the quoted `<launcher> skill-path` command for
 *      real and replying with the PATH via a pi-shaped message_end, exit 0.
 *   2. The probe is NOT a work round: no invocation is journaled and no
 *      canned-behaviors invocation index is consumed (the next work round
 *      still starts at index 0).
 *
 * Test isolation: each test creates its own temp dirs with a mock tamandua
 * CLI that returns canned responses, so no real tamandua DB is needed. No
 * model is ever invoked — zero tokens.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";

const runtimePath = path.resolve(
  process.cwd(),
  "e2e-tests/helpers/scripted-agent-runtime.mjs",
);

const MOCK_RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MOCK_STEP_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PREF_RUN_ID = `run-${MOCK_RUN_ID}`;
const PREF_STEP_ID = `step-${MOCK_STEP_ID}`;

interface TestDirs {
  tmp: string;
  stateDir: string;
  behaviorsPath: string;
  mockCliPath: string;
  workdir: string;
}

function makeTempDirs(): TestDirs {
  const tmp = tamanduaTempDir("agent-runtime-test-");
  const stateDir = path.join(tmp, "scripted-state");
  const behaviorsPath = path.join(tmp, "behaviors.json");
  const mockCliPath = path.join(tmp, "mock-tamandua");
  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  return { tmp, stateDir, behaviorsPath, mockCliPath, workdir };
}

function writeBehaviors(behaviorsPath: string, config: Record<string, unknown>) {
  fs.writeFileSync(behaviorsPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Create a mock tamandua CLI that returns canned, deterministic responses:
 * step peek → HAS_WORK, step claim → a JSON stepId/runId/input, step
 * complete/fail → exit 0.
 *
 * When `logPath` is given every invocation appends its first two argv words
 * (e.g. "step peek") to that file, so a test can prove a mode never issued a
 * `step claim` / `step complete`.
 */
function createMockCli(dir: string, logPath?: string): string {
  const mockPath = path.join(dir, "mock-tamandua");
  fs.writeFileSync(
    mockPath,
    [
      "#!/usr/bin/env node",
      "var fs = require('node:fs');",
      "var args = process.argv.slice(2);",
      logPath
        ? `fs.appendFileSync(${JSON.stringify(logPath)}, args.slice(0, 2).join(' ') + '\\n');`
        : "",
      "if (args[0] === 'step' && args[1] === 'peek') { process.stdout.write('HAS_WORK'); process.exit(0); }",
      "if (args[0] === 'step' && args[1] === 'claim') {",
      "  process.stdout.write(JSON.stringify({ stepId: " + JSON.stringify(PREF_STEP_ID) + ", runId: " + JSON.stringify(PREF_RUN_ID) + ", input: 'MOCK_INPUT: canned\\n' }));",
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.chmodSync(mockPath, 0o755);
  return mockPath;
}

/** Read the scripted runtime's invocation journal (empty when absent). */
function readInvocationJournal(stateDir: string): Array<Record<string, unknown>> {
  const logPath = path.join(stateDir, "invocations.jsonl");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Read the mock-CLI call log (empty when absent). */
function readCliCalls(logPath: string): string {
  if (!fs.existsSync(logPath)) return "";
  return fs.readFileSync(logPath, "utf-8");
}

/**
 * Spawn the pi runtime exactly like PiHarnessAdapter does:
 * `pi --print --mode json --no-session "<prompt>"` in the harness workdir.
 */
function spawnPi(
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
    [runtimePath, "--print", "--mode", "json", "--no-session", prompt],
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

/**
 * Spawn the pi runtime with a launch-time harness probe prompt (IFLB): the
 * same invocation shape, but the prompt is the probe prompt whose quoted
 * `<launcher> skill-path` command is `mockProbeBin skill-path`.
 */
function spawnPiProbe(
  dirs: TestDirs,
  mockProbeBin: string,
  env: Record<string, string>,
  opts?: { timeoutMs?: number },
): SpawnSyncReturns<string> {
  const prompt = [
    "TAMANDUA_HARNESS_PROBE: skill-path",
    `Run the exact command "${mockProbeBin} skill-path" and reply with the PATH and nothing else.`,
  ].join("\n");

  return spawnSync(
    process.execPath,
    [runtimePath, "--print", "--mode", "json", "--no-session", prompt],
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

function cleanup(tmp: string) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

describe("scripted-agent-runtime (pi)", () => {
  // ── Launch-time harness probe (IFLB) ──────────────────────────────

  describe("launch-time harness probe (IFLB)", () => {
    function writeProbeBin(dirs: TestDirs, pathOut: string): string {
      const probeBin = path.join(dirs.tmp, "mock-skill-path");
      fs.writeFileSync(probeBin, `#!/bin/sh\necho "${pathOut}"\n`, { mode: 0o755 });
      return probeBin;
    }

    it("answers a probe prompt with the real command's path (pi message_end), exit 0, no journal", () => {
      const dirs = makeTempDirs();
      try {
        const probeBin = writeProbeBin(dirs, "/skills/pi/skill/path");

        const result = spawnPiProbe(dirs, probeBin, {
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });

        assert.equal(
          result.status,
          0,
          `probe answer should exit 0, got status=${result.status} signal=${result.signal}, stderr: ${result.stderr}`,
        );
        // The path must be carried as the assistant message_end text (the
        // daemon reads pi JSON message_end as the observed final message).
        assert.ok(
          result.stdout.includes("/skills/pi/skill/path"),
          `probe answer stdout should contain the PATH, got: "${result.stdout}"`,
        );
        assert.ok(
          result.stdout.includes('"type":"message_end"'),
          `probe answer should be a pi-shaped message_end, got: "${result.stdout}"`,
        );
        // The probe is not a work round: no invocation journal.
        const invocationsPath = path.join(dirs.stateDir, "invocations.jsonl");
        assert.ok(!fs.existsSync(invocationsPath), "probe must not journal an invocation");
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("does not consume the canned-invocation index (next work round still starts at index 0)", () => {
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
        const probeBin = writeProbeBin(dirs, "/skills/pi/skill/path");

        // Probe first — it must NOT consume a behavior slot.
        const probe = spawnPiProbe(dirs, probeBin, {
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });
        assert.equal(probe.status, 0, `probe failed: ${probe.stderr}`);
        assert.ok(probe.stdout.includes("/skills/pi/skill/path"));

        // The first WORK invocation after the probe must still be index 0.
        const work = spawnPi(dirs, {
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        });
        assert.ok(
          work.stdout.includes("ROUND: first"),
          `first work round after a probe should use behavior index 0, got: "${work.stdout}", stderr: ${work.stderr}`,
        );
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });

  // ── Pre-claim death chaos modes (OUTAGE-ROUNDS) ─────────────────────
  //
  // These modes model a harness round that runs past the instant-fail wall
  // threshold and exits without ever claiming a step. US-009 drives the full
  // backoff/cap pipeline from them; here we pin the runtime contract: the
  // stream mode emits non-empty stdout, both modes wait at least sleepMs,
  // exit non-zero, and never issue a `step claim` / `step complete`.

  describe("pre-claim death chaos modes (OUTAGE-ROUNDS)", () => {
    function spawnChaosMode(
      dirs: TestDirs,
      behavior: Record<string, unknown>,
      logPath: string,
    ): { result: SpawnSyncReturns<string>; elapsedMs: number } {
      createMockCli(dirs.tmp, logPath);
      writeBehaviors(dirs.behaviorsPath, { agents: { doer: behavior } });
      const started = performance.now();
      const result = spawnPi(
        dirs,
        {
          TAMANDUA_SCRIPTED_BEHAVIORS: dirs.behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: dirs.stateDir,
        },
        { timeoutMs: 20_000 },
      );
      return { result, elapsedMs: performance.now() - started };
    }

    it("mode=stream-die-before-claim: streams non-empty stdout, sleeps, exits nonzero, never claims", () => {
      const dirs = makeTempDirs();
      try {
        const callLog = path.join(dirs.tmp, "cli-calls.log");
        const { result, elapsedMs } = spawnChaosMode(
          dirs,
          { mode: "stream-die-before-claim", sleepMs: 500, streamOutput: "working...", exitCode: 1 },
          callLog,
        );

        assert.equal(
          result.status,
          1,
          `stream-die-before-claim should exit 1, got status=${result.status} signal=${result.signal}, stderr: ${result.stderr}`,
        );
        assert.ok(
          result.stdout.includes("working..."),
          `stream-die-before-claim should write streamOutput, got stdout: "${result.stdout}"`,
        );
        assert.ok(
          elapsedMs >= 500,
          `stream-die-before-claim should wait >= 500ms, elapsed ${elapsedMs}ms`,
        );

        const calls = readCliCalls(callLog);
        assert.ok(calls.includes("step peek"), `expected a peek call, got: ${calls}`);
        assert.ok(!calls.includes("step claim"), `must never claim, got calls: ${calls}`);
        assert.ok(!calls.includes("step complete"), `must never complete, got calls: ${calls}`);

        const work = readInvocationJournal(dirs.stateDir).filter((e) => e.phase === "work");
        assert.equal(work.length, 1, "exactly one work round should be journaled");
        assert.equal(work[0].mode, "stream-die-before-claim");
        assert.equal(work[0].stepId, undefined, "no stepId must be journaled (never claimed)");
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("mode=stream-die-before-claim: defaults to non-empty stdout when streamOutput is absent", () => {
      const dirs = makeTempDirs();
      try {
        const callLog = path.join(dirs.tmp, "cli-calls.log");
        const { result } = spawnChaosMode(
          dirs,
          { mode: "stream-die-before-claim", sleepMs: 100 },
          callLog,
        );

        assert.equal(result.status, 1, `expected exit 1, stderr: ${result.stderr}`);
        assert.ok(
          result.stdout.trim().length > 0,
          `default streamOutput must be non-empty, got: "${result.stdout}"`,
        );
        assert.ok(!readCliCalls(callLog).includes("step claim"), "must never claim");
      } finally {
        cleanup(dirs.tmp);
      }
    });

    it("mode=die-before-claim with sleepMs: sleeps, empty stdout, exits nonzero, never claims", () => {
      const dirs = makeTempDirs();
      try {
        const callLog = path.join(dirs.tmp, "cli-calls.log");
        const { result, elapsedMs } = spawnChaosMode(
          dirs,
          { mode: "die-before-claim", sleepMs: 400, exitCode: 3 },
          callLog,
        );

        assert.equal(
          result.status,
          3,
          `die-before-claim should exit 3, got status=${result.status} signal=${result.signal}, stderr: ${result.stderr}`,
        );
        assert.equal(
          result.stdout,
          "",
          `die-before-claim with sleepMs must still emit empty stdout, got: "${result.stdout}"`,
        );
        assert.ok(
          elapsedMs >= 400,
          `die-before-claim should wait >= 400ms, elapsed ${elapsedMs}ms`,
        );
        assert.ok(!readCliCalls(callLog).includes("step claim"), "must never claim");
      } finally {
        cleanup(dirs.tmp);
      }
    });
  });
});
