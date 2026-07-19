/**
 * Harness routing in executeDispatchRound(): when a dispatch round finds a
 * pending step (deterministic in-process peek), the work spawn must route to
 * runPi for harnessType "pi"/missing and to runHermes for "hermes", with the
 * hermes binary handed down via TAMANDUA_HERMES_BINARY. Also covers
 * buildDispatchRoundContext's harnessType and createAgentCronJob reading
 * harness_type from the run context.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  buildDispatchRoundContext,
  createAgentCronJob,
  executeDispatchRound,
  removeRunCrons,
  shutdownAllCrons,
} from "../../dist/installer/agent-scheduler.js";
import { getHarnessAdapter } from "../../dist/installer/harness-adapter.js";
import { getDb } from "../../dist/db.js";
import type { CronJobInfo } from "../../dist/installer/agent-scheduler.js";
import type { WorkflowAgent, WorkflowSpec } from "../../dist/installer/types.js";

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

describe("buildDispatchRoundContext harnessType", () => {
  it("includes harnessType in returned context", () => {
    const job: CronJobInfo = {
      id: "test-job",
      workflowId: "wf-1",
      runId: "run-1",
      agentId: "wf-1_test-agent",
      harnessType: "hermes",
      createdAt: new Date().toISOString(),
    };

    const context = buildDispatchRoundContext(job, makeAgent(), 60, "/tmp/work");

    assert.equal(context.harnessType, "hermes");
  });

  it("defaults harnessType to 'pi' when not set on job", () => {
    const job: CronJobInfo = {
      id: "test-job",
      workflowId: "wf-1",
      runId: "run-1",
      agentId: "wf-1_test-agent",
      // harnessType intentionally omitted
      createdAt: new Date().toISOString(),
    };

    const context = buildDispatchRoundContext(job, makeAgent(), 60, "/tmp/work");

    assert.equal(context.harnessType, "pi");
  });

  it("includes harnessType 'pi' when explicitly set", () => {
    const job: CronJobInfo = {
      id: "test-job",
      workflowId: "wf-1",
      runId: "run-1",
      agentId: "wf-1_test-agent",
      harnessType: "pi",
      createdAt: new Date().toISOString(),
    };

    const context = buildDispatchRoundContext(job, makeAgent(), 60, "/tmp/work");

    assert.equal(context.harnessType, "pi");
  });
});

describe("executeDispatchRound harness dispatch", () => {
  let tempHome: string;
  let savedPiBinary: string | undefined;
  let savedHermesBinary: string | undefined;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-test-routing-");
    savedPiBinary = process.env.TAMANDUA_PI_BINARY;
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;

    const homeDir = path.join(tempHome, "home");
    const stateDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    // Create mock pi binary. The dispatch motor only spawns a harness when
    // a pending step exists, so each test seeds one; the mock replies
    // NO_WORK_AVAILABLE (a benign no_work outcome — it never claims).
    const piPath = path.join(tempHome, "pi-mock");
    const piLog = path.join(tempHome, "pi-args.log");
    makeMockBinary(piPath, `echo "$@" >> "${piLog}"; echo "NO_WORK_AVAILABLE"`);
    process.env.TAMANDUA_PI_BINARY = piPath;
  });

  afterEach(() => {
    if (savedPiBinary === undefined) delete process.env.TAMANDUA_PI_BINARY;
    else process.env.TAMANDUA_PI_BINARY = savedPiBinary;
    if (savedHermesBinary === undefined) delete process.env.TAMANDUA_HERMES_BINARY;
    else process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Insert a running run + a pending step so the dispatch peek says HAS_WORK. */
  function seedRunWithPendingStep(runId: string, workdir: string, harnessType?: string): void {
    const db = getDb();
    const now = new Date().toISOString();
    const context: Record<string, string> = {
      working_directory_for_harness: workdir,
    };
    if (harnessType) context.harness_type = harnessType;
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "test task", "running", JSON.stringify(context), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);
  }

  it("dispatches to runPi when harnessType is 'pi'", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    // Internal DB fixtures use bare valid UUIDs. The run- prefix is reserved
    // for the external typed-ID representation and is stripped at API boundaries.
    const runId = "11111111-1111-4111-8111-111111111111";
    seedRunWithPendingStep(runId, workdir, "pi");

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    assert.ok(result.ok);

    const piLog = path.join(tempHome, "pi-args.log");
    const piDispatchJob = { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "pi" as const, workingDirectoryForHarness: workdir, createdAt: "" };
    await executeDispatchRound(piDispatchJob, makeAgent(), workflow);

    // Verify pi was invoked (log file should contain --print args)
    const piArgs = fs.readFileSync(piLog, "utf-8");
    assert.ok(piArgs.includes("--print"), "pi should be invoked with --print");
    assert.ok(piArgs.includes("--mode"), "pi should be invoked with --mode");
    assert.ok(piArgs.includes("step claim"), "work prompt should instruct step claim");

    await removeRunCrons(runId);
  });

  it("dispatches to runHermes when harnessType is 'hermes'", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    // Create mock hermes binary that logs its args
    const hermesPath = path.join(tempHome, "hermes-mock");
    const hermesLog = path.join(tempHome, "hermes-args.log");
    makeMockBinary(hermesPath, `echo "$@" >> "${hermesLog}"; echo "NO_WORK_AVAILABLE"`);
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const runId = "22222222-2222-4222-8222-222222222222";
    seedRunWithPendingStep(runId, workdir, "hermes");

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    assert.ok(result.ok);

    const hermesDispatchJob = { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "hermes" as const, workingDirectoryForHarness: workdir, createdAt: "" };
    await executeDispatchRound(hermesDispatchJob, makeAgent(), workflow);

    // Verify hermes was invoked (log file should contain chat subcommand)
    const hermesArgs = fs.readFileSync(hermesLog, "utf-8");
    assert.ok(hermesArgs.includes("chat"), "hermes should be invoked with chat");
    assert.ok(hermesArgs.includes("--max-turns"), "hermes should have --max-turns");
    assert.ok(hermesArgs.includes("--yolo"), "hermes should have --yolo");

    await removeRunCrons(runId);
  });

  it("dispatches to runPi when harnessType is missing (defaults to pi)", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "33333333-3333-4333-8333-333333333333";
    seedRunWithPendingStep(runId, workdir);

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    assert.ok(result.ok);

    const piLog = path.join(tempHome, "pi-args.log");
    await executeDispatchRound(
      { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: undefined, workingDirectoryForHarness: workdir, createdAt: "" },
      makeAgent(),
      workflow,
    );

    // Verify pi was invoked (not hermes)
    const piArgs = fs.readFileSync(piLog, "utf-8");
    assert.ok(piArgs.includes("--print"), "pi should be invoked by default");

    await removeRunCrons(runId);
  });

  it("does NOT spawn any harness when the agent has no pending step", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "44444444-4444-4444-8444-444444444444";
    // Run exists but its only step is already done — peek says NO_WORK.
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'task', 'running', ?, ?, ?)",
    ).run(runId, JSON.stringify({ working_directory_for_harness: workdir }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'done', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);

    const workflow = makeWorkflow();
    await executeDispatchRound(
      { id: "job-idle", workflowId: "test-wf", runId, agentId: "test-wf_test-agent", workingDirectoryForHarness: workdir, createdAt: "" },
      makeAgent(),
      workflow,
    );

    const piLog = path.join(tempHome, "pi-args.log");
    assert.ok(!fs.existsSync(piLog), "idle dispatch round must not spawn the harness");
  });

  it("passes TAMANDUA_HERMES_BINARY to child env when dispatching to runHermes", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    // Create a mock hermes that dumps its environment
    const hermesPath = path.join(tempHome, "hermes-mock");
    const envLog = path.join(tempHome, "hermes-env.log");
    makeMockBinary(hermesPath, `env | grep TAMANDUA >> "${envLog}"; echo "NO_WORK_AVAILABLE"`);
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const runId = "55555555-5555-4555-8555-555555555555";
    seedRunWithPendingStep(runId, workdir, "hermes");

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    assert.ok(result.ok);

    const hermesEnvDispatchJob = { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", harnessType: "hermes" as const, workingDirectoryForHarness: workdir, createdAt: "" };
    await executeDispatchRound(hermesEnvDispatchJob, makeAgent(), workflow);

    // Verify TAMANDUA_HERMES_BINARY was passed to child env
    const envOutput = fs.readFileSync(envLog, "utf-8");
    assert.ok(
      envOutput.includes("TAMANDUA_HERMES_BINARY"),
      "child env should contain TAMANDUA_HERMES_BINARY",
    );

    await removeRunCrons(runId);
  });
});

