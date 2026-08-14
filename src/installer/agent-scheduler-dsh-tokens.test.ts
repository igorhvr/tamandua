/**
 * dsh token accounting in the scheduler (US-007):
 *
 * - dsh round stdout is NEVER parsed for token JSON (the pi
 *   --mode json usage gate is pi-only; hermes/dsh usage comes from
 *   their own stores)
 * - tokens are attributed from the dsh session-file lookup on the
 *   success path (including timed-out rounds, which resolve through the
 *   normal post-round path)
 * - the error path also attempts dsh session-file attribution
 * - an unavailable lookup falls back to 0 tokens with a warning — never
 *   an error, never a retry, never blocks the round
 *
 * All mocks are `#!/bin/sh` fakes that write a synthetic
 * `$DSH_HOME/sessions/<escaped-workdir>/session-<uuid>/session.jsonl.zstd`
 * — zero tokens, never a real harness or model.
 *
 * The scheduler lookup runs the "auto" zstd strategy (node:zlib zstd on
 * Node >= 23.8, else a spawned `zstd -dc`). To stay deterministic on
 * every supported Node (engines allows >= 22), fixtures are compressed
 * in-test via `zstdCompressSync` when available, and a plain-text
 * fixture + fake `zstd` (`cat "$2"`) on PATH otherwise.
 *
 * This file spawns harness mock processes, so it is classified in the
 * serial test lane (tests/serial-files.txt).
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  createAgentCronJob,
  executeDispatchRound,
  removeRunCrons,
  shutdownAllCrons,
} from "../../dist/installer/agent-scheduler.js";
import { getDb } from "../../dist/db.js";
import { dshSessionProjectDir } from "../../dist/installer/dsh-usage.js";
import type { WorkflowAgent, WorkflowSpec } from "../../dist/installer/types.js";

// ── Feature gate: node:zlib zstd (Node >= 23.8) ────────────────────

const zstdCompress =
  typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function"
    ? (zlib as { zstdCompressSync: (b: Uint8Array) => Buffer }).zstdCompressSync
    : null;
const haveNodeZstd = zstdCompress !== null;

// ── Session-log fixtures (mirror dsh-usage.test.ts) ────────────────

function headerLine(id: string, createdAt: number): string {
  return (
    JSON.stringify({
      type: "session",
      version: 1,
      id,
      createdAt,
      delegationDepth: 0,
    }) + "\n"
  );
}

function usageLine(opts: {
  input: number;
  output: number;
  cacheRead?: number;
  seq?: number;
}): string {
  return (
    JSON.stringify({
      type: "assistant/chunk",
      seq: opts.seq ?? 0,
      time: 1_700_000_000_000,
      data: {
        turn: 0,
        step: 0,
        chunk: {
          type: "usage",
          usage: {
            inputTokens: opts.input,
            outputTokens: opts.output,
            ...(opts.cacheRead !== undefined
              ? { cacheReadTokens: opts.cacheRead }
              : {}),
          },
        },
      },
    }) + "\n"
  );
}

/** Plaintext fixture: 100 + 50 + 25 + 75 = 250 tokens (cache reads excluded). */
const FIXTURE_PLAINTEXT =
  headerLine("session-fixture", 1_700_000_000_000) +
  usageLine({ input: 100, output: 50, cacheRead: 9_000, seq: 1 }) +
  usageLine({ input: 25, output: 75, cacheRead: 1_000, seq: 2 });

const FIXTURE_TOKENS = 250;

/** Session-log bytes in the representation the running Node's auto tier can read. */
function fixtureBytes(): Buffer {
  if (haveNodeZstd) {
    return zstdCompress!(Buffer.from(FIXTURE_PLAINTEXT, "utf8"));
  }
  return Buffer.from(FIXTURE_PLAINTEXT, "utf8");
}

