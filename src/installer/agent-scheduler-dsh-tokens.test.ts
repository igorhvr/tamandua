/**
 * dsh token accounting in the scheduler — DSH-OWNER (owned stores +
 * idempotent high-water charging).
 *
 * - Each native dsh invocation gets its OWN session store, prepared by the
 *   dispatcher and handed to dsh through a `--patch` session-persistence
 *   overlay (the adapter's argv carries it). The mocks below are small
 *   `node` scripts that receive EXACTLY that argv: they discover their
 *   persistence root by reading the overlay the adapter passed (never a
 *   separately invented test root), so the tests exercise the real
 *   invocation→store binding.
 * - dsh round stdout is NEVER parsed for token JSON.
 * - Settlement is idempotent: repeated settlement of the same physical
 *   session charges only its unaccounted increment.
 * - UNOBSERVED (missing/unreadable own evidence) reads 0 tokens with a
 *   warning — never a foreign session, never an error.
 *
 * KEY REGRESSIONS (adversarial review counterexample A): two overlapping
 * rounds of one run with ONE session present must charge it exactly ONCE
 * (final 250, not 500), and the round with no session of its own must not
 * be charged at all; the positive companion proves two distinct owned
 * sessions are each counted; the settle-level idempotency test proves a
 * repeated settlement of the SAME physical session is a no-op and that
 * later growth charges only the delta.
 *
 * Note on re-dispatch: a re-executed round gets a FRESH owned store, so it
 * produces a NEW physical session whose usage is legitimately new tokens —
 * the idempotency contract covers repeated handling of the SAME physical
 * session, not distinct invocations.
 *
 * This file spawns harness mock processes, so it is classified in the
 * serial test lane (tests/serial-files.txt).
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  createAgentCronJob,
  executeDispatchRound,
  removeRunCrons,
  settleDshOwnedRoundUsage,
  shutdownAllCrons,
} from "../../dist/installer/agent-scheduler.js";
import { getDb } from "../../dist/db.js";
import {
  dshOwnedSessionProjectDir,
  prepareDshOwnedStore,
} from "../../dist/installer/dsh-usage.js";
import type { WorkflowAgent, WorkflowSpec } from "../../dist/installer/types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST_DSH_USAGE_URL = pathToFileURL(
  path.join(REPO_ROOT, "dist", "installer", "dsh-usage.js"),
).href;

// ── Session-log fixtures (plain v3 JSONL; the mock computes projectKey) ──

function headerLine(id: string): string {
  return (
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      createdAt: 1_700_000_000_000,
      isSeeded: false,
      delegationDepth: 0,
    }) + "\n"
  );
}

/** One v3 `assistant/message` usage record (input+output billable). */
function usageLine(input: number, output: number, seq = 0): string {
  return (
    JSON.stringify({
      type: "assistant/message",
      seq,
      time: 1_700_000_000_000,
      data: {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [] },
        usage: { inputTokens: input, outputTokens: output },
      },
    }) + "\n"
  );
}

/**
 * A dsh mock as a node ESM script. It receives the adapter's real argv,
 * finds `--patch <overlay>`, reads the persistence root out of that
 * overlay, and (when `writeSession`) writes a plain v3 session for its
 * cwd under `<root>/<projectKey(realpath(cwd))>/<sessionName>/`:
 *   standard fixture: 100+50+25+75 = 250 tokens (cache reads excluded);
 *   `extraUsage` appends more records (for growth/idempotency cases);
 *   `stdoutText` replaces the default completion line (contamination cases).
 * `marker` touches a file immediately on start; `release` makes the mock
 * poll for a release file (bounded) before exiting — the in-flight
 * condition the counterexample needs.
 */