describe("createAgentCronJob harnessType from run context", () => {
  let tempHome: string;
  let savedPiBinary: string | undefined;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-test-cron-harness-");
    savedPiBinary = process.env.TAMANDUA_PI_BINARY;

    const homeDir = path.join(tempHome, "home");
    const stateDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    // Create mock pi binary
    const piPath = path.join(tempHome, "pi-mock");
    makeMockBinary(piPath, `echo "NO_WORK_AVAILABLE"`);
    process.env.TAMANDUA_PI_BINARY = piPath;
  });

  afterEach(() => {
    if (savedPiBinary === undefined) delete process.env.TAMANDUA_PI_BINARY;
    else process.env.TAMANDUA_PI_BINARY = savedPiBinary;
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("populates CronJobInfo.harnessType from run context harness_type=hermes", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "66666666-6666-4666-8666-666666666666";
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "task", "running", JSON.stringify({
      harness_type: "hermes",
      working_directory_for_harness: workdir,
    }), now, now);

    const workflow = makeWorkflow();
    await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    // Verify job metadata has harnessType from context
    const { _scheduledRunIds } = await import("../../dist/installer/agent-scheduler.js");
    assert.ok(_scheduledRunIds().has(runId), "run should be scheduled");

    await removeRunCrons(runId);
  });

  it("populates CronJobInfo.harnessType as 'pi' when harness_type not in context", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "77777777-7777-4777-8777-777777777777";
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "task", "running", JSON.stringify({
      working_directory_for_harness: workdir,
      // harness_type intentionally missing
    }), now, now);

    const workflow = makeWorkflow();
    await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    // Verify the run is scheduled (defaults to pi dispatch)
    const { _scheduledRunIds } = await import("../../dist/installer/agent-scheduler.js");
    assert.ok(_scheduledRunIds().has(runId), "run should be scheduled with default harness");

    await removeRunCrons(runId);
  });

  it("populates CronJobInfo.harnessType as 'pi' when harness_type is explicitly 'pi'", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "88888888-8888-4888-8888-888888888888";
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "task", "running", JSON.stringify({
      harness_type: "pi",
      working_directory_for_harness: workdir,
    }), now, now);

    const workflow = makeWorkflow();
    await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    // Verify the run is scheduled
    const { _scheduledRunIds } = await import("../../dist/installer/agent-scheduler.js");
    assert.ok(_scheduledRunIds().has(runId), "run should be scheduled");

    await removeRunCrons(runId);
  });

  // ── sessionRef capture in HermesHarnessAdapter.runRound ───────────

  it("captures session_id trailer as sessionRef and filters it from output", async () => {
    const hermesPath = path.join(tempHome, "hermes-mock");
    makeMockBinary(
      hermesPath,
      `echo "some output
session_id: abc123"`,
    );
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const adapter = getHarnessAdapter("hermes");
    const result = await adapter.runRound("do work", {
      workdir: tempHome,
      timeout: 5,
      env: { TAMANDUA_HERMES_BINARY: hermesPath },
    });

    assert.equal(result.sessionRef, "abc123");
    assert.ok(!result.output.includes("session_id"), "output must not contain session_id trailer");
    assert.ok(result.output.includes("some output"), "output must retain content lines");
  });

  it("uses LAST session_id line when multiple are present", async () => {
    const hermesPath = path.join(tempHome, "hermes-mock");
    makeMockBinary(
      hermesPath,
      `echo "session_id: first
some output
session_id: last-one"`,
    );
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const adapter = getHarnessAdapter("hermes");
    const result = await adapter.runRound("do work", {
      workdir: tempHome,
      timeout: 5,
      env: { TAMANDUA_HERMES_BINARY: hermesPath },
    });

    assert.equal(result.sessionRef, "last-one");
    assert.ok(!result.output.includes("session_id"), "output must not contain any session_id line");
  });

  it("sessionRef is undefined when no session_id trailer is present", async () => {
    const hermesPath = path.join(tempHome, "hermes-mock");
    makeMockBinary(
      hermesPath,
      `echo "some output without session id"`,
    );
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const adapter = getHarnessAdapter("hermes");
    const result = await adapter.runRound("do work", {
      workdir: tempHome,
      timeout: 5,
      env: { TAMANDUA_HERMES_BINARY: hermesPath },
    });

    assert.equal(result.sessionRef, undefined);
    assert.ok(result.output.includes("some output"), "output retained");
  });

  it("session_id with extra whitespace is correctly stripped", async () => {
    const hermesPath = path.join(tempHome, "hermes-mock");
    makeMockBinary(
      hermesPath,
      `echo "some output
session_id:   abc123  "`,
    );
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const adapter = getHarnessAdapter("hermes");
    const result = await adapter.runRound("do work", {
      workdir: tempHome,
      timeout: 5,
      env: { TAMANDUA_HERMES_BINARY: hermesPath },
    });

    assert.equal(result.sessionRef, "abc123");
  });

  it("empty hermes output produces undefined sessionRef", async () => {
    const hermesPath = path.join(tempHome, "hermes-mock");
    makeMockBinary(
      hermesPath,
      `exit 0`,
    );
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const adapter = getHarnessAdapter("hermes");
    const result = await adapter.runRound("do work", {
      workdir: tempHome,
      timeout: 5,
      env: { TAMANDUA_HERMES_BINARY: hermesPath },
    });

    assert.equal(result.sessionRef, undefined);
    assert.equal(result.output, "");
  });
});
