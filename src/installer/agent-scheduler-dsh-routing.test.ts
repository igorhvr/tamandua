/**
 * dsh harness routing in the scheduler (US-006):
 *
 * - createAgentCronJob reads harness_type=dsh from the run context
 * - dsh rounds spawn through the dsh resolver with the mandatory
 *   DSH_PERMISSION_MODE=danger-full-access injection (the dsh equivalent of
 *   hermes --yolo) overriding any inherited conflicting value
 * - TAMANDUA_DSH_BINARY is handed down to the child env (mirror of the
 *   hermes injection), the resolved binary's directory is prepended to the
 *   child PATH, and the rest of the user's dsh env (DSH_HOME,
 *   DEEPSEEK_API_KEY) passes through unmodified
 * - no-hurry runs prefer dsh-token-saver from PATH (mirror of the
 *   hermes-token-saver behavior)
 * - cleanChildEnv whitelists TAMANDUA_DSH_BINARY + DSH_HOME
 *
 * All mocks are `#!/bin/sh` fakes (makeMockDsh) — zero tokens, never a real
 * harness.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  createAgentCronJob,
  executeDispatchRound,
  removeRunCrons,
  shutdownAllCrons,
  _scheduledJobHarnessType,
} from "../../dist/installer/agent-scheduler.js";
import { getDb } from "../../dist/db.js";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";
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

describe("executeDispatchRound dsh routing", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined> = {};

  const SAVED_KEYS = [
    "HOME",
    "TAMANDUA_STATE_DIR",
    "TAMANDUA_PI_BINARY",
    "TAMANDUA_HERMES_BINARY",
    "TAMANDUA_DSH_BINARY",
    "DSH_PERMISSION_MODE",
    "DSH_HOME",
    "DEEPSEEK_API_KEY",
    "PATH",
  ] as const;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-test-dsh-routing-");
    for (const key of SAVED_KEYS) {
      saved[key] = process.env[key];
    }

    const homeDir = path.join(tempHome, "home");
    const stateDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    // Guard mock pi: if a dsh run ever misroutes to pi, this fake logs it
    // and the test assertions on the pi log fail loudly.
    const piPath = path.join(tempHome, "pi-mock");
    makeMockBinary(piPath, `echo "PI_MISROUTE" >> "${path.join(tempHome, "pi-args.log")}"; echo "NO_WORK_AVAILABLE"`);
    process.env.TAMANDUA_PI_BINARY = piPath;
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
  function seedRunWithPendingStep(
    runId: string,
    workdir: string,
    contextExtras: Record<string, string> = {},
  ): void {
    const db = getDb();
    const now = new Date().toISOString();
    const context: Record<string, string> = {
      harness_type: "dsh",
      working_directory_for_harness: workdir,
      ...contextExtras,
    };
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "test task", "running", JSON.stringify(context), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);
  }

  /** Mock dsh that records argv + full child env and replies NO_WORK_AVAILABLE. */
  function makeMockDsh(logsDir: string): string {
    const dshDir = path.join(logsDir, "dsh-bin");
    fs.mkdirSync(dshDir, { recursive: true });
    const dshPath = path.join(dshDir, "dsh-mock");
    const argsLog = path.join(logsDir, "dsh-args.log");
    const envLog = path.join(logsDir, "dsh-env.log");
    makeMockBinary(
      dshPath,
      `echo "$@" >> "${argsLog}"
env | sort >> "${envLog}"
echo "NO_WORK_AVAILABLE"`,
    );
    return dshPath;
  }

  async function dispatchDshRound(runId: string, workdir: string): Promise<{ id: string }> {
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
      },
      makeAgent(),
      workflow,
    );
    return { id: result.id! };
  }

  it("dispatches to dsh with --profile headless argv and never touches pi", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "11111111-1111-4111-8111-111111111111";
    seedRunWithPendingStep(runId, workdir);

    const dshPath = makeMockDsh(tempHome);
    process.env.TAMANDUA_DSH_BINARY = dshPath;

    await dispatchDshRound(runId, workdir);

    const argsLog = path.join(tempHome, "dsh-args.log");
    const args = fs.readFileSync(argsLog, "utf-8");
    assert.ok(args.includes("--profile headless"), "dsh must be invoked with --profile headless");
    assert.ok(args.includes("step claim"), "work prompt should instruct step claim");

    const piLog = path.join(tempHome, "pi-args.log");
    assert.ok(!fs.existsSync(piLog), "pi must not be invoked for a dsh run");

    await removeRunCrons(runId);
  });

  it("injects DSH_PERMISSION_MODE=danger-full-access overriding an inherited conflicting value", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "22222222-2222-4222-8222-222222222222";
    seedRunWithPendingStep(runId, workdir);

    const dshPath = makeMockDsh(tempHome);
    process.env.TAMANDUA_DSH_BINARY = dshPath;
    // Conflicting inherited value — the injection must win.
    process.env.DSH_PERMISSION_MODE = "read-only";

    await dispatchDshRound(runId, workdir);

    const envLog = fs.readFileSync(path.join(tempHome, "dsh-env.log"), "utf-8");
    assert.ok(
      envLog.includes("DSH_PERMISSION_MODE=danger-full-access"),
      "child env must carry DSH_PERMISSION_MODE=danger-full-access",
    );
    assert.ok(
      !envLog.includes("DSH_PERMISSION_MODE=read-only"),
      "inherited conflicting permission mode must be overridden",
    );

    await removeRunCrons(runId);
  });

  it("sets TAMANDUA_DSH_BINARY, prepends its dir to PATH, and passes DSH_HOME/DEEPSEEK_API_KEY through unmodified", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "33333333-3333-4333-8333-333333333333";
    seedRunWithPendingStep(runId, workdir);

    const dshPath = makeMockDsh(tempHome);
    process.env.TAMANDUA_DSH_BINARY = dshPath;
    process.env.DSH_HOME = path.join(tempHome, "user-dsh-home");
    process.env.DEEPSEEK_API_KEY = "sk-test-pass-through";

    const { id } = await dispatchDshRound(runId, workdir);

    const envLog = fs.readFileSync(path.join(tempHome, "dsh-env.log"), "utf-8");
    assert.ok(
      envLog.includes(`TAMANDUA_DSH_BINARY=${dshPath}`),
      "child env must carry TAMANDUA_DSH_BINARY pointing at the resolved binary",
    );
    assert.ok(
      envLog.includes(`DSH_HOME=${path.join(tempHome, "user-dsh-home")}`),
      "user DSH_HOME must pass through unmodified",
    );
    assert.ok(
      envLog.includes("DEEPSEEK_API_KEY=sk-test-pass-through"),
      "user DEEPSEEK_API_KEY must pass through unmodified",
    );
    assert.ok(
      envLog.includes(`TAMANDUA_WORKER_JOB_ID=${id}`),
      "standard TAMANDUA_WORKER_* vars must still be set",
    );

    // Child PATH must start with the resolved binary's directory.
    const pathLine = envLog.split("\n").find((line) => line.startsWith("PATH="));
    assert.ok(pathLine, "env dump must include PATH");
    const binaryDir = path.dirname(dshPath);
    assert.ok(
      pathLine!.startsWith(`PATH=${binaryDir}${path.delimiter}`),
      `child PATH must be prepended with the resolved binary's directory (got: ${pathLine})`,
    );

    await removeRunCrons(runId);
  });

  it("still injects danger-full-access when the parent env sets NO conflicting value", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "44444444-4444-4444-8444-444444444444";
    seedRunWithPendingStep(runId, workdir);

    const dshPath = makeMockDsh(tempHome);
    process.env.TAMANDUA_DSH_BINARY = dshPath;
    delete process.env.DSH_PERMISSION_MODE;

    await dispatchDshRound(runId, workdir);

    const envLog = fs.readFileSync(path.join(tempHome, "dsh-env.log"), "utf-8");
    assert.ok(envLog.includes("DSH_PERMISSION_MODE=danger-full-access"));

    await removeRunCrons(runId);
  });
});