function makeDshMock(
  home: string,
  opts: {
    /** Session name to write (also its header id); omit to write NO session. */
    writeSession?: string;
    /** Extra usage lines appended after the standard fixture. */
    extraUsage?: string;
    /** Stdout text (default NO_WORK_AVAILABLE). */
    stdoutText?: string;
    /** Touch this marker file immediately on start. */
    marker?: string;
    /** Poll for this release file before exiting. */
    release?: string;
  },
): string {
  const dshDir = path.join(home, "dsh-bin");
  fs.mkdirSync(dshDir, { recursive: true });
  const mockPath = path.join(dshDir, `dsh-mock-${Math.random().toString(16).slice(2)}.mjs`);
  const lines = [
    "#!/usr/bin/env node",
    'import fs from "node:fs";',
    'import path from "node:path";',
    `const { projectKey } = await import(${JSON.stringify(DIST_DSH_USAGE_URL)});`,
    "const argv = process.argv.slice(2);",
    "let overlay = null;",
    "for (let i = 0; i < argv.length; i++) { if (argv[i] === '--patch') overlay = argv[i + 1]; }",
    opts.marker !== undefined ? `fs.writeFileSync(${JSON.stringify(opts.marker)}, "started");` : "",
    opts.writeSession !== undefined
      ? [
          "if (overlay === null) { process.stderr.write('mock: --patch overlay missing\\n'); process.exit(3); }",
          "const overlayText = fs.readFileSync(overlay, 'utf8');",
          "const m = /^\\s*root:\\s*\"(.+)\"\\s*$/m.exec(overlayText);",
          "if (!m) { process.stderr.write('mock: overlay root unreadable\\n'); process.exit(3); }",
          "const root = m[1];",
          "const cwd = fs.realpathSync(process.cwd());",
          "const dir = path.join(root, projectKey(cwd), " + JSON.stringify(opts.writeSession) + ");",
          "fs.mkdirSync(dir, { recursive: true });",
          "fs.writeFileSync(path.join(dir, 'session.v3.jsonl'), " +
            JSON.stringify(
              headerLine(opts.writeSession) +
                usageLine(100, 50, 1) +
                usageLine(25, 75, 2) +
                (opts.extraUsage ?? ""),
            ) +
            ");",
        ].join("\n")
      : "",
    opts.release !== undefined
      ? [
          "let waited = 0;",
          `while (!fs.existsSync(${JSON.stringify(opts.release)})) {`,
          "  if (waited >= 300) { process.stderr.write('mock: release timeout\\n'); process.exit(4); }",
          "  await new Promise((r) => setTimeout(r, 100));",
          "  waited++;",
          "}",
        ].join("\n")
      : "",
    "process.stdout.write(" + JSON.stringify(opts.stdoutText ?? "NO_WORK_AVAILABLE\n") + ");",
  ].filter((l) => l.length > 0);
  fs.writeFileSync(mockPath, lines.join("\n") + "\n", { mode: 0o755 });
  return mockPath;
}

function makeAgent(id: string): WorkflowAgent {
  return { id, model: "fake", workspace: { baseDir: ".", files: {} } };
}

function makeWorkflow(): WorkflowSpec {
  return {
    id: "test-wf",
    agents: [makeAgent("developer"), makeAgent("verifier")],
    steps: [
      { id: "step-dev", agent: "developer", input: "do work", expects: "STATUS" },
      { id: "step-ver", agent: "verifier", input: "verify", expects: "STATUS" },
    ],
  };
}