/** Fake `zstd` binary for Node < 23.8: `zstd -dc <file>` → cat the file. */
function writeFakeZstd(dir: string): void {
  fs.writeFileSync(path.join(dir, "zstd"), '#!/bin/sh\ncat "$2"\n', {
    mode: 0o755,
  });
}

function makeMockBinary(binPath: string, behavior: string): void {
  fs.writeFileSync(binPath, `#!/bin/sh\n${behavior}\n`, { mode: 0o755 });
}

function makeAgent(): WorkflowAgent {
  return {
    id: "test-agent",
    model: "fake",
    workspace: { baseDir: "." },
  };
}

function makeWorkflow(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    id: "test-wf",
    agents: [makeAgent()],
    steps: [
      {
        id: "step-1",
        agent: "test-agent",
        input: "do work",
        expects: "STATUS",
      },
    ],
    ...overrides,
  };
}

describe("executeDispatchRound dsh token accounting", () => {
  let tempHome: string;
  let dshHome: string;
  let stateDir: string;
  let saved: Record<string, string | undefined> = {};

  const SAVED_KEYS = [
    "HOME",
    "TAMANDUA_STATE_DIR",
    "TAMANDUA_PI_BINARY",
    "TAMANDUA_DSH_BINARY",
    "DSH_HOME",
    "PATH",
  ] as const;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-test-dsh-tokens-");
    for (const key of SAVED_KEYS) {
      saved[key] = process.env[key];
    }

    const homeDir = path.join(tempHome, "home");
    stateDir = path.join(homeDir, ".tamandua");
    dshHome = path.join(tempHome, "dsh-home");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(dshHome, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.DSH_HOME = dshHome;

    // Guard mock pi: if a dsh run ever misroutes to pi, this fake logs it
    // and the assertions on the pi log fail loudly.
    const piPath = path.join(tempHome, "pi-mock");
    makeMockBinary(
      piPath,
      `echo "PI_MISROUTE" >> "${path.join(tempHome, "pi-args.log")}"; echo "NO_WORK_AVAILABLE"`,
    );
    process.env.TAMANDUA_PI_BINARY = piPath;

    // Node < 23.8: the scheduler's "auto" zstd tier spawns `zstd -dc` —
    // give it a deterministic fake that cats the (plain-text) fixture.
    if (!haveNodeZstd) {
      const fakeBinDir = path.join(tempHome, "fake-bin");
      fs.mkdirSync(fakeBinDir, { recursive: true });
      writeFakeZstd(fakeBinDir);
      process.env.PATH = `${fakeBinDir}${path.delimiter}${saved["PATH"] ?? ""}`;
    }
  });

  afterEach(() => {
    for (const key of SAVED_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key] as string;
      }
    }
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Insert a running run + a pending step so the dispatch peek says HAS_WORK. */
  function seedRunWithPendingStep(runId: string, workdir: string): void {
    const db = getDb();
    const now = new Date().toISOString();
    const context: Record<string, string> = {
      harness_type: "dsh",
      working_directory_for_harness: workdir,
    };
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "test task", "running", JSON.stringify(context), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);
  }

  function tokensSpent(runId: string): number {
    const db = getDb();
    const row = db
      .prepare("SELECT tokens_spent FROM runs WHERE id = ?")
      .get(runId) as { tokens_spent: number } | undefined;
    return row?.tokens_spent ?? -1;
  }

  function readTamanduaLog(): string {
    try {
      return fs.readFileSync(path.join(stateDir, "tamandua.log"), "utf8");
    } catch {
      return "";
    }
  }

  /** Write the synthetic session fixture into $DSH_HOME/sessions/<escaped-workdir>. */
  function writeSessionFixture(workdir: string, sessionName: string): string {
    const sessionDir = path.join(dshSessionProjectDir(dshHome, workdir), sessionName);
    fs.mkdirSync(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, "session.jsonl.zstd");
    fs.writeFileSync(logPath, fixtureBytes());
    return sessionDir;
  }

  /**
   * Mock dsh that creates a session under $DSH_HOME for the workdir,
   * writes the fixture usage log into it, prints `stdoutText`, and exits.
   */
  function makeSessionDsh(
    workdir: string,
    sessionName: string,
    stdoutText: string,
    extraBehavior = "",
  ): string {
    const dshDir = path.join(tempHome, "dsh-bin");
    fs.mkdirSync(dshDir, { recursive: true });
    const dshPath = path.join(dshDir, "dsh-mock");
    const sessionDir = path.join(dshSessionProjectDir(dshHome, workdir), sessionName);
    makeMockBinary(
      dshPath,
      `mkdir -p "${sessionDir}"
cp "${path.join(tempHome, "fixture.zstd")}" "${path.join(sessionDir, "session.jsonl.zstd")}"
echo "${stdoutText}"
${extraBehavior}`,
    );
    return dshPath;
  }

  async function dispatchDshRound(
    runId: string,
    workdir: string,
    options: { timeoutSeconds?: number } = {},
  ): Promise<void> {
    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });
    assert.ok(result.ok);
    await executeDispatchRound(
      {
        id: result.id!,
        workflowId: "test-wf",
        runId,
        agentId: "test-wf_test-agent",
        harnessType: "dsh",
        workingDirectoryForHarness: workdir,
        createdAt: "",
        ...(options.timeoutSeconds !== undefined
          ? { timeoutSeconds: options.timeoutSeconds }
          : {}),
      },
      makeAgent(),
      workflow,
    );
  }

  it("attributes tokens from the dsh session file on the success path", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(tempHome, "fixture.zstd"), fixtureBytes());

    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    seedRunWithPendingStep(runId, workdir);

    process.env.TAMANDUA_DSH_BINARY = makeSessionDsh(
      workdir,
      "session-11111111-2222-4333-8444-555555555555",
      "NO_WORK_AVAILABLE",
    );

    await dispatchDshRound(runId, workdir);

    assert.equal(
      tokensSpent(runId),
      FIXTURE_TOKENS,
      `tokens_spent must be attributed from the session file (${FIXTURE_TOKENS})`,
    );
    assert.match(
      readTamanduaLog(),
      /dsh token attribution from session file/,
      "success-path dsh attribution should be logged",
    );

    // The attribution should also fire the standard run.tokens.updated event.
    const eventsFile = path.join(stateDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(eventsFile), "run events file should exist");
    const events = fs.readFileSync(eventsFile, "utf8");
    assert.match(events, /"event":"run\.tokens\.updated"/);
    assert.match(events, /"tokenDelta":250/);

    const piLog = path.join(tempHome, "pi-args.log");
    assert.ok(!fs.existsSync(piLog), "pi must not be invoked for a dsh run");

    await removeRunCrons(runId);
  });

  it("never parses dsh stdout for token JSON (pi gate is pi-only)", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(tempHome, "fixture.zstd"), fixtureBytes());

    const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    seedRunWithPendingStep(runId, workdir);

    // stdout carries a pi-style message_end with usage 999999 — if the
    // scheduler parsed dsh stdout for tokens, it would attribute this on
    // top of the session-file usage. It must NOT.
    const fakePiJson = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "STATUS: done" }],
        usage: { inputTokens: 900_000, outputTokens: 99_999 },
      },
    });
    process.env.TAMANDUA_DSH_BINARY = makeSessionDsh(
      workdir,
      "session-22222222-3333-4444-8555-666666666666",
      fakePiJson,
    );

    await dispatchDshRound(runId, workdir);

    assert.equal(
      tokensSpent(runId),
      FIXTURE_TOKENS,
      `only the session-file usage may be attributed — stdout JSON must be ignored (got ${tokensSpent(runId)})`,
    );
    assert.ok(
      !readTamanduaLog().includes("--mode json may be off"),
      "the pi stdout-parse gate must not run for dsh rounds",
    );

    await removeRunCrons(runId);
  });

  it("attributes tokens on the error path when a session exists", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    seedRunWithPendingStep(runId, workdir);

    // A session already exists for this workdir with a future mtime so the
    // round-start scan considers it eligible (mtime >= spawnedAtMs).
    const sessionDir = writeSessionFixture(workdir, "session-error-path");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(sessionDir, future, future);

    // Force dispatch-time binary resolution to fail: no env override, an
    // empty PATH, and a login-shell zsh that fails. The round must land in
    // the error path WITHOUT crashing and still attempt dsh attribution.
    delete process.env.TAMANDUA_DSH_BINARY;
    const strippedBinDir = path.join(tempHome, "stripped-bin");
    fs.mkdirSync(strippedBinDir, { recursive: true });
    makeMockBinary(path.join(strippedBinDir, "zsh"), `exit 1`);
    writeFakeZstd(strippedBinDir);
    process.env.PATH = strippedBinDir;

    await dispatchDshRound(runId, workdir);

    assert.match(
      readTamanduaLog(),
      /Work round failed/,
      "the dispatch round should fail at binary resolution",
    );
    assert.equal(
      tokensSpent(runId),
      FIXTURE_TOKENS,
      `the error path must attempt dsh session-file attribution (got ${tokensSpent(runId)})`,
    );
    assert.match(
      readTamanduaLog(),
      /dsh token attribution from error-path session lookup/,
      "error-path dsh attribution should be logged",
    );

    await removeRunCrons(runId);
  });

  it("falls back to 0 tokens with a warning (never an error) when the lookup is unavailable", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    seedRunWithPendingStep(runId, workdir);

    // A dsh mock that writes NO session at all — the lookup must warn and
    // the round must complete with 0 attributed tokens.
    const dshDir = path.join(tempHome, "dsh-bin");
    fs.mkdirSync(dshDir, { recursive: true });
    const dshPath = path.join(dshDir, "dsh-mock");
    makeMockBinary(dshPath, `echo "NO_WORK_AVAILABLE"`);
    process.env.TAMANDUA_DSH_BINARY = dshPath;

    await dispatchDshRound(runId, workdir);

    const log = readTamanduaLog();
    assert.equal(tokensSpent(runId), 0, "zero-token fallback must not attribute anything");
    assert.match(
      log,
      /dsh session token lookup unavailable — tokens will read 0/,
      "the zero-token fallback should emit a scheduler-level warning",
    );
    assert.ok(
      !log.includes("Work round failed"),
      "an unavailable dsh lookup must not fail the round",
    );
    assert.ok(
      !log.includes("--mode json may be off"),
      "the pi stdout-parse gate must not run for dsh rounds",
    );

    await removeRunCrons(runId);
  });

  it("attributes tokens for a timed-out dsh round via the normal post-round path", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(tempHome, "fixture.zstd"), fixtureBytes());

    const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    seedRunWithPendingStep(runId, workdir);

    // The mock writes its session log immediately, then hangs past the
    // 1-second harness timeout (dsh traps SIGTERM and exits 0 — the
    // phantom-outcome guard keeps the round honest, and token attribution
    // still runs on the resolved round).
    process.env.TAMANDUA_DSH_BINARY = makeSessionDsh(
      workdir,
      "session-33333333-4444-4555-8666-777777777777",
      "NO_WORK_AVAILABLE",
      "sleep 30",
    );

    await dispatchDshRound(runId, workdir, { timeoutSeconds: 1 });

    assert.equal(
      tokensSpent(runId),
      FIXTURE_TOKENS,
      `a timed-out round must still attribute session-file usage (got ${tokensSpent(runId)})`,
    );
    assert.match(
      readTamanduaLog(),
      /dsh token attribution from session file/,
      "timeout-path dsh attribution should be logged",
    );

    await removeRunCrons(runId);
  });
});