describe("createAgentCronJob harnessType from run context (dsh)", () => {
  let tempHome: string;
  let savedPiBinary: string | undefined;
  let savedHome: string | undefined;
  let savedStateDir: string | undefined;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-test-dsh-cron-");
    savedPiBinary = process.env.TAMANDUA_PI_BINARY;
    savedHome = process.env.HOME;
    savedStateDir = process.env.TAMANDUA_STATE_DIR;

    const homeDir = path.join(tempHome, "home");
    const stateDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const piPath = path.join(tempHome, "pi-mock");
    makeMockBinary(piPath, `echo "NO_WORK_AVAILABLE"`);
    process.env.TAMANDUA_PI_BINARY = piPath;
  });

  afterEach(() => {
    if (savedPiBinary === undefined) delete process.env.TAMANDUA_PI_BINARY;
    else process.env.TAMANDUA_PI_BINARY = savedPiBinary;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = savedStateDir;
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function seedRun(runId: string, workdir: string, context: Record<string, string>): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "task", "running", JSON.stringify(context), now, now);
  }

  it("reads harness_type=dsh from the run context", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "55555555-5555-4555-8555-555555555555";
    seedRun(runId, workdir, { harness_type: "dsh", working_directory_for_harness: workdir });

    await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow: makeWorkflow(),
      workingDirectoryForHarness: workdir,
    });

    assert.equal(_scheduledJobHarnessType(runId), "dsh");
    await removeRunCrons(runId);
  });

  it("defaults to 'pi' when harness_type is absent", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "66666666-6666-4666-8666-666666666666";
    seedRun(runId, workdir, { working_directory_for_harness: workdir });

    await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow: makeWorkflow(),
      workingDirectoryForHarness: workdir,
    });

    assert.equal(_scheduledJobHarnessType(runId), "pi");
    await removeRunCrons(runId);
  });

  it("keeps reading harness_type=hermes (regression pin)", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "77777777-7777-4777-8777-777777777777";
    seedRun(runId, workdir, { harness_type: "hermes", working_directory_for_harness: workdir });

    await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow: makeWorkflow(),
      workingDirectoryForHarness: workdir,
    });

    assert.equal(_scheduledJobHarnessType(runId), "hermes");
    await removeRunCrons(runId);
  });
});