describe("executeDispatchRound dsh owned-store token accounting", () => {
  let tempHome: string;
  let stateDir: string;
  let saved: Record<string, string | undefined> = {};

  const SAVED_KEYS = [
    "HOME",
    "TAMANDUA_STATE_DIR",
    "TAMANDUA_PI_BINARY",
    "TAMANDUA_DSH_BINARY",
    "DSH_HOME",
    "PATH",
    // The mock harnesses reply NO_WORK_AVAILABLE to any prompt — they would
    // never pass a launch-time harness probe — so the probe is disabled for
    // these dispatch rounds (session token accounting is the behavior under
    // test).
    "TAMANDUA_HARNESS_PROBE",
  ] as const;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-test-dsh-owner-");
    for (const key of SAVED_KEYS) {
      saved[key] = process.env[key];
    }

    const homeDir = path.join(tempHome, "home");
    stateDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    delete process.env.DSH_HOME;

    // Guard mock pi: if a dsh run ever misroutes to pi, this fake logs it
    // and the assertions on the pi log fail loudly.
    const piPath = path.join(tempHome, "pi-mock");
    fs.writeFileSync(
      piPath,
      `#!/bin/sh\necho "PI_MISROUTE" >> "${path.join(tempHome, "pi-args.log")}"\necho "NO_WORK_AVAILABLE"\n`,
      { mode: 0o755 },
    );
    process.env.TAMANDUA_PI_BINARY = piPath;
  });

  afterEach(() => {
    // Tear the scheduler machinery down BEFORE restoring the saved env:
    // shutdownAllCrons (and any pending-run teardown) can log, and those
    // log writes must resolve to the per-test temp state dir, not the
    // production one. Restoring HOME/TAMANDUA_STATE_DIR first would make
    // teardown logging a test-isolation violation.
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
    for (const key of SAVED_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key] as string;
      }
    }
  });

  /** Insert a running run + pending dev/ver steps so dispatch peeks say HAS_WORK. */
  function seedRun(runId: string, workdir: string): void {
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
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-dev', 'test-wf_developer', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step-dev`, runId, now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-ver', 'test-wf_verifier', 1, 'verify', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step-ver`, runId, now, now);
  }

  function tokensSpent(runId: string): number {
    const db = getDb();
    const row = db
      .prepare("SELECT tokens_spent FROM runs WHERE id = ?")
      .get(runId) as { tokens_spent: number } | undefined;
    return row?.tokens_spent ?? -1;
  }

  function ledgerRows(): Array<{
    session_dir: string;
    run_id: string;
    job_id: string;
    charged_total_tokens: number;
  }> {
    return getDb()
      .prepare(
        "SELECT session_dir, run_id, job_id, charged_total_tokens FROM dsh_session_charges ORDER BY session_dir",
      )
      .all() as Array<{
      session_dir: string;
      run_id: string;
      job_id: string;
      charged_total_tokens: number;
    }>;
  }

  function readTamanduaLog(): string {
    try {
      return fs.readFileSync(path.join(stateDir, "tamandua.log"), "utf8");
    } catch {
      return "";
    }
  }

  function countTokenEvents(runId: string): number {
    try {
      const text = fs.readFileSync(path.join(stateDir, "events", `${runId}.jsonl`), "utf8");
      return text.split("\n").filter((l: string) => l.includes('"event":"run.tokens.updated"')).length;
    } catch {
      return 0;
    }
  }

  async function makeJob(runId: string, agentId: string, workdir: string) {
    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(agentId),
      workflow,
      workingDirectoryForHarness: workdir,
    });
    assert.ok(result.ok, `cron job creation failed for ${agentId}`);
    return {
      job: {
        id: result.id!,
        workflowId: "test-wf",
        runId,
        agentId: `test-wf_${agentId}`,
        harnessType: "dsh" as const,
        workingDirectoryForHarness: workdir,
        createdAt: "",
      },
      agent: makeAgent(agentId),
      workflow,
    };
  }

  function workdir(): string {
    const dir = path.join(tempHome, "work");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("attributes tokens from the invocation's OWNED store on the success path", async () => {
    const wd = workdir();
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    seedRun(runId, wd);
    process.env.TAMANDUA_DSH_BINARY = makeDshMock(tempHome, {
      writeSession: "session-11111111-2222-4333-8444-555555555555",
    });

    const { job, agent, workflow } = await makeJob(runId, "developer", wd);
    await executeDispatchRound(job, agent, workflow);

    assert.equal(tokensSpent(runId), 250, "owned-store usage must be charged");
    assert.match(readTamanduaLog(), /dsh token attribution from owned session store/);

    const rows = ledgerRows();
    assert.equal(rows.length, 1, "exactly one charge-ledger row");
    assert.equal(rows[0].run_id, runId);
    assert.equal(rows[0].job_id, job.id, "the charging invocation owns the ledger row");
    assert.equal(rows[0].charged_total_tokens, 250);

    assert.equal(countTokenEvents(runId), 1, "exactly one run.tokens.updated event");
    const events = fs.readFileSync(path.join(stateDir, "events", `${runId}.jsonl`), "utf8");
    assert.match(events, /"tokenDelta":250/);

    assert.ok(!fs.existsSync(path.join(tempHome, "pi-args.log")), "pi must not be invoked");

    await removeRunCrons(runId);
  });

  it("never parses dsh stdout for token JSON (the pi metadata shape is ignored)", async () => {
    const wd = workdir();
    const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    seedRun(runId, wd);

    // A pi-style `message_end` carrying huge usage, emitted BY THE MOCK on
    // stdout. If the scheduler parsed dsh stdout for tokens, it would add
    // ~999_999 on top of the owned-store 250. It must not.
    const fakePiJson =
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STATUS: done" }],
          usage: { inputTokens: 900_000, outputTokens: 99_999 },
        },
      }) + "\n";
    const mock = makeDshMock(tempHome, {
      writeSession: "session-22222222-3333-4444-8555-666666666666",
      stdoutText: fakePiJson,
    });
    // Precondition: the mock REALLY emits the contaminating JSON (guards
    // against a vacuous test that never pollutes stdout).
    assert.ok(
      fs.readFileSync(mock, "utf8").includes("900000"),
      "the mock must actually emit the pi-style usage JSON",
    );
    process.env.TAMANDUA_DSH_BINARY = mock;

    const { job, agent, workflow } = await makeJob(runId, "developer", wd);
    await executeDispatchRound(job, agent, workflow);

    assert.equal(
      tokensSpent(runId),
      250,
      "only the owned-store usage may be charged — the stdout JSON must be ignored",
    );
    const events = fs.readFileSync(path.join(stateDir, "events", `${runId}.jsonl`), "utf8");
    assert.match(events, /"tokenDelta":250/, "the charged delta is the store's, not stdout's");
    // Mask diagnostic pids ("pid=<n>") first: a 6+ digit pid containing 9
    // followed by five digits (e.g. pid=2906286, or any 19xxxxx pid on a busy
    // host) false-matches the sweep, while the stdout-usage sentinels this
    // guards (900000 / 999999) never appear inside a pid.
    assert.doesNotMatch(
      events.replace(/pid=\d+/g, "pid=<masked>"),
      /9\d{5}/,
      "no stdout-derived usage may land anywhere",
    );
    assert.ok(
      !readTamanduaLog().includes("--mode json may be off"),
      "the pi stdout-parse gate must not run for dsh rounds",
    );

    await removeRunCrons(runId);
  });

  it("charges nothing and warns UNOBSERVED when the invocation's own store has no session", async () => {
    const wd = workdir();
    const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    seedRun(runId, wd);

    // A dsh mock that writes NO session at all — the settle must warn and
    // the round must complete with 0 attributed tokens.
    process.env.TAMANDUA_DSH_BINARY = makeDshMock(tempHome, {});

    const { job, agent, workflow } = await makeJob(runId, "developer", wd);
    await executeDispatchRound(job, agent, workflow);

    const log = readTamanduaLog();
    assert.equal(tokensSpent(runId), 0, "zero-token fallback must not charge anything");
    assert.equal(ledgerRows().length, 0, "no charge-ledger row may be created");
    assert.match(log, /dsh session token lookup unobserved — no charge for this round/);
    assert.ok(!log.includes("Work round failed"), "an unobserved lookup must not fail the round");

    await removeRunCrons(runId);
  });

  it("charges 0 on a binary-resolution failure (no launch, no owned store, no attribution)", async () => {
    const wd = workdir();
    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    seedRun(runId, wd);

    // Force dispatch-time binary resolution to fail: no env override, an
    // empty PATH, and a login-shell zsh that fails.
    delete process.env.TAMANDUA_DSH_BINARY;
    const strippedBinDir = path.join(tempHome, "stripped-bin");
    fs.mkdirSync(strippedBinDir, { recursive: true });
    fs.writeFileSync(path.join(strippedBinDir, "zsh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.PATH = strippedBinDir;

    const { job, agent, workflow } = await makeJob(runId, "developer", wd);
    await executeDispatchRound(job, agent, workflow);

    assert.match(readTamanduaLog(), /Work round failed/, "the round should fail at resolution");
    assert.equal(tokensSpent(runId), 0, "no launch → no owned store → no charge");
    assert.equal(ledgerRows().length, 0, "no charge-ledger row for a round that never launched");

    await removeRunCrons(runId);
  });

  it("attributes tokens for a timed-out dsh round via the normal post-round path", async () => {
    const wd = workdir();
    const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    seedRun(runId, wd);

    process.env.TAMANDUA_DSH_BINARY = makeDshMock(tempHome, {
      writeSession: "session-33333333-4444-4555-8666-777777777777",
      // The mock writes its session, then hangs past the 1-second harness
      // timeout — the round resolves via the timeout path and settlement
      // still runs.
      release: path.join(tempHome, "never-released"),
    });

    const { job, agent, workflow } = await makeJob(runId, "developer", wd);
    const timed = { ...job, timeoutSeconds: 1 };
    await executeDispatchRound(timed, agent, workflow);

    assert.equal(
      tokensSpent(runId),
      250,
      "a timed-out round must still charge its owned-store usage",
    );
    assert.match(readTamanduaLog(), /dsh token attribution from owned session store/);

    await removeRunCrons(runId);
  });

  it("COUNTEREXAMPLE A REGRESSION: one session, two overlapping rounds — charged exactly ONCE (250, not 500)", async () => {
    const wd = workdir();
    const runId = "a5a5a5a5-b6b6-4c7c-8d8d-e9e9e9e9e9e9";
    seedRun(runId, wd);

    const devMarker = path.join(tempHome, "dev-started");
    const releaseFile = path.join(tempHome, "dev-release");

    // Developer round: NO session of its own, blocks until released.
    const devMock = makeDshMock(tempHome, { marker: devMarker, release: releaseFile });
    // Verifier round: publishes the ONLY session of the whole production.
    const verMock = makeDshMock(tempHome, {
      writeSession: "session-4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    });

    // Step 1: dispatch the developer while pointing the dsh binary at its mock.
    process.env.TAMANDUA_DSH_BINARY = devMock;
    const dev = await makeJob(runId, "developer", wd);
    const devPromise = executeDispatchRound(dev.job, dev.agent, dev.workflow);
    devPromise.catch(() => {}); // observed via await below

    try {
      // Wait (bounded) for the developer to actually start.
      const started = Date.now();
      while (!fs.existsSync(devMarker)) {
        if (Date.now() - started > 20_000) throw new Error("developer mock start timeout");
        await new Promise((r) => setTimeout(r, 25));
      }

      // Step 2: controlled transition — mark the dev step done while its
      // harness is still up (disclosed fixture transition; models "developer
      // completed its step while its harness is still up").
      getDb()
        .prepare("UPDATE steps SET status = 'done', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), `${runId}-step-dev`);

      // Step 3: dispatch the verifier WHILE the developer is in flight; its
      // round writes and settles the only session (250).
      process.env.TAMANDUA_DSH_BINARY = verMock;
      const ver = await makeJob(runId, "verifier", wd);
      await executeDispatchRound(ver.job, ver.agent, ver.workflow);

      assert.equal(tokensSpent(runId), 250, "the verifier's session charges 250 once");
      const rowsAfterVer = ledgerRows();
      assert.equal(rowsAfterVer.length, 1, "one charge-ledger row after the verifier");
      assert.equal(rowsAfterVer[0].job_id, ver.job.id, "the verifier owns the first (only) charge");

      // Step 4: release the developer; its settle finds NO session in its own
      // store → UNOBSERVED → it must add NOTHING.
      fs.writeFileSync(releaseFile, "go");
      await devPromise;

      assert.equal(
        tokensSpent(runId),
        250,
        "final total must stay 250 — the developer round must not be charged",
      );
      const rowsFinal = ledgerRows();
      assert.equal(rowsFinal.length, 1, "no additional charge-ledger row");
      assert.equal(
        rowsFinal.filter((r) => r.job_id === dev.job.id).length,
        0,
        "the developer job must own no charge",
      );
      assert.equal(rowsFinal[0].charged_total_tokens, 250, "single 250 charge");

      assert.equal(countTokenEvents(runId), 1, "exactly ONE run.tokens.updated event");
      const log = readTamanduaLog();
      assert.match(log, /dsh session token lookup unobserved/, "the developer's settle reads UNOBSERVED");
      assert.equal(
        log.split("\n").filter((l: string) => l.includes("dsh token attribution from owned session store")).length,
        1,
        "exactly one attribution record",
      );
    } finally {
      // Failure-safe teardown: if an assertion above throws while the
      // developer mock is still blocked, release it so no child process
      // outlives the test (bounded wait inside the mock stays the backstop).
      if (!fs.existsSync(releaseFile)) fs.writeFileSync(releaseFile, "go");
      await devPromise.catch(() => {});
    }
  });

  it("POSITIVE COMPANION: two overlapping rounds with two distinct owned sessions — BOTH counted (250 + 370)", async () => {
    const wd = workdir();
    const runId = "b7b7b7b7-c8c8-4d4d-9e9e-f0f0f0f0f0f0";
    seedRun(runId, wd);

    const devMarker = path.join(tempHome, "dev2-started");
    const releaseFile = path.join(tempHome, "dev2-release");

    // Developer: writes ITS OWN session (250), then blocks.
    const devMock = makeDshMock(tempHome, {
      writeSession: "session-d00d0000-1111-4222-8333-444444444444",
      marker: devMarker,
      release: releaseFile,
    });
    // Verifier: writes ITS OWN different session (250 + 100+20 = 370).
    const verMock = makeDshMock(tempHome, {
      writeSession: "session-e00e0000-1111-4222-8333-555555555555",
      extraUsage: usageLine(100, 20, 3),
    });

    process.env.TAMANDUA_DSH_BINARY = devMock;
    const dev = await makeJob(runId, "developer", wd);
    const devPromise = executeDispatchRound(dev.job, dev.agent, dev.workflow);
    devPromise.catch(() => {});
    const started = Date.now();
    while (!fs.existsSync(devMarker)) {
      if (Date.now() - started > 20_000) throw new Error("developer mock start timeout");
      await new Promise((r) => setTimeout(r, 25));
    }

    getDb()
      .prepare("UPDATE steps SET status = 'done', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), `${runId}-step-dev`);

    process.env.TAMANDUA_DSH_BINARY = verMock;
    const ver = await makeJob(runId, "verifier", wd);
    await executeDispatchRound(ver.job, ver.agent, ver.workflow);

    fs.writeFileSync(releaseFile, "go");
    await devPromise;

    assert.equal(
      tokensSpent(runId),
      250 + 370,
      "both rounds' OWN sessions must be counted (250 + 370 = 620)",
    );
    const rows = ledgerRows();
    assert.equal(rows.length, 2, "two charge-ledger rows (one per distinct session)");
    const byJob = new Map(rows.map((r) => [r.job_id, r]));
    assert.equal(byJob.get(dev.job.id)?.charged_total_tokens, 250);
    assert.equal(byJob.get(ver.job.id)?.charged_total_tokens, 370);
    assert.equal(countTokenEvents(runId), 2, "one event per charged round");
  });

  it("SETTLE-LEVEL IDEMPOTENCY: repeated settlement of the SAME physical session is a no-op; later growth charges only the delta", async () => {
    const wd = workdir();
    const runId = "f1f1f1f1-a2a2-4b3b-8c4c-d5d5d5d5d5d5";
    seedRun(runId, wd);

    const jobId = `tamandua-test-wf-${runId}-developer`;
    const job = {
      id: jobId,
      workflowId: "test-wf",
      runId,
      agentId: "test-wf_developer",
      createdAt: "",
    };

    const store = prepareDshOwnedStore({ stateDir, runId, jobId, phase: "work" });
    assert.ok(store, "owned store preparation must succeed");

    const sessionName = "session-99999999-8888-4777-8666-555555555555";
    const sessionDir = path.join(dshOwnedSessionProjectDir(store!.ownedRoot, wd), sessionName);
    fs.mkdirSync(sessionDir, { recursive: true });
    const logPath = path.join(sessionDir, "session.v3.jsonl");
    fs.writeFileSync(
      logPath,
      headerLine(sessionName) + usageLine(100, 50, 1) + usageLine(25, 75, 2),
    );

    const settle = () =>
      settleDshOwnedRoundUsage({
        context: {},
        job,
        ownedStore: store!,
        phase: "work",
        workdir: wd,
        source: "work_success",
      });

    const first = await settle();
    assert.equal(first.chargedTokens, 250, "first settlement charges the observed total");
    assert.equal(first.unobserved, false);
    assert.equal(tokensSpent(runId), 250);
    assert.equal(countTokenEvents(runId), 1);

    const second = await settle();
    assert.equal(second.chargedTokens, 0, "a repeated settlement of the SAME session adds nothing");
    assert.equal(second.unobserved, false, "already-settled is a no-op, not unobserved");
    assert.equal(tokensSpent(runId), 250, "no second charge");
    assert.equal(countTokenEvents(runId), 1, "no second run.tokens.updated event");

    // The log grows by 120 tokens (a later durable append): only the delta
    // is charged (high-water marks never move down; growth is incremental).
    fs.appendFileSync(logPath, usageLine(100, 20, 3));
    const third = await settle();
    assert.equal(third.chargedTokens, 120, "only the unaccounted increment is charged");
    assert.equal(tokensSpent(runId), 250 + 120);
    assert.equal(countTokenEvents(runId), 2, "one event for the delta charge");

    const rows = ledgerRows();
    assert.equal(rows.length, 1, "still ONE ledger row (same physical session)");
    assert.equal(rows[0].charged_total_tokens, 250 + 120, "high-water mark reflects the growth");

    await removeRunCrons(runId);
  });

  it("SETTLE REFUSES when the receipt does not name the settling invocation (the binding is load-bearing)", async () => {
    const wd = workdir();
    const runId = "d0d0d0d0-e1e1-4f2f-8a3a-b4b4b4b4b4b4";
    seedRun(runId, wd);

    const jobId = `tamandua-test-wf-${runId}-developer`;
    const job = {
      id: jobId,
      workflowId: "test-wf",
      runId,
      agentId: "test-wf_developer",
      createdAt: "",
    };

    const store = prepareDshOwnedStore({ stateDir, runId, jobId, phase: "work" });
    assert.ok(store, "owned store preparation must succeed");
    const receiptText = fs.readFileSync(store!.receiptPath, "utf8");

    // A 250-token session exists in the store: any settlement that passes
    // the binding WILL charge, so a refusal is not vacuous.
    const sessionName = "session-cccc0000-1111-4222-8333-444444444444";
    const sessionDir = path.join(dshOwnedSessionProjectDir(store!.ownedRoot, wd), sessionName);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session.v3.jsonl"),
      headerLine(sessionName) + usageLine(100, 50, 1) + usageLine(25, 75, 2),
    );

    const settle = (phase: "work" | "probe" = "work") =>
      settleDshOwnedRoundUsage({
        context: {},
        job,
        ownedStore: store!,
        phase,
        workdir: wd,
        source: "work_success",
      });

    // 1) Wrong phase: the receipt says "work", the settle claims "probe".
    const wrongPhase = await settle("probe");
    assert.equal(wrongPhase.chargedTokens, 0);
    assert.equal(wrongPhase.unobserved, true);
    assert.equal(tokensSpent(runId), 0, "a phase mismatch must not charge");
    assert.match(readTamanduaLog(), /dsh owned settlement refused/);

    // 2) Tampered receipt claiming a different RUN: still refused.
    fs.writeFileSync(
      store!.receiptPath,
      JSON.stringify({ ...JSON.parse(receiptText), runId: "someone-else" }),
    );
    const tamperedRun = await settle();
    assert.equal(tamperedRun.chargedTokens, 0);
    assert.equal(tamperedRun.unobserved, true);
    assert.equal(tokensSpent(runId), 0);
    assert.equal(ledgerRows().length, 0, "no ledger row for any refused settlement");

    // 3) Tampered receipt claiming a different JOB: still refused.
    fs.writeFileSync(
      store!.receiptPath,
      JSON.stringify({ ...JSON.parse(receiptText), jobId: "other-job" }),
    );
    const tamperedJob = await settle();
    assert.equal(tamperedJob.chargedTokens, 0);
    assert.equal(tamperedJob.unobserved, true);
    assert.equal(ledgerRows().length, 0);

    // 4) The honest receipt settles exactly once (proves the refusals above
    // were the binding talking, not a broken fixture).
    fs.writeFileSync(store!.receiptPath, receiptText);
    const honest = await settle();
    assert.equal(honest.chargedTokens, 250);
    assert.equal(honest.unobserved, false);
    assert.equal(tokensSpent(runId), 250);
    assert.equal(ledgerRows().length, 1);
    assert.equal(ledgerRows()[0].job_id, jobId);

    await removeRunCrons(runId);
  });
});