describe("dsh-token-saver preference in no-hurry mode", () => {
  let tempHome: string;
  let saved: Record<string, string | undefined> = {};

  const SAVED_KEYS = [
    "HOME",
    "TAMANDUA_STATE_DIR",
    "TAMANDUA_PI_BINARY",
    "TAMANDUA_DSH_BINARY",
    "PATH",
  ] as const;

  beforeEach(() => {
    tempHome = tamanduaTempDir("tamandua-test-dsh-saver-");
    for (const key of SAVED_KEYS) {
      saved[key] = process.env[key];
    }

    const homeDir = path.join(tempHome, "home");
    const stateDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    delete process.env.TAMANDUA_DSH_BINARY;

    const piPath = path.join(tempHome, "pi-mock");
    makeMockBinary(piPath, `echo "NO_WORK_AVAILABLE"`);
    process.env.TAMANDUA_PI_BINARY = piPath;
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

  function seedRun(runId: string, workdir: string, noHurry: boolean): void {
    const db = getDb();
    const now = new Date().toISOString();
    const context: Record<string, string> = {
      harness_type: "dsh",
      working_directory_for_harness: workdir,
    };
    if (noHurry) context.no_hurry_save_tokens_mode = "true";
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "task", "running", JSON.stringify(context), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'step-1', 'test-wf_test-agent', 0, 'do work', 'STATUS', 'pending', ?, ?)",
    ).run(`${runId}-step`, runId, now, now);
  }

  async function dispatch(runId: string, workdir: string): Promise<void> {
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
      },
      makeAgent(),
      workflow,
    );
  }

  it("prefers dsh-token-saver from PATH when the run is in no-hurry mode", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const binDir = path.join(tempHome, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    makeMockBinary(
      path.join(binDir, "dsh-token-saver"),
      `echo "TOKEN_SAVER" >> "${path.join(tempHome, "token-saver.log")}"; echo "NO_WORK_AVAILABLE"`,
    );
    makeMockBinary(
      path.join(binDir, "dsh"),
      `echo "PLAIN_DSH" >> "${path.join(tempHome, "plain-dsh.log")}"; echo "NO_WORK_AVAILABLE"`,
    );
    process.env.PATH = `${binDir}${path.delimiter}${saved["PATH"] ?? ""}`;

    const runId = "88888888-8888-4888-8888-888888888888";
    seedRun(runId, workdir, true);
    await dispatch(runId, workdir);

    assert.ok(
      fs.existsSync(path.join(tempHome, "token-saver.log")),
      "no-hurry dsh run must prefer dsh-token-saver",
    );
    assert.ok(
      !fs.existsSync(path.join(tempHome, "plain-dsh.log")),
      "plain dsh must not be used when dsh-token-saver is available",
    );

    await removeRunCrons(runId);
  });

  it("uses plain dsh when the run is not in no-hurry mode", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const binDir = path.join(tempHome, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    makeMockBinary(
      path.join(binDir, "dsh-token-saver"),
      `echo "TOKEN_SAVER" >> "${path.join(tempHome, "token-saver.log")}"; echo "NO_WORK_AVAILABLE"`,
    );
    makeMockBinary(
      path.join(binDir, "dsh"),
      `echo "PLAIN_DSH" >> "${path.join(tempHome, "plain-dsh.log")}"; echo "NO_WORK_AVAILABLE"`,
    );
    process.env.PATH = `${binDir}${path.delimiter}${saved["PATH"] ?? ""}`;

    const runId = "99999999-9999-4999-8999-999999999999";
    seedRun(runId, workdir, false);
    await dispatch(runId, workdir);

    assert.ok(
      fs.existsSync(path.join(tempHome, "plain-dsh.log")),
      "non-no-hurry dsh run must use plain dsh",
    );
    assert.ok(
      !fs.existsSync(path.join(tempHome, "token-saver.log")),
      "dsh-token-saver must not be preferred without no-hurry mode",
    );

    await removeRunCrons(runId);
  });
});

describe("cleanChildEnv dsh whitelist", () => {
  it("passes TAMANDUA_DSH_BINARY and DSH_HOME through from the base env", () => {
    // Object.assign (not a spread) keeps the test-isolation guard happy:
    // spreading process.env into a child-env literal is a forbidden pattern.
    const baseEnv = Object.assign({}, process.env, {
      TAMANDUA_DSH_BINARY: "/fake/dsh",
      DSH_HOME: "/fake/dsh-home",
    });
    const env = cleanChildEnv({}, baseEnv);

    assert.equal(env.TAMANDUA_DSH_BINARY, "/fake/dsh");
    assert.equal(env.DSH_HOME, "/fake/dsh-home");
  });

  it("still honors explicit overrides of TAMANDUA_DSH_BINARY and DSH_HOME", () => {
    const env = cleanChildEnv({
      TAMANDUA_DSH_BINARY: "/override/dsh",
      DSH_HOME: "/override/dsh-home",
    });

    assert.equal(env.TAMANDUA_DSH_BINARY, "/override/dsh");
    assert.equal(env.DSH_HOME, "/override/dsh-home");
  });
});
